import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  createModels, createProvider, InMemoryCredentialStore, InMemoryModelsStore,
  type Model, type ModelsStoreEntry, type RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createZCodeCatalog, type AcceptedOffPeakRoute } from "../extensions/glm-zcode/catalog.js";
import { LIVE_MODELS_MAX_BYTES, LIVE_MODELS_URL } from "../extensions/glm-zcode/live-catalog.js";
import { MODELS_DEV_API_URL, ULTRA_BASE_URL, ZAI_THINKING_LEVEL_MAP } from "../extensions/glm-zcode/models.js";
import { OFFPEAK_BASE_URL } from "../extensions/glm-zcode/offpeak.js";

const now = Date.UTC(2026, 10, 23, 12);
const provider = "glm-zcode";
const old: Model<"anthropic-messages"> = {
  provider, api: "anthropic-messages", id: "old", name: "OLD", baseUrl: OFFPEAK_BASE_URL,
  headers: { Authorization: "obsolete-ticket" }, reasoning: true, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
};
const stale = { models: [old], checkedAt: now - 3_600_000 };
const apiKey = { type: "api_key", key: "test-key" } as const;
const oauth = { type: "oauth", access: "test-access", refresh: "test-refresh", expires: now + 60_000 } as const;
const offPeakCredential = { ...oauth, zcodeJwtToken: "fixture-jwt" };
const live = [{ id: "new", display_name: "Vision preview" }, { id: "glm-5.4", display_name: "GLM-5.4" }];
const devRow = { name: "unused", modalities: { input: ["text", "image", "pdf", "video"] },
  limit: { context: 200000, output: 8192 }, reasoning: false };
const metadata = {
  "zai-coding-plan": { models: { "glm-5.4": devRow, "dev-only": { ...devRow, name: "DEV-ONLY" } } },
  zai: { models: { "glm-5.4": { ...devRow, limit: { context: 3000 } }, "zai-only": devRow } },
};
const reject = () => { throw new Error("source unavailable"); };
type Reply = (init?: RequestInit) => Response | Promise<Response>;
const requests: { url: string; bearer: string | null }[] = [];
const unexpected: string[] = [];
function sources(liveReply?: Reply, devReply?: Reply) {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, bearer: new Headers(init?.headers).get("Authorization") });
    const reply = url === LIVE_MODELS_URL ? liveReply : url === MODELS_DEV_API_URL ? devReply : undefined;
    if (reply) return reply(init);
    unexpected.push(url);
    throw new Error(`unexpected request: ${url}`);
  }));
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("OFFLINE", undefined);
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  vi.stubEnv("ZCODE_DEVICE_ID", "catalog-fixture-device");
  vi.stubEnv("ZCODE_APP_VERSION", undefined);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", undefined);
  requests.length = unexpected.length = 0;
  sources();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(unexpected).toEqual([]);
});

function host(overrides: Partial<RefreshModelsContext> = {}) {
  let entry: ModelsStoreEntry | undefined = overrides.stored;
  const publish = vi.fn<RefreshModelsContext["publish"]>(async publication => {
    if (publication.persist) entry = structuredClone(publication.persist);
    publication.update?.();
    return true;
  });
  const ctx: RefreshModelsContext = { publish, allowNetwork: true, credential: apiKey,
    signal: new AbortController().signal, ...overrides };
  return { ctx, publish, stored: () => entry };
}
function deferred() {
  let resolve: () => void = () => { throw new Error("Uninitialized deferred"); };
  const promise = new Promise<void>(accept => { resolve = accept; });
  return { promise, resolve };
}
const ids = (catalog: ReturnType<typeof createZCodeCatalog>) => catalog.getModels().map(row => row.id);
const regularSources = () => sources(() => Response.json(live), () => Response.json(metadata));

