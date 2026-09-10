import { webcrypto } from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  SIGNING_GATE_URL,
  SIGNING_HANDSHAKE_URL,
  buildRequestSignature,
  decryptSigningPrivateKey,
  handshakeSignature,
  parseZCodeApiKey,
  resetZCodeSigningState,
  resolveZCodeSigningHeaders,
  solveClientPow,
} from "../extensions/glm-zcode/signing.js";

const subtle = webcrypto.subtle;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

async function hkdf(secret: string, info: string): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", encodeUtf8(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: encodeUtf8("WD_CLIENT_SIGN_KDF_SALT"), info: encodeUtf8(info) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function leadingZeroBits(digest: Uint8Array): Promise<number> {
  let bits = 0;
  for (const byte of digest) {
    for (let shift = 7; shift >= 0; shift -= 1) {
      if ((byte >> shift) & 1) return bits;
      bits += 1;
    }
  }
  return bits;
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest("SHA-256", encodeUtf8(value)));
}

/** Builds a privateCipher exactly the way the server does, from a locally generated key. */
async function makePrivateCipher(credential: { apiKeyId: string; apiKeySecret: string }): Promise<{
  cipher: string;
  publicKey: CryptoKey;
}> {
  const pair = (await subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  const aesKey = await subtle.importKey("raw", await hkdf(credential.apiKeySecret, "ed25519_priv"), "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = new Uint8Array(12);
  webcrypto.getRandomValues(iv);
  const plaintext = encodeUtf8(toBase64(new Uint8Array(pkcs8)));
  const sealed = new Uint8Array(
    await subtle.encrypt(
      { additionalData: encodeUtf8(credential.apiKeyId), iv, name: "AES-GCM", tagLength: 128 },
      aesKey,
      plaintext,
    ),
  );
  const cipher = new Uint8Array(iv.length + sealed.length);
  cipher.set(iv, 0);
  cipher.set(sealed, iv.length);
  return { cipher: toBase64(cipher), publicKey: pair.publicKey };
}

function glmHeaders(apiKey: string): Record<string, string | null> {
  return {
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://zcode.z.ai",
    "User-Agent": "ZCode/3.11.2",
    "X-Title": "Z Code@electron",
    "X-ZCode-App-Version": "3.11.2",
    "X-Release-Channel": "production",
    "X-Client-Language": "en-US",
    "X-Client-Timezone": "Asia/Seoul",
    "X-Platform": "darwin-arm64",
    "X-Os-Category": "macos",
    "X-Os-Version": "25.6.0",
    "X-ZCode-Agent": "glm",
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetZCodeSigningState();
});

describe("parseZCodeApiKey", () => {
  test("Given a provisioned key, when parsed, then it splits on the first separator only", () => {
    expect(parseZCodeApiKey("id.secret")).toEqual({ apiKeyId: "id", apiKeySecret: "secret" });
    expect(parseZCodeApiKey("id.se.cr.et")).toEqual({ apiKeyId: "id", apiKeySecret: "se.cr.et" });
  });

  test("Given a malformed key, when parsed, then it is rejected", () => {
    expect(parseZCodeApiKey("noseparator")).toBeUndefined();
    expect(parseZCodeApiKey(".secret")).toBeUndefined();
    expect(parseZCodeApiKey("id.")).toBeUndefined();
  });
});

describe("handshakeSignature", () => {
  test("Given the credential and challenge, when signed, then the value is the documented HKDF-HMAC template", async () => {
    const credential = { apiKeyId: "kid123", apiKeySecret: "sec456" };
    const signature = await handshakeSignature(credential, "1700000000000", "a".repeat(32));

    const derived = await hkdf("sec456", "getSignKey_hmac");
    const key = await subtle.importKey("raw", derived, { hash: "SHA-256", name: "HMAC" }, false, ["verify"]);
    const message = encodeUtf8(`get_sign_key\nkid123\n1700000000000\n${"a".repeat(32)}`);
    expect(await subtle.verify("HMAC", key, fromBase64(signature), message)).toBe(true);
  });
});

describe("decryptSigningPrivateKey", () => {
  test("Given a server-shaped privateCipher, when decrypted, then an Ed25519 signing key emerges", async () => {
    const credential = { apiKeyId: "kid123", apiKeySecret: "sec456" };
    const { cipher, publicKey } = await makePrivateCipher(credential);

    const privateKey = await decryptSigningPrivateKey(credential, cipher);
    const message = encodeUtf8("hello");
    const signature = await subtle.sign("Ed25519", privateKey, message);
    expect(await subtle.verify("Ed25519", publicKey, signature, message)).toBe(true);
  });

  test("Given a cipher encrypted for another key, when decrypted, then it fails", async () => {
    const credential = { apiKeyId: "kid123", apiKeySecret: "sec456" };
    const { cipher } = await makePrivateCipher({ apiKeyId: "other", apiKeySecret: "sec456" });
    await expect(decryptSigningPrivateKey(credential, cipher)).rejects.toThrow();
  });
});

describe("solveClientPow", () => {
  test("Given the pow challenge, when solved, then the answer carries 8 leading zero bits over the documented template", async () => {
    const { nonce, pow } = await solveClientPow("kid123", "session-1", "1700000000000");

    expect(pow.startsWith(nonce)).toBe(true);
    expect(pow.length).toBe(nonce.length + 8);
    const challengeHex = Buffer.from(await sha256("kid123\nzcode\nsession-1\n1700000000000")).toString("hex");
    const digest = await sha256(`${challengeHex.slice(0, 32)}\n${pow}`);
    expect(await leadingZeroBits(digest)).toBeGreaterThanOrEqual(8);
  });
});

describe("buildRequestSignature", () => {
  test("Given the signing key, when signing, then the signature verifies over the documented message template", async () => {
    const credential = { apiKeyId: "kid123", apiKeySecret: "sec456" };
    const { cipher, publicKey } = await makePrivateCipher(credential);
    const privateKey = await decryptSigningPrivateKey(credential, cipher);

    const signature = await buildRequestSignature(privateKey, credential, "1700000000000", "3.11.2", "session-1", "deadbeef");
    const message = encodeUtf8("kid123\n1700000000000\n3.11.2\nsession-1\ndeadbeef");
    expect(await subtle.verify("Ed25519", publicKey, fromBase64(signature), message)).toBe(true);
  });
});

describe("resolveZCodeSigningHeaders", () => {
  const credential = { apiKeyId: "kid123", apiKeySecret: "sec456" };
  const apiKey = `${credential.apiKeyId}.${credential.apiKeySecret}`;

  function stubGateAndHandshake(gatePayload: unknown, cipher: string) {
    return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === SIGNING_GATE_URL) {
        expect(init?.method).toBe("GET");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe(apiKey);
        expect(headers.get("X-ZCode-App-Version")).toBe("3.11.2");
        expect(headers.get("X-ZCode-Agent")).toBeNull();
        return json(gatePayload);
      }
      if (url === SIGNING_HANDSHAKE_URL) {
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("Authorization")).toBe(apiKey);
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        expect(body.apiKey).toBe(apiKey);
        expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
        expect(body.ts).toMatch(/^\d+$/);
        return json({ code: 200, msg: "Operation successful", data: { privateCipher: cipher } });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  test("Given an enabled gate and a working handshake, when resolved, then the request carries verifiable signature headers", async () => {
    const { cipher, publicKey } = await makePrivateCipher(credential);
    const fetch = stubGateAndHandshake({ code: 0, msg: "", data: { codingPlanSignature: { enable: true } } }, cipher);
    vi.stubGlobal("fetch", fetch);

    const headers = await resolveZCodeSigningHeaders(glmHeaders(apiKey));

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(headers["X-App-Id"]).toBe("zcode");
    expect(headers["X-Client-Version"]).toBe("3.11.2");
    expect(headers["X-Session-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(headers["X-Client-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
    expect(headers["X-Client-Ts"]).toMatch(/^\d+$/);
    expect(headers["X-Client-Pow"]).toMatch(/^[0-9a-f]{40}$/);
    expect(headers["x-zcode-session-type"]).toBe("main");
    for (const name of ["x-request-id", "x-zcode-trace-id", "x-query-id"]) {
      expect(headers[name]).toMatch(/^[0-9a-f-]{36}$/);
    }

    const message = encodeUtf8(
      `${credential.apiKeyId}\n${headers["X-Client-Ts"]}\n3.11.2\n${headers["X-Session-Id"]}\n${headers["X-Client-Nonce"]}`,
    );
    expect(await subtle.verify("Ed25519", publicKey, fromBase64(headers["X-Client-Sig"]), message)).toBe(true);

    const challengeHex = Buffer.from(
      await sha256(`${credential.apiKeyId}\nzcode\n${headers["X-Session-Id"]}\n${headers["X-Client-Ts"]}`),
    ).toString("hex");
    const powDigest = await sha256(`${challengeHex.slice(0, 32)}\n${headers["X-Client-Pow"]}`);
    expect(await leadingZeroBits(powDigest)).toBeGreaterThanOrEqual(8);
  });

  test("Given a second request in the same process, when resolved, then the gate and handshake are cached but values are fresh", async () => {
    const { cipher } = await makePrivateCipher(credential);
    const fetch = stubGateAndHandshake({ code: 0, msg: "", data: { codingPlanSignature: { enable: true } } }, cipher);
    vi.stubGlobal("fetch", fetch);

    const clock = { now: 1_000_000_000_000 };
    const realNow = Date.now;
    Date.now = () => clock.now;
    try {
      const first = await resolveZCodeSigningHeaders(glmHeaders(apiKey));
      clock.now += 2_000;
      const second = await resolveZCodeSigningHeaders(glmHeaders(apiKey));

      expect(fetch).toHaveBeenCalledTimes(2);
      expect(second["X-Session-Id"]).toBe(first["X-Session-Id"]);
      expect(Number(second["X-Client-Ts"])).toBe(clock.now);
      expect(second["X-Client-Nonce"]).not.toBe(first["X-Client-Nonce"]);
      expect(second["X-Client-Sig"]).not.toBe(first["X-Client-Sig"]);
    } finally {
      Date.now = realNow;
    }
  });

  test("Given a disabled gate, when resolved, then no signing headers are added and no handshake happens", async () => {
    const { cipher } = await makePrivateCipher(credential);
    const fetch = stubGateAndHandshake({ code: 0, msg: "", data: { codingPlanSignature: { enable: false } } }, cipher);
    vi.stubGlobal("fetch", fetch);

    expect(await resolveZCodeSigningHeaders(glmHeaders(apiKey))).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("Given a rejected handshake, when resolved, then the request fails open unsigned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) =>
        String(input instanceof Request ? input.url : input) === SIGNING_GATE_URL
          ? json({ code: 0, msg: "", data: { codingPlanSignature: { enable: true } } })
          : json({ code: 400, msg: "HANDSHAKE_REJECTED" }),
      ),
    );

    expect(await resolveZCodeSigningHeaders(glmHeaders(apiKey))).toEqual({});
  });

  test("Given a non-glm provider or missing bearer key, when resolved, then nothing happens without any fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    expect(await resolveZCodeSigningHeaders({ ...glmHeaders(apiKey), "X-ZCode-Agent": "other" })).toEqual({});
    const withoutAgent = { ...glmHeaders(apiKey) };
    delete withoutAgent["X-ZCode-Agent"];
    expect(await resolveZCodeSigningHeaders(withoutAgent)).toEqual({});
    expect(await resolveZCodeSigningHeaders({ ...glmHeaders("no-separator-key"), "X-ZCode-Agent": "glm" })).toEqual({});
    expect(await resolveZCodeSigningHeaders({ ...glmHeaders(apiKey), Authorization: null })).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
  });
});
