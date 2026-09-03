/**
 * Where the nodes go — G2 (STA-55), kept out of the component on purpose.
 *
 * The hand-rolled relaxation this replaces lived inside the view and re-ran on every
 * render (STA-44 item 5). Moving the arrangement into a pure module is what makes the
 * memoization in GraphView possible AND what makes "does auto-arrange actually put
 * blockers to the left of what they block" a test rather than a screenshot.
 *
 * Nothing here imports React or touches storage. `graph-positions.ts` owns persistence;
 * this file only ever computes the CANONICAL arrangement, which is the thing
 * auto-arrange restores you to.
 */
import dagre from "@dagrejs/dagre";

/**
 * Node box, in pixels. Shared with TaskNode.tsx's card, and it has to be: dagre packs
 * ranks using the sizes it is given, so a card that renders wider than this would
 * overlap its neighbours no matter how good the layout is.
 */
export const NODE_W = 208;
export const NODE_H = 62;

/** Rank separation (along the flow) and node separation (across it). */
const RANK_SEP = 90;
const NODE_SEP = 24;

/**
 * Container geometry — O4c (STA-135).
 *
 * `CONTAINER_HEADER_H` is the strip the box's own identifier/title/count occupies, and it
 * is the TOP inset for everything inside: a member laid out at y = CONTAINER_HEADER_H sits
 * immediately under the header rather than behind it. The side and bottom insets are the
 * same number so the box does not read as lopsided.
 *
 * These live here rather than in EpicContainerNode.tsx for the same reason NODE_W does:
 * the arrangement is computed from them, so a header that renders taller than this value
 * would sit on top of the first row of members no matter how good the layout is.
 * EpicContainerNode imports them.
 */
export const CONTAINER_PAD = 14;
export const CONTAINER_HEADER_H = 42;

/**
 * The smallest a box may be — one member's worth of room.
 *
 * An epic whose only visible member was hidden by a filter would otherwise draw as a
 * sliver of header with nothing under it, which reads as a broken node rather than as an
 * empty group.
 */
export const MIN_CONTAINER_W = NODE_W + CONTAINER_PAD * 2;
export const MIN_CONTAINER_H = CONTAINER_HEADER_H + NODE_H + CONTAINER_PAD;

/** The margin `dagreLayout` has always framed the whole canvas with. */
const OUTER_MARGIN = 24;

