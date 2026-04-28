"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const ROLE_COLORS = {
  agent: { soft: "var(--accent-soft)", border: "var(--accent)" },
  guardrail: { soft: "var(--policy-soft)", border: "var(--policy)" },
  orchestrator: { soft: "var(--accent-soft)", border: "var(--accent)" },
  executor: { soft: "var(--tool-soft)", border: "var(--tool)" },
  eval: { soft: "var(--eval-soft)", border: "var(--eval)" },
  memory: { soft: "var(--memory-soft)", border: "var(--memory)" },
};

const SEED_NODES = [
  {
    id: "intake",
    role: "agent",
    title: "Intake",
    description: "Normalize the user goal and identify missing inputs before routing.",
    x: 120,
    y: 200,
    w: 220,
    h: 130,
  },
  {
    id: "policy",
    role: "guardrail",
    title: "Policy gate",
    description: "Classify read, write, network, shell, and credential intent against permissions.",
    x: 400,
    y: 200,
    w: 220,
    h: 130,
  },
  {
    id: "orch",
    role: "orchestrator",
    title: "Orchestrator",
    description: "Choose the next action from the active tool pool.",
    x: 680,
    y: 200,
    w: 220,
    h: 130,
  },
  {
    id: "exec",
    role: "executor",
    title: "Executor",
    description: "Run approved reads or writes and return structured results.",
    x: 680,
    y: 380,
    w: 220,
    h: 130,
  },
  {
    id: "evalCheck",
    role: "eval",
    title: "Eval check",
    description: "Check output, permissions, and guardrail invariants.",
    x: 960,
    y: 290,
    w: 220,
    h: 130,
  },
];

const SEED_EDGES = [
  { id: "intake->policy", from: "intake", to: "policy" },
  { id: "policy->orch", from: "policy", to: "orch" },
  { id: "orch->exec", from: "orch", to: "exec" },
  { id: "exec->evalCheck", from: "exec", to: "evalCheck" },
  { id: "orch->evalCheck", from: "orch", to: "evalCheck" },
];

function edgeId(from, to) {
  return `${from}->${to}`;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;

// Persistence: bump STORAGE_VERSION (and the key suffix) when the persisted shape changes.
const STORAGE_KEY = "agent-studio:v1";
const STORAGE_VERSION = 1;
const PERSIST_DEBOUNCE_MS = 350;

function readPersistedState() {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) return null;
    const { nodes, edges, pan, zoom } = parsed;
    if (!Array.isArray(nodes) || !Array.isArray(edges)) return null;
    if (!pan || typeof pan.x !== "number" || typeof pan.y !== "number") return null;
    if (typeof zoom !== "number" || !Number.isFinite(zoom)) return null;
    return { nodes, edges, pan, zoom };
  } catch (err) {
    console.warn("[agent-studio] failed to read persisted state, falling back to seeds:", err);
    return null;
  }
}

function writePersistedState(payload) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: STORAGE_VERSION, ...payload }),
    );
  } catch (err) {
    console.warn("[agent-studio] failed to persist state:", err);
  }
}

function clearPersistedState() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn("[agent-studio] failed to clear persisted state:", err);
  }
}

