import { webcrypto as nodeWebcrypto } from "node:crypto";
import { vi } from "vitest";
import type { ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import glmZcodeExtension from "../../extensions/glm-zcode/index.js";
import { LIVE_MODELS_URL } from "../../extensions/glm-zcode/live-catalog.js";
import { MODELS_DEV_API_URL } from "../../extensions/glm-zcode/models.js";
import { OFFPEAK_BASE_URL } from "../../extensions/glm-zcode/offpeak.js";
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

/** Ticket availability endpoint used by the catalog's entitlement probe. */
export const TICKET_AVAILABILITY_URL = "https://zcode.z.ai/api/v1/off-peak/ticket/availability";

export const FLASH_MODEL_ID = "glm-5.3-flash";

type FixtureRoute = (url: string, init?: RequestInit) => Response | undefined;

/**
 * Catalog + entitlement doubles for an accepted off-peak publication. Only the
 * three known sources answer; `wireFetch` rejects every other target. A ticket
 * take is delegated so each case can decide when the warm-up or request-time
 * take succeeds.
 */
export function offPeakCatalogRoutes(options: { readonly models?: readonly string[] } = {}): FixtureRoute {
  const ids = options.models ?? [FLASH_MODEL_ID, "glm-5.3"];
  return (url, init) => {
    if (url === LIVE_MODELS_URL) return jsonResponse({ data: ids.map(id => ({ id, display_name: id })) });
    if (url === MODELS_DEV_API_URL) return jsonResponse({});
    if (url === TICKET_AVAILABILITY_URL && init?.method === "GET") {
      return jsonResponse({ code: 0, data: { can_take_number: true } });
    }
    if (url === TICKET_AVAILABILITY_URL) throw new Error(`wire fixture: availability used ${init?.method}`);
    return undefined;
  };
}

/**
 * Publishes a live catalog through the provider's real refresh path so the
 * extension accepts its own off-peak route (the caller-supplied model URL is
 * no longer routing authority). Returns the visible models after acceptance.
 */
export async function publishOffPeakCatalog(
  provider: Provider,
  credential: { readonly access: string; readonly jwt: string },
): Promise<readonly { id: string; baseUrl: string }[]> {
  if (!provider.refreshModels) throw new Error("wire fixture: catalog not registered");
  let persisted: ModelsStoreEntry | null | undefined;
  await provider.refreshModels({
    allowNetwork: true,
    force: true,
    signal: new AbortController().signal,
    credential: { type: "oauth", access: credential.access, refresh: "wire-refresh", expires: 1, zcodeJwtToken: credential.jwt },
    publish: async publication => {
      persisted = publication.persist;
      publication.update?.();
      return true;
    },
  });
  const models = provider.getModels();
  if (!models.some(model => model.id === FLASH_MODEL_ID && model.baseUrl === OFFPEAK_BASE_URL)) {
    throw new Error(`wire fixture: off-peak route was not accepted (checkedAt=${String(persisted?.checkedAt)})`);
  }
  return models.map(model => ({ id: model.id, baseUrl: model.baseUrl ?? "" }));
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
