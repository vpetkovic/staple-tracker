/**
 * WHERE A ROW GOES — the tree view's placement rule, and nothing else. V5 (STA-97).
 *
 * R4 (STA-102) took the row's SHAPE and GEOMETRY out of this file and into
 * `components/task-list/model.ts`, where the detail panel and the palette can reach them
 * without also inheriting the tree's bucketing rules. What is left here is the one thing
 * that is genuinely about the tree: which status group a task lands in, how a family
 * flattens inside it, and what the connector under it looks like — kept as pure functions
 * so the thing that is easy to get wrong is also the thing that is cheap to pin down.
 *
 * Nothing here renders, reads a clock, or touches storage.
 *
 * ── THE INVARIANT (row spec §1) ───────────────────────────────────────────────────────
 *
 *   > Every task in the "In Progress" group is in progress.
 *
 * A task is placed in the group of its OWN status. That sounds obvious and the obvious
 * implementation gets it wrong: the natural thing is to walk the parent tree and put each
 * family under its head, which drops an in-progress child into the Backlog group. Then the
 * header is a lie, the count counts something else, and — once done/cancelled are hidden by
 * default — a live child of a finished parent silently vanishes from the tracker.
 *
 * The cost is stated plainly in the spec and is worth restating here, because it is the
 * first thing a reader will want to "fix": in status-grouped mode YOU DO NOT SEE THE WHOLE
 * TREE IN ONE PLACE. A parent and child with different statuses appear in different groups.
 * That is the correct trade — status grouping is a triage view whose job is "what is
 * happening right now", not "how is this epic shaped". The graph view and the detail
 * drawer's children list own the whole-tree question properly.
 *
 * ── GHOSTS: ONE LEVEL OF THE TREE, BORROWED BACK — O3c (STA-128) ──────────────────────
 *
 * The child used to carry a breadcrumb CHIP instead of an indent, and three children of one
 * epic then read as three unrelated rows that happen to wear the same 11px token. So the
 * missing parent is now drawn ONCE inside the bucket as a dimmed GHOST with its children
 * nested under it.
 *
 * THAT DOES NOT WEAKEN THE INVARIANT ABOVE, and the distinction is the whole design. A
 * ghost is a BRACKET AROUND ROWS, not a row: it is not in the group's count, not in
 * `visibleOrder`, not in the keyboard sequence, cannot be selected, and cannot be folded.
 * Every task in the "In Progress" group is still in progress — the ghost is not a task in
 * the group, it is a caption on three of them. Exactly ONE level is borrowed (the nearest
 * missing ancestor); a chain would rebuild the whole tree inside a status group, which is
 * the thing this note has just finished saying grouped mode deliberately does not do.
 */
import {
  forEachAncestor,
  parentRollups,
  type ParentRollup,
  type TaskRow,
} from "@/components/task-list";
import { isStaleClaim } from "@/lib/claim";
import type { Selection } from "@/lib/session";
import type { GroupBy } from "@/lib/view-prefs";
import {
  buildPickupGroups,
  EMPTY_PICKUP_INDEX,
  type PickupGroup,
  type PickupIndex,
  type PickupSectionId,
} from "./pickup-model";
import {
  OPEN_STATUS_ORDER,
  RESOLVED_STATUSES,
  type Issue,
  type IssuePriority,
  type IssueRow,
  type IssueStatus,
} from "@/lib/types";

/**
 * Group order: the open statuses in board order, then the resolved ones.
 *
 * DERIVED, NOT RETYPED. Two constants that both know the column order will drift, and the
 * board already learned that lesson once.
 */
export const GROUP_ORDER: readonly IssueStatus[] = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES];

/**
 * THE ONE PLACE "hidden unless asked for" is decided — V4 (STA-89) rewires exactly here.
 *
 * V5 must not ship its own "show done" control and must not hardcode the exclusion at a
 * call site either, or turning the filter on becomes a hunt. `buildGroups` consults this
 * and nothing else does.
 */
export function isResolvedStatus(status: IssueStatus): boolean {
  return RESOLVED_STATUSES.includes(status);
}

/**
 * Groups whose parents start expanded. Active work is what you came to see; a fully
 * expanded backlog is a wall. This is a DEFAULT, not a rule — an explicit toggle on any
 * row overrides it and persists (see expansion.ts).
 */
export const DEFAULT_EXPANDED_GROUPS: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "in_progress",
  "in_review",
  "blocked",
]);

const PRIORITY_RANK: Record<IssuePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

