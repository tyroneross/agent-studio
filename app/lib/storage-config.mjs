// Pass 14.6 — single source of truth for every storage-related limit in the
// studio. Every snapshot writer, runCache writer, status pill, and preflight
// guard imports the config from this module. Code never references inline
// magic numbers for storage limits; the no-hardcoded-storage grep test
// (scripts/test-no-hardcoded-storage.mjs) fails the build if a literal slips
// in.
//
// Shape (`agent-studio:storage-config:v1` in localStorage):
// {
//   warnLevel: number,                // % full → pill turns amber. Default 70.
//   blockLevel: number,               // % full → save preflight kicks in. Default 90.
//   runCacheBytesPerEntry: number,    // hard cap per cached node output (bytes). Default 100_000.
//   runCacheEntriesPerNode: number,   // count cap. Default 1.
//   snapshotsPerProject: number,      // count cap. Default 50.
//   autoSnapshotWhenLow: boolean,     // skip auto-snap before restore/reopen if at blockLevel. Default true.
// }
//
// Quota detection is a thin wrapper around `navigator.storage.estimate()`
// with a 30s in-memory cache (per the design principle: don't hammer the
// browser API). Older browsers return `{ supported: false }` so callers can
// surface "unknown" without crashing.
//
// This module is pure — no React, no DOM mutation. The pill component owns
// the cache hand-off and the panel component owns the user-facing form.

// ── Defaults ──────────────────────────────────────────────────────────────
//
// CHANGE WITH CARE. Every literal in this object IS the magic number. The
// no-hardcoded-storage grep test exempts this file; everywhere else in the
// codebase the same numeric values are forbidden as inline literals.

export const DEFAULT_STORAGE_CONFIG = Object.freeze({
  warnLevel: 70,
  blockLevel: 90,
  runCacheBytesPerEntry: 100_000,
  runCacheEntriesPerNode: 1,
  snapshotsPerProject: 50,
  autoSnapshotWhenLow: true,
});

// localStorage key. Versioned so a future field-shape change can bump
// without colliding with the prior shape.
export const STORAGE_CONFIG_KEY_V1 = "agent-studio:storage-config:v1";

// Numeric fields that must be positive integers. UI form helpers use this
// list to label "reset to default" links and to validate user input.
export const NUMERIC_CONFIG_FIELDS = Object.freeze([
  "warnLevel",
  "blockLevel",
  "runCacheBytesPerEntry",
  "runCacheEntriesPerNode",
  "snapshotsPerProject",
]);

export const BOOLEAN_CONFIG_FIELDS = Object.freeze(["autoSnapshotWhenLow"]);

// Truncation marker. Public so the SoloRunModal can detect it and render a
// subtle "transcript on disk" affordance instead of a broken-looking string.
export function truncationMarker(transcriptPath) {
  // Path may be empty when the writer doesn't know it yet (the marker still
  // needs to be syntactically distinct so the consumer can detect it).
  const tail = transcriptPath ? ` at ${transcriptPath}` : "";
  return `... [truncated — full transcript${tail}]`;
}

// Public regex used by the round-trip harness + the modal to detect a
// truncated cache entry without coupling to the exact string. Anchored at
// the marker prefix so a legitimate string ending with "..." doesn't false-
// positive. The lazy match is intentional — multiple markers in one payload
// would still only flag the first.
export const TRUNCATION_MARKER_PREFIX = "... [truncated";

// ── Load + save ───────────────────────────────────────────────────────────
//
// Lazy migration. Missing keys backfill from defaults so a partially-
// populated stored object stays valid. Invalid (non-numeric, negative,
// non-integer) values reset to default with a console warn — quieter than
// throwing because the UI must still render.

function coerceNumber(value, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function coerceBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  return fallback;
}

export function normalizeStorageConfig(raw) {
  const base = { ...DEFAULT_STORAGE_CONFIG };
  if (!raw || typeof raw !== "object") return base;
  for (const field of NUMERIC_CONFIG_FIELDS) {
    base[field] = coerceNumber(raw[field], DEFAULT_STORAGE_CONFIG[field]);
  }
  for (const field of BOOLEAN_CONFIG_FIELDS) {
    base[field] = coerceBoolean(raw[field], DEFAULT_STORAGE_CONFIG[field]);
  }
  // warnLevel must be < blockLevel; fall back if the user inverts them.
  if (base.warnLevel >= base.blockLevel) {
    base.warnLevel = DEFAULT_STORAGE_CONFIG.warnLevel;
    base.blockLevel = DEFAULT_STORAGE_CONFIG.blockLevel;
  }
  return base;
}

export function loadStorageConfig() {
  if (typeof window === "undefined") return { ...DEFAULT_STORAGE_CONFIG };
  try {
    const raw = window.localStorage.getItem(STORAGE_CONFIG_KEY_V1);
    if (!raw) return { ...DEFAULT_STORAGE_CONFIG };
    const parsed = JSON.parse(raw);
    return normalizeStorageConfig(parsed);
  } catch (err) {
    console.warn("[agent-studio] failed to read storage-config:", err);
    return { ...DEFAULT_STORAGE_CONFIG };
  }
}

