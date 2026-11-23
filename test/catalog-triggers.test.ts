import {
  createModels, InMemoryCredentialStore, InMemoryModelsStore,
  type ModelsRefreshOptions, type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";
import { CATALOG_REFRESH_INTERVAL_MS as period, MODELS_DEV_API_URL } from "../extensions/glm-zcode/models.js";
import { LIVE_MODELS_URL } from "../extensions/glm-zcode/live-catalog.js";

const now = Date.UTC(2026, 10, 23, 12);
const providerId = "glm-zcode";
const unexpected: string[] = [];
function sources(live?: () => Response | Promise<Response>) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    if (live && String(input) === LIVE_MODELS_URL) return live();
    if (live && String(input) === MODELS_DEV_API_URL) return Response.json({});
    unexpected.push(String(input));
    throw new Error("Unexpected request");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubEnv("OFFLINE", undefined);
  vi.stubEnv("ZCODE_DEVICE_ID", "trigger-fixture");
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", undefined);
  sources();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  expect(unexpected.splice(0)).toEqual([]);
});

async function host(checkedAt?: number) {
  let registered: Provider | undefined;
  const on = vi.fn();
  const registerCommand = vi.fn();
  glmZcodeExtension({ on, registerCommand, registerProvider(p) {
    if (typeof p === "string") throw new Error("Expected native provider");
    registered = p;
  } });
  if (!registered?.refreshModels) throw new Error("Missing dynamic provider");
  const provider = registered;
  const modelsStore = new InMemoryModelsStore();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(providerId, async () => ({
    type: "oauth", access: "fixture-key", refresh: "fixture-refresh", zcodeJwtToken: "fixture-jwt", expires: now + 10 * period,
  }));
  const models = createModels({ modelsStore, credentials });
  const seed = provider.getModels()[0];
  if (checkedAt !== undefined) await modelsStore.write(providerId, { checkedAt, models: [{ ...seed, id: "cached" }] });
  const phases = vi.fn(registered.refreshModels);
  provider.refreshModels = phases;
  models.setProvider(provider);
  const foreign = vi.fn(async () => {});
  models.setProvider({ ...provider, id: "foreign", getModels: () => [{ ...seed, id: "foreign-only", provider: "foreign" }],
    refreshModels: foreign });
  // Host bootstrap restores only; network is disabled unless the extension explicitly opts in.
  await models.refresh({ providers: [providerId], allowNetwork: false });
  phases.mockClear();
  const refresh = vi.fn((options: ModelsRefreshOptions) => models.refresh({ allowNetwork: false, ...options }));
  const notify = vi.fn();
  const ctx = { modelRegistry: { refresh, getAll: () => models.getModels() }, hasUI: true, ui: { notify } };
  function fire(event: string) {
    const fn = on.mock.calls.find(([name]) => name === event)?.[1];
    if (typeof fn !== "function") throw new Error("Missing " + event);
    return fn({ type: event }, ctx);
  }
  const definition = registerCommand.mock.calls.find(([name]) => name === "glm-models")?.[1];
  expect(definition.argumentHint).toBe("[--force]");
  return { start: () => fire("session_start"), shutdown: () => fire("session_shutdown"),
    command: (args: string) => definition.handler(args, ctx), notify, ctx, modelsStore, models, foreign, refresh, phases };
}

const due = { providers: [providerId], allowNetwork: true, force: false, signal: expect.any(AbortSignal) };
const reply = (id: string) => Response.json([{ id }]);
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("Uninitialized deferred"); };
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}

test.each([undefined, now - period])("startup with checkedAt=%s returns before catalog I/O and publishes only GLM", async checkedAt => {
  const h = await host(checkedAt);
  const started = deferred<void>();
  const gate = deferred<Response>();
  sources(() => { started.resolve(); return gate.promise; });
  expect(h.start()).toBeUndefined();
  h.start();
  await started.promise;
  expect(h.refresh.mock.calls).toEqual([[due]]);
  expect(h.phases.mock.calls.map(([c]) => [c.allowNetwork, c.credential?.type, c.force])).toEqual([
    [false, "oauth", undefined], [true, "oauth", false],
  ]);
  expect(h.models.getModel(providerId, "new")).toBeUndefined();
  gate.resolve(reply("new"));
  await h.refresh.mock.results[0].value;
  expect((await h.modelsStore.read(providerId))?.models.map(m => m.id)).toEqual(["new"]);
  expect(h.models.getModels(providerId).map(m => m.id)).toEqual(["new"]);
  expect(h.foreign).not.toHaveBeenCalled();
  h.shutdown();
});