export interface XY {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface LayoutNode {
  id: string;
}

/**
 * A node that may sit inside a box, and may BE a box — O4c (STA-135).
 *
 * Both fields are optional so that a plain `LayoutNode[]` is still a valid argument
 * everywhere; a flat graph is the degenerate compound graph, which is exactly how
 * `dagreLayout` is implemented below.
 */
export interface CompoundNode extends LayoutNode {
  /** The container this node is drawn inside, or null/absent at the top level. */
  parent?: string | null;
  /** True when other nodes are drawn INSIDE this one. */
  container?: boolean;
}

export interface LayoutEdge {
  from: string;
  to: string;
}

/**
 * Only nodes that actually participate in a dependency.
 *
 * The graph view has always shown the dependency graph, not the backlog — a workspace
 * where nine tickets in ten block nothing would otherwise render as a field of
 * disconnected boxes with the four interesting arrows lost inside it. The "no
 * dependencies yet" empty state is this function returning nothing.
 */
export function connectedNodes<T extends LayoutNode>(nodes: readonly T[], edges: readonly LayoutEdge[]): T[] {
  const linked = new Set<string>();
  for (const edge of edges) {
    linked.add(edge.from);
    linked.add(edge.to);
  }
  return nodes.filter((node) => linked.has(node.id));
}

/**
 * A content signature for the graph's SHAPE — ids and edges, deliberately nothing else.
 *
 * THIS IS THE LOAD-BEARING FUNCTION IN G2, and the reason is the poll. `useResource`
 * refetches the graph whenever the fingerprint changes, which is any write anywhere in
 * the workspace, roughly every 1.5s on an active repo. `graph` is therefore a brand new
 * object constantly. If the layout keyed on object identity, dagre would re-run on a
 * timer and — much worse — every node you had dragged would jump back to canonical while
 * you were looking at it.
 *
 * Title and status are excluded on purpose rather than by oversight. A ticket moving to
 * in_progress must re-tint WITHOUT relocating; including status here would make the whole
 * board twitch every time an agent claimed something, which on this project is often.
 *
 * Sorted so that a reordering of the same rows is not mistaken for a change.
 *
 * O4c ADDED CONTAINMENT, and it is part of the shape rather than an extra. `A` drawn
 * loose and `A` drawn inside a box are two different arrangements of the same ids, and
 * a signature that could not tell them apart would leave a newly opened epic's members
 * sitting at whatever coordinates they held on the outside. A node with no parent
 * contributes exactly what it always did, so the flat graph's signature is unchanged.
 */
export function graphSignature(
  nodes: readonly CompoundNode[],
  edges: readonly LayoutEdge[],
): string {
  const ids = nodes.map((n) => (n.parent ? `${n.id}<${n.parent}` : n.id)).sort();
  const pairs = edges.map((e) => `${e.from}>${e.to}`).sort();
  return `${ids.join(",")}|${pairs.join(",")}`;
}

/**
 * The canonical arrangement: a layered DAG, left to right.
 *
 * `rankdir: LR` keeps the one property the old relaxation layout was built around —
 * every arrow points forward, so "what is upstream of this" is answerable by looking
 * left. Switching to top-down would have been a quieter change than it looks: the whole
 * reading of the view is horizontal, and the legend, the node card, and every habit
 * anyone has formed in front of this thing assume it.
 *
 * dagre reports node CENTRES; React Flow positions by top-left corner. The half-size
 * subtraction happens here, once, so no caller has to remember it.
 */
export function dagreLayout(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
): Record<string, XY> {
  return compoundLayout(nodes, edges).positions;
}

/**
 * What a compound arrangement produces. Kept as one value because the two halves are
 * only correct together: a container's `size` is the box its `positions` fit inside, and
 * handing a caller one without the other invites it to invent the missing half.
 */
export interface CompoundLayout {
  /**
   * Where every node goes. A node with a parent is positioned RELATIVE to that parent's
   * top-left — React Flow's convention for sub-flows, and the one thing about this record
   * that is not obvious from looking at it.
   */
  positions: Record<string, XY>;
  /** Container id -> the box it needs. Contains an entry for every container. */
  sizes: Record<string, Size>;
}

/** Every node's box: a container's measured size, or the fixed card for anything else. */
function sizeOf(id: string, sizes: Record<string, Size>): Size {
  return sizes[id] ?? { width: NODE_W, height: NODE_H };
}

/**
 * The box a container needs to hold the children at these positions.
 *
 * The one arithmetic in the file that has to be shared: `compoundLayout` uses it as it
 * builds each level, and `fitContainers` uses it again against positions a human dragged
 * to. Two copies of it would drift and the symptom would be members hanging out of their
 * box after a reload.
 */
function boxFor(
  kids: readonly string[],
  positions: Record<string, XY>,
  sizes: Record<string, Size>,
): Size {
  let width = MIN_CONTAINER_W;
  let height = MIN_CONTAINER_H;
  for (const kid of kids) {
    const at = positions[kid];
    if (!at) continue;
    const box = sizeOf(kid, sizes);
    width = Math.max(width, at.x + box.width + CONTAINER_PAD);
    height = Math.max(height, at.y + box.height + CONTAINER_PAD);
  }
  return { width, height };
}

/** parent -> its direct children, in input order. `""` is the top level. */
function levelsOf(nodes: readonly CompoundNode[]): Map<string, CompoundNode[]> {
  const levels = new Map<string, CompoundNode[]>();
  for (const node of nodes) {
    const key = node.parent ?? "";
    const bucket = levels.get(key);
    if (bucket) bucket.push(node);
    else levels.set(key, [node]);
  }
  return levels;
}

/**
 * Containers, deepest first.
 *
 * The order every pass in this file needs: a box cannot be packed into the level above
 * until it knows how big it is, and it does not know that until its own contents are
 * laid out. `seen` makes a malformed parent chain terminate rather than hang — the store
 * forbids cycles, but this module is not the place to find out it was wrong.
 */
function containersDeepestFirst(nodes: readonly CompoundNode[]): string[] {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent ?? null]));
  const depth = (id: string): number => {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id) ?? null;
    let steps = 0;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      steps += 1;
      cursor = parentOf.get(cursor) ?? null;
    }
    return steps;
  };
  return nodes
    .filter((node) => node.container)
    .map((node) => node.id)
    .sort((a, b) => depth(b) - depth(a));
}

