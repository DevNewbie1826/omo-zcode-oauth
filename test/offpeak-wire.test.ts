import { webcrypto as nodeWebcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Model, Provider, RefreshModelsContext, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import { resetZCodeSigningState, zcodeSessionId } from "../extensions/glm-zcode/signing.js";
import glmZcodeExtension, {
  resetOffPeakStateForTests,
  setOffPeakClockForTests,
  setOffPeakTransportForTests,
} from "../extensions/glm-zcode/index.js";
import { MODELS_DEV_API_URL, ULTRA_BASE_URL } from "../extensions/glm-zcode/models.js";
import { OFFPEAK_BASE_URL } from "../extensions/glm-zcode/offpeak.js";
import { LIVE_MODELS_URL } from "../extensions/glm-zcode/live-catalog.js";

// The runtime posts to `<baseUrl>/v1/messages?beta=true`; assertions split origin+path from query.
const subtle = nodeWebcrypto.subtle;
const KEY = "wire-key-id.wire-secret";
const JWT = "wire-jwt";
const TICKET_BASE = "https://zcode.z.ai/api/v1/off-peak/ticket";
const IN_WINDOW = new Date("2026-09-09T18:00:00Z");
const WINDOW_EDGE = new Date("2026-09-09T00:59:59.500Z");
const OUT_WINDOW = new Date("2026-09-09T08:00:00Z");
const FAKE_HOST = "https://fake-glm-host.example/anthropic";

type RequestHook = (event: { payload: unknown; model: { provider: string } }) => unknown;
type HeadersHook = (event: { headers: Record<string, string | null> }) => Promise<void>;

function captureExtension() {
  const on = vi.fn();
  let provider: Provider | undefined;
  glmZcodeExtension({
    on,
    registerCommand: vi.fn(),
    registerProvider(p: Provider | string) {
      if (typeof p === "string") throw new Error("Expected native provider registration");
      provider = p;
    },
  });
  if (!provider) throw new Error("provider not registered");
  return { provider, on };
}

function registeredHook<T>(on: ReturnType<typeof vi.fn>, event: string): T {
  const handler: unknown = on.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof handler !== "function") throw new Error(`${event} not registered`);
  return handler as T;
}

async function signedHeaders(provider: Provider, on: ReturnType<typeof vi.fn>): Promise<Record<string, string | null>> {
  const oauth = provider.auth.oauth;
  if (!oauth) throw new Error("OAuth auth not registered");
  const auth = await oauth.toAuth({ type: "oauth", access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT });
  const headers = auth.headers ?? {};
  await registeredHook<HeadersHook>(on, "before_provider_headers")({ headers });
  return headers;
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

function wireModel(baseUrl: string, id = "glm-5.3-flash"): Model<"anthropic-messages"> {
  return {
    provider: "glm-zcode",
    api: "anthropic-messages",
    baseUrl,
    id,
    name: id === "glm-5.3-flash" ? "GLM-5.3-Flash" : id,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    thinkingLevelMap: { minimal: "low", low: "low", medium: "low", high: "high", xhigh: "max", max: "max" },
    compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
  };
}

const transcript = normalizeContext({
  messages: [{ role: "user", content: [{ type: "text", text: "Say OK" }], timestamp: 0 }],
});

type WireEntry = { url: string; pathname: string; query: string; headers: Record<string, string>; body: string };
type Route = (url: string) => Response | undefined | Promise<Response | undefined>;

function wireFetch(wire: WireEntry[], route: Route = () => undefined) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const routed = await route(url);
    if (routed) return routed;
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/v1/messages")) throw new Error(`unexpected request: ${url}`);
    const raw = init?.body;
    wire.push({
      url,
      pathname: parsed.origin + parsed.pathname,
      query: parsed.search,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof raw === "string" ? raw : raw == null ? "" : String(raw),
    });
    return sseResponse();
  });
}

function messageUrl(wire: WireEntry[]): WireEntry {
  const entry = wire.find((item) => item.pathname.endsWith("/v1/messages"));
  if (!entry) throw new Error("no /v1/messages request was recorded");
  return entry;
}

function refreshHost(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
  return {
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    credential: { type: "oauth", access: KEY, refresh: "r", expires: 1, zcodeJwtToken: JWT },
    publish: async (publication) => {
      publication.update?.();
      return true;
    },
    ...overrides,
  };
}

function signingRoutes(cipher: string) {
  return (url: string): Response | undefined => {
    if (url.endsWith("/agent/configs")) return json({ code: 0, data: { codingPlanSignature: { enable: true } } });
    if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) return json({ code: 200, data: { privateCipher: cipher } });
    return undefined;
  };
}

