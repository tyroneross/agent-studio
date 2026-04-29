# Agent Spec — `agent-spec/v1`

**Frozen:** Pass 14 (2026-04-28). Additive extensions allowed; breaking changes bump to `agent-spec/v2`.

This document is the **portability contract** for Agent Studio. Every node-level field added by any future pass falls into exactly one bucket: **portable**, **replayable**, or **studio-only**. The pass that adds the field must name its bucket. Round-trip (export → wipe → import → re-run) is enforced from Pass 14 onward by `npm run test:roundtrip`.

The on-disk format mirrors `agent-builder/lib/build-files.js` so a spec produced by Agent Studio is consumable, unmodified, by `agent-builder` v0.3.0.

---

## On-disk layout

A spec is a directory with these 10 files. The set is fixed and matches `agent-builder/lib/generator.js#CORE_FILES` exactly so downstream tools can rely on the shape:

```
<spec-root>/
  agent.yaml                       # name, runtime, framework, autonomy, declared inputs/outputs, graph
  manifest.json                    # tool registry, permissions, sandbox tier, full graph
  system-prompt.md                 # composed from role templates + node instructions
  tools.json                       # tool descriptions per node that uses them
  evals/
    golden-tasks.json              # fixture inputs + expected outputs (replayable)
    regression-scenarios.json      # seeded from learning exemplars (empty stub OK)
  memory/
    domain-playbook.md             # promoted lessons (empty stub OK)
    learning-ledger.json           # ledger of accepted/rejected lessons (empty stub OK)
  README.md                        # human-readable summary, list of stripped studio-only fields
  sources.md                       # source registry references
```

Files that Agent Studio doesn't yet populate ship as **empty stubs** with the correct schema header. This keeps `agent-builder/lib/build-files.js` happy without forcing the studio to generate content it doesn't have.

---

## Bucket table — every node-level field declared by Pass 14

| Field | Bucket | Where it goes on export | Notes |
|---|---|---|---|
| `id` | portable | `agent.yaml#graph.nodes[].id`, `manifest.json#graph.nodes[].id` | Stable identifier, used by edges. |
| `role` | portable | `agent.yaml#graph.nodes[].kind`, `manifest.json#graph.nodes[].kind` | Studio's `role` maps to agent-builder's `kind`. Values: `agent`, `guardrail`, `orchestrator`, `executor`, `eval`, `memory`. |
| `title` | portable | `agent.yaml#graph.nodes[].title`, `manifest.json#graph.nodes[].title` | Display name. Required by `validateSpec`. |
| `description` | portable | `system-prompt.md` (per-node section), `manifest.json` (via toYaml inside graph) | Drives the system-prompt `## <title>` body. |
| `instructions` | portable | `system-prompt.md` (per-node section, appended after description) | Pass 7 per-node instructions. Composed into the role template. |
| `x`, `y`, `w`, `h` | studio-only | (excluded; stripped on export) | Layout hints. Not part of agent semantics. |
| `inputs[]` | portable | `agent.yaml#graph.nodes[].inputs`, `manifest.json#graph.nodes[].inputs`, `agent.yaml#inputs` (project-level union) | Declared input tags drive the runtime's data flow. |
| `outputs[]` | portable | `agent.yaml#graph.nodes[].outputs`, `manifest.json#graph.nodes[].outputs`, `agent.yaml#outputs` (project-level union) | Declared output tags drive the runtime's data flow. |
| `fixture: { inputs, source }` (Pass 14) | portable (inputs) + studio-only (source) | `evals/golden-tasks.json` (inputs only, paired with the most recent `runCache` output if present) | The user-saved test inputs for this node. `source: "manual" \| "upstream-cache"` is editor metadata only and is dropped on export. |
| `mockOutput` (Pass 14, populated by Pass 15) | studio-only | (excluded; stripped on export) | Substitutes Ollama's response when set. Useful for testing downstream cheaply. Never exported because the spec must always represent a real runtime. |

**Edges** (`canvas.edges`) are portable in full (`{from, to}`). They land in `agent.yaml#graph.edges` and `manifest.json#graph.edges`.

**Project-level** fields:

| Field | Bucket | Where it goes on export |
|---|---|---|
| `name` | portable | `agent.yaml#name`, `manifest.json#name` |
| `goal` + `context` + `outcome` | portable | `agent.yaml#description` (composed), `system-prompt.md` (Job section) |
| `workingFolder` | studio-only | (excluded) |
| `uploads[]` | studio-only for v1 | (excluded; the file paths are local and uploaded contents are inlined into prompts at runtime, not into the spec) |
| `rolePromptOverrides` | portable | `system-prompt.md` (composed via `getEffectiveRoleTemplate`) |
| `runCache` (Pass 14) | studio-only | (excluded; stripped on export with a one-line note in `README.md`) |
| `canvas.pan`, `canvas.zoom` | studio-only | (excluded) |

---

## Defaults filled at export time

Agent Studio doesn't carry every field that `agent-builder/lib/generator.js#normalizeSpec` expects. Rather than asking the user up front, export fills these conservative defaults — chosen to (a) match the current studio runtime (Ollama, local Next.js) and (b) survive `validateSpec` without complaint:

