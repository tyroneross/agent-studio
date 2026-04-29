// Project storage layer. Owns the on-disk shape, migrations, and the helpers
// the canvas + landing page use to read/write projects. Pure module — no React.
//
// Storage shape (v6 — Pass 14.5):
//   {
//     version: 6,
//     activeProjectId: string,
//     projects: [
//       {
//         id: string,
//         name: string,
//         workingFolder: string,         // absolute path or ""
//         createdAt: string,             // ISO
//         goal: string,                  // Pass 5
//         context: string,               // Pass 5
//         outcome: string,               // Pass 5
//         uploads: [...],                // Pass 5
//         rolePromptOverrides: { [role]: string }, // Pass 7
//         runCache: { [nodeId]: { input, output, ts } }, // Pass 14 (studio-only)
//         status: "draft" | "completed", // Pass 14.5 — completion lock
//         snapshots: [                   // Pass 14.5 — per-project named snapshots
//           {
//             id: string,                // s-<timeBase36>-<rand6>
//             name: string,
//             createdAt: string,         // ISO
//             projectFrozen: object      // deep clone of the project minus snapshots + minus runCache
//           }
//         ],
//         canvas: {
//           nodes: [
//             {
//               id, role, title, description, instructions, x, y, w, h,
//               inputs?: string[], outputs?: string[],   // Pass 6
//               fixture?: { inputs, source } | null,     // Pass 14 (portable)
//               mockOutput?: any | null,                 // Pass 14 (studio-only)
//             }
//           ],
//           edges,
//           pan,
//           zoom
//         }
//       },
//       ...
//     ]
//   }
//
// Migration chain: v1 → v6 (structural), v2 → v6, v3 → v6, v4 → v6, v5 → v6
// (additive: status="draft" + snapshots=[] per project). v5 key retained for
// recovery (existing pattern). All lazy on first load and persisted to v6
// immediately on first write.
//
// Pass 9: SEED_NODES / SEED_EDGES are now re-exported from agent-patterns.js
// (the Solo Tool Agent pattern). The pattern library is the single source of
// truth for canonical agent shapes; this file owns persistence + migrations.

import {
  PATTERNS,
  SOLO_TOOL_AGENT_PATTERN_ID,
  findPatternById,
  canvasFromPattern,
} from "./agent-patterns.js";
import {
  loadStorageConfig,
  DEFAULT_STORAGE_CONFIG,
  truncateOutputForCache,
} from "./storage-config.mjs";

export const STORAGE_KEY_V1 = "agent-studio:v1";
export const STORAGE_KEY_V2 = "agent-studio:v2";
export const STORAGE_KEY_V3 = "agent-studio:v3";
export const STORAGE_KEY_V4 = "agent-studio:v4";
export const STORAGE_KEY_V5 = "agent-studio:v5";
export const STORAGE_KEY_V6 = "agent-studio:v6";
export const STORAGE_VERSION_V3 = 3;
export const STORAGE_VERSION_V4 = 4;
export const STORAGE_VERSION_V5 = 5;
export const STORAGE_VERSION_V6 = 6;

// Pass 14.6 — read snapshot cap from storage-config. Falls back to the
// frozen default when the runtime hasn't loaded localStorage yet (server
// side). The user-facing storage panel is the only place that mutates this
// value; consumers always read live so a settings change takes effect on
// the next save without a reload.
export function getSnapshotsPerProjectCap() {
  if (typeof window === "undefined") return DEFAULT_STORAGE_CONFIG.snapshotsPerProject;
  return loadStorageConfig().snapshotsPerProject;
}

// Pass 14.5 → 14.6 — historical export retained as a thin wrapper so any
// downstream caller that imported the old constant keeps working. The
// returned value is now dynamic; callers that captured it once at module
// load time should switch to `getSnapshotsPerProjectCap()`.
export const SNAPSHOTS_PER_PROJECT_CAP = DEFAULT_STORAGE_CONFIG.snapshotsPerProject;

