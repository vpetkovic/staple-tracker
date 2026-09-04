/**
 * The filter dimensions that need to know something the ROW does not carry — R4b (STA-187).
 *
 * ── WHY THIS IS A SECOND FILE AND NOT THREE MORE ENTRIES IN lib/filters.ts ────────────
 *
 * `FilterDimension` there is `(row, value) => boolean`. That signature is the whole reason
 * that registry is as clean as it is, and it is also a ceiling: three of the dimensions this
 * ticket asks for cannot be answered from one row.
 *
 *   MILESTONE — membership lives in `/api/milestones`, not on the issue. The ticket is
 *     explicit that it is membership and never `parentId`: a milestone contains epics and
 *     tasks WITHOUT reparenting them, so reading the tree would answer a different question
 *     and answer it wrongly.
 *   EPIC — a row's top-level ancestor is a property of the WHOLE list. One row knows its
 *     parent id and nothing above that.
 *   PICKUP STATE — the resolver's answer when it is served, and a derivation over the gate,
 *     the blockers, the claim and the status when it is not.
 *
 * So this file widens the signature by one argument — a `FilterContext` of served facts —
 * and COMPOSES the existing registry rather than replacing it: `allFilterDimensions()` is
 * the eight dimensions lib/filters.ts already argues, adapted, plus the three below, and
 * `applyFilterDimensions` calls `applyFilters` first and then applies the new ones. That
 * composition is safe precisely because `applyFilters` documents that it IGNORES a dimension
 * id it does not know — the same clause that lets an older build read a newer state.
 *
 * Everything here is pure. No fetch, no storage, no clock, and no write path: the one thing
 * this file must never be able to do is change what the queue thinks, and the way to be sure
 * of that is that it imports nothing that could (see `lib/api.ts` — deliberately absent).
 *
 * ── OR WITHIN, AND WITHIN ACROSS ──────────────────────────────────────────────────────
 *
 * Unchanged from lib/filters.ts, because a second combination scheme on the same chip strip
 * would be unreadable: alternatives inside one dimension are ORed, dimensions are ANDed, and
 * an empty selection is the ABSENCE of a constraint rather than "match nothing".
 *
 * ── EVERY OPTION COMES FROM SERVED DATA ───────────────────────────────────────────────
 *
 * Statuses and kinds come from the settings envelope through lib/settings.ts, assignees and
 * labels from the rows, milestones from `/api/milestones`, epics from the rows' own ancestry.
 * Nothing here hard-codes a value a workspace is allowed to rename — the one exception is the
 * five pickup states, which are a CONTRACT with the resolver (docs/queue.md) rather than a
 * vocabulary, and are listed in `PICKUP_STATES` in lib/types.ts.
 */
import { isGateParked, isQueuedBehindGate } from "./derived-queued";
import {
  applyFilters,
  countActive,
  toggleValue,
  withText,
  FILTER_DIMENSIONS,
  type FilterChip,
  type FilterOption,
  type FilterState,
} from "./filters";
import { isResolvedStatus, statusCategory } from "./settings";
import { PICKUP_STATES, type Issue, type IssueRow, type PickupState } from "./types";

// ---------------------------------------------------------------- the context

/**
 * One milestone, as the filter needs it.
 *
 * `members` is `null` — not `[]` — until somebody has fetched that milestone's view.
 * `/api/milestones` returns every milestone WITHOUT its members (it carries `memberCount`
 * instead), so a page that has only listed them knows a milestone exists and does not yet
 * know who is in it. The two are different facts and the predicate below treats them
 * differently: an unloaded milestone matches nothing, because claiming a row is a member on
 * the strength of a count would be an invention.
 */
export interface MilestoneFacts {
  identifier: string;
  title: string;
  /** The server's own total, used as the menu count until the members themselves arrive. */
  memberCount: number;
  /** Member identifiers, or null when this milestone's members have not been fetched. */
  members: readonly string[] | null;
}

