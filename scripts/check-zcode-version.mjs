#!/usr/bin/env node
// Compares the plugin's default ZCODE_APP_VERSION with the latest ZCode release.
// Sources: GitHub Releases (zai-org/ZCode) and the public CDN latest.yml for that tag.
// Exit codes: 0 = up to date, 1 = plugin default is behind, 2 = a source could not be read.
import { readFile } from "node:fs/promises";

const MODELS_TS = new URL("../extensions/glm-zcode/models.ts", import.meta.url);
const GITHUB_LATEST = "https://api.github.com/repos/zai-org/ZCode/releases/latest";
const CDN_LATEST_YML = (version) =>
  `https://cdn-zcode.z.ai/zcode/electron/releases/${version}/macos-arm64/latest.yml`;

function compareVersions(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

async function pluginDefaultVersion() {
  const source = await readFile(MODELS_TS, "utf8");
  const match = source.match(/process\.env\.ZCODE_APP_VERSION \|\| "([^"]+)"/);
  if (!match) throw new Error("default ZCODE_APP_VERSION not found in models.ts");
  return match[1];
}

async function latestGitHubRelease() {
  const headers = { accept: "application/vnd.github+json", "user-agent": "omo-zcode-oauth-version-check" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(GITHUB_LATEST, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const body = await res.json();
  return { version: String(body.tag_name).replace(/^v/, ""), publishedAt: body.published_at };
}

async function cdnRelease(version) {
  const res = await fetch(CDN_LATEST_YML(version), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CDN latest.yml for ${version}: HTTP ${res.status}`);
  const yml = await res.text();
  return {
    version: yml.match(/^version:\s*(\S+)/m)?.[1],
    releaseDate: yml.match(/^releaseDate:\s*'?([^'\n]+)'?/m)?.[1],
  };
}

try {
  const current = await pluginDefaultVersion();
  const github = await latestGitHubRelease();
  const cdn = await cdnRelease(github.version);
  console.log(`plugin default : ${current}`);
  console.log(`GitHub latest  : ${github.version} (published ${github.publishedAt})`);
  console.log(`CDN latest.yml : ${cdn.version ?? "?"} (releaseDate ${cdn.releaseDate ?? "?"})`);
  if (compareVersions(current, github.version) < 0) {
    console.log(`BEHIND: bump ZCODE_APP_VERSION ${current} -> ${github.version} after a protocol diff`);
    process.exit(1);
  }
  console.log("UP TO DATE");
} catch (error) {
  console.error(`check failed: ${error.message}`);
  process.exit(2);
}