export interface StatusGroup {
  status: IssueStatus;
  /** Rows to render — children of a collapsed parent are absent. */
  rows: TaskRow[];
  /**
   * How many tasks are in this group, collapsed or not. Deliberately NOT `rows.length`:
   * a count that follows what is rendered says zero for a collapsed group, which deletes
   * the only reason the count exists.
   */
  count: number;
}

export interface BuildOptions {
  /**
   * The user's EXPLICIT expand/collapse choice for a row, or `undefined` if they have not
   * made one — in which case this module supplies the default, which differs by mode. See
   * `defaultExpansion` below and the note in expansion.ts.
   */
  isExpanded: (issue: Issue) => boolean | undefined;
  /**
   * Whether resolved statuses may form groups. THE ONE PLACE the hide-resolved default is
   * applied inside V5 — and in the live app it is now handed `true`, because V4 (STA-89)
   * landed and `lib/filters.ts` decides this upstream. Gating twice would silently break
   * V4's second, subtler rule: selecting the "Done" status IS the opt-in, so a user who
   * filters for Done gets rows that a hardcoded exclusion here would throw away again, and
   * would be shown an empty list and told the filter is broken.
   */
  showResolved?: boolean;
  /**
   * `issue.id -> the parent that is NOT in `rows``, for breadcrumbs across a filter rather
   * than across a group. This is V4's `hiddenParents()` output, passed straight through.
   *
   * It matters because a done epic disappears under the default filter while its
   * in-progress children stay — correctly — and those children would otherwise be rendered
   * at depth 0 with no indication of where they came from.
   */
  hiddenParents?: ReadonlyMap<string, Issue>;
  /**
   * The workspace's configured status order — O3a (STA-126) / O7 (STA-139).
   *
   * O7a made the status set DATA: statuses can be added, renamed and REORDERED per
   * workspace, and the configured order is the canonical order everywhere. The UI still
   * carries a hand-kept mirror of the built-in order (`lib/types.ts`), and O7b is what
   * wires `/api/settings` through to here. This field is that seam, present ahead of it:
   * when the configured order arrives it is passed down and NOTHING in the sort changes.
   *
   * Optional and defaulted to `GROUP_ORDER`, so every existing caller compiles untouched
   * and the tree keeps ordering exactly as it does today until somebody reorders a status.
   */
  statusOrder?: readonly IssueStatus[];
  /**
   * THE UNFILTERED LIST, for the collapsed-parent rollup — O3b (STA-127).
   *
   * `rows` reaching this module has already been through `lib/filters.ts`, and `done` is
   * hidden by the default filter. A rollup computed from it would tell an epic with three
   * finished children and two open ones that it is `0/2` — which is not a partial answer,
   * it is the wrong one, and it is precisely the arithmetic the reader opened the tracker
   * to avoid doing. So the count comes from the whole `/api/issues` payload, which
   * `views/TreeView.tsx` already holds and which is unpaged (server.ts:427-446).
   *
   * NO NEW FETCH. This is a reference to an array that is already in memory.
   *
   * Deliberately the OPPOSITE of what O3a's sort does with its activity tiers, which are
   * computed over the VISIBLE rows on purpose. They answer different questions: an ORDER
   * the reader cannot account for from what is in front of them is worse than a plain one,
   * whereas a COUNT that only counts what is in front of them is not a count at all.
   *
   * Optional, and DEFAULTED TO `rows` — so every existing caller, fixture and test compiles
   * and behaves exactly as before, and a surface that has no wider list still gets a rollup
   * over what it does have.
   */
  rollupSource?: readonly IssueRow[];
  /**
   * MAY A MISSING PARENT BE DRAWN INSIDE THIS BUCKET — O3c (STA-128).
   *
   * A child whose parent landed in another group, or was removed by a filter, used to
   * render at depth 0 wearing a breadcrumb chip. Three children of one epic then read as
   * three unrelated rows that happen to carry the same 11px token. With this on, the
   * parent is drawn ONCE inside the bucket as a dimmed GHOST and its children nest under
   * it, so the epic's unit of work reads as a unit.
   *
   * It is a switch rather than a constant because a ghost needs an INDENT to be legible,
   * and two surfaces have none:
   *
   *   FLAT MODE, always. `flattenFlat` passes `false` at the call site and does not read
   *   this field, because the ungrouped view must stay pixel-identical to today — there,
   *   lineage already nests and the only orphan is one a filter made, which keeps its chip.
   *
   *   NARROW CONTAINERS. `TreeGrid` passes `columns.disclosure`, the EXISTING switch that
   *   means "this container has an indent to nest into". The `panel` and `popup` presets
   *   turn it off; a ghost there would be a dimmed row at depth 0 indistinguishable from a
   *   real one, so the breadcrumb chip stays and this path is not taken at all.
   *
   * Defaulted to `true` for the grouped shapes, which is where the ticket lives.
   */
  ghostParents?: boolean;
}

