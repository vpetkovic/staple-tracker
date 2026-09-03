/**
 * "What is this ONE ticket's place in the plan?" — O2a (STA-131), as a pure function.
 *
 * The graph view answers a board-wide question and dims what does not matter. The
 * Relations tab (O2b) asks the same question from the opposite end: you already have a
 * ticket open, and you want the four sentences about it that a list view cannot say —
 * what it belongs to, what it contains, what has to land before it, and what is waiting
 * on it — with counts, and with cross-workspace edges intact.
 *
 * That is a set-of-ids problem plus a "which boxes go on the canvas" problem, and
 * neither is a drawing problem, so both live here with no React and no layout. O2b picks
 * a renderer; this file does not move when it does.
 *
 * ── What this file is NOT allowed to do ──────────────────────────────────────────────
 *
 * It does not re-implement lineage. `lineageFrom` (graph-lineage.ts) already decided the
 * hard question — that a lit edge needs BOTH ends on the same side of the focus, so a
 * cousin does not creep in — and it decided it once, for the graph view's hover. If this
 * file walked the blocks edges itself, the tab and the canvas would eventually disagree
 * about what "blocked by" means, and nothing would catch it. So graph-lineage is imported
 * and used verbatim, not copied and not modified.
 *
 * It also does not touch the wire types or the producers. `Hub.graph()` already emits
 * `parent` as the parent's identifier, and the hub branch of /api/graph already passes it
 * through, so hub mode resolves epics with no server change at all. The proof of that
 * lives in this module's test as a hub-shaped fixture rather than as an edit here.
 *
 * ── The two blocker numbers ──────────────────────────────────────────────────────────
 *
 * `store.unresolvedBlockersFor` is a DIRECT count — one join, no recursion — and it
 * treats done and cancelled alike as resolved. `lineageFrom` gives the TRANSITIVE set.
 * These are different questions ("can I start this today?" versus "how deep is the pile
 * behind it?") and a strip that shows one number labelled with the other's meaning is
 * the kind of wrong that survives for months. Both are computed and both are exposed,
 * named for which is which.
 *
 * Imports are relative, like every other module under lib/, and the wire types come in
 * as `import type` so nothing is emitted for them.
 */
import { buildLineageIndex, lineageFrom } from "./graph-lineage";
import type { Graph, GraphNode, IssueStatus } from "./types";

/**
 * Resolved = finished, one way or the other.
 *
 * Deliberately the same rule as `RESOLVED_STATUSES` in core and `isResolved` in
 * graph-clusters.ts. Cancelled counts with done: it is not remaining work, and a blocker
 * somebody cancelled is not blocking anything. Getting this wrong in either direction
 * makes the tab argue with the inbox badge about the same ticket.
 */
const RESOLVED: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["done", "cancelled"]);

/** One arrow the tab draws. `GraphEdge` plus which kind of relation it stands for. */
export interface RelationEdge {
  from: string;
  to: string;
  /**
   * Dashed. For a blocks edge this is the payload's own flag, carried through untouched
   * — cross-workspace dependencies are what a hub view exists to show, and a traversal
   * that dropped the flag would silently redraw them as ordinary local arrows. For a
   * parent edge it is computed from the two nodes' workspaces, which is `false` for
   * every parent the store can currently produce, and stays honest if that changes.
   */
  cross: boolean;
  /** `parent` points parent -> child. `blocks` points blocker -> blocked. */
  kind: "parent" | "blocks";
}

/**
 * The numbers above the canvas.
 *
 * Everything here is derivable from the arrays below; it is precomputed because the
 * strip renders on every poll and because naming each number is the only way to keep
 * "blocked by 3" and "blocked by 7 upstream" from being written by two different people
 * as the same variable.
 */
