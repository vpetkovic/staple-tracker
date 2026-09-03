/**
 * ONE CANVAS, TWO VIEWS — O2c (STA-155).
 *
 * Everything between "here is a graph" and "here are the arrays React Flow renders":
 * boxes around expanded epics, arrows re-pointed at those boxes, the dim set, and the
 * two typed lists themselves. It was inline in GraphView until the Relations tab needed
 * the same picture scoped to one ticket, and the first attempt at that tab (O2b) built a
 * parallel pipeline instead — its own layout, its own node wrapper, dependencies running
 * DOWN the page while the graph runs them ACROSS it. Two canvases in one app that
 * disagree about which way an arrow means "before" is the bug this file exists to make
 * impossible: there is now one derivation, and both views are callers of it.
 *
 * ── What is deliberately NOT here ────────────────────────────────────────────────────
 *
 * Which tickets are on the canvas at all — the epic filter, the collapse set, the done
 * modes, the global filter — is GraphView's question and stays there. This module starts
 * where those have already had their say (`visible` and `bridged`), because that is
 * exactly the point where the two views converge: the tab reaches the same shape by a
 * completely different route (one ticket's relatives, nothing collapsed) and from here
 * on the code cannot tell them apart. Positions are not here either; they are STATE in
 * the graph view (drag, storage, `relayout`) and a pure function of the shape in the tab,
 * and folding two lifetimes into one signature would serve neither.
 *
 * No React. `MarkerType` and the `Edge`/`Node` types are the only things imported from
 * @xyflow/react, and `GraphFlowNode` comes in as a type, so nothing here renders.
 */
import { MarkerType, type Edge } from "@xyflow/react";
import { edgeKey } from "@/lib/graph-lineage";
import type { GraphEdge, GraphNode } from "@/lib/types";
import {
  boundaryEdges,
  collapseGraph,
  containerize,
  dimContainers,
  summarizeEpics,
  type CanvasEdge,
  type CanvasNode,
  type Containment,
  type EpicSummary,
} from "./graph-clusters";
import {
  MIN_CONTAINER_H,
  MIN_CONTAINER_W,
  NODE_H,
  NODE_W,
  graphSignature,
  type CompoundNode,
  type LayoutEdge,
  type Size,
  type XY,
} from "./graph-layout";
import { bridgeResolved, type BridgedEdge, type Emphasis } from "./graph-planning";
import type { GraphFlowNode } from "./node-types";

/** Nothing is collapsed and nothing is hidden. Frozen so a caller cannot make it lie. */
const NONE: ReadonlySet<string> = new Set<string>();

/**
 * An arrow as drawn, with what it stands for folded back in.
 *
 * `boundaryEdges` hands back INDICES rather than edges so that it never has to learn
 * about `cross`, `count` or bridging; this is where those come back together, and the
 * three rules are the ones `collapseGraph` already established for bundling, restated
 * for a bundle that formed at a box's edge instead of inside a super-node:
 *
 *   `cross` is ALL-of — dashed promises "this crosses workspaces", and one crossing
 *     contributor in nine must not be allowed to make that promise false.
 *   `derived` is ALL-of — dotted means "inferred, because what was really here is
 *     hidden", so a bundle holding one real dependency is drawn as a real one.
 *   `count` SUMS, over the real dependencies only. A bridged edge has no count: it says
 *     "there is a path", not "there are n of them".
 *
 * For an ordinary unbundled arrow every rule reduces to what it said before O4c, which
 * is the case that must not change.
 */
export interface CanvasLink {
  from: string;
  to: string;
  derived: boolean;
  cross: boolean;
  count: number;
}

