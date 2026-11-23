import os from "node:os";
import type { ProviderModelConfig } from "@code-yeongyu/senpi";
import type { Model, ModelsStoreEntry } from "@earendil-works/pi-ai";

/** The chat member of the host's provider-row union; image and classifier rows are out of scope. */
export type ZCodeChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

export const ZCODE_PROVIDER_ID = "glm-zcode";
export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const CATALOG_PROVIDER = "zai-coding-plan";
export const MODELS_DEV_FALLBACK_PROVIDER = "zai";
/** Due-check interval for the live catalog. This is the only freshness constant; there is no 24-hour TTL. */
export const CATALOG_REFRESH_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Inference base URL. ZCode 3.11.2 routes `api.z.ai/api/anthropic/v1/messages`
 * here via the agent-configs proxy mapping; the ultra gateway is where signed
 * (client-signature V4) traffic is recognized for plan-quota classification.
 * `ZCODE_ANTHROPIC_BASE_URL` reverts to the direct endpoint when set.
 */
export const ULTRA_BASE_URL = "https://zcode.z.ai/api/v1/ultra-zai/anthropic";

export function resolveZCodeAnthropicBaseUrl(): string {
  const override = printableAscii(process.env.ZCODE_ANTHROPIC_BASE_URL || "");
  return override || ULTRA_BASE_URL;
}

export function zcodeAppVersion(): string {
  return printableAscii(process.env.ZCODE_APP_VERSION || "4.0.0");
}

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

/** Input modalities a chat catalogue row can carry (vitest-visible sets exclude video/pdf). */
export type ZCodeInputModality = "text" | "image";

/** Narrower than the whole ProviderModelConfig union, which ImageApi/ClassifierApi rows also join. */
export type ZCodeThinkingConfig = Pick<Model<"anthropic-messages">, "thinkingLevelMap" | "compat">;

/** Live metadata never supplies id or name; only these four fields cross the merge. */
export interface ZCodeChatModelMetadata {
  reasoning: boolean;
  input: ZCodeInputModality[];
  contextWindow: number;
  maxTokens: number;
}

/**
 * What one models.dev row actually states. A field the row omits or writes
 * invalidly stays absent, so a later section or the live defaults can supply it
 * instead of a manufactured value masquerading as authoritative metadata.
 */
export interface ZCodeChatModelMetadataFields {
  reasoning?: boolean;
  input?: ZCodeInputModality[];
  contextWindow?: number;
  maxTokens?: number;
}

/** Defaults for live ids without models.dev metadata, including 5.4: text-only, 1M context, 131072 output. */
export const ZCODE_CHAT_DEFAULTS: ZCodeChatModelMetadata = {
  reasoning: true,
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 131_072,
};

const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChatInputModality(value: unknown): value is "text" | "image" | "video" {
  return value === "text" || value === "image" || value === "video";
}

function isThinkingLevel(value: string): value is ModelThinkingLevel {
  return (MODEL_THINKING_LEVELS as readonly string[]).includes(value);
}

/** Legacy row filter: keeps text/image/video (models.dev video rows historically mapped as video). */
function filteredInput(value: unknown): ZCodeChatModelConfig["input"] | undefined {
  if (!Array.isArray(value)) return undefined;
  const input = [...new Set(value.filter(isChatInputModality))];
  return input.length > 0 ? input : ["text"];
}

