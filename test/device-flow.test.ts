import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import { loginGlmZcode } from "../extensions/glm-zcode/oauth.js";

// ---------------------------------------------------------------------------
// Constants and helpers (mirroring the conventions of test/glm-zcode.test.ts)
// ---------------------------------------------------------------------------

const UPSTREAM_TOKEN = "upstream-token";
const BUSINESS_TOKEN = "business-token";
const BROKER_URL = "https://zcode.z.ai/api/v1/oauth/token";
const CLI_INIT_URL = "https://zcode.z.ai/api/v1/oauth/cli/init";
const CLI_POLL_URL = "https://zcode.z.ai/api/v1/oauth/cli/poll";
const POLL_PATH = `/api/v1/oauth/cli/poll/${"a".repeat(32)}`;
const KEYS_URL = "https://api.z.ai/api/biz/v1/organization/org-id/projects/proj-id/api_keys";
const FLOW_ID = "a".repeat(32);
const POLL_TOKEN = "b".repeat(64);
const AUTH_URL =
  "https://chat.z.ai/api/oauth/authorize?client_id=client_P8X5CMWmlaRO9gyO-KSqtg" +
  `&redirect_uri=${encodeURIComponent("https://zcode.z.ai/api/v1/oauth/cli/callback/zai")}` +
  "&state=broker-state&response_type=code";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function initPayload(dataOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    code: 0,
    msg: "",
    data: {
      flow_id: FLOW_ID,
      poll_token: POLL_TOKEN,
      authorize_url: AUTH_URL,
      expires_at: Math.floor(Date.now() / 1000) + 120,
      poll_interval_sec: 2,
      ...dataOverrides,
    },
  };
}

/** Provisioning chain endpoints (z/login -> getCustomerInfo -> api_keys list/create -> copy). */
function provisionRoutes(url: string, init?: RequestInit): Response | undefined {
  if (url.endsWith("/auth/z/login")) return json({ data: { access_token: BUSINESS_TOKEN } });
  if (url.endsWith("/getCustomerInfo")) {
    return json({
      data: {
        email: "User@Example.com",
        id: 42,
        organizations: [
          { organizationId: "org-id", isDefault: true, projects: [{ projectId: "proj-id", isDefault: true }] },
        ],
      },
    });
  }
  if (url.endsWith("/api_keys") && init?.method === "GET") return json({ data: [] });
  if (url.endsWith("/api_keys") && init?.method === "POST") return json({ data: { apiKey: "key-id" } });
  if (url.endsWith("/api_keys/copy/key-id")) return json({ data: { secretKey: "api-secret" } });
  return undefined;
}

type FetchMock = ReturnType<typeof vi.fn>;
type FetchCall = [input: string | URL | Request, init?: RequestInit];

/** fetch mock whose router answers known URLs and throws on unknown ones (init failure). */
function router(routes: (url: string, init?: RequestInit) => Response | undefined): FetchMock {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const response = routes(url, init);
    if (!response) throw new Error(`unexpected request: ${url}`);
    return response;
  });
}

function brokerRoutes(url: string): Response | undefined {
  if (url === BROKER_URL) return json({ data: { zai: { access_token: UPSTREAM_TOKEN } } });
  return undefined;
}

type Callbacks = {
  onAuth: ReturnType<typeof vi.fn>;
  onDeviceCode: ReturnType<typeof vi.fn>;
  onPrompt: ReturnType<typeof vi.fn>;
  onManualCodeInput: ReturnType<typeof vi.fn>;
  onSelect: ReturnType<typeof vi.fn>;
  onProgress: ReturnType<typeof vi.fn>;
  signal: AbortSignal | undefined;
};

function callbacks(overrides: Partial<Callbacks> = {}): Callbacks {
  return {
    onAuth: vi.fn(),
    onDeviceCode: vi.fn(),
    onPrompt: vi.fn(async () => ""),
    onManualCodeInput: vi.fn(async () => ""),
    onSelect: vi.fn(async () => undefined),
    onProgress: vi.fn(),
    signal: undefined,
    ...overrides,
  };
}

/** Makes the paste prompt return a valid zcode:// callback carrying the real authorize state. */
function withPaste(cb: Callbacks): Callbacks {
  cb.onManualCodeInput.mockImplementation(async () => {
    const url = new URL(authUrlOf(cb));
    return `zcode://oauth/callback?code=auth-code&state=${url.searchParams.get("state") ?? ""}`;
  });
  return cb;
}

