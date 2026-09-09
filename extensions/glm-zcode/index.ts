import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";
import type { RefreshModelsContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { CATALOG_TTL_MS, buildZCodeSourceHeaders, catalogToPersistedModels, fetchCatalogModels, resolveZCodeAnthropicBaseUrl, storedToConfig, thinkingConfigFor } from "./models.js";
import { fetchLiveModels } from "./live-catalog.js";
import { loginGlmZcode, refreshGlmZcode } from "./oauth.js";
import { resolveZCodeSigningHeaders } from "./signing.js";

let anthropicStreamSimple: typeof import("@earendil-works/pi-ai/api/anthropic-messages").streamSimple | undefined;
let createEventStream: typeof import("@earendil-works/pi-ai/utils/event-stream").createAssistantMessageEventStream | undefined;
try {
  ({ streamSimple: anthropicStreamSimple } = await import("@earendil-works/pi-ai/api/anthropic-messages"));
  ({ createAssistantMessageEventStream: createEventStream } = await import("@earendil-works/pi-ai/utils/event-stream"));
} catch {
  anthropicStreamSimple = undefined;
}
import {
  OFFPEAK_BASE_URL,
  SIGNATURE_HEADERS,
  isOffPeakRouted,
  isOffPeakWindow,
  isTicketFresh,
  takeTicketState,
  applyOffPeakRouting,
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

type RefreshModels = NonNullable<ProviderConfig["refreshModels"]>;

// Existing consumers (and tests) import these from the extension entry point.
export { buildZCodeSourceHeaders, osCategory } from "./models.js";

// Static fallback for offline/first-run before catalog fetch.
const MODELS = [
  {
    id: "glm-5.3",
    name: "GLM-5.3",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    baseUrl: resolveZCodeAnthropicBaseUrl(),
    ...thinkingConfigFor(undefined),
  },
] satisfies ProviderModelConfig[];

/** Resolves the effective API key from the type-tagged credential union; missing/empty means none. */
function credentialApiKey(credential: RefreshModelsContext["credential"]): string | undefined {
  switch (credential?.type) {
    case "oauth":
      return credential.access || undefined;
    case "api_key":
      return credential.key || undefined;
    case undefined:
      return undefined;
    default: {
      const unhandled: never = credential;
      throw new Error(`unsupported credential type: ${String(unhandled)}`);
    }
  }
}

/** Whether the stored snapshot is fresh enough to skip both catalogs (force always bypasses). */
function hasFreshSnapshot(context: RefreshModelsContext): boolean {
  const checkedAt = context.stored?.checkedAt;
  return !context.force && typeof checkedAt === "number" && Date.now() - checkedAt < CATALOG_TTL_MS;
}

function restoreStored(context: RefreshModelsContext): ProviderModelConfig[] | undefined {
  const restored = storedToConfig(context.stored);
  return restored.length > 0 ? restored : undefined;
}

/** The pre-existing models.dev path: TTL/stored/static behavior, unchanged. */
async function refreshCatalogDev(context: RefreshModelsContext): Promise<ProviderModelConfig[] | undefined> {
  // Offline or first-run-without-store: keep static fallback
  if (!context.allowNetwork || context.signal.aborted) return restoreStored(context);
  // TTL: skip network when the snapshot is fresh (unless forced)
  if (hasFreshSnapshot(context)) return restoreStored(context);
  try {
    const models = await fetchCatalogModels(context.signal);
    if (models.length === 0) return restoreStored(context);
    await context.publish({
      persist: {
        models: catalogToPersistedModels(models),
        checkedAt: Date.now(),
      },
    });
    return models;
  } catch {
    // Never throw from refreshModels: graceful degradation to stored/static
    return restoreStored(context);
  }
}

/**
 * Hybrid catalog: with a credential and network access, prefer the authenticated live
 * /v1/models endpoint; any live failure (network, non-2xx, bad shape, empty) degrades to
 * the models.dev path verbatim. Without a credential only models.dev runs.
 *
 * Cache note: ModelsStoreEntry has no typed credential-fingerprint slot, so the live path
 * honors the shared 24h TTL and only context.force bypasses it. A re-login under a
 * different account may therefore serve a stale live snapshot for up to the TTL.
 */
let offPeakTransportOverride: boolean | undefined;

/** Transport readiness: without the wrapped streamSimple, off-peak models could never reroute on failure. */
function offPeakTransportReady(): boolean {
  return offPeakTransportOverride ?? (anthropicStreamSimple !== undefined && createEventStream !== undefined);
}

/** The per-model off-peak route decision: transport + window + entitlement + a usable JWT. */
async function offPeakActiveFor(context: RefreshModelsContext): Promise<boolean> {
  if (!offPeakTransportReady()) return false;
  if (!isOffPeakWindow(offPeakTestClock ?? new Date()) || !context.allowNetwork || context.signal.aborted) return false;
  if (context.credential?.type !== "oauth") return false;
  const jwt = typeof context.credential.zcodeJwtToken === "string" ? context.credential.zcodeJwtToken : undefined;
  const apiKey = credentialApiKey(context.credential);
  if (!jwt || !apiKey) return false;
  if (!(await fetchOffPeakAvailability(jwt, apiKey))) return false;
  preTakenTicket = undefined;
  const warm = ensureOffPeakTicket(jwt, apiKey, currentOffPeakTaskId());
  pendingTicket = { apiKey, jwt, promise: warm };
  warm.then((ticketId) => {
    if (ticketId) preTakenTicket = takeTicketState(jwt, apiKey, ticketId, offPeakTestClock ?? new Date());
    else if (pendingTicket?.promise === warm) pendingTicket = undefined;
  }).catch(() => {
    if (pendingTicket?.promise === warm) pendingTicket = undefined;
  });
  // Routing only requires the entitlement; the ticket warms up in the background.
  return true;
}

async function refreshModels(context: Parameters<RefreshModels>[0]): ReturnType<RefreshModels>;
async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[] | undefined> {
  const apiKey = credentialApiKey(context.credential);
  if (context.allowNetwork && !context.signal.aborted && apiKey !== undefined && !hasFreshSnapshot(context)) {
    try {
      const live = await fetchLiveModels(apiKey, context.signal);
      if (live.length > 0) {
        const routed = applyOffPeakRouting(live, await offPeakActiveFor(context));
        await context.publish({
          persist: {
            models: catalogToPersistedModels(routed),
            checkedAt: Date.now(),
          },
        });
        return routed;
      }
    } catch (error) {
      console.debug(
        `glm-zcode: live catalog unavailable, falling back to models.dev (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
  const fromDev = await refreshCatalogDev(context);
  return fromDev === undefined ? undefined : applyOffPeakRouting(fromDev, await offPeakActiveFor(context));
}

/**
 * Request-time endpoint selection. The headers hook can only strip the
 * marker (and skip signing); this streamSimple override is the one layer
 * that controls the actual destination: a fresh ticket inside the window
 * sends the request to the off-peak gateway with JWT auth, anything else
 * falls back to the signed ultra gateway with the normal API key.
 */
const offPeakStreamSimple = ((model: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0], context: Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1], options?: SimpleStreamOptions) => {
  const outer = createEventStream!() as unknown as ReturnType<NonNullable<ProviderConfig["streamSimple"]>>;
  if (isOffPeakRouted(model)) {
    const now = offPeakTestClock ?? new Date();
    const apiKey = options?.apiKey ?? "";
    const credential = cachedCredential && cachedCredential.apiKey === apiKey ? cachedCredential : undefined;
    const waitFresh = (promise: Promise<string | undefined>) =>
      Promise.race([promise, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), TICKET_REQUEST_WAIT_MS))]);
    const acquire = isTicketFresh(preTakenTicket, now, apiKey, credential?.jwt ?? "")
      ? Promise.resolve(preTakenTicket!.ticketId)
      : credential && isOffPeakWindow(now)
        ? waitFresh(
            (pendingTicket && pendingTicket.apiKey === apiKey && pendingTicket.jwt === credential.jwt
              ? pendingTicket.promise
              : startPendingTicket(credential.jwt, apiKey)
            ).then((ticketId) => {
              if (ticketId) preTakenTicket = takeTicketState(credential.jwt, apiKey, ticketId, offPeakTestClock ?? new Date());
              return ticketId;
            }),
          )
        : Promise.resolve(undefined);
    acquire
      .then((ticketId) => {
        const stillInWindow = isOffPeakWindow(offPeakTestClock ?? new Date());
        const fallbackModel = { ...model, baseUrl: resolveZCodeAnthropicBaseUrl() };
        if (ticketId && credential && stillInWindow) {
          const stripped: Record<string, string | null> = { ...(options?.headers as Record<string, string | null> ?? {}) };
          for (const header of SIGNATURE_HEADERS) delete stripped[header];
          return anthropicStreamSimple!(
            { ...fallbackModel, baseUrl: OFFPEAK_BASE_URL } as Parameters<NonNullable<typeof anthropicStreamSimple>>[0],
            context,
            {
              ...options,
              headers: { ...stripped, ...offPeakRequestHeaders(credential.jwt, apiKey, ticketId) },
            },
          );
        }
        const signingInput: Record<string, string | null> = { ...(options?.headers as Record<string, string | null> ?? {}), Authorization: `Bearer ${apiKey}` };
        return resolveZCodeSigningHeaders(signingInput).then((signed) =>
          anthropicStreamSimple!(fallbackModel as Parameters<NonNullable<typeof anthropicStreamSimple>>[0], context, {
            ...options,
            headers: { ...(options?.headers ?? {}), ...signed },
          }),
        );
      })
      .then((inner) => {
        (async () => {
          for await (const event of inner) outer.push(event);
          outer.end(await inner.result());
        })().catch((error) => outer.fail(error));
      })
      .catch((error) => outer.fail(error));
    return outer;
  }
  return anthropicStreamSimple!(model as Parameters<NonNullable<typeof anthropicStreamSimple>>[0], context, options);
}) as unknown as NonNullable<ProviderConfig["streamSimple"]>;

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

export default function glmZcodeExtension(pi: ExtensionAPI): void {
  pi.on("before_provider_headers", async (event) => {
    Object.assign(event.headers, await resolveZCodeSigningHeaders(event.headers));
  });
  pi.registerProvider("glm-zcode", {
    name: "GLM ZCode (unofficial)",
    api: "anthropic-messages",
    authHeader: true,
    headers: buildZCodeSourceHeaders(),
    models: MODELS.map((model) => ({ ...model, baseUrl: resolveZCodeAnthropicBaseUrl() })),
    ...(offPeakTransportReady() ? { streamSimple: offPeakStreamSimple } : {}),
    refreshModels,
    oauth: {
      name: "GLM ZCode (unofficial)",
      login: loginGlmZcode,
      refreshToken: refreshGlmZcode,
      getApiKey: (credentials: OAuthCredentials) => {
        const jwt = typeof credentials.zcodeJwtToken === "string" && credentials.zcodeJwtToken ? credentials.zcodeJwtToken : undefined;
        cachedCredential = jwt ? { apiKey: credentials.access, jwt } : undefined;
        if (preTakenTicket && (preTakenTicket.apiKey !== credentials.access || preTakenTicket.jwt !== (jwt ?? ""))) {
          preTakenTicket = undefined;
        }
        return credentials.access;
      },
    },
  });
}
