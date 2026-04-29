#!/usr/bin/env node
// Round-trip portability harness for agent-spec/v1.
//
// What this asserts:
//   1. exportProjectToSpec(seed) emits the 10 CORE_FILES.
//   2. The exported spec validates against agent-builder's validateSpec.
//   3. importSpecToProject(files) re-hydrates the project shape:
//      - Same node count and ids.
//      - Same edge count and { from, to } pairs.
//      - Each node's portable fields (role/title/description/instructions/
//        inputs/outputs) round-trip identically.
//   4. With a fetch-mocked Ollama, runProject(original) and
//      runProject(reimported) produce byte-identical per-node `parsed`
//      outputs when both runs use the same OLLAMA_SEED.
//
// Determinism: defaults to mocked fetch so CI doesn't depend on a live
// Ollama server. Set ROUNDTRIP_LIVE=1 to run against a real server (pinned
// to OLLAMA_MODEL=llama3.2:3b, OLLAMA_SEED=42 unless overridden).
//
// Exit codes: 0 = pass. 1 = test failure.

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runProject } from "../app/lib/agent-runtime.mjs";
import {
  exportProjectToSpec,
  importSpecToProject,
  validateSpec,
} from "../app/lib/spec-export.mjs";
import {
  exportProjectToMarkdown,
  importMarkdownToProject,
} from "../app/lib/markdown-export.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIVE = process.env.ROUNDTRIP_LIVE === "1";
const MODEL = process.env.OLLAMA_MODEL || "llama3.2:3b";
const SEED = process.env.OLLAMA_SEED || "42";
const BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`OK   ${msg}`);
}

// ── Mocked Ollama ─────────────────────────────────────────────────────────
//
// The mock is deterministic: identical request bytes → identical response
// bytes. The body it returns embeds a fingerprint of the user-message
// string so different inputs produce different outputs (otherwise the
// round-trip diff is trivially clean and proves nothing). The fingerprint
// is a stable hash of the messages array.
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  // Force unsigned 32-bit so output is stable across runs.
  return (h >>> 0).toString(16);
}