export function writeStorageConfig(config) {
  if (typeof window === "undefined") return;
  const normalized = normalizeStorageConfig(config);
  try {
    window.localStorage.setItem(STORAGE_CONFIG_KEY_V1, JSON.stringify(normalized));
  } catch (err) {
    console.warn("[agent-studio] failed to persist storage-config:", err);
  }
}

export function resetStorageConfigField(field) {
  const current = loadStorageConfig();
  if (Object.prototype.hasOwnProperty.call(DEFAULT_STORAGE_CONFIG, field)) {
    current[field] = DEFAULT_STORAGE_CONFIG[field];
    writeStorageConfig(current);
  }
  return current;
}

// ── Quota probe ───────────────────────────────────────────────────────────
//
// `navigator.storage.estimate()` returns `{ usage, quota }`. We cache the
// result for QUOTA_CACHE_TTL_MS so a re-render storm doesn't call the API
// hundreds of times. `force: true` bypasses the cache (used after a write).
//
// 30s TTL is the design-doc default. Lifted to a named constant so a future
// pass can tune without touching call sites — but it's NOT a storage-limit
// literal so it doesn't trigger the grep guard.

const QUOTA_CACHE_TTL_MS = 30_000;
let _quotaCache = null; // { ts, usage, quota, supported }

export function clearQuotaCache() {
  _quotaCache = null;
}

export async function getStorageEstimate({ force = false } = {}) {
  const now = Date.now();
  if (!force && _quotaCache && now - _quotaCache.ts < QUOTA_CACHE_TTL_MS) {
    return _quotaCache;
  }
  if (
    typeof navigator === "undefined"
    || !navigator.storage
    || typeof navigator.storage.estimate !== "function"
  ) {
    _quotaCache = { ts: now, usage: null, quota: null, supported: false };
    return _quotaCache;
  }
  try {
    const result = await navigator.storage.estimate();
    _quotaCache = {
      ts: now,
      usage: typeof result.usage === "number" ? result.usage : null,
      quota: typeof result.quota === "number" ? result.quota : null,
      supported: true,
    };
    return _quotaCache;
  } catch (err) {
    // Permission denied, opaque storage, etc. Treat as unsupported so the
    // pill renders "unknown" and the preflight skips its gate.
    console.warn("[agent-studio] storage.estimate failed:", err);
    _quotaCache = { ts: now, usage: null, quota: null, supported: false };
    return _quotaCache;
  }
}

// ── Status classification ─────────────────────────────────────────────────
//
// The pill and the panel both consume this shape. Three states map to the
// design-doc plain-language phrases:
//   "ok"       → "Plenty of room"
//   "warn"     → "Getting full"
//   "block"    → "Almost out"
//   "unknown"  → "Storage status unknown" (browser API unsupported)
//
// `percent` is 0..100 or null (unknown). `freeBytes` is the remaining bytes
// or null. Pure function so the pill can render synchronously off the
// cached estimate.

export function classifyUsage(estimate, config) {
  const cfg = config || DEFAULT_STORAGE_CONFIG;
  if (!estimate || estimate.supported === false || !estimate.quota) {
    return { state: "unknown", percent: null, freeBytes: null, usedBytes: null, totalBytes: null };
  }
  const usage = estimate.usage ?? 0;
  const quota = estimate.quota;
  const percent = quota > 0 ? Math.min(100, (usage / quota) * 100) : 0;
  const freeBytes = Math.max(0, quota - usage);
  let state = "ok";
  if (percent >= cfg.blockLevel) state = "block";
  else if (percent >= cfg.warnLevel) state = "warn";
  return {
    state,
    percent,
    freeBytes,
    usedBytes: usage,
    totalBytes: quota,
  };
}

// ── Preflight ─────────────────────────────────────────────────────────────
//
// Returns a verdict for a snapshot save. When projected usage crosses
// `blockLevel`, the verdict carries `intercept: true` so the caller shows the
// confirm. When the API isn't supported, the verdict carries `unknown: true`
// and the caller should let the save through (per design: don't gate on
// missing data).

export function projectedUsage(estimate, projectedAddBytes) {
  if (!estimate || estimate.supported === false || !estimate.quota) {
    return { unknown: true };
  }
  const projected = (estimate.usage ?? 0) + Math.max(0, projectedAddBytes || 0);
  const projectedPercent = estimate.quota > 0 ? Math.min(100, (projected / estimate.quota) * 100) : 0;
  return { unknown: false, projectedBytes: projected, projectedPercent, quota: estimate.quota };
}

