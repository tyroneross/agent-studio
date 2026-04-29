// Pure module: studio project ↔ agent-spec/v1 directory.
//
// Pass 14 freezes the agent-spec/v1 contract. This file is the single
// source of truth for that conversion. It owns:
//
//   exportProjectToSpec(project): { files: [{ path, content }], slug, defaults }
//   importSpecToProject(files):   project (v5 shape)
//
// Field shape mirrors agent-builder/lib/generator.js#buildAgentArtifacts so
// a directory written from this output is consumable, unmodified, by
// agent-builder v0.3.0. See docs/SPEC.md for the bucket table.
//
// No filesystem access. No fetch. The caller is responsible for writing the
// returned files to disk if it wants persistence; the round-trip harness
// keeps the files in memory.

import { getEffectiveRoleTemplate, HARD_RULES } from "./role-templates.mjs";

// ── Defaults ───────────────────────────────────────────────────────────────
//
// Studio doesn't surface these fields in the editor today. Pass 14 fills them
// at export time using values that (a) match the studio's runtime (Ollama,
// local Next.js) and (b) pass agent-builder's validateSpec(). See
// docs/SPEC.md#defaults-filled-at-export-time for the rationale per field.

export const SPEC_DEFAULTS = Object.freeze({
  schemaVersion: "agent-spec/v1",
  patternId: "solo-tool-agent",
  runtime: "local-nextjs",
  framework: "custom-loop",
  modelProvider: "ollama",
  sandbox: "workspace-write",
  autonomy: "human-in-loop",
  permissions: {
    default: "deny-by-default",
    read: "allow approved local/project context",
    write: "ask first",
    network: "ask first unless source registry marks official docs",
    shell: "ask first",
  },
  memory: {
    working: "current request, selected context, active plan",
    session: "tool outputs and decisions for this run",
    persistent: "operator policy and reusable project facts with provenance",
  },
  // agent-builder generator defaults `tools` to the pattern's tools when the
  // input doesn't provide any. We set it to [] explicitly so studio specs
  // don't get pattern-default tools the user never declared. Empty list is
  // accepted by validateSpec.
  tools: [],
  sources: ["next-app-router", "next-route-handlers", "ollama-api"],
  evalsFrameworkLabel: "Custom loop",
});

// agent-builder's manifest carries this exact pattern envelope; we mirror it
// so the agent.yaml graph + manifest.json both validate.
const SPEC_PATTERN_ENVELOPE = Object.freeze({
  id: "solo-tool-agent",
  name: "Solo Tool Agent",
  type: "Type I",
});

// ── Helpers ────────────────────────────────────────────────────────────────

export function slugifySpec(value) {
  return String(value ?? "agent")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "agent";
}

function quoteYaml(value) {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null || value === undefined) return "null";
  const text = String(value);
  if (!text) return '""';
  if (/^[a-zA-Z0-9_./:-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

// Minimal YAML emitter — same algorithm as agent-builder/lib/generator.js#toYaml
// so output bytes line up. Object-mode emits `key: value` lines; array-mode
// emits `- value` lines; nested objects/arrays recurse.
export function toYaml(value, indent = 0) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          const rendered = toYaml(item, indent + 2);
          return `${pad}- ${rendered.trimStart()}`;
        }
        return `${pad}- ${quoteYaml(item)}`;
      })
      .join("\n");
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (!entries.length) return "{}";
    return entries
      .map(([key, item]) => {
        if (Array.isArray(item)) {
          return item.length ? `${pad}${key}:\n${toYaml(item, indent + 2)}` : `${pad}${key}: []`;
        }
        if (item && typeof item === "object") {
          return `${pad}${key}:\n${toYaml(item, indent + 2)}`;
        }
        return `${pad}${key}: ${quoteYaml(item)}`;
      })
      .join("\n");
  }
  return `${pad}${quoteYaml(value)}`;
}