test("cold start exposes complete emergency models; offline restore replaces them without restoring a route", async () => {
  const c = createZCodeCatalog();
  expect(ids(c).sort()).toEqual(["glm-5.3", "glm-5.4"]);
  expect(c.getModels().find(m => m.id === "glm-5.4")).toMatchObject({ api: "anthropic-messages",
    provider, input: ["text", "image"], baseUrl: ULTRA_BASE_URL, reasoning: true, maxTokens: 131072 });
  expect(c.checkedAt).toBeUndefined();
  expect(c.officialGlmModelId("glm-5.4")).toBe("glm-5.4");
  const h = host({ allowNetwork: false, stored: stale, force: true });
  await c.refresh(h.ctx);
  expect(h.publish.mock.calls).toEqual([[{ update: expect.any(Function) }]]);
  expect(c.getModels()).toMatchObject([{ id: "old", baseUrl: ULTRA_BASE_URL, thinkingLevelMap: ZAI_THINKING_LEVEL_MAP,
    compat: { forceAdaptiveThinking: true, supportsDisabledThinking: false } }]);
  expect(c.getModels()[0]).not.toHaveProperty("headers");
  expect(c.checkedAt).toBe(stale.checkedAt);
  expect(c.officialGlmModelId("old")).toBe("OLD");
});

const invalidStores: Record<string, ModelsStoreEntry["models"]> = {
  empty: [], foreign: [{ ...old, provider: "foreign" }],
  image: [{ ...old, type: "image", output: ["image"] }], invalid: [{ ...old, maxTokens: 0 }],
};
test.each(Object.entries(invalidStores))("%s store cannot establish freshness", async (_, models) => {
  const c = createZCodeCatalog();
  const h = host({ stored: { models, checkedAt: now } });
  await c.refresh({ ...h.ctx, allowNetwork: false });
  expect(h.publish).not.toHaveBeenCalled();
  expect(c.isFresh()).toBe(false);
  regularSources();
  await c.refresh(h.ctx);
  expect(ids(c)).toEqual(["new", "glm-5.4"]);
});

test.each([
  [1_799_999, false, false], [1_800_000, false, true], [1_860_000, false, true],
  [1, true, true], [-1000, false, true], [NaN, false, true],
] as const)("stored age %s ms, force=%s: fetch=%s", async (age, force, due) => {
  const c = createZCodeCatalog();
  const h = host({ stored: { models: [old], checkedAt: now - age }, force });
  if (due) regularSources();
  await c.refresh(h.ctx);
  expect(requests.map(r => r.url)).toEqual(due ? [LIVE_MODELS_URL, MODELS_DEV_API_URL] : []);
  expect(ids(c)).toEqual(due ? ["new", "glm-5.4"] : ["old"]);
  expect(c.checkedAt).toBe(due ? now : now - age);
});

test.each(["OFFLINE", "aborted", "cache-only"])("force cannot override %s", async mode => {
  const c = createZCodeCatalog();
  if (mode === "OFFLINE") vi.stubEnv("OFFLINE", "");
  const h = host({ force: true, allowNetwork: mode !== "cache-only",
    signal: mode === "aborted" ? AbortSignal.abort() : new AbortController().signal });
  await c.refresh(h.ctx);
  expect(h.publish).not.toHaveBeenCalled();
  expect(c.checkedAt).toBeUndefined();
});

test.each([true, false])("live rows own identity, metadata available=%s", async available => {
  const c = createZCodeCatalog();
  const h = host({ credential: available ? oauth : apiKey });
  sources(() => Response.json(live), available ? () => Response.json(metadata) : reject);
  await expect(c.refresh(h.ctx)).resolves.toBeUndefined();
  expect(requests).toEqual([
    { url: LIVE_MODELS_URL, bearer: `Bearer ${available ? oauth.access : apiKey.key}` },
    { url: MODELS_DEV_API_URL, bearer: null },
  ]);
  expect(h.publish).toHaveBeenCalledTimes(1);
  expect(h.stored()).toEqual({ models: c.getModels().map(m => expect.objectContaining({ id: m.id, name: m.name })),
    checkedAt: now });
  expect(c.getModels()).toMatchObject([
    { id: "new", name: "Vision preview" },
    { id: "glm-5.4", name: "GLM-5.4", ...(available
      ? { input: ["text", "image"], contextWindow: 200000, maxTokens: 8192, reasoning: false }
      : { input: ["text"], contextWindow: 1_000_000, maxTokens: 131072, reasoning: true }) },
  ]);
  expect(c.officialGlmModelId("NEW")).toBe("NEW");
});

