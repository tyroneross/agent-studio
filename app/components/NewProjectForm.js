"use client";

import { useEffect, useRef, useState } from "react";
import WorkingFolderInput from "./WorkingFolderInput";
import UploadZone from "./UploadZone";
import {
  PERMITTED_PATH_PREFIXES,
  looksAbsolutePath,
  defaultWorkingFolder,
  slugifyProjectName,
} from "../lib/projects";
import { canvasFromPattern } from "../lib/agent-patterns";

// Inline new-project form. Submits a fully-formed project payload via onCreate.
//
// Fields (per Pass 5 spec):
//   - name (required)
//   - workingFolder (required, gated by /api/fs/validate)
//   - goal (warn-if-empty, allow proceed)
//   - context (optional)
//   - outcome (optional)
//   - uploads (optional; uploaded as the user adds them, recorded onto the project at submit)
//
// Working-folder validation is duplicated here from WorkingFolderInput because
// the form needs to gate Submit on the same check. WorkingFolderInput exposes
// no callback for "is valid?", so we re-run a lightweight client-side check
// (looksAbsolutePath + permitted prefix) and rely on the server's authoritative
// answer when the user actually uploads a file. A later refactor could have
// WorkingFolderInput report status upward; for now keep it self-contained.
export default function NewProjectForm({ onCreate, onCancel, seedPattern }) {
  const [name, setName] = useState(seedPattern?.name || "");
  const [workingFolder, setWorkingFolder] = useState("");
  const [folderValidated, setFolderValidated] = useState(false);
  const [goal, setGoal] = useState("");
  const [context, setContext] = useState("");
  const [outcome, setOutcome] = useState("");
  const [uploads, setUploads] = useState([]);
  const [submitAttempted, setSubmitAttempted] = useState(false);
  const folderTouchedRef = useRef(false);

  // Pass 9: when a seedPattern is supplied (e.g. user picked a pattern in the
  // onboarding wizard or the landing pattern picker), pre-fill the project
  // name with the pattern name on first mount and on pattern change. We don't
  // overwrite a name the user has already typed.
  useEffect(() => {
    if (!seedPattern) return;
    setName((current) => (current && current.trim().length > 0 ? current : seedPattern.name));
  }, [seedPattern]);

  // Pass 10: pre-fill the working folder with ${HOME}/agent-studio/<slug>/
  // as soon as we know the user's home directory. We only set it if the user
  // hasn't already typed something; once they touch the field, name changes
  // don't re-roll the default.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/fs/home");
        const data = await res.json();
        if (cancelled || !data?.home) return;
        if (folderTouchedRef.current) return;
        const candidate = defaultWorkingFolder({
          name: name || seedPattern?.name || "project",
          home: data.home,
        });
        setWorkingFolder(candidate);
        // We trigger validation manually here because we set the state directly.
        kickValidate(candidate);
      } catch {
        /* leave folder empty if we can't reach /api/fs/home */
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-roll default folder when the project name changes — but only if the
  // user hasn't manually edited the folder. Once they touch it, leave it.
  useEffect(() => {
    if (folderTouchedRef.current) return;
    if (!workingFolder) return;
    // Re-derive the slug position; only adjust the trailing segment.
    const m = workingFolder.match(/^(.*\/agent-studio\/)([^/]*)\/?$/);
    if (!m) return;
    const next = `${m[1]}${slugifyProjectName(name || seedPattern?.name || "project")}/`;
    if (next !== workingFolder) {
      setWorkingFolder(next);
      kickValidate(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, seedPattern]);

  // Whether the working folder *might* be valid. We surface this for the
  // submit gate even before the server round-trips, so the user gets fast
  // feedback. WorkingFolderInput's own server check handles the authoritative
  // verdict.
  const folderLooksValid =
    looksAbsolutePath(workingFolder) &&
    PERMITTED_PATH_PREFIXES.some((prefix) => workingFolder.startsWith(prefix));

  // Gate submit on:
  //   - non-empty name
  //   - working folder that the server has marked writable+isDirectory.
  // We track that via folderValidated, set by an effect that mirrors what
  // WorkingFolderInput would report. To avoid a duplicate fetch, we listen to
  // each working-folder change and POST the validate endpoint ourselves.
  // Trade-off: two parallel validators, which is fine for this scale and
  // simpler than refactoring WorkingFolderInput's API.
  // (See effect below.)

  // Submit-disabled reason — used for the helper text under the button so the
  // user knows why it's not enabled.
  const submitBlockedReason = (() => {
    if (!name.trim()) return "name required";
    if (!workingFolder) return "working folder required";
    if (!folderLooksValid) return "working folder must be under /Users, /tmp, or /var/folders";
    if (!folderValidated) return "validating working folder…";
    return null;
  })();

  function handleWorkingFolderChange(value) {
    folderTouchedRef.current = true;
    setWorkingFolder(value);
    kickValidate(value);
  }

  // Internal: run the same validate-and-set pattern used by both manual edits
  // and the default-folder pre-fill. Kept separate so the pre-fill effect
  // doesn't have to flip folderTouchedRef.
  //
  // Pass 11: send `create: true` so a typed-but-not-yet-existing path is
  // mkdir'd in lockstep with the inner WorkingFolderInput's own validator.
  // Without this, the form's parallel validator could race and report
  // exists:false while the inner validator created the dir, leaving the
  // submit button stuck in "validating working folder…".
  function kickValidate(value) {
    setFolderValidated(false);
    if (!value) return;
    if (!looksAbsolutePath(value)) return;
    if (!PERMITTED_PATH_PREFIXES.some((prefix) => value.startsWith(prefix))) return;
    const captured = value;
    setTimeout(async () => {
      try {
        const res = await fetch("/api/fs/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: captured, create: true }),
        });
        const data = await res.json();
        if (data && data.ok && data.exists && data.isDirectory && data.writable) {
          setFolderValidated(true);
        } else {
          setFolderValidated(false);
        }
      } catch {
        setFolderValidated(false);
      }
    }, 350);
  }

  function handleUploaded(record) {
    setUploads((arr) => [...arr, record]);
  }
  function handleUploadRemoved(savedPath) {
    setUploads((arr) => arr.filter((u) => u.savedPath !== savedPath));
  }

  function onSubmit(e) {
    e.preventDefault();
    setSubmitAttempted(true);
    if (submitBlockedReason) return;
    // Pass 9: when a seedPattern was supplied, attach its canvas (deep-cloned
    // by canvasFromPattern) to the create payload. The landing page passes
    // this through to makeProject({canvas}) so the project starts on the
    // pattern's graph instead of the default Solo Tool Agent seed.
    const canvas = seedPattern ? canvasFromPattern(seedPattern) : undefined;
    onCreate({
      name: name.trim(),
      workingFolder: workingFolder.trim(),
      goal: goal.trim(),
      context: context.trim(),
      outcome: outcome.trim(),
      uploads,
      canvas,
      seedPatternId: seedPattern?.id,
    });
  }

  const goalWarn = submitAttempted && !goal.trim();

  return (
    <form
      className="np-form"
      onSubmit={onSubmit}
      data-new-project-form
      data-new-project-seed-pattern={seedPattern?.id || ""}
    >
      <p className="np-intro" data-new-project-intro>
        Set up a project. You can change anything later.
      </p>
      {seedPattern && (
        <div className="np-pattern-banner" data-new-project-pattern-banner>
          <span className="np-pattern-label">Pattern</span>
          <span className="np-pattern-name">{seedPattern.name}</span>
          <span className="np-pattern-desc">{seedPattern.shortDescription}</span>
        </div>
      )}
      <div className="np-grid">
        <label className="np-field">
          <span className="np-label">Name</span>
          <input
            className="np-input"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My agent"
            data-new-project-name
            required
          />
        </label>

        <div className="np-field">
          <WorkingFolderInput
            value={workingFolder}
            onChange={handleWorkingFolderChange}
          />
        </div>

        <label className="np-field">
          <span className="np-label">
            Goal {goalWarn && <span className="np-warn">— consider adding one</span>}
          </span>
          <textarea
            className="np-input np-textarea"
            rows={3}
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            placeholder="One or two sentences describing what this agent is for."
            data-new-project-goal
          />
        </label>

        <label className="np-field">
          <span className="np-label">Context</span>
          <textarea
            className="np-input np-textarea np-textarea-tall"
            rows={6}
            value={context}
            onChange={(e) => setContext(e.target.value)}
            placeholder="Background information, prior decisions, links, or constraints."
            data-new-project-context
          />
        </label>

        <label className="np-field">
          <span className="np-label">Desired outcome</span>
          <textarea
            className="np-input np-textarea"
            rows={3}
            value={outcome}
            onChange={(e) => setOutcome(e.target.value)}
            placeholder="What does success look like? How will you know this agent worked?"
            data-new-project-outcome
          />
        </label>
      </div>

      <section className="np-uploads" data-new-project-uploads>
        <h3 className="np-uploads-title">Context files (optional)</h3>
        <p className="np-uploads-help">
          Saved into <code>{workingFolder ? `${workingFolder.replace(/\/$/, "")}/uploads/` : "<workingFolder>/uploads/"}</code>.
        </p>
        <UploadZone
          workingFolder={folderValidated ? workingFolder : ""}
          uploads={uploads}
          onUploaded={handleUploaded}
          onRemoved={handleUploadRemoved}
          disabled={!folderValidated}
        />
      </section>

      <div className="np-actions">
        <button
          type="submit"
          className="tool-btn np-submit"
          disabled={!!submitBlockedReason}
          data-new-project-submit
        >
          create project
        </button>
        {onCancel && (
          <button type="button" className="tool-btn" onClick={onCancel} data-new-project-cancel>
            cancel
          </button>
        )}
        <span className="np-blocked">{submitBlockedReason || "ready"}</span>
      </div>

      <style jsx>{`
        .np-form {
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .np-intro {
          font-size: 13px;
          color: var(--muted);
          margin: 0;
          line-height: 1.5;
        }
        .np-uploads {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 14px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--surface);
        }
        .np-uploads-title {
          margin: 0;
          font-size: 13px;
          font-weight: 600;
          color: var(--ink);
        }
        .np-uploads-help {
          margin: 0;
          font-size: 11px;
          color: var(--muted);
          line-height: 1.4;
        }
        .np-uploads-help code {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
        }
        .np-grid {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .np-field {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .np-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .np-warn {
          color: var(--policy);
          text-transform: none;
          letter-spacing: 0;
          font-size: 11px;
        }
        .np-input {
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
        .np-input:hover {
          border-color: var(--border-strong);
        }
        .np-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .np-textarea {
          resize: vertical;
          min-height: 64px;
          line-height: 1.4;
          font-family: inherit;
        }
        .np-textarea-tall {
          min-height: 120px;
        }
        .np-actions {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .np-submit {
          font-weight: 600;
        }
        .np-submit:not(:disabled) {
          background: var(--accent-soft);
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .np-blocked {
          font-size: 12px;
          color: var(--muted);
        }
        .np-pattern-banner {
          display: flex;
          flex-direction: column;
          gap: 2px;
          padding: 10px 14px;
          border: 1px solid var(--border);
          border-left: 3px solid var(--accent);
          border-radius: 8px;
          background: var(--accent-soft);
        }
        .np-pattern-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--accent-strong);
        }
        .np-pattern-name {
          font-size: 14px;
          font-weight: 600;
          color: var(--ink);
        }
        .np-pattern-desc {
          font-size: 12px;
          color: var(--muted);
          line-height: 1.4;
        }
      `}</style>
    </form>
  );
}
