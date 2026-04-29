// POST /api/agent/run-node
// Body: { project, nodeId, inputs?, model? }
//   - project: full project object from localStorage.
//   - nodeId:  id of the single node to execute.
//   - inputs:  optional plain-object map / JSON value the user supplied
//              from the solo-run modal. Becomes the node's "user query"
//              when present; falls back to the node's saved fixture.inputs.
//   - model:   optional Ollama model override.
//
// Streams Server-Sent Events with the same frame shape as /api/agent/run:
//   warmup, warmup-ok, warmup-fail, level-start, node-start, node-chunk,
//   node-end, node-error, warning, complete.
//
// Pass 14 — solo run constructs a one-node sub-project from `project` so the
// existing runtime, prompt composition, and SSE pipeline are reused without
// duplication. The sub-project drops every other node and edge, preserving
// the original project's goal/context/outcome/uploads/rolePromptOverrides so
// the prompt the user sees matches what the full graph would have sent.
//
// Defense-in-depth (path allowlist, upload byte budget, AbortController, SSE
// frame shape) mirrors /api/agent/run exactly. The cache write — always to
// runCache only, never to disk transcripts — is the only behavior unique to
// this route. The solo run does NOT mutate the project's canonical
// transcript on the client; the client folds the cache entry into its own
// state via the `node-end` event.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runProject, planExecution } from "../../../lib/agent-runtime.mjs";
import {
  DEFAULT_STORAGE_CONFIG,
  truncateOutputForCache,
} from "../../../lib/storage-config.mjs";

export const runtime = "nodejs";

const PERMITTED_PREFIXES = ["/Users/", "/tmp/", "/var/folders/"];

// Mirror /api/agent/run: same upload extension allowlist + byte budget so
// solo-run prompts get the same context the full run would.
const PERMITTED_UPLOAD_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
]);
const UPLOAD_BYTE_BUDGET = 64 * 1024;

function isPermittedFolder(absolute) {
  return PERMITTED_PREFIXES.some(
    (prefix) => absolute.startsWith(prefix) || absolute + "/" === prefix,
  );
}