/**
 * The served facts the three new dimensions need, resolved once per page rather than per row.
 *
 * `epicOf` and `epicTitle` are DERIVED from the unfiltered rows rather than fetched, and the
 * word unfiltered is load-bearing: built from the visible list, an epic hidden by the status
 * filter would stop being anybody's epic and its children would answer "no epic" to a
 * question the reader asked about the plan. Same argument `buildParentGroups` makes in
 * views/tree/tree-model.ts for its own ancestor map.
 */
export interface FilterContext {
  milestones: readonly MilestoneFacts[];
  /** `issue.id` -> the IDENTIFIER of its top-level ancestor. A root maps to itself. */
  epicOf: ReadonlyMap<string, string>;
  /** Epic identifier -> its title, for the menu and the chip. */
  epicTitle: ReadonlyMap<string, string>;
}

/** No milestones, no ancestry: every context-bearing dimension offers nothing and matches nothing. */
export const EMPTY_FILTER_CONTEXT: FilterContext = {
  milestones: [],
  epicOf: new Map(),
  epicTitle: new Map(),
};

/**
 * Build the context from what the page has: the UNFILTERED rows and the milestones payload.
 *
 * The ancestry walk stops at the first parent the input does not contain, so a row whose
 * parent was never loaded is treated as its own root rather than as belonging to an epic
 * nobody can see. The step cap is not paranoia about the store — it is what keeps a
 * hand-edited or half-written payload with a parent cycle from hanging the render.
 */
export function buildFilterContext(
  rows: readonly IssueRow[],
  milestones: readonly MilestoneFacts[] = [],
): FilterContext {
  const byId = new Map<string, Issue>(rows.map((row) => [row.issue.id, row.issue]));
  const epicOf = new Map<string, string>();
  const epicTitle = new Map<string, string>();
  for (const { issue } of rows) {
    let top = issue;
    for (let step = 0; step < byId.size; step += 1) {
      const parent = top.parentId ? byId.get(top.parentId) : undefined;
      if (!parent) break;
      top = parent;
    }
    epicOf.set(issue.id, top.identifier);
    epicTitle.set(top.identifier, top.title);
  }
  return { milestones, epicOf, epicTitle };
}

// ---------------------------------------------------------------- pickup state

const PICKUP_LABELS: Record<PickupState, string> = {
  pickable: "Pickable",
  queued: "Queued",
  waiting: "Waiting",
  gated: "Gated",
  in_flight: "In flight",
};

/** What each value MEANS. Rendered as the menu row's tooltip through `FilterOptionView`. */
export const PICKUP_HINTS: Record<PickupState, string> = {
  pickable: "nothing is in the way — an agent could check it out now",
  queued: "eligible, but the plan puts an earlier row first",
  waiting: "an unresolved blocker, or a blocked status",
  gated: "a human review gate holds it, or it stands behind one",
  in_flight: "somebody is holding it, or it is already being worked",
};

const isPickupState = (value: unknown): value is PickupState =>
  typeof value === "string" && (PICKUP_STATES as readonly string[]).includes(value);

/**
 * THIS ROW'S PICKUP STATE — the resolver's word when it sent one, otherwise derived.
 *
 * ── THE SERVED VALUE WINS, ALWAYS ─────────────────────────────────────────────────────
 *
 * `row.pickupState` is the queue resolver's own classification (docs/queue.md, step 3), and
 * it knows two things the browser cannot: the effective ORDER, and cross-workspace blockers
 * that cannot be resolved from this page. When it is there it is used verbatim.
 *
 * ── THE FALLBACK, AND WHAT IT DELIBERATELY CANNOT SAY ─────────────────────────────────
 *
 * R2c serves the field; until it lands — and for any fixture or synthesised row that has no
 * opinion — the state is derived from the four facts every row already carries, in the
 * resolver's own precedence:
 *
 *   1. resolved     -> null. Finished work is not waiting for anything.
 *   2. gated        -> the row's own active gate, or the gate it stands behind. Read through
 *                      lib/derived-queued.ts, so the filter cannot select a row the tree
 *                      would not caption. Named BEFORE the blocker, exactly as
 *                      `store.inbox()` and `pickupSectionOf` both do.
 *   3. waiting      -> an unresolved blocker on `deps`, or a status in the `blocked` category.
 *   4. in_flight    -> a claim, a bare `checkoutAgent`, or a status in the `active`/`review`
 *                      categories — a ticket moved by hand without a checkout is still not
 *                      free to take.
 *   5. pickable     -> everything else.
 *
 * `queued` IS UNREACHABLE FROM THE FALLBACK, on purpose. It means "eligible, but something
 * else comes first", which is a claim about the plan's order; the browser holds a page of
 * rows, not the resolver's effective sequence, and inventing the distinction from a
 * `queuePosition` that may be absent on half the rows would produce a filter that says
 * different things about the same board depending on what was loaded. So before R2c serves
 * the field, filtering for Queued selects nothing — and `explainNoMatches` says so in
 * words rather than leaving an empty page to be read as a bug.
 */
