import { afterEach, describe, expect, test, vi } from "vitest";
import { LIVE_MODELS_MAX_BYTES, LIVE_MODELS_URL, fetchLiveModels } from "../extensions/glm-zcode/live-catalog.js";
import { ZCODE_CHAT_DEFAULTS, toChatModelConfig } from "../extensions/glm-zcode/models.js";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

/** The one row shape the live reader must produce: M's chat builder over the shared defaults. */
function expectedLiveModel(id: string, name: string) {
  return toChatModelConfig(id, name, ZCODE_CHAT_DEFAULTS);
}

/** A transport double that only answers the live catalog GET; anything else is a test bug. */
function stubCatalog(response: () => Response): ReturnType<typeof vi.fn> {
  const fetch = vi.fn(async (input: string | URL | Request) => {
    if (String(input) !== LIVE_MODELS_URL) throw new Error(`unexpected request: ${String(input)}`);
    return response();
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchLiveModels", () => {
  test("Given a {data:[...]} envelope, when fetched, then usable entries map through the typed chat builder", async () => {
    stubCatalog(() =>
      json({ data: [{ id: "glm-live-a", display_name: "GLM Live A" }, { id: "glm-live-b" }] }),
    );

    const models = await fetchLiveModels("key-123");

    expect(models).toEqual([expectedLiveModel("glm-live-a", "GLM Live A"), expectedLiveModel("glm-live-b", "glm-live-b")]);
  });

  test("Given a bare array envelope, when fetched, then usable entries map the same way", async () => {
    stubCatalog(() => json([{ id: "glm-bare", display_name: "GLM Bare" }]));

    const models = await fetchLiveModels("key-123");

    expect(models).toEqual([expectedLiveModel("glm-bare", "GLM Bare")]);
  });

  test("Given safe display names, when fetched, then each name is preserved byte-for-byte", async () => {
    const names = ["GLM-5.4", "GLM-5.3-FlashX-Legal", "  padded name  ", "GLM 비전 preview", "glm lowercase"];
    stubCatalog(() =>
      json({ data: names.map((name, index) => ({ id: `glm-${index}`, display_name: name })) }),
    );

    const models = await fetchLiveModels("key-123");

    expect(models.map((model) => model.name)).toEqual(names);
    expect(models.map((model) => model.id)).toEqual(["glm-0", "glm-1", "glm-2", "glm-3", "glm-4"]);
  });

  test("Given a 5.4 live row, when fetched, then it keeps the shared text-only defaults (no image override)", async () => {
    stubCatalog(() => json({ data: [{ id: "glm-5.4", display_name: "GLM-5.4" }] }));

    const [model] = await fetchLiveModels("key-123");

    expect(model).toEqual(expectedLiveModel("glm-5.4", "GLM-5.4"));
    expect(model?.input).toEqual(["text"]);
    expect(model?.contextWindow).toBe(1_000_000);
    expect(model?.maxTokens).toBe(131_072);
    expect(model?.reasoning).toBe(true);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("Given an api key, when fetched, then the request carries Bearer auth, Accept json, and the ZCode source headers", async () => {
    const fetch = stubCatalog(() => json({ data: [] }));

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

  test("Given unsanitary ids or display names, when fetched, then unsafe entries drop silently and names fall back to the id", async () => {
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
    stubCatalog(() => json(payload));

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
    for (const [index, model] of models.entries()) {
      const unsafeName = index >= 2;
      if (unsafeName) expect(model.name).toBe(model.id);
    }
  });

  test("Given a 200 error-only envelope, when fetched, then it rejects instead of returning rows", async () => {
    stubCatalog(() => json({ error: { code: 1210, message: "invalid api key" } }));

    await expect(fetchLiveModels("key-123")).rejects.toThrow(/error envelope/);
  });

  test("Given a recognized error envelope beside data rows, when fetched, then every error shape rejects instead of trusting the rows", async () => {
    const rows = [{ id: "not-an-entitlement" }];
    const error = { code: 1210, message: "invalid api key" };
    const shapes: unknown[] = [
      { success: false, code: 401, data: rows },
      { type: "error", error, data: rows },
      { type: "error", data: rows },
      { error, data: rows },
      { error: "invalid api key", data: rows },
    ];

    for (const shape of shapes) {
      stubCatalog(() => json(shape));

      await expect(fetchLiveModels("key-123"), JSON.stringify(shape)).rejects.toThrow(/error envelope/);
    }
  });

  test("Given the success and bare-array shapes, when fetched, then their rows are still accepted", async () => {
    const rows = [{ id: "entitled" }];
    const shapes: unknown[] = [{ success: true, data: rows }, { type: "success", data: rows }, rows];

    for (const shape of shapes) {
      stubCatalog(() => json(shape));

      const models = await fetchLiveModels("key-123");
      expect(models.map((model) => model.id), JSON.stringify(shape)).toEqual(["entitled"]);
    }
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
    stubCatalog(() => new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }));

    await expect(fetchLiveModels("key-123")).rejects.toBeInstanceOf(Error);
    expect(probe.bytesPulled).toBeGreaterThan(LIVE_MODELS_MAX_BYTES);
    expect(probe.bytesPulled).toBeLessThan(totalAvailable);
    expect(probe.bytesPulled).toBeLessThanOrEqual(LIVE_MODELS_MAX_BYTES + chunkSize * 2);
    expect(probe.cancelCount).toBe(1);
  });

  test("Given a caller signal aborted mid-flight, when fetched, then the request signal aborts with the caller reason", async () => {
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== LIVE_MODELS_URL) throw new Error(`unexpected request: ${String(input)}`);
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetch);

    const controller = new AbortController();
    const pending = fetchLiveModels("key-123", controller.signal);
    const reason = new DOMException("caller aborted", "AbortError");
    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(requestSignal?.aborted).toBe(true);
  });

  test("Given an already-aborted caller signal, when fetched, then it rejects without issuing a request", async () => {
    const fetch = stubCatalog(() => json({ data: [{ id: "should-not-arrive" }] }));
    const controller = new AbortController();
    const reason = new DOMException("caller aborted early", "AbortError");
    controller.abort(reason);

    await expect(fetchLiveModels("key-123", controller.signal)).rejects.toBe(reason);
  });

  test("Given a non-2xx response, when fetched, then it rejects", async () => {
    stubCatalog(() => json({ error: "unauthorized" }, 401));

    await expect(fetchLiveModels("key-123")).rejects.toBeInstanceOf(Error);
  });

  test("Given a non-2xx response with an open body, when fetched, then it rejects and cancels the body", async () => {
    const probe = { cancelCount: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Stays open until the reader cancels, like a stalled error response.
      },
      cancel() {
        probe.cancelCount += 1;
      },
    });
    stubCatalog(() => new Response(body, { status: 503 }));

    await expect(fetchLiveModels("key-123")).rejects.toThrow(/503/);
    expect(probe.cancelCount).toBe(1);
  });

  test("Given a non-JSON body, when fetched, then it rejects", async () => {
    stubCatalog(() => new Response("not-json", { status: 200 }));

    await expect(fetchLiveModels("key-123")).rejects.toBeInstanceOf(Error);
  });

  test("Given an envelope without a model array, when fetched, then no models are returned", async () => {
    stubCatalog(() => json({ data: { id: "not-an-array" } }));

    await expect(fetchLiveModels("key-123")).resolves.toEqual([]);
  });
});
