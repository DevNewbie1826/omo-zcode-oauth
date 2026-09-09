import { webcrypto as nodeWebcrypto } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import { resetZCodeSigningState } from "../extensions/glm-zcode/signing.js";
import glmZcodeExtension, {
  resetOffPeakStateForTests,
  setOffPeakClockForTests,
  setOffPeakTransportForTests,
} from "../extensions/glm-zcode/index.js";

/**
 * Wire-level off-peak routing tests through the REAL provider stream path:
 * real signer (gate/handshake stubbed, cipher generated locally), real pi-ai
 * anthropic client (fetch stubbed), and models shaped exactly as the senpi
 * provider composer emits them — baseUrl preserved, headers cleared.
 */

const subtle = nodeWebcrypto.subtle;
const KEY = "wire-key-id.wire-secret";
const JWT = "wire-jwt";
const OFFPEAK_MESSAGES = "https://zcode.z.ai/api/v1/off-peak/anthropic/v1/messages";
const ULTRA_MESSAGES = "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages";
const IN_WINDOW = new Date("2026-09-09T18:00:00Z"); // 03:00 KST
const WINDOW_EDGE = new Date("2026-09-09T00:59:59.500Z"); // 09:59:59.5 KST
const OUT_WINDOW = new Date("2026-09-09T08:00:00Z"); // 17:00 KST

type Registered = { name: string; config: ProviderConfig };

function captureProvider(): Registered {
  let captured: Registered | undefined;
  const pi = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "registerProvider") {
          return (name: string, config: ProviderConfig) => {
            captured = { name, config };
          };
        }
        return () => undefined;
      },
    },
  );
  glmZcodeExtension(pi as Parameters<typeof glmZcodeExtension>[0]);
  if (!captured) throw new Error("provider not registered");
  return captured;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function sseResponse(): Response {
  const frames = [
    ["message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", model: "glm-5.3-flash", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } }],
    ["message_stop", { type: "message_stop" }],
  ];
  const body = frames.map(([event, data]) => "event: " + event + "\n" + "data: " + JSON.stringify(data) + "\n\n").join("");
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

async function hkdf(secret: string, info: string): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("WD_CLIENT_SIGN_KDF_SALT"), info: new TextEncoder().encode(info) }, key, 256);
  return new Uint8Array(bits);
}

/** Server-shaped privateCipher for the real signing handshake. */
async function cipherFixture(): Promise<string> {
  const pair = (await subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const aes = await subtle.importKey("raw", await hkdf("wire-secret", "ed25519_priv"), "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  nodeWebcrypto.getRandomValues(iv);
  const sealed = new Uint8Array(await subtle.encrypt({ additionalData: new TextEncoder().encode("wire-key-id"), iv, name: "AES-GCM", tagLength: 128 } as unknown as Algorithm, aes, new TextEncoder().encode(Buffer.from(pkcs8).toString("base64"))));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return Buffer.from(out).toString("base64");
}

/** A model exactly as the provider composer projects it: headers cleared, baseUrl kept. */
function composedOffPeakModel() {
  return {
    provider: "glm-zcode",
    api: "anthropic-messages",
    baseUrl: "https://zcode.z.ai/api/v1/off-peak/anthropic",
    headers: undefined,
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  } as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[0];
}

const wireContext = {
  tools: [],
  messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "Say OK" }], timestamp: Date.now() }],
} as unknown as Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];

type WireEntry = { url: string; headers: Record<string, string> };

