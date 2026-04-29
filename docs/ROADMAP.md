# Agent Studio — Roadmap

> Drafted 2026-04-28 after Pass 12. Reframed 2026-04-28: product is a **portable agent editor**; DES patterns are borrowed as a **verification lens**, not a product pivot.

## Bottom line

Agent Studio is a **visual editor for designing and testing agent chains that are portable** — what you build here exports cleanly and runs outside the studio against the same APIs / LLMs (Ollama today, OpenAI / Anthropic / agent-builder runtimes next). Editing must be easy. Export must be honest: if a node carries it, the spec either ships it or marks it as studio-only.

To make editing trustworthy we borrow inspection patterns from discrete-event simulation: run any single node in isolation, step the chain one DAG level at a time, inspect every node's input/output after a run, replay any node from a saved transcript, and substitute mock outputs to test downstream without burning tokens. These are **verification tools for the editor**, not a simulation product.

The four items previously queued (lasso + group drag, LLM-inferred dependencies, generic agent-spec exporter, multi-agent compose) sequence into this framing below. Spec export is no longer a late add-on — its **schema contract is established in Pass 14** and every later pass must respect it.

## Scope of this roadmap

| Pass | Theme | Output |
|---|---|---|
| 13 | UI polish — selection model upgrade | Lasso + group drag on canvas |
| 14 | Single-node solo run + portable spec contract | "Solo run" mode + per-node fixtures + frozen export schema + round-trip harness |
| 14.5 | Save snapshots + completion flag + single-file markdown export | Named project snapshots, "completed" status, round-trip-safe `agent.md` |
| 14.6 | Storage-aware saving | Quota detection, plain-language save preflight, configurable limits, no hardcoded thresholds |
| 15 | Run inspector + step-through + per-node mocks | Inspector panel, level-by-level step mode, mock outputs |
| 16 | Inferred edge ordering for sparse graphs | LLM-inferred dependencies; accepted edges write back to spec |
| 17 | Spec export UI | Export / import `agent.yaml` + `tools.json` + `system-prompt.md` (schema already exists from Pass 14) |
| 18 | Multi-agent compose | One project can call another as a sub-agent; subagent reference is exportable |

Each pass is independent enough to launch as a separate `/build-loop:build-loop` invocation. They share state through the existing project model, DAG runtime, **and the portable spec schema established in Pass 14**.

## Portability contract — the rule every pass follows

Every node-level field added by a pass falls into exactly one bucket. The pass's acceptance criteria must name which.

| Bucket | Where it lives | Where it goes on export | Examples |
|---|---|---|---|
| **Portable** | Project file + spec | `agent.yaml`, `tools.json`, `system-prompt.md`, `manifest.json` | role, instructions, inputs/outputs declarations, tool bindings, accepted edges |
| **Replayable** | Project file + spec/evals | `evals/golden-tasks.json`, `evals/transcripts/` | run history, transcripts, golden inputs+outputs |
| **Studio-only** | Project file, never spec | (excluded; stripped on export with a one-line note) | `runCache`, `mockOutput`, `fixture`, inferred-but-not-accepted ghost edges |

**Round-trip test** (added Pass 14, runs in CI from Pass 14 onward): export → wipe studio state → import → run against the same model → output matches the pre-export run. Any pass that breaks round-trip is not done.

---

## Pass 13 — Lasso + group drag

### Why now

User-paused at start of session. Quick win before the heavier DES work. Improves usability for graphs >10 nodes which DES will encourage (more nodes per project once people start composing chains).

### Design

- Drag on empty canvas with **Shift held** starts a rubber-band rectangle.
- On release, every node whose center falls inside the rectangle joins a `selectedIds: Set<string>` selection model.
- Drag any selected node moves all selected nodes together. Edges follow.
- Click empty space clears selection.
- Delete-key removes all selected nodes (with cascading edge cleanup) after a single confirm.

### Acceptance

1. Shift-drag draws a visible bounding rect; on release, nodes inside are highlighted.
2. Drag any selected node translates all selected by the same delta.
3. Existing single-node drag, click-to-expand, port-drag-to-connect still work unchanged.
4. Persistence: positions of all selected nodes save on group-drag-end.
5. Pass 1-12 regressions all pass.

