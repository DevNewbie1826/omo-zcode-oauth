import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { CATALOG_TTL_MS, buildZCodeSourceHeaders, catalogToPersistedModels, fetchCatalogModels, resolveZCodeAnthropicBaseUrl, storedToConfig, thinkingConfigFor } from "./models.js";
import { fetchLiveModels } from "./live-catalog.js";
import { loginGlmZcode, refreshGlmZcode } from "./oauth.js";
import { resolveZCodeSigningHeaders } from "./signing.js";
import {
  OFFPEAK_ROUTE_MARKER,
  installOffPeakAuth,
  applyOffPeakRouting,
  ensureOffPeakTicket,
  fetchOffPeakAvailability,
  isOffPeakWindow,
  offPeakRequestHeaders,
} from "./offpeak.js";

/** Side-channel for hooks that never see credentials: the JWT cached at auth resolution, bound to its API key so concurrent credential swaps cannot mix accounts. */
let cachedCredential: { apiKey: string; jwt: string } | undefined;
let offPeakTaskId: string | undefined;
let preTakenTicket: { apiKey: string; jwt: string; ticketId: string } | undefined;

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
/** The per-model off-peak route decision: window + entitlement + a usable JWT. */
async function offPeakActiveFor(context: RefreshModelsContext): Promise<boolean> {
  if (!isOffPeakWindow() || !context.allowNetwork || context.signal.aborted) return false;
  if (context.credential?.type !== "oauth") return false;
  const jwt = typeof context.credential.zcodeJwtToken === "string" ? context.credential.zcodeJwtToken : undefined;
  const apiKey = credentialApiKey(context.credential);
  if (!jwt || !apiKey) return false;
  if (!(await fetchOffPeakAvailability(jwt, apiKey))) return false;
  preTakenTicket = undefined;
  const ticketId = await ensureOffPeakTicket(jwt, apiKey, currentOffPeakTaskId());
  if (ticketId) preTakenTicket = { apiKey, jwt, ticketId };
  return ticketId !== undefined;
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

/** Thin state wrapper: binds the request's API key to its cached JWT and the pre-taken ticket. */
async function applyOffPeakHeaders(headers: Record<string, string | null>): Promise<boolean> {
  const credential = cachedCredential;
  return installOffPeakAuth(headers, {
    credential: credential ? { ...credential } : undefined,
    ensureTicket: async (jwt, apiKey) => {
      if (preTakenTicket && preTakenTicket.apiKey === apiKey && preTakenTicket.jwt === jwt) return preTakenTicket.ticketId;
      return ensureOffPeakTicket(jwt, apiKey, currentOffPeakTaskId());
    },
  });
}

export default function glmZcodeExtension(pi: ExtensionAPI): void {
  pi.on("before_provider_headers", async (event) => {
    if (await applyOffPeakHeaders(event.headers)) return;
    Object.assign(event.headers, await resolveZCodeSigningHeaders(event.headers));
  });
  pi.registerProvider("glm-zcode", {
    name: "GLM ZCode (unofficial)",
    api: "anthropic-messages",
    authHeader: true,
    headers: buildZCodeSourceHeaders(),
    models: MODELS.map((model) => ({ ...model, baseUrl: resolveZCodeAnthropicBaseUrl() })),
    refreshModels,
    oauth: {
      name: "GLM ZCode (unofficial)",
      login: loginGlmZcode,
      refreshToken: refreshGlmZcode,
      getApiKey: (credentials: OAuthCredentials) => {
        const jwt = typeof credentials.zcodeJwtToken === "string" && credentials.zcodeJwtToken ? credentials.zcodeJwtToken : undefined;
        cachedCredential = jwt ? { apiKey: credentials.access, jwt } : undefined;
        preTakenTicket = preTakenTicket?.apiKey === credentials.access ? preTakenTicket : undefined;
        return credentials.access;
      },
    },
  });
}
