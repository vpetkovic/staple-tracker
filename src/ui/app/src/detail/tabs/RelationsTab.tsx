/**
 * The graph view, pointed at one ticket — O2b (STA-132), rebuilt by O2c (STA-155).
 *
 * ── What changed and why ─────────────────────────────────────────────────────────────
 *
 * O2b drew this tab with its own layout module, its own node wrapper and its own axis:
 * ancestors above, children below, dependencies down the page. Every piece of that was
 * defensible on its own and the whole was wrong, because the app's other canvas runs
 * dependencies ACROSS the page. Two diagrams that disagree about which direction means
 * "before" is worse than either of them alone. VP's review, in one sentence: *the same
 * view and look as the graph section, except it only shows the tree related to the task
 * in question*.
 *
 * So there is no second pipeline any more. `views/graph/graph-canvas.ts` is the canvas
 * derivation both views call; this file is the other caller. Same `TaskNode`, same
 * `EpicContainerNode`, same edge classes, same `MarkerType`, same emphasis rule, same
 * dagre `rankdir: LR` — the only difference is which sub-graph goes in.
 *
 * ── The two axes, resolved ───────────────────────────────────────────────────────────
 *
 * The old tab needed two axes because it fed BOTH relations to the layout as edges: a
 * parent edge and a blocks edge competing for one `rankdir`. The graph view never had
 * that problem, because it does not draw parenthood as an arrow — it draws it as a BOX.
 * Doing the same here dissolves the conflict rather than working around it: ancestors
 * become nested containers (`summarizeEpics` reads `GraphNode.parent`, `containerize`
 * turns each into a box), the focus becomes the innermost box when it has children, and
 * the only edges dagre ever ranks are dependencies. Predecessors left, successors right,
 * at every depth, by the same call the big canvas makes.
 *
 * ── What is NOT in this file ─────────────────────────────────────────────────────────
 *
 * Which boxes and arrows:   lib/relation-context.ts        (O2a, imported, not modified)
 * How they become a canvas: views/graph/graph-canvas.ts    (shared with GraphView)
 * Where they go:            views/graph/graph-layout.ts    (compoundLayout, unchanged)
 * What the strip says:      detail/relation-stats.ts       (pure, tested)
 * What a box looks like:    views/graph/TaskNode.tsx, EpicContainerNode.tsx (read-only)
 * What an arrow means:      styles/app.css                 (read-only, reused verbatim)
 *
 * There are no component tests for logic in this repo, so logic inside a `.tsx` is logic
 * nothing checks. Everything a test would want to assert about was pushed out on purpose;
 * what is left here is wiring.
 *
 * ── Read-only, and why that is not a limitation ──────────────────────────────────────
 *
 * No dragging, no persisted positions, no toolbar, no picker, no export, no share link,
 * no minimap. The big canvas earns all of those because it is a workspace you arrange;
 * this is a diagram you read, and every one of them would be a second place a position
 * could be remembered and later disagree. The two the ticket does ask for — Background
 * and zoom Controls — are the two that cost nothing to be wrong about.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type NodeMouseHandler,
} from "@xyflow/react";
import { getGraph } from "@/lib/api";
import { buildLineageIndex, lineageFrom, type Lineage } from "@/lib/graph-lineage";
import { relationContext, type RelationContext } from "@/lib/relation-context";
import { useSession } from "@/lib/session";
import type { Graph } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useResource } from "@/lib/useStaple";
import {
  canvasDimmed,
  canvasFlowEdges,
  canvasFlowNodes,
  canvasTicket,
  expandedCanvasShape,
} from "@/views/graph/graph-canvas";
import { compoundLayout } from "@/views/graph/graph-layout";
import { emphasisFor, type Emphasis } from "@/views/graph/graph-planning";
import { selectionTarget } from "@/views/graph/graph-folding";
import { nodeTypes, type GraphFlowNode } from "@/views/graph/node-types";
import { EmptyState, ErrorState, LoadingState } from "@/views/ViewChrome";
import { relationStats } from "../relation-stats";
import type { TabProps } from "./registry";

/** Collapsing has no meaning on a canvas that exists to show one tree fully expanded. */
const noop = () => {};

/**
 * The strip. Numbers only — every one of them came off `RelationCounts`, so this cannot
 * drift from the canvas below it, and the sentences are pinned by a test next door.
 */
function StatsStrip({ context }: { context: RelationContext }) {
  const stats = useMemo(() => relationStats(context.counts), [context.counts]);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {stats.map((stat, index) => (
        <span key={stat.key} className="flex items-center gap-2">
          {index > 0 ? <span aria-hidden>·</span> : null}
          <span className={cn("tabular-nums", stat.blocked && "text-[var(--status-task-blocked)]")}>
            {stat.text}
          </span>
        </span>
      ))}
    </div>
  );
}

