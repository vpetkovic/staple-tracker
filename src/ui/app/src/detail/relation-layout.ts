/**
 * Where the boxes go on the Relations tab — O2b (STA-132), as a pure function.
 *
 * The tab has to say four things at once about one ticket: what it belongs to, what it
 * contains, what must land before it, and what waits on it. O2a
 * (lib/relation-context.ts) already decided WHICH boxes and arrows; this file decides
 * WHERE, and nothing else. No React, no React Flow, no CSS — which is the only reason
 * "does an ancestor actually render above the focus" is a test rather than a screenshot.
 *
 * ── Why this is not dagre ────────────────────────────────────────────────────────────
 *
 * The graph view lays out with `dagreLayout` and is right to. dagre has ONE `rankdir`,
 * though, and this tab needs two axes AT THE SAME TIME: ancestors above and children
 * below (vertical, the parent relation) while predecessors sit left and successors right
 * (horizontal, the blocks relation). `LR` ranks parents to the left of their children;
 * `TB` ranks blockers above what they block. Either choice quietly contradicts half of
 * what the tab is for, and there is no dagre knob that says "rank this edge kind down
 * the page and that one across it". Two dagre passes stitched together is more code than
 * the placement below and loses determinism at the seam, which on a canvas that re-renders
 * every 1.5s poll means boxes that swap places while you read them.
 *
 * So: a cross. A vertical SPINE of generations through the middle, and two horizontal
 * WINGS of dependency hanging off it.
 *
 * ── The one property worth stating ───────────────────────────────────────────────────
 *
 * THE WINGS START OUTSIDE THE SPINE'S WIDEST ROW. `spineHalfWidth` is measured from the
 * rows after they are laid out, and the first wing column begins `WING_GAP` beyond it.
 * That is what makes "no box lands on another box" true BY CONSTRUCTION rather than true
 * on the fixtures someone happened to write: an epic with nine children can spread as
 * wide as it likes and still cannot grow into the blocker column, because the blocker
 * column is defined relative to how wide it grew.
 *
 * Sizes come from `graph-layout.ts` rather than being redeclared. That file says in as
 * many words that the box size is one fact shared with the card; a second copy here would
 * be a fourth place for it to drift.
 */
import type { RelationContext } from "../lib/relation-context";
import { NODE_H, NODE_W, type XY } from "../views/graph/graph-layout";

/**
 * What a drawn node IS, relative to the focus. Drives placement here and emphasis in the
 * tab; exported so the two cannot disagree about which box is the epic and which is the
 * blocker.
 *
 * `context` is the one that needs explaining: O2a deliberately draws the PARENT of each
 * lineage node — one hop, no further — so that a blocker from another epic arrives as
 * "the auth epic blocks this" rather than as a bare identifier. Such a node is not a
 * relation of the focus at all. It is orientation.
 */
export type RelationRole =
  | "focus"
  | "ancestor"
  | "descendant"
  | "predecessor"
  | "successor"
  | "context";

export interface RelationLayout {
  /** React Flow coordinates: TOP-LEFT, not centres. Keyed by node id. */
  positions: Record<string, XY>;
  roles: Record<string, RelationRole>;
  /**
   * Changes exactly when the arrangement would move, and not when a status or a title
   * changes. What the canvas re-fits the viewport on — same reasoning as
   * `graphSignature`, for the same reason: the poll rebuilds this object constantly and
   * re-fitting on object identity would yank the viewport once a second.
   */
  signature: string;
}

/** Between stacked rows, and between members of a wing column. */
const ROW_GAP = 34;
/** Between siblings sharing a spine row. */
const SIBLING_GAP = 28;
/** Clear air between the spine's widest row and the first wing column. */
const WING_GAP = 64;
/** Between wing columns — one hop further upstream or downstream. */
const COLUMN_GAP = 64;

const ROW_PITCH = NODE_H + ROW_GAP;
const SPINE_PITCH = NODE_W + SIBLING_GAP;
const COLUMN_PITCH = NODE_W + COLUMN_GAP;

