"use client";

// TestPanel — slide-up panel anchored to the bottom of the canvas.
//
// Responsibilities:
//   - Pick an Ollama model (queried from /api/agent/models).
//   - Take a test query.
//   - POST the active project + query to /api/agent/run, parse the SSE
//     stream, and update per-node status (idle | running | ok | error) live.
//   - Show warnings (parallel mode, model fallback, missing working folder).
//   - Surface the final brief and the run folder path.
//   - Cancel button aborts the in-flight fetch via AbortController.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Pass 8: per-project flag tracking whether the test panel has seen a
// completed run. While unset, we surface an example query above the textarea
// so first-time users have something concrete to try.
function firstRunSeenKey(projectId) {
  return `agent-studio:firstRunSeen:${projectId}`;
}

const STATUS_LABEL = {
  idle: "idle",
  running: "running",
  ok: "ok",
  error: "error",
};

function statusColor(status) {
  if (status === "running") return "var(--accent)";
  if (status === "ok") return "var(--eval, #1f7a1f)";
  if (status === "error") return "var(--danger, #b00020)";
  return "var(--faint)";
}

export default function TestPanel({ project, isOpen, onToggle, locked = false }) {
  const [models, setModels] = useState([]);
  const [modelsError, setModelsError] = useState(null);
  const [selectedModel, setSelectedModel] = useState("");
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState(false);
  const [warnings, setWarnings] = useState([]);
  const [statusById, setStatusById] = useState({});
  const [brief, setBrief] = useState("");
  const [runDir, setRunDir] = useState(null);
  const [error, setError] = useState(null);
  // Pass 8: first-run-seen flag, hydrated from localStorage on project change.
  // Determines whether to show the example-query hint above the textarea.
  const [firstRunSeen, setFirstRunSeen] = useState(true);
  const abortRef = useRef(null);
  // Pass 11: track whether THIS project has been auto-opened already in this
  // mount. Without this, every isOpen flip would re-trigger the auto-open
  // effect and we'd fight the user's explicit close.
  const autoOpenedForProjectRef = useRef(null);
  // Pass 11: track whether the current open run has been pre-filled. We seed
  // the query exactly once per first-run open so user edits aren't clobbered.
  const prefilledForProjectRef = useRef(null);

  // Hydrate first-run flag whenever the active project changes. Default to
  // "seen" for SSR to avoid hint flicker before localStorage is available.
  useEffect(() => {
    if (!project?.id) {
      setFirstRunSeen(true);
      return;
    }
    try {
      if (typeof window === "undefined") {
        setFirstRunSeen(true);
        return;
      }
      const seen = window.localStorage.getItem(firstRunSeenKey(project.id)) === "1";
      setFirstRunSeen(seen);
      // Reset per-project gates so a project switch can re-trigger auto-open
      // and pre-fill (subject to firstRunSeen still being false).
      autoOpenedForProjectRef.current = null;
      prefilledForProjectRef.current = null;
    } catch {
      setFirstRunSeen(true);
    }
  }, [project?.id]);

  // Pass 11: auto-open the panel on the very first visit to a project the
  // user hasn't run yet. Surfacing the panel collapsed-by-default left
  // first-time users staring at a graph with no obvious action; opening it
  // shows the model picker, the example-query hint, and the Run button at
  // once. We only do this once per project per mount: any explicit close
  // sets firstRunSeen, which short-circuits this effect on next render.
  useEffect(() => {
    if (!project?.id) return;
    if (firstRunSeen) return;
    if (isOpen) return;
    if (autoOpenedForProjectRef.current === project.id) return;
    autoOpenedForProjectRef.current = project.id;
    onToggle?.();
  }, [project?.id, firstRunSeen, isOpen, onToggle]);

  // Pass 11: pre-fill the textarea with a sensible example the first time
  // this project's panel opens. Use the project goal when present, otherwise
  // fall back to a graph-flavoured starter. We only seed if the textarea is
  // empty; we never overwrite a user edit.
  useEffect(() => {
    if (!project?.id) return;
    if (!isOpen) return;
    if (firstRunSeen) return;
    if (prefilledForProjectRef.current === project.id) return;
    prefilledForProjectRef.current = project.id;
    setQuery((current) => {
      if (current && current.trim().length > 0) return current;
      const goal = typeof project.goal === "string" ? project.goal.trim() : "";
      return goal || "What is the riskiest dependency in this graph?";
    });
  }, [project?.id, project?.goal, isOpen, firstRunSeen]);

  // Fetch model list once on mount and again every time the panel opens.
  // Keep this side-effect-free of project state so model availability stays
  // independent of project switching.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/agent/models");
        const body = await res.json();
        if (cancelled) return;
        if (body?.ok && Array.isArray(body.models)) {
          setModels(body.models);
          setModelsError(null);
          if (body.models.length > 0) {
            setSelectedModel((prev) => (prev && body.models.includes(prev) ? prev : body.models[0]));
          }
        } else {
          setModels([]);
          setModelsError(body?.error || "could not list models");
        }
      } catch (err) {
        if (cancelled) return;
        setModels([]);
        setModelsError(err?.message || "could not reach /api/agent/models");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const nodeRows = useMemo(() => {
    if (!project?.canvas?.nodes) return [];
    return project.canvas.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      role: n.role,
      status: statusById[n.id]?.status ?? "idle",
      durationMs: statusById[n.id]?.durationMs ?? null,
      bytes: statusById[n.id]?.bytes ?? null,
      error: statusById[n.id]?.error ?? null,
    }));
  }, [project, statusById]);

  function resetRunState() {
    setWarnings([]);
    setStatusById({});
    setBrief("");
    setRunDir(null);
    setError(null);
  }

  const handleEvent = useCallback((evt) => {
    if (!evt || typeof evt !== "object") return;
    if (evt.type === "warning") {
      setWarnings((arr) => [...arr, evt.text]);
      return;
    }
    if (evt.type === "warmup-fail") {
      setError(evt.error || "warmup failed");
      return;
    }
    if (evt.type === "node-start") {
      setStatusById((m) => ({ ...m, [evt.id]: { status: "running", bytes: 0 } }));
      return;
    }
    if (evt.type === "node-chunk") {
      setStatusById((m) => ({
        ...m,
        [evt.id]: { ...(m[evt.id] || { status: "running" }), bytes: evt.bytes },
      }));
      return;
    }
    if (evt.type === "node-end") {
      setStatusById((m) => ({
        ...m,
        [evt.id]: {
          status: "ok",
          durationMs: evt.durationMs,
          bytes: evt.bytes,
        },
      }));
      return;
    }
    if (evt.type === "node-error") {
      if (!evt.id) {
        setError(evt.error || "run error");
        return;
      }
      setStatusById((m) => ({
        ...m,
        [evt.id]: { status: "error", error: evt.error },
      }));
      return;
    }
    if (evt.type === "complete") {
      setBrief(evt.brief || "");
      setRunDir(evt.runDir || null);
      // Pass 8: persist first-run-seen as soon as the run completes. We hold
      // the project id at call time via `project?.id`. If the user navigates
      // mid-run we still record against the project that owned the run.
      if (project?.id) {
        try {
          if (typeof window !== "undefined") {
            window.localStorage.setItem(firstRunSeenKey(project.id), "1");
          }
        } catch {
          // ignore
        }
        setFirstRunSeen(true);
      }
      return;
    }
  }, [project?.id]);

  // Parse SSE text stream incrementally. We buffer between reads and split on
  // blank lines (the SSE event terminator). Each event payload is a single
  // `data: <json>` line in our protocol.
  async function consumeSSE(response) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const line = frame
          .split("\n")
          .find((l) => l.startsWith("data:"));
        if (!line) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try {
          handleEvent(JSON.parse(payload));
        } catch {
          /* malformed frame — skip */
        }
      }
    }
  }

  // Pass 11: persist firstRunSeen the moment the user commits to running. We
  // also already persist on `complete` (Pass 8 behavior); doing both means a
  // run that fails halfway still counts as "user has tried this project" and
  // suppresses the auto-open the next time they navigate back.
  function markFirstRunSeen() {
    if (!project?.id) return;
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(firstRunSeenKey(project.id), "1");
      }
    } catch {
      /* ignore */
    }
    setFirstRunSeen(true);
  }

  // Pass 11: wrap the toggle so an explicit user-driven close marks the
  // first-run flag. We never set the flag on open (the auto-open effect
  // does that path); only on close, which is the user opting out.
  function handleToggleClick() {
    if (isOpen) {
      // User is closing the panel — record intent.
      markFirstRunSeen();
    }
    onToggle?.();
  }

  async function startRun() {
    if (!project) return;
    if (running) return;
    markFirstRunSeen();
    resetRunState();
    setRunning(true);
    const ac = new AbortController();
    abortRef.current = ac;
    try {
      const res = await fetch("/api/agent/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ project, query, model: selectedModel || undefined }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        const detail = await res.text().catch(() => "");
        throw new Error(`run failed: ${res.status}${detail ? ` ${detail}` : ""}`);
      }
      await consumeSSE(res);
    } catch (err) {
      if (err?.name === "AbortError") {
        setError("run cancelled");
      } else {
        setError(err?.message || "run failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function cancelRun() {
    if (abortRef.current) {
      abortRef.current.abort();
    }
  }

  return (
    <div className={`test-panel ${isOpen ? "is-open" : ""}`} data-test-panel>
      <button
        type="button"
        className="test-panel-handle"
        onClick={handleToggleClick}
        data-test-panel-toggle
        aria-expanded={isOpen}
      >
        {isOpen ? "▼ test panel" : "▲ test panel"}
      </button>

      {isOpen && (
        <div className="test-panel-body">
          {!firstRunSeen && (
            <p className="tp-first-run-hint" data-test-panel-first-run-hint>
              Try: &ldquo;What&rsquo;s the riskiest dependency in this graph?&rdquo;
            </p>
          )}
          <div className="test-panel-controls">
            <label className="tp-field">
              <span className="tp-label">Model</span>
              <select
                className="tp-input tp-select"
                value={selectedModel}
                onChange={(e) => setSelectedModel(e.target.value)}
                disabled={running || models.length === 0}
                data-test-panel-model
              >
                {models.length === 0 && (
                  <option value="">{modelsError ? "ollama unreachable" : "no models pulled"}</option>
                )}
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label className="tp-field tp-field-grow">
              <span className="tp-label">Test query</span>
              <textarea
                className="tp-input tp-textarea"
                rows={2}
                value={query}
                placeholder="Try a query against this graph. e.g. 'Plan the Q3 launch.'"
                onChange={(e) => setQuery(e.target.value)}
                disabled={running}
                data-test-panel-query
              />
            </label>

            <div className="tp-actions">
              {!running ? (
                <button
                  type="button"
                  className="tool-btn tp-run"
                  onClick={startRun}
                  disabled={!project || models.length === 0 || locked}
                  title={locked ? "Project is completed (read-only)" : undefined}
                  data-test-panel-run
                >
                  Run
                </button>
              ) : (
                <button
                  type="button"
                  className="tool-btn tp-cancel"
                  onClick={cancelRun}
                  data-test-panel-cancel
                >
                  Cancel
                </button>
              )}
            </div>
          </div>

          {warnings.length > 0 && (
            <ul className="tp-warnings" data-test-panel-warnings>
              {warnings.map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          )}

          {error && (
            <div className="tp-error" data-test-panel-error>
              {error}
            </div>
          )}

          <ul className="tp-nodes" data-test-panel-nodes>
            {nodeRows.map((n) => (
              <li key={n.id} className="tp-node-row" data-node-id={n.id} data-status={n.status}>
                <span className="tp-node-status" style={{ color: statusColor(n.status) }}>
                  ●
                </span>
                <span className="tp-node-title">{n.title}</span>
                <span className="tp-node-role">{n.role}</span>
                <span className="tp-node-meta">
                  {n.status === "running" && n.bytes ? `${n.bytes}b…` : null}
                  {n.status === "ok" && n.durationMs != null
                    ? `${n.durationMs}ms · ${n.bytes ?? 0}b`
                    : null}
                  {n.status === "error" ? n.error : null}
                  {n.status === "idle" ? STATUS_LABEL.idle : null}
                </span>
              </li>
            ))}
          </ul>

          {(brief || runDir) && (
            <div className="tp-result" data-test-panel-result>
              <div className="tp-result-header">
                <span className="studio-eyebrow">Brief</span>
                {runDir && (
                  <button
                    type="button"
                    className="tool-btn tp-runfolder"
                    onClick={() => alert(`Run folder:\n${runDir}`)}
                    title={runDir}
                    data-test-panel-runfolder
                  >
                    Open run folder
                  </button>
                )}
              </div>
              {brief && <pre className="tp-brief" data-test-panel-brief>{brief}</pre>}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .test-panel {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          background: var(--surface);
          border-top: 1px solid var(--border);
          z-index: 6;
          max-height: 60vh;
          display: flex;
          flex-direction: column;
        }
        .test-panel-handle {
          align-self: center;
          margin-top: -14px;
          padding: 4px 14px;
          font-size: 11px;
          font-family: inherit;
          color: var(--muted);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 999px;
          cursor: pointer;
          letter-spacing: 0.04em;
        }
        .test-panel-handle:hover {
          color: var(--accent-strong);
          border-color: var(--accent);
        }
        .test-panel-body {
          padding: 12px 18px 14px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .tp-first-run-hint {
          margin: 0;
          padding: 6px 10px;
          font-size: 12px;
          color: var(--muted);
          background: var(--accent-soft);
          border: 1px solid var(--border);
          border-radius: 8px;
        }
        .test-panel-controls {
          display: flex;
          gap: 12px;
          align-items: flex-end;
          flex-wrap: wrap;
        }
        .tp-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 180px;
        }
        .tp-field-grow {
          flex: 1 1 320px;
        }
        .tp-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .tp-input {
          padding: 8px 10px;
          font-family: inherit;
          font-size: 13px;
          color: var(--ink);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          outline: none;
        }
        .tp-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .tp-textarea {
          resize: vertical;
          line-height: 1.4;
          min-height: 44px;
        }
        .tp-select {
          cursor: pointer;
        }
        .tp-actions {
          display: flex;
          gap: 8px;
        }
        .tp-run {
          color: var(--accent-strong);
          border-color: var(--accent);
        }
        .tp-cancel {
          color: var(--danger, #b00020);
          border-color: var(--danger, #b00020);
        }
        .tp-warnings {
          margin: 0;
          padding: 8px 10px;
          list-style: none;
          background: var(--policy-soft, #fff7e0);
          border: 1px solid var(--border);
          border-radius: 8px;
          font-size: 12px;
          color: var(--ink);
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .tp-error {
          padding: 8px 10px;
          background: var(--danger-soft, #fde7ea);
          border: 1px solid var(--danger, #b00020);
          border-radius: 8px;
          font-size: 12px;
          color: var(--danger, #b00020);
        }
        .tp-nodes {
          margin: 0;
          padding: 0;
          list-style: none;
          display: flex;
          flex-direction: column;
          gap: 2px;
          border: 1px solid var(--border);
          border-radius: 8px;
          overflow: hidden;
        }
        .tp-node-row {
          display: grid;
          grid-template-columns: 18px 1fr 90px 1fr;
          align-items: center;
          gap: 8px;
          padding: 6px 10px;
          font-size: 12px;
          background: var(--surface);
        }
        .tp-node-row + .tp-node-row {
          border-top: 1px solid var(--border);
        }
        .tp-node-status {
          font-size: 14px;
          line-height: 1;
        }
        .tp-node-title {
          font-weight: 500;
          color: var(--ink);
        }
        .tp-node-role {
          font-size: 10px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .tp-node-meta {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          color: var(--muted);
          text-align: right;
        }
        .tp-result {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .tp-result-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .tp-brief {
          margin: 0;
          padding: 10px 12px;
          background: var(--bg);
          border: 1px solid var(--border);
          border-radius: 8px;
          font-size: 12px;
          line-height: 1.5;
          white-space: pre-wrap;
          max-height: 240px;
          overflow: auto;
        }
      `}</style>
    </div>
  );
}
