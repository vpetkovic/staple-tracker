/**
 * The dependency graph, on a real canvas — G2 (STA-55).
 *
 * What this file is NOT: it is not where the layout lives (graph/graph-layout.ts), not
 * where the arrangement is persisted (graph/graph-positions.ts), not where a ticket is
 * drawn (graph/TaskNode.tsx), and not where "what is connected to this" is decided
 * (lib/graph-lineage.ts, from G1). Everything a test would want to assert about is
 * outside this component on purpose; what is left here is wiring, and wiring is the part
 * the live check covers.
 *
 * ── The one design decision worth reading ────────────────────────────────────────────
 *
 * POSITIONS ARE STATE HERE; NODES ARE DERIVED. There is no `useNodesState`.
 *
 * The alternative — React Flow holding the nodes — falls apart against this app's data
 * story. `useResource` refetches the graph whenever the fingerprint poll ticks, which is
 * any write anywhere in the workspace, roughly every 1.5 seconds while agents are
 * working. Every one of those refetches produces a new `graph` object and would want to
 * rebuild the node array — clobbering, on each tick, both the position you just dragged
 * a node to and React Flow's own in-flight drag.
 *
 * So: one `positions` record is the single source of truth for where things are. It is
 * seeded from dagre+storage when the graph's SHAPE changes (`graphSignature`, which
 * deliberately ignores title and status so a status change re-tints without relocating),
 * updated by drag, and written to storage on drag end. The nodes React Flow renders are
 * a pure function of (graph, positions, lineage). One place a coordinate can come from.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type NodeChange,
  type NodeMouseHandler,
} from "@xyflow/react";
import { Button } from "@/components/ui/button";
import { getGraph } from "@/lib/api";
import type { AuthError } from "@/lib/api";
import { applyFilters } from "@/lib/filters";
import { buildLineageIndex, edgeKey, lineageFrom, type Lineage } from "@/lib/graph-lineage";
import { useSession } from "@/lib/session";
import type { Graph, IssueStatus } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import {
  absorption,
  collapseGraph,
  isResolved,
  restrictToEpic,
  shouldDefaultCollapse,
  summarizeEpics,
} from "./graph/graph-clusters";
import {
  bridgeResolved,
  emphasisFor,
  frontier,
  unfinishedChain,
  type DoneMode,
  type Emphasis,
  type PlanningMode,
} from "./graph/graph-planning";
import {
  NODE_H,
  NODE_W,
  connectedNodes,
  dagreLayout,
  graphSignature,
  mergePositions,
  type XY,
} from "./graph/graph-layout";
import { clearPositions, loadPositions, positionsKey, savePositions } from "./graph/graph-positions";
import {
  buildSvg,
  copyText,
  downloadBlob,
  svgToPngBlob,
  type ExportColors,
  type ExportEdge,
  type ExportNode,
} from "./graph/graph-export";
import {
  GRAPH_PARAM,
  decodeGraphView,
  withGraphView,
  type GraphViewState,
} from "./graph/graph-share";
import { EpicControls, GraphToolbar } from "./graph/GraphToolbar";
import { nodeTypes, type GraphFlowNode } from "./graph/node-types";
import { EmptyState, NoMatchesState, ViewState } from "./ViewChrome";

/** Height is explicit because React Flow measures its container and the shell scrolls. */
/*
 * V2 (STA-87): was `h-[calc(100vh-13rem)] min-h-[26rem]`. That 13rem was a hard-coded
 * guess at the height of the app header plus this view's own toolbar, and it was wrong
 * the moment the header changed — which is exactly what STA-87 did. The canvas now takes
 * the space that is left, because the shell hands this view a real box to fill instead of
 * a scrolling page to measure against the viewport.
 */
const CANVAS_CLASS = "min-h-0 w-full flex-1 rounded-lg border bg-card";

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-4 px-1 py-2 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <svg width="18" height="8" aria-hidden>
          <line x1="0" y1="4" x2="18" y2="4" className="staple-graph-edge" />
        </svg>
        blocks (same workspace)
      </span>
      <span className="flex items-center gap-1.5">
        <svg width="18" height="8" aria-hidden>
          <line x1="0" y1="4" x2="18" y2="4" className="staple-graph-edge cross" />
        </svg>
        blocks (cross-workspace)
      </span>
      <span className="text-muted-foreground/70">hover or select a task to trace its chain</span>
    </div>
  );
}

