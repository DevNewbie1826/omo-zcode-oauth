import { hasApi, normalizeContext, type Model, type Provider, type RefreshModelsContext, type ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import glmZcodeExtension, { buildZCodeSourceHeaders } from "../extensions/glm-zcode/index.js";
import {
  MODELS_DEV_API_URL,
  catalogToPersistedModels,
  catalogRowsFromModelsDev,
  fetchModelsDevPayload,
  storedToConfig,
  thinkingConfigFor,
} from "../extensions/glm-zcode/models.js";
import * as provisioning from "../extensions/glm-zcode/oauth.js";
import { refreshGlmZcode } from "../extensions/glm-zcode/oauth.js";
import { resolveZCodeSigningHeaders } from "../extensions/glm-zcode/signing.js";

vi.mock("../extensions/glm-zcode/signing.js", () => ({
  resolveZCodeSigningHeaders: vi.fn(async () => ({ "X-Client-Sig": "sig", "X-App-Id": "zcode" })),
}));

function captureProvider(on = vi.fn()): Provider {
  let registered: Provider | undefined;
  const registerProvider = vi.fn((p: Provider | string) => {
    if (typeof p === "string") throw new Error("Expected native provider registration");
    registered = p;
  });
  glmZcodeExtension({ registerProvider, on, registerCommand: vi.fn() });
  expect(registerProvider.mock.calls).toEqual([[registered]]);
  if (!registered) throw new Error("Provider not registered");
  return registered;
}

function oauthAdapter() {
  const oauth = captureProvider().auth.oauth;
  if (!oauth) throw new Error("OAuth not registered");
  return oauth;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function registeredModel(): Model<"anthropic-messages"> {
  const model = captureProvider().getModels().find(m => m.id === "glm-5.3");
  if (!model || !hasApi(model, "anthropic-messages")) throw new Error("Missing fallback model");
  return model;
}

async function captureAnthropicWireBody(
  model: Model<"anthropic-messages">,
  reasoning?: ThinkingLevel,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin + url.pathname !== "https://zcode.z.ai/api/v1/ultra-zai/anthropic/v1/messages") throw new Error("unexpected transport URL");
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof rawBody !== "string") throw new Error("anthropic request had no JSON body");
      captured = JSON.parse(rawBody) as Record<string, unknown>;
      return json({ type: "error", error: { type: "invalid_request_error", message: "wire capture" } }, 400);
    }),
  );

  await streamSimple(
    model,
    normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 0 }] }),
    { apiKey: "test-key", reasoning, maxRetries: 0 },
  ).result();

  if (!captured) throw new Error("anthropic serializer did not issue a request");
  return captured;
}

const UPSTREAM_TOKEN = "upstream-token";
const BUSINESS_TOKEN = "business-token";
const BROKER_URL = "https://zcode.z.ai/api/v1/oauth/token";
const KEYS_URL = "https://api.z.ai/api/biz/v1/organization/org-id/projects/proj-id/api_keys";

