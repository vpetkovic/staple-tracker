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
  CONTAINER_HEADER_H,
  CONTAINER_PAD,
  MIN_CONTAINER_H,
  MIN_CONTAINER_W,
  NODE_H,
  NODE_W,
  absolutePositions,
  clampInside,
  compoundLayout,
  connectedNodes,
  dagreLayout,
  fitContainers,
  graphSignature,
  mergePositions,
  type CompoundLayout,
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

/**
 * O4c — the compound arrangement, and the ways a box can lie about what is in it.
 *
 * The layout half of this ticket has one job that nothing downstream can recover from: a
 * member drawn OUTSIDE the box it is a member of. Every assertion below is that job from
 * a different angle — the child's coordinate frame, the box's size, the box's size after
 * a human dragged something, and the flattening the export has to do to get back to one
 * coordinate space.
 *
 * The other risk is silent: the flat graph going through a new code path and coming out
 * subtly different. `dagreLayout` is now a wrapper over `compoundLayout`, so every
 * assertion in the `dagreLayout` block above is also an assertion about this one — plus
 * the equivalence that opens this block.
 */
const leaf = (id: string, parent: string | null = null) => ({ id, parent, container: false });
const box = (id: string, parent: string | null = null) => ({ id, parent, container: true });

/** The top-left of `id` relative to whatever it is drawn inside. */
const at = (layout: CompoundLayout, id: string): XY => {
  const position = layout.positions[id];
  expect(position, `no position for ${id}`).toBeDefined();
  return position!;
};

describe("compoundLayout, flat", () => {
  it("is exactly dagreLayout when nothing is a container", () => {
    // dagreLayout IS this function with no boxes. The equivalence is not an aspiration —
    // it is the reason a feature about epics could not move an ordinary graph's nodes.
    const nodes = [leaf("A"), leaf("B"), leaf("C")];
    const edges = [
      { from: "A", to: "B" },
      { from: "B", to: "C" },
    ];
    expect(compoundLayout(nodes, edges).positions).toEqual(dagreLayout(nodes, edges));
  });

  it("reports no sizes when there are no containers", () => {
    expect(compoundLayout([leaf("A"), leaf("B")], [{ from: "A", to: "B" }]).sizes).toEqual({});
  });

  it("has nothing to say about an empty canvas", () => {
    expect(compoundLayout([], [])).toEqual({ positions: {}, sizes: {} });
  });
});

describe("compoundLayout, one box", () => {
  const nodes = [box("epic:E"), leaf("A", "epic:E"), leaf("B", "epic:E")];
  const edges = [{ from: "A", to: "B" }];

  it("positions members RELATIVE to their box, under the header", () => {
    // The load-bearing assertion of the block. React Flow reads a sub-flow child's
    // position as an offset from its parent, so a member holding an absolute coordinate
    // here is drawn at box.position PLUS that coordinate — off in the distance.
    const layout = compoundLayout(nodes, edges);
    expect(at(layout, "A").x).toBe(CONTAINER_PAD);
    expect(at(layout, "A").y).toBe(CONTAINER_HEADER_H);
    // And the header is genuinely clear: nothing is allowed above it.
    expect(at(layout, "B").y).toBeGreaterThanOrEqual(CONTAINER_HEADER_H);
  });

  it("still puts a blocker left of what it blocks, inside the box", () => {
    // The rule the whole view is read by does not stop applying at a box's border.
    const layout = compoundLayout(nodes, edges);
    expect(at(layout, "A").x).toBeLessThan(at(layout, "B").x);
  });

  it("measures a box that holds everything inside it", () => {
    const layout = compoundLayout(nodes, edges);
    const size = layout.sizes["epic:E"]!;
    for (const id of ["A", "B"]) {
      expect(at(layout, id).x + NODE_W).toBeLessThanOrEqual(size.width);
      expect(at(layout, id).y + NODE_H).toBeLessThanOrEqual(size.height);
    }
  });

  it("keeps an empty box big enough to read as a box", () => {
    const layout = compoundLayout([box("epic:E")], []);
    expect(layout.sizes["epic:E"]).toEqual({ width: MIN_CONTAINER_W, height: MIN_CONTAINER_H });
  });

  it("places the box itself in the outer graph, framed like any other node", () => {
    expect(at(compoundLayout(nodes, edges), "epic:E")).toEqual({ x: 24, y: 24 });
  });
});

