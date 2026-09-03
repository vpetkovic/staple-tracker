/**
 * WHERE A ROW SITS RELATIVE TO THE OTHER ROWS IN ITS BUCKET — O8a (STA-149).
 *
 * One placement rule, shared by `tree-model.ts`'s `flatten` and by `pickup-model.ts`'s
 * `buildPickupGroups`. It knows about parents, children, ghosts and indentation, and about
 * nothing else: no statuses, no pickup sections, no comparator, no `TaskRow`. What it hands
 * back is a forest and a walk over it; every caller keeps its own answers to "in what order
 * do siblings go" and "what does a rendered line look like".
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────────────────
 *
 * It did not, and that WAS the bug O8a fixes. `flatten` filed a child under a parent in the
 * same bucket, ghosted a parent that was elsewhere, and let one recursive walk produce
 * depth, guides, the elbow and `isLast` for both cases. `buildPickupGroups` had a second,
 * flatter rule: blocks of one row, or a ghost plus the orphans it brackets, and no case at
 * all for a parent that is present. So the same pair of tickets rendered as a family under
 * group-by-status and as two unrelated rows one menu entry away — which is precisely what
 * STA-148 says grouping must never do, grouping being a presentation layer.
 *
 * Two placement rules is also how the NEXT divergence gets in. O3c's ghost had to be built
 * twice and reasoned about twice; STA-150 lifts that ghost from the nearest parent to the
 * whole ancestor chain and, with two copies, would have to lift it twice more. O3a
 * extracted the subtree walk into `components/task-list/model.ts` for exactly this reason
 * and left a note saying so. This is the same move for the placement.
 *
 * ── WHAT A GHOST IS, HERE ─────────────────────────────────────────────────────────────
 *
 * A synthesised node standing in for a parent that is NOT in this bucket — it landed in
 * another group, or a filter removed it — drawn so that its orphans read as one family
 * rather than as unrelated rows that happen to share an 11px chip. It is injected as an
 * ordinary node with the orphans filed under it, so depth, guides, the elbow, `isLast` and
 * the nesting of the orphans' OWN children all fall out of the ordinary traversal. Nothing
 * below branches on `ghost` except the two lines that have to.
 *
 * The caller decides WHICH parents may be ghosted, by supplying `ghostFor`; a caller that
 * supplies nothing gets no ghosts and a bucket of roots, which is what flat mode wants.
 */
import type { Issue, IssueRow } from "@/lib/types";

/**
 * One placed row: the row itself, whether it was synthesised, and what hangs off it.
 *
 * `children` is MUTABLE on purpose. `placeRows` fills it in encounter order and hands the
 * forest back unsorted, because the two callers order siblings differently and neither
 * order is this file's to know — the tree ranks them with `compareRows`, the queue keeps
 * the store's sequence and sorts nothing. A caller that wants an order sorts these arrays
 * in place before walking.
 */
export interface PlacedNode {
  row: IssueRow;
  /** Synthesised to stand in for a parent that is not in this bucket. */
  ghost: boolean;
  children: PlacedNode[];
}

export interface PlaceOptions {
  /**
   * The parent to draw a GHOST of for a row whose parent is not in this bucket, or
   * `undefined` for silence.
   *
   * Silence is a real answer and the caller owes it in three cases: the parent is not in
   * the data at all (a ghost pointing at a ticket the reader cannot reach is worse than
   * nothing), the bucket's own header already names it (O3d), or this container has no
   * indent for a ghost to be legible in (O3c). All three live at the call site because all
   * three are facts about the caller's axis, not about placement.
   *
   * Absent entirely means no ghosts at all — flat mode's answer.
   */
  ghostFor?: (row: IssueRow) => Issue | undefined;
  /**
   * THE NEXT ANCESTOR UP FROM AN ALREADY-SYNTHESISED GHOST — O8b (STA-150), or `undefined`
   * to stop the chain there.
   *
   * A SECOND resolver rather than reusing `ghostFor`, because the two are asked different
   * questions and are allowed different answers. `ghostFor` is asked about a row that is ON
   * THE PAGE and may consult `hiddenParents` — a map keyed by the child's id, so only real
   * rows have an entry, and a row that would otherwise render as a mysterious root has
   * earned the answer. A ghost is not on the page, has no entry there, and gets the narrower
   * source: an ancestor that is somewhere in the current list. A chain that climbed further,
   * into work the filter removed, would be undoing the filter — which is the argument O3c
   * already made for keeping flat mode ghost-free.
   *
   * Absent means O3c's original behaviour exactly: the nearest missing ancestor, and stop.
   */
  ancestorFor?: (issue: Issue) => Issue | undefined;
  /**
   * MAY LINEAGE BE DRAWN AT ALL IN THIS CONTAINER — O8a (STA-149). Default `true`.
   *
   * `false` returns every row as a root, nested under nothing. It exists for the one
   * surface where nesting is not a presentation choice but a loss: `TaskRowLine` zeroes the
   * indent AND drops the connectors when `columns.disclosure` is off, so a child placed
   * under its parent there would be pixel-identical to a root and would ALSO have given up
   * the breadcrumb chip that was standing in for the indent. Lineage-free and context-free
   * is strictly worse than the flat, chipped list those presets render today.
   *
   * It is the same switch as `ghostFor`'s absence at those call sites, and deliberately so:
   * a ghost and an indent buy the reader the same thing and cost the same pixels.
   */
  nest?: boolean;
}