// Replicates the agent-builder validateSpec contract (lib/generator.js). We
// inline it instead of importing because the studio is a Next.js app and
// agent-builder isn't (yet) a peer dep in package.json. If it becomes one,
// switch to `import { validateSpec } from "agent-builder/lib/generator.js"`.
export function validateSpec(spec) {
  const errors = [];
  if (!spec.projectName?.trim()) errors.push("Project name is required.");
  if (!Array.isArray(spec.nodes) || spec.nodes.length === 0) {
    errors.push("At least one node is required.");
  }
  const nodeIds = new Set((spec.nodes ?? []).map((node) => node.id));
  for (const node of spec.nodes ?? []) {
    if (!node.id) errors.push("Every node needs an id.");
    if (!node.title) errors.push(`Node ${node.id || "(missing id)"} needs a title.`);
  }
  for (const edge of spec.edges ?? []) {
    if (!nodeIds.has(edge.from)) errors.push(`Edge source ${edge.from} does not exist.`);
    if (!nodeIds.has(edge.to)) errors.push(`Edge target ${edge.to} does not exist.`);
  }
  return errors;
}

// ── Project → spec ─────────────────────────────────────────────────────────

// Compose project description from goal/outcome/context. Falls back to a
// short generic line so agent.yaml#description is never empty (validateSpec
// doesn't enforce it but agent-builder readers expect it).
function projectDescription(project) {
  const parts = [];
  if (project.goal) parts.push(`Goal: ${project.goal}`);
  if (project.outcome) parts.push(`Desired outcome: ${project.outcome}`);
  if (project.context) parts.push(`Context: ${project.context}`);
  return parts.join("\n\n") || `Studio project ${project.name || project.id}.`;
}

// Project-level inputs/outputs are the union of every node's declared
// inputs/outputs, deduped, in first-seen order. This matches agent-builder's
// expectation that agent.yaml#inputs is a flat string list.
function projectInputsOutputs(nodes) {
  const inputs = [];
  const outputs = [];
  const inputSet = new Set();
  const outputSet = new Set();
  for (const n of nodes) {
    for (const tag of Array.isArray(n.inputs) ? n.inputs : []) {
      if (typeof tag !== "string" || !tag) continue;
      if (!inputSet.has(tag)) {
        inputSet.add(tag);
        inputs.push(tag);
      }
    }
    for (const tag of Array.isArray(n.outputs) ? n.outputs : []) {
      if (typeof tag !== "string" || !tag) continue;
      if (!outputSet.has(tag)) {
        outputSet.add(tag);
        outputs.push(tag);
      }
    }
  }
  return { inputs, outputs };
}

// Build the studio's intermediate "spec" — the single object that drives
// every emitted file. Shape mirrors agent-builder/lib/generator.js#normalizeSpec.
//
// Studio-only node fields (x, y, w, h, mockOutput, fixture.source) are
// dropped here. Portable fields (id, role→kind, title, description,
// instructions, inputs, outputs) are mapped one-to-one. fixture.inputs is
// preserved separately for golden-task emission.
function projectToSpec(project) {
  const nodesRaw = project?.canvas?.nodes ?? [];
  const edgesRaw = project?.canvas?.edges ?? [];

  const nodes = nodesRaw.map((n) => ({
    id: n.id,
    title: n.title,
    kind: n.role,
    description: n.description ?? "",
    instructions: typeof n.instructions === "string" ? n.instructions : "",
    tools: [],
    inputs: Array.isArray(n.inputs) ? n.inputs.slice() : [],
    outputs: Array.isArray(n.outputs) ? n.outputs.slice() : [],
    permission: "ask-first",
    model: "inherit",
  }));

  const edges = edgesRaw.map((e) => ({ from: e.from, to: e.to }));
  const { inputs, outputs } = projectInputsOutputs(nodesRaw);

  // Pair fixtures with their most recent runCache output (when present) to
  // form golden tasks. Fixture inputs are portable; the matching output is
  // replayable. Per-node fixture.source is dropped (studio-only).
  const goldenTasks = [];
  const runCache = project?.runCache ?? {};
  for (const n of nodesRaw) {
    if (!n.fixture || typeof n.fixture !== "object") continue;
    if (!("inputs" in n.fixture)) continue;
    const cached = runCache[n.id];
    goldenTasks.push({
      name: `${n.id}-fixture`,
      input: n.fixture.inputs,
      // Use the most recent solo-run output if available; fall back to a
      // notes-only task otherwise. Either form passes agent-builder's
      // evals.passCondition (clear stop reason).
      expected: cached ? cached.output : null,
    });
  }

  return {
    schemaVersion: SPEC_DEFAULTS.schemaVersion,
    projectName: project.name || "Untitled project",
    description: projectDescription(project),
    patternId: SPEC_DEFAULTS.patternId,
    runtime: SPEC_DEFAULTS.runtime,
    framework: SPEC_DEFAULTS.framework,
    modelProvider: SPEC_DEFAULTS.modelProvider,
    sandbox: SPEC_DEFAULTS.sandbox,
    autonomy: SPEC_DEFAULTS.autonomy,
    nodes,
    edges,
    inputs,
    outputs,
    tools: SPEC_DEFAULTS.tools.slice(),
    sources: SPEC_DEFAULTS.sources.slice(),
    permissions: { ...SPEC_DEFAULTS.permissions },
    memory: { ...SPEC_DEFAULTS.memory },
    evals: goldenTasks,
    rolePromptOverrides: { ...(project.rolePromptOverrides ?? {}) },
    // Studio metadata — round-tripped via manifest.studio (Pass 14).
    studioGoal: project.goal ?? "",
    studioContext: project.context ?? "",
    studioOutcome: project.outcome ?? "",
  };
}

