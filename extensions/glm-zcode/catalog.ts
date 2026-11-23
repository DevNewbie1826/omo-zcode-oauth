import type { Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { fetchLiveModels, isSafeToken as safeToken } from "./live-catalog.js";
import {
  CATALOG_PROVIDER, CATALOG_REFRESH_INTERVAL_MS, ZCODE_PROVIDER_ID,
  catalogRowsFromModelsDev, catalogToPersistedModels, catalogWireName, chatModelConfig,
  chatThinkingConfig, fetchModelsDevPayload, mergeChatMetadata, parseModelsDevMetadata, resolveZCodeAnthropicBaseUrl,
  storedToConfig, zcodeFallbackChatModels, type ZCodeChatModelConfig,
} from "./models.js";
import { applyOffPeakRouting } from "./offpeak.js";

// ZCode 4.0.0 app spellings, not catalog membership. New models come from discovery.
const appWireNames = new Map([
  "GLM-5.3", "GLM-5.3-Flash", "glm-5.3-flashx", "GLM-5V-Turbo", "GLM-5.2",
  "GLM-5.1", "GLM-5.1-Highspeed", "GLM-5", "GLM-5-Turbo", "GLM-4.7",
  "GLM-4.7-FlashX", "GLM-4.7-Flash", "GLM-4.6", "GLM-4.5-Air", "GLM-4.5",
  "GLM-4.6V", "GLM-4.6V-Flash", "GLM-4.6V-FlashX", "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash", "GLM-4-FlashX-250414", "GLM-4-Flash-250414", "GLM-4V-Flash",
].map(id => [id.toLowerCase(), id]));

interface Snapshot {
  readonly current: readonly Model<"anthropic-messages">[];
  readonly wireNames: ReadonlyMap<string, string>;
  readonly checkedAt?: number;
}

function nativeModels(rows: ZCodeChatModelConfig[], offPeak: boolean): Snapshot["current"] {
  return applyOffPeakRouting(rows, offPeak).filter(chatModelConfig).map(row => ({
    id: row.id, name: row.name, api: "anthropic-messages", provider: ZCODE_PROVIDER_ID,
    baseUrl: row.baseUrl ?? resolveZCodeAnthropicBaseUrl(), reasoning: row.reasoning,
    input: row.input, cost: row.cost, contextWindow: row.contextWindow, maxTokens: row.maxTokens,
    ...chatThinkingConfig(row),
  }));
}

function snapshot(rows: ZCodeChatModelConfig[], checkedAt: number | undefined, offPeak = false): Snapshot {
  const wireNames = new Map<string, string>();
  for (const { id, name } of rows) {
    if (id.toLowerCase() === name.toLowerCase()) wireNames.set(id.toLowerCase(), name);
  }
  return { current: nativeModels(rows, offPeak), wireNames, checkedAt };
}

function isFresh(checkedAt: number | undefined): boolean {
  if (checkedAt === undefined) return false;
  const age = Date.now() - checkedAt;
  return age >= 0 && age < CATALOG_REFRESH_INTERVAL_MS;
}

function codingPlanRows(payload: unknown): ZCodeChatModelConfig[] {
  if (!payload || typeof payload !== "object" || !(CATALOG_PROVIDER in payload)) return [];
  // The zai section can enrich live rows but cannot establish plan membership.
  return catalogRowsFromModelsDev({ [CATALOG_PROVIDER]: payload[CATALOG_PROVIDER] })
    .filter(row => safeToken(row.id))
    .map(row => ({
      ...row,
      // Preserve friendly UI labels, but never let a dev label teach a wire spelling on restore.
      name: !safeToken(row.name) || catalogWireName(row.id, row.name) !== row.id ? row.id : row.name,
    }));
}

async function discover({ credential, signal }: RefreshModelsContext): Promise<ZCodeChatModelConfig[]> {
  // Start the optional enrichment budget BEFORE live discovery, leaving room for
  // publication within the trigger's 15s deadline even if live is slow.
  const enrichmentDeadline = AbortSignal.timeout(10_000);
  const key = credential?.type === "oauth" ? credential.access : credential?.key;
  const live = key?.trim() ? await fetchLiveModels(key, signal).catch(() => []) : [];
  if (signal.aborted) return [];
  const devSignal = live.length ? AbortSignal.any([signal, enrichmentDeadline]) : signal;
  if (devSignal.aborted) return live;
  let payload: unknown;
  try {
    payload = await fetchModelsDevPayload(devSignal);
  } catch {
    return live;
  }
  return live.length ? mergeChatMetadata(live, parseModelsDevMetadata(payload)) : codingPlanRows(payload);
}

export function createZCodeCatalog(offPeakActiveFor?: (context: RefreshModelsContext) => Promise<boolean>) {
  let state: Snapshot = { current: nativeModels(zcodeFallbackChatModels(), false), wireNames: new Map() };
  return {
    getModels: () => state.current,
    get checkedAt() { return state.checkedAt; },
    isFresh: () => isFresh(state.checkedAt),
    officialGlmModelId(id: string): string {
      const lower = id.toLowerCase();
      return appWireNames.get(lower) ?? state.wireNames.get(lower) ?? id;
    },
    async refresh(context: RefreshModelsContext): Promise<void> {
      const { stored, signal } = context;
      if (signal.aborted) return;
      const restored = stored && Array.isArray(stored.models)
        ? storedToConfig({ models: stored.models.filter(row => row?.provider === ZCODE_PROVIDER_ID) })
            .filter(row => safeToken(row.id))
            .map(row => safeToken(row.name) ? row : { ...row, name: row.id })
        : [];
      const checkedAt = Number.isFinite(stored?.checkedAt) ? stored?.checkedAt : undefined;
      if (restored.length) {
        const candidate = snapshot(restored, checkedAt);
        if (!(await context.publish({ update: () => { state = candidate; } }))) return;
      }
      if (!context.allowNetwork || signal.aborted || process.env.OFFLINE !== undefined) return;
      if (!context.force && restored.length && isFresh(checkedAt)) return;

      const rows = await discover(context);
      if (!rows.length || signal.aborted) return;
      const offPeak = await offPeakActiveFor?.(context) ?? false;
      if (signal.aborted) return;
      const now = Date.now();
      const candidate = snapshot(rows, now, offPeak);
      // The host owns generation/abort checks and writes before invoking update.
      // Do not catch a failed write as a source failure or retry with different rows.
      await context.publish({
        persist: { models: catalogToPersistedModels(rows), checkedAt: now },
        update: () => { state = candidate; },
      });
    },
  };
}