/**
 * ACTIVITY TIER — O3a (STA-126). Lower is more active. Reserved for the live claim; the
 * configured statuses are offset past it.
 */
export const LIVE_CLAIM_TIER = 0;

/**
 * The best tier among a row's STRICT descendants, by issue id. Absent means "nothing
 * beneath this row", which is not the same as "beneath this row is idle" — see
 * `activityRank`, which folds absence into the row's own tier rather than into a floor.
 */
export type SubtreeTiers = ReadonlyMap<string, number>;

const NO_SUBTREE_TIERS: SubtreeTiers = new Map();

/**
 * HOW ACTIVE IS THIS ROW — the one rank O3a (STA-126) adds ahead of priority.
 *
 * Two rungs, and deliberately only two:
 *
 * 1. A LIVE CLAIM is tier 0 and beats everything. Somebody is inside this ticket right
 *    now, and no amount of priority on an untouched ticket is more urgent than that.
 *    Liveness is `lib/claim.ts`'s `isStaleClaim` and NOTHING ELSE. That file is the single
 *    judgement the whole app makes about `idleSeconds`, and a second threshold spelled
 *    here would let the badge and the sort disagree about the same claim. A STALE claim is
 *    pointedly NOT a tier: an agent that died four hours ago must not hold the top of the
 *    list, so it falls through to its status like any unheld row.
 *
 * 2. Otherwise, POSITION IN THE CONFIGURED STATUS ORDER, offset by one so tier 0 stays the
 *    claim's. Today that order is `GROUP_ORDER` — in_progress, in_review, blocked, todo,
 *    backlog, then the resolved statuses — which is the tier list STA-126 spells out and
 *    also O7a's documented board rank under the built-in seed. It is a PARAMETER rather
 *    than a constant because O7 (STA-139) makes it per-workspace data: reordering statuses
 *    must reorder the tree with no code change here.
 *
 * A status the order does not mention ranks last but still ranks — an unranked row would
 * make the comparator return `NaN` and a `NaN` comparator is not merely wrong, it is not
 * self-consistent, which is how a list starts changing shape on every poll.
 *
 * `subtree` is what makes a PARENT rank by its best descendant: an epic holding a live
 * child outranks an idle high-priority epic, and because the rollup is computed over the
 * whole ancestor chain a GRANDCHILD counts exactly as much as a child. Defaulted to empty
 * so the function is meaningful on one row with no tree around it.
 */
export function activityRank(
  row: IssueRow,
  subtree: SubtreeTiers = NO_SUBTREE_TIERS,
  statusOrder: readonly IssueStatus[] = GROUP_ORDER,
): number {
  const own = ownActivityTier(row, statusOrder);
  const beneath = subtree.get(row.issue.id);
  return beneath === undefined ? own : Math.min(own, beneath);
}

function ownActivityTier(row: IssueRow, statusOrder: readonly IssueStatus[]): number {
  if (row.claim && !isStaleClaim(row.claim)) return LIVE_CLAIM_TIER;
  const index = statusOrder.indexOf(row.issue.status);
  return index === -1 ? statusOrder.length + 1 : index + 1;
}

/**
 * THE BEST TIER BENEATH EACH ROW, in one pass over the ancestor chains.
 *
 * Computed UPWARDS rather than downwards, and that is the whole trick: every row walks to
 * its own ancestors and lowers each one's recorded tier, so a grandchild reaches its
 * grandparent on the same pass that reaches its parent. A downward recursion would need a
 * child index, a depth bound, and a decision about what to do with a cycle; this needs
 * none of them.
 *
 * Strict descendants only — the row's own tier is folded in by `activityRank`, so this map
 * answers exactly one question and callers cannot half-apply it.
 */
export function subtreeActivityTiers(
  rows: readonly IssueRow[],
  statusOrder: readonly IssueStatus[] = GROUP_ORDER,
): Map<string, number> {
  const best = new Map<string, number>();
  forEachAncestor(rows, (row, ancestorId) => {
    const tier = ownActivityTier(row, statusOrder);
    const carried = best.get(ancestorId);
    if (carried === undefined || tier < carried) best.set(ancestorId, tier);
  });
  return best;
}