/**
 * The compound arrangement — O4c (STA-135). TWO PASSES, NOT ONE COMPOUND DAGRE GRAPH.
 *
 * The choice is written up on STA-135's plan doc; the short version is that React Flow
 * needs a container's SIZE and its children's coordinates RELATIVE to it, and dagre's
 * compound support hands back neither — we would derive both afterwards, on top of the
 * least-exercised path in the library. The two-pass form derives them by construction,
 * nests without a special case, and leaves O4d a container it can re-lay on its own.
 *
 * Each level is an ordinary `rankdir: LR` dagre run over its DIRECT children, where a
 * nested container participates as a single node of its measured size. Edges are mapped
 * up to that level: an edge from a member of box A to a member of box B ranks A against
 * B, which is what makes the boxes land in dependency order even though the edge is drawn
 * between the members. An edge whose two ends are the same child at this level (both
 * inside the same box) says nothing at this level and is dropped — it was already used
 * one level down.
 *
 * The margins are applied by hand rather than through dagre's `marginx/marginy` because
 * a container's top inset is NOT its side inset: the header owns the top. The flat case
 * normalizes to the same 24/24 dagre used to add, so `dagreLayout` is unchanged output
 * through a new code path.
 *
 * O4d (STA-136) made the body `arrange`, of which this is the "every level is stale" case.
 * `relayout` below is the same function told what is already on screen; the two share one
 * implementation so that the partial arrangement cannot drift from the full one.
 */
export function compoundLayout(
  nodes: readonly CompoundNode[],
  edges: readonly LayoutEdge[],
): CompoundLayout {
  return arrange(nodes, edges, null);
}

/**
 * The arrangement as it currently stands — O4d (STA-136). The argument `relayout` needs
 * in order to leave things alone.
 *
 * THE TWO HALVES COME FROM DIFFERENT MOMENTS, ON PURPOSE. `nodes` is the shape as it was
 * last LAID OUT; `positions`/`sizes` are where things are NOW, drags included. Pairing
 * them is what makes a node the user dragged count as settled AT THE PLACE THEY PUT IT
 * rather than at the place dagre last put it — which is the difference between "nothing
 * moved" and "nothing moved except the four you had tidied".
 */
export interface LayoutSnapshot {
  /** The compound node list this arrangement was computed for. */
  nodes: readonly CompoundNode[];
  /** Current coordinates, container-relative for anything inside a box. */
  positions: Record<string, XY>;
  /** Current container boxes. */
  sizes: Record<string, Size>;
}

/**
 * The compound arrangement, RE-RUN ONLY WHERE THE SHAPE MOVED — O4d (STA-136).
 *
 * ── The observation this is built on ─────────────────────────────────────────────────
 *
 * A fold does not change any level's child SET. `collapseGraph` replaces a collapsed
 * epic's members with the cluster `epic:E`; `containerize` turns that same id into a box
 * and puts the members inside it. O4c made the container REUSE the cluster id, so `epic:E`
 * is present either way, at the same level, under the same string. What a fold changes is
 * therefore only: the members of E's own level, which appear or vanish.
 *
 * So "lay out only the container that was toggled" needs no argument saying which one was
 * toggled. It falls out of a rule about the data:
 *
 *   A LEVEL IS RE-LAID OUT IFF ONE OF ITS DIRECT CHILDREN IS NOT SETTLED, where a node is
 *   settled when it was on the canvas before, IN THE SAME BOX, with a position.
 *
 * Expanding E: E's members are new, so E's level is stale and dagre runs for E alone. The
 * top level's children are all settled, so it is not touched and every coordinate out
 * there is the same OBJECT it was — not merely equal, identical. Collapsing E: its members
 * are gone and nothing is new anywhere, so NO level is stale and nothing moves at all.
 *
 * Deriving it from the data rather than from the call site is what makes it also cover the
 * cases nobody would remember to pass in: a fold arriving from a shared link, an epic
 * revealed by an epic-filter change, and a nested epic that was ALREADY expanded when its
 * parent opened — its box needs laying out too, it is deeper, and `containersDeepestFirst`
 * already runs it first.
 *
 * ── What still moves, and why that is the ticket rather than a defect ─────────────────
 *
 * An expanded box is bigger than the cluster it replaced and nothing moves out of its way,
 * so it can overlap its neighbours. "Every other node keeps its coordinates" and
 * "auto-arrange is the only thing that moves everything" together say exactly that. The
 * viewport fit is the answer — you are looking INSIDE the epic, not at the board — and
 * auto-arrange is the gesture that tidies the board. Written down so that nobody later
 * reads the overlap as a bug and repairs it by re-seeding.
 *
 * A level that IS stale re-lays out all of its children, settled ones included. That is
 * deliberate and it is the pre-O4d behaviour for the one case that reaches it — a genuinely
 * new ticket arriving on the top level. Keeping some coordinates and taking dagre's for the
 * rest would place the newcomer relative to an arrangement that no longer exists, i.e. on
 * top of something. `mergePositions` still layers the stored arrangement back over the
 * result, so anything the user had dragged returns to where they dragged it.
 */