// Pass 9: seed comes from the canonical Solo Tool Agent pattern. We expose
// SEED_NODES / SEED_EDGES as plain arrays for backward compatibility — older
// callers that imported these arrays directly continue to work. Cloning is
// caller-side as before.
const _soloPattern = findPatternById(SOLO_TOOL_AGENT_PATTERN_ID);
export const SEED_NODES = _soloPattern.nodes.map((n) => ({ ...n }));
export const SEED_EDGES = _soloPattern.edges.map((e) => ({ ...e }));

export function makeProjectId() {
  // Short, sortable-ish, sufficient for a single-user local tool.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function seedCanvas() {
  // Deep clone via the pattern lib so per-project mutations don't bleed
  // across projects.
  return canvasFromPattern(_soloPattern);
}

export function makeProject({
  name,
  workingFolder = "",
  goal = "",
  context = "",
  outcome = "",
  uploads = [],
  rolePromptOverrides = {},
  runCache = {},
  status = "draft",
  snapshots = [],
  canvas,
} = {}) {
  return {
    id: makeProjectId(),
    name: name || "Untitled project",
    workingFolder,
    createdAt: new Date().toISOString(),
    goal,
    context,
    outcome,
    uploads,
    rolePromptOverrides: { ...rolePromptOverrides },
    runCache: { ...runCache },
    status: status === "completed" ? "completed" : "draft",
    snapshots: Array.isArray(snapshots) ? snapshots.slice() : [],
    canvas: canvas || seedCanvas(),
  };
}