/** Minimap dots read as status, which is the only thing legible at that size. */
const MINIMAP_COLORS: Record<IssueStatus, string> = {
  backlog: "var(--status-task-backlog)",
  todo: "var(--status-task-todo)",
  in_progress: "var(--status-task-in_progress)",
  in_review: "var(--status-task-in_review)",
  done: "var(--status-task-done)",
  blocked: "var(--status-task-blocked)",
  cancelled: "var(--status-task-cancelled)",
};

function GraphCanvas({
  graph,
  hiddenByFilter,
}: {
  graph: Graph;
  /**
   * Ticket ids the global filter (V4/STA-89) excluded, EXCLUDING resolved work — that is
   * handled by `doneMode` below, which also bridges the edges it hides.
   */
  hiddenByFilter: ReadonlySet<string>;
}) {
  const session = useSession();
  const [hovered, setHovered] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, XY>>({});

  /**
   * The shared link, read ONCE (G5).
   *
   * Read at mount rather than subscribed to, because a component that kept tracking the
   * URL would fight the user the instant they touched a control — and the URL is being
   * rewritten by this same component, so it would also fight itself. `null` means the
   * visitor arrived without a prepared view, which is a different thing from arriving
   * with an empty one; see decodeGraphView.
   */
  const [shared] = useState<GraphViewState | null>(() =>
    decodeGraphView(new URLSearchParams(window.location.search).get(GRAPH_PARAM)),
  );

  const storageKey = positionsKey(session.mode, session.ws);

  // Only tickets that participate in a dependency; see connectedNodes().
  const drawn = useMemo(() => connectedNodes(graph.nodes, graph.edges), [graph]);

  /**
   * Epics are derived from the FULL node list, not `drawn`, because an epic usually
   * blocks nothing itself and so is not drawn — its title has to come from somewhere.
   * Empty in hub mode, where the payload carries no `parent` (see GraphNode.parent).
   */
  const epics = useMemo(() => summarizeEpics(graph.nodes, drawn), [graph.nodes, drawn]);

  /**
   * Which epics are collapsed. Seeded ONCE, on mount, and never re-derived.
   *
   * The default has to be an initializer rather than an effect: a default re-applied
   * when the poll delivered a 25th node would silently re-collapse an epic the user had
   * just expanded, while they were reading it. Mount is also the right granularity
   * because the provider is keyed on `mode:ws` (see GraphView) — switching scope
   * remounts this component, which is exactly when "is this graph big enough to need
   * collapsing" deserves a fresh answer.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => {
    // A shared link OVERRIDES the size default, including when it says "nothing is
    // collapsed" — that is the sender's arrangement, and re-collapsing it on arrival
    // would defeat the point of having sent it.
    if (shared) return new Set(shared.collapsed);
    return shouldDefaultCollapse(drawn.length) ? new Set(epics.map((epic) => epic.id)) : new Set();
  });

  /** Pin the canvas to one epic's members. null = the whole graph. */
  const [epicFilter, setEpicFilter] = useState<string | null>(shared?.epicFilter ?? null);

  /**
   * G4's two controls. Both default to the plain graph: a view that opened already
   * filtered would make the first question in any meeting "why is half of it missing".
   * `fade` is tempting as a default and is still a lie by omission on first paint.
   */
  const [mode, setMode] = useState<PlanningMode>(shared?.mode ?? "off");

  /**
   * V4 (STA-89) TOOK THE DEFAULT AWAY FROM THIS CONTROL.
   *
   * `doneMode` used to default to "show", on the reasoning that a canvas which opened
   * already filtered makes the first question in any meeting "why is half of it missing".
   * That reasoning was right about the graph in isolation and wrong about the app: the
   * tree now hides resolved work by default, and a graph that showed it would mean the
   * two views disagreed about what "the current plan" is. The global toggle decides;
   * a shared link still wins over both, because that is somebody's prepared arrangement.
   *
   * The three-way control stays. `fade` is a genuinely useful canvas-only state with no
   * equivalent in a list — "this is done, and here is where it sits in the chain" — so
   * the toolbar remains a local REFINEMENT of the global answer rather than a duplicate
   * of it. Flipping the global toggle resets this to match, which is the effect below.
   */
  const [doneMode, setDoneMode] = useState<DoneMode>(
    shared?.doneMode ?? (session.filters.showDone ? "show" : "hide"),
  );
  const globalShowDone = session.filters.showDone;
  const lastGlobal = useRef(globalShowDone);
  useEffect(() => {
    if (lastGlobal.current === globalShowDone) return;
    lastGlobal.current = globalShowDone;
    setDoneMode(globalShowDone ? "show" : "hide");
  }, [globalShowDone]);

  const activeFilter = useMemo(
    // A filter naming an epic that has since vanished must fall back to the whole graph
    // rather than render an empty canvas nobody can explain.
    () => epics.find((epic) => epic.id === epicFilter) ?? null,
    [epics, epicFilter],
  );

  /**
   * The canvas, in one derivation: filter to an epic, then substitute super-nodes.
   *
   * Order matters. Filtering first means the collapse set applies to what survived, so
   * pinning to an epic and collapsing another one cannot interact; collapsing first
   * would have to un-collapse to find out whether a member passed the filter.
   */
  const canvas = useMemo(() => {
    const scoped = restrictToEpic(drawn, graph.edges, activeFilter);
    return collapseGraph(scoped.nodes, scoped.edges, epics, collapsed);
  }, [drawn, graph.edges, activeFilter, epics, collapsed]);

  /**
   * Every box reduced to what the planning modes need (G4). A collapsed epic contributes
   * its AGGREGATE status, so "which of these is ready" is answerable at whatever level
   * the canvas is currently drawn — the planning module never learns clusters exist.
   */
  const planning = useMemo(
    () =>
      canvas.nodes.map((node) => ({
        id: node.id,
        status: node.kind === "cluster" ? node.epic.status : node.task.status,
      })),
    [canvas.nodes],
  );

  /**
   * Finished work, and what to do about it (G4).
   *
   * `hide` removes the nodes and BRIDGES their edges — see bridgeResolved. Hiding
   * without bridging would split the plan into islands and claim two connected tickets
   * are unrelated, so the two always happen together.
   */
  const resolvedIds = useMemo(
    () => new Set(planning.filter((node) => isResolved(node.status)).map((node) => node.id)),
    [planning],
  );
  /**
   * Everything off the canvas, from both causes, in one set — V4 (STA-89).
   *
   * The global filter's exclusions ride the SAME mechanism as hidden done work, and that
   * is the whole reason this is one set rather than a second filter applied later:
   * `bridgeResolved` below is what keeps the plan connected when nodes disappear. Dropping
   * filtered nodes without bridging would split the graph into islands and quietly claim
   * two dependent tickets are unrelated — which is a worse lie than showing them.
   *
   * One known limit, stated rather than papered over: `hiddenByFilter` holds TICKET ids,
   * so a filtered-out ticket inside a COLLAPSED epic does not remove anything — the
   * cluster stands for the epic as a whole and keeps its aggregate. Expanding the epic
   * applies the filter to its members as normal.
   */
  const hidden = useMemo(() => {
    const out = new Set<string>(hiddenByFilter);
    if (doneMode === "hide") for (const id of resolvedIds) out.add(id);
    return out;
  }, [doneMode, resolvedIds, hiddenByFilter]);

  const nodes = useMemo(
    () => canvas.nodes.filter((node) => !hidden.has(node.id)),
    [canvas.nodes, hidden],
  );
  const bridged = useMemo(() => bridgeResolved(canvas.edges, hidden), [canvas.edges, hidden]);
  /** The edge list dagre and the lineage index work on: post-collapse, post-bridge. */
  const pairs = useMemo(() => bridged.map(({ from, to }) => ({ from, to })), [bridged]);

  /**
   * The signature is computed over the FINAL lists — collapsed, then filtered, then
   * bridged — which is how both the collapse set and the done mode get folded in without
   * `graphSignature` growing an argument: either one changes which ids and which edge
   * pairs exist, so the signature changes and the layout effect below re-seeds. Toggling
   * a cluster or hiding done work re-runs dagre; a poll still does not.
   */
  const signature = useMemo(() => graphSignature(nodes, pairs), [nodes, pairs]);

  /**
   * The seeding effect keys on the SHAPE, not on `graph`.
   *
   * `graph` is read through a ref rather than listed as a dependency, and that is the
   * whole trick: listing it would re-run this on every poll and undo every drag. The ref
   * is always current because it is assigned during render, and the only thing this
   * effect reads out of it — ids and edges — is exactly what `signature` already
   * summarises. So "the signature changed" and "the ref holds something new" are the
   * same event by construction.
   */
  const latest = useRef({ nodes, edges: pairs });
  latest.current = { nodes, edges: pairs };

  useEffect(() => {
    const { nodes: current, edges } = latest.current;
    const canonical = dagreLayout(current, edges);
    setPositions(mergePositions(canonical, loadPositions(window.localStorage, storageKey)));
  }, [signature, storageKey]);

  /** Auto-arrange: back to canonical, and forget the manual arrangement for good. */
  const autoArrange = useCallback(() => {
    const { nodes: current, edges } = latest.current;
    clearPositions(window.localStorage, storageKey);
    setPositions(dagreLayout(current, edges));
  }, [storageKey]);

  /**
   * Collapse controls. Each returns a NEW Set rather than mutating: the collapse set is
   * a dependency of the memo chain that produces the canvas, and a mutated Set has the
   * same identity, so nothing downstream would recompute and the toggle would appear to
   * do nothing.
   */
  const toggleEpic = useCallback((epic: string) => {
    setCollapsed((previous) => {
      const next = new Set(previous);
      if (!next.delete(epic)) next.add(epic);
      return next;
    });
  }, []);

  const expandOne = useCallback((epic: string) => {
    setCollapsed((previous) => {
      if (!previous.has(epic)) return previous;
      const next = new Set(previous);
      next.delete(epic);
      return next;
    });
  }, []);

  const collapseAll = useCallback(
    () => setCollapsed(new Set(epics.map((epic) => epic.id))),
    [epics],
  );
  const expandAll = useCallback(() => setCollapsed(new Set()), []);

  /**
   * Reopen the ticket a shared link was aimed at (G5).
   *
   * An effect rather than an initializer because opening the detail panel is a call into
   * the session, not local state, and doing it during render would be a side effect in
   * the wrong phase. It runs once: `session.open` is not in the dependency list on
   * purpose, because re-running this would reopen the panel every time the user closed
   * it. The empty-ish dependency list is the point, not an oversight.
   */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !shared?.target) return;
    restored.current = true;
    const node = graph.nodes.find((candidate) => candidate.id === shared.target);
    // A target that no longer exists is not an error — the link simply outlived it.
    if (node) session.open(node.workspace, node.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shared, graph.nodes]);

  /**
   * Built once per shape; walked once per hover. G1's seam, used as intended.
   *
   * Over the CANVAS edges rather than the raw ones, so that hovering a collapsed epic
   * traces the chain at the level being displayed — cluster to cluster. Walking the raw
   * edges here would return ticket ids that no longer name anything on screen, and the
   * highlight would light nothing.
   */
  const index = useMemo(() => buildLineageIndex(pairs), [pairs]);

  /**
   * Selection is mapped through `absorption` because the detail panel deals in tickets
   * and the canvas may currently be drawing that ticket as part of a super-node. Without
   * the mapping, opening a ticket inside a collapsed epic would trace nothing — the
   * dimming would be total, which reads as a bug rather than as "it is in there".
   */
  const absorbed = useMemo(() => absorption(epics, collapsed), [epics, collapsed]);
  const selected = session.selection?.ref ?? null;
  const target = selected ? (absorbed.get(selected) ?? selected) : null;

  /** Path-to-target has nothing to answer about a target that is not on the canvas. */
  const hasTarget = target !== null && nodes.some((node) => node.id === target);

  const hoverLineage = useMemo<Lineage | null>(
    () => (hovered ? lineageFrom(index, hovered) : null),
    [index, hovered],
  );
  const selectionLineage = useMemo<Lineage | null>(
    () => (target ? lineageFrom(index, target) : null),
    [index, target],
  );

  // Computed only when its mode is on: both walk the whole graph, and doing that on
  // every poll to throw the answer away is exactly the waste G2 went to lengths to avoid.
  const frontierSet = useMemo(
    () => (mode === "frontier" ? frontier(planning, pairs) : null),
    [mode, planning, pairs],
  );
  const pathChain = useMemo(
    () => (mode === "path" && hasTarget && target ? unfinishedChain(planning, pairs, target) : null),
    [mode, hasTarget, target, planning, pairs],
  );

  /**
   * One emphasis, chosen by one rule (graph-planning.ts): hover > mode > selection.
   * `null` dims nothing, which is the contract G1 established and every mode inherits.
   */
  const emphasis = useMemo<Emphasis | null>(
    () => emphasisFor({ hoverLineage, mode, frontierSet, pathChain, selectionLineage }),
    [hoverLineage, mode, frontierSet, pathChain, selectionLineage],
  );

  /** The node the emphasis is being traced FROM, for the focus ring. */
  const focus = hovered ?? (mode === "path" && hasTarget ? target : (target ?? null));

  /**
   * `fade` keeps finished work on the canvas at low opacity. It is deliberately NOT the
   * same visual as `dim`: dim means "not part of what you asked about" and comes and
   * goes with the pointer, while faded means "this is done", which is a fact about the
   * ticket. Two different sentences earn two different opacities.
   */
  const faded = doneMode === "fade" ? resolvedIds : null;

  const showWorkspace = session.mode === "hub";

  /**
   * The view state, as one value — the thing the link encodes and the thing the URL is
   * kept in step with.
   */
  const viewState = useMemo<GraphViewState>(
    () => ({ mode, doneMode, epicFilter, collapsed: [...collapsed], target: selected }),
    [mode, doneMode, epicFilter, collapsed, selected],
  );

  /**
   * Keep the address bar in step, so "copy the URL" works as well as the button does.
   *
   * `replaceState`, never `pushState`: every toggle would otherwise become a history
   * entry and Back would stop meaning "the page I was on before". `withGraphView` rebuilds
   * the URL from the CURRENT href and sets exactly one parameter, which is what keeps
   * `token` untouched — it is never read here, never re-encoded, never reordered.
   */
  useEffect(() => {
    const next = withGraphView(window.location.href, viewState);
    if (next !== window.location.href) window.history.replaceState(null, "", next);
  }, [viewState]);

  const [copied, setCopied] = useState<string | null>(null);
  const copyLink = useCallback(() => {
    const link = withGraphView(window.location.href, viewState);
    /*
     * `copyText` tries the real clipboard API and falls back to execCommand — see the
     * note there. The result is REPORTED rather than assumed: a silent failure leaves
     * someone pasting whatever was in the clipboard before, into a meeting. And because
     * the address bar is already kept in step with this exact state, "copy failed" still
     * leaves a working way to share — the URL is right there.
     */
    void copyText(link).then((ok) => setCopied(ok ? "link copied" : "copy failed — use the URL"));
    setTimeout(() => setCopied(null), 2200);
  }, [viewState]);

  /**
   * Export (G5). Geometry comes from `positions` and the node list — the same data dagre
   * laid out — so the file cannot disagree with the screen. Only the edge SHAPES are read
   * from the DOM, because smoothstep routing is React Flow's and re-deriving it would be
   * a second, worse implementation of it.
   */
  const exportView = useCallback(
    async (format: "svg" | "png") => {
      const canvasEl = document.querySelector('[data-testid="graph-canvas"]');
      const styles = canvasEl ? getComputedStyle(canvasEl) : null;
      const readVar = (name: string, fallback: string) =>
        styles?.getPropertyValue(name).trim() || fallback;

      const colors: ExportColors = {
        background: readVar("--card", "#ffffff"),
        card: readVar("--card", "#ffffff"),
        border: readVar("--border", "#e5e5e5"),
        text: readVar("--card-foreground", "#111111"),
        muted: readVar("--muted-foreground", "#777777"),
      };

      const exportNodes: ExportNode[] = nodes.map((node) => {
        const at = positions[node.id] ?? { x: 0, y: 0 };
        const status = node.kind === "cluster" ? node.epic.status : node.task.status;
        return {
          x: at.x,
          y: at.y,
          w: NODE_W,
          h: NODE_H,
          label:
            node.kind === "cluster"
              ? `${showWorkspace ? `${node.epic.workspace} · ` : ""}${node.epic.id}`
              : `${showWorkspace ? `${node.task.workspace} · ` : ""}${node.id}`,
          title: node.kind === "cluster" ? node.epic.title : node.task.title,
          // Resolved here, not in the SVG: a `var(--…)` inside an exported file refers to
          // a custom property that does not exist once the file leaves the page.
          accent: readVar(`--status-task-${status}`, colors.muted),
          badge: node.kind === "cluster" ? `${node.epic.resolved}/${node.epic.total} done` : undefined,
          cluster: node.kind === "cluster",
          faded: faded?.has(node.id) ?? false,
        };
      });

      /*
       * Edge shapes, by index. `flowEdges` and the rendered paths are the same list in
       * the same order, so position in the DOM is the join key — matching on the `d`
       * string instead would fail on two edges that happen to be routed identically.
       */
      const drawnPaths = canvasEl?.querySelectorAll<SVGPathElement>(".react-flow__edge-path") ?? [];
      const exportEdges: ExportEdge[] = [...drawnPaths].flatMap((path, i) => {
        const d = path.getAttribute("d");
        const source = bridged[i];
        if (!d || !source) return [];
        return [{ d, cross: !source.derived && source.edge.cross, derived: source.derived }];
      });

      const svg = buildSvg({
        nodes: exportNodes,
        edges: exportEdges,
        colors,
        caption: `staple · ${session.mode === "hub" ? "all workspaces" : session.ws || "workspace"} · ${new Date().toISOString().slice(0, 10)}`,
      });

      const stamp = new Date().toISOString().slice(0, 10);
      if (format === "svg") {
        downloadBlob(new Blob([svg], { type: "image/svg+xml" }), `staple-graph-${stamp}.svg`);
        return;
      }
      downloadBlob(await svgToPngBlob(svg), `staple-graph-${stamp}.png`);
    },
    [nodes, positions, bridged, faded, showWorkspace, session.mode, session.ws],
  );

  const flowNodes = useMemo<GraphFlowNode[]>(
    () =>
      nodes.map((node): GraphFlowNode => {
        /**
         * Everything both kinds of box share. The only difference between a ticket and a
         * collapsed epic on this canvas is which component draws it and what it carries
         * in `data` — same size, same position source, same dim/focus rules.
         *
         * SIZE IS DECLARED RATHER THAN MEASURED, and it has to be declared HERE.
         *
         * React Flow normally learns a node's size by measuring the DOM and writing the
         * result back through an `onNodesChange` "dimensions" event. This component
         * derives its nodes fresh from `positions` on every render and applies only
         * position changes, so a measured size would be discarded on the next render —
         * and anything downstream of size silently gets nothing. The minimap is that
         * downstream: without this it draws an empty box.
         *
         * Stating the size is honest rather than a workaround: both cards ARE fixed at
         * NODE_W × NODE_H, and dagre already laid the graph out on that assumption.
         */
        const shared = {
          id: node.id,
          position: positions[node.id] ?? { x: 0, y: 0 },
          width: NODE_W,
          height: NODE_H,
          // The card is the drag handle; React Flow adds its own. Nothing is connectable.
          connectable: false,
          // `emphasis === null` means nothing was asked, which must dim NOTHING.
          dim: emphasis ? !emphasis.nodes.has(node.id) : false,
          focused: focus === node.id,
        };
        const { dim, focused, ...box } = shared;
        /*
         * Fade is an inline style rather than a class because it must NOT compete with
         * the dim/lit vocabulary in app.css — a faded node that is also dimmed should
         * read as dimmed, and the two are applied to different elements (this wrapper
         * vs. the card inside), so they multiply instead of fighting.
         */
        const style = faded?.has(node.id) && !dim ? { opacity: 0.32 } : undefined;

        if (node.kind === "cluster") {
          return {
            ...box,
            style,
            type: "cluster" as const,
            data: { epic: node.epic, showWorkspace, dim, focused, onExpand: expandOne },
          };
        }
        return {
          ...box,
          style,
          type: "task" as const,
          data: { node: node.task, showWorkspace, dim, focused },
        };
      }),
    [nodes, positions, emphasis, faded, focus, showWorkspace, expandOne],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      bridged.map((link, i) => {
        const { edge, from, to, derived } = link;
        const lit = emphasis?.edges.has(edgeKey(from, to)) ?? false;
        const dim = emphasis ? !lit : false;
        return {
          // Index is in the id because a duplicated dependency row would otherwise
          // collide and React Flow would drop one of them silently.
          id: `${from}->${to}#${i}`,
          source: from,
          target: to,
          type: "smoothstep",
          // Semantics live in the class; app.css turns them into pixels. `cross` is the
          // same class name the legend swatches use, so the two cannot drift apart.
          // A bridged edge is never `cross`: the workspaces it passed through are
          // precisely the information that was hidden, so claiming either answer would
          // be making it up.
          className: [
            "staple-rf-edge",
            !derived && edge.cross ? "cross" : "",
            emphasis ? (lit ? "lineage" : "dim") : "",
          ]
            .filter(Boolean)
            .join(" "),
          /*
           * A bridged edge is dotted, and inline rather than a class so that no new CSS
           * has to know about it. It is a DIFFERENT dash pattern from the cross-workspace
           * dash (5 4) on purpose — two dashed lines meaning different things would be
           * the graph's third ambiguity, and this one reads as "inferred", not "crosses".
           *
           * Not applied when the edge is dimmed: the dim class owns opacity, and an
           * inline style here would override it and make ignored edges the loudest.
           */
          style: derived && !dim ? { strokeDasharray: "1 4", opacity: 0.7 } : undefined,
          /*
           * How many real dependencies this one arrow stands for. Only shown when it
           * stands for more than one — labelling every ordinary edge "×1" would add a
           * hundred pieces of text to say nothing. A bridged edge carries no count: it
           * says "there is a path", not "there are n dependencies".
           */
          label: !derived && edge.count > 1 ? `×${edge.count}` : undefined,
          labelShowBg: false,
          labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        };
      }),
    [bridged, emphasis],
  );

  /**
   * Drag. Only position changes are applied — selection and dimensions are React Flow's
   * business, and this app's idea of "selected" is `session.selection`, not the canvas's.
   */
  const onNodesChange = useCallback((changes: NodeChange<GraphFlowNode>[]) => {
    const moves = changes.filter(
      (change): change is Extract<NodeChange<GraphFlowNode>, { type: "position" }> =>
        change.type === "position" && change.position !== undefined,
    );
    if (moves.length === 0) return;
    setPositions((previous) => {
      const next = { ...previous };
      for (const move of moves) if (move.position) next[move.id] = move.position;
      return next;
    });
  }, []);

  /**
   * Persist on drag END, not on every frame. A drag emits a position change per pointer
   * move; writing localStorage on each one is a synchronous serialize-and-store per
   * frame, which is exactly how a smooth drag becomes a stuttering one.
   */
  const onNodeDragStop = useCallback(() => {
    setPositions((current) => {
      savePositions(window.localStorage, storageKey, current);
      return current;
    });
  }, [storageKey]);

  /**
   * Clicking a box opens the ticket it stands for — including a super-node, which stands
   * for a real epic ticket with a real detail panel. Expanding is the chevron's job (see
   * ClusterNode), so that "click a node, read the node" survives collapsing.
   */
  const onNodeClick = useCallback<NodeMouseHandler<GraphFlowNode>>(
    (_event, node) =>
      node.type === "cluster"
        ? session.open(node.data.epic.workspace, node.data.epic.id)
        : session.open(node.data.node.workspace, node.id),
    [session],
  );

  const onNodeMouseEnter = useCallback<NodeMouseHandler<GraphFlowNode>>(
    (_event, node) => setHovered(node.id),
    [],
  );
  const onNodeMouseLeave = useCallback(() => setHovered(null), []);

  if (nodes.length === 0) {
    // Same distinction the tree makes: a graph with nothing in it and a graph the filter
    // emptied are different facts, and only one of them is fixed by clearing filters.
    return hidden.size > 0 ? (
      <NoMatchesState noun="dependencies" />
    ) : (
      <EmptyState>no dependencies yet — add some with blocked-by or a cross-workspace link</EmptyState>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <Legend />
        <div className="flex flex-wrap items-center gap-1.5">
          <GraphToolbar
            mode={mode}
            onMode={setMode}
            doneMode={doneMode}
            onDoneMode={setDoneMode}
            hasTarget={hasTarget}
            onExport={(format) => void exportView(format)}
            onCopyLink={copyLink}
            copied={copied}
          />
          <EpicControls
            epics={epics}
            collapsed={collapsed}
            onToggle={toggleEpic}
            onCollapseAll={collapseAll}
            onExpandAll={expandAll}
            filter={epicFilter}
            onFilter={setEpicFilter}
          />
          <Button type="button" variant="outline" size="sm" onClick={autoArrange}>
            auto-arrange
          </Button>
        </div>
      </div>
      <div className={CANVAS_CLASS} data-testid="graph-canvas">
        <ReactFlow<GraphFlowNode>
          nodes={flowNodes}
          edges={flowEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          onNodeMouseEnter={onNodeMouseEnter}
          onNodeMouseLeave={onNodeMouseLeave}
          // Dependencies are a store write, never a canvas gesture.
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: false }}
          minZoom={0.1}
          maxZoom={2}
          // Only on the first arrangement: re-fitting after every poll would yank the
          // viewport out from under someone who had zoomed in on a corner.
          fitView
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        >
          <Background gap={20} size={1} />
          <Controls showInteractive={false} />
          <MiniMap
            pannable
            zoomable
            // A collapsed epic shows its AGGREGATE status, so the minimap keeps saying
            // the same thing the canvas does at whatever level it is currently drawn.
            nodeColor={(node) => {
              const box = node as GraphFlowNode;
              return MINIMAP_COLORS[
                box.type === "cluster" ? box.data.epic.status : box.data.node.status
              ];
            }}
            nodeStrokeWidth={0}
            className="!bg-card"
          />
        </ReactFlow>
      </div>
    </>
  );
}

