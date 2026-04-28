// POST /api/fs/validate
// Body: { path: string, create?: boolean }
// Response (always JSON):
//   - On permitted path: { ok: true, exists, isDirectory, writable, created?, error? }
//   - On rejected path:  { ok: false, error: string }
//
// "Permitted" means the path lives under one of /Users/, /tmp/, /var/folders/.
// This is a defense in depth check for a local single-user dev tool: it stops
// us from accidentally probing /etc/, /System/, /private/etc, etc.
//
// Pass 8: when `create: true` and the directory does not exist (and the path
// is permitted), the route runs `mkdir -p` and reports `{ created: true }`.
// Existing callers that omit `create` get the original behavior unchanged.

import { promises as fs } from "node:fs";
import path from "node:path";

export const runtime = "nodejs";

const PERMITTED_PREFIXES = ["/Users/", "/tmp/", "/var/folders/"];

function isPermitted(absolute) {
  // Match "/Users/foo" against prefix "/Users/" and also allow the bare root
  // (e.g. exactly "/tmp" or "/Users") by stripping one trailing slash.
  return PERMITTED_PREFIXES.some(
    (prefix) => absolute.startsWith(prefix) || absolute + "/" === prefix,
  );
}

async function isWritable(absolute) {
  // Probe writability with a temp file rather than fs.access(W_OK), which on
  // macOS can lie about ACL-mediated paths.
  const probeName = `.agent-studio-write-probe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const probePath = path.join(absolute, probeName);
  try {
    await fs.writeFile(probePath, "");
    await fs.unlink(probePath);
    return true;
  } catch {
    return false;
  }
}

export async function POST(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const raw = body?.path;
  if (typeof raw !== "string" || raw.length === 0) {
    return Response.json({ ok: false, error: "path required" }, { status: 400 });
  }
  if (!raw.startsWith("/")) {
    return Response.json({ ok: false, error: "path must be absolute" }, { status: 400 });
  }

  // Normalize before the prefix check so /Users/foo/../../etc/passwd cannot
  // sneak past the allowlist.
  const absolute = path.resolve(raw);
  if (!isPermitted(absolute)) {
    return Response.json({ ok: false, error: "path outside permitted root" }, { status: 400 });
  }

  const create = body?.create === true;

  try {
    const stat = await fs.stat(absolute);
    const isDirectory = stat.isDirectory();
    const writable = isDirectory ? await isWritable(absolute) : false;
    return Response.json({ ok: true, exists: true, isDirectory, writable });
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // Pass 8: optional create. We already validated the prefix above, so
      // mkdir -p is bounded to the permitted roots.
      if (create) {
        try {
          await fs.mkdir(absolute, { recursive: true });
          const writable = await isWritable(absolute);
          return Response.json({
            ok: true,
            exists: true,
            isDirectory: true,
            writable,
            created: true,
          });
        } catch (mkErr) {
          return Response.json(
            {
              ok: true,
              exists: false,
              isDirectory: false,
              writable: false,
              error: mkErr?.message || "mkdir failed",
            },
            { status: 200 },
          );
        }
      }
      return Response.json({ ok: true, exists: false, isDirectory: false, writable: false });
    }
    return Response.json(
      {
        ok: true,
        exists: false,
        isDirectory: false,
        writable: false,
        error: err?.message || "stat failed",
      },
      { status: 200 },
    );
  }
}
