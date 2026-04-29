// POST /api/fs/write-markdown
// Body (application/json): { workingFolder: string, content: string, filename?: string }
//   - workingFolder: absolute path. Same allowlist as /api/uploads + /api/agent/run.
//   - content:       full markdown body to write (already serialized).
//   - filename:      defaults to "agent.md". Sanitized to a basename and
//                    constrained to a `.md` extension so this route can't be
//                    repurposed to write arbitrary files.
//
// Response (always JSON):
//   - success:  { ok: true,  savedPath, bytes }
//   - rejected: { ok: false, error: string }
//
// Atomic write: writes to <savedPath>.tmp then renames over savedPath so a
// crash mid-write never leaves a half-written agent.md on disk. This is the
// same guarantee the spec exporter (Pass 14) gave for the 10-file directory.
//
// Pass 14.5: introduced for the "Export markdown" toolbar action. Defense in
// depth — the client also checks `looksAbsolutePath` + the same prefix list
// before sending; this is the server-side gate.

import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const PERMITTED_PREFIXES = ["/Users/", "/tmp/", "/var/folders/"];
const MAX_BYTES = 4 * 1024 * 1024; // 4 MB cap; agent.md should never approach this.

function isPermittedFolder(absolute) {
  return PERMITTED_PREFIXES.some(
    (prefix) => absolute.startsWith(prefix) || absolute + "/" === prefix,
  );
}

// Strip path separators from filename and reject names that would resolve
// outside the workingFolder. Force a `.md` extension.
function sanitizeMarkdownFilename(rawName) {
  if (typeof rawName !== "string" || rawName.length === 0) return null;
  const base = path.basename(rawName);
  if (
    !base ||
    base === "." ||
    base === ".." ||
    base.includes("/") ||
    base.includes("\\") ||
    base.includes("\0")
  ) {
    return null;
  }
  const ext = path.extname(base).toLowerCase();
  if (ext !== ".md") return null;
  return base;
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "expected application/json body" }, { status: 400 });
  }

  const { workingFolder: rawFolder, content, filename: rawFilename } = body || {};

  if (typeof rawFolder !== "string" || rawFolder.length === 0) {
    return Response.json({ ok: false, error: "workingFolder required" }, { status: 400 });
  }
  if (!rawFolder.startsWith("/")) {
    return Response.json({ ok: false, error: "workingFolder must be absolute" }, { status: 400 });
  }
  // Normalize before the prefix check so /Users/foo/../../etc cannot sneak past.
  const workingFolder = path.resolve(rawFolder);
  if (!isPermittedFolder(workingFolder)) {
    return Response.json({ ok: false, error: "workingFolder outside permitted root" }, { status: 400 });
  }

  if (typeof content !== "string") {
    return Response.json({ ok: false, error: "content (string) required" }, { status: 400 });
  }
  // Use Buffer.byteLength so multi-byte characters count correctly.
  const buf = Buffer.from(content, "utf8");
  if (buf.length > MAX_BYTES) {
    return Response.json({ ok: false, error: "content exceeds 4MB limit" }, { status: 400 });
  }

  const filename = sanitizeMarkdownFilename(rawFilename ?? "agent.md");
  if (!filename) {
    return Response.json({ ok: false, error: "invalid filename (must end in .md)" }, { status: 400 });
  }

  // mkdir -p the working folder in case the user just typed it for the first
  // time; consistent with /api/uploads behaviour.
  try {
    await fs.mkdir(workingFolder, { recursive: true });
  } catch (err) {
    return Response.json(
      { ok: false, error: `could not create working folder: ${err?.message || "mkdir failed"}` },
      { status: 500 },
    );
  }

  const savedPath = path.join(workingFolder, filename);
  const tmpPath = `${savedPath}.tmp`;
  try {
    await fs.writeFile(tmpPath, buf);
    await fs.rename(tmpPath, savedPath);
  } catch (err) {
    // Best-effort cleanup of the half-written tmp file.
    try { await fs.unlink(tmpPath); } catch {}
    return Response.json(
      { ok: false, error: `could not write file: ${err?.message || "write failed"}` },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, savedPath, bytes: buf.length });
}
