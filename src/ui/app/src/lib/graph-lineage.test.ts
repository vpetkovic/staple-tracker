/**
 * G1 — the judgement the chain highlight is made of.
 *
 * What is worth pinning here is not "BFS visits nodes". It is the four ways this feature
 * could quietly stop being useful while still appearing to work:
 *
 *   1. Highlighting only one direction. A ticket's lineage is blockers AND dependents;
 *      a version that lit only what a ticket waits on would look correct on every chain
 *      and would silently answer half the question a planner is asking.
 *   2. Bleeding into siblings. "Either end is lit" is the obvious edge rule and it is
 *      wrong — on a real board it walks outward until most of the graph is lit, at which
 *      point dimming has stopped meaning anything and nobody can say when it broke.
 *   3. Dropping cross-workspace edges. They are the dependencies a hub view exists for,
 *      and an implementation that special-cased them would fail here and nowhere else.
 *   4. Hanging on a cycle. The store rejects cycles, so nothing in normal use proves the
 *      guard is still there — only a test that feeds one in does.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time. graph-lineage
 * itself imports nothing at all, which is what makes that painless.
 */
import { describe, expect, it } from "vitest";
import { buildLineageIndex, edgeKey, lineageFrom, lineageOf, type LineageEdge } from "./graph-lineage";

/** Sorted array, so a failure prints a readable diff instead of "Set(3)". */
const ids = (set: Set<string>): string[] => [...set].sort();

/** `A->B` pairs, sorted, for asserting on the lit edge set. */
const pairs = (set: Set<string>): string[] => [...set].map((k) => k.split("\u0000").join("->")).sort();

describe("lineage of a straight chain", () => {
  // A blocks B blocks C blocks D
  const chain: LineageEdge[] = [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
    { from: "C", to: "D" },
  ];

  it("reaches every transitive blocker, not just the immediate one", () => {
    const lineage = lineageOf(chain, "D");
    expect(ids(lineage.ancestors)).toEqual(["A", "B", "C"]);
  });

  it("reaches every transitive dependent, not just the immediate one", () => {
    const lineage = lineageOf(chain, "A");
    expect(ids(lineage.descendants)).toEqual(["B", "C", "D"]);
  });

  it("lights both directions at once from the middle of a chain", () => {
    const lineage = lineageOf(chain, "C");
    expect(ids(lineage.ancestors)).toEqual(["A", "B"]);
    expect(ids(lineage.descendants)).toEqual(["D"]);
    // The whole chain stays lit — this is the sentence the feature exists to say.
    expect(ids(lineage.nodes)).toEqual(["A", "B", "C", "D"]);
    expect(pairs(lineage.edges)).toEqual(["A->B", "B->C", "C->D"]);
  });

  it("puts the focus in nodes but not in ancestors or descendants", () => {
    const lineage = lineageOf(chain, "B");
    expect(lineage.focus).toBe("B");
    expect(lineage.nodes.has("B")).toBe(true);
    expect(lineage.ancestors.has("B")).toBe(false);
    expect(lineage.descendants.has("B")).toBe(false);
  });
});

describe("lineage of a diamond", () => {
  // A splits into B and C, which both re-converge on D.
  const diamond: LineageEdge[] = [
    { from: "A", to: "B" },
    { from: "A", to: "C" },
    { from: "B", to: "D" },
    { from: "C", to: "D" },
  ];

  it("keeps both arms of the diamond when the convergence point is focused", () => {
    const lineage = lineageOf(diamond, "D");
    expect(ids(lineage.ancestors)).toEqual(["A", "B", "C"]);
    expect(pairs(lineage.edges)).toEqual(["A->B", "A->C", "B->D", "C->D"]);
  });

  it("keeps both arms when the fork point is focused", () => {
    const lineage = lineageOf(diamond, "A");
    expect(ids(lineage.descendants)).toEqual(["B", "C", "D"]);
    expect(pairs(lineage.edges)).toEqual(["A->B", "A->C", "B->D", "C->D"]);
  });

  it("does not light the sibling arm when one arm is focused", () => {
    // Focused on B: A is a blocker, D is a dependent, C is a COUSIN. C is on a path
    // through A and through D, but not through B — so it dims. This is the assertion
    // that separates a lineage highlight from a connected-component highlight.
    const lineage = lineageOf(diamond, "B");
    expect(ids(lineage.nodes)).toEqual(["A", "B", "D"]);
    expect(lineage.nodes.has("C")).toBe(false);
    expect(pairs(lineage.edges)).toEqual(["A->B", "B->D"]);
    // Specifically: neither edge that touches C survives, even though both of C's
    // neighbours (A and D) are lit.
    expect(lineage.edges.has(edgeKey("A", "C"))).toBe(false);
    expect(lineage.edges.has(edgeKey("C", "D"))).toBe(false);
  });
});

