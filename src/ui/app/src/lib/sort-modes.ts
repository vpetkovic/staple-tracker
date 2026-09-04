/**
 * WHAT ORDER THE LIST IS IN — one registry, R4a (STA-186).
 *
 * ── WHY THIS IS NOT A `switch` IN tree-model.ts ───────────────────────────────────────
 *
 * Before this file there was one comparator, `compareRows`, private to the tree, and it was
 * the right shape for a list with one order. The moment the order becomes a CHOICE, three
 * things have to agree about it: the comparator, the menu that names it, and the docs that
 * promise a tie-break chain. A switch inside the model can only be the first of those, so
 * the menu would retype the names and `docs/web-ui.md` would retype the chains, and the day
 * a mode's tie-break changes, two of the three would keep saying the old thing.
 *
 * So a mode is DATA: an id, both of its direction labels, the chain written out as the list
 * of steps it actually runs, and the rollup it does or does not take. `SortByMenu` renders
 * the registry, the docs table is a transcription of it, and `sort-modes.test.ts` asserts
 * the transcription is honest — every documented step is a real step, in that order.
 *
 * ── THE TWO RULES DIRECTION DOES NOT TOUCH ────────────────────────────────────────────
 *
 * 1. DIRECTION FLIPS THE PRIMARY KEY AND NOTHING ELSE. The tie-break chain runs forwards in
 *    both directions. Reversing the whole comparator is the obvious implementation and it is
 *    wrong twice: two rows that tie would swap places for no reason the reader can name, and
 *    "sort descending, then ascending again" would not be the identity — which on a list the
 *    fingerprint poll rebuilds every 1.5s is how rows start moving under the pointer.
 * 2. UNDER `queue`, UNQUEUED ROWS SORT AFTER QUEUED ONES IN BOTH DIRECTIONS. "Descending" on
 *    a queue means "the back of the plan first", not "the things that are not in the plan
 *    first"; a null is not a large position, it is the absence of one.
 *
 * Between them those two rules are what make every mode TOTAL: every chain terminates in the
 * numeric identifier, which is unique, so no two distinct rows ever compare equal and the
 * order is fully determined by the data. That is the property the poll depends on.
 *
 * ── PRESENTATION ONLY. THIS FILE CANNOT REACH THE QUEUE ───────────────────────────────
 *
 * `docs/queue.md` is explicit that presentation sort is not the queue: plan position is a
 * thing the list may DISPLAY and order by, and never a thing it may set. Nothing here
 * writes: the module exports pure comparators over `readonly` rows, it reads
 * `queuePosition`/`planPosition` off the row payload and reads nothing else about the queue,
 * and `sort-modes.test.ts` sorts a fixture through every mode and asserts the queue,
 * eligibility and dependency fields on every row come out identical. Choosing a sort is a
 * statement about the reader's screen, not about what an agent picks up next.
 */
import type { IssuePriority, IssueRow, StatusId } from "./types";

export type SortModeId =
  | "activity"
  | "queue"
  | "status"
  | "priority"
  | "updated"
  | "created"
  | "identifier"
  | "title";

export type SortDirection = "asc" | "desc";

/** What is persisted, and what the trigger names. */
export interface SortPref {
  mode: SortModeId;
  direction: SortDirection;
}

/**
 * TODAY'S ORDER, NAMED. `activity` ascending is `compareRows` as it was before this ticket —
 * live claim first, then the configured status order, then priority, then the newest update,
 * then the identifier — so a workspace that never opens this menu sees the list it had.
 */
export const DEFAULT_SORT: SortPref = { mode: "activity", direction: "asc" };

/**
 * The comparison steps, each named for what it reads. Every step is written in ASCENDING
 * terms — "a before b" returns negative — except the two that are ties rather than primaries
 * (`updatedRecent`), where the direction is part of the step's meaning and is fixed.
 */
export type SortStepId =
  | "queuedFirst"
  | "activity"
  | "queue"
  | "status"
  | "priority"
  | "updated"
  | "updatedRecent"
  | "created"
  | "title"
  | "identifier";

