import type { ProviderModelConfig } from "@code-yeongyu/senpi";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  CATALOG_PROVIDER,
  MODELS_DEV_API_URL,
  MODELS_DEV_FALLBACK_PROVIDER,
  ZCODE_CHAT_DEFAULTS,
  catalogToPersistedModels,
  catalogWireName,
  chatModelConfig,
  fetchModelsDevPayload,
  mergeChatMetadata,
  parseModelsDevMetadata,
  storedToConfig,
  zcodeFallbackChatModels,
} from "../extensions/glm-zcode/models.js";

const THINKING = {
  minimal: "low",
  low: "low",
  medium: "low",
  high: "high",
  xhigh: "max",
  max: "max",
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function liveRow(id: string, name: string): ProviderModelConfig {
  return {
    id,
    name,
    reasoning: ZCODE_CHAT_DEFAULTS.reasoning,
    input: [...ZCODE_CHAT_DEFAULTS.input],
    cost: { ...ZERO_COST },
    contextWindow: ZCODE_CHAT_DEFAULTS.contextWindow,
    maxTokens: ZCODE_CHAT_DEFAULTS.maxTokens,
    thinkingLevelMap: { ...THINKING },
    compat: { supportsDisabledThinking: false, forceAdaptiveThinking: true },
  };
}

const conflictingMetadata = {
  [CATALOG_PROVIDER]: {
    models: {
      "glm-5.4": {
        name: "Coding Plan Five Four",
        reasoning: false,
        limit: { context: 200_000, output: 8_192 },
        modalities: { input: ["text", "image", "video", "pdf"] },
      },
      "glm-plan-only": {
        name: "Plan Only",
        reasoning: true,
        limit: { context: 500_000, output: 16_384 },
        modalities: { input: ["text"] },
      },
    },
  },
  [MODELS_DEV_FALLBACK_PROVIDER]: {
    models: {
      "glm-5.4": {
        name: "Zai Five Four",
        reasoning: true,
        limit: { context: 999_999, output: 65_536 },
        modalities: { input: ["text"] },
      },
      "glm-zai-only": {
        name: "Zai Only",
        reasoning: false,
        limit: { context: 131_072, output: 4_096 },
        modalities: { input: ["text", "image"] },
      },
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseModelsDevMetadata", () => {
  test("an id present in both dev sections keeps the coding-plan row", () => {
    const metadata = parseModelsDevMetadata(conflictingMetadata);

    expect(metadata.get("glm-5.4")).toEqual({
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
  });

  test("an id only in the fallback section keeps that section's row", () => {
    const metadata = parseModelsDevMetadata(conflictingMetadata);

    expect(metadata.get("glm-zai-only")).toEqual({
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 131_072,
      maxTokens: 4_096,
    });
    expect(metadata.has("glm-plan-only")).toBe(true);
  });

  test("video and pdf modalities are dropped while text and image survive", () => {
    const metadata = parseModelsDevMetadata(conflictingMetadata);

    expect(metadata.get("glm-5.4")?.input).toEqual(["text", "image"]);
  });

  test("malformed payloads and rows yield no metadata", () => {
    expect(parseModelsDevMetadata(undefined).size).toBe(0);
    expect(parseModelsDevMetadata([]).size).toBe(0);
    expect(parseModelsDevMetadata({ [CATALOG_PROVIDER]: { models: { broken: { limit: { output: 1 } } } } }).size).toBe(0);
  });

  test("an incomplete primary row leaves absent fields for the fallback section to state", () => {
    const metadata = parseModelsDevMetadata({
      [CATALOG_PROVIDER]: { models: { future: { limit: { context: 99 } } } },
      [MODELS_DEV_FALLBACK_PROVIDER]: {
        models: { future: { reasoning: true, limit: { context: 8_000, output: 400 }, modalities: { input: ["text", "image"] } } },
      },
    });

    expect(metadata.get("future")).toEqual({
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 99,
      maxTokens: 400,
    });
  });

  test("an explicit false in the primary row is not replaced by a fallback true", () => {
    const metadata = parseModelsDevMetadata({
      [CATALOG_PROVIDER]: { models: { future: { reasoning: false, limit: { context: 99 } } } },
      [MODELS_DEV_FALLBACK_PROVIDER]: { models: { future: { reasoning: true } } },
    });

    expect(metadata.get("future")?.reasoning).toBe(false);
  });

  test("a row that states no reasoning carries no reasoning field", () => {
    const metadata = parseModelsDevMetadata({
      [CATALOG_PROVIDER]: { models: { future: { limit: { context: 99 } } } },
    });

    expect(metadata.has("future")).toBe(true);
    expect(metadata.get("future")?.reasoning).toBeUndefined();
  });
});

describe("mergeChatMetadata", () => {
  test("metadata supplies input, context, output and reasoning while the live id and name stay authoritative", () => {
    const metadata = parseModelsDevMetadata(conflictingMetadata);

    const merged = mergeChatMetadata([liveRow("glm-5.4", "GLM-5.4"), liveRow("glm-zai-only", "GLM Zai Only")], metadata);

    expect(merged[0]).toMatchObject({
      id: "glm-5.4",
      name: "GLM-5.4",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: false,
    });
    expect(merged[0]?.name).not.toBe("Coding Plan Five Four");
    expect(merged[1]).toMatchObject({
      id: "glm-zai-only",
      name: "GLM Zai Only",
      input: ["text", "image"],
      contextWindow: 131_072,
      maxTokens: 4_096,
      reasoning: false,
    });
  });

  test("rows without metadata keep their own values, so 5.4 stays text-only by default", () => {
    const merged = mergeChatMetadata([liveRow("glm-5.4", "GLM-5.4")], new Map());

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      input: ["text"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      reasoning: true,
    });
  });

  test("missing reasoning metadata does not override the live default or suppress secondary data", () => {
    const metadata = parseModelsDevMetadata({
      [CATALOG_PROVIDER]: { models: { future: { limit: { context: 99 } } } },
      [MODELS_DEV_FALLBACK_PROVIDER]: {
        models: { future: { reasoning: true, limit: { context: 8_000, output: 400 }, modalities: { input: ["text", "image"] } } },
      },
    });

    const [merged] = mergeChatMetadata([liveRow("future", "Future")], metadata);

    expect(merged).toMatchObject({
      id: "future",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 99,
      maxTokens: 400,
    });
  });

  test("when no source states reasoning, the live default survives instead of a manufactured false", () => {
    const metadata = parseModelsDevMetadata({
      [CATALOG_PROVIDER]: { models: { future: { limit: { context: 99 } } } },
    });

    const [merged] = mergeChatMetadata([liveRow("future", "Future")], metadata);

    expect(merged).toMatchObject({ reasoning: true, contextWindow: 99, maxTokens: 131_072, input: ["text"] });
  });

  test("an explicit false in metadata still wins over the live default", () => {
    const metadata = parseModelsDevMetadata({
      [CATALOG_PROVIDER]: { models: { future: { reasoning: false, limit: { context: 99 } } } },
    });

    const [merged] = mergeChatMetadata([liveRow("future", "Future")], metadata);

    expect(merged?.reasoning).toBe(false);
  });

  test("non-chat rows are skipped", () => {
    const imageRow: ProviderModelConfig = {
      type: "image",
      id: "glm-image",
      name: "GLM Image",
      input: ["text"],
      output: ["image"],
      cost: { ...ZERO_COST },
    };

    const merged = mergeChatMetadata([imageRow, liveRow("glm-5.4", "GLM-5.4")], new Map());

    expect(merged.map((row) => row.id)).toEqual(["glm-5.4"]);
    expect(chatModelConfig(imageRow)).toBe(false);
    expect(chatModelConfig(liveRow("legacy", "Legacy"))).toBe(true);
  });
});

describe("fetchModelsDevPayload", () => {
  test("reads the models.dev catalog once through the documented URL", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      if (String(input) !== MODELS_DEV_API_URL) throw new Error(`unexpected request: ${String(input)}`);
      return json(conflictingMetadata);
    });
    vi.stubGlobal("fetch", fetch);

    const metadata = parseModelsDevMetadata(await fetchModelsDevPayload());

    expect(fetch).toHaveBeenCalledOnce();
    expect(metadata.get("glm-5.4")?.contextWindow).toBe(200_000);
  });

  test("a non-2xx response rejects so the caller can degrade", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== MODELS_DEV_API_URL) throw new Error(`unexpected request: ${String(input)}`);
      return json({ error: "unavailable" }, 503);
    }));

    await expect(fetchModelsDevPayload()).rejects.toThrow(/503/);
  });

  test("a non-2xx response with an open body rejects and cancels the body", async () => {
    const probe = { cancelCount: 0 };
    const body = new ReadableStream<Uint8Array>({
      pull() {
        // Stays open until the reader cancels, like a stalled error response.
      },
      cancel() {
        probe.cancelCount += 1;
      },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) !== MODELS_DEV_API_URL) throw new Error(`unexpected request: ${String(input)}`);
      return new Response(body, { status: 503 });
    }));

    await expect(fetchModelsDevPayload()).rejects.toThrow(/503/);
    expect(probe.cancelCount).toBe(1);
  });
});