test("a credential-bearing endpoint override is visible but never persisted", async () => {
  const override = "https://fixture:local-secret@gateway.invalid/anthropic?token=fixture-marker";
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", override);
  const c = createZCodeCatalog();
  const h = host();
  regularSources();

  await c.refresh(h.ctx);

  expect(c.getModels().map(row => row.baseUrl)).toEqual([override, override]);
  expect(h.stored()?.models.map(row => row.baseUrl)).toEqual([ULTRA_BASE_URL, ULTRA_BASE_URL]);
  expect(JSON.stringify(h.stored())).not.toContain("fixture-marker");
  expect(JSON.stringify(h.stored())).not.toContain("local-secret");
  const nextOverride = "https://other-gateway.invalid/anthropic";
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", nextOverride);
  sources();
  await c.refresh(host({ stored: h.stored(), allowNetwork: false }).ctx);
  expect(c.getModels().map(row => row.baseUrl)).toEqual([nextOverride, nextOverride]);
});

const failures: Record<string, Reply> = {
  http: () => new Response(null, { status: 503 }), throws: reject, invalid: () => new Response("{"),
  envelope: () => Response.json({ error: "bad" }), empty: () => Response.json([]),
  oversized: () => new Response("x".repeat(LIVE_MODELS_MAX_BYTES + 1)),
};
test.each(Object.entries(failures))("live %s falls back to coding-plan membership only", async (_, reply) => {
  sources(reply, () => Response.json(metadata));
  const c = createZCodeCatalog();
  const h = host();
  await c.refresh(h.ctx);
  expect(ids(c)).toEqual(["glm-5.4", "dev-only"]);
  expect(h.stored()?.models.find(m => m.id === "dev-only")?.name).toBe("dev-only");
  expect(requests.map(r => r.url)).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
});

test.each([undefined, { type: "api_key", key: "" }, { ...oauth, access: "" }] as const)(
  "missing or empty credentials skip live and preserve the store when dev fails", async credential => {
    sources(undefined, reject);
    const c = createZCodeCatalog();
    const h = host({ credential, stored: stale });
    await expect(c.refresh(h.ctx)).resolves.toBe("source-unavailable");
    expect(h.publish.mock.calls).toEqual([[{ update: expect.any(Function) }]]);
    expect(ids(c)).toEqual(["old"]);
    expect(c.checkedAt).toBe(stale.checkedAt);
    expect(requests).toEqual([{ url: MODELS_DEV_API_URL, bearer: null }]);
  },
);

test("both sources failing retains the previously accepted state even without a store", async () => {
  const c = createZCodeCatalog();
  await c.refresh(host({ stored: stale, allowNetwork: false }).ctx);
  sources(reject, reject);
  const h = host();
  await expect(c.refresh(h.ctx)).resolves.toBe("source-unavailable");
  expect(h.publish).not.toHaveBeenCalled();
  expect(ids(c)).toEqual(["old"]);
  expect(c.checkedAt).toBe(stale.checkedAt);
});

test.each(["restore", "network", "abort-during-live", "abort-during-publication"])(
  "%s refusal or cancellation cannot install unpublished rows, casing or time", async mode => {
    const c = createZCodeCatalog();
    const controller = new AbortController();
    if (mode === "abort-during-live") sources(() => { controller.abort(); return Response.json(live); });
    else if (mode !== "restore") regularSources();
    const h = host({ stored: stale, signal: controller.signal });
    const publish = vi.fn<RefreshModelsContext["publish"]>(async publication => {
      if (mode === "restore") return false;
      if (publication.persist) {
        if (mode === "abort-during-publication") controller.abort();
        return false;
      }
      return h.ctx.publish(publication);
    });
    await c.refresh({ ...h.ctx, publish });
    expect(publish).toHaveBeenCalledTimes(mode === "restore" || mode === "abort-during-live" ? 1 : 2);
    expect(c.checkedAt).toBe(mode === "restore" ? undefined : stale.checkedAt);
    expect(ids(c).sort()).toEqual(mode === "restore" ? ["glm-5.3", "glm-5.4"] : ["old"]);
    expect(c.officialGlmModelId("glm-5.4")).toBe("glm-5.4");
    expect(c.officialGlmModelId("old")).toBe(mode === "restore" ? "old" : "OLD");
  },
);