test("fresh start aligns to remaining freshness; a slow check moves the next due time", async () => {
  const h = await host(now - period + 500);
  const timeout = vi.spyOn(globalThis, "setTimeout");
  const interval = vi.spyOn(globalThis, "setInterval");
  const gate = deferred<Response>();
  const live = vi.fn(() => Promise.resolve(reply("next"))).mockImplementationOnce(() => gate.promise);
  sources(live);
  h.start();
  h.start();
  expect(timeout.mock.results[0].value.hasRef()).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(499);
  expect(h.refresh).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(live).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2500);
  gate.resolve(reply("slow"));
  await h.refresh.mock.results[0].value;
  await vi.advanceTimersByTimeAsync(0);
  expect(interval.mock.results.at(-1)?.value.hasRef()).toBe(false);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(period - 1);
  expect(h.refresh.mock.calls).toEqual([[due]]);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.refresh.mock.calls).toEqual([[due], [due]]);
  expect(live).toHaveBeenCalledTimes(2);
  h.shutdown();
  await vi.advanceTimersByTimeAsync(2 * period);
  expect(h.refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test("shutdown clears an alignment timeout and ignores late startup completion", async () => {
  const fresh = await host(now - 100);
  fresh.start();
  fresh.shutdown();
  const h = await host();
  const gate = deferred<Response>();
  const started = deferred<void>();
  sources(() => { started.resolve(); return gate.promise; });
  h.start();
  await started.promise;
  h.shutdown();
  gate.resolve(reply("late"));
  await h.refresh.mock.results[0].value;
  await vi.advanceTimersByTimeAsync(2 * period);
  expect(vi.getTimerCount()).toBe(0);
  expect(h.refresh).toHaveBeenCalledTimes(1);
  expect(fresh.refresh).not.toHaveBeenCalled();
});

test("shutdown cancels every queued ticket warm-up before it can poll", async () => {
  vi.setSystemTime(Date.UTC(2026, 10, 23, 0)); // 09:00 KST
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  const h = await host();
  const ticket = "https://zcode.z.ai/api/v1/off-peak/ticket";
  let takes = 0, polls = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case LIVE_MODELS_URL: return reply("glm-5.3-flash");
      case MODELS_DEV_API_URL: return Response.json({});
      case `${ticket}/availability`: return Response.json({ can_take_number: true });
      case ticket: return Response.json({ state: "queued", ticket_id: String(++takes), next_poll_after: 2 });
      case `${ticket}/status`: polls++; return Response.json({ tickets: [] });
      default: unexpected.push(String(input)); throw new Error("Unexpected request");
    }
  });
  h.start();
  await h.refresh.mock.results[0].value;
  await h.command("--force");
  expect(takes).toBe(2);
  h.shutdown();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(polls).toBe(0);
});

test("OFFLINE even when empty prevents startup polling and forced online refresh", async () => {
  vi.stubEnv("OFFLINE", "");
  const h = await host();
  h.start();
  expect(vi.getTimerCount()).toBe(0);
  expect(h.refresh).not.toHaveBeenCalled();
  await h.command("--force");
  expect(h.phases.mock.calls.every(([c]) => !c.allowNetwork)).toBe(true);
  const [text] = h.notify.mock.calls[0];
  for (const word of ["offline", "never", "glm-5.4"]) expect(text).toContain(word);
  expect(text).not.toContain("foreign-only");
  h.shutdown();
});

test("a scheduled tick checks OFFLINE again at dispatch", async () => {
  const h = await host(now);
  h.start();
  vi.stubEnv("OFFLINE", "");
  await vi.advanceTimersByTimeAsync(period);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  h.shutdown();
});

test("normal command reports cached time and IDs; force replaces fresh membership and stays scoped", async () => {
  const h = await host(now);
  await h.command("");
  expect(h.refresh.mock.calls).toEqual([[due]]);
  const [normal] = h.notify.mock.calls[0];
  expect(normal).toContain("cached");
  expect(normal).toContain(new Date(now).toISOString());
  expect(normal).not.toContain("foreign-only");
  sources(() => reply("new"));
  vi.setSystemTime(now + 100);
  await h.command("--force");
  expect(h.phases.mock.calls.at(-1)?.[0]).toMatchObject({ allowNetwork: true, credential: { type: "oauth" }, force: true });
  const [forced] = h.notify.mock.calls[1];
  expect(forced).toContain("new");
  expect(forced).toContain(new Date(now + 100).toISOString());
  expect(forced).not.toMatch(/cached|foreign-only/);
  expect(h.models.getModels(providerId).map(m => m.id)).toEqual(["new"]);
  expect(h.foreign).not.toHaveBeenCalled();
});

test("bad arguments show usage without refreshing; noninteractive command never notifies", async () => {
  const h = await host(now);
  await h.command("--force unexpected");
  expect(h.notify.mock.calls[0][0]).toMatch(/usage: \/glm-models/i);
  expect(h.refresh).not.toHaveBeenCalled();
  h.ctx.hasUI = false;
  h.notify.mockClear();
  await h.command("");
  await h.command("invalid");
  expect(h.refresh.mock.calls).toEqual([[due]]);
  expect(h.notify).not.toHaveBeenCalled();
});

test.each(["publish", "registry"])("command reports sanitized %s failure and retains cached models", async failure => {
  const h = await host(now);
  const error = new Error("sensitive fixture credential");
  if (failure === "publish") {
    sources(() => reply("unpublished"));
    vi.spyOn(h.modelsStore, "write").mockRejectedValueOnce(error);
  } else h.refresh.mockRejectedValueOnce(error);
  await h.command("--force");
  const [text, level] = h.notify.mock.calls[0];
  expect(level).toBe("error");
  expect(text).toMatch(/failed/i);
  expect(text).toContain("cached");
  expect(text).not.toMatch(/sensitive|unpublished|foreign-only/);
  expect(h.models.getModels(providerId).map(m => m.id)).toEqual(["cached"]);
});
