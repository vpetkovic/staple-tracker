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
/**
 * R4a (STA-186). THE ORDER IS THE REGISTRY'S NOW — this module decides WHERE a row goes and
 * no longer decides what "before" means. `compareRows` used to be the one comparator and is
 * now one entry (`activity`) among eight, with the same steps in the same order, so the
 * default mode reproduces this file's previous output byte for byte. What this module still
 * owns is the ACTIVITY TIER, which is a fact about the tree — the rollup over descendants,
 * and the deliberate decision to turn it off under status grouping — and it hands that in as
 * `activityTier` rather than letting a `lib/` module reach into the tree to compute it.
 */
import {
  buildSortContext,
  compareBySort,
  DEFAULT_SORT,
  type SortPref,
} from "@/lib/sort-modes";
import type { GroupBy } from "@/lib/view-prefs";
/**
 * O8a (STA-149). The placement — who nests under whom, where a ghost goes, and what depth,
 * guides and the elbow come out as. Extracted so that pickup mode runs the SAME rule rather
 * than its own flatter one; see the header of `nesting.ts`.
 */
import { placeRows, rankedRow, sortPlaced, walkPlaced } from "./nesting";
import {
  buildPickupGroups,
  EMPTY_PICKUP_INDEX,
  type PickupGroup,
  type PickupIndex,
} from "./pickup-model";
import {
  configuredGroupOrder,
  configuredKindOrder,
  isResolvedStatus as isResolvedInWorkspace,
  kindLabel,
} from "@/lib/settings";
import {
  DEFAULT_ISSUE_KIND,
  ISSUE_KINDS,
  KIND_RANK,
  OPEN_STATUS_ORDER,
  RESOLVED_STATUSES,
  type Issue,
  type IssueRow,
  type IssueStatus,
  type StatusId,
} from "@/lib/types";

/**
 * The BUILT-IN group order: the open statuses in board order, then the resolved ones.
 *
 * DERIVED, NOT RETYPED. Two constants that both know the column order will drift, and the
 * board already learned that lesson once.
 *
 * ── IT IS NO LONGER A LIVE DEFAULT — O7b's wiring (STA-141) ───────────────────────────
 *
 * O7a made the status set DATA: statuses can be added, renamed and REORDERED per workspace.
 * A per-workspace order that changes at runtime cannot be a module constant evaluated once
 * at import, so every place that used to read this now calls `configuredGroupOrder()`, which
 * returns exactly this array for a default workspace (asserted in `lib/settings.test.ts`).
 *
 * The constant survives as the BUILT-IN reference — what the seed order is, what the tests
 * compare against, and what a reader needs to see to understand what the accessor returns
 * when nobody has touched the settings dialog. Deleting it would have turned a substitution
 * into a redesign.
 */
export const GROUP_ORDER: readonly IssueStatus[] = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES];

/**
 * THE ONE PLACE "hidden unless asked for" is decided — V4 (STA-89) rewires exactly here.
 *
 * V5 must not ship its own "show done" control and must not hardcode the exclusion at a
 * call site either, or turning the filter on becomes a hunt. `buildGroups` consults this
 * and nothing else does.
 *
 * O7b's wiring (STA-141): the answer now comes from the workspace's configured CATEGORY for
 * the status rather than from membership of the built-in `RESOLVED_STATUSES` pair. On a
 * default workspace those are the same two ids; on a workspace with a custom `shipped`
 * status in the `done` category they are not, and the old test would have left a shipped
 * ticket on the page after the filter said it had gone. The function stays here, and stays
 * the tree's single spelling of the question, so the substitution is one line rather than a
 * hunt through the call sites.
 */
