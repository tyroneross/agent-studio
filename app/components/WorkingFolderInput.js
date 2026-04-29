"use client";

import { useEffect, useRef, useState } from "react";
import { PERMITTED_PATH_PREFIXES, looksAbsolutePath } from "../lib/projects";
import FolderPickerModal from "./FolderPickerModal";

// Working folder input for the active project. Pass 10.
//
// Two input modes:
//   1. Type / paste an absolute path. Validation hits /api/fs/validate after
//      a short debounce. Inline status: green check (exists+dir+writable),
//      amber dot (exists but not writable, or not a directory), red X
//      (rejected / missing), or no-badge (empty).
//   2. Browse — opens FolderPickerModal, a server-driven directory picker
//      backed by /api/fs/list. The modal returns an absolute path on commit.
//
// Pass 10 removed the previous webkitdirectory <input> (macOS labels that
// "Upload" — confusing) and the drag-drop folder zone (browsers don't expose
// absolute paths via drag-drop in standard mode, so the zone could only ever
// surface a name and apologize). Drag-drop for actual file uploads stays in
// UploadZone, which is a different surface.
export default function WorkingFolderInput({ value, onChange, disabled = false }) {
  const [draft, setDraft] = useState(value ?? "");
  const [status, setStatus] = useState({ kind: "idle" }); // idle | checking | ok | warn | error
  const [hint, setHint] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const debounceRef = useRef(null);

  // Keep draft in sync with the active project's stored value (e.g. on project switch).
  useEffect(() => {
    setDraft(value ?? "");
  }, [value]);

  // Validate against /api/fs/validate after typing settles.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!draft) {
      setStatus({ kind: "idle" });
      setHint("");
      return;
    }
    if (!looksAbsolutePath(draft)) {
      setStatus({ kind: "warn" });
      setHint("must be absolute path (start with /)");
      return;
    }
    if (!PERMITTED_PATH_PREFIXES.some((prefix) => draft.startsWith(prefix))) {
      setStatus({ kind: "warn" });
      setHint("path outside permitted root (/Users, /tmp, /var/folders)");
      return;
    }
    setStatus({ kind: "checking" });
    setHint("");
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch("/api/fs/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: draft }),
        });
        const data = await res.json();
        if (!data.ok) {
          setStatus({ kind: "error" });
          setHint(data.error || "rejected");
          return;
        }
        if (!data.exists) {
          setStatus({ kind: "error" });
          setHint("path does not exist");
          return;
        }
        if (!data.isDirectory) {
          setStatus({ kind: "warn" });
          setHint("path is not a directory");
          return;
        }
        if (!data.writable) {
          setStatus({ kind: "warn" });
          setHint("directory is not writable");
          return;
        }
        setStatus({ kind: "ok" });
        setHint("ready");
      } catch (err) {
        setStatus({ kind: "error" });
        setHint(err?.message || "validation failed");
      }
    }, 250);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [draft]);

  function commit(next) {
    setDraft(next);
    onChange(next);
  }

  // Picker committed a path. Set the input AND attempt mkdir if missing — that
  // way clicking "Use this folder" on a not-yet-created project subdirectory
  // works the same as typing one and waiting for create-on-validate to fire.
  // We don't await; the typing effect above will still validate the new draft
  // a few hundred ms later either way.
  async function onPickerSelect(absPath) {
    setPickerOpen(false);
    commit(absPath);
    // Best-effort: ensure the directory exists if it was a typed-path that the
    // picker accepted on Enter. The list route only returns existing dirs, so
    // in practice this branch is mostly inert — but it's safe and cheap.
    try {
      await fetch("/api/fs/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: absPath, create: true }),
      });
    } catch {
      /* swallow — the typing-debounced validator will report the real status */
    }
  }

  const badge =
    status.kind === "ok" ? <span className="wf-badge wf-ok" title="Validated">✓</span> :
    status.kind === "warn" ? <span className="wf-badge wf-warn" title={hint}>!</span> :
    status.kind === "error" ? <span className="wf-badge wf-error" title={hint}>✕</span> :
    status.kind === "checking" ? <span className="wf-badge wf-check" title="Checking…">…</span> :
    null;

  return (
    <div className="wf">
      <span className="panel-label">Working folder</span>
      <div className="wf-row">
        <input
          className="panel-input wf-input"
          type="text"
          value={draft}
          placeholder="/Users/you/path/to/project"
          onChange={(e) => commit(e.target.value)}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={disabled}
          data-working-folder-input
        />
        {badge}
        <button
          type="button"
          className="tool-btn wf-browse"
          onClick={() => setPickerOpen(true)}
          disabled={disabled}
          data-working-folder-browse
        >
          Browse
        </button>
      </div>
      {hint && (
        <p
          className={`wf-hint wf-hint-${status.kind}`}
          data-working-folder-hint
          data-working-folder-status={status.kind}
        >
          {hint}
        </p>
      )}

      <FolderPickerModal
        open={pickerOpen}
        initialPath={draft || ""}
        onSelect={onPickerSelect}
        onClose={() => setPickerOpen(false)}
      />

      <style jsx>{`
        .wf {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .wf-row {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .wf-input {
          flex: 1;
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px;
        }
        .panel-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .panel-input {
          width: 100%;
          padding: 8px 10px;
          font-family: inherit;
          font-size: 13px;
          color: var(--ink);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          outline: none;
          transition: border-color 100ms ease, box-shadow 100ms ease;
        }
        .panel-input:hover {
          border-color: var(--border-strong);
        }
        .panel-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .wf-badge {
          width: 22px;
          height: 22px;
          border-radius: 50%;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 12px;
          font-weight: 600;
          flex-shrink: 0;
        }
        .wf-ok { background: var(--accent-soft); color: var(--accent-strong); }
        .wf-warn { background: var(--policy-soft); color: var(--policy); }
        .wf-error { background: var(--danger-soft); color: var(--danger); }
        .wf-check { background: var(--surface); color: var(--muted); border: 1px solid var(--border); }
        .wf-browse {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
          cursor: pointer;
          height: 32px;
          padding: 0 12px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--surface);
          font-size: 13px;
          color: var(--ink);
          font-family: inherit;
        }
        .wf-browse:hover {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .wf-hint {
          font-size: 11px;
          margin: 0;
          line-height: 1.4;
          color: var(--muted);
        }
        .wf-hint-ok { color: var(--accent-strong); }
        .wf-hint-warn { color: var(--policy); }
        .wf-hint-error { color: var(--danger); }
      `}</style>
    </div>
  );
}
