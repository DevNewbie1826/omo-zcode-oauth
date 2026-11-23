import { Buffer } from "node:buffer";
import {
  ZCODE_CHAT_DEFAULTS,
  buildZCodeSourceHeaders,
  toChatModelConfig,
  type ZCodeChatModelConfig,
} from "./models.js";

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
export function isSafeToken(value: string): boolean {
  return value.trim() !== "" && value.length <= 200 && !CONTROL_CHARS.test(value);
}

/**
 * One decoded live row. The `id` is the sole identity; `name` is the safe
 * `display_name` preserved byte-for-byte when usable, else the id. A4 derives
 * official wire casing from it (case-only rename), so trimming or normalizing
 * a usable name here would silently lose the app's spelling.
 */
interface LiveCatalogEntry {
  id: string;
  name: string;
}

function usableEntry(entry: JsonRecord): LiveCatalogEntry | undefined {
  const id = entry.id;
  if (typeof id !== "string" || !isSafeToken(id)) return undefined;
  const displayName = entry.display_name;
  const name = typeof displayName === "string" && isSafeToken(displayName) ? displayName : id;
  return { id, name };
}

/**
 * Reads the response body incrementally and stops as soon as `maxBytes` is crossed.
 * The overflowing chunk is not retained; the reader is cancelled so the producer stops.
 */
async function readCappedUtf8(stream: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string> {
  if (stream === null) return "";

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let releaseLock = true;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      const chunk = result.value;
      if (chunk === undefined) continue;
      total += chunk.byteLength;
      if (total > maxBytes) {
        releaseLock = false;
        await reader.cancel();
        throw new Error(`live models response exceeded ${maxBytes} bytes`);
      }
      chunks.push(chunk);
    }
  } finally {
    if (releaseLock) reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Fetches the authenticated live /v1/models catalog and decodes it into typed chat rows.
 * The OpenAI-shaped envelope is parsed tolerantly ({data:[...]} or a bare array); entries
 * without a usable id are dropped silently, and a missing or unsafe display_name falls
 * back to the id. The live catalog supplies ids/names only, so rows carry the shared
 * ZCODE_CHAT_DEFAULTS through M's single chat builder (zero cost, 1M context,
 * 131072 max tokens, adaptive-thinking defaults, no image/video override for 5.4).
 * Non-2xx, non-JSON, oversize bodies and aborts reject; the caller decides how to degrade.
 */
export async function fetchLiveModels(apiKey: string, signal?: AbortSignal): Promise<ZCodeChatModelConfig[]> {
  // Honor an already-aborted caller signal before touching the network; fetch only
  // observes signals it receives, so a transport double would otherwise answer.
  if (signal?.aborted) throw signal.reason;
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

  const text = await readCappedUtf8(response.body, LIVE_MODELS_MAX_BYTES);

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

  const models: ZCodeChatModelConfig[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const usable = usableEntry(entry);
    if (!usable) continue;
    models.push(toChatModelConfig(usable.id, usable.name, ZCODE_CHAT_DEFAULTS));
  }
  return models;
}