/**
 * WHAT A COMPARATOR IS ALLOWED TO KNOW — and the reason this is an argument rather than an
 * import.
 *
 * Two of the three rollups the modes need are already computed by the tree
 * (`subtreeActivityTiers`), and one of the two callers deliberately turns the activity tier
 * OFF (`buildGroups` ranks every row 0, per STA-126). A registry that computed the tier for
 * itself could not honour either fact, and a registry that imported `tree-model.ts` would
 * close an import cycle with the module that imports it. So the tier arrives as a function
 * and the other two rollups are built here, over the rows the caller is about to sort.
 */
export interface SortContext {
  /** The row's activity tier, rollup already applied. Lower is more active. */
  activityTier: (row: IssueRow) => number;
  /** The row's effective queue position, rollup already applied; null when unqueued. */
  queuePosition: (row: IssueRow) => number | null;
  /** The row's effective `updatedAt`, rollup already applied. ISO-8601, so string order is time order. */
  updatedAt: (row: IssueRow) => string;
  /** Position in the workspace's configured status order; unknown ids rank last. */
  statusRank: (row: IssueRow) => number;
}

const PRIORITY_RANK: Record<IssuePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * THE ROW'S OWN PLAN POSITION, before any rollup — R2c's payload, read and never written.
 *
 * `queuePosition` before `planPosition` because they answer different questions and R4c
 * (STA-188) spells out which is which: `queuePosition` is the EFFECTIVE position an
 * actionable row holds in the pickup queue, `planPosition` is the plan position a container
 * carries. A row that has both is an actionable row whose container position is a coarser
 * answer to the same question, so the effective one wins. Absent and null are the same
 * answer — "not in the plan" — because the field is optional on the type precisely so that
 * fixtures and synthesised rows need not have an opinion.
 */
export function ownQueuePosition(row: IssueRow): number | null {
  return row.queuePosition ?? row.planPosition ?? null;
}

/**
 * THE EARLIEST POSITION ANYWHERE IN A ROW'S SUBTREE, by issue id — the `queue` mode's rollup.
 *
 * An epic is rarely queued itself; its tasks are. Ranked by its own (absent) position it
 * would sink to the bottom with everything else that is unqueued, taking the queue's next
 * three items down with it — which is the one thing a queue-ordered list must not do. So a
 * parent inherits the earliest position beneath it and stops being unqueued.
 *
 * Computed upwards, exactly as `subtreeActivityTiers` is, so a grandchild reaches its
 * grandparent on the same pass that reaches its parent — and, like that function, this
 * answers about STRICT descendants only. The row's own position is folded in by
 * `effectiveQueuePosition`, so no caller can half-apply it.
 */
export function subtreeQueuePositions(rows: readonly IssueRow[]): Map<string, number> {
  const best = new Map<string, number>();
  forEachAncestorId(rows, (row, ancestorId) => {
    const position = ownQueuePosition(row);
    if (position === null) return;
    const carried = best.get(ancestorId);
    if (carried === undefined || position < carried) best.set(ancestorId, position);
  });
  return best;
}

/**
 * THE LATEST UPDATE ANYWHERE IN A ROW'S SUBTREE — the `updated` mode's rollup, and the one
 * the ticket names.
 *
 * "Sort by most recently updated" asked about an epic means "when did anything happen in
 * here", not "when was this row's own title last edited". An epic whose child moved a minute
 * ago is the freshest thing on the page and its own `updatedAt` is a month old; ranked by
 * that it would sit under work nobody has touched since. Strict descendants, folded in by
 * `effectiveUpdatedAt`, for the same reason as above.
 */
export function subtreeUpdatedAt(rows: readonly IssueRow[]): Map<string, string> {
  const latest = new Map<string, string>();
  forEachAncestorId(rows, (row, ancestorId) => {
    const carried = latest.get(ancestorId);
    if (carried === undefined || row.issue.updatedAt > carried) {
      latest.set(ancestorId, row.issue.updatedAt);
    }
  });
  return latest;
}