// Pass 14.5 — short stable snapshot id. Mirrors `makeProjectId` so log/UI
// debugging treats them as a single class of identifiers.
export function makeSnapshotId() {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

// Pass 7: validate per-role override map. We only keep entries whose value is
// a non-empty string after trim. This is what the runtime treats as "an
// override exists" — empty strings collapse back to the default.
function normalizeRolePromptOverrides(overrides) {
  if (!overrides || typeof overrides !== "object") return {};
  const out = {};
  for (const [role, value] of Object.entries(overrides)) {
    if (typeof value !== "string") continue;
    if (value.trim().length === 0) continue;
    out[role] = value;
  }
  return out;
}

// Defensive normalization for a single node read from storage.
// - `instructions` predates Pass 7; default to "".
// - `fixture` (Pass 14, portable): { inputs, source } | null. We keep a single
//   `fixture` slot per node; export writes its inputs into evals/golden-tasks.
//   `source` is studio-only ("manual" | "upstream-cache").
// - `mockOutput` (Pass 14, studio-only): any | null. Used by Pass 15; in Pass
//   14 we just reserve the field so the v5 shape doesn't change again.
function normalizeNode(n) {
  if (!n || typeof n !== "object") return n;
  const out = { ...n };
  if (typeof out.instructions !== "string") out.instructions = "";
  if (!Object.prototype.hasOwnProperty.call(out, "fixture")) {
    out.fixture = null;
  } else if (out.fixture && typeof out.fixture === "object") {
    // Sanity-check the shape; drop anything malformed back to null.
    const sourceOk =
      out.fixture.source === "manual" || out.fixture.source === "upstream-cache";
    if (!sourceOk || !("inputs" in out.fixture)) {
      out.fixture = null;
    }
  } else if (out.fixture !== null) {
    out.fixture = null;
  }
  if (!Object.prototype.hasOwnProperty.call(out, "mockOutput")) {
    out.mockOutput = null;
  }
  return out;
}

// Pass 14 → 14.6: defensive normalization for the per-project run cache.
// Strips malformed entries and respects the cache shape (single entry per
// node — N=1 today). The N-cap, the bytes-per-entry cap, and the truncation
// marker all live in `app/lib/storage-config.mjs` so the no-hardcoded-storage
// guard has a single source of truth. The shape stays a single {input,
// output, ts, truncated?} object per node; if a future pass extends to last-N
// we'll replace the value with an array and apply
// `runCacheEntriesPerNode` here without touching consumers.
function normalizeRunCache(cache) {
  if (!cache || typeof cache !== "object") return {};
  const out = {};
  for (const [nodeId, value] of Object.entries(cache)) {
    if (typeof nodeId !== "string" || !nodeId) continue;
    if (!value || typeof value !== "object") continue;
    if (!("output" in value)) continue;
    out[nodeId] = {
      input: value.input ?? null,
      output: value.output,
      ts: typeof value.ts === "string" ? value.ts : new Date().toISOString(),
      // truncated is studio-only metadata so the SoloRunModal can render a
      // "transcript on disk" hint. Optional — older v6 entries default to
      // false.
      ...(value.truncated === true ? { truncated: true } : {}),
    };
  }
  return out;
}

function normalizeCanvas(canvas) {
  if (!canvas || !Array.isArray(canvas.nodes) || !Array.isArray(canvas.edges)) {
    return seedCanvas();
  }
  const pan =
    canvas.pan && typeof canvas.pan.x === "number" && typeof canvas.pan.y === "number"
      ? canvas.pan
      : { x: 0, y: 0 };
  const zoom =
    typeof canvas.zoom === "number" && Number.isFinite(canvas.zoom) ? canvas.zoom : 1;
  return {
    nodes: canvas.nodes.map(normalizeNode),
    edges: canvas.edges,
    pan,
    zoom,
  };
}

// Defensive normalization for an upload record read from storage.
function normalizeUpload(u) {
  if (!u || typeof u !== "object") return null;
  if (typeof u.name !== "string" || typeof u.savedPath !== "string") return null;
  return {
    name: u.name,
    size: typeof u.size === "number" ? u.size : 0,
    savedPath: u.savedPath,
    uploadedAt: typeof u.uploadedAt === "string" ? u.uploadedAt : new Date().toISOString(),
  };
}

// Pass 14.5 — defensive normalization for per-project snapshots. Drops
// malformed entries; trims to the cap (newest first preserved); coerces
// fields. `projectFrozen` is treated as opaque object — we don't recurse into
// it so a snapshot of an older shape stays intact.
function normalizeSnapshots(snapshots) {
  if (!Array.isArray(snapshots)) return [];
  const cleaned = [];
  for (const s of snapshots) {
    if (!s || typeof s !== "object") continue;
    if (typeof s.id !== "string" || !s.id) continue;
    if (typeof s.name !== "string") continue;
    if (!s.projectFrozen || typeof s.projectFrozen !== "object") continue;
    cleaned.push({
      id: s.id,
      name: s.name,
      createdAt: typeof s.createdAt === "string" ? s.createdAt : new Date().toISOString(),
      projectFrozen: s.projectFrozen,
    });
  }
  const cap = getSnapshotsPerProjectCap();
  if (cleaned.length > cap) {
    if (typeof console !== "undefined") {
      console.warn(
        `[agent-studio] dropping ${cleaned.length - cap} snapshot(s) over cap (${cap})`,
      );
    }
    return cleaned.slice(0, cap);
  }
  return cleaned;
}

function normalizeProject(p) {
  return {
    id: p.id,
    name: p.name,
    workingFolder: typeof p.workingFolder === "string" ? p.workingFolder : "",
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    goal: typeof p.goal === "string" ? p.goal : "",
    context: typeof p.context === "string" ? p.context : "",
    outcome: typeof p.outcome === "string" ? p.outcome : "",
    uploads: Array.isArray(p.uploads) ? p.uploads.map(normalizeUpload).filter(Boolean) : [],
    rolePromptOverrides: normalizeRolePromptOverrides(p.rolePromptOverrides),
    runCache: normalizeRunCache(p.runCache),
    status: p.status === "completed" ? "completed" : "draft",
    snapshots: normalizeSnapshots(p.snapshots),
    canvas: normalizeCanvas(p.canvas),
  };
}

// Try v6, then v5 (additive: status="draft" + snapshots=[]), then v4 (chain
// v4→v5→v6), v3 (chain v3→v4→v5→v6), v2 (chain v2→…→v6), v1 (single hop to
// v6), else null. Old keys are left in place per pre-existing recovery
// convention — v5 store is preserved on first v6 write.
export function loadStore() {
  if (typeof window === "undefined") return null;

  // Prefer v6 if present.
  try {
    const rawV6 = window.localStorage.getItem(STORAGE_KEY_V6);
    if (rawV6) {
      const parsed = JSON.parse(rawV6);
      if (parsed && parsed.version === STORAGE_VERSION_V6 && Array.isArray(parsed.projects)) {
        return hydrateStore(parsed);
      }
    }
  } catch (err) {
    console.warn("[agent-studio] failed to read v6 store:", err);
  }

  // v5 → v6: copy forward, default status="draft" + snapshots=[] per project.
  // normalizeProject fills the defaults during hydration so we just bump the
  // version envelope.
  try {
    const rawV5 = window.localStorage.getItem(STORAGE_KEY_V5);
    if (rawV5) {
      const v5 = JSON.parse(rawV5);
      if (v5 && v5.version === STORAGE_VERSION_V5 && Array.isArray(v5.projects)) {
        const upgraded = {
          version: STORAGE_VERSION_V6,
          activeProjectId: v5.activeProjectId,
          projects: v5.projects.map((p) => ({
            ...p,
            status: "draft",
            snapshots: [],
          })),
        };
        const hydrated = hydrateStore(upgraded);
        writeStore(hydrated);
        return hydrated;
      }
    }
  } catch (err) {
    console.warn("[agent-studio] failed to migrate v5 store:", err);
  }

  // v4 → v6: chain (runCache + status + snapshots additive).
  try {
    const rawV4 = window.localStorage.getItem(STORAGE_KEY_V4);
    if (rawV4) {
      const v4 = JSON.parse(rawV4);
      if (v4 && v4.version === STORAGE_VERSION_V4 && Array.isArray(v4.projects)) {
        const upgraded = {
          version: STORAGE_VERSION_V6,
          activeProjectId: v4.activeProjectId,
          projects: v4.projects.map((p) => ({
            ...p,
            runCache: {},
            status: "draft",
            snapshots: [],
          })),
        };
        const hydrated = hydrateStore(upgraded);
        writeStore(hydrated);
        return hydrated;
      }
    }
  } catch (err) {
    console.warn("[agent-studio] failed to migrate v4 store:", err);
  }

  // v3 → v6: chain — add rolePromptOverrides + runCache + status + snapshots.
  try {
    const rawV3 = window.localStorage.getItem(STORAGE_KEY_V3);
    if (rawV3) {
      const v3 = JSON.parse(rawV3);
      if (v3 && v3.version === STORAGE_VERSION_V3 && Array.isArray(v3.projects)) {
        const upgraded = {
          version: STORAGE_VERSION_V6,
          activeProjectId: v3.activeProjectId,
          projects: v3.projects.map((p) => ({
            ...p,
            rolePromptOverrides: {},
            runCache: {},
            status: "draft",
            snapshots: [],
          })),
        };
        const hydrated = hydrateStore(upgraded);
        writeStore(hydrated);
        return hydrated;
      }
    }
  } catch (err) {
    console.warn("[agent-studio] failed to migrate v3 store:", err);
  }

  // v2 → v6: chain — additive defaults from each step folded together.
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const v2 = JSON.parse(rawV2);
      if (v2 && v2.version === 2 && Array.isArray(v2.projects)) {
        const upgraded = {
          version: STORAGE_VERSION_V6,
          activeProjectId: v2.activeProjectId,
          projects: v2.projects.map((p) => ({
            ...p,
            goal: typeof p.goal === "string" ? p.goal : "",
            context: typeof p.context === "string" ? p.context : "",
            outcome: typeof p.outcome === "string" ? p.outcome : "",
            uploads: Array.isArray(p.uploads) ? p.uploads : [],
            rolePromptOverrides: {},
            runCache: {},
            status: "draft",
            snapshots: [],
          })),
        };
        const hydrated = hydrateStore(upgraded);
        writeStore(hydrated);
        return hydrated;
      }
    }
  } catch (err) {
    console.warn("[agent-studio] failed to migrate v2 store:", err);
  }

  // v1 → v6: structural migration (single project from raw nodes/edges).
  try {
    const rawV1 = window.localStorage.getItem(STORAGE_KEY_V1);
    if (rawV1) {
      const v1 = JSON.parse(rawV1);
      if (v1 && Array.isArray(v1.nodes) && Array.isArray(v1.edges)) {
        const canvas = normalizeCanvas({
          nodes: v1.nodes,
          edges: v1.edges,
          pan: v1.pan,
          zoom: v1.zoom,
        });
        const project = makeProject({ name: "Default", workingFolder: "", canvas });
        const store = {
          version: STORAGE_VERSION_V6,
          activeProjectId: project.id,
          projects: [project],
        };
        writeStore(store);
        return store;
      }
    }
  } catch (err) {
    console.warn("[agent-studio] failed to migrate v1 store:", err);
  }

  return null;
}

