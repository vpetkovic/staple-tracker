/**
 * "What is the logical path forward" — G4 (STA-57), as pure functions.
 *
 * Three planning questions, one answer shape. Each mode picks a SET OF IDS to keep lit
 * and everything else dims, which is the language G1 already established for hover
 * lineage — opacity, never a new colour. That is why this file returns `Emphasis` and
 * draws nothing: the canvas has exactly one way of saying "look here", and a third mode
 * added later should have to use it too.
 *
 * WHY THIS WORKS ON CLUSTERS FOR FREE. Everything below takes `{ id, status }`, which a
 * ticket satisfies and a collapsed epic also satisfies (its aggregate status, from
 * graph-clusters.ts). So "frontier" over a collapsed board answers "which EPICS are
 * ready to move" and the same code answers "which tickets" when expanded. No branch, no
 * second implementation, and the two answers cannot drift.
 *
 * Type imports only, so the test can import this with a relative path — see the note in
 * graph-clusters.ts.
 */
import type { IssueStatus } from "@/lib/types";
import { isResolved } from "./graph-clusters";

/** The three states of the done control. */
export type DoneMode = "show" | "fade" | "hide";

/** Which planning question the canvas is answering, if any. */
export type PlanningMode = "off" | "frontier" | "path";

/** The minimum a box has to be for any of this to apply. */
export interface PlanningNode {
  id: string;
  status: IssueStatus;
}

export interface PlanningEdge {
  from: string;
  to: string;
}

/** What stays lit. `null` from a caller means "no question asked", which dims nothing. */
export interface Emphasis {
  nodes: Set<string>;
  edges: Set<string>;
}

/** The same NUL-joined edge key lib/graph-lineage.ts uses, and for the same reason. */
export function planKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/**
 * Everything that could be picked up right now.
 *
 * THE RULE IS THE STORE'S, NOT A NEW ONE. `store.inbox()` calls an issue blocked when its
 * status is `blocked` or it has unresolved blockers, and ready otherwise. This mirrors
 * that exactly, minus resolved work. Inventing a second definition of "ready" for the
 * graph is how the canvas and `staple inbox` start giving a meeting two different answers
 * to the same question, which is a bug that is very hard to see and very embarrassing to
 * find out loud.
 *
 * A node with no blockers at all is on the frontier, which is the common case for the
 * left edge of the graph and is why this is not just "things with satisfied blockers".
 */
export function frontier(
  nodes: readonly PlanningNode[],
  edges: readonly PlanningEdge[],
): Set<string> {
  const statusOf = new Map(nodes.map((node) => [node.id, node.status]));

  /** id -> does it still have a blocker that has not been finished. */
  const stillBlocked = new Set<string>();
  for (const edge of edges) {
    const blocker = statusOf.get(edge.from);
    // An edge naming a node that is not on the canvas cannot be judged, so it is not
    // allowed to hold anything back — the alternative is a permanently empty frontier
    // whenever a cross-workspace blocker lives somewhere this page cannot see.
    if (blocker === undefined) continue;
    if (!isResolved(blocker)) stillBlocked.add(edge.to);
  }

  const ready = new Set<string>();
  for (const node of nodes) {
    if (isResolved(node.status)) continue;
    if (node.status === "blocked") continue;
    if (stillBlocked.has(node.id)) continue;
    ready.add(node.id);
  }
  return ready;
}

/**
 * The chain of unfinished work standing between today and `target`.
 *
 * THE WALK STOPS AT RESOLVED NODES; IT DOES NOT FILTER THEM OUT AFTERWARDS. That is the
 * whole correctness of this function, and the difference shows up here:
 *
 *     X (todo) → A (done) → TARGET
 *
 * `A` is finished, so `TARGET` is not waiting on it — and it is therefore not waiting on
 * `X` either, even though `X` is genuinely upstream in the graph. Filtering the full
 * ancestor set down to "the unresolved ones" would light `X` and tell a planning meeting
 * that a piece of work stands in the way when a completed blocker already made it
 * irrelevant. Refusing to traverse THROUGH a resolved node is what makes the answer mean
 * "what is left".
 *
 * The target itself is included when it is unresolved, because the chain to a ticket ends
 * at the ticket. An already-finished target lights nothing: there is nothing between you
 * and it.
 */