export function isResolvedStatus(status: StatusId): boolean {
  return isResolvedInWorkspace(status);
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

/**
 * WHAT A HEADER NAMES, when the group is not a status — O3d (STA-129).
 *
 * The status axis needs none of this: a status IS its own label and `StatusIcon` draws it
 * from the key. Every other axis needs a name that the key alone cannot produce, and the
 * MODEL is where it is produced, because the model is the only thing holding the unfiltered
 * source the name has to be read out of.
 *
 * THIS WAS THE SEAM O1C (STA-130) USED, AND IT HELD. TreeGrid branches on the PRESENCE of a
 * heading, not on `groupBy`, so group-by-kind was a model-only change: one
 * `GROUP_BY_OPTIONS` entry, one `buildKindGroups`, one `buildList` case, and a heading per
 * bucket with `issue: null`, `label: kindLabel(id)`, `identifier: null`, `kind: id`,
 * `rollup: null`. No edit to TreeGrid's render path, GroupHeader, expansion.ts, the keyboard
 * sequence or `visibleOrder` — the one TreeGrid change was swapping O3d's placeholder glyph
 * for the shared one, which is a different ticket's debt being paid in passing.
 */
export interface GroupHeading {
  /**
   * The issue this group is named after, or `null` for a bucket that names no issue (the
   * "No epic" catch-all today; every kind bucket tomorrow).
   *
   * Read from the UNFILTERED source, so an epic the current filter removed still names and
   * heads the group holding its children.
   */
  issue: Issue | null;
  /** What the header reads — the epic's title, or "No epic". */
  label: string;
  /** Rendered before the label. `null` when there is no issue to identify. */
  identifier: string | null;
  /** What the kind glyph is drawn from. `null` when there is no issue. */
  kind: string | null;
  /**
   * O3b's rollup for `issue`, over the UNFILTERED source — `resolved/total` in the header's
   * trailing slot. `null` for a heading that names no issue, and for an issue with no
   * descendants, which cannot happen for an epic that heads a group but can for a kind.
   */
  rollup: ParentRollup | null;
}

export interface StatusGroup {
  /**
   * THE GROUP'S KEY — a status id, a pickup section id, or (since O3d) an issue id or
   * `NO_PARENT_GROUP_KEY`. Typed `GroupKey`, which is `string`.
   *
   * THE NAME IS A SURVIVAL, NOT A CLAIM. `key` is the honest name now that the value can be
   * an epic id, and the rename is one mechanical pass — except for one line in
   * `components/task-list/row-render.test.tsx`, a file O1b (STA-125) is editing on another
   * branch this sprint. A naming improvement is not worth a merge conflict inside somebody
   * else's ticket. O1c should do it when that file is free.
   */
  status: GroupKey;
  /** Rows to render — children of a collapsed parent are absent. */
  rows: TaskRow[];
  /**
   * How many tasks are in this group, collapsed or not. Deliberately NOT `rows.length`:
   * a count that follows what is rendered says zero for a collapsed group, which deletes
   * the only reason the count exists. Since O3c it is also not `rows.length` because
   * `rows` can contain ghosts — see `buildGroups`.
   */
  count: number;
  /**
   * O3d (STA-129). What the header names, for an axis whose key is not self-describing.
   * `null` on the status axis, where the key IS the name — and, since O8d, on the epic axis,
   * where the head is a ROW and there is nothing left for a header to say. See `headedByRow`.
   */
  heading?: GroupHeading | null;
  /**
   * IS THIS GROUP'S HEAD ITS FIRST ROW rather than a header above the rows — O8d (STA-152).
   *
   * True only on the epic axis. It means three things at once, and they are one decision:
   * the view draws no `GroupHeader`, the group takes no entry in the keyboard sequence, and
   * the group DOES NOT FOLD — the head row's own chevron is the fold, keyed by the issue id
   * like every other row's, which is what makes an epic collapsed in one view collapsed in
   * all of them.
   *
   * A group that folds by TWO controls over one set of rows is the defect STA-148 raises.
   * So `isGroupCollapsed` is not consulted for these groups at all, which also makes a
   * collapsed-groups entry written by an O3d build inert rather than a fold nobody can undo.
   *
   * Read through `sectionsOf`, not off the group, by everything that walks the shape —
   * `visibleRows` and TreeGrid's `nav` — because that accessor exists precisely so those
   * two cannot disagree about what is on the page.
   */
  headedByRow?: boolean;
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
   * THE SEAM IS NOW WIRED (STA-141's table, done in STA-129). Absent, it defaults to
   * `configuredGroupOrder()` — the live per-workspace order, which is byte-identical to
   * `GROUP_ORDER` on a default workspace. So no caller has to pass it and none does; the
   * field survives because a TEST must be able to hand this module an order without also
   * publishing settings into a module-level snapshot the next test would inherit.
   *
   * `readonly StatusId[]` rather than `readonly IssueStatus[]`: `IssueStatus` is still the
   * seven-member built-in union (see the debt note at the top of `lib/types.ts`) and a
   * configured order contains ids that union has never heard of. Widening here rather than
   * there is the same fix with a blast radius this ticket can be responsible for.
   */
  statusOrder?: readonly StatusId[];
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
  /**
   * WHICH ORDER, of the eight — R4a (STA-186). See `lib/sort-modes.ts` for the registry and
   * for the two rules `direction` does not touch.
   *
   * Optional and defaulted to `DEFAULT_SORT`, which is `activity` ascending: the tier, then
   * priority, then the newest update, then the numeric identifier — this file's own
   * comparator before the ticket, unchanged. So every existing caller, fixture and test that
   * says nothing gets exactly the list it got, and the criterion "the default reproduces
   * today's order" is a property of the default rather than of a code path.
   *
   * It applies inside every shape, not only the flat one. A reader who has asked for titles
   * alphabetically has asked about the rows, and the rows are the same rows whether or not
   * there are headers over them; a sort that silently stopped applying one menu entry away
   * would be the kind of inconsistency the Group control's own notes keep arguing against.
   */
  sort?: SortPref;
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
  statusOrder: readonly StatusId[] = configuredGroupOrder(),
): number {
  const own = ownActivityTier(row, statusOrder);
  const beneath = subtree.get(row.issue.id);
  return beneath === undefined ? own : Math.min(own, beneath);
}

function ownActivityTier(row: IssueRow, statusOrder: readonly StatusId[]): number {
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
  statusOrder: readonly StatusId[] = configuredGroupOrder(),
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
 * THE COMPARATOR ONE BUILD USES — R4a (STA-186), replacing this file's private `compareRows`.
 *
 * That function was the one sort key in the app: activity tier, then priority, then newest
 * update, then a numeric-aware identifier. It is now `SORT_MODES`'s `activity` entry, step
 * for step, and this is the four lines that reach it. The identifier tie-break survives
 * intact and for the reason it was written: the view refetches every 1.5s on the fingerprint
 * poll, and two rows that compare equal are free to swap on every rebuild — which reads as
 * the list twitching under the pointer. Every mode in the registry terminates in it.
 *
 * `rows` is the set the rollups are computed over — the VISIBLE set at every call site
 * below, per O3a: a parent must never be ranked by a descendant the current filter has taken
 * off the page. `tierOf` is this module's own activity tier, handed IN, which is what keeps
 * `buildGroups`'s deliberate `NO_ACTIVITY_TIER` a decision about status grouping rather than
 * a special case inside the registry.
 */
function rowComparator(
  rows: readonly IssueRow[],
  options: BuildOptions,
  statusOrder: readonly StatusId[],
  tierOf: (row: IssueRow) => number,
): (a: IssueRow, b: IssueRow) => number {
  const ctx = buildSortContext(rows, { statusOrder, activityTier: tierOf });
  return compareBySort(options.sort ?? DEFAULT_SORT, ctx);
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
  /**
   * R4a (STA-186). THE COMPARATOR, not the tier it used to be given.
   *
   * `flatten` never needed the tier itself — it needed an answer to "which of these two rows
   * comes first", and the tier was three quarters of the only answer there was. Taking the
   * comparator instead is what lets one bucket be ordered by title and another by queue
   * position without this function learning either word, and it is what keeps the ONE place
   * that knows the activity tier is off under status grouping at the call site that decides
   * it. Built once per LIST by `rowComparator` and shared by every bucket.
   */
  compare: (a: IssueRow, b: IssueRow) => number,
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

  /**
   * Two ways to lose your parent: it landed in another GROUP, or a FILTER removed it. The
   * first is on the page somewhere, the second is not — and neither is a reason to render
   * a child as though it were a root. A parent that is in NEITHER map is absent from the
   * data entirely, and earns silence: a chip or a ghost pointing at a ticket the reader
   * cannot reach is worse than nothing.
   */
  /*
   * O3d's THIRD case — "the group's own header IS the parent, so it is neither missing nor
   * worth naming twice" — was deleted by O8d (STA-152) along with the header it protected.
   * The epic is in its own bucket now, so a child of it finds a REAL parent here and no
   * ghost is made; and when the filter removed the epic, a ghost of it is exactly what the
   * group needs, because there is no header left to name it. See `buildParentGroups`.
   */
  const missingParentOf = (r: IssueRow): Issue | undefined =>
    r.issue.parentId
      ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
      : undefined;

  /**
   * THE PLACEMENT IS `nesting.ts`'s NOW — O8a (STA-149), and nothing about it changed here.
   *
   * A child nests under a parent in this bucket; a child whose parent can be NAMED but is
   * not in this bucket nests under a once-per-family GHOST of it; anything else is a root.
   * That was written out in this function and is now written out once, because pickup mode
   * had a second, flatter version of the same rule and the two had already diverged — see
   * the header of `nesting.ts`. Handing the ghost policy in as `missingParentOf` is what
   * keeps the three reasons for silence (absent from the data, named by the header, no
   * indent to draw in) at this call site, where they are facts about THIS axis.
   */
  /**
   * O8b (STA-150). THE NEXT ANCESTOR UP FROM A GHOST, which is a narrower question than
   * `missingParentOf` above and gets a narrower source.
   *
   * `presentAnywhere` only. `hiddenParents` is keyed by the CHILD's id and a ghost is not a
   * child on this page, so it could not answer; the unfiltered `rollupSource` could, and is
   * deliberately not asked, because a chain climbing into work the filter removed would be
   * undoing the filter — the same argument that keeps flat mode ghost-free. A chain
   * therefore shows the ancestry that is ON THE PAGE and stops, silently, where it is not.
   *
   * O8d (STA-152): `presentAnywhere` is now the caller's map to widen. `buildParentGroups`
   * adds the group's own epic to it when the filter removed that epic, which is what lets a
   * chain terminate on the thing the group is named after rather than trailing off. That is
   * a fact about THAT axis, so it is expressed there rather than as a rule here.
   */
  const ancestorOf = (issue: Issue): Issue | undefined =>
    issue.parentId ? presentAnywhere.get(issue.parentId) : undefined;

  const roots = placeRows(bucket, {
    ghostFor: ghostParents ? missingParentOf : undefined,
    ancestorFor: ghostParents ? ancestorOf : undefined,
  });

  /**
   * Siblings are ranked against siblings, at every depth — so an epic's live child rises
   * inside that epic exactly as the epic itself rises among the roots. `sortPlaced` goes
   * deepest-first, because `rankedRow` reads a ghost's best child and a ghost can only be
   * ranked once its own children are in order.
   *
   * A GHOST SORTS AS THE BEST ROW IT BRACKETS — O3c (STA-128), now `rankedRow`. Ranked by
   * the PARENT's own priority, a low-priority epic holding the group's most urgent task
   * would sink and take that task down with it: acquiring a context line would have
   * reordered real work, which nothing asked for and every reader would notice.
   */
  sortPlaced(roots, (a, b) => compare(rankedRow(a), rankedRow(b)));

  /**
   * A GHOST FOLDS LIKE ANY ROW — O8c (STA-151), replacing O3c's "a ghost is always open".
   *
   * O3c's argument was that a fold on a ghost would remove real rows from the group they
   * belong to, which §1 exists to prevent. STA-148 answers it: a group is a way of
   * DISPLAYING rows, so a fold hides rows from the display and says nothing about
   * membership — and `StatusGroup.count` is `bucket.length`, computed before any of this
   * runs, so no fold can reach it. §1 was never at risk.
   *
   * BUT THE DEFAULT IS NOT `defaultExpanded`, and this is the line that matters. Under
   * group-by-status that default is "my own status is active", and a backlog epic ghosted
   * into the In Progress group would be folded ON FIRST SIGHT — a dimmed row with nothing
   * under it and a header saying 2. The default belongs to the ISSUE's own row, in its own
   * group; a ghost is a bracket, and a bracket is open until somebody closes it.
   *
   * So: the user's EXPLICIT choice, shared with the real row because it is keyed by issue
   * id, and `true` when there is none. That is what makes "collapse an epic in the flat
   * view and it is collapsed in every view" a property of the key rather than of a sync.
   */
  const lines = walkPlaced(
    roots,
    (node) =>
      node.children.length > 0 &&
      (explicit(node.row.issue) ?? (node.ghost || defaultExpanded(node.row.issue))),
  );

  return lines.map((line) => {
    const r = line.row;
    /**
     * A GHOST WEARS NO CHIP, and since O8b (STA-150) that is the only thing this line still
     * says. It used to say more: O3c drew the nearest missing ancestor and stopped, so a
     * ghost had no ghost above it either, and this was where that was enforced.
     *
     * STA-148 lifted the cap. The whole missing chain is drawn now — see `ancestorOf` — and
     * a ghost's own context is the ghost above it, which is a better answer than a chip
     * could be. What survives is that a ghost never wears one: the chip names a parent the
     * reader cannot see, and by construction the ghost's parent is either drawn above it or
     * cannot be named at all.
     */
    const parent = line.ghost ? undefined : missingParentOf(r);

    return {
      issue: r.issue,
      claim: r.claim,
      workspace: r.workspace,
      pullRequests: r.pullRequests,
      // W4 (STA-116). Carried for the same reason `claim` is, and with the same
      // history behind the reminder: this pass once mapped `IssueRow[] -> Issue[]` and
      // threw away a reading the server had batched a query to produce.
      worklog: r.worklog,
      deps: r.deps,
      depth: line.depth,
      hasChildren: line.hasChildren,
      isExpanded: line.isExpanded,
      childCount: line.childCount,
      /*
       * O3b (STA-127). Beside `childCount` because they are the same kind of fact about
       * the same row, and NOT the same number: `childCount` is DIRECT children that
       * survived into this bucket — what `+N` declares it is hiding — while the rollup
       * counts every DESCENDANT in the unfiltered list, which is what "3 of 5 done"
       * means. A leaf gets `null` rather than a zeroed rollup, so the row renders nothing
       * rather than a bar claiming an epic has no children.
       */
      rollup: rollups.get(r.issue.id) ?? null,
      guides: line.guides,
      isLast: line.isLast,
      // A nested child is placed by lineage and the elbow already says so; only a row
      // that could NOT be nested needs to name the parent it belongs to.
      breadcrumb:
        line.depth === 0 && parent
          ? { identifier: parent.identifier, title: parent.title }
          : null,
      /*
       * O3c (STA-128). The one field every consumer of this list has to check: a ghost is
       * excluded from the group's count, from `visibleOrder` and from the keyboard
       * sequence, and it is drawn dimmed and non-interactive except for the click that
       * opens the parent. Written explicitly on every row rather than only on ghosts, so
       * `row.ghost` is never `undefined` inside the tree and a reader of one row does not
       * have to know which of two shapes produced it.
       */
      ghost: line.ghost,
    };
  });
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
  const { showResolved = false, ghostParents = true, statusOrder = configuredGroupOrder() } = options;

  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));
  /*
   * O3b (STA-127). From the UNFILTERED source, never from `visible` — see `rollupSource`.
   * Built once here and shared by every bucket below.
   */
  const rollups = parentRollups(options.rollupSource ?? rows);

  const buckets = new Map<StatusId, IssueRow[]>();
  for (const r of visible) {
    const bucket = buckets.get(r.issue.status);
    if (bucket) bucket.push(r);
    else buckets.set(r.issue.status, [r]);
  }

  /*
   * THE TIER IS OFF HERE, AND IT IS STILL OFF — see `NO_ACTIVITY_TIER` above. R4a moved the
   * comparison into the registry and left that decision exactly where it was: this axis
   * ranks every row 0 on the activity step, so the `activity` mode falls straight through to
   * priority, newest update and identifier, which is STA-126's grouped output unchanged. Any
   * OTHER mode the user picks reads its own key and is unaffected by the tier either way.
   */
  const byRow = rowComparator(visible, options, statusOrder, NO_ACTIVITY_TIER);

  const out: StatusGroup[] = [];

  /*
   * O7b's wiring (STA-141). `configuredGroupOrder()` rather than the `GROUP_ORDER`
   * constant — the workspace's live order, byte-identical to the constant until somebody
   * reorders a status in the settings dialog. Read at CALL time, not at import: it is
   * per-workspace data that changes while the page is open, and `App.tsx` re-renders the
   * tree when it does.
   */
  for (const status of statusOrder) {
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
        byRow,
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
      // The key IS the name on this axis, so there is nothing to carry. Written explicitly
      // rather than omitted, so a reader of one group does not have to know which builder
      // produced it — the same rule O3c applied to `ghost`.
      heading: null,
    });
  }

  return out;
}

