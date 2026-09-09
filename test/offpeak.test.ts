import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderModelConfig } from "@code-yeongyu/senpi";
import {
  installOffPeakAuth,
  OFFPEAK_BASE_URL,
  applyOffPeakRouting,
  ensureOffPeakTicket,
  fetchOffPeakAvailability,
  isFlashModelId,
  isOffPeakRouted,
  isOffPeakWindow,
  offPeakRequestHeaders,
} from "../extensions/glm-zcode/offpeak.js";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function flashModel(overrides: Partial<ProviderModelConfig> = {}): ProviderModelConfig {
  return {
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    ...overrides,
  } as ProviderModelConfig;
}

function plainModel(): ProviderModelConfig {
  return flashModel({ id: "glm-5.3", name: "GLM-5.3" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("isOffPeakWindow", () => {
  test("KST midnight-to-10am is the campaign window, boundaries included/excluded", () => {
    expect(isOffPeakWindow(new Date("2026-09-09T15:00:00Z"))).toBe(true); // 00:00 KST
    expect(isOffPeakWindow(new Date("2026-09-09T18:30:00Z"))).toBe(true); // 03:30 KST
    expect(isOffPeakWindow(new Date("2026-09-10T00:59:59Z"))).toBe(true); // 09:59:59 KST
    expect(isOffPeakWindow(new Date("2026-09-10T01:00:00Z"))).toBe(false); // 10:00 KST
    expect(isOffPeakWindow(new Date("2026-09-09T06:00:00Z"))).toBe(false); // 15:00 KST
    expect(isOffPeakWindow(new Date("2026-09-09T14:59:59Z"))).toBe(false); // 23:59:59 KST
  });
});

describe("isFlashModelId / isOffPeakRouted", () => {
  test("flash family ids and the marker+base pair are recognized", () => {
    expect(isFlashModelId("glm-5.3-flash")).toBe(true);
    expect(isFlashModelId("GLM-5.3-Flash")).toBe(true);
    expect(isFlashModelId("glm-5.3")).toBe(false);
    expect(isOffPeakRouted({ baseUrl: OFFPEAK_BASE_URL })).toBe(true);
    expect(isOffPeakRouted({ baseUrl: "https://zcode.z.ai/api/v1/ultra-zai/anthropic" })).toBe(false);
    expect(isOffPeakRouted({})).toBe(false);
  });
});

describe("fetchOffPeakAvailability", () => {
  test("availability request authenticates with the jwt and coding-plan key", async () => {
    const fetch = vi.fn(async () => json({ code: 0, data: { can_take_number: true } }));
    vi.stubGlobal("fetch", fetch);

    expect(await fetchOffPeakAvailability("jwt-tok", "key-id.secret")).toBe(true);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe("https://zcode.z.ai/api/v1/off-peak/ticket/availability");
    expect(init.method).toBe("GET");
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer jwt-tok");
    expect(headers.get("X-Coding-Plan-Api-Key")).toBe("key-id.secret");
  });

  test("can_take_number false, non-2xx, and network errors all read as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 0, data: { can_take_number: false } })));
    expect(await fetchOffPeakAvailability("jwt", "key")).toBe(false);
    vi.stubGlobal("fetch", vi.fn(async () => json({}, 401)));
    expect(await fetchOffPeakAvailability("jwt", "key")).toBe(false);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(await fetchOffPeakAvailability("jwt", "key")).toBe(false);
  });
});

describe("ensureOffPeakTicket", () => {
  test("take returns a ready ticket id and posts the task_id", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const url = String(_input);
      if (url.endsWith("/ticket")) {
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({ task_id: "task-1" });
        return json({ ticket_id: "t-1", state: "ready" });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    expect(await ensureOffPeakTicket("jwt", "key", "task-1")).toBe("t-1");
  });

  test("queued tickets are polled to ready, then returned; failures return undefined", async () => {
    let statusCalls = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/ticket")) return json({ ticket_id: "t-2", state: "queued", next_poll_after: 0.05 });
      if (url.endsWith("/ticket/status")) {
        statusCalls += 1;
        return json({ tickets: [{ ticket_id: "t-2", state: statusCalls >= 2 ? "ready" : "queued" }] });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    expect(await ensureOffPeakTicket("jwt", "key", "task-2")).toBe("t-2");
    expect(statusCalls).toBe(2);

    vi.stubGlobal("fetch", vi.fn(async () => json({ code: 3103, msg: "free tier limit reached" }, 429)));
    expect(await ensureOffPeakTicket("jwt", "key", "task-3")).toBeUndefined();
  });
});

describe("offPeakRequestHeaders", () => {
  test("jwt auth, coding-plan key, and ticket id headers are emitted", () => {
    expect(offPeakRequestHeaders("jwt-tok", "key-1", "t-9")).toEqual({
      Authorization: "Bearer jwt-tok",
      "X-Coding-Plan-Api-Key": "key-1",
      "X-Off-Peak-Ticket-ID": "t-9",
    });
  });
});

describe("applyOffPeakRouting", () => {
  test("active: flash gets the off-peak base, others keep ultra; inactive: everything ultra", () => {
    const [routedFlash, routedPlain] = applyOffPeakRouting([flashModel(), plainModel()], true);
    expect(routedFlash.baseUrl).toBe(OFFPEAK_BASE_URL);
    expect(routedPlain.baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    expect(routedPlain.headers).toBeUndefined();

    const [plainFlash] = applyOffPeakRouting([flashModel()], false);
    expect(plainFlash.baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
    expect(plainFlash.headers).toBeUndefined();
  });

  test("an explicit ZCODE_ANTHROPIC_BASE_URL override beats off-peak routing on every model", () => {
    vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", "https://api.z.ai/api/anthropic");
    const [routed] = applyOffPeakRouting([flashModel()], true);
    expect(routed.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(routed.headers).toBeUndefined();
    const [rebased] = applyOffPeakRouting([flashModel({ baseUrl: OFFPEAK_BASE_URL })], false);
    expect(rebased.baseUrl).toBe("https://api.z.ai/api/anthropic");
    vi.unstubAllEnvs();
  });

  test("existing model headers survive routing untouched in both directions", () => {
    const custom = flashModel({ headers: { "anthropic-beta": "x-1", "X-Custom": "keep" } });
    const [routed] = applyOffPeakRouting([custom], true);
    expect(routed.headers).toEqual({ "anthropic-beta": "x-1", "X-Custom": "keep" });
    const [stale] = applyOffPeakRouting([flashModel({ baseUrl: OFFPEAK_BASE_URL, headers: { "X-Custom": "keep", "X-ZCode-Route": "off-peak" } })], false);
    expect(stale.headers).toEqual({ "X-Custom": "keep" });
    expect(stale.baseUrl).toBe("https://zcode.z.ai/api/v1/ultra-zai/anthropic");
  });
});

describe("ensureOffPeakTicket final-poll semantics", () => {
  test("a ticket that becomes ready on the last permitted poll is still returned", async () => {
    vi.useFakeTimers();
    try {
      let statusCalls = 0;
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/ticket")) return json({ ticket_id: "t-late", state: "queued" });
        if (url.endsWith("/ticket/status")) {
          statusCalls += 1;
          return json({ tickets: [{ ticket_id: "t-late", state: statusCalls >= 4 ? "ready" : "queued" }] });
        }
        throw new Error(`unexpected ${url}`);
      });
      vi.stubGlobal("fetch", fetch);
      const pending = ensureOffPeakTicket("jwt", "key", "task-late");
      const advance = (async () => { for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(600); })();
      const [ticket] = await Promise.all([pending, advance]);
      expect(ticket).toBe("t-late");
      expect(statusCalls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a ticket still queued after the final poll gives up", async () => {
    vi.useFakeTimers();
    try {
      const fetch = vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/ticket")) return json({ ticket_id: "t-stuck", state: "queued" });
        if (url.endsWith("/ticket/status")) return json({ tickets: [{ ticket_id: "t-stuck", state: "queued" }] });
        throw new Error(`unexpected ${url}`);
      });
      vi.stubGlobal("fetch", fetch);
      const pending = ensureOffPeakTicket("jwt", "key", "task-stuck");
      const advance = (async () => { for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(600); })();
      const [ticket] = await Promise.all([pending, advance]);
      expect(ticket).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("installOffPeakAuth", () => {
  const inWin = new Date("2026-09-09T18:00:00Z"); // 03:00 KST
  const outWin = new Date("2026-09-09T08:00:00Z"); // 17:00 KST
  const markerHeaders = () => ({ Authorization: "Bearer key-id.secret", "X-ZCode-Route": "off-peak" });

  test("matching credential in-window installs JWT + ticket auth and drops the marker", async () => {
    const headers = markerHeaders();
    const ok = await installOffPeakAuth(headers, {
      now: inWin,
      credential: { apiKey: "key-id.secret", jwt: "jwt-tok" },
      ensureTicket: async (jwt, apiKey) => (jwt === "jwt-tok" && apiKey === "key-id.secret" ? "t-7" : undefined),
    });
    expect(ok).toBe(true);
    expect(headers).toEqual({
      Authorization: "Bearer jwt-tok",
      "X-Coding-Plan-Api-Key": "key-id.secret",
      "X-Off-Peak-Ticket-ID": "t-7",
    });
  });

  test("outside the window the marker is dropped but API-key auth stays untouched (fail-open)", async () => {
    const headers = markerHeaders();
    const ok = await installOffPeakAuth(headers, {
      now: outWin,
      credential: { apiKey: "key-id.secret", jwt: "jwt-tok" },
      ensureTicket: async () => "t-7",
    });
    expect(ok).toBe(false);
    expect(headers).toEqual({ Authorization: "Bearer key-id.secret" });
  });

  test("a credential pair bound to a different API key never installs, and ticket failure fails open", async () => {
    const stale = markerHeaders();
    expect(
      await installOffPeakAuth(stale, {
        now: inWin,
        credential: { apiKey: "other-account-key", jwt: "jwt-other" },
        ensureTicket: async () => "t-7",
      }),
    ).toBe(false);
    expect(stale).toEqual({ Authorization: "Bearer key-id.secret" });

    const noTicket = markerHeaders();
    expect(
      await installOffPeakAuth(noTicket, {
        now: inWin,
        credential: { apiKey: "key-id.secret", jwt: "jwt-tok" },
        ensureTicket: async () => undefined,
      }),
    ).toBe(false);
    expect(noTicket).toEqual({ Authorization: "Bearer key-id.secret" });
  });

  test("requests without the marker are left completely alone", async () => {
    const headers = { Authorization: "Bearer key-id.secret", "User-Agent": "ZCode/3.11.2" };
    expect(await installOffPeakAuth(headers, { ensureTicket: async () => "t" })).toBe(false);
    expect(headers).toEqual({ Authorization: "Bearer key-id.secret", "User-Agent": "ZCode/3.11.2" });
  });
});
