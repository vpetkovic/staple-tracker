/**
 * O2c (STA-155) — one canvas derivation, and the four things it must not get wrong.
 *
 * The extraction itself is covered by the graph view's own suite staying green:
 * `graph-clusters.test.ts`, `graph-layout.test.ts` and `graph-folding.test.ts` all assert
 * the pieces this module composes, and none of them changed. What is NEW and needs
 * asserting is the composition and the second caller:
 *
 *   1. ANCESTRY BECOMES NESTED BOXES. This is the acceptance criterion that made the
 *      ticket a bug rather than a polish job — the old tab drew parents as arrows above
 *      the focus, and the graph draws them as containers around it.
 *   2. LEFT TO RIGHT. Predecessors left, successors right, at the same y. VP's actual
 *      complaint. Asserted through `absolutePositions` because the interesting nodes are
 *      inside boxes and a container-relative x is not comparable across boxes.
 *   3. THE FLAT CASE IS UNCHANGED. A graph with no `parent` anywhere must produce exactly
 *      what it produced before containers existed — that is hub mode, and it is the
 *      degradation both views share.
 *   4. THE RENDERED ARRAYS SAY WHAT app.css READS. Classes, markers, dash semantics: the
 *      vocabulary is the contract between this module and the stylesheet, and a typo in
 *      either would be invisible to the typechecker.
 *
 * Relative imports, like every other test under `src/ui/app/` — see the note in
 * graph-clusters.ts. `@` also works now (vitest.config.ts), and the two type-only imports
 * from `@/lib/types` are erased before this file runs.
 */
import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "@/lib/types";
import {
  canvasDimmed,
  canvasFlowEdges,
  canvasFlowNodes,
  canvasTicket,
  expandedCanvasShape,
} from "./graph-canvas";
import { absolutePositions, compoundLayout } from "./graph-layout";
import { lineageOf } from "../../lib/graph-lineage";

const node = (id: string, parent: string | null, extra: Partial<GraphNode> = {}): GraphNode => ({
  id,
  workspace: "sta",
  title: `${id} title`,
  status: "todo",
  parent,
  ...extra,
});

const blocks = (from: string, to: string, cross = false): GraphEdge => ({ from, to, cross });

/**
 * The shape the Relations tab is FOR, drawn as O2a would hand it over.
 *
 * `E1 > E2 > F`, F has two children; `UP` blocks F from inside the unrelated epic `E9`;
 * F blocks `DOWN`, which is loose at the top level. That is every case at once: a chain
 * of ancestors, a focus that is itself a parent, a blocker one epic away, and a dependent
 * with no epic at all.
 */
const FIXTURE = {
  nodes: [
    node("E1", null),
    node("E2", "E1"),
    node("F", "E2"),
    node("C1", "F"),
    node("C2", "F"),
    node("E9", null),
    node("UP", "E9"),
    node("DOWN", null),
  ],
  edges: [blocks("UP", "F"), blocks("F", "DOWN"), blocks("C1", "F")],
};

