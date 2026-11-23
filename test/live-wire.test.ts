import { afterEach, describe, expect, test, vi } from "vitest";
import { normalizeContext, type Model, type Provider } from "@earendil-works/pi-ai";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";
import { resolveZCodeAnthropicBaseUrl } from "../extensions/glm-zcode/models.js";
import { resetZCodeSigningState } from "../extensions/glm-zcode/signing.js";

// Opt-in live check: LIVE_ZCODE_WIRE=1 LIVE_ZCODE_KEY="<id>.<secret>" npx vitest run test/live-wire.test.ts
// Skipped by default; under the offline gate it is compile-only and sends nothing.
const apiKey = process.env.LIVE_ZCODE_KEY ?? "";

type HeadersHook = (event: { headers: Record<string, string | null> }) => Promise<void>;

function captureProvider(): { provider: Provider; signingHook: HeadersHook } {
  const on = vi.fn();
  let provider: Provider | undefined;
  glmZcodeExtension({
    on,
    registerCommand: vi.fn(),
    registerProvider(p: Provider | string) {
      if (typeof p === "string") throw new Error("Expected native provider registration");
      provider = p;
    },
  });
  if (!provider) throw new Error("provider not registered");
  const hook: unknown = on.mock.calls.find(([name]) => name === "before_provider_headers")?.[1];
  if (typeof hook !== "function") throw new Error("before_provider_headers not registered");
  return { provider, signingHook: hook as HeadersHook };
}

// The diagnostic needs a flash model without a restore/discovery round trip: the
// cold catalog carries only glm-5.3 and glm-5.4. This fixture is the catalog row
// shape, constructed here rather than selected from the provider. It resolves the
// endpoint at run time so an explicit ZCODE_ANTHROPIC_BASE_URL governs the probe.
const flashModel: Model<"anthropic-messages"> = {
  provider: "glm-zcode",
  api: "anthropic-messages",
  baseUrl: resolveZCodeAnthropicBaseUrl(),
  id: "glm-5.3-flash",
  name: "GLM-5.3-Flash",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 131_072,
  thinkingLevelMap: { minimal: "low", low: "low", medium: "low", high: "high", xhigh: "max", max: "max" },
  compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
};

const context = normalizeContext({
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Reply with OK only." }],
      timestamp: Date.now(),
    },
  ],
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetZCodeSigningState();
});

describe.skipIf(process.env.LIVE_ZCODE_WIRE !== "1")("live wire against the ultra gateway", () => {
  test("a signed glm-zcode request completes through the native provider", async () => {
    expect(apiKey).toMatch(/^\S+\.\S+$/);

    const { provider, signingHook } = captureProvider();
    const oauth = provider.auth.oauth;
    if (!oauth) throw new Error("OAuth auth not registered");
    const auth = await oauth.toAuth({ type: "oauth", access: apiKey, refresh: "live", expires: Date.now() + 60_000 });
    const headers: Record<string, string | null> = { ...(auth.headers ?? {}) };
    await signingHook({ headers });
    const signed: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === "string") signed[key] = value;
    }
    expect(signed["X-Client-Sig"]).toMatch(/^\S+$/);
    expect(signed["X-Session-Id"]).toMatch(/^\S+$/);

    const stream = provider.streamSimple(flashModel, context, {
      apiKey,
      headers: signed,
      maxTokens: 256,
      maxRetries: 0,
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
