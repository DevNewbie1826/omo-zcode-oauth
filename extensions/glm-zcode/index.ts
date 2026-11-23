import type { ExtensionAPI, ExtensionContext } from "@code-yeongyu/senpi";
import { createAssistantMessageEventStream, createProvider, hasApi, type OAuthAuth, type ProviderStreams, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { stream as anthropicStream, streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { CATALOG_REFRESH_INTERVAL_MS, ZCODE_PROVIDER_ID, buildZCodeSourceHeaders, resolveZCodeAnthropicBaseUrl } from "./models.js";
import { createZCodeCatalog } from "./catalog.js";
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
} from "./offpeak.js";

/** Side-channel for hooks that never see credentials: the JWT cached at auth resolution, bound to its API key so concurrent credential swaps cannot mix accounts. */
let cachedCredential: { apiKey: string; jwt: string } | undefined;
const TICKET_REQUEST_WAIT_MS = 60_000;
let offPeakTaskId: string | undefined;
let preTakenTicket: import("./offpeak.js").OffPeakTicketState | undefined;
let pendingTicket: { apiKey: string; jwt: string; promise: Promise<string | undefined> } | undefined;
let offPeakTestClock: Date | undefined;

function currentOffPeakTaskId(): string {
  offPeakTaskId ??= `omo-offpeak-${crypto.randomUUID()}`;
  return offPeakTaskId;
}

// Existing consumers (and tests) import these from the extension entry point.
export { buildZCodeSourceHeaders, osCategory } from "./models.js";

let offPeakTransportOverride: boolean | undefined;

/** Transport helpers are statically imported (always available); the override remains a test hook simulating unavailability. */
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
  if (!(await fetchOffPeakAvailability(jwt, apiKey))) return false;
  preTakenTicket = undefined;
  startPendingTicket(jwt, apiKey).then((ticketId) => {
    // A late settlement must not resurrect state after a reset or credential swap.
    if (ticketId && cachedCredential?.apiKey === apiKey && cachedCredential.jwt === jwt) {
      preTakenTicket = takeTicketState(jwt, apiKey, ticketId, offPeakTestClock ?? new Date());
    }
  }).catch(() => {});
  // Routing only requires the entitlement; the ticket warms up in the background.
  return true;
}

function ticketRouteEnabled(): boolean {
  return process.env.ZCODE_OFFPEAK_ENABLE === "1" && offPeakTransportReady() && !process.env.ZCODE_ANTHROPIC_BASE_URL?.trim();
}

async function requestTicket(apiKey: string, jwt: string): Promise<string | undefined> {
  const now = offPeakTestClock ?? new Date();
  if (!isOffPeakWindow(now) || !ticketRouteEnabled()) return undefined;
  if (preTakenTicket && isTicketFresh(preTakenTicket, now, apiKey, jwt)) return preTakenTicket.ticketId;
  const pending = pendingTicket?.apiKey === apiKey && pendingTicket.jwt === jwt
    ? pendingTicket.promise : startPendingTicket(jwt, apiKey);
  let timer: NodeJS.Timeout | undefined;
  try {
    const id = await Promise.race([pending, new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), TICKET_REQUEST_WAIT_MS).unref();
    })]);
    if (id && cachedCredential?.apiKey === apiKey && cachedCredential.jwt === jwt) {
      preTakenTicket = takeTicketState(jwt, apiKey, id, offPeakTestClock ?? new Date());
    }
    return id;
  } finally { clearTimeout(timer); }
}

const streams: ProviderStreams = {
  stream(model, context, options) {
    if (!hasApi(model, "anthropic-messages")) throw new Error("Expected an Anthropic chat model");
    // Full streams never use a ticket; the headers hook already signed the normal request.
    return anthropicStream(isOffPeakRouted(model) ? { ...model, baseUrl: resolveZCodeAnthropicBaseUrl() } : model, context, options);
  },
  streamSimple(model, context, options) {
    if (!hasApi(model, "anthropic-messages")) throw new Error("Expected an Anthropic chat model");
    if (!isOffPeakRouted(model)) return anthropicStreamSimple(model, context, options);
    const outer = createAssistantMessageEventStream();
    void (async () => {
      const key = options?.apiKey ?? "";
      const jwt = cachedCredential?.apiKey === key ? cachedCredential.jwt : undefined;
      const id = jwt ? await requestTicket(key, jwt) : undefined;
      const headers = { ...options?.headers };
      let baseUrl = resolveZCodeAnthropicBaseUrl();
      if (id && jwt && cachedCredential?.apiKey === key && cachedCredential.jwt === jwt && ticketRouteEnabled() && isOffPeakWindow(offPeakTestClock ?? new Date())) {
        baseUrl = OFFPEAK_BASE_URL;
        for (const header of SIGNATURE_HEADERS) delete headers[header];
        Object.assign(headers, offPeakRequestHeaders(jwt, key, id));
      } else if (!headers["X-Client-Sig"]) {
        Object.assign(headers, await resolveZCodeSigningHeaders({ ...headers, Authorization: "Bearer " + key }));
      }
      const inner = anthropicStreamSimple({ ...model, baseUrl }, context, { ...options, headers });
      for await (const event of inner) outer.push(event);
      outer.end(await inner.result());
    })().catch(error => outer.fail(error));
    return outer;
  },
};