function buildAgentYaml(spec) {
  const config = {
    schemaVersion: SPEC_DEFAULTS.schemaVersion,
    name: spec.projectName,
    description: spec.description,
    runtime: spec.runtime,
    framework: spec.framework,
    modelProvider: spec.modelProvider,
    sandbox: spec.sandbox,
    autonomy: spec.autonomy,
    inputs: spec.inputs,
    outputs: spec.outputs,
    graph: {
      nodes: spec.nodes.map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        permission: n.permission,
        model: n.model,
        tools: n.tools,
        inputs: n.inputs,
        outputs: n.outputs,
      })),
      edges: spec.edges,
    },
    permissions: spec.permissions,
    memory: spec.memory,
  };
  return toYaml(config) + "\n";
}

function buildManifestJson(spec, createdAt) {
  return JSON.stringify(
    {
      schemaVersion: "agent-builder.v1",
      name: spec.projectName,
      slug: slugifySpec(spec.projectName),
      description: spec.description,
      // Pass 14 — additive: studio-side metadata that round-trips. agent-builder
      // ignores unknown manifest fields (validateSpec only checks projectName +
      // nodes + edges), so this stays compatible with v0.3.0. The block is
      // namespaced under `studio` so future agent-builder versions don't
      // accidentally collide with one of these keys.
      studio: {
        schemaVersion: SPEC_DEFAULTS.schemaVersion,
        goal: spec.studioGoal ?? "",
        context: spec.studioContext ?? "",
        outcome: spec.studioOutcome ?? "",
        rolePromptOverrides: spec.rolePromptOverrides ?? {},
      },
      pattern: { ...SPEC_PATTERN_ENVELOPE, autonomy: spec.autonomy },
      runtime: spec.runtime,
      framework: { id: spec.framework, label: SPEC_DEFAULTS.evalsFrameworkLabel },
      modelProvider: spec.modelProvider,
      sandbox: spec.sandbox,
      inputs: spec.inputs,
      outputs: spec.outputs,
      graph: {
        nodes: spec.nodes.map((n) => ({
          id: n.id,
          title: n.title,
          kind: n.kind,
          // Pass 14 — additive: include description and instructions so the
          // round-trip preserves them. agent-builder's validateSpec ignores
          // unknown fields, so this stays compatible with v0.3.0.
          description: n.description,
          instructions: n.instructions,
          model: n.model,
          permission: n.permission,
          tools: n.tools,
          inputs: n.inputs,
          outputs: n.outputs,
        })),
        edges: spec.edges,
      },
      permissions: spec.permissions,
      memory: spec.memory,
      createdAt,
    },
    null,
    2,
  ) + "\n";
}