export interface RelationCounts {
  /** Length of the parent chain. */
  ancestors: number;
  /** DIRECT children only — what the `resolved/total` badge counts. */
  children: number;
  childrenResolved: number;
  /** The whole subtree, focus excluded. */
  descendants: number;
  descendantsResolved: number;
  /** Immediate blockers. Mirrors `store.blockersOf`. */
  blockedByDirect: number;
  /** Immediate blockers that are not done/cancelled. Mirrors `unresolvedBlockersFor`. */
  blockedByUnresolved: number;
  /** TRANSITIVE blockers — the whole pile upstream. Never smaller than `blockedByDirect`. */
  blockedByTotal: number;
  /** Immediate dependents. */
  blocksDirect: number;
  /** Transitive dependents. */
  blocksTotal: number;
  /** Drawn edges flagged cross-workspace. */
  crossEdges: number;
  /** Drawn nodes living in a workspace other than the focus's. */
  crossNodes: number;
}

/**
 * Everything the Relations tab needs, in one value.
 *
 * The relation lists are ARRAYS OF IDENTIFIERS, not nodes: they are answers to questions
 * about the plan, and a caller that wants to say "STA-11" should not have to reach
 * through an object to say it. The sub-graph carries whole `GraphNode`s instead, because
 * that half is a drawing and a drawing needs titles, statuses and workspaces. One lookup
 * (`graph.nodes`) covers both.
 */
export interface RelationContext {
  /** The identifier that was asked about, present or not. */
  focus: string;
  /** Whether `focus` was actually in the payload. False while the graph is still loading. */
  found: boolean;
  /** The parent chain, ROOT FIRST. Excludes the focus. */
  ancestors: string[];
  /** Direct children, in payload order. */
  children: string[];
  /** The whole subtree, focus excluded, in payload order. */
  descendants: string[];
  /** Transitive blockers, in payload order. */
  predecessors: string[];
  /** Transitive dependents, in payload order. */
  successors: string[];
  /** IMMEDIATE blockers, deduped, in edge order. */
  blockedBy: string[];
  /** IMMEDIATE dependents, deduped, in edge order. */
  blocks: string[];
  /** The subset of `blockedBy` that is not done/cancelled — what the strip tints. */
  unresolvedBlockers: string[];
  counts: RelationCounts;
  /**
   * Whether there is anything to draw beyond the focus itself.
   *
   * Read off the DRAWABLE sub-graph rather than off the relation arrays, because it
   * exists to answer one question — does the canvas show a shape, or one lonely box? A
   * relation whose node is absent from the payload cannot be drawn, so counting it here
   * would promise a picture the tab cannot paint.
   */
  hasRelations: boolean;
  /** The boxes and arrows, ready for a layout pass. */
  graph: { nodes: GraphNode[]; edges: RelationEdge[] };
}

const EMPTY_COUNTS: RelationCounts = {
  ancestors: 0,
  children: 0,
  childrenResolved: 0,
  descendants: 0,
  descendantsResolved: 0,
  blockedByDirect: 0,
  blockedByUnresolved: 0,
  blockedByTotal: 0,
  blocksDirect: 0,
  blocksTotal: 0,
  crossEdges: 0,
  crossNodes: 0,
};

function notFound(ref: string): RelationContext {
  return {
    focus: ref,
    found: false,
    ancestors: [],
    children: [],
    descendants: [],
    predecessors: [],
    successors: [],
    blockedBy: [],
    blocks: [],
    unresolvedBlockers: [],
    counts: { ...EMPTY_COUNTS },
    hasRelations: false,
    graph: { nodes: [], edges: [] },
  };
}

/**
 * The parent chain above `focus`, root first.
 *
 * ROOT FIRST because the only thing anyone does with this list is read it left to right
 * as a breadcrumb, and a breadcrumb runs outermost to innermost. Leaf-first is the same
 * set, which is exactly why reversing it is a bug that set assertions cannot see.
 *
 * The walk STOPS at a parent that has no node in the payload rather than recording the
 * bare identifier. It has to: without that node we do not know its parent either, so the
 * chain ends there whatever we do — and a breadcrumb entry with no title, no status and
 * no workspace is a dead crumb the tab cannot render or click. This is a real hub-shaped
 * state (a parent in a workspace this page cannot see), not a defect.
 *
 * `seen` is the cycle guard. The store cannot create a parent cycle, but a hand-edited
 * DB can, and the tab must then look confusing rather than lock the tab up.
 */
