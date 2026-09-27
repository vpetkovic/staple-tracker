/**
 * Connections — where this task sits in the plan, as a list you can read, with the map one
 * tap away.
 *
 * ── Why a list first ────────────────────────────────────────────────────────────────
 *
 * The tab used to open on a canvas and a strip of counters. On a phone the canvas was a
 * mostly-empty grid, and the counters (`blocked by 0 direct (0 unresolved) · 0 upstream
 * total`) were exact and unreadable. The questions a reader brings here are plain ones —
 * what is this part of, what are its sub-tasks, what is it waiting on, what is waiting on
 * it — and each is answered by a short list of tasks with their status. So the tab opens
 * on those lists, every row a tappable task, and the summary above them is in sentences
 * (../relation-stats.ts, pinned by a test). The canvas is still here, unchanged, behind
 * "Show map".
 *
 * The lists come straight off `IssueDetail` (ancestors, children, blockedBy, blocks,
 * crossBlockers), so they render with the detail and never wait on a second request. The
 * graph is fetched for the map and for the one figure only the graph knows — how much
 * more is waiting further up the chain.
 *
 * ── The map ──────────────────────────────────────────────────────────────────────────
 *
 * The graph view, pointed at one ticket — O2b (STA-132), rebuilt by O2c (STA-155).
 * `views/graph/graph-canvas.ts` is the canvas derivation both views call; this file is the
 * other caller. Same `TaskNode`, same `EpicContainerNode`, same edge classes, same
 * `MarkerType`, same emphasis rule, same dagre `rankdir: LR` — the only difference is which
 * sub-graph goes in. Ancestors become nested containers, the focus becomes the innermost
 * box when it has children, and the only edges dagre ever ranks are dependencies.
 * Read-only: no dragging, no persisted positions, no toolbar; Background and zoom Controls
 * only.
 *
 * Which boxes and arrows:   lib/relation-context.ts
 * How they become a canvas: views/graph/graph-canvas.ts    (shared with GraphView)
 * Where they go:            views/graph/graph-layout.ts    (compoundLayout, unchanged)
 * What the summary says:    detail/relation-stats.ts       (pure, tested)
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
import { ChevronRight, CircleCheck, EyeOff, Map as MapIcon, Network, OctagonAlert } from "lucide-react";
import { StatusIcon } from "@/components/task-list/StatusIcon";
import { getGraph } from "@/lib/api";
import { buildLineageIndex, lineageFrom, type Lineage } from "@/lib/graph-lineage";
import { relationContext, type RelationContext } from "@/lib/relation-context";
import { useSession } from "@/lib/session";
import { isResolvedStatus, statusLabel } from "@/lib/settings";
import type { CrossBlocker, Graph, IssueDetail } from "@/lib/types";
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
import { ErrorState, LoadingState } from "@/views/ViewChrome";
import { EmptyState, SectionHeading, cn } from "../parts";
import { directCounts, relationStats, unreachableWords } from "../relation-stats";
import type { TabProps } from "./registry";

import "./tabs.css";

/** Collapsing has no meaning on a canvas that exists to show one tree fully expanded. */
const noop = () => {};

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

/** One task, as a row you can tap: its status glyph, its title, and its status in words. */
function TaskRow({
  identifier,
  title,
  status,
  onOpen,
  note,
}: {
  identifier: string;
  title: string;
  status: string;
  onOpen?: () => void;
  /** Quiet words after the status, e.g. the workspace a cross-workspace task lives in. */
  note?: string;
}) {
  const inner = (
    <>
      <StatusIcon status={status} className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{title}</span>
        <span className="block truncate text-caption text-text-tertiary">
          {statusLabel(status)}
          {note ? ` · ${note}` : ""}
        </span>
      </span>
      {onOpen ? <ChevronRight aria-hidden className="size-4 shrink-0 text-text-tertiary" /> : null}
    </>
  );
  const row = "flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left";
  return (
    <li className="border-b border-border last:border-b-0">
      {onOpen ? (
        <button
          type="button"
          onClick={onOpen}
          title={`${identifier} · ${title}`}
          className={cn(row, "focus-ring-inset transition-colors duration-150 hover:bg-surface-hover")}
        >
          {inner}
        </button>
      ) : (
        <div className={row} title={`${identifier} · ${title}`}>
          {inner}
        </div>
      )}
    </li>
  );
}

