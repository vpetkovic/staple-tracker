/**
 * "Where does this ticket sit in the plan?" — O2b (STA-132).
 *
 * The graph view asks a board-wide question and dims what does not matter. This asks the
 * same question from the other end: the ticket is already open, and the four sentences a
 * list cannot say are what it belongs to, what it contains, what must land before it and
 * what waits on it. Same data, same components, opposite starting point.
 *
 * ── What is NOT in this file ─────────────────────────────────────────────────────────
 *
 * Which boxes and arrows:  lib/relation-context.ts   (O2a, imported, not modified)
 * Where they go:           detail/relation-layout.ts (pure, tested)
 * What the strip says:     detail/relation-stats.ts  (pure, tested)
 * What a box looks like:   views/graph/TaskNode.tsx  (read-only, wrapped by RelationNode)
 * What an arrow means:     styles/app.css            (read-only, classes reused verbatim)
 *
 * There are no component tests in this repo, so logic inside a `.tsx` is logic nothing
 * checks. Everything a test would want to assert about was pushed out on purpose; what is
 * left here is wiring.
 *
 * ── Read-only, and why that is not a limitation ──────────────────────────────────────
 *
 * No dragging, no persisted positions, no toolbar, no minimap. The big canvas earns all
 * of those because it is a workspace you arrange; this is a diagram you read, and every
 * one of them would be a second place where a position could be remembered and later
 * disagree. `fitView` runs on mount and again whenever the arrangement changes, which is
 * what makes prev/next (R6) feel like flipping pages rather than like losing your place.
 *
 * ── Emphasis: the one deviation, stated out loud ─────────────────────────────────────
 *
 * The focus wears the same ring the graph view puts on a hovered node, and the blocks
 * edges carry the same `lineage`/`dim` classes. NO NODE IS DIMMED, though.
 * `.staple-rf-node[data-dim]` is `opacity: 0.16`, and it earns that on a fifty-box canvas
 * where the faded boxes are genuinely irrelevant to what you hovered. Here the box set has
 * ALREADY been narrowed to the focus's own relatives, so there is nothing dimming would be
 * true about — and the nearest candidate, the epic O2a draws above a cross-epic blocker,
 * exists precisely to be READ ("the auth epic blocks this", not "STA-88 blocks this").
 * Fading it to 0.16 would delete the sentence it was added to say. So the vocabulary is
 * applied where it has something to report and not for the look of it.
 */
import { useCallback, useEffect, useMemo } from "react";
import {
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type NodeMouseHandler,
} from "@xyflow/react";
import { getGraph } from "@/lib/api";
import { buildLineageIndex, edgeKey, lineageFrom } from "@/lib/graph-lineage";
import { relationContext, type RelationContext } from "@/lib/relation-context";
import { useSession } from "@/lib/session";
import type { Graph } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useResource } from "@/lib/useStaple";
import { NODE_H, NODE_W } from "@/views/graph/graph-layout";
import { EmptyState, ErrorState, LoadingState } from "@/views/ViewChrome";
import { relationLayout } from "../relation-layout";
import { relationStats } from "../relation-stats";
import { relationNodeTypes, type RelationFlowNode } from "../RelationNode";
import type { TabProps } from "./registry";

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
          <span
            className={cn("tabular-nums", stat.blocked && "text-[var(--status-task-blocked)]")}
          >
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
 * one's corner of the coordinate space. Keyed on the layout signature so a status change
 * — which re-tints without relocating anything — does not move the viewport.
 */
function FitOnFocus({ signature }: { signature: string }) {
  const flow = useReactFlow();
  useEffect(() => {
    // Deferred a frame: on the render that introduces new nodes React Flow has not
    // measured them yet, and fitting against unmeasured boxes lands on the wrong zoom.
    const frame = requestAnimationFrame(() => flow.fitView({ padding: 0.16, maxZoom: 1 }));
    return () => cancelAnimationFrame(frame);
  }, [flow, signature]);
  return null;
}

