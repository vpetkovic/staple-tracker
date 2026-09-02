/**
 * O2a — the relation model behind the Relations tab (STA-131).
 *
 * What is worth pinning here is not "BFS walks a tree". It is the handful of ways this
 * module could quietly stop answering the question the tab exists to answer while still
 * returning plausible-looking arrays:
 *
 *   1. Ancestors in the wrong order. Leaf-first and root-first are the same SET, so a
 *      set assertion passes either way and the breadcrumb silently reads backwards.
 *   2. Conflating "blocked by" with "transitively blocked by". The stats strip shows
 *      BOTH numbers; a version that computed one and printed it twice would look right
 *      on every straight chain and wrong on every real board.
 *   3. Drifting from the store's unresolved semantics. `unresolvedBlockersFor` is a
 *      DIRECT count and treats cancelled as resolved. Either half is easy to lose.
 *   4. Bleeding into cousins. A sibling under the same epic is not a relation of the
 *      focus, and a sub-graph that includes it has stopped being "about this ticket".
 *   5. Losing the lineage node's parent. That one hop is the entire reason a cross-epic
 *      blocker can say which epic it belongs to.
 *   6. Losing `cross`. Cross-workspace edges are what a hub view exists for, and they
 *      are the only edges whose flag can be dropped without any other test noticing.
 *   7. Hanging on a cycle. The store rejects them; a hand-edited DB does not have to.
 *
 * Imports are relative, matching every other module under lib/ — and `relation-context`
 * itself only imports TYPES from ./types plus the real functions from ./graph-lineage,
 * so nothing here needs the app's `@` alias to resolve.
 */
import { describe, expect, it } from "vitest";
import { relationContext } from "./relation-context";
import { ISSUE_STATUSES, RESOLVED_STATUSES } from "./types";
import type { Graph, GraphEdge, GraphNode } from "./types";

// ---------- fixture helpers ----------

/** A node with the two fields most tests do not care about filled in. */
function node(
  id: string,
  status: GraphNode["status"],
  parent: string | null = null,
  workspace = "main",
): GraphNode {
  return { id, workspace, title: `${id} title`, status, parent };
}

function edge(from: string, to: string, cross = false): GraphEdge {
  return { from, to, cross };
}

/**
 * The board most assertions below run against.
 *
 *   STA-1  (epic)            STA-10 (epic)
 *     STA-2  <- focus          STA-11 (todo)   blocks STA-2
 *     STA-3  (done, sibling)   STA-12 (done)   blocks STA-11
 *   STA-20 (backlog)         blocked by STA-2
 *   STA-30 (backlog)         unrelated to everything
 *
 * STA-3 and STA-30 are the control group: a sibling and a stranger, neither of which is
 * a relation of STA-2, both of which a sloppy implementation would sweep in.
 */
const board: Graph = {
  nodes: [
    node("STA-1", "in_progress"),
    node("STA-2", "in_progress", "STA-1"),
    node("STA-3", "done", "STA-1"),
    node("STA-10", "backlog"),
    node("STA-11", "todo", "STA-10"),
    node("STA-12", "done", "STA-10"),
    node("STA-20", "backlog"),
    node("STA-30", "backlog"),
  ],
  edges: [edge("STA-11", "STA-2"), edge("STA-12", "STA-11"), edge("STA-2", "STA-20")],
};

/**
 * The acceptance criterion "no node unreachable from the focus", as a function.
 *
 * Written as an undirected walk over BOTH edge kinds on purpose: the tab draws ancestors
 * above and successors right, so "reachable" here means connected in the drawing, not
 * reachable by following arrowheads. A node the walk never touches is a box the canvas
 * would render floating with no line attached to it, which is the actual failure this
 * criterion is guarding against.
 */