export function preflightVerdict(estimate, config, projectedAddBytes) {
  const cfg = config || DEFAULT_STORAGE_CONFIG;
  const projection = projectedUsage(estimate, projectedAddBytes);
  if (projection.unknown) {
    return { intercept: false, unknown: true };
  }
  if (projection.projectedPercent >= cfg.blockLevel) {
    return {
      intercept: true,
      unknown: false,
      projectedPercent: projection.projectedPercent,
      projectedBytes: projection.projectedBytes,
      quota: projection.quota,
    };
  }
  return {
    intercept: false,
    unknown: false,
    projectedPercent: projection.projectedPercent,
    projectedBytes: projection.projectedBytes,
    quota: projection.quota,
  };
}

// ── Plain-language helpers ────────────────────────────────────────────────
//
// The design doc bans percentages from the default UI. Convert raw bytes
// into a friendly string and a "how many saves left" estimate. The byte
// formatter caps at GB (we don't expect to need TB for localStorage).

export function formatBytesPlain(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return "unknown";
  const mb = 1024 * 1024;
  const kb = 1024;
  if (bytes >= mb) {
    const value = bytes / mb;
    // 1 decimal until 10 MB, then whole number
    return value >= 10 ? `${Math.round(value)} MB` : `${value.toFixed(1)} MB`;
  }
  if (bytes >= kb) return `${Math.round(bytes / kb)} KB`;
  return `${bytes} B`;
}

export function estimateSavesLeft(freeBytes, perSaveBytes) {
  if (freeBytes == null || !Number.isFinite(freeBytes)) return null;
  if (!perSaveBytes || perSaveBytes <= 0) return null;
  return Math.max(0, Math.floor(freeBytes / perSaveBytes));
}

// Approximate the size of a project (bytes) by JSON-serializing it. Used
// for the "what's using space" table and for the preflight projection.
// Exposed as a pure helper so a unit test can assert behavior without a
// browser.
export function approxProjectBytes(project) {
  if (!project || typeof project !== "object") return 0;
  try {
    return new Blob([JSON.stringify(project)]).size;
  } catch {
    // Older runtimes without Blob — fall back to UTF-16 code-unit estimate.
    try {
      return JSON.stringify(project).length * 2;
    } catch {
      return 0;
    }
  }
}

// Approximate a snapshot's bytes the same way. Snapshots stored projects
// (`projectFrozen`) include canvas + nodes/edges + role overrides etc.
export function approxSnapshotBytes(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return 0;
  try {
    return new Blob([JSON.stringify(snapshot)]).size;
  } catch {
    try {
      return JSON.stringify(snapshot).length * 2;
    } catch {
      return 0;
    }
  }
}

// Approximate a single runCache entry's bytes (output payload only — that's
// the field the truncation cap operates on).
export function approxOutputBytes(output) {
  if (output == null) return 0;
  const text = typeof output === "string" ? output : JSON.stringify(output);
  try {
    return new Blob([text]).size;
  } catch {
    return text.length * 2;
  }
}

// ── runCache truncation ───────────────────────────────────────────────────
//
// Apply the `runCacheBytesPerEntry` cap to a candidate output. Returns
// { output, truncated, originalBytes }. When truncated, the output is a
// string that ends with the truncation marker (so consumers can detect it).
// When the original is structured (object/array), we serialize first; the
// caller can decide whether to re-parse or treat as opaque text.
//
// `transcriptPath` is woven into the marker so the user knows where to find
// the full output if the writer captured one.

export function truncateOutputForCache(output, config, transcriptPath = "") {
  const cfg = config || DEFAULT_STORAGE_CONFIG;
  const cap = cfg.runCacheBytesPerEntry;
  if (output == null) return { output, truncated: false, originalBytes: 0 };
  const text = typeof output === "string" ? output : JSON.stringify(output);
  const originalBytes = approxOutputBytes(text);
  if (originalBytes <= cap) {
    return { output, truncated: false, originalBytes };
  }
  // Slice to a UTF-8-safe prefix that leaves room for the marker. We use the
  // marker bytes plus a small overhead margin to avoid exceeding the cap.
  const marker = truncationMarker(transcriptPath);
  const markerBytes = approxOutputBytes(marker);
  const headroom = Math.max(0, cap - markerBytes);
  // String.slice operates on UTF-16 code units; for ASCII-heavy LLM JSON
  // output this is a tight enough proxy that we don't need a full TextEncoder
  // walk. The only failure mode is a slightly-undersized prefix when the
  // payload is heavy on multi-byte runes — acceptable.
  let truncatedPrefix = text.slice(0, headroom);
  // If still over cap (very-multi-byte heavy strings), shrink in 95% steps
  // until under. Same algorithm /api/agent/run uses for upload byte budget.
  while (approxOutputBytes(truncatedPrefix) + markerBytes > cap && truncatedPrefix.length > 0) {
    truncatedPrefix = truncatedPrefix.slice(0, Math.max(0, Math.floor(truncatedPrefix.length * 0.95) - 1));
  }
  return {
    output: `${truncatedPrefix}\n${marker}`,
    truncated: true,
    originalBytes,
  };
}