/** Drops video/pdf from models.dev rows; the chat union here is text/image only. */
function metadataInput(value: unknown): ZCodeInputModality[] {
  if (!Array.isArray(value)) return [...ZCODE_CHAT_DEFAULTS.input];
  const input = [...new Set(value.filter((entry): entry is ZCodeInputModality => entry === "text" || entry === "image"))];
  return input.length > 0 ? input : [...ZCODE_CHAT_DEFAULTS.input];
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

function storedThinkingMap(value: unknown): Model<"anthropic-messages">["thinkingLevelMap"] | undefined {
  if (!isRecord(value)) return undefined;
  const map: Model<"anthropic-messages">["thinkingLevelMap"] = {};
  for (const [level, wire] of Object.entries(value)) {
    if (!isThinkingLevel(level)) continue;
    if (wire === null || typeof wire === "string") map[level] = wire;
  }
  return map;
}

/**
 * Thinking/compat fields for a models.dev row: a `toggle` reasoning row omits the
 * compat override so the endpoint keeps its default disabled-thinking behavior.
 */
export function thinkingConfigFor(reasoningOptions: unknown): ZCodeThinkingConfig {
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

/**
 * Copies (or defaults) a row's thinking fields. Stored rows keep their persisted
 * map/compat; an untyped legacy row gets the conservative defaults.
 */
export function chatThinkingConfig(seed?: { thinkingLevelMap?: unknown; compat?: unknown }): ZCodeThinkingConfig {
  if (seed === undefined) {
    return {
      thinkingLevelMap: { ...ZAI_THINKING_LEVEL_MAP },
      compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
    };
  }
  const thinkingLevelMap = storedThinkingMap(seed.thinkingLevelMap) ?? ZAI_THINKING_LEVEL_MAP;
  return {
    thinkingLevelMap: { ...thinkingLevelMap },
    compat: isRecord(seed.compat) ? anthropicMessagesCompat(seed.compat) : undefined,
  };
}

export function chatModelConfig(model: ProviderModelConfig): model is ZCodeChatModelConfig {
  return model.type === undefined || model.type === "chat";
}

export function toChatModelConfig(
  id: string,
  name: string,
  metadata: ZCodeChatModelMetadata,
  thinking: ZCodeThinkingConfig = chatThinkingConfig(),
): ZCodeChatModelConfig {
  return {
    id,
    name,
    reasoning: metadata.reasoning,
    input: [...metadata.input],
    cost: { ...ZERO_COST },
    contextWindow: metadata.contextWindow,
    maxTokens: metadata.maxTokens,
    ...(thinking.thinkingLevelMap ? { thinkingLevelMap: { ...thinking.thinkingLevelMap } } : {}),
    ...(thinking.compat ? { compat: { ...thinking.compat } } : {}),
  };
}

/**
 * The two emergency fallback rows (5.3 text, 5.4 text/image), complete native chat
 * configs at zero cost. They are a display list only: they seed no timestamp and
 * are not a source of official wire spellings.
 */
export function zcodeFallbackChatModels(): ZCodeChatModelConfig[] {
  return [
    toChatModelConfig("glm-5.3", "GLM-5.3", {
      reasoning: true,
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    }),
    toChatModelConfig("glm-5.4", "GLM-5.4", {
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    }),
  ];
}

/**
 * Official wire spelling for a catalog id: the accepted name only when it differs
 * from the id in case alone; a friendly name never becomes a wire id.
 */
export function catalogWireName(id: string, name: string | undefined): string {
  return name !== undefined && name.toLowerCase() === id.toLowerCase() ? name : id;
}

function parseDevRow(id: string, model: unknown): ZCodeChatModelConfig | undefined {
  if (!isRecord(model)) return undefined;
  const limit = model.limit;
  if (!isRecord(limit) || !finiteNumber(limit.context) || limit.context <= 0) return undefined;

  const modalities = isRecord(model.modalities) ? model.modalities : undefined;
  return toChatModelConfig(
    id,
    typeof model.name === "string" ? model.name : id,
    {
      reasoning: model.reasoning === true,
      input: metadataInput(modalities?.input),
      contextWindow: limit.context,
      maxTokens: finiteNumber(limit.output) && limit.output > 0 ? limit.output : ZCODE_CHAT_DEFAULTS.maxTokens,
    },
    thinkingConfigFor(model.reasoning_options),
  );
}

function devSectionModels(payload: JsonRecord, provider: string): JsonRecord | undefined {
  const section = payload[provider];
  return isRecord(section) && isRecord(section.models) ? section.models : undefined;
}

/**
 * Parses models.dev rows into legacy chat configs. `zai-coding-plan` wins for an id
 * present in both sections; `zai` only fills ids the primary section lacks.
 */
export function catalogRowsFromModelsDev(payload: unknown): ZCodeChatModelConfig[] {
  if (!isRecord(payload)) return [];
  const rows = new Map<string, ZCodeChatModelConfig>();
  for (const section of [CATALOG_PROVIDER, MODELS_DEV_FALLBACK_PROVIDER]) {
    const models = devSectionModels(payload, section);
    if (!models) continue;
    for (const [id, model] of Object.entries(models)) {
      if (rows.has(id)) continue;
      const row = parseDevRow(id, model);
      if (row) rows.set(id, row);
    }
  }
  return [...rows.values()];
}

/**
 * The stated fields of one models.dev row. A row needs a usable context limit to
 * count at all; beyond that, each field is kept only when the row states it — an
 * absent `reasoning` is not `false`, and an absent output limit is not a default.
 */
function parseDevMetadataFields(model: unknown): ZCodeChatModelMetadataFields | undefined {
  if (!isRecord(model)) return undefined;
  const limit = model.limit;
  if (!isRecord(limit) || !finiteNumber(limit.context) || limit.context <= 0) return undefined;

  const modalities = isRecord(model.modalities) ? model.modalities : undefined;
  return {
    contextWindow: limit.context,
    ...(typeof model.reasoning === "boolean" ? { reasoning: model.reasoning } : {}),
    ...(modalities !== undefined && Array.isArray(modalities.input) ? { input: metadataInput(modalities.input) } : {}),
    ...(finiteNumber(limit.output) && limit.output > 0 ? { maxTokens: limit.output } : {}),
  };
}

/**
 * Per-id metadata keyed the same way as the live ids: `zai-coding-plan` first,
 * `zai` only for fields the primary section left unstated. The winning row supplies
 * input, contextWindow, maxTokens and reasoning; ids and names are never read from it.
 */
export function parseModelsDevMetadata(payload: unknown): Map<string, ZCodeChatModelMetadataFields> {
  const metadata = new Map<string, ZCodeChatModelMetadataFields>();
  if (!isRecord(payload)) return metadata;
  for (const section of [CATALOG_PROVIDER, MODELS_DEV_FALLBACK_PROVIDER]) {
    const models = devSectionModels(payload, section);
    if (!models) continue;
    for (const [id, model] of Object.entries(models)) {
      const fields = parseDevMetadataFields(model);
      if (!fields) continue;
      // Only unstated fields are filled, so an explicit primary value always wins:
      // the already-recorded fields spread last and shadow the later section.
      metadata.set(id, { ...fields, ...metadata.get(id) });
    }
  }
  return metadata;
}

/** One models.dev GET (30 s cap plus the caller signal); non-2xx rejects so the caller can degrade. */
export async function fetchModelsDevPayload(signal?: AbortSignal): Promise<unknown> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(MODELS_DEV_API_URL, { signal: requestSignal });
  if (!response.ok) {
    // Cancel rather than abandon the body, so the failed read cannot hold transport
    // resources after the caller has already degraded.
    try {
      await response.body?.cancel();
    } catch {
      // A body that cannot be cancelled must not hide the HTTP status error.
    }
    throw new Error(`models.dev catalog request failed: ${response.status}`);
  }
  return response.json();
}

/**
 * Enriches catalog rows with models.dev metadata by id. Rows keep their own id, name
 * and thinking fields; only the metadata fields a dev row actually states change, and
 * anything it leaves unstated keeps the row's own value (the live defaults).
 */
export function mergeChatMetadata(
  models: readonly ProviderModelConfig[],
  metadata: ReadonlyMap<string, ZCodeChatModelMetadataFields>,
): ZCodeChatModelConfig[] {
  const merged: ZCodeChatModelConfig[] = [];
  for (const model of models) {
    const chat = chatModelConfig(model) ? model : undefined;
    if (!chat) continue;
    const enrichment = metadata.get(chat.id);
    merged.push(
      toChatModelConfig(
        chat.id,
        chat.name,
        {
          reasoning: enrichment?.reasoning ?? chat.reasoning,
          input: enrichment?.input ?? metadataInput(chat.input),
          contextWindow: enrichment?.contextWindow ?? chat.contextWindow,
          maxTokens: enrichment?.maxTokens ?? chat.maxTokens,
        },
        chatThinkingConfig(chat),
      ),
    );
  }
  return merged;
}

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

export function catalogToPersistedModels(models: readonly ProviderModelConfig[]): ModelsStoreEntry["models"] {
  return models.map(toPersistedModel);
}

function toPersistedModel(model: ProviderModelConfig): ZCodePersistedModel {
  if (!chatModelConfig(model)) throw new Error(`glm-zcode catalog persistence only supports chat rows: ${model.id}`);
  return {
    provider: ZCODE_PROVIDER_ID,
    api: "anthropic-messages",
    baseUrl: resolveZCodeAnthropicBaseUrl(),
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

/** Restores usable chat rows from a provider-scoped store entry; invalid/foreign-type rows are dropped. */
export function storedToConfig(stored: Readonly<ModelsStoreEntry> | undefined): ZCodeChatModelConfig[] {
  if (!Array.isArray(stored?.models)) return [];

  const models: ZCodeChatModelConfig[] = [];
  for (const model of stored.models) {
    const restored = restoredChatModel(model);
    if (restored) models.push(restored);
  }
  return models;
}

function restoredChatModel(model: unknown): ZCodeChatModelConfig | undefined {
  if (!isRecord(model)) return undefined;
  if (model.type !== undefined && model.type !== "chat") return undefined;
  if (typeof model.provider === "string" && model.provider !== ZCODE_PROVIDER_ID) return undefined;

  const input = filteredInput(model.input);
  const cost = model.cost;
  const thinkingLevelMap = model.thinkingLevelMap === undefined ? undefined : storedThinkingMap(model.thinkingLevelMap);
  const thinkingConfig =
    thinkingLevelMap === undefined
      ? thinkingConfigFor(undefined)
      : chatThinkingConfig({
          thinkingLevelMap,
          ...(isRecord(model.compat) ? { compat: anthropicMessagesCompat(model.compat) } : {}),
        });
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
    return undefined;
  }

  return {
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
  };
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
  const version = zcodeAppVersion();
  const channel = printableAscii(process.env.ZCODE_RELEASE_CHANNEL || "production");
  const raw: Record<string, string> = {
    "User-Agent": `ZCode/${version} ai-sdk/provider-utils/4.0.27 runtime/node.js/${process.versions.node}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": version,
    "X-Release-Channel": channel,
    "X-Platform": `${process.platform}-${process.arch}`,
    "X-Os-Category": osCategory(process.platform),
    "X-Os-Version": os.release(),
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
