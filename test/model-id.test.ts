import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Provider, ModelsStoreEntry, RefreshModelsContext } from "@earendil-works/pi-ai";
import { LIVE_MODELS_URL } from "../extensions/glm-zcode/live-catalog.js";
import { MODELS_DEV_API_URL } from "../extensions/glm-zcode/models.js";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.UTC(2026, 10, 23));
  vi.stubEnv("OFFLINE", undefined);
  vi.stubEnv("ZCODE_OFFPEAK_ENABLE", undefined);
  vi.stubEnv("ZCODE_ANTHROPIC_BASE_URL", undefined);
  vi.stubEnv("ZCODE_APP_VERSION", "4.0.0");
  vi.stubEnv("ZCODE_RELEASE_CHANNEL", "production");
  vi.stubEnv("ZCODE_DEVICE_ID", "test-device-1234");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("model-id tests must not fetch");
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function loadGlmZcode() {
  const on = vi.fn();
  let config: Provider | undefined;
  glmZcodeExtension({ on, registerCommand: vi.fn(), registerProvider(p) {
    if (typeof p === "string") throw new Error("Expected native provider");
    config = p;
  } });
  if (!config) throw new Error("not registered");
  const hook = on.mock.calls.find(([name]) => name === "before_provider_request")?.[1];
  if (typeof hook !== "function") throw new Error("before_provider_request not registered");
  return { hook, config };
}

describe("official GLM model id on the wire", () => {
  test.each([
    ["glm-5.3", "GLM-5.3"],
    ["glm-5.3-flash", "GLM-5.3-Flash"],
    ["glm-4.5-air", "GLM-4.5-Air"],
    ["glm-4.1v-thinking-flashx", "GLM-4.1V-Thinking-FlashX"],
    ["GLM-5.3", "GLM-5.3"],
  ])("Given model %s, when the glm-zcode hook runs, then the wire spelling is %s", (input, official) => {
    const { hook } = loadGlmZcode();
    const payload: Record<string, unknown> = { model: input, messages: [] };
    const result = hook({ payload, model: { provider: "glm-zcode" } });
    expect(payload.model).toBe(official);
    expect(result).toBe(payload);
  });

  test.each(["glm-5.3-flashx", "some-custom-model"])(
    "Given unknown model %s, when the glm-zcode hook runs, then it passes through unchanged",
    (input) => {
      const { hook } = loadGlmZcode();
      const payload: Record<string, unknown> = { model: input, messages: [] };
      hook({ payload, model: { provider: "glm-zcode" } });
      expect(payload.model).toBe(input);
    },
  );

  test.each([
    ["glm-5.3", "GLM-5.3"],
    ["glm-4.5-air", "GLM-4.5-Air"],
  ])(
    "Given model %s and preset metadata.user_id, when the glm-zcode hook runs, then the wire spelling is %s and metadata stays keep",
    (input, official) => {
      const { hook } = loadGlmZcode();
      const payload: Record<string, unknown> = { model: input, metadata: { user_id: "keep" } };
      const result = hook({ payload, model: { provider: "glm-zcode" } });
      expect(payload.model).toBe(official);
      expect((payload.metadata as { user_id: string }).user_id).toBe("keep");
      expect(result).toBe(payload);
    },
  );

  test("Given a foreign openai payload, when the hook runs, then glm-5.3 is untouched", () => {
    const { hook } = loadGlmZcode();
    const payload: Record<string, unknown> = { model: "glm-5.3", messages: [] };
    hook({ payload, model: { provider: "openai" } });
    expect(payload).toEqual({ model: "glm-5.3", messages: [] });
  });

  test("Given the provider is registered, when inspected, then the static model id is still glm-5.3", () => {
    const { config } = loadGlmZcode();
    expect(config.getModels().map(m => m.id)).toContain("glm-5.3");
  });

  test("Given a glm-zcode payload, when the hook runs, then it returns the same payload object", () => {
    const { hook } = loadGlmZcode();
    const payload: Record<string, unknown> = { model: "glm-4.6v-flashx", messages: [] };
    const result = hook({ payload, model: { provider: "glm-zcode" } });
    expect(result).toBe(payload);
    expect(payload.model).toBe("GLM-4.6V-FlashX");
  });
});

test("live and offline-restored catalogs supply only matching wire spellings to the hook", async () => {
  const live = loadGlmZcode();
  function wire(ext: ReturnType<typeof loadGlmZcode>, id: string) {
    const payload = { model: id, metadata: { user_id: "original" } };
    expect(ext.hook({ payload, model: { provider: "glm-zcode" } })).toBe(payload);
    expect(payload.metadata.user_id).toBe("original");
    return payload.model;
  }
  expect(wire(live, "glm-5.4")).toBe("glm-5.4");
  expect(wire(live, "glm-5v-turbo")).toBe("GLM-5V-Turbo");
  const rows = [
    ["glm-5.4", "GLM-5.4"], ["glm-future", "GLM-Future"],
    ["glm-friendly", "Vision preview"], ["glm-5.3-flashx", "GLM-5.3-FlashX"],
  ];
  const fetch = vi.fn(async (url: RequestInfo | URL) => {
    if (String(url) === LIVE_MODELS_URL) return Response.json(rows.map(([id, display_name]) => ({ id, display_name })));
    if (String(url) === MODELS_DEV_API_URL) return Response.json({});
    throw new Error("Unexpected catalog URL");
  });
  vi.stubGlobal("fetch", fetch);
  let stored: ModelsStoreEntry | undefined;
  const publish: RefreshModelsContext["publish"] = async p => {
    if (p.persist) stored = structuredClone(p.persist);
    p.update?.();
    return true;
  };
  const signal = new AbortController().signal;
  await live.config.refreshModels?.({ signal, publish, allowNetwork: true, credential: { type: "api_key", key: "test" } });
  const restored = loadGlmZcode();
  await restored.config.refreshModels?.({ signal, publish, stored, allowNetwork: false });
  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([LIVE_MODELS_URL, MODELS_DEV_API_URL]);
  for (const ext of [live, restored]) {
    expect(ext.config.getModels().map(m => m.id)).toEqual(rows.map(([id]) => id));
    for (const [id, expected] of [["glm-5.4", "GLM-5.4"], ["glm-future", "GLM-Future"],
      ["glm-friendly", "glm-friendly"], ["unknown", "unknown"], ["GLM-5.3-FlashX", "glm-5.3-flashx"]]) {
      expect(wire(ext, id)).toBe(expected);
    }
  }
});
