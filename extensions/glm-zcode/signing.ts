import { randomUUID, webcrypto } from "node:crypto";
import { zcodeAppVersion } from "./models.js";

/**
 * ZCode client request signing ("ClientRequestSigningV4"), reverse-engineered
 * from the ZCode 3.11.2 agent bundle (glm/zcode.cjs) and verified live against
 * the real endpoints on 2026-09-09:
 *
 * 1. Feature gate: GET https://zcode.z.ai/api/v1/agent/configs with the ZCode
 *    source headers plus `x-api-key` reports `data.codingPlanSignature.enable`.
 * 2. Handshake: POST https://api.z.ai/api/paas/c1f3a7e2/v2/client with the raw
 *    `{id}.{secret}` key as Authorization and a body proving knowledge of the
 *    secret (HKDF-derived HMAC over `get_sign_key\n{id}\n{ts}\n{nonce}`).
 *    The response carries `data.privateCipher`: base64(IV(12) || AES-256-GCM(
 *    base64(pkcs8 Ed25519 private key))) with the AES key HKDF-derived from the
 *    secret and the apiKeyId as additional data.
 * 3. Per request: `X-Client-Ts/Version/Sig/Nonce`, `X-App-Id: zcode`,
 *    `X-Client-Pow` (8-bit SHA-256 proof of work) and `X-Session-Id`. The
 *    Ed25519 signature covers `{id}\n{ts}\n{version}\n{sessionId}\n{nonce}`.
 *
 * Signed traffic is what Z.ai's ultra gateway (`zcode.z.ai/api/v1/ultra-zai/…`)
 * recognizes as "used via ZCode" — the basis of the GLM-5.3-Flash zero-quota
 * usage campaign (docs.z.ai/devpack/notice/event-glm-5.3-flash).
 *
 * Every failure path mirrors the app's fail-open behavior: the request is sent
 * unsigned rather than blocked.
 */

const subtle = webcrypto.subtle;

export const CLIENT_SIGNING_APP_ID = "zcode";
export const SIGNING_GATE_URL = "https://zcode.z.ai/api/v1/agent/configs";
export const SIGNING_HANDSHAKE_URL = "https://api.z.ai/api/paas/c1f3a7e2/v2/client";
/** HKDF salt shared by the handshake HMAC key and the private-cipher AES key. */
const KDF_SALT = "WD_CLIENT_SIGN_KDF_SALT";
const KDF_INFO_HMAC = "getSignKey_hmac";
const KDF_INFO_PRIVATE = "ed25519_priv";
const HANDSHAKE_ACTION = "get_sign_key";
const POW_BITS = 8;
const NONCE_BYTES = 16;
const GATE_TTL_MS = 60 * 60 * 1000;
const GATE_TIMEOUT_MS = 15_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

export type ZCodeApiKeyCredential = { apiKeyId: string; apiKeySecret: string };

type SigningState = {
  gate?: { enabled: boolean; checkedAt: number };
  keyPromise?: Promise<CryptoKey>;
};

const states = new Map<string, SigningState>();
let sessionId: string | undefined;

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  webcrypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable per-process session identity (the app derives it per agent session). */
function currentSessionId(): string {
  sessionId ??= randomUUID();
  return sessionId;
}

/** The same session id the app carries in both x-session-id and metadata.user_id. */
export function zcodeSessionId(): string {
  return currentSessionId();
}

/** Splits a provisioned Z.AI key into its id/secret halves; anything else is unusable. */
export function parseZCodeApiKey(key: string): ZCodeApiKeyCredential | undefined {
  const separator = key.indexOf(".");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  return { apiKeyId: key.slice(0, separator), apiKeySecret: key.slice(separator + 1) };
}

