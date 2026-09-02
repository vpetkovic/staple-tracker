/**
 * G3 — the grouping, and the two things about it that would ship broken.
 *
 * The easy half is arithmetic: does `3/9 done` say 3 and 9. It is worth pinning because
 * the definitions are choices (cancelled counts as resolved; the denominator is DRAWN
 * members, not every child) and a later reader is more likely to "fix" a choice than a
 * bug.
 *
 * The half that would actually get out the door wrong is the edge rewrite. Collapsing an
 * epic is only calmer than not collapsing it if the nine arrows between epic A and epic
 * B become ONE arrow — dedupe is the entire feature, not a tidy-up — and if the arrows
 * INSIDE a collapsed epic disappear rather than turning into self-loops on the
 * super-node. Neither is visible in a screenshot of a small fixture and both are obvious
 * in front of a real board, which is the worst place to find out.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's alias does not exist at test time. graph-clusters.ts only ever `import type`s
 * from "@/lib/types", and those are erased before this runs.
 */
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode, IssueStatus } from "@/lib/types";
import {
  COLLAPSE_THRESHOLD,
  aggregateStatus,
  boundaryEdges,
  clusterId,
  collapseGraph,
  containerize,
  dimContainers,
  epicOfClusterId,
  filterEpicRows,
  flattenEpics,
  isClusterId,
  restrictToEpic,
  restrictToEpics,
  shouldDefaultCollapse,
  summarizeEpics,
  withDescendantEpics,
  type CanvasNode,
} from "./graph-clusters";

const task = (
  id: string,
  parent: string | null = null,
  status: IssueStatus = "todo",
): GraphNode => ({ id, workspace: "sta", title: `${id} title`, status, parent });

const edge = (from: string, to: string, cross = false): GraphEdge => ({ from, to, cross });

/** The single summary these fixtures expect, asserted rather than indexed-and-hoped. */
const one = <T,>(summaries: T[]): T => {
  expect(summaries).toHaveLength(1);
  return summaries[0]!;
};

describe("cluster ids", () => {
  it("cannot collide with a task identifier", () => {
    // Identifiers are PREFIX-123 and contain no colon; that is the whole guarantee.
    expect(isClusterId(clusterId("STA-53"))).toBe(true);
    expect(isClusterId("STA-53")).toBe(false);
    expect(epicOfClusterId(clusterId("STA-53"))).toBe("STA-53");
    expect(epicOfClusterId("STA-53")).toBeNull();
  });
});

describe("aggregateStatus", () => {
  it("reads as done only when every member is finished", () => {
    expect(aggregateStatus(["done", "done", "cancelled"])).toBe("done");
    expect(aggregateStatus(["done", "done", "todo"])).not.toBe("done");
  });

  it("lets active work outrank everything quieter", () => {
    // An epic with one ticket moving and six in the backlog is an epic in progress.
    expect(aggregateStatus(["backlog", "backlog", "in_progress", "blocked"])).toBe("in_progress");
    expect(aggregateStatus(["backlog", "blocked", "todo"])).toBe("blocked");
    expect(aggregateStatus(["backlog", "in_review", "todo"])).toBe("in_review");
    expect(aggregateStatus(["backlog", "todo"])).toBe("todo");
    expect(aggregateStatus(["backlog", "backlog"])).toBe("backlog");
  });

  it("does not let a finished member drag the epic to done", () => {
    expect(aggregateStatus(["done", "backlog"])).toBe("backlog");
  });
});

