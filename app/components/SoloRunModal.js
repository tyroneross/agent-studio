"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadStorageConfig, TRUNCATION_MARKER_PREFIX } from "../lib/storage-config.mjs";

// Pass 14 — Solo Run modal.
//
// What it does
// - Pre-fills inputs from the node's saved fixture, falling back to
//   upstream runCache outputs (Q1 resolved: editable, no separate "pull"
//   button).
// - Renders one field per declared input when `node.inputs[]` is non-empty;
//   otherwise renders a single JSON textarea (the unfriendly fallback the
//   roadmap calls out).
// - Streams the response from POST /api/agent/run-node and shows a running
//   byte count + the parsed JSON output.
// - On `complete`, calls `onComplete(nodeId, runCacheEntry)` so the canvas
//   can fold the entry into its localStorage-backed `runCache`.
//
// What it does not do
// - It does not write to localStorage itself; the canvas owns persistence.
// - It does not mutate the project's canonical transcript; the runCache is
//   the only side effect of a solo run.
// - It does not currently support cancellation mid-stream beyond closing
//   the modal (Pass 15 will add explicit cancel + step controls).

function makeInitialValues(node, upstreamCache, edges) {
  // Priority: saved fixture inputs → upstream runCache aggregated by
  // upstream-node id → empty.
  if (node.fixture && node.fixture.inputs != null) {
    return { mode: "fields", values: cloneInputs(node.fixture.inputs, node) };
  }

  // Aggregate upstream-cache outputs into a fields/json starting point.
  const upstreamIds = (edges ?? [])
    .filter((e) => e.to === node.id)
    .map((e) => e.from);
  const aggregated = {};
  for (const upId of upstreamIds) {
    const cached = upstreamCache?.[upId];
    if (cached && cached.output != null) aggregated[upId] = cached.output;
  }

  if (Array.isArray(node.inputs) && node.inputs.length > 0) {
    // Map declared inputs to upstream output shape if names line up; otherwise
    // leave blank for the user.
    const values = {};
    for (const tag of node.inputs) values[tag] = aggregated[tag] ?? "";
    return { mode: "fields", values };
  }

  if (Object.keys(aggregated).length > 0) {
    return { mode: "json", values: aggregated };
  }
  return { mode: "json", values: {} };
}

function cloneInputs(inputs, node) {
  if (Array.isArray(node.inputs) && node.inputs.length > 0) {
    const out = {};
    for (const tag of node.inputs) {
      out[tag] = inputs?.[tag] ?? "";
    }
    return out;
  }
  return typeof inputs === "object" ? { ...inputs } : inputs;
}

