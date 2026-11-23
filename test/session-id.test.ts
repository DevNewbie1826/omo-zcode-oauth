import { webcrypto as nodeWebcrypto } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";
import { zcodeSessionId } from "../extensions/glm-zcode/signing.js";
import { resetZCodeSigningState } from "../extensions/glm-zcode/signing.js";

type RequestHook = (event: { payload: unknown; model: { provider: string } }) => unknown;
type HeadersHook = (event: { headers: Record<string, string | null> }) => Promise<void>;

const KEY = "session-key-id.session-secret";

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

async function hkdf(secret: string, info: string): Promise<Uint8Array> {
  const subtle = nodeWebcrypto.subtle;
  const key = await subtle.importKey("raw", new TextEncoder().encode(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode("WD_CLIENT_SIGN_KDF_SALT"),
    info: new TextEncoder().encode(info),
  }, key, 256);
  return new Uint8Array(bits);
}

async function cipherFixture(): Promise<string> {
  const subtle = nodeWebcrypto.subtle;
  const pair = (await subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const aes = await subtle.importKey("raw", await hkdf("session-secret", "ed25519_priv"), "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  nodeWebcrypto.getRandomValues(iv);
  const sealed = new Uint8Array(await subtle.encrypt({
    additionalData: new TextEncoder().encode("session-key-id"),
    iv,
    name: "AES-GCM",
    tagLength: 128,
  } as unknown as Algorithm, aes, new TextEncoder().encode(Buffer.from(pkcs8).toString("base64"))));
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return Buffer.from(out).toString("base64");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetZCodeSigningState();
});

describe("session id unification", () => {
  test("metadata.session_id is a bare uuid (no omo-offpeak prefix)", async () => {
    vi.stubEnv("ZCODE_DEVICE_ID", "dev-1");
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
    vi.stubEnv("ZCODE_DEVICE_ID", "dev-2");
    const cipher = await cipherFixture();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/agent/configs")) {
          return Response.json({ code: 0, data: { codingPlanSignature: { enable: true } } });
        }
        if (url.endsWith("/api/paas/c1f3a7e2/v2/client")) {
          return Response.json({ code: 200, data: { privateCipher: cipher } });
        }
        throw new Error(`unexpected request: ${url}`);
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

    expect(meta.device_id).toBe("dev-2");
    expect(meta.session_id).toBe(zcodeSessionId());
    expect(headers["X-Session-Id"]).toBe(meta.session_id);
    expect(headers["X-Client-Sig"]).toMatch(/^\S+$/);
  });
});