// Validate + repair a parsed v6 store. Guarantees at least one project and a
// valid activeProjectId pointing at one of them.
function hydrateStore(parsed) {
  const projects = parsed.projects
    .filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
    .map(normalizeProject);

  if (projects.length === 0) {
    return {
      version: STORAGE_VERSION_V6,
      activeProjectId: null,
      projects: [],
    };
  }

  const activeId = projects.some((p) => p.id === parsed.activeProjectId)
    ? parsed.activeProjectId
    : projects[0].id;

  return {
    version: STORAGE_VERSION_V6,
    activeProjectId: activeId,
    projects,
  };
}

export function writeStore(store) {
  if (typeof window === "undefined") return;
  try {
    const payload = {
      version: STORAGE_VERSION_V6,
      activeProjectId: store.activeProjectId,
      projects: store.projects,
    };
    window.localStorage.setItem(STORAGE_KEY_V6, JSON.stringify(payload));
  } catch (err) {
    console.warn("[agent-studio] failed to persist v6 store:", err);
  }
}

export function clearStore() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY_V6);
  } catch (err) {
    console.warn("[agent-studio] failed to clear v6 store:", err);
  }
}

// Empty-store factory. The landing page uses this when no stored projects
// exist. The canvas page should never be reached without an active project,
// but guards by redirecting in that case.
export function emptyStore() {
  return {
    version: STORAGE_VERSION_V6,
    activeProjectId: null,
    projects: [],
  };
}

