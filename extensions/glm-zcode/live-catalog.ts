import { Buffer } from "node:buffer";
import type { ProviderModelConfig } from "@code-yeongyu/senpi";
import { buildZCodeSourceHeaders, thinkingConfigFor } from "./models.js";

export const LIVE_MODELS_URL = "https://api.z.ai/api/anthropic/v1/models";
/** Hard cap on the live catalog body; larger responses are treated as a failed live fetch. */
export const LIVE_MODELS_MAX_BYTES = 1_048_576;
const REQUEST_TIMEOUT_MS = 30_000;
const CONTROL_CHARS = /[\u0000-\u001F\u007F\u0080-\u009F]/;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A model id or display name is safe only when non-blank, short, and free of control characters. */
function isSafeToken(value: string): boolean {
  return value.trim() !== "" && value.length <= 200 && !CONTROL_CHARS.test(value);
}

function usableEntry(entry: JsonRecord): { id: string; name: string } | undefined {
  const id = entry.id;
  if (typeof id !== "string" || !isSafeToken(id)) return undefined;
  const displayName = entry.display_name;
  const name = typeof displayName === "string" && isSafeToken(displayName) ? displayName : id;
  return { id, name };
}

/**
 * Fetches the authenticated live /v1/models catalog. The OpenAI-shaped envelope is parsed
 * tolerantly ({data:[...]} or a bare array); entries without a usable id are dropped silently.
 * The live catalog supplies ids/names only, so metadata defaults mirror the static MODELS
 * fallback (zero cost, 1M context, 131072 max tokens, adaptive-thinking defaults).
 */
export async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<ProviderModelConfig[]> {
  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(LIVE_MODELS_URL, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...buildZCodeSourceHeaders(),
    },
    signal: requestSignal,
  });
  if (!response.ok) throw new Error(`live models request failed: ${response.status}`);

  // Guard before JSON.parse: bodies above the cap are rejected without parsing.
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > LIVE_MODELS_MAX_BYTES) {
    throw new Error(`live models response exceeded ${LIVE_MODELS_MAX_BYTES} bytes`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error("live models response was not valid JSON", { cause: error });
  }

  const entries = Array.isArray(payload)
    ? payload
    : isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : [];

  const models: ProviderModelConfig[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const usable = usableEntry(entry);
    if (!usable) continue;
    models.push({
      id: usable.id,
      name: usable.name,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      ...thinkingConfigFor(undefined),
    });
  }
  return models;
}