describe("expandedCanvasShape — ancestry becomes nested containers", () => {
  const shape = expandedCanvasShape(FIXTURE.nodes, FIXTURE.edges);
  const kindOf = new Map(shape.nodes.map((box) => [box.id, box.kind]));

  it("boxes every ancestor of the focus, nested outermost-first", () => {
    expect(kindOf.get("epic:E1")).toBe("container");
    expect(kindOf.get("epic:E2")).toBe("container");
    expect(shape.containment.parentOf.get("epic:E2")).toBe("epic:E1");
    expect(shape.containment.parentOf.get("epic:F")).toBe("epic:E2");
  });

  it("boxes the focus itself when it has children, and draws them inside it", () => {
    expect(kindOf.get("epic:F")).toBe("container");
    // The focus's own card is gone — the box's header IS the focus, exactly as the graph
    // view does it, and drawing both would be the ticket twice.
    expect(kindOf.has("F")).toBe(false);
    expect(shape.containment.parentOf.get("C1")).toBe("epic:F");
    expect(shape.containment.parentOf.get("C2")).toBe("epic:F");
    expect(shape.containment.headers.get("F")).toBe("epic:F");
  });

  it("gives a blocker from another epic its own box and leaves a loose dependent loose", () => {
    expect(kindOf.get("epic:E9")).toBe("container");
    expect(shape.containment.parentOf.get("UP")).toBe("epic:E9");
    expect(shape.containment.parentOf.has("DOWN")).toBe(false);
  });

  it("puts containers before their contents, which React Flow requires of sub-flows", () => {
    const order = shape.nodes.map((box) => box.id);
    expect(order.indexOf("epic:E1")).toBeLessThan(order.indexOf("epic:E2"));
    expect(order.indexOf("epic:E2")).toBeLessThan(order.indexOf("epic:F"));
    expect(order.indexOf("epic:F")).toBeLessThan(order.indexOf("C1"));
  });

  it("re-points an edge naming a boxed epic at that epic's box", () => {
    // UP still blocks the focus, which is now the container rather than a card.
    expect(shape.links).toContainEqual(
      expect.objectContaining({ from: "UP", to: "epic:F", cross: false, count: 1 }),
    );
    expect(shape.links).toContainEqual(expect.objectContaining({ from: "epic:F", to: "DOWN" }));
    /*
     * C1 blocks its own parent — `createChild(..., blockParentUntilDone)`, the most common
     * shape in this codebase — and that arrow SURVIVES, running from the card to the edge
     * of the box it sits in. It is not dropped as an internal dependency because it is not
     * one: the two ends are the member and the box, not two members. This is the graph
     * view's existing behaviour for an expanded epic, pinned here rather than "fixed",
     * because the two canvases agreeing is the entire ticket.
     */
    expect(shape.links).toContainEqual(expect.objectContaining({ from: "C1", to: "epic:F" }));
  });

  it("only carries dependencies as arrows the layout ranks, never parenthood", () => {
    // Every pair fed to dagre is a `blocks` edge. A parent edge in here is what forced the
    // old tab to invent a second axis.
    expect(shape.pairs).toEqual([
      { from: "UP", to: "epic:F" },
      { from: "epic:F", to: "DOWN" },
      { from: "C1", to: "epic:F" },
    ]);
  });

  it("never lets a member-to-its-own-box arrow rank anything", () => {
    // At epic:F's level the box is not one of its own children, and at the top level both
    // ends resolve to epic:F. So C1→epic:F is drawn and lays nothing out — which is why
    // the child sits where its siblings do rather than being pushed a rank left.
    const layout = compoundLayout(shape.compound, shape.pairs);
    expect(layout.positions["C1"]!.x).toBe(layout.positions["C2"]!.x);
  });
});

describe("expandedCanvasShape — dependencies rank left to right", () => {
  it("puts a predecessor left of the focus and a successor right of it", () => {
    const shape = expandedCanvasShape(FIXTURE.nodes, FIXTURE.edges);
    const layout = compoundLayout(shape.compound, shape.pairs);
    // Container-relative coordinates are not comparable across boxes; flatten first.
    const at = absolutePositions(shape.compound, layout.positions);

    expect(at["UP"]!.x).toBeLessThan(at["epic:F"]!.x);
    expect(at["epic:F"]!.x).toBeLessThan(at["DOWN"]!.x);
    // The blocker's own box ranks with it, which is what makes "the auth epic blocks
    // this" legible rather than a bare identifier floating on the left.
    expect(at["epic:E9"]!.x).toBeLessThan(at["epic:E1"]!.x);
  });

  it("ranks a chain of blockers by distance, further upstream further left", () => {
    const shape = expandedCanvasShape(
      [node("A", null), node("B", null), node("C", null)],
      [blocks("A", "B"), blocks("B", "C")],
    );
    const at = absolutePositions(shape.compound, compoundLayout(shape.compound, shape.pairs).positions);
    expect(at["A"]!.x).toBeLessThan(at["B"]!.x);
    expect(at["B"]!.x).toBeLessThan(at["C"]!.x);
  });
});