/**
 * THE KEY OF THE BUCKET FOR ROWS THAT HAVE NO EPIC — O3d (STA-129).
 *
 * A double-underscored literal rather than a bare `none`, and rather than prefixing the
 * epic keys with `parent:`. Three vocabularies now share one collapsed-groups set in
 * expansion.ts (statuses, pickup sections, issue ids) and this literal cannot collide with
 * any of them, while leaving the EPIC keys unprefixed keeps `data-status="<issue id>"` on
 * the header addressable from a test and from the browser exactly as the other two axes
 * are. Prefix here first if a fourth axis ever makes that untrue.
 */
export const NO_PARENT_GROUP_KEY = "__no_epic__";

/** What that group's header reads. Named for what is ABSENT, because that is the fact. */
export const NO_PARENT_GROUP_LABEL = "No epic";

/**
 * EVERY ROW'S TOP-LEVEL ANCESTOR — `issue.id -> root id`, for rows that have one.
 *
 * Four lines over `forEachAncestor` rather than a second upward walk: that helper visits a
 * row's ancestors in order from the parent upwards and stops at the first id the input does
 * not contain, so the LAST id it hands us for a row is that row's root. Overwriting on each
 * visit is therefore the whole algorithm.
 *
 * ABSENT means "this row is itself a root", which is not the same as "this row has no
 * ancestor in the input" — pass the UNFILTERED list and the two coincide, which is exactly
 * why `buildParentGroups` does.
 */
