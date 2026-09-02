/**
 * "What is this ticket actually connected to?" — G1 (STA-54), as a pure function.
 *
 * The graph view's job at fifty tickets is not to draw every arrow; it is to answer one
 * question about ONE ticket — what has to land before it, and what is waiting on it —
 * and to make everything else get out of the way. That answer is a set-of-ids problem,
 * not a drawing problem, so it lives here with no React and no SVG and no canvas in
 * sight. G2 replaces the entire renderer underneath it and this file does not move.
 *
 * IT TAKES A STRUCTURAL EDGE, NOT `GraphEdge`. `{ from, to }` is the whole input. The
 * wire type is assignable to it, so callers pass `graph.edges` unchanged — but this file
 * imports nothing, which is what lets it be tested with a plain relative import (there is
 * no vitest config at the repo root, so the app's `@` alias does not exist at test time).
 *
 * CROSS-WORKSPACE EDGES NEED NO SPECIAL CASE, and that is deliberate rather than
 * overlooked. The hub flattens every workspace into one id space before the graph ever
 * reaches the browser, so a cross edge is an ordinary edge whose ends happen to live in
 * different files. `cross` is a rendering fact (dashed vs solid); treating it as a
 * traversal fact would silently amputate exactly the dependencies a hub view exists to
 * show. Any future "same workspace only" mode belongs in the caller's edge list, not here.
 */

/** The only shape this module needs. `GraphEdge` is structurally assignable. */
export interface LineageEdge {
  from: string;
  to: string;
}

/**
 * Adjacency, built once per graph payload.
 *
 * Exists so hovering is cheap. Rebuilding two Maps on every pointer move would be O(E)
 * per mouse event for an answer that cannot have changed — the edges are the same edges.
 * G2 memoizes this on the graph data and walks it per hover; `lineageOf` below is the
 * same thing for callers that only ask once.
 */
export interface LineageIndex {
  /** node -> nodes that block it (walk this to go upstream). */
  blockers: Map<string, string[]>;
  /** node -> nodes it blocks (walk this to go downstream). */
  dependents: Map<string, string[]>;
}

/**
 * The answer, as sets of ids. Everything not in `nodes`/`edges` is what the view dims.
 *
 * `ancestors` and `descendants` are kept separate from `nodes` even though the view only
 * uses the union: "upstream of me" and "downstream of me" are different sentences to a
 * human reading a plan, and G4's path/frontier modes need them apart. Splitting them
 * later would mean re-deriving what this walk already knew.
 */
export interface Lineage {
  focus: string;
  /** Transitive blockers. Contains `focus` only if `focus` sits on a cycle. */
  ancestors: Set<string>;
  /** Transitive dependents. Contains `focus` only if `focus` sits on a cycle. */
  descendants: Set<string>;
  /** `focus` ∪ ancestors ∪ descendants — every node that stays lit. */
  nodes: Set<string>;
  /** Every edge that stays lit, keyed by `edgeKey`. */
  edges: Set<string>;
}

/**
 * A stable key for an edge.
 *
 * NUL-joined rather than `${from}->${to}` because a task identifier is user-supplied
 * text in principle, and "A->B" plus "C" must never collide with "A" plus "B->C". The
 * key is deliberately NOT the edge's array index: a graph can carry the same dependency
 * twice (same pair, different rows), and both copies should light or dim together.
 */
export function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

export function buildLineageIndex(edges: readonly LineageEdge[]): LineageIndex {
  const blockers = new Map<string, string[]>();
  const dependents = new Map<string, string[]>();
  for (const edge of edges) {
    // from BLOCKS to — so `to`'s blocker is `from`, and `from`'s dependent is `to`.
    push(blockers, edge.to, edge.from);
    push(dependents, edge.from, edge.to);
  }
  return { blockers, dependents };
}

/**
 * Breadth-first reachability with a visited set.
 *
 * The visited set is the cycle guard. The store rejects dependency cycles at write time,
 * so this should never matter — but "should never" is not "cannot", and a corrupt or
 * hand-edited DB must render a confusing graph rather than lock up the tab. The old SVG
 * layout took the same position with its pass cap; this is the same promise, kept the
 * same way, for the traversal that replaced it.
 */
function reach(adjacency: Map<string, string[]>, start: string): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [start];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/**
 * The lineage of `focusId` over a prebuilt index.
 *
 * WHY THE EDGE RULE IS "BOTH ENDS ON THE SAME SIDE" rather than "either end is lit".
 * Take a diamond — A→B, A→C, B→D, C→D — focused on D. Both rules keep all four edges,
 * so the diamond does not tell them apart. A sibling does: with A→B and A→C focused on
 * B, "either end is lit" would light A→C, because A is lit. But C is not on any path
 * through B; it is a cousin, and lighting it is how a highlight feature slowly becomes a
 * highlight-everything feature on a real board. Requiring both ends to sit on the SAME
 * side of the focus — both upstream, or both downstream — is what keeps the lit subgraph
 * to paths that actually run through the focused ticket.
 *
 * Note the two sides both include the focus, which is what lets the last hop in
 * (A→focus is upstream; focus→Z is downstream) without any special-casing.
 */
export function lineageFrom(index: LineageIndex, focusId: string): Lineage {
  const ancestors = reach(index.blockers, focusId);
  const descendants = reach(index.dependents, focusId);

  const nodes = new Set<string>([focusId]);
  for (const id of ancestors) nodes.add(id);
  for (const id of descendants) nodes.add(id);

  const upstream = new Set<string>(ancestors).add(focusId);
  const downstream = new Set<string>(descendants).add(focusId);

  const edges = new Set<string>();
  for (const [to, froms] of index.blockers) {
    for (const from of froms) {
      const onUpstream = upstream.has(from) && upstream.has(to);
      const onDownstream = downstream.has(from) && downstream.has(to);
      if (onUpstream || onDownstream) edges.add(edgeKey(from, to));
    }
  }

  return { focus: focusId, ancestors, descendants, nodes, edges };
}

/**
 * One-shot convenience: build the index and walk it.
 *
 * Correct everywhere, wasteful in a hover handler — that is what `buildLineageIndex` +
 * `lineageFrom` are for. A focus id that appears in no edge is not an error: an isolated
 * ticket's lineage is itself, which dims the whole rest of the board, which is the true
 * and useful answer.
 */
export function lineageOf(edges: readonly LineageEdge[], focusId: string): Lineage {
  return lineageFrom(buildLineageIndex(edges), focusId);
}