function ancestryOf(byId: ReadonlyMap<string, GraphNode>, focus: string): string[] {
  const chain: string[] = [];
  const seen = new Set<string>([focus]);
  let current = byId.get(focus)?.parent ?? null;
  while (current && !seen.has(current)) {
    const node = byId.get(current);
    if (!node) break;
    seen.add(current);
    chain.push(current);
    current = node.parent ?? null;
  }
  return chain.reverse();
}

/**
 * Every node beneath `focus`, focus excluded.
 *
 * Breadth-first over the child index with the same visited-set cycle guard as the walk
 * up. `focus` is pre-seeded into `seen` so a corrupt self-parent or a parent cycle that
 * loops back through the focus cannot put the focus inside its own subtree — which would
 * make the canvas draw the lit node twice.
 */
function subtreeOf(childrenOf: ReadonlyMap<string, string[]>, focus: string): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>([focus]);
  const queue: string[] = [focus];
  while (queue.length > 0) {
    for (const child of childrenOf.get(queue.pop()!) ?? []) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}

/** Deduped, order-preserving. A payload may carry the same dependency twice. */
function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

/**
 * Everything the Relations tab shows about `ref`, from one /api/graph payload.
 *
 * `ref` is an identifier (`STA-131`) — the same id space as node ids and both ends of
 * every edge. A `ref` that is not in the payload is NOT an error: it is what the tab
 * holds during the first poll, and during the moment after somebody opens a ticket from
 * a workspace this graph does not cover. It returns an empty context with `found: false`
 * so the caller renders its empty state with no branch of its own.
 *
 * The function is pure and does not retain the payload: every array it returns is fresh,
 * and the `GraphNode`s inside `graph.nodes` are the caller's own objects, never copies —
 * they are treated as immutable here, as they are everywhere else in the app.
 */