### Build-loop passes: **1**.

---

## Pass 14 — Single-node solo run + portable spec contract

### Why now

Two foundations land together: **solo execution** (verify a single node in isolation) and **the export schema** (the contract every later pass must respect). Doing them together means we never invent node features that can't be expressed in the spec, and we never invent a spec that can't represent what's on the canvas.

### Design

**1. Per-node input fixture (portable).** Each node gets an optional `fixture: { inputs: any, source: "manual" | "upstream-cache" }`. Saved on the node, persisted with the project. Fixture *inputs* export to `evals/golden-tasks.json` because they describe expected I/O. The `source` field is studio-only.

**2. Solo run (UI only).** Right-click a node or use the "Run solo" button in the side panel. Opens a modal:
- Inputs pre-fill from upstream `runCache` when present (editable). No separate "pull" button — the common case shouldn't need a click.
- If the node declares `inputs[]`, render one field per input. Otherwise a single JSON textarea seeded from the last fixture or empty.
- "Run" executes only this node, streams the response, writes to `projects[i].canvas.runCache[nodeId] = { input, output, ts }`.

**3. Per-node run cache (studio-only).** localStorage with the project. Side-panel visible. "Clear cache" toolbar action. Never exported.

**4. Portable spec schema (the contract).** Frozen this pass — version `agent-spec/v1`. Defines:
- `agent.yaml` — name, description, runtime, framework, autonomy, declared inputs/outputs.
- `manifest.json` — tool registry, permissions, sandbox tier.
- `system-prompt.md` — composed from role templates + node instructions.
- `tools.json` — tool descriptions per node that uses them.
- `evals/golden-tasks.json` — fixture inputs + recorded outputs.
- Studio-only fields (`runCache`, `mockOutput`, ghost edges) excluded with a one-line stripped-on-export note in the schema.

**5. Round-trip harness.** New `npm run test:roundtrip` script: serialize a project to spec → wipe → re-import → re-run against the same model with `OLLAMA_SEED` fixed → diff outputs. Wired into `npm run test:self`. Every later pass extends this test.

### Acceptance

1. Right-click a node shows "Run solo". Side panel has a "Run solo" button.
2. Modal renders correct inputs based on declarations; upstream `runCache` pre-fills editable fields.
3. Solo run streams output via the same SSE pattern as full runs, but only for the chosen node.
4. Run cache persists across reload; "Clear cache" empties it.
5. Solo run does NOT mutate the project's canonical transcript; writes to `runCache` only.
6. **Portability:** The `agent-spec/v1` schema doc exists at `docs/SPEC.md` and lists every node-level field with its bucket (portable / replayable / studio-only).
7. **Portability:** `npm run test:roundtrip` exists, exports a sample project, re-imports, re-runs, and diff-passes for at least one fixture.
8. Pass 1-13 regressions all pass.

### Build-loop passes: **2**.

---

## Pass 14.5 — Save snapshots + completion flag + single-file markdown export

### Why now

