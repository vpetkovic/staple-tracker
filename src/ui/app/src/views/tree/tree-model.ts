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
 * TREE IN ONE PLACE. A parent and child with different statuses appear in different groups
 * and the child carries a breadcrumb chip instead of an indent. That is the correct trade —
 * status grouping is a triage view whose job is "what is happening right now", not "how is
 * this epic shaped". The graph view and the detail drawer's children list own the whole-tree
 * question properly.
 */
import type { TaskRow } from "@/components/task-list";
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
 * THE SUBTREE WALK, ONCE — every row paired with each of its ancestors, upwards.
 *
 * Extracted by O3a (STA-126) and not duplicated: the expansion default above and the
 * activity rollup in `subtreeActivityTiers` ask different questions of the same traversal,
 * and two hand-written copies of "walk up the parent chain" is exactly the kind of pair
 * that drifts once and is then wrong in only one view.
 *
 * `seen` guards against a cycle the store should never produce and which would otherwise
 * hang the render rather than draw a wrong row.
 */
function forEachAncestor(
  rows: readonly IssueRow[],
  visit: (row: IssueRow, ancestorId: string) => void,
): void {
  const parentOf = new Map(rows.map((r) => [r.issue.id, r.issue.parentId]));

  for (const r of rows) {
    const seen = new Set<string>();
    let parentId = parentOf.get(r.issue.id) ?? null;
    while (parentId && parentOf.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      visit(r, parentId);
      parentId = parentOf.get(parentId) ?? null;
    }
  }
}

function flatten(
  bucket: IssueRow[],
  presentAnywhere: Map<string, Issue>,
  options: BuildOptions,
  defaultExpanded: (issue: Issue) => boolean,
  tierOf: (row: IssueRow) => number = NO_ACTIVITY_TIER,
): TaskRow[] {
  const { isExpanded: explicit, hiddenParents } = options;
  const isExpanded = (issue: Issue): boolean => explicit(issue) ?? defaultExpanded(issue);

  const inGroup = new Map(bucket.map((r) => [r.issue.id, r]));
  const children = new Map<string, IssueRow[]>();
  const roots: IssueRow[] = [];

  for (const r of bucket) {
    const parentId = r.issue.parentId;
    // Nesting happens ONLY where parent and child are both in this bucket.
    if (parentId && inGroup.has(parentId)) {
      const bucketed = children.get(parentId);
      if (bucketed) bucketed.push(r);
      else children.set(parentId, [r]);
    } else {
      roots.push(r);
    }
  }

  // Siblings are ranked against siblings, at every depth — so an epic's live child rises
  // inside that epic exactly as the epic itself rises among the roots.
  const byRow = (a: IssueRow, b: IssueRow) => compareRows(a, b, tierOf);
  roots.sort(byRow);
  for (const list of children.values()) list.sort(byRow);

  const rendered: TaskRow[] = [];

  const walk = (list: IssueRow[], depth: number, ancestorGuides: boolean[]): void => {
    list.forEach((r, index) => {
      const kids = children.get(r.issue.id) ?? [];
      const isLast = index === list.length - 1;
      const expanded = kids.length > 0 && isExpanded(r.issue);
      // Two ways to lose your parent, both worth a chip: it landed in another GROUP, or
      // it was removed by a FILTER. The first is on the page somewhere, the second is not
      // — and neither is a reason to render a child as though it were a root.
      const parent = r.issue.parentId
        ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
        : undefined;

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
        guides: depth === 0 ? [] : [...ancestorGuides, !isLast],
        isLast,
        // A nested child is placed by lineage and the elbow already says so; only a row
        // that could NOT be nested needs to name the parent it belongs to.
        breadcrumb:
          depth === 0 && parent ? { identifier: parent.identifier, title: parent.title } : null,
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
  const { showResolved = false } = options;

  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));

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
      rows: flatten(bucket, presentAnywhere, options, (issue) =>
        DEFAULT_EXPANDED_GROUPS.has(issue.status),
      ),
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
 */
export function visibleRows(
  shape: ListShape,
  isGroupCollapsed: (key: GroupKey) => boolean,
): TaskRow[] {
  if (shape.kind === "flat") return shape.rows;
  const out: TaskRow[] = [];
  for (const section of sectionsOf(shape)) {
    if (isGroupCollapsed(section.key)) continue;
    out.push(...section.rows);
  }
  return out;
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
