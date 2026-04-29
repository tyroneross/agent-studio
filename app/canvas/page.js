"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import ProjectSwitcher from "../components/ProjectSwitcher";
import SoloRunModal from "../components/SoloRunModal";
import StoragePanel from "../components/StoragePanel";
import StoragePill from "../components/StoragePill";
import TestPanel from "../components/TestPanel";
import WelcomeModal from "../components/WelcomeModal";
import WorkingFolderInput from "../components/WorkingFolderInput";
import {
  SEED_NODES,
  SEED_EDGES,
  loadStore,
  writeStore,
  makeProject,
  seedCanvas,
  getActiveProject,
  withProjectUpdated,
  withCanvasUpdated,
  withRunCacheEntry,
  withRunCacheCleared,
  withSnapshotAdded,
  withSnapshotRestored,
  withSnapshotDeleted,
  withStatusChanged,
  isProjectLocked,
} from "../lib/projects";
import { templateFor } from "../lib/role-templates.mjs";
import {
  exportProjectToMarkdown,
  importMarkdownToProject,
} from "../lib/markdown-export.mjs";
import {
  approxProjectBytes,
  approxSnapshotBytes,
  clearQuotaCache,
  getStorageEstimate,
  loadStorageConfig,
  preflightVerdict,
} from "../lib/storage-config.mjs";

const ROLE_COLORS = {
  agent: { soft: "var(--accent-soft)", border: "var(--accent)" },
  guardrail: { soft: "var(--policy-soft)", border: "var(--policy)" },
  orchestrator: { soft: "var(--accent-soft)", border: "var(--accent)" },
  executor: { soft: "var(--tool-soft)", border: "var(--tool)" },
  eval: { soft: "var(--eval-soft)", border: "var(--eval)" },
  memory: { soft: "var(--memory-soft)", border: "var(--memory)" },
};

const ROLE_OPTIONS = ["agent", "guardrail", "orchestrator", "executor", "eval", "memory"];

function edgeId(from, to) {
  return `${from}->${to}`;
}

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.5;

const PERSIST_DEBOUNCE_MS = 350;

// Pass 8: localStorage flag for the welcome modal. Once set, the modal does
// not auto-show. The toolbar `?` button can still re-open it on demand.
// (The first-run-seen-per-project flag lives inside TestPanel.)
const WELCOME_FLAG_KEY = "agent-studio:onboarded:v1";

