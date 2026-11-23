import {
  createModels, InMemoryCredentialStore, InMemoryModelsStore, normalizeContext,
  type ModelsRefreshOptions, type Provider,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import glmZcodeExtension, { resetOffPeakStateForTests } from "../extensions/glm-zcode/index.js";
import { CATALOG_REFRESH_INTERVAL_MS as period, MODELS_DEV_API_URL, ULTRA_BASE_URL } from "../extensions/glm-zcode/models.js";
import { LIVE_MODELS_URL } from "../extensions/glm-zcode/live-catalog.js";
import { OFFPEAK_BASE_URL } from "../extensions/glm-zcode/offpeak.js";
import * as oauthFlow from "../extensions/glm-zcode/oauth.js";

const now = Date.UTC(2026, 10, 23, 12);
const inWindow = Date.UTC(2026, 10, 23, 0); // 09:00 KST
const providerId = "glm-zcode";
const ticket = "https://zcode.z.ai/api/v1/off-peak/ticket";
const account = { type: "oauth", access: "fixture-key", refresh: "fixture-refresh", zcodeJwtToken: "fixture-jwt",
  expires: now + 10 * period } as const;
const otherAccount = { ...account, access: "other-key", zcodeJwtToken: "other-jwt" };
const flash = "glm-5.3-flash";
const transcript = normalizeContext({ messages: [{ role: "user", content: "fixture", timestamp: 0 }] });
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
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  vi.stubEnv("ZCODE_APP_VERSION", undefined);
  sources();
});
afterEach(() => {
  resetOffPeakStateForTests();
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
  await credentials.modify(providerId, async () => account);
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
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error("Missing OAuth registration");
  return { start: () => fire("session_start"), shutdown: () => fire("session_shutdown"),
    command: (args: string) => definition.handler(args, ctx), notify, ctx, modelsStore, models, foreign, refresh, phases,
    provider, oauth, credentials };
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

test.each([
  ["startup", "cache-only"],
  ["due tick", "cache-only"],
  ["startup", "publishes"],
  ["startup", "sources-fail"],
] as const)(
  "%s retries only when a competing refresh leaves the catalog due: %s", async (trigger, mode) => {
    const h = await host(trigger === "due tick" ? now : undefined);
    const entered = deferred<void>();
    const first = deferred<Response>();
    const newer = deferred<Response>();
    const newerEntered = deferred<void>();
    const live = vi.fn(() => Promise.resolve(mode === "sources-fail" ? new Response(null, { status: 503 }) : reply("retry")));
    if (mode !== "sources-fail") live.mockImplementationOnce(() => { entered.resolve(); return first.promise; });
    if (mode === "publishes") live.mockImplementationOnce(() => { newerEntered.resolve(); return newer.promise; });
    sources(live);
    try {
      h.start();
      if (trigger === "due tick") await vi.advanceTimersByTimeAsync(period);
      if (mode === "sources-fail") {
        await h.refresh.mock.results[0].value;
      } else {
        await entered.promise;
        const replacing = h.models.refresh({ allowNetwork: mode === "publishes", force: true });
        if (mode === "publishes") {
          await newerEntered.promise;
          await vi.advanceTimersByTimeAsync(0);
          expect(h.refresh).toHaveBeenCalledTimes(1);
          newer.resolve(reply("newer"));
        }
        await replacing;
      }
      first.resolve(reply("superseded"));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.refresh).toHaveBeenCalledTimes(mode === "cache-only" ? 2 : 1);
      expect(live).toHaveBeenCalledTimes(mode === "sources-fail" ? 1 : 2);
      const published = mode === "cache-only" ? "retry" : mode === "publishes" ? "newer" : undefined;
      expect((await h.modelsStore.read(providerId))?.models.map(row => row.id)).toEqual(published ? [published] : undefined);
      if (published) expect(h.models.getModels(providerId).map(row => row.id)).toEqual([published]);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      newer.resolve(reply("cleanup"));
      first.resolve(reply("cleanup"));
      h.shutdown();
    }
  },
);

test("startup recovery leaves a newer force alone while its first store read is pending", async () => {
  const h = await host();
  const startupEntered = deferred<void>();
  const startup = deferred<Response>();
  const live = vi.fn<() => Response | Promise<Response>>(() => reply("forced")).mockImplementationOnce(() => {
    startupEntered.resolve();
    return startup.promise;
  });
  sources(live);
  const readEntered = deferred<void>();
  const releaseRead = deferred<void>();
  let forceSignal: AbortSignal | undefined;
  try {
    h.start();
    await startupEntered.promise;
    const read = h.modelsStore.read.bind(h.modelsStore);
    vi.spyOn(h.modelsStore, "read").mockImplementationOnce(async (id, options) => {
      forceSignal = options?.signal;
      readEntered.resolve();
      await releaseRead.promise;
      return read(id, options);
    });
    const command = h.command("--force");
    await readEntered.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(forceSignal?.aborted).toBe(false);
    expect(h.refresh.mock.calls.map(([options]) => options.force)).toEqual([false, true]);
    releaseRead.resolve();
    await command;
    expect(h.phases.mock.calls.filter(([ctx]) => ctx.allowNetwork).map(([ctx]) => ctx.force)).toEqual([false, true]);
    expect((await h.modelsStore.read(providerId))?.models.map(row => row.id)).toEqual(["forced"]);
    expect(h.notify.mock.calls).toEqual([[expect.stringContaining("\nforced"), "info"]]);
  } finally {
    h.shutdown();
    releaseRead.resolve();
    startup.resolve(reply("discarded"));
  }
});

test.each(["before provider entry", "during online phase"])("force never reports success when superseded %s", async boundary => {
  const h = await host(now);
  const entered = deferred<void>();
  const release = deferred<void>();
  if (boundary === "before provider entry") {
    const read = h.modelsStore.read.bind(h.modelsStore);
    vi.spyOn(h.modelsStore, "read").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return read(...args);
    });
  } else {
    sources(async () => {
      entered.resolve();
      await release.promise;
      return reply("discarded");
    });
  }
  try {
    const command = h.command("--force");
    await entered.promise;
    await h.models.refresh({ providers: [providerId], allowNetwork: false });
    await command;
    expect(h.notify.mock.calls).toEqual([[expect.stringContaining("\ncached"), "error"]]);
    expect(h.models.getModels(providerId).map(model => model.id)).toEqual(["cached"]);
  } finally {
    h.shutdown();
    release.resolve();
  }
});