const EMPTY: RelationLayout = { positions: {}, roles: {}, signature: "" };

function push(index: Map<string, string[]>, key: string, value: string): void {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}

/**
 * Breadth-first layers away from `start`, CLAIMING each node for `role` as it goes.
 *
 * Claiming inside the walk is what implements the priority rule: whoever calls first
 * wins, so a ticket that is both my child and my blocker is drawn once, as my child, and
 * the blocker walk does not get a second opinion about where it goes.
 *
 * IT TRAVERSES THROUGH A NODE SOMEONE ELSE ALREADY CLAIMED, and that is not an oversight
 * — it is this codebase's most common shape. `createChild(..., blockParentUntilDone)`
 * makes a child that ALSO blocks its parent, so on a normal epic every direct blocker is
 * already a descendant. Stopping the upstream walk at the first claimed node would have
 * ended it immediately and stranded the whole pile behind those children, which is the
 * exact question the tab exists to answer. The walk cannot run away regardless: its
 * adjacency comes from O2a's already-narrowed sub-graph, so the furthest it can reach is
 * a box that was going to be drawn anyway.
 *
 * A layer may therefore be EMPTY (every node at that distance belongs to someone else)
 * while later layers are not. Emptiness is preserved rather than collapsed here; the
 * caller decides what an empty rank means for its own axis.
 */
function claimLayers(
  start: string,
  next: (id: string) => readonly string[],
  roles: Record<string, RelationRole>,
  role: RelationRole,
): string[][] {
  const layers: string[][] = [];
  const seen = new Set<string>([start]);
  let frontier: string[] = [start];
  while (frontier.length > 0) {
    const layer: string[] = [];
    const reached: string[] = [];
    for (const id of frontier) {
      for (const neighbour of next(id)) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        reached.push(neighbour);
        if (roles[neighbour]) continue;
        roles[neighbour] = role;
        layer.push(neighbour);
      }
    }
    if (reached.length === 0) break;
    layers.push(layer);
    frontier = reached;
  }
  return layers;
}

/**
 * The arrangement for one `RelationContext`.
 *
 * Pure and deterministic: same context in, identical object out, every time. Every
 * ordering it depends on is an ordering O2a already fixed (ancestry root-first, everything
 * else in payload order), so the canvas does not reshuffle between polls.
 *
 * A context whose focus is not drawable — the first poll, or a ticket from a workspace
 * this payload does not cover — returns an empty layout rather than throwing. The tab
 * shows "no relations" for it, which is the truthful thing to show when there is no graph
 * yet.
 */