describe("summarizeEpics", () => {
  it("counts the members the canvas draws, not every child of the epic", () => {
    // E has three children but only two are wired into dependencies, so only two are
    // drawn. The badge must say 2, because 2 is what expanding the cluster produces.
    const all = [task("E"), task("A", "E", "done"), task("B", "E"), task("C", "E")];
    const drawn = [task("A", "E", "done"), task("B", "E")];
    const epic = one(summarizeEpics(all, drawn));
    expect(epic.total).toBe(2);
    expect(epic.resolved).toBe(1);
    expect(epic.members).toEqual(["A", "B"]);
  });

  it("counts a cancelled member as resolved", () => {
    const all = [task("E"), task("A", "E", "done"), task("B", "E", "cancelled")];
    const epic = one(summarizeEpics(all, all.slice(1)));
    expect(epic.resolved).toBe(2);
    expect(epic.total).toBe(2);
  });

  it("takes its title from the epic ticket even when the epic is not drawn", () => {
    // The common case: an epic contains work but blocks nothing, so it has no edges and
    // connectedNodes drops it. The cluster still has to be labelled.
    const all = [task("E"), task("A", "E")];
    const epic = one(summarizeEpics(all, [task("A", "E")]));
    expect(epic.title).toBe("E title");
    expect(epic.members).toEqual(["A"]);
  });

  it("absorbs the epic's own node when the epic is itself drawn", () => {
    // Otherwise the epic would sit next to the super-node that stands for it.
    const all = [task("E"), task("A", "E")];
    const epic = one(summarizeEpics(all, all));
    expect(epic.members).toEqual(["E", "A"]);
    expect(epic.total).toBe(2);
  });

  it("ignores parentless tickets entirely", () => {
    expect(summarizeEpics([task("A"), task("B")], [task("A"), task("B")])).toEqual([]);
  });

  it("still groups when the epic ticket is missing from the payload", () => {
    // Hub-shaped: the parent lives in a workspace this page cannot see. Losing the
    // grouping would be worse than an unglamorous title.
    const epic = one(summarizeEpics([task("A", "GONE")], [task("A", "GONE")]));
    expect(epic.id).toBe("GONE");
    expect(epic.title).toBe("GONE");
  });
});

describe("collapseGraph", () => {
  const all = [
    task("E1"),
    task("E2"),
    task("A1", "E1"),
    task("A2", "E1"),
    task("B1", "E2"),
    task("B2", "E2"),
  ];
  const drawn = all.slice(2);
  const epics = summarizeEpics(all, drawn);

  it("bundles every edge between two epics into ONE arrow", () => {
    // THE point of the feature. Four crossings become one line, not four drawn on top
    // of each other — a collapsed view that still draws forty arrows is not calmer.
    const edges = [edge("A1", "B1"), edge("A1", "B2"), edge("A2", "B1"), edge("A2", "B2")];
    const result = collapseGraph(drawn, edges, epics, new Set(["E1", "E2"]));
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toMatchObject({
      from: clusterId("E1"),
      to: clusterId("E2"),
      count: 4,
    });
  });

  it("drops edges that are internal to a collapsed epic", () => {
    // A1 -> A2 is exactly what collapsing E1 is hiding. Mapped naively it would be a
    // self-loop on the super-node, which React Flow will happily draw as a lasso.
    const result = collapseGraph(drawn, [edge("A1", "A2")], epics, new Set(["E1"]));
    expect(result.edges).toEqual([]);
  });

  it("replaces the members of a collapsed epic with one super-node", () => {
    const result = collapseGraph(drawn, [edge("A1", "B1")], epics, new Set(["E1"]));
    expect(result.nodes.map((n) => n.id)).toEqual([clusterId("E1"), "B1", "B2"]);
    const cluster = result.nodes.find((n) => n.kind === "cluster");
    expect(cluster?.kind === "cluster" && cluster.epic.total).toBe(2);
  });

  it("leaves an expanded graph exactly as it found it", () => {
    // The empty collapse set must be a true no-op: same nodes, same edges, count 1.
    const edges = [edge("A1", "B1"), edge("A2", "B2")];
    const result = collapseGraph(drawn, edges, epics, new Set());
    expect(result.nodes.map((n) => n.id)).toEqual(["A1", "A2", "B1", "B2"]);
    expect(result.nodes.every((n) => n.kind === "task")).toBe(true);
    expect(result.edges).toEqual([
      { from: "A1", to: "B1", cross: false, count: 1 },
      { from: "A2", to: "B2", cross: false, count: 1 },
    ]);
  });

  it("keeps an un-collapsed ticket wired to the cluster that swallowed its neighbour", () => {
    const loose = [...drawn, task("LOOSE")];
    const result = collapseGraph(loose, [edge("LOOSE", "A1")], epics, new Set(["E1"]));
    expect(result.edges).toEqual([
      { from: "LOOSE", to: clusterId("E1"), cross: false, count: 1 },
    ]);
  });

  it("calls a bundle cross-workspace only when every edge in it is", () => {
    // Dashed promises "this connection crosses workspaces". One cross edge among four
    // must not be allowed to make that promise on behalf of the other three.
    const mixed = [edge("A1", "B1", true), edge("A2", "B2", false)];
    const partly = collapseGraph(drawn, mixed, epics, new Set(["E1", "E2"]));
    expect(partly.edges[0]!.cross).toBe(false);

    const bothCross = [edge("A1", "B1", true), edge("A2", "B2", true)];
    const wholly = collapseGraph(drawn, bothCross, epics, new Set(["E1", "E2"]));
    expect(wholly.edges[0]!.cross).toBe(true);
  });

  it("dedupes a dependency that was recorded twice", () => {
    const twice = [edge("A1", "B1"), edge("A1", "B1")];
    const result = collapseGraph(drawn, twice, epics, new Set());
    expect(result.edges).toEqual([{ from: "A1", to: "B1", cross: false, count: 2 }]);
  });
});

