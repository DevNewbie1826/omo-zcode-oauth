import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { zcodeSessionId } from "../extensions/glm-zcode/signing.js";
import { resetZCodeSigningState } from "../extensions/glm-zcode/signing.js";
import {
  captureExtension,
  cipherFixture,
  registeredHook,
  signingRoutes,
  type HeadersHook,
  type RequestHook,
} from "./support/wire-fixture.js";

const KEY = "session-key-id.session-secret";

beforeEach(() => {
  vi.stubEnv("ZCODE_DEVICE_ID", "session-device-fixture");
  vi.stubEnv("ZCODE_APP_VERSION", "4.0.0");
  vi.stubEnv("ZCODE_RELEASE_CHANNEL", "production");
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", undefined);
  vi.stubEnv("OFFLINE", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetZCodeSigningState();
});

describe("session id unification", () => {
  test("metadata.session_id is a bare uuid (no omo-offpeak prefix)", async () => {
    const { on } = captureExtension();
    const hook = registeredHook<RequestHook>(on, "before_provider_request");
    const payload: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    hook({ payload, model: { provider: "glm-zcode" } });
    const meta = JSON.parse((payload.metadata as { user_id: string }).user_id) as { session_id: string };
    expect(meta.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(meta.session_id.includes("omo-offpeak")).toBe(false);

    expect(meta.session_id).toBe(zcodeSessionId());

    const second: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    hook({ payload: second, model: { provider: "glm-zcode" } });
    const secondMeta = JSON.parse((second.metadata as { user_id: string }).user_id) as { session_id: string };
    expect(secondMeta.session_id).toBe(meta.session_id);
    expect(zcodeSessionId()).toBe(meta.session_id);
  });

  test("signed headers carry the same session id as the request metadata", async () => {
    const cipher = await cipherFixture({ apiKeyId: "session-key-id", apiKeySecret: "session-secret" });
    const auxiliary: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const routed = signingRoutes(cipher, auxiliary)(String(input));
        if (routed) return routed;
        throw new Error(`unexpected request: ${String(input)}`);
      }),
    );
    const { provider, on } = captureExtension();
    const oauth = provider.auth.oauth;
    if (!oauth) throw new Error("OAuth auth not registered");
    const auth = await oauth.toAuth({ type: "oauth", access: KEY, refresh: "r", expires: 1 });
    const headers = { ...(auth.headers ?? {}) };
    await registeredHook<HeadersHook>(on, "before_provider_headers")({ headers });

    const payload: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    registeredHook<RequestHook>(on, "before_provider_request")({ payload, model: { provider: "glm-zcode" } });
    const meta = JSON.parse((payload.metadata as { user_id: string }).user_id) as {
      device_id: string;
      session_id: string;
    };

    expect(meta.device_id).toBe("session-device-fixture");
    expect(meta.session_id).toBe(zcodeSessionId());
    expect(headers["X-Session-Id"]).toBe(meta.session_id);
    expect(headers["X-Client-Sig"]).toMatch(/^\S+$/);
    expect(auxiliary).toHaveLength(2);
  });
});
