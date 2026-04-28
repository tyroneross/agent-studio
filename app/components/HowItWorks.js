"use client";

// HowItWorks — three numbered steps shown on the empty-state landing page.
// Calm Precision: Gestalt grouping (single border around the trio, dividers
// between, no individual cards), hierarchy (number + title + 1-line
// description, no decorative chrome), signal-vs-noise (numbers carry meaning,
// not visual flourish).
export default function HowItWorks() {
  return (
    <ol className="hiw" data-how-it-works>
      <li className="hiw-step">
        <span className="hiw-num">1</span>
        <div className="hiw-text">
          <span className="hiw-title">Create a project</span>
          <span className="hiw-desc">Pick a working folder, jot the goal, drop reference files.</span>
        </div>
      </li>
      <li className="hiw-step">
        <span className="hiw-num">2</span>
        <div className="hiw-text">
          <span className="hiw-title">Build the graph</span>
          <span className="hiw-desc">Drag nodes, connect ports, edit instructions on the right.</span>
        </div>
      </li>
      <li className="hiw-step">
        <span className="hiw-num">3</span>
        <div className="hiw-text">
          <span className="hiw-title">Run a test query</span>
          <span className="hiw-desc">Pick a model, hit Run, read the brief and per-node output.</span>
        </div>
      </li>

      <style jsx>{`
        .hiw {
          margin: 0;
          padding: 0;
          list-style: none;
          border: 1px solid var(--border);
          border-radius: 12px;
          background: var(--surface);
          overflow: hidden;
        }
        .hiw-step {
          display: flex;
          align-items: center;
          gap: 14px;
          padding: 14px 18px;
        }
        .hiw-step + .hiw-step {
          border-top: 1px solid var(--border);
        }
        .hiw-num {
          flex-shrink: 0;
          width: 24px;
          height: 24px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px;
          font-weight: 600;
          color: var(--accent-strong);
          background: var(--accent-soft);
          border-radius: 50%;
        }
        .hiw-text {
          display: flex;
          flex-direction: column;
          gap: 2px;
          min-width: 0;
        }
        .hiw-title {
          font-size: 14px;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.3;
        }
        .hiw-desc {
          font-size: 13px;
          color: var(--muted);
          line-height: 1.4;
        }
      `}</style>
    </ol>
  );
}
