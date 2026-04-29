"use client";

// Pass 14.6 — storage slide-over panel.
//
// Three sections per the design doc:
//   1. Status — plain language, no percent symbol unless the user toggles
//      "show numbers".
//   2. What's using space — table of projects with bytes / snapshots / cache
//      counts. Per-row "trim run cache" + "delete oldest snapshots" actions.
//   3. Settings — every field in DEFAULT_STORAGE_CONFIG, with helper text and
//      a per-field "reset to default" link.
//
// Bytes are summarized via storage-config helpers; the panel never inlines a
// magic number itself. Mutations to the active store flow through the
// callbacks (onTrimRunCache, onDeleteOldestSnapshots) so the canvas page
// owns the writeStore + state-update side effects in one place.

import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_STORAGE_CONFIG,
  NUMERIC_CONFIG_FIELDS,
  BOOLEAN_CONFIG_FIELDS,
  approxOutputBytes,
  approxProjectBytes,
  approxSnapshotBytes,
  classifyUsage,
  formatBytesPlain,
  getStorageEstimate,
  loadStorageConfig,
  resetStorageConfigField,
  writeStorageConfig,
} from "../lib/storage-config.mjs";

const FIELD_LABELS = {
  warnLevel: {
    label: "Warn at",
    unit: "% full",
    help: "Storage pill turns amber once usage reaches this percent.",
  },
  blockLevel: {
    label: "Block at",
    unit: "% full",
    help: "Save preflight intercepts saves once projected usage reaches this percent.",
  },
  runCacheBytesPerEntry: {
    label: "Cache size cap per node",
    unit: "bytes",
    help: "Cached solo-run output truncated above this size; full transcript saved to disk.",
  },
  runCacheEntriesPerNode: {
    label: "Cached runs per node",
    unit: "entries",
    help: "How many recent solo runs to keep per node. Default 1.",
  },
  snapshotsPerProject: {
    label: "Snapshots per project",
    unit: "snapshots",
    help: "Older snapshots dropped silently above this cap.",
  },
  autoSnapshotWhenLow: {
    label: "Auto-snapshot when storage is low",
    help: "When off, the auto-snapshot before restore/reopen is skipped at block level (with a one-time toast).",
  },
};

function bytesPerProjectRow(project) {
  const projectBytes = approxProjectBytes(project);
  const snapshotBytes = (project.snapshots ?? []).reduce(
    (acc, s) => acc + approxSnapshotBytes(s),
    0,
  );
  const cacheEntries = Object.values(project.runCache ?? {});
  const cacheBytes = cacheEntries.reduce(
    (acc, e) => acc + approxOutputBytes(e?.output),
    0,
  );
  return {
    projectBytes,
    snapshotBytes,
    snapshotCount: (project.snapshots ?? []).length,
    cacheBytes,
    cacheCount: cacheEntries.length,
  };
}