afterEach(() => {
  setOffPeakClockForTests(undefined);
  setOffPeakTransportForTests(undefined);
  resetOffPeakStateForTests();
  resetZCodeSigningState();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("off-peak wire routing (real signer, composer-shaped models)", () => {
  test("fresh ticket in-window: off-peak gateway, JWT auth, no signature headers", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    const wire: WireEntry[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/off-peak/ticket")) return json({ ticket_id: "t-1", state: "ready" });
        wire.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return sseResponse();
      }),
    );

    const stream = config.streamSimple!(composedOffPeakModel(), wireContext, {
      apiKey: KEY,
      headers: { Authorization: `Bearer ${KEY}`, "X-ZCode-Agent": "glm" },
    } as never);
    const message = await stream.result();

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = wire.find((entry) => entry.url.includes("/v1/messages"))!;
    expect(model.url).toBe(OFFPEAK_MESSAGES);
    expect(model.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBe("t-1");
    expect(model.headers["x-coding-plan-api-key"]).toBe(KEY);
    expect(model.headers["x-client-sig"]).toBeUndefined();
  });

  test("ticket failure and outside window: signed ultra fallback through the real signer", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    const cipher = await cipherFixture();
    for (const [label, clock, takeStatus] of [
      ["ticket-429", IN_WINDOW, 429],
      ["out-of-window", OUT_WINDOW, 200],
    ] as const) {
      resetZCodeSigningState();
      setOffPeakClockForTests(clock);
      const { config } = captureProvider();
      config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
      const wire: WireEntry[] = [];
      const gate: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith("/off-peak/ticket")) return json({ code: 3103, msg: "limit" }, takeStatus);
          if (url.endsWith("/agent/configs")) {
            gate.push(url);
            return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
          }
          if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: cipher } });
          wire.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
          return sseResponse();
        }),
      );

      const stream = config.streamSimple!(composedOffPeakModel(), wireContext, {
        apiKey: KEY,
        headers: { Authorization: `Bearer ${KEY}`, "X-ZCode-Agent": "glm" },
      } as never);
      const message = await stream.result();

      expect(message.content, `${label} content`).toEqual([{ type: "text", text: "OK" }]);
      expect(gate, `${label} signing gate consulted`).toHaveLength(1);
      const model = wire.find((entry) => entry.url.includes("/v1/messages"))!;
      expect(model.url).toBe(ULTRA_MESSAGES);
      expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
      expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
    }
  });

  test("window closing during ticket acquisition falls back to signed ultra", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(WINDOW_EDGE);
    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    const wire: WireEntry[] = [];
    let releaseTake: (() => void) | undefined;
    let takeStarted: (() => void) | undefined;
    const takeStartedPromise = new Promise<void>((resolve) => {
      takeStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/off-peak/ticket")) {
          takeStarted?.();
          await new Promise<void>((resolve) => {
            releaseTake = resolve;
          });
          return json({ ticket_id: "t-late", state: "ready" });
        }
        if (url.endsWith("/agent/configs")) return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: await cipherFixture() } });
        wire.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return sseResponse();
      }),
    );

    const stream = config.streamSimple!(composedOffPeakModel(), wireContext, {
      apiKey: KEY,
      headers: { Authorization: `Bearer ${KEY}`, "X-ZCode-Agent": "glm" },
    } as never);
    const pending = stream.result();
    await Promise.race([takeStartedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("take never started")), 2_000))]);
    setOffPeakClockForTests(new Date("2026-09-09T01:00:01Z")); // window closed mid-acquisition
    releaseTake?.();
    const message = await pending;

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = wire.find((entry) => entry.url.includes("/v1/messages"))!;
    expect(model.url).toBe(ULTRA_MESSAGES);
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
    expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
  });

  test("transport failure: refreshModels never routes flash off-peak despite a valid window", async () => {
    setOffPeakTransportForTests(false);
    setOffPeakClockForTests(IN_WINDOW);
    const { config } = captureProvider();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === "https://api.z.ai/api/anthropic/v1/models") {
          return json({ data: [{ id: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }, { id: "glm-5.3", display_name: "GLM-5.3" }] });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const refreshed = await config.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: { type: "oauth", access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT },
      publish: async () => {},
      force: true,
    } as never);

    expect(refreshed?.map((model) => model.id).sort()).toEqual(["glm-5.3", "glm-5.3-flash"]);
    const flash = refreshed?.find((model) => model.id.includes("flash"));
    expect(flash?.baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    expect(requests).toEqual(["https://api.z.ai/api/anthropic/v1/models"]);
  });

  test("transport ready with availability and ticket: refreshModels routes flash off-peak", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const { config } = captureProvider();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://api.z.ai/api/anthropic/v1/models") {
          return json({ data: [{ id: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }, { id: "glm-5.3", display_name: "GLM-5.3" }] });
        }
        if (url === "https://zcode.z.ai/api/v1/off-peak/ticket/availability") {
          return json({ code: 0, data: { can_take_number: true } });
        }
        if (url === "https://zcode.z.ai/api/v1/off-peak/ticket") {
          return json({ ticket_id: "t-refresh", state: "ready" });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    const refreshed = await config.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: { type: "oauth", access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT },
      publish: async () => {},
      force: true,
    } as never);

    const flash = refreshed?.find((model) => model.id.includes("flash"));
    const plain = refreshed?.find((model) => !model.id.includes("flash"));
    expect(flash?.baseUrl).toBe("https://zcode.z.ai/api/v1/off-peak/anthropic");
    expect(plain?.baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    vi.unstubAllEnvs();
  });
});