/** Canned responses for every endpoint of the provisioning chain. */
function fetchMock(existingKeyId?: string): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === BROKER_URL) return json({ data: { zai: { access_token: UPSTREAM_TOKEN }, token: "test-jwt" } });
    if (url.endsWith("/auth/z/login")) return json({ data: { access_token: BUSINESS_TOKEN } });
    if (url.endsWith("/getCustomerInfo"))
      return json({
        data: {
          email: "User@Example.com",
          id: 42,
          organizations: [
            {
              organizationId: "org-id",
              isDefault: true,
              projects: [{ projectId: "proj-id", isDefault: true }],
            },
          ],
        },
      });
    if (url.endsWith("/api_keys") && init?.method === "GET") {
      return json({ data: existingKeyId ? [{ apiKey: existingKeyId, name: "zcode-api-key" }] : [] });
    }
    if (url.endsWith("/api_keys") && init?.method === "POST") return json({ data: { apiKey: "key-id" } });
    if (url.endsWith(`/api_keys/copy/${existingKeyId ?? "key-id"}`)) {
      return json({ data: { secretKey: "api-secret" } });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

/** Drives loginGlmZcode with a pasted callback; {state} is replaced by the real state. */
async function loginWithCallback(callback: string): Promise<{ credentials: OAuthCredentials; authUrl: string }> {
  let authUrl = "";
  const credentials = await oauthAdapter().login({
    signal: new AbortController().signal,
    notify: event => { if (event.type === "auth_url") authUrl = event.url; },
    prompt: async prompt => {
      expect(prompt.type).toBe("manual_code");
      return callback.replace("{state}", new URL(authUrl).searchParams.get("state") ?? "");
    },
  });
  return { credentials, authUrl };
}

const validCallback = "zcode://oauth/callback?code=auth-code&state={state}";

const staleCredentials: OAuthCredentials = {
  access: "stale-key.stale-secret",
  refresh: UPSTREAM_TOKEN,
  expires: Date.now() - 1_000,
  email: "user@example.com",
  accountId: "42",
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 23, 12));
  vi.stubEnv("ZCODE_DEVICE_ID", "test-device");
  vi.stubEnv("OFFLINE", undefined);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", undefined);
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected fetch"); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("glm-zcode extension", () => {
  test("registers one native provider with complete chat models and source headers in resolved auth", async () => {
    const p = captureProvider();
    expect(p.id).toBe("glm-zcode");
    expect(p.name).toBe("GLM ZCode");
    expect(p.auth.oauth?.name).toBe("GLM ZCode");
    expect(p.baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    expect(p.getAllModels?.()).toEqual(p.getModels());
    expect(p.stream).toBeTypeOf("function");
    expect(p.streamSimple).toBeTypeOf("function");
    expect(p.getModels().find(m => m.id === "glm-5.3")).toMatchObject({
      api: "anthropic-messages", baseUrl: p.baseUrl, contextWindow: 1_000_000, maxTokens: 131_072,
      thinkingLevelMap: { medium: "low", xhigh: "max" }, compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
    });
    const auth = await p.auth.oauth?.toAuth({ type: "oauth", access: "id.secret", refresh: "r", expires: 1 });
    expect(auth).toEqual({ apiKey: "id.secret", headers: { ...buildZCodeSourceHeaders(), Authorization: "Bearer id.secret" } });
    expect(auth?.headers).toMatchObject({ "X-ZCode-Agent": "glm", "User-Agent": expect.stringMatching(/^ZCode\//) });
    expect(auth?.headers).not.toHaveProperty("X-ZCode-Version");
  });

  test("translates login interaction events, prompt types, and cancellation signals", async () => {
    const signal = new AbortController().signal;
    const local = new AbortController().signal;
    const prompts = vi.fn(async () => "answer");
    const notify = vi.fn();
    vi.spyOn(provisioning, "loginGlmZcode").mockImplementationOnce(async cb => {
      expect(cb.signal).toBe(signal);
      cb.onAuth({ url: "https://example.invalid", instructions: "open" });
      cb.onDeviceCode({ userCode: "fixture", verificationUri: "https://example.invalid" });
      cb.onProgress?.("progress");
      for (const type of [undefined, "secret", "manual_code"] as const) {
        expect(await cb.onPrompt({ type, message: "prompt", signal: local })).toBe("answer");
      }
      expect(await cb.onSelect({ message: "select", options: [], signal: local })).toBe("answer");
      expect(await cb.onManualCodeInput?.()).toBe("answer");
      return { access: "key", refresh: "r", expires: 1, zcodeJwtToken: "jwt" };
    });
    expect(await oauthAdapter().login({ signal, prompt: prompts, notify })).toMatchObject({ type: "oauth", zcodeJwtToken: "jwt" });
    expect(notify.mock.calls).toEqual([
      [{ type: "auth_url", url: "https://example.invalid", instructions: "open" }],
      [{ type: "device_code", userCode: "fixture", verificationUri: "https://example.invalid" }],
      [{ type: "progress", message: "progress" }],
    ]);
    expect(prompts.mock.calls).toEqual([
      ...["text", "secret", "manual_code"].map(type => [{ type, message: "prompt", signal: local }]),
      [{ type: "select", message: "select", options: [], signal: local }],
      [expect.objectContaining({ type: "manual_code" })],
    ]);
  });

  test("wires before_provider_headers to client signing", async () => {
    const on = vi.fn();
    captureProvider(on);
    const handler = on.mock.calls.find(([name]) => name === "before_provider_headers")?.[1];
    const headers = { Authorization: "Bearer id.secret", "X-ZCode-Agent": "glm" };
    await handler({ headers });

    const mocked = vi.mocked(resolveZCodeSigningHeaders);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]?.[0]).toBe(headers);
    expect(headers).toEqual({
      Authorization: "Bearer id.secret",
      "X-ZCode-Agent": "glm",
      "X-Client-Sig": "sig",
      "X-App-Id": "zcode",
    });
  });

  test("honors ZCODE_ANTHROPIC_BASE_URL to revert to the direct endpoint", () => {
    vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", "https://api.z.ai/api/anthropic");
    try {
      expect(registeredModel().baseUrl).toBe("https://api.z.ai/api/anthropic");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test("completes the full OAuth flow: broker exchange, z/login, customer lookup, key create + copy", async () => {
    const fetch = fetchMock();
    vi.stubGlobal("fetch", fetch);
    const startedAt = Date.now();

    const { credentials, authUrl } = await loginWithCallback(validCallback);

    // The authorize URL must carry client_id, redirect_uri, response_type and state.
    const authorize = new URL(authUrl);
    expect(`${authorize.protocol}//${authorize.host}${authorize.pathname}`).toBe(
      "https://chat.z.ai/api/oauth/authorize",
    );
    expect(authorize.searchParams.get("client_id")).toBe("client_P8X5CMWmlaRO9gyO-KSqtg");
    expect(authorize.searchParams.get("redirect_uri")).toBe("zcode://oauth/callback");
    expect(authorize.searchParams.get("response_type")).toBe("code");
    expect(authorize.searchParams.get("state")).toBeTruthy();

    // The full endpoint chain is hit in order; the empty key list triggers a create.
    // The device-flow init attempt comes first and fails against this mock (unknown URL),
    // so login degrades to the classic paste flow.
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      "https://zcode.z.ai/api/v1/oauth/cli/init",
      BROKER_URL,
      "https://api.z.ai/api/auth/z/login",
      "https://api.z.ai/api/biz/customer/getCustomerInfo",
      KEYS_URL, // list (empty)
      KEYS_URL, // create
      `${KEYS_URL}/copy/key-id`,
    ]);

    // Broker exchange carries the pasted code and the state from the authorize URL.
    const brokerBody = JSON.parse(String(fetch.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect(brokerBody).toMatchObject({ provider: "zai", code: "auth-code", redirect_uri: "zcode://oauth/callback" });
    expect(brokerBody.state).toBe(authorize.searchParams.get("state"));

    // z/login exchanges the upstream token for the business token.
    const loginBody = JSON.parse(String(fetch.mock.calls[2][1]?.body)) as Record<string, unknown>;
    expect(loginBody).toEqual({ token: UPSTREAM_TOKEN });

    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual([
      "POST", // cli/init attempt (mock rejects → paste fallback)
      "POST", // broker
      "POST", // z/login
      "GET", // getCustomerInfo
      "GET", // api_keys list
      "POST", // api_keys create
      "GET", // copy
    ]);
    for (const call of fetch.mock.calls.slice(3)) {
      expect(new Headers(call[1]?.headers).get("Authorization")).toBe(`Bearer ${BUSINESS_TOKEN}`);
    }
    const createBody = JSON.parse(String(fetch.mock.calls[5][1]?.body)) as Record<string, unknown>;
    expect(createBody).toEqual({ name: "zcode-api-key", usageScene: 1 });

    // Provisioned credentials.
    expect(credentials).toMatchObject({
      type: "oauth", zcodeJwtToken: "test-jwt",
      access: "key-id.api-secret",
      refresh: UPSTREAM_TOKEN,
      email: "user@example.com",
      accountId: "42",
    });
    // API key TTL is 10 years (long-lived); allow a generous lower bound.
    expect(credentials.expires).toBeGreaterThan(startedAt + 10 * 365 * 24 * 60 * 60 * 1000 - 10_000);
    expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 + 5_000);
  });

  describe("malformed callbacks are rejected after only the device-flow init attempt", () => {
    test("rejects a bare auth code that is not a URL", async () => {
      const fetch = vi.fn((_input: unknown) => Promise.reject(new Error("fetch rejected")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("auth-code")).rejects.toThrow("complete zcode:// callback URL");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain("/api/v1/oauth/cli/init");
    });

    test("rejects a callback with the wrong port", async () => {
      const fetch = vi.fn((_input: unknown) => Promise.reject(new Error("fetch rejected")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("zcode://oauth:431/callback?code=x&state=y")).rejects.toThrow(
        "callback URL is invalid",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain("/api/v1/oauth/cli/init");
    });

    test("rejects a callback missing the state parameter", async () => {
      const fetch = vi.fn((_input: unknown) => Promise.reject(new Error("fetch rejected")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("zcode://oauth/callback?code=x")).rejects.toThrow("exactly one");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain("/api/v1/oauth/cli/init");
    });

    test("rejects a callback whose state does not match", async () => {
      const fetch = vi.fn((_input: unknown) => Promise.reject(new Error("fetch rejected")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("zcode://oauth/callback?code=x&state=wrong")).rejects.toThrow(
        "state did not match",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(fetch.mock.calls[0][0])).toContain("/api/v1/oauth/cli/init");
    });
  });

  describe("refresh", () => {
    test("re-provisions a fresh key with the stored upstream token, without touching the broker", async () => {
      const fetch = fetchMock();
      vi.stubGlobal("fetch", fetch);
      const startedAt = Date.now();

      const refreshed = await oauthAdapter().refresh({ ...staleCredentials, type: "oauth", zcodeJwtToken: "jwt" }, new AbortController().signal);
      expect(refreshed).toMatchObject({ type: "oauth", zcodeJwtToken: "jwt" });

      expect(refreshed).toMatchObject({
        access: "key-id.api-secret",
        refresh: UPSTREAM_TOKEN,
        email: "user@example.com",
        accountId: "42",
      });
      expect(refreshed.expires).toBeGreaterThan(startedAt + 10 * 365 * 24 * 60 * 60 * 1000 - 10_000);
      // Refresh starts directly at z/login; the broker is never involved.
      expect(String(fetch.mock.calls[0][0])).toContain("/auth/z/login");
      expect(fetch.mock.calls.map((call) => String(call[0]))).not.toContain(BROKER_URL);
    });

    test("reuses the named existing key without creating another one", async () => {
      const fetch = fetchMock("existing-id");
      vi.stubGlobal("fetch", fetch);

      const refreshed = await refreshGlmZcode(staleCredentials);

      expect(refreshed.access).toBe("existing-id.api-secret");
      const calls = fetch.mock.calls.map((call) => ({ url: String(call[0]), method: call[1]?.method }));
      expect(calls).not.toContainEqual({ url: KEYS_URL, method: "POST" });
      expect(calls).toContainEqual({ url: `${KEYS_URL}/copy/existing-id`, method: "GET" });
    });

    test("passes host cancellation to refresh provisioning", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be touched")));
      vi.stubGlobal("fetch", fetch);
      const controller = new AbortController();
      controller.abort();

      await expect(oauthAdapter().refresh({ ...staleCredentials, type: "oauth" }, controller.signal)).rejects.toThrow("re-login");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("without a stored upstream token it demands re-login", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be touched")));
      vi.stubGlobal("fetch", fetch);
      const rejection = refreshGlmZcode({ access: "key-id.api-secret", refresh: "", expires: 0 });
      await expect(rejection).rejects.toThrow("re-login");
      await expect(rejection).rejects.toThrow("/login glm-zcode");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("when re-provisioning fails it surfaces re-login guidance", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ error: "provisioning down" }, 500)),
      );
      const rejection = refreshGlmZcode(staleCredentials);
      await expect(rejection).rejects.toThrow("re-login");
      await expect(rejection).rejects.toThrow("/login glm-zcode");
      await expect(rejection).rejects.toThrow("re-provisioning");
      await expect(rejection).rejects.toThrow("z/login request failed: 500");
    });

    test("refresh failure redacts secrets in error detail", async () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error(`fetch failed: connect to https://api.z.ai ${jwt}`);
        }),
      );
      const rejection = refreshGlmZcode(staleCredentials);
      await expect(rejection).rejects.toThrow("network error");
      await expect(rejection).rejects.toThrow("[redacted-jwt]");
      await expect(rejection).rejects.not.toThrow(jwt);
    });

    test("HTTP failure never echoes mixed recognized and unrecognized secrets", async () => {
      const jwt =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const apiKey = "sk-live-secret-abc123";
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => json({ error: "invalid_token", token: jwt, api_key: apiKey }, 401)),
      );

      const rejection = refreshGlmZcode(staleCredentials);
      await expect(rejection).rejects.toThrow("401");
      await expect(rejection).rejects.not.toThrow(jwt);
      await expect(rejection).rejects.not.toThrow(apiKey);
      await expect(rejection).rejects.not.toThrow("invalid_token");
    });

    test("refresh failure redacts 40-plus-character secrets in network errors", async () => {
      const apiKey = "a".repeat(48);
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error(`socket hang up, apiKey=${apiKey}`);
        }),
      );

      const rejection = refreshGlmZcode(staleCredentials);
      await expect(rejection).rejects.toThrow("[redacted]");
      await expect(rejection).rejects.not.toThrow(apiKey);
    });
  });

  test("error messages never echo response bodies containing secrets", async () => {
    const secret = "sk-live-secret-abc123";
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === BROKER_URL) return json({ error: "invalid_grant", secret }, 400);
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    const rejection = loginWithCallback(validCallback);
    await expect(rejection).rejects.toThrow(/400/);
    await expect(rejection).rejects.not.toThrow(secret);
  });

  test("security: a broker URL smuggled in via env is ignored, endpoints are hardcoded", async () => {
    const fetch = fetchMock();
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("ZCODE_OAUTH_BROKER_TOKEN_URL", "https://attacker.invalid/token");

    const { credentials } = await loginWithCallback(validCallback);

    expect(credentials.access).toBe("key-id.api-secret");
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls.some((url) => url.includes("attacker.invalid"))).toBe(false);
    // The real hardcoded broker was used instead.
    expect(urls).toContain(BROKER_URL);
  });
});

