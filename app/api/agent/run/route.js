// POST /api/agent/run
// Body: { project, query, model? }
//   - project: full project object from localStorage (the client owns
//     persistence; the server just runs the graph).
//   - query:   user test query string.
//   - model:   optional Ollama model name override.
//
// Streams Server-Sent Events (`text/event-stream`). Each event line is
// `data: <json>\n\n` matching the runtime's onEvent shape:
//   warmup, warmup-ok, warmup-fail, level-start, node-start, node-chunk,
//   node-end, node-error, warning, complete.
//
// On the `complete` event we attach `runDir` if a working folder was
// configured and writable: artifacts (transcript.json + brief.md) are written
// to <workingFolder>/runs/<isoTimestamp>/.
//
// The same path allowlist as /api/fs/validate + /api/uploads is applied to the
// project's workingFolder before any disk write — defense in depth for a
// single-user local dev tool.

import { promises as fs } from "node:fs";
import path from "node:path";
import { runProject, planExecution } from "../../../lib/agent-runtime.mjs";

export const runtime = "nodejs";

const PERMITTED_PREFIXES = ["/Users/", "/tmp/", "/var/folders/"];

// Pass 11: must mirror /api/uploads exactly so uploads accepted there can be
// loaded back here without surprise. Anything outside this set is silently
// skipped with a warning event (we don't fail the run on a stray .pdf).
const PERMITTED_UPLOAD_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
]);

// Pass 11: total byte cap across ALL inlined upload contents combined. Sized
// to leave plenty of headroom under Ollama's default num_ctx (8192 tokens ≈
// 32 KB) for the role template, project goal/context/outcome, node prompts,
// upstream outputs, and the user query. 64 KB is the budget for uploads only.
const UPLOAD_BYTE_BUDGET = 64 * 1024;

function isPermittedFolder(absolute) {
  return PERMITTED_PREFIXES.some(
    (prefix) => absolute.startsWith(prefix) || absolute + "/" === prefix,
  );
}

// Same allowlist + absolute-path enforcement as /api/uploads.
function resolveWritableRunDir(workingFolder) {
  if (typeof workingFolder !== "string" || workingFolder.length === 0) return null;
  if (!workingFolder.startsWith("/")) return null;
  const abs = path.resolve(workingFolder);
  if (!isPermittedFolder(abs)) return null;
  return abs;
}

// Pass 11: load each upload's contents from disk under a strict allowlist.
//
// Path-traversal protection: every savedPath must resolve under
// `<workingFolder>/uploads/`. We compare normalized absolute paths; a pasted
// `/etc/passwd` or `..`-laden savedPath is rejected before any read.
//
// Extension allowlist: same set as /api/uploads accepts on write.
//
// Byte budget: 64 KB total across all loaded files. The first N files that
// fit are inlined fully; the file that crosses the boundary is truncated to
// the remaining budget and flagged `truncated: true`; subsequent files are
// flagged `skipped: true` (no contents). The runtime turns these flags into
// a concise note in the system prompt so the model knows context was clipped.
//
// Errors are non-fatal: anything that can't be read (missing, permission,
// non-string) emits a `warning` event via `emit` and is dropped from the
// loaded list. We never throw out of here.
async function loadUploadContents(project, emit) {
  const list = Array.isArray(project?.uploads) ? project.uploads : [];
  if (list.length === 0) return { loaded: [], totalBytes: 0, truncated: false };

  const wfRaw = project?.workingFolder;
  const wfAbs =
    typeof wfRaw === "string" && wfRaw.startsWith("/") && isPermittedFolder(path.resolve(wfRaw))
      ? path.resolve(wfRaw)
      : null;
  // No valid workingFolder → no uploads can possibly satisfy the allowlist.
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

    // Normalize and ensure containment under <wf>/uploads/. Also accept the
    // exact uploads root itself? No — files only.
    const abs = path.resolve(savedPathRaw);
    if (abs !== uploadsRoot && !abs.startsWith(uploadsRootPrefix)) {
      emit({
        type: "warning",
        text: `upload "${name}" outside project uploads dir; skipped`,
      });
      continue;
    }
    const ext = path.extname(abs).toLowerCase();
    if (!PERMITTED_UPLOAD_EXTENSIONS.has(ext)) {
      emit({
        type: "warning",
        text: `upload "${name}" has non-permitted extension "${ext}"; skipped`,
      });
      continue;
    }

    // If we've already hit the budget, mark this file skipped without reading.
    if (totalBytes >= UPLOAD_BYTE_BUDGET) {
      loaded.push({ name, contents: "", skipped: true });
      truncated = true;
      continue;
    }

    let contents;
    try {
      contents = await fs.readFile(abs, "utf8");
    } catch (err) {
      emit({
        type: "warning",
        text: `upload "${name}" could not be read: ${err?.message || "read failed"}`,
      });
      continue;
    }

    const size = Buffer.byteLength(contents, "utf8");
    const remaining = UPLOAD_BYTE_BUDGET - totalBytes;
    if (size <= remaining) {
      loaded.push({ name, contents });
      totalBytes += size;
    } else {
      // Partial inline — truncate to the remaining budget, on a UTF-8 boundary
      // (Buffer.from(contents).slice(0,remaining).toString("utf8") would do
      // for ASCII; for multi-byte we trim and let TextDecoder strip a partial
      // last codepoint). Conservative: slice the original string by chars
      // until its byte length fits. Cheaper to slice from the end of a
      // tight-loop buffer here since contents is bounded by /api/uploads to
      // 10 MB.
      let trimmed = contents;
      while (Buffer.byteLength(trimmed, "utf8") > remaining && trimmed.length > 0) {
        // Drop ~1% per iteration; converges fast for ASCII and OK for mixed.
        trimmed = trimmed.slice(0, Math.max(0, Math.floor(trimmed.length * 0.99) - 1));
      }
      loaded.push({ name, contents: trimmed, truncated: true });
      totalBytes += Buffer.byteLength(trimmed, "utf8");
      truncated = true;
    }
  }

  return { loaded, totalBytes, truncated };
}

