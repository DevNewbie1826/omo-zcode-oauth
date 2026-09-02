import { afterEach, describe, expect, test, vi } from "vitest";
import { buildZCodeSourceHeaders, osCategory } from "../extensions/glm-zcode/index.js";

const SOURCE_HEADER_KEYS = [
  "HTTP-Referer",
  "User-Agent",
  "X-Client-Language",
  "X-Client-Timezone",
  "X-Os-Category",
  "X-Os-Version",
  "X-Platform",
  "X-Release-Channel",
  "X-Title",
  "X-ZCode-Agent",
  "X-ZCode-App-Version",
] as const;

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildZCodeSourceHeaders", () => {
  test("emits the exact 11 named source headers and omits X-ZCode-Version", () => {
    const previousVersion = process.env.ZCODE_APP_VERSION;
    const previousChannel = process.env.ZCODE_RELEASE_CHANNEL;
    delete process.env.ZCODE_APP_VERSION;
    delete process.env.ZCODE_RELEASE_CHANNEL;
    try {
      const headers = buildZCodeSourceHeaders();
      expect(Object.keys(headers).sort()).toEqual([...SOURCE_HEADER_KEYS].sort());
      expect(headers).not.toHaveProperty("X-ZCode-Version");
      expect(headers["HTTP-Referer"]).toBe("https://zcode.z.ai");
      expect(headers["X-Title"]).toBe("Z Code@electron");
      expect(headers["X-ZCode-Agent"]).toBe("glm");
      expect(headers["X-Release-Channel"]).toBe("production");
      expect(headers["X-Platform"]).toBe(`${process.platform}-${process.arch}`);
      expect(headers["X-Os-Category"]).toBe(osCategory(process.platform));
    } finally {
      if (previousVersion === undefined) delete process.env.ZCODE_APP_VERSION;
      else process.env.ZCODE_APP_VERSION = previousVersion;
      if (previousChannel === undefined) delete process.env.ZCODE_RELEASE_CHANNEL;
      else process.env.ZCODE_RELEASE_CHANNEL = previousChannel;
    }
  });

  test("User-Agent defaults to ZCode/3.10.2 and X-ZCode-App-Version uses the same version", () => {
    const previous = process.env.ZCODE_APP_VERSION;
    delete process.env.ZCODE_APP_VERSION;
    try {
      const headers = buildZCodeSourceHeaders();
      expect(headers["User-Agent"]).toBe("ZCode/3.10.2");
      expect(headers["X-ZCode-App-Version"]).toBe("3.10.2");
    } finally {
      if (previous === undefined) delete process.env.ZCODE_APP_VERSION;
      else process.env.ZCODE_APP_VERSION = previous;
    }
  });

  test("honors ZCODE_APP_VERSION for User-Agent and X-ZCode-App-Version", () => {
    vi.stubEnv("ZCODE_APP_VERSION", "9.9.9");
    const headers = buildZCodeSourceHeaders();
    expect(headers["User-Agent"]).toBe("ZCode/9.9.9");
    expect(headers["X-ZCode-App-Version"]).toBe("9.9.9");
  });

  test("omits a header whose resolved value is empty", () => {
    vi.stubEnv("ZCODE_RELEASE_CHANNEL", "\u0001");
    const headers = buildZCodeSourceHeaders();
    expect(headers).not.toHaveProperty("X-Release-Channel");
  });
});

describe("osCategory", () => {
  test("maps darwin / win32 / linux", () => {
    expect(osCategory("darwin")).toBe("macos");
    expect(osCategory("win32")).toBe("windows");
    expect(osCategory("linux")).toBe("linux");
  });
});