/**
 * File every row in a bucket under its parent, under a ghost of its parent, or at the root.
 *
 * ONE GHOST PER FAMILY PER BUCKET: the second orphan finds the first one's and nests beside
 * it. A ghost takes the position its first-encountered orphan would have had — which is
 * what makes the block land where the queue expects it, and what makes `rankedRow` below
 * able to say "sort as the best row you bracket" without a second ordering rule.
 *
 * Rows whose parent is in the bucket are filed under it WHEREVER it appears in the input,
 * before or after them: the nodes are all built first, so placement never depends on input
 * order. What input order does decide is the order of the unsorted result, and that is the
 * caller's to keep or to overwrite.
 */
export function placeRows(bucket: readonly IssueRow[], options: PlaceOptions = {}): PlacedNode[] {
  const { ghostFor, ancestorFor, nest = true } = options;

  const nodes: PlacedNode[] = bucket.map((row) => ({ row, ghost: false, children: [] }));
  if (!nest) return nodes;

  /**
   * FIRST WINS on a duplicate id, and the duplicate still gets its own node above.
   *
   * Two rows with one id is not a case this list should ever see, but "the second copy
   * silently replaces the first as everyone's parent" and "the second copy is not rendered
   * at all" are both worse failures than drawing it twice. Lookup collapses; rendering
   * does not.
   */
  const byId = new Map<string, PlacedNode>();
  for (const node of nodes) {
    const id = node.row.issue.id;
    if (!byId.has(id)) byId.set(id, node);
  }

  const roots: PlacedNode[] = [];
  const ghosts = new Map<string, PlacedNode>();

  /**
   * THE GHOST OF `id`, PLACED — creating it, and everything above it, if it is new.
   *
   * O3c stopped at the nearest missing ancestor. O8b (STA-150) walks up until one of three
   * things happens, and the three of them are the whole rule:
   *
   *   A REAL ROW IN THIS BUCKET. The chain nests under it and stops — the reader can see
   *   that ancestor for real, so a dimmed copy of it would be the same fact twice.
   *   AN ANCESTOR ALREADY GHOSTED. The memo returns it and the chain stops, which is what
   *   makes "one ghost per family per bucket" survive chains: two orphans of two different
   *   sub-epics of one epic share the epic's ghost, each under its own.
   *   NOBODY NAMEABLE. The chain becomes a root, exactly as a single ghost used to.
   *
   * `seen` carries the path and the memo is written BEFORE the recursion, so a parent cycle
   * in the data terminates at the edge that closes it rather than looping — and the rows
   * still render, where a cycle among real rows drops them.
   */
  const placeGhost = (id: string, issue: Issue, workspace: string, seen: Set<string>): PlacedNode => {
    const existing = ghosts.get(id);
    if (existing) return existing;

    /**
     * WHAT A GHOST CARRIES: the parent's issue, and nothing about the parent's own
     * liveness. `hiddenParents` yields an `Issue` and nothing more, so a ghost built from a
     * filtered-away parent could never show a claim; letting the cross-group ghost show one
     * would mean two ghosts of identical shape reporting different KINDS of fact about the
     * same relationship. The parent's real row — in its own group, or behind the filter —
     * stays the single place its claim is written down.
     *
     * The WORKSPACE is the orphan's. `parentId` is intra-workspace by construction, so that
     * is not an approximation, and it is what makes click-to-open work with no new plumbing.
     */
    const ghost: PlacedNode = { row: { issue, claim: null, workspace }, ghost: true, children: [] };
    ghosts.set(id, ghost);
    seen.add(id);

    const parentId = issue.parentId;
    if (parentId && !seen.has(parentId)) {
      const real = byId.get(parentId);
      if (real) {
        real.children.push(ghost);
        return ghost;
      }
      const up = ancestorFor?.(issue);
      if (up) {
        placeGhost(parentId, up, workspace, seen).children.push(ghost);
        return ghost;
      }
    }

    roots.push(ghost);
    return ghost;
  };

  for (const node of nodes) {
    const parentId = node.row.issue.parentId;

    // Nesting happens where parent and child are both in this bucket…
    if (parentId) {
      const parent = byId.get(parentId);
      if (parent) {
        parent.children.push(node);
        continue;
      }
    }

    // …and where the parent is not, but can be NAMED.
    const missing = parentId && ghostFor ? ghostFor(node.row) : undefined;
    if (missing && parentId) {
      placeGhost(parentId, missing, node.row.workspace, new Set()).children.push(node);
      continue;
    }

    roots.push(node);
  }

  return roots;
}

