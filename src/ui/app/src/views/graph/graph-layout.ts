/**
 * Where the nodes go — G2 (STA-55), kept out of the component on purpose.
 *
 * The hand-rolled relaxation this replaces lived inside the view and re-ran on every
 * render (STA-44 item 5). Moving the arrangement into a pure module is what makes the
 * memoization in GraphView possible AND what makes "does auto-arrange actually put
 * blockers to the left of what they block" a test rather than a screenshot.
 *
 * Nothing here imports React or touches storage. `graph-positions.ts` owns persistence;
 * this file only ever computes the CANONICAL arrangement, which is the thing
 * auto-arrange restores you to.
 */
import dagre from "@dagrejs/dagre";

/**
 * Node box, in pixels. Shared with TaskNode.tsx's card, and it has to be: dagre packs
 * ranks using the sizes it is given, so a card that renders wider than this would
 * overlap its neighbours no matter how good the layout is.
 */
export const NODE_W = 208;
export const NODE_H = 62;

/** Rank separation (along the flow) and node separation (across it). */
const RANK_SEP = 90;
const NODE_SEP = 24;

export interface XY {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

/**
 * Only nodes that actually participate in a dependency.
 *
 * The graph view has always shown the dependency graph, not the backlog — a workspace
 * where nine tickets in ten block nothing would otherwise render as a field of
 * disconnected boxes with the four interesting arrows lost inside it. The "no
 * dependencies yet" empty state is this function returning nothing.
 */
export function connectedNodes<T extends LayoutNode>(nodes: readonly T[], edges: readonly LayoutEdge[]): T[] {
  const linked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  return nodes.filter((node) => linked.has(node.id));
}

/**
 * A content signature for the graph's SHAPE — ids and edges, deliberately nothing else.
 *
 * THIS IS THE LOAD-BEARING FUNCTION IN G2, and the reason is the poll. `useResource`
 * refetches the graph whenever the fingerprint changes, which is any write anywhere in
 * the workspace, roughly every 1.5s on an active repo. `graph` is therefore a brand new
 * object constantly. If the layout keyed on object identity, dagre would re-run on a
 * timer and — much worse — every node you had dragged would jump back to canonical while
 * you were looking at it.
 *
 * Title and status are excluded on purpose rather than by oversight. A ticket moving to
 * in_progress must re-tint WITHOUT relocating; including status here would make the whole
 * board twitch every time an agent claimed something, which on this project is often.
 *
 * Sorted so that a reordering of the same rows is not mistaken for a change.
 */
export function graphSignature(nodes: readonly LayoutNode[], edges: readonly LayoutEdge[]): string {
  const ids = nodes.map((n) => n.id).sort();
  const pairs = edges.map((e) => `${e.from}>${e.to}`).sort();
  return `${ids.join(",")}|${pairs.join(",")}`;
}

/**
 * The canonical arrangement: a layered DAG, left to right.
 *
 * `rankdir: LR` keeps the one property the old relaxation layout was built around —
 * every arrow points forward, so "what is upstream of this" is answerable by looking
 * left. Switching to top-down would have been a quieter change than it looks: the whole
 * reading of the view is horizontal, and the legend, the node card, and every habit
 * anyone has formed in front of this thing assume it.
 *
 * dagre reports node CENTRES; React Flow positions by top-left corner. The half-size
 * subtraction happens here, once, so no caller has to remember it.
 */
export function dagreLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Record<string, XY> {
  const present = new Set(nodes.map((n) => n.id));
  if (present.size === 0) return {};

  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));

  for (const node of nodes) g.setNode(node.id, { width: NODE_W, height: NODE_H });
  for (const edge of edges) {
    // An edge naming a node we are not drawing would make dagre invent it as a
    // zero-size node and open a hole in the layout. Cross-workspace edges into a
    // workspace file that is not on this machine do exactly that.
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    // multigraph + an explicit name: a duplicated dependency row must not silently
    // replace its twin, which is what setEdge without a name would do.
    g.setEdge(edge.from, edge.to, {}, `${edge.from}>${edge.to}`);
  }

  dagre.layout(g);

  const positions: Record<string, XY> = {};
  for (const id of g.nodes()) {
    const laid = g.node(id) as { x?: number; y?: number } | undefined;
    if (!laid || laid.x === undefined || laid.y === undefined) continue;
    positions[id] = { x: laid.x - NODE_W / 2, y: laid.y - NODE_H / 2 };
  }
  return positions;
}

/**
 * Canonical arrangement with the user's own moves laid over the top.
 *
 * Stored entries win, but only for ids that still exist — a ticket that was dragged and
 * later deleted must not keep a slot, and a NEW ticket must land wherever dagre thinks
 * it belongs rather than at the origin. That second half is what stops "one new
 * dependency" from stacking every fresh node at 0,0 in the corner.
 */
export function mergePositions(
  canonical: Record<string, XY>,
  stored: Record<string, XY> | null | undefined,
): Record<string, XY> {
  if (!stored) return { ...canonical };
  const merged: Record<string, XY> = { ...canonical };
  for (const [id, position] of Object.entries(stored)) {
    if (id in merged) merged[id] = position;
  }
  return merged;
}