/** The canvas, derived once. Every field is a pure function of the same four inputs. */
export interface CanvasShape {
  /** In RENDER ORDER: every box before the things drawn inside it. React Flow requires it. */
  nodes: CanvasNode[];
  containment: Containment;
  links: CanvasLink[];
  /** What dagre and the lineage index work on: post-collapse, post-bridge, post-box. */
  pairs: LayoutEdge[];
  /** The canvas as the LAYOUT sees it: an id, the box it is in, and whether it is one. */
  compound: CompoundNode[];
  /**
   * A content signature over the FINAL lists. The collapse set, the done mode and
   * containment are all folded in for free, because each of them changes which ids,
   * which parents or which edge pairs exist. Title and status are excluded on purpose:
   * a ticket moving to in_progress must re-tint WITHOUT relocating.
   */
  signature: string;
}

/**
 * Boxes, boundary arrows, and the two projections the layout needs.
 *
 * CONTAINMENT LAST, AND THAT ORDER IS THE FEATURE'S WHOLE BLAST RADIUS. Everything the
 * callers do upstream of this — the epic filter, collapsing, the global filter,
 * `bridgeResolved` — still sees the flat ticket graph it was written against, so none of
 * it had to learn what a container is. What containment changes is only which box a node
 * is drawn INSIDE and where an arrow lands.
 */
export function canvasShape(
  visible: readonly CanvasNode[],
  bridged: readonly BridgedEdge<CanvasEdge>[],
  epics: readonly EpicSummary[],
  collapsed: ReadonlySet<string>,
): CanvasShape {
  const containment = containerize(visible, epics, collapsed);
  const nodes = containment.nodes;

  const links = boundaryEdges(bridged, containment, collapsed).map((arrow): CanvasLink => {
    const sources = arrow.sources.map((index) => bridged[index]!);
    return {
      from: arrow.from,
      to: arrow.to,
      derived: sources.every((source) => source.derived),
      cross: sources.every((source) => !source.derived && source.edge.cross),
      count: sources.reduce((total, source) => total + (source.derived ? 0 : source.edge.count), 0),
    };
  });

  const pairs = links.map(({ from, to }) => ({ from, to }));
  const compound = nodes.map(
    (node): CompoundNode => ({
      id: node.id,
      parent: containment.parentOf.get(node.id) ?? null,
      container: node.kind === "container",
    }),
  );

  return { nodes, containment, links, pairs, compound, signature: graphSignature(compound, pairs) };
}

/**
 * The same canvas for a sub-graph with EVERY epic expanded — O2c (STA-155).
 *
 * What the Relations tab hands `relationContext(graph, ref).graph` to. Three of the four
 * stages the graph view runs are degenerate here and stated as such rather than skipped:
 * nothing is collapsed (the point of the tab is to show the tree, not to fold it),
 * nothing is hidden (the box set was already narrowed to the focus's relatives, so there
 * is nothing left to filter), and therefore nothing is bridged.
 *
 * THE ARGUMENT IS BLOCKS EDGES ONLY, and that is the whole answer to "why does the tab
 * flow left to right now". Parent/child is expressed as NESTING — `summarizeEpics` reads
 * `GraphNode.parent`, `containerize` turns each parent into a box around its children —
 * so the only edges the layout ever ranks are dependencies, and `compoundLayout` ranks
 * those `rankdir: LR` exactly as it does on the big canvas. The old tab fed both
 * relations to one layout as edges and had to invent a second axis to keep them apart.
 *
 * A caller passing a graph that carries no `parent` (hub mode's payload, on some servers)
 * gets no epics, no containers and a flat LR dependency graph — the identical degradation
 * the graph view already has, which is the reason both go through this one function.
 */
export function expandedCanvasShape(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): CanvasShape {
  // Both lists are the same: on a sub-graph every node is drawn, so "what exists" and
  // "what is on the canvas" — the two lists summarizeEpics deliberately keeps apart —
  // are the same list here, and saying so is more honest than passing a narrower one.
  const epics = summarizeEpics(nodes, nodes);
  const canvas = collapseGraph(nodes, edges, epics, NONE);
  return canvasShape(canvas.nodes, bridgeResolved(canvas.edges, NONE), epics, NONE);
}