describe("glm-zcode anthropic wire payloads", () => {
  test("medium uses adaptive thinking with the mapped low effort", async () => {
    const body = await captureAnthropicWireBody(registeredModel(), "medium");

    expect(body.thinking).toMatchObject({ type: "adaptive" });
    expect(body.output_config).toEqual({ effort: "low" });
    console.log(`glm-zcode medium wire body: ${JSON.stringify(body)}`);
  });

  test("off omits thinking and keeps the cheapest valid adaptive effort", async () => {
    const body = await captureAnthropicWireBody(registeredModel());

    expect(body).not.toHaveProperty("thinking");
    expect(body.output_config).toEqual({ effort: "low" });
    console.log(`glm-zcode off wire body: ${JSON.stringify(body)}`);
  });

  test("toggle-model off does not force adaptive effort", async () => {
    const toggleThinkingConfig = thinkingConfigFor([{ type: "toggle" }]);
    const toggleModel: Model<"anthropic-messages"> = {
      ...registeredModel(),
      id: "glm-toggle",
      thinkingLevelMap: toggleThinkingConfig.thinkingLevelMap,
      compat: toggleThinkingConfig.compat,
    };
    const body = await captureAnthropicWireBody(toggleModel);

    expect(body).not.toHaveProperty("output_config");
    expect(body.thinking).toEqual({ type: "disabled" });
    console.log(`glm-zcode toggle off wire body: ${JSON.stringify(body)}`);
  });
});