export function topLevelAncestors(
  rows: readonly { issue: Pick<Issue, "id" | "parentId"> }[],
): Map<string, string> {
  const top = new Map<string, string>();
  forEachAncestor(rows, (row, ancestorId) => {
    top.set(row.issue.id, ancestorId);
  });
  return top;
}

/**
 * BUCKET BY TOP-LEVEL ANCESTOR — group-by-epic, O3d (STA-129), rewritten by O8d (STA-152).
 *
 * ── THE GROUP'S HEAD IS THE EPIC'S OWN ROW ────────────────────────────────────────────
 *
 * O3d PROMOTED the epic out of its bucket and drew it as a group header, to avoid putting
 * one issue on the page twice. It was right about the duplication and wrong about which of
 * the two to keep. The header it built had its own triangle, its own click-to-fold, its own
 * collapsed-groups key and its own label — four parallel implementations of things the
 * epic's ROW already has, drawn eight pixels above it and behaving differently from it in
 * every other view. STA-148: a group is a way of DISPLAYING rows, and the thing at the top
 * of an epic's group is the epic, behaving as it does everywhere else.
 *
 * So the head is filed back into its own bucket, `flatten` nests the bucket under it exactly
 * as it nests any parent under any parent, and every one of those four mechanisms is DELETED
 * rather than reconciled. There is nothing left that could disagree with the row.
 *
 * Still one issue in one place: the head is in its own group and in no other, and O3d's
 * completeness rule is untouched — A ROOT THAT HEADS NO GROUP IS AN ORDINARY ROW UNDER
 * "No epic". A parentless task with no children heads nothing; so does a parentless epic
 * whose every child the filter removed. Both land in the catch-all, which sorts last.
 *
 * ── AND WHEN THE FILTER TOOK THE EPIC, THE HEAD IS A GHOST ────────────────────────────
 *
 * A header is a LABEL and could name a row the filter removed without contradiction. A row
 * cannot: drawing a filtered-away issue as a full row is undoing the filter. So the head is
 * a GHOST there — the mechanism every other axis already uses for a parent the filter took,
 * and which, since STA-151, folds and opens exactly like the real row would. The two cases
 * therefore read and behave alike, and the group is never left headless.
 *
 * The ghost is reached by WIDENING `presentAnywhere` with this group's own epic, per group,
 * rather than by teaching `flatten` about heads. `missingParentOf` and `ancestorOf` then
 * both terminate on it with no new rule, and the widening is scoped to exactly the one issue
 * this group is named after — not to the whole unfiltered source, which is the line O8b drew
 * and this does not cross.
 *
 * ── THE ANCESTOR MAP IS BUILT FROM THE UNFILTERED SOURCE ──────────────────────────────
 *
 * The acceptance criterion is that a FILTERED-OUT epic still names the group holding its
 * children. Built from `visible`, a done epic hidden by the default filter would stop being
 * anybody's ancestor and its whole family would fall into "No epic" — the group-by axis
 * would then be silently rewritten by the status filter. So the map, and the issue the
 * header is drawn from, come from `options.rollupSource ?? rows`: the same array O3b
 * already threads through for the rollup counts, already in memory, no new fetch.
 *
 * This is deliberately NOT what O3a does with its activity tiers, and the two are not
 * inconsistent — see `rollupSource`. PLACEMENT and COUNTS must be stable under a filter;
 * ORDER must be accountable from what is in front of the reader.
 */
