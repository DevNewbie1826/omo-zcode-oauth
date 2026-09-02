import { randomBytes } from "node:crypto";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai/compat";

const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const BROKER_URL = "https://zcode.z.ai/api/v1/oauth/token";
const CLI_INIT_URL = "https://zcode.z.ai/api/v1/oauth/cli/init";
const CLI_POLL_URL = "https://zcode.z.ai/api/v1/oauth/cli/poll";
const ZAI_API_BASE_URL = "https://api.z.ai";
const ZAI_LOGIN_URL = `${ZAI_API_BASE_URL}/api/auth/z/login`;
const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const REDIRECT_URI = "zcode://oauth/callback";
const API_KEY_NAME = "zcode-api-key";
/** Provisioned API keys are long-lived; pin expiry far out so AuthStorage never force-refreshes. */
const GLM_ZCODE_API_KEY_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30_000;

type JsonRecord = Record<string, unknown>;

/** Validated payload of a successful cli/init handshake. */
type CliDeviceFlowInit = {
  flowId: string;
  pollToken: string;
  authorizeUrl: string;
  expiresAtSec: number;
  pollIntervalSec: number;
};

function redactSecrets(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted-jwt]")
    .replace(/[A-Za-z0-9_-]{40,}/g, "[redacted]");
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function data(payload: unknown): JsonRecord {
  if (!isRecord(payload)) throw new Error("GLM ZCode response was not an object");
  return isRecord(payload.data) ? payload.data : payload;
}

async function request(
  url: string,
  options: RequestInit,
  signal: AbortSignal | undefined,
  label: string,
): Promise<unknown> {
  if (signal?.aborted) throw new Error(`GLM ZCode ${label} request cancelled`);

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(url, { ...options, signal: requestSignal });
  } catch (error) {
    if (signal?.aborted) throw new Error(`GLM ZCode ${label} request cancelled`);
    if (timeoutSignal.aborted) {
      throw new Error(`GLM ZCode ${label} request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw new Error(
      `GLM ZCode ${label} request failed due to a network error (${redactSecrets(String(error))})`,
    );
  }

  if (!response.ok) throw new Error(`GLM ZCode ${label} request failed: ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`GLM ZCode ${label} response was not valid JSON`);
  }
}

async function post(
  url: string,
  body: JsonRecord,
  signal: AbortSignal | undefined,
  label: string,
  token?: string,
): Promise<unknown> {
  return request(
    url,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    signal,
    label,
  );
}

async function get(url: string, signal: AbortSignal | undefined, label: string, token: string): Promise<unknown> {
  return request(
    url,
    { method: "GET", headers: { Accept: "application/json", Authorization: `Bearer ${token}` } },
    signal,
    label,
  );
}

function cancelledError(label: string): Error {
  return new Error(`GLM ZCode ${label} request cancelled`);
}

/** Abortable sleep; rejects with the file's cancelled-style error when `signal` fires. */
function sleep(ms: number, signal: AbortSignal | undefined, label: string): Promise<void> {
  if (signal?.aborted) return Promise.reject(cancelledError(label));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(label));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function callbackCode(value: string, state: string): string {
  const input = value.trim();
  if (!input) throw new Error("GLM ZCode authorization callback URL is required");

  let callback: URL;
  try {
    callback = new URL(input);
  } catch {
    throw new Error("GLM ZCode requires the complete zcode:// callback URL");
  }

  if (
    callback.protocol !== "zcode:" ||
    callback.hostname !== "oauth" ||
    callback.pathname !== "/callback" ||
    callback.port ||
    callback.username ||
    callback.password ||
    callback.hash
  ) {
    throw new Error("GLM ZCode callback URL is invalid");
  }

  const codes = callback.searchParams.getAll("code");
  const states = callback.searchParams.getAll("state");
  if (codes.length !== 1 || states.length !== 1 || !codes[0] || !states[0]) {
    throw new Error("GLM ZCode callback URL must contain exactly one non-empty code and state");
  }
  if (states[0] !== state) throw new Error("GLM ZCode callback state did not match");
  return codes[0];
}