describe("pending ticket lifecycle (retry and reacquisition)", () => {
  const routedModel = () => composedOffPeakModel();
  const run = (config: ProviderConfig, clock: Date) =>
    config.streamSimple!(routedModel(), wireContext, { apiKey: KEY, headers: { Authorization: `Bearer ${KEY}`, "X-ZCode-Agent": "glm" } } as never).result();

  test("a failed request-time acquisition is retried on the next request", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    let takes = 0;
    const wire: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/off-peak/ticket")) {
          takes += 1;
          return takes === 1 ? json({ code: 3103, msg: "limit" }, 429) : json({ ticket_id: "t-retry", state: "ready" });
        }
        if (url.endsWith("/agent/configs")) return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: await cipherFixture() } });
        wire.push(url);
        return sseResponse();
      }),
    );

    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    await run(config, IN_WINDOW);
    await run(config, IN_WINDOW);

    expect(takes).toBe(2);
    expect(wire).toEqual([ULTRA_MESSAGES, OFFPEAK_MESSAGES]);
  });

  test("a refresh warm-up does not bypass ticket expiry (refresh-first flow)", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    let takes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/off-peak/ticket")) {
          takes += 1;
          return json({ ticket_id: `t-warm-${takes}`, state: "ready" });
        }
        if (url.endsWith("/off-peak/ticket/availability")) return json({ code: 0, data: { can_take_number: true } });
        throw new Error(`unexpected ${url}`);
      }),
    );

    const wire: string[] = [];
    const usedTickets: string[] = [];
    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === "https://api.z.ai/api/anthropic/v1/models") {
          return json({ data: [{ id: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }, { id: "glm-5.3", display_name: "GLM-5.3" }] });
        }
        if (url.endsWith("/off-peak/ticket")) {
          takes += 1;
          return json({ ticket_id: `t-warm-${takes}`, state: "ready" });
        }
        if (url.endsWith("/off-peak/ticket/availability")) return json({ code: 0, data: { can_take_number: true } });
        if (url.endsWith("/agent/configs")) return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: await cipherFixture() } });
        if (url.includes("/v1/messages")) {
          wire.push(url);
          usedTickets.push(new Headers(init?.headers).get("x-off-peak-ticket-id") ?? "?");
          return sseResponse();
        }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const refreshed = await config.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: { type: "oauth", access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT },
      publish: async () => {},
      force: true,
    } as never);
    expect(refreshed?.find((model) => model.id.includes("flash"))?.baseUrl).toBe("https://zcode.z.ai/api/v1/off-peak/anthropic");
    expect(takes).toBe(1); // the refresh warm-up itself took the ticket
    await run(config, IN_WINDOW); // uses the warm ticket
    setOffPeakClockForTests(new Date(IN_WINDOW.getTime() + 11 * 60_000)); // TTL expiry
    await run(config, IN_WINDOW); // must re-take with a NEW ticket id

    expect(takes).toBe(2); // warm take + one reacquisition after TTL
    expect(wire).toEqual([OFFPEAK_MESSAGES, OFFPEAK_MESSAGES]);
    expect(usedTickets[0]).not.toBe(usedTickets[1]);
    expect(usedTickets[1]).toBe("t-warm-2");
    vi.unstubAllEnvs();
  });

  test("a fulfilled pending promise does not outlive the ticket TTL", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    let takes = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/off-peak/ticket")) {
          takes += 1;
          return json({ ticket_id: `t-${takes}`, state: "ready" });
        }
        throw new Error(`unexpected ${url}`);
      }),
    );

    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    await run(config, IN_WINDOW); // take 1, cached fresh
    setOffPeakClockForTests(new Date(IN_WINDOW.getTime() + 11 * 60_000)); // TTL expired, same window
    await run(config, IN_WINDOW); // must re-take, not reuse the fulfilled promise

    expect(takes).toBe(2);
  });
});

