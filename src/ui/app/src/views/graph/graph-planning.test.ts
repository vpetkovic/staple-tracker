/**
 * G4 — the three planning answers, and the two that are easy to get plausibly wrong.
 *
 * "Plausibly wrong" is the operative phrase. All three modes produce a picture that looks
 * reasonable whichever way you implement them; the failures are semantic, not visual, and
 * they mislead a planning meeting rather than crashing a page.
 *
 * The two pinned hardest:
 *
 *   1. `unfinishedChain` must STOP at finished work rather than filter it out. The
 *      `X → A(done) → TARGET` fixture is the whole reason the function is a walk and not
 *      a one-line filter over `lineage.ancestors`.
 *   2. `bridgeResolved` must re-wire across what it hides. Hiding done work and leaving
 *      the graph in disconnected islands would assert that A and C are unrelated, which
 *      is false, and nothing about the resulting picture looks broken.
 *
 * Relative import; graph-planning.ts only `import type`s from "@/lib/types".
 */
import { describe, expect, it } from "vitest";
import type { IssueStatus } from "@/lib/types";
import {
  bridgeResolved,
  emphasisFor,
  frontier,
  planKey,
  unfinishedChain,
  type Emphasis,
} from "./graph-planning";

const n = (id: string, status: IssueStatus) => ({ id, status });
const e = (from: string, to: string) => ({ from, to });

describe("frontier", () => {
  it("lights work whose blockers are all finished", () => {
    const nodes = [n("A", "done"), n("B", "todo"), n("C", "todo")];
    const edges = [e("A", "B"), e("B", "C")];
    // B's only blocker is done, so B is pickable. C still waits on B.
    expect([...frontier(nodes, edges)]).toEqual(["B"]);
  });

  it("lights a node with no blockers at all", () => {
    expect([...frontier([n("A", "todo")], [])]).toEqual(["A"]);
  });

  it("excludes finished work — the frontier is what is LEFT", () => {
    expect([...frontier([n("A", "done"), n("B", "cancelled")], [])]).toEqual([]);
  });

  it("excludes an explicitly blocked ticket even with no blocker edges", () => {
    // This is the store's rule: `status === "blocked"` is blocked regardless of edges.
    // The graph must not call something ready that `staple inbox` calls blocked.
    expect([...frontier([n("A", "blocked")], [])]).toEqual([]);
  });

  it("counts in_progress work as on the frontier", () => {
    // Same as the store's inbox: ready is "not blocked", not "not started".
    expect([...frontier([n("A", "in_progress")], [])]).toEqual(["A"]);
  });

  it("is not held back by a blocker that is not on the canvas", () => {
    // A cross-workspace blocker in a workspace this page cannot see would otherwise
    // empty the frontier permanently.
    expect([...frontier([n("B", "todo")], [e("GHOST", "B")])]).toEqual(["B"]);
  });
});

describe("unfinishedChain", () => {
  it("does not light work made irrelevant by a finished blocker", () => {
    // THE fixture. X is upstream of TARGET, but only through A, which is done — so
    // nothing stands between today and TARGET except TARGET itself.
    const nodes = [n("X", "todo"), n("A", "done"), n("TARGET", "todo")];
    const edges = [e("X", "A"), e("A", "TARGET")];
    const chain = unfinishedChain(nodes, edges, "TARGET");
    expect([...chain.nodes]).toEqual(["TARGET"]);
    expect(chain.nodes.has("X")).toBe(false);
  });

  it("walks the whole unfinished chain", () => {
    const nodes = [n("A", "todo"), n("B", "todo"), n("TARGET", "todo")];
    const edges = [e("A", "B"), e("B", "TARGET")];
    const chain = unfinishedChain(nodes, edges, "TARGET");
    expect([...chain.nodes].sort()).toEqual(["A", "B", "TARGET"]);
    expect(chain.edges.has(planKey("A", "B"))).toBe(true);
    expect(chain.edges.has(planKey("B", "TARGET"))).toBe(true);
  });

  it("lights nothing for a target that is already finished", () => {
    const nodes = [n("A", "todo"), n("TARGET", "done")];
    const chain = unfinishedChain(nodes, [e("A", "TARGET")], "TARGET");
    expect(chain.nodes.size).toBe(0);
  });

  it("ignores what the target blocks — this is upstream only", () => {
    const nodes = [n("TARGET", "todo"), n("DOWNSTREAM", "todo")];
    const chain = unfinishedChain(nodes, [e("TARGET", "DOWNSTREAM")], "TARGET");
    expect([...chain.nodes]).toEqual(["TARGET"]);
  });

  it("terminates on a cycle", () => {
    const nodes = [n("A", "todo"), n("B", "todo")];
    const chain = unfinishedChain(nodes, [e("A", "B"), e("B", "A")], "A");
    expect([...chain.nodes].sort()).toEqual(["A", "B"]);
  });
});

