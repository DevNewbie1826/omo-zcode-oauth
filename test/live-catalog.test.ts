import { afterEach, describe, expect, test, vi } from "vitest";
import { LIVE_MODELS_MAX_BYTES, LIVE_MODELS_URL, fetchLiveModels } from "../extensions/glm-zcode/live-catalog.js";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

const EXPECTED_THINKING = {
  minimal: "low",
  low: "low",
  medium: "low",
  high: "high",
  xhigh: "max",
  max: "max",
};

function expectedLiveModel(id: string, name: string) {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    thinkingLevelMap: EXPECTED_THINKING,
    compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLiveModels", () => {
  test("Given a {data:[...]} envelope, when fetched, then usable entries map with static metadata defaults", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => json({ data: [{ id: "glm-live-a", display_name: "GLM Live A" }, { id: "glm-live-b" }] })),
    );

    const models = await fetchLiveModels("key-123");

    expect(models).toEqual([expectedLiveModel("glm-live-a", "GLM Live A"), expectedLiveModel("glm-live-b", "glm-live-b")]);
  });

  test("Given a bare array envelope, when fetched, then usable entries map the same way", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json([{ id: "glm-bare", display_name: "GLM Bare" }])));

    const models = await fetchLiveModels("key-123");

    expect(models).toEqual([expectedLiveModel("glm-bare", "GLM Bare")]);
  });

  test("Given an api key, when fetched, then the request carries Bearer auth, Accept json, and the ZCode source headers", async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => json({ data: [] }));
    vi.stubGlobal("fetch", fetch);

    await fetchLiveModels("secret-key");

    expect(fetch).toHaveBeenCalledOnce();
    expect(String(fetch.mock.calls[0]?.[0])).toBe(LIVE_MODELS_URL);
    const headers = fetch.mock.calls[0]?.[1]?.headers;
    const parsed = new Headers(headers);
    expect(parsed.get("Authorization")).toBe("Bearer secret-key");
    expect(parsed.get("Accept")).toBe("application/json");
    const headerKeys = Object.keys(headers ?? {});
    expect(headerKeys.filter((key) => key.startsWith("X-ZCode-")).length).toBeGreaterThan(0);
    expect(headerKeys).toContain("User-Agent");
  });

  test("Given unsanitary ids or display names, when fetched, then unsafe entries drop silently and ids are never rewritten", async () => {
    const payload = {
      data: [
        { id: "keep", display_name: "Keep Me" },
        { id: "drop-ctrl\u0007", display_name: "x" },
        { id: "drop-c1\u009F" },
        { id: "   " },
        { id: "d".repeat(201) },
        { id: 42 },
        { display_name: "missing id" },
        "bare-string",
        { id: "named", display_name: "Named Model" },
        { id: "unsafe-name", display_name: "bad\u0001name" },
        { id: "nonstring-name", display_name: 7 },
        { id: "blank-name", display_name: "   " },
        { id: " spaced " },
        { id: "b".repeat(200) },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => json(payload)));

    const models = await fetchLiveModels("key-123");

    expect(models.map((model) => model.id)).toEqual([
      "keep",
      "named",
      "unsafe-name",
      "nonstring-name",
      "blank-name",
      " spaced ",
      "b".repeat(200),
    ]);
    expect(models.map((model) => model.name)).toEqual([
      "Keep Me",
      "Named Model",
      "unsafe-name",
      "nonstring-name",
      "blank-name",
      " spaced ",
      "b".repeat(200),
    ]);
  });

  test("Given a response body over 1MB, when fetched, then reading stops once the cap is crossed", async () => {
    const chunkSize = 65_536;
    const totalAvailable = LIVE_MODELS_MAX_BYTES * 3;
    const probe = { bytesPulled: 0, cancelCount: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (probe.bytesPulled >= totalAvailable) {
          controller.close();
          return;
        }
        const size = Math.min(chunkSize, totalAvailable - probe.bytesPulled);
        probe.bytesPulled += size;
        controller.enqueue(new Uint8Array(size));
      },
      cancel() {
        probe.cancelCount += 1;
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } })),
    );

    await expect(fetchLiveModels("key-123")).rejects.toBeInstanceOf(Error);
    expect(probe.bytesPulled).toBeGreaterThan(LIVE_MODELS_MAX_BYTES);
    expect(probe.bytesPulled).toBeLessThan(totalAvailable);
    expect(probe.bytesPulled).toBeLessThanOrEqual(LIVE_MODELS_MAX_BYTES + chunkSize * 2);
    expect(probe.cancelCount).toBe(1);
  });

  test("Given a non-2xx response, when fetched, then it rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "unauthorized" }, 401)));

    await expect(fetchLiveModels("key-123")).rejects.toBeInstanceOf(Error);
  });

  test("Given a non-JSON body, when fetched, then it rejects", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));

    await expect(fetchLiveModels("key-123")).rejects.toBeInstanceOf(Error);
  });

  test("Given an envelope without a model array, when fetched, then no models are returned", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ data: { id: "not-an-array" } })));

    await expect(fetchLiveModels("key-123")).resolves.toEqual([]);
  });
});
