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

const VERSION_KEY_LINE = /^version:(?:[ \t]|$)/;

function isIndented(line) {
  return line.startsWith(" ") || line.startsWith("\t");
}

// electron-builder writes latest.yml as one plain block mapping: identifier
// keys at column 0, plain or quoted scalars, nested block collections and
// `|`/`>` block scalars. Any other shape (a flow collection, an anchor, alias
// or tag, a quoted or non-identifier root key, content on a document marker)
// is refused rather than interpreted: guessing which nested scalar belongs to
// the root is how a nested file "version" used to win.
const ROOT_KEY_LINE = /^[A-Za-z_][A-Za-z0-9_-]*:(?:[ \t]|$)/;
const BLOCK_SCALAR_START = /:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$/;
const UNSUPPORTED_SYNTAX = /[{}\[\]&*!]/;
const INDENTED_ENTRY = /^[ \t]+(?:-(?:[ \t]|$)|[A-Za-z_][A-Za-z0-9_-]*:(?:[ \t]|$))/;

// Accepts only the line shapes electron-builder writes, for the whole document:
// comments, identifier keys at column 0, indented `key:` or `- ` entries, and
// opaque `|`/`>` block-scalar text. Every quoted value must close on its own
// line. A document that starts indented, has a document marker, a continued or
// unterminated quoted value, or any other line is refused, so the checker never
// reads a version out of a document a YAML parser would reject or read differently.
function hasSupportedShape(lines) {
  let blockScalarIndent = -1;
  let seenEntry = false;
  for (const line of lines) {
    if (/^[ \t]*$/.test(line)) continue;
    const indent = /^[ \t]*/.exec(line)[0].length;
    if (blockScalarIndent >= 0) {
      if (indent > blockScalarIndent) continue;
      blockScalarIndent = -1;
    }
    if (/^[ \t]*#/.test(line)) continue;
    if (!seenEntry && indent > 0) return false;
    seenEntry = true;
    if (UNSUPPORTED_SYNTAX.test(line.replace(/[ \t]#.*$/, ""))) return false;
    if (indent === 0 ? !ROOT_KEY_LINE.test(line) : !INDENTED_ENTRY.test(line)) return false;
    let rest = line.slice(indent);
    if (rest.startsWith("-")) rest = rest.slice(1).replace(/^[ \t]+/, "");
    const keyed = /^[A-Za-z_][A-Za-z0-9_-]*:(.*)$/.exec(rest);
    const value = (keyed ? keyed[1] : rest).replace(/^[ \t]+/, "");
    if ((value.startsWith("'") || value.startsWith('"')) && readQuotedScalar([value]) === null) return false;
    if (BLOCK_SCALAR_START.test(line)) blockScalarIndent = indent;
  }
  return seenEntry;
}

// Reads the document's top-level "version" entry as one YAML scalar: the text
// after the key, then every indented continuation line, folded the way YAML
// folds it. Returns null when the document has no such key, has more than one
// (ambiguous), or writes the entry so the checker cannot prove it is a key at
// all: "version:4.0.0" and "version:\"4.0.0\"" are plain scalars, not mappings.
function readVersionField(yml) {
  const lines = yml.split(/\r?\n/);
  if (!hasSupportedShape(lines)) return null;
  // In a supported document every column-0 line is a root key; block-scalar text is indented.
  const keyIndexes = [];
  for (let index = 0; index < lines.length; index++) {
    if (VERSION_KEY_LINE.test(lines[index])) keyIndexes.push(index);
  }
  if (keyIndexes.length !== 1) return null;
  return readScalarValue(entryParts(lines, keyIndexes[0], "version:".length));
}

// The value text of the root entry at keyIndex plus its indented continuation lines.
function entryParts(lines, keyIndex, valueStart) {
  const parts = [lines[keyIndex].slice(valueStart)];
  for (let index = keyIndex + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line !== "" && !isIndented(line)) break;
    parts.push(line);
  }
  return parts;
}

function readScalarValue(parts) {
  let start = 0;
  while (start < parts.length && parts[start].trim() === "") start++;
  if (start === parts.length) return null;
  const body = parts.slice(start);
  const first = body[0].trim();
  if (first.startsWith('"') || first.startsWith("'")) return readQuotedScalar(body);
  return readPlainScalar(body);
}

// A quoted scalar runs to its closing quote; an indented line break inside it
// folds to a space and a blank line inside it to a newline. Anything after the
// closing quote other than a comment makes the field unreadable.
function readQuotedScalar(parts) {
  const quote = parts[0].trim()[0];
  let value = null;
  let fold = " ";
  for (let lineIndex = 0; lineIndex < parts.length; lineIndex++) {
    const text = lineIndex === 0 ? parts[0].trim() : parts[lineIndex].trim();
    if (lineIndex > 0) {
      if (text === "") {
        if (value !== null) fold = "\n";
        continue;
      }
      if (value !== null) value += fold;
      fold = " ";
    }
    if (value === null) value = "";
    for (let index = lineIndex === 0 ? 1 : 0; index < text.length; index++) {
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
      if (char !== quote) {
        value += char;
        continue;
      }
      if (quote === "'" && text[index + 1] === "'") {
        value += "'";
        index += 1;
        continue;
      }
      const rest = text.slice(index + 1);
      if (rest !== "" && !/^[ \t]+#/.test(rest)) return null;
      for (let tail = lineIndex + 1; tail < parts.length; tail++) {
        const extra = parts[tail].trim();
        if (extra !== "" && !extra.startsWith("#")) return null;
      }
      return value;
    }
  }
  return null;
}

// A plain scalar joins its indented continuation lines with a space and keeps a
// blank line as a newline (so a value split over lines keeps its suffix and
// fails validation). It ends at a comment that starts after whitespace;
// "4.0.0#generated" is one token and fails too.
function readPlainScalar(parts) {
  let value = null;
  let fold = " ";
  for (const part of parts) {
    const text = part.trim();
    if (text === "" || text.startsWith("#")) {
      if (value !== null) fold = "\n";
      continue;
    }
    const commentStart = text.search(/[ \t]#/);
    const content = (commentStart === -1 ? text : text.slice(0, commentStart)).trim();
    if (content === "") break;
    value = value === null ? content : value + fold + content;
    fold = " ";
    if (commentStart !== -1) break;
  }
  return value;
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
  const rawVersion = readVersionField(yml);
  const cdnVersion = normalizeVersion(rawVersion);
  if (!cdnVersion) {
    throw new Error(`CDN latest.yml for ${version}: missing or invalid version ${JSON.stringify(rawVersion)}`);
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
