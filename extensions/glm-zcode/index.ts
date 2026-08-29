import type { ExtensionAPI, ProviderConfig, ProviderModelConfig } from "@code-yeongyu/senpi";
import type { RefreshModelsContext } from "@earendil-works/pi-ai";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import {
  CATALOG_TTL_MS,
  catalogToPersistedModels,
  fetchCatalogModels,
  storedToConfig,
  thinkingConfigFor,
} from "./models.js";
import { loginGlmZcode, refreshGlmZcode } from "./oauth.js";

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

export default function glmZcodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider("glm-zcode", {
    name: "GLM ZCode (unofficial)",
    baseUrl: "https://api.z.ai/api/anthropic",
    api: "anthropic-messages",
    authHeader: true,
    headers: { "User-Agent": "ZCode/3.1.2", "X-ZCode-Agent": "glm", "X-ZCode-Version": "3.1.2" },
    models: MODELS,
    refreshModels: (async (context: RefreshModelsContext): Promise<ProviderModelConfig[] | undefined> => {
      // Offline or first-run-without-store: keep static fallback
      if (!context.allowNetwork || context.signal.aborted) {
        const restored = storedToConfig(context.stored);
        return restored.length > 0 ? restored : undefined;
      }
      // TTL: skip network when the snapshot is fresh (unless forced)
      const checkedAt = context.stored?.checkedAt;
      if (!context.force && typeof checkedAt === "number" && Date.now() - checkedAt < CATALOG_TTL_MS) {
        const restored = storedToConfig(context.stored);
        return restored.length > 0 ? restored : undefined;
      }
      try {
        const models = await fetchCatalogModels(context.signal);
        if (models.length === 0) {
          const restored = storedToConfig(context.stored);
          return restored.length > 0 ? restored : undefined;
        }
        await context.publish({
          persist: {
            models: catalogToPersistedModels(models) as unknown as NonNullable<RefreshModelsContext["stored"]>["models"],
            checkedAt: Date.now(),
          },
        });
        return models;
      } catch {
        // Never throw from refreshModels: graceful degradation to stored/static
        const restored = storedToConfig(context.stored);
        return restored.length > 0 ? restored : undefined;
      }
    }) as NonNullable<ProviderConfig["refreshModels"]>,
    oauth: {
      name: "GLM ZCode (unofficial)",
      login: loginGlmZcode,
      refreshToken: refreshGlmZcode,
      getApiKey: (credentials: OAuthCredentials) => credentials.access,
    },
  });
}
