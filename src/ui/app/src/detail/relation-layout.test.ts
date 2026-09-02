/**
 * Placement, asserted rather than screenshotted — O2b (STA-132).
 *
 * The acceptance criteria for this ticket are geometric sentences ("ancestors render
 * above the focus and children below", "predecessors left and successors right"), and a
 * geometric sentence is exactly the kind of thing that is true the day it ships and
 * quietly false three refactors later. That is why the placement is a pure function and
 * why these tests read as inequalities: `y(parent) < y(focus)` is the criterion, written
 * down.
 *
 * IMPORTS ARE RELATIVE. There is a `@` alias in vitest.config.ts now (added by V5), but
 * every module under `lib/` and this one are plain relative-import files, and a test that
 * needed the alias would be a test that could not move.
 *
 * The fixture is built once and driven through `relationContext` rather than being a
 * hand-written `RelationContext` literal: the layout's whole job is to arrange what O2a
 * produces, and a hand-made input would let the two drift apart without a failure.
 */
import { describe, expect, it } from "vitest";
import { relationContext } from "../lib/relation-context";
import type { Graph, GraphNode, IssueStatus } from "../lib/types";
import { NODE_H, NODE_W } from "../views/graph/graph-layout";
import { relationLayout } from "./relation-layout";

function node(
  id: string,
  parent: string | null,
  status: IssueStatus = "todo",
  workspace = "core",
): GraphNode {
  return { id, workspace, title: `${id} title`, status, parent };
}

/**
 * One board with every shape the tab has to draw at once:
 *
 *   PROG  -> EPIC -> FOCUS -> { C1 (done), C2 -> G1 }        the generation spine
 *   B0 -> B1 -> FOCUS,  B2 (done) -> FOCUS                    two ranks upstream
 *   X1 -> FOCUS  (cross-workspace, child of XEPIC)            the extra-hop epic
 *   FOCUS -> D1 -> D2                                         two ranks downstream
 */
function board(): Graph {
  return {
    nodes: [
      node("PROG", null),
      node("EPIC", "PROG"),
      node("FOCUS", "EPIC", "in_progress"),
      node("C1", "FOCUS", "done"),
      node("C2", "FOCUS"),
      node("G1", "C2"),
      node("B0", null),
      node("B1", null),
      node("B2", null, "done"),
      node("D1", null),
      node("D2", null),
      node("XEPIC", null, "todo", "other"),
      node("X1", "XEPIC", "todo", "other"),
    ],
    edges: [
      { from: "B1", to: "FOCUS", cross: false },
      { from: "B2", to: "FOCUS", cross: false },
      { from: "X1", to: "FOCUS", cross: true },
      { from: "B0", to: "B1", cross: false },
      { from: "FOCUS", to: "D1", cross: false },
      { from: "D1", to: "D2", cross: false },
    ],
  };
}

const laidOut = () => relationLayout(relationContext(board(), "FOCUS"));

/** Centre of a box, which is what "above" and "left of" are actually about. */
function centre(layout: ReturnType<typeof relationLayout>, id: string): { x: number; y: number } {
  const position = layout.positions[id];
  if (!position) throw new Error(`${id} was not placed`);
  return { x: position.x + NODE_W / 2, y: position.y + NODE_H / 2 };
}