export function pickupStateOf(row: IssueRow): PickupState | null {
  if (isPickupState(row.pickupState)) return row.pickupState;
  const { issue } = row;
  if (isResolvedStatus(issue.status)) return null;
  if (isGateParked(row) || isQueuedBehindGate(row)) return "gated";
  const category = statusCategory(issue.status);
  if ((row.deps?.blockedBy.length ?? 0) > 0 || category === "blocked") return "waiting";
  if (row.claim || issue.checkoutAgent || category === "active" || category === "review") {
    return "in_flight";
  }
  return "pickable";
}

/** The sentence a row can give for its state — the resolver's `detail`, when it sent one. */
export function pickupReasonOf(row: IssueRow): string | null {
  return row.pickupReason ?? null;
}

// ---------------------------------------------------------------- the widened registry

/**
 * A menu row, with the one thing `FilterOption` has no room for: a sentence saying what the
 * value MEANS. Only the pickup states carry one — "Gated" is a word a reader can guess wrong
 * and the five of them are a contract with the resolver rather than a vocabulary they chose
 * — and the menu renders it generically as a tooltip, so it still names no dimension.
 */
export interface FilterOptionView extends FilterOption {
  hint?: string;
}

export interface ContextFilterDimension {
  id: string;
  /** Menu heading, Title Case: "Pickup state". */
  label: string;
  options: (rows: readonly IssueRow[], context: FilterContext) => FilterOptionView[];
  matches: (row: IssueRow, value: string, context: FilterContext) => boolean;
  format: (value: string, context: FilterContext) => string;
}

/** A context-free dimension, widened. The extra argument is simply ignored. */
function adapt(dimension: (typeof FILTER_DIMENSIONS)[number]): ContextFilterDimension {
  return {
    id: dimension.id,
    label: dimension.label,
    options: (rows) => dimension.options(rows),
    matches: (row, value) => dimension.matches(row, value),
    format: (value) => dimension.format(value),
  };
}

const matchPickup = (row: IssueRow, value: string) => pickupStateOf(row) === value;

const milestoneFor = (context: FilterContext, identifier: string) =>
  context.milestones.find((milestone) => milestone.identifier === identifier);

const matchMilestone = (row: IssueRow, value: string, context: FilterContext) => {
  const members = milestoneFor(context, value)?.members;
  // Not loaded is NOT "not a member" — but it is not a match either. See `MilestoneFacts`.
  return members ? members.includes(row.issue.identifier) : false;
};

const matchEpic = (row: IssueRow, value: string, context: FilterContext) =>
  context.epicOf.get(row.issue.id) === value;

