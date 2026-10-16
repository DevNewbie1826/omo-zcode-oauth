import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";

beforeEach(() => {
  vi.stubEnv("ZCODE_DEVICE_ID", "test-device-1234");
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("model-id tests must not fetch");
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function loadGlmZcode(): { hook: (event: unknown) => unknown; config: ProviderConfig } {
  const handlers: Record<string, unknown[]> = {};
  let config: ProviderConfig | undefined;
  const pi = new Proxy({}, { get: (_t: any, p: any) => (p === "registerProvider" ? (_n: string, c: ProviderConfig) => { config = c; } : (p === "on" ? (e: string, h: any) => { (handlers[e] ??= []).push(h); } : () => undefined)) });
  glmZcodeExtension(pi as Parameters<typeof glmZcodeExtension>[0]);
  if (!config) throw new Error("not registered");
  const hook = handlers["before_provider_request"]?.[0] as ((event: unknown) => unknown) | undefined;
  if (!hook) throw new Error("before_provider_request not registered");
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
    expect(config.models?.[0]?.id).toBe("glm-5.3");
  });

  test("Given a glm-zcode payload, when the hook runs, then it returns the same payload object", () => {
    const { hook } = loadGlmZcode();
    const payload: Record<string, unknown> = { model: "glm-4.6v-flashx", messages: [] };
    const result = hook({ payload, model: { provider: "glm-zcode" } });
    expect(result).toBe(payload);
    expect(payload.model).toBe("GLM-4.6V-FlashX");
  });
});
