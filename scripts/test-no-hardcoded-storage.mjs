#!/usr/bin/env node
// Pass 14.6 — fail the build if any storage-related numeric literal slipped
// into a feature file. The single source of truth for storage limits is
// `app/lib/storage-config.mjs`; every other consumer must import the
// constants from there.
//
// What this checks:
//   - Files in TARGET_FILES are read.
//   - Each line is scanned for a literal that EQUALS one of the FORBIDDEN
//     numeric values from DEFAULT_STORAGE_CONFIG.
//   - Comments, JSDoc, copyright headers, and string literals are stripped
//     before matching so a doc-comment that mentions "70%" doesn't trigger.
//   - Storage config keys themselves (e.g. `runCacheBytesPerEntry`) are
//     allowed because they're identifiers, not literals.
//
// What it deliberately doesn't check:
//   - The 30s quota cache TTL (`30_000`). It's a polling interval, not a
//     storage limit.
//   - Pixel sizes / timing constants in style and animation code.
//
// Exit codes: 0 = clean. 1 = at least one literal was found.
//
// To extend: add the file path to TARGET_FILES. To exempt a numeric value
// from the guard, add it to ALLOWED_VALUES with a comment explaining why.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

// Files the no-hardcoded-storage rule applies to.
const TARGET_FILES = [
  "app/lib/projects.js",
  "app/lib/markdown-export.mjs",
  "app/lib/spec-export.mjs",
  "app/components/SoloRunModal.js",
  "app/canvas/page.js",
  "app/lib/agent-runtime.mjs",
];

// Forbidden numeric values. Sourced from DEFAULT_STORAGE_CONFIG so the rule
// stays aligned with the only place these literals are legal. Imported via a
// dynamic import so the script is self-contained.
//
// Values 0/1/2 are universally used as loop counters, slice offsets, and
// state increments (e.g. `setStorageRefreshKey(k => k + 1)`); excluding them
// avoids a sea of false positives. The acceptance criterion calls out the
// distinctive values: 50, 70, 90, 100, 100_000. Any future config field
// whose default is one of those distinctive values automatically becomes
// forbidden via this set.
const cfgModule = await import("../app/lib/storage-config.mjs");
const UNIVERSAL_LOW_INTS = new Set(["0", "1", "2"]);
const FORBIDDEN_VALUES = new Set(
  Object.values(cfgModule.DEFAULT_STORAGE_CONFIG)
    .filter((v) => typeof v === "number")
    .map(String)
    .filter((v) => !UNIVERSAL_LOW_INTS.has(v)),
);

// Numeric literals that exist for unrelated reasons (timing, pixels). We don't
// have any allowed exceptions today; this is the seam where a future
// genuine collision can be exempted.
const ALLOWED_VALUES = new Set([
  // currently empty
]);

// Match an integer literal. Allow underscore separators (`100_000`). Exclude
// floats; the storage limits are all integers.
const NUM_RE = /\b(\d[\d_]*)\b/g;

// Strip line/block comments and the contents of single/double/backtick
// string literals so doc text and string constants are exempt. We don't
// need a full JS parser — these files use simple string forms.
function stripCommentsAndStrings(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      // line comment
      const eol = src.indexOf("\n", i);
      i = eol === -1 ? n : eol;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      out += c;
      i++;
      while (i < n) {
        const cc = src[i];
        if (cc === "\\") {
          i += 2;
          continue;
        }
        if (cc === c) {
          out += cc;
          i++;
          break;
        }
        // strip the string body itself but keep length so line numbers align
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      while (i < n) {
        const cc = src[i];
        if (cc === "\\") {
          i += 2;
          continue;
        }
        if (cc === "`") {
          out += cc;
          i++;
          break;
        }
        // template-literal body — strip but preserve newlines so line numbers
        // align in error reports.
        out += cc === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function findOffenders(content) {
  const stripped = stripCommentsAndStrings(content);
  const offenders = [];
  const lines = stripped.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    NUM_RE.lastIndex = 0;
    let m;
    while ((m = NUM_RE.exec(line)) !== null) {
      // Normalize underscored literals (100_000 → "100000") for comparison
      // against the forbidden set, which holds the canonical decimal form.
      const raw = m[1];
      const normalized = raw.replaceAll("_", "");
      if (!FORBIDDEN_VALUES.has(normalized)) continue;
      if (ALLOWED_VALUES.has(normalized)) continue;
      offenders.push({
        lineNumber: lineIdx + 1,
        column: m.index + 1,
        literal: raw,
        snippet: line.trim(),
      });
    }
  }
  return offenders;
}

async function main() {
  let totalOffenders = 0;
  for (const rel of TARGET_FILES) {
    const abs = path.join(ROOT, rel);
    let content;
    try {
      content = await fs.readFile(abs, "utf8");
    } catch (err) {
      console.error(`SKIP ${rel}: ${err.message}`);
      continue;
    }
    const offenders = findOffenders(content);
    if (offenders.length === 0) {
      console.log(`OK   ${rel}`);
      continue;
    }
    totalOffenders += offenders.length;
    console.error(`FAIL ${rel} — ${offenders.length} forbidden literal(s):`);
    for (const o of offenders) {
      console.error(`  L${o.lineNumber}:${o.column}  ${o.literal}  →  ${o.snippet}`);
    }
  }

  if (totalOffenders > 0) {
    console.error("");
    console.error(
      `Found ${totalOffenders} hardcoded storage literal(s). Source the value from app/lib/storage-config.mjs#DEFAULT_STORAGE_CONFIG.`,
    );
    process.exit(1);
  }
  console.log("");
  console.log(`Scanned ${TARGET_FILES.length} files; no hardcoded storage literals found.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`unexpected: ${err?.stack || err?.message || err}`);
  process.exit(1);
});
