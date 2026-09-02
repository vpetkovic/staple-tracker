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
  clusterId,
  collapseGraph,
  epicOfClusterId,
  isClusterId,
  restrictToEpic,
  shouldDefaultCollapse,
  summarizeEpics,
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