export function relayout(
  nodes: readonly CompoundNode[],
  edges: readonly LayoutEdge[],
  previous: LayoutSnapshot | null,
): CompoundLayout {
  return arrange(nodes, edges, previous);
}

/**
 * The one implementation both entry points use. `previous === null` is the full arrangement
 * — every level stale — so `compoundLayout` is not a second code path that could drift from
 * this one, in the same way `dagreLayout` is not a second code path from `compoundLayout`.
 */
function arrange(
  nodes: readonly CompoundNode[],
  edges: readonly LayoutEdge[],
  previous: LayoutSnapshot | null,
): CompoundLayout {
  const positions: Record<string, XY> = {};
  const sizes: Record<string, Size> = {};
  if (nodes.length === 0) return { positions, sizes };

  const parentOf = new Map(nodes.map((node) => [node.id, node.parent ?? null]));
  const levels = levelsOf(nodes);

  /**
   * Nodes entitled to the coordinate they already have.
   *
   * THE PARENT COMPARISON IS THE HALF THAT IS EASY TO LEAVE OUT AND EXPENSIVE TO OMIT.
   * Positions inside a box are RELATIVE to it (O4c), so the same `{x: 20, y: 56}` means
   * two completely different places depending on which box it is read against. A node that
   * changed box has a position that is no longer about anywhere, and keeping it would park
   * it near its new box's header instead of laying it out.
   */
  const settled = new Set<string>();
  if (previous) {
    const was = new Map(previous.nodes.map((node) => [node.id, node.parent ?? ""]));
    for (const node of nodes) {
      const before = was.get(node.id);
      if (before === undefined) continue; // new to the canvas
      if (before !== (node.parent ?? "")) continue; // changed box
      if (!previous.positions[node.id]) continue; // never had a coordinate
      settled.add(node.id);
    }
  }

  /**
   * Which of `level`'s direct children the node `id` lives in — `id` itself when it is
   * one, an ancestor when it is nested deeper, `null` when it is not inside `level` at
   * all (which is also the answer for an edge naming a node we are not drawing).
   */
  const withinLevel = (id: string, level: string): string | null => {
    const seen = new Set<string>();
    let cursor: string | null = id;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const parent = parentOf.get(cursor);
      if (parent === undefined) return null; // not a node we are drawing
      if ((parent ?? "") === level) return cursor;
      cursor = parent;
    }
    return null;
  };

  const layoutLevel = (level: string): void => {
    const kids = levels.get(level) ?? [];
    if (kids.length === 0) {
      if (level !== "") sizes[level] = { width: MIN_CONTAINER_W, height: MIN_CONTAINER_H };
      return;
    }

    const g = new dagre.graphlib.Graph({ multigraph: true });
    g.setGraph({ rankdir: "LR", ranksep: RANK_SEP, nodesep: NODE_SEP, marginx: 0, marginy: 0 });
    g.setDefaultEdgeLabel(() => ({}));

    for (const kid of kids) g.setNode(kid.id, { ...sizeOf(kid.id, sizes) });
    for (const edge of edges) {
      const from = withinLevel(edge.from, level);
      const to = withinLevel(edge.to, level);
      // An edge naming a node we are not drawing would make dagre invent it as a
      // zero-size node and open a hole in the layout. Cross-workspace edges into a
      // workspace file that is not on this machine do exactly that.
      if (from === null || to === null || from === to) continue;
      // multigraph + an explicit name: a duplicated dependency row must not silently
      // replace its twin, which is what setEdge without a name would do. Two members of
      // the same pair of boxes lift to the SAME name here, which is correct — they are
      // one ranking constraint, not two.
      g.setEdge(from, to, {}, `${from}>${to}`);
    }

    dagre.layout(g);

    // dagre reports node CENTRES; React Flow positions by top-left corner.
    const corners = new Map<string, XY>();
    for (const kid of kids) {
      const laid = g.node(kid.id) as { x?: number; y?: number } | undefined;
      const box = sizeOf(kid.id, sizes);
      corners.set(kid.id, {
        x: (laid?.x ?? 0) - box.width / 2,
        y: (laid?.y ?? 0) - box.height / 2,
      });
    }

    const originX = level === "" ? OUTER_MARGIN : CONTAINER_PAD;
    const originY = level === "" ? OUTER_MARGIN : CONTAINER_HEADER_H;
    let minX = Infinity;
    let minY = Infinity;
    for (const at of corners.values()) {
      minX = Math.min(minX, at.x);
      minY = Math.min(minY, at.y);
    }
    for (const [id, at] of corners) {
      positions[id] = { x: at.x - minX + originX, y: at.y - minY + originY };
    }

    if (level !== "") {
      sizes[level] = boxFor(
        kids.map((kid) => kid.id),
        positions,
        sizes,
      );
    }
  };

  /**
   * A level nothing happened to: its children keep the coordinate OBJECTS they already
   * had, so "untouched" is assertable by identity rather than by comparing numbers.
   *
   * The container's own box is kept, GROWN ONLY — `fitContainers`' rule, applied here so
   * that `relayout`'s output is coherent on its own rather than only after a later pass.
   * The growth is not hypothetical: a settled box whose nested epic just opened now holds
   * something bigger than it did, and a box that did not grow would draw its own contents
   * hanging out of it.
   */
  const keepLevel = (level: string, snapshot: LayoutSnapshot): void => {
    const kids = levels.get(level) ?? [];
    for (const kid of kids) {
      const at = snapshot.positions[kid.id];
      if (at) positions[kid.id] = at;
    }
    if (level === "") return;
    const held = snapshot.sizes[level] ?? { width: MIN_CONTAINER_W, height: MIN_CONTAINER_H };
    const needed = boxFor(
      kids.map((kid) => kid.id),
      positions,
      sizes,
    );
    sizes[level] = {
      width: Math.max(held.width, needed.width),
      height: Math.max(held.height, needed.height),
    };
  };

  /**
   * Deepest first, for the reason every pass in this file is: a box has to know how big it
   * is before the level above can pack it, and it does not know that until its own contents
   * are settled — whether they settled by being laid out or by being left alone.
   *
   * `sizes` is rebuilt from the CURRENT container list rather than carried over, which is
   * how a collapsed epic's box measurement is dropped. That is load-bearing: `sizeOf` reads
   * `sizes[id]`, and a leftover 600x400 for an id now drawn as a 208x62 cluster would open
   * a hole in the outer layout the size of the epic that just closed.
   */
  const run = (level: string): void => {
    if (previous === null) {
      layoutLevel(level);
      return;
    }
    const kids = levels.get(level) ?? [];
    // An empty level is laid out rather than kept, so that a container which lost every
    // member still gets `layoutLevel`'s minimum box instead of no measurement at all.
    if (kids.length === 0 || kids.some((kid) => !settled.has(kid.id))) {
      layoutLevel(level);
      return;
    }
    keepLevel(level, previous);
  };

  for (const container of containersDeepestFirst(nodes)) run(container);
  run("");
  return { positions, sizes };
}