/**
 * Sort key within a bucket: activity tier, then priority, then newest update, then
 * identifier.
 *
 * `IssueRow`-typed since O3a (STA-126), and it had to be: `claim` is a SIBLING of `issue`
 * on the row, so an `Issue` alone literally cannot see whether anybody is holding it.
 *
 * The identifier tiebreak is not cosmetic. The view refetches every 1.5s on the fingerprint
 * poll, and two rows that compare equal are free to swap on every rebuild — which reads as
 * the list twitching under the pointer. Numeric-aware so STA-9 precedes STA-10.
 */
function compareRows(a: IssueRow, b: IssueRow, tierOf: (row: IssueRow) => number): number {
  const byActivity = tierOf(a) - tierOf(b);
  if (byActivity !== 0) return byActivity;
  const byPriority = PRIORITY_RANK[a.issue.priority] - PRIORITY_RANK[b.issue.priority];
  if (byPriority !== 0) return byPriority;
  if (a.issue.updatedAt !== b.issue.updatedAt) return a.issue.updatedAt < b.issue.updatedAt ? 1 : -1;
  return a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true });
}

/**
 * THE TIER, TURNED OFF — what `buildGroups` sorts with, and why that is not a hedge.
 *
 * STA-126 is explicit that under group-by-status the tier is a no-op and priority still
 * decides, and its acceptance criterion is that grouped output is unchanged EXCEPT for tie
 * order inside a group. It is tempting to argue the tier is naturally inert in a status
 * bucket because every row in it shares a status. It is not: a live claim would lift a
 * low-priority held row above a critical one, and the descendant rollup would lift a parent
 * by a child that grouped mode filed in a DIFFERENT group. Both are real reorderings, not
 * tie breaks, and both would break the criterion. So the grouped path ranks every row 0 and
 * means it.
 */
const NO_ACTIVITY_TIER = (): number => 0;

/** O3b (STA-127). What `flatten` sees when nobody asked for a rollup. */
const EMPTY_ROLLUPS: ReadonlyMap<string, ParentRollup> = new Map();

/**
 * Flatten one bucket of rows into rendered lines, depth-first.
 *
 * Shared by `buildGroups` (one call per status bucket) and by `flattenFlat` (one call over
 * the whole page, for R1's ungrouped default). Extracting it is what makes "flat mode is
 * the same list without the bucketing step" true in the code and not only in the ticket.
 */
/**
 * Which parents are expanded when the user has not said — and why it is not one rule.
 *
 * GROUPED: the row's own status. Coherent, because §11.3 places a parent and the children
 * nested under it in the same group, so "active work is open, the backlog is folded" applies
 * to both ends of every parent/child edge that is actually drawn.
 *
 * FLAT: that rule HIDES WORK, and this is the trap R1 walked into and had to climb back out
 * of. A backlog epic holding in-progress children is folded by its own status — and in flat
 * mode its children have nowhere else to appear, where in grouped mode they were still on
 * screen as roots of the In Progress group wearing a breadcrumb. Making flat the default
 * would therefore have made active work *less* visible, which is the opposite of the point.
 * So the flat default is "this row, or anything beneath it, is active".
 *
 * Found by looking at the evidence screenshots, not by a failing unit test: the seeded
 * in-progress child of a backlog parent simply was not on the page.
 */
function subtreesHoldingActiveWork(rows: readonly IssueRow[]): Set<string> {
  const holders = new Set<string>();
  forEachAncestor(rows, (row, ancestorId) => {
    if (DEFAULT_EXPANDED_GROUPS.has(row.issue.status)) holders.add(ancestorId);
  });
  return holders;
}

/**
 * THE SUBTREE WALK — now `components/task-list/model.ts`'s, and imported at the top of this
 * file rather than written here.
 *
 * O3a (STA-126) extracted it precisely so the expansion default above and
 * `subtreeActivityTiers` could not drift; O3b (STA-127) added a THIRD caller — the parent
 * rollup — which is pure, is wanted by surfaces that are not the tree, and therefore cannot
 * live in a module about the tree's bucketing rules. Moving the walk to the pure module and
 * importing it back keeps O3a's promise instead of making the copy it warned about. Nothing
 * about the traversal, the `seen` cycle guard, or either caller's behaviour changed.
 */

