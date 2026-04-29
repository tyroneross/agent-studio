"use client";

// Renders the saved projects with Open / Rename / Delete actions. Pure
// presentational — all state lives in the parent.
//
// Props:
//   projects: Project[]
//   activeProjectId: string | null
//   onOpen(id): void                 // navigates to /canvas with this active
//   onRename(id, name): void
//   onDelete(id): void
export default function ProjectsList({
  projects,
  activeProjectId,
  onOpen,
  onRename,
  onDelete,
}) {
  function handleRename(p) {
    if (typeof window === "undefined") return;
    const next = window.prompt("Rename project:", p.name);
    if (!next || !next.trim()) return;
    onRename(p.id, next.trim());
  }
  function handleDelete(p) {
    if (typeof window === "undefined") return;
    if (!window.confirm(`Delete project "${p.name}"? This cannot be undone.`)) return;
    onDelete(p.id);
  }

  if (!projects || projects.length === 0) {
    return (
      <div className="pl-empty" data-projects-empty>
        <p className="pl-empty-text">
          No projects yet. Click <strong>+ new project</strong> above to start one.
        </p>
        <style jsx>{`
          .pl-empty {
            border: 1px dashed var(--border-strong);
            border-radius: 12px;
            padding: 28px 20px;
            text-align: center;
            color: var(--muted);
            background: var(--surface);
          }
          .pl-empty-text { margin: 0; font-size: 14px; }
        `}</style>
      </div>
    );
  }

  // Pass 14.5 — split by status so completed projects render in a separate
  // dimmed section under a "Completed" divider.
  const drafts = projects.filter((p) => p.status !== "completed");
  const completed = projects.filter((p) => p.status === "completed");

  return (
    <div data-projects-list-wrap>
      <ProjectListUL
        projects={drafts}
        activeProjectId={activeProjectId}
        onOpen={onOpen}
        handleRename={handleRename}
        handleDelete={handleDelete}
      />
      {completed.length > 0 && (
        <>
          <div className="pl-completed-divider" data-projects-completed-divider>
            Completed
          </div>
          <ProjectListUL
            projects={completed}
            activeProjectId={activeProjectId}
            onOpen={onOpen}
            handleRename={handleRename}
            handleDelete={handleDelete}
            dimmed
          />
        </>
      )}
      <style jsx>{`
        .pl-completed-divider {
          margin: 16px 0 8px;
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
      `}</style>
    </div>
  );
}

function ProjectListUL({ projects, activeProjectId, onOpen, handleRename, handleDelete, dimmed = false }) {
  return (
    <ul className={`pl-list ${dimmed ? "is-dimmed" : ""}`} data-projects-list data-projects-group={dimmed ? "completed" : "draft"}>
      {projects.map((p) => {
        const isActive = p.id === activeProjectId;
        const created = formatDate(p.createdAt);
        return (
          <li
            key={p.id}
            className={`pl-row ${isActive ? "is-active" : ""}`}
            data-project-row
            data-project-id={p.id}
            data-project-status={p.status === "completed" ? "completed" : "draft"}
          >
            <div className="pl-row-main">
              <button
                type="button"
                className="pl-name"
                onClick={() => onOpen(p.id)}
                title="Open in canvas"
                data-project-open
              >
                {p.name}
              </button>
              <div className="pl-meta">
                <span className="pl-folder" title={p.workingFolder || "no working folder"}>
                  {p.workingFolder ? truncatePath(p.workingFolder) : <em>no working folder</em>}
                </span>
                <span className="pl-dot">·</span>
                <span className="pl-date">{created}</span>
                {Array.isArray(p.uploads) && p.uploads.length > 0 && (
                  <>
                    <span className="pl-dot">·</span>
                    <span className="pl-uploads">{p.uploads.length} file{p.uploads.length === 1 ? "" : "s"}</span>
                  </>
                )}
              </div>
            </div>
            <div className="pl-actions">
              <button
                type="button"
                className="tool-btn pl-action"
                onClick={() => onOpen(p.id)}
                data-project-open-action
              >
                open
              </button>
              <button
                type="button"
                className="tool-btn pl-action"
                onClick={() => handleRename(p)}
                data-project-rename
              >
                rename
              </button>
              <button
                type="button"
                className="tool-btn pl-action pl-danger"
                onClick={() => handleDelete(p)}
                data-project-delete
              >
                delete
              </button>
            </div>
          </li>
        );
      })}

      <style jsx>{`
        .pl-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .pl-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 14px;
          border: 1px solid var(--border);
          border-radius: 10px;
          background: var(--surface);
        }
        .pl-row.is-active {
          border-color: var(--accent);
          background: var(--accent-soft);
        }
        .is-dimmed .pl-row {
          opacity: 0.7;
        }
        .is-dimmed .pl-name {
          color: var(--muted);
        }
        .pl-row-main {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .pl-name {
          font-size: 15px;
          font-weight: 600;
          color: var(--ink);
          background: none;
          border: 0;
          padding: 0;
          text-align: left;
          cursor: pointer;
          font-family: inherit;
        }
        .pl-name:hover {
          color: var(--accent-strong);
        }
        .pl-meta {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--muted);
          margin-top: 2px;
          flex-wrap: wrap;
        }
        .pl-folder {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          color: var(--muted);
          max-width: 320px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pl-dot {
          color: var(--faint);
        }
        .pl-actions {
          display: flex;
          gap: 6px;
          flex-shrink: 0;
        }
        .pl-action {
          height: 28px;
          padding: 0 10px;
          font-size: 12px;
        }
        .pl-danger:hover:not(:disabled) {
          border-color: var(--danger);
          color: var(--danger);
        }
      `}</style>
    </ul>
  );
}

// Truncate the middle of a long path for compactness:
//   /Users/tyroneross/dev/git-folder/agent-studio/test
//   -> /Users/tyron…/agent-studio/test
function truncatePath(p) {
  if (typeof p !== "string") return "";
  if (p.length <= 56) return p;
  const head = p.slice(0, 14);
  const tail = p.slice(p.length - 38);
  return `${head}…${tail}`;
}

function formatDate(iso) {
  if (typeof iso !== "string") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}