export function GraphView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const load = useCallback(() => getGraph(), []);
  const resource = useResource(load, [session.version], onAuthError);

  /**
   * The global filter, translated into graph terms — V4 (STA-89).
   *
   * `/api/graph` carries id, workspace, title, status and parent. It does not carry
   * assignee, priority or labels, so the filter cannot be evaluated against a node. It
   * CAN be evaluated against the issue the node stands for, and the node id IS the
   * identifier, so the join is exact: run the same `applyFilters` the tree runs, and
   * hide the nodes whose issue did not survive.
   *
   * TWO DELIBERATE CHOICES IN HERE:
   *
   *   `showDone: true` — resolved work is excluded from THIS set and left to `doneMode`,
   *     which hides it *and bridges the edges through it*. Hiding a finished ticket that
   *     three others hang off would otherwise strand them.
   *
   *   A node with no matching issue is KEPT. In hub mode the graph reaches across
   *     workspace files that this fetch may not have loaded, and "I have no record of
   *     this ticket" is not evidence that it fails the filter. Showing something the
   *     filter might have excluded is a recoverable error; hiding work on a guess is not.
   */
  const hiddenByFilter = useMemo(() => {
    const rows = session.issues.data;
    const graph = resource.data;
    if (!rows || !graph || rows.length === 0) return new Set<string>();
    const known = new Set(rows.map((row) => row.issue.identifier));
    const survives = new Set(
      applyFilters(rows, { ...session.filters, showDone: true }).map((row) => row.issue.identifier),
    );
    return new Set(
      graph.nodes
        .filter((node) => known.has(node.id) && !survives.has(node.id))
        .map((node) => node.id),
    );
  }, [session.issues.data, session.filters, resource.data]);

  return (
    // A column that fills the shell's content box: toolbar at its natural height, canvas
    // taking the rest. Unlike the tree, this view is INSET rather than full-bleed — a
    // canvas is a single object you look at, not a list that runs to the edge of the
    // window, and the border is what says where the coordinate space stops.
    <div className="flex h-full flex-col gap-2 px-4 py-3">
      <ViewState resource={resource} empty="no dependencies yet">
        {(graph) => (
          // Keyed by scope: switching hub/workspace or the ws filter is a different
          // picture with a different saved arrangement, and remounting is the honest way
          // to reset the viewport and the position state together.
          <ReactFlowProvider key={`${session.mode}:${session.ws}`}>
            <GraphCanvas graph={graph} hiddenByFilter={hiddenByFilter} />
          </ReactFlowProvider>
        )}
      </ViewState>
    </div>
  );
}