/**
 * Who is faded back — with boxes given the benefit of the doubt.
 *
 * `dimContainers` is the whole rule: React Flow draws a box's members as SIBLINGS of the
 * box, not inside it, so dimming a box does not dim what it holds. A dimmed outline
 * around bright cards reads as a rendering fault, so a box is background only when
 * everything in it is.
 *
 * `emphasis === null` means nothing was asked, which must dim NOTHING — the contract G1
 * established and every mode has inherited since.
 */
export function canvasDimmed(
  nodes: readonly CanvasNode[],
  containment: Containment,
  emphasis: Emphasis | null,
): Set<string> {
  if (!emphasis) return new Set<string>();
  const base = new Set(nodes.filter((node) => !emphasis.nodes.has(node.id)).map((node) => node.id));
  return dimContainers(nodes, containment.parentOf, base);
}

export interface CanvasFlowNodeOptions {
  nodes: readonly CanvasNode[];
  containment: Containment;
  /** Container-relative for anything inside a box — React Flow's sub-flow convention. */
  positions: Record<string, XY>;
  /** Container boxes. A node with no entry is a card at NODE_W x NODE_H. */
  sizes: Record<string, Size>;
  dimmed: ReadonlySet<string>;
  /** Resolved work kept on the canvas at low opacity, or `null` when that mode is off. */
  faded: ReadonlySet<string> | null;
  /** The node the emphasis is being traced FROM — the focus ring. */
  focus: string | null;
  /** Hub mode prefixes every identifier with its workspace, as every other view does. */
  showWorkspace: boolean;
  onExpand: (epic: string) => void;
  onCollapse: (epic: string) => void;
  /**
   * `false` pins every box. Omitted leaves React Flow's default, which is what the graph
   * view wants — a canvas you arrange. A read-only canvas states it.
   */
  draggable?: boolean;
  /** An extra class on React Flow's node wrapper. The Relations tab tints blockers with it. */
  classNameFor?: (node: CanvasNode) => string | undefined;
}

/**
 * The boxes, as React Flow wants them.
 *
 * SIZE IS DECLARED RATHER THAN MEASURED, AND IT HAS TO BE. React Flow normally learns a
 * node's size by measuring the DOM and writing the result back through an `onNodesChange`
 * "dimensions" event. Both callers derive their nodes fresh from `positions` on every
 * render and apply only position changes, so a measured size would be discarded on the
 * next render — and anything downstream of size silently gets nothing (the minimap draws
 * an empty box). Stating it is honest rather than a workaround: both cards ARE fixed at
 * NODE_W x NODE_H and dagre already laid the graph out on that assumption, and a
 * container's box was MEASURED by `compoundLayout` — `extent: "parent"` needs something
 * to clamp against before React Flow has had a chance to read one off the DOM.
 *
 * `parentId` makes a node a sub-flow CHILD, which means its `position` is read relative
 * to that parent — which is exactly what `positions` holds for it. `extent: "parent"` is
 * what keeps a dragged member inside its box; without it the box would be a decoration a
 * member could be dragged out of, leaving a card that claims to be in an epic it is
 * visibly outside.
 */