describe("expandedCanvasShape — the flat case", () => {
  /** Hub mode's payload may carry no `parent` at all. Both views degrade identically. */
  const flat = expandedCanvasShape(
    [node("A", null), node("B", null)],
    [blocks("A", "B", true)],
  );

  it("draws no containers and nests nothing", () => {
    expect(flat.nodes.map((box) => box.kind)).toEqual(["task", "task"]);
    expect(flat.containment.parentOf.size).toBe(0);
    expect(flat.compound).toEqual([
      { id: "A", parent: null, container: false },
      { id: "B", parent: null, container: false },
    ]);
  });

  it("keeps the cross-workspace flag on the arrow", () => {
    expect(flat.links).toEqual([{ from: "A", to: "B", derived: false, cross: true, count: 1 }]);
  });

  it("signs the shape over ids and pairs, so a status change cannot move anything", () => {
    const restyled = expandedCanvasShape(
      [node("A", null, { status: "done", title: "renamed" }), node("B", null)],
      [blocks("A", "B", true)],
    );
    expect(restyled.signature).toBe(flat.signature);
  });
});

describe("canvasFlowNodes", () => {
  const shape = expandedCanvasShape(FIXTURE.nodes, FIXTURE.edges);
  const layout = compoundLayout(shape.compound, shape.pairs);
  const flow = canvasFlowNodes({
    nodes: shape.nodes,
    containment: shape.containment,
    positions: layout.positions,
    sizes: layout.sizes,
    dimmed: new Set(["C2"]),
    faded: null,
    focus: "epic:F",
    showWorkspace: false,
    onExpand: () => {},
    onCollapse: () => {},
    draggable: false,
    classNameFor: (box) => (box.id === "UP" ? "staple-relation-unresolved" : undefined),
  });
  const byId = new Map(flow.map((box) => [box.id, box]));

  it("registers each box against the component that draws it", () => {
    expect(byId.get("epic:F")!.type).toBe("container");
    expect(byId.get("C1")!.type).toBe("task");
  });

  it("declares every size, because these nodes are derived rather than measured", () => {
    const card = byId.get("C1")!;
    expect(card.width).toBe(208);
    expect(card.height).toBe(62);
    const box = byId.get("epic:F")!;
    expect(box.width).toBe(layout.sizes["epic:F"]!.width);
    expect(box.height).toBe(layout.sizes["epic:F"]!.height);
  });

  it("makes a boxed node a sub-flow child clamped to its parent", () => {
    expect(byId.get("C1")!.parentId).toBe("epic:F");
    expect(byId.get("C1")!.extent).toBe("parent");
    expect(byId.get("DOWN")!.parentId).toBeUndefined();
    expect(byId.get("DOWN")!.extent).toBeUndefined();
  });

  it("passes dim, focus, draggability and the caller's class through", () => {
    expect(byId.get("C2")!.data.dim).toBe(true);
    expect(byId.get("C1")!.data.dim).toBe(false);
    expect(byId.get("epic:F")!.data.focused).toBe(true);
    expect(byId.get("C1")!.data.focused).toBe(false);
    expect(byId.get("C1")!.draggable).toBe(false);
    expect(byId.get("UP")!.className).toBe("staple-relation-unresolved");
    expect(byId.get("C1")!.className).toBeUndefined();
  });

  it("leaves draggability and class alone when the caller says nothing", () => {
    const plain = canvasFlowNodes({
      nodes: shape.nodes,
      containment: shape.containment,
      positions: layout.positions,
      sizes: layout.sizes,
      dimmed: new Set(),
      faded: null,
      focus: null,
      showWorkspace: true,
      onExpand: () => {},
      onCollapse: () => {},
    });
    expect(plain[0]!.draggable).toBeUndefined();
    expect(plain[0]!.className).toBeUndefined();
    expect(plain.every((box) => box.data.showWorkspace === true)).toBe(true);
  });

  it("fades resolved work without letting fade fight dim", () => {
    const faded = canvasFlowNodes({
      nodes: shape.nodes,
      containment: shape.containment,
      positions: layout.positions,
      sizes: layout.sizes,
      dimmed: new Set(["C2"]),
      faded: new Set(["C1", "C2"]),
      focus: null,
      showWorkspace: false,
      onExpand: () => {},
      onCollapse: () => {},
    });
    const at = new Map(faded.map((box) => [box.id, box]));
    expect(at.get("C1")!.style).toEqual({ opacity: 0.32 });
    // Already dim: the class owns the opacity and an inline style would outrank it.
    expect(at.get("C2")!.style).toBeUndefined();
  });
});