function flatten(
  bucket: IssueRow[],
  presentAnywhere: Map<string, Issue>,
  options: BuildOptions,
  defaultExpanded: (issue: Issue) => boolean,
  tierOf: (row: IssueRow) => number = NO_ACTIVITY_TIER,
  /**
   * O3b (STA-127). Built ONCE per list from the unfiltered source and handed down, rather
   * than recomputed per bucket: `buildGroups` calls this up to seven times and every one of
   * those calls would otherwise walk the same ancestor chains again to produce the same map.
   */
  rollups: ReadonlyMap<string, ParentRollup> = EMPTY_ROLLUPS,
  /**
   * O3c (STA-128). See `BuildOptions.ghostParents`. Defaulted OFF here rather than on,
   * because the one call site that must never grow ghosts — `flattenFlat` — is also the
   * one that would acquire them silently if a later edit forgot the argument.
   */
  ghostParents = false,
): TaskRow[] {
  const { isExpanded: explicit, hiddenParents } = options;
  const isExpanded = (issue: Issue): boolean => explicit(issue) ?? defaultExpanded(issue);

  const inGroup = new Map(bucket.map((r) => [r.issue.id, r]));
  const children = new Map<string, IssueRow[]>();
  const roots: IssueRow[] = [];
  /**
   * O3c (STA-128). The synthesised parents, by id — MEMBERSHIP HERE IS WHAT MAKES A ROW A
   * GHOST, and it is the only thing `walk` below has to learn.
   *
   * A ghost is injected as an ordinary root with its orphans filed under it in `children`,
   * so depth, guides, the elbow, `isLast` and the recursive nesting of the orphans' OWN
   * children all fall out of the existing traversal. Teaching `walk` a second shape would
   * have been a second placement rule, and two placement rules is how the ghost path and
   * the real path start drawing different trees.
   */
  const ghosts = new Map<string, IssueRow>();

  /**
   * Two ways to lose your parent: it landed in another GROUP, or a FILTER removed it. The
   * first is on the page somewhere, the second is not — and neither is a reason to render
   * a child as though it were a root. A parent that is in NEITHER map is absent from the
   * data entirely, and earns silence: a chip or a ghost pointing at a ticket the reader
   * cannot reach is worse than nothing.
   */
  const missingParentOf = (r: IssueRow): Issue | undefined =>
    r.issue.parentId
      ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
      : undefined;

  const fileUnder = (parentId: string, r: IssueRow) => {
    const filed = children.get(parentId);
    if (filed) filed.push(r);
    else children.set(parentId, [r]);
  };

  for (const r of bucket) {
    const parentId = r.issue.parentId;
    // Nesting happens where parent and child are both in this bucket…
    if (parentId && inGroup.has(parentId)) {
      fileUnder(parentId, r);
      continue;
    }
    // …and, since O3c, where the parent can be NAMED even though it is not in the bucket.
    // ONE ghost per family: the second orphan finds the first one's and nests beside it.
    const missing = ghostParents && parentId ? missingParentOf(r) : undefined;
    if (missing && parentId) {
      if (!ghosts.has(parentId)) {
        /**
         * WHAT A GHOST CARRIES: the parent's issue, and nothing about the parent's own
         * liveness. `hiddenParents` yields an `Issue` and nothing more, so a ghost built
         * from a filtered-away parent could never show a claim; letting the cross-group
         * ghost show one would mean two ghosts of identical shape reporting different
         * KINDS of fact about the same relationship. `RowClaimSlot` on the parent's real
         * row — in its own group, or behind the filter — stays the single place the row's
         * own claim is written down.
         *
         * The WORKSPACE is the child's. `parentId` is intra-workspace by construction, so
         * that is not an approximation, and it is what makes click-to-open work with no
         * new plumbing.
         */
        const ghost: IssueRow = { issue: missing, claim: null, workspace: r.workspace };
        ghosts.set(parentId, ghost);
        roots.push(ghost);
      }
      fileUnder(parentId, r);
      continue;
    }
    roots.push(r);
  }

  // Siblings are ranked against siblings, at every depth — so an epic's live child rises
  // inside that epic exactly as the epic itself rises among the roots. Children FIRST,
  // because a ghost's rank is read off the head of its sorted child list below.
  const byRow = (a: IssueRow, b: IssueRow) => compareRows(a, b, tierOf);
  for (const list of children.values()) list.sort(byRow);

  /**
   * A GHOST SORTS AS THE BEST ROW IT BRACKETS — O3c (STA-128).
   *
   * It is not a row and must not be ranked as one. Ranked by the PARENT's own priority, a
   * low-priority epic holding the group's most urgent task would sink and take that task
   * down with it: acquiring a context line would have reordered real work, which nothing
   * asked for and every reader would notice. Ranked by its best child, the block lands
   * exactly where that child would have landed and the epic's other children move up to
   * join it — minimum disturbance, same comparator, no second ordering rule to drift.
   */
  const rankedAs = (r: IssueRow): IssueRow =>
    ghosts.has(r.issue.id) ? (children.get(r.issue.id)?.[0] ?? r) : r;
  roots.sort((a, b) => byRow(rankedAs(a), rankedAs(b)));

  const rendered: TaskRow[] = [];

  const walk = (list: IssueRow[], depth: number, ancestorGuides: boolean[]): void => {
    list.forEach((r, index) => {
      const isGhost = ghosts.has(r.issue.id);
      const kids = children.get(r.issue.id) ?? [];
      const isLast = index === list.length - 1;
      // A ghost is ALWAYS open. A fold on it would remove real rows from the group they
      // belong to, which is the one thing tree-model.ts's §1 invariant exists to prevent.
      const expanded = isGhost || (kids.length > 0 && isExpanded(r.issue));
      /**
       * NEAREST MISSING ANCESTOR ONLY, and this line is where that rule is enforced.
       *
       * A ghost gets no chip of its own and no ghost above it. The direct parent IS the
       * nearest missing ancestor, so one level is the whole answer: it buys "these three
       * rows are the same epic" for 20px of indent, where a chain would rebuild the entire
       * tree inside a status group — precisely the thing this file's header says grouped
       * mode deliberately does not do. It also caps rendered depth growth at exactly +1.
       */
      const parent = isGhost ? undefined : missingParentOf(r);

      rendered.push({
        issue: r.issue,
        claim: r.claim,
        workspace: r.workspace,
        pullRequests: r.pullRequests,
        // W4 (STA-116). Carried for the same reason `claim` is, and with the same
        // history behind the reminder: this pass once mapped `IssueRow[] -> Issue[]` and
        // threw away a reading the server had batched a query to produce.
        worklog: r.worklog,
        deps: r.deps,
        depth,
        hasChildren: kids.length > 0,
        isExpanded: expanded,
        childCount: kids.length,
        /*
         * O3b (STA-127). Beside `childCount` because they are the same kind of fact about
         * the same row, and NOT the same number: `childCount` is DIRECT children that
         * survived into this bucket — what `+N` declares it is hiding — while the rollup
         * counts every DESCENDANT in the unfiltered list, which is what "3 of 5 done"
         * means. A leaf gets `null` rather than a zeroed rollup, so the row renders nothing
         * rather than a bar claiming an epic has no children.
         */
        rollup: rollups.get(r.issue.id) ?? null,
        guides: depth === 0 ? [] : [...ancestorGuides, !isLast],
        isLast,
        // A nested child is placed by lineage and the elbow already says so; only a row
        // that could NOT be nested needs to name the parent it belongs to.
        breadcrumb:
          depth === 0 && parent ? { identifier: parent.identifier, title: parent.title } : null,
        /*
         * O3c (STA-128). The one field every consumer of this list has to check: a ghost is
         * excluded from the group's count, from `visibleOrder` and from the keyboard
         * sequence, and it is drawn dimmed and non-interactive except for the click that
         * opens the parent. Written explicitly on every row rather than only on ghosts, so
         * `row.ghost` is never `undefined` inside the tree and a reader of one row does not
         * have to know which of two shapes produced it.
         */
        ghost: isGhost,
      });

      if (expanded) {
        walk(kids, depth + 1, depth === 0 ? [] : [...ancestorGuides, !isLast]);
      }
    });
  };

  walk(roots, 0, []);
  return rendered;
}