async function provision(upstreamToken: string, signal: AbortSignal | undefined): Promise<OAuthCredentials> {
  const login = await post(ZAI_LOGIN_URL, { token: upstreamToken }, signal, "z/login");
  const businessToken = data(login).access_token;
  if (typeof businessToken !== "string" || !businessToken) {
    throw new Error("GLM ZCode z/login response missing data.access_token");
  }

  const customer = data(
    await get(`${ZAI_API_BASE_URL}/api/biz/customer/getCustomerInfo`, signal, "getCustomerInfo", businessToken),
  );
  const organizations = Array.isArray(customer.organizations) ? customer.organizations.filter(isRecord) : [];
  const organization = organizations.find((entry) => entry.isDefault === true) ?? organizations[0];
  const projects = organization && Array.isArray(organization.projects) ? organization.projects.filter(isRecord) : [];
  const project = projects.find((entry) => entry.isDefault === true) ?? projects[0];
  const organizationId = organization?.organizationId;
  const projectId = project?.projectId;
  if (typeof organizationId !== "string" || typeof projectId !== "string") {
    throw new Error("GLM ZCode getCustomerInfo response missing default organization/project");
  }

  const keysUrl = `${ZAI_API_BASE_URL}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
  const listed = data(await get(keysUrl, signal, "api_keys.list", businessToken));
  const keys = Array.isArray(listed.data) ? listed.data.filter(isRecord) : [];
  let key = keys.find((entry) => entry.name === API_KEY_NAME);
  if (!key) {
    key = data(await post(keysUrl, { name: API_KEY_NAME }, signal, "api_keys.create", businessToken));
  }

  const keyId = typeof key.apiKey === "string" ? key.apiKey : key.id;
  if (typeof keyId !== "string" || !keyId) {
    throw new Error("GLM ZCode api_keys response missing apiKey id");
  }

  const copied = data(
    await get(`${keysUrl}/copy/${encodeURIComponent(keyId)}`, signal, "api_keys.copy", businessToken),
  );
  if (typeof copied.secretKey !== "string" || !copied.secretKey) {
    throw new Error("GLM ZCode api_keys copy response missing secretKey");
  }

  return {
    access: `${keyId}.${copied.secretKey}`,
    refresh: upstreamToken,
    expires: Date.now() + GLM_ZCODE_API_KEY_TTL_MS,
    email: typeof customer.email === "string" ? customer.email.toLowerCase() : undefined,
    accountId: typeof customer.id === "string" || typeof customer.id === "number" ? String(customer.id) : undefined,
  };
}

/**
 * CLI device flow (reverse-engineered from the ZCode 3.10.2 host bundle): cli/init hands out a
 * server-side-callback authorize URL plus poll credentials, and we poll until the upstream token
 * shows up or the flow expires.
 */
async function initCliDeviceFlow(signal: AbortSignal | undefined): Promise<CliDeviceFlowInit> {
  const clientToken = randomBytes(32).toString("hex");
  const payload = await post(CLI_INIT_URL, { provider: "zai" }, signal, "cli init", clientToken);
  if (!isRecord(payload) || payload.code !== 0) {
    throw new Error("GLM ZCode cli init response was not a successful payload");
  }
  const payloadData = isRecord(payload.data) ? payload.data : undefined;

  const rawAuthorizeUrl = payloadData?.authorize_url;
  let authorizeUrl: string;
  try {
    if (typeof rawAuthorizeUrl !== "string") throw new Error("missing data.authorize_url");
    if (new URL(rawAuthorizeUrl).protocol !== "https:") throw new Error("not an https URL");
    authorizeUrl = rawAuthorizeUrl;
  } catch {
    throw new Error("GLM ZCode cli init response missing a valid https data.authorize_url");
  }

  const flowId = payloadData?.flow_id;
  const expiresAtSec = payloadData?.expires_at;
  const pollIntervalSec = payloadData?.poll_interval_sec;
  if (typeof flowId !== "string" || !flowId) {
    throw new Error("GLM ZCode cli init response missing data.flow_id");
  }
  if (typeof expiresAtSec !== "number" || !Number.isFinite(expiresAtSec)) {
    throw new Error("GLM ZCode cli init response missing numeric data.expires_at");
  }
  if (typeof pollIntervalSec !== "number" || !Number.isFinite(pollIntervalSec) || pollIntervalSec < 1) {
    throw new Error("GLM ZCode cli init response missing data.poll_interval_sec >= 1");
  }

  // Prefer the server-issued poll token; fall back to the client bearer token.
  const rawPollToken = payloadData?.poll_token;
  const pollToken = typeof rawPollToken === "string" && rawPollToken.trim() ? rawPollToken : clientToken;
  return { flowId, pollToken, authorizeUrl, expiresAtSec, pollIntervalSec };
}

/** Returns the upstream token once present, or undefined to keep polling. */
async function pollCliDeviceFlowOnce(
  flowId: string,
  pollToken: string,
  signal: AbortSignal | undefined,
): Promise<string | undefined> {
  if (signal?.aborted) throw cancelledError("cli poll");

  const timeoutSignal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response: Response;
  try {
    response = await fetch(`${CLI_POLL_URL}/${encodeURIComponent(flowId)}`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${pollToken}` },
      signal: requestSignal,
    });
  } catch {
    if (signal?.aborted) throw cancelledError("cli poll");
    return undefined; // network error or timeout: keep polling until the flow expires
  }

  // 408/429/5xx are transient; any other 4xx means the flow is broken.
  if (response.status === 408 || response.status === 429 || response.status >= 500) return undefined;
  if (response.status >= 400) throw new Error(`GLM ZCode cli poll request failed: ${response.status}`);
  if (response.status < 200 || response.status >= 300) return undefined;

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return undefined; // non-JSON body: keep polling
  }
  if (!isRecord(payload)) return undefined;
  const record = isRecord(payload.data) ? payload.data : payload;
  const zai = isRecord(record.zai) ? record.zai : undefined;
  if (typeof zai?.access_token === "string" && zai.access_token) return zai.access_token;
  if (typeof record.access_token === "string" && record.access_token) return record.access_token;
  return undefined; // login still pending
}