describe("compoundLayout, nesting", () => {
  const nodes = [
    box("epic:OUTER"),
    box("epic:INNER", "epic:OUTER"),
    leaf("A", "epic:INNER"),
    leaf("B", "epic:OUTER"),
  ];

  it("draws a box inside a box, big enough to hold it", () => {
    const layout = compoundLayout(nodes, []);
    const inner = layout.sizes["epic:INNER"]!;
    const outer = layout.sizes["epic:OUTER"]!;
    const nested = at(layout, "epic:INNER");
    expect(nested.y).toBeGreaterThanOrEqual(CONTAINER_HEADER_H);
    expect(nested.x + inner.width).toBeLessThanOrEqual(outer.width);
    expect(nested.y + inner.height).toBeLessThanOrEqual(outer.height);
  });

  it("measures the inner box before the outer one needs it", () => {
    // Deepest-first is not a preference. An outer box packed before its inner box was
    // measured packs a zero-size hole and then draws a box on top of its neighbours.
    const layout = compoundLayout(nodes, []);
    expect(layout.sizes["epic:OUTER"]!.width).toBeGreaterThan(layout.sizes["epic:INNER"]!.width);
  });

  it("keeps the grandchild's coordinate relative to its OWN box", () => {
    const layout = compoundLayout(nodes, []);
    expect(at(layout, "A")).toEqual({ x: CONTAINER_PAD, y: CONTAINER_HEADER_H });
  });
});

describe("compoundLayout, edges across boxes", () => {
  it("ranks two boxes by an edge drawn between their members", () => {
    // The two-pass trade, asserted. The arrow is drawn member-to-member, but the OUTER
    // pass sees it lifted to the boxes — which is what puts box A left of box B instead
    // of leaving the two in arbitrary order.
    const nodes = [box("epic:A"), leaf("A1", "epic:A"), box("epic:B"), leaf("B1", "epic:B")];
    const layout = compoundLayout(nodes, [{ from: "A1", to: "B1" }]);
    expect(at(layout, "epic:A").x).toBeLessThan(at(layout, "epic:B").x);
  });

  it("does not let an edge inside a box rank anything outside it", () => {
    // Lifted to the outer level both ends are the same box, which says nothing there.
    // Dropping it is what stops dagre being handed a self-loop on the container.
    const nodes = [box("epic:A"), leaf("A1", "epic:A"), leaf("A2", "epic:A"), leaf("LOOSE")];
    const layout = compoundLayout(nodes, [{ from: "A1", to: "A2" }]);
    // Same rank, so the same centre — compared on centres rather than left edges because
    // the box and the card are different widths and dagre ranks by centre.
    const boxCentre = at(layout, "epic:A").x + layout.sizes["epic:A"]!.width / 2;
    expect(boxCentre).toBe(at(layout, "LOOSE").x + NODE_W / 2);
  });

  it("ignores an edge naming something it is not drawing", () => {
    // Cross-workspace blockers in a file this page never loaded do exactly this, and
    // dagre would otherwise invent a zero-size node and open a hole in the layout.
    const nodes = [box("epic:A"), leaf("A1", "epic:A")];
    const edges = [{ from: "A1", to: "ELSEWHERE" }];
    expect(() => compoundLayout(nodes, edges)).not.toThrow();
    expect(compoundLayout(nodes, edges).positions["ELSEWHERE"]).toBeUndefined();
  });
});

describe("fitContainers", () => {
  const nodes = [box("epic:E"), leaf("A", "epic:E")];

  it("grows a box that a stored position would otherwise hang out of", () => {
    // The reload case, exactly: yesterday's arrangement had this member further right
    // than today's membership measures for. Without this it is drawn outside its epic.
    const stored = { "epic:E": { x: 0, y: 0 }, A: { x: 600, y: 400 } };
    const grown = fitContainers(nodes, stored, { "epic:E": { width: 240, height: 120 } });
    expect(grown["epic:E"]!.width).toBeGreaterThanOrEqual(600 + NODE_W);
    expect(grown["epic:E"]!.height).toBeGreaterThanOrEqual(400 + NODE_H);
  });

  it("never shrinks a box onto its contents", () => {
    // Shrink-wrapping would ratchet: `extent: "parent"` clamps members inside the box, so
    // a box that hugged them after every tidy-up would get smaller and smaller and there
    // would be no gesture that grew it back.
    const stored = { "epic:E": { x: 0, y: 0 }, A: { x: CONTAINER_PAD, y: CONTAINER_HEADER_H } };
    const roomy = { "epic:E": { width: 900, height: 700 } };
    expect(fitContainers(nodes, stored, roomy)).toEqual(roomy);
  });

  it("grows an outer box when the inner one had to grow", () => {
    const nested = [box("epic:O"), box("epic:I", "epic:O"), leaf("A", "epic:I")];
    const stored = {
      "epic:O": { x: 0, y: 0 },
      "epic:I": { x: CONTAINER_PAD, y: CONTAINER_HEADER_H },
      A: { x: 500, y: 300 },
    };
    const grown = fitContainers(nested, stored, {
      "epic:O": { width: 100, height: 100 },
      "epic:I": { width: 100, height: 100 },
    });
    expect(grown["epic:O"]!.width).toBeGreaterThan(grown["epic:I"]!.width);
  });

  it("does not mutate the sizes it was handed", () => {
    const sizes = { "epic:E": { width: 240, height: 120 } };
    fitContainers(nodes, { "epic:E": { x: 0, y: 0 }, A: { x: 600, y: 400 } }, sizes);
    expect(sizes).toEqual({ "epic:E": { width: 240, height: 120 } });
  });
});