/**
 * Grow every box until it holds the positions it is actually being asked to hold.
 *
 * GROW-ONLY, AND THAT IS THE WHOLE POINT. Positions arriving from storage (or from O4d,
 * later, keeping untouched nodes still) can sit outside the box dagre measured for
 * today's membership, and a member drawn outside its container is the one failure this
 * feature cannot survive. Shrink-wrapping instead would be worse than doing nothing: with
 * `extent: "parent"` clamping children inside the box, a box that shrank to hug them
 * would ratchet smaller every time somebody tidied a member inwards, and there would be
 * no gesture that grew it back.
 *
 * Deepest first, because growing a nested box may be what forces its parent to grow.
 */
export function fitContainers(
  nodes: readonly CompoundNode[],
  positions: Record<string, XY>,
  sizes: Record<string, Size>,
): Record<string, Size> {
  const levels = levelsOf(nodes);
  const out: Record<string, Size> = { ...sizes };
  for (const container of containersDeepestFirst(nodes)) {
    const kids = (levels.get(container) ?? []).map((kid) => kid.id);
    const needed = boxFor(kids, positions, out);
    const current = out[container] ?? { width: MIN_CONTAINER_W, height: MIN_CONTAINER_H };
    out[container] = {
      width: Math.max(current.width, needed.width),
      height: Math.max(current.height, needed.height),
    };
  }
  return out;
}

