import type { ProviderModelConfig } from "@code-yeongyu/senpi";
import { buildZCodeSourceHeaders, resolveZCodeAnthropicBaseUrl } from "./models.js";

/**
 * ZCode off-peak ("Idle plan") inference path, reverse-engineered from the
 * 3.11.2 host bundle. During the GLM-5.3-Flash usage campaign window
 * (23:00-09:00 SGT == 00:00-10:00 KST daily), ZCode routes flash traffic
 * through `zcode.z.ai/api/v1/off-peak/anthropic` authenticated by the zcode
 * JWT (broker `data.token`) plus a ticket from `/api/v1/off-peak/ticket`,
 * which the plan bills at zero quota. Ticket protocol (mirrored by the app's
 * e2e mock):
 *   GET  /ticket/availability            -> {data:{can_take_number, next_take_at?}}
 *   POST /ticket          {task_id}      -> {ticket_id, state: queued|ready|active, next_poll_after, ...}
 *   POST /ticket/status   {ticket_ids[]} -> {tickets:[{ticket_id, state, position, ...}]}
 *   POST /ticket/{id}/settle             -> {state:"settled"}
 * Requests carry Authorization: Bearer <jwt>, X-Coding-Plan-Api-Key, and
 * X-Off-Peak-Ticket-ID; error codes 3102 (wrong ticket), 3103 (take limit),
 * 3105 (not ready). Every failure degrades to the normal signed ultra path.
 */

export const OFFPEAK_BASE_URL = "https://zcode.z.ai/api/v1/off-peak/anthropic";
const TICKET_BASE_URL = "https://zcode.z.ai/api/v1/off-peak/ticket";
const REQUEST_TIMEOUT_MS = 15_000;
const STATUS_POLLS = 4;
const STATUS_POLL_INTERVAL_MS = 600;

/** Campaign window: KST [00:00, 10:00). */
export function isOffPeakWindow(now: Date = new Date()): boolean {
  const kstHour = (now.getUTCHours() + 9) % 24;
  return kstHour < 10;
}

