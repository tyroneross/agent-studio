"use client";

import { useEffect, useRef, useState } from "react";

// Toolbar control: shows the active project's name as a button, opens a
// dropdown listing all projects with new/rename/delete actions. Inline-styled
// to stay consistent with .tool-btn, no new CSS files.
//
// Props:
//   projects: Project[]
//   activeProjectId: string
//   onSelect(id)
//   onNew(name) -> string | undefined  // returns the new id; component closes
//   onRename(id, name)
//   onDelete(id)
export default function ProjectSwitcher({
  projects,
  activeProjectId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const active = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;
  const onlyOne = projects.length <= 1;
  // Pass 14.5 — group projects by status so completed projects render in a
  // separate dimmed section. Original ordering is preserved within each group
  // so the user's mental model of "newest first" stays intact.
  const drafts = projects.filter((p) => p.status !== "completed");
  const completed = projects.filter((p) => p.status === "completed");

  // Close on outside click / Escape so the dropdown doesn't trap focus.
  useEffect(() => {
    if (!open) return;
    function onDown(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function handleNew() {
    const name =
      typeof window !== "undefined"
        ? window.prompt("Name for the new project:", "New project")
        : null;
    if (!name || !name.trim()) return;
    onNew(name.trim());
    setOpen(false);
  }

  function handleRename(project) {
    const name =
      typeof window !== "undefined"
        ? window.prompt("Rename project:", project.name)
        : null;
    if (!name || !name.trim()) return;
    onRename(project.id, name.trim());
  }

  function handleDelete(project) {
    if (onlyOne) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(`Delete project "${project.name}"? This cannot be undone.`)
    ) {
      return;
    }
    onDelete(project.id);
  }

  return (
    <div className="proj-switcher" ref={wrapRef} data-project-switcher>
      <button
        className="tool-btn"
        onClick={() => setOpen((v) => !v)}
        title="Switch project"
        data-project-switcher-trigger
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="proj-name">{active ? active.name : "(no project)"}</span>
        <span className="proj-caret">▾</span>
      </button>

      {open && (
        <div className="proj-menu" role="menu" data-project-switcher-menu>
          <ProjectGroup
            projects={drafts}
            activeProjectId={activeProjectId}
            onSelect={onSelect}
            setOpen={setOpen}
            handleRename={handleRename}
            handleDelete={handleDelete}
            onlyOne={onlyOne}
          />
          {completed.length > 0 && (
            <>
              <div className="proj-group-divider" data-project-completed-divider>
                Completed
              </div>
              <ProjectGroup
                projects={completed}
                activeProjectId={activeProjectId}
                onSelect={onSelect}
                setOpen={setOpen}
                handleRename={handleRename}
                handleDelete={handleDelete}
                onlyOne={onlyOne}
                dimmed
              />
            </>
          )}
          <div className="proj-menu-footer">
            <button className="tool-btn proj-new" onClick={handleNew} data-project-new>
              + new project
            </button>
          </div>
        </div>
      )}

      <style jsx>{`
        .proj-switcher {
          position: relative;
          display: inline-flex;
        }
        .proj-name {
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .proj-caret {
          margin-left: 8px;
          font-size: 10px;
          color: var(--muted);
        }
        .proj-menu {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          min-width: 280px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          box-shadow: var(--shadow-lift);
          z-index: 20;
          overflow: hidden;
        }
        .proj-menu-section {
          max-height: 280px;
          overflow-y: auto;
          padding: 6px;
        }
        .proj-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 4px 6px;
          border-radius: 6px;
        }
        .proj-row:hover {
          background: var(--accent-soft);
        }
        .proj-row.is-active .proj-row-name {
          color: var(--accent-strong);
          font-weight: 600;
        }
        .proj-pick {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          background: none;
          border: 0;
          padding: 4px 4px;
          font-size: 13px;
          color: var(--ink);
          cursor: pointer;
          text-align: left;
          font-family: inherit;
        }
        .proj-dot {
          width: 12px;
          font-size: 10px;
          color: var(--accent);
        }
        .proj-row-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .proj-row-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }
        .proj-mini {
          height: 24px;
          padding: 0 8px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--surface);
          font-size: 11px;
          color: var(--muted);
          cursor: pointer;
          font-family: inherit;
        }
        .proj-mini:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .proj-mini-danger:hover:not(:disabled) {
          border-color: var(--danger);
          color: var(--danger);
        }
        .proj-mini:disabled {
          color: var(--faint);
          cursor: not-allowed;
        }
        .proj-menu-footer {
          padding: 6px;
          border-top: 1px solid var(--border);
        }
        .proj-new {
          width: 100%;
        }
        .proj-group-divider {
          padding: 6px 12px;
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
          background: var(--surface-muted, #f4f3ee);
          border-top: 1px solid var(--border);
          border-bottom: 1px solid var(--border);
        }
        .proj-menu-section.is-dimmed :global(.proj-row-name) {
          color: var(--muted);
        }
      `}</style>
    </div>
  );
}

// Pass 14.5 — render a single group of projects (drafts or completed). The
// dimmed flag toggles muted styling so completed projects feel secondary.
function ProjectGroup({
  projects,
  activeProjectId,
  onSelect,
  setOpen,
  handleRename,
  handleDelete,
  onlyOne,
  dimmed = false,
}) {
  if (!projects || projects.length === 0) return null;
  return (
    <div
      className={`proj-menu-section ${dimmed ? "is-dimmed" : ""}`}
      data-project-group={dimmed ? "completed" : "draft"}
    >
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        return (
          <div
            key={p.id}
            className={`proj-row ${isActive ? "is-active" : ""}`}
            data-project-row
            data-project-id={p.id}
            data-project-status={p.status === "completed" ? "completed" : "draft"}
          >
            <button
              className="proj-pick"
              onClick={() => {
                onSelect(p.id);
                setOpen(false);
              }}
              title={isActive ? "Active project" : "Switch to this project"}
            >
              <span className="proj-dot" aria-hidden>{isActive ? "●" : "○"}</span>
              <span className="proj-row-name">{p.name}</span>
            </button>
            <div className="proj-row-actions">
              <button
                className="proj-mini"
                onClick={() => handleRename(p)}
                title="Rename project"
                data-project-rename
              >
                rename
              </button>
              <button
                className="proj-mini proj-mini-danger"
                onClick={() => handleDelete(p)}
                disabled={onlyOne}
                title={onlyOne ? "Cannot delete the only project" : "Delete project"}
                data-project-delete
              >
                delete
              </button>
            </div>
          </div>
        );
      })}
      <style jsx>{`
        .proj-menu-section {
          max-height: 280px;
          overflow-y: auto;
          padding: 6px;
        }
        .proj-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 4px 6px;
          border-radius: 6px;
        }
        .proj-row:hover {
          background: var(--accent-soft);
        }
        .proj-row.is-active .proj-row-name {
          color: var(--accent-strong);
          font-weight: 600;
        }
        .proj-pick {
          flex: 1;
          display: flex;
          align-items: center;
          gap: 8px;
          background: none;
          border: 0;
          padding: 4px 4px;
          font-size: 13px;
          color: var(--ink);
          cursor: pointer;
          text-align: left;
          font-family: inherit;
        }
        .proj-dot {
          width: 12px;
          font-size: 10px;
          color: var(--accent);
        }
        .proj-row-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .is-dimmed .proj-row-name,
        .is-dimmed .proj-pick {
          color: var(--muted);
        }
        .is-dimmed .proj-row {
          opacity: 0.85;
        }
        .proj-row-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }
        .proj-mini {
          height: 24px;
          padding: 0 8px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--surface);
          font-size: 11px;
          color: var(--muted);
          cursor: pointer;
          font-family: inherit;
        }
        .proj-mini:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .proj-mini-danger:hover:not(:disabled) {
          border-color: var(--danger);
          color: var(--danger);
        }
        .proj-mini:disabled {
          color: var(--faint);
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