/**
 * Bucket by own status, nest only within a bucket, emit rows depth-first.
 *
 * The two-pass shape matters: `presentAnywhere` is built from the WHOLE input, not from the
 * bucket, so "my parent is in another group" and "my parent does not exist" stay different
 * answers. The first earns a breadcrumb; the second earns silence, because a chip pointing
 * at a ticket the reader cannot see is worse than no chip.
 */
export function buildGroups(rows: IssueRow[], options: BuildOptions): StatusGroup[] {
  const { showResolved = false, ghostParents = true } = options;

  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));
  /*
   * O3b (STA-127). From the UNFILTERED source, never from `visible` — see `rollupSource`.
   * Built once here and shared by every bucket below.
   */
  const rollups = parentRollups(options.rollupSource ?? rows);

  const buckets = new Map<IssueStatus, IssueRow[]>();
  for (const r of visible) {
    const bucket = buckets.get(r.issue.status);
    if (bucket) bucket.push(r);
    else buckets.set(r.issue.status, [r]);
  }

  const out: StatusGroup[] = [];

  for (const status of GROUP_ORDER) {
    const bucket = buckets.get(status);
    // Empty groups do not render. A "Blocked 0" header is permanent furniture announcing
    // a non-event, and furniture stops being read within a day.
    if (!bucket || bucket.length === 0) continue;
    out.push({
      status,
      // Grouped: the row's own status, which is also the group it is rendered in.
      rows: flatten(
        bucket,
        presentAnywhere,
        options,
        (issue) => DEFAULT_EXPANDED_GROUPS.has(issue.status),
        NO_ACTIVITY_TIER,
        rollups,
        ghostParents,
      ),
      /*
       * THE REAL ROWS, COUNTED BEFORE ANY GHOST EXISTS — O3c (STA-128).
       *
       * `bucket` is what the placement rule put in this group; the ghost is a bracket drawn
       * around some of them. So ghosts cannot reach this number by construction, which is
       * stronger than subtracting them afterwards would have been — and it is why the
       * tempting "simplification" to `rows.length` is now wrong in two separate ways rather
       * than one (a collapsed parent's children, and the ghosts).
       */
      count: bucket.length,
    });
  }

  return out;
}