/** Starts a request-time acquisition; the pending entry always clears on settlement, success included. */
function startPendingTicket(jwt: string, apiKey: string): Promise<string | undefined> {
  const attempt = ensureOffPeakTicket(jwt, apiKey, currentOffPeakTaskId());
  pendingTicket = { apiKey, jwt, promise: attempt };
  const clear = () => {
    if (pendingTicket?.promise === attempt) pendingTicket = undefined;
  };
  attempt.then(clear, clear);
  return attempt;
}

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
  let existing: string | undefined;
  try {
    const raw = readFileSync(path, "utf8");
    const state = JSON.parse(raw) as { deviceMid?: string };
    const mid = state.deviceMid?.trim();
    if (mid && /^[\x20-\x7e]+$/.test(mid)) return mid;
    // Malformed or mid-less but present: NEVER overwrite app-owned state.
    existing = undefined;
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
      onPrompt: prompt => interaction.prompt({ ...prompt, type: prompt.type ?? "text" }),
      onManualCodeInput: () => interaction.prompt({ type: "manual_code", message: "Paste the ZCode redirect URL" }),
      onSelect: prompt => interaction.prompt({ type: "select", ...prompt }),
      signal: interaction.signal,
    });
    return { ...credential, type: "oauth" };
  },
  refresh: async (credential, signal) => ({ ...await refreshGlmZcode(credential, signal), type: "oauth" }),
  async toAuth({ access, zcodeJwtToken }) {
    const jwt = typeof zcodeJwtToken === "string" && zcodeJwtToken ? zcodeJwtToken : undefined;
    cachedCredential = jwt ? { apiKey: access, jwt } : undefined;
    if (preTakenTicket && (preTakenTicket.apiKey !== access || preTakenTicket.jwt !== jwt)) preTakenTicket = undefined;
    return { apiKey: access, headers: { ...buildZCodeSourceHeaders(), Authorization: "Bearer " + access } };
  },
};

async function refreshCatalog(ctx: ExtensionContext, force: boolean): Promise<boolean> {
  try {
    const result = await ctx.modelRegistry.refresh({ providers: [ZCODE_PROVIDER_ID], force,
      allowNetwork: process.env.OFFLINE === undefined, signal: AbortSignal.timeout(15_000) });
    return !result.aborted && result.errors.size === 0;
  } catch {
    // Registry errors may contain credentials. Never forward their messages to the UI.
    return false;
  }
}

type GlmExtensionAPI = Pick<ExtensionAPI, "on" | "registerProvider" | "registerCommand">;

function registerCatalogTriggers(pi: GlmExtensionAPI, catalog: ReturnType<typeof createZCodeCatalog>): void {
  let stop: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (stop || process.env.OFFLINE !== undefined) return;
    let cancelTimer: (() => void) | undefined;
    let active = true;
    stop = () => { active = false; cancelTimer?.(); };

    function schedule() {
      cancelTimer?.();
      if (!active || process.env.OFFLINE !== undefined) return;
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
      if (!active || process.env.OFFLINE !== undefined || catalog.isFresh()) return schedule();
      cancelTimer?.();
      void refreshCatalog(ctx, false).then(ok => {
        if (!active) return;
        if (!ok && ctx.hasUI) ctx.ui.notify("GLM ZCode catalog refresh failed; retained cached models.", "warning");
        schedule(); // Schedule from the accepted publication, not the start of this GET.
      });
    }
    if (catalog.isFresh()) schedule();
    else tick();
  });
  pi.on("session_shutdown", () => { stop?.(); stop = undefined; });
  pi.registerCommand("glm-models", {
    description: "Refresh and list GLM ZCode models", argumentHint: "[--force]",
    async handler(args, ctx) {
      const arg = args.trim();
      if (arg && arg !== "--force") {
        if (ctx.hasUI) ctx.ui.notify("Usage: /glm-models [--force]", "warning");
        return;
      }
      const offline = process.env.OFFLINE !== undefined;
      const ok = await refreshCatalog(ctx, arg === "--force");
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
  const catalog = createZCodeCatalog(offPeakActiveFor);
  pi.on("before_provider_request", (event) => {
    if (event.model?.provider !== "glm-zcode" || event.payload == null || typeof event.payload !== "object") return event.payload;
    const payload = event.payload as { model?: unknown; metadata?: { user_id?: unknown } & Record<string, unknown> };
    if (typeof payload.model === "string") payload.model = catalog.officialGlmModelId(payload.model);
    if (payload.metadata?.user_id !== undefined) return event.payload;
    const metadata = deviceIdentityMetadata();
    if (!metadata) return event.payload;
    payload.metadata = { ...(payload.metadata as Record<string, unknown> | undefined), ...metadata };
    return payload;
  });
  pi.on("before_provider_headers", async (event) => {
    Object.assign(event.headers, await resolveZCodeSigningHeaders(event.headers));
  });
  const base = createProvider({ id: ZCODE_PROVIDER_ID, name: "GLM ZCode", baseUrl: resolveZCodeAnthropicBaseUrl(),
    auth: { oauth }, models: catalog.getModels(), api: streams });
  pi.registerProvider({ ...base, getModels: catalog.getModels, getAllModels: catalog.getModels, refreshModels: catalog.refresh });
  registerCatalogTriggers(pi, catalog);
}
