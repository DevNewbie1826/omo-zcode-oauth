#!/usr/bin/env node
// Compares the plugin's default ZCODE_APP_VERSION with the latest ZCode release.
// Sources: GitHub Releases (zai-org/ZCode) and the public CDN latest.yml for that tag.
// Both sources must yield a valid version and agree with each other.
// Exit codes: 0 = up to date, 1 = plugin default is behind, 2 = a source could not be read, the sources disagree,
// or the plugin default is ahead of the latest release.
import { readFile } from "node:fs/promises";

const MODELS_TS = new URL("../extensions/glm-zcode/models.ts", import.meta.url);
const GITHUB_LATEST = "https://api.github.com/repos/zai-org/ZCode/releases/latest";
const CDN_LATEST_YML = (version) =>
  `https://cdn-zcode.z.ai/zcode/electron/releases/${version}/macos-arm64/latest.yml`;

const VERSION_PATTERN = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*$/;

function normalizeVersion(raw) {
  if (typeof raw !== "string") return null;
  // No trimming: any surrounding character (including Unicode spaces) makes the version unreadable.
  const value = raw.replace(/^v/, "");
  return VERSION_PATTERN.test(value) ? value : null;
}

// latest.yml is not parsed as YAML. The checker needs exactly one column-0
// line `version: X.Y.Z` (optionally quoted); none or several exit 2. The value
// must also equal the GitHub release tag, and the file is fetched from that
// tag's own release directory, so a malformed or unusual document can only
// produce exit 2 or a version the GitHub release independently confirms.
const VERSION_LINE = /^version: ?(['"]?)(\d+\.\d+\.\d+)\1[ \t]*\r?$/gm;

function readVersionLine(yml) {
  const matches = [...yml.matchAll(VERSION_LINE)];
  return matches.length === 1 ? matches[0][2] : null;
}

function compareVersions(a, b) {
  // BigInt components: large numbers must not round to equal values.
  const pa = a.split(".").map(BigInt);
  const pb = b.split(".").map(BigInt);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0n;
    const y = pb[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

async function pluginDefaultVersion() {
  const source = await readFile(MODELS_TS, "utf8");
  const match = source.match(/process\.env\.ZCODE_APP_VERSION \|\| "([^"]+)"/);
  if (!match) throw new Error("default ZCODE_APP_VERSION not found in models.ts");
  const version = normalizeVersion(match[1]);
  if (!version) throw new Error(`default ZCODE_APP_VERSION is not a valid version: ${match[1]}`);
  return version;
}

async function latestGitHubRelease() {
  const headers = { accept: "application/vnd.github+json", "user-agent": "omo-zcode-oauth-version-check" };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const res = await fetch(GITHUB_LATEST, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`GitHub releases: HTTP ${res.status}`);
  const body = await res.json();
  const version = normalizeVersion(body?.tag_name);
  if (!version) throw new Error(`GitHub releases: missing or invalid tag_name ${JSON.stringify(body?.tag_name)}`);
  return { version, publishedAt: body.published_at };
}

async function cdnRelease(version) {
  const res = await fetch(CDN_LATEST_YML(version), { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`CDN latest.yml for ${version}: HTTP ${res.status}`);
  const yml = await res.text();
  const cdnVersion = readVersionLine(yml);
  if (!cdnVersion) {
    throw new Error(`CDN latest.yml for ${version}: no single \"version: X.Y.Z\" line`);
  }
  return {
    version: cdnVersion,
    releaseDate: yml.match(/^releaseDate:\s*'?([^'\n]+)'?/m)?.[1],
  };
}

try {
  const current = await pluginDefaultVersion();
  const github = await latestGitHubRelease();
  const cdn = await cdnRelease(github.version);
  console.log(`plugin default : ${current}`);
  console.log(`GitHub latest  : ${github.version} (published ${github.publishedAt ?? "?"})`);
  console.log(`CDN latest.yml : ${cdn.version} (releaseDate ${cdn.releaseDate ?? "?"})`);
  if (cdn.version !== github.version) {
    throw new Error(`release sources disagree: GitHub ${github.version}, CDN ${cdn.version}`);
  }
  const delta = compareVersions(current, github.version);
  if (delta < 0) {
    console.log(`BEHIND: bump ZCODE_APP_VERSION ${current} -> ${github.version} after a protocol diff`);
    process.exit(1);
  }
  if (delta > 0) {
    console.log(`AHEAD: plugin default ${current} is newer than release ${github.version}`);
    process.exit(2);
  }
  if (current !== github.version) {
    throw new Error(`plugin default ${current} and release ${github.version} are equal only after normalization`);
  }
  console.log("UP TO DATE");
} catch (error) {
  console.error(`check failed: ${error.message}`);
  process.exit(2);
}