/**
 * The upward walk, in the shape this module needs it.
 *
 * `components/task-list/model.ts` exports `forEachAncestor` and this is the same traversal
 * with the same cycle guard. It is written out here rather than imported because that module
 * is the tree's row geometry — a `lib/` module that pure-imports a `components/` one to get
 * a four-line loop is a dependency edge pointing the wrong way, and this loop is the only
 * thing this file would use it for.
 */
function forEachAncestorId(
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

/** The row's own position, or the earliest one beneath it. Null when neither exists. */
export function effectiveQueuePosition(
  row: IssueRow,
  subtree: ReadonlyMap<string, number>,
): number | null {
  const own = ownQueuePosition(row);
  const beneath = subtree.get(row.issue.id);
  if (own === null) return beneath ?? null;
  return beneath === undefined ? own : Math.min(own, beneath);
}

/** The row's own `updatedAt`, or the latest one beneath it. */
export function effectiveUpdatedAt(row: IssueRow, subtree: ReadonlyMap<string, string>): string {
  const beneath = subtree.get(row.issue.id);
  return beneath !== undefined && beneath > row.issue.updatedAt ? beneath : row.issue.updatedAt;
}

/**
 * NUMERIC ON THE NUMBER PART, NEVER LEXICAL — the tie-break every chain ends in.
 *
 * `STA-9` before `STA-10`, which a string comparison gets backwards and gets backwards
 * silently: the list still renders, it is just in an order that stops making sense at ten
 * tickets and stays wrong forever. The pre-R4a code reached for
 * `localeCompare(undefined, { numeric: true })`, which is correct for these identifiers and
 * is also a HOST-LOCALE-dependent answer for anything else; an ordering that could differ
 * between two machines looking at the same workspace is not an ordering a test can pin.
 *
 * So the shape is split explicitly: prefix compared by code unit, number compared as a
 * number. Anything that does not match `PREFIX-DIGITS` falls back to a plain code-unit
 * comparison, which is total, locale-free and only ever reached by data that has no number
 * to be numeric about.
 */
export function compareIdentifiers(a: string, b: string): number {
  if (a === b) return 0;
  const left = splitIdentifier(a);
  const right = splitIdentifier(b);
  if (left && right) {
    if (left.prefix !== right.prefix) return left.prefix < right.prefix ? -1 : 1;
    if (left.number !== right.number) return left.number - right.number;
  }
  return a < b ? -1 : 1;
}

function splitIdentifier(id: string): { prefix: string; number: number } | null {
  const dash = id.lastIndexOf("-");
  if (dash <= 0 || dash === id.length - 1) return null;
  const tail = id.slice(dash + 1);
  if (!/^\d+$/.test(tail)) return null;
  return { prefix: id.slice(0, dash), number: Number(tail) };
}

type Step = (a: IssueRow, b: IssueRow, ctx: SortContext) => number;

/**
 * Every step, ascending, by id. Written once so a chain is a list of names rather than a list
 * of closures, which is what lets the registry publish its own tie-break chain and lets the
 * test walk it.
 */
const STEPS: Record<SortStepId, Step> = {
  /**
   * QUEUED BEFORE UNQUEUED — rule 2 in this file's header, and the reason it is a step of its
   * own rather than a branch inside `queue` below.
   *
   * `direction` is applied to the PRIMARY, so anything the partition folded into the primary
   * would flip with it and "back of the queue first" would answer with the rows that are not
   * in the queue at all. As a separate step that runs BEFORE the primary and is never signed,
   * the partition holds in both directions and the direction reorders the queued rows among
   * themselves, which is what "descending" can honestly mean here.
   */
  queuedFirst: (a, b, ctx) => {
    const left = ctx.queuePosition(a) === null ? 1 : 0;
    const right = ctx.queuePosition(b) === null ? 1 : 0;
    return left - right;
  },
  activity: (a, b, ctx) => ctx.activityTier(a) - ctx.activityTier(b),
  /** Only ever reached with the partition already settled, so a null on both sides is a tie. */
  queue: (a, b, ctx) => (ctx.queuePosition(a) ?? 0) - (ctx.queuePosition(b) ?? 0),
  status: (a, b, ctx) => ctx.statusRank(a) - ctx.statusRank(b),
  priority: (a, b) => PRIORITY_RANK[a.issue.priority] - PRIORITY_RANK[b.issue.priority],
  /** The ROLLED-UP time — the `updated` mode's primary, and the only step that takes it. */
  updated: (a, b, ctx) => compareStrings(ctx.updatedAt(a), ctx.updatedAt(b)),
  /**
   * Newest first, on the row's OWN `updatedAt` — deliberately not `ctx.updatedAt`.
   *
   * The rollup belongs to the MODE that asks for it, not to the field. This step is the
   * third link of `activity`'s chain and it is `compareRows`'s third link unchanged, which is
   * what makes the default mode reproduce today's list byte for byte; reading the rollup here
   * would silently re-rank every parent whose child moved more recently than it did, in a
   * mode nobody asked to change. A tie-break also has a fixed direction — it is not the key
   * `direction` flips — so the negation is part of its meaning rather than a caller's choice.
   */
  updatedRecent: (a, b) => -compareStrings(a.issue.updatedAt, b.issue.updatedAt),
  created: (a, b) => compareStrings(a.issue.createdAt, b.issue.createdAt),
  /**
   * Locale-aware, and this is the one comparison where that is the correct answer rather than
   * a hazard: a title is prose in the reader's language, and "Ärende" belongs beside "Arende"
   * for the person reading it, not after "Zebra" where its code point puts it. Ties fall
   * through to the identifier below, so the locale can never make the order non-total.
   */
  title: (a, b) => a.issue.title.localeCompare(b.issue.title, undefined, { sensitivity: "base" }),
  identifier: (a, b) => compareIdentifiers(a.issue.identifier, b.issue.identifier),
};

/** ISO-8601 sorts as text; this is only here so a missing value cannot produce `NaN`. */
function compareStrings(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface SortMode {
  id: SortModeId;
  /** The noun the trigger shows: "Sort: Updated". */
  label: string;
  /** What the mode is FOR, in the menu, in `GROUP_BY_OPTIONS`'s register. */
  hint: string;
  /**
   * A step that runs BEFORE the primary and is never signed by `direction` — one mode has one
   * (`queue`, which keeps unqueued rows last in both directions) and the rest do not.
   */
  partition?: SortStepId;
  /** The key `direction` flips, and the only one it flips. */
  primary: SortStepId;
  /**
   * The steps that run after the primary, in order, ALWAYS forwards. Terminates in
   * `identifier` for every mode — including `identifier` itself, whose primary IS it and
   * whose chain is therefore empty because a unique key leaves nothing to break.
   */
  tieBreak: readonly SortStepId[];
  /** Which reading each direction is. "asc"/"desc" says nothing about a composite rank. */
  directions: Record<SortDirection, string>;
  /** The direction the mode opens in — the one a reader asking for it means. */
  defaultDirection: SortDirection;
  /**
   * What a PARENT is ranked by, when that is not its own field — the descendant rollup, named
   * for the reader of the docs table. `null` means the mode reads the row and nothing else,
   * which is true of five of the eight and is the fact worth stating.
   */
  rollup: string | null;
}

/**
 * THE MODES, in menu order.
 *
 * Order is menu order and a NEW MODE APPENDS, for the reason `GROUP_BY_OPTIONS` gives next
 * door: inserting moves every entry below the insertion point, and a menu that reshuffles
 * under the pointer costs more than kinship in the list is worth. `activity` is first because
 * it is the default; the rest are grouped by what they read — the plan, the workflow fields,
 * the clocks, then the labels.
 */
const ACTIVITY: SortMode = {
  id: "activity",
  label: "Activity",
  hint: "what is happening now — a live claim first, then the configured status order",
  primary: "activity",
  tieBreak: ["priority", "updatedRecent", "identifier"],
  directions: { asc: "Most active first", desc: "Least active first" },
  defaultDirection: "asc",
  rollup: "a parent takes the best activity tier in its subtree",
};

/** The one the default preference names, and the one an unknown id falls back to. */
const DEFAULT_MODE: SortMode = ACTIVITY;

export const SORT_MODES: readonly SortMode[] = [
  ACTIVITY,
  {
    id: "queue",
    label: "Queue position",
    hint: "the pickup plan's order — display only, and it never moves the queue itself",
    partition: "queuedFirst",
    primary: "queue",
    tieBreak: ["activity", "priority", "updatedRecent", "identifier"],
    directions: { asc: "Front of the queue first", desc: "Back of the queue first" },
    defaultDirection: "asc",
    rollup: "a parent takes the earliest queue position in its subtree; unqueued rows sort last in both directions",
  },
  {
    id: "status",
    label: "Status",
    hint: "the workspace's own status order, as configured in Work Workspace Settings",
    primary: "status",
    tieBreak: ["priority", "updatedRecent", "identifier"],
    directions: { asc: "First status first", desc: "Last status first" },
    defaultDirection: "asc",
    rollup: null,
  },
  {
    id: "priority",
    label: "Priority",
    hint: "critical through low, with activity deciding inside a band",
    primary: "priority",
    tieBreak: ["activity", "updatedRecent", "identifier"],
    directions: { asc: "Critical first", desc: "Low first" },
    defaultDirection: "asc",
    rollup: null,
  },
  {
    id: "updated",
    label: "Updated",
    hint: "when anything last moved, counting the whole subtree",
    primary: "updated",
    tieBreak: ["priority", "identifier"],
    directions: { asc: "Oldest first", desc: "Newest first" },
    defaultDirection: "desc",
    rollup: "a parent takes the latest update in its subtree",
  },
  {
    id: "created",
    label: "Created",
    hint: "when the ticket was filed — its own date, never a child's",
    primary: "created",
    tieBreak: ["priority", "identifier"],
    directions: { asc: "Oldest first", desc: "Newest first" },
    defaultDirection: "desc",
    rollup: null,
  },
  {
    id: "identifier",
    label: "Identifier",
    hint: "numerically, so STA-9 comes before STA-10",
    primary: "identifier",
    tieBreak: [],
    directions: { asc: "STA-1 first", desc: "STA-1 last" },
    defaultDirection: "asc",
    rollup: null,
  },
  {
    id: "title",
    label: "Title",
    hint: "alphabetically, in your language's own order",
    primary: "title",
    tieBreak: ["identifier"],
    directions: { asc: "A to Z", desc: "Z to A" },
    defaultDirection: "asc",
    rollup: null,
  },
];

/**
 * The mode, or the default when a stored id has outlived the build that wrote it. Repair
 * rather than reject, the rule `decodeViewPrefs` follows next door: a preference nobody
 * recognises costs the reader that one preference, not a list that refuses to render.
 */
export function sortMode(id: SortModeId): SortMode {
  return SORT_MODES.find((mode) => mode.id === id) ?? DEFAULT_MODE;
}

export function isSortModeId(value: unknown): value is SortModeId {
  return typeof value === "string" && SORT_MODES.some((mode) => mode.id === value);
}

export function isSortDirection(value: unknown): value is SortDirection {
  return value === "asc" || value === "desc";
}

/**
 * The whole state in one line, for the trigger: "Activity · Most active first".
 *
 * The direction is HALF the state and the ticket's first acceptance criterion is that both
 * halves are readable without opening the menu. An arrow glyph alone would be the usual
 * answer and it cannot say "most active first" — which is exactly the reading a composite
 * rank needs spelled out.
 */
export function sortLabel(pref: SortPref): string {
  const mode = sortMode(pref.mode);
  return `${mode.label} · ${mode.directions[pref.direction]}`;
}

/**
 * The chain a mode actually runs, in the order it runs — partition (if any), primary, then
 * the tie-breaks. What the docs table transcribes, and what the test walks to prove the
 * transcription is honest.
 */
export function sortChain(id: SortModeId): readonly SortStepId[] {
  const mode = sortMode(id);
  return [...(mode.partition ? [mode.partition] : []), mode.primary, ...mode.tieBreak];
}

/** The default preference for a mode the user has just picked from the menu. */
export function withSortMode(id: SortModeId): SortPref {
  return { mode: id, direction: sortMode(id).defaultDirection };
}

/**
 * THE ROLLUPS, BUILT ONCE PER LIST. Two upward walks over the rows about to be sorted, not
 * one per comparison — the comparator runs O(n log n) times and each of these is O(n).
 *
 * Over the rows the caller HANDS IN, which for every tree call site is the visible set. That
 * is O3a's rule and it holds here for the same reason: an order the reader cannot account for
 * from what is in front of them is worse than a plain one, so a parent is never lifted by a
 * descendant the current filter has taken off the page.
 */
export function buildSortContext(
  rows: readonly IssueRow[],
  options: {
    /** The workspace's configured status order. */
    statusOrder: readonly StatusId[];
    /**
     * The activity tier, INCLUDING whatever rollup the caller applies. Optional because the
     * modes that are not `activity` still list it as a tie-break, and a caller with no notion
     * of activity (a fixture, a flat surface) should get a coherent order rather than an
     * error. Flat zero then makes the step inert, which is exactly what `buildGroups` wants.
     */
    activityTier?: (row: IssueRow) => number;
  },
): SortContext {
  const { statusOrder, activityTier = () => 0 } = options;
  const queueSubtree = subtreeQueuePositions(rows);
  const updatedSubtree = subtreeUpdatedAt(rows);
  const statusIndex = new Map(statusOrder.map((id, index) => [id, index]));
  return {
    activityTier,
    queuePosition: (row) => effectiveQueuePosition(row, queueSubtree),
    updatedAt: (row) => effectiveUpdatedAt(row, updatedSubtree),
    /**
     * A status the configured order has never heard of ranks LAST but still ranks. An
     * unranked row would make the comparator return `NaN`, and a `NaN` comparator is not
     * merely wrong, it is not self-consistent — which is how a list starts changing shape on
     * every poll. Same argument, same answer as `ownActivityTier` in tree-model.ts.
     */
    statusRank: (row) => statusIndex.get(row.issue.status) ?? statusOrder.length,
  };
}

/**
 * THE COMPARATOR FOR ONE PREFERENCE — the only thing the tree calls.
 *
 * Primary first, signed by the direction; then the chain, forwards, always. Returns 0 only
 * for a row compared with itself, because every chain ends in the identifier.
 */
export function compareBySort(
  pref: SortPref,
  ctx: SortContext,
): (a: IssueRow, b: IssueRow) => number {
  const mode = sortMode(pref.mode);
  const sign = pref.direction === "desc" ? -1 : 1;
  const partition = mode.partition ? STEPS[mode.partition] : null;
  const primary = STEPS[mode.primary];
  const chain = mode.tieBreak.map((step) => STEPS[step]);
  return (a, b) => {
    if (partition) {
      const split = partition(a, b, ctx);
      if (split !== 0) return split;
    }
    const first = sign * primary(a, b, ctx);
    if (first !== 0) return first;
    for (const step of chain) {
      const next = step(a, b, ctx);
      if (next !== 0) return next;
    }
    return 0;
  };
}

/**
 * The same comparator, applied — a COPY, never in place.
 *
 * `Array.prototype.sort` mutates, and the arrays reaching a sort in this app are the
 * caller's `rows`, which is `session.issues.data` or a slice of it. Sorting that in place
 * would reorder the page's single source of truth as a side effect of drawing one view.
 * The rows themselves are passed through by reference and never copied, which is what makes
 * "changing the sort cannot change a row" checkable by identity in the test.
 */
export function sortRows(
  rows: readonly IssueRow[],
  pref: SortPref,
  ctx: SortContext,
): IssueRow[] {
  return [...rows].sort(compareBySort(pref, ctx));
}
