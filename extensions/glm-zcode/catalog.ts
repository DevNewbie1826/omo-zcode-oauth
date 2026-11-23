import { isDeepStrictEqual } from "node:util";
import type { Model, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { fetchLiveModels, isSafeToken as safeToken } from "./live-catalog.js";
import {
  CATALOG_PROVIDER, CATALOG_REFRESH_INTERVAL_MS, ULTRA_BASE_URL, ZCODE_PROVIDER_ID,
  catalogRowsFromModelsDev, catalogToPersistedModels, catalogWireName, chatModelConfig,
  chatThinkingConfig, fetchModelsDevPayload, mergeChatMetadata, parseModelsDevMetadata, resolveZCodeAnthropicBaseUrl,
  storedToConfig, zcodeFallbackChatModels, type ZCodeChatModelConfig,
} from "./models.js";
import { applyOffPeakRouting, isFlashModelId } from "./offpeak.js";

export const CATALOG_TRIGGER_TIMEOUT_MS = 15_000;

// ZCode 4.0.0 app spellings, not catalog membership. New models come from discovery.
const appWireNames = new Map([
  "GLM-5.3", "GLM-5.3-Flash", "glm-5.3-flashx", "GLM-5V-Turbo", "GLM-5.2",
  "GLM-5.1", "GLM-5.1-Highspeed", "GLM-5", "GLM-5-Turbo", "GLM-4.7",
  "GLM-4.7-FlashX", "GLM-4.7-Flash", "GLM-4.6", "GLM-4.5-Air", "GLM-4.5",
  "GLM-4.6V", "GLM-4.6V-Flash", "GLM-4.6V-FlashX", "GLM-4.1V-Thinking-FlashX",
  "GLM-4.1V-Thinking-Flash", "GLM-4-FlashX-250414", "GLM-4-Flash-250414", "GLM-4V-Flash",
].map(id => [id.toLowerCase(), id]));

interface OffPeakOwner {
  readonly access: string;
  readonly jwt: string;
  readonly session: AbortSignal;
}

export interface AcceptedOffPeakRoute extends OffPeakOwner {
  /** Cancelled on withdrawal/replacement as well as session shutdown. */
  readonly signal: AbortSignal;
  /** False once this publication's route is replaced or its session ends. */
  readonly isCurrent: () => boolean;
}

interface PublishedRoute extends OffPeakOwner {
  readonly canonical: ModelsStoreEntry;
  readonly controller: AbortController;
}

interface Snapshot {
  readonly current: readonly Model<"anthropic-messages">[];
  readonly wireNames: ReadonlyMap<string, string>;
  readonly foldedWireNames: ReadonlyMap<string, string | undefined>;
  readonly checkedAt?: number;
  readonly route?: PublishedRoute;
}

function nativeModels(rows: ZCodeChatModelConfig[], offPeak: boolean): Snapshot["current"] {
  return applyOffPeakRouting(rows, offPeak).filter(chatModelConfig).map(row => ({
    id: row.id, name: row.name, api: "anthropic-messages", provider: ZCODE_PROVIDER_ID,
    baseUrl: row.baseUrl ?? resolveZCodeAnthropicBaseUrl(), reasoning: row.reasoning,
    input: row.input, cost: row.cost, contextWindow: row.contextWindow, maxTokens: row.maxTokens,
    ...chatThinkingConfig(row),
  }));
}

// Keep the first usable row for an exact ID; case-distinct IDs are separate selections.
function uniqueRows(rows: ZCodeChatModelConfig[]): ZCodeChatModelConfig[] {
  const byId = new Map<string, ZCodeChatModelConfig>();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  return [...byId.values()];
}

function snapshot(rows: ZCodeChatModelConfig[], checkedAt: number | undefined): Snapshot {
  const wireNames = new Map<string, string>();
  const foldedWireNames = new Map<string, string | undefined>();
  for (const { id, name } of rows) {
    const lower = id.toLowerCase();
    wireNames.set(id, catalogWireName(id, name));
    // Even a row with a friendly label makes a case-folded lookup ambiguous.
    foldedWireNames.set(lower, !foldedWireNames.has(lower) && name.toLowerCase() === lower ? name : undefined);
  }
  return { current: nativeModels(rows, false), wireNames, foldedWireNames, checkedAt };
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

async function discover(
  { credential, signal }: RefreshModelsContext,
  deadline: number,
  checkOffPeak: ((signal: AbortSignal) => Promise<boolean>) | undefined,
): Promise<{ rows: ZCodeChatModelConfig[]; offPeak: boolean }> {
  const key = credential?.type === "oauth" ? credential.access : credential?.key;
  const live = key?.trim() ? await fetchLiveModels(key, signal).catch(() => []) : [];
  if (signal.aborted) return { rows: [], offPeak: false };
  // Without live rows models.dev supplies membership, so this read is not optional.
  const rows = live.length ? live : codingPlanRows(await fetchModelsDevPayload(signal).catch(() => undefined));
  const budget = Math.floor((deadline - Date.now()) / 2);
  if (!rows.length || signal.aborted || budget <= 0) return { rows, offPeak: false };

  // Metadata and entitlement share one cutoff, leaving the rest of the trigger budget for publish.
  const optional = new AbortController();
  const optionalSignal = AbortSignal.any([signal, optional.signal]);
  const timer = setTimeout(() => optional.abort(), budget).unref();
  let onAbort: (() => void) | undefined;
  const cutoff = new Promise<undefined>(resolve => {
    onAbort = () => resolve(undefined);
    optionalSignal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    // Race each result independently: a hung read must not hide the other stage's result.
    const metadata = live.length ? fetchModelsDevPayload(optionalSignal).catch(() => undefined) : undefined;
    const [payload, offPeak] = await Promise.all([
      Promise.race([metadata, cutoff]),
      Promise.race([rows.some(row => isFlashModelId(row.id)) ? checkOffPeak?.(optionalSignal) : undefined, cutoff]),
    ]);
    return { rows: payload === undefined ? rows : mergeChatMetadata(rows, parseModelsDevMetadata(payload)), offPeak: offPeak ?? false };
  } finally {
    clearTimeout(timer);
    if (onAbort) optionalSignal.removeEventListener("abort", onAbort);
  }
}

export function createZCodeCatalog(
  offPeakActiveFor?: (context: RefreshModelsContext, session: AbortSignal) => Promise<boolean>,
  getSessionSignal?: () => AbortSignal,
  onOffPeakAccepted?: (route: AcceptedOffPeakRoute) => void,
) {
  const standaloneSession = new AbortController().signal;
  const currentSession = getSessionSignal ?? (() => standaloneSession);
  const generationSessions = new WeakMap<AbortSignal, AbortSignal>();
  let state: Snapshot = {
    current: nativeModels(zcodeFallbackChatModels(), false), wireNames: new Map(), foldedWireNames: new Map(),
  };
  function install(candidate: Snapshot): void {
    const old = state.route;
    state = candidate;
    if (old !== candidate.route) old?.controller.abort();
  }
  return {
    getModels: () => state.current,
    get checkedAt() { return state.checkedAt; },
    clearSessionRoute() {
      if (state.route) install(snapshot(storedToConfig(state.route.canonical), state.checkedAt));
    },
    isFresh: () => isFresh(state.checkedAt),
    officialGlmModelId(id: string): string {
      const lower = id.toLowerCase();
      return appWireNames.get(lower) ?? state.wireNames.get(id) ?? state.foldedWireNames.get(lower) ?? id;
    },
    async refresh(ctx: RefreshModelsContext, deadline = Date.now() + CATALOG_TRIGGER_TIMEOUT_MS): Promise<void> {
      // The host uses one generation signal for restore and online phases.
      let session = generationSessions.get(ctx.signal);
      if (!session) {
        session = currentSession();
        generationSessions.set(ctx.signal, session);
      }
      if (session !== currentSession()) return;
      const context = { ...ctx, signal: AbortSignal.any([ctx.signal, session]) };
      const { stored, signal } = context;
      const isCurrent = () => !signal.aborted && currentSession() === session;
      if (signal.aborted) return;
      const restored = stored && Array.isArray(stored.models)
        ? uniqueRows(storedToConfig({ models: stored.models.filter(row => row?.provider === ZCODE_PROVIDER_ID) })
            .filter(row => safeToken(row.id))
            .map(row => safeToken(row.name) ? row : { ...row, name: row.id }))
        : [];
      const checkedAt = Number.isFinite(stored?.checkedAt) ? stored?.checkedAt : undefined;
      if (restored.length) {
        // The host restores a clone even on the same instance before each online check.
        const route = state.route;
        const credential = context.credential;
        const sameRoute = route?.session === session && credential?.type === "oauth" && credential.access === route.access &&
          credential.zcodeJwtToken === route.jwt && isFresh(checkedAt) && checkedAt === state.checkedAt &&
          isDeepStrictEqual(stored?.models, route.canonical.models);
        const canonical = snapshot(restored, checkedAt);
        const candidate = sameRoute ? state : canonical;
        if (!(await context.publish({ update: () => { if (isCurrent()) install(candidate); } }))) return;
      }
      if (!context.allowNetwork || !isCurrent() || process.env.OFFLINE !== undefined) return;
      if (!context.force && restored.length && isFresh(checkedAt)) return;

      const credential = context.credential;
      const owner = credential?.type === "oauth" && credential.access &&
        typeof credential.zcodeJwtToken === "string" && credential.zcodeJwtToken
        ? { session, access: credential.access, jwt: credential.zcodeJwtToken } : undefined;
      const discovery = await discover(context, deadline, owner && offPeakActiveFor
        ? optionalSignal => offPeakActiveFor({ ...context, signal: optionalSignal }, session) : undefined);
      if (!discovery.rows.length || !isCurrent()) return;
      const rows = uniqueRows(discovery.rows);
      const now = Date.now();
      const persist: ModelsStoreEntry = {
        models: catalogToPersistedModels(rows).map(row => ({ ...row, baseUrl: ULTRA_BASE_URL })),
        checkedAt: now,
      };
      const route = discovery.offPeak && owner && !process.env.ZCODE_ANTHROPIC_BASE_URL?.trim()
        ? { ...owner, canonical: persist, controller: new AbortController() } : undefined;
      const canonical = snapshot(rows, now);
      const candidate = route ? { ...canonical, current: nativeModels(rows, true), route } : canonical;
      // A host-started write may finish after shutdown. Only a current session may use its update.
      const accepted = await context.publish({
        persist,
        update: () => { if (isCurrent()) install(candidate); },
      });
      if (accepted && route && isCurrent() && state.route === route) {
        const routeSignal = AbortSignal.any([session, route.controller.signal]);
        onOffPeakAccepted?.({
          session, access: route.access, jwt: route.jwt, signal: routeSignal,
          isCurrent: () => !routeSignal.aborted && currentSession() === session && state.route === route,
        });
      }
    },
  };
}
