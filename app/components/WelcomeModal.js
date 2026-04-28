"use client";

import { useEffect, useRef } from "react";

// WelcomeModal — first-run modal shown once per browser on the canvas page.
// Pass 8.
//
// Calm Precision rules applied:
//   - Plain layout, no animation flourish, no shadow drama.
//   - Single border around the whole dialog (not per-hint).
//   - Hints separated by horizontal dividers, not boxes.
//   - One primary action ("Got it"). The dismiss flag persists; the toolbar's
//     `?` button can re-trigger this dialog.
//
// Props:
//   - open: boolean
//   - onDismiss: () => void  (parent persists the localStorage flag)
//
// We intentionally don't use a native <dialog> element here because we want
// custom backdrop styling that matches existing CSS-vars and we don't need
// the focus-trap semantics for v1.
export default function WelcomeModal({ open, onDismiss }) {
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === "Escape") onDismiss();
    }
    window.addEventListener("keydown", onKey);
    // Auto-focus the primary action so Enter dismisses.
    buttonRef.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div className="welcome-overlay" data-welcome-modal role="presentation">
      <div
        className="welcome"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        data-welcome-dialog
      >
        <h2 id="welcome-title" className="welcome-title">
          Welcome to Agent Studio
        </h2>
        <p className="welcome-body">
          This canvas runs locally against your Ollama models. Sketch the graph, drop in
          context, and run a test query. Three gestures cover the core flow.
        </p>

        <ul className="welcome-hints">
          <li>
            <span className="welcome-hint-label">Drag a node</span>
            <span className="welcome-hint-detail">to move it on the canvas.</span>
          </li>
          <li>
            <span className="welcome-hint-label">Drag from a port</span>
            <span className="welcome-hint-detail">on the right edge of a node to connect to another.</span>
          </li>
          <li>
            <span className="welcome-hint-label">Click a node</span>
            <span className="welcome-hint-detail">to edit its title, role, and instructions in the right panel.</span>
          </li>
        </ul>

        <div className="welcome-actions">
          <button
            ref={buttonRef}
            type="button"
            className="welcome-cta"
            onClick={onDismiss}
            data-welcome-dismiss
          >
            Got it
          </button>
        </div>
      </div>

      <style jsx>{`
        .welcome-overlay {
          position: fixed;
          inset: 0;
          background: rgba(31, 37, 32, 0.32);
          display: flex;
          align-items: center;
          justify-content: center;
          z-index: 50;
          padding: 24px;
        }
        .welcome {
          width: 100%;
          max-width: 460px;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 22px 22px 18px;
          color: var(--ink);
        }
        .welcome-title {
          margin: 0 0 8px;
          font-size: 18px;
          font-weight: 600;
        }
        .welcome-body {
          margin: 0 0 16px;
          font-size: 13px;
          line-height: 1.5;
          color: var(--muted);
        }
        .welcome-hints {
          margin: 0 0 18px;
          padding: 0;
          list-style: none;
          border: 1px solid var(--border);
          border-radius: 10px;
          overflow: hidden;
        }
        .welcome-hints li {
          padding: 10px 14px;
          font-size: 13px;
          line-height: 1.4;
          display: flex;
          flex-direction: column;
          gap: 1px;
        }
        .welcome-hints li + li {
          border-top: 1px solid var(--border);
        }
        .welcome-hint-label {
          font-weight: 600;
          color: var(--ink);
        }
        .welcome-hint-detail {
          color: var(--muted);
        }
        .welcome-actions {
          display: flex;
          justify-content: flex-end;
        }
        .welcome-cta {
          font-family: inherit;
          font-size: 13px;
          font-weight: 600;
          height: 36px;
          padding: 0 18px;
          border-radius: 8px;
          border: 1px solid var(--accent);
          background: var(--accent);
          color: #ffffff;
          cursor: pointer;
        }
        .welcome-cta:hover {
          background: var(--accent-strong);
          border-color: var(--accent-strong);
        }
        .welcome-cta:focus-visible {
          outline: 2px solid var(--accent-strong);
          outline-offset: 2px;
        }
      `}</style>
    </div>
  );
}
