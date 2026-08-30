import type { ProviderConfig } from "@code-yeongyu/senpi";
import type { Model, RefreshModelsContext, ThinkingLevel } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";
import {
  catalogToPersistedModels,
  fetchCatalogModels,
  storedToConfig,
  thinkingConfigFor,
} from "../extensions/glm-zcode/models.js";
import { loginGlmZcode, refreshGlmZcode } from "../extensions/glm-zcode/oauth.js";

type RegisteredProvider = {
  name: string;
  config: {
    name: string;
    baseUrl: string;
    api: string;
    authHeader: boolean;
    headers: Record<string, string>;
    models: Array<Record<string, unknown>>;
    refreshModels?: NonNullable<ProviderConfig["refreshModels"]>;
    oauth?: {
      name: string;
      login: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
      refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) => Promise<OAuthCredentials>;
      getApiKey: (credentials: OAuthCredentials) => string;
    };
  };
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Proxy-based ExtensionAPI mock (as in PR #295): captures the registerProvider
 * call and swallows every other API method.
 */
function captureProvider(): RegisteredProvider {
  let captured: RegisteredProvider | undefined;
  const pi = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === "registerProvider") {
          return (name: string, config: RegisteredProvider["config"]) => {
            captured = { name, config };
          };
        }
        return () => undefined;
      },
    },
  );
  glmZcodeExtension(pi as Parameters<typeof glmZcodeExtension>[0]);
  if (!captured) throw new Error("glm-zcode extension did not register a provider");
  return captured;
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function registeredModel(): Model<"anthropic-messages"> {
  const { config } = captureProvider();
  return {
    provider: "glm-zcode",
    api: "anthropic-messages",
    baseUrl: config.baseUrl,
    headers: config.headers,
    ...config.models[0],
  } as unknown as Model<"anthropic-messages">;
}

