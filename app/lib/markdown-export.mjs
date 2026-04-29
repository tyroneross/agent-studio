// Pure module: studio project ↔ single-file `agent.md` (`agent-md/v1`).
//
// Pass 14.5 ships this as a peer to `spec-export.mjs`. The 10-file `spec/`
// exporter targets agent-builder's runtime; this module targets humans + LLMs
// — one file you can paste into a chat, commit to a repo, or hand off to a
// model to rebuild the project from scratch.
//
//   exportProjectToMarkdown(project) → string
//   importMarkdownToProject(md)      → project (v6 shape, sans snapshots/status)
//
// Bucket policy (mirrors docs/SPEC.md):
//   portable   → frontmatter, role overrides, nodes (no x/y/w/h/mockOutput),
//                edges, instructions, project goal/context/outcome, name
//   replayable → fixture inputs (per node)
//   studio-only → runCache, snapshots, status, x/y/w/h, mockOutput, fixture.source
//
// The studio-only fields MUST NOT appear in the output. Round-trip asserts
// that. Layout (x/y/w/h) is regenerated on import (same horizontal-lane
// algorithm spec-export uses).
//
// YAML: hand-rolled, intentionally tiny. Supports:
//   - flat objects with string/number/bool/null values
//   - arrays of objects whose values are primitives or string arrays
//   - arrays of strings/primitives
//   - that's it. No anchors, no multiline strings (long prose lives in the
//     markdown body, not in YAML blocks).

const SCHEMA_VERSION = "agent-md/v1";

// ── YAML primitives ────────────────────────────────────────────────────────

function needsQuoting(text) {
  if (text === "") return true;
  // Anything with whitespace, special YAML chars, or that could be coerced
  // (true/false/null/numbers) must be quoted.
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(text)) return true;
  if (/^-?\d+(\.\d+)?$/.test(text)) return true;
  if (/[:#\-{}[\],&*!|>'"%@`?\n]/.test(text)) return true;
  if (/^\s|\s$/.test(text)) return true;
  return false;
}

function emitScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "null";
    return String(value);
  }
  const text = String(value);
  if (needsQuoting(text)) {
    // Use JSON.stringify for safe escaping. JSON's quoting is a strict subset
    // of YAML's double-quoted string, so the result parses cleanly.
    return JSON.stringify(text);
  }
  return text;
}

// Emit an array. Each element is either a primitive or an object. Objects in
// arrays use the YAML "block" form (`- key: value` on the first line, indented
// keys after).
function emitArray(arr, indent) {
  if (!Array.isArray(arr) || arr.length === 0) return "[]";
  const pad = " ".repeat(indent);
  const lines = [];
  for (const item of arr) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const entries = Object.entries(item);
      if (entries.length === 0) {
        lines.push(`${pad}- {}`);
        continue;
      }
      const [firstKey, firstVal] = entries[0];
      lines.push(`${pad}- ${firstKey}: ${emitInline(firstVal, indent + 4)}`);
      for (let i = 1; i < entries.length; i++) {
        const [k, v] = entries[i];
        lines.push(`${pad}  ${k}: ${emitInline(v, indent + 4)}`);
      }
    } else if (Array.isArray(item)) {
      // Array-in-array: rare; fall back to JSON inline so we don't mis-encode.
      lines.push(`${pad}- ${JSON.stringify(item)}`);
    } else {
      lines.push(`${pad}- ${emitScalar(item)}`);
    }
  }
  return lines.join("\n");
}

// Inline emit: handles a value that follows a `key:` or `- key:` opener.
// Arrays of primitives stay inline as flow `[a, b, c]`; arrays of objects
// break onto the next line at the parent indent + 2.
function emitInline(value, contIndent) {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.every((v) => v === null || typeof v !== "object")) {
      return "[" + value.map(emitScalar).join(", ") + "]";
    }
    return "\n" + emitArray(value, contIndent);
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    return "\n" + emitObject(value, contIndent);
  }
  return emitScalar(value);
}

// Emit a flat-or-nested object (top-level, not inside an array).
function emitObject(obj, indent) {
  if (!obj || typeof obj !== "object") return emitScalar(obj);
  const entries = Object.entries(obj);
  if (entries.length === 0) return "{}";
  const pad = " ".repeat(indent);
  const lines = [];
  for (const [key, val] of entries) {
    lines.push(`${pad}${key}: ${emitInline(val, indent + 2)}`);
  }
  return lines.join("\n");
}