export function relationContext(graph: Graph, ref: string): RelationContext {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const focusNode = byId.get(ref);
  if (!focusNode) return notFound(ref);

  const childrenOf = new Map<string, string[]>();
  for (const node of graph.nodes) {
    // Self-parenting is impossible in the store and would otherwise make a node its own
    // child, which the subtree walk's guard would then have to unpick.
    if (!node.parent || node.parent === node.id) continue;
    const bucket = childrenOf.get(node.parent);
    if (bucket) bucket.push(node.id);
    else childrenOf.set(node.parent, [node.id]);
  }

  const ancestors = ancestryOf(byId, ref);
  const subtree = subtreeOf(childrenOf, ref);
  const lineage = lineageFrom(buildLineageIndex(graph.edges), ref);

  // ---------- which boxes go on the canvas ----------
  //
  // focus + chain + subtree + lineage, and then ONE MORE HOP: the parent of each lineage
  // node. That hop is not decoration. A blocker from another epic arrives as a bare
  // identifier with no context, and "STA-88 blocks this" is a different sentence from
  // "the auth epic blocks this". Drawing the parent is what turns the first into the
  // second, and it is bounded — one level, not the whole chain — so the canvas cannot
  // grow back into the board-wide graph this tab exists to replace.
  const visible = new Set<string>([ref]);
  for (const id of ancestors) visible.add(id);
  for (const id of subtree) visible.add(id);
  for (const id of lineage.nodes) visible.add(id);
  for (const id of lineage.nodes) {
    const parent = byId.get(id)?.parent;
    if (parent) visible.add(parent);
  }
  // A relation whose node is absent from the payload is still a true relation (it counts)
  // but it is not a box (it cannot be drawn). Filtering here rather than at each source
  // keeps that distinction in exactly one place.
  const nodes = graph.nodes.filter((node) => visible.has(node.id));
  const drawn = new Set(nodes.map((node) => node.id));

  // ---------- the arrows ----------
  //
  // Parent edges first: they are the skeleton the tab stacks ancestors above and children
  // below, and emitting them in node order keeps the layout stable across polls.
  const edges: RelationEdge[] = [];
  for (const node of nodes) {
    if (!node.parent || !drawn.has(node.parent)) continue;
    const parent = byId.get(node.parent);
    edges.push({
      from: node.parent,
      to: node.id,
      cross: parent !== undefined && parent.workspace !== node.workspace,
      kind: "parent",
    });
  }
  //
  // Then blocks edges, in payload order, keeping any edge whose BOTH ENDS are on screen.
  //
  // WHY "BOTH ENDS DRAWN" and not graph-lineage's stricter "both ends on the same side of
  // the focus". The two rules exist to solve different problems. On the board-wide canvas
  // the node set is everything, so the strict rule is what stops a highlight from walking
  // outward into a highlight-everything. Here the node set has ALREADY been narrowed to
  // the focus's own relatives, and every survivor is on screen for a reason. Between two
  // boxes that are both drawn, an arrow that exists in the data and not on the canvas
  // reads as "there is no dependency between these two" — a false sentence, and a worse
  // failure than showing one extra true arrow. So: if both ends are drawn, draw it.
  for (const edge of graph.edges) {
    if (!drawn.has(edge.from) || !drawn.has(edge.to)) continue;
    edges.push({ from: edge.from, to: edge.to, cross: edge.cross, kind: "blocks" });
  }

  // ---------- direct neighbours, which is what the store counts ----------
  const blockedBy = dedupe(graph.edges.filter((e) => e.to === ref).map((e) => e.from));
  const blocks = dedupe(graph.edges.filter((e) => e.from === ref).map((e) => e.to));
  // A blocker with no node in the payload counts as UNRESOLVED. We cannot prove it is
  // done, and under-reporting a blocker is the dangerous direction — the tab would say
  // "ready to start" about something that is not. Neither producer can emit this (both
  // join the issues table), so it is a corrupt-payload guard, not a routine path.
  const unresolvedBlockers = blockedBy.filter((id) => {
    const node = byId.get(id);
    return node === undefined || !RESOLVED.has(node.status);
  });

  // Payload order for everything except the ancestry, whose order is a fact about the
  // plan. Re-sorting the rest would fight whatever order the route chose and would make
  // the canvas reshuffle whenever the server's ordering changed.
  const inPayloadOrder = (set: ReadonlySet<string>): string[] =>
    graph.nodes.filter((node) => set.has(node.id)).map((node) => node.id);

  const children = childrenOf.get(ref) ?? [];
  const descendants = inPayloadOrder(subtree);
  const isResolved = (id: string): boolean => {
    const node = byId.get(id);
    return node !== undefined && RESOLVED.has(node.status);
  };

  return {
    focus: ref,
    found: true,
    ancestors,
    children: [...children],
    descendants,
    predecessors: inPayloadOrder(lineage.ancestors),
    successors: inPayloadOrder(lineage.descendants),
    blockedBy,
    blocks,
    unresolvedBlockers,
    counts: {
      ancestors: ancestors.length,
      children: children.length,
      childrenResolved: children.filter(isResolved).length,
      descendants: subtree.size,
      descendantsResolved: [...subtree].filter(isResolved).length,
      blockedByDirect: blockedBy.length,
      blockedByUnresolved: unresolvedBlockers.length,
      blockedByTotal: lineage.ancestors.size,
      blocksDirect: blocks.length,
      blocksTotal: lineage.descendants.size,
      crossEdges: edges.filter((e) => e.cross).length,
      crossNodes: nodes.filter((node) => node.workspace !== focusNode.workspace).length,
    },
    hasRelations: nodes.length > 1,
    graph: { nodes, edges },
  };
}
