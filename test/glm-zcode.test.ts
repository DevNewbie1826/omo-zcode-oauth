import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";
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
      id: "glm-5.2",
      contextWindow: 1_000_000,
      maxTokens: 131_072,
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
    // Re-provision interval is 55 minutes; allow a generous lower bound.
    expect(credentials.expires).toBeGreaterThan(startedAt + 50 * 60 * 1000);
    expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 55 * 60 * 1000 + 5_000);
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
      expect(refreshed.expires).toBeGreaterThan(startedAt + 50 * 60 * 1000);
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