async function hkdfDerive(secret: string, info: string): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encodeUtf8(KDF_SALT), info: encodeUtf8(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** HMAC-SHA256 (HKDF-derived key) over the handshake challenge; base64-encoded. */
export async function handshakeSignature(
  credential: ZCodeApiKeyCredential,
  ts: string,
  nonce: string,
): Promise<string> {
  const derived = await hkdfDerive(credential.apiKeySecret, KDF_INFO_HMAC);
  const key = await subtle.importKey("raw", derived, { hash: "SHA-256", name: "HMAC" }, false, ["sign"]);
  const message = `${HANDSHAKE_ACTION}\n${credential.apiKeyId}\n${ts}\n${nonce}`;
  const signature = await subtle.sign("HMAC", key, encodeUtf8(message));
  return toBase64(new Uint8Array(signature));
}

/** Decrypts the handshake `privateCipher` into an Ed25519 signing key. */
export async function decryptSigningPrivateKey(
  credential: ZCodeApiKeyCredential,
  privateCipher: string,
): Promise<CryptoKey> {
  const cipher = fromBase64(privateCipher);
  if (cipher.byteLength <= 12 + 16) throw new Error("glm-zcode: privateCipher is too short");
  const derived = await hkdfDerive(credential.apiKeySecret, KDF_INFO_PRIVATE);
  const aesKey = await subtle.importKey("raw", derived, "AES-GCM", false, ["decrypt"]);
  const plaintext = await subtle.decrypt(
    {
      additionalData: encodeUtf8(credential.apiKeyId),
      iv: cipher.slice(0, 12),
      name: "AES-GCM",
      tagLength: 128,
    },
    aesKey,
    cipher.slice(12),
  );
  // The decrypted plaintext is the pkcs8 DER as a base64 string.
  const pkcs8 = fromBase64(new TextDecoder().decode(plaintext));
  return subtle.importKey("pkcs8", pkcs8, "Ed25519", false, ["sign"]);
}

function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (digest[index] !== 0) return false;
  }
  const remainder = bits % 8;
  if (remainder === 0) return true;
  const mask = (255 << (8 - remainder)) & 255;
  return (digest[fullBytes] ?? 255 & mask) === 0;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await subtle.digest("SHA-256", encodeUtf8(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Solves the client proof of work: `${nonce}${counter:08x}` with `POW_BITS` leading zero bits. */
export async function solveClientPow(
  apiKeyId: string,
  sessionIdValue: string,
  ts: string,
): Promise<{ nonce: string; pow: string }> {
  const nonce = randomHex(NONCE_BYTES);
  const challenge = (await sha256Hex(`${apiKeyId}\n${CLIENT_SIGNING_APP_ID}\n${sessionIdValue}\n${ts}`)).slice(0, 32);
  for (let counter = 0; counter <= 4294967295; counter += 1) {
    const candidate = `${nonce}${counter.toString(16).padStart(8, "0")}`;
    const digestHex = await sha256Hex(`${challenge}\n${candidate}`);
    const digest = new Uint8Array(digestHex.length / 2);
    for (let index = 0; index < digest.length; index += 1) {
      digest[index] = Number.parseInt(digestHex.slice(index * 2, index * 2 + 2), 16);
    }
    if (hasLeadingZeroBits(digest, POW_BITS)) return { nonce, pow: candidate };
  }
  throw new Error("glm-zcode: unable to solve client proof of work");
}

/** Ed25519 signature over `{id}\n{ts}\n{version}\n{sessionId}\n{nonce}`; base64-encoded. */
export async function buildRequestSignature(
  privateKey: CryptoKey,
  credential: ZCodeApiKeyCredential,
  ts: string,
  clientVersion: string,
  sessionIdValue: string,
  nonce: string,
): Promise<string> {
  const message = `${credential.apiKeyId}\n${ts}\n${clientVersion}\n${sessionIdValue}\n${nonce}`;
  const signature = await subtle.sign("Ed25519", privateKey, encodeUtf8(message));
  return toBase64(new Uint8Array(signature));
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
}

async function fetchSigningEnabled(apiKey: string, headers: Record<string, string>): Promise<boolean> {
  const response = await fetchWithTimeout(
    SIGNING_GATE_URL,
    { headers: { ...headers, "x-api-key": apiKey }, method: "GET" },
    GATE_TIMEOUT_MS,
  );
  if (!response.ok) return false;
  const payload: unknown = await response.json();
  if (!isRecord(payload) || payload.code !== 0) return false;
  const data = isRecord(payload.data) ? payload.data : undefined;
  const signatureFlag = isRecord(data?.codingPlanSignature) ? data.codingPlanSignature : undefined;
  return signatureFlag?.enable === true;
}

/** Cached gate check (1h TTL on affirmative responses, re-checked after failures). */
async function signingEnabled(apiKey: string, headers: Record<string, string>): Promise<boolean> {
  const state = states.get(apiKey) ?? {};
  states.set(apiKey, state);
  if (state.gate && Date.now() - state.gate.checkedAt < GATE_TTL_MS) return state.gate.enabled;
  let enabled = false;
  try {
    enabled = await fetchSigningEnabled(apiKey, headers);
  } catch {
    enabled = false;
  }
  if (enabled) state.gate = { enabled, checkedAt: Date.now() };
  else state.gate = undefined;
  return enabled;
}

async function performHandshake(credential: ZCodeApiKeyCredential): Promise<CryptoKey> {
  const ts = String(Date.now());
  const nonce = randomHex(NONCE_BYTES);
  const signature = await handshakeSignature(credential, ts, nonce);
  const response = await fetchWithTimeout(
    SIGNING_HANDSHAKE_URL,
    {
      method: "POST",
      headers: { Authorization: `${credential.apiKeyId}.${credential.apiKeySecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: `${credential.apiKeyId}.${credential.apiKeySecret}`, nonce, sig: signature, ts }),
    },
    HANDSHAKE_TIMEOUT_MS,
  );
  if (response.status !== 200) throw new Error(`glm-zcode: signing handshake HTTP status ${response.status}`);
  const payload: unknown = await response.json();
  if (!isRecord(payload)) throw new Error("glm-zcode: signing handshake response was not an object");
  if (payload.code === 500) throw new Error("glm-zcode: signing handshake reported code 500");
  if (payload.code !== 200) throw new Error("glm-zcode: signing handshake was rejected");
  const privateCipher = isRecord(payload.data) ? payload.data.privateCipher : undefined;
  if (typeof privateCipher !== "string" || !privateCipher) {
    throw new Error("glm-zcode: signing handshake omitted privateCipher");
  }
  return decryptSigningPrivateKey(credential, privateCipher);
}

async function ensurePrivateKey(credential: ZCodeApiKeyCredential): Promise<CryptoKey> {
  const apiKey = `${credential.apiKeyId}.${credential.apiKeySecret}`;
  const state = states.get(apiKey) ?? {};
  states.set(apiKey, state);
  state.keyPromise ??= performHandshake(credential).catch((error: unknown) => {
    state.keyPromise = undefined; // next request retries, this one fails open
    throw error;
  });
  return state.keyPromise;
}

/**
 * Computes the per-request client-signature and attribution headers for a
 * glm-zcode model request. Returns `{}` (unsigned) whenever signing does not
 * apply: foreign provider, missing/invalid key, gate disabled, or any internal
 * failure — never throws.
 */
export async function resolveZCodeSigningHeaders(
  headers: Record<string, string | null | undefined>,
): Promise<Record<string, string>> {
  try {
    if (headers["X-ZCode-Agent"] !== "glm") return {};
    const authorization = typeof headers.Authorization === "string" ? headers.Authorization.trim() : "";
    const bearer = /^Bearer\s+(\S+)$/i.exec(authorization);
    if (!bearer) return {};
    const apiKey = bearer[1];
    const credential = parseZCodeApiKey(apiKey);
    if (!credential) return {};
    // Gate headers mirror the app: source headers only (no X-ZCode-Agent).
    const source: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string" && value !== "" && key !== "X-ZCode-Agent" && key !== "Authorization" && !key.startsWith("x-") && !key.startsWith("X-Client")) {
        source[key] = value;
      }
    }
    if (!(await signingEnabled(apiKey, source))) return {};
    const privateKey = await ensurePrivateKey(credential);
    const sessionIdValue = currentSessionId();
    const ts = String(Date.now());
    const { nonce, pow } = await solveClientPow(credential.apiKeyId, sessionIdValue, ts);
    const signature = await buildRequestSignature(
      privateKey,
      credential,
      ts,
      zcodeAppVersion(),
      sessionIdValue,
      nonce,
    );
    return {
      "X-Client-Ts": ts,
      "X-Client-Version": zcodeAppVersion(),
      "X-Client-Sig": signature,
      "X-Session-Id": sessionIdValue,
      "X-Client-Nonce": nonce,
      "X-App-Id": CLIENT_SIGNING_APP_ID,
      "X-Client-Pow": pow,
      "x-request-id": randomUUID(),
      "x-zcode-trace-id": randomUUID(),
      "x-query-id": randomUUID(),
      "x-zcode-session-type": "main",
    };
  } catch (error) {
    console.debug(
      `glm-zcode: client signing unavailable, sending unsigned (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
    return {};
  }
}

/** Test hook: clears the gate/handshake caches between cases. */
export function resetZCodeSigningState(): void {
  states.clear();
  sessionId = undefined;
}