function publisher() {
  return vi.fn<RefreshModelsContext["publish"]>(async publication => { publication.update?.(); return true; });
}

async function visibleAfterRefresh(ctx: RefreshModelsContext, provider = captureProvider()) {
  if (!provider.refreshModels) throw new Error("Catalog not registered");
  await expect(provider.refreshModels(ctx)).resolves.toBeUndefined();
  return provider.getModels();
}

const fallbackIds = ["glm-5.3", "glm-5.4"];

describe("dynamic model catalog", () => {
  const catalogPayload = {
    "zai-coding-plan": {
      models: {
        "glm-text": {
          name: "GLM Text",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high", "max"] }],
          limit: { context: 1_000_000, output: 131_072 },
          modalities: { input: ["text"] },
        },
        "glm-multimodal": {
          name: "GLM Multimodal",
          reasoning: false,
          reasoning_options: [{ type: "toggle" }],
          limit: { context: 250_000, output: 32_768 },
          modalities: { input: ["text", "image", "video", "pdf"] },
        },
        "glm-broken": {
          name: "GLM Broken",
          reasoning: true,
          limit: { output: 4_096 },
          modalities: { input: ["text"] },
        },
        "glm-noname": {
          reasoning: true,
          limit: { context: 500_000, output: 8_192 },
          modalities: { input: ["text"] },
        },
        "glm-notarecord": "not-an-object",
      },
    },
  };

  const expectedThinkingLevelMap = {
    minimal: "low",
    low: "low",
    medium: "low",
    high: "high",
    xhigh: "max",
    max: "max",
  };

  const persistedModel = {
    provider: "glm-zcode",
    api: "anthropic-messages" as const,
    baseUrl: "https://api.z.ai/api/anthropic",
    id: "glm-9",
    name: "GLM 9",
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 500_000,
    maxTokens: 8_192,
  };

  function context(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
    return {
      allowNetwork: true,
      stored: undefined,
      signal: new AbortController().signal,
      publish: publisher(),
      ...overrides,
    };
  }


  test("maps valid catalog models and skips malformed entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(catalogPayload)));

    const models = catalogRowsFromModelsDev(await fetchModelsDevPayload());

    expect(models).toEqual([
      {
        id: "glm-text",
        name: "GLM Text",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_000_000,
        maxTokens: 131_072,
        thinkingLevelMap: expectedThinkingLevelMap,
        compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
      },
      {
        id: "glm-multimodal",
        name: "GLM Multimodal",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 250_000,
        maxTokens: 32_768,
        thinkingLevelMap: expectedThinkingLevelMap,
      },
      {
        id: "glm-noname",
        name: "glm-noname",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 500_000,
        maxTokens: 8_192,
        thinkingLevelMap: expectedThinkingLevelMap,
        compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
      },
    ]);
    expect(models).toHaveLength(3);
    expect(models.find((model) => model.id === "glm-noname")?.name).toBe("glm-noname");
    expect(models.some((model) => model.id === "glm-broken")).toBe(false);
    expect(models.some((model) => model.id === "glm-notarecord")).toBe(false);
  });

  test("persists and restores thinking configuration", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(catalogPayload)));
    const models = catalogRowsFromModelsDev(await fetchModelsDevPayload());

    const persisted = catalogToPersistedModels(models);

    expect(persisted.find((model) => model.id === "glm-text")).toMatchObject({
      thinkingLevelMap: expectedThinkingLevelMap,
      compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
    });
    expect(persisted.find((model) => model.id === "glm-multimodal")).toMatchObject({
      thinkingLevelMap: expectedThinkingLevelMap,
    });
    expect(persisted.find((model) => model.id === "glm-multimodal")).not.toHaveProperty("compat");
    expect(persisted.find((model) => model.id === "glm-noname")).toMatchObject({
      thinkingLevelMap: expectedThinkingLevelMap,
      compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
    });
    expect(storedToConfig({ models: persisted })).toEqual(models);
  });

  test("applies conservative thinking defaults to legacy stored models", () => {
    expect(storedToConfig({ models: [persistedModel] })[0]).toMatchObject({
      thinkingLevelMap: expectedThinkingLevelMap,
      compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
    });
  });

  test("refreshModels publishes valid models to the registered getters", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    const publish = publisher();
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(context({ publish }));

    expect(models).toHaveLength(3);
    expect(models.map((model) => model.id)).toEqual(["glm-text", "glm-multimodal", "glm-noname"]);
    expect(publish).toHaveBeenCalledOnce();
    const publication = publish.mock.calls[0]?.[0];
    const persisted = publication?.persist?.models;
    expect(persisted).toBeInstanceOf(Array);
    expect(persisted).toHaveLength(3);
    expect([...(persisted ?? [])].map((model) => model.id).sort()).toEqual([
      "glm-multimodal",
      "glm-noname",
      "glm-text",
    ]);
    expect(
      persisted?.every(
        (model) =>
          model.provider === "glm-zcode" &&
          model.api === "anthropic-messages" &&
          model.baseUrl === "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
      ),
    ).toBe(true);
    expect(publication?.persist?.checkedAt).toEqual(expect.any(Number));
  });

  test("offline without stored models keeps both emergency models without fetching", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(context({ allowNetwork: false, stored: undefined }));

    expect(models.map(m => m.id).sort()).toEqual(fallbackIds);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("offline with stored models restores them without fetching", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(
      context({ allowNetwork: false, stored: { models: [persistedModel], checkedAt: 123 } }),
    );

    expect(models).toMatchObject([
      {
        id: "glm-9",
        name: "GLM 9",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 500_000,
        maxTokens: 8_192,
        baseUrl: "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
        thinkingLevelMap: expectedThinkingLevelMap,
        compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("fetch failure retains the fallback without throwing when no store exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("catalog unavailable"))));

    expect((await visibleAfterRefresh(context())).map(m => m.id).sort()).toEqual(fallbackIds);
  });

  test("malformed api.json without zai-coding-plan retains the fallback", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ anotherProvider: { models: {} } })));

    expect((await visibleAfterRefresh(context())).map(m => m.id).sort()).toEqual(fallbackIds);
  });

  test("fresh stored models skip the catalog fetch", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(
      context({ stored: { models: [persistedModel], checkedAt: Date.now() } }),
    );

    expect(models?.map((model) => model.id)).toEqual(["glm-9"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("expired stored models trigger a catalog re-fetch", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(
      context({ stored: { models: [persistedModel], checkedAt: Date.now() - 25 * 60 * 60 * 1_000 } }),
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(models?.map((model) => model.id)).toEqual(["glm-text", "glm-multimodal", "glm-noname"]);
  });

  test("force bypasses the stored-model TTL", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(
      context({ force: true, stored: { models: [persistedModel], checkedAt: Date.now() } }),
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(models?.map((model) => model.id)).toEqual(["glm-text", "glm-multimodal", "glm-noname"]);
  });

  test.each([true, false])("publish rejection with store=%s retains the last visible list", async hasStore => {
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      if (String(url) !== MODELS_DEV_API_URL) throw new Error("Unexpected URL");
      return json(catalogPayload);
    }));
    const p = captureProvider();
    const ctx = context({ stored: hasStore ? { models: [persistedModel] } : undefined,
      publish: async publication => {
        if (publication.persist) throw new Error("disk full");
        publication.update?.();
        return true;
      },
    });
    await expect(p.refreshModels?.(ctx)).rejects.toThrow("disk full");
    expect(p.getModels().map(m => m.id).sort()).toEqual(hasStore ? ["glm-9"] : fallbackIds);
  });
});