function isoStamp() {
  // 2026-04-27T15-32-04-512Z — colons replaced with dashes so this is a safe
  // directory name on every filesystem.
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sseFrame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const project = body?.project;
  const query = typeof body?.query === "string" ? body.query : "";
  const model = typeof body?.model === "string" && body.model ? body.model : undefined;

  if (!project || !project.canvas || !Array.isArray(project.canvas.nodes)) {
    return Response.json(
      { ok: false, error: "project with canvas.nodes required" },
      { status: 400 },
    );
  }

  // Plan upfront so cycle errors come back as a clean SSE event before any
  // streaming starts, instead of as a torn 200/500.
  let planError = null;
  try {
    planExecution(project);
  } catch (err) {
    planError = err.message || String(err);
  }

  // Pre-compute target run dir if we'll be able to write artifacts.
  const wfAbs = resolveWritableRunDir(project.workingFolder);
  const runDir = wfAbs ? path.join(wfAbs, "runs", isoStamp()) : null;

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

      // Honor client cancellation. The runtime takes an AbortSignal.
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      request.signal.addEventListener("abort", onAbort);

      try {
        if (planError) {
          send({ type: "node-error", id: null, error: planError });
          send({ type: "complete", transcript: { error: planError }, brief: `# Error\n\n${planError}\n` });
          controller.close();
          return;
        }

        // Pass 11: resolve upload contents from disk before any LLM call. We
        // run this here (the route, the Node-runtime boundary) instead of
        // inside the lib so file-system access stays out of the runtime
        // module — keeps the lib testable under mocked fetch.
        const uploads = await loadUploadContents(project, send);
        send({
          type: "uploads-loaded",
          count: uploads.loaded.length,
          totalBytes: uploads.totalBytes,
          truncated: uploads.truncated,
        });

        const { transcript, brief } = await runProject({
          project,
          query,
          model,
          loadedUploads: uploads.loaded,
          baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
          signal: ac.signal,
          onEvent: (evt) => {
            // Attach runDir to the final `complete` event so the UI can show
            // the path. We swallow it on every other event to keep frames lean.
            if (evt.type === "complete") {
              send({ ...evt, runDir });
            } else {
              send(evt);
            }
          },
        });

        // Persist artifacts. Failures here are non-fatal; we surface them as
        // a warning event so the client can show a small badge.
        if (runDir) {
          try {
            await fs.mkdir(runDir, { recursive: true });
            await fs.writeFile(
              path.join(runDir, "transcript.json"),
              JSON.stringify(transcript, null, 2),
              "utf8",
            );
            await fs.writeFile(path.join(runDir, "brief.md"), brief, "utf8");
          } catch (err) {
            send({
              type: "warning",
              text: `could not write run artifacts to ${runDir}: ${err?.message || "write failed"}`,
            });
          }
        } else if (project.workingFolder) {
          send({
            type: "warning",
            text: `working folder "${project.workingFolder}" is not under the permitted root; run artifacts not saved`,
          });
        } else {
          send({
            type: "warning",
            text: "no working folder set on this project — run artifacts not saved",
          });
        }
      } catch (err) {
        send({
          type: "node-error",
          id: null,
          error: err?.message || "run failed",
        });
        send({
          type: "complete",
          transcript: { error: err?.message || "run failed" },
          brief: `# Error\n\n${err?.message || "run failed"}\n`,
          runDir: null,
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