describe("canonical chat rows", () => {
  test("fallback rows are 5.3 text and 5.4 text/image at zero cost", () => {
    const fallback = zcodeFallbackChatModels();

    expect(fallback.map((row) => row.id).sort()).toEqual(["glm-5.3", "glm-5.4"]);
    const fiveFour = fallback.find((row) => row.id === "glm-5.4");
    expect(fiveFour).toMatchObject({
      name: "GLM-5.4",
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      cost: { ...ZERO_COST },
    });
    expect(fallback.every((row) => row.input.every((entry) => entry === "text" || entry === "image"))).toBe(true);
  });

  test("a merged list serializes and restores to the same canonical rows", () => {
    const metadata = parseModelsDevMetadata(conflictingMetadata);
    const merged = mergeChatMetadata([liveRow("glm-5.4", "GLM-5.4")], metadata);

    const persisted = catalogToPersistedModels(merged);

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      provider: "glm-zcode",
      api: "anthropic-messages",
      id: "glm-5.4",
      name: "GLM-5.4",
      input: ["text", "image"],
      contextWindow: 200_000,
      maxTokens: 8_192,
      reasoning: false,
    });
    expect(storedToConfig({ models: persisted })).toEqual(merged);
  });

  test("restore drops foreign-provider and non-chat rows", () => {
    const own = catalogToPersistedModels([liveRow("glm-5.4", "GLM-5.4")]);
    const foreign = { ...own[0]!, provider: "zai", id: "glm-foreign" };
    const image = { ...own[0]!, id: "glm-image", type: "image" as const, output: ["image" as const] };

    const restored = storedToConfig({ models: [foreign, image, ...own] });

    expect(restored.map((row) => row.id)).toEqual(["glm-5.4"]);
  });

  test("the wire name derives from case-only matches and never adopts a friendly name", () => {
    expect(catalogWireName("glm-5.4", "GLM-5.4")).toBe("GLM-5.4");
    expect(catalogWireName("glm-5.3-flashx", "GLM-5.3-FlashX")).toBe("GLM-5.3-FlashX");
    expect(catalogWireName("glm-x", "Vision preview")).toBe("glm-x");
    expect(catalogWireName("glm-x", undefined)).toBe("glm-x");
  });
});