function RelationCanvas({
  context,
  focusWorkspace,
}: {
  context: RelationContext;
  /** The focus's own workspace — what makes a node "cross-workspace" and pill it. */
  focusWorkspace: string;
}) {
  const session = useSession();
  const layout = useMemo(() => relationLayout(context), [context]);

  /**
   * The blocks chain, from the SAME function the graph view lights on hover — `both ends
   * on the same side of the focus` and all. Parent edges are excluded from the index
   * because they are not dependencies; feeding them in would light the family tree as if
   * it were a blocking chain.
   */
  const lineage = useMemo(
    () =>
      lineageFrom(
        buildLineageIndex(context.graph.edges.filter((edge) => edge.kind === "blocks")),
        context.focus,
      ),
    [context],
  );

  /** Direct blockers that are not done or cancelled — the ones that stop you starting. */
  const unresolved = useMemo(() => new Set(context.unresolvedBlockers), [context]);

  const nodes = useMemo<RelationFlowNode[]>(
    () =>
      context.graph.nodes.map((node) => ({
        id: node.id,
        type: "relation" as const,
        position: layout.positions[node.id] ?? { x: 0, y: 0 },
        // Stated rather than measured, for the same reason GraphView states it: these
        // nodes are derived fresh on every render, so a measured size would be thrown
        // away on the next one — and both cards ARE fixed at NODE_W × NODE_H.
        width: NODE_W,
        height: NODE_H,
        draggable: false,
        connectable: false,
        // The tint for an unresolved blocker. One class, defined in detail.css against
        // the blocked status token — no new hue, and it rides on the React Flow wrapper
        // so `TaskNode` did not have to learn what a blocker is.
        className: unresolved.has(node.id) ? "staple-relation-unresolved" : undefined,
        data: {
          node,
          // The criterion's "cross-workspace nodes carry the workspace pill", exactly:
          // in a single-workspace graph nothing is pilled, in hub mode only the boxes
          // that actually live somewhere else are.
          showWorkspace: node.workspace !== focusWorkspace,
          dim: false,
          focused: node.id === context.focus,
        },
      })),
    [context, layout, unresolved, focusWorkspace],
  );

  const edges = useMemo<Edge[]>(
    () =>
      context.graph.edges.map((edge, index) => {
        const parent = edge.kind === "parent";
        const lit = !parent && lineage.edges.has(edgeKey(edge.from, edge.to));
        return {
          // The index is in the id because a duplicated dependency row would otherwise
          // collide and React Flow would drop one of them silently.
          id: `${edge.kind}:${edge.from}->${edge.to}#${index}`,
          source: edge.from,
          target: edge.to,
          // Named handles for the vertical spine; none for the horizontal dependencies,
          // which fall through to TaskNode's own Left/Right pair. See RelationNode.tsx.
          sourceHandle: parent ? "bottom" : undefined,
          targetHandle: parent ? "top" : undefined,
          type: "smoothstep",
          className: [
            "staple-rf-edge",
            edge.cross ? "cross" : "",
            // Parent edges carry NO emphasis class. They are the skeleton the reader is
            // using to find their place; dimming the spine would fight the two criteria
            // that put ancestors above and children below in the first place.
            parent ? "" : lit ? "lineage" : "dim",
          ]
            .filter(Boolean)
            .join(" "),
          markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
        };
      }),
    [context, lineage],
  );

  /**
   * Click a box, open that ticket — through `session.open`, the single navigation
   * primitive the graph view and the breadcrumb also use. That is the whole reason
   * prev/next (R6) keeps working: selection is session state, and this only sets it.
   */
  const onNodeClick = useCallback<NodeMouseHandler<RelationFlowNode>>(
    (_event, node) => session.open(node.data.node.workspace, node.id),
    [session],
  );

  return (
    <ReactFlow<RelationFlowNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={relationNodeTypes}
      onNodeClick={onNodeClick}
      // Read-only, stated four ways because React Flow has four opinions to override.
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable={false}
      panOnScroll={false}
      minZoom={0.2}
      maxZoom={1.5}
      fitView
      fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
      proOptions={{ hideAttribution: false }}
    >
      <FitOnFocus signature={layout.signature} />
    </ReactFlow>
  );
}

function RelationsBody({
  graph,
  focus,
  workspace,
}: {
  graph: Graph;
  focus: string;
  workspace: string;
}) {
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
            <RelationCanvas context={context} focusWorkspace={workspace} />
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
  return (
    <RelationsBody
      graph={resource.data}
      focus={detail.issue.identifier}
      workspace={detail.workspace}
    />
  );
}