test.each(["shutdown", "restart"])("an old host refresh's online phase cannot publish after %s", async mode => {
  const h = await host(now);
  const entered = deferred<void>();
  const release = deferred<void>();
  const read = h.modelsStore.read.bind(h.modelsStore);
  vi.spyOn(h.modelsStore, "read").mockImplementationOnce(read).mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return read(...args);
  });
  const fetch = sources(() => reply("old-account-only"));
  const pending = h.models.refresh({ providers: [providerId], allowNetwork: true, force: true });
  try {
    await entered.promise;
    h.shutdown();
    await h.credentials.modify(providerId, async () => otherAccount);
    if (mode === "restart") h.start();
    release.resolve();
    await pending;

    expect(fetch).not.toHaveBeenCalled();
    expect(h.models.getModels(providerId).map(model => model.id)).toEqual(["cached"]);
    expect((await h.modelsStore.read(providerId))?.models.map(model => model.id)).toEqual(["cached"]);
  } finally {
    release.resolve();
    h.shutdown();
  }
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

test.each(["withdrawal", "replacement", "shutdown"])("a queued warm-up stops polling after route %s", async change => {
  vi.setSystemTime(inWindow);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  const h = await host();
  let id = flash;
  const takes: (AbortSignal | null | undefined)[] = [];
  const polls: unknown[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    switch (String(input)) {
      case LIVE_MODELS_URL: return reply(id);
      case MODELS_DEV_API_URL: return Response.json({});
      case `${ticket}/availability`: return Response.json({ can_take_number: true });
      case ticket:
        takes.push(init?.signal);
        return Response.json({ state: "queued", ticket_id: String(takes.length), next_poll_after: 2 });
      case `${ticket}/status`:
        polls.push(JSON.parse(String(init?.body)));
        return Response.json({ tickets: [] });
      default: unexpected.push(String(input)); throw new Error("Unexpected request");
    }
  });
  try {
    h.start();
    await h.refresh.mock.results[0].value;
    await vi.advanceTimersByTimeAsync(0);
    if (change === "shutdown") h.shutdown();
    else {
      id = change === "withdrawal" ? "ordinary" : "replacement-flash";
      await h.command("--force");
      expect(h.models.getModels(providerId).map(model => model.id)).toEqual([id]);
    }
    expect(takes.map(signal => signal?.aborted)).toEqual(change === "replacement" ? [true, false] : [true]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(polls).toEqual(change === "replacement" ? [{ ticket_ids: ["2"] }] : []);
  } finally {
    h.shutdown();
  }
  expect(vi.getTimerCount()).toBe(0);
});

