"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import ProjectsList from "./components/ProjectsList";
import NewProjectForm from "./components/NewProjectForm";
import HowItWorks from "./components/HowItWorks";
import {
  emptyStore,
  getActiveProject,
  loadStore,
  makeProject,
  makeDemoProject,
  findDemoProject,
  DEMO_PROJECT_NAME,
  DEMO_PROJECT_WORKING_FOLDER,
  withProjectUpdated,
  writeStore,
} from "./lib/projects";

// Landing page. Shows existing projects and gates new-project creation behind
// a single-screen form. Submitting routes to /canvas with the new project active.
//
// Pass 8 additions:
//   - When zero projects exist, show a hero + "How it works" + two CTAs.
//   - "Try the demo project" creates a canonical seeded project (or opens
//     it if one already exists) and routes to /canvas.
//   - Inline Ollama health check pings /api/agent/models and reports state.
export default function Landing() {
  const router = useRouter();
  const [store, setStore] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [demoError, setDemoError] = useState(null);

  // Pass 8: Ollama prereq state. "unknown" while loading, "ok" if >=1 model,
  // "warn" if reachable but empty, "err" if unreachable. The empty state on
  // the landing page renders a compact pill driven by this.
  const [prereq, setPrereq] = useState({ status: "unknown", detail: null });

  useEffect(() => {
    const loaded = loadStore();
    if (loaded) {
      setStore(loaded);
    } else {
      const fresh = emptyStore();
      setStore(fresh);
      writeStore(fresh);
    }
  }, []);

  // Health check: only when no projects exist. We don't need to spam the
  // model endpoint on every visit — once the user has projects they'll see
  // model state inside the canvas test panel.
  useEffect(() => {
    if (!store) return;
    if (store.projects.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/agent/models");
        const body = await res.json();
        if (cancelled) return;
        if (body?.ok && Array.isArray(body.models) && body.models.length > 0) {
          setPrereq({ status: "ok", detail: `${body.models.length} model${body.models.length === 1 ? "" : "s"} available` });
        } else if (body?.ok && Array.isArray(body.models)) {
          setPrereq({ status: "warn", detail: "ollama is reachable but no models are pulled" });
        } else {
          setPrereq({ status: "err", detail: body?.error || "ollama did not respond" });
        }
      } catch (err) {
        if (cancelled) return;
        setPrereq({ status: "err", detail: err?.message || "ollama unreachable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const activeProject = useMemo(() => (store ? getActiveProject(store) : null), [store]);

  function persist(next) {
    setStore(next);
    writeStore(next);
  }

  function handleOpen(projectId) {
    if (!store) return;
    const next = { ...store, activeProjectId: projectId };
    persist(next);
    router.push("/canvas");
  }

  function handleRename(projectId, name) {
    if (!store) return;
    const next = withProjectUpdated(store, projectId, (p) => ({ ...p, name }));
    persist(next);
  }

  function handleDelete(projectId) {
    if (!store) return;
    const remaining = store.projects.filter((p) => p.id !== projectId);
    const wasActive = store.activeProjectId === projectId;
    const next = {
      ...store,
      projects: remaining,
      activeProjectId: wasActive ? (remaining[0]?.id ?? null) : store.activeProjectId,
    };
    persist(next);
  }

  function handleCreate({ name, workingFolder, goal, context, outcome, uploads }) {
    const project = makeProject({ name, workingFolder, goal, context, outcome, uploads });
    const next = store
      ? { ...store, projects: [...store.projects, project], activeProjectId: project.id }
      : { ...emptyStore(), projects: [project], activeProjectId: project.id };
    persist(next);
    router.push("/canvas");
  }

  // Pass 8: idempotent demo flow.
  //   1. If a project named DEMO_PROJECT_NAME exists, switch to it and go.
  //   2. Otherwise: ensure /tmp/agent-studio-demo/ exists via /api/fs/validate
  //      with create:true, build the seeded project, persist, navigate.
  // Errors don't block — we still create the project locally and let the
  // canvas surface working-folder warnings later. We do show the message
  // inline so the user knows.
  async function handleTryDemo() {
    if (!store) return;
    if (demoBusy) return;
    setDemoBusy(true);
    setDemoError(null);

    const existing = findDemoProject(store);
    if (existing) {
      const next = { ...store, activeProjectId: existing.id };
      persist(next);
      // Mark the existing project's onboarded flag so we don't re-prompt
      // someone who has already seen the welcome modal for the demo.
      router.push("/canvas");
      return;
    }

    // Best-effort mkdir. The /tmp/agent-studio-demo path is permitted by the
    // validator's allowlist. We don't fail if it errors — the canvas will
    // show the working-folder warning the same way it does for any project.
    try {
      const res = await fetch("/api/fs/validate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: DEMO_PROJECT_WORKING_FOLDER, create: true }),
      });
      const body = await res.json();
      if (!body?.ok) {
        setDemoError(body?.error || "could not prepare working folder");
      }
    } catch (err) {
      setDemoError(err?.message || "could not reach /api/fs/validate");
    }

    const project = makeDemoProject();
    const next = {
      ...store,
      projects: [...store.projects, project],
      activeProjectId: project.id,
    };
    persist(next);
    setDemoBusy(false);
    router.push("/canvas");
  }

  if (!store) {
    return (
      <div className="land-loading" data-landing-loading>
        Loading…
        <style jsx>{`
          .land-loading {
            padding: 48px;
            color: var(--muted);
            font-size: 14px;
          }
        `}</style>
      </div>
    );
  }

  const hasProjects = store.projects.length > 0;

  return (
    <div className="land">
      <header className="land-hero">
        <div className="land-hero-text">
          <span className="land-eyebrow">Agent Studio</span>
          <h1 className="land-title">
            {hasProjects
              ? "Visual canvas for agent design and testing."
              : "Design and test agents on your local machine. No cloud, no waiting."}
          </h1>
          <p className="land-sub">
            Sketch the agent graph, attach context files, and iterate on a project at a time.
          </p>
        </div>
        {hasProjects && (
          <button
            type="button"
            className="tool-btn land-cta"
            onClick={() => setShowForm((v) => !v)}
            data-landing-new-project
          >
            {showForm ? "close" : "+ new project"}
          </button>
        )}
      </header>

      <main className="land-main">
        {!hasProjects && !showForm && (
          <section className="land-card" data-landing-empty>
            <HowItWorks />

            <div className="land-cta-row" data-landing-cta-row>
              <button
                type="button"
                className="cta cta-primary"
                onClick={handleTryDemo}
                disabled={demoBusy}
                data-landing-try-demo
              >
                {demoBusy ? "Preparing demo…" : "Try the demo project"}
              </button>
              <button
                type="button"
                className="cta cta-secondary"
                onClick={() => setShowForm(true)}
                data-landing-create-blank
              >
                Create blank project
              </button>
            </div>

            <div
              className={`prereq prereq-${prereq.status}`}
              data-landing-prereq
              data-prereq-status={prereq.status}
            >
              <span className="prereq-dot" aria-hidden="true" />
              <span className="prereq-label">
                {prereq.status === "unknown" && "Checking Ollama…"}
                {prereq.status === "ok" && `Ollama ready · ${prereq.detail}`}
                {prereq.status === "warn" && (
                  <>
                    Ollama is reachable but no models are pulled. See{" "}
                    <a href="/README.md#troubleshooting" target="_blank" rel="noreferrer">
                      troubleshooting
                    </a>
                    .
                  </>
                )}
                {prereq.status === "err" && (
                  <>
                    Ollama not reachable ({prereq.detail}). See{" "}
                    <a href="/README.md#troubleshooting" target="_blank" rel="noreferrer">
                      troubleshooting
                    </a>
                    .
                  </>
                )}
              </span>
            </div>

            {demoError && (
              <p className="land-card-sub" data-landing-demo-error>
                Working folder note: {demoError}
              </p>
            )}
          </section>
        )}

        {showForm && (
          <section className="land-card" data-landing-form>
            <div className="land-card-header">
              <span className="land-eyebrow">New project</span>
              <p className="land-card-sub">
                Pick a working folder under <code>/Users</code>, <code>/tmp</code>, or
                <code> /var/folders</code>. Files dropped below upload immediately into
                <code> &lt;workingFolder&gt;/uploads/</code>.
              </p>
            </div>
            <NewProjectForm
              onCreate={handleCreate}
              onCancel={() => setShowForm(false)}
            />
          </section>
        )}

        {hasProjects && (
          <section className="land-card">
            <div className="land-card-header">
              <span className="land-eyebrow">
                Projects {store.projects.length > 0 && `(${store.projects.length})`}
              </span>
              {activeProject && (
                <span className="land-card-sub">
                  Active: <strong>{activeProject.name}</strong>
                </span>
              )}
            </div>
            <ProjectsList
              projects={store.projects}
              activeProjectId={store.activeProjectId}
              onOpen={handleOpen}
              onRename={handleRename}
              onDelete={handleDelete}
            />
          </section>
        )}
      </main>

      <style jsx>{`
        .land {
          max-width: 920px;
          margin: 0 auto;
          padding: 48px 24px 96px;
          min-height: 100vh;
        }
        .land-hero {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 24px;
          padding-bottom: 32px;
          border-bottom: 1px solid var(--border);
          margin-bottom: 32px;
          flex-wrap: wrap;
        }
        .land-hero-text {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-width: 620px;
        }
        .land-eyebrow {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .land-title {
          font-size: 28px;
          font-weight: 700;
          color: var(--ink);
          margin: 0;
          line-height: 1.2;
        }
        .land-sub {
          font-size: 15px;
          color: var(--muted);
          margin: 4px 0 0;
        }
        .land-cta {
          height: 36px;
          font-weight: 600;
          background: var(--accent-soft);
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .land-main {
          display: flex;
          flex-direction: column;
          gap: 24px;
        }
        .land-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 22px 22px 24px;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .land-card-header {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          flex-wrap: wrap;
        }
        .land-card-sub {
          font-size: 12px;
          color: var(--muted);
          margin: 0;
          line-height: 1.5;
        }
        .land-card-sub code {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          color: var(--ink);
        }
        .land-cta-row {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }
        .cta {
          font-family: inherit;
          cursor: pointer;
          border-radius: 10px;
          border: 1px solid var(--border);
          background: var(--surface);
          color: var(--ink);
          font-size: 14px;
          padding: 0 16px;
          height: 40px;
          transition: border-color 100ms ease, color 100ms ease, background 100ms ease;
        }
        .cta:disabled {
          color: var(--faint);
          cursor: not-allowed;
        }
        .cta-primary {
          flex: 1 1 280px;
          height: 44px;
          font-weight: 600;
          background: var(--accent);
          border-color: var(--accent);
          color: #ffffff;
        }
        .cta-primary:hover:not(:disabled) {
          background: var(--accent-strong);
          border-color: var(--accent-strong);
        }
        .cta-primary:disabled {
          background: var(--accent-soft);
          border-color: var(--border);
          color: var(--accent-strong);
        }
        .cta-secondary {
          flex: 0 0 auto;
        }
        .cta-secondary:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .prereq {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 12px;
          color: var(--muted);
        }
        .prereq-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--faint);
          display: inline-block;
        }
        .prereq-ok .prereq-dot {
          background: var(--eval);
        }
        .prereq-ok .prereq-label {
          color: var(--ink);
        }
        .prereq-warn .prereq-dot {
          background: var(--tool);
        }
        .prereq-warn .prereq-label {
          color: var(--ink);
        }
        .prereq-err .prereq-dot {
          background: var(--danger);
        }
        .prereq-err .prereq-label {
          color: var(--danger);
        }
        .prereq a {
          color: inherit;
          text-decoration: underline;
        }
        .tool-btn {
          height: 32px;
          padding: 0 14px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--surface);
          font-size: 13px;
          color: var(--ink);
          cursor: pointer;
          font-family: inherit;
        }
        .tool-btn:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .tool-btn:disabled {
          color: var(--faint);
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}