export default function SoloRunModal({ project, node, onClose, onComplete }) {
  const upstreamCache = project?.runCache ?? {};
  const edges = project?.canvas?.edges ?? [];
  const initial = useMemo(
    () => makeInitialValues(node, upstreamCache, edges),
    [node, upstreamCache, edges],
  );

  const declaredInputs = Array.isArray(node.inputs) ? node.inputs : [];
  const useFields = declaredInputs.length > 0;

  const [fieldValues, setFieldValues] = useState(useFields ? initial.values : {});
  const [jsonText, setJsonText] = useState(
    useFields ? "" : JSON.stringify(initial.values ?? {}, null, 2),
  );
  const [jsonError, setJsonError] = useState("");
  const [running, setRunning] = useState(false);
  const [bytes, setBytes] = useState(0);
  const [output, setOutput] = useState(null);
  const [error, setError] = useState("");
  const [warnings, setWarnings] = useState([]);
  const abortRef = useRef(null);

  // Reset state if the modal opens against a different node.
  useEffect(() => {
    setFieldValues(useFields ? initial.values : {});
    setJsonText(useFields ? "" : JSON.stringify(initial.values ?? {}, null, 2));
    setJsonError("");
    setBytes(0);
    setOutput(null);
    setError("");
    setWarnings([]);
  }, [node.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Always release the in-flight reader if the modal unmounts mid-stream.
  useEffect(() => {
    return () => {
      try {
        abortRef.current?.abort();
      } catch {
        /* no-op */
      }
    };
  }, []);

  function readInputs() {
    if (useFields) return { ...fieldValues };
    if (!jsonText.trim()) return null;
    try {
      const parsed = JSON.parse(jsonText);
      setJsonError("");
      return parsed;
    } catch (err) {
      setJsonError(err.message || "invalid JSON");
      throw err;
    }
  }

  async function run() {
    let inputs;
    try {
      inputs = readInputs();
    } catch {
      return; // jsonError already set
    }

    setRunning(true);
    setBytes(0);
    setOutput(null);
    setError("");
    setWarnings([]);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      // Pass 14.6 — pass the user's storage-config so the server applies the
      // same byte cap when truncating cached outputs.
      const storageConfig = loadStorageConfig();
      const res = await fetch("/api/agent/run-node", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project,
          nodeId: node.id,
          inputs,
          storageConfig,
        }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) {
        throw new Error(`run-node returned ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        // SSE frames: "data: <json>\n\n"
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.startsWith("data:") ? frame.slice(5).trim() : frame.trim();
          if (!line) continue;
          let evt;
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          handleEvent(evt);
        }
      }
    } catch (err) {
      if (err?.name !== "AbortError") {
        setError(err?.message || "request failed");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleEvent(evt) {
    switch (evt.type) {
      case "warmup-fail":
        setError(evt.error || "ollama warmup failed");
        break;
      case "node-chunk":
        if (typeof evt.bytes === "number") setBytes(evt.bytes);
        break;
      case "node-end":
        setOutput(evt.parsed != null ? evt.parsed : evt.output);
        if (typeof evt.bytes === "number") setBytes(evt.bytes);
        break;
      case "node-error":
        setError(evt.error || "node failed");
        break;
      case "warning":
        setWarnings((w) => [...w, evt.text]);
        break;
      case "complete":
        if (evt.runCacheEntry) {
          onComplete?.(node.id, evt.runCacheEntry);
        }
        break;
      default:
        // ignore the rest (warmup, level-start, node-start, uploads-loaded)
        break;
    }
  }

  function close() {
    try {
      abortRef.current?.abort();
    } catch {
      /* no-op */
    }
    onClose?.();
  }

  return (
    <div className="solo-run-modal-backdrop" role="dialog" aria-modal="true" aria-label="Solo run">
      <div className="solo-run-modal">
        <header className="solo-run-modal-header">
          <div>
            <div className="studio-eyebrow">Solo run</div>
            <h2 className="solo-run-modal-title">{node.title}</h2>
          </div>
          <button className="tool-btn" type="button" onClick={close} aria-label="Close">
            ×
          </button>
        </header>

        <div className="solo-run-modal-body">
          <section className="solo-run-section">
            <div className="solo-run-section-label">Inputs</div>
            {useFields ? (
              <div className="solo-run-fields">
                {declaredInputs.map((tag) => (
                  <label key={tag} className="solo-run-field">
                    <span className="solo-run-field-label">{tag}</span>
                    <textarea
                      className="solo-run-field-input"
                      rows={3}
                      value={
                        typeof fieldValues[tag] === "string"
                          ? fieldValues[tag]
                          : JSON.stringify(fieldValues[tag] ?? "", null, 2)
                      }
                      onChange={(e) =>
                        setFieldValues((v) => ({ ...v, [tag]: e.target.value }))
                      }
                      placeholder={`value for ${tag}`}
                    />
                  </label>
                ))}
              </div>
            ) : (
              <>
                <textarea
                  className="solo-run-json"
                  rows={8}
                  value={jsonText}
                  onChange={(e) => {
                    setJsonText(e.target.value);
                    setJsonError("");
                  }}
                  placeholder="JSON inputs (this node has no declared input tags)"
                />
                {jsonError && <div className="solo-run-error">JSON: {jsonError}</div>}
              </>
            )}
            <p className="solo-run-hint">
              Inputs pre-fill from this node&apos;s saved fixture, then from upstream cached
              outputs. Edit them freely — solo run never touches the project transcript.
            </p>
          </section>

          {(running || bytes > 0 || output != null || error) && (
            <section className="solo-run-section">
              <div className="solo-run-section-label">
                Output {running ? "(streaming…)" : ""}
              </div>
              {bytes > 0 && (
                <div className="solo-run-meta">{bytes.toLocaleString()} bytes</div>
              )}
              {output != null && (
                <>
                  <pre className="solo-run-output">
                    {typeof output === "string" ? output : JSON.stringify(output, null, 2)}
                  </pre>
                  {typeof output === "string" && output.includes(TRUNCATION_MARKER_PREFIX) && (
                    <p className="solo-run-hint" data-solo-run-truncated>
                      Output exceeded the cache size cap. The full payload was written to the
                      project working folder; see the marker above for the path.
                    </p>
                  )}
                </>
              )}
              {error && <div className="solo-run-error">{error}</div>}
              {warnings.length > 0 && (
                <ul className="solo-run-warnings">
                  {warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>

        <footer className="solo-run-modal-footer">
          <button className="tool-btn" type="button" onClick={close} disabled={running}>
            Close
          </button>
          <button
            className="tool-btn solo-run-go"
            type="button"
            onClick={run}
            disabled={running}
          >
            {running ? "Running…" : "Run"}
          </button>
        </footer>
      </div>

      <style jsx>{`
        .solo-run-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(31, 37, 32, 0.4);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 50;
          padding: 24px;
        }
        .solo-run-modal {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          width: min(620px, 100%);
          max-height: calc(100vh - 48px);
          display: flex;
          flex-direction: column;
          box-shadow: var(--shadow-lift);
          overflow: hidden;
        }
        .solo-run-modal-header {
          padding: 16px 20px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border);
        }
        .solo-run-modal-title {
          margin: 4px 0 0 0;
          font-size: 18px;
          font-weight: 600;
        }
        .solo-run-modal-body {
          padding: 16px 20px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 18px;
        }
        .solo-run-section {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .solo-run-section-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .solo-run-fields {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .solo-run-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .solo-run-field-label {
          font-size: 12px;
          color: var(--muted);
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
        }
        .solo-run-field-input,
        .solo-run-json,
        .solo-run-output {
          width: 100%;
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px;
          padding: 8px 10px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--surface-muted);
          color: var(--ink);
          resize: vertical;
          line-height: 1.4;
        }
        .solo-run-output {
          white-space: pre-wrap;
          word-break: break-word;
          max-height: 320px;
          overflow: auto;
          margin: 0;
        }
        .solo-run-hint {
          font-size: 12px;
          color: var(--muted);
          margin: 0;
        }
        .solo-run-meta {
          font-size: 12px;
          color: var(--muted);
        }
        .solo-run-error {
          font-size: 12px;
          color: var(--danger);
          background: var(--danger-soft);
          padding: 6px 10px;
          border-radius: 6px;
        }
        .solo-run-warnings {
          font-size: 12px;
          color: var(--muted);
          margin: 4px 0 0 0;
          padding-left: 18px;
        }
        .solo-run-modal-footer {
          padding: 12px 20px;
          border-top: 1px solid var(--border);
          display: flex;
          justify-content: flex-end;
          gap: 8px;
        }
        .solo-run-go {
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          font-weight: 600;
        }
        .solo-run-go:hover:not(:disabled) {
          background: var(--accent-strong);
        }
      `}</style>
    </div>
  );
}