async function runStream(provider: Provider, auth: Record<string, string | null>, options: Partial<SimpleStreamOptions> = {}) {
  return provider.streamSimple(wireModel(OFFPEAK_BASE_URL), transcript, { apiKey: KEY, headers: auth, maxRetries: 0, ...options }).result();
}

beforeEach(() => {
  vi.stubEnv("OFFLINE", undefined);
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
});

afterEach(() => {
  setOffPeakClockForTests(undefined);
  setOffPeakTransportForTests(undefined);
  resetOffPeakStateForTests();
  resetZCodeSigningState();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("off-peak wire routing (native provider, signed request path)", () => {
  test("fresh ticket in-window: off-peak gateway, JWT auth, no signature headers", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    const wire: WireEntry[] = [];
    let takes = 0;
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, (url) => {
        if (url === TICKET_BASE) {
          takes += 1;
          return json({ ticket_id: "t-1", state: "ready" });
        }
        return signingRoutes(cipher)(url);
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);
    expect(auth.Authorization).toBe(`Bearer ${KEY}`);
    expect(auth["X-Client-Sig"]).toMatch(/^\S+$/);

    const stream = provider.streamSimple(wireModel(OFFPEAK_BASE_URL), transcript, {
      apiKey: KEY,
      headers: auth,
      maxRetries: 0,
    });
    const message = await stream.result();

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = messageUrl(wire);
    expect(model.pathname).toBe(`${OFFPEAK_BASE_URL}/v1/messages`);
    expect(model.query).toBe("?beta=true");
    expect(model.headers.authorization).toBe(`Bearer ${JWT}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBe("t-1");
    expect(model.headers["x-coding-plan-api-key"]).toBe(KEY);
    expect(model.headers["x-client-sig"]).toBeUndefined();
    expect(model.headers["x-zcode-agent"]).toBe("glm");
    expect(takes).toBe(1);
    const body = JSON.parse(model.body) as { model: string; stream: boolean };
    expect(body.model).toBe("glm-5.3-flash");
    expect(body.stream).toBe(true);
  });

  test("ticket failure and outside window: signed ultra fallback through the real signer", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    const cipher = await cipherFixture();
    for (const [label, clock, takeStatus] of [
      ["ticket-429", IN_WINDOW, 429],
      ["out-of-window", OUT_WINDOW, 200],
    ] as const) {
      resetZCodeSigningState();
      resetOffPeakStateForTests();
      setOffPeakClockForTests(clock);
      const wire: WireEntry[] = [];
      const gate: string[] = [];
      vi.stubGlobal(
        "fetch",
        wireFetch(wire, (url) => {
          if (url === TICKET_BASE) return json({ code: 3103, msg: "limit" }, takeStatus);
          if (url.endsWith("/agent/configs")) gate.push(url);
          return signingRoutes(cipher)(url);
        }),
      );
      const { provider, on } = captureExtension();
      const auth = await signedHeaders(provider, on);

      const stream = provider.streamSimple(wireModel(OFFPEAK_BASE_URL), transcript, {
        apiKey: KEY,
        headers: auth,
        maxRetries: 0,
      });
      const message = await stream.result();

      expect(message.content, `${label} content`).toEqual([{ type: "text", text: "OK" }]);
      expect(gate, `${label} signing gate consulted`).toHaveLength(1);
      const model = messageUrl(wire);
      expect(model.pathname, `${label} origin/path`).toBe(`${ULTRA_BASE_URL}/v1/messages`);
      expect(model.query, `${label} beta transport`).toBe("?beta=true");
      expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
      expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
      expect(model.headers["x-zcode-agent"]).toBe("glm");
      expect(model.headers["x-session-id"]).toBe(zcodeSessionId());
      expect(JSON.parse(model.body).model).toBe("glm-5.3-flash");
    }
  });

  test("signed ultra carries source marker, bearer, signed version and matching session metadata", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    vi.stubEnv("ZCODE_DEVICE_ID", "wire-device");
    setOffPeakClockForTests(OUT_WINDOW);
    const cipher = await cipherFixture();
    const wire: WireEntry[] = [];
    vi.stubGlobal("fetch", wireFetch(wire, signingRoutes(cipher)));
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);

    const payload = { model: "glm-5.3-flash", messages: [{ role: "user", content: "hi" }] } as Record<string, unknown>;
    const hook = registeredHook<RequestHook>(on, "before_provider_request");
    const message = await provider.streamSimple(wireModel(OFFPEAK_BASE_URL), transcript, {
      apiKey: KEY,
      headers: auth,
      maxRetries: 0,
      onPayload: () => hook({ payload, model: { provider: "glm-zcode" } }),
    }).result();

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = messageUrl(wire);
    expect(model.pathname).toBe(`${ULTRA_BASE_URL}/v1/messages`);
    expect(model.headers["x-zcode-agent"]).toBe("glm");
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-client-version"]).toBe("4.0.0");
    expect(model.headers["x-session-id"]).toBe(zcodeSessionId());
    const sent = JSON.parse(model.body) as { metadata: { user_id: string } };
    const meta = JSON.parse(sent.metadata.user_id) as { device_id: string; session_id: string };
    expect(meta.device_id).toBe("wire-device");
    expect(meta.session_id).toBe(model.headers["x-session-id"]);
  });

  test("window closing during ticket acquisition falls back to signed ultra", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(WINDOW_EDGE);
    const cipher = await cipherFixture();
    const wire: WireEntry[] = [];
    let releaseTake: (() => void) | undefined;
    let takeStarted: (() => void) | undefined;
    const takeStartedPromise = new Promise<void>((resolve) => {
      takeStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, async (url) => {
        if (url !== TICKET_BASE) return signingRoutes(cipher)(url);
        takeStarted?.();
        await new Promise<void>((resolve) => {
          releaseTake = resolve;
        });
        return json({ ticket_id: "t-late", state: "ready" });
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);

    const pending = provider.streamSimple(wireModel(OFFPEAK_BASE_URL), transcript, {
      apiKey: KEY,
      headers: auth,
      maxRetries: 0,
    }).result();
    await Promise.race([takeStartedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("take never started")), 2_000))]);
    setOffPeakClockForTests(new Date("2026-09-09T01:00:01Z"));
    releaseTake?.();
    const message = await pending;

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = messageUrl(wire);
    expect(model.pathname).toBe(`${ULTRA_BASE_URL}/v1/messages`);
    expect(model.query).toBe("?beta=true");
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
    expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
  });

  test("full stream keeps an off-peak-routed model on the signed ultra path", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    const wire: WireEntry[] = [];
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, (url) => {
        if (url === TICKET_BASE) return json({ ticket_id: "t-full", state: "ready" });
        return signingRoutes(cipher)(url);
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);

    const message = await provider.stream(wireModel(OFFPEAK_BASE_URL), transcript, {
      apiKey: KEY,
      headers: auth,
      maxRetries: 0,
      thinkingEnabled: false,
    }).result();

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = messageUrl(wire);
    expect(model.pathname).toBe(`${ULTRA_BASE_URL}/v1/messages`);
    expect(model.query).toBe("?beta=true");
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
    expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
  });

  test("transport failure: refreshModels never routes flash off-peak despite a valid window", async () => {
    setOffPeakTransportForTests(false);
    setOffPeakClockForTests(IN_WINDOW);
    const { provider } = captureExtension();
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url === LIVE_MODELS_URL) {
          return json({ data: [{ id: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }, { id: "glm-5.3", display_name: "GLM-5.3" }] });
        }
        if (url === MODELS_DEV_API_URL) return json({});
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    await provider.refreshModels!(refreshHost());

    expect(provider.getModels().map((model) => model.id).sort()).toEqual(["glm-5.3", "glm-5.3-flash"]);
    expect(provider.getModels().find((model) => model.id === "glm-5.3-flash")?.baseUrl).toBe(ULTRA_BASE_URL);
    expect(requests).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
  });

  test("transport ready with availability and ticket: refreshModels routes flash off-peak", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const { provider } = captureExtension();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === LIVE_MODELS_URL) {
          return json({ data: [{ id: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }, { id: "glm-5.3", display_name: "GLM-5.3" }] });
        }
        if (url === MODELS_DEV_API_URL) return json({});
        if (url === `${TICKET_BASE}/availability`) return json({ code: 0, data: { can_take_number: true } });
        if (url === TICKET_BASE) return json({ ticket_id: "t-refresh", state: "ready" });
        throw new Error(`unexpected request: ${url}`);
      }),
    );

    await provider.refreshModels!(refreshHost());

    expect(provider.getModels().find((model) => model.id === "glm-5.3-flash")?.baseUrl).toBe(OFFPEAK_BASE_URL);
    expect(provider.getModels().find((model) => model.id === "glm-5.3")?.baseUrl).toBe(ULTRA_BASE_URL);
  });
});

describe("pending ticket lifecycle (retry and reacquisition)", () => {
  const pathnames = (wire: WireEntry[]) => wire.map((entry) => entry.pathname);

  test("a failed request-time acquisition is retried on the next request", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    let takes = 0;
    const wire: WireEntry[] = [];
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, (url) => {
        if (url === TICKET_BASE) {
          takes += 1;
          return takes === 1 ? json({ code: 3103, msg: "limit" }, 429) : json({ ticket_id: "t-retry", state: "ready" });
        }
        return signingRoutes(cipher)(url);
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);
    await runStream(provider, auth);
    await runStream(provider, auth);

    expect(takes).toBe(2);
    expect(pathnames(wire)).toEqual([`${ULTRA_BASE_URL}/v1/messages`, `${OFFPEAK_BASE_URL}/v1/messages`]);
  });

  test("a refresh warm-up does not bypass ticket expiry (refresh-first flow)", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    let takes = 0;
    const wire: WireEntry[] = [];
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, (url) => {
        if (url === LIVE_MODELS_URL) {
          return json({ data: [{ id: "glm-5.3-flash", display_name: "GLM-5.3-Flash" }, { id: "glm-5.3", display_name: "GLM-5.3" }] });
        }
        if (url === MODELS_DEV_API_URL) return json({});
        if (url === `${TICKET_BASE}/availability`) return json({ code: 0, data: { can_take_number: true } });
        if (url === TICKET_BASE) {
          takes += 1;
          return json({ ticket_id: `t-warm-${takes}`, state: "ready" });
        }
        return signingRoutes(cipher)(url);
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);
    await provider.refreshModels!(refreshHost());
    expect(provider.getModels().find((model) => model.id === "glm-5.3-flash")?.baseUrl).toBe(OFFPEAK_BASE_URL);
    expect(takes).toBe(1);
    await runStream(provider, auth);
    setOffPeakClockForTests(new Date(IN_WINDOW.getTime() + 11 * 60_000));
    await runStream(provider, auth);

    expect(takes).toBe(2);
    expect(pathnames(wire)).toEqual([`${OFFPEAK_BASE_URL}/v1/messages`, `${OFFPEAK_BASE_URL}/v1/messages`]);
    expect(wire[0].headers["x-off-peak-ticket-id"]).toBe("t-warm-1");
    expect(wire[1].headers["x-off-peak-ticket-id"]).toBe("t-warm-2");
  });

  test("a fulfilled pending promise does not outlive the ticket TTL", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    let takes = 0;
    vi.stubGlobal(
      "fetch",
      wireFetch([], (url) => {
        if (url === TICKET_BASE) {
          takes += 1;
          return json({ ticket_id: `t-${takes}`, state: "ready" });
        }
        return signingRoutes(cipher)(url);
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);
    await runStream(provider, auth);
    setOffPeakClockForTests(new Date(IN_WINDOW.getTime() + 11 * 60_000));
    await runStream(provider, auth);

    expect(takes).toBe(2);
  });
});

describe("device identity metadata (PR10)", () => {
  test("before_provider_request injects metadata.user_id with the machine device id", async () => {
    vi.stubEnv("ZCODE_DEVICE_ID", "test-device-1234");
    const { on } = captureExtension();
    expect(on.mock.calls.filter(([name]) => name === "before_provider_request")).toHaveLength(1);
    expect(on.mock.calls.filter(([name]) => name === "before_provider_headers")).toHaveLength(1);
    const hook = registeredHook<RequestHook>(on, "before_provider_request");
    const payload: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    const result = hook({ payload, model: { provider: "glm-zcode" } });
    const meta = JSON.parse((payload.metadata as { user_id: string }).user_id) as {
      device_id: string;
      account_uuid: string;
      session_id: string;
    };
    expect(meta.device_id).toBe("test-device-1234");
    expect(meta.account_uuid).toBe("");
    expect(meta.session_id).toBe(zcodeSessionId());
    expect(result).toBe(payload);
  });

  test("foreign providers and pre-existing metadata are untouched", async () => {
    vi.stubEnv("ZCODE_DEVICE_ID", "test-device-1234");
    const { on } = captureExtension();
    const hook = registeredHook<RequestHook>(on, "before_provider_request");
    const foreign: Record<string, unknown> = { model: "x", messages: [] };
    hook({ payload: foreign, model: { provider: "openai" } });
    expect(foreign.metadata).toBeUndefined();
    const own: Record<string, unknown> = { model: "x", metadata: { user_id: "keep" } };
    hook({ payload: own, model: { provider: "glm-zcode" } });
    expect((own.metadata as { user_id: string }).user_id).toBe("keep");
  });

  test("off-peak routing requires ZCODE_OFFPEAK_ENABLE=1", async () => {
    setOffPeakClockForTests(IN_WINDOW);
    const { provider } = captureExtension();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url === LIVE_MODELS_URL) return json({ data: [{ id: "glm-5.3-flash" }] });
        if (url === MODELS_DEV_API_URL) return json({});
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    await provider.refreshModels!(refreshHost());
    expect(provider.getModels().find((model) => model.id === "glm-5.3-flash")?.baseUrl).toBe(ULTRA_BASE_URL);
  });
});

describe("stale off-peak routing guard", () => {
  test("flag unset: off-peak-routed model falls back to signed ultra at request time", async () => {
    const cipher = await cipherFixture();
    setOffPeakClockForTests(IN_WINDOW);
    const wire: WireEntry[] = [];
    vi.stubGlobal("fetch", wireFetch(wire, signingRoutes(cipher)));
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);

    const message = await runStream(provider, auth);

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = messageUrl(wire);
    expect(model.pathname).toBe(`${ULTRA_BASE_URL}/v1/messages`);
    expect(model.query).toBe("?beta=true");
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
    expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
  });
});

describe("off-peak flag gates cached tickets too", () => {
  test("warm cache is bypassed when ZCODE_OFFPEAK_ENABLE is unset mid-flight", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    let takes = 0;
    const wire: WireEntry[] = [];
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, (url) => {
        if (url === TICKET_BASE) {
          takes += 1;
          return json({ ticket_id: "t-c", state: "ready" });
        }
        return signingRoutes(cipher)(url);
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);
    await runStream(provider, auth);
    expect(wire[0]?.pathname).toBe(`${OFFPEAK_BASE_URL}/v1/messages`);

    vi.unstubAllEnvs();
    await runStream(provider, auth);
    expect(wire[1]?.pathname).toBe(`${ULTRA_BASE_URL}/v1/messages`);
    expect(takes).toBe(1);
  });
});

describe("flag drops mid-acquisition", () => {
  test("deferred ticket settlement after the flag is unset routes to signed ultra", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", "1");
    setOffPeakClockForTests(IN_WINDOW);
    const cipher = await cipherFixture();
    const wire: WireEntry[] = [];
    let releaseTake: (() => void) | undefined;
    let takeStarted: (() => void) | undefined;
    const takeStartedPromise = new Promise<void>((resolve) => {
      takeStarted = resolve;
    });
    vi.stubGlobal(
      "fetch",
      wireFetch(wire, async (url) => {
        if (url !== TICKET_BASE) return signingRoutes(cipher)(url);
        takeStarted?.();
        await new Promise<void>((resolve) => {
          releaseTake = resolve;
        });
        return json({ ticket_id: "t-midflight", state: "ready" });
      }),
    );
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);

    const pending = runStream(provider, auth);
    await Promise.race([takeStartedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error("take never started")), 2_000))]);
    vi.unstubAllEnvs();
    releaseTake?.();
    const message = await pending;

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    const model = messageUrl(wire);
    expect(model.pathname).toBe(`${ULTRA_BASE_URL}/v1/messages`);
    expect(model.query).toBe("?beta=true");
    expect(model.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(model.headers["x-off-peak-ticket-id"]).toBeUndefined();
    expect(model.headers["x-client-sig"]).toMatch(/^\S+$/);
  });
});

describe("non-routed passthrough wire", () => {
  test("plain glm-zcode model hits only the model baseUrl /v1/messages", async () => {
    vi.stubEnv("ZCODE_OFFPEAK_ENABLE", undefined);
    const cipher = await cipherFixture();
    const wire: WireEntry[] = [];
    vi.stubGlobal("fetch", wireFetch(wire, signingRoutes(cipher)));
    const { provider, on } = captureExtension();
    const auth = await signedHeaders(provider, on);

    const message = await provider.streamSimple(wireModel(FAKE_HOST), transcript, {
      apiKey: KEY,
      headers: auth,
      maxRetries: 0,
    }).result();

    expect(message.content).toEqual([{ type: "text", text: "OK" }]);
    expect(wire).toHaveLength(1);
    expect(wire[0].pathname).toBe(`${FAKE_HOST}/v1/messages`);
    expect(wire[0].query).toBe("?beta=true");
    expect(JSON.parse(wire[0].body).model).toBe("glm-5.3-flash");
    expect(wire.some((entry) => /\/off-peak\/ticket|\/agent\/configs|\/api\/paas\//.test(entry.url))).toBe(false);
  });
});
