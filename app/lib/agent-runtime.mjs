// Generic DAG runtime for an agent-studio project.
//
// Inputs:
//   project: { id, name, goal, context, outcome, uploads, canvas: { nodes, edges } }
//     Each node may also carry optional `inputs: string[]` and `outputs: string[]`
//     declarations. A node with `inputs: ["scope"]` depends on any node with
//     `outputs: ["scope"]`. These declarations augment explicit edges; they do
//     not replace them.
//   query:    string — the user's test query / runtime input
//   model?:   string — Ollama model name (defaults to env OLLAMA_MODEL or gpt-oss:20b)
//   onEvent:  (event) => void — receives every progress event (see below)
//   signal?:  AbortSignal — caller can cancel the run mid-flight
//   baseUrl?: string — Ollama base url (default http://localhost:11434)
//
// Events:
//   { type: "warmup" }
//   { type: "warmup-ok", model }
//   { type: "warmup-fail", error }
//   { type: "warning", text }
//   { type: "level-start", level, nodeIds }
//   { type: "node-start", id, name, role }
//   { type: "node-chunk", id, bytes }                 // running byte count of streamed body
//   { type: "node-end", id, durationMs, bytes, parsed, output }
//   { type: "node-error", id, error }
//   { type: "complete", transcript, brief }
//
// Cycle detection: throws Error("graph has cycles: <list>") before any LLM call.
// No-order graph (no edges, no inputs/outputs declarations): emits a warning
//   and runs every node at level 0 in parallel.
// Per-level parallelism is capped at 4 via Promise.all over chunks of 4.
//
// Streaming pattern: POST /api/chat with stream:true, format:"json",
// temperature 0.2, num_ctx 8192. The body is NDJSON; each line is a JSON
// object with at least { message: { content }, done }. We accumulate
// message.content until done:true and then JSON.parse() the result.
// TAG:ASSUMED — Ollama /api/chat NDJSON streaming protocol (documented stable).

import { getEffectiveRoleTemplate, HARD_RULES } from "./role-templates.mjs";

const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_MODEL =
  (typeof process !== "undefined" && process.env && process.env.OLLAMA_MODEL) ||
  "gpt-oss:20b";
const PER_LEVEL_PARALLELISM = 4;

// Pass 7: test-only ring buffer of the last system prompts composed by
// buildMessages(). The self-consistency test inspects this to assert that a
// per-project role-prompt override actually reaches Ollama. Capped at 32
// entries so a long-running dev server doesn't grow this unbounded.
const SYSTEM_PROMPT_RING_CAP = 32;
export const _lastSystemPrompts = [];
function recordSystemPrompt(prompt) {
  _lastSystemPrompts.push(prompt);
  if (_lastSystemPrompts.length > SYSTEM_PROMPT_RING_CAP) {
    _lastSystemPrompts.splice(0, _lastSystemPrompts.length - SYSTEM_PROMPT_RING_CAP);
  }
}

// ── Topological planner ────────────────────────────────────────────────────

// Given nodes + edges + per-node inputs/outputs declarations, compute the set
// of dependency edges as a Map<toId, Set<fromId>>.
//
// Explicit edges are added as-is. Then for every node N with `inputs: [t]` and
// every node M with `outputs: [t]`, we add M -> N. Self-loops are ignored.
function computeDependencies(nodes, edges) {
  const incoming = new Map(); // toId -> Set<fromId>
  for (const node of nodes) incoming.set(node.id, new Set());

  for (const edge of edges) {
    if (!incoming.has(edge.to) || !incoming.has(edge.from)) continue;
    if (edge.from === edge.to) continue;
    incoming.get(edge.to).add(edge.from);
  }

  // Producers index: tag -> [nodeIds that output it]
  const producers = new Map();
  for (const node of nodes) {
    if (Array.isArray(node.outputs)) {
      for (const tag of node.outputs) {
        if (typeof tag !== "string" || !tag) continue;
        if (!producers.has(tag)) producers.set(tag, []);
        producers.get(tag).push(node.id);
      }
    }
  }

  // For each consumer (inputs:[]), wire edges from each producer of that tag.
  for (const node of nodes) {
    if (!Array.isArray(node.inputs)) continue;
    for (const tag of node.inputs) {
      const list = producers.get(tag);
      if (!list) continue;
      for (const fromId of list) {
        if (fromId === node.id) continue;
        incoming.get(node.id).add(fromId);
      }
    }
  }

  return incoming;
}