describe("clampInside", () => {
  const child = { width: NODE_W, height: NODE_H };
  const parent = { width: 600, height: 300 };

  it("keeps a member out from behind the header", () => {
    // `extent: "parent"` clamps to the parent RECTANGLE, whose top is 0 — it has never
    // heard of a header, so it will happily park a card over the epic's own title.
    expect(clampInside({ x: 40, y: 0 }, child, parent).y).toBe(CONTAINER_HEADER_H);
    expect(clampInside({ x: 40, y: -500 }, child, parent).y).toBe(CONTAINER_HEADER_H);
  });

  it("keeps a member inside the right and bottom edges", () => {
    const held = clampInside({ x: 9999, y: 9999 }, child, parent);
    expect(held.x + NODE_W).toBeLessThanOrEqual(parent.width - CONTAINER_PAD);
    expect(held.y + NODE_H).toBeLessThanOrEqual(parent.height - CONTAINER_PAD);
  });

  it("leaves a position that was already inside exactly alone", () => {
    expect(clampInside({ x: 100, y: 90 }, child, parent)).toEqual({ x: 100, y: 90 });
  });

  it("still returns a usable spot when the box is smaller than what is in it", () => {
    // Membership can shrink a box under a card that a filter has not removed yet. The
    // floor wins over the ceiling: inside-and-overflowing beats a negative coordinate.
    const tiny = { width: 40, height: 40 };
    expect(clampInside({ x: 999, y: 999 }, child, tiny)).toEqual({
      x: CONTAINER_PAD,
      y: CONTAINER_HEADER_H,
    });
  });
});

describe("absolutePositions", () => {
  it("flattens a grandchild through both of its boxes", () => {
    // The export does not go through React Flow, so it has to do this itself or write a
    // file that disagrees with the screen.
    const nodes = [box("epic:O"), box("epic:I", "epic:O"), leaf("A", "epic:I")];
    const positions = {
      "epic:O": { x: 100, y: 200 },
      "epic:I": { x: 10, y: 40 },
      A: { x: 5, y: 8 },
    };
    expect(absolutePositions(nodes, positions)["A"]).toEqual({ x: 115, y: 248 });
  });

  it("leaves a top-level node exactly where it was", () => {
    expect(absolutePositions([leaf("A")], { A: { x: 7, y: 9 } })["A"]).toEqual({ x: 7, y: 9 });
  });

  it("treats a missing coordinate as no offset rather than as NaN", () => {
    const nodes = [box("epic:O"), leaf("A", "epic:O")];
    expect(absolutePositions(nodes, { A: { x: 5, y: 5 } })["A"]).toEqual({ x: 5, y: 5 });
  });
});

describe("graphSignature and containment", () => {
  it("tells a node inside a box from the same node loose", () => {
    // O4d re-seeds on this. Without containment in the signature, opening an epic would
    // leave its members at whatever coordinates they held on the outside — which are now
    // measured from the box's corner, so hundreds of pixels away from where they read.
    const loose = graphSignature([{ id: "A" }, { id: "epic:E", container: true }], []);
    const inside = graphSignature(
      [
        { id: "A", parent: "epic:E" },
        { id: "epic:E", container: true },
      ],
      [],
    );
    expect(inside).not.toBe(loose);
  });

  it("is unchanged for a graph with no boxes in it", () => {
    // The flat case must produce the string it always produced, or every saved
    // arrangement re-seeds once for no reason on the first load after this ships.
    expect(graphSignature([{ id: "A" }, { id: "B" }], [{ from: "A", to: "B" }])).toBe("A,B|A>B");
  });
});