test.each(["restore", "network"] as const)(
  "an obsolete %s update leaves visible rows, wire spelling and freshness untouched", async mode => {
    let session = new AbortController();
    const onAccepted = vi.fn<(route: AcceptedOffPeakRoute) => void>();
    const c = createZCodeCatalog(async () => true, () => session.signal, onAccepted);
    await c.refresh(host({ stored: stale, allowNetwork: false }).ctx);
    const next = { ...old, id: "new-flash", name: "New-Flash" };
    const h = host(mode === "restore"
      ? { stored: { models: [next], checkedAt: now }, allowNetwork: false }
      : { credential: offPeakCredential });
    if (mode === "network") sources(() => Response.json([{ id: next.id, display_name: next.name }]), reject);
    const entered = deferred();
    const release = deferred();
    // Like a host-started publish, this publisher does not know the extension's session has ended.
    const refresh = c.refresh({ ...h.ctx, publish: async publication => {
      entered.resolve();
      await release.promise;
      return h.ctx.publish(publication);
    } });

    await entered.promise;
    session.abort();
    c.clearSessionRoute();
    session = new AbortController();
    release.resolve();
    await refresh;

    expect(ids(c)).toEqual(["old"]);
    expect(c.officialGlmModelId("old")).toBe("OLD");
    expect(c.officialGlmModelId(next.id)).toBe(next.id);
    expect(c.checkedAt).toBe(stale.checkedAt);
    expect(onAccepted).not.toHaveBeenCalled();
    expect(h.stored()).toMatchObject({ models: [{ id: next.id, name: next.name }], checkedAt: now });

    sources();
    await c.refresh(host({ stored: h.stored(), allowNetwork: false }).ctx);
    expect(ids(c)).toEqual([next.id]);
    expect(c.officialGlmModelId(next.id)).toBe(next.name);
    expect(c.checkedAt).toBe(now);
    expect(c.getModels()[0].baseUrl).toBe(ULTRA_BASE_URL);
    expect(onAccepted).not.toHaveBeenCalled();
  },
);

test.each(["live", "restore"] as const)(
  "%s keeps the first exact ID row and folds only unambiguous wire spellings", async mode => {
    const rows = [
      { id: "ModelX", name: "ModelX" }, { id: "modelx", name: "Friendly label" },
      { id: "duplicate", name: "DUPLICATE" }, { id: "duplicate", name: "Duplicate" },
      { id: "solo", name: "Solo" }, { id: "glm-5.3-flashx", name: "GLM-5.3-FlashX" },
    ];
    const c = createZCodeCatalog();
    const h = host(mode === "restore"
      ? { stored: { models: rows.map(row => ({ ...old, ...row })), checkedAt: now }, allowNetwork: false }
      : {});
    if (mode === "live") {
      sources(() => Response.json(rows.map(({ id, name }) => ({ id, display_name: name }))), reject);
    }

    await c.refresh(h.ctx);

    const expected = rows.filter(row => row.name !== "Duplicate");
    expect(c.getModels().map(({ id, name }) => ({ id, name }))).toEqual(expected);
    if (mode === "live") expect(h.stored()?.models.map(({ id, name }) => ({ id, name }))).toEqual(expected);
    expect(c.officialGlmModelId("ModelX")).toBe("ModelX");
    expect(c.officialGlmModelId("modelx")).toBe("modelx");
    expect(c.officialGlmModelId("MODELX")).toBe("MODELX");
    expect(c.officialGlmModelId("duplicate")).toBe("DUPLICATE");
    expect(c.officialGlmModelId("SOLO")).toBe("Solo");
    expect(c.officialGlmModelId("glm-5.3-flashx")).toBe("glm-5.3-flashx");
  },
);