function Group({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section aria-label={title}>
      <SectionHeading action={action}>{title}</SectionHeading>
      <ul className="overflow-hidden rounded-xl border border-border bg-surface-raised">{children}</ul>
    </section>
  );
}

/** Sub-tasks finished, as a thin bar beside the words. */
function Progress({ done, total }: { done: number; total: number }) {
  const share = total === 0 ? 0 : done / total;
  return (
    <span className="flex items-center gap-2">
      <span className="tabular-nums">
        {done} of {total} finished
      </span>
      <span
        role="progressbar"
        aria-label="Sub-tasks finished"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken"
      >
        <span
          className="block h-full rounded-full bg-[var(--status-task-done)] transition-[width] duration-200 motion-reduce:transition-none"
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </span>
    </span>
  );
}

/**
 * A blocker in another workspace, as /api/issue sends it: the hub adds the title for the
 * detail (additive, so an older server simply leaves it out and the row falls back to the id).
 */
type TitledCrossBlocker = CrossBlocker & { title?: string | null; missing?: "workspace" | "task" | null };

/**
 * A blocker this computer cannot read: no status glyph (there is no status to show), the
 * agreed sentence, and what the person can do. Not a button: there is nothing to open.
 */
function UnreachableRow({ blocker, knownWorkspaces }: { blocker: TitledCrossBlocker; knownWorkspaces: readonly string[] }) {
  const words = unreachableWords(blocker, knownWorkspaces)!;
  return (
    <li className="border-b border-border last:border-b-0" data-unreachable={words.kind}>
      <div className="flex min-h-11 w-full items-start gap-3 px-3 py-2.5 text-left">
        <EyeOff aria-hidden className="mt-0.5 size-4 shrink-0 text-text-tertiary" />
        <span className="min-w-0 flex-1">
          <span className="block text-body text-foreground [overflow-wrap:anywhere]">{words.headline}</span>
          <span className="block text-caption text-text-secondary">{words.advice}</span>
        </span>
      </div>
    </li>
  );
}

function Summary({ detail, graph }: { detail: IssueDetail; graph: Graph | undefined }) {
  const context = useMemo(
    () => (graph ? relationContext(graph, detail.issue.identifier) : null),
    [graph, detail.issue.identifier],
  );
  const stats = useMemo(() => {
    const direct = directCounts({
      ancestors: detail.ancestors.length,
      children: detail.children,
      blockedBy: detail.blockedBy,
      blocks: detail.blocks.length,
      crossBlockers: detail.crossBlockers,
      isResolved: isResolvedStatus,
    });
    // Only the graph knows the transitive pile; it adds to the direct figure, never replaces it.
    const further = context?.found ? Math.max(0, context.counts.blockedByTotal - context.counts.blockedByDirect) : 0;
    return relationStats({ ...direct, blockedByTotal: direct.blockedByDirect + further });
  }, [detail, context]);

  // Sub-task progress is said once, beside the Sub-tasks list, not twice.
  const [lead, ...rest] = stats.filter((stat) => stat.key !== "children");
  if (!lead) return null;
  const LeadIcon = lead.blocked ? OctagonAlert : CircleCheck;
  return (
    <div className="space-y-1" data-testid="relations-summary">
      <p
        className={cn(
          "text-reading flex items-center gap-2 font-medium",
          lead.blocked ? "text-[var(--status-task-blocked)]" : "text-foreground",
        )}
      >
        <LeadIcon aria-hidden className={cn("size-4 shrink-0", !lead.blocked && "text-[var(--status-task-done)]")} />
        {lead.text}
      </p>
      {rest.length > 0 ? (
        <p className="pl-6 text-body text-text-secondary">{rest.map((stat) => stat.text).join(" · ")}</p>
      ) : null}
    </div>
  );
}