describe("relationLayout roles", () => {
  it("classifies every drawn node", () => {
    const { roles } = laidOut();
    expect(roles).toEqual({
      FOCUS: "focus",
      PROG: "ancestor",
      EPIC: "ancestor",
      C1: "descendant",
      C2: "descendant",
      G1: "descendant",
      B0: "predecessor",
      B1: "predecessor",
      B2: "predecessor",
      X1: "predecessor",
      D1: "successor",
      D2: "successor",
      // The parent O2a draws so a cross-workspace blocker says which epic it belongs to.
      XEPIC: "context",
    });
  });

  it("gives a node that is both a child and a blocker to the closer relation", () => {
    const graph = board();
    // C2 is already FOCUS's child; now make it block FOCUS as well.
    graph.edges.push({ from: "C2", to: "FOCUS", cross: false });
    const { roles } = relationLayout(relationContext(graph, "FOCUS"));
    expect(roles.C2).toBe("descendant");
  });

  /**
   * The shape `createChild(..., blockParentUntilDone)` produces, which is most epics in
   * this tracker: every direct blocker is also a child. An upstream walk that stopped at
   * the first already-claimed node would end on the first hop and strand the entire pile
   * behind those children — the exact question the tab exists to answer. Found by opening
   * a real epic in the browser, so it is pinned here.
   */
  it("reaches blockers hidden behind a child that blocks its own parent", () => {
    const graph: Graph = {
      nodes: [
        node("EPIC", null),
        node("KID", "EPIC"),
        node("UP1", null),
        node("UP2", null),
      ],
      edges: [
        { from: "KID", to: "EPIC", cross: false },
        { from: "UP1", to: "KID", cross: false },
        { from: "UP2", to: "UP1", cross: false },
      ],
    };
    const layout = relationLayout(relationContext(graph, "EPIC"));
    expect(layout.roles).toMatchObject({ KID: "descendant", UP1: "predecessor", UP2: "predecessor" });
    // And they are drawn in the left wing, not dumped in the fallback row.
    expect(centre(layout, "UP1").x).toBeLessThan(centre(layout, "EPIC").x);
    expect(centre(layout, "UP2").x).toBeLessThan(centre(layout, "UP1").x);
    // The first upstream rank was entirely claimed by the spine, so the wing closes up
    // against it rather than leaving an unexplained empty column. Proved against a
    // control where UP1 blocks the focus directly: same column, same x.
    const control: Graph = {
      nodes: [node("EPIC", null), node("KID", "EPIC"), node("UP1", null), node("UP2", null)],
      edges: [
        { from: "UP1", to: "EPIC", cross: false },
        { from: "UP2", to: "UP1", cross: false },
      ],
    };
    expect(centre(layout, "UP1").x).toBe(
      centre(relationLayout(relationContext(control, "EPIC")), "UP1").x,
    );
  });
});