function offPeakSources(take: (init?: RequestInit) => Response | Promise<Response>) {
  vi.setSystemTime(inWindow);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
  const calls: string[] = [];
  const sent: Headers[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    switch (url) {
      case LIVE_MODELS_URL: return reply(flash);
      case MODELS_DEV_API_URL: return Response.json({});
      case `${ticket}/availability`: return Response.json({ can_take_number: true });
      case ticket: return take(init);
      case `${OFFPEAK_BASE_URL}/v1/messages?beta=true`:
      case `${ULTRA_BASE_URL}/v1/messages?beta=true`:
        sent.push(new Headers(init?.headers));
        return Response.json({ type: "error", error: { type: "invalid_request_error", message: "fixture" } }, { status: 400 });
      default: unexpected.push(url); throw new Error("Unexpected request");
    }
  });
  return { calls, sent };
}

const ready = () => Response.json({ state: "ready", ticket_id: "fixture-ticket" });
const refreshOnline = { providers: [providerId], force: true, allowNetwork: true };

test.each(["neither", "first", "both"])("concurrent streams share one on-demand take with independent cancellation: %s", async cancel => {
  const entered = deferred<void>();
  const release = deferred<Response>();
  let acquireSignal: AbortSignal | null | undefined;
  let takes = 0;
  const { calls, sent } = offPeakSources(init => {
    if (++takes === 1) return new Response(null, { status: 429 }); // Warm-up refused.
    if (takes > 2) return new Response(null, { status: 429 });
    acquireSignal = init?.signal;
    entered.resolve();
    return release.promise;
  });
  const h = await host();
  try {
    await h.models.refresh(refreshOnline);
    await vi.advanceTimersByTimeAsync(0);
    const model = h.models.getModel(providerId, flash);
    if (!model) throw new Error("Missing accepted flash model");
    const auth = await h.oauth.toAuth(account);
    const first = new AbortController(), second = new AbortController();
    const start = (signal: AbortSignal) => h.provider.streamSimple(model, transcript, {
      ...auth, headers: { ...auth.headers, "X-Client-Sig": "fixture" }, signal, maxRetries: 0,
    }).result();
    const firstResult = start(first.signal);
    await entered.promise;
    const secondResult = start(second.signal);
    if (cancel !== "neither") {
      first.abort();
      expect(await firstResult).toMatchObject({ stopReason: "aborted" });
      expect(acquireSignal?.aborted).toBe(false);
    }
    if (cancel === "both") {
      second.abort();
      expect(await secondResult).toMatchObject({ stopReason: "aborted" });
      expect(acquireSignal?.aborted).toBe(true);
      expect(await start(second.signal)).toMatchObject({ stopReason: "aborted" });
    }
    release.resolve(ready());
    await Promise.all([firstResult, secondResult]);
    expect(takes).toBe(2);
    expect(calls.filter(url => url.includes("/v1/messages"))).toEqual(
      Array.from({ length: cancel === "neither" ? 2 : cancel === "first" ? 1 : 0 }, () => `${OFFPEAK_BASE_URL}/v1/messages?beta=true`),
    );
    expect(sent.every(headers => headers.get("X-Off-Peak-Ticket-ID") === "fixture-ticket")).toBe(true);
  } finally {
    release.resolve(ready());
    h.shutdown();
  }
});