/** Count matches for a value list in one pass, the context-bearing twin of filters.ts's `tally`. */
function tally(
  rows: readonly IssueRow[],
  values: readonly string[],
  context: FilterContext,
  matches: (row: IssueRow, value: string, context: FilterContext) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>(values.map((value) => [value, 0]));
  for (const row of rows) {
    for (const value of values) {
      if (matches(row, value, context)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * THE THREE NEW DIMENSIONS, APPENDED.
 *
 * lib/filters.ts argues its order entry by entry and inserted `kind` where kinship put it.
 * These three go at the END instead, and the reason is not timidity: every dimension in that
 * registry is a property of the TICKET or of one review, and these are properties of the
 * PLAN — where this work sits in the sequence, which milestone it was committed to, which
 * epic it belongs to. They read as a block, and the block reads last.
 *
 * Pickup state heads the block because it is the one that answers "what do I do next", and
 * it sits directly after `gate` — the dimension it partly subsumes and never contradicts,
 * since both read the gate through the same module.
 */
export const CONTEXT_FILTER_DIMENSIONS: readonly ContextFilterDimension[] = [
  {
    id: "pickup",
    label: "Pickup state",
    /**
     * A CLOSED enum, offered in full even at zero — the same call `status`, `priority` and
     * `gate` make. "Is anything pickable right now?" has to be answerable, and the answer
     * "no" is only reachable if the option is there to select.
     */
    options: (rows, context) => {
      const counts = tally(rows, PICKUP_STATES, context, matchPickup);
      return PICKUP_STATES.map((value) => ({
        value,
        label: PICKUP_LABELS[value],
        hint: PICKUP_HINTS[value],
        count: counts.get(value) ?? 0,
      }));
    },
    matches: matchPickup,
    format: (value) => PICKUP_LABELS[value as PickupState] ?? value,
  },
  {
    id: "milestone",
    label: "Milestone",
    /**
     * In the payload's own order, which is the plan order `/api/milestones` returns — the
     * same sequence the milestones view lists down its left pane. Sorting it alphabetically
     * would make this menu the one surface that disagrees about what comes first.
     *
     * The count is the number of rows ON THE PAGE that are members once the members are
     * loaded, and the milestone's own `memberCount` until then — a served number either way,
     * and never a zero that would read as "this milestone is empty".
     */
    options: (rows, context) =>
      context.milestones.map((milestone) => ({
        value: milestone.identifier,
        label: milestone.title,
        count: milestone.members
          ? rows.filter((row) => milestone.members!.includes(row.issue.identifier)).length
          : milestone.memberCount,
      })),
    matches: matchMilestone,
    format: (value, context) => milestoneFor(context, value)?.title ?? value,
  },
  {
    id: "epic",
    label: "Epic",
    /**
     * The top-level ancestors actually present, by title. An OPEN set like `assignee` and
     * `label`, because the epics on a board are data and a closed list of them cannot exist.
     *
     * A top-level row is its own epic, so selecting one keeps the epic AND its subtree — the
     * reading somebody who picks "Epic: R" is asking for. It is also what keeps the ghost
     * rules quiet: the parent survives its own filter, so there is nothing to ghost.
     */
    options: (rows, context) => {
      const present = new Set<string>();
      for (const row of rows) {
        const epic = context.epicOf.get(row.issue.id);
        if (epic) present.add(epic);
      }
      const values = [...present].sort((a, b) =>
        (context.epicTitle.get(a) ?? a).localeCompare(context.epicTitle.get(b) ?? b),
      );
      const counts = tally(rows, values, context, matchEpic);
      return values.map((value) => ({
        value,
        label: context.epicTitle.get(value) ?? value,
        count: counts.get(value) ?? 0,
      }));
    },
    matches: matchEpic,
    format: (value, context) => context.epicTitle.get(value) ?? value,
  },
];

/** Every dimension the menu offers: the eight from lib/filters.ts, then the three above. */
export const ALL_FILTER_DIMENSIONS: readonly ContextFilterDimension[] = [
  ...FILTER_DIMENSIONS.map(adapt),
  ...CONTEXT_FILTER_DIMENSIONS,
];

const BY_ID = new Map(ALL_FILTER_DIMENSIONS.map((dimension) => [dimension.id, dimension]));

export function findFilterDimension(id: string): ContextFilterDimension | undefined {
  return BY_ID.get(id);
}

export function filterDimensionOptions(
  id: string,
  rows: readonly IssueRow[],
  context: FilterContext = EMPTY_FILTER_CONTEXT,
): FilterOptionView[] {
  return findFilterDimension(id)?.options(rows, context) ?? [];
}

// ---------------------------------------------------------------- applying

/**
 * The whole filter, including the context-bearing dimensions.
 *
 * `applyFilters` runs FIRST and does the work it already does — the done default, the text
 * box, and its own eight dimensions — and then the three here narrow what survived. It is
 * two passes rather than one because that is what keeps the two registries from having to
 * know about each other; the cost is one extra array over rows already in memory.
 *
 * A dimension id that is in the state and in NEITHER registry is ignored by both, which is
 * the property that lets an older build read a newer build's saved filters and show more
 * than it should rather than a blank page it cannot explain.
 */
export function applyFilterDimensions(
  rows: readonly IssueRow[],
  state: FilterState,
  context: FilterContext = EMPTY_FILTER_CONTEXT,
): IssueRow[] {
  const base = applyFilters(rows, state);
  return base.filter((row) => {
    for (const dimension of CONTEXT_FILTER_DIMENSIONS) {
      const selected = state.dims[dimension.id];
      if (!selected || selected.length === 0) continue; // no constraint, not "none match"
      if (!selected.some((value) => dimension.matches(row, value, context))) return false;
    }
    return true;
  });
}

/**
 * How many constraints are active, ACROSS BOTH REGISTRIES.
 *
 * `countActive` in lib/filters.ts counts its own eight and cannot see these three, so a
 * milestone filter would leave the Filter button's badge saying nothing is on. Every surface
 * that shows the number — the badge, the empty state — reads this one.
 */
export function countActiveFilters(state: FilterState): number {
  let total = countActive(state);
  for (const dimension of CONTEXT_FILTER_DIMENSIONS) {
    total += (state.dims[dimension.id] ?? []).length;
  }
  return total;
}

export function isFilteringNow(state: FilterState): boolean {
  return countActiveFilters(state) > 0;
}

/**
 * One removable chip per active value, in registry order, text last — the twin of
 * `activeChips` in lib/filters.ts, widened so that a milestone chip can print the
 * milestone's TITLE rather than its identifier.
 *
 * Each chip still carries its own `remove`, so the strip never has to know which registry a
 * chip came from, and "Clear all" is still `clearFilters()` — a reset to the shipped default
 * clears the new dimensions for free, because they live in the same `dims` record.
 */
export function activeFilterChips(
  state: FilterState,
  context: FilterContext = EMPTY_FILTER_CONTEXT,
): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const dimension of ALL_FILTER_DIMENSIONS) {
    for (const value of state.dims[dimension.id] ?? []) {
      chips.push({
        dimension: dimension.id,
        dimensionLabel: dimension.label,
        value,
        label: dimension.format(value, context),
        remove: (current) => toggleValue(current, dimension.id, value),
      });
    }
  }
  const text = state.text.trim();
  if (text.length > 0) {
    chips.push({
      dimension: "text",
      dimensionLabel: "Search",
      value: text,
      label: `"${text}"`,
      remove: (current) => withText(current, ""),
    });
  }
  return chips;
}

// ---------------------------------------------------------------- explaining nothing

/**
 * Pairs of selections that cannot both be true of one row, as a table rather than as
 * branching code — the same trick the registries play, and for the same reason: a ninth
 * conflict should be one entry.
 *
 * Both entries are consequences of definitions in this file and lib/derived-queued.ts, not
 * guesses about data: a resolved row has NO pickup state, and a gated row's pickup state is
 * `gated` and nothing else.
 */
const IMPOSSIBLE_PAIRS: readonly {
  a: { dimension: string; values: readonly string[] };
  b: { dimension: string; values: readonly string[] };
  because: string;
}[] = [
  {
    a: { dimension: "status", values: ["done", "cancelled"] },
    b: { dimension: "pickup", values: [...PICKUP_STATES] },
    because: "finished work has no pickup state",
  },
  {
    a: { dimension: "gate", values: ["awaiting", "queued"] },
    b: { dimension: "pickup", values: ["pickable", "queued", "waiting", "in_flight"] },
    because: "a row behind a gate is gated, and nothing else",
  },
];

export interface NoMatchExplanation {
  /** The dimension ids to blame, in registry order. Empty when nothing is filtering. */
  dimensions: string[];
  /** True when the selection could not match a row whatever the data said. */
  impossible: boolean;
  /** One sentence, ready to render. "" when there is nothing to explain. */
  sentence: string;
}

/** The search box is not a dimension, but it narrows and it has to be blameable. */
const TEXT_DIMENSION = "text";

const labelOf = (id: string) =>
  id === TEXT_DIMENSION ? "Search" : (findFilterDimension(id)?.label ?? id);

/** "Status" / "Status and Pickup state" / "Status, Milestone and Epic". */
function listLabels(ids: readonly string[]): string {
  const labels = ids.map(labelOf);
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/**
 * WHY NOTHING MATCHED, IN ONE SENTENCE THAT NAMES NAMES.
 *
 * An empty list under a filter is the moment a tracker gets accused of losing work, and
 * "no tasks match these filters" does not help: with five chips on, the reader's real
 * question is WHICH of them to take off. So:
 *
 *   1. IMPOSSIBLE FIRST. Some pairs cannot match anything at all — asking for done work that
 *      is also pickable is a question with no answer, and no amount of data would change it.
 *      Saying "remove one of these" is the only useful reply, and it is a different sentence
 *      from "this combination is merely empty today".
 *   2. OTHERWISE, THE ONE THAT WOULD HELP. For each active dimension, ask what the page
 *      would look like WITHOUT it. Any dimension whose removal brings rows back is a
 *      dimension worth naming, with the count it would restore — that is the sentence that
 *      turns an empty page into one click.
 *   3. AND IF NONE OF THEM WOULD, they are only unsatisfiable TOGETHER, which is its own
 *      answer and has to be said plainly rather than by listing every chip.
 *
 * Pure, and over the rows it is given: it re-runs the same `applyFilterDimensions` the view
 * ran, so it can never explain a page the view did not produce.
 */
export function explainNoMatches(
  rows: readonly IssueRow[],
  state: FilterState,
  context: FilterContext = EMPTY_FILTER_CONTEXT,
): NoMatchExplanation {
  const active = ALL_FILTER_DIMENSIONS.map((dimension) => dimension.id).filter(
    (id) => (state.dims[id] ?? []).length > 0,
  );
  if (state.text.trim().length > 0) active.push(TEXT_DIMENSION);
  if (active.length === 0) return { dimensions: [], impossible: false, sentence: "" };

  for (const pair of IMPOSSIBLE_PAIRS) {
    const chosenA = (state.dims[pair.a.dimension] ?? []).filter((v) => pair.a.values.includes(v));
    const chosenB = (state.dims[pair.b.dimension] ?? []).filter((v) => pair.b.values.includes(v));
    // Every selected value on BOTH sides has to be in the pair, or the OR inside the
    // dimension leaves a satisfiable alternative and the combination is not impossible.
    if (
      chosenA.length > 0 &&
      chosenB.length > 0 &&
      chosenA.length === (state.dims[pair.a.dimension] ?? []).length &&
      chosenB.length === (state.dims[pair.b.dimension] ?? []).length
    ) {
      const [first, second] = [pair.a.dimension, pair.b.dimension];
      return {
        dimensions: [first!, second!],
        impossible: true,
        sentence: `${listLabels([first!, second!])} cannot both be true — ${pair.because}. Remove one of them.`,
      };
    }
  }

  const relieving: { id: string; count: number }[] = [];
  for (const id of active) {
    const without: FilterState =
      id === TEXT_DIMENSION
        ? { ...state, text: "" }
        : { ...state, dims: { ...state.dims } };
    if (id !== TEXT_DIMENSION) delete without.dims[id];
    const count = applyFilterDimensions(rows, without, context).length;
    if (count > 0) relieving.push({ id, count });
  }

  if (relieving.length > 0) {
    const named = relieving.map(({ id, count }) => `${labelOf(id)} (${count})`);
    const list =
      named.length <= 1
        ? named[0]!
        : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
    return {
      dimensions: relieving.map((entry) => entry.id),
      impossible: false,
      sentence: `Nothing matches. Removing ${list} would bring rows back — the number is what each would show.`,
    };
  }

  return {
    dimensions: active,
    impossible: false,
    sentence:
      active.length > 1
        ? `Nothing matches: ${listLabels(active)} exclude every row together, so no single one of them explains it.`
        : `Nothing matches ${listLabels(active)}.`,
  };
}