describe("canvasFlowEdges", () => {
  const links = [
    { from: "A", to: "B", derived: false, cross: false, count: 1 },
    { from: "B", to: "C", derived: false, cross: true, count: 3 },
    { from: "C", to: "D", derived: true, cross: false, count: 0 },
  ];

  it("says nothing about emphasis when nothing was asked", () => {
    const edges = canvasFlowEdges(links, null);
    expect(edges.map((edge) => edge.className)).toEqual([
      "staple-rf-edge",
      "staple-rf-edge cross",
      "staple-rf-edge",
    ]);
    expect(edges[0]!.markerEnd).toEqual({ type: "arrowclosed", width: 16, height: 16 });
    expect(edges[0]!.type).toBe("smoothstep");
  });

  it("lights the asked-about chain and dims the rest", () => {
    const emphasis = lineageOf(links, "B");
    const edges = canvasFlowEdges(links, emphasis);
    expect(edges[0]!.className).toBe("staple-rf-edge lineage");
    expect(edges[1]!.className).toBe("staple-rf-edge cross lineage");
    // C→D is downstream of B, so it is lit too; an unrelated pair is what dims.
    const stray = canvasFlowEdges([...links, { from: "X", to: "Y", derived: false, cross: false, count: 1 }], emphasis);
    expect(stray[3]!.className).toBe("staple-rf-edge dim");
  });

  it("draws a bridged edge dotted and an unbundled one plain", () => {
    const edges = canvasFlowEdges(links, null);
    expect(edges[2]!.style).toEqual({ strokeDasharray: "1 4", opacity: 0.7 });
    expect(edges[0]!.style).toBeUndefined();
  });

  it("labels a bundle with what it stands for and says nothing about a single arrow", () => {
    const edges = canvasFlowEdges(links, null);
    expect(edges[0]!.label).toBeUndefined();
    expect(edges[1]!.label).toBe("×3");
    // A bridged edge has no count: it says "there is a path", not "there are n of them".
    expect(edges[2]!.label).toBeUndefined();
  });

  it("keeps duplicated dependencies apart, which React Flow keys on", () => {
    const twice = canvasFlowEdges(
      [
        { from: "A", to: "B", derived: false, cross: false, count: 1 },
        { from: "A", to: "B", derived: false, cross: false, count: 1 },
      ],
      null,
    );
    expect(new Set(twice.map((edge) => edge.id)).size).toBe(2);
  });
});

describe("canvasDimmed", () => {
  const shape = expandedCanvasShape(FIXTURE.nodes, FIXTURE.edges);

  it("dims nothing when nothing was asked", () => {
    expect(canvasDimmed(shape.nodes, shape.containment, null).size).toBe(0);
  });

  it("keeps a box lit while anything inside it is lit", () => {
    // Only C1 is lit. Its box must stay lit — React Flow draws members as siblings, so a
    // dim box around bright cards is a ghost outline rather than an answer.
    const dimmed = canvasDimmed(shape.nodes, shape.containment, {
      nodes: new Set(["C1"]),
      edges: new Set(),
    });
    expect(dimmed.has("C1")).toBe(false);
    expect(dimmed.has("C2")).toBe(true);
    expect(dimmed.has("epic:F")).toBe(false);
    expect(dimmed.has("epic:E2")).toBe(false);
    expect(dimmed.has("epic:E9")).toBe(true);
  });
});

describe("canvasTicket", () => {
  const shape = expandedCanvasShape(FIXTURE.nodes, FIXTURE.edges);
  const layout = compoundLayout(shape.compound, shape.pairs);
  const flow = canvasFlowNodes({
    nodes: shape.nodes,
    containment: shape.containment,
    positions: layout.positions,
    sizes: layout.sizes,
    dimmed: new Set(),
    faded: null,
    focus: null,
    showWorkspace: false,
    onExpand: () => {},
    onCollapse: () => {},
  });
  const byId = new Map(flow.map((box) => [box.id, box]));

  it("opens the ticket a card stands for", () => {
    expect(canvasTicket(byId.get("C1")!)).toEqual({ workspace: "sta", id: "C1" });
  });

  it("opens the EPIC a box stands for, not one of its members", () => {
    expect(canvasTicket(byId.get("epic:F")!)).toEqual({ workspace: "sta", id: "F" });
  });
});
