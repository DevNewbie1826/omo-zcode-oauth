import os from "node:os";
import type { ProviderModelConfig } from "@code-yeongyu/senpi";
import type { Model, ModelsStoreEntry } from "@earendil-works/pi-ai";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const CATALOG_PROVIDER = "zai-coding-plan";
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 30_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

// Z.AI anthropic endpoint accepts only low/high/max (error 1210 otherwise).
export const ZAI_THINKING_LEVEL_MAP = {
  minimal: "low",
  low: "low",
  medium: "low",
  high: "high",
  xhigh: "max",
  max: "max",
} as const;

type JsonRecord = Record<string, unknown>;
type InputModality = ProviderModelConfig["input"][number];
/** Persist only the Model fields this catalog actually writes; assignable to ModelsStoreEntry.models. */
type ZCodePersistedModel = Pick<
  Model<"anthropic-messages">,
  | "provider"
  | "api"
  | "baseUrl"
  | "id"
  | "name"
  | "reasoning"
  | "input"
  | "cost"
  | "contextWindow"
  | "maxTokens"
  | "thinkingLevelMap"
  | "compat"
>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInputModality(value: unknown): value is InputModality {
  return value === "text" || value === "image" || value === "video";
}

function filteredInput(value: unknown): ProviderModelConfig["input"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const input = value.filter(isInputModality);
  return input.length > 0 ? input : ["text"];
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const ANTHROPIC_COMPAT_FLAGS = [
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "sendSessionAffinityHeaders",
  "supportsCacheControlOnTools",
  "supportsDisabledThinking",
  "supportsTemperature",
  "supportsToolChoice",
  "supportsForcedToolChoice",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
  "supportsToolReferences",
  "supportsWebSearch",
] as const satisfies readonly (keyof NonNullable<Model<"anthropic-messages">["compat"]>)[];

function anthropicMessagesCompat(value: object): NonNullable<Model<"anthropic-messages">["compat"]> {
  if (!isRecord(value)) return {};
  const compat: NonNullable<Model<"anthropic-messages">["compat"]> = {};
  for (const key of ANTHROPIC_COMPAT_FLAGS) {
    const entry = value[key];
    if (typeof entry === "boolean") {
      compat[key] = entry;
    }
  }
  if (value.unsignedThinkingReplay === "text" || value.unsignedThinkingReplay === "empty-signature") {
    compat.unsignedThinkingReplay = value.unsignedThinkingReplay;
  }
  return compat;
}

export function thinkingConfigFor(
  reasoningOptions: unknown,
): Pick<ProviderModelConfig, "thinkingLevelMap" | "compat"> {
  const firstOption = Array.isArray(reasoningOptions) ? reasoningOptions[0] : undefined;
  const reasoningType = isRecord(firstOption) ? firstOption.type : undefined;

  return {
    thinkingLevelMap: { ...ZAI_THINKING_LEVEL_MAP },
    compat:
      reasoningType === "toggle"
        ? undefined
        : { supportsDisabledThinking: false, forceAdaptiveThinking: true },
  };
}

export async function fetchCatalogModels(signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(MODELS_DEV_API_URL, { signal: requestSignal });
  if (!response.ok) throw new Error(`models.dev catalog request failed: ${response.status}`);

  const json: unknown = await response.json();
  if (!isRecord(json)) return [];
  const provider = json[CATALOG_PROVIDER];
  if (!isRecord(provider) || !isRecord(provider.models)) return [];

  const models: ProviderModelConfig[] = [];
  for (const [id, model] of Object.entries(provider.models)) {
    if (!isRecord(model)) continue;
    const limit = model.limit;
    if (!isRecord(limit) || !finiteNumber(limit.context) || limit.context <= 0) continue;

    const modalities = isRecord(model.modalities) ? model.modalities : undefined;
    const input = filteredInput(modalities?.input ?? ["text"]) ?? ["text"];
    models.push({
      id,
      name: typeof model.name === "string" ? model.name : id,
      reasoning: model.reasoning === true,
      input,
      cost: { ...ZERO_COST },
      contextWindow: limit.context,
      maxTokens: finiteNumber(limit.output) ? limit.output : 131_072,
      ...thinkingConfigFor(model.reasoning_options),
    });
  }
  return models;
}

export function catalogToPersistedModels(models: readonly ProviderModelConfig[]): ModelsStoreEntry["models"] {
  return models.map(toPersistedModel);
}

function toPersistedModel(model: ProviderModelConfig): ZCodePersistedModel {
  return {
    provider: "glm-zcode",
    api: "anthropic-messages",
    baseUrl: "https://api.z.ai/api/anthropic",
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.thinkingLevelMap ? { thinkingLevelMap: { ...model.thinkingLevelMap } } : {}),
    ...(model.compat ? { compat: anthropicMessagesCompat(model.compat) } : {}),
  };
}

export function storedToConfig(stored: Readonly<ModelsStoreEntry> | undefined): ProviderModelConfig[] {
  if (!Array.isArray(stored?.models)) return [];

  const models: ProviderModelConfig[] = [];
  for (const model of stored.models) {
    if (!isRecord(model)) continue;
    const input = filteredInput(model.input);
    const cost = model.cost;
    const thinkingLevelMap =
      model.thinkingLevelMap === undefined ? undefined : { ...model.thinkingLevelMap };
    const compat = isRecord(model.compat) ? anthropicMessagesCompat(model.compat) : undefined;
    const thinkingConfig =
      thinkingLevelMap === undefined
        ? thinkingConfigFor(undefined)
        : { thinkingLevelMap, ...(compat ? { compat } : {}) };
    if (
      typeof model.id !== "string" ||
      model.id.length === 0 ||
      typeof model.name !== "string" ||
      model.name.length === 0 ||
      typeof model.reasoning !== "boolean" ||
      input === undefined ||
      !isRecord(cost) ||
      !finiteNumber(cost.input) ||
      !finiteNumber(cost.output) ||
      !finiteNumber(cost.cacheRead) ||
      !finiteNumber(cost.cacheWrite) ||
      !finiteNumber(model.contextWindow) ||
      model.contextWindow <= 0 ||
      !finiteNumber(model.maxTokens) ||
      model.maxTokens <= 0
    ) {
      continue;
    }

    models.push({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input,
      cost: {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      },
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...thinkingConfig,
    });
  }
  return models;
}

// ---------------------------------------------------------------------------
// ZCode source headers (hoisted here so live-catalog.ts can use them without
// a circular import through index.ts, which re-exports them for consumers).
// ---------------------------------------------------------------------------

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
