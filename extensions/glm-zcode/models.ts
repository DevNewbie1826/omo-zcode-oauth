import type { ProviderModelConfig } from "@code-yeongyu/senpi";

export const MODELS_DEV_API_URL = "https://models.dev/api.json";
export const CATALOG_PROVIDER = "zai-coding-plan";
export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 30_000;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

type JsonRecord = Record<string, unknown>;
type InputModality = ProviderModelConfig["input"][number];

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
    });
  }
  return models;
}

export function catalogToPersistedModels(models: ProviderModelConfig[]): Record<string, unknown>[] {
  return models.map((model) => ({
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
  }));
}

export function storedToConfig(stored: { models?: unknown } | undefined): ProviderModelConfig[] {
  if (!Array.isArray(stored?.models)) return [];

  const models: ProviderModelConfig[] = [];
  for (const model of stored.models) {
    if (!isRecord(model)) continue;
    const input = filteredInput(model.input);
    const cost = model.cost;
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
    });
  }
  return models;
}