export function buildParentGroups(rows: IssueRow[], options: BuildOptions): StatusGroup[] {
  const { showResolved = false, ghostParents = true, statusOrder = configuredGroupOrder() } = options;

  const source = options.rollupSource ?? rows;
  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));
  const rollups = parentRollups(source);
  const topOf = topLevelAncestors(source);
  const sourceById = new Map(source.map((r) => [r.issue.id, r]));
  /**
   * O8d (STA-152). THE HEAD'S OWN ROW, IF THE FILTER KEPT IT — the thing that decides
   * whether this group's first row is the epic or a ghost of it. Read from `visible` rather
   * than from `source`, because `source` is unfiltered and a head taken from there would be
   * a filtered-away issue drawn as a full row.
   */
  const visibleById = new Map(visible.map((r) => [r.issue.id, r]));

  /**
   * WHICH IDS ARE HEADERS: an id is a header exactly when a VISIBLE row claims it as its
   * top-level ancestor. Computed before the buckets are filled, because a root's own
   * placement depends on it — a root that heads a group is promoted, one that heads
   * nothing is a row.
   */
  const headerIds = new Set<string>();
  for (const r of visible) {
    const top = topOf.get(r.issue.id);
    if (top !== undefined) headerIds.add(top);
  }

  const buckets = new Map<string, IssueRow[]>();
  const fileIn = (key: string, r: IssueRow) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  };

  for (const r of visible) {
    const top = topOf.get(r.issue.id);
    if (top !== undefined) {
      fileIn(top, r);
      continue;
    }
    // A root. It is either this group's header — in which case it is drawn as one, not as
    // a row — or it heads nothing and belongs to the catch-all.
    if (headerIds.has(r.issue.id)) continue;
    fileIn(NO_PARENT_GROUP_KEY, r);
  }

  /**
   * GROUPS ORDER BY THE EPIC'S `activityRank` — O3a (STA-126), through the LIST'S OWN
   * comparator rather than a bare rank comparison.
   *
   * The tier alone leaves ties, and a tie on a list the fingerprint poll rebuilds every
   * 1.5s is a list that swaps rows under the pointer. The active sort mode is the app's ONE
   * answer to "these two compare equal, now what" — every chain in `lib/sort-modes.ts` ends
   * in the numeric identifier — and reusing it is what keeps the group order and the row
   * order from drifting into two different notions of important.
   *
   * Tiers over `visible`, per O3a: an order the reader cannot account for from what is in
   * front of them is worse than a plain one. The epic's OWN row comes from the unfiltered
   * source, so a filtered-away epic holding a live agent still sorts to the top — its claim
   * is on the row in `source`, and it would have been invisible had we looked in `visible`.
   */
  const subtree = subtreeActivityTiers(visible, statusOrder);
  const tierOf = (row: IssueRow): number => activityRank(row, subtree, statusOrder);
  /*
   * R4a (STA-186). ONE comparator for the group order AND the row order, which is the point
   * the note above makes about `compareRows` and is now enforced by there being one call:
   * the epics are ranked by it and so is every row inside them, so the two cannot drift into
   * different notions of important — including when the reader has asked for titles.
   */
  const byRow = rowComparator(visible, options, statusOrder, tierOf);

  // Computed once for every bucket below, because it is one walk over the same rows.
  const holdsActiveWork = subtreesHoldingActiveWork(visible);

  const headers = [...headerIds]
    .filter((id) => (buckets.get(id)?.length ?? 0) > 0)
    .map((id) => ({ id, row: sourceById.get(id) }))
    .filter((entry): entry is { id: string; row: IssueRow } => entry.row !== undefined)
    .sort((a, b) => byRow(a.row, b.row));

  const out: StatusGroup[] = [];

  for (const { id, row } of headers) {
    const bucket = buckets.get(id)!;
    /**
     * O8d (STA-152). THE HEAD IS PREPENDED AT THE CALL, NOT FILED INTO THE BUCKET.
     *
     * `count` is `bucket.length` and must keep meaning "how much work is in this group", so
     * the number beside a group never counts the thing the group is named after. Prepending
     * here rather than in the bucketing loop is what makes that true by construction instead
     * of by a subtraction somebody has to remember.
     *
     * Absent when the filter removed the epic — see the ghost note in this function's header.
     */
    const head = visibleById.get(id);
    const known = head ? presentAnywhere : new Map(presentAnywhere).set(id, row.issue);
    out.push({
      status: id,
      rows: flatten(
        head ? [head, ...bucket] : bucket,
        known,
        options,
        /*
         * THE FLAT DEFAULT, NOT THE STATUS ONE, and this is the one place the two grouped
         * axes genuinely differ.
         *
         * Status grouping folds by the row's own status, which is only coherent because it
         * SPLITS a parent from a child of a different status — the child is still on screen,
         * as a root of its own group. Here the whole family is in ONE group, so folding a
         * backlog sub-epic by its own status would hide the in-progress children that have
         * nowhere else to appear. That is precisely the trap R1 fell into in flat mode and
         * had to climb back out of; the answer is the same answer.
         */
        (issue) => DEFAULT_EXPANDED_GROUPS.has(issue.status) || holdsActiveWork.has(issue.id),
        /*
         * AND THE TIER IS ON, unlike status grouping. `buildGroups` ranks every row 0
         * because STA-126's acceptance criterion pins grouped output unchanged except for
         * tie order. This axis is new and carries no such promise, and it is the axis where
         * the tier is most obviously right: inside one epic, the child somebody is holding
         * right now belongs at the top of the epic.
         */
        byRow,
        rollups,
        ghostParents,
      ),
      // `bucket.length`, per O3c: the real rows, counted before any ghost exists — and,
      // since O8d, before the head is prepended. Both exclusions for the same reason: the
      // number says how much WORK is here, and neither a bracket nor the group's own name
      // is work.
      count: bucket.length,
      /**
       * O8d (STA-152). NOTHING LEFT FOR A HEADING TO NAME.
       *
       * The head row carries the kind glyph, the identifier, the title, the rollup and the
       * claim, through the same `TaskRowLine` every other row uses. A heading would be a
       * second copy of all five, eight pixels away, free to drift — which is exactly the
       * complaint STA-148 makes about O3d's header.
       */
      heading: null,
      headedByRow: true,
    });
  }

  /**
   * THE CATCH-ALL IS LAST, UNCONDITIONALLY — not ranked, not sorted in.
   *
   * It is not an epic and has no activity rank of its own. Ranking it by its best member
   * would let "everything that belongs to nothing" outrank a real epic, which inverts the
   * one thing this axis exists to say: work belongs to something.
   */
  const orphans = buckets.get(NO_PARENT_GROUP_KEY);
  if (orphans && orphans.length > 0) {
    out.push({
      status: NO_PARENT_GROUP_KEY,
      rows: flatten(
        orphans,
        presentAnywhere,
        options,
        (issue) => DEFAULT_EXPANDED_GROUPS.has(issue.status) || holdsActiveWork.has(issue.id),
        byRow,
        rollups,
        ghostParents,
      ),
      count: orphans.length,
      heading: {
        issue: null,
        label: NO_PARENT_GROUP_LABEL,
        identifier: null,
        kind: null,
        rollup: null,
      },
    });
  }

  return out;
}