Pass 14 froze the schema and proved exportability with the 10-file `spec/` directory. Pass 14.5 makes the editor genuinely useful for the work-in-progress lifecycle: you can save a finished design as a named snapshot, mark a project as completed (so you don't keep editing the canonical version), and ship a single `agent.md` you can paste into a chat, commit to a repo, or hand to another LLM to rebuild from scratch. Lands before Pass 15 because Pass 15's inspector reads from the same project shape — better to extend the shape once.

### Design

**1. Named snapshots (project-scoped, persistent).** Each project carries an optional `snapshots: [{id, name, createdAt, projectFrozen}]` array. `projectFrozen` is a deep clone of the project at snapshot time minus its own `snapshots` array (no recursion) and minus `runCache` (studio-only, per Pass 14 buckets).
- Toolbar action: **"Save snapshot"** prompts for a name, captures current state, prepends to `snapshots[]`.
- Side-panel section under the project: list of snapshots with name + relative time + `restore` / `delete`.
- `restore` overwrites the live canvas + project metadata with the snapshot's frozen state; the previous live state is auto-snapshotted as `Auto-saved before restore <ISO>` so restore is reversible.
- Snapshots are stored in localStorage with the project. Schema bump v5→v6 adds the field with `[]` default.

**2. Completion flag.** Each project gets `status: "draft" | "completed" = "draft"`.
- Toolbar action: **"Mark completed"** flips the flag and locks the canvas (read-only — no node drags, no instruction edits, no port connections, no Run/Run-solo). A muted banner across the top reads *"This project is marked completed. Click 'Reopen' to edit."*
- **"Reopen"** flips status back to `"draft"`. Auto-snapshots the completed state first as `Completed <ISO>` so the completed version is recoverable.
- Project switcher renders completed projects in a separate section, dimmed.
- Schema bump v5→v6 adds `status: "draft"` default.

**3. Single-file markdown export (`agent.md`).** Toolbar action: **"Export markdown"** writes `<workingFolder>/agent.md` with this structure:

```markdown
---
agent_spec: agent-md/v1
name: <project name>
created_at: <ISO>
exported_at: <ISO>
status: draft|completed
runtime: local-nextjs
framework: custom-loop
model_provider: ollama
sandbox: workspace-write
autonomy: human-in-loop
---

# <project name>

## Goal
<goal>

## Context
<context>

## Outcome
<outcome>

## Role prompt overrides
```yaml
<rolePromptOverrides as YAML, or empty object>
```

## Graph

### Nodes
```yaml
<canvas.nodes serialized as YAML — every portable + replayable field>
```

### Edges
```yaml
<canvas.edges as YAML>
```

## Per-node instructions
### <node title> (`<node id>`)
<instructions block, or "_none_" placeholder>

## Fixtures (replayable)
### <node id>
```json
<fixture.inputs>
```
```

**4. Single-file markdown import.** Companion toolbar action: **"Import markdown"** parses `agent.md` back into a project. Uses YAML frontmatter for top-level fields, fenced code blocks for graph data, header-anchored sections for prose. New project is created (does not overwrite an existing one) and routed into.

**5. Round-trip harness extension.** `npm run test:roundtrip` grows a second case: export project → write `agent.md` → re-parse → diff portable + replayable fields. Studio-only fields (`runCache`, snapshots, status) excluded by spec — round-trip asserts they are NOT present in the markdown.

### Acceptance

1. Toolbar **"Save snapshot"** prompts for a name and writes a snapshot under the active project. Side-panel lists snapshots with name + relative time.
2. **"Restore snapshot"** overwrites the live canvas with the snapshot's content. The previous live state is auto-snapshotted first.
3. **"Delete snapshot"** removes a single snapshot (with one confirm).
4. **"Mark completed"** locks the canvas: nodes can't be dragged or edited; ports can't be dragged; Run / Run-solo are disabled. Banner shows.
5. **"Reopen"** unlocks the canvas and auto-snapshots the completed state first.
6. Project switcher groups draft vs completed projects.
7. **Export markdown** writes `<workingFolder>/agent.md` matching the `agent-md/v1` schema. File parses as valid markdown + YAML frontmatter.
8. **Import markdown** reads an `agent.md` and creates a new project that loads onto the canvas.
9. **Portability:** Round-trip — export `agent.md`, re-import, diff portable + replayable fields → byte-equal (after stable key ordering). Studio-only fields (`runCache`, `snapshots`, `status`) MUST NOT appear in the markdown.
10. **Portability:** Existing `spec/` round-trip from Pass 14 still passes. The new `agent.md` round-trip is additive.
11. Schema bump v5 → v6 with chained migration; v5 stores upgrade additively (snapshots: [], status: "draft").
12. Pass 1-14 regressions all pass — `npm run test:self` chains both round-trips.

### Build-loop passes: **1-2**.

---

## Pass 14.6 — Storage-aware saving

### Why now

Pass 14.5 unlocked snapshots and run-cache, both of which write to the browser's localStorage. localStorage is per-origin and has a hard cap (typically a few MB; varies by browser). A user who saves 30 snapshots of a 20-node project, or runs solo a few hundred times, can silently fill the quota and then experience a confusing save failure with no recovery affordance. Pass 14.6 makes the limits visible, the warnings intuitive, and the controls user-tunable. **No hardcoded thresholds anywhere.**

### Design principle

The user shouldn't see percentages or byte counts. They should see plain-language status (*"plenty of room"*, *"getting full"*, *"almost out"*) and a single settings page where they can adjust what those phrases mean if they want to. Every numeric limit lives in a single config object, persisted with the user's profile in localStorage. Code reads from that config — never from inline literals.

### Design

**1. Storage settings live in one place.**
New per-user (not per-project) localStorage entry: `agent-studio:storage-config:v1`. Shape:

```ts
{
  warnLevel: number,        // % full at which the status pill turns amber. Default 70.
  blockLevel: number,       // % full at which saves require explicit override. Default 90.
  runCacheBytesPerEntry: number,    // hard cap per cached node output. Default 100_000 (100 KB).
  runCacheEntriesPerNode: number,   // count cap. Default 1.
  snapshotsPerProject: number,      // count cap. Default 50.
  autoSnapshotWhenLow: boolean,     // skip auto-snapshot before restore/reopen if at blockLevel. Default true.
}
```

The defaults sit in a single exported `DEFAULT_STORAGE_CONFIG` constant in `app/lib/storage-config.mjs`. Every consumer (snapshot writer, runCache writer, status pill) imports from this module. **Code never references magic numbers.**

**2. Toolbar storage pill (always visible).**
Shows one of three plain-language states based on `usage / quota` vs `warnLevel` / `blockLevel`:
- **Plenty of room** — green dot, no number.
- **Getting full** — amber dot, *"~3 saves left"* (estimated by snapshot bytes / available bytes).
- **Almost out** — red dot, *"out of space — manage storage"*.

Click opens a slide-over panel.

**3. Storage panel (slide-over, not modal).**
Three sections:

- **Status** — *"You've used 4.1 MB of about 5 MB. About 12 saves of recent size still fit."* Plain language, no percent symbols by default. Tiny "show numbers" toggle reveals % + raw bytes for power users.
- **What's using space** — table of projects with name + bytes + snapshot count + cache count. Each row has a *"trim run cache"* and *"delete oldest snapshots"* action with a count picker. No bulk-delete-all (too dangerous).
- **Settings** — five labeled fields with helper text explaining what each does in one sentence. Fields show *current value* (e.g. "70" for warnLevel) plus a "reset to default" link per field. Constants come from `DEFAULT_STORAGE_CONFIG`, never inline.

**4. Save preflight.**
Before any snapshot write, compute projected post-save usage. If projected usage crosses `blockLevel`, intercept the save action with a small confirm:

> *"This save would leave you almost out of space. You can save anyway, or trim older snapshots first."*
> [Trim & save] [Save anyway] [Cancel]

If `autoSnapshotWhenLow` is false and the source action was an auto-snapshot (before restore / before reopen), skip silently with a one-time toast: *"Auto-snapshot skipped — storage is low. Save manually first if you want a recovery point."*

**5. RunCache byte cap.**
The runCache writer reads `runCacheBytesPerEntry` from config. If a node's output exceeds the cap, truncate the output string with a marker:

```
... [truncated — full transcript at <workingFolder>/runs/<ts>/transcript.json]
```

The full transcript is already written to disk by `runProject` for full-graph runs. For solo runs this pass extends `/api/agent/run-node` to also write a transcript when truncation occurs (only then — keeps the disk side cheap).

**6. Quota detection.**
On app load and on every save attempt, call `navigator.storage.estimate()`. Cache result for 30s to avoid hammering the API. Fall back gracefully if the API isn't available (older browsers): pill shows *"unknown"* and skips the preflight gate.

**7. Documentation.**
`docs/SPEC.md` adds a Storage section: documents the config shape, the defaults, the consumer modules. Reinforces the "no magic numbers" rule.

### Acceptance

1. `app/lib/storage-config.mjs` exists with `DEFAULT_STORAGE_CONFIG` exported. **Every** numeric limit in the codebase that affects storage (snapshots, runCache bytes, runCache count, warn/block thresholds) reads from this module. Grep proves no inline literals remain in `projects.js`, `markdown-export.mjs`, `spec-export.mjs`, `SoloRunModal.js`, or `canvas/page.js`.
2. Toolbar pill renders one of three plain-language states; click opens the storage panel.
3. Storage panel shows usage in plain language; "show numbers" toggle reveals percentages and raw bytes.
4. "What's using space" lists every project with bytes / snapshots / cache; trim and delete-oldest actions work and update the panel without reload.
5. Settings section lets the user change every field in `DEFAULT_STORAGE_CONFIG`; "reset to default" restores per-field; values persist to `agent-studio:storage-config:v1`.
6. Save preflight intercepts saves at `blockLevel`; user choices (trim & save / save anyway / cancel) all work.
7. RunCache truncation kicks in at `runCacheBytesPerEntry`; truncated entries carry the marker; solo-run transcript is written to disk only on truncation.
8. `navigator.storage.estimate()` failure falls back gracefully — pill shows "unknown", preflight skipped, no crashes.
9. **No hardcoded data:** automated grep test in `scripts/test-no-hardcoded-storage.mjs` fails the build if any of `projects.js`, `markdown-export.mjs`, `spec-export.mjs`, `SoloRunModal.js`, `canvas/page.js`, `agent-runtime.mjs` contain numeric literals matching common storage limits (50, 100, 70, 90, 100_000) outside of `DEFAULT_STORAGE_CONFIG` itself.
10. Pass 1-14.5 regressions all pass — `npm run test:self` includes the no-hardcoded-storage check.

### Build-loop passes: **1-2**.

---

## Pass 15 — Run inspector + step-through + per-node mocks

### Why now

Once solo execution exists, the user needs to see what happened during a chain run, and to advance level-by-level when debugging. This is the inspector + debugger.

### Design

**Run trace inspector.** Today the runtime writes `transcript.json` to disk. Add a UI:
- After a run completes, the canvas shows a small "Inspect last run" badge in the toolbar.
- Clicking any node on the canvas opens a panel showing that node's record from the most recent transcript:
  - System prompt sent
  - User message sent
  - Raw text response
  - Parsed JSON output
  - Duration
  - Bytes
  - Error if any
- The panel has a "Replay this node" button that re-runs only that node with the same inputs. Useful for verifying a prompt edit without re-running the chain.

**Step-through mode.** New "Step run" button next to the existing "Run" button.
- On click, the runtime starts but pauses after each DAG level emits its `level-end` event.
- A "Next level" button advances to the next batch.
- "Skip to end" runs the rest non-stop.
- "Cancel" aborts.
- Level-by-level advancement is the discrete-event step. Inside a level, nodes still parallelize (cap 4).

**Per-node mock output.** Right-click a node → "Set mock". Opens a JSON textarea. Saved on the node as `mockOutput: any`. When set, the runtime emits the mock instead of calling Ollama for that node, marks the event as `mocked: true`. Useful for testing downstream without burning tokens.

### Acceptance

1. After a chain run, clicking a node opens an inspector panel with the system+user prompts, raw response, parsed output, duration.
2. "Replay this node" re-runs just that node and updates the panel.
3. "Step run" pauses after each level; "Next level" advances; "Skip to end" runs without pausing further; "Cancel" aborts mid-step.
4. Setting a mock output on a node bypasses Ollama for that node and the event is tagged `mocked: true` in the transcript.
5. Mocked nodes still appear in the inspector with their mock as the parsed output.
6. **Portability:** `mockOutput` is tagged studio-only in the spec schema and stripped on export. Inspector transcripts export to `evals/transcripts/` as replayable.
7. `npm run test:roundtrip` still passes after this pass.
8. Pass 1-14 regressions all pass.

### Build-loop passes: **2**.

---

## Pass 16 — Inferred edge ordering for sparse graphs

### Why now

Today the runtime topologically sorts on explicit edges + declared `inputs`/`outputs`. When neither is present, it warns and runs everything in parallel. With the DES workbench in place, users will increasingly draw graphs with implicit data flow that the model can infer.

### Design

When the graph has nodes with no edges and no `inputs`/`outputs` declarations, before execution:
- Make one extra LLM call passing every node's `{ id, role, title, description, instructions }`.
- Prompt the model to return a JSON array of edges it would draw based on data flow inferred from descriptions: `[{ from, to, reason }]`.
- Show the inferred edges as **dashed ghost edges** on the canvas with a banner: "Inferred order. Click to accept or edit."
- "Accept" promotes them to real edges. "Decline" runs in parallel as today.
- Inferred edges are saved per-run; they don't auto-write to the project unless the user accepts.

### Acceptance

1. Graph with explicit edges runs as today, no inference call.
2. Graph with no edges and `inputs`/`outputs` declared uses declarations, no inference call.
3. Graph with no edges and no declarations triggers the inference call. Banner appears.
4. "Accept" persists edges to the project **and to the exported spec** (accepted edges are portable).
5. "Decline" runs in parallel, original behavior. Declined / un-accepted ghost edges are studio-only and never exported.
6. Inference call uses Ollama with `format:json`. Falls back to parallel mode on failure.
7. **Portability:** `npm run test:roundtrip` covers a graph that had inferred-then-accepted edges; round-trip preserves them.
8. Pass 1-15 regressions all pass.

### Build-loop passes: **1**.

---

## Pass 17 — Spec export UI

### Why now

The schema and round-trip harness already exist (Pass 14). This pass adds the user-facing **Export** / **Import** actions, the human-readable `README.md` summary, and the agent-builder-compatibility validation. By landing UI last we know the schema has survived three passes of evolution (14, 15, 16) before being exposed.

### Design

New toolbar actions:

**Export agent spec.** Writes atomically to `<workingFolder>/spec/`:

```
<workingFolder>/spec/
  agent.yaml         # frozen schema from Pass 14
  manifest.json
  system-prompt.md
  tools.json
  evals/golden-tasks.json
  evals/transcripts/  # replayable transcripts
  README.md           # summary + how to consume + which fields were stripped
```

Format mirrors `agent-builder/lib/build-files.js` so the spec is picked up by agent-builder without changes. README lists every studio-only field that was excluded so the consumer knows what's not portable.

**Import agent spec.** User picks a spec directory; canvas reconstructs nodes/edges. Studio-only fields default to empty.

### Acceptance

1. "Export agent spec" writes the files atomically to `<workingFolder>/spec/`.
2. The exported `agent.yaml` validates against the agent-builder schema.
3. README lists stripped studio-only fields by name.
4. "Import agent spec" loads a spec directory onto the canvas.
5. **Portability:** UI-driven export → UI-driven import produces a graph that passes `npm run test:roundtrip`.
6. **Portability:** A spec exported from the studio runs unmodified through `agent-builder/lib/build-files.js` and produces matching output for at least one fixture.
7. Pass 1-16 regressions all pass.

### Build-loop passes: **1**.

---

## Pass 18 — Multi-agent compose

### Why now

Last item in the roadmap. Once specs are portable and DES can run pieces in isolation, the natural next step is letting one project invoke another as a sub-agent. This unlocks compositions like "research agent → writing agent → eval agent" where each sub-agent is its own project with its own canvas, working folder, role overrides.

### Design

New node type: **`subagent`**. A node whose `role: "subagent"` carries `subagentProjectId: string`. When the runtime hits a subagent node:
- Resolves the project by id (must be in the same studio store).
- Recursively runs that project against Ollama with the parent node's inputs as the sub-project's inputs.
- The subagent's full transcript becomes the subagent node's output.
- DES inspection drills into the subagent's transcript (clickable).

Visual: subagent nodes render with a distinct double border and a "↳ <project name>" label.

Cycle prevention: a project cannot directly or indirectly call itself. Detected and rejected at run time.

### Acceptance

1. New role `subagent` available in the side-panel role dropdown.
2. When `subagent` is selected, a project picker appears, choosing from the studio's projects.
3. Running a graph with a subagent node runs the inner project and inlines its output.
4. The inspector panel for a subagent node opens a nested view of the inner project's transcript.
5. Self-referential cycles are detected with a clear error message before any LLM call.
6. **Portability:** Subagent reference exports as `subagent: { ref: <projectId>, inlineSpec: <path> }` in `agent.yaml`. Decision: same-store ref by default; if the referenced project also has a spec on disk, include the relative path so external runtimes can resolve it. Round-trip test covers a parent + subagent pair.
7. Pass 1-17 regressions all pass.

### Build-loop passes: **2**.

---

## Sequencing rationale

| Pass | Why it goes here |
|---|---|
| 13 — Lasso | Quick win, blocks nothing. UI polish lifts the rest. |
| 14 — Solo run + spec contract | Foundation for verification AND portability. Schema lands here so every later pass extends a known contract instead of inventing one at the end. |
| 15 — Inspect + step + mocks | Verification surface. Inspection makes solo + chain runs trustworthy. Mocks let users test downstream cheaply. All three share the inspector panel. |
| 16 — Inferred order | Once inspection exists, the user can verify inferred edges visually before accepting them. Accepted edges write back to the portable spec. |
| 17 — Spec export UI | Schema already exists (Pass 14). UI is built last so the schema has survived three passes of evolution. Round-trip is enforced from Pass 14 onward. |
| 18 — Multi-agent | Last because subagent references need spec round-trip + inspector drill-down to work. |

---

## Resolved decisions (2026-04-28)

| # | Question | Decision |
|---|---|---|
| Q1 | Solo-run inputs auto-pull vs manual? | **Auto-pull from upstream `runCache`, fields editable.** No separate "pull" button. |
| Q2 | Mocks per-node or per-project? | **Per-node** for v1. Per-project fixtures only if users ask. |
| Q3 | Step granularity per level or per node? | **Per DAG level.** Preserves parallel-siblings semantics. |
| Q4 | Spec format — agent-builder only, or also OpenAgents? | **Agent-builder only** for v1. OpenAgents too unsettled. |
| Q5 | Subagent recursion — same store only or remote URL? | **Same store** for v1. Spec ref includes optional relative path so external runtimes can resolve. |

---

## Risks

- **Inference-call cost.** Pass 16 adds an extra LLM round-trip whenever a graph is sparse. Cap at one inference per run; cache by graph hash so identical graphs don't re-infer.
- **Solo-run UX with undeclared inputs.** When `inputs[]` isn't declared, the JSON textarea is unfriendly. Mitigation: auto-suggest a JSON shape from the node's role template.
- **Inspector scrolling.** A 20-node graph produces 20 inspector entries. Mitigation: virtualize the per-node panel list, or lazy-render only on click.
- **Multi-agent compose context size.** A subagent's full transcript inlined into the parent prompt can blow context. Mitigation: pass only the parsed output, not raw text. Surface a "show full transcript" link in the inspector.
- **Backward compatibility.** Each pass extends the project model. Storage version bumps from `agent-studio:v4` upward. Migration paths must chain (v4 → v5 → v6 ...) so legacy users keep their data.
- **Schema lock-in.** Pass 14 freezes `agent-spec/v1`. Later passes can extend additively but not break the contract. If a pass needs a breaking change, bump to `agent-spec/v2` with a migration path and round-trip coverage for both versions.
- **External runtime drift.** "Portable" means portable to today's `agent-builder/lib/build-files.js`, today's Ollama API, today's OpenAI / Anthropic APIs. If those drift, the round-trip test fails fast — fix the export, don't paper over it.

---

## Out of scope for this roadmap

These came up in earlier conversation but are not in this five-pass plan. Tracked here so they don't get lost.

- **NavGator detection of Ollama via raw fetch.** Tooling gap; report it to NavGator, not a code fix in this repo.
- **`gpt-oss:20b` self-consistency check** vs the `llama3.2:3b` test used in Pass 6. Run `OLLAMA_MODEL=gpt-oss:20b npm run test:self` ad-hoc.
- **iOS / mobile companion app.** Web-first for now.
- **Cloud-backed multi-user mode.** Local-first by design; multi-user is a different product.

---

## How to launch a pass

In a fresh Claude Code session at `~/dev/git-folder/agent-studio/`:

```
/build-loop:build-loop run pass <N> from docs/ROADMAP.md
```

The orchestrator reads this doc, picks the section for that pass, and follows its acceptance criteria. Each pass commits and reports back. Push manually after each pass or every few passes. Use `npm run test:self` to confirm runtime regression after any runtime-touching pass (14, 15, 16, 18).

---

_Last updated 2026-04-28 (reframed: portable editor + verification lens). After Pass 12, before Pass 13. Repo: https://github.com/tyroneross/agent-studio._