export function canvasFlowNodes(options: CanvasFlowNodeOptions): GraphFlowNode[] {
  const {
    nodes,
    containment,
    positions,
    sizes,
    dimmed,
    faded,
    focus,
    showWorkspace,
    onExpand,
    onCollapse,
    draggable,
    classNameFor,
  } = options;

  return nodes.map((node): GraphFlowNode => {
    const parentId = containment.parentOf.get(node.id);
    const measured =
      node.kind === "container"
        ? (sizes[node.id] ?? { width: MIN_CONTAINER_W, height: MIN_CONTAINER_H })
        : { width: NODE_W, height: NODE_H };
    const dim = dimmed.has(node.id);
    const focused = focus === node.id;
    const box = {
      id: node.id,
      position: positions[node.id] ?? { x: 0, y: 0 },
      width: measured.width,
      height: measured.height,
      parentId,
      extent: parentId ? ("parent" as const) : undefined,
      // The card is the drag handle; React Flow adds its own. Nothing is connectable.
      connectable: false,
      draggable,
      className: classNameFor?.(node),
    };
    /*
     * Fade is an inline style rather than a class because it must NOT compete with the
     * dim/lit vocabulary in app.css — a faded node that is also dimmed should read as
     * dimmed, and the two are applied to different elements (this wrapper vs. the card
     * inside), so they multiply instead of fighting.
     */
    const style = faded?.has(node.id) && !dim ? { opacity: 0.32 } : undefined;

    if (node.kind === "cluster") {
      return {
        ...box,
        style,
        type: "cluster" as const,
        data: { epic: node.epic, showWorkspace, dim, focused, onExpand },
      };
    }
    if (node.kind === "container") {
      return {
        ...box,
        style,
        type: "container" as const,
        data: {
          epic: node.epic,
          showWorkspace,
          dim,
          focused,
          width: measured.width,
          height: measured.height,
          onCollapse,
        },
      };
    }
    return {
      ...box,
      style,
      type: "task" as const,
      data: { node: node.task, showWorkspace, dim, focused },
    };
  });
}

/**
 * The arrows, as React Flow wants them.
 *
 * Semantics live in the CLASS; app.css turns them into pixels, and `cross` is the same
 * class name the graph legend's swatches use so the two cannot drift apart. A bridged
 * edge is never `cross`: the workspaces it passed through are precisely the information
 * that was hidden, so claiming either answer would be making it up.
 */
export function canvasFlowEdges(
  links: readonly CanvasLink[],
  emphasis: Emphasis | null,
): Edge[] {
  return links.map((link, index) => {
    const { from, to, derived, cross, count } = link;
    const lit = emphasis?.edges.has(edgeKey(from, to)) ?? false;
    const dim = emphasis ? !lit : false;
    return {
      // Index is in the id because a duplicated dependency row would otherwise collide
      // and React Flow would drop one of them silently.
      id: `${from}->${to}#${index}`,
      source: from,
      target: to,
      type: "smoothstep",
      className: ["staple-rf-edge", cross ? "cross" : "", emphasis ? (lit ? "lineage" : "dim") : ""]
        .filter(Boolean)
        .join(" "),
      /*
       * A bridged edge is dotted, and inline rather than a class so that no new CSS has
       * to know about it. It is a DIFFERENT dash pattern from the cross-workspace dash
       * (5 4) on purpose — two dashed lines meaning different things would be the graph's
       * third ambiguity, and this one reads as "inferred", not "crosses".
       *
       * Not applied when the edge is dimmed: the dim class owns opacity, and an inline
       * style here would override it and make ignored edges the loudest.
       */
      style: derived && !dim ? { strokeDasharray: "1 4", opacity: 0.7 } : undefined,
      /*
       * How many real dependencies this one arrow stands for. Only shown when it stands
       * for more than one — labelling every ordinary edge "x1" would add a hundred pieces
       * of text to say nothing.
       */
      label: !derived && count > 1 ? `×${count}` : undefined,
      labelShowBg: false,
      labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
      /*
       * An edge touching a sub-flow node has to be lifted above the box it crosses, or
       * React Flow paints the container over the arrow that enters it. `zIndex` on the
       * EDGE is the library's own answer and costs nothing for the flat case.
       */
      zIndex: 1,
    };
  });
}

/**
 * The ticket a box stands for — including a super-node or a container, which stand for a
 * real epic ticket with a real detail panel.
 *
 * Shared rather than written at each call site because "click a box, read that ticket" is
 * a promise both canvases make and it would be quietly broken by one of them opening the
 * container's first member instead. Expanding is the chevron's job (see ClusterNode), so
 * that "click a node, read the node" survives collapsing.
 */
export function canvasTicket(node: GraphFlowNode): { workspace: string; id: string } {
  return node.type === "task"
    ? { workspace: node.data.node.workspace, id: node.id }
    : { workspace: node.data.epic.workspace, id: node.data.epic.id };
}