function hasOrderingSignal(nodes, edges) {
  if (edges.length > 0) return true;
  for (const n of nodes) {
    if (Array.isArray(n.inputs) && n.inputs.length > 0) return true;
    if (Array.isArray(n.outputs) && n.outputs.length > 0) return true;
  }
  return false;
}

// Kahn's algorithm with level batching: at each level, emit all nodes whose
// remaining in-degree is zero. If any nodes remain after we exhaust the
// frontier, the graph has a cycle.
function levelize(nodes, incoming) {
  const remaining = new Map();
  for (const [id, set] of incoming) remaining.set(id, new Set(set));

  const idsLeft = new Set(nodes.map((n) => n.id));
  const levels = [];

  while (idsLeft.size > 0) {
    const ready = [];
    for (const id of idsLeft) {
      const deps = remaining.get(id);
      if (!deps || deps.size === 0) ready.push(id);
    }
    if (ready.length === 0) {
      // Cycle: every remaining node has at least one unmet dependency.
      const cyclic = Array.from(idsLeft).sort();
      const err = new Error(`graph has cycles: ${cyclic.join(", ")}`);
      err.code = "CYCLE";
      err.cyclicNodes = cyclic;
      throw err;
    }
    levels.push(ready);
    for (const id of ready) {
      idsLeft.delete(id);
      // Remove this id from every other node's remaining set.
      for (const set of remaining.values()) set.delete(id);
    }
  }

  return levels;
}

export function planExecution(project) {
  const nodes = project?.canvas?.nodes ?? [];
  const edges = project?.canvas?.edges ?? [];
  if (nodes.length === 0) {
    return { levels: [], hasOrdering: false, incoming: new Map() };
  }
  const incoming = computeDependencies(nodes, edges);
  const ordering = hasOrderingSignal(nodes, edges);
  if (!ordering) {
    // No edges, no inputs/outputs: every node is level 0.
    return {
      levels: [nodes.map((n) => n.id)],
      hasOrdering: false,
      incoming,
    };
  }
  const levels = levelize(nodes, incoming);
  return { levels, hasOrdering: true, incoming };
}

// ── Prompt composition ─────────────────────────────────────────────────────

// Pass 11: build the project-level context block. When `loadedUploads` is
// supplied (route resolved each upload's contents and policed the byte budget),
// inline each file's contents under a labeled section. Files past the budget
// arrive with truncated/skipped flags; we surface those as a single trailing
// note rather than silently dropping them. The route owns disk reads and the
// path allowlist; this function never touches the filesystem.
function projectContextBlock(project, loadedUploads) {
  const lines = [];
  if (project.goal) lines.push(`Project goal: ${project.goal}`);
  if (project.outcome) lines.push(`Desired outcome: ${project.outcome}`);
  if (project.context) lines.push(`Project context: ${project.context}`);

  const loaded = Array.isArray(loadedUploads) ? loadedUploads : [];
  const inlined = loaded.filter((u) => typeof u?.contents === "string" && u.contents.length > 0);
  for (const u of inlined) {
    lines.push("");
    lines.push(`### Uploaded context: ${u.name}`);
    lines.push(u.contents);
    if (u.truncated) {
      lines.push(`(${u.name} truncated to fit context budget)`);
    }
  }
  const skippedCount = loaded.filter((u) => u && u.skipped === true).length;
  if (skippedCount > 0) {
    lines.push("");
    lines.push(`(${skippedCount} more file${skippedCount === 1 ? "" : "s"} truncated due to context budget)`);
  }
  return lines.join("\n");
}

function upstreamOutputsBlock(node, incoming, results) {
  const deps = incoming.get(node.id);
  if (!deps || deps.size === 0) return "";
  const sections = [];
  for (const fromId of deps) {
    const r = results.get(fromId);
    if (!r) continue;
    const payload = r.parsed ?? r.text ?? null;
    sections.push(
      `From upstream node "${r.title || fromId}" (role: ${r.role}):\n${
        typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
      }`,
    );
  }
  return sections.join("\n\n");
}