test.each(["caller", "shutdown", "on-demand caller"] as const)(
  "stream cancellation ends the foreground wait without dispatching inference: %s", async mode => {
    const entered = deferred<void>();
    const release = deferred<Response>();
    let acquireSignal: AbortSignal | null | undefined;
    let takes = 0;
    const { calls } = offPeakSources(init => {
      if (++takes === 1 && mode === "on-demand caller") return new Response(null, { status: 429 });
      acquireSignal = init?.signal;
      entered.resolve();
      return release.promise;
    });
    const h = await host();
    const caller = new AbortController();
    try {
      await h.models.refresh(refreshOnline);
      await vi.advanceTimersByTimeAsync(0);
      const model = h.models.getModel(providerId, flash);
      if (!model) throw new Error("Missing accepted flash model");
      const auth = await h.oauth.toAuth(account);
      const start = (signal?: AbortSignal) => h.provider.streamSimple(model, transcript, {
        ...auth, headers: { ...auth.headers, "X-Client-Sig": "fixture" }, signal, maxRetries: 0,
      }).result();
      const pending = start(caller.signal);
      await entered.promise;
      const before = [...calls];
      if (mode === "shutdown") h.shutdown();
      else caller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(await Promise.race([pending, Promise.resolve("still waiting")])).toMatchObject({ stopReason: "aborted" });
      expect(acquireSignal?.aborted).toBe(mode !== "caller");
      expect(calls).toEqual(before);
      if (mode === "caller") {
        const unabridged = start();
        release.resolve(ready());
        await unabridged;
        expect(calls.slice(before.length)).toEqual([`${OFFPEAK_BASE_URL}/v1/messages?beta=true`]);
      } else {
        release.resolve(ready());
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(before);
      }
    } finally {
      release.resolve(ready());
      h.shutdown();
    }
  },
);