| agent-builder field | Default | Rationale |
|---|---|---|
| `patternId` | `solo-tool-agent` | The studio's seed graph is a Solo Tool Agent. Override at import if a future pattern picker lands. |
| `runtime` | `local-nextjs` | Studio runs in Next.js against local Ollama. |
| `framework` | `custom-loop` | The studio's runtime is a hand-rolled DAG, not a third-party framework. |
| `modelProvider` | `ollama` | Today's only provider. |
| `sandbox` | `workspace-write` | Conservative default; matches agent-builder's own default. |
| `autonomy` | `human-in-loop` | Solo Tool Agent's autonomy setting. |
| `tools[]` | `[]` | Studio doesn't model tools as first-class today. Empty array passes `validateSpec`. |
| `sources[]` | `[]` | Inherited from `solo-tool-agent` pattern's source list at export time. |
| `permissions` | inherited from `solo-tool-agent` pattern | `validateSpec` doesn't require a specific shape; inheriting keeps round-trip clean. |
| `memory` | inherited from `solo-tool-agent` pattern | Same reasoning. |
| `evals[]` | empty list | Populated from per-node `fixture` inputs at export time (one golden task per node that has a fixture). |

These defaults are the only fields that don't round-trip identically: they're set on export and re-set on import. As long as the studio doesn't surface them in the editor, that's fine — round-trip is concerned with **runtime behavior**, not with byte-equivalence of the YAML.

---

## Round-trip contract

`npm run test:roundtrip` enforces:

1. Load a fixture project (`test/fixtures/seed-project.json`).
2. `exportProjectToSpec(project)` → in-memory `{files: [{path, content}]}` matching the on-disk layout above.
3. `importSpecToProject(files)` → a v5 project. Studio-only fields default to empty.
4. Run the original project once with `OLLAMA_SEED=42` and `OLLAMA_MODEL=llama3.2:3b`.
5. Run the imported project with the same seed and model.
6. Diff per-node `parsed` outputs from the two transcripts. They must match.

**Determinism scope.** The round-trip is **same-machine, same-Ollama-build, same-pinned-model**. Cross-machine drift is documented as an Ollama property and is out of scope for the round-trip test. CI pins `llama3.2:3b` because it's small (about 2 GB), fast, and deterministic-friendly with `seed`+`temperature: 0`. `gpt-oss:20b` is heavier and more drift-prone; ad-hoc only.

**Mocked Ollama.** `npm run test:roundtrip` runs against a fetch-mocked Ollama by default so it never depends on a live model server. The mock returns identical bytes for identical inputs, which is sufficient to exercise the export / import contract. Live-Ollama round-trip can be enabled by setting `ROUNDTRIP_LIVE=1`; in that mode the test pins seed and model and requires a reachable server.

---

## Versioning

- `agent-spec/v1` — frozen Pass 14. Additive fields allowed (must declare a bucket).
- `agent-spec/v2` — reserved for any breaking change. Bumping requires a migration adapter and round-trip coverage for both versions.

When a future pass extends the spec, it writes the new field into one of the three buckets above, updates this table, and updates `app/lib/spec-export.mjs` + `npm run test:roundtrip` accordingly.

---

## Storage limits — `app/lib/storage-config.mjs`

**Added Pass 14.6.** Every storage-related numeric limit in the studio lives in a single config object. Code never inlines magic numbers; the no-hardcoded-storage grep test (`scripts/test-no-hardcoded-storage.mjs`, wired into `npm run test:self`) fails the build if a literal slips in.

| Field | Default | Purpose |
|---|---|---|
| `warnLevel` | 70 | % full at which the toolbar storage pill turns amber. |
| `blockLevel` | 90 | % full at which the save preflight intercepts saves. |
| `runCacheBytesPerEntry` | 100_000 | Hard cap per cached node output. Above this, the entry is truncated with a marker; full payload is written to `<workingFolder>/runs/<ts>-solo-<nodeId>/`. |
| `runCacheEntriesPerNode` | 1 | Cached runs per node. Pass 14 ships single-entry; future passes can increase. |
| `snapshotsPerProject` | 50 | Older snapshots dropped silently above this cap. |
| `autoSnapshotWhenLow` | true | When false, the auto-snapshot before restore/reopen is skipped at block level (with a one-time toast). |

**Storage:** user-level (not project-level), keyed `agent-studio:storage-config:v1` in localStorage. Changes apply immediately to subsequent saves; no reload needed.

**Consumers** (every file that respects a storage limit):

- `app/lib/projects.js` — `getSnapshotsPerProjectCap()`, `withRunCacheEntry()` (truncation hook).
- `app/api/agent/run-node/route.js` — applies `runCacheBytesPerEntry`, writes truncation transcript when triggered.
- `app/components/SoloRunModal.js` — passes the user's config to the route; surfaces the truncation hint.
- `app/components/StoragePill.js` — reads `warnLevel` / `blockLevel` to classify usage.
- `app/components/StoragePanel.js` — slide-over UI: status, "what's using space", settings.
- `app/canvas/page.js` — save preflight, low-storage toast, trim handlers wired into the panel.

**Rule:** if you add or change a storage-related limit, add the field to `DEFAULT_STORAGE_CONFIG`, surface it in `StoragePanel`'s settings section, document it here, and let the grep test confirm no inline literal slipped in.

---

## What this contract guarantees, and what it does not

It guarantees:

- A spec emitted by Agent Studio is consumable by `agent-builder` v0.3.0 without modification.
- Studio-only fields are never written to a spec, so an external runtime never sees a field it can't act on.
- A round-trip preserves runtime behavior on the same machine.

It does not guarantee:

- Cross-machine deterministic output. Ollama's `options.seed` reproduces same-machine, same-build results; cross-machine drift is documented and out of scope.
- That every consumer of `agent-spec/v1` is `agent-builder` itself. Other runtimes (OpenAI Agents SDK, LangGraph, …) can consume the spec but may need their own adapter; the studio's job is to emit the contract, not to land every adapter.