describe("restrictToEpic", () => {
  const nodes = [task("A1", "E1"), task("A2", "E1"), task("B1", "E2")];
  const epics = summarizeEpics([task("E1"), ...nodes], nodes);
  const e1 = epics.find((e) => e.id === "E1")!;

  it("keeps only the epic's members", () => {
    const result = restrictToEpic(nodes, [], e1);
    expect(result.nodes.map((n) => n.id)).toEqual(["A1", "A2"]);
  });

  it("drops an edge with only one end inside the epic", () => {
    // A half-edge points at a box that is not on screen, which reads as a rendering
    // bug. A missing edge reads as the filter doing what was asked.
    const result = restrictToEpic(nodes, [edge("A1", "A2"), edge("A2", "B1")], e1);
    expect(result.edges).toEqual([{ from: "A1", to: "A2", cross: false }]);
  });

  it("is a no-op with no epic selected", () => {
    const edges = [edge("A2", "B1")];
    const result = restrictToEpic(nodes, edges, null);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toEqual(edges);
  });
});

describe("shouldDefaultCollapse", () => {
  it("opens flat below the threshold and clustered above it", () => {
    expect(shouldDefaultCollapse(COLLAPSE_THRESHOLD)).toBe(false);
    expect(shouldDefaultCollapse(COLLAPSE_THRESHOLD + 1)).toBe(true);
  });
});

/**
 * ── O4b (STA-134): the picker's data layer ──────────────────────────────────────────
 *
 * Everything below exists because the epic picker has to answer three questions the
 * single-epic filter never had to: which epics contain which (so rows can indent), what
 * a selection of several means (the union, and how far down it reaches), and what a query
 * leaves standing. All three are pure, and all three are the kind of thing that looks
 * right in a screenshot of a two-epic fixture and is wrong on a real board.
 */

/** A nested fixture: E1 > E2 > E3, plus a sibling root E9 and tickets under each. */
const nested = () => {
  const all = [
    { ...task("E1"), title: "Platform" },
    { ...task("E2", "E1"), title: "Auth" },
    { ...task("E3", "E2"), title: "Tokens" },
    { ...task("E9"), title: "Docs" },
    task("A1", "E1"),
    task("A2", "E2"),
    task("A3", "E3"),
    task("A9", "E9"),
  ];
  // Every ticket is drawn, and so are the child epics (they are members of their parents).
  return summarizeEpics(all, all);
};