export default function StudioCanvas() {
  const router = useRouter();
  // Canvas page is always rendered against an existing project, but we have to
  // wait for hydration to know if any exists. If the load yields no projects,
  // we send the user back to the landing page rather than crashing or seeding
  // an unintended project.
  const [store, setStore] = useState(null);
  const [nodes, setNodes] = useState(SEED_NODES);
  const [edges, setEdges] = useState(SEED_EDGES);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);

  const [expandedId, setExpandedId] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState(null);
  const [hoveredNodeId, setHoveredNodeId] = useState(null);
  const [connect, setConnect] = useState(null);
  const [testPanelOpen, setTestPanelOpen] = useState(false);
  // Pass 8: welcome modal. Defaults to closed; the hydration effect opens it
  // once when the localStorage flag is missing. The `?` button in the toolbar
  // re-opens it without writing the flag.
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  // Pass 14 — solo-run modal + right-click context menu state. The modal is
  // node-bound; closing it clears the binding.
  const [soloRunNodeId, setSoloRunNodeId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null); // { x, y, nodeId } | null

  // Pass 14.6 — storage panel slide-over + a one-shot toast queue. Toasts
  // surface low-storage events (auto-snapshot skipped, save preflight) so the
  // user knows why a save behaved differently than expected.
  const [storagePanelOpen, setStoragePanelOpen] = useState(false);
  const [storageRefreshKey, setStorageRefreshKey] = useState(0);
  const [storageToast, setStorageToast] = useState(null); // { text } | null
  const skippedAutoSnapshotShownRef = useRef(false);

  const containerRef = useRef(null);
  const dragState = useRef(null);
  const hasHydratedRef = useRef(false);
  const persistTimerRef = useRef(null);
  const skipNextMirrorRef = useRef(false);
  // Pass 7: per-role prompt-override debounce. Same pattern as canvas auto-save
  // but lives at the project level rather than canvas level, so a separate
  // timer prevents collision.
  const overrideTimersRef = useRef({});
  // Local draft of override edits by role, applied after debounce fires. This
  // keeps the textarea responsive while we coalesce writes.
  const [roleOverrideDrafts, setRoleOverrideDrafts] = useState({});
  const [rolePromptExpanded, setRolePromptExpanded] = useState(false);

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
    if (target.closest("[data-port]")) return;
    if (target.closest("[data-edge-hit]")) return;
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
    if (side !== "out") return;
    if (locked) return; // Pass 14.5 — no port drags on completed projects.
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
    // Pass 14.5 — when locked, allow selecting (read-only side panel) but no
    // drag tracking. We still record the pointer down so a click selects.
    if (locked) {
      setSelectedId(node.id);
      return;
    }
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
      if (connect) setConnect(null);
      return;
    }
    if (ds.type === "node" && !ds.moved) {
      setExpandedId((id) => (id === ds.nodeId ? null : ds.nodeId));
    } else if (ds.type === "connect") {
      const targetEl = document.elementFromPoint(e.clientX, e.clientY);
      const portEl = targetEl?.closest?.("[data-port]");
      if (portEl) {
        const side = portEl.getAttribute("data-port");
        const toId = portEl.getAttribute("data-node-id");
        if (side === "in" && toId && toId !== ds.fromId) {
          setEdges((arr) => {
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
    const canvasX = (cx - pan.x) / zoom;
    const canvasY = (cy - pan.y) / zoom;
    const newPanX = cx - canvasX * nextZoom;
    const newPanY = cy - canvasY * nextZoom;
    setZoom(nextZoom);
    setPan({ x: newPanX, y: newPanY });
  }

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
        instructions: "",
        x: center.x - 110,
        y: center.y - 60,
        w: 220,
        h: 130,
      },
    ]);
    setSelectedId(id);
  }

  const updateNodeField = useCallback((id, field, value) => {
    setNodes((arr) => arr.map((n) => (n.id === id ? { ...n, [field]: value } : n)));
  }, []);

  function deleteSelected() {
    if (selectedEdgeId) {
      setEdges((arr) => arr.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
      return;
    }
    if (!selectedId) return;
    setNodes((arr) => arr.filter((n) => n.id !== selectedId));
    setEdges((arr) => arr.filter((edge) => edge.from !== selectedId && edge.to !== selectedId));
    setSelectedId(null);
    setExpandedId(null);
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") {
        if (connect) {
          setConnect(null);
          dragState.current = null;
          return;
        }
        setSelectedId(null);
        setSelectedEdgeId(null);
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

  // Hydrate from localStorage on mount. If no projects exist, redirect home so
  // the user can create one.
  useEffect(() => {
    const loaded = loadStore();
    if (!loaded || !loaded.projects || loaded.projects.length === 0) {
      router.replace("/");
      return;
    }
    const active = getActiveProject(loaded);
    if (!active) {
      router.replace("/");
      return;
    }
    skipNextMirrorRef.current = true;
    setStore(loaded);
    setNodes(active.canvas.nodes);
    setEdges(active.canvas.edges);
    setPan(active.canvas.pan);
    setZoom(active.canvas.zoom);
    hasHydratedRef.current = true;
    // Pass 8: open the welcome modal on first canvas visit. Single global
    // flag so the modal appears once per browser, regardless of how the
    // user got to /canvas (demo CTA, blank project, or directly).
    try {
      if (typeof window !== "undefined" && !window.localStorage.getItem(WELCOME_FLAG_KEY)) setWelcomeOpen(true);
    } catch {}
    return () => {
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    };
  }, [router]);

  // Debounced auto-save. Only mirrors back when the store has been hydrated and
  // we haven't just swapped projects.
  useEffect(() => {
    if (!store) return;
    if (!hasHydratedRef.current) return;
    if (skipNextMirrorRef.current) {
      skipNextMirrorRef.current = false;
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      setStore((prev) => {
        if (!prev) return prev;
        const next = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
        writeStore(next);
        return next;
      });
      persistTimerRef.current = null;
    }, PERSIST_DEBOUNCE_MS);
  }, [nodes, edges, pan, zoom, store]);

  function clearAll() {
    if (!store) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Reset this project's canvas to the seed graph? This will erase saved changes for this project.")
    ) {
      return;
    }
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    const seeded = seedCanvas();
    setStore((prev) => {
      const next = withCanvasUpdated(prev, prev.activeProjectId, seeded);
      writeStore(next);
      return next;
    });
    skipNextMirrorRef.current = true;
    setNodes(seeded.nodes);
    setEdges(seeded.edges);
    setPan(seeded.pan);
    setZoom(seeded.zoom);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setExpandedId(null);
    setHoveredNodeId(null);
    setConnect(null);
  }

  function handleSelectProject(projectId) {
    if (!store) return;
    if (projectId === store.activeProjectId) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setStore((prev) => {
      const flushed = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
      const next = { ...flushed, activeProjectId: projectId };
      writeStore(next);
      const target = next.projects.find((p) => p.id === projectId);
      if (target) {
        skipNextMirrorRef.current = true;
        queueMicrotask(() => {
          setNodes(target.canvas.nodes);
          setEdges(target.canvas.edges);
          setPan(target.canvas.pan);
          setZoom(target.canvas.zoom);
          setSelectedId(null);
          setSelectedEdgeId(null);
          setExpandedId(null);
          setHoveredNodeId(null);
          setConnect(null);
        });
      }
      return next;
    });
  }

  function handleNewProject(name) {
    // Lightweight new-project flow from inside the canvas: creates a default
    // project on the fly. The richer flow (goal/context/uploads) lives on the
    // landing page.
    const project = makeProject({ name });
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setStore((prev) => {
      const flushed = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
      const next = {
        ...flushed,
        activeProjectId: project.id,
        projects: [...flushed.projects, project],
      };
      writeStore(next);
      skipNextMirrorRef.current = true;
      queueMicrotask(() => {
        setNodes(project.canvas.nodes);
        setEdges(project.canvas.edges);
        setPan(project.canvas.pan);
        setZoom(project.canvas.zoom);
        setSelectedId(null);
        setSelectedEdgeId(null);
        setExpandedId(null);
        setHoveredNodeId(null);
        setConnect(null);
      });
      return next;
    });
  }

  function handleRenameProject(projectId, name) {
    setStore((prev) => {
      const next = withProjectUpdated(prev, projectId, (p) => ({ ...p, name }));
      writeStore(next);
      return next;
    });
  }

  function handleDeleteProject(projectId) {
    setStore((prev) => {
      if (!prev) return prev;
      if (prev.projects.length <= 1) return prev;
      const remaining = prev.projects.filter((p) => p.id !== projectId);
      const wasActive = prev.activeProjectId === projectId;
      const nextActiveId = wasActive ? remaining[0].id : prev.activeProjectId;
      const next = { ...prev, projects: remaining, activeProjectId: nextActiveId };
      writeStore(next);
      if (wasActive) {
        const target = next.projects.find((p) => p.id === nextActiveId);
        if (target) {
          skipNextMirrorRef.current = true;
          queueMicrotask(() => {
            setNodes(target.canvas.nodes);
            setEdges(target.canvas.edges);
            setPan(target.canvas.pan);
            setZoom(target.canvas.zoom);
            setSelectedId(null);
            setSelectedEdgeId(null);
            setExpandedId(null);
            setHoveredNodeId(null);
            setConnect(null);
          });
        }
      }
      return next;
    });
  }

  function handleWorkingFolderChange(value) {
    setStore((prev) => {
      const next = withProjectUpdated(prev, prev.activeProjectId, (p) => ({
        ...p,
        workingFolder: value,
      }));
      writeStore(next);
      return next;
    });
  }

  // Pass 14 — solo-run cache update. Pure state write through projects.js
  // helpers so localStorage stays the only persistence layer (per the
  // roadmap constraint). Called by SoloRunModal's onComplete.
  const handleSoloRunComplete = useCallback((nodeId, entry) => {
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(prev, prev.activeProjectId, (p) =>
        withRunCacheEntry(p, nodeId, entry),
      );
      writeStore(next);
      return next;
    });
  }, []);

  // Pass 14 — wipe the active project's runCache. Toolbar action; confirms
  // before wiping because the user can't undo this from the editor today.
  function clearRunCache() {
    if (!store) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm("Clear all cached solo-run outputs for this project?")
    ) {
      return;
    }
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(prev, prev.activeProjectId, (p) =>
        withRunCacheCleared(p),
      );
      writeStore(next);
      return next;
    });
  }

  // Hoisted so the snapshot/markdown handlers below can reference these
  // bindings during Next.js prerender without TDZ errors. They were
  // previously declared near the bottom of the component; minified bundles
  // were tripping on lexical reordering.
  const activeProject = useMemo(() => (store ? getActiveProject(store) : null), [store]);
  // Pass 14.5 — completion lock. The data layer also enforces this via
  // withProjectUpdated; the UI uses this flag to disable controls so the
  // intent is visible. Snapshots and status flips remain available.
  const locked = isProjectLocked(activeProject);

  // The TestPanel needs the canvas state the user is currently looking at,
  // not the last persisted snapshot. Compose a "live" project that overrides
  // canvas with current in-memory nodes/edges. This lets a user run the graph
  // immediately after editing without waiting for the debounced auto-save.
  const liveProject = useMemo(() => {
    if (!activeProject) return null;
    return {
      ...activeProject,
      canvas: {
        ...activeProject.canvas,
        nodes,
        edges,
      },
    };
  }, [activeProject, nodes, edges]);

  // Pass 14 — open the solo-run modal for a node. Centralised so the
  // side-panel button and the context menu both go through one path.
  const openSoloRun = useCallback((nodeId) => {
    setContextMenu(null);
    if (locked) return; // Pass 14.5 — solo-run disabled on completed projects.
    setSoloRunNodeId(nodeId);
  }, [locked]);

  // Pass 14.6 — storage panel handlers + recent-save bytes for the pill's
  // "saves left" estimate. We use the median of the active project's last
  // few snapshot byte sizes; falls back to the project byte size when no
  // snapshots exist yet.
  const bytesPerRecentSave = useMemo(() => {
    if (!activeProject) return 0;
    const snaps = activeProject.snapshots ?? [];
    if (snaps.length === 0) {
      return approxProjectBytes(activeProject);
    }
    const recent = snaps.slice(0, Math.min(snaps.length, 5));
    const sizes = recent.map((s) => approxSnapshotBytes(s)).sort((a, b) => a - b);
    return sizes[Math.floor(sizes.length / 2)] || 0;
  }, [activeProject]);

  const handleTrimRunCache = useCallback((projectId) => {
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(prev, projectId, (p) => withRunCacheCleared(p));
      writeStore(next);
      return next;
    });
    clearQuotaCache();
    setStorageRefreshKey((k) => k + 1);
  }, []);

  const handleDeleteOldestSnapshots = useCallback((projectId, count) => {
    const n = Math.max(1, Number(count) || 1);
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(
        prev,
        projectId,
        (p) => {
          const list = Array.isArray(p.snapshots) ? p.snapshots : [];
          if (list.length === 0) return p;
          return { ...p, snapshots: list.slice(0, Math.max(0, list.length - n)) };
        },
        { allowOnLocked: true },
      );
      writeStore(next);
      return next;
    });
    clearQuotaCache();
    setStorageRefreshKey((k) => k + 1);
  }, []);

  const handleStorageConfigChanged = useCallback(() => {
    // The pill re-reads on its own interval but a settings change should
    // re-evaluate immediately.
    clearQuotaCache();
    setStorageRefreshKey((k) => k + 1);
  }, []);

  // Pass 14.5 → 14.6 — Save snapshot with storage preflight.
  // We flush the live canvas state into the project first (the debounced
  // auto-save may not have fired yet) so the snapshot captures what the user
  // sees, not the last persisted version. Before writing we project the
  // post-save usage; if it would cross the user's `blockLevel`, we surface a
  // confirm with three options:
  //   - Trim & save (auto-deletes the oldest snapshot for the active
  //     project, then proceeds)
  //   - Save anyway
  //   - Cancel
  // When `navigator.storage.estimate()` is unavailable we skip the gate
  // (per design: don't block on missing data).
  async function saveSnapshot() {
    if (!store) return;
    if (typeof window === "undefined") return;
    const defaultName = `Snapshot ${new Date().toLocaleString()}`;
    const name = window.prompt("Name this snapshot:", defaultName);
    if (name === null) return; // user cancelled
    const trimmed = name.trim();
    if (!trimmed) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    // Estimate the bytes the new snapshot will add. The snapshot is a deep
    // clone of the project minus snapshots + minus runCache; project size
    // is a tight upper bound for that.
    const liveProjectForBytes = liveProject
      ? { ...liveProject, snapshots: [], runCache: {} }
      : null;
    const projectedAdd = liveProjectForBytes ? approxSnapshotBytes({ projectFrozen: liveProjectForBytes, name: trimmed, id: "x", createdAt: "x" }) : 0;
    const estimate = await getStorageEstimate({ force: false });
    const cfg = loadStorageConfig();
    const verdict = preflightVerdict(estimate, cfg, projectedAdd);

    let trimFirst = false;
    if (verdict.intercept) {
      // Use a single confirm with explicit text mapping to the design's
      // three-button modal. Browsers don't have a native 3-button confirm so
      // we chain two prompts: the first asks whether to proceed at all, the
      // second whether to trim oldest first.
      const proceed = window.confirm(
        "This save would leave your browser storage almost full.\n\n[OK] save anyway\n[Cancel] back out\n\nAfter you click OK you can also choose to trim the oldest snapshot first.",
      );
      if (!proceed) return;
      trimFirst = window.confirm(
        "Trim the oldest snapshot before saving? Click OK to trim, Cancel to save without trimming.",
      );
    }

    setStore((prev) => {
      if (!prev) return prev;
      // Flush the live canvas first (allowed even when locked is false).
      let working = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
      if (trimFirst) {
        // Drop the oldest snapshot for the active project before adding the
        // new one. Keeps the panel's "delete oldest" affordance reusable.
        working = withProjectUpdated(
          working,
          working.activeProjectId,
          (p) => {
            const list = Array.isArray(p.snapshots) ? p.snapshots : [];
            if (list.length === 0) return p;
            return { ...p, snapshots: list.slice(0, list.length - 1) };
          },
          { allowOnLocked: true },
        );
      }
      // withSnapshotAdded is allowed on completed projects too.
      const next = withProjectUpdated(
        working,
        working.activeProjectId,
        (p) => withSnapshotAdded(p, trimmed),
        { allowOnLocked: true },
      );
      writeStore(next);
      return next;
    });
    // Force the pill to refresh now that we've written.
    clearQuotaCache();
    setStorageRefreshKey((k) => k + 1);
  }

  // Pass 14.5 → 14.6 — Restore a snapshot. Auto-snapshots first by default,
  // unless the user has turned off `autoSnapshotWhenLow` and storage is at
  // block level — in that case we skip the auto-snap silently and emit a
  // one-time toast so the user knows why.
  async function restoreSnapshot(snapshotId) {
    if (!store) return;
    if (typeof window === "undefined") return;
    if (!window.confirm("Restore this snapshot? Your current canvas will be auto-saved as a snapshot first.")) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }

    // Decide whether to skip the auto-snapshot.
    const cfg = loadStorageConfig();
    let skipAuto = false;
    if (!cfg.autoSnapshotWhenLow) {
      const estimate = await getStorageEstimate({ force: false });
      if (estimate.supported && estimate.quota) {
        const pct = (estimate.usage ?? 0) / estimate.quota * 100;
        if (pct >= cfg.blockLevel) {
          skipAuto = true;
          if (!skippedAutoSnapshotShownRef.current) {
            skippedAutoSnapshotShownRef.current = true;
            setStorageToast({
              text:
                "Auto-snapshot skipped — storage is low. Save manually first if you want a recovery point.",
            });
            window.setTimeout(() => setStorageToast(null), 5_000);
          }
        }
      }
    }

    setStore((prev) => {
      if (!prev) return prev;
      // Flush live state into the project so the auto-snapshot inside
      // withSnapshotRestored captures the actual canvas the user sees.
      const flushed = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
      const next = withProjectUpdated(
        flushed,
        flushed.activeProjectId,
        (p) => {
          if (skipAuto) {
            // Manually mirror withSnapshotRestored without the auto-save
            // sub-step. Fetch frozen state from the snapshot list and apply.
            const list = Array.isArray(p.snapshots) ? p.snapshots : [];
            const target = list.find((s) => s.id === snapshotId);
            if (!target || !target.projectFrozen) return p;
            const frozen = target.projectFrozen;
            return {
              ...frozen,
              id: p.id,
              status: p.status === "completed" ? "completed" : "draft",
              snapshots: list,
              runCache: {},
            };
          }
          return withSnapshotRestored(p, snapshotId);
        },
        { allowOnLocked: true },
      );
      writeStore(next);
      // Push the restored canvas into the live state.
      const restored = next.projects.find((p) => p.id === next.activeProjectId);
      if (restored) {
        skipNextMirrorRef.current = true;
        queueMicrotask(() => {
          setNodes(restored.canvas.nodes);
          setEdges(restored.canvas.edges);
          setPan(restored.canvas.pan ?? { x: 0, y: 0 });
          setZoom(restored.canvas.zoom ?? 1);
          setSelectedId(null);
          setSelectedEdgeId(null);
          setExpandedId(null);
        });
      }
      return next;
    });
    clearQuotaCache();
    setStorageRefreshKey((k) => k + 1);
  }

  function deleteSnapshot(snapshotId) {
    if (!store) return;
    if (typeof window === "undefined") return;
    if (!window.confirm("Delete this snapshot? This cannot be undone.")) return;
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(
        prev,
        prev.activeProjectId,
        (p) => withSnapshotDeleted(p, snapshotId),
        { allowOnLocked: true },
      );
      writeStore(next);
      return next;
    });
  }

  // Pass 14.5 — Mark completed / Reopen. Mark-completed flushes the canvas
  // into the project first. Reopen auto-snapshots the completed state as
  // `Completed <ISO>` first so the completed version is recoverable.
  function markCompleted() {
    if (!store) return;
    if (persistTimerRef.current) {
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = null;
    }
    setStore((prev) => {
      if (!prev) return prev;
      const flushed = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
      const next = withProjectUpdated(
        flushed,
        flushed.activeProjectId,
        (p) => withStatusChanged(p, "completed"),
        { allowOnLocked: true },
      );
      writeStore(next);
      return next;
    });
  }

  async function reopenProject() {
    if (!store) return;
    // Pass 14.6 — honor `autoSnapshotWhenLow=false` at block level.
    const cfg = loadStorageConfig();
    let skipAuto = false;
    if (!cfg.autoSnapshotWhenLow) {
      const estimate = await getStorageEstimate({ force: false });
      if (estimate.supported && estimate.quota) {
        const pct = (estimate.usage ?? 0) / estimate.quota * 100;
        if (pct >= cfg.blockLevel) {
          skipAuto = true;
          if (!skippedAutoSnapshotShownRef.current && typeof window !== "undefined") {
            skippedAutoSnapshotShownRef.current = true;
            setStorageToast({
              text:
                "Auto-snapshot skipped — storage is low. Save manually first if you want a recovery point.",
            });
            window.setTimeout(() => setStorageToast(null), 5_000);
          }
        }
      }
    }
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(
        prev,
        prev.activeProjectId,
        (p) => {
          if (skipAuto) return withStatusChanged(p, "draft");
          const snapped = withSnapshotAdded(p, `Completed ${new Date().toISOString()}`);
          return withStatusChanged(snapped, "draft");
        },
        { allowOnLocked: true },
      );
      writeStore(next);
      return next;
    });
    clearQuotaCache();
    setStorageRefreshKey((k) => k + 1);
  }

  // Pass 14.5 — Export markdown. Serializes the live project (so the user's
  // unflushed edits are included), POSTs to the write-markdown route. The
  // active project must have a workingFolder configured because the write
  // route needs an absolute path under the allowlist; we guard against the
  // empty case with a clear message.
  async function exportMarkdown() {
    if (!liveProject) return;
    if (!liveProject.workingFolder || !liveProject.workingFolder.startsWith("/")) {
      if (typeof window !== "undefined") {
        window.alert("Set the project's working folder before exporting markdown.");
      }
      return;
    }
    const md = exportProjectToMarkdown(liveProject);
    try {
      const res = await fetch("/api/fs/write-markdown", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ workingFolder: liveProject.workingFolder, content: md }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        if (typeof window !== "undefined") {
          window.alert(`Export failed: ${json.error || res.status}`);
        }
        return;
      }
      if (typeof window !== "undefined") {
        window.alert(`Wrote ${json.bytes} bytes to ${json.savedPath}`);
      }
    } catch (err) {
      if (typeof window !== "undefined") {
        window.alert(`Export failed: ${err?.message || "network error"}`);
      }
    }
  }

  // Pass 14.5 — Import markdown. Opens a file picker, parses the file as
  // agent-md/v1, creates a NEW project (does not overwrite anything), and
  // routes into it.
  function importMarkdown() {
    if (typeof document === "undefined") return;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".md,text/markdown";
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      let text;
      try {
        text = await file.text();
      } catch (err) {
        if (typeof window !== "undefined") window.alert(`Read failed: ${err?.message || "io"}`);
        return;
      }
      let parsed;
      try {
        parsed = importMarkdownToProject(text);
      } catch (err) {
        if (typeof window !== "undefined") window.alert(`Import failed: ${err?.message || "parse"}`);
        return;
      }
      // Append as a new project and switch to it.
      if (persistTimerRef.current) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      setStore((prev) => {
        if (!prev) return prev;
        const flushed = withCanvasUpdated(prev, prev.activeProjectId, { nodes, edges, pan, zoom });
        const next = {
          ...flushed,
          projects: [...flushed.projects, parsed],
          activeProjectId: parsed.id,
        };
        writeStore(next);
        skipNextMirrorRef.current = true;
        queueMicrotask(() => {
          setNodes(parsed.canvas.nodes);
          setEdges(parsed.canvas.edges);
          setPan(parsed.canvas.pan);
          setZoom(parsed.canvas.zoom);
          setSelectedId(null);
          setSelectedEdgeId(null);
          setExpandedId(null);
        });
        return next;
      });
    };
    input.click();
  }

  // Pass 14 — right-click on a node opens a small context menu with "Run
  // solo" as the only entry today. Pass 15 will add Set Mock + Inspect.
  const onNodeContextMenu = useCallback((e, node) => {
    e.preventDefault();
    e.stopPropagation();
    setSelectedId(node.id);
    setContextMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
  }, []);

  // Close context menu on outside click / scroll / Esc.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("pointerdown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    function onKey(e) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  // Pass 7: edit a per-project role prompt override. Debounced 350ms so the
  // textarea stays responsive. Empty/whitespace-only values are treated as
  // "remove the override" (the runtime falls back to the default).
  const setRoleOverrideDraft = useCallback((role, value) => {
    setRoleOverrideDrafts((prev) => ({ ...prev, [role]: value }));
    const timers = overrideTimersRef.current;
    if (timers[role]) clearTimeout(timers[role]);
    timers[role] = setTimeout(() => {
      setStore((prev) => {
        if (!prev) return prev;
        const next = withProjectUpdated(prev, prev.activeProjectId, (p) => {
          const overrides = { ...(p.rolePromptOverrides ?? {}) };
          if (typeof value === "string" && value.trim().length > 0) {
            overrides[role] = value;
          } else {
            delete overrides[role];
          }
          return { ...p, rolePromptOverrides: overrides };
        });
        writeStore(next);
        return next;
      });
      delete overrideTimersRef.current[role];
    }, PERSIST_DEBOUNCE_MS);
  }, []);

  // Reset to default: drop the override entirely so the runtime falls back to
  // the hardcoded template. No confirm prompt — re-editing reinstates it.
  const resetRoleOverride = useCallback((role) => {
    const timers = overrideTimersRef.current;
    if (timers[role]) {
      clearTimeout(timers[role]);
      delete timers[role];
    }
    setRoleOverrideDrafts((prev) => {
      const next = { ...prev };
      delete next[role];
      return next;
    });
    setStore((prev) => {
      if (!prev) return prev;
      const next = withProjectUpdated(prev, prev.activeProjectId, (p) => {
        const overrides = { ...(p.rolePromptOverrides ?? {}) };
        delete overrides[role];
        return { ...p, rolePromptOverrides: overrides };
      });
      writeStore(next);
      return next;
    });
  }, []);

  // When the user switches projects we drop drafts so the new project's
  // overrides take effect immediately.
  useEffect(() => {
    setRoleOverrideDrafts({});
    setRolePromptExpanded(false);
    const timers = overrideTimersRef.current;
    for (const k of Object.keys(timers)) {
      clearTimeout(timers[k]);
      delete timers[k];
    }
  }, [store?.activeProjectId]);

  function selectEdge(e, edge) {
    e.stopPropagation();
    setSelectedEdgeId(edge.id);
    setSelectedId(null);
  }

  // Pass 8: welcome modal helpers. dismiss persists the flag; reopen does
  // not write the flag, so the "shown once auto" contract is preserved.
  function dismissWelcome() {
    setWelcomeOpen(false);
    try {
      if (typeof window !== "undefined") window.localStorage.setItem(WELCOME_FLAG_KEY, "1");
    } catch {}
  }
  function reopenWelcome() { setWelcomeOpen(true); }

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

  const selectedNode = useMemo(
    () => (selectedId ? nodes.find((n) => n.id === selectedId) ?? null : null),
    [nodes, selectedId],
  );

  // (activeProject / locked / liveProject hoisted above the snapshot/markdown
  // handlers — see top of the component body. The previous declaration here
  // was removed so the handlers can reference these values without TDZ
  // errors during Next.js prerender.)

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

  // Loading state until the store hydrates. This usually flashes for a frame
  // and then mounts the toolbar; if the store is empty we redirect to "/" in
  // the hydration effect above.
  if (!store) {
    return <div data-canvas-loading style={{ padding: 24, color: "var(--muted)" }}>Loading…</div>;
  }

  return (
    <div className="studio-shell">
      <header className="studio-toolbar">
        <div className="studio-brand">
          <Link href="/" className="studio-back" data-canvas-projects-link>
            ← Projects
          </Link>
          <span className="studio-eyebrow">Agent Studio</span>
          <span className="studio-title">{activeProject?.name || "Canvas"}</span>
        </div>

        <div className="studio-tools">
          <ProjectSwitcher
            projects={store.projects}
            activeProjectId={store.activeProjectId}
            onSelect={handleSelectProject}
            onNew={handleNewProject}
            onRename={handleRenameProject}
            onDelete={handleDeleteProject}
          />
          <span className="tool-sep" />
          <button
            className="tool-btn"
            onClick={addNode}
            disabled={locked}
            title={locked ? "Project is completed (read-only)" : "Add node"}
          >
            + node
          </button>
          <button
            className="tool-btn"
            onClick={deleteSelected}
            disabled={locked || (!selectedId && !selectedEdgeId)}
            title={locked ? "Project is completed (read-only)" : "Delete selected"}
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
            disabled={locked}
            title={locked ? "Project is completed (read-only)" : "Clear this project's canvas and reset to seed graph"}
          >
            clear
          </button>
          <button
            className="tool-btn"
            onClick={clearRunCache}
            disabled={locked}
            title={locked ? "Project is completed (read-only)" : "Clear all cached solo-run outputs for this project"}
            data-canvas-clear-cache
          >
            clear cache
          </button>
          <span className="tool-sep" />
          {/* Pass 14.5 — snapshot + completion + markdown actions. */}
          <button
            className="tool-btn"
            onClick={saveSnapshot}
            title="Save the current canvas as a named snapshot"
            data-canvas-save-snapshot
          >
            save snapshot
          </button>
          {locked ? (
            <button
              className="tool-btn"
              onClick={reopenProject}
              title="Reopen this project for editing (auto-snapshots the completed state first)"
              data-canvas-reopen
            >
              reopen
            </button>
          ) : (
            <button
              className="tool-btn"
              onClick={markCompleted}
              title="Mark project completed and lock the canvas"
              data-canvas-mark-completed
            >
              mark completed
            </button>
          )}
          <span className="tool-sep" />
          <button
            className="tool-btn"
            onClick={exportMarkdown}
            title="Write a single-file agent.md to the project's working folder"
            data-canvas-export-md
          >
            export markdown
          </button>
          <button
            className="tool-btn"
            onClick={importMarkdown}
            title="Import an agent.md as a new project"
            data-canvas-import-md
          >
            import markdown
          </button>
          <span className="tool-sep" />
          {/* Pass 14.6 — toolbar storage pill. Click opens the slide-over. */}
          <StoragePill
            onOpen={() => setStoragePanelOpen(true)}
            bytesPerRecentSave={bytesPerRecentSave}
            refreshKey={storageRefreshKey}
          />
          <button
            className="tool-btn tool-help"
            onClick={reopenWelcome}
            title="Show the welcome hints"
            aria-label="Show welcome hints"
            data-canvas-help-button
          >
            ?
          </button>
          <a
            className="tool-btn tool-readme"
            href="/README.md"
            target="_blank"
            rel="noreferrer"
            title="Open README in a new tab"
            data-canvas-readme-link
          >
            README
          </a>
        </div>
      </header>

      {locked && (
        <div className="studio-locked-banner" role="status" data-canvas-locked-banner>
          This project is marked completed. Click &quot;Reopen&quot; to edit.
        </div>
      )}
      <div className="studio-body">
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
                onContextMenu={(e) => onNodeContextMenu(e, n)}
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

        {nodes.length === 0 && (
          <div className="studio-empty" data-canvas-empty>
            + Add a node from the toolbar, or run the demo project for a starter graph.
          </div>
        )}

        <div className="studio-help">
          drag empty space to pan · scroll to zoom · click a node to expand · drag a node to move ·
          drag from the right port to connect · click an edge then Delete to remove
        </div>

        <TestPanel
          project={liveProject}
          isOpen={testPanelOpen}
          onToggle={() => setTestPanelOpen((o) => !o)}
          locked={locked}
        />
      </div>

      {activeProject && (
        <aside className="studio-panel" aria-label="Project and node properties">
          <div className="panel-header">
            <span className="studio-eyebrow">Project</span>
            <span className="panel-id" title="Project id">{activeProject.id}</span>
          </div>

          <div className="panel-body">
            <WorkingFolderInput
              value={activeProject.workingFolder}
              onChange={handleWorkingFolderChange}
              disabled={locked}
            />

            {/* Pass 14.5 — snapshot list. Always rendered (even when empty)
                so the user knows the section exists; "no snapshots yet" line
                doubles as guidance. */}
            <SnapshotsSection
              snapshots={activeProject.snapshots ?? []}
              onRestore={restoreSnapshot}
              onDelete={deleteSnapshot}
            />

            {selectedNode ? (
              <>
                <div className="panel-divider" />
                <div className="panel-subheader">
                  <span className="studio-eyebrow">Node</span>
                  <span className="panel-id" title="Node id">{selectedNode.id}</span>
                </div>
                <label className="panel-field">
                  <span className="panel-label">Title</span>
                  <input
                    className="panel-input"
                    type="text"
                    value={selectedNode.title}
                    placeholder="Untitled node"
                    disabled={locked}
                    onChange={(e) => updateNodeField(selectedNode.id, "title", e.target.value)}
                  />
                </label>

                <label className="panel-field">
                  <span className="panel-label">Description</span>
                  <textarea
                    className="panel-input panel-textarea"
                    rows={3}
                    value={selectedNode.description}
                    disabled={locked}
                    onChange={(e) => updateNodeField(selectedNode.id, "description", e.target.value)}
                  />
                </label>

                <label className="panel-field">
                  <span className="panel-label">Role</span>
                  <select
                    className="panel-input panel-select"
                    value={selectedNode.role}
                    disabled={locked}
                    onChange={(e) => updateNodeField(selectedNode.id, "role", e.target.value)}
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="panel-field">
                  <span className="panel-label">Instructions</span>
                  <textarea
                    className="panel-input panel-textarea panel-textarea-tall"
                    rows={8}
                    value={selectedNode.instructions ?? ""}
                    placeholder="What should this node do? (system prompt, policy, etc.)"
                    disabled={locked}
                    onChange={(e) => updateNodeField(selectedNode.id, "instructions", e.target.value)}
                  />
                </label>

                <RolePromptSection
                  role={selectedNode.role}
                  overrides={activeProject.rolePromptOverrides ?? {}}
                  draftValue={roleOverrideDrafts[selectedNode.role]}
                  expanded={rolePromptExpanded}
                  onToggle={() => setRolePromptExpanded((v) => !v)}
                  onChange={(v) => setRoleOverrideDraft(selectedNode.role, v)}
                  onReset={() => resetRoleOverride(selectedNode.role)}
                />
              </>
            ) : (
              <p className="panel-empty">Select a node to edit its title, role, and instructions.</p>
            )}
          </div>

          {selectedNode && (
            <div className="panel-footer">
              <button
                className="tool-btn panel-solo-run"
                onClick={() => openSoloRun(selectedNode.id)}
                disabled={locked}
                title={locked ? "Project is completed (read-only)" : "Run only this node against Ollama; result goes to this project's run cache"}
                data-panel-solo-run
              >
                run solo
              </button>
              <button
                className="tool-btn panel-delete"
                onClick={deleteSelected}
                disabled={locked}
                title={locked ? "Project is completed (read-only)" : "Delete this node and any connected edges"}
              >
                delete node
              </button>
            </div>
          )}
        </aside>
      )}
      </div>

      {soloRunNodeId &&
        liveProject &&
        (() => {
          const target = liveProject.canvas.nodes.find((n) => n.id === soloRunNodeId);
          if (!target) return null;
          return (
            <SoloRunModal
              project={liveProject}
              node={target}
              onClose={() => setSoloRunNodeId(null)}
              onComplete={handleSoloRunComplete}
            />
          );
        })()}

      {contextMenu && (
        <div
          className="canvas-context-menu"
          style={{
            position: "fixed",
            top: contextMenu.y,
            left: contextMenu.x,
            zIndex: 60,
          }}
          role="menu"
          // Stop the global pointerdown closer from firing on our own clicks.
          onPointerDown={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="canvas-context-item"
            onClick={() => openSoloRun(contextMenu.nodeId)}
            data-canvas-context-run-solo
          >
            Run solo
          </button>
        </div>
      )}

      <WelcomeModal open={welcomeOpen} onDismiss={dismissWelcome} />

      {/* Pass 14.6 — storage slide-over panel + low-storage toast. */}
      <StoragePanel
        open={storagePanelOpen}
        onClose={() => setStoragePanelOpen(false)}
        store={store}
        onTrimRunCache={handleTrimRunCache}
        onDeleteOldestSnapshots={handleDeleteOldestSnapshots}
        onConfigChanged={handleStorageConfigChanged}
      />
      {storageToast && (
        <div className="studio-toast" role="status" data-storage-toast>
          {storageToast.text}
        </div>
      )}

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
          align-items: center;
          gap: 14px;
          line-height: 1.1;
        }
        .studio-back {
          font-size: 12px;
          color: var(--muted);
          text-decoration: none;
          padding: 4px 8px;
          border-radius: 6px;
          border: 1px solid var(--border);
          background: var(--surface);
        }
        .studio-back:hover {
          color: var(--accent-strong);
          border-color: var(--accent);
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
        .studio-body {
          flex: 1;
          display: flex;
          flex-direction: row;
          min-height: 0;
        }
        .studio-locked-banner {
          padding: 8px 18px;
          background: var(--surface-muted, #f4f3ee);
          border-bottom: 1px solid var(--border);
          color: var(--muted);
          font-size: 13px;
          text-align: center;
          font-weight: 500;
        }
        .studio-toast {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: var(--ink, #1f2520);
          color: var(--surface, #fff);
          padding: 10px 16px;
          border-radius: 8px;
          font-size: 13px;
          z-index: 70;
          box-shadow: var(--shadow-lift);
          max-width: 480px;
        }
        .studio-canvas {
          position: relative;
          flex: 1;
          min-width: 0;
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
        .studio-empty {
          position: absolute;
          inset: 0;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
          color: var(--faint);
          pointer-events: none;
          padding: 24px;
          text-align: center;
        }
        .tool-help {
          width: 32px;
          padding: 0;
          font-weight: 600;
        }
        .tool-readme {
          text-decoration: none;
          color: var(--ink);
          display: inline-flex;
          align-items: center;
        }
        .tool-readme:hover {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .studio-panel {
          width: 340px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          background: var(--surface);
          border-left: 1px solid var(--border);
          overflow-y: auto;
          z-index: 1;
        }
        .panel-header,
        .panel-subheader {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          padding: 14px 18px 10px;
        }
        .panel-header {
          border-bottom: 1px solid var(--border);
        }
        .panel-subheader {
          padding: 4px 0 6px;
        }
        .panel-divider {
          height: 1px;
          background: var(--border);
          margin: 8px 0 0;
        }
        .panel-id {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          color: var(--faint);
        }
        .panel-body {
          padding: 14px 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex: 1;
        }
        .panel-empty {
          font-size: 12px;
          color: var(--muted);
          margin: 4px 0 0;
        }
        .panel-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .panel-label {
          font-size: 11px;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .panel-input {
          width: 100%;
          padding: 8px 10px;
          font-family: inherit;
          font-size: 13px;
          color: var(--ink);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          outline: none;
          transition: border-color 100ms ease, box-shadow 100ms ease;
        }
        .panel-input:hover {
          border-color: var(--border-strong);
        }
        .panel-input:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .panel-textarea {
          resize: none;
          line-height: 1.4;
          min-height: 64px;
        }
        .panel-textarea-tall {
          min-height: 140px;
        }
        .panel-select {
          appearance: none;
          background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%),
            linear-gradient(135deg, var(--muted) 50%, transparent 50%);
          background-position:
            calc(100% - 16px) 50%,
            calc(100% - 11px) 50%;
          background-size: 5px 5px, 5px 5px;
          background-repeat: no-repeat;
          padding-right: 28px;
          cursor: pointer;
        }
        .panel-footer {
          padding: 12px 18px 18px;
          border-top: 1px solid var(--border);
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .panel-solo-run {
          width: 100%;
          background: var(--accent);
          color: #fff;
          border-color: var(--accent);
          font-weight: 600;
        }
        .panel-solo-run:hover:not(:disabled) {
          background: var(--accent-strong);
        }
        .panel-delete {
          width: 100%;
          color: var(--danger);
          border-color: var(--border);
        }
        .panel-delete:hover:not(:disabled) {
          border-color: var(--danger);
          color: var(--danger);
          background: var(--danger-soft);
        }
        .canvas-context-menu {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 8px;
          box-shadow: var(--shadow-lift);
          padding: 4px;
          min-width: 140px;
        }
        .canvas-context-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: 8px 10px;
          border-radius: 6px;
          background: transparent;
          border: 0;
          font: inherit;
          font-size: 13px;
          color: var(--ink);
          cursor: pointer;
        }
        .canvas-context-item:hover {
          background: var(--surface-muted);
          color: var(--accent-strong);
        }
        .role-prompt-section {
          border: 1px solid var(--border);
          border-radius: 8px;
          background: var(--surface);
        }
        .role-prompt-summary {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          background: transparent;
          border: 0;
          width: 100%;
          font: inherit;
          font-size: 12px;
          color: var(--ink);
          cursor: pointer;
          text-align: left;
        }
        .role-prompt-summary:hover {
          background: var(--accent-soft);
        }
        .role-prompt-chevron {
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 11px;
          color: var(--muted);
        }
        .role-prompt-overridden-badge {
          display: inline-block;
          font-size: 10px;
          letter-spacing: 0.06em;
          padding: 2px 6px;
          border-radius: 4px;
          background: var(--accent-soft);
          color: var(--accent-strong);
          margin-left: 6px;
        }
        .role-prompt-body {
          padding: 4px 12px 12px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          border-top: 1px solid var(--border);
        }
        .role-prompt-help {
          font-size: 11px;
          color: var(--muted);
          margin: 0;
        }
        .role-prompt-textarea {
          width: 100%;
          padding: 8px 10px;
          font-family: ui-monospace, "SF Mono", Menlo, monospace;
          font-size: 12px;
          line-height: 1.5;
          color: var(--ink);
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 6px;
          resize: vertical;
          outline: none;
          min-height: 160px;
        }
        .role-prompt-textarea:focus {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .role-prompt-actions {
          display: flex;
          justify-content: flex-end;
        }
        .role-prompt-reset {
          padding: 4px 10px;
          font-size: 12px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--surface);
          color: var(--muted);
          cursor: pointer;
          font-family: inherit;
        }
        .role-prompt-reset:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .role-prompt-reset:disabled {
          color: var(--faint);
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
}

// Pass 7: collapsible "Role prompt template" editor in the side panel.
// Reads `overrides[role]` if present (via parent), else pre-fills with the
// hardcoded default. Editing autosaves through `onChange` (parent debounces).
// Reset removes the override so the runtime falls back to the default.
function RolePromptSection({ role, overrides, draftValue, expanded, onToggle, onChange, onReset }) {
  const persisted = overrides && typeof overrides[role] === "string" ? overrides[role] : null;
  const hasOverride = persisted != null && persisted.trim().length > 0;
  // Draft (in-memory while debounce pending) wins over persisted, persisted
  // wins over default. Default is the hardcoded role template.
  const defaultTemplate = templateFor(role);
  const value = draftValue !== undefined ? draftValue : persisted != null ? persisted : defaultTemplate;
  // The reset button stays enabled if the persisted store has an override OR
  // if the user has typed a draft that differs from the default. Either way
  // pressing reset returns the textarea to the default template.
  const draftDiffersFromDefault = draftValue !== undefined && draftValue !== defaultTemplate;
  const canReset = hasOverride || draftDiffersFromDefault;
  return (
    <div className="role-prompt-section" data-role-prompt-section data-role={role}>
      <button
        type="button"
        className="role-prompt-summary"
        onClick={onToggle}
        aria-expanded={expanded}
        data-role-prompt-toggle
      >
        <span>
          Role prompt template
          {hasOverride && (
            <span className="role-prompt-overridden-badge" data-role-prompt-overridden>
              currently overridden
            </span>
          )}
        </span>
        <span className="role-prompt-chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="role-prompt-body">
          <p className="role-prompt-help">{`Used by every ${role} node in this project.`}</p>
          <textarea
            className="role-prompt-textarea"
            rows={10}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            data-role-prompt-textarea
            spellCheck={false}
          />
          <div className="role-prompt-actions">
            <button
              type="button"
              className="role-prompt-reset"
              onClick={onReset}
              disabled={!canReset}
              data-role-prompt-reset
              title={canReset ? "Remove override and revert to the default template" : "No override to reset"}
            >
              Reset to default
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Pass 14.5 — snapshot list in the side panel. Always rendered so the user
// knows the section exists; an empty list shows a one-line guidance string.
// Each row carries a relative time label via Intl.RelativeTimeFormat — the
// label re-computes on every render so a snapshot saved 30 seconds ago shows
// "30 seconds ago" without a timer.
function formatRelative(iso) {
  if (typeof iso !== "string") return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diffMs = t - Date.now();
  const abs = Math.abs(diffMs);
  let value;
  let unit;
  if (abs < 60_000) {
    value = Math.round(diffMs / 1000);
    unit = "second";
  } else if (abs < 3_600_000) {
    value = Math.round(diffMs / 60_000);
    unit = "minute";
  } else if (abs < 86_400_000) {
    value = Math.round(diffMs / 3_600_000);
    unit = "hour";
  } else if (abs < 30 * 86_400_000) {
    value = Math.round(diffMs / 86_400_000);
    unit = "day";
  } else if (abs < 365 * 86_400_000) {
    value = Math.round(diffMs / (30 * 86_400_000));
    unit = "month";
  } else {
    value = Math.round(diffMs / (365 * 86_400_000));
    unit = "year";
  }
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    return rtf.format(value, unit);
  } catch {
    return iso;
  }
}

function SnapshotsSection({ snapshots, onRestore, onDelete }) {
  return (
    <div className="snap-section" data-snapshots-section>
      <span className="panel-label">Snapshots</span>
      {(!snapshots || snapshots.length === 0) ? (
        <p className="snap-empty">No snapshots yet. Use &quot;save snapshot&quot; in the toolbar.</p>
      ) : (
        <ul className="snap-list">
          {snapshots.map((s) => (
            <li key={s.id} className="snap-row" data-snapshot-row data-snapshot-id={s.id}>
              <div className="snap-meta">
                <span className="snap-name" title={s.name}>{s.name}</span>
                <span className="snap-time" title={s.createdAt}>{formatRelative(s.createdAt)}</span>
              </div>
              <div className="snap-actions">
                <button
                  type="button"
                  className="snap-mini"
                  onClick={() => onRestore(s.id)}
                  data-snapshot-restore
                  title="Restore this snapshot (auto-saves current state first)"
                >
                  restore
                </button>
                <button
                  type="button"
                  className="snap-mini snap-mini-danger"
                  onClick={() => onDelete(s.id)}
                  data-snapshot-delete
                  title="Delete this snapshot"
                >
                  delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <style jsx>{`
        .snap-section {
          display: flex;
          flex-direction: column;
          gap: 6px;
          margin-top: 4px;
        }
        .snap-empty {
          font-size: 12px;
          color: var(--muted);
          margin: 0;
        }
        .snap-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 220px;
          overflow-y: auto;
        }
        .snap-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 6px;
          padding: 6px 8px;
          border: 1px solid var(--border);
          border-radius: 6px;
          background: var(--surface);
        }
        .snap-meta {
          display: flex;
          flex-direction: column;
          min-width: 0;
        }
        .snap-name {
          font-size: 12px;
          color: var(--ink);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .snap-time {
          font-size: 10px;
          color: var(--muted);
        }
        .snap-actions {
          display: flex;
          gap: 4px;
          flex-shrink: 0;
        }
        .snap-mini {
          height: 22px;
          padding: 0 8px;
          border-radius: 4px;
          border: 1px solid var(--border);
          background: var(--surface);
          font-size: 11px;
          color: var(--muted);
          cursor: pointer;
          font-family: inherit;
        }
        .snap-mini:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .snap-mini-danger:hover:not(:disabled) {
          border-color: var(--danger);
          color: var(--danger);
        }
      `}</style>
    </div>
  );
}