export function isFlashModelId(modelId: string): boolean {
  return modelId.toLowerCase().includes("flash");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ticketFetch(url: string, init: RequestInit): Promise<Response | undefined> {
  try {
    return await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    return undefined;
  }
}

function ticketHeaders(jwt: string, apiKey: string): Record<string, string> {
  return {
    ...buildZCodeSourceHeaders(),
    Authorization: `Bearer ${jwt}`,
    "X-Coding-Plan-Api-Key": apiKey,
  };
}

/** Whether the plan currently grants an off-peak ticket. Any failure reads as false. */
export async function fetchOffPeakAvailability(jwt: string, apiKey: string): Promise<boolean> {
  const response = await ticketFetch(`${TICKET_BASE_URL}/availability`, {
    method: "GET",
    headers: ticketHeaders(jwt, apiKey),
  });
  if (!response || !response.ok) return false;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return false;
  }
  const record = isRecord(payload) && isRecord(payload.data) ? payload.data : payload;
  return isRecord(record) && record.can_take_number === true;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Takes a ticket for `taskId` and waits briefly for it to become ready.
 * Returns the ticket id, or undefined when unavailable (caller keeps ultra).
 */
export async function ensureOffPeakTicket(
  jwt: string,
  apiKey: string,
  taskId: string,
): Promise<string | undefined> {
  const take = await ticketFetch(TICKET_BASE_URL, {
    method: "POST",
    headers: { ...ticketHeaders(jwt, apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ task_id: taskId }),
  });
  if (!take || !take.ok) return undefined;
  let payload: unknown;
  try {
    payload = await take.json();
  } catch {
    return undefined;
  }
  const envelope: Record<string, unknown> | undefined = isRecord(payload) ? payload : undefined;
  const ticket: Record<string, unknown> | undefined = envelope && isRecord(envelope.data) ? envelope.data : envelope;
  const ticketId = ticket?.ticket_id;
  if (typeof ticketId !== "string" || !ticketId) return undefined;

  let state = ticket?.state;
  for (let poll = 0; poll <= STATUS_POLLS; poll += 1) {
    if (state === "ready" || state === "active") return ticketId;
    if (state !== "queued") return undefined;
    if (poll === STATUS_POLLS) return undefined;
    await sleep(STATUS_POLL_INTERVAL_MS);
    const status = await ticketFetch(`${TICKET_BASE_URL}/status`, {
      method: "POST",
      headers: { ...ticketHeaders(jwt, apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ ticket_ids: [ticketId] }),
    });
    if (!status || !status.ok) return undefined;
    try {
      payload = await status.json();
    } catch {
      return undefined;
    }
    const body: Record<string, unknown> | undefined = isRecord(payload) ? (isRecord(payload.data) ? payload.data : payload) : undefined;
    const tickets = Array.isArray(body?.tickets) ? body.tickets : [];
    const entry = tickets.find((item): item is Record<string, unknown> => isRecord(item) && item.ticket_id === ticketId);
    if (!isRecord(entry)) return undefined;
    state = entry.state ?? "queued";
  }
  return undefined;
}

/**
 * Installs off-peak JWT+ticket auth on a routed request's headers. The URL is
 * fixed per-model, so fail-open means NOT installing off-peak auth: the
 * request proceeds with its normal signed API-key authorization (a visible
 * failure beats silent mis-billing).
 */
export async function installOffPeakAuth(
  headers: Record<string, string | null>,
  deps: {
    now?: Date;
    credential?: { apiKey: string; jwt: string };
    ensureTicket: (jwt: string, apiKey: string) => Promise<string | undefined>;
  },
): Promise<boolean> {
  if (headers["X-ZCode-Route"] !== "off-peak") return false;
  delete headers["X-ZCode-Route"];
  if (!isOffPeakWindow(deps.now ?? new Date())) return false;
  const authorization = typeof headers.Authorization === "string" ? headers.Authorization : "";
  const apiKey = /^Bearer\s+(\S+)$/i.exec(authorization.trim())?.[1];
  if (!apiKey || !deps.credential || deps.credential.apiKey !== apiKey) return false;
  const ticketId = await deps.ensureTicket(deps.credential.jwt, apiKey);
  if (!ticketId) return false;
  Object.assign(headers, offPeakRequestHeaders(deps.credential.jwt, apiKey, ticketId));
  return true;
}

/** Auth headers an off-peak inference request must carry. */
export function offPeakRequestHeaders(jwt: string, apiKey: string, ticketId: string): Record<string, string> {
  return {
    Authorization: `Bearer ${jwt}`,
    "X-Coding-Plan-Api-Key": apiKey,
    "X-Off-Peak-Ticket-ID": ticketId,
  };
}

/** Static marker placed on models routed to the off-peak gateway. */
export const OFFPEAK_ROUTE_MARKER = { "X-ZCode-Route": "off-peak" } as const;

export function isOffPeakRouted(model: { baseUrl?: string; headers?: Record<string, string> }): boolean {
  return model.baseUrl === OFFPEAK_BASE_URL && model.headers?.["X-ZCode-Route"] === "off-peak";
}

/**
 * Assigns per-model base URLs: flash models go to the off-peak gateway with
 * the route marker when active; everything else stays on the ultra gateway.
 */
/** An explicit ZCODE_ANTHROPIC_BASE_URL override always wins over off-peak routing. */
function explicitEndpointOverride(): string | undefined {
  const override = process.env.ZCODE_ANTHROPIC_BASE_URL?.trim();
  return override ? override : undefined;
}

function withoutRouteMarker(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers || headers["X-ZCode-Route"] === undefined) return headers;
  const { "X-ZCode-Route": _marker, ...rest } = headers;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

export function applyOffPeakRouting(
  models: readonly ProviderModelConfig[],
  offPeakActive: boolean,
): ProviderModelConfig[] {
  const ultra = resolveZCodeAnthropicBaseUrl();
  const override = explicitEndpointOverride();
  const routeOffPeak = offPeakActive && override === undefined;
  const fallbackBase = override ?? ultra;
  return models.map((model) => {
    if (routeOffPeak && isFlashModelId(model.id)) {
      return { ...model, baseUrl: OFFPEAK_BASE_URL, headers: { ...model.headers, ...OFFPEAK_ROUTE_MARKER } };
    }
    const headers = withoutRouteMarker(model.headers);
    const base = !model.baseUrl || model.baseUrl === OFFPEAK_BASE_URL ? fallbackBase : (override ?? model.baseUrl);
    return headers === undefined ? { ...model, baseUrl: base } : { ...model, baseUrl: base, headers };
  });
}