describe("bridgeResolved", () => {
  it("re-wires a path that ran through hidden work", () => {
    // A -> D(hidden) -> C must not become two islands.
    const edges = [e("A", "D"), e("D", "C")];
    const out = bridgeResolved(edges, new Set(["D"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: "A", to: "C", derived: true });
  });

  it("bridges a run of several hidden nodes", () => {
    const edges = [e("A", "D1"), e("D1", "D2"), e("D2", "C")];
    const out = bridgeResolved(edges, new Set(["D1", "D2"]));
    expect(out.map((b) => `${b.from}->${b.to}`)).toEqual(["A->C"]);
  });

  it("leaves an untouched graph untouched", () => {
    const edges = [e("A", "B"), e("B", "C")];
    const out = bridgeResolved(edges, new Set());
    expect(out.every((b) => !b.derived)).toBe(true);
    expect(out.map((b) => `${b.from}->${b.to}`)).toEqual(["A->B", "B->C"]);
  });

  it("prefers a real dependency over a bridged one between the same pair", () => {
    // A blocks C outright AND via hidden D. The recorded edge is the true statement.
    const edges = [e("A", "C"), e("A", "D"), e("D", "C")];
    const out = bridgeResolved(edges, new Set(["D"]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ from: "A", to: "C", derived: false });
  });

  it("drops an edge into hidden work that leads nowhere visible", () => {
    // A -> D(hidden), and D blocks nothing further. There is no path to redraw.
    expect(bridgeResolved([e("A", "D")], new Set(["D"]))).toEqual([]);
  });

  it("terminates on a cycle among hidden nodes", () => {
    const edges = [e("A", "D1"), e("D1", "D2"), e("D2", "D1"), e("D2", "C")];
    const out = bridgeResolved(edges, new Set(["D1", "D2"]));
    expect(out.map((b) => `${b.from}->${b.to}`)).toEqual(["A->C"]);
  });
});

describe("emphasisFor", () => {
  const lit = (...ids: string[]): Emphasis => ({ nodes: new Set(ids), edges: new Set() });

  it("lets hover beat an active mode", () => {
    // The pointer is the most recent question. A mode that refused to yield would look
    // like the canvas had stopped responding.
    const result = emphasisFor({
      hoverLineage: lit("HOVER"),
      mode: "frontier",
      frontierSet: new Set(["READY"]),
      pathChain: null,
      selectionLineage: lit("SELECTED"),
    });
    expect([...result!.nodes]).toEqual(["HOVER"]);
  });

  it("falls back to the mode when the pointer leaves", () => {
    const result = emphasisFor({
      hoverLineage: null,
      mode: "frontier",
      frontierSet: new Set(["READY"]),
      pathChain: null,
      selectionLineage: lit("SELECTED"),
    });
    expect([...result!.nodes]).toEqual(["READY"]);
  });

  it("lights no EDGES in frontier mode", () => {
    // Two tickets being ready at the same time is not a relationship between them.
    const result = emphasisFor({
      hoverLineage: null,
      mode: "frontier",
      frontierSet: new Set(["A", "B"]),
      pathChain: null,
      selectionLineage: null,
    });
    expect(result!.edges.size).toBe(0);
  });

  it("falls back to selection when no mode is on", () => {
    const result = emphasisFor({
      hoverLineage: null,
      mode: "off",
      frontierSet: null,
      pathChain: null,
      selectionLineage: lit("SELECTED"),
    });
    expect([...result!.nodes]).toEqual(["SELECTED"]);
  });

  it("dims nothing when nothing is asked", () => {
    // `null` must stay `null` all the way to the view — this is G1's contract.
    expect(
      emphasisFor({
        hoverLineage: null,
        mode: "off",
        frontierSet: null,
        pathChain: null,
        selectionLineage: null,
      }),
    ).toBeNull();
  });
});