function buildMessages(node, project, query, incoming, results, loadedUploads) {
  // Pass 7: prefer the per-project role-prompt override when present, else
  // fall back to the hardcoded default for the role.
  const roleTemplate = getEffectiveRoleTemplate(node.role, project?.rolePromptOverrides);
  const sysParts = [HARD_RULES, "", roleTemplate];
  const userParts = [];

  const ctx = projectContextBlock(project, loadedUploads);
  if (ctx) userParts.push(ctx);

  if (typeof node.instructions === "string" && node.instructions.trim()) {
    userParts.push(`Node-specific instructions:\n${node.instructions.trim()}`);
  }

  userParts.push(`Node title: ${node.title}\nNode description: ${node.description}`);

  const upstream = upstreamOutputsBlock(node, incoming, results);
  if (upstream) userParts.push(upstream);

  if (query) userParts.push(`User query: ${query}`);

  userParts.push(
    "Respond with the strict JSON object required by your role template. No commentary outside the JSON.",
  );

  const systemContent = sysParts.join("\n");
  // Test-only hook: record the composed system prompt before it leaves the
  // process. Inspected by scripts/test-self.mjs to assert override flow.
  recordSystemPrompt(systemContent);

  return [
    { role: "system", content: systemContent },
    { role: "user", content: userParts.join("\n\n") },
  ];
}

// ── Ollama streaming caller ────────────────────────────────────────────────

