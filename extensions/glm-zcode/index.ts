import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import {
  CATALOG_TTL_MS,
  buildZCodeSourceHeaders,
  catalogToPersistedModels,
  fetchCatalogModels,
  storedToConfig,
  thinkingConfigFor,
} from "./models.js";
import { fetchLiveModels } from "./live-catalog.js";
import { loginGlmZcode, refreshGlmZcode } from "./oauth.js";

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
async function refreshModels(context: Parameters<RefreshModels>[0]): ReturnType<RefreshModels>;
async function refreshModels(context: RefreshModelsContext): Promise<ProviderModelConfig[] | undefined> {
  const apiKey = credentialApiKey(context.credential);
  if (context.allowNetwork && !context.signal.aborted && apiKey !== undefined && !hasFreshSnapshot(context)) {
    try {
      const live = await fetchLiveModels(apiKey, context.signal);
      if (live.length > 0) {
        await context.publish({
          persist: {
            models: catalogToPersistedModels(live),
            checkedAt: Date.now(),
          },
        });
        return live;
      }
    } catch (error) {
      console.debug(
        `glm-zcode: live catalog unavailable, falling back to models.dev (${
          error instanceof Error ? error.message : String(error)
        })`,
      );
    }
  }
  return refreshCatalogDev(context);
}

export default function glmZcodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider("glm-zcode", {
    name: "GLM ZCode (unofficial)",
    baseUrl: "https://api.z.ai/api/anthropic",
    api: "anthropic-messages",
    authHeader: true,
    headers: buildZCodeSourceHeaders(),
    models: MODELS,
    refreshModels,
    oauth: {
      name: "GLM ZCode (unofficial)",
      login: loginGlmZcode,
      refreshToken: refreshGlmZcode,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
  });
}