describe("unrelated work dims", () => {
  it("leaves a disjoint component entirely out of the lineage", () => {
    const lineage = lineageOf(
      [
        { from: "A", to: "B" },
        { from: "X", to: "Y" },
      ],
      "A",
    );
    expect(ids(lineage.nodes)).toEqual(["A", "B"]);
    expect(pairs(lineage.edges)).toEqual(["A->B"]);
  });

  it("treats a ticket with no edges as its own lineage rather than an error", () => {
    // Everything else on the board dims, which is the true answer: this ticket is
    // connected to nothing. An empty/throwing result would make the view special-case it.
    const lineage = lineageOf([{ from: "A", to: "B" }], "LONELY");
    expect(ids(lineage.nodes)).toEqual(["LONELY"]);
    expect(lineage.edges.size).toBe(0);
  });
});

describe("cross-workspace edges are ordinary edges", () => {
  it("walks through a cross-workspace hop without a special case", () => {
    // The hub flattens workspaces into one id space, so a cross edge differs only in
    // how it is DRAWN. A traversal that filtered on `cross` would cut the chain here.
    const edges = [
      { from: "STA-1", to: "OTH-9", cross: true },
      { from: "OTH-9", to: "STA-4", cross: true },
      { from: "STA-4", to: "STA-7", cross: false },
    ];
    const lineage = lineageOf(edges, "STA-7");
    expect(ids(lineage.ancestors)).toEqual(["OTH-9", "STA-1", "STA-4"]);
    expect(pairs(lineage.edges)).toEqual(["OTH-9->STA-4", "STA-1->OTH-9", "STA-4->STA-7"]);
  });
});

describe("a corrupt graph cannot hang the page", () => {
  it("terminates on a cycle and reports the focus as its own ancestor", () => {
    // The store rejects cycles at write time, so this can only arrive from a corrupt or
    // hand-edited DB. Terminating is the requirement; the sets below are what honest
    // termination looks like — on a cycle, a node really is upstream of itself.
    const lineage = lineageOf(
      [
        { from: "A", to: "B" },
        { from: "B", to: "C" },
        { from: "C", to: "A" },
      ],
      "A",
    );
    expect(ids(lineage.ancestors)).toEqual(["A", "B", "C"]);
    expect(ids(lineage.descendants)).toEqual(["A", "B", "C"]);
    expect(pairs(lineage.edges)).toEqual(["A->B", "B->C", "C->A"]);
  });

  it("terminates on a self-loop", () => {
    const lineage = lineageOf([{ from: "A", to: "A" }], "A");
    expect(ids(lineage.nodes)).toEqual(["A"]);
    expect(pairs(lineage.edges)).toEqual(["A->A"]);
  });
});

describe("duplicate edges", () => {
  it("keys on the pair, so a repeated dependency lights and dims as one", () => {
    const lineage = lineageOf(
      [
        { from: "A", to: "B" },
        { from: "A", to: "B" },
      ],
      "B",
    );
    expect(lineage.edges.size).toBe(1);
    expect(lineage.edges.has(edgeKey("A", "B"))).toBe(true);
  });

  it("cannot collide two different pairs into one key", () => {
    // `${from}->${to}` string concatenation would let ("A->B","C") and ("A","B->C")
    // share a key. Identifiers are configurable text, so this is cheap insurance.
    expect(edgeKey("A->B", "C")).not.toBe(edgeKey("A", "B->C"));
  });
});

describe("the index is the hover seam", () => {
  it("gives the same answer as the one-shot helper", () => {
    // G2 builds the index once per graph payload and walks it on every pointer move.
    // If these two ever disagree, hovering and clicking would highlight different things.
    const edges: LineageEdge[] = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
      { from: "X", to: "C" },
    ];
    const index = buildLineageIndex(edges);
    for (const focus of ["A", "B", "C", "X"]) {
      const viaIndex = lineageFrom(index, focus);
      const viaOneShot = lineageOf(edges, focus);
      expect(ids(viaIndex.nodes)).toEqual(ids(viaOneShot.nodes));
      expect(pairs(viaIndex.edges)).toEqual(pairs(viaOneShot.edges));
    }
  });

  it("is not mutated by walking it", () => {
    // The index is memoized across every hover in G2; a walk that wrote into it would
    // make the second hover disagree with the first in a way nothing else would catch.
    const index = buildLineageIndex([
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ]);
    const before = JSON.stringify([...index.blockers], null, 0) + JSON.stringify([...index.dependents], null, 0);
    lineageFrom(index, "B");
    lineageFrom(index, "C");
    const after = JSON.stringify([...index.blockers], null, 0) + JSON.stringify([...index.dependents], null, 0);
    expect(after).toBe(before);
  });
});