describe("device identity metadata (PR10)", () => {
  const captured = (handlers: Record<string, unknown[]>) => {
    let config: ProviderConfig | undefined;
    const pi = new Proxy({}, { get: (_t: any, p: any) => (p === "registerProvider" ? (_n: string, c: ProviderConfig) => { config = c; } : (p === "on" ? (e: string, h: any) => { (handlers[e] ??= []).push(h); } : () => undefined)) });
    glmZcodeExtension(pi as Parameters<typeof glmZcodeExtension>[0]);
    if (!config) throw new Error("not registered");
    return config;
  };

  test("before_provider_request injects metadata.user_id with the machine device id", async () => {
    vi.stubEnv("ZCODE_DEVICE_ID", "test-device-1234");
    const handlers: Record<string, unknown[]> = {};
    captured(handlers);
    const hook = handlers["before_provider_request"][0] as (e: any) => unknown;
    const payload: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    const model = { provider: "glm-zcode" };
    const result = hook({ payload, model });
    const meta = JSON.parse((payload.metadata as { user_id: string }).user_id);
    expect(meta.device_id).toBe("test-device-1234");
    expect(meta.account_uuid).toBe("");
    expect(typeof meta.session_id).toBe("string");
    expect(result).toBe(payload);
    vi.unstubAllEnvs();
  });

  test("foreign providers and pre-existing metadata are untouched", async () => {
    const handlers: Record<string, unknown[]> = {};
    captured(handlers);
    const hook = handlers["before_provider_request"][0] as (e: any) => unknown;
    const foreign: Record<string, unknown> = { model: "x", messages: [] };
    hook({ payload: foreign, model: { provider: "openai" } });
    expect(foreign.metadata).toBeUndefined();
    const own: Record<string, unknown> = { model: "x", metadata: { user_id: "keep" } };
    hook({ payload: own, model: { provider: "glm-zcode" } });
    expect((own.metadata as { user_id: string }).user_id).toBe("keep");
  });

  test("off-peak routing requires ZCODE_OFFPEAK_ENABLE=1", async () => {
    setOffPeakClockForTests(IN_WINDOW);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === "https://api.z.ai/api/anthropic/v1/models") return json({ data: [{ id: "glm-5.3-flash" }] });
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { config } = captureProvider();
    const refreshed = await config.refreshModels!({
      allowNetwork: true,
      signal: new AbortController().signal,
      credential: { type: "oauth", access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT },
      publish: async () => {},
      force: true,
    } as never);
    expect(refreshed?.[0].baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
  });
});

describe("stale off-peak routing guard", () => {
  test("flag unset: off-peak-routed model falls back to signed ultra at request time", async () => {
    const cipher = await cipherFixture();
    setOffPeakClockForTests(IN_WINDOW);
    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    const wire: WireEntry[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/agent/configs")) return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: cipher } });
        wire.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
        return sseResponse();
      }),
    );

    const stream = config.streamSimple!(composedOffPeakModel(), wireContext, {
      apiKey: KEY,
      headers: { Authorization: `Bearer ${KEY}`, "X-ZCode-Agent": "glm" },
    } as never);
    const message = await stream.result();

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = wire.find((entry) => entry.url.includes("/v1/messages"))!;
    expect(model.url).toBe(ULTRA_MESSAGES);
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
  });
});

describe("off-peak flag gates cached tickets too", () => {
  test("warm cache is bypassed when ZCODE_OFFPEAK_ENABLE is unset mid-flight", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    let takes = 0;
    const wire: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/off-peak/ticket")) { takes += 1; return json({ ticket_id: "t-c", state: "ready" }); }
        if (url.endsWith("/agent/configs")) return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: await cipherFixture() } });
        if (url.includes("/v1/messages")) { wire.push(url); return sseResponse(); }
        throw new Error(`unexpected ${url}`);
      }),
    );
    const { config } = captureProvider();
    config.oauth!.getApiKey({ access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
    const run = () => config.streamSimple!(composedOffPeakModel(), wireContext, { apiKey: KEY, headers: { Authorization: `Bearer ${KEY}`, "X-ZCode-Agent": "glm" } } as never).result();
    await run(); // warms the ticket cache (off-peak)
    expect(wire[0]).toBe(OFFPEAK_MESSAGES);

    vi.unstubAllEnvs(); // flag OFF mid-flight, cache still warm
    await run(); // must ignore the warm cache and fall back to signed ultra
    expect(wire[1]).toBe(ULTRA_MESSAGES);
    expect(takes).toBe(1); // no new acquisition either
  });
});