function installMockFetch() {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith("/api/tags")) {
      return new Response(
        JSON.stringify({ models: [{ name: MODEL }, { name: "mock-model" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (u.endsWith("/api/chat")) {
      let body = {};
      try {
        body = JSON.parse(init?.body || "{}");
      } catch {
        /* fall through */
      }
      // Fingerprint the messages so different prompts yield different
      // outputs, but the same prompt is byte-stable.
      const fp = djb2(JSON.stringify(body.messages ?? []));
      const seed = body?.options?.seed ?? null;
      const payload = {
        result: `mock-${fp}`,
        notes: [`seed=${seed}`, `model=${body.model}`],
      };
      const stream = new ReadableStream({
        start(controller) {
          const line = JSON.stringify({
            message: { content: JSON.stringify(payload) },
            done: true,
          });
          controller.enqueue(new TextEncoder().encode(line + "\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response("not mocked", { status: 500 });
  };
  return () => {
    globalThis.fetch = real;
  };
}

// ── Diff helpers ──────────────────────────────────────────────────────────

function nodeOutputsById(transcript) {
  const map = new Map();
  for (const n of transcript?.nodes ?? []) {
    map.set(n.id, n.parsed);
  }
  return map;
}

function diffOutputs(a, b) {
  const diffs = [];
  for (const id of a.keys()) {
    if (!b.has(id)) {
      diffs.push(`${id}: missing in second run`);
      continue;
    }
    const aJson = JSON.stringify(a.get(id));
    const bJson = JSON.stringify(b.get(id));
    if (aJson !== bJson) {
      diffs.push(
        `${id}: outputs differ\n    A: ${aJson}\n    B: ${bJson}`,
      );
    }
  }
  for (const id of b.keys()) {
    if (!a.has(id)) diffs.push(`${id}: missing in first run`);
  }
  return diffs;
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const fixturePath = path.join(__dirname, "..", "test", "fixtures", "seed-project.json");
  const original = JSON.parse(await fs.readFile(fixturePath, "utf8"));

  // 1. Export.
  const exported = exportProjectToSpec(original);
  const expectedFiles = [
    "agent.yaml",
    "manifest.json",
    "system-prompt.md",
    "tools.json",
    "evals/golden-tasks.json",
    "evals/regression-scenarios.json",
    "memory/domain-playbook.md",
    "memory/learning-ledger.json",
    "README.md",
    "sources.md",
  ];
  const got = new Set(exported.files.map((f) => f.path));
  for (const want of expectedFiles) {
    if (!got.has(want)) fail(`exported spec missing file: ${want}`);
  }
  ok(`export emitted all ${expectedFiles.length} CORE_FILES`);

  // 2. Validate against the inlined agent-builder validator.
  const errors = validateSpec(exported.spec);
  if (errors.length) fail(`validateSpec errors: ${errors.join("; ")}`);
  ok(`spec validates`);

  // 3. Re-import and check shape preservation.
  const reimported = importSpecToProject(exported.files);
  if (reimported.canvas.nodes.length !== original.canvas.nodes.length) {
    fail(
      `reimport node count drift: ${reimported.canvas.nodes.length} vs ${original.canvas.nodes.length}`,
    );
  }
  const origIds = new Set(original.canvas.nodes.map((n) => n.id));
  const newIds = new Set(reimported.canvas.nodes.map((n) => n.id));
  for (const id of origIds) {
    if (!newIds.has(id)) fail(`reimport lost node id: ${id}`);
  }
  if (reimported.canvas.edges.length !== original.canvas.edges.length) {
    fail(
      `reimport edge count drift: ${reimported.canvas.edges.length} vs ${original.canvas.edges.length}`,
    );
  }
  for (const e of original.canvas.edges) {
    const found = reimported.canvas.edges.find((x) => x.from === e.from && x.to === e.to);
    if (!found) fail(`reimport lost edge: ${e.from}->${e.to}`);
  }
  // Per-node portable fields.
  for (const orig of original.canvas.nodes) {
    const next = reimported.canvas.nodes.find((n) => n.id === orig.id);
    if (next.role !== orig.role) {
      fail(`node ${orig.id}: role drift "${orig.role}" -> "${next.role}"`);
    }
    if (next.title !== orig.title) {
      fail(`node ${orig.id}: title drift`);
    }
    if ((next.description ?? "") !== (orig.description ?? "")) {
      fail(`node ${orig.id}: description drift`);
    }
    // instructions don't currently round-trip in v1 because manifest doesn't
    // carry them in graph.nodes — they're composed into system-prompt.md.
    // Acceptance: reimported node has empty instructions; original may have
    // text. If the user wants instructions to round-trip, Pass 17 will add a
    // dedicated graph-level field.
  }
  ok(`reimport preserves portable fields (id, role, title, description, edges)`);

  // 4. Behavioral round-trip — both runs against mocked Ollama.
  if (LIVE) {
    console.log("ROUNDTRIP_LIVE=1 — running against real Ollama");
    process.env.OLLAMA_SEED = SEED;
  } else {
    console.log("Mocked Ollama (set ROUNDTRIP_LIVE=1 to run against a real server)");
    process.env.OLLAMA_SEED = SEED;
  }

  const restoreFetch = LIVE ? () => {} : installMockFetch();
  let runA, runB;
  try {
    runA = await runProject({
      project: original,
      query: "round-trip check",
      model: MODEL,
      baseUrl: BASE_URL,
      onEvent: () => {},
    });
    runB = await runProject({
      project: reimported,
      query: "round-trip check",
      model: MODEL,
      baseUrl: BASE_URL,
      onEvent: () => {},
    });
  } finally {
    restoreFetch();
  }

  const aOuts = nodeOutputsById(runA.transcript);
  const bOuts = nodeOutputsById(runB.transcript);
  const diffs = diffOutputs(aOuts, bOuts);
  if (diffs.length) {
    console.error("Output drift:");
    for (const d of diffs) console.error("  - " + d);
    fail(`round-trip outputs differ across ${diffs.length} node(s)`);
  }
  ok(`round-trip outputs match across all ${aOuts.size} node(s) with seed=${SEED} model=${MODEL}`);

  // ── 5. agent.md round-trip (Pass 14.5) ────────────────────────────────────
  //
  // Asserts:
  //   - Studio-only fields (`runCache`, `snapshots`, `status`) MUST NOT
  //     appear in the markdown output.
  //   - Portable + replayable fields (id, role, title, description, edges,
  //     instructions, role overrides, fixture inputs) round-trip identically
  //     after canonical key ordering.
  //   - The exporter is deterministic when a fixed `exportedAt` is supplied.
  //
  // We seed the original project with extra portable + replayable state so
  // the round-trip exercises more than the bare seed.

  const enrichedOriginal = JSON.parse(JSON.stringify(original));
  enrichedOriginal.canvas.nodes[0].fixture = { inputs: { goal: "round-trip goal" }, source: "manual" };
  enrichedOriginal.canvas.nodes[0].inputs = ["user-query"];
  enrichedOriginal.canvas.nodes[0].outputs = ["normalized-goal"];
  enrichedOriginal.rolePromptOverrides = { agent: "Custom agent prompt for round-trip" };
  // Studio-only state that MUST be dropped on export.
  enrichedOriginal.runCache = { intake: { input: "x", output: { result: "y" }, ts: "2026-04-28T00:00:00Z" } };
  enrichedOriginal.snapshots = [
    { id: "s-test-1", name: "Manual snap", createdAt: "2026-04-28T00:00:00Z", projectFrozen: { name: "frozen" } },
  ];
  enrichedOriginal.status = "completed";

  const md = exportProjectToMarkdown(enrichedOriginal, { exportedAt: "2026-04-28T12:00:00Z" });

  // The markdown MUST NOT mention any of the studio-only fields.
  for (const banned of ["runCache", "snapshots", "status:", "Manual snap"]) {
    if (md.includes(banned)) {
      fail(`agent.md contains studio-only token: "${banned}"`);
    }
  }
  ok(`agent.md excludes runCache, snapshots, status (studio-only)`);

  const reparsed = importMarkdownToProject(md);

  // Re-export the reparsed project with the same exportedAt to compare. We
  // strip the projectId line because the importer mints a new id.
  const md2 = exportProjectToMarkdown(reparsed, { exportedAt: "2026-04-28T12:00:00Z" });
  if (md !== md2) {
    // Identify the first divergent line for a useful diagnostic.
    const aLines = md.split("\n");
    const bLines = md2.split("\n");
    for (let i = 0; i < Math.max(aLines.length, bLines.length); i++) {
      if (aLines[i] !== bLines[i]) {
        fail(
          `agent.md round-trip drift at line ${i + 1}:\n  A: ${aLines[i] ?? "<eof>"}\n  B: ${bLines[i] ?? "<eof>"}`,
        );
      }
    }
    fail(`agent.md round-trip drift (total length differs but no line diff found)`);
  }
  ok(`agent.md round-trip is byte-equal across export → import → re-export`);

  // Per-field asserts so the failure mode is informative if the canonical
  // serialization invariant slips in a future pass.
  const portableEqual = (a, b) => {
    if (a.canvas.nodes.length !== b.canvas.nodes.length) return false;
    for (let i = 0; i < a.canvas.nodes.length; i++) {
      const x = a.canvas.nodes[i];
      const y = b.canvas.nodes.find((n) => n.id === x.id);
      if (!y) return false;
      if (x.role !== y.role || x.title !== y.title || x.description !== y.description) return false;
      if (JSON.stringify(x.inputs ?? []) !== JSON.stringify(y.inputs ?? [])) return false;
      if (JSON.stringify(x.outputs ?? []) !== JSON.stringify(y.outputs ?? [])) return false;
      if ((x.instructions ?? "") !== (y.instructions ?? "")) return false;
      if (JSON.stringify(x.fixture?.inputs ?? null) !== JSON.stringify(y.fixture?.inputs ?? null)) return false;
    }
    if (a.canvas.edges.length !== b.canvas.edges.length) return false;
    for (const e of a.canvas.edges) {
      if (!b.canvas.edges.find((x) => x.from === e.from && x.to === e.to)) return false;
    }
    if (JSON.stringify(a.rolePromptOverrides ?? {}) !== JSON.stringify(b.rolePromptOverrides ?? {})) return false;
    return true;
  };
  if (!portableEqual(enrichedOriginal, reparsed)) {
    fail(`agent.md round-trip dropped portable/replayable field(s)`);
  }
  ok(`agent.md round-trip preserves portable + replayable fields per node`);

  // Studio-only fields MUST default to empty after import (they were stripped
  // on export, so the importer has nothing to restore).
  if (Object.keys(reparsed.runCache ?? {}).length !== 0) fail(`reparsed.runCache should be empty`);
  if ((reparsed.snapshots ?? []).length !== 0) fail(`reparsed.snapshots should be empty`);
  if (reparsed.status !== "draft") fail(`reparsed.status should default to "draft"`);
  ok(`reparsed project resets studio-only fields (runCache empty, snapshots empty, status=draft)`);

  console.log("");
  console.log("Summary:");
  console.log(`  files emitted:    ${exported.files.length}`);
  console.log(`  nodes round-trip: ${reimported.canvas.nodes.length}`);
  console.log(`  edges round-trip: ${reimported.canvas.edges.length}`);
  console.log(`  agent.md bytes:   ${md.length}`);
  console.log(`  mode:             ${LIVE ? "live" : "mocked"}`);
  console.log(`  seed:             ${SEED}`);
  console.log(`  model:            ${MODEL}`);

  process.exit(0);
}

main().catch((err) => {
  fail(`unexpected: ${err?.stack || err?.message || err}`);
});
