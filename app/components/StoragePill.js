"use client";

// Pass 14.6 — toolbar storage pill.
//
// What it does
// - Reads `navigator.storage.estimate()` via storage-config.getStorageEstimate
//   (cached 30s).
// - Classifies usage against the user's `warnLevel` / `blockLevel` config and
//   renders one of three plain-language states: "Plenty of room", "Getting
//   full — ~N saves left", "Almost out — manage storage". Falls back to
//   "Storage status unknown" when the API is unsupported.
// - Click opens the StoragePanel slide-over (parent owns the open state).
//
// What it does not do
// - It doesn't compute "saves left" without an explicit per-save estimate.
//   The parent passes `bytesPerRecentSave` (median of the active project's
//   recent snapshot bytes) so the estimate stays grounded; the pill falls
//   back to "saves left: a few" when the parent passes 0.

import { useEffect, useState } from "react";
import {
  classifyUsage,
  estimateSavesLeft,
  getStorageEstimate,
  loadStorageConfig,
} from "../lib/storage-config.mjs";

export default function StoragePill({ onOpen, bytesPerRecentSave = 0, refreshKey = 0 }) {
  const [estimate, setEstimate] = useState({
    state: "unknown",
    percent: null,
    freeBytes: null,
  });

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const raw = await getStorageEstimate({ force: refreshKey > 0 });
      if (cancelled) return;
      const cfg = loadStorageConfig();
      const classified = classifyUsage(raw, cfg);
      setEstimate(classified);
    }
    refresh();
    // Refresh every 30s so a long-running session reflects accumulated
    // writes without a hard reload.
    const id = setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [refreshKey]);

  const { state, freeBytes } = estimate;
  let label = "Storage";
  let savesLine = null;
  let dotClass = "dot-unknown";

  if (state === "ok") {
    label = "Plenty of room";
    dotClass = "dot-ok";
  } else if (state === "warn") {
    label = "Getting full";
    dotClass = "dot-warn";
    const left = estimateSavesLeft(freeBytes, bytesPerRecentSave);
    if (left != null) savesLine = `~${left} save${left === 1 ? "" : "s"} left`;
    else savesLine = "a few saves left";
  } else if (state === "block") {
    label = "Almost out — manage storage";
    dotClass = "dot-block";
  } else {
    label = "Storage: unknown";
    dotClass = "dot-unknown";
  }

  return (
    <button
      className="storage-pill"
      type="button"
      onClick={onOpen}
      data-storage-pill
      data-storage-state={state}
      title="Open storage panel"
      aria-label={`Storage: ${label}`}
    >
      <span className={`storage-dot ${dotClass}`} aria-hidden="true" />
      <span className="storage-label">{label}</span>
      {savesLine && <span className="storage-extra">{savesLine}</span>}

      <style jsx>{`
        .storage-pill {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid var(--border);
          background: var(--surface);
          color: var(--ink);
          font-size: 12px;
          cursor: pointer;
          font-weight: 500;
          line-height: 1.2;
        }
        .storage-pill:hover {
          border-color: var(--accent);
        }
        .storage-pill[data-storage-state="block"] {
          border-color: var(--danger);
        }
        .storage-pill[data-storage-state="warn"] {
          border-color: var(--warn, #d99a3b);
        }
        .storage-dot {
          display: inline-block;
          width: 8px;
          height: 8px;
          border-radius: 50%;
        }
        .dot-ok {
          background: #2c8a4a;
        }
        .dot-warn {
          background: #d99a3b;
        }
        .dot-block {
          background: var(--danger, #c0392b);
        }
        .dot-unknown {
          background: var(--muted, #98a39c);
        }
        .storage-label {
          color: var(--ink);
        }
        .storage-extra {
          color: var(--muted);
          font-weight: 400;
        }
      `}</style>
    </button>
  );
}