export default function StudioCanvas() {
  const [nodes, setNodes] = useState(SEED_NODES);
  const [edges, setEdges] = useState(SEED_EDGES);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [expandedId, setExpandedId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  // Active connection drag state, kept in React state so the ghost path re-renders.
  // Shape: { fromId: string, ghost: { x, y } } (canvas-space) | null
  const [connect, setConnect] = useState(null);

  const containerRef = useRef(null);
  const dragState = useRef(null); // { type: "pan" | "node" | "connect", nodeId?, startX, startY, startPan, startNode, moved, fromId? }
  // Persistence guards: hasHydratedRef gates auto-save until the load-from-storage pass has run,
  // so we never overwrite saved state with seed state on first paint.
  const hasHydratedRef = useRef(false);
  const persistTimerRef = useRef(null);

  const screenToCanvas = useCallback(
    (sx, sy) => {
      const rect = containerRef.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return {
        x: (sx - rect.left - pan.x) / zoom,
        y: (sy - rect.top - pan.y) / zoom,
      };
    },
    [pan, zoom],
  );

  function onCanvasPointerDown(e) {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest("[data-port]")) return; // handled by port pointerdown
    if (target.closest("[data-edge-hit]")) return; // handled by edge pointerdown
    if (target.closest("[data-node]")) return;
    dragState.current = {
      type: "pan",
      startX: e.clientX,
      startY: e.clientY,
      startPan: { ...pan },
      moved: false,
    };
    setSelectedId(null);
    setSelectedEdgeId(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPortPointerDown(e, node, side) {
    if (e.button !== 0) return;
    e.stopPropagation();
    // Out-port starts a connection. In-port is drop-target only.
    if (side !== "out") return;
    const startCanvas = {
      x: node.x + node.w,
      y: node.y + node.h / 2,
    };
    dragState.current = {
      type: "connect",
      fromId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      moved: false,
    };
    setConnect({ fromId: node.id, ghost: startCanvas });
    setSelectedId(null);
    setSelectedEdgeId(null);
    // Capture on the canvas so we keep getting moves outside the port circle.
    const canvasEl = containerRef.current;
    if (canvasEl) {
      try {
        canvasEl.setPointerCapture(e.pointerId);
      } catch {}
    }
  }

  function onNodePointerDown(e, node) {
    if (e.button !== 0) return;
    e.stopPropagation();
    dragState.current = {
      type: "node",
      nodeId: node.id,
      startX: e.clientX,
      startY: e.clientY,
      startNode: { x: node.x, y: node.y },
      moved: false,
    };
    setSelectedId(node.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    const ds = dragState.current;
    if (!ds) return;
    const dx = e.clientX - ds.startX;
    const dy = e.clientY - ds.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) ds.moved = true;
    if (ds.type === "pan") {
      setPan({ x: ds.startPan.x + dx, y: ds.startPan.y + dy });
    } else if (ds.type === "node") {
      const nx = ds.startNode.x + dx / zoom;
      const ny = ds.startNode.y + dy / zoom;
      setNodes((arr) => arr.map((n) => (n.id === ds.nodeId ? { ...n, x: nx, y: ny } : n)));
    } else if (ds.type === "connect") {
      const canvasPt = screenToCanvas(e.clientX, e.clientY);
      setConnect((c) => (c ? { ...c, ghost: canvasPt } : c));
    }
  }

  function onPointerUp(e) {
    const ds = dragState.current;
    if (!ds) {
      // Defensive: clear stale connect state if drag ref was lost.
      if (connect) setConnect(null);
      return;
    }
    if (ds.type === "node" && !ds.moved) {
      setExpandedId((id) => (id === ds.nodeId ? null : ds.nodeId));
    } else if (ds.type === "connect") {
      // Resolve drop target by hit-testing the element under the cursor.
      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      const portEl = targetEl?.closest?.("[data-port]");
      if (portEl) {
        const side = portEl.getAttribute("data-port");
        const toId = portEl.getAttribute("data-node-id");
        if (side === "in" && toId && toId !== ds.fromId) {
          setEdges((arr) => {
            // Dedupe: don't add an edge that already exists in this direction.
            if (arr.some((edge) => edge.from === ds.fromId && edge.to === toId)) {
              return arr;
            }
            return [...arr, { id: edgeId(ds.fromId, toId), from: ds.fromId, to: toId }];
          });
        }
      }
      setConnect(null);
    }
    dragState.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }

  function onWheel(e) {
    if (!containerRef.current) return;
    e.preventDefault();
    const rect = containerRef.current.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom * factor));
    if (nextZoom === zoom) return;
    // Anchor zoom at cursor: keep the same canvas point under the pointer.
    const canvasX = (cx - pan.x) / zoom;
    const canvasY = (cy - pan.y) / zoom;
    const newPanX = cx - canvasX * nextZoom;
    const newPanY = cy - canvasY * nextZoom;
    setZoom(nextZoom);
    setPan({ x: newPanX, y: newPanY });
  }

  // Native non-passive wheel listener so preventDefault is allowed on the canvas.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e) => onWheel(e);
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [pan, zoom]);

  function resetView() {
    setPan({ x: 0, y: 0 });
    setZoom(1);
  }

  function fitView() {
    if (!containerRef.current || nodes.length === 0) return;
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + n.w));
    const maxY = Math.max(...nodes.map((n) => n.y + n.h));
    const rect = containerRef.current.getBoundingClientRect();
    const padding = 60;
    const z = Math.min(
      (rect.width - padding * 2) / (maxX - minX),
      (rect.height - padding * 2) / (maxY - minY),
      1.5,
    );
    const newZoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    setZoom(newZoom);
    setPan({
      x: rect.width / 2 - cx * newZoom,
      y: rect.height / 2 - cy * newZoom,
    });
  }

  function addNode() {
    const id = `node-${Date.now()}`;
    const center = containerRef.current
      ? screenToCanvas(
          containerRef.current.getBoundingClientRect().width / 2,
          containerRef.current.getBoundingClientRect().height / 2,
        )
      : { x: 200, y: 200 };
    setNodes((arr) => [
      ...arr,
      {
        id,
        role: "agent",
        title: "New node",
        description: "Describe what this node does.",
        x: center.x - 110,
        y: center.y - 60,
        w: 220,
        h: 130,
      },
    ]);
    setSelectedId(id);
  }

  function deleteSelected() {
    if (selectedEdgeId) {
      setEdges((arr) => arr.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      return;
    }
    if (!selectedId) return;
    setNodes((arr) => arr.filter((n) => n.id !== selectedId));
    // Also remove any edges touching the deleted node.
    setEdges((arr) => arr.filter((edge) => edge.from !== selectedId && edge.to !== selectedId));
    setSelectedId(null);
    setExpandedId(null);
  }

  // Global keyboard: Delete / Backspace removes the currently selected edge or node.
  // Escape cancels an in-flight connection drag.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape" && connect) {
        setConnect(null);
        dragState.current = null;
        return;
      }
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      const tag = (e.target && e.target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target && e.target.isContentEditable)) {
        return;
      }
      if (selectedEdgeId) {
        e.preventDefault();
        setEdges((arr) => arr.filter((edge) => edge.id !== selectedEdgeId));
        setSelectedEdgeId(null);
      } else if (selectedId) {
        e.preventDefault();
        setNodes((arr) => arr.filter((n) => n.id !== selectedId));
        setEdges((arr) => arr.filter((edge) => edge.from !== selectedId && edge.to !== selectedId));
        setSelectedId(null);
        setExpandedId(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedEdgeId, selectedId, connect]);

  // Hydrate from localStorage on mount. We accept one frame of seed state (the initial useState
  // values) before swapping to persisted state — simpler and SSR-safe.
  useEffect(() => {
    const persisted = readPersistedState();
    if (persisted) {
      setNodes(persisted.nodes);
      setEdges(persisted.edges);
      setPan(persisted.pan);
      setZoom(persisted.zoom);
    }
    hasHydratedRef.current = true;
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, []);

  // Debounced auto-save. Skipped until hydration completes so we don't clobber persisted state
  // with seeds on first render. Transient UI state (selection, hover, expand, connect ghost) is
  // intentionally excluded.
  useEffect(() => {
    if (!hasHydratedRef.current) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      writePersistedState({ nodes, edges, pan, zoom });
      persistTimerRef.current = null;
    }, PERSIST_DEBOUNCE_MS);
  }, [nodes, edges, pan, zoom]);

  function clearAll() {
    if (typeof window !== "undefined" && !window.confirm("Clear the canvas and reset to the seed graph? This will erase saved changes.")) {
      return;
    }
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    clearPersistedState();
    setNodes(SEED_NODES);
    setEdges(SEED_EDGES);
    setPan({ x: 0, y: 0 });
    setZoom(1);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setExpandedId(null);
    setHoveredNodeId(null);
    setConnect(null);
  }

  function selectEdge(e, edge) {
    e.stopPropagation();
    setSelectedEdgeId(edge.id);
    setSelectedId(null);
  }

  // Edge geometry: bezier between right-mid of source and left-mid of target.
  const edgePaths = useMemo(() => {
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    return edges
      .map((edge) => {
        const a = byId[edge.from];
        const b = byId[edge.to];
        if (!a || !b) return null;
        const x1 = a.x + a.w;
        const y1 = a.y + a.h / 2;
        const x2 = b.x;
        const y2 = b.y + b.h / 2;
        const mx = (x1 + x2) / 2;
        return {
          id: edge.id,
          edge,
          d: `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`,
        };
      })
      .filter(Boolean);
  }, [nodes, edges]);

  // Ghost edge during a connection drag.
  const ghostPath = useMemo(() => {
    if (!connect) return null;
    const a = nodes.find((n) => n.id === connect.fromId);
    if (!a) return null;
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = connect.ghost.x;
    const y2 = connect.ghost.y;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
  }, [connect, nodes]);

  return (
    <div className="studio-shell">
      <header className="studio-toolbar">
        <div className="studio-brand">
          <span className="studio-eyebrow">Agent Studio</span>
          <span className="studio-title">Solo Tool Agent</span>
        </div>

        <div className="studio-tools">
          <button className="tool-btn" onClick={addNode} title="Add node">
            + node
          </button>
          <button
            className="tool-btn"
            onClick={deleteSelected}
            disabled={!selectedId && !selectedEdgeId}
            title="Delete selected"
          >
            delete
          </button>
          <span className="tool-sep" />
          <button className="tool-btn" onClick={() => setZoom((z) => Math.max(ZOOM_MIN, z * 0.85))} title="Zoom out">
            −
          </button>
          <span className="tool-zoom">{Math.round(zoom * 100)}%</span>
          <button className="tool-btn" onClick={() => setZoom((z) => Math.min(ZOOM_MAX, z * 1.15))} title="Zoom in">
            +
          </button>
          <button className="tool-btn" onClick={fitView} title="Fit view">
            fit
          </button>
          <button className="tool-btn" onClick={resetView} title="Reset view">
            reset
          </button>
          <span className="tool-sep" />
          <button
            className="tool-btn"
            onClick={clearAll}
            title="Clear saved state and reset to seed graph"
          >
            clear
          </button>
        </div>
      </header>

      <div
        ref={containerRef}
        className="studio-canvas"
        onPointerDown={onCanvasPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div
          className="studio-grid"
          style={{
            backgroundPosition: `${pan.x}px ${pan.y}px`,
            backgroundSize: `${24 * zoom}px ${24 * zoom}px`,
          }}
        />

        <div
          className="studio-stage"
          style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
        >
          <svg className="studio-edges" width="4000" height="4000">
            <defs>
              <marker
                id="arrow"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--border-strong)" />
              </marker>
              <marker
                id="arrow-selected"
                viewBox="0 0 10 10"
                refX="8"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--accent)" />
              </marker>
            </defs>
            {edgePaths.map((p) => {
              const isSelected = selectedEdgeId === p.id;
              return (
                <g key={p.id}>
                  {/* invisible thicker hit-target for click + right-click */}
                  <path
                    data-edge-hit
                    d={p.d}
                    stroke="transparent"
                    strokeWidth="14"
                    fill="none"
                    style={{ pointerEvents: "stroke", cursor: "pointer" }}
                    onPointerDown={(e) => selectEdge(e, p.edge)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      selectEdge(e, p.edge);
                    }}
                  />
                  <path
                    d={p.d}
                    stroke={isSelected ? "var(--accent)" : "var(--border-strong)"}
                    strokeWidth={isSelected ? 2.5 : 2}
                    fill="none"
                    markerEnd={isSelected ? "url(#arrow-selected)" : "url(#arrow)"}
                    style={{ pointerEvents: "none" }}
                  />
                </g>
              );
            })}
            {ghostPath && (
              <path
                d={ghostPath}
                stroke="var(--accent)"
                strokeWidth="2"
                strokeDasharray="6 5"
                fill="none"
                opacity="0.85"
                style={{ pointerEvents: "none" }}
              />
            )}
          </svg>

          {nodes.map((n) => {
            const c = ROLE_COLORS[n.role] ?? ROLE_COLORS.agent;
            const isExpanded = expandedId === n.id;
            const isSelected = selectedId === n.id;
            const isHovered = hoveredNodeId === n.id;
            const showPorts = isHovered || isSelected || (connect && connect.fromId !== n.id);
            return (
              <div
                key={n.id}
                data-node
                className={`studio-node ${isSelected ? "is-selected" : ""} ${isExpanded ? "is-expanded" : ""}`}
                style={{
                  left: n.x,
                  top: n.y,
                  width: n.w,
                  minHeight: n.h,
                  background: c.soft,
                  borderColor: isSelected ? c.border : "transparent",
                }}
                onPointerDown={(e) => onNodePointerDown(e, n)}
                onPointerEnter={() => setHoveredNodeId(n.id)}
                onPointerLeave={() => setHoveredNodeId((id) => (id === n.id ? null : id))}
              >
                <div className="studio-node-role" style={{ color: c.border }}>
                  {n.role.toUpperCase()}
                </div>
                <div className="studio-node-title">{n.title}</div>
                <div className={`studio-node-desc ${isExpanded ? "" : "is-clamped"}`}>
                  {n.description}
                </div>
                <div
                  data-port="in"
                  data-node-id={n.id}
                  className={`studio-port studio-port-in ${showPorts ? "is-visible" : ""}`}
                  style={{ borderColor: c.border }}
                  title="Drop a connection here"
                />
                <div
                  data-port="out"
                  data-node-id={n.id}
                  className={`studio-port studio-port-out ${showPorts ? "is-visible" : ""}`}
                  style={{ borderColor: c.border, background: c.border }}
                  title="Drag to connect to another node"
                  onPointerDown={(e) => onPortPointerDown(e, n, "out")}
                />
              </div>
            );
          })}
        </div>

        <div className="studio-help">
          drag empty space to pan · scroll to zoom · click a node to expand · drag a node to move ·
          drag from the right port to connect · click an edge then Delete to remove
        </div>
      </div>

      <style jsx>{`
        .studio-shell {
          position: fixed;
          inset: 0;
          display: flex;
          flex-direction: column;
        }
        .studio-toolbar {
          height: 56px;
          padding: 0 18px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          border-bottom: 1px solid var(--border);
          background: var(--surface);
          z-index: 2;
        }
        .studio-brand {
          display: flex;
          flex-direction: column;
          line-height: 1.1;
        }
        .studio-eyebrow {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .studio-title {
          font-size: 16px;
          font-weight: 600;
        }
        .studio-tools {
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .tool-btn {
          height: 32px;
          padding: 0 12px;
          border-radius: 8px;
          border: 1px solid var(--border);
          background: var(--surface);
          font-size: 13px;
          color: var(--ink);
          cursor: pointer;
        }
        .tool-btn:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .tool-btn:disabled {
          color: var(--faint);
          cursor: not-allowed;
        }
        .tool-zoom {
          width: 56px;
          text-align: center;
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px;
          color: var(--muted);
        }
        .tool-sep {
          width: 1px;
          height: 22px;
          background: var(--border);
          margin: 0 6px;
        }
        .studio-canvas {
          position: relative;
          flex: 1;
          overflow: hidden;
          background: var(--bg);
          touch-action: none;
          cursor: grab;
        }
        .studio-canvas:active {
          cursor: grabbing;
        }
        .studio-grid {
          position: absolute;
          inset: 0;
          background-image:
            linear-gradient(to right, var(--grid) 1px, transparent 1px),
            linear-gradient(to bottom, var(--grid) 1px, transparent 1px);
          pointer-events: none;
        }
        .studio-stage {
          position: absolute;
          inset: 0;
          transform-origin: 0 0;
          will-change: transform;
        }
        .studio-edges {
          position: absolute;
          left: 0;
          top: 0;
          pointer-events: none;
          overflow: visible;
        }
        .studio-node {
          position: absolute;
          padding: 12px 14px;
          border-radius: 12px;
          border: 2px solid transparent;
          background: var(--surface);
          box-shadow: var(--shadow);
          cursor: grab;
          user-select: none;
          transition: box-shadow 120ms ease;
        }
        .studio-node.is-selected {
          box-shadow: var(--shadow-lift);
        }
        .studio-node.is-expanded {
          z-index: 5;
        }
        .studio-node-role {
          font-size: 10px;
          letter-spacing: 0.08em;
          font-weight: 600;
          margin-bottom: 4px;
        }
        .studio-node-title {
          font-size: 16px;
          font-weight: 600;
          margin-bottom: 6px;
        }
        .studio-node-desc {
          font-size: 13px;
          color: var(--muted);
          line-height: 1.4;
        }
        .studio-node-desc.is-clamped {
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .studio-port {
          position: absolute;
          top: 50%;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid var(--border-strong);
          background: var(--surface);
          transform: translate(-50%, -50%);
          opacity: 0;
          transition: opacity 100ms ease, transform 100ms ease;
          pointer-events: none;
          cursor: crosshair;
        }
        .studio-port.is-visible {
          opacity: 1;
          pointer-events: auto;
        }
        .studio-port:hover {
          transform: translate(-50%, -50%) scale(1.25);
        }
        .studio-port-in {
          left: 0;
        }
        .studio-port-out {
          left: 100%;
        }
        .studio-help {
          position: absolute;
          left: 18px;
          bottom: 14px;
          font-size: 12px;
          color: var(--faint);
          pointer-events: none;
          background: rgba(255, 255, 255, 0.7);
          padding: 4px 10px;
          border-radius: 6px;
        }
      `}</style>
    </div>
  );
}