// Pass 14.5 — completion lock. Returns true when the project is read-only.
// Used by data-layer mutation guards (defense in depth) and by the UI to
// disable controls. The two side-effects (status flip + snapshot mutation)
// must remain available even on completed projects so the user can reopen
// or save further snapshots without first unlocking.
export function isProjectLocked(project) {
  return !!project && project.status === "completed";
}

// Pure helpers for the reducer-style updates page.js performs.
//
// Pass 14.5 — `withProjectUpdated` accepts an `options.allowOnLocked` flag.
// Helpers that must work even when `status === "completed"` (status flips,
// snapshot writes) pass it through; everything else (canvas edits, role
// override edits, working-folder edits, runCache writes) refuses silently
// when the project is locked. The UI also disables those controls — this is
// belt-and-suspenders so a stale state setter or a future code path can't
// mutate a locked project by accident.
export function withProjectUpdated(store, projectId, updater, options = {}) {
  const allowOnLocked = !!options.allowOnLocked;
  return {
    ...store,
    projects: store.projects.map((p) => {
      if (p.id !== projectId) return p;
      if (!allowOnLocked && isProjectLocked(p)) return p;
      return updater(p);
    }),
  };
}

export function withCanvasUpdated(store, projectId, canvasPatch) {
  return withProjectUpdated(store, projectId, (p) => ({
    ...p,
    canvas: { ...p.canvas, ...canvasPatch },
  }));
}

export function getActiveProject(store) {
  if (!store || !Array.isArray(store.projects) || store.projects.length === 0) return null;
  return store.projects.find((p) => p.id === store.activeProjectId) ?? store.projects[0] ?? null;
}