// Public top-level emitter. We hand-roll a small frontmatter shape so the
// frontmatter has predictable key order and no leading blank line.
function emitYamlBlock(obj) {
  return emitObject(obj, 0);
}

// ── YAML parsing (matched subset) ──────────────────────────────────────────
//
// Parses what we emit, plus a little forgiveness for hand-edited files
// (extra whitespace, `~` for null, single-quoted scalars). We do NOT support
// anchors, multi-document streams, or block scalars.

function parseYamlScalar(raw) {
  const text = raw.trim();
  if (text === "" || text === "~" || text === "null") return null;
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^-?\d+$/.test(text)) {
    const n = parseInt(text, 10);
    return Number.isFinite(n) ? n : text;
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : text;
  }
  // Quoted strings — JSON.parse handles double-quoted; trim single quotes.
  if (text.startsWith('"') && text.endsWith('"')) {
    try { return JSON.parse(text); } catch { return text.slice(1, -1); }
  }
  if (text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function parseInlineList(raw) {
  // Strip surrounding [ ]; split top-level commas; handle quoted items.
  const inner = raw.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let buf = "";
  let depth = 0;
  let quote = null;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (quote) {
      buf += c;
      if (c === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "," && depth === 0) { items.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim().length > 0) items.push(buf);
  return items.map((s) => parseYamlScalar(s));
}

// Indentation + structural parser. Returns the parsed value (object or array).
function parseYamlBlock(text) {
  // Tokenize into lines, preserving leading whitespace. Drop blank lines and
  // comment-only lines.
  const lines = text.split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l, _i) => {
      if (l.trim() === "") return false;
      if (/^\s*#/.test(l)) return false;
      return true;
    });
  if (lines.length === 0) return null;

  // Convert each line into { indent, content }. Distinguish array items
  // (start with `-`) from key/value lines.
  const tokens = lines.map((l) => {
    const indent = l.length - l.trimStart().length;
    return { indent, content: l.trimStart(), raw: l };
  });

  let cursor = 0;

  function parseBlock(currentIndent) {
    // Determine if the first token at this indent is a list item or a map.
    const first = tokens[cursor];
    if (!first || first.indent < currentIndent) return null;
    const isList = first.content.startsWith("- ");
    if (isList) return parseList(currentIndent);
    return parseMap(currentIndent);
  }

  function parseList(indent) {
    const out = [];
    while (cursor < tokens.length) {
      const t = tokens[cursor];
      if (t.indent < indent) break;
      if (t.indent > indent) break;
      if (!t.content.startsWith("- ")) break;
      cursor++;
      const itemContent = t.content.slice(2); // strip "- "
      // The item can be: scalar, inline list, key:value (start of an obj).
      if (itemContent.includes(": ") || /:\s*$/.test(itemContent)) {
        // Object item. Synthesize a virtual map starting at this token's
        // indent + 2 (the position of the first key).
        const itemIndent = indent + 2;
        const obj = {};
        // Parse the first key on the same line.
        const { key, value } = splitKeyValue(itemContent);
        if (value === "" || value === undefined) {
          // Nested block follows.
          obj[key] = parseNested(itemIndent);
        } else {
          obj[key] = parseScalarOrInline(value);
        }
        // Continue collecting same-indent map keys belonging to this item.
        while (cursor < tokens.length) {
          const t2 = tokens[cursor];
          if (t2.indent !== itemIndent) break;
          if (t2.content.startsWith("- ")) break;
          cursor++;
          const { key: k2, value: v2 } = splitKeyValue(t2.content);
          if (v2 === "" || v2 === undefined) {
            obj[k2] = parseNested(itemIndent + 2);
          } else {
            obj[k2] = parseScalarOrInline(v2);
          }
        }
        out.push(obj);
      } else if (itemContent.startsWith("[")) {
        out.push(parseInlineList(itemContent));
      } else {
        out.push(parseYamlScalar(itemContent));
      }
    }
    return out;
  }

  function parseMap(indent) {
    const obj = {};
    while (cursor < tokens.length) {
      const t = tokens[cursor];
      if (t.indent < indent) break;
      if (t.indent > indent) break;
      if (t.content.startsWith("- ")) break;
      cursor++;
      const { key, value } = splitKeyValue(t.content);
      if (value === "" || value === undefined) {
        obj[key] = parseNested(indent + 2);
      } else {
        obj[key] = parseScalarOrInline(value);
      }
    }
    return obj;
  }

  function parseNested(childIndent) {
    // Look at next token. If it's at >= childIndent and is a list start,
    // parse as list at its own indent. If it's a map at its own indent, parse
    // map. If nothing nests, return null.
    if (cursor >= tokens.length) return null;
    const t = tokens[cursor];
    if (t.indent < childIndent) return null;
    return parseBlock(t.indent);
  }

  function parseScalarOrInline(s) {
    const trimmed = s.trim();
    if (trimmed.startsWith("[")) return parseInlineList(trimmed);
    if (trimmed.startsWith("{")) {
      // Inline object — rare in our shape; fall back to JSON5-ish via JSON.
      try { return JSON.parse(trimmed); } catch { return trimmed; }
    }
    return parseYamlScalar(trimmed);
  }

  function splitKeyValue(line) {
    // Find the first `: ` or trailing `:` at top level (not inside quotes).
    let depth = 0;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) { if (c === quote && line[i - 1] !== "\\") quote = null; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "[" || c === "{") { depth++; continue; }
      if (c === "]" || c === "}") { depth--; continue; }
      if (c === ":" && depth === 0) {
        const after = line.slice(i + 1);
        if (after === "" || after.startsWith(" ")) {
          return { key: line.slice(0, i).trim(), value: after.replace(/^\s/, "") };
        }
      }
    }
    return { key: line.trim(), value: "" };
  }

  // Top-level: detect map vs list.
  const firstIndent = tokens[0].indent;
  return parseBlock(firstIndent);
}