describe("summarizeEpics — hierarchy and kind (O4b)", () => {
  it("reports the epic's own parent, so rows can nest", () => {
    const byId = new Map(nested().map((epic) => [epic.id, epic]));
    expect(byId.get("E1")!.parent).toBeNull();
    expect(byId.get("E2")!.parent).toBe("E1");
    expect(byId.get("E3")!.parent).toBe("E2");
    expect(byId.get("E9")!.parent).toBeNull();
  });

  it("drops a parent that is not itself an epic on this canvas", () => {
    // Indenting a row under a row that does not exist is the failure being prevented:
    // GHOST parents E and nothing else here, so it gets no bucket and therefore no row,
    // and E has to read as top-level rather than as a child of something invisible.
    const orphan = summarizeEpics([task("E", "GHOST"), task("A", "E")], [task("A", "E")]);
    expect(one(orphan).parent).toBeNull();
  });

  it("carries the epic's declared kind through from the graph node", () => {
    const all = [{ ...task("E"), kind: "epic" }, task("A", "E")];
    expect(one(summarizeEpics(all, all.slice(1))).kind).toBe("epic");
    // Absent means "an older server omitted the field", never "no kind" — the picker
    // draws its default mark rather than treating it as an error.
    expect(one(summarizeEpics([task("E"), task("A", "E")], [task("A", "E")])).kind).toBeUndefined();
  });
});

describe("restrictToEpics", () => {
  const nodes = [task("A1", "E1"), task("A2", "E1"), task("B1", "E2"), task("C1", "E3")];
  const epics = summarizeEpics([task("E1"), task("E2"), task("E3"), ...nodes], nodes);
  const pick = (...ids: string[]) => epics.filter((epic) => ids.includes(epic.id));

  it("shows the UNION of the selected epics, not their intersection", () => {
    // Two epics share no members by construction — a ticket has one parent — so an
    // intersecting filter would go blank the moment it was used for what it is for.
    const result = restrictToEpics(nodes, [], pick("E1", "E2"));
    expect(result.nodes.map((n) => n.id)).toEqual(["A1", "A2", "B1"]);
  });

  it("keeps an edge that runs BETWEEN two selected epics", () => {
    // This is the whole reason the filter went plural: "show me these two and how they
    // relate" is unanswerable if the arrow between them is dropped as a half-edge.
    const result = restrictToEpics(nodes, [edge("A2", "B1"), edge("B1", "C1")], pick("E1", "E2"));
    expect(result.edges).toEqual([{ from: "A2", to: "B1", cross: false }]);
  });

  it("is a no-op on an empty selection — that is the whole graph", () => {
    const edges = [edge("A2", "B1")];
    const result = restrictToEpics(nodes, edges, []);
    expect(result.nodes).toHaveLength(4);
    expect(result.edges).toEqual(edges);
  });

  it("ignores a selected epic that no longer exists rather than emptying the canvas", () => {
    // A shared link outlives the epic it named. `pick` returns nothing for a dead id, so
    // a selection of only-dead ids is an empty list, which is "the whole graph".
    expect(restrictToEpics(nodes, [], pick("GONE")).nodes).toHaveLength(4);
  });

  it("still answers the single-epic question through the wrapper", () => {
    const e1 = epics.find((e) => e.id === "E1")!;
    expect(restrictToEpic(nodes, [], e1).nodes.map((n) => n.id)).toEqual(["A1", "A2"]);
    expect(restrictToEpic(nodes, [], null).nodes).toHaveLength(4);
  });
});

describe("withDescendantEpics", () => {
  it("pulls a selected epic's child epics in with it", () => {
    // Without this, selecting E1 draws E2's node and NONE of the tickets under it —
    // a box with its contents surgically removed. summarizeEpics buckets by DIRECT
    // parent, so the grandchildren live nowhere else.
    const ids = withDescendantEpics(nested(), new Set(["E1"])).map((epic) => epic.id);
    expect(ids).toEqual(["E1", "E2", "E3"]);
  });

  it("does not reach upward", () => {
    expect(withDescendantEpics(nested(), new Set(["E2"])).map((e) => e.id)).toEqual(["E2", "E3"]);
  });

  it("returns each epic once when two selections overlap", () => {
    const ids = withDescendantEpics(nested(), new Set(["E1", "E3"])).map((epic) => epic.id);
    expect(ids).toEqual(["E1", "E2", "E3"]);
  });

  it("is empty for an empty selection, which the caller reads as no filter", () => {
    expect(withDescendantEpics(nested(), new Set())).toEqual([]);
  });
});