// Same loader as /api/agent/run — kept inline rather than refactored to a
// shared module because Pass 14 is additive and we don't want to risk any
// behavior change on the full-graph path.
async function loadUploadContents(project, emit) {
  const list = Array.isArray(project?.uploads) ? project.uploads : [];
  if (list.length === 0) return { loaded: [], totalBytes: 0, truncated: false };

  const wfRaw = project?.workingFolder;
  const wfAbs =
    typeof wfRaw === "string" && wfRaw.startsWith("/") && isPermittedFolder(path.resolve(wfRaw))
      ? path.resolve(wfRaw)
      : null;
  if (!wfAbs) {
    if (list.length > 0) {
      emit({
        type: "warning",
        text: `project working folder is not under permitted root; ${list.length} upload(s) skipped`,
      });
    }
    return { loaded: [], totalBytes: 0, truncated: false };
  }
  const uploadsRoot = path.resolve(path.join(wfAbs, "uploads"));
  const uploadsRootPrefix = uploadsRoot + path.sep;

  const loaded = [];
  let totalBytes = 0;
  let truncated = false;

  for (const u of list) {
    const name = typeof u?.name === "string" ? u.name : null;
    const savedPathRaw = typeof u?.savedPath === "string" ? u.savedPath : null;
    if (!name || !savedPathRaw) continue;

    const abs = path.resolve(savedPathRaw);
    if (abs !== uploadsRoot && !abs.startsWith(uploadsRootPrefix)) {
      emit({ type: "warning", text: `upload "${name}" outside project uploads dir; skipped` });
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (!PERMITTED_UPLOAD_EXTENSIONS.has(ext)) {
      emit({ type: "warning", text: `upload "${name}" has non-permitted extension "${ext}"; skipped` });
      continue;
    }
    if (totalBytes >= UPLOAD_BYTE_BUDGET) {
      loaded.push({ name, contents: "", skipped: true });
      truncated = true;
      continue;
    }
    let contents;
    try {
      contents = await fs.readFile(abs, "utf8");
    } catch (err) {
      emit({ type: "warning", text: `upload "${name}" could not be read: ${err?.message || "read failed"}` });
      continue;
    }
    const size = Buffer.byteLength(contents, "utf8");
    const remaining = UPLOAD_BYTE_BUDGET - totalBytes;
    if (size <= remaining) {
      loaded.push({ name, contents });
      totalBytes += size;
    } else {
      let trimmed = contents;
      while (Buffer.byteLength(trimmed, "utf8") > remaining && trimmed.length > 0) {
        trimmed = trimmed.slice(0, Math.max(0, Math.floor(trimmed.length * 0.99) - 1));
      }
      loaded.push({ name, contents: trimmed, truncated: true });
      totalBytes += Buffer.byteLength(trimmed, "utf8");
      truncated = true;
    }
  }

  return { loaded, totalBytes, truncated };
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

// Build a one-node sub-project from the full project. Drops every other
// node and edge so planExecution lays out a single level with one node.
// We strip the target node's `inputs[]` declarations because the solo run's
// inputs come from the user, not from upstream producers — keeping `inputs`
// present would make the runtime expect a producer node that no longer
// exists, with no functional effect (no upstream results to inject), but
// would surface a confusing "no order detected" warning.
function buildSoloSubProject(project, nodeId, soloInputs) {
  const node = project.canvas.nodes.find((n) => n.id === nodeId);
  if (!node) return null;

  // Carry the user-supplied inputs into the node's `instructions` so the
  // existing prompt composer surfaces them in the user message. We do NOT
  // overwrite `instructions`; we append a `Solo-run inputs:` block. This
  // keeps the prompt human-readable in the transcript and reuses the same
  // composer used by the full-graph run.
  const inputsBlock =
    soloInputs == null
      ? ""
      : `\n\n### Solo-run inputs\n${typeof soloInputs === "string" ? soloInputs : JSON.stringify(soloInputs, null, 2)}`;

  const soloNode = {
    ...node,
    inputs: [],
    outputs: [],
    instructions: (node.instructions ?? "") + inputsBlock,
  };

  return {
    ...project,
    canvas: {
      ...project.canvas,
      nodes: [soloNode],
      edges: [],
    },
  };
}

// Pass 14.6 — write a transcript file when a solo run's output exceeds
// `runCacheBytesPerEntry`. Mirrors /api/agent/run's <workingFolder>/runs/<ts>
// layout so the on-disk shape is consistent between full-graph and solo
// runs. Returns the absolute path on success, "" on failure (caller surfaces
// a warning event but doesn't fail the run).
async function writeTruncationTranscript({ project, nodeId, fullPayload, transcript, storageConfig: _cfg }) {
  void _cfg; // reserved for future per-write byte-cap policies
  const wfRaw = project?.workingFolder;
  if (!wfRaw || typeof wfRaw !== "string" || !wfRaw.startsWith("/")) {
    return "";
  }
  const wfAbs = path.resolve(wfRaw);
  if (!isPermittedFolder(wfAbs)) return "";
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(wfAbs, "runs", `${ts}-solo-${nodeId}`);
  await fs.mkdir(dir, { recursive: true });
  const transcriptPath = path.join(dir, "transcript.json");
  const fullPayloadPath = path.join(dir, "output.json");
  const minimalTranscript = transcript ?? {
    project: project.id,
    projectName: project.name,
    nodes: [
      {
        id: nodeId,
        title: project.canvas.nodes[0]?.title ?? nodeId,
        role: project.canvas.nodes[0]?.role ?? "agent",
        output: typeof fullPayload === "string" ? fullPayload : JSON.stringify(fullPayload),
      },
    ],
    truncated: true,
  };
  await fs.writeFile(transcriptPath, JSON.stringify(minimalTranscript, null, 2), "utf8");
  await fs.writeFile(
    fullPayloadPath,
    typeof fullPayload === "string" ? fullPayload : JSON.stringify(fullPayload, null, 2),
    "utf8",
  );
  return transcriptPath;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const project = body?.project;
  const nodeId = typeof body?.nodeId === "string" ? body.nodeId : "";
  const soloInputs = "inputs" in (body ?? {}) ? body.inputs : undefined;
  const model = typeof body?.model === "string" && body.model ? body.model : undefined;
  // Pass 14.6 — the client passes its loaded storage-config so the server
  // applies the same byte cap when truncating cached outputs. Falls back to
  // DEFAULT_STORAGE_CONFIG when the client doesn't supply one (older
  // callers, server-side tests). Only `runCacheBytesPerEntry` matters here.
  const storageConfig =
    body?.storageConfig && typeof body.storageConfig === "object"
      ? body.storageConfig
      : DEFAULT_STORAGE_CONFIG;

  if (!project || !project.canvas || !Array.isArray(project.canvas.nodes)) {
    return Response.json(
      { ok: false, error: "project with canvas.nodes required" },
      { status: 400 },
    );
  }
  if (!nodeId) {
    return Response.json({ ok: false, error: "nodeId required" }, { status: 400 });
  }
  const targetExists = project.canvas.nodes.some((n) => n.id === nodeId);
  if (!targetExists) {
    return Response.json(
      { ok: false, error: `node ${nodeId} not found in project` },
      { status: 404 },
    );
  }

  const soloProject = buildSoloSubProject(project, nodeId, soloInputs);

  // Plan upfront so any failure surfaces as a clean SSE event before
  // streaming starts. A single-node graph with no edges is always plannable
  // (one level, one node) so this is cheap insurance.
  let planError = null;
  try {
    planExecution(soloProject);
  } catch (err) {
    planError = err.message || String(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (evt) => {
        try {
          controller.enqueue(encoder.encode(sseFrame(evt)));
        } catch {
          /* client disconnected */
        }
      };

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      request.signal.addEventListener("abort", onAbort);

      try {
        if (planError) {
          send({ type: "node-error", id: nodeId, error: planError });
          send({
            type: "complete",
            transcript: { error: planError },
            brief: `# Error\n\n${planError}\n`,
            soloNodeId: nodeId,
          });
          controller.close();
          return;
        }

        const uploads = await loadUploadContents(soloProject, send);
        send({
          type: "uploads-loaded",
          count: uploads.loaded.length,
          totalBytes: uploads.totalBytes,
          truncated: uploads.truncated,
        });

        let cacheEntry = null;
        // Pass 14.6 — when truncation kicks in we write a transcript to disk
        // so the user has the full payload, then point the cache marker at
        // it. We defer the write until we know there's something to truncate
        // (keeps the disk side cheap for the typical small-output case).
        let pendingFullPayload = null;
        let pendingFullTranscript = null;
        let truncationOccurred = false;
        let transcriptDiskPath = "";

        const { transcript } = await runProject({
          project: soloProject,
          query: "",
          model,
          loadedUploads: uploads.loaded,
          baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
          signal: ac.signal,
          onEvent: (evt) => {
            // Capture the single node's output so we can echo it back as a
            // structured runCache entry on `complete`. The client uses this
            // to update localStorage without re-deriving from the transcript.
            if (evt.type === "node-end") {
              const payload = evt.parsed != null ? evt.parsed : evt.output;
              // Pre-truncation byte check. We don't yet know the on-disk
              // path; pass an empty string and patch the marker after we
              // write the transcript.
              const probe = truncateOutputForCache(payload, storageConfig, "");
              if (probe.truncated) {
                truncationOccurred = true;
                pendingFullPayload = payload;
              }
              cacheEntry = {
                input: soloInputs ?? null,
                output: probe.output,
                ts: new Date().toISOString(),
                ...(probe.truncated ? { truncated: true } : {}),
              };
            }
            if (evt.type === "complete") {
              // Pass 14.6 — only write a transcript on truncation; otherwise
              // keep the disk side untouched (Pass 14 contract).
              const finishComplete = (entry) => {
                send({
                  type: "complete",
                  soloNodeId: nodeId,
                  runCacheEntry: entry,
                });
              };
              if (truncationOccurred) {
                pendingFullTranscript = evt.transcript ?? transcript ?? null;
                writeTruncationTranscript({
                  project: soloProject,
                  nodeId,
                  fullPayload: pendingFullPayload,
                  transcript: pendingFullTranscript,
                  storageConfig,
                })
                  .then((diskPath) => {
                    transcriptDiskPath = diskPath || "";
                    if (cacheEntry) {
                      // Re-truncate with the now-known path so the marker
                      // points to the saved transcript.
                      const final = truncateOutputForCache(
                        pendingFullPayload,
                        storageConfig,
                        transcriptDiskPath,
                      );
                      cacheEntry = {
                        ...cacheEntry,
                        output: final.output,
                        truncated: true,
                        transcriptPath: transcriptDiskPath,
                      };
                    }
                    finishComplete(cacheEntry);
                  })
                  .catch((err) => {
                    send({
                      type: "warning",
                      text: `transcript write failed: ${err?.message || "io"}`,
                    });
                    finishComplete(cacheEntry);
                  });
                return;
              }
              finishComplete(cacheEntry);
            } else {
              send(evt);
            }
          },
        });

        // We rely on the onEvent passthrough above to send `complete`; if
        // somehow we got here without one, defensively close the SSE.
        if (!transcript) {
          send({
            type: "complete",
            soloNodeId: nodeId,
            runCacheEntry: cacheEntry,
          });
        }
      } catch (err) {
        const msg = err?.message || "run failed";
        send({ type: "node-error", id: nodeId, error: msg });
        send({
          type: "complete",
          soloNodeId: nodeId,
          runCacheEntry: null,
          error: msg,
        });
      } finally {
        request.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    },
  });
}