/**
 * THE KIND AN ISSUE COUNTS AS FOR BUCKETING — O1c (STA-130).
 *
 * `issues.kind` is NOT NULL with a default (O1a, STA-124), so an empty one should be
 * unreachable. It is normalised anyway, and NOT defensively: `IssueRow` can be built from a
 * payload an older server sent, which is a case lib/types.ts already spells out for the
 * graph node's optional `kind` and answers the same way. The consequence is what makes it
 * worth a line — an unbucketed row is not a row with a wrong header, it is a row that is
 * NOT ON THE PAGE, and a list that silently drops a ticket is the one failure this view
 * cannot have. `||` rather than `??`, so `""` and `undefined` land in the same place.
 *
 * The filter dimension in lib/filters.ts deliberately does NOT do this; see `matchKind`.
 */
function kindOf(issue: Pick<Issue, "kind">): string {
  return issue.kind || DEFAULT_ISSUE_KIND;
}

/**
 * BUCKET BY DECLARED KIND — group-by-kind, O1c (STA-130).
 *
 * The fourth axis, and structurally the simplest: the key is a field on the row, so unlike
 * `buildParentGroups` there is no ancestry to walk, no header to promote out of its own
 * bucket, and no catch-all — every row has a kind, which is exactly what O1a made true.
 *
 * ── THE ORDER IS THE WORKSPACE'S, WITH `KIND_RANK` AS THE FALLBACK ────────────────────
 *
 * `configuredKindOrder()` first, which on a default workspace is the seeded
 * `epic, task, bug, chore, spike` — the acceptance criterion verbatim — and after an
 * operator drags the settings list, theirs. This is the same substitution O7b made for the
 * status axis and it is made here for the same reason: the vocabulary is DATA, and a
 * module constant evaluated at import cannot follow a per-workspace order that changes
 * while the page is open.
 *
 * `KIND_RANK` therefore ranks only the LEFTOVERS — a kind on a row that the configured
 * order has not got, which happens for the second between another tab adding a kind and
 * /api/settings catching up. lib/types.ts says what to do with those and this does it:
 * `KIND_RANK[k] ?? ISSUE_KINDS.length`, so the built-in five keep their seed order among
 * themselves and anything genuinely unknown sorts last. The id breaks the remaining ties,
 * because a group order that is not total is a page that reshuffles on the 1.5s poll.
 *
 * Empty buckets are not drawn, per `buildGroups`: a "Spike 0" header on a workspace that
 * has never filed one is furniture, and furniture stops being read within a day.
 *
 * ── THE TWO KNOBS ARE ANSWERED LIKE `parent`, NOT LIKE `status` ───────────────────────
 *
 * Both turn on ONE question: if a fold hides a child, does that child have anywhere else
 * to appear? Status grouping is the only axis where the answer is yes — the child is a root
 * of its own status group — and that is the whole reason its rules are what they are.
 *
 *   1. THE FLAT EXPANSION DEFAULT. A task's task-children share its bucket and nest inside
 *      it, so folding a backlog parent by its own status would hide in-progress children
 *      that have nowhere else to be. That is the trap R1 fell into in flat mode and had to
 *      climb back out of, and `buildParentGroups` documents it one axis over. Same trap,
 *      same answer: `holdsActiveWork` re-opens anything with live work beneath it.
 *   2. THE ACTIVITY TIER IS ON. `buildGroups` ranks every row 0 only because STA-126
 *      promised grouped output unchanged; this axis is new and carries no such promise.
 *
 * ── GHOSTS STAY ON, AND THERE IS NO `headOfGroup` SUPPRESSION ─────────────────────────
 *
 * O3d had to suppress a ghost because the epic heading a group is absent from its own
 * bucket. Nothing is promoted here, so that case cannot arise, and passing an id to
 * suppress would be borrowing a fix for a problem this axis does not have. The ghosts this
 * axis DOES draw are the point of the feature working: an epic sits in the Epic group, so
 * its tasks are orphans in the Task group, and the dimmed bracket plus the breadcrumb is
 * what says where they came from. Without it "every bug on the board" is a flat list of
 * bugs with no indication of whose they are.
 *
 * ── ONE KNOWN COST, RECORDED WHERE THE NEXT AXIS WILL READ IT ─────────────────────────
 *
 * A FOURTH VOCABULARY NOW SHARES THE COLLAPSED-GROUPS SET in expansion.ts, and it is the
 * first one that can genuinely collide. Statuses, pickup sections and issue ids are
 * pairwise disjoint by construction; kind ids and status ids are BOTH operator-configurable
 * strings matching the same `VOCABULARY_ID_PATTERN`, so a workspace with a `bug` status and
 * a `bug` kind would fold one under the other. Not prefixed today — it changes nothing on
 * any workspace that exists, and unprefixed keys keep `data-status="epic"` on the header
 * addressable from a test and from the browser exactly as the other three axes are — but
 * `GroupKey`'s note says "prefix it at its own builder rather than discovering it here",
 * and THIS is the builder that will have to.
 */