/**
 * The SAME list with the bucketing step skipped — R1 (STA-100)'s default view.
 *
 * One bucket, so a parent and child of different statuses nest normally and no breadcrumb
 * is needed for a parent that is right there on the screen above. Sorting is unchanged:
 * priority, then recency, then identifier. Which means flat mode is not "grouped mode minus
 * headers" — it is a genuinely different reading of the same data, and it is the one that
 * answers "what does this project look like" rather than "what is happening right now".
 */
export function flattenFlat(rows: IssueRow[], options: BuildOptions): TaskRow[] {
  const { showResolved = false, statusOrder = GROUP_ORDER } = options;
  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));
  const holders = subtreesHoldingActiveWork(visible);

  /**
   * O3a (STA-126). The rollup is computed over the VISIBLE rows — the same set that is
   * about to be sorted — so a parent is never ranked by a descendant the current filter
   * has taken off the page. Ranking by an invisible row would be an order the reader
   * cannot account for from what is in front of them, which is worse than a plain one.
   */
  const subtree = subtreeActivityTiers(visible, statusOrder);

  return flatten(
    visible,
    presentAnywhere,
    options,
    // Flat: this row, or anything beneath it, is active. Anything else stays folded, so the
    // backlog is still not a wall.
    (issue) => DEFAULT_EXPANDED_GROUPS.has(issue.status) || holders.has(issue.id),
    (row) => activityRank(row, subtree, statusOrder),
    // O3b (STA-127). The unfiltered source, NOT `visible` — the one line where the rollup
    // and the tier above deliberately disagree about which set they read.
    parentRollups(options.rollupSource ?? rows),
    /*
     * NO GHOSTS IN FLAT MODE — O3c (STA-128), and it is a hard `false` rather than a read
     * of `options.ghostParents` on purpose.
     *
     * The acceptance criterion is that the ungrouped view is pixel-identical to today, and
     * the reason is not caution: flat mode has ONE bucket, so lineage already nests and the
     * only orphan left is one a filter made. Drawing that filtered-away parent back in
     * would undo the filter in the one view whose whole reading is "what does this project
     * actually look like right now". It keeps its breadcrumb chip, exactly as before.
     */
    false,
  );
}


/**
 * The list, in whichever of its two shapes is currently on screen — R1 (STA-100).
 *
 * A tagged union rather than "groups, or null, plus rows, or null", so a caller cannot
 * half-use one shape while rendering the other, and so the two functions below can be
 * exhaustive over it instead of defensive.
 */
export type ListShape =
  | { kind: "flat"; rows: TaskRow[] }
  | { kind: "grouped"; groups: StatusGroup[] }
  /** V5 (STA-111). Sections by pickup readiness; built in pickup-model.ts. */
  | { kind: "pickup"; groups: PickupGroup[] };

/**
 * A group's KEY — what the fold is remembered under and what the keyboard addresses it by.
 *
 * Two disjoint vocabularies in one union, and the disjointness is load-bearing: no status is
 * spelled `up_next` and no section is spelled `in_progress`, so one collapsed-groups set in
 * expansion.ts holds both without a prefix and without either mode disturbing the other's
 * folds. If a future section ever collides with a status name, prefix it there rather than
 * discovering it here.
 */