function RelationMap({ graph, focus }: { graph: Graph; focus: string }) {
  const session = useSession();
  const context = useMemo(() => relationContext(graph, focus), [graph, focus]);
  if (!context.found || !context.hasRelations) {
    return <p className="px-1 py-4 text-body text-text-secondary">There is nothing to draw on the map for this task.</p>;
  }
  return (
    <div className="staple-relations-canvas tab-fade-in w-full overflow-hidden rounded-xl border border-border bg-card">
      {/*
        Keyed on the focus: a different ticket is a different picture, and remounting
        resets React Flow's viewport and internal node store together rather than
        leaving the previous shape's pan behind.
      */}
      <ReactFlowProvider key={focus}>
        <RelationCanvas context={context} showWorkspace={session.mode === "hub"} />
      </ReactFlowProvider>
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
export function RelationsTab({ detail, workspace, onAuthError }: TabProps) {
  const load = useCallback(() => getGraph(), []);
  const session = useSession();
  const resource = useResource(load, [session.version], onAuthError);
  const [showMap, setShowMap] = useState(false);

  const open = (identifier: string, ws: string = workspace) => session.open(ws, identifier);
  const parent = detail.ancestors.at(-1);
  const doneChildren = detail.children.filter((child) => isResolvedStatus(child.status)).length;
  const waitingOn = [...detail.blockedBy].sort(
    (a, b) => Number(isResolvedStatus(a.status)) - Number(isResolvedStatus(b.status)),
  );
  const nothing =
    !parent &&
    detail.children.length === 0 &&
    detail.blockedBy.length === 0 &&
    detail.blocks.length === 0 &&
    detail.crossBlockers.length === 0;

  if (nothing) {
    return (
      <div className="w-full max-w-readable">
        <EmptyState icon={Network}>
          This task stands on its own: it has no parent, no sub-tasks, and nothing it waits on or holds up.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="w-full max-w-readable space-y-5">
      <Summary detail={detail} graph={resource.data} />

      {parent ? (
        <Group title="Part of">
          <TaskRow
            identifier={parent.identifier}
            title={parent.title}
            status={parent.status}
            onOpen={() => open(parent.identifier, detail.workspace)}
          />
        </Group>
      ) : null}

      {detail.children.length > 0 ? (
        <Group title="Sub-tasks" action={<Progress done={doneChildren} total={detail.children.length} />}>
          {detail.children.map((child) => (
            <TaskRow
              key={child.id}
              identifier={child.identifier}
              title={child.title}
              status={child.status}
              onOpen={() => open(child.identifier, detail.workspace)}
            />
          ))}
        </Group>
      ) : null}

      {waitingOn.length > 0 || detail.crossBlockers.length > 0 ? (
        <Group title="Waiting on">
          {waitingOn.map((ref) => (
            <TaskRow
              key={ref.identifier}
              identifier={ref.identifier}
              title={ref.title}
              status={ref.status}
              onOpen={() => open(ref.identifier, detail.workspace)}
            />
          ))}
          {(detail.crossBlockers as TitledCrossBlocker[]).map((blocker) =>
            blocker.unresolvable ? (
              <UnreachableRow
                key={`${blocker.workspace}:${blocker.identifier}`}
                blocker={blocker}
                knownWorkspaces={session.workspaces.map((ws) => ws.slug)}
              />
            ) : (
              <TaskRow
                key={`${blocker.workspace}:${blocker.identifier}`}
                identifier={blocker.identifier}
                title={blocker.title?.trim() || blocker.identifier}
                status={blocker.status ?? (blocker.resolved ? "done" : "todo")}
                note={`in ${blocker.workspace}`}
                onOpen={session.mode === "hub" ? () => open(blocker.identifier, blocker.workspace) : undefined}
              />
            ),
          )}
        </Group>
      ) : null}

      {detail.blocks.length > 0 ? (
        <Group title="Holding up">
          {detail.blocks.map((ref) => (
            <TaskRow
              key={ref.identifier}
              identifier={ref.identifier}
              title={ref.title}
              status={ref.status}
              onOpen={() => open(ref.identifier, detail.workspace)}
            />
          ))}
        </Group>
      ) : null}

      <section aria-label="Map" className="space-y-3">
        <button
          type="button"
          aria-expanded={showMap}
          onClick={() => setShowMap((on) => !on)}
          className="focus-ring inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-surface-raised px-3 text-body text-foreground transition-colors duration-150 hover:bg-surface-hover"
        >
          <MapIcon aria-hidden className="size-4 text-text-secondary" />
          {showMap ? "Hide map" : "Show map"}
        </button>
        {showMap ? (
          resource.error ? (
            <ErrorState error={resource.error} />
          ) : resource.data === undefined ? (
            <LoadingState rows={2} />
          ) : (
            <RelationMap graph={resource.data} focus={detail.issue.identifier} />
          )
        ) : null}
      </section>
    </div>
  );
}