async function pollCliDeviceFlow(init: CliDeviceFlowInit, callbacks: OAuthLoginCallbacks): Promise<string> {
  for (;;) {
    if (Date.now() / 1000 >= init.expiresAtSec) {
      throw new Error("GLM ZCode login flow expired before completion");
    }
    const upstreamToken = await pollCliDeviceFlowOnce(init.flowId, init.pollToken, callbacks.signal);
    if (upstreamToken) return upstreamToken;
    await sleep(init.pollIntervalSec * 1000, callbacks.signal, "cli poll");
  }
}

async function loginViaManualPaste(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const state = crypto.randomUUID();
  const params = new URLSearchParams({
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    client_id: CLIENT_ID,
    state,
  });
  callbacks.onAuth({
    url: `${AUTHORIZE_URL}?${params}`,
    instructions:
      "Complete Z.AI login in your browser. This is an unofficial ZCode-based login without PKCE support; keep the final zcode:// redirect URL private, then paste it here.",
  });

  const input = callbacks.onManualCodeInput
    ? await callbacks.onManualCodeInput()
    : await callbacks.onPrompt({ message: "Paste the ZCode redirect URL" });
  const broker = data(
    await post(
      BROKER_URL,
      { provider: "zai", code: callbackCode(input, state), redirect_uri: REDIRECT_URI, state },
      callbacks.signal,
      "broker",
    ),
  );
  const zai = isRecord(broker.zai) ? broker.zai : undefined;
  if (typeof zai?.access_token !== "string" || !zai.access_token) {
    throw new Error("GLM ZCode broker response missing data.zai.access_token");
  }

  callbacks.onProgress?.("Provisioning Z.AI API key...");
  return provision(zai.access_token, callbacks.signal);
}

const DEVICE_FLOW_INSTRUCTIONS =
  "Complete the Z.AI login in your browser. This is an unofficial ZCode-based device flow and may break " +
  "at any time; this session picks up the authorization code automatically, so there is nothing to paste.";

export async function loginGlmZcode(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  let init: CliDeviceFlowInit;
  try {
    init = await initCliDeviceFlow(callbacks.signal);
  } catch (error) {
    if (callbacks.signal?.aborted) throw error;
    // Device-flow handoff unavailable (offline, endpoint gone, unexpected shape):
    // degrade to the classic paste flow verbatim.
    return loginViaManualPaste(callbacks);
  }

  callbacks.onAuth({ url: init.authorizeUrl, instructions: DEVICE_FLOW_INSTRUCTIONS });
  callbacks.onProgress?.("Waiting for Z.AI login to complete...");

  const upstreamToken = await pollCliDeviceFlow(init, callbacks);

  callbacks.onProgress?.("Provisioning Z.AI API key...");
  return provision(upstreamToken, callbacks.signal);
}

export async function refreshGlmZcode(
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  if (!credentials.refresh) {
    throw new Error("GLM ZCode credentials require re-login (`/login glm-zcode`); no stored upstream Z.AI token");
  }
  try {
    return await provision(credentials.refresh, signal);
  } catch (error) {
    throw new Error(
      `GLM ZCode credentials require re-login (\`/login glm-zcode\`); re-provisioning the Z.AI API key failed (${redactSecrets(String(error))})`,
    );
  }
}
