// Project storage layer. Owns the on-disk shape, migrations, and the helpers
// the canvas + landing page use to read/write projects. Pure module — no React.
//
// Storage shape (v4):
//   {
//     version: 4,
//     activeProjectId: string,
//     projects: [
//       {
//         id: string,
//         name: string,
//         workingFolder: string,         // absolute path or ""
//         createdAt: string,             // ISO
//         goal: string,                  // Pass 5 — short statement of the agent goal
//         context: string,               // Pass 5 — background, prior decisions, links
//         outcome: string,               // Pass 5 — what success looks like
//         uploads: [                     // Pass 5 — files saved into <workingFolder>/uploads/
//           { name, size, savedPath, uploadedAt }
//         ],
//         rolePromptOverrides: {         // Pass 7 — per-role prompt-template overrides
//           [role]: string               // e.g. { agent: "Custom prompt..." }
//         },
//         canvas: { nodes, edges, pan, zoom }
//       },
//       ...
//     ]
//   }
//
// Migration chain: v1 -> v4 (structural), v2 -> v4 (additive), v3 -> v4
// (additive: rolePromptOverrides defaults to {} per project). All lazy on
// first load and persisted to v4 immediately. Old keys are left in place so
// a user can recover if a migration produced something unexpected.

export const STORAGE_KEY_V1 = "agent-studio:v1";
export const STORAGE_KEY_V2 = "agent-studio:v2";
export const STORAGE_KEY_V3 = "agent-studio:v3";
export const STORAGE_KEY_V4 = "agent-studio:v4";
export const STORAGE_VERSION_V3 = 3;
export const STORAGE_VERSION_V4 = 4;

// Seed graph reused by both new-project flow and v1 hydration default.
export const SEED_NODES = [
  {
    id: "intake",
    role: "agent",
    title: "Intake",
    description: "Normalize the user goal and identify missing inputs before routing.",
    instructions: "",
    x: 120,
    y: 200,
    w: 220,
    h: 130,
  },
  {
    id: "policy",
    role: "guardrail",
    title: "Policy gate",
    description: "Classify read, write, network, shell, and credential intent against permissions.",
    instructions: "",
    x: 400,
    y: 200,
    w: 220,
    h: 130,
  },
  {
    id: "orch",
    role: "orchestrator",
    title: "Orchestrator",
    description: "Choose the next action from the active tool pool.",
    instructions: "",
    x: 680,
    y: 200,
    w: 220,
    h: 130,
  },
  {
    id: "exec",
    role: "executor",
    title: "Executor",
    description: "Run approved reads or writes and return structured results.",
    instructions: "",
    x: 680,
    y: 380,
    w: 220,
    h: 130,
  },
  {
    id: "evalCheck",
    role: "eval",
    title: "Eval check",
    description: "Check output, permissions, and guardrail invariants.",
    instructions: "",
    x: 960,
    y: 290,
    w: 220,
    h: 130,
  },
];

export const SEED_EDGES = [
  { id: "intake->policy", from: "intake", to: "policy" },
  { id: "policy->orch", from: "policy", to: "orch" },
  { id: "orch->exec", from: "orch", to: "exec" },
  { id: "exec->evalCheck", from: "exec", to: "evalCheck" },
  { id: "orch->evalCheck", from: "orch", to: "evalCheck" },
];