export default function StoragePanel({
  open,
  onClose,
  store,
  onTrimRunCache,
  onDeleteOldestSnapshots,
  onConfigChanged,
}) {
  const [estimate, setEstimate] = useState(null);
  const [showNumbers, setShowNumbers] = useState(false);
  const [config, setConfig] = useState(() => loadStorageConfig());

  useEffect(() => {
    let cancelled = false;
    if (!open) return undefined;
    async function refresh() {
      const raw = await getStorageEstimate({ force: true });
      if (cancelled) return;
      setEstimate(raw);
    }
    refresh();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reload the config when the panel opens so a value bumped programmatically
  // elsewhere is reflected. Saving from the panel updates state in-place.
  useEffect(() => {
    if (open) setConfig(loadStorageConfig());
  }, [open]);

  const classification = useMemo(() => classifyUsage(estimate, config), [estimate, config]);

  const projectRows = useMemo(() => {
    const projects = store?.projects ?? [];
    return projects
      .map((p) => ({ project: p, ...bytesPerProjectRow(p) }))
      .sort((a, b) => b.snapshotBytes + b.cacheBytes - (a.snapshotBytes + a.cacheBytes));
  }, [store]);

  if (!open) return null;

  const statusText = renderStatusLine(classification, showNumbers);

  function commitField(field, rawValue) {
    const next = { ...config };
    if (BOOLEAN_CONFIG_FIELDS.includes(field)) {
      next[field] = !!rawValue;
    } else if (NUMERIC_CONFIG_FIELDS.includes(field)) {
      const parsed = Number(rawValue);
      if (!Number.isFinite(parsed)) return; // ignore garbage; keep last valid value
      next[field] = parsed;
    } else {
      return;
    }
    setConfig(next);
    writeStorageConfig(next);
    onConfigChanged?.();
  }

  function resetField(field) {
    const next = resetStorageConfigField(field);
    setConfig(next);
    onConfigChanged?.();
  }

  return (
    <aside
      className="storage-panel"
      role="dialog"
      aria-modal="true"
      aria-label="Storage"
      data-storage-panel
    >
      <div className="storage-backdrop" onClick={onClose} />
      <div className="storage-sheet">
        <header className="storage-header">
          <h2>Storage</h2>
          <button
            type="button"
            className="tool-btn"
            onClick={onClose}
            aria-label="Close storage panel"
          >
            ×
          </button>
        </header>

        <section className="storage-section">
          <div className="section-label">Status</div>
          <p className="status-line" data-storage-status>
            {statusText}
          </p>
          <label className="show-numbers">
            <input
              type="checkbox"
              checked={showNumbers}
              onChange={(e) => setShowNumbers(e.target.checked)}
            />
            <span>Show numbers</span>
          </label>
          {showNumbers && classification.percent != null && (
            <p className="status-numbers">
              {classification.percent.toFixed(1)}% used —{" "}
              {formatBytesPlain(classification.usedBytes)} of{" "}
              {formatBytesPlain(classification.totalBytes)} total —{" "}
              {formatBytesPlain(classification.freeBytes)} free
            </p>
          )}
        </section>

        <section className="storage-section">
          <div className="section-label">What&apos;s using space</div>
          {projectRows.length === 0 ? (
            <p className="muted">No projects yet.</p>
          ) : (
            <table className="storage-table" data-storage-projects>
              <thead>
                <tr>
                  <th>Project</th>
                  <th>Size</th>
                  <th>Snapshots</th>
                  <th>Cache</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {projectRows.map(({ project, projectBytes, snapshotBytes, snapshotCount, cacheBytes, cacheCount }) => (
                  <tr key={project.id}>
                    <td>{project.name || project.id}</td>
                    <td>{formatBytesPlain(projectBytes)}</td>
                    <td>
                      {snapshotCount} ({formatBytesPlain(snapshotBytes)})
                    </td>
                    <td>
                      {cacheCount} ({formatBytesPlain(cacheBytes)})
                    </td>
                    <td className="actions-cell">
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => onTrimRunCache?.(project.id)}
                        disabled={cacheCount === 0}
                        title="Clear all cached solo-run outputs for this project"
                      >
                        trim cache
                      </button>
                      <button
                        type="button"
                        className="text-action"
                        onClick={() => onDeleteOldestSnapshots?.(project.id, 1)}
                        disabled={snapshotCount === 0}
                        title="Delete the oldest snapshot for this project"
                      >
                        delete oldest snapshot
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="storage-section">
          <div className="section-label">Settings</div>
          <p className="muted setting-intro">
            Every limit below lives in <code>app/lib/storage-config.mjs</code>.
            Changes save immediately to your browser profile.
          </p>
          <div className="settings-grid">
            {NUMERIC_CONFIG_FIELDS.map((field) => {
              const meta = FIELD_LABELS[field];
              return (
                <label key={field} className="setting-row">
                  <span className="setting-label">
                    {meta?.label || field}
                    {meta?.unit && <span className="setting-unit"> ({meta.unit})</span>}
                  </span>
                  <span className="setting-input-row">
                    <input
                      type="number"
                      min={1}
                      value={config[field]}
                      onChange={(e) => commitField(field, e.target.value)}
                      data-storage-setting={field}
                    />
                    {config[field] !== DEFAULT_STORAGE_CONFIG[field] && (
                      <button
                        type="button"
                        className="text-action small"
                        onClick={() => resetField(field)}
                      >
                        reset to default
                      </button>
                    )}
                  </span>
                  {meta?.help && <span className="setting-help">{meta.help}</span>}
                </label>
              );
            })}
            {BOOLEAN_CONFIG_FIELDS.map((field) => {
              const meta = FIELD_LABELS[field];
              return (
                <label key={field} className="setting-row checkbox-row">
                  <span className="setting-label">{meta?.label || field}</span>
                  <span className="setting-input-row">
                    <input
                      type="checkbox"
                      checked={!!config[field]}
                      onChange={(e) => commitField(field, e.target.checked)}
                      data-storage-setting={field}
                    />
                    {config[field] !== DEFAULT_STORAGE_CONFIG[field] && (
                      <button
                        type="button"
                        className="text-action small"
                        onClick={() => resetField(field)}
                      >
                        reset to default
                      </button>
                    )}
                  </span>
                  {meta?.help && <span className="setting-help">{meta.help}</span>}
                </label>
              );
            })}
          </div>
        </section>
      </div>

      <style jsx>{`
        .storage-panel {
          position: fixed;
          inset: 0;
          z-index: 60;
          display: flex;
          justify-content: flex-end;
        }
        .storage-backdrop {
          position: absolute;
          inset: 0;
          background: rgba(31, 37, 32, 0.4);
        }
        .storage-sheet {
          position: relative;
          width: min(440px, 100%);
          height: 100%;
          background: var(--surface);
          border-left: 1px solid var(--border);
          box-shadow: var(--shadow-lift);
          display: flex;
          flex-direction: column;
          overflow-y: auto;
        }
        .storage-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
        }
        .storage-header h2 {
          margin: 0;
          font-size: 16px;
          font-weight: 600;
        }
        .storage-section {
          padding: 16px 20px;
          border-bottom: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .section-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .status-line {
          margin: 0;
          font-size: 14px;
        }
        .status-numbers {
          margin: 0;
          font-size: 12px;
          color: var(--muted);
        }
        .show-numbers {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12px;
          color: var(--muted);
        }
        .storage-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12px;
        }
        .storage-table th,
        .storage-table td {
          text-align: left;
          padding: 6px 4px;
          border-bottom: 1px solid var(--border);
          vertical-align: top;
        }
        .actions-cell {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .text-action {
          background: none;
          border: none;
          color: var(--accent);
          padding: 0;
          font-size: 12px;
          cursor: pointer;
          text-align: left;
        }
        .text-action.small {
          font-size: 11px;
          color: var(--muted);
        }
        .text-action:hover:not(:disabled) {
          text-decoration: underline;
        }
        .text-action:disabled {
          color: var(--muted);
          cursor: not-allowed;
        }
        .settings-grid {
          display: flex;
          flex-direction: column;
          gap: 14px;
        }
        .setting-row {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .setting-label {
          font-size: 13px;
          font-weight: 500;
        }
        .setting-unit {
          font-weight: 400;
          color: var(--muted);
          font-size: 12px;
        }
        .setting-input-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .setting-input-row input[type="number"] {
          width: 110px;
          padding: 4px 8px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--surface-muted);
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px;
        }
        .setting-help {
          font-size: 11px;
          color: var(--muted);
        }
        .setting-intro {
          margin: 0 0 4px 0;
        }
        .checkbox-row .setting-input-row {
          align-items: center;
        }
        .muted {
          color: var(--muted);
          font-size: 12px;
          margin: 0;
        }
      `}</style>
    </aside>
  );
}

function renderStatusLine(classification, showNumbers) {
  if (classification.state === "unknown") {
    return "Storage status is unavailable on this browser.";
  }
  const used = formatBytesPlain(classification.usedBytes);
  const total = formatBytesPlain(classification.totalBytes);
  if (showNumbers) {
    return `${used} of about ${total} used — ${classification.percent.toFixed(1)}% full.`;
  }
  if (classification.state === "ok") {
    return `Plenty of room. You've used ${used} of about ${total}.`;
  }
  if (classification.state === "warn") {
    return `Getting full. You've used ${used} of about ${total} — consider trimming snapshots or cache.`;
  }
  return `Almost out of space. You've used ${used} of about ${total} — manage storage to keep saving.`;
}