function buildSystemPrompt(spec) {
  const overrides = spec.rolePromptOverrides ?? {};
  const nodes = spec.nodes
    .map((n) => {
      const roleTemplate = getEffectiveRoleTemplate(n.kind, overrides);
      const instructions = n.instructions
        ? `\n\n### Node-specific instructions\n${n.instructions}`
        : "";
      return `## ${n.title}\nRole: ${n.kind}\nPermission: ${n.permission}\n\n${n.description}\n\n### Role template\n${roleTemplate}${instructions}`;
    })
    .join("\n\n");

  return `# ${spec.projectName} System Prompt

You are operating inside the ${SPEC_DEFAULTS.evalsFrameworkLabel} harness emitted by Agent Studio (${SPEC_DEFAULTS.schemaVersion}).

## Job
${spec.description}

## Inputs
${(spec.inputs.length ? spec.inputs : ["(none declared)"]).map((i) => `- ${i}`).join("\n")}

## Outputs
${(spec.outputs.length ? spec.outputs : ["(none declared)"]).map((o) => `- ${o}`).join("\n")}

## Hard rules
${HARD_RULES}

## Nodes
${nodes || "(no nodes declared)"}
`;
}

function buildToolsJson(spec) {
  return JSON.stringify(
    {
      schemaVersion: "agent-builder.tools.v1",
      policy: spec.permissions,
      // Studio doesn't model tools as first-class today; emit an empty list.
      // Future passes will populate this from per-node tool bindings.
      tools: spec.tools,
    },
    null,
    2,
  ) + "\n";
}

function buildGoldenTasks(spec) {
  return JSON.stringify(
    {
      schemaVersion: "agent-builder.evals.v1",
      passCondition: "All golden tasks pass or produce explicit stop reasons.",
      goldenTasks: spec.evals,
    },
    null,
    2,
  ) + "\n";
}

function buildRegressionScenarios() {
  return JSON.stringify(
    {
      schemaVersion: "agent-builder.regression-scenarios.v1",
      passCondition: "A promoted domain lesson must not reduce any scenario score.",
      scenarios: [],
    },
    null,
    2,
  ) + "\n";
}

function buildDomainPlaybook() {
  return `# Domain Playbook

No domain-learning profile was supplied. Pass 14 ships an empty stub so
agent-builder consumers see the expected file layout. Promote lessons here
once a learning ledger is in place.
`;
}

function buildLearningLedger(createdAt) {
  return JSON.stringify(
    {
      schemaVersion: "agent-builder.learning-ledger.v1",
      agent: null,
      domain: null,
      createdAt,
      promotionGate: null,
      runs: [],
      candidateLessons: [],
      acceptedLessons: [],
      rejectedLessons: [],
    },
    null,
    2,
  ) + "\n";
}

function buildReadme(spec, strippedFields) {
  return `# ${spec.projectName}

${spec.description}

Generated by Agent Studio export — schema \`${SPEC_DEFAULTS.schemaVersion}\`.

## Generated files

- \`agent.yaml\`
- \`manifest.json\`
- \`system-prompt.md\`
- \`tools.json\`
- \`evals/golden-tasks.json\`
- \`evals/regression-scenarios.json\`
- \`memory/domain-playbook.md\`
- \`memory/learning-ledger.json\`
- \`README.md\`
- \`sources.md\`

## Runtime

- Pattern: ${SPEC_PATTERN_ENVELOPE.name} (${SPEC_PATTERN_ENVELOPE.type})
- Framework: ${SPEC_DEFAULTS.evalsFrameworkLabel}
- Model provider: ${spec.modelProvider}
- Sandbox: ${spec.sandbox}
- Autonomy: ${spec.autonomy}

## Stripped studio-only fields

These fields lived on the studio canvas but are excluded on export per the
\`agent-spec/v1\` contract (see \`docs/SPEC.md\#bucket-table\`):

${strippedFields.map((f) => `- \`${f}\``).join("\n")}