describe("flattenEpics", () => {
  it("puts every epic directly under its parent, indented", () => {
    // The identifier-sorted list summarizeEpics returns is right for super-nodes and
    // wrong for a menu: an epic and its child end up rows apart with strangers between.
    expect(flattenEpics(nested()).map((row) => [row.epic.id, row.depth])).toEqual([
      ["E1", 0],
      ["E2", 1],
      ["E3", 2],
      ["E9", 0],
    ]);
  });

  it("emits every epic exactly once even if the parent links form a cycle", () => {
    // A cycle cannot come out of the store, and a render that hangs is a worse way to
    // find out than a list that is merely flat.
    const self = one(summarizeEpics([task("E1"), task("A", "E1")], [task("A", "E1")]));
    const rows = flattenEpics([{ ...self, parent: self.id }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.depth).toBe(0);
  });
});

describe("filterEpicRows", () => {
  const rows = flattenEpics(nested());
  const shown = (query: string) => filterEpicRows(rows, query).map((row) => row.epic.id);

  it("returns everything, matched, for an empty query", () => {
    expect(filterEpicRows(rows, "  ").every((row) => row.matched)).toBe(true);
    expect(shown("")).toHaveLength(4);
  });

  it("matches on identifier and on title", () => {
    expect(shown("e9")).toEqual(["E9"]);
    expect(shown("docs")).toEqual(["E9"]);
  });

  it("keeps the list's order rather than a relevance order", () => {
    // The R7 rule: a fuzzy scorer puts STA-118 above STA-1 for the query "STA-1", and a
    // list of identifiers that reshuffles as you type is a list you cannot aim at.
    expect(shown("e")).toEqual(["E1", "E2", "E3", "E9"]);
  });

  it("narrows on every token, so two words mean AND", () => {
    expect(shown("e3 tokens")).toEqual(["E1", "E2", "E3"]);
    expect(shown("e3 platform")).toEqual([]);
  });

  it("brings a match's ancestors along, flagged as context", () => {
    // Indentation is a claim about the row above it. A child surfacing alone at depth 2
    // under an unrelated epic would state a containment that is false.
    const result = filterEpicRows(rows, "tokens");
    expect(result.map((row) => [row.epic.id, row.depth, row.matched])).toEqual([
      ["E1", 0, false],
      ["E2", 1, false],
      ["E3", 2, true],
    ]);
  });

  it("says nothing rather than everything when the query matches no epic", () => {
    expect(shown("zzz")).toEqual([]);
  });
});

/**
 * O4c — the boxes, and the two claims a box makes that could be false.
 *
 * A container says two things at once: "this work is inside this epic" and "this arrow
 * touches this epic". The first is `containerize` and its failure mode is a member drawn
 * in the wrong box (or an epic drawn twice, once as a header and once as a card inside
 * itself). The second is `boundaryEdges`, whose failure mode is the one collapsing exists
 * to prevent — nine arrows drawn on top of each other saying one thing.
 *
 * The fixtures below always go through `collapseGraph` first, because that is the only
 * way `containerize` is ever called and building its input by hand would let these tests
 * agree with an input the view never produces.
 */
describe("containerize", () => {
  /** The canvas as GraphView assembles it: draw, summarize, collapse, then box. */
  const canvas = (
    nodes: readonly GraphNode[],
    edges: readonly GraphEdge[],
    collapsed: readonly string[] = [],
  ) => {
    const epics = summarizeEpics(nodes, nodes);
    const collapse = new Set(collapsed);
    const flat = collapseGraph(nodes, edges, epics, collapse);
    return {
      epics,
      collapse,
      flat,
      containment: containerize(flat.nodes, epics, collapse),
    };
  };

  it("draws an expanded epic as a box with its members inside", () => {
    const { containment } = canvas(
      [task("E"), task("M1", "E"), task("M2", "E")],
      [edge("M1", "M2")],
    );
    const container = containment.nodes.find((node) => node.kind === "container");
    expect(container?.id).toBe(clusterId("E"));
    expect(containment.parentOf.get("M1")).toBe(clusterId("E"));
    expect(containment.parentOf.get("M2")).toBe(clusterId("E"));
  });

  it("turns the epic's own ticket into the header rather than drawing it twice", () => {
    // `summarizeEpics` puts a drawn epic in its own bucket, so without this the canvas
    // would show `E` as the box AND `E` as a card inside itself, wired to the same
    // things. Exactly the duplicate collapsing already refuses to draw.
    const { containment } = canvas([task("E"), task("M1", "E")], [edge("E", "M1")]);
    expect(containment.nodes.some((node) => node.kind === "task" && node.id === "E")).toBe(false);
    expect(containment.headers.get("E")).toBe(clusterId("E"));
  });

  it("gives a container and a cluster the SAME id", () => {
    // This is the acceptance criterion expressed as data: collapsing swaps the box for
    // the ClusterNode "in the same place", and place is what GraphView's positions record
    // is keyed by. Two ids would mean two slots and a jump.
    const nodes = [task("E"), task("M1", "E"), task("M2", "E")];
    const edges = [edge("M1", "M2")];
    const open = canvas(nodes, edges);
    const shut = canvas(nodes, edges, ["E"]);
    const container = open.containment.nodes.find((node) => node.kind === "container");
    const cluster = shut.containment.nodes.find((node) => node.kind === "cluster");
    expect(container!.id).toBe(cluster!.id);
  });

  it("draws no box for a collapsed epic", () => {
    const { containment } = canvas([task("E"), task("M1", "E")], [edge("E", "M1")], ["E"]);
    expect(containment.nodes.some((node) => node.kind === "container")).toBe(false);
    expect(containment.parentOf.size).toBe(0);
  });

  it("draws no box for an epic with nothing but itself on the canvas", () => {
    // A lone epic ticket that happens to block something is a ticket, not a place.
    const { containment } = canvas([task("E"), task("OTHER")], [edge("E", "OTHER")]);
    expect(containment.nodes.some((node) => node.kind === "container")).toBe(false);
  });

  it("nests a box inside its parent's box", () => {
    const { containment } = canvas(
      [task("P"), task("C", "P"), task("M", "C"), task("PM", "P")],
      [edge("M", "PM")],
    );
    expect(containment.parentOf.get(clusterId("C"))).toBe(clusterId("P"));
    expect(containment.parentOf.get("M")).toBe(clusterId("C"));
    expect(containment.parentOf.get("PM")).toBe(clusterId("P"));
  });

  it("puts a collapsed epic INSIDE its expanded parent's box", () => {
    // One level of collapse at a time, which `absorption` already promises: a nested epic
    // stays its own super-node rather than vanishing into its grandparent. The box is
    // where that super-node then has to sit.
    const { containment } = canvas(
      [task("P"), task("C", "P"), task("M", "C"), task("PM", "P")],
      [edge("M", "PM")],
      ["C"],
    );
    expect(containment.parentOf.get(clusterId("C"))).toBe(clusterId("P"));
    expect(containment.nodes.some((node) => node.kind === "cluster" && node.id === clusterId("C"))).toBe(true);
  });

  it("boxes an epic that has no node of its own but does have members", () => {
    // The common case, in fact: the graph draws only tickets that participate in a
    // dependency, and an epic that merely contains work often blocks nothing itself.
    const { containment } = canvas([task("M1", "E"), task("M2", "E")], [edge("M1", "M2")]);
    expect(containment.nodes.some((node) => node.id === clusterId("E"))).toBe(true);
    expect(containment.parentOf.get("M1")).toBe(clusterId("E"));
  });

  it("nests through the epic tree, not through membership", () => {
    // THE CASE THIS FILE EXISTS FOR, found in the browser and not in a fixture. `P` and
    // `C` block nothing, so neither is DRAWN, so neither is in the other's `members` —
    // `summarizeEpics` buckets drawn nodes only. Nesting through membership therefore
    // leaves `C`'s box floating at the top level beside its own parent's. `EpicSummary`
    // carries `parent` (O4b) precisely so the tree survives its epics not being drawn.
    const { containment } = canvas([task("M1", "C"), task("M2", "C")], [edge("M1", "M2")], []);
    // Only C has members, so only C is a box — P is not on this canvas at all.
    expect(containment.parentOf.get(clusterId("C"))).toBeUndefined();

    // Now give P a drawn member of its own: C's box must land INSIDE P's.
    const deeper = canvas(
      [task("P"), task("C", "P"), task("M1", "C"), task("PM", "P")],
      [edge("M1", "PM")],
    );
    expect(deeper.containment.parentOf.get(clusterId("C"))).toBe(clusterId("P"));
  });

  it("boxes a grandparent whose only content is a child's box", () => {
    // `P` holds no ticket directly — everything real is one level further down. It is
    // still a place, and drawing `C`'s box outside it would state that `C` is top-level.
    const { containment } = canvas(
      [task("P"), task("C", "P"), task("M1", "C"), task("M2", "C")],
      [edge("M1", "M2")],
    );
    expect(containment.nodes.some((node) => node.id === clusterId("P"))).toBe(true);
    expect(containment.parentOf.get(clusterId("C"))).toBe(clusterId("P"));
  });

  it("lists every box before anything drawn inside it", () => {
    // React Flow's rule for sub-flows, and it warns and mis-positions rather than
    // failing, which is the kind of bug that ships.
    const { containment } = canvas(
      [task("P"), task("C", "P"), task("M", "C"), task("PM", "P")],
      [edge("M", "PM")],
    );
    const index = new Map(containment.nodes.map((node, i) => [node.id, i]));
    for (const [child, parent] of containment.parentOf) {
      expect(index.get(parent)!, `${parent} must precede ${child}`).toBeLessThan(index.get(child)!);
    }
  });
});

describe("boundaryEdges", () => {
  /** The whole pipeline, returning what GraphView would draw. */
  const arrows = (
    nodes: readonly GraphNode[],
    edges: readonly GraphEdge[],
    collapsed: readonly string[] = [],
  ) => {
    const epics = summarizeEpics(nodes, nodes);
    const collapse = new Set(collapsed);
    const flat = collapseGraph(nodes, edges, epics, collapse);
    const containment = containerize(flat.nodes, epics, collapse);
    return boundaryEdges(flat.edges, containment, collapse).map((arrow) => ({
      from: arrow.from,
      to: arrow.to,
      count: arrow.sources.length,
    }));
  };

  it("bundles a box's members into ONE arrow when the far side is collapsed", () => {
    // The acceptance criterion, and the reason the feature is worth having: three arrows
    // from three cards to one collapsed epic say the same thing three times, and the
    // reader already asked to be told it once by collapsing that epic.
    const drawn = arrows(
      [
        task("A1", "A"),
        task("A2", "A"),
        task("A3", "A"),
        task("B1", "B"),
        task("B2", "B"),
      ],
      [edge("A1", "B1"), edge("A2", "B1"), edge("A3", "B2")],
      ["B"],
    );
    expect(drawn).toEqual([{ from: clusterId("A"), to: clusterId("B"), count: 3 }]);
  });

  it("leaves the arrows member-to-member while both sides are open", () => {
    // Nothing is being simplified for the reader here — they opened both epics, which is
    // the gesture that asks exactly which ticket waits on which.
    const drawn = arrows(
      [task("A1", "A"), task("A2", "A"), task("B1", "B"), task("B2", "B")],
      [edge("A1", "B1"), edge("A2", "B2")],
    );
    expect(drawn).toEqual([
      { from: "A1", to: "B1", count: 1 },
      { from: "A2", to: "B2", count: 1 },
    ]);
  });

  it("moves an epic's own edges onto its box", () => {
    // The epic's node became the header, so an edge naming it has nothing else to land on.
    const drawn = arrows([task("E"), task("M", "E"), task("OUT")], [edge("OUT", "E")]);
    expect(drawn).toEqual([{ from: "OUT", to: clusterId("E"), count: 1 }]);
  });

  it("lifts to the NEAREST box, not the outermost", () => {
    // A member of a box inside a box lifts one level, so the arrow still says which of
    // the nested epics it came from — which is the only reason to have drawn two boxes.
    const drawn = arrows(
      [
        task("P"),
        task("C", "P"),
        task("M", "C"),
        task("X1", "X"),
      ],
      [edge("M", "X1")],
      ["X"],
    );
    expect(drawn).toEqual([{ from: clusterId("C"), to: clusterId("X"), count: 1 }]);
  });

  it("never draws a box pointing at something inside itself", () => {
    // Lifting `M` to its box would produce an arrow from the box to the collapsed epic it
    // contains: a picture of nothing, and one that reads as a rendering fault.
    const drawn = arrows(
      [task("P"), task("M", "P"), task("C", "P"), task("CM", "C")],
      [edge("M", "C")],
      ["C"],
    );
    expect(drawn).toEqual([{ from: "M", to: clusterId("C"), count: 1 }]);
  });

  it("leaves an arrow between two members of the same box alone", () => {
    // It is drawn INSIDE the box, between the two cards it is about. Bundling it to the
    // box would produce a self-loop, and hiding it would throw away the only dependency
    // information an opened epic exists to show.
    const drawn = arrows([task("E"), task("M1", "E"), task("M2", "E")], [edge("M1", "M2")]);
    expect(drawn).toEqual([{ from: "M1", to: "M2", count: 1 }]);
  });

  it("keeps members' arrows to a collapsed epic INSIDE their own box separate", () => {
    // The ancestor guard, from the other side. Neither member may lift, because the box
    // they would lift to is the box the collapsed epic is drawn in — so what is left is
    // two honest arrows drawn inside the box between the things they are about.
    const drawn = arrows(
      [task("E"), task("M1", "E"), task("M2", "E"), task("C", "E"), task("CM", "C")],
      [edge("M1", "CM"), edge("M2", "CM")],
      ["C"],
    );
    expect(drawn).toEqual([
      { from: "M1", to: clusterId("C"), count: 1 },
      { from: "M2", to: clusterId("C"), count: 1 },
    ]);
  });

  it("changes nothing about a graph with no boxes in it", () => {
    const flat = [task("A"), task("B")];
    expect(arrows(flat, [edge("A", "B")])).toEqual([{ from: "A", to: "B", count: 1 }]);
  });
});

describe("dimContainers", () => {
  const nodes: CanvasNode[] = [
    { kind: "container", id: "epic:E", epic: one(summarizeEpics([task("E"), task("M1", "E")], [task("E"), task("M1", "E")])) },
    { kind: "task", id: "M1", task: task("M1", "E") },
    { kind: "task", id: "M2", task: task("M2", "E") },
  ];
  const parentOf = new Map([
    ["M1", "epic:E"],
    ["M2", "epic:E"],
  ]);

  it("does not dim a box while anything inside it is lit", () => {
    // React Flow draws a box's members as SIBLINGS of the box, not inside it, so a dimmed
    // box does not fade its contents — it draws a ghost outline around bright cards, which
    // reads as a rendering fault rather than as "you did not ask about this".
    expect(dimContainers(nodes, parentOf, new Set(["epic:E", "M2"])).has("epic:E")).toBe(false);
  });

  it("dims a box once everything inside it is background", () => {
    expect(dimContainers(nodes, parentOf, new Set(["epic:E", "M1", "M2"])).has("epic:E")).toBe(true);
  });

  it("leaves the leaves exactly as it found them", () => {
    const out = dimContainers(nodes, parentOf, new Set(["M2"]));
    expect(out.has("M2")).toBe(true);
    expect(out.has("M1")).toBe(false);
  });

  it("lets an empty box follow its own emphasis", () => {
    // Nothing inside to protect, so the box answers for itself.
    const empty: CanvasNode[] = [nodes[0]!];
    expect(dimContainers(empty, new Map(), new Set(["epic:E"])).has("epic:E")).toBe(true);
  });
});
