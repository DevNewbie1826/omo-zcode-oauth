import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

test("the senpi loader registers GLM ZCode from a Git-install-shaped copy without devDependencies", async () => {
  const home = await mkdtemp(join(tmpdir(), "glm-loader-"));
  const checkout = join(home, "checkout");
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    await cp(join(root, "extensions"), join(checkout, "extensions"), { recursive: true });
    await cp(join(root, "package.json"), join(checkout, "package.json"));
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval", `
      import { join } from "node:path";
      const [checkout] = process.argv.slice(1);
      const loader = new URL("./core/extensions/loader.js", import.meta.resolve("@code-yeongyu/senpi"));
      process.chdir(checkout);
      let attempts = 0;
      globalThis.fetch = async () => { attempts++; throw new Error("Unexpected fetch during extension load"); };
      const { loadExtensions } = await import(loader.href);
      const result = await loadExtensions([join(checkout, "extensions/glm-zcode/index.ts")], checkout);
      console.log(JSON.stringify({
        loaded: result.extensions.length,
        errors: result.errors,
        providers: result.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider.id),
        attempts,
      }));
    `, checkout], {
      cwd: root,
      env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home,
        PI_CODING_AGENT_DIR: home, PI_AGENT_DIR: home, OMO_CONFIG_DIR: home, OFFLINE: "",
        JITI_FS_CACHE: "false", ZCODE_DEVICE_ID: "loader-fixture" },
    });
    expect(JSON.parse(stdout.trim())).toEqual({ loaded: 1, errors: [], providers: ["glm-zcode"], attempts: 0 });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