function unreachableFrom(
  focus: string,
  sub: { nodes: readonly GraphNode[]; edges: readonly { from: string; to: string }[] },
): string[] {
  const neighbours = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    const bucket = neighbours.get(a);
    if (bucket) bucket.push(b);
    else neighbours.set(a, [b]);
  };
  for (const e of sub.edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  const seen = new Set<string>([focus]);
  const queue = [focus];
  while (queue.length > 0) {
    for (const next of neighbours.get(queue.pop()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return sub.nodes.map((n) => n.id).filter((id) => !seen.has(id));
}

const idsOf = (nodes: readonly GraphNode[]): string[] => nodes.map((n) => n.id).sort();

// ---------- ancestry ----------

describe("ancestry", () => {
  it("orders the parent chain root first, not leaf first", () => {
    // The two orders are the same SET, so only an ordered assertion can catch a reversal
    // — and a reversed breadcrumb is exactly the bug a set assertion would ship.
    const deep: Graph = {
      nodes: [
        node("STA-100", "backlog"),
        node("STA-101", "backlog", "STA-100"),
        node("STA-102", "backlog", "STA-101"),
        node("STA-103", "backlog", "STA-102"),
      ],
      edges: [],
    };
    expect(relationContext(deep, "STA-103").ancestors).toEqual(["STA-100", "STA-101", "STA-102"]);
  });

  it("gives a root task no ancestors rather than itself", () => {
    expect(relationContext(board, "STA-1").ancestors).toEqual([]);
  });

  it("excludes the focus from its own ancestry", () => {
    const context = relationContext(board, "STA-2");
    expect(context.ancestors).toEqual(["STA-1"]);
    expect(context.ancestors).not.toContain("STA-2");
  });

  it("does not hang when the parent pointers form a cycle", () => {
    // Impossible through the store, possible in a hand-edited DB. A confusing tab beats
    // a locked one.
    const cyclic: Graph = {
      nodes: [node("A", "backlog", "B"), node("B", "backlog", "A")],
      edges: [],
    };
    expect(relationContext(cyclic, "A").ancestors).toEqual(["B"]);
  });

  it("keeps walking up through a parent that is missing from the payload", () => {
    // Hub-shaped: a parent in a workspace this page cannot see. The chain must stop
    // cleanly rather than inventing a node.
    const orphan: Graph = { nodes: [node("STA-2", "backlog", "STA-1")], edges: [] };
    const context = relationContext(orphan, "STA-2");
    expect(context.ancestors).toEqual([]);
    expect(idsOf(context.graph.nodes)).toEqual(["STA-2"]);
  });
});

// ---------- subtree ----------

describe("subtree", () => {
  const tree: Graph = {
    nodes: [
      node("E", "in_progress"),
      node("C1", "done", "E"),
      node("C2", "todo", "E"),
      node("G1", "backlog", "C2"),
      node("G2", "cancelled", "C2"),
      node("OUT", "backlog"),
    ],
    edges: [],
  };

  it("separates direct children from the whole subtree", () => {
    const context = relationContext(tree, "E");
    expect(context.children).toEqual(["C1", "C2"]);
    expect(context.descendants.slice().sort()).toEqual(["C1", "C2", "G1", "G2"]);
  });

  it("counts children resolved/total the way the stats strip prints it", () => {
    // done and cancelled both count as resolved — an epic whose last child was cancelled
    // has to be able to read as finished.
    const context = relationContext(tree, "C2");
    expect(context.counts.children).toBe(2);
    expect(context.counts.childrenResolved).toBe(1);
  });

  it("excludes the focus and anything outside its subtree", () => {
    const context = relationContext(tree, "E");
    expect(context.descendants).not.toContain("E");
    expect(context.descendants).not.toContain("OUT");
  });

  it("does not hang on a parent cycle in the subtree walk", () => {
    const cyclic: Graph = {
      nodes: [node("A", "backlog", "B"), node("B", "backlog", "A")],
      edges: [],
    };
    expect(relationContext(cyclic, "A").descendants).toEqual(["B"]);
  });
});

// ---------- lineage, reused from graph-lineage.ts ----------

describe("predecessors and successors", () => {
  it("reaches transitive blockers and dependents, not just the immediate ones", () => {
    const context = relationContext(board, "STA-2");
    expect(context.predecessors.slice().sort()).toEqual(["STA-11", "STA-12"]);
    expect(context.successors).toEqual(["STA-20"]);
  });

  it("keeps the direct neighbours separate from the transitive ones", () => {
    // The strip prints both. A version that computed one number and showed it twice
    // would pass every straight-chain test and be wrong on every real board.
    const context = relationContext(board, "STA-2");
    expect(context.blockedBy).toEqual(["STA-11"]);
    expect(context.counts.blockedByDirect).toBe(1);
    expect(context.counts.blockedByTotal).toBe(2);
    expect(context.blocks).toEqual(["STA-20"]);
    expect(context.counts.blocksDirect).toBe(1);
    expect(context.counts.blocksTotal).toBe(1);
  });

  it("does not sweep in a cousin that merely shares a blocker", () => {
    // A -> B and A -> C. Focused on B, C is not a relation: it is a cousin, and lighting
    // it is how a focused view slowly becomes an unfocused one.
    const fan: Graph = {
      nodes: [node("A", "todo"), node("B", "todo"), node("C", "todo")],
      edges: [edge("A", "B"), edge("A", "C")],
    };
    const context = relationContext(fan, "B");
    expect(context.predecessors).toEqual(["A"]);
    expect(idsOf(context.graph.nodes)).toEqual(["A", "B"]);
  });
});

// ---------- counts, held against the store's semantics ----------

describe("unresolved blocker count", () => {
  /**
   * The same shape `store.unresolvedBlockersFor` is fed: several direct blockers with
   * mixed statuses. That query is DIRECT (one join, no recursion) and treats
   * done + cancelled as resolved. Both halves are pinned here.
   */
  const mixed: Graph = {
    nodes: [
      node("F", "blocked"),
      node("B-done", "done"),
      node("B-cancelled", "cancelled"),
      node("B-review", "in_review"),
      node("B-todo", "todo"),
      node("UPSTREAM", "todo"),
    ],
    edges: [
      edge("B-done", "F"),
      edge("B-cancelled", "F"),
      edge("B-review", "F"),
      edge("B-todo", "F"),
      edge("UPSTREAM", "B-todo"),
    ],
  };

  it("counts only DIRECT blockers, matching the store's single join", () => {
    const context = relationContext(mixed, "F");
    // UPSTREAM blocks a blocker of F. The store would not count it; neither do we.
    expect(context.counts.blockedByDirect).toBe(4);
    expect(context.counts.blockedByUnresolved).toBe(2);
    expect(context.unresolvedBlockers).toEqual(["B-review", "B-todo"]);
  });

  it("treats cancelled as resolved, exactly like RESOLVED_STATUSES", () => {
    expect(relationContext(mixed, "F").unresolvedBlockers).not.toContain("B-cancelled");
    expect(relationContext(mixed, "F").unresolvedBlockers).not.toContain("B-done");
  });

  it("uses exactly RESOLVED_STATUSES, the same list the store filters on", () => {
    /**
     * The store's query says `b.status NOT IN (done, cancelled)`; `RESOLVED_STATUSES` in
     * ./types is this app's mirror of that same core constant. Rather than restate the
     * two names here — which would drift the day a third resolved status is added — this
     * drives one blocker through EVERY status and asserts the resolved/unresolved split
     * lands exactly where the shared constant says it should.
     *
     * This is how the "matches unresolvedBlockersFor semantics" criterion is met without
     * importing src/core: core is Node-only (`node:sqlite`), and the app builds under a
     * DOM tsconfig that must never see it — the reason ./types is a hand-kept mirror in
     * the first place.
     */
    const resolved = new Set<string>(RESOLVED_STATUSES);
    for (const status of ISSUE_STATUSES) {
      const one: Graph = {
        nodes: [node("F", "blocked"), node("B", status)],
        edges: [edge("B", "F")],
      };
      const context = relationContext(one, "F");
      expect(context.counts.blockedByDirect).toBe(1);
      expect(context.counts.blockedByUnresolved).toBe(resolved.has(status) ? 0 : 1);
    }
  });

  it("reports the transitive total as a SEPARATE number from the direct one", () => {
    const context = relationContext(mixed, "F");
    expect(context.counts.blockedByDirect).toBe(4);
    expect(context.counts.blockedByTotal).toBe(5);
  });

  it("treats a blocker missing from the payload as unresolved", () => {
    // We cannot prove it is done, and under-reporting a blocker is the dangerous
    // direction. Neither producer can emit this; it is a corrupt-payload guard.
    const partial: Graph = { nodes: [node("F", "blocked")], edges: [edge("GHOST", "F")] };
    const context = relationContext(partial, "F");
    expect(context.counts.blockedByUnresolved).toBe(1);
    expect(context.unresolvedBlockers).toEqual(["GHOST"]);
  });
});

// ---------- the sub-graph the tab draws ----------

describe("sub-graph", () => {
  it("contains the focus, its chain, its subtree, its lineage and the lineage parents", () => {
    const context = relationContext(board, "STA-2");
    expect(idsOf(context.graph.nodes)).toEqual([
      "STA-1", // ancestor
      "STA-10", // parent of the blockers — the whole point of the extra hop
      "STA-11", // predecessor
      "STA-12", // transitive predecessor
      "STA-2", // focus
      "STA-20", // successor
    ]);
  });

  it("leaves out the sibling and the stranger", () => {
    const drawn = idsOf(relationContext(board, "STA-2").graph.nodes);
    expect(drawn).not.toContain("STA-3");
    expect(drawn).not.toContain("STA-30");
  });

  it("contains no node unreachable from the focus", () => {
    for (const focus of board.nodes.map((n) => n.id)) {
      const context = relationContext(board, focus);
      expect(unreachableFrom(focus, context.graph)).toEqual([]);
    }
  });

  it("draws parent edges from parent to child and marks their kind", () => {
    const context = relationContext(board, "STA-2");
    const parents = context.graph.edges
      .filter((e) => e.kind === "parent")
      .map((e) => `${e.from}->${e.to}`)
      .sort();
    expect(parents).toEqual(["STA-1->STA-2", "STA-10->STA-11", "STA-10->STA-12"]);
  });

  it("draws every blocks edge whose ends are both on screen", () => {
    const context = relationContext(board, "STA-2");
    const blocks = context.graph.edges
      .filter((e) => e.kind === "blocks")
      .map((e) => `${e.from}->${e.to}`)
      .sort();
    expect(blocks).toEqual(["STA-11->STA-2", "STA-12->STA-11", "STA-2->STA-20"]);
  });

  it("never emits an edge to a node it did not include", () => {
    const context = relationContext(board, "STA-2");
    const drawn = new Set(context.graph.nodes.map((n) => n.id));
    for (const e of context.graph.edges) {
      expect(drawn.has(e.from)).toBe(true);
      expect(drawn.has(e.to)).toBe(true);
    }
  });

  it("hands back whole nodes, so the tab can render titles without a second lookup", () => {
    const focus = relationContext(board, "STA-2").graph.nodes.find((n) => n.id === "STA-2");
    expect(focus?.title).toBe("STA-2 title");
    expect(focus?.status).toBe("in_progress");
  });
});

// ---------- hub mode ----------

describe("hub-shaped payloads", () => {
  /**
   * The shape `Hub.graph()` really returns: nodes from two workspaces, each carrying
   * `parent` as the parent's IDENTIFIER (never a uuid, never null just because it is
   * hub mode), plus a cross-workspace edge flagged `cross: true`.
   *
   * This is the ticket's "hub-mode /api/graph nodes carry parent so epics resolve across
   * workspaces" criterion, asserted where it can be asserted without a database: the
   * producer already emits the field (src/core/hub.ts) and the route already passes it
   * through (src/ui/server.ts), so what is left to prove is that this module RESOLVES
   * epics for both workspaces off it.
   */
  const hub: Graph = {
    nodes: [
      node("ALPHA-1", "in_progress", null, "alpha"),
      node("ALPHA-2", "todo", "ALPHA-1", "alpha"),
      node("BETA-1", "backlog", null, "beta"),
      node("BETA-2", "todo", "BETA-1", "beta"),
    ],
    edges: [edge("BETA-2", "ALPHA-2", true)],
  };

  it("resolves each node's epic in its own workspace", () => {
    expect(relationContext(hub, "ALPHA-2").ancestors).toEqual(["ALPHA-1"]);
    expect(relationContext(hub, "BETA-2").ancestors).toEqual(["BETA-1"]);
  });

  it("shows a cross-workspace blocker together with the epic it belongs to", () => {
    // Without the lineage-parent hop, BETA-2 would appear as a bare box from some other
    // workspace with no indication of what it is part of.
    const context = relationContext(hub, "ALPHA-2");
    expect(idsOf(context.graph.nodes)).toEqual(["ALPHA-1", "ALPHA-2", "BETA-1", "BETA-2"]);
    expect(context.predecessors).toEqual(["BETA-2"]);
  });

  it("keeps the cross flag on the edge that crosses workspaces", () => {
    const context = relationContext(hub, "ALPHA-2");
    const crossing = context.graph.edges.filter((e) => e.cross);
    expect(crossing.map((e) => `${e.from}->${e.to}`)).toEqual(["BETA-2->ALPHA-2"]);
    expect(context.counts.crossEdges).toBe(1);
  });

  it("counts the visible nodes that live in another workspace", () => {
    expect(relationContext(hub, "ALPHA-2").counts.crossNodes).toBe(2);
    expect(relationContext(hub, "ALPHA-1").counts.crossNodes).toBe(0);
  });

  it("flags a parent edge as crossing only when it really crosses", () => {
    // Parents never span workspaces today, so every parent edge here is solid. The flag
    // is computed rather than hardcoded so the day that changes, the dashes are right.
    const context = relationContext(hub, "ALPHA-2");
    for (const e of context.graph.edges.filter((edg) => edg.kind === "parent")) {
      expect(e.cross).toBe(false);
    }
  });
});

// ---------- the states the tab has to render ----------

describe("degenerate inputs", () => {
  it("reports a focus that is not in the payload as not found, without throwing", () => {
    const context = relationContext(board, "STA-999");
    expect(context.found).toBe(false);
    expect(context.focus).toBe("STA-999");
    expect(context.graph.nodes).toEqual([]);
    expect(context.hasRelations).toBe(false);
  });

  it("survives an empty payload, which is what the tab renders while loading", () => {
    const context = relationContext({ nodes: [], edges: [] }, "STA-2");
    expect(context.found).toBe(false);
    expect(context.counts.blockedByTotal).toBe(0);
  });

  it("says a lonely task has no relations rather than drawing one box", () => {
    const context = relationContext(board, "STA-30");
    expect(context.found).toBe(true);
    expect(context.hasRelations).toBe(false);
    expect(idsOf(context.graph.nodes)).toEqual(["STA-30"]);
  });

  it("says a task with any relation at all has relations", () => {
    expect(relationContext(board, "STA-2").hasRelations).toBe(true);
    expect(relationContext(board, "STA-1").hasRelations).toBe(true);
  });

  it("does not mutate the payload it was handed", () => {
    // The tab recomputes on every poll off the cached graph. A walk that wrote into it
    // would make the second render disagree with the first.
    const before = JSON.stringify(board);
    for (const focus of board.nodes.map((n) => n.id)) relationContext(board, focus);
    expect(JSON.stringify(board)).toBe(before);
  });

  it("is deterministic across repeated calls", () => {
    const once = relationContext(board, "STA-2");
    const twice = relationContext(board, "STA-2");
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});