export function makeProjectId() {
  // Short, sortable-ish, sufficient for a single-user local tool.
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function seedCanvas() {
  return {
    // Deep clone seeds so per-project mutations don't bleed across projects.
    nodes: SEED_NODES.map((n) => ({ ...n })),
    edges: SEED_EDGES.map((e) => ({ ...e })),
    pan: { x: 0, y: 0 },
    zoom: 1,
  };
}

export function makeProject({
  name,
  workingFolder = "",
  goal = "",
  context = "",
  outcome = "",
  uploads = [],
  rolePromptOverrides = {},
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
    canvas: canvas || seedCanvas(),
  };
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

// Defensive normalization for a single node read from storage. Older saves
// predate the `instructions` field; default it to "" so panel inputs stay
// controlled.
function normalizeNode(n) {
  return typeof n.instructions === "string" ? n : { ...n, instructions: "" };
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
    canvas: normalizeCanvas(p.canvas),
  };
}

// Try v4, then v3 (additive: add rolePromptOverrides), then v2 (chain v2->v3->v4),
// then v1 (single hop to v4), else null (caller seeds a default).
export function loadStore() {
  if (typeof window === "undefined") return null;

  // Prefer v4 if present.
  try {
    const rawV4 = window.localStorage.getItem(STORAGE_KEY_V4);
    if (rawV4) {
      const parsed = JSON.parse(rawV4);
      if (parsed && parsed.version === STORAGE_VERSION_V4 && Array.isArray(parsed.projects)) {
        return hydrateStore(parsed);
      }
      // Malformed v4 — fall through.
    }
  } catch (err) {
    console.warn("[agent-studio] failed to read v4 store:", err);
  }

  // v3 -> v4: copy forward, default rolePromptOverrides to {} per project.
  try {
    const rawV3 = window.localStorage.getItem(STORAGE_KEY_V3);
    if (rawV3) {
      const v3 = JSON.parse(rawV3);
      if (v3 && v3.version === STORAGE_VERSION_V3 && Array.isArray(v3.projects)) {
        const upgraded = {
          version: STORAGE_VERSION_V4,
          activeProjectId: v3.activeProjectId,
          projects: v3.projects.map((p) => ({
            ...p,
            rolePromptOverrides: {},
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

  // v2 -> v4: chain — additive defaults from v2->v3, then v3->v4 override map.
  try {
    const rawV2 = window.localStorage.getItem(STORAGE_KEY_V2);
    if (rawV2) {
      const v2 = JSON.parse(rawV2);
      if (v2 && v2.version === 2 && Array.isArray(v2.projects)) {
        const upgraded = {
          version: STORAGE_VERSION_V4,
          activeProjectId: v2.activeProjectId,
          projects: v2.projects.map((p) => ({
            ...p,
            goal: typeof p.goal === "string" ? p.goal : "",
            context: typeof p.context === "string" ? p.context : "",
            outcome: typeof p.outcome === "string" ? p.outcome : "",
            uploads: Array.isArray(p.uploads) ? p.uploads : [],
            rolePromptOverrides: {},
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

  // v1 -> v4: structural migration (single project from raw nodes/edges).
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
          version: STORAGE_VERSION_V4,
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

// Validate + repair a parsed v4 store. Guarantees at least one project and a
// valid activeProjectId pointing at one of them.
function hydrateStore(parsed) {
  const projects = parsed.projects
    .filter((p) => p && typeof p.id === "string" && typeof p.name === "string")
    .map(normalizeProject);

  if (projects.length === 0) {
    return {
      version: STORAGE_VERSION_V4,
      activeProjectId: null,
      projects: [],
    };
  }

  const activeId = projects.some((p) => p.id === parsed.activeProjectId)
    ? parsed.activeProjectId
    : projects[0].id;

  return {
    version: STORAGE_VERSION_V4,
    activeProjectId: activeId,
    projects,
  };
}

export function writeStore(store) {
  if (typeof window === "undefined") return;
  try {
    const payload = {
      version: STORAGE_VERSION_V4,
      activeProjectId: store.activeProjectId,
      projects: store.projects,
    };
    window.localStorage.setItem(STORAGE_KEY_V4, JSON.stringify(payload));
  } catch (err) {
    console.warn("[agent-studio] failed to persist v4 store:", err);
  }
}

export function clearStore() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY_V4);
  } catch (err) {
    console.warn("[agent-studio] failed to clear v4 store:", err);
  }
}

// Empty-store factory. The landing page uses this when no stored projects
// exist. The canvas page should never be reached without an active project,
// but guards by redirecting in that case.
export function emptyStore() {
  return {
    version: STORAGE_VERSION_V4,
    activeProjectId: null,
    projects: [],
  };
}

// Pure helpers for the reducer-style updates page.js performs.
export function withProjectUpdated(store, projectId, updater) {
  return {
    ...store,
    projects: store.projects.map((p) => (p.id === projectId ? updater(p) : p)),
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

// "/Users/..." | "/tmp/..." | "/var/folders/..." (the three paths the API will
// actually serve). Used both server-side (the route) and client-side (passive
// hint, before the round-trip).
export const PERMITTED_PATH_PREFIXES = ["/Users/", "/tmp/", "/var/folders/"];

export function looksAbsolutePath(value) {
  return typeof value === "string" && value.startsWith("/");
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