async function captureAnthropicWireBody(
  model: Model<"anthropic-messages">,
  reasoning?: ThinkingLevel,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> | undefined;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      if (typeof rawBody !== "string") throw new Error("anthropic request had no JSON body");
      captured = JSON.parse(rawBody) as Record<string, unknown>;
      return json({ type: "error", error: { type: "invalid_request_error", message: "wire capture" } }, 400);
    }),
  );

  await streamSimple(
    model,
    { messages: [{ role: "user", content: "hello", timestamp: 0 }] },
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
    if (url === BROKER_URL) return json({ data: { zai: { access_token: UPSTREAM_TOKEN } } });
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
  const credentials = await loginGlmZcode({
    onAuth: ({ url }) => {
      authUrl = url;
    },
    onPrompt: async () => "",
    onManualCodeInput: async () => callback.replace("{state}", new URL(authUrl).searchParams.get("state") ?? ""),
    onDeviceCode: () => undefined,
    onSelect: async () => undefined,
    signal: undefined,
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("glm-zcode extension", () => {
  test("registers the glm-zcode provider with the Z.AI anthropic-compatible config", () => {
    const { name, config } = captureProvider();

    expect(name).toBe("glm-zcode");
    expect(config.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(config.api).toBe("anthropic-messages");
    expect(config.authHeader).toBe(true);
    expect(config.headers).toMatchObject({
      "User-Agent": "ZCode/3.1.2",
      "X-ZCode-Agent": "glm",
      "X-ZCode-Version": "3.1.2",
    });

    expect(config.models[0]).toMatchObject({
      id: "glm-5.3",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      thinkingLevelMap: { medium: "low", xhigh: "max" },
      compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
    });

    expect(config.oauth).toBeDefined();
    expect(typeof config.oauth!.login).toBe("function");
    expect(typeof config.oauth!.refreshToken).toBe("function");
    expect(typeof config.oauth!.getApiKey).toBe("function");
    // The factory must wire up the exact oauth functions from oauth.js.
    expect(config.oauth!.login).toBe(loginGlmZcode);
    expect(config.oauth!.refreshToken).toBe(refreshGlmZcode);
    expect(config.oauth!.getApiKey({ access: "key-id.api-secret", refresh: "refresh", expires: 1 })).toBe(
      "key-id.api-secret",
    );
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
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      BROKER_URL,
      "https://api.z.ai/api/auth/z/login",
      "https://api.z.ai/api/biz/customer/getCustomerInfo",
      KEYS_URL, // list (empty)
      KEYS_URL, // create
      `${KEYS_URL}/copy/key-id`,
    ]);

    // Broker exchange carries the pasted code and the state from the authorize URL.
    const brokerBody = JSON.parse(String(fetch.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(brokerBody).toMatchObject({ provider: "zai", code: "auth-code", redirect_uri: "zcode://oauth/callback" });
    expect(brokerBody.state).toBe(authorize.searchParams.get("state"));

    // z/login exchanges the upstream token for the business token.
    const loginBody = JSON.parse(String(fetch.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect(loginBody).toEqual({ token: UPSTREAM_TOKEN });

    expect(fetch.mock.calls.map((call) => call[1]?.method)).toEqual(["POST", "POST", "GET", "GET", "POST", "GET"]);
    for (const call of fetch.mock.calls.slice(2)) {
      expect(new Headers(call[1]?.headers).get("Authorization")).toBe(`Bearer ${BUSINESS_TOKEN}`);
    }
    const createBody = JSON.parse(String(fetch.mock.calls[4][1]?.body)) as Record<string, unknown>;
    expect(createBody).toEqual({ name: "zcode-api-key" });

    // Provisioned credentials.
    expect(credentials).toMatchObject({
      access: "key-id.api-secret",
      refresh: UPSTREAM_TOKEN,
      email: "user@example.com",
      accountId: "42",
    });
    // API key TTL is 10 years (long-lived); allow a generous lower bound.
    expect(credentials.expires).toBeGreaterThan(startedAt + 10 * 365 * 24 * 60 * 60 * 1000 - 10_000);
    expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000 + 5_000);
  });

  describe("malformed callbacks are rejected before any request", () => {
    test("rejects a bare auth code that is not a URL", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be touched")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("auth-code")).rejects.toThrow("complete zcode:// callback URL");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("rejects a callback with the wrong port", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be touched")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("zcode://oauth:431/callback?code=x&state=y")).rejects.toThrow(
        "callback URL is invalid",
      );
      expect(fetch).not.toHaveBeenCalled();
    });

    test("rejects a callback missing the state parameter", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be touched")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("zcode://oauth/callback?code=x")).rejects.toThrow("exactly one");
      expect(fetch).not.toHaveBeenCalled();
    });

    test("rejects a callback whose state does not match", async () => {
      const fetch = vi.fn(() => Promise.reject(new Error("network must not be touched")));
      vi.stubGlobal("fetch", fetch);
      await expect(loginWithCallback("zcode://oauth/callback?code=x&state=wrong")).rejects.toThrow(
        "state did not match",
      );
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  describe("refresh", () => {
    test("re-provisions a fresh key with the stored upstream token, without touching the broker", async () => {
      const fetch = fetchMock();
      vi.stubGlobal("fetch", fetch);
      const startedAt = Date.now();

      const refreshed = await refreshGlmZcode(staleCredentials);

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

      await expect(refreshGlmZcode(staleCredentials, controller.signal)).rejects.toThrow("re-login");
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
      await expect(rejection).rejects.toThrow(/\(.+\)/);
    });

    test("refresh failure redacts secrets in error detail", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () =>
          json(
            {
              error: "invalid_token",
              token:
                "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
            },
            401,
          ),
        ),
      );
      const rejection = refreshGlmZcode(staleCredentials);
      await expect(rejection).rejects.toThrow("[redacted-jwt]");
      await expect(rejection).rejects.not.toThrow("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
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
      compat: toggleThinkingConfig.compat as Model<"anthropic-messages">["compat"],
    };
    const body = await captureAnthropicWireBody(toggleModel);

    expect(body).not.toHaveProperty("output_config");
    expect(body.thinking).toEqual({ type: "disabled" });
    console.log(`glm-zcode toggle off wire body: ${JSON.stringify(body)}`);
  });
});

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
      publish: vi.fn(async () => true),
      ...overrides,
    };
  }

  function registeredRefreshModels(): NonNullable<ProviderConfig["refreshModels"]> {
    const refreshModels = captureProvider().config.refreshModels;
    if (!refreshModels) throw new Error("glm-zcode provider did not register refreshModels");
    return refreshModels;
  }

  test("maps valid catalog models and skips malformed entries", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(catalogPayload)));

    const models = await fetchCatalogModels();

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
        input: ["text", "image", "video"],
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
    const models = await fetchCatalogModels();

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

  test("refreshModels fetches, publishes, and returns valid models", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    const publish = vi.fn<RefreshModelsContext["publish"]>(async () => true);
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(context({ publish }));

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
          model.baseUrl === "https://api.z.ai/api/anthropic",
      ),
    ).toBe(true);
    expect(publication?.persist?.checkedAt).toEqual(expect.any(Number));
  });

  test("offline without stored models returns undefined without fetching", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(context({ allowNetwork: false, stored: undefined }));

    expect(models).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  test("offline with stored models restores them without fetching", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(
      context({ allowNetwork: false, stored: { models: [persistedModel], checkedAt: 123 } }),
    );

    expect(models).toEqual([
      {
        id: "glm-9",
        name: "GLM 9",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 500_000,
        maxTokens: 8_192,
        thinkingLevelMap: expectedThinkingLevelMap,
        compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
      },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("fetch failure returns undefined without throwing when no store exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("catalog unavailable"))));

    await expect(registeredRefreshModels()(context())).resolves.toBeUndefined();
  });

  test("malformed api.json without zai-coding-plan returns undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ anotherProvider: { models: {} } })));

    await expect(registeredRefreshModels()(context())).resolves.toBeUndefined();
  });

  test("fresh stored models skip the catalog fetch", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(
      context({ stored: { models: [persistedModel], checkedAt: Date.now() } }),
    );

    expect(models?.map((model) => model.id)).toEqual(["glm-9"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  test("expired stored models trigger a catalog re-fetch", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(
      context({ stored: { models: [persistedModel], checkedAt: Date.now() - 25 * 60 * 60 * 1_000 } }),
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(models?.map((model) => model.id)).toEqual(["glm-text", "glm-multimodal", "glm-noname"]);
  });

  test("force bypasses the stored-model TTL", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(
      context({ force: true, stored: { models: [persistedModel], checkedAt: Date.now() } }),
    );

    expect(fetch).toHaveBeenCalledOnce();
    expect(models?.map((model) => model.id)).toEqual(["glm-text", "glm-multimodal", "glm-noname"]);
  });

  test("publish failure keeps existing models without throwing", async () => {
    // pins current behavior — publish rejection discards the fresh list in favor of the stored snapshot; changing to return-fresh-on-publish-failure requires a production change (tracked in PR description).
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    const models = await registeredRefreshModels()(
      context({
        publish: vi.fn(async () => {
          throw new Error("disk full");
        }),
        stored: {
          models: [
            {
              provider: "glm-zcode",
              api: "anthropic-messages",
              baseUrl: "https://api.z.ai/api/anthropic",
              id: "glm-stored",
              name: "GLM Stored",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1_000_000,
              maxTokens: 131_072,
            },
          ],
        },
      }),
    );

    expect(models).toHaveLength(1);
    expect(models?.[0]?.id).toBe("glm-stored");
    expect(fetch).toHaveBeenCalledOnce();
  });

  test("publish failure without stored models returns undefined without throwing", async () => {
    const fetch = vi.fn(async () => json(catalogPayload));
    vi.stubGlobal("fetch", fetch);

    await expect(
      registeredRefreshModels()(
        context({
          publish: vi.fn(async () => {
            throw new Error("disk full");
          }),
          stored: undefined,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledOnce();
  });
});