export type GroupKey = IssueStatus | PickupSectionId;

/**
 * THE SECTIONS OF WHATEVER SHAPE IS ON SCREEN, key and rows, in render order.
 *
 * The reason this exists rather than each caller switching on `kind`: TreeGrid's keyboard
 * sequence and `visibleOrder` below must never disagree about what is on the page, and the
 * file already learned that once (see `visibleRows`). One accessor means a third shape could
 * not be added to one of them and forgotten in the other — the compiler now refuses.
 */
export function sectionsOf(shape: ListShape): { key: GroupKey; rows: TaskRow[] }[] {
  switch (shape.kind) {
    case "flat":
      return [];
    case "grouped":
      return shape.groups.map((g) => ({ key: g.status, rows: g.rows }));
    case "pickup":
      return shape.groups.map((g) => ({ key: g.id, rows: g.rows }));
  }
}

/**
 * `buildList` needs the inbox to build the pickup shape and cannot fetch it — this module is
 * pure. So the index is passed in, and its ABSENCE is a legitimate state: `EMPTY_PICKUP_INDEX`
 * places every row by the race fallback, which is what the view renders for the instant
 * before `/api/inbox` answers.
 */
export function buildList(
  rows: IssueRow[],
  groupBy: GroupBy,
  options: BuildOptions,
  pickup: PickupIndex = EMPTY_PICKUP_INDEX,
): ListShape {
  switch (groupBy) {
    case "status":
      return { kind: "grouped", groups: buildGroups(rows, options) };
    case "pickup":
      return {
        kind: "pickup",
        groups: buildPickupGroups(rows, pickup, {
          showResolved: options.showResolved,
          hiddenParents: options.hiddenParents,
          // O3c (STA-128). The ghost rule is the SAME rule on both grouped axes, so it is
          // the same switch — a reader who has learned it under status grouping must not
          // find a different answer one menu entry away.
          ghostParents: options.ghostParents,
        }),
      };
    default:
      return { kind: "flat", rows: flattenFlat(rows, options) };
  }
}

/**
 * The rows the user can actually SEE, in the order they see them.
 *
 * This is the single derivation behind two things that must never disagree: the keyboard
 * sequence in TreeGrid, and `session.visibleOrder`, which R6 (STA-106) pages through with the
 * detail view's prev/next arrows. If they were computed separately, the arrows would
 * eventually land somewhere the keyboard says is not there — and it would be an off-by-one
 * that only appears once a group is collapsed.
 *
 * A collapsed group's rows are excluded. They are still in the DOM so the fold can animate,
 * and they are `inert`, and they are not visible — "next" landing on a row you cannot see is
 * exactly the bug the arrows exist to avoid. Rows under a COLLAPSED PARENT are excluded for
 * the same reason, and for free: `buildGroups`/`flattenFlat` never emitted them.
 *
 * GHOSTS ARE EXCLUDED TOO — O3c (STA-128). A ghost is a bracket around rows, not a row: it
 * is a parent that is not in this group, drawn here for context, and it already has a real
 * position of its own somewhere else on the page (or behind the filter). Paging onto it
 * would open a ticket the arrows had no business visiting from here, and it would make the
 * same ticket appear twice in one traversal. Applied in BOTH branches of the union rather
 * than only the grouped one: flat mode never emits a ghost today, and the day something
 * changes that, this is the line that must not have been an assumption.
 */
export function visibleRows(
  shape: ListShape,
  isGroupCollapsed: (key: GroupKey) => boolean,
): TaskRow[] {
  if (shape.kind === "flat") return shape.rows.filter(isNotGhost);
  const out: TaskRow[] = [];
  for (const section of sectionsOf(shape)) {
    if (isGroupCollapsed(section.key)) continue;
    for (const row of section.rows) if (isNotGhost(row)) out.push(row);
  }
  return out;
}

/** O3c (STA-128). One predicate, so "is this navigable" has exactly one spelling. */
function isNotGhost(row: TaskRow): boolean {
  return row.ghost !== true;
}

/** `visibleRows` as the navigation contract published on the session. */
export function visibleOrder(
  shape: ListShape,
  isGroupCollapsed: (key: GroupKey) => boolean,
): Selection[] {
  return visibleRows(shape, isGroupCollapsed).map((row) => ({
    workspace: row.workspace,
    ref: row.issue.identifier,
  }));
}