test("a foreground stream waiting on shared warm-up keeps its own timer referenced", async () => {
  offPeakSources(() => Response.json({ state: "queued", ticket_id: "queued", next_poll_after: 2 }));
  const h = await host();
  const clock = vi.spyOn(globalThis, "setTimeout");
  try {
    await h.models.refresh(refreshOnline);
    await vi.advanceTimersByTimeAsync(0);
    const warm = clock.mock.calls.findIndex(([, ms]) => ms === 2000);
    expect(clock.mock.results[warm]?.value.hasRef()).toBe(false);
    const model = h.models.getModel(providerId, flash);
    if (!model) throw new Error("Missing accepted flash model");
    const auth = await h.oauth.toAuth(account);
    const result = h.provider.streamSimple(model, transcript, auth).result();
    const waiter = clock.mock.calls.findIndex(([, ms]) => ms === 60_000);
    expect(clock.mock.results[waiter]?.value.hasRef()).toBe(true);
    h.shutdown();
    expect(await result).toMatchObject({ stopReason: "aborted" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    h.shutdown();
  }
});

test("first auth resolution reuses the ticket taken for the accepted catalog", async () => {
  let takes = 0;
  const { calls, sent } = offPeakSources(() => ++takes === 1 ? ready() : new Response(null, { status: 429 }));
  const h = await host();
  try {
    // This model object predates the accepted off-peak route and still points to ultra.
    const held = { ...h.provider.getModels()[0], id: flash };
    expect(held.baseUrl).toBe(ULTRA_BASE_URL);
    await h.models.refresh(refreshOnline);
    await vi.advanceTimersByTimeAsync(0);
    expect(takes).toBe(1);
    const auth = await h.oauth.toAuth(account);
    await h.provider.streamSimple(held, transcript, {
      ...auth, headers: { ...auth.headers, "X-Client-Sig": "fixture" }, maxRetries: 0,
    }).result();
    expect(calls.at(-1)).toBe(`${OFFPEAK_BASE_URL}/v1/messages?beta=true`);
    expect(sent[0]?.get("X-Off-Peak-Ticket-ID")).toBe("fixture-ticket");
    expect(takes).toBe(1);
  } finally {
    h.shutdown();
  }
});

test.each(["account switch", "new session"] as const)(
  "a held flash model cannot authorize an off-peak dispatch after %s", async change => {
    const { calls, sent } = offPeakSources(ready);
    const h = await host();
    try {
      await h.models.refresh(refreshOnline);
      const selected = h.models.getModel(providerId, flash);
      if (!selected) throw new Error("Missing accepted flash model");
      expect(selected.baseUrl).toBe(OFFPEAK_BASE_URL);
      if (change === "new session") {
        h.shutdown();
        h.start();
        await h.models.refresh({ providers: [providerId], allowNetwork: false });
        expect(h.models.getModel(providerId, flash)?.baseUrl).toBe(ULTRA_BASE_URL);
      }
      const auth = await h.oauth.toAuth(change === "new session" ? account : otherAccount);
      const priorCalls = calls.length;
      await h.provider.streamSimple(selected, transcript, {
        ...auth, headers: { ...auth.headers, "X-Client-Sig": "fixture" }, maxRetries: 0,
      }).result();
      expect(calls.slice(priorCalls)).toEqual([`${ULTRA_BASE_URL}/v1/messages?beta=true`]);
      expect(sent[0]?.has("X-Off-Peak-Ticket-ID")).toBe(false);
    } finally {
      h.shutdown();
    }
  },
);

test.each([true, false])("fresh restore after a gated host write keeps the route only within the same session: shutdown=%s", async shutdown => {
  vi.setSystemTime(inWindow);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  const h = await host();
  const flash = "glm-5.3-flash";
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    switch (String(input)) {
      case LIVE_MODELS_URL: return reply(flash);
      case MODELS_DEV_API_URL: return Response.json({});
      case `${ticket}/availability`: return Response.json({ can_take_number: true });
      case ticket: return Response.json({ state: "ready", ticket_id: "fixture-ticket" });
      default: unexpected.push(String(input)); throw new Error("Unexpected request");
    }
  });
  vi.stubGlobal("fetch", fetch);

  const entered = deferred<void>();
  const release = deferred<void>();
  const write = h.modelsStore.write.bind(h.modelsStore);
  vi.spyOn(h.modelsStore, "write").mockImplementationOnce(async (...args) => {
    entered.resolve();
    await release.promise;
    return write(...args);
  });
  const providers = [providerId];
  const pending = h.models.refresh({ providers, allowNetwork: true, force: true });
  try {
    await entered.promise;
    if (shutdown) h.shutdown();
    release.resolve();
    await pending;
    const lateBaseUrl = h.models.getModel(providerId, flash)?.baseUrl;
    h.start();
    await h.models.refresh({ providers, allowNetwork: true, force: false });

    const expected = shutdown ? ULTRA_BASE_URL : OFFPEAK_BASE_URL;
    expect(h.models.getModel(providerId, flash)?.baseUrl).toBe(expected);
    if (shutdown) expect(lateBaseUrl).toBeUndefined();
    else expect(lateBaseUrl).toBe(expected);
    expect((await h.modelsStore.read(providerId))?.models).toMatchObject([{ id: flash, baseUrl: ULTRA_BASE_URL }]);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      LIVE_MODELS_URL, MODELS_DEV_API_URL, `${ticket}/availability`, ...(shutdown ? [] : [ticket]),
    ]);
  } finally {
    release.resolve();
    h.shutdown();
  }
});