/**
 * Re-frame when the SHAPE changes, not when the data does.
 *
 * `fitView` as a prop only runs on the first arrangement, which is right for mount and
 * useless for prev/next: the panel keeps this component mounted and hands it a new focus,
 * and without this the reader would arrive on the next ticket looking at the previous
 * one's corner of the coordinate space. Keyed on the canvas signature so a status change
 * — which re-tints without relocating anything — does not move the viewport.
 */
function FitOnFocus({ signature }: { signature: string }) {
  const flow = useReactFlow();
  useEffect(() => {
    // Deferred a frame: on the render that introduces new nodes React Flow has not
    // measured them yet, and fitting against unmeasured boxes lands on the wrong zoom.
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: 0.16, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [flow, signature]);
  return null;
}

function RelationCanvas({
  context,
  showWorkspace,
}: {
  context: RelationContext;
  /** Hub mode prefixes every identifier with its workspace — the graph view's own rule. */
  showWorkspace: boolean;
}) {
  const session = useSession();
  const [hovered, setHovered] = useState<string | null>(null);

  /**
   * The canvas, from O2a's sub-graph. Blocks edges only — parenthood is expressed by the
   * containers `expandedCanvasShape` builds out of `GraphNode.parent`, which is what
   * leaves dagre one axis to rank and makes this view flow left-to-right like the other.
   */
  const shape = useMemo(
    () =>
      expandedCanvasShape(
        context.graph.nodes,
        context.graph.edges.filter((edge) => edge.kind === "blocks"),
      ),
    [context],
  );
  const { nodes, containment, links, pairs, compound, signature } = shape;

  /**
   * Positions are DERIVED here, where the graph view holds them as state.
   *
   * That view has drag, storage and `relayout` to reconcile, and O4d's whole subject is
   * keeping coordinates still across those. This canvas has none of them: the arrangement
   * is a pure function of the shape, so `compoundLayout` — the canonical arrangement,
   * the thing the graph's Auto-arrange restores you to — is the only thing that needs to
   * run, and it runs when the SHAPE changes rather than when the poll delivers a new
   * object. The ref is the same trick GraphView uses for the same reason: listing
   * `compound`/`pairs` as dependencies would re-lay the canvas every 1.5 seconds and
   * hand React Flow a new coordinate object for every node each time.
   */
  const latest = useRef({ compound, pairs });
  latest.current = { compound, pairs };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const layout = useMemo(() => compoundLayout(latest.current.compound, latest.current.pairs), [signature]);

  /**
   * The blocks chain, from the SAME index the graph view builds — over the CANVAS edges,
   * post-containment, so hovering traces the chain at the level being displayed.
   */
  const index = useMemo(() => buildLineageIndex(pairs), [pairs]);

  /**
   * The focus, mapped to whatever box currently draws it. `selectionTarget` is the graph
   * view's own answer to "a ticket is selected, which box do I light": here the absorption
   * map is empty (nothing is collapsed) and the header map is what matters — a focus with
   * children IS a container now, under `epic:<id>`, and lighting its old ticket id would
   * light nothing.
   */
  const target = selectionTarget(context.focus, new Map(), containment.headers);

  const hoverLineage = useMemo<Lineage | null>(
    () => (hovered ? lineageFrom(index, hovered) : null),
    [index, hovered],
  );
  const selectionLineage = useMemo<Lineage | null>(
    () => (target ? lineageFrom(index, target) : null),
    [index, target],
  );

  /**
   * One emphasis, chosen by the graph view's rule with the planning modes switched off:
   * hover wins, otherwise the focus's own chain is lit and everything else dims. The tab's
   * focus IS a selection, so this is the same sentence the big canvas says about the same
   * ticket — which is the point of the ticket.
   *
   * The DEPTH of the dim is scoped down in detail.css. `app.css` fades to 0.16, which
   * earns its severity on a fifty-box board where a faded box is genuinely irrelevant;
   * here the set has already been narrowed to the focus's own relatives, so a dimmed box
   * is still something you asked about. Same class, same verb, gentler value, and the
   * graph view is untouched.
   */
  const emphasis = useMemo<Emphasis | null>(
    () =>
      emphasisFor({
        hoverLineage,
        mode: "off",
        frontierSet: null,
        pathChain: null,
        selectionLineage,
      }),
    [hoverLineage, selectionLineage],
  );

  const focus = hovered ?? target;

  const dimmed = useMemo(
    () => canvasDimmed(nodes, containment, emphasis),
    [nodes, containment, emphasis],
  );

  /** Direct blockers that are not done or cancelled — the ones that stop you starting. */
  const unresolved = useMemo(() => new Set(context.unresolvedBlockers), [context]);

  const flowNodes = useMemo<GraphFlowNode[]>(
    () =>
      canvasFlowNodes({
        nodes,
        containment,
        positions: layout.positions,
        sizes: layout.sizes,
        dimmed,
        // `fade` is the graph toolbar's done mode and there is no toolbar here. Resolved
        // work on this canvas is a relation like any other and is drawn as one.
        faded: null,
        focus,
        showWorkspace,
        onExpand: noop,
        onCollapse: noop,
        draggable: false,
        // The tint for an unresolved blocker. One class, defined in detail.css against the
        // blocked status token — no new hue, and it rides on React Flow's node wrapper so
        // `TaskNode` did not have to learn what a blocker is.
        classNameFor: (node) =>
          unresolved.has(node.id) ? "staple-relation-unresolved" : undefined,
      }),
    [nodes, containment, layout, dimmed, focus, showWorkspace, unresolved],
  );

  const flowEdges = useMemo(() => canvasFlowEdges(links, emphasis), [links, emphasis]);

  /**
   * Click a box, open that ticket — through `session.open`, the single navigation
   * primitive the graph view and the breadcrumb also use. That is the whole reason
   * prev/next (R6) keeps working: selection is session state, and this only sets it.
   * `canvasTicket` is the graph view's mapping, so a container opens its epic here too.
   */
  const onNodeClick = useCallback<NodeMouseHandler<GraphFlowNode>>(
    (_event, node) => {
      const ticket = canvasTicket(node);
      session.open(ticket.workspace, ticket.id);
    },
    [session],
  );

  const onNodeMouseEnter = useCallback<NodeMouseHandler<GraphFlowNode>>(
    (_event, node) => setHovered(node.id),
    [],
  );
  const onNodeMouseLeave = useCallback(() => setHovered(null), []);

  return (
    <ReactFlow<GraphFlowNode>
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={onNodeClick}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      // Read-only, stated three ways because React Flow has three opinions to override.
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      minZoom={0.1}
      maxZoom={2}
      fitView
      fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
      proOptions={{ hideAttribution: false }}
    >
      <Background gap={20} size={1} />
      <Controls showInteractive={false} />
      <FitOnFocus signature={signature} />
    </ReactFlow>
  );
}

function RelationsBody({ graph, focus }: { graph: Graph; focus: string }) {
  const session = useSession();
  const context = useMemo(() => relationContext(graph, focus), [graph, focus]);

  /**
   * A focus that is not in the payload has no honest numbers to print — it is the state
   * during the first poll, and the state for a ticket whose workspace this graph does not
   * cover. Showing a strip of zeroes there would assert "nothing blocks this", which is
   * not something we know.
   */
  if (!context.found) return <EmptyState>no relations</EmptyState>;

  return (
    <div className="flex flex-col gap-2">
      <StatsStrip context={context} />
      {context.hasRelations ? (
        <div className="staple-relations-canvas bg-card w-full overflow-hidden rounded-lg border">
          {/*
            Keyed on the focus: a different ticket is a different picture, and remounting
            resets React Flow's viewport and internal node store together rather than
            leaving the previous shape's pan behind.
          */}
          <ReactFlowProvider key={focus}>
            <RelationCanvas context={context} showWorkspace={session.mode === "hub"} />
          </ReactFlowProvider>
        </div>
      ) : (
        // Not "one lonely box". A canvas drawn for a ticket with nothing attached says
        // less than the sentence does, and costs a scroll of empty grid to say it.
        <EmptyState>no relations</EmptyState>
      )}
    </div>
  );
}

/**
 * The tab fetches its OWN graph, the way AnalyticsTab reads its own numbers off the
 * detail: `/api/graph` is not on `IssueDetail` and putting it there would make every
 * other tab pay for this one. `session.version` enrols the fetch in the fingerprint poll,
 * so a dependency an agent adds in another terminal shows up here within ~1.5s.
 *
 * Node ids in BOTH producers are identifiers (`hub.graph()` sets `id: issue.identifier`),
 * which is why hub mode needs no branch anywhere in this file.
 */
export function RelationsTab({ detail, onAuthError }: TabProps) {
  const load = useCallback(() => getGraph(), []);
  const session = useSession();
  const resource = useResource(load, [session.version], onAuthError);

  if (resource.error) return <ErrorState error={resource.error} />;
  if (resource.data === undefined) {
    return resource.loading ? <LoadingState rows={2} /> : <EmptyState>no relations</EmptyState>;
  }
  return <RelationsBody graph={resource.data} focus={detail.issue.identifier} />;
}
