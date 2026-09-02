import os from "node:os";
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

function printableAscii(value: string): string {
  return value.replace(/[^\x20-\x7E]/g, "");
}

export function osCategory(platform: string): "macos" | "windows" | "linux" {
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "linux";
}

export function buildZCodeSourceHeaders(): Record<string, string> {
  const version = printableAscii(process.env.ZCODE_APP_VERSION || "3.10.2");
  const channel = printableAscii(process.env.ZCODE_RELEASE_CHANNEL || "production");
  const raw: Record<string, string> = {
    "User-Agent": `ZCode/${version}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": version,
    "X-Release-Channel": channel,
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": osCategory(process.platform),
    "X-Os-Version": os.version(),
    "X-Client-Language": Intl.DateTimeFormat().resolvedOptions().locale,
    "X-Client-Timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
    "X-ZCode-Agent": "glm",
  };
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    const normalized = printableAscii(value);
    if (normalized !== "") headers[key] = normalized;
  }
  return headers;
}

export default function glmZcodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider("glm-zcode", {
    name: "GLM ZCode (unofficial)",
    baseUrl: "https://api.z.ai/api/anthropic",
    api: "anthropic-messages",
    authHeader: true,
    headers: buildZCodeSourceHeaders(),
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
