#!/usr/bin/env node
// Compares the plugin's default ZCODE_APP_VERSION with the latest ZCode release.
// Sources: GitHub Releases (zai-org/ZCode) and the public CDN latest.yml for that tag.
// Both sources must yield a valid version and agree with each other.
// Exit codes: 0 = up to date, 1 = plugin default is behind, 2 = a source could not be read or the sources disagree.
import { readFile } from "node:fs/promises";

const MODELS_TS = new URL("../extensions/glm-zcode/models.ts", import.meta.url);
const GITHUB_LATEST = "https://api.github.com/repos/zai-org/ZCode/releases/latest";
const CDN_LATEST_YML = (version) =>
  `https://cdn-zcode.z.ai/zcode/electron/releases/${version}/macos-arm64/latest.yml`;

const VERSION_PATTERN = /^\d+(?:\.\d+)*$/;

function normalizeVersion(raw) {
  if (typeof raw !== "string") return null;
  const value = raw.trim().replace(/^v/, "");
  return VERSION_PATTERN.test(value) ? value : null;
}

// Reads a YAML scalar the way the CDN file writes it: an optional single- or
// double-quoted value followed only by an optional comment. Plain scalars end at
// a comment that starts after whitespace; any other trailing text stays in the
// value so a version with a suffix ("4.0.0 beta") fails validation instead of
// silently matching its numeric prefix. Returns null when the field is absent or
// its scalar cannot be read unambiguously.
function parseYamlScalar(rawLine) {
  if (typeof rawLine !== "string") return null;
  const text = rawLine.trim();
  if (text.startsWith('"') || text.startsWith("'")) {
    const quote = text[0];
    let value = "";
    let index = 1;
    for (; index < text.length; index++) {
      const char = text[index];
      if (quote === '"' && char === "\\") {
        const escaped = text[index + 1];
        if (escaped === '"' || escaped === "\\") value += escaped;
        else if (escaped === "n") value += "\n";
        else if (escaped === "t") value += "\t";
        else return null;
        index += 1;
        continue;
      }
      if (char === quote) {
        if (quote === "'" && text[index + 1] === "'") {
          value += "'";
          index += 1;
          continue;
        }
        break;
      }
      value += char;
    }
    if (index >= text.length) return null;
    const rest = text.slice(index + 1);
    if (rest.trim() === "") return value;
    return /^[ \t]+#/.test(rest) ? value : null;
  }
  const commentStart = text.search(/[ \t]#/);
  const value = (commentStart === -1 ? text : text.slice(0, commentStart)).trim();
  return value === "" ? null : value;
}

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
  const versionField = yml.match(/^version:[ \t]*(.*)$/m)?.[1];
  const rawVersion = parseYamlScalar(versionField);
  const cdnVersion = normalizeVersion(rawVersion);
  if (!cdnVersion) {
    throw new Error(`CDN latest.yml for ${version}: missing or invalid version ${JSON.stringify(versionField?.trim() ?? null)}`);
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
  if (compareVersions(github.version, cdn.version) !== 0) {
    throw new Error(`release sources disagree: GitHub ${github.version}, CDN ${cdn.version}`);
  }
  const delta = compareVersions(current, github.version);
  if (delta < 0) {
    console.log(`BEHIND: bump ZCODE_APP_VERSION ${current} -> ${github.version} after a protocol diff`);
    process.exit(1);
  }
  if (delta > 0) {
    console.log(`AHEAD: plugin default ${current} is newer than release ${github.version}`);
    process.exit(0);
  }
  console.log("UP TO DATE");
} catch (error) {
  console.error(`check failed: ${error.message}`);
  process.exit(2);
}