test("startup publishes canonical live rows before the deadline when metadata and availability run long", async () => {
  vi.setSystemTime(inWindow);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  // Native AbortSignal.timeout uses its own clock, not Vitest's fake timers.
  vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const h = await host();
  const flash = "glm-5.3-flash";
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    switch (String(input)) {
      case LIVE_MODELS_URL: return new Promise<Response>(resolve => setTimeout(() => resolve(reply(flash)), 10_500));
      case MODELS_DEV_API_URL: {
        const signal = init?.signal;
        if (!signal) throw new Error("Missing metadata signal");
        return new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }
      case `${ticket}/availability`:
        // The response arrives after the optional cutoff even if the caller aborts.
        return new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ can_take_number: false })), 3000));
      default: unexpected.push(String(input)); throw new Error("Unexpected request");
    }
  });
  vi.stubGlobal("fetch", fetch);
  h.start();
  try {
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.models.getModels(providerId)).toMatchObject([{ id: flash, baseUrl: ULTRA_BASE_URL, input: ["text"] }]);
    expect((await h.modelsStore.read(providerId))?.models).toMatchObject([{ id: flash, baseUrl: ULTRA_BASE_URL }]);
    expect(h.refresh.mock.calls[0][0].signal?.aborted).toBe(false);
    expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
      LIVE_MODELS_URL, MODELS_DEV_API_URL, `${ticket}/availability`,
    ]);
    expect(fetch.mock.calls.find(([input]) => input === `${ticket}/availability`)?.[1]?.signal?.aborted).toBe(true);
  } finally {
    h.shutdown();
    vi.clearAllTimers();
  }
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

test.each(["start", "manual"])("an offline tick disarms polling until online %s re-entry", async reentry => {
  const h = await host(now);
  h.start();
  vi.stubEnv("OFFLINE", "");
  await vi.advanceTimersByTimeAsync(period);
  expect(h.refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  vi.stubEnv("OFFLINE", undefined);
  const live = vi.fn(() => reply("resumed"));
  sources(live);
  if (reentry === "start") h.start();
  else await h.command("--force");
  await vi.advanceTimersByTimeAsync(0);
  expect(live).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  await vi.advanceTimersByTimeAsync(period);
  expect(live).toHaveBeenCalledTimes(2);
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

test("aborting the OAuth interaction closes the real manual fallback prompt", async () => {
  const h = await host();
  const controller = new AbortController();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    if (String(input) === "https://zcode.z.ai/api/v1/oauth/cli/init") return new Response(null, { status: 503 });
    unexpected.push(String(input));
    throw new Error("Unexpected request");
  });
  const entered = deferred<void>();
  const prompt = vi.fn<Parameters<typeof h.oauth.login>[0]["prompt"]>(spec => {
    entered.resolve();
    return new Promise<string>((_, reject) => spec.signal?.addEventListener("abort", () => reject(spec.signal?.reason), { once: true }));
  });
  const login = h.oauth.login({ signal: controller.signal, notify() {}, prompt });
  await entered.promise;
  expect(prompt.mock.calls[0]?.[0].type).toBe("manual_code");
  expect(prompt.mock.calls[0]?.[0].signal).toBe(controller.signal);
  controller.abort();
  await expect(login).rejects.toBe(controller.signal.reason);
});

test("the OAuth adapter preserves narrower text and select prompt signals", async () => {
  const h = await host();
  const signal = new AbortController().signal;
  const narrower = new AbortController().signal;
  vi.spyOn(oauthFlow, "loginGlmZcode").mockImplementation(async callbacks => {
    await callbacks.onPrompt({ message: "fixture", type: "secret", signal: narrower });
    await callbacks.onSelect({ message: "fixture", options: [], signal: narrower });
    return account;
  });
  const prompt = vi.fn<Parameters<typeof h.oauth.login>[0]["prompt"]>(async () => "fixture");
  await h.oauth.login({ signal, notify() {}, prompt });
  expect(prompt.mock.calls.map(([spec]) => spec.type)).toEqual(["secret", "select"]);
  expect(prompt.mock.calls[0]?.[0].signal).toBe(narrower);
  expect(prompt.mock.calls[1]?.[0].signal).toBe(narrower);
});