export function relationLayout(context: RelationContext): RelationLayout {
  const drawn = new Set(context.graph.nodes.map((node) => node.id));
  if (!drawn.has(context.focus)) return { positions: {}, roles: {}, signature: EMPTY.signature };

  // ---------- adjacency, all of it in the order O2a emitted ----------
  const childrenOf = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  const blockersOf = new Map<string, string[]>();
  const dependentsOf = new Map<string, string[]>();
  for (const edge of context.graph.edges) {
    if (edge.kind === "parent") {
      push(childrenOf, edge.from, edge.to);
      parentOf.set(edge.to, edge.from);
    } else {
      push(blockersOf, edge.to, edge.from);
      push(dependentsOf, edge.from, edge.to);
    }
  }

  // ---------- who is what ----------
  const roles: Record<string, RelationRole> = { [context.focus]: "focus" };
  // Ancestry comes from O2a's chain rather than from a walk, because its ORDER is a fact
  // about the plan (root first) and re-deriving it here would be a second chance to get
  // the direction wrong. Filtered to drawable: a parent absent from the payload has no box.
  const ancestors = context.ancestors.filter((id) => drawn.has(id));
  for (const id of ancestors) roles[id] = "ancestor";
  const descendantLayers = claimLayers(
    context.focus,
    (id) => childrenOf.get(id) ?? [],
    roles,
    "descendant",
  );
  const upstreamLayers = claimLayers(
    context.focus,
    (id) => blockersOf.get(id) ?? [],
    roles,
    "predecessor",
  );
  const downstreamLayers = claimLayers(
    context.focus,
    (id) => dependentsOf.get(id) ?? [],
    roles,
    "successor",
  );
  for (const node of context.graph.nodes) roles[node.id] ??= "context";

  // ---------- the spine: generations, down the middle ----------
  const rows: string[][] = [];
  for (const id of ancestors) rows.push([id]);
  rows.push([context.focus]);
  // Empty ranks are dropped rather than drawn as blank rows. A generation whose every
  // member was claimed by a closer relation has nothing to show, and reserving a stripe
  // of whitespace for it would say "there is a hidden generation here", which is false.
  for (const layer of descendantLayers) if (layer.length > 0) rows.push(layer);
  const focusRow = ancestors.length;

  // Centres for now; the top-left conversion happens once, at the end.
  const centres: Record<string, XY> = {};
  let spineHalfWidth = NODE_W / 2;
  rows.forEach((row, index) => {
    const y = (index - focusRow) * ROW_PITCH;
    const half = (row.length - 1) / 2;
    row.forEach((id, position) => {
      centres[id] = { x: (position - half) * SPINE_PITCH, y };
    });
    spineHalfWidth = Math.max(spineHalfWidth, half * SPINE_PITCH + NODE_W / 2);
  });

  // ---------- the wings: dependency, out to the sides ----------
  //
  // `sign` is the whole difference between the two of them: -1 draws upstream to the
  // left, +1 draws downstream to the right. One function, because "predecessors mirror
  // successors" is a property worth being unable to break.
  const placeWing = (layers: string[][], sign: -1 | 1): void => {
    // Empty ranks are skipped, so a wing whose first hop was all claimed by the spine
    // (every `blockParentUntilDone` child) still starts against the spine instead of
    // leaving an unexplained empty column. Distance ORDER survives — further upstream is
    // still further out — which is the thing the reader is actually reading.
    layers.filter((layer) => layer.length > 0).forEach((layer, index) => {
      // The extra-hop epic joins its child's column as a MEMBER rather than being nudged
      // in above it afterwards. Same pixels, but as a member the column's spread accounts
      // for it, so it cannot land on the box below it however many blockers share a rank.
      const column: string[] = [];
      for (const id of layer) {
        const parent = parentOf.get(id);
        if (parent && roles[parent] === "context" && centres[parent] === undefined) {
          if (!column.includes(parent)) column.push(parent);
        }
        column.push(id);
      }
      const x = sign * (spineHalfWidth + WING_GAP + NODE_W / 2 + index * COLUMN_PITCH);
      const half = (column.length - 1) / 2;
      column.forEach((id, position) => {
        centres[id] = { x, y: (position - half) * ROW_PITCH };
      });
    });
  };
  placeWing(upstreamLayers, -1);
  placeWing(downstreamLayers, 1);

  // ---------- anything left ----------
  //
  // Defensive. O2a's node set is focus + chain + subtree + lineage + one parent hop, and
  // every one of those is placed above — but a box with no coordinate would stack at the
  // origin on top of the focus, which is the one failure that would look like a rendering
  // bug rather than like data. One centred row under everything else instead.
  const stranded = context.graph.nodes
    .map((node) => node.id)
    .filter((id) => centres[id] === undefined);
  if (stranded.length > 0) {
    const y = (rows.length - focusRow) * ROW_PITCH;
    const half = (stranded.length - 1) / 2;
    stranded.forEach((id, position) => {
      centres[id] = { x: (position - half) * SPINE_PITCH, y };
    });
  }

  // dagre reports centres and React Flow positions by top-left corner; `dagreLayout` does
  // this same subtraction once so no caller has to remember it, and neither should this
  // one's callers.
  const positions: Record<string, XY> = {};
  for (const [id, centre] of Object.entries(centres)) {
    positions[id] = { x: centre.x - NODE_W / 2, y: centre.y - NODE_H / 2 };
  }

  return {
    positions,
    roles,
    signature: `${context.focus}|${Object.keys(positions).sort().join(",")}`,
  };
}
