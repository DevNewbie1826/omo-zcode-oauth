import { webcrypto as nodeWebcrypto } from "node:crypto";
import { vi } from "vitest";
import type { Provider } from "@earendil-works/pi-ai";
import glmZcodeExtension from "../../extensions/glm-zcode/index.js";
import { SIGNING_GATE_URL, SIGNING_HANDSHAKE_URL } from "../../extensions/glm-zcode/signing.js";

export type RequestHook = (event: { payload: unknown; model: { provider: string } }) => unknown;
export type HeadersHook = (event: { headers: Record<string, string | null> }) => Promise<void>;

export function captureExtension() {
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

export function registeredHook<T>(on: ReturnType<typeof vi.fn>, event: string): T {
  const handler: unknown = on.mock.calls.find(([name]) => name === event)?.[1];
  if (typeof handler !== "function") throw new Error(`${event} not registered`);
  return handler as T;
}

const subtle = nodeWebcrypto.subtle;
const utf8 = new TextEncoder();

export async function hkdf(secret: string, info: string): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", utf8.encode(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: utf8.encode("WD_CLIENT_SIGN_KDF_SALT"), info: utf8.encode(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export function aesGcmParams(apiKeyId: string, iv: Uint8Array<ArrayBuffer>): AesGcmParams {
  if (iv.byteLength !== 12) throw new Error("wire fixture: AES-GCM iv must be 12 bytes");
  const additionalData = utf8.encode(apiKeyId);
  if (additionalData.byteLength === 0) throw new Error("wire fixture: AES-GCM additionalData must bind the api key id");
  return { additionalData, iv, name: "AES-GCM", tagLength: 128 };
}

export async function cipherFixture(options: { apiKeyId?: string; apiKeySecret?: string } = {}): Promise<string> {
  const apiKeyId = options.apiKeyId ?? "wire-key-id";
  const apiKeySecret = options.apiKeySecret ?? "wire-secret";
  const pair = (await subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const aes = await subtle.importKey("raw", await hkdf(apiKeySecret, "ed25519_priv"), "AES-GCM", false, ["encrypt"]);
  const iv = new Uint8Array(12);
  nodeWebcrypto.getRandomValues(iv);
  const sealed = new Uint8Array(
    await subtle.encrypt(aesGcmParams(apiKeyId, iv), aes, utf8.encode(Buffer.from(pkcs8).toString("base64"))),
  );
  const out = new Uint8Array(iv.length + sealed.length);
  out.set(iv);
  out.set(sealed, iv.length);
  return Buffer.from(out).toString("base64");
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

export function signingRoutes(
  cipher: string | ((apiKey: string) => string | undefined),
  auxiliary: string[] = [],
): (url: string, init?: RequestInit) => Response | undefined {
  return (url, init) => {
    if (url === SIGNING_GATE_URL) {
      auxiliary.push(url);
      return jsonResponse({ code: 0, data: { codingPlanSignature: { enable: true } } });
    }
    if (url === SIGNING_HANDSHAKE_URL) {
      auxiliary.push(url);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as { apiKey?: unknown }) : {};
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      const privateCipher = typeof cipher === "string" ? cipher : cipher(apiKey);
      if (!privateCipher) throw new Error(`wire fixture: no privateCipher for ${apiKey}`);
      return jsonResponse({ code: 200, data: { privateCipher } });
    }
    return undefined;
  };
}