/**
 * A member's position, held inside its box — O4c (STA-135).
 *
 * TWO REASONS THIS IS OURS AND NOT REACT FLOW'S, and the second is the one that bit.
 *
 * `extent: "parent"` clamps a child to the parent's RECTANGLE, which starts at 0,0 — it
 * has never heard of the header, so it will happily park a card behind the epic's title.
 * The floor here is `CONTAINER_HEADER_H` instead.
 *
 * And React Flow clamps what it DRAWS, not what it reports: a drag that runs past the
 * bottom of the box emits the position the pointer asked for, so the coordinate that gets
 * persisted is one the box does not contain. On the next load `fitContainers` grows the
 * box to hold it and everything visibly shifts — a graph that "moves a bit when you
 * reload it", which is precisely the complaint manual arrangement exists to answer.
 * Clamping on the way IN makes what is stored the thing that was on screen.
 */
export function clampInside(position: XY, child: Size, parent: Size): XY {
  const maxX = Math.max(CONTAINER_PAD, parent.width - child.width - CONTAINER_PAD);
  const maxY = Math.max(CONTAINER_HEADER_H, parent.height - child.height - CONTAINER_PAD);
  return {
    x: Math.min(Math.max(position.x, CONTAINER_PAD), maxX),
    y: Math.min(Math.max(position.y, CONTAINER_HEADER_H), maxY),
  };
}

/**
 * Container-relative coordinates flattened to canvas coordinates.
 *
 * React Flow does this internally to render; this exists because the SVG/PNG export does
 * NOT go through React Flow — it draws from `positions` directly, and without this every
 * member of every box would export at its offset-from-the-header instead of where it is.
 * The exported file disagreeing with the screen is the specific bug this prevents.
 */
export function absolutePositions(
  nodes: readonly CompoundNode[],
  positions: Record<string, XY>,
): Record<string, XY> {
  const parentOf = new Map(nodes.map((node) => [node.id, node.parent ?? null]));
  const out: Record<string, XY> = {};
  for (const node of nodes) {
    let x = 0;
    let y = 0;
    const seen = new Set<string>();
    let cursor: string | null = node.id;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      const at = positions[cursor];
      if (at) {
        x += at.x;
        y += at.y;
      }
      cursor = parentOf.get(cursor) ?? null;
    }
    out[node.id] = { x, y };
  }
  return out;
}

/**
 * Canonical arrangement with the user's own moves laid over the top.
 *
 * Stored entries win, but only for ids that still exist — a ticket that was dragged and
 * later deleted must not keep a slot, and a NEW ticket must land wherever dagre thinks
 * it belongs rather than at the origin. That second half is what stops "one new
 * dependency" from stacking every fresh node at 0,0 in the corner.
 */
export function mergePositions(
  canonical: Record<string, XY>,
  stored: Record<string, XY> | null | undefined,
): Record<string, XY> {
  if (!stored) return { ...canonical };
  const merged: Record<string, XY> = { ...canonical };
  for (const [id, position] of Object.entries(stored)) {
    if (id in merged) merged[id] = position;
  }
  return merged;
}