describe("relationLayout geometry", () => {
  it("puts the focus at the origin", () => {
    expect(centre(laidOut(), "FOCUS")).toEqual({ x: 0, y: 0 });
  });

  it("stacks ancestors above the focus, root highest", () => {
    const layout = laidOut();
    expect(centre(layout, "PROG").y).toBeLessThan(centre(layout, "EPIC").y);
    expect(centre(layout, "EPIC").y).toBeLessThan(centre(layout, "FOCUS").y);
  });

  it("stacks children below the focus, deeper generations further down", () => {
    const layout = laidOut();
    expect(centre(layout, "C1").y).toBeGreaterThan(centre(layout, "FOCUS").y);
    expect(centre(layout, "C2").y).toBe(centre(layout, "C1").y);
    expect(centre(layout, "G1").y).toBeGreaterThan(centre(layout, "C2").y);
  });

  it("keeps the generation spine centred on the focus's column", () => {
    const layout = laidOut();
    for (const id of ["PROG", "EPIC", "G1"]) expect(centre(layout, id).x).toBe(0);
    // Siblings straddle it rather than hanging off one side.
    expect(centre(layout, "C1").x).toBeLessThan(0);
    expect(centre(layout, "C2").x).toBeGreaterThan(0);
  });

  it("puts predecessors to the left, further upstream further out", () => {
    const layout = laidOut();
    expect(centre(layout, "B1").x).toBeLessThan(centre(layout, "FOCUS").x);
    expect(centre(layout, "B2").x).toBe(centre(layout, "B1").x);
    expect(centre(layout, "B0").x).toBeLessThan(centre(layout, "B1").x);
  });

  it("puts successors to the right, further downstream further out", () => {
    const layout = laidOut();
    expect(centre(layout, "D1").x).toBeGreaterThan(centre(layout, "FOCUS").x);
    expect(centre(layout, "D2").x).toBeGreaterThan(centre(layout, "D1").x);
  });

  it("mirrors the two wings about the focus", () => {
    const layout = laidOut();
    expect(centre(layout, "D1").x).toBe(-centre(layout, "B1").x);
    expect(centre(layout, "D2").x).toBe(-centre(layout, "B0").x);
  });

  it("draws a cross-workspace blocker's epic in the same column, directly above it", () => {
    const layout = laidOut();
    const epic = centre(layout, "XEPIC");
    const blocker = centre(layout, "X1");
    expect(epic.x).toBe(blocker.x);
    expect(epic.y).toBeLessThan(blocker.y);
  });

  it("never overlaps two boxes", () => {
    const layout = laidOut();
    const ids = Object.keys(layout.positions);
    for (const a of ids) {
      for (const b of ids) {
        if (a >= b) continue;
        const first = centre(layout, a);
        const second = centre(layout, b);
        const apart =
          Math.abs(first.x - second.x) >= NODE_W || Math.abs(first.y - second.y) >= NODE_H;
        expect(apart, `${a} overlaps ${b}`).toBe(true);
      }
    }
  });

  it("keeps the wings clear of a wide sibling row", () => {
    // The property that makes "never overlaps" true by construction rather than by luck:
    // widening the spine must push the blocker column further out, not let it collide.
    const narrow = laidOut();
    const graph = board();
    for (const extra of ["C3", "C4", "C5", "C6"]) graph.nodes.push(node(extra, "FOCUS"));
    const wide = relationLayout(relationContext(graph, "FOCUS"));
    expect(centre(wide, "B1").x).toBeLessThan(centre(narrow, "B1").x);
    expect(centre(wide, "D1").x).toBeGreaterThan(centre(narrow, "D1").x);
  });
});

describe("relationLayout contract", () => {
  it("is deterministic", () => {
    expect(laidOut()).toEqual(laidOut());
  });

  it("returns React Flow top-left corners, not centres", () => {
    const layout = laidOut();
    expect(layout.positions.FOCUS).toEqual({ x: -NODE_W / 2, y: -NODE_H / 2 });
  });

  it("places every drawn node and invents none", () => {
    const context = relationContext(board(), "FOCUS");
    expect(Object.keys(context.graph.nodes.map((n) => n.id)).length).toBeGreaterThan(0);
    expect(Object.keys(relationLayout(context).positions).sort()).toEqual(
      context.graph.nodes.map((n) => n.id).sort(),
    );
  });

  it("signature tracks the focus and the drawn set, so the canvas re-fits", () => {
    const graph = board();
    const focus = relationLayout(relationContext(graph, "FOCUS")).signature;
    const other = relationLayout(relationContext(graph, "D1")).signature;
    expect(focus).not.toBe(other);
    expect(relationLayout(relationContext(board(), "FOCUS")).signature).toBe(focus);
  });

  it("returns an empty layout for a focus the payload does not carry", () => {
    expect(relationLayout(relationContext(board(), "NOPE"))).toEqual({
      positions: {},
      roles: {},
      signature: "",
    });
  });

  it("draws a lone ticket as nothing but itself", () => {
    const graph: Graph = { nodes: [node("ALONE", null)], edges: [] };
    const layout = relationLayout(relationContext(graph, "ALONE"));
    expect(layout.roles).toEqual({ ALONE: "focus" });
    expect(layout.positions.ALONE).toEqual({ x: -NODE_W / 2, y: -NODE_H / 2 });
  });

  it("survives a parent cycle without hanging", () => {
    const graph: Graph = {
      nodes: [node("A", "B"), node("B", "A")],
      edges: [],
    };
    expect(Object.keys(relationLayout(relationContext(graph, "A")).positions)).toContain("A");
  });
});
