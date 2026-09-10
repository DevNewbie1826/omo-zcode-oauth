import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderConfig } from "@code-yeongyu/senpi";
import glmZcodeExtension from "../extensions/glm-zcode/index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("session id unification", () => {
  test("metadata.session_id is a bare uuid (no omo-offpeak prefix)", async () => {
    vi.stubEnv("ZCODE_DEVICE_ID", "dev-1");
    const handlers: Record<string, unknown[]> = {};
    let config: ProviderConfig | undefined;
    const pi = new Proxy(
      {},
      {
        get: (_t: unknown, p: string) =>
          p === "registerProvider"
            ? (_n: string, c: ProviderConfig) => {
                config = c;
              }
            : (event: string, handler: unknown) => {
                (handlers[event] ??= []).push(handler);
              },
      },
    );
    glmZcodeExtension(pi as Parameters<typeof glmZcodeExtension>[0]);
    const hook = handlers["before_provider_request"]?.[0] as (event: unknown) => unknown;
    expect(hook).toBeTypeOf("function");
    const payload: Record<string, unknown> = { model: "glm-5.3-flash", messages: [] };
    hook({ payload, model: { provider: "glm-zcode" } });
    const meta = JSON.parse((payload.metadata as { user_id: string }).user_id) as { session_id: string };
    expect(meta.session_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(meta.session_id.includes("omo-offpeak")).toBe(false);
  });
});
