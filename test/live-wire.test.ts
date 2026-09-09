import { afterEach, describe, expect, test, vi } from "vitest";
import type { Context } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import type { Model } from "@earendil-works/pi-ai";
import glmZcodeExtension, { buildZCodeSourceHeaders } from "../extensions/glm-zcode/index.js";
import { resolveZCodeAnthropicBaseUrl } from "../extensions/glm-zcode/models.js";
import { resolveZCodeSigningHeaders, resetZCodeSigningState } from "../extensions/glm-zcode/signing.js";

/**
 * Live wire check against the real ultra gateway. Requires a provisioned
 * Z.AI coding-plan key and runs only when LIVE_ZCODE_WIRE=1 is set:
 *   LIVE_ZCODE_WIRE=1 LIVE_ZCODE_KEY="<id>.<secret>" npx vitest run test/live-wire.test.ts
 * It exercises the exact runtime composition: provider-registered model +
 * Bearer auth + the before_provider_headers signing hook.
 */

const apiKey = process.env.LIVE_ZCODE_KEY ?? "";

function wireModel(): Model<"anthropic-messages"> {
  return {
    provider: "glm-zcode",
    api: "anthropic-messages",
    baseUrl: resolveZCodeAnthropicBaseUrl(),
    headers: { ...buildZCodeSourceHeaders(), "X-ZCode-Agent": "glm" },
    id: "glm-5.3-flash",
    name: "GLM-5.3-Flash",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    thinkingLevelMap: { minimal: "low", low: "low", medium: "low", high: "high", xhigh: "max", max: "max" },
    compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
  } as unknown as Model<"anthropic-messages">;
}

const context = {
  tools: [],
  messages: [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "Reply with OK only." }],
      timestamp: Date.now(),
    },
  ],
} as unknown as Context;

afterEach(() => {
  vi.unstubAllEnvs();
  resetZCodeSigningState();
});

describe.skipIf(process.env.LIVE_ZCODE_WIRE !== "1")("live wire against the ultra gateway", () => {
  test("a signed glm-zcode request completes through streamSimple", async () => {
    expect(apiKey).toMatch(/^\S+\.\S+$/);

    // Mirrors ModelRuntime.applyAuth: static provider headers + Bearer auth,
    // then the before_provider_headers hook output merged on top.
    const assembled = {
      ...buildZCodeSourceHeaders(),
      "X-ZCode-Agent": "glm",
      Authorization: `Bearer ${apiKey}`,
    };
    const signed: Record<string, string> = {
      ...assembled,
      ...(await resolveZCodeSigningHeaders(assembled)),
    };
    expect(signed["X-Client-Sig"]).toMatch(/^\S+$/);

    const stream = streamSimple(wireModel(), context, {
      apiKey,
      headers: signed,
      maxTokens: 256,
    });
    const message = await stream.result();
    const content = Array.isArray(message.content) ? message.content : [];
    expect(content.length).toBeGreaterThan(0);
    const text = content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    expect(text.trim()).not.toBe("");
  }, 60_000);
});