/**
 * The real row a node sorts as.
 *
 * A GHOST SORTS AS THE BEST ROW IT BRACKETS — O3c (STA-128), and it is a rule about
 * ordering that belongs beside the placement that creates the thing being ordered. Ranked
 * by the parent's OWN priority, a low-priority epic holding the group's most urgent task
 * would sink and take that task with it: acquiring a context line would have reordered real
 * work, which nothing asked for and every reader would notice. Ranked by its best child,
 * the block lands exactly where that child would have landed.
 *
 * Recurses through ghosts, so a chain of them is ranked by the real row at the bottom.
 * Reads `children[0]`, so the caller must have sorted a node's children before sorting the
 * list that node is in — which is what `sortPlaced` below is for.
 */
export function rankedRow(node: PlacedNode): IssueRow {
  if (!node.ghost) return node.row;
  const first = node.children[0];
  return first ? rankedRow(first) : node.row;
}

/**
 * Sort every sibling list in the forest, DEEPEST FIRST.
 *
 * The order matters and is not a detail: `rankedRow` reads a ghost's first child, so a list
 * containing a ghost can only be sorted once that ghost's own children are in order. Sorting
 * top-down would rank the ghost by whichever orphan happened to be encountered first.
 *
 * The comparator is the caller's, over `PlacedNode` rather than `IssueRow`, so a caller that
 * does not want ghosts ranked by their contents is free not to use `rankedRow`.
 */
export function sortPlaced(
  roots: PlacedNode[],
  compare: (a: PlacedNode, b: PlacedNode) => number,
): void {
  const sortTree = (node: PlacedNode) => {
    for (const child of node.children) sortTree(child);
    node.children.sort(compare);
  };
  for (const node of roots) sortTree(node);
  roots.sort(compare);
}

/** One line of the rendered tree — everything the walk knows, and nothing about styling. */
export interface NestedRow {
  row: IssueRow;
  ghost: boolean;
  depth: number;
  /** One entry per ancestor level: does that ancestor have a sibling below it. */
  guides: boolean[];
  isLast: boolean;
  hasChildren: boolean;
  /**
   * DIRECT children that survived into this bucket — what a `+N` badge declares it hides.
   *
   * A GHOST IS TRANSPARENT TO THIS COUNT — O8b (STA-150). `+N` says how much work a fold is
   * hiding, and a bracket is not work: with chains, a real row can have exactly one child
   * that is a ghost holding three tickets, and "+1" would then stand for three. So a ghost
   * child is replaced by its own children, recursively — the same rule that keeps ghosts
   * out of `StatusGroup.count` and out of `visibleOrder`, applied one level down.
   *
   * `hasChildren` is NOT transparent, because something genuinely is nested there.
   */
  childCount: number;
  isExpanded: boolean;
}

/**
 * Walk the placed forest depth-first and emit one `NestedRow` per visible line.
 *
 * This is the only place depth, guides and the elbow are computed, for either axis. A
 * collapsed node emits itself and stops, which is what keeps `visibleOrder` honest for free:
 * a row that is not on the page was never in the list.
 *
 * `isExpanded` is asked about every node, INCLUDING ghosts and leaves, and the caller
 * answers for its own axis — the tree by status, the queue by "open unless the user folded
 * it", both by "a ghost is always open" for now. A leaf's answer is irrelevant to the walk
 * and is still reported, because a caller that renders a chevron from it should be reading
 * `hasChildren` and this way it cannot accidentally read something else.
 */
export function walkPlaced(
  roots: readonly PlacedNode[],
  isExpanded: (node: PlacedNode) => boolean,
): NestedRow[] {
  const out: NestedRow[] = [];

  /** See `NestedRow.childCount`: brackets do not count, what they bracket does. */
  const taskChildCount = (node: PlacedNode): number =>
    node.children.reduce((n, child) => n + (child.ghost ? taskChildCount(child) : 1), 0);

  const walk = (list: readonly PlacedNode[], depth: number, ancestorGuides: boolean[]): void => {
    list.forEach((node, index) => {
      const isLast = index === list.length - 1;
      const kids = node.children;
      const expanded = isExpanded(node);
      // At depth 0 there is no ancestor to draw a guide for; below it, every level adds
      // one. So `guides.length === depth` for every row on the page.
      const guides = depth === 0 ? [] : [...ancestorGuides, !isLast];

      out.push({
        row: node.row,
        ghost: node.ghost,
        depth,
        guides,
        isLast,
        hasChildren: kids.length > 0,
        childCount: taskChildCount(node),
        isExpanded: expanded,
      });

      if (expanded && kids.length > 0) walk(kids, depth + 1, guides);
    });
  };

  walk(roots, 0, []);
  return out;
}