function authUrlOf(cb: Callbacks): string {
  const info = cb.onAuth.mock.calls.at(-1)?.[0] as { url?: string } | undefined;
  if (!info?.url) throw new Error("onAuth was never called with a URL");
  return info.url;
}

function callsTo(fetchMock: FetchMock, url: string): FetchCall[] {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === url) as FetchCall[];
}

function bearerOf(call: FetchCall | undefined): string {
  return new Headers(call?.[1]?.headers).get("Authorization") ?? "";
}

function pollUrls(fetchMock: FetchMock): number {
  return fetchMock.mock.calls.filter((call) => String(call[0]).startsWith(CLI_POLL_URL)).length;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("glm-zcode CLI device-flow login", () => {
  test("happy path: init, browser auth, poll picks up the token, provisions without any paste prompt", async () => {
    vi.useFakeTimers();
    const sentInit = initPayload();
    let pollCount = 0;
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(sentInit);
      if (url === `${CLI_POLL_URL}/${FLOW_ID}`) {
        pollCount += 1;
        // First poll: login still pending (no token fields). Second: upstream token present.
        return pollCount === 1
          ? json({ code: 0, msg: "", data: { status: "pending" } })
          : json({ code: 0, msg: "", data: { zai: { access_token: UPSTREAM_TOKEN } } });
      }
      return provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = callbacks();

    const pending = loginGlmZcode(cb);
    // Fires exactly the one poll-interval sleep (2s) the flow needs; nothing really waits.
    await vi.advanceTimersByTimeAsync(2_000);
    const credentials: OAuthCredentials = await pending;

    // cli/init was called once with a random 32-byte hex bearer and {"provider":"zai"}.
    const initCalls = callsTo(fetch, CLI_INIT_URL);
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0][1]?.method).toBe("POST");
    expect(JSON.parse(String(initCalls[0][1]?.body))).toEqual({ provider: "zai" });
    expect(new Headers(initCalls[0][1]?.headers).get("Content-Type")).toBe("application/json");
    expect(bearerOf(initCalls[0])).toMatch(/^Bearer [0-9a-f]{64}$/);

    // onAuth got the authorize_url handed out by cli/init, with non-empty instructions.
    expect(cb.onAuth).toHaveBeenCalledOnce();
    const auth = cb.onAuth.mock.calls[0][0] as { url: string; instructions?: string };
    expect(auth.url).toBe(AUTH_URL);
    expect(typeof auth.instructions).toBe("string");
    expect(auth.instructions!.length).toBeGreaterThan(0);

    expect(cb.onProgress.mock.calls.length).toBeGreaterThanOrEqual(2);

    // Polling hit the flow endpoint with the server poll token, pending first, then token.
    expect(pollCount).toBe(2);
    const pollCalls = callsTo(fetch, `${CLI_POLL_URL}/${FLOW_ID}`);
    expect(pollCalls).toHaveLength(2);
    expect(new URL(String(pollCalls[0][0])).pathname).toBe(POLL_PATH);
    for (const call of pollCalls) {
      expect(call[1]?.method).toBe("GET");
      expect(bearerOf(call)).toBe(`Bearer ${POLL_TOKEN}`);
    }

    // Provisioning chain reused: z/login -> customer -> api_keys create + copy.
    const urls = fetch.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain("https://api.z.ai/api/auth/z/login");
    expect(urls).toContain(`${KEYS_URL}/copy/key-id`);

    expect(credentials).toMatchObject({
      access: "key-id.api-secret",
      refresh: UPSTREAM_TOKEN,
      email: "user@example.com",
      accountId: "42",
    });

    // The paste prompts must stay completely untouched on the device-flow path.
    expect(cb.onManualCodeInput).not.toHaveBeenCalled();
    expect(cb.onPrompt).not.toHaveBeenCalled();
  });

  test("cli/init network failure degrades to the manual paste flow", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return undefined; // unknown URL -> router throws -> init fails
      return brokerRoutes(url) ?? provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = withPaste(callbacks());

    const credentials = await loginGlmZcode(cb);

    // init was attempted and failed; the paste flow completed the login via the broker.
    expect(callsTo(fetch, CLI_INIT_URL)).toHaveLength(1);
    expect(cb.onManualCodeInput).toHaveBeenCalledOnce();
    const auth = cb.onAuth.mock.calls[0][0] as { instructions?: string };
    expect(typeof auth.instructions).toBe("string");
    expect(auth.instructions!.length).toBeGreaterThan(0);
    expect(credentials).toMatchObject({ access: "key-id.api-secret", refresh: UPSTREAM_TOKEN });
  });

  test("cli/init 200 with a missing flow_id degrades to the manual paste flow", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(initPayload({ flow_id: "" }));
      return brokerRoutes(url) ?? provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = withPaste(callbacks());

    const credentials = await loginGlmZcode(cb);

    expect(callsTo(fetch, CLI_INIT_URL)).toHaveLength(1);
    expect(pollUrls(fetch)).toBe(0);
    expect(cb.onManualCodeInput).toHaveBeenCalledOnce();
    expect(credentials).toMatchObject({ access: "key-id.api-secret", refresh: UPSTREAM_TOKEN });
  });

  test("cli/init 200 with a non-https authorize_url degrades to the manual paste flow", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) {
        return json(initPayload({ authorize_url: AUTH_URL.replace("https://", "http://") }));
      }
      return brokerRoutes(url) ?? provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = withPaste(callbacks());

    const credentials = await loginGlmZcode(cb);

    expect(callsTo(fetch, CLI_INIT_URL)).toHaveLength(1);
    expect(pollUrls(fetch)).toBe(0);
    expect(cb.onManualCodeInput).toHaveBeenCalledOnce();
    expect(credentials).toMatchObject({ access: "key-id.api-secret", refresh: UPSTREAM_TOKEN });
  });

  test("flow already expired at init throws an expired error without ever polling", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(initPayload({ expires_at: Math.floor(Date.now() / 1000) - 5 }));
      return provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = callbacks();

    await expect(loginGlmZcode(cb)).rejects.toThrow("expired before completion");
    expect(callsTo(fetch, CLI_INIT_URL)).toHaveLength(1);
    expect(pollUrls(fetch)).toBe(0);
  });

  test("an already-aborted signal fails as cancelled without any poll attempt", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(initPayload());
      return brokerRoutes(url) ?? provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const controller = new AbortController();
    controller.abort();
    const onManualCodeInput = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const onPrompt = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const cb = callbacks({ signal: controller.signal, onManualCodeInput, onPrompt });

    await expect(loginGlmZcode(cb)).rejects.toThrow(/request cancelled/);
    expect(cb.onAuth).not.toHaveBeenCalled();
    expect(cb.onManualCodeInput).not.toHaveBeenCalled();
    expect(cb.onPrompt).not.toHaveBeenCalled();
    expect(pollUrls(fetch)).toBe(0);
  });

  test("aborting while waiting between polls cancels without further poll attempts", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let pollCount = 0;
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(initPayload());
      if (url === `${CLI_POLL_URL}/${FLOW_ID}`) {
        pollCount += 1;
        return json({ code: 0, msg: "", data: { status: "pending" } });
      }
      return provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = callbacks({ signal: controller.signal });

    const pending = loginGlmZcode(cb);
    // Settle init + first poll; the interval sleep is now armed on the fake clock.
    await vi.advanceTimersByTimeAsync(1);
    expect(pollCount).toBe(1);

    controller.abort();
    await expect(pending).rejects.toThrow("request cancelled");
    expect(pollCount).toBe(1); // never polled again after cancellation
  });

  test("a poll 4xx other than 408/429 is fatal", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(initPayload());
      if (url === `${CLI_POLL_URL}/${FLOW_ID}`) return json({ code: 40301, msg: "forbidden" }, 403);
      return provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = callbacks();

    await expect(loginGlmZcode(cb)).rejects.toThrow("cli poll request failed: 403");
    expect(callsTo(fetch, `${CLI_POLL_URL}/${FLOW_ID}`)).toHaveLength(1);
  });

  test("without a poll_token the client bearer token is used for polling", async () => {
    const fetch = router((url, init) => {
      if (url === CLI_INIT_URL) return json(initPayload({ poll_token: "" }));
      // Token on the very first poll: data.access_token fallback shape.
      if (url === `${CLI_POLL_URL}/${FLOW_ID}`) {
        return json({ code: 0, msg: "", data: { access_token: UPSTREAM_TOKEN } });
      }
      return provisionRoutes(url, init);
    });
    vi.stubGlobal("fetch", fetch);
    const cb = callbacks();

    const credentials = await loginGlmZcode(cb);

    const initAuth = bearerOf(callsTo(fetch, CLI_INIT_URL)[0]);
    const pollAuth = bearerOf(callsTo(fetch, `${CLI_POLL_URL}/${FLOW_ID}`)[0]);
    expect(initAuth).toMatch(/^Bearer [0-9a-f]{64}$/);
    expect(pollAuth).toBe(initAuth);
    expect(credentials.refresh).toBe(UPSTREAM_TOKEN);
  });
});