test("only update installs the routed snapshot; canonical names survive restart and disappear on replacement", async () => {
  const c = createZCodeCatalog(async () => true);
  const h = host({ credential: { ...oauth, zcodeJwtToken: "fixture-jwt" } });
  const flash = { id: "glm-5.3-flashx", display_name: "GLM-5.3-FlashX" };
  sources(() => Response.json([...live, flash]), reject);
  await c.refresh({ ...h.ctx, publish: async p => {
    expect(ids(c).sort()).toEqual(["glm-5.3", "glm-5.4"]);
    expect(c.checkedAt).toBeUndefined();
    expect(c.officialGlmModelId("glm-5.4")).toBe("glm-5.4");
    return h.ctx.publish(p);
  } });
  expect(c.getModels().find(m => m.id === flash.id)?.baseUrl).toBe(OFFPEAK_BASE_URL);
  expect(h.stored()?.models.find(m => m.id === flash.id)?.baseUrl).toBe(ULTRA_BASE_URL);
  const restored = createZCodeCatalog();
  sources();
  await restored.refresh(host({ stored: h.stored(), allowNetwork: false }).ctx);
  for (const catalog of [c, restored]) {
    expect(catalog.checkedAt).toBe(now);
    expect(catalog.officialGlmModelId("GLM-5.3-FlashX")).toBe("glm-5.3-flashx");
    expect(catalog.officialGlmModelId("glm-5v-turbo")).toBe("GLM-5V-Turbo");
    expect(catalog.officialGlmModelId("glm-5.4")).toBe("GLM-5.4");
    expect(catalog.officialGlmModelId("new")).toBe("new");
  }
  sources(() => Response.json([{ id: "next", display_name: "Next" }]), reject);
  vi.setSystemTime(now + 100);
  await c.refresh({ ...h.ctx, stored: h.stored(), force: true });
  expect(ids(c)).toEqual(["next"]);
  expect(c.officialGlmModelId("next")).toBe("Next");
  expect(c.officialGlmModelId("glm-5.4")).toBe("glm-5.4");
  expect(c.checkedAt).toBe(now + 100);
  expect(restored.officialGlmModelId("glm-5.4")).toBe("GLM-5.4");
});

test("registry reports a rejected write once and retains the restored snapshot", async () => {
  regularSources();
  const c = createZCodeCatalog();
  const modelsStore = new InMemoryModelsStore();
  await modelsStore.write(provider, stale);
  const failure = new Error("store write failed");
  const write = vi.spyOn(modelsStore, "write").mockRejectedValue(failure);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(provider, async () => apiKey);
  const registry = createModels({ modelsStore, credentials });
  const base = createProvider({ id: provider, auth: { apiKey: {
    name: "Test", resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key } }),
  } }, models: c.getModels(), api: { stream: reject, streamSimple: reject } });
  registry.setProvider({ ...base, getModels: c.getModels, getAllModels: c.getModels,
    refreshModels: async ctx => { await c.refresh(ctx); } });

  const result = await registry.refresh({ providers: [provider], force: true, allowNetwork: true });
  expect(result.errors.get(provider)).toBe(failure);
  expect(write).toHaveBeenCalledTimes(1);
  expect(registry.getModels(provider).map(m => m.id)).toEqual(["old"]);
  expect(c.checkedAt).toBe(stale.checkedAt);
  expect(c.officialGlmModelId("glm-5.4")).toBe("glm-5.4");
  expect(await modelsStore.read(provider)).toEqual(stale);
});