// ── Frontmatter + section helpers ──────────────────────────────────────────

function parseFrontmatter(md) {
  // Only accept `---\n...\n---\n` at the very start.
  if (!md.startsWith("---\n")) return { frontmatter: {}, body: md };
  const end = md.indexOf("\n---\n", 4);
  if (end < 0) return { frontmatter: {}, body: md };
  const yamlBody = md.slice(4, end);
  const frontmatter = parseYamlBlock(yamlBody) || {};
  const body = md.slice(end + 5); // skip "\n---\n"
  return { frontmatter, body };
}

// Find a fenced code block following a header line. Returns the inner content
// (without the ```...``` wrapper) or null if none found at that header.
//
// We accept the fence with or without a leading newline (the header match
// usually consumes the trailing `\n` so the fence sits at offset 0 of the
// remainder). `lang` is the optional code-block language tag; pass "" to
// match a plain fence.
function readFencedAfter(body, headerRegex, lang) {
  const headerMatch = body.match(headerRegex);
  if (!headerMatch) return null;
  const start = headerMatch.index + headerMatch[0].length;
  const fenceTag = "```" + (lang || "");
  // Find the next fence opener, allowing for arbitrary whitespace between
  // the header and the fence.
  const remainder = body.slice(start);
  const fenceMatch = remainder.match(new RegExp("^\\s*" + fenceTag.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&") + "\\s*\\n"));
  if (!fenceMatch) return null;
  const innerStart = start + fenceMatch[0].length;
  const closeIdx = body.indexOf("\n```", innerStart);
  if (closeIdx < 0) return null;
  return body.slice(innerStart, closeIdx);
}

// ── Project → markdown ─────────────────────────────────────────────────────

// Strip studio-only fields off each canvas node before emitting. Mirrors the
// agent-md/v1 contract — no x/y/w/h, no mockOutput. fixture.source is also
// dropped; only fixture.inputs (replayable) survives, and lives in its own
// "## Fixtures" section, not on the node.
function nodeForExport(n) {
  return {
    id: n.id,
    role: n.role,
    title: n.title,
    description: n.description ?? "",
    inputs: Array.isArray(n.inputs) ? n.inputs.slice() : [],
    outputs: Array.isArray(n.outputs) ? n.outputs.slice() : [],
  };
}

export function exportProjectToMarkdown(project, options = {}) {
  if (!project || typeof project !== "object") {
    throw new Error("exportProjectToMarkdown: project required");
  }

  const exportedAt = options.exportedAt ?? new Date().toISOString();
  const projectName = project.name || "Untitled project";

  // Frontmatter is the portable runtime envelope. Studio-only state (status,
  // snapshots, runCache, working folder) MUST NOT appear here.
  const frontmatter = {
    agent_spec: SCHEMA_VERSION,
    name: projectName,
    created_at: typeof project.createdAt === "string" ? project.createdAt : exportedAt,
    exported_at: exportedAt,
    runtime: "local-nextjs",
    framework: "custom-loop",
    model_provider: "ollama",
    sandbox: "workspace-write",
    autonomy: "human-in-loop",
  };

  const nodes = Array.isArray(project.canvas?.nodes) ? project.canvas.nodes : [];
  const edges = Array.isArray(project.canvas?.edges) ? project.canvas.edges : [];
  const exportedNodes = nodes.map(nodeForExport);
  const exportedEdges = edges.map((e) => ({ from: e.from, to: e.to }));

  const overrides = project.rolePromptOverrides && typeof project.rolePromptOverrides === "object"
    ? project.rolePromptOverrides
    : {};

  // Per-node instructions — emitted as their own section so prose stays in
  // markdown form, not crammed into a YAML scalar.
  const instructionsBlocks = nodes.map((n) => {
    const body = typeof n.instructions === "string" && n.instructions.trim().length > 0
      ? n.instructions
      : "_none_";
    const titleLabel = (n.title ?? n.id).trim() || n.id;
    return `### ${titleLabel} (\`${n.id}\`)\n${body}`;
  });

  // Fixtures — replayable bucket. fixture.source is studio-only and dropped.
  const fixtureBlocks = nodes
    .filter((n) => n.fixture && typeof n.fixture === "object" && "inputs" in n.fixture)
    .map((n) => `### \`${n.id}\`\n\`\`\`json\n${JSON.stringify(n.fixture.inputs, null, 2)}\n\`\`\``);

  const goalText = project.goal && project.goal.trim().length > 0 ? project.goal : "_none_";
  const contextText = project.context && project.context.trim().length > 0 ? project.context : "_none_";
  const outcomeText = project.outcome && project.outcome.trim().length > 0 ? project.outcome : "_none_";

  const md = `---
${emitYamlBlock(frontmatter)}
---

# ${projectName}

## Goal
${goalText}

## Context
${contextText}

## Outcome
${outcomeText}

## Role prompt overrides
\`\`\`yaml
${emitYamlBlock(overrides) || "{}"}
\`\`\`

## Graph

### Nodes
\`\`\`yaml
${emitArray(exportedNodes, 0)}
\`\`\`

### Edges
\`\`\`yaml
${emitArray(exportedEdges, 0)}
\`\`\`

## Per-node instructions
${instructionsBlocks.join("\n\n") || "_none_"}

## Fixtures (replayable)
${fixtureBlocks.join("\n\n") || "_none_"}
`;
  return md;
}

// ── Markdown → project ─────────────────────────────────────────────────────

function readSection(body, headerRegex) {
  const m = body.match(headerRegex);
  if (!m) return "";
  const start = m.index + m[0].length;
  // The matched header begins with a run of `#`s; find the count so we look
  // for a same-or-lower-level next heading as the terminator. We scan from
  // `start` onward (don't look back at the header itself).
  const headerText = m[0].replace(/^\n/, "");
  const level = (headerText.match(/^#+/)?.[0]?.length) ?? 2;
  // Build a regex that matches the start of a subsequent heading at <= level.
  // Anchor to line start with a leading `\n` since `^` with the m flag would
  // also match the very first character of the slice (mid-section text can't
  // begin with `#` because we already split fences out, but be defensive).
  const hashes = "#".repeat(level);
  // Match `\n# `, `\n## ` … up to `\n${hashes} ` exactly. We include lower
  // levels (fewer `#`s) so a parent heading also terminates the slice.
  const altPatterns = [];
  for (let lv = 1; lv <= level; lv++) {
    altPatterns.push("#".repeat(lv));
  }
  const nextRe = new RegExp("\\n(?:" + altPatterns.join("|") + ")\\s+", "g");
  nextRe.lastIndex = start;
  const next = nextRe.exec(body);
  const slice = body.slice(start, next ? next.index : body.length);
  return slice.trim();
}

function importYamlBlockUnder(body, headerRegex, lang) {
  const inner = readFencedAfter(body, headerRegex, lang);
  if (inner === null) return null;
  return parseYamlBlock(inner);
}

// Lay imported nodes in a horizontal lane (same algorithm as
// spec-export.importSpecToProject so the visual feels familiar).
function layoutNodes(nodes, edges) {
  const incoming = new Map();
  for (const n of nodes) incoming.set(n.id, new Set());
  for (const e of edges) {
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
  for (const n of nodes) depthOf(n.id);
  const perColumn = new Map();
  return nodes.map((n) => {
    const col = depth.get(n.id) ?? 0;
    const row = perColumn.get(col) ?? 0;
    perColumn.set(col, row + 1);
    return { x: 120 + col * 280, y: 80 + row * 200, w: 220, h: 130 };
  });
}

export function importMarkdownToProject(md, options = {}) {
  if (typeof md !== "string" || !md.trim()) {
    throw new Error("importMarkdownToProject: markdown string required");
  }
  const { frontmatter, body } = parseFrontmatter(md);
  if (frontmatter.agent_spec && frontmatter.agent_spec !== SCHEMA_VERSION) {
    throw new Error(
      `importMarkdownToProject: unsupported agent_spec "${frontmatter.agent_spec}", expected "${SCHEMA_VERSION}"`,
    );
  }

  const goal = readSection(body, /^##\s+Goal\s*\n/m);
  const context = readSection(body, /^##\s+Context\s*\n/m);
  const outcome = readSection(body, /^##\s+Outcome\s*\n/m);

  const overrides = importYamlBlockUnder(body, /^##\s+Role prompt overrides\s*\n/m, "yaml") || {};
  const nodesRaw = importYamlBlockUnder(body, /^###\s+Nodes\s*\n/m, "yaml") || [];
  const edgesRaw = importYamlBlockUnder(body, /^###\s+Edges\s*\n/m, "yaml") || [];

  // Per-node instructions: parse out each `### <title> (\`id\`)` block.
  const instructionsSection = readSection(body, /^##\s+Per-node instructions\s*\n/m);
  const instructionsByNode = new Map();
  if (instructionsSection && instructionsSection !== "_none_") {
    const re = /^###\s+(?:.*?)\s*\(`([^`]+)`\)\s*\n([\s\S]*?)(?=\n###\s|$)/gm;
    let m;
    while ((m = re.exec(instructionsSection)) !== null) {
      const id = m[1];
      const text = m[2].trim();
      if (text === "_none_") {
        instructionsByNode.set(id, "");
      } else {
        instructionsByNode.set(id, text);
      }
    }
  }

  // Fixtures: parse out each `### \`id\`` block followed by a JSON fence.
  const fixturesSection = readSection(body, /^##\s+Fixtures\s+\(replayable\)\s*\n/m);
  const fixturesByNode = new Map();
  if (fixturesSection && fixturesSection !== "_none_") {
    const re = /^###\s+`([^`]+)`\s*\n```json\n([\s\S]*?)\n```/gm;
    let m;
    while ((m = re.exec(fixturesSection)) !== null) {
      const id = m[1];
      try {
        const inputs = JSON.parse(m[2]);
        fixturesByNode.set(id, { inputs, source: "manual" });
      } catch {
        // Skip malformed fixture blocks; project still imports.
      }
    }
  }

  const layoutNodesRaw = nodesRaw.map((n) => ({
    id: n.id,
    role: n.role || "agent",
    title: n.title || n.id,
    description: n.description || "",
    inputs: Array.isArray(n.inputs) ? n.inputs : [],
    outputs: Array.isArray(n.outputs) ? n.outputs : [],
  }));
  const positions = layoutNodes(layoutNodesRaw, edgesRaw);
  const nodes = layoutNodesRaw.map((n, i) => ({
    ...n,
    instructions: instructionsByNode.get(n.id) || "",
    x: positions[i].x,
    y: positions[i].y,
    w: positions[i].w,
    h: positions[i].h,
    fixture: fixturesByNode.has(n.id) ? fixturesByNode.get(n.id) : null,
    mockOutput: null,
  }));

  const edges = edgesRaw.map((e) => ({ id: `${e.from}->${e.to}`, from: e.from, to: e.to }));

  const projectId = options.projectId
    || `p-md-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  // Importer always returns a v6-shape draft project. Studio-only fields
  // (snapshots, status, runCache) take their defaults — they were stripped on
  // export by contract, so there's nothing to restore.
  return {
    id: projectId,
    name: typeof frontmatter.name === "string" ? frontmatter.name : "Imported project",
    workingFolder: "",
    createdAt: typeof frontmatter.created_at === "string"
      ? frontmatter.created_at
      : new Date().toISOString(),
    goal: goal === "_none_" ? "" : goal,
    context: context === "_none_" ? "" : context,
    outcome: outcome === "_none_" ? "" : outcome,
    uploads: [],
    rolePromptOverrides: overrides && typeof overrides === "object" ? { ...overrides } : {},
    runCache: {},
    status: "draft",
    snapshots: [],
    canvas: {
      nodes,
      edges,
      pan: { x: 0, y: 0 },
      zoom: 1,
    },
  };
}

// Exposed for tests + the round-trip harness.
export const _internal = {
  emitYamlBlock,
  parseYamlBlock,
  parseFrontmatter,
  SCHEMA_VERSION,
};