// Pass 14 → 14.6: write a single solo-run result into a project's runCache.
// Pure — returns a new project object. The output payload is whatever the
// runtime produced (parsed JSON preferred, raw text fallback). The byte cap
// (`runCacheBytesPerEntry` from storage-config) is applied here so the cache
// can never grow past the user's configured budget. When the entry was
// truncated server-side the route already replaced `output` with a
// truncation marker; this function honors that marker. When the route did
// NOT truncate (older API), we still apply the cap here as belt-and-braces.
//
// Cache shape stays single-entry per node (N=1) per Pass 14 research
// recommendation; `runCacheEntriesPerNode` from storage-config governs the
// future N>1 case.
export function withRunCacheEntry(project, nodeId, entry) {
  if (!project || typeof project !== "object") return project;
  if (typeof nodeId !== "string" || !nodeId) return project;

  const cfg = typeof window === "undefined" ? DEFAULT_STORAGE_CONFIG : loadStorageConfig();
  const incomingTruncated = entry?.truncated === true;
  let output = entry?.output ?? null;
  let truncated = incomingTruncated;
  if (!incomingTruncated) {
    const result = truncateOutputForCache(output, cfg, entry?.transcriptPath ?? "");
    output = result.output;
    truncated = result.truncated;
  }

  const next = {
    ...project,
    runCache: {
      ...(project.runCache ?? {}),
      [nodeId]: {
        input: entry?.input ?? null,
        output,
        ts: typeof entry?.ts === "string" ? entry.ts : new Date().toISOString(),
        ...(truncated ? { truncated: true } : {}),
      },
    },
  };
  return next;
}

// Pass 14: wipe a project's runCache. Used by the toolbar "Clear cache"
// action. Pure — returns a new project object.
export function withRunCacheCleared(project) {
  if (!project || typeof project !== "object") return project;
  return { ...project, runCache: {} };
}

// Pass 14.5 — freeze a project for snapshot storage. Strips `snapshots` (no
// recursion) and `runCache` (studio-only per Pass 14 buckets). Returns a
// fresh object so callers can safely deep-clone.
function freezeForSnapshot(project) {
  if (!project || typeof project !== "object") return null;
  // Shallow copy then strip the two excluded fields. Canvas is included as a
  // structured clone via JSON round-trip so a future canvas mutation can't
  // bleed into the saved snapshot.
  const { snapshots: _s, runCache: _r, ...rest } = project;
  // void the unused destructures so eslint doesn't warn in stricter configs
  void _s; void _r;
  return JSON.parse(JSON.stringify(rest));
}

// Pass 14.5 — append a new named snapshot to the project. Newest first so
// the side-panel list reads top-down by recency. Honors the per-project cap;
// older entries are dropped silently with a one-time warn (already in
// normalizeSnapshots; cap is enforced both on add and on hydrate so a future
// cap drop doesn't leave a stale fat list around).
//
// Allowed even when status === "completed" — see withProjectUpdated options.
export function withSnapshotAdded(project, name) {
  if (!project || typeof project !== "object") return project;
  const trimmedName = typeof name === "string" && name.trim().length > 0
    ? name.trim()
    : `Snapshot ${new Date().toISOString()}`;
  const snapshot = {
    id: makeSnapshotId(),
    name: trimmedName,
    createdAt: new Date().toISOString(),
    projectFrozen: freezeForSnapshot(project),
  };
  let snapshots = [snapshot, ...(Array.isArray(project.snapshots) ? project.snapshots : [])];
  const cap = getSnapshotsPerProjectCap();
  if (snapshots.length > cap) {
    if (typeof console !== "undefined") {
      console.warn(
        `[agent-studio] snapshot cap reached for project ${project.id}; dropping oldest`,
      );
    }
    snapshots = snapshots.slice(0, cap);
  }
  return { ...project, snapshots };
}

// Pass 14.5 — restore a snapshot. Auto-snapshots the current live state
// first (`Auto-saved before restore <ISO>`) so restore is reversible, then
// overwrites portable + replayable + studio-only fields with the frozen
// project. Status is preserved from the live project so a "completed"
// project that restores an older snapshot stays completed; the user must
// reopen explicitly. Snapshots list keeps growing across restores (the
// auto-save is the most recent entry).
//
// Allowed even when status === "completed".
export function withSnapshotRestored(project, snapshotId) {
  if (!project || typeof project !== "object") return project;
  const snapshots = Array.isArray(project.snapshots) ? project.snapshots : [];
  const target = snapshots.find((s) => s.id === snapshotId);
  if (!target || !target.projectFrozen) return project;
  // Save current state as auto-snapshot first.
  const withAutoSave = withSnapshotAdded(project, `Auto-saved before restore ${new Date().toISOString()}`);
  // Apply the frozen state, but keep the live `status`, `snapshots`, and `id`.
  const frozen = target.projectFrozen;
  return {
    ...frozen,
    id: project.id,
    status: project.status === "completed" ? "completed" : "draft",
    snapshots: withAutoSave.snapshots,
    // runCache was stripped from the freeze; reset it to an empty object so
    // the project shape remains complete. The user can re-run nodes after
    // restore to repopulate.
    runCache: {},
  };
}