describe("hybrid live model catalog", () => {
  const LIVE_MODELS_URL = "https://api.z.ai/api/anthropic/v1/models";

  const liveEnvelope = {
    data: [
      { id: "glm-live-a", display_name: "GLM Live A" },
      { id: "glm-live-b" },
    ],
  };

  const modelsDevPayload = {
    "zai-coding-plan": {
      models: {
        "glm-dev": {
          name: "GLM Dev",
          reasoning: true,
          limit: { context: 200_000, output: 8_192 },
          modalities: { input: ["text"] },
        },
      },
    },
  };

  const storedModel = {
    provider: "glm-zcode",
    api: "anthropic-messages" as const,
    baseUrl: "https://api.z.ai/api/anthropic",
    id: "glm-stored",
    name: "GLM Stored",
    reasoning: true,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
  };

  function hybridContext(overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext {
    return {
      allowNetwork: true,
      stored: undefined,
      signal: new AbortController().signal,
      publish: publisher(),
      credential: { type: "oauth", access: "key-id.secret", refresh: "refresh-token", expires: 1 },
      ...overrides,
    };
  }


  /** Serves the live catalog from `live` and the models.dev catalog from `modelsDevPayload`. */
  function bothCatalogsFetch(live: () => Promise<Response>) {
    return vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === LIVE_MODELS_URL) return live();
      if (url === MODELS_DEV_API_URL) return json(modelsDevPayload);
      throw new Error(`unexpected request: ${url}`);
    });
  }

  test("Given a credential and network access, when refreshing, then the live catalog is served with Bearer auth and ZCode source headers without adding models.dev fallback members", async () => {
    const fetch = bothCatalogsFetch(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);
    const publish = publisher();

    const models = await visibleAfterRefresh(hybridContext({ publish }));

    expect(models?.map((model) => model.id)).toEqual(["glm-live-a", "glm-live-b"]);
    expect(models?.[0]).toMatchObject({
      name: "GLM Live A",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_000_000,
      maxTokens: 131_072,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]?.[0])).toBe(LIVE_MODELS_URL);
    const headers = fetch.mock.calls[0]?.[1]?.headers;
    expect(new Headers(headers).get("Authorization")).toBe("Bearer key-id.secret");
    expect(new Headers(headers).get("Accept")).toBe("application/json");
    expect(Object.keys(headers ?? {}).some((key) => key.startsWith("X-ZCode-"))).toBe(true);
    expect(fetch.mock.calls.map((call) => String(call[0]))).toContain(MODELS_DEV_API_URL);

    expect(publish).toHaveBeenCalledOnce();
    const publication = publish.mock.calls[0]?.[0];
    const persisted = publication?.persist?.models;
    expect([...(persisted ?? [])].map((model) => model.id)).toEqual(["glm-live-a", "glm-live-b"]);
    expect(
      persisted?.every(
        (model) =>
          model.provider === "glm-zcode" &&
          model.api === "anthropic-messages" &&
          model.baseUrl === "https://zcode.z.ai/api/v1/ultra-zai/anthropic",
      ),
    ).toBe(true);
    expect(publication?.persist?.checkedAt).toEqual(expect.any(Number));
  });

  test("Given the live endpoint rejects, when refreshing, then it falls back to the models.dev catalog", async () => {
    const fetch = bothCatalogsFetch(async () => Promise.reject(new Error("live down")));
    vi.stubGlobal("fetch", fetch);
    const publish = publisher();

    const models = await visibleAfterRefresh(hybridContext({ publish }));

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(models?.map((model) => model.id)).toEqual(["glm-dev"]);
    const persisted = publish.mock.calls[0]?.[0]?.persist?.models;
    expect([...(persisted ?? [])].map((model) => model.id)).toEqual(["glm-dev"]);
  });

  test("Given the live endpoint answers non-2xx, when refreshing, then it falls back to the models.dev catalog", async () => {
    const fetch = bothCatalogsFetch(async () => json({ error: "upstream down" }, 503));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(hybridContext());

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(models?.map((model) => model.id)).toEqual(["glm-dev"]);
  });

  test("Given both catalogs fail with a stored snapshot, when refreshing, then stored models are restored without publishing new models", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("catalog unavailable")));
    vi.stubGlobal("fetch", fetch);
    const publish = publisher();
    const stored = { models: [storedModel], checkedAt: 123 };

    const models = await visibleAfterRefresh(hybridContext({ publish, stored }));

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(models.map(m => m.id)).toEqual(["glm-stored"]);
    expect(publish.mock.calls).toEqual([[{ update: expect.any(Function) }]]);
  });

  test("Given both catalogs fail without a stored snapshot, when refreshing, then no catalog is returned and the registered static list is retained", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Promise.reject(new Error("catalog unavailable")));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(hybridContext({ stored: undefined }));

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(models.map(m => m.id).sort()).toEqual(fallbackIds);
  });

  test("Given the live catalog has zero usable models, when refreshing, then it falls back to the models.dev catalog", async () => {
    const fetch = bothCatalogsFetch(async () => json({ data: ["junk", { id: "   " }, { display_name: "no id" }] }));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(hybridContext());

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(models?.map((model) => model.id)).toEqual(["glm-dev"]);
  });

  test("Given an oversize live response, when refreshing, then it falls back to the models.dev catalog", async () => {
    const fetch = bothCatalogsFetch(async () => json({ data: [{ id: "y".repeat(1_100_000) }] }));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(hybridContext());

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
    expect(models?.map((model) => model.id)).toEqual(["glm-dev"]);
  });

  test("Given no credential, when refreshing, then the live endpoint is not called and models.dev serves the catalog", async () => {
    const fetch = bothCatalogsFetch(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(hybridContext({ credential: undefined }));

    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([MODELS_DEV_API_URL]);
    expect(models?.map((model) => model.id)).toEqual(["glm-dev"]);
  });

  test("Given the network is disabled, when refreshing, then neither catalog is fetched and stored models are served", async () => {
    const fetch = vi.fn(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(
      hybridContext({ allowNetwork: false, stored: { models: [storedModel], checkedAt: 123 } }),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(models?.map((model) => model.id)).toEqual(["glm-stored"]);
  });

  test("Given the network is disabled without stored models, when refreshing, then it keeps both emergency models without fetching", async () => {
    const fetch = vi.fn(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(hybridContext({ allowNetwork: false }));

    expect(models.map(m => m.id).sort()).toEqual(fallbackIds);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("Given an already-aborted signal, when refreshing with a credential, then neither catalog is fetched and stored models are served", async () => {
    const fetch = vi.fn(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();

    const p = captureProvider();
    await visibleAfterRefresh(hybridContext({ allowNetwork: false, stored: { models: [storedModel] } }), p);
    const models = await visibleAfterRefresh(
      hybridContext({ signal: controller.signal, stored: { models: [{ ...storedModel, id: "not-published" }] } }),
      p,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(models?.map((model) => model.id)).toEqual(["glm-stored"]);
  });

  test("Given an api_key credential, when refreshing, then the live request authorizes with its key", async () => {
    const fetch = bothCatalogsFetch(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);

    await visibleAfterRefresh(hybridContext({ credential: { type: "api_key", key: "sk-zcode-key" } }));

    expect(String(fetch.mock.calls[0]?.[0])).toBe(LIVE_MODELS_URL);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer sk-zcode-key");
  });

  test("Given an api_key credential with a missing or empty key, when refreshing, then it is treated as no credential and models.dev serves the catalog", async () => {
    for (const credential of [{ type: "api_key" as const }, { type: "api_key" as const, key: "" }]) {
      const fetch = bothCatalogsFetch(async () => json(liveEnvelope));
      vi.stubGlobal("fetch", fetch);

      const models = await visibleAfterRefresh(hybridContext({ credential }));

      expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([MODELS_DEV_API_URL]);
      expect(models?.map((model) => model.id)).toEqual(["glm-dev"]);
    }
  });

  test("Given force is set with a fresh stored snapshot, when refreshing, then the live catalog bypasses the TTL", async () => {
    const fetch = bothCatalogsFetch(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);

    const models = await visibleAfterRefresh(
      hybridContext({ force: true, stored: { models: [storedModel], checkedAt: Date.now() } }),
    );

    expect(String(fetch.mock.calls[0]?.[0])).toBe(LIVE_MODELS_URL);
    expect(models?.map((model) => model.id)).toEqual(["glm-live-a", "glm-live-b"]);
  });

  test("Given a fresh stored snapshot without force, when refreshing with a credential, then neither catalog is fetched and stored models are served", async () => {
    const fetch = bothCatalogsFetch(async () => json(liveEnvelope));
    vi.stubGlobal("fetch", fetch);
    const publish = publisher();

    const models = await visibleAfterRefresh(
      hybridContext({ stored: { models: [storedModel], checkedAt: Date.now() }, publish }),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(publish.mock.calls).toEqual([[{ update: expect.any(Function) }]]);
    expect(models?.map((model) => model.id)).toEqual(["glm-stored"]);
  });
});