export function unfinishedChain(
  nodes: readonly PlanningNode[],
  edges: readonly PlanningEdge[],
  target: string,
): Emphasis {
  const statusOf = new Map(nodes.map((node) => [node.id, node.status]));
  const done = (id: string): boolean => {
    const status = statusOf.get(id);
    // An unknown node is not known to be finished, so it stays in the chain rather than
    // silently truncating it.
    return status !== undefined && isResolved(status);
  };

  const chain: Emphasis = { nodes: new Set(), edges: new Set() };
  if (!statusOf.has(target) || done(target)) return chain;

  const blockers = new Map<string, string[]>();
  for (const edge of edges) {
    const bucket = blockers.get(edge.to);
    if (bucket) bucket.push(edge.from);
    else blockers.set(edge.to, [edge.from]);
  }

  chain.nodes.add(target);
  const queue = [target];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const blocker of blockers.get(current) ?? []) {
      // The edge is lit whenever it is an unfinished blocker OF something in the chain,
      // so the last hop into an unfinished node is drawn even though the walk stops.
      if (done(blocker)) continue;
      chain.edges.add(planKey(blocker, current));
      if (chain.nodes.has(blocker)) continue; // cycle guard; see graph-lineage.ts
      chain.nodes.add(blocker);
      queue.push(blocker);
    }
  }
  return chain;
}

/** An edge after resolved work was removed. `derived` ones were bridged across it. */
export interface BridgedEdge<E> {
  edge: E;
  from: string;
  to: string;
  /** True when this arrow stands for a path through hidden nodes rather than one edge. */
  derived: boolean;
}

/**
 * Re-wire the graph across nodes that are being hidden.
 *
 * WITHOUT THIS, HIDING DONE WORK LIES. A plan where `A → done → C` becomes two
 * disconnected islands the moment finished work is hidden, and a graph that shows two
 * unrelated boxes when they are in fact one chain is worse than a cluttered one — the
 * clutter is honest. So every path that ran through a hidden node is redrawn as a single
 * arrow between the visible ends, and drawn dotted so it is never mistaken for a
 * dependency somebody actually recorded.
 *
 * A direct edge always wins over a bridged one between the same pair: if A blocks C
 * outright, that is the true relationship and the fact that a longer finished path also
 * connected them adds nothing.
 *
 * The walk through hidden nodes has a visited set per source, so a cycle among hidden
 * nodes cannot hang the tab — the same promise the rest of this module's traversals make.
 */
export function bridgeResolved<E extends PlanningEdge>(
  edges: readonly E[],
  hidden: ReadonlySet<string>,
): BridgedEdge<E>[] {
  const direct: BridgedEdge<E>[] = [];
  const bridged = new Map<string, BridgedEdge<E>>();

  const outgoing = new Map<string, E[]>();
  for (const edge of edges) {
    const bucket = outgoing.get(edge.from);
    if (bucket) bucket.push(edge);
    else outgoing.set(edge.from, [edge]);
  }

  const seenDirect = new Set<string>();
  for (const edge of edges) {
    if (hidden.has(edge.from)) continue;
    if (!hidden.has(edge.to)) {
      direct.push({ edge, from: edge.from, to: edge.to, derived: false });
      seenDirect.add(planKey(edge.from, edge.to));
      continue;
    }
    // Into the hidden region: keep walking until visible ground.
    const visited = new Set<string>([edge.to]);
    const queue = [edge.to];
    while (queue.length > 0) {
      const current = queue.pop()!;
      for (const next of outgoing.get(current) ?? []) {
        if (hidden.has(next.to)) {
          if (visited.has(next.to)) continue;
          visited.add(next.to);
          queue.push(next.to);
          continue;
        }
        if (next.to === edge.from) continue; // a loop back to where we started
        const key = planKey(edge.from, next.to);
        if (!bridged.has(key)) {
          bridged.set(key, { edge, from: edge.from, to: next.to, derived: true });
        }
      }
    }
  }

  return [...direct, ...[...bridged.values()].filter((b) => !seenDirect.has(planKey(b.from, b.to)))];
}

/**
 * Which set of ids the canvas should light, given everything that could want a say.
 *
 * HOVER WINS. It is the most recent thing the user did and it is transient; a planning
 * mode is a standing question that the pointer is temporarily interrupting. The other
 * order — mode outranks hover — makes the graph stop reacting to the pointer while a mode
 * is on, which reads as the page having frozen. Letting go restores the mode, so it never
 * has to be re-armed.
 *
 * Selection is last because it is the stickiest and least deliberate of the three: a
 * ticket stays selected long after you stopped asking about it.
 *
 * `null` means nothing is emphasized and therefore NOTHING dims — the same contract
 * `lineage === null` has carried since G1.
 */
export function emphasisFor(input: {
  hoverLineage: Emphasis | null;
  mode: PlanningMode;
  frontierSet: Set<string> | null;
  pathChain: Emphasis | null;
  selectionLineage: Emphasis | null;
}): Emphasis | null {
  if (input.hoverLineage) return input.hoverLineage;
  if (input.mode === "frontier" && input.frontierSet) {
    // Frontier is a statement about NODES. Lighting the edges between two ready tickets
    // would suggest a relationship between them; being ready together is not one.
    return { nodes: input.frontierSet, edges: new Set() };
  }
  if (input.mode === "path" && input.pathChain) return input.pathChain;
  return input.selectionLineage;
}
