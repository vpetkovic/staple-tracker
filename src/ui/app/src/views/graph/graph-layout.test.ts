/**
 * G2 — the arrangement, and the one thing that keeps it still.
 *
 * Two very different risks live in this file.
 *
 * The layout half is easy to eyeball and easy to get subtly wrong: what must hold is
 * that a blocker sits LEFT of what it blocks, because the entire view — legend, card,
 * everyone's reading habit — assumes arrows run forward. A `rankdir` typo would still
 * produce a pretty graph that answers the question backwards.
 *
 * The signature half is not eyeballable at all, and it is the one that would actually
 * ship broken. `useResource` refetches on a 1.5s fingerprint poll, so `graph` is a new
 * object several times a minute. If the signature picked up title or status, dagre would
 * re-run on a timer and every node the user had dragged would snap back mid-look — a bug
 * that only appears on a workspace where something else is happening, i.e. never on a
 * fixture and always in front of the person you are demoing to.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import {
  NODE_H,
  NODE_W,
  connectedNodes,
  dagreLayout,
  graphSignature,
  mergePositions,
  type XY,
} from "./graph-layout";

const node = (id: string) => ({ id });

describe("connectedNodes", () => {
  it("drops tickets that block nothing and are blocked by nothing", () => {
    // The view is the dependency graph, not the backlog. Forty unconnected boxes would
    // bury the four arrows that matter.
    const kept = connectedNodes([node("A"), node("B"), node("LONE")], [{ from: "A", to: "B" }]);
    expect(kept.map((n) => n.id)).toEqual(["A", "B"]);
  });

  it("returns nothing when there are no edges at all, which is the empty state", () => {
    expect(connectedNodes([node("A"), node("B")], [])).toEqual([]);
  });
});

describe("graphSignature", () => {
  it("ignores row order on both nodes and edges", () => {
    const a = graphSignature([node("A"), node("B")], [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ]);
    const b = graphSignature([node("B"), node("A")], [
      { from: "B", to: "C" },
      { from: "A", to: "B" },
    ]);
    expect(a).toBe(b);
  });

  it("does NOT change when a ticket's status or title changes", () => {
    // The load-bearing assertion of this file. An agent claiming a ticket must re-tint
    // the card without relocating it — and on this project that happens constantly.
    // Declared as consts rather than inline so TypeScript's excess-property check does
    // not object to the very fields this test exists to prove are ignored.
    const early = [
      { id: "A", status: "todo", title: "old" },
      { id: "B", status: "todo", title: "b" },
    ];
    const later = [
      { id: "A", status: "in_progress", title: "renamed" },
      { id: "B", status: "done", title: "b" },
    ];
    const edges = [{ from: "A", to: "B" }];
    expect(graphSignature(later, edges)).toBe(graphSignature(early, edges));
  });

  it("changes when a ticket appears", () => {
    const before = graphSignature([node("A"), node("B")], [{ from: "A", to: "B" }]);
    const after = graphSignature([node("A"), node("B"), node("C")], [{ from: "A", to: "B" }]);
    expect(after).not.toBe(before);
  });

  it("changes when a dependency appears", () => {
    const before = graphSignature([node("A"), node("B")], [{ from: "A", to: "B" }]);
    const after = graphSignature([node("A"), node("B")], [
      { from: "A", to: "B" },
      { from: "B", to: "A" },
    ]);
    expect(after).not.toBe(before);
  });

  it("changes when a dependency reverses direction", () => {
    // `A>B` vs `B>A`. A signature built from an unordered pair set would call these
    // equal and leave the arrows pointing the wrong way until a reload.
    const before = graphSignature([node("A"), node("B")], [{ from: "A", to: "B" }]);
    const after = graphSignature([node("A"), node("B")], [{ from: "B", to: "A" }]);
    expect(after).not.toBe(before);
  });
});

describe("dagreLayout", () => {
  const chain = [
    { from: "A", to: "B" },
    { from: "B", to: "C" },
  ];

  it("puts a blocker to the left of what it blocks", () => {
    const pos = dagreLayout([node("A"), node("B"), node("C")], chain);
    expect(pos["A"]!.x).toBeLessThan(pos["B"]!.x);
    expect(pos["B"]!.x).toBeLessThan(pos["C"]!.x);
  });

  it("separates ranks by more than a node width, so cards cannot overlap", () => {
    const pos = dagreLayout([node("A"), node("B"), node("C")], chain);
    expect(pos["B"]!.x - pos["A"]!.x).toBeGreaterThanOrEqual(NODE_W);
  });

  it("places siblings in the same rank at the same x and different y", () => {
    const pos = dagreLayout([node("A"), node("B"), node("C")], [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
    ]);
    expect(pos["B"]!.x).toBe(pos["C"]!.x);
    expect(Math.abs(pos["B"]!.y - pos["C"]!.y)).toBeGreaterThanOrEqual(NODE_H);
  });

  it("returns top-left corners, not centres", () => {
    // dagre reports centres and React Flow positions by corner. Getting this wrong is
    // half a card of drift on every node — visible, but easy to talk yourself out of.
    const pos = dagreLayout([node("SOLO")], []);
    // marginx/marginy are 24, so the centre of the only node is (24 + w/2, 24 + h/2)
    // and the corner this must return is (24, 24).
    expect(pos["SOLO"]).toEqual({ x: 24, y: 24 });
  });

  it("gives every node a finite position", () => {
    const pos = dagreLayout([node("A"), node("B"), node("C")], chain);
    for (const id of ["A", "B", "C"]) {
      expect(Number.isFinite(pos[id]!.x)).toBe(true);
      expect(Number.isFinite(pos[id]!.y)).toBe(true);
    }
  });

  it("ignores an edge naming a node that is not being drawn", () => {
    // A cross-workspace blocker whose workspace file is not on this machine. dagre would
    // otherwise invent a zero-size node for it and open a hole in the arrangement.
    const pos = dagreLayout([node("A"), node("B")], [
      { from: "A", to: "B" },
      { from: "GHOST", to: "B" },
    ]);
    expect(Object.keys(pos).sort()).toEqual(["A", "B"]);
  });

  it("survives a duplicated dependency row", () => {
    const pos = dagreLayout([node("A"), node("B")], [
      { from: "A", to: "B" },
      { from: "A", to: "B" },
    ]);
    expect(pos["A"]!.x).toBeLessThan(pos["B"]!.x);
  });

  it("returns an empty arrangement for an empty graph rather than throwing", () => {
    expect(dagreLayout([], [])).toEqual({});
  });

  it("is deterministic — the same graph arranges identically twice", () => {
    // Auto-arrange promises to put you back where you started. If dagre were seeded by
    // insertion order or anything else non-deterministic, "restore" would drift.
    const nodes = [node("A"), node("B"), node("C"), node("D")];
    const edges = [
      { from: "A", to: "B" },
      { from: "A", to: "C" },
      { from: "B", to: "D" },
      { from: "C", to: "D" },
    ];
    expect(dagreLayout(nodes, edges)).toEqual(dagreLayout(nodes, edges));
  });
});

describe("mergePositions", () => {
  const canonical: Record<string, XY> = {
    A: { x: 0, y: 0 },
    B: { x: 100, y: 0 },
  };

  it("lets a stored position win over canonical", () => {
    expect(mergePositions(canonical, { A: { x: 500, y: 500 } })).toEqual({
      A: { x: 500, y: 500 },
      B: { x: 100, y: 0 },
    });
  });

  it("drops a stored position for a ticket that no longer exists", () => {
    // Otherwise a deleted ticket keeps a slot in storage forever and, worse, a recycled
    // identifier inherits somebody else's corner of the canvas.
    expect(mergePositions(canonical, { GONE: { x: 9, y: 9 } })).toEqual(canonical);
  });

  it("gives a brand new ticket its canonical spot, not the origin", () => {
    // The failure this prevents: add one dependency, and the new node appears stacked at
    // 0,0 in the corner instead of in its rank.
    const withNew = { ...canonical, C: { x: 200, y: 0 } };
    expect(mergePositions(withNew, { A: { x: 5, y: 5 } })["C"]).toEqual({ x: 200, y: 0 });
  });

  it("returns canonical untouched when nothing is stored", () => {
    expect(mergePositions(canonical, null)).toEqual(canonical);
    expect(mergePositions(canonical, undefined)).toEqual(canonical);
  });

  it("does not mutate its inputs", () => {
    const stored = { A: { x: 5, y: 5 } };
    const snapshot = JSON.stringify(canonical);
    mergePositions(canonical, stored);
    expect(JSON.stringify(canonical)).toBe(snapshot);
  });
});