## How to consume

\`agent-builder\` v0.3.0 reads this directory directly. For other runtimes,
treat \`agent.yaml\` as the source of truth: it carries the declared inputs,
outputs, graph, and permissions. The rest is agent-builder convenience.
`;
}

function buildSourcesMarkdown(spec) {
  // We emit only id-level references here; agent-builder's source-registry is
  // canonical. Studio doesn't ship its own registry yet.
  return `# Source Registry

These references are inherited from agent-builder's canonical registry. Look
each up in \`agent-builder/lib/patterns.js#SOURCE_REGISTRY\` for full details.

${(spec.sources ?? []).map((id) => `- \`${id}\``).join("\n")}
`;
}

// Public entrypoint — emit the 10-file spec for a project.
export function exportProjectToSpec(project, options = {}) {
  if (!project || typeof project !== "object") {
    throw new Error("exportProjectToSpec: project required");
  }
  const spec = projectToSpec(project);
  const errors = validateSpec(spec);
  if (errors.length) {
    const err = new Error(`spec validation failed: ${errors.join("; ")}`);
    err.code = "SPEC_INVALID";
    err.errors = errors;
    throw err;
  }

  const createdAt = options.createdAt ?? new Date().toISOString();

  // Studio-only fields the exporter drops, surfaced in README so the
  // downstream consumer knows what was excluded.
  const strippedFields = [
    "canvas.nodes[].x / y / w / h (layout)",
    "canvas.nodes[].mockOutput (Pass 14 — runtime substitution, never exported)",
    "canvas.nodes[].fixture.source (manual vs upstream-cache hint)",
    "runCache (per-node solo-run cache)",
    "uploads (local file references)",
    "workingFolder",
    "canvas.pan / zoom",
  ];

  const files = [
    { path: "agent.yaml", content: buildAgentYaml(spec) },
    { path: "manifest.json", content: buildManifestJson(spec, createdAt) },
    { path: "system-prompt.md", content: buildSystemPrompt(spec) },
    { path: "tools.json", content: buildToolsJson(spec) },
    { path: "evals/golden-tasks.json", content: buildGoldenTasks(spec) },
    { path: "evals/regression-scenarios.json", content: buildRegressionScenarios() },
    { path: "memory/domain-playbook.md", content: buildDomainPlaybook() },
    { path: "memory/learning-ledger.json", content: buildLearningLedger(createdAt) },
    { path: "README.md", content: buildReadme(spec, strippedFields) },
    { path: "sources.md", content: buildSourcesMarkdown(spec) },
  ];

  return {
    files,
    slug: slugifySpec(spec.projectName),
    defaults: SPEC_DEFAULTS,
    spec,
    strippedFields,
  };
}

// ── Spec → project ─────────────────────────────────────────────────────────

// Find a file by exact path. Returns the content string or null if missing.
function fileContent(files, targetPath) {
  if (!Array.isArray(files)) return null;
  const f = files.find((x) => x?.path === targetPath);
  return f && typeof f.content === "string" ? f.content : null;
}

// Minimal manifest reader. We re-read manifest.json (not agent.yaml) on
// import because the JSON is unambiguous and we already know agent-builder
// emits both. Future passes can swap to a YAML parser if needed.
function readManifest(files) {
  const raw = fileContent(files, "manifest.json");
  if (!raw) throw new Error("import: manifest.json missing");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`import: manifest.json is not valid JSON: ${err.message}`);
  }
}

function readGoldenTasks(files) {
  const raw = fileContent(files, "evals/golden-tasks.json");
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.goldenTasks) ? parsed.goldenTasks : [];
  } catch {
    return [];
  }
}

// Public entrypoint — re-hydrate a v5 project from an exported spec. Studio-
// only fields default to empty (per docs/SPEC.md). Layout (x/y/w/h) is
// regenerated as a simple horizontal lane because it isn't in the spec.
export function importSpecToProject(files, options = {}) {
  const manifest = readManifest(files);
  const goldenTasks = readGoldenTasks(files);

  const graphNodes = Array.isArray(manifest?.graph?.nodes) ? manifest.graph.nodes : [];
  const graphEdges = Array.isArray(manifest?.graph?.edges) ? manifest.graph.edges : [];

  // Index golden tasks by node id (we named them `${id}-fixture` on export).
  const fixtureByNode = new Map();
  for (const task of goldenTasks) {
    if (!task || typeof task.name !== "string") continue;
    if (!task.name.endsWith("-fixture")) continue;
    const nodeId = task.name.slice(0, -"-fixture".length);
    fixtureByNode.set(nodeId, {
      inputs: task.input ?? null,
      // Importer preserves the inputs as a portable fixture; source is
      // studio-only and defaults to "manual" because we don't know whether
      // the original came from upstream-cache.
      source: "manual",
    });
  }

  // Lay nodes out in a horizontal lane keyed by topo-distance from sources.
  // We don't have x/y in the spec; this is a deterministic best-effort so the
  // re-imported canvas isn't all stacked at (0,0). 240px columns, 180px rows.
  const incoming = new Map();
  for (const n of graphNodes) incoming.set(n.id, new Set());
  for (const e of graphEdges) {
    if (incoming.has(e.to)) incoming.get(e.to).add(e.from);
  }
  const depth = new Map();
  function depthOf(id, seen = new Set()) {
    if (depth.has(id)) return depth.get(id);
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = incoming.get(id);
    if (!deps || deps.size === 0) {
      depth.set(id, 0);
      return 0;
    }
    let max = 0;
    for (const d of deps) {
      const dd = depthOf(d, seen);
      if (dd + 1 > max) max = dd + 1;
    }
    depth.set(id, max);
    return max;
  }
  for (const n of graphNodes) depthOf(n.id);
  const perColumnIndex = new Map();
  function placement(id) {
    const col = depth.get(id) ?? 0;
    const row = perColumnIndex.get(col) ?? 0;
    perColumnIndex.set(col, row + 1);
    return { x: 120 + col * 280, y: 80 + row * 200, w: 220, h: 130 };
  }

  const nodes = graphNodes.map((n) => {
    const xy = placement(n.id);
    return {
      id: n.id,
      role: n.kind ?? "agent",
      title: n.title ?? n.id,
      description: n.description ?? "",
      instructions: typeof n.instructions === "string" ? n.instructions : "",
      x: xy.x,
      y: xy.y,
      w: xy.w,
      h: xy.h,
      inputs: Array.isArray(n.inputs) ? n.inputs.slice() : [],
      outputs: Array.isArray(n.outputs) ? n.outputs.slice() : [],
      fixture: fixtureByNode.has(n.id) ? fixtureByNode.get(n.id) : null,
      mockOutput: null,
    };
  });

  const edges = graphEdges.map((e) => ({
    id: `${e.from}->${e.to}`,
    from: e.from,
    to: e.to,
  }));

  const id = options.projectId
    || `p-imported-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Pass 14 — pull studio metadata back out of the manifest.studio block if
  // present. Falls back to empty strings so older specs (without the block)
  // still import cleanly.
  const studioMeta = manifest?.studio && typeof manifest.studio === "object" ? manifest.studio : {};

  return {
    id,
    name: manifest.name ?? "Imported project",
    workingFolder: "",
    createdAt: typeof manifest.createdAt === "string" ? manifest.createdAt : new Date().toISOString(),
    goal: typeof studioMeta.goal === "string" ? studioMeta.goal : "",
    context: typeof studioMeta.context === "string" ? studioMeta.context : "",
    outcome: typeof studioMeta.outcome === "string" ? studioMeta.outcome : "",
    uploads: [],
    rolePromptOverrides:
      studioMeta.rolePromptOverrides && typeof studioMeta.rolePromptOverrides === "object"
        ? { ...studioMeta.rolePromptOverrides }
        : {},
    runCache: {},
    canvas: {
      nodes,
      edges,
      pan: { x: 0, y: 0 },
      zoom: 1,
    },
  };
}
