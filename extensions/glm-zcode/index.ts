import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { createAssistantMessageEventStream, createProvider, hasApi, type AssistantMessage, type Model, type OAuthAuth, type ProviderStreams, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import { CATALOG_REFRESH_INTERVAL_MS, ULTRA_BASE_URL, ZCODE_PROVIDER_ID, buildZCodeSourceHeaders, resolveZCodeAnthropicBaseUrl } from "./models.js";
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
let offPeakTestClock: Date | undefined;

interface PendingTicket {
  readonly controller: AbortController;
  readonly promise: Promise<string | undefined>;
  readonly background: boolean;
  waiters: number;
}

interface TicketRoute extends AcceptedOffPeakRoute {
  ticket?: OffPeakTicketState;
  pending?: PendingTicket;
}

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

function startTicket(route: TicketRoute, background: boolean): PendingTicket {
  const controller = new AbortController();
  const signal = AbortSignal.any([route.signal, controller.signal]);
  const work = ensureOffPeakTicket(route.jwt, route.access, currentOffPeakTaskId(), signal, { background });
  const pending: PendingTicket = {
    controller, background, waiters: 0,
    promise: waitFor(work, signal).catch(error => {
      if (signal.aborted) return undefined;
      throw error;
    }).then(id => {
      if (id && route.pending === pending && routeUsable(route) && (background || credentialMatches(route, route.access))) {
        route.ticket = takeTicketState(route.jwt, route.access, id, offPeakTestClock ?? new Date());
      }
      return id;
    }).finally(() => { if (route.pending === pending) route.pending = undefined; }),
  };
  route.pending = pending;
  return pending;
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

async function requestTicket(route: TicketRoute, signal: AbortSignal): Promise<string | undefined> {
  signal.throwIfAborted();
  const now = offPeakTestClock ?? new Date();
  if (route.ticket && isTicketFresh(route.ticket, now, route.access, route.jwt)) return route.ticket.ticketId;
  const pending = route.pending ?? startTicket(route, false);
  pending.waiters++;
  // Each foreground wait has its own deadline and referenced timer, even when
  // the acquisition is a background warm-up with unref'd poll timers.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TICKET_REQUEST_WAIT_MS);
  const waitSignal = AbortSignal.any([signal, deadline.signal]);
  try {
    const id = await waitFor(pending.promise, waitSignal);
    signal.throwIfAborted();
    return id;
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted) return undefined;
    throw error;
  } finally {
    clearTimeout(timer);
    pending.waiters--;
    if (pending.waiters === 0 && !pending.background && route.pending === pending) {
      route.pending = undefined;
      pending.controller.abort();
    }
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

const streams = (session: { controller: AbortController }, routeFor: (id: string, key: string) => TicketRoute | undefined): ProviderStreams => ({
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
    // A host-selected non-canonical URL (e.g. models.json) is an explicit
    // destination. Canonical ultra and the catalog marker are not overrides.
    const route = model.baseUrl === ULTRA_BASE_URL || isOffPeakRouted(model) ? routeFor(model.id, key) : undefined;
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
      const baseUrl = offPeak ? OFFPEAK_BASE_URL : normalBaseUrl(model);
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

const oauth: Omit<OAuthAuth, "toAuth"> = {
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
};

function catalogRefreshes(catalog: ReturnType<typeof createZCodeCatalog>) {
  // The registry's result only reports caller aborts. The provider sees generation aborts.
  type Outcome = "ok" | "superseded" | "failed";
  type Attempt = { readonly deadline: number; providerSignal?: AbortSignal; sourceUnavailable?: boolean };
  const trigger = new AsyncLocalStorage<Attempt | "fence">();
  let latestPhase: { signal: AbortSignal; done: Promise<"ok" | "failed"> } | undefined;
  let latestIssued: { session: AbortSignal; done: Promise<Outcome>; settled: boolean } | undefined;
  let handoff: Promise<void> | undefined;
  return {
    async provider(context: RefreshModelsContext) {
      const owner = trigger.getStore();
      if (owner === "fence") return;
      // The host aborts old generations at the fence; newer generations can
      // continue once the new session is active. Never block the fence itself.
      if (handoff) {
        try {
          await waitFor(handoff, context.signal);
        } catch (error) {
          if (context.signal.aborted) return;
          throw error;
        }
      }
      if (context.signal.aborted) return;
      if (owner) owner.providerSignal = context.signal;
      const work = catalog.refresh(context, owner?.deadline);
      latestPhase = { signal: context.signal, done: work.then(status => status ? "failed" : "ok", () => "failed") };
      // Preserve the host's non-throwing fallback while distinguishing it from
      // supersession for extension callers deciding whether to retry.
      if (await work === "source-unavailable" && owner) owner.sourceUnavailable = true;
    },
    fence(ctx: ExtensionContext, resume: () => void): Promise<void> {
      if (handoff) return handoff;
      // A host generation may still be reading credentials or the store before
      // its first provider callback. Supersede it in the host, without restoring
      // any rows or permitting network access during the handoff.
      const pending = trigger.run("fence", async () => ctx.modelRegistry.refresh({
        providers: [ZCODE_PROVIDER_ID], allowNetwork: false, signal: AbortSignal.timeout(CATALOG_TRIGGER_TIMEOUT_MS),
      })).then(result => {
        if (handoff === pending && !result.aborted) resume();
      }, () => {
        // A failed host call is not evidence that its old generation was fenced.
      }).finally(() => { if (handoff === pending) handoff = undefined; });
      handoff = pending;
      return pending;
    },
    endHandoff() { handoff = undefined; },
    async run(ctx: ExtensionContext, force: boolean, session: AbortSignal, recover = false): Promise<boolean> {
      const signal = AbortSignal.any([session, AbortSignal.timeout(CATALOG_TRIGGER_TIMEOUT_MS)]);
      const deadline = Date.now() + CATALOG_TRIGGER_TIMEOUT_MS;
      const current = () => latestIssued?.session === session ? latestIssued : undefined;
      function issue(): Promise<Outcome> {
        // Register the whole call before the host starts its credential/store reads.
        let complete: ((outcome: Outcome) => void) | undefined;
        const done = new Promise<Outcome>(resolve => { complete = resolve; });
        const issued = { session, done, settled: false };
        latestIssued = issued;
        const attempt: Attempt = { deadline };
        void (async (): Promise<Outcome> => {
          try {
            const result = await trigger.run(attempt, () => ctx.modelRegistry.refresh({
              providers: [ZCODE_PROVIDER_ID], force, allowNetwork: process.env.OFFLINE === undefined, signal,
            }));
            if (signal.aborted || result.aborted || result.errors.size || attempt.sourceUnavailable) return "failed";
            // Otherwise even a credential-less generation reaches the restore phase.
            return attempt.providerSignal?.aborted === false ? "ok" : "superseded";
          } catch {
            // Registry errors may contain credentials. Never forward their messages to the UI.
            return "failed";
          }
        })().then(outcome => {
          issued.settled = true;
          complete?.(outcome);
        });
        return done;
      }
      try {
        const active = current();
        let work = recover && active && !active.settled ? active.done : issue();
        let outcome = await waitFor(work, signal);
        while (recover && outcome === "superseded" && !signal.aborted) {
          const newer = current();
          if (newer && newer.done !== work) {
            work = newer.done;
            outcome = await waitFor(work, signal);
            continue;
          }
          // Unsolicited host refreshes are only visible once they enter the provider.
          const replacement = latestPhase;
          if (replacement && !replacement.signal.aborted) {
            const phase = await waitFor(replacement.done, AbortSignal.any([signal, replacement.signal]))
              .catch(() => "superseded");
            if (current()?.done !== work || latestPhase !== replacement) continue;
            if (phase === "failed") return false;
          }
          if (signal.aborted || process.env.OFFLINE !== undefined) return false;
          if (catalog.isFresh()) return true;
          await new Promise<void>(resolve => { setImmediate(resolve).unref(); });
          if (current()?.done !== work || latestPhase !== replacement) continue;
          if (signal.aborted || process.env.OFFLINE !== undefined) return false;
          // This result is terminal: never issue a second recovery, or upgrade
          // the result already returned to a superseded manual command.
          return catalog.isFresh() || (await waitFor(issue(), signal)) === "ok";
        }
        return outcome === "ok";
      } catch {
        return false;
      }
    },
  };
}

type GlmExtensionAPI = Pick<ExtensionAPI, "on" | "registerProvider" | "registerCommand">;

function registerCatalogTriggers(pi: GlmExtensionAPI, catalog: ReturnType<typeof createZCodeCatalog>, session: { controller: AbortController }, refreshes: ReturnType<typeof catalogRefreshes>): void {
  let polling: { resume: () => void; rearm: () => void; stop: () => void } | undefined;
  function startPolling(ctx: ExtensionContext, afterHandoff = false) {
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
      void refreshes.run(ctx, false, signal, true).then(ok => {
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
    if (afterHandoff && process.env.OFFLINE === undefined && !catalog.isFresh()) {
      // Give host callbacks released by the fence their turn to restore before
      // a new polling generation can supersede them.
      const timer = setImmediate(() => { disarm(); resume(); }).unref();
      cancelTimer = () => clearImmediate(timer);
    } else resume();
  }
  pi.on("session_start", (_event, ctx) => {
    if (!session.controller.signal.aborted) return startPolling(ctx);
    return refreshes.fence(ctx, () => {
      session.controller = new AbortController();
      startPolling(ctx, true);
    });
  });
  pi.on("session_shutdown", () => {
    refreshes.endHandoff();
    session.controller.abort();
    catalog.clearSessionRoute();
    polling?.stop();
    polling = undefined;
  });
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
      const ok = await refreshes.run(ctx, arg === "--force", signal);
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
  let acceptedRoute: TicketRoute | undefined;
  const catalog = createZCodeCatalog(offPeakActiveFor, () => session.controller.signal, route => {
    const tickets: TicketRoute = { ...route };
    acceptedRoute = tickets;
    if (routeUsable(tickets)) void startTicket(tickets, true).promise.catch(() => {});
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
  const auth: OAuthAuth = {
    ...oauth,
    async toAuth({ access, zcodeJwtToken }) {
      const jwt = typeof zcodeJwtToken === "string" && zcodeJwtToken ? zcodeJwtToken : undefined;
      cachedCredential = jwt ? { apiKey: access, jwt } : undefined;
      const route = acceptedRoute;
      if (route && (route.access !== access || route.jwt !== jwt)) {
        route.ticket = undefined;
        const pending = route.pending;
        route.pending = undefined;
        pending?.controller.abort();
      }
      return { apiKey: access, headers: { ...buildZCodeSourceHeaders(), Authorization: "Bearer " + access } };
    },
  };
  const base = createProvider({ id: ZCODE_PROVIDER_ID, name: "GLM ZCode", baseUrl: resolveZCodeAnthropicBaseUrl(),
    auth: { oauth: auth }, models: catalog.getModels(), api: streams(session, routeFor) });
  pi.registerProvider({ ...base, getModels: catalog.getModels, getAllModels: catalog.getModels,
    refreshModels: refreshes.provider });
  registerCatalogTriggers(pi, catalog, session, refreshes);
}