export function buildKindGroups(rows: IssueRow[], options: BuildOptions): StatusGroup[] {
  const { showResolved = false, ghostParents = true, statusOrder = configuredGroupOrder() } = options;

  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));
  // O3b (STA-127). From the UNFILTERED source, never from `visible` — see `rollupSource`.
  const rollups = parentRollups(options.rollupSource ?? rows);

  const buckets = new Map<string, IssueRow[]>();
  for (const r of visible) {
    const key = kindOf(r.issue);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(r);
    else buckets.set(key, [r]);
  }

  const configured = configuredKindOrder();
  const configuredSet = new Set(configured);
  const leftovers = [...buckets.keys()]
    .filter((id) => !configuredSet.has(id))
    .sort(
      (a, b) =>
        (KIND_RANK[a] ?? ISSUE_KINDS.length) - (KIND_RANK[b] ?? ISSUE_KINDS.length) ||
        a.localeCompare(b),
    );

  const subtree = subtreeActivityTiers(visible, statusOrder);
  const byRow = rowComparator(visible, options, statusOrder, (row) =>
    activityRank(row, subtree, statusOrder),
  );
  // One walk over the same rows, shared by every bucket below.
  const holdsActiveWork = subtreesHoldingActiveWork(visible);

  const out: StatusGroup[] = [];

  for (const kind of [...configured, ...leftovers]) {
    const bucket = buckets.get(kind);
    if (!bucket || bucket.length === 0) continue;
    out.push({
      status: kind,
      rows: flatten(
        bucket,
        presentAnywhere,
        options,
        (issue) => DEFAULT_EXPANDED_GROUPS.has(issue.status) || holdsActiveWork.has(issue.id),
        byRow,
        rollups,
        ghostParents,
      ),
      // `bucket.length`, per O3c: the real rows, counted before any ghost exists.
      count: bucket.length,
      heading: {
        /*
         * NO ISSUE, so no identifier and no rollup — the shape O3d built for the "No epic"
         * catch-all, and for the same reason. This bucket names a VOCABULARY ENTRY rather
         * than a ticket; there is nothing to identify and nothing to roll up, and the
         * trailing slot correctly falls back to the plain count.
         */
        issue: null,
        // `kindLabel`, not the raw id: the workspace that renamed `spike` to
        // "Investigation" must be heard saying so, and O7b's accessor is the only thing
        // that knows. It title-cases an id it has never met, which is the right failure.
        label: kindLabel(kind),
        identifier: null,
        // What `KindGlyph` draws from in TreeGrid. The one field this axis fills that the
        // catch-all leaves null — a kind bucket always knows its own kind.
        kind,
        rollup: null,
      },
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
  const { showResolved = false, statusOrder = configuredGroupOrder() } = options;
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
    rowComparator(visible, options, statusOrder, (row) => activityRank(row, subtree, statusOrder)),
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
 * FOUR vocabularies now, and the disjointness is still load-bearing: no status is spelled
 * `up_next`, no section is spelled `in_progress`, and no issue id is spelled either — so one
 * collapsed-groups set in expansion.ts holds all of them without a prefix and without any
 * axis disturbing another's folds. If a future key ever collides, prefix it at its own
 * builder rather than discovering it here.
 *
 * THE FOURTH — kind ids, O1c (STA-130) — IS THE FIRST THAT CAN GENUINELY COLLIDE, and the
 * note above is now a live instruction rather than a precaution. The first three are
 * disjoint by construction; kind ids and status ids are both operator-configurable strings
 * matching one `VOCABULARY_ID_PATTERN`, so a workspace with a `bug` status AND a `bug` kind
 * folds one under the other. Left unprefixed deliberately — see `buildKindGroups`, which is
 * the builder that will have to do it.
 *
 * ── WHY IT IS `string` AND NO LONGER A UNION — O3d (STA-129) ──────────────────────────
 *
 * It was `IssueStatus | PickupSectionId` while both vocabularies were closed sets known at
 * compile time. Group-by-epic keys a group on an ISSUE ID, which is data, and O7a made the
 * status set data too. A union of two closed sets plus "any string" is `string` with extra
 * steps, and the union's remaining value — catching a typo'd literal — was already gone the
 * day a status id became a per-workspace row in a table.
 *
 * What replaces the compile-time check is a LABEL RESOLVER at the render site: TreeGrid
 * asks `statusLabel()` for a status key and reads `StatusGroup.heading` for anything else,
 * so a key it has never seen renders as a title-cased id rather than as `undefined`.
 */
export type GroupKey = string;

/**
 * THE SECTIONS OF WHATEVER SHAPE IS ON SCREEN, key and rows, in render order.
 *
 * The reason this exists rather than each caller switching on `kind`: TreeGrid's keyboard
 * sequence and `visibleOrder` below must never disagree about what is on the page, and the
 * file already learned that once (see `visibleRows`). One accessor means a third shape could
 * not be added to one of them and forgotten in the other — the compiler now refuses.
 */
export function sectionsOf(
  shape: ListShape,
): { key: GroupKey; rows: TaskRow[]; headedByRow: boolean }[] {
  switch (shape.kind) {
    case "flat":
      return [];
    case "grouped":
      /*
       * O8d (STA-152). `headedByRow` travels with the key and the rows because the three
       * are one fact — "this section has no header, so it has no group fold either" — and
       * the two walkers below and in TreeGrid must not each decide it. See `StatusGroup`.
       */
      return shape.groups.map((g) => ({
        key: g.status,
        rows: g.rows,
        headedByRow: g.headedByRow === true,
      }));
    case "pickup":
      return shape.groups.map((g) => ({ key: g.id, rows: g.rows, headedByRow: false }));
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
    /*
     * O3d (STA-129). The SAME `"grouped"` shape, deliberately — the fold, the keyboard
     * sequence, `visibleOrder`, the `inert` body and the animation are the same behaviour
     * on both axes, and a third `kind` in the union would have forced every one of those to
     * grow a branch that does the same thing. What differs is what a header NAMES, which is
     * carried on the group as `heading` rather than in the shape's type.
     */
    case "parent":
      return { kind: "grouped", groups: buildParentGroups(rows, options) };
    /*
     * O1c (STA-130). The same `"grouped"` shape again, and the third entry that takes it is
     * the evidence O3d's reasoning was right rather than a guess: the fold, the keyboard
     * sequence, `visibleOrder`, the `inert` body and the animation are identical on all
     * three, and what differs is only what a header NAMES — carried on the group as
     * `heading`, which is why this case is one line and TreeGrid needed no branch.
     */
    case "kind":
      return { kind: "grouped", groups: buildKindGroups(rows, options) };
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
          /*
           * O8a (STA-149). Pickup mode nests now, so it has chevrons, so the fold has to
           * reach it — and it is the SAME fold, not a parallel one: expansion is stored per
           * issue, and STA-148's principle is that a row keeps its state across groupings.
           * Only the EXPLICIT choice crosses; the default differs by shape and belongs to
           * the model building it, which is why `buildPickupGroups` supplies its own.
           */
          isExpanded: options.isExpanded,
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
    // O8d (STA-152). A section whose head is a ROW has no group fold, so a collapsed-groups
    // entry carrying its key — one an O3d build may well have written — must not hide rows
    // the head row's own chevron says are open.
    if (!section.headedByRow && isGroupCollapsed(section.key)) continue;
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