test.each(["accepted", "non-flash", "refused", "write-failure"] as const)(
  "off-peak warm-up requires an eligible and accepted catalog publication: %s", async mode => {
    const session = new AbortController();
    const checkAvailability = vi.fn(async () => true);
    const onAccepted = vi.fn<(route: AcceptedOffPeakRoute) => void>();
    const c = createZCodeCatalog(checkAvailability, () => session.signal, onAccepted);
    const h = host({ credential: offPeakCredential });
    const id = mode === "non-flash" ? "glm-5.4" : "new-flash";
    sources(() => Response.json([{ id }]), reject);
    const failure = new Error("store write rejected");
    const refresh = c.refresh({ ...h.ctx, publish: async publication => {
      expect(onAccepted).not.toHaveBeenCalled();
      if (mode === "refused") return false;
      if (mode === "write-failure") throw failure;
      const accepted = await h.ctx.publish(publication);
      expect(onAccepted).not.toHaveBeenCalled();
      return accepted;
    } });

    if (mode === "write-failure") await expect(refresh).rejects.toBe(failure);
    else await refresh;

    expect(checkAvailability).toHaveBeenCalledTimes(mode === "non-flash" ? 0 : 1);
    if (mode !== "accepted") {
      expect(onAccepted).not.toHaveBeenCalled();
      expect(c.getModels().some(row => row.baseUrl === OFFPEAK_BASE_URL)).toBe(false);
      return;
    }
    expect(onAccepted).toHaveBeenCalledExactlyOnceWith({
      access: offPeakCredential.access, jwt: offPeakCredential.zcodeJwtToken, session: session.signal,
      signal: expect.any(AbortSignal), isCurrent: expect.any(Function),
    });
    expect(c.getModels()).toMatchObject([{ id, baseUrl: OFFPEAK_BASE_URL }]);
    const route = onAccepted.mock.calls[0]?.[0];
    expect(route?.isCurrent()).toBe(true);
    expect(route?.signal.aborted).toBe(false);
    c.clearSessionRoute();
    expect(route?.isCurrent()).toBe(false);
    expect(route?.signal.aborted).toBe(true);
  },
);

test("same-instance fresh check keeps the accepted route only for unchanged rows and account", async () => {
  const credential = { ...oauth, zcodeJwtToken: "fixture-jwt" };
  for (const change of ["account", "snapshot"]) {
    const c = createZCodeCatalog(async () => true);
    const h = host({ credential });
    sources(() => Response.json([{ id: "glm-flash" }]), reject);
    await c.refresh(h.ctx);
    const stored = h.stored();
    if (!stored) throw new Error("Missing publication");
    expect(stored.models[0].baseUrl).toBe(ULTRA_BASE_URL);
    sources();
    const check = { ...h.ctx, stored };
    await c.refresh({ ...check, allowNetwork: false });
    await c.refresh({ ...check, force: false });
    expect(c.getModels()[0].baseUrl).toBe(OFFPEAK_BASE_URL);

    if (change === "account") await c.refresh({ ...check, credential: { ...credential, access: "other" } });
    else await c.refresh({ ...check, stored: { ...stored, models: [{ ...stored.models[0], name: "Changed" }] } });
    expect(c.getModels()[0].baseUrl).toBe(ULTRA_BASE_URL);
  }
});

test("a fresh restore does not reuse an identical snapshot's route under a different session token", async () => {
  let session = new AbortController().signal;
  const c = createZCodeCatalog(async () => true, () => session);
  const h = host({ credential: { ...oauth, zcodeJwtToken: "fixture-jwt" } });
  sources(() => Response.json([{ id: "glm-flash" }]), reject);
  await c.refresh(h.ctx);
  expect(c.getModels()[0].baseUrl).toBe(OFFPEAK_BASE_URL);

  session = new AbortController().signal;
  sources();
  await c.refresh({ ...h.ctx, signal: new AbortController().signal, stored: h.stored(), force: false });
  expect(c.getModels()[0].baseUrl).toBe(ULTRA_BASE_URL);
});

test.each([true, false])("slow live read gets one metadata attempt before the trigger deadline: available=%s", async available => {
  vi.useRealTimers(); // Replace the suite's Date-only clock with fake timers as well.
  vi.useFakeTimers();
  vi.setSystemTime(now);
  // Node's native AbortSignal.timeout uses an internal clock, not the fake setTimeout.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  try {
    const signal = AbortSignal.timeout(15_000);
    sources(() => new Promise(resolve => setTimeout(() => resolve(Response.json(live)), 10_500)), init => {
      if (available) return Response.json(metadata);
      const child = init?.signal;
      if (!child) throw new Error("Missing metadata signal");
      return new Promise<Response>((_, reject) => child.addEventListener("abort", () => reject(child.reason), { once: true }));
    });
    const h = host({ signal });
    const c = createZCodeCatalog();
    const refresh = c.refresh(h.ctx);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(requests.map(r => r.url)).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(signal.aborted).toBe(false);
    expect(h.stored()?.models).toMatchObject([{ id: "new" }, { id: "glm-5.4", input: available ? ["text", "image"] : ["text"] }]);
    await refresh;
  } finally {
    vi.clearAllTimers();
    timeout.mockRestore();
  }
});