async function checkOllama(baseUrl, signal) {
  const res = await fetch(`${baseUrl}/api/tags`, {
    signal,
  });
  if (!res.ok) throw new Error(`ollama tags returned ${res.status}`);
  const body = await res.json();
  const models = (body.models ?? []).map((m) => m.name);
  return { models };
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Stream the chat response. Returns { text, parsed, bytes }.
// onChunkBytes(bytes) is called as bytes accumulate.
async function streamChat(baseUrl, model, messages, signal, onChunkBytes) {
  const res = await fetch(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      format: "json",
      options: {
        temperature: 0.2,
        num_ctx: 8192,
      },
    }),
    signal,
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`ollama /api/chat returned ${res.status}${detail ? `: ${detail}` : ""}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let collected = "";
  let bytes = 0;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      const piece = evt?.message?.content ?? "";
      if (piece) {
        collected += piece;
        bytes += Buffer.byteLength(piece, "utf8");
        if (onChunkBytes) onChunkBytes(bytes);
      }
      if (evt?.done) {
        // drain any remaining buffer; loop will exit naturally
      }
    }
  }
  // flush any trailing line
  const tail = buffer.trim();
  if (tail) {
    try {
      const evt = JSON.parse(tail);
      const piece = evt?.message?.content ?? "";
      if (piece) {
        collected += piece;
        bytes += Buffer.byteLength(piece, "utf8");
        if (onChunkBytes) onChunkBytes(bytes);
      }
    } catch {
      /* ignore */
    }
  }

  return { text: collected, parsed: safeJsonParse(collected), bytes };
}

// ── Public entry point ─────────────────────────────────────────────────────

export async function runProject({
  project,
  query,
  model,
  onEvent = () => {},
  signal,
  baseUrl = DEFAULT_BASE_URL,
  // Pass 11: pre-resolved upload contents from the route. Shape:
  //   [{ name, contents, truncated?, skipped? }]
  // The route is the Node-runtime boundary that owns disk access + the path
  // allowlist; this lib stays filesystem-free so it remains testable under a
  // mocked fetch and portable to other deploy targets.
  loadedUploads,
}) {
  if (!project || !project.canvas) {
    throw new Error("project with canvas required");
  }
  const nodes = project.canvas.nodes ?? [];
  const edges = project.canvas.edges ?? [];
  if (nodes.length === 0) {
    onEvent({ type: "warning", text: "project has no nodes — nothing to run" });
    const transcript = { project: project.id, query, model: null, levels: [], nodes: [] };
    const brief = composeBrief({ project, query, transcript });
    onEvent({ type: "complete", transcript, brief });
    return { transcript, brief };
  }

  // Plan first. Cycle detection happens in planExecution before any network call.
  const plan = planExecution(project);
  if (!plan.hasOrdering) {
    onEvent({
      type: "warning",
      text: "no order detected — running all nodes in parallel; add edges or declare inputs/outputs to control flow",
    });
  }

  // Warmup probe: confirm Ollama is reachable. We surface failures via events
  // and then re-throw so the caller can stop the run.
  onEvent({ type: "warmup" });
  let resolvedModel = model || DEFAULT_MODEL;
  try {
    const status = await checkOllama(baseUrl, signal);
    if (status.models.length === 0) {
      throw new Error("ollama has no models pulled");
    }
    if (!status.models.includes(resolvedModel)) {
      // Fall back to whatever's first; surface a warning.
      onEvent({
        type: "warning",
        text: `model "${resolvedModel}" not found locally; using "${status.models[0]}"`,
      });
      resolvedModel = status.models[0];
    }
    onEvent({ type: "warmup-ok", model: resolvedModel });
  } catch (err) {
    onEvent({ type: "warmup-fail", error: err.message || String(err) });
    throw err;
  }

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const results = new Map(); // id -> { id, role, title, durationMs, bytes, parsed, text }

  for (let levelIdx = 0; levelIdx < plan.levels.length; levelIdx++) {
    const ids = plan.levels[levelIdx];
    onEvent({ type: "level-start", level: levelIdx, nodeIds: ids });

    // Run in chunks of PER_LEVEL_PARALLELISM. Promise.all over each chunk.
    for (let i = 0; i < ids.length; i += PER_LEVEL_PARALLELISM) {
      const chunk = ids.slice(i, i + PER_LEVEL_PARALLELISM);
      await Promise.all(
        chunk.map(async (id) => {
          const node = nodeById.get(id);
          if (!node) return;
          onEvent({ type: "node-start", id, name: node.title, role: node.role });
          const t0 = Date.now();
          try {
            const messages = buildMessages(node, project, query, plan.incoming, results, loadedUploads);
            const { text, parsed, bytes } = await streamChat(
              baseUrl,
              resolvedModel,
              messages,
              signal,
              (bytesSoFar) => onEvent({ type: "node-chunk", id, bytes: bytesSoFar }),
            );
            const durationMs = Date.now() - t0;
            results.set(id, {
              id,
              role: node.role,
              title: node.title,
              durationMs,
              bytes,
              parsed,
              text,
            });
            onEvent({
              type: "node-end",
              id,
              durationMs,
              bytes,
              parsed,
              output: text,
            });
          } catch (err) {
            const durationMs = Date.now() - t0;
            results.set(id, {
              id,
              role: node.role,
              title: node.title,
              durationMs,
              bytes: 0,
              parsed: null,
              text: "",
              error: err.message || String(err),
            });
            onEvent({ type: "node-error", id, error: err.message || String(err) });
          }
        }),
      );
    }
  }

  const transcript = {
    project: project.id,
    projectName: project.name,
    query,
    model: resolvedModel,
    startedAt: new Date().toISOString(),
    levels: plan.levels,
    nodes: nodes.map((n) => {
      const r = results.get(n.id);
      return {
        id: n.id,
        title: n.title,
        role: n.role,
        instructions: n.instructions ?? "",
        description: n.description ?? "",
        durationMs: r?.durationMs ?? 0,
        bytes: r?.bytes ?? 0,
        parsed: r?.parsed ?? null,
        output: r?.text ?? "",
        error: r?.error ?? null,
      };
    }),
  };

  const brief = composeBrief({ project, query, transcript });
  onEvent({ type: "complete", transcript, brief });
  return { transcript, brief };
}

// ── Brief composer ─────────────────────────────────────────────────────────

export function composeBrief({ project, query, transcript }) {
  const parts = [];
  parts.push(`# Run: ${project.name || "Untitled project"}`);
  parts.push("");
  if (project.goal) parts.push(`**Goal:** ${project.goal}`);
  if (project.outcome) parts.push(`**Desired outcome:** ${project.outcome}`);
  if (query) parts.push(`**Query:** ${query}`);
  if (transcript.model) parts.push(`**Model:** ${transcript.model}`);
  parts.push("");
  for (const n of transcript.nodes) {
    parts.push(`## ${n.title} _(role: ${n.role})_`);
    if (n.error) {
      parts.push(`> error: ${n.error}`);
    } else {
      const payload = n.parsed != null ? JSON.stringify(n.parsed, null, 2) : n.output || "";
      parts.push("```json");
      parts.push(typeof payload === "string" ? payload : JSON.stringify(payload, null, 2));
      parts.push("```");
    }
    parts.push("");
  }
  return parts.join("\n");
}
