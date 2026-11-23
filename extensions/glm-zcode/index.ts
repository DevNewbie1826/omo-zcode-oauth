import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { createAssistantMessageEventStream, createProvider, hasApi, type AssistantMessage, type Model, type OAuthAuth, type ProviderStreams, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { CATALOG_REFRESH_INTERVAL_MS, ZCODE_PROVIDER_ID, buildZCodeSourceHeaders, resolveZCodeAnthropicBaseUrl } from "./models.js";
import { CATALOG_TRIGGER_TIMEOUT_MS, createZCodeCatalog, type AcceptedOffPeakRoute } from "./catalog.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { loginGlmZcode, refreshGlmZcode } from "./oauth.js";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolveZCodeSigningHeaders, zcodeSessionId } from "./signing.js";

import {
  OFFPEAK_BASE_URL,
  SIGNATURE_HEADERS,
  isOffPeakRouted,
  isOffPeakWindow,
  isTicketFresh,
  takeTicketState,
  ensureOffPeakTicket,
  fetchOffPeakAvailability,
  offPeakRequestHeaders,
  type OffPeakTicketState,
} from "./offpeak.js";

const anthropic = anthropicMessagesApi();
/** Side-channel for hooks that never see credentials: the JWT cached at auth resolution, bound to its API key so concurrent credential swaps cannot mix accounts. */
let cachedCredential: { apiKey: string; jwt: string } | undefined;
const TICKET_REQUEST_WAIT_MS = 60_000;
let offPeakTaskId: string | undefined;
let preTakenTicket: { route: AcceptedOffPeakRoute; ticket: OffPeakTicketState } | undefined;
let pendingTicket: { route: AcceptedOffPeakRoute; promise: Promise<string | undefined> } | undefined;
let offPeakTestClock: Date | undefined;

function currentOffPeakTaskId(): string {
  offPeakTaskId ??= `omo-offpeak-${crypto.randomUUID()}`;
  return offPeakTaskId;
}

// Existing consumers (and tests) import these from the extension entry point.
export { buildZCodeSourceHeaders, osCategory } from "./models.js";

let offPeakTransportOverride: boolean | undefined;

/** The override remains a test hook simulating an unavailable transport. */
function offPeakTransportReady(): boolean {
  return offPeakTransportOverride ?? true;
}

/** The per-model off-peak route decision: transport + window + entitlement + a usable JWT. */
async function offPeakActiveFor(context: RefreshModelsContext): Promise<boolean> {
  if (!ticketRouteEnabled()) return false;
  if (!isOffPeakWindow(offPeakTestClock ?? new Date()) || !context.allowNetwork || context.signal.aborted) return false;
  if (context.credential?.type !== "oauth") return false;
  const jwt = typeof context.credential.zcodeJwtToken === "string" ? context.credential.zcodeJwtToken : undefined;
  const apiKey = context.credential.access;
  if (!jwt || !apiKey) return false;
  return await fetchOffPeakAvailability(jwt, apiKey, context.signal) && !context.signal.aborted;
}

function ticketRouteEnabled(): boolean {
  return process.env.ZCODE_OFFPEAK_ENABLE === "1" && offPeakTransportReady() && !process.env.ZCODE_ANTHROPIC_BASE_URL?.trim();
}

function routeUsable(route: AcceptedOffPeakRoute): boolean {
  return route.isCurrent() && ticketRouteEnabled() && isOffPeakWindow(offPeakTestClock ?? new Date());
}

function retainTicket(route: AcceptedOffPeakRoute, id: string): void {
  if (routeUsable(route)) {
    preTakenTicket = { route, ticket: takeTicketState(route.jwt, route.access, id, offPeakTestClock ?? new Date()) };
  }
}

function warmTicket(route: AcceptedOffPeakRoute): void {
  if (!routeUsable(route)) return;
  const promise = ensureOffPeakTicket(route.jwt, route.access, currentOffPeakTaskId(), route.session, { background: true });
  const pending = { route, promise };
  pendingTicket = pending;
  const clear = () => { if (pendingTicket === pending) pendingTicket = undefined; };
  void promise.then(id => {
    if (pendingTicket !== pending) return;
    clear();
    if (id) retainTicket(route, id);
  }, clear);
}

async function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined;
  try {
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    return await Promise.race([operation, aborted]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function requestTicket(route: AcceptedOffPeakRoute, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const now = offPeakTestClock ?? new Date();
  if (preTakenTicket?.route === route && isTicketFresh(preTakenTicket.ticket, now, route.access, route.jwt)) {
    return preTakenTicket.ticket.ticketId;
  }
  // A shared warm-up stays session-owned. An on-demand take belongs only to this request.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TICKET_REQUEST_WAIT_MS);
  const waitSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const shared = pendingTicket?.route === route ? pendingTicket.promise : undefined;
    const id = await waitFor(shared ?? ensureOffPeakTicket(route.jwt, route.access, currentOffPeakTaskId(), waitSignal), waitSignal);
    signal.throwIfAborted();
    if (id && !shared && credentialMatches(route, route.access)) retainTicket(route, id);
    return id;
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function credentialMatches(route: AcceptedOffPeakRoute, key: string): boolean {
  return route.access === key && cachedCredential?.apiKey === key && cachedCredential.jwt === route.jwt;
}

function abortedStream(model: Model<"anthropic-messages">, outer = createAssistantMessageEventStream()) {
  const error: AssistantMessage = {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "aborted", errorMessage: "Request aborted", timestamp: Date.now(),
  };
  outer.push({ type: "error", reason: "aborted", error });
  outer.end(error);
  return outer;
}

function requestSignal(session: AbortSignal, caller?: AbortSignal): AbortSignal {
  return caller ? AbortSignal.any([session, caller]) : session;
}

function normalBaseUrl(model: Model<"anthropic-messages">): string {
  // Only the off-peak marker is session-scoped; allow intentional host endpoint
  // overrides on non-routed models, with the current environment override first.
  return process.env.ZCODE_ANTHROPIC_BASE_URL?.trim() ||
    (isOffPeakRouted(model) ? resolveZCodeAnthropicBaseUrl() : model.baseUrl);
}

const streams = (session: { controller: AbortController }, routeFor: (id: string, key: string) => AcceptedOffPeakRoute | undefined): ProviderStreams => ({
  stream(model, context, options) {
    if (!hasApi(model, "anthropic-messages")) throw new Error("Expected an Anthropic chat model");
    const signal = requestSignal(session.controller.signal, options?.signal);
    // Full streams never use a ticket; the headers hook already signed the normal request.
    return signal.aborted ? abortedStream(model) :
      anthropic.stream({ ...model, baseUrl: normalBaseUrl(model) }, context, { ...options, signal });
  },
  streamSimple(model, context, options) {
    if (!hasApi(model, "anthropic-messages")) throw new Error("Expected an Anthropic chat model");
    const signal = requestSignal(session.controller.signal, options?.signal);
    if (signal.aborted) return abortedStream(model);
    const key = options?.apiKey ?? "";
    const route = routeFor(model.id, key);
    if (!route) return anthropic.streamSimple({ ...model, baseUrl: normalBaseUrl(model) }, context, { ...options, signal });
    const outer = createAssistantMessageEventStream();
    void (async () => {
      const id = await requestTicket(route, signal);
      signal.throwIfAborted();
      const headers = { ...options?.headers };
      const offPeak = id && routeFor(model.id, key) === route;
      if (offPeak) {
        for (const header of SIGNATURE_HEADERS) delete headers[header];
        Object.assign(headers, offPeakRequestHeaders(route.jwt, key, id));
      } else if (!headers["X-Client-Sig"]) {
        Object.assign(headers, await waitFor(resolveZCodeSigningHeaders({ ...headers, Authorization: "Bearer " + key }), signal));
      }
      signal.throwIfAborted();
      const baseUrl = offPeak ? OFFPEAK_BASE_URL : resolveZCodeAnthropicBaseUrl();
      const inner = anthropic.streamSimple({ ...model, baseUrl }, context, { ...options, headers, signal });
      for await (const event of inner) outer.push(event);
      outer.end(await inner.result());
    })().catch(error => {
      if (signal.aborted) abortedStream(model, outer);
      else outer.fail(error);
    });
    return outer;
  },
});

/** Test hook: deterministic clock for window-boundary coverage. */
export function setOffPeakClockForTests(clock: Date | undefined): void {
  offPeakTestClock = clock;
}

/** Test hook: clear credential/ticket caches between cases. */
export function resetOffPeakStateForTests(): void {
  cachedCredential = undefined;
  preTakenTicket = undefined;
  pendingTicket = undefined;
  offPeakTaskId = undefined;
}

/** Test hook: force transport readiness off to simulate import failure. */
export function setOffPeakTransportForTests(ready: boolean | undefined): void {
  offPeakTransportOverride = ready;
}

let defaultDeviceId: string | undefined;

function printableAsciiEnv(name: string): string | undefined {
  const value = process.env[name]?.trim() ?? "";
  return value && /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

function deviceMidPath(): string {
  return join(homedir(), ".zcode/v2/telemetry-state.json");
}

/**
 * Reads the app-registered device id; on app-less machines, creates one in
 * the app's own telemetry format so the id stays stable and a later real
 * app install adopts the SAME id instead of forking the device identity.
 */
function getOrCreateDeviceMid(): string | undefined {
  const path = deviceMidPath();
  try {
    const raw = readFileSync(path, "utf8");
    const state = JSON.parse(raw) as { deviceMid?: string };
    const mid = state.deviceMid?.trim();
    if (mid && /^[\x20-\x7e]+$/.test(mid)) return mid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; // unreadable: leave untouched
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fresh = randomUUID();
    writeFileSync(path, JSON.stringify({ deviceMid: fresh }, null, 2), { flag: "wx" }); // exclusive
    return fresh;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A concurrent creator won: adopt its id.
      try {
        const state = JSON.parse(readFileSync(path, "utf8")) as { deviceMid?: string };
        const mid = state.deviceMid?.trim();
        return mid && /^[\x20-\x7e]+$/.test(mid) ? mid : undefined;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

/**
 * Device-identity metadata for glm-zcode request bodies. The real app
 * (captured 2026-09-10) sends metadata.user_id = JSON({device_id,
 * account_uuid, session_id}); with the metadata the request matches the
 * app's shape that the server uses to classify "used via ZCode" (the basis
 * of the current 150% quota campaign, 0.67 coefficient); the plugin-side
 * effect is unconfirmed.
 */
function deviceIdentityMetadata(): { user_id: string } | undefined {
  const deviceId = printableAsciiEnv("ZCODE_DEVICE_ID") ?? defaultDeviceId;
  if (!deviceId) return undefined;
  return { user_id: JSON.stringify({ device_id: deviceId, account_uuid: "", session_id: zcodeSessionId() }) };
}

const oauth: OAuthAuth = {
  name: "GLM ZCode",
  async login(interaction) {
    const credential = await loginGlmZcode({
      onAuth: info => interaction.notify({ type: "auth_url", ...info }),
      onDeviceCode: info => interaction.notify({ type: "device_code", ...info }),
      onProgress: message => interaction.notify({ type: "progress", message }),
      onPrompt: prompt => interaction.prompt({ ...prompt, type: prompt.type ?? "text", signal: prompt.signal ?? interaction.signal }),
      onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: "Paste the ZCode redirect URL", signal: interaction.signal }),
      onSelect: prompt => interaction.prompt({ type: "select", ...prompt, signal: prompt.signal ?? interaction.signal }),
      signal: interaction.signal,
    });
    return { ...credential, type: "oauth" };
  },
  refresh: async (credential, signal) => ({ ...await refreshGlmZcode(credential, signal), type: "oauth" }),
  async toAuth({ access, zcodeJwtToken }) {
    const jwt = typeof zcodeJwtToken === "string" && zcodeJwtToken ? zcodeJwtToken : undefined;
    cachedCredential = jwt ? { apiKey: access, jwt } : undefined;
    if (preTakenTicket && (preTakenTicket.ticket.apiKey !== access || preTakenTicket.ticket.jwt !== jwt)) preTakenTicket = undefined;
    if (pendingTicket && (pendingTicket.route.access !== access || pendingTicket.route.jwt !== jwt)) pendingTicket = undefined;
    return { apiKey: access, headers: { ...buildZCodeSourceHeaders(), Authorization: "Bearer " + access } };
  },
};

function catalogRefreshes(catalog: ReturnType<typeof createZCodeCatalog>) {
  // The registry's result only reports caller aborts. The provider sees generation aborts.
  const trigger = new AsyncLocalStorage<{ deadline: number; providerSignal?: AbortSignal }>();
  let latest: { signal: AbortSignal; done: Promise<void> } | undefined;
  return {
    provider(context: RefreshModelsContext) {
      const owner = trigger.getStore();
      if (owner) owner.providerSignal = context.signal;
      const work = catalog.refresh(context, owner?.deadline);
      latest = { signal: context.signal, done: work.then(() => {}, () => {}) };
      return work;
    },
    async run(ctx: ExtensionContext, force: boolean, session: AbortSignal, retrySuperseded = false): Promise<boolean> {
      try {
        const signal = AbortSignal.any([session, AbortSignal.timeout(CATALOG_TRIGGER_TIMEOUT_MS)]);
        const deadline = Date.now() + CATALOG_TRIGGER_TIMEOUT_MS;
        const first: { deadline: number; providerSignal?: AbortSignal } = { deadline };
        const run = () => ctx.modelRegistry.refresh({
          providers: [ZCODE_PROVIDER_ID], force, allowNetwork: process.env.OFFLINE === undefined, signal,
        });
        let result = await trigger.run(first, run);
        // Even without credentials the registry calls the restore phase, unless
        // this generation was superseded before it reached the provider.
        const superseded = first.providerSignal?.aborted ?? true;
        if (retrySuperseded && superseded && !signal.aborted && !result.aborted && result.errors.size === 0) {
          // Give a cache phase a turn to hand off to the host's online phase, and
          // don't interrupt an observed replacement publication. Recovery is one-shot.
          let replacement: typeof latest;
          do {
            replacement = latest;
            if (replacement && replacement.signal !== first.providerSignal && !replacement.signal.aborted) {
              await waitFor(replacement.done, AbortSignal.any([signal, replacement.signal])).catch(() => {});
            }
            if (signal.aborted || catalog.isFresh()) break;
            await new Promise<void>(resolve => { setImmediate(resolve).unref(); });
          } while (replacement !== latest && !signal.aborted);
          if (!signal.aborted && process.env.OFFLINE === undefined && !catalog.isFresh()) {
            result = await trigger.run({ deadline }, run);
          }
        }
        return !signal.aborted && !result.aborted && result.errors.size === 0;
      } catch {
        // Registry errors may contain credentials. Never forward their messages to the UI.
        return false;
      }
    },
  };
}

type GlmExtensionAPI = Pick<ExtensionAPI, "on" | "registerProvider" | "registerCommand">;

function registerCatalogTriggers(pi: GlmExtensionAPI, catalog: ReturnType<typeof createZCodeCatalog>, session: { controller: AbortController }, refresh: ReturnType<typeof catalogRefreshes>["run"]): void {
  let polling: { resume: () => void; rearm: () => void; stop: () => void } | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (session.controller.signal.aborted) session.controller = new AbortController();
    if (polling) return polling.resume();
    const signal = session.controller.signal;
    let cancelTimer: (() => void) | undefined;
    let running = false;

    function disarm() {
      cancelTimer?.();
      cancelTimer = undefined;
    }

    function schedule() {
      disarm();
      if (signal.aborted || process.env.OFFLINE !== undefined) return;
      const age = catalog.checkedAt === undefined ? 0 : Date.now() - catalog.checkedAt;
      if (age > 0 && age < CATALOG_REFRESH_INTERVAL_MS) {
        const timer = setTimeout(tick, CATALOG_REFRESH_INTERVAL_MS - age).unref();
        cancelTimer = () => clearTimeout(timer);
      } else {
        const timer = setInterval(tick, CATALOG_REFRESH_INTERVAL_MS).unref();
        cancelTimer = () => clearInterval(timer);
      }
    }
    function tick() {
      disarm();
      if (signal.aborted || process.env.OFFLINE !== undefined || catalog.isFresh()) return schedule();
      running = true;
      void refresh(ctx, false, signal, true).then(ok => {
        running = false;
        if (signal.aborted) return;
        if (!ok && ctx.hasUI) ctx.ui.notify("GLM ZCode catalog refresh failed; retained cached models.", "warning");
        schedule(); // Schedule from the accepted publication, not the start of this GET.
      });
    }
    function resume() {
      if (process.env.OFFLINE !== undefined) disarm();
      else if (!running && !cancelTimer) tick();
    }
    polling = { resume, rearm: () => { if (!running) schedule(); }, stop: disarm };
    resume();
  });
  pi.on("session_shutdown", () => { session.controller.abort(); catalog.clearSessionRoute(); polling?.stop(); polling = undefined; });
  pi.registerCommand("glm-models", {
    description: "Refresh and list GLM ZCode models", argumentHint: "[--force]",
    async handler(args, ctx) {
      const arg = args.trim();
      if (arg && arg !== "--force") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /glm-models [--force]", "warning");
        return;
      }
      const offline = process.env.OFFLINE !== undefined;
      const signal = session.controller.signal;
      if (offline) polling?.stop();
      const ok = await refresh(ctx, arg === "--force", signal);
      if (ok && !offline && !signal.aborted) polling?.rearm();
      if (!ctx.hasUI) return;
      const ids = ctx.modelRegistry.getAll().filter(m => m.provider === ZCODE_PROVIDER_ID).map(m => m.id);
      const checked = new Date(catalog.checkedAt ?? NaN);
      const status = [offline && "offline", !ok && "refresh failed; retained cached models"].filter(Boolean).join("; ");
      ctx.ui.notify(["GLM ZCode" + (status ? " (" + status + ")" : ""),
        "checkedAt: " + (Number.isNaN(checked.getTime()) ? "never" : checked.toISOString()), ...ids].join("\n"), ok ? "info" : "error");
    },
  });
}

export default function glmZcodeExtension(pi: GlmExtensionAPI): void {
  if (!printableAsciiEnv("ZCODE_DEVICE_ID")) defaultDeviceId ??= getOrCreateDeviceMid();
  const session = { controller: new AbortController() };
  let acceptedRoute: AcceptedOffPeakRoute | undefined;
  const catalog = createZCodeCatalog(offPeakActiveFor, () => session.controller.signal, route => {
    acceptedRoute = route;
    warmTicket(route);
  });
  const refreshes = catalogRefreshes(catalog);
  const routeFor = (id: string, key: string) => {
    const route = acceptedRoute;
    return route && routeUsable(route) && credentialMatches(route, key) &&
      catalog.getModels().some(model => model.id === id && isOffPeakRouted(model)) ? route : undefined;
  };
  pi.on("before_provider_request", (event) => {
    if (event.model?.provider !== "glm-zcode" || event.payload == null || typeof event.payload !== "object") return event.payload;
    const payload = event.payload as { model?: unknown; metadata?: { user_id?: unknown } & Record<string, unknown> };
    if (typeof payload.model === "string") payload.model = catalog.officialGlmModelId(payload.model);
    if (payload.metadata?.user_id !== undefined) return event.payload;
    const metadata = deviceIdentityMetadata();
    if (!metadata) return event.payload;
    payload.metadata = { ...payload.metadata, ...metadata };
    return payload;
  });
  pi.on("before_provider_headers", async (event) => {
    Object.assign(event.headers, await resolveZCodeSigningHeaders(event.headers));
  });
  const base = createProvider({ id: ZCODE_PROVIDER_ID, name: "GLM ZCode", baseUrl: resolveZCodeAnthropicBaseUrl(),
    auth: { oauth }, models: catalog.getModels(), api: streams(session, routeFor) });
  pi.registerProvider({ ...base, getModels: catalog.getModels, getAllModels: catalog.getModels,
    refreshModels: refreshes.provider });
  registerCatalogTriggers(pi, catalog, session, refreshes.run);
}