// Pass 14.5 — delete a single snapshot by id. Pure — returns a new project
// with the snapshot removed. Allowed even when status === "completed" so the
// user can prune snapshots after marking a project complete.
export function withSnapshotDeleted(project, snapshotId) {
  if (!project || typeof project !== "object") return project;
  const snapshots = Array.isArray(project.snapshots) ? project.snapshots : [];
  return { ...project, snapshots: snapshots.filter((s) => s.id !== snapshotId) };
}

// Pass 14.5 — flip the status flag. Coerces invalid values to "draft" so a
// hand-crafted store entry can't put the project into an unknown lock state.
// Allowed even when status === "completed" (this is the only way out).
export function withStatusChanged(project, nextStatus) {
  if (!project || typeof project !== "object") return project;
  const status = nextStatus === "completed" ? "completed" : "draft";
  return { ...project, status };
}

// "/Users/..." | "/tmp/..." | "/var/folders/..." (the three paths the API will
// actually serve). Used both server-side (the route) and client-side (passive
// hint, before the round-trip).
export const PERMITTED_PATH_PREFIXES = ["/Users/", "/tmp/", "/var/folders/"];

export function looksAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
}

// Pass 10: kebab-case slug for project-name → directory-segment. Lowercase
// alphanumerics with hyphens between groups. Empty input yields "project" so
// the default working folder always has a valid trailing segment.
export function slugifyProjectName(name) {
  if (typeof name !== "string") return "project";
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

// Pass 10: default working folder for a freshly-opened new-project form.
// We pre-fill ${HOME}/agent-studio/<slug>/ — under /Users/, so the validator
// allowlist accepts it, and unique-per-project so two new projects don't
// collide on the same folder. The directory may not exist yet; the user can
// click "Browse" or save and the existing /api/fs/validate { create: true }
// flow will mkdir on submit.
//
// `home` is injected so the component can pass `process.env.HOME` (server)
// or a hardcoded `/Users/<user>/` (client, where process.env is empty).
export function defaultWorkingFolder({ name, home }) {
  if (!home || typeof home !== "string") return "";
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return `${base}/agent-studio/${slugifyProjectName(name)}/`;
}

// Pass 8: demo-project flow. The landing page surfaces a "Try the demo
// project" CTA which creates this canonical project (or opens it if it
// already exists) and routes to /canvas.
export const DEMO_PROJECT_NAME = "Demo: Solo Tool Agent";
export const DEMO_PROJECT_WORKING_FOLDER = "/tmp/agent-studio-demo";

export const DEMO_PROJECT_GOAL =
  "Plan a 1-week rollout for a small internal tool";
export const DEMO_PROJECT_CONTEXT =
  "Audience: a 12-person ops team familiar with the current spreadsheet workflow.\nConstraints: no security review needed, can ship behind an internal flag, two engineers half-time.\nSuccess looks like: by Friday EOD, ops can run the new tool end-to-end on real data.";
export const DEMO_PROJECT_OUTCOME =
  "A timeline, an action list, and risks";

// Find an existing demo project by exact name match. Returns null when no
// store exists or no project carries the demo name. The match is by name
// (not id) because demo projects are created locally and aren't shared.
export function findDemoProject(store) {
  if (!store || !Array.isArray(store.projects)) return null;
  return store.projects.find((p) => p.name === DEMO_PROJECT_NAME) ?? null;
}

// Build a demo project with the seed graph pre-loaded. Caller decides where
// it goes (store append) and is responsible for `mkdir -p` of the working
// folder via /api/fs/validate { create: true } before navigation.
export function makeDemoProject() {
  return makeProject({
    name: DEMO_PROJECT_NAME,
    workingFolder: DEMO_PROJECT_WORKING_FOLDER,
    goal: DEMO_PROJECT_GOAL,
    context: DEMO_PROJECT_CONTEXT,
    outcome: DEMO_PROJECT_OUTCOME,
  });
}
