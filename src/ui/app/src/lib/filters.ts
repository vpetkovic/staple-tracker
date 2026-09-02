/**
 * The filter system — V4 (STA-89). All of the judgement, none of the pixels.
 *
 * ── Why this is a registry and not six `if` statements ────────────────────────────────
 *
 * The obvious implementation of "filter by status, assignee, priority, label, text and
 * claim state" is a function with six branches and a bar component with six hard-coded
 * menus. It works, and then the seventh dimension arrives — sprint, or due date, or
 * "blocked by something I own" — and it has to be added in four places that do not know
 * about each other: the state type, the predicate, the menu, and the chip renderer. The
 * fourth one is always the one that gets missed, and the symptom is a filter that
 * silently applies but cannot be seen or removed.
 *
 * So a dimension is a VALUE here: an id, a label, the options it offers given the rows on
 * hand, a predicate for one value, and how to print it. `applyFilters` iterates the
 * registry; the bar iterates the registry; the chips iterate the registry. Adding a
 * dimension is one entry in `FILTER_DIMENSIONS` and nothing else changes.
 *
 * ── The two rules that make combinations mean anything ────────────────────────────────
 *
 *   OR *within* a dimension — "status is todo or blocked" is one question.
 *   AND *across* dimensions — "…and assigned to kim" narrows it.
 *
 * This is the only combination scheme that matches what a person means when they add a
 * second chip, and it is what Linear, ClickUp and Jira all do. An empty selection is NOT
 * "match nothing" — it is the absence of a constraint, which is why removing the last
 * value from a dimension drops the dimension entirely (see `withDimension`).
 *
 * ── Done is hidden by default, and that is a default, not a rule ──────────────────────
 *
 * `showDone: false` in the shipped default state. But `passesDone` has a second clause
 * that matters more than the first: selecting a resolved status IS the opt-in. A user who
 * filters for "Done" and is shown an empty list has been told the filter is broken. The
 * toggle lifts the default globally; an explicit status selection lifts it for exactly
 * the statuses named.
 *
 * ── What this file does NOT do ────────────────────────────────────────────────────────
 *
 * It does not decide what a stale claim is. `lib/claim.ts` owns the single threshold this
 * app has, the takeover buttons send that same number, and the `claim` dimension calls
 * `isStaleClaim` rather than comparing seconds itself. One judgement, one place.
 *
 * It does not walk the tree. Filtering a done PARENT out must not take its live children
 * off the page — that is the STA-97 invariant — and the reason it holds is that this
 * returns a FLAT list and `TreeView.flatten()` already re-roots subtrees whose parent is
 * missing. `hiddenParents` exists so a row can say WHICH parent it lost.
 */
import { isStaleClaim } from "./claim";
import {
  ISSUE_PRIORITIES,
  OPEN_STATUS_ORDER,
  RESOLVED_STATUSES,
  type IssuePriority,
  type IssueRow,
  type IssueStatus,
  type Issue,
} from "./types";

// ---------------------------------------------------------------- state

/**
 * Everything the page is filtered by, as one serialisable value.
 *
 * `dims` is an open record rather than a closed set of named fields on purpose. It is
 * what lets a build that has never heard of dimension seven read, hold and write back a
 * state containing it (see `decodeFilters`), instead of silently dropping it the moment
 * someone opens an older tab.
 *
 * `text` is not in `dims` because it is not a set of alternatives — it is one string with
 * its own input, and modelling it as a one-element array would put a search box in a
 * checkbox menu.
 *
 * `showDone` is not a filter. It is a DEFAULT being lifted, which is why `isFiltering`
 * and `countActive` deliberately ignore it and no chip is emitted for it: the bar shows
 * it as a toggle, because "I turned off a default" and "I added a constraint" are
 * different sentences and a chip would tell the first one as if it were the second.
 */
export interface FilterState {
  /** dimension id -> selected values. Absent or empty means unconstrained. */
  dims: Record<string, string[]>;
  /** Free text over identifier, title, assignee and labels. */
  text: string;
  /** Lift the hide-resolved default everywhere. */
  showDone: boolean;
}

/** The shipped default: nothing constrained, resolved work out of sight. */
export function emptyFilters(): FilterState {
  return { dims: {}, text: "", showDone: false };
}

/**
 * The sentinel for "nobody is assigned".
 *
 * A real filter needs this — "unassigned" is one of the most useful questions a tracker
 * answers — and `null` cannot travel through a record of string arrays. The `~` prefix is
 * chosen because it sorts after every alphanumeric agent name and reads as non-literal;
 * an agent that genuinely names itself `~unassigned` would collide, which is a trade
 * worth making against carrying a tagged union through localStorage.
 */
export const UNASSIGNED = "~unassigned";

// ---------------------------------------------------------------- the registry

export interface FilterOption {
  value: string;
  label: string;
  /** How many of the rows on hand this value would match. Zero is still selectable. */
  count: number;
}

export interface FilterDimension {
  id: string;
  /** Menu heading, Title Case: "Status". */
  label: string;
  /** Values selectable right now. Closed enums list in full; open sets come from rows. */
  options: (rows: readonly IssueRow[]) => FilterOption[];
  /** Does this row satisfy this ONE value? Alternatives are ORed by `applyFilters`. */
  matches: (row: IssueRow, value: string) => boolean;
  /** Chip and menu text for a value. */
  format: (value: string) => string;
}

/** `in_progress` -> "In Progress". The wire value is never shown to a human. */
function titleCase(value: string): string {
  return value
    .split("_")
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(" ");
}

const STATUS_LABELS: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "To Do",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/**
 * `critical` renders as "Urgent".
 *
 * The STA-97 row spec §2.1 settled this: the brief says urgent, the SQLite enum says
 * critical, they are the same rung, and renaming the enum would mean a migration plus a
 * change to CLI output and the MCP payload. One mapping line absorbs it.
 */
const PRIORITY_LABELS: Record<IssuePriority, string> = {
  critical: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/**
 * The four claim states, in the evaluation order the STA-97 row spec fixes. They are
 * mutually exclusive and they cover every row, which is what makes them safe to offer as
 * a menu: selecting all four is the same as selecting none.
 */
export const CLAIM_STATES = ["live", "stale", "held", "free"] as const;
export type ClaimState = (typeof CLAIM_STATES)[number];

const CLAIM_LABELS: Record<ClaimState, string> = {
  live: "Working now",
  stale: "Stale claim",
  held: "Held",
  free: "Unclaimed",
};

/** Which of the four a row is in. Exactly one answer, always. */
export function claimStateOf(row: IssueRow): ClaimState {
  if (row.claim) return isStaleClaim(row.claim) ? "stale" : "live";
  // A `checkoutAgent` with no liveness reading says a claim EXISTS, not that anyone is
  // awake — see lib/claim.ts. That is its own state, not a synonym for live.
  return row.issue.checkoutAgent ? "held" : "free";
}

/** Count matches for a fixed value list, in one pass over the rows. */
function tally(
  rows: readonly IssueRow[],
  values: readonly string[],
  matches: (row: IssueRow, value: string) => boolean,
): Map<string, number> {
  const counts = new Map<string, number>(values.map((value) => [value, 0]));
  for (const row of rows) {
    for (const value of values) {
      if (matches(row, value)) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  return counts;
}

/** Options for a closed enum: every member, always, whether or not a row uses it. */
function closedOptions(
  rows: readonly IssueRow[],
  values: readonly string[],
  label: (value: string) => string,
  matches: (row: IssueRow, value: string) => boolean,
): FilterOption[] {
  const counts = tally(rows, values, matches);
  return values.map((value) => ({ value, label: label(value), count: counts.get(value) ?? 0 }));
}

const matchStatus = (row: IssueRow, value: string) => row.issue.status === value;
const matchPriority = (row: IssueRow, value: string) => row.issue.priority === value;
const matchClaim = (row: IssueRow, value: string) => claimStateOf(row) === value;

const matchAssignee = (row: IssueRow, value: string) => {
  const who = row.issue.assignee;
  if (value === UNASSIGNED) return who === null || who === "";
  // Case-insensitive: agents are inconsistent about capitalising their own names, and a
  // filter that distinguishes `kim` from `Kim` is a filter that hides half the answer.
  return who !== null && who.toLowerCase() === value.toLowerCase();
};

const matchLabel = (row: IssueRow, value: string) =>
  row.issue.labels.some((label) => label.toLowerCase() === value.toLowerCase());

/**
 * The registry. ORDER IS THE MENU ORDER AND THE CHIP ORDER — status first because it is
 * the axis the list is grouped on, then who, then how urgent, then the open-ended ones.
 *
 * Text is deliberately absent: it has its own box and its own field on the state. Every
 * OTHER dimension is a set of alternatives and belongs here.
 */
export const FILTER_DIMENSIONS: readonly FilterDimension[] = [
  {
    id: "status",
    label: "Status",
    // Open statuses in board order, then the resolved pair — the same sequence the tree's
    // group headers use (STA-97 §6.2), imported rather than retyped.
    options: (rows) =>
      closedOptions(
        rows,
        [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES],
        (value) => STATUS_LABELS[value as IssueStatus] ?? titleCase(value),
        matchStatus,
      ),
    matches: matchStatus,
    format: (value) => STATUS_LABELS[value as IssueStatus] ?? titleCase(value),
  },
  {
    id: "assignee",
    label: "Assignee",
    options: (rows) => {
      // Open set: the menu can only offer the people who actually appear. A canonical
      // spelling per lowercased name, so `kim` and `Kim` are one entry rather than two.
      const canonical = new Map<string, string>();
      let unassigned = 0;
      for (const row of rows) {
        const who = row.issue.assignee;
        if (who === null || who === "") {
          unassigned += 1;
          continue;
        }
        const key = who.toLowerCase();
        if (!canonical.has(key)) canonical.set(key, who);
      }
      const names = [...canonical.values()].sort((a, b) => a.localeCompare(b));
      const counts = tally(rows, names, matchAssignee);
      const options: FilterOption[] = names.map((name) => ({
        value: name,
        label: name,
        count: counts.get(name) ?? 0,
      }));
      // Last, because it is a bucket rather than a person and the `~` prefix sorts it
      // there anyway. Offered only when it would match something — an "Unassigned 0" row
      // in the menu is furniture.
      if (unassigned > 0) {
        options.push({ value: UNASSIGNED, label: "Unassigned", count: unassigned });
      }
      return options;
    },
    matches: matchAssignee,
    format: (value) => (value === UNASSIGNED ? "Unassigned" : value),
  },
  {
    id: "priority",
    label: "Priority",
    options: (rows) =>
      closedOptions(
        rows,
        ISSUE_PRIORITIES,
        (value) => PRIORITY_LABELS[value as IssuePriority] ?? titleCase(value),
        matchPriority,
      ),
    matches: matchPriority,
    format: (value) => PRIORITY_LABELS[value as IssuePriority] ?? titleCase(value),
  },
  {
    id: "label",
    label: "Label",
    options: (rows) => {
      const canonical = new Map<string, string>();
      for (const row of rows) {
        for (const label of row.issue.labels) {
          const key = label.toLowerCase();
          if (!canonical.has(key)) canonical.set(key, label);
        }
      }
      const labels = [...canonical.values()].sort((a, b) => a.localeCompare(b));
      const counts = tally(rows, labels, matchLabel);
      return labels.map((label) => ({ value: label, label, count: counts.get(label) ?? 0 }));
    },
    matches: matchLabel,
    format: (value) => value,
  },
  {
    id: "claim",
    label: "Claim",
    options: (rows) =>
      closedOptions(rows, CLAIM_STATES, (value) => CLAIM_LABELS[value as ClaimState] ?? value, matchClaim),
    matches: matchClaim,
    format: (value) => CLAIM_LABELS[value as ClaimState] ?? value,
  },
];

const BY_ID = new Map(FILTER_DIMENSIONS.map((dimension) => [dimension.id, dimension]));

export function findDimension(id: string): FilterDimension | undefined {
  return BY_ID.get(id);
}

/** The options a menu should show for one dimension, given the rows currently loaded. */
export function dimensionOptions(id: string, rows: readonly IssueRow[]): FilterOption[] {
  return findDimension(id)?.options(rows) ?? [];
}

// ---------------------------------------------------------------- applying

/** Everything the text box searches. Identifier first: it is what people paste. */
function searchable(row: IssueRow): string {
  const { identifier, title, assignee, labels } = row.issue;
  return `${identifier} ${title} ${assignee ?? ""} ${labels.join(" ")}`.toLowerCase();
}

/**
 * The done gate, and its escape hatch.
 *
 * Clause two is the one that matters: an explicit selection naming a resolved status
 * lifts the default FOR THAT STATUS. Asking for Done and getting an empty list is how a
 * filter system loses a user's trust in one click.
 */
function passesDone(row: IssueRow, state: FilterState): boolean {
  if (state.showDone) return true;
  if (!RESOLVED_STATUSES.includes(row.issue.status)) return true;
  return (state.dims.status ?? []).includes(row.issue.status);
}

/**
 * The whole filter, as one pure function over a flat row list.
 *
 * Every view calls exactly this — the tree on its issue rows, the graph on the issue rows
 * behind its nodes — which is what "applied globally" means in practice: not a shared
 * component, a shared PREDICATE. Two views that each re-derived "is this row in" would
 * eventually disagree, and the graph would quietly show work the list said was filtered
 * out.
 *
 * A dimension present in `state.dims` but absent from the registry is IGNORED rather than
 * treated as unsatisfiable. An older build reading a newer state must show more than it
 * should, never less — the alternative is a blank page with no visible explanation.
 */
export function applyFilters(rows: readonly IssueRow[], state: FilterState): IssueRow[] {
  const text = state.text.trim().toLowerCase();
  return rows.filter((row) => {
    if (!passesDone(row, state)) return false;
    for (const dimension of FILTER_DIMENSIONS) {
      const selected = state.dims[dimension.id];
      if (!selected || selected.length === 0) continue; // no constraint, not "none match"
      if (!selected.some((value) => dimension.matches(row, value))) return false;
    }
    if (text.length > 0 && !searchable(row).includes(text)) return false;
    return true;
  });
}

/**
 * For each surviving row whose parent did NOT survive, the parent that was filtered out.
 *
 * The seam for STA-97's breadcrumb chip. A done epic disappears under the default filter
 * while its in-progress children stay — correctly, because hiding live work is the one
 * thing a tracker must never do — and those children are then rendered at depth 0 with no
 * indication of where they came from. This says where: `visibleIssueId -> parent Issue`.
 *
 * A row whose parent is absent from BOTH lists is not in here. That parent was never
 * loaded (a different workspace, or outside the page) rather than filtered away, and
 * claiming the filter hid it would be an invention.
 */
export function hiddenParents(
  visible: readonly IssueRow[],
  all: readonly IssueRow[],
): Map<string, Issue> {
  const shown = new Set(visible.map((row) => row.issue.id));
  const everything = new Map(all.map((row) => [row.issue.id, row.issue]));
  const out = new Map<string, Issue>();
  for (const row of visible) {
    const parentId = row.issue.parentId;
    if (!parentId || shown.has(parentId)) continue;
    const parent = everything.get(parentId);
    if (parent) out.set(row.issue.id, parent);
  }
  return out;
}

// ---------------------------------------------------------------- editing the state

/**
 * Replace one dimension's selection. An empty list DELETES the key rather than storing
 * `[]`, so "no constraint" has exactly one representation — otherwise `isFiltering` and
 * the persisted payload would both have to special-case an empty array forever.
 *
 * Never mutates: the state is a React value and a mutated one has the same identity, so
 * nothing downstream would re-render.
 */
export function withDimension(state: FilterState, id: string, values: readonly string[]): FilterState {
  const dims = { ...state.dims };
  if (values.length === 0) delete dims[id];
  else dims[id] = [...values];
  return { ...state, dims };
}

/** Check-box semantics for one value in one dimension. */
export function toggleValue(state: FilterState, id: string, value: string): FilterState {
  const current = state.dims[id] ?? [];
  const next = current.includes(value)
    ? current.filter((entry) => entry !== value)
    : [...current, value];
  return withDimension(state, id, next);
}

export function withText(state: FilterState, text: string): FilterState {
  return { ...state, text };
}

export function withShowDone(state: FilterState, showDone: boolean): FilterState {
  return { ...state, showDone };
}

/** Back to the shipped default — including re-hiding done, which is part of the default. */
export function clearFilters(): FilterState {
  return emptyFilters();
}

/**
 * How many constraints are active. Counts each selected VALUE, not each dimension, because
 * that is what the chip row shows and a badge that disagrees with a visible count is worse
 * than no badge. `showDone` is not counted — see the note on `FilterState`.
 *
 * Only registry dimensions count. A dimension this build cannot apply must not be
 * advertised as applied.
 */
export function countActive(state: FilterState): number {
  let total = state.text.trim().length > 0 ? 1 : 0;
  for (const dimension of FILTER_DIMENSIONS) total += (state.dims[dimension.id] ?? []).length;
  return total;
}

export function isFiltering(state: FilterState): boolean {
  return countActive(state) > 0;
}

/**
 * One removable chip per active value, in registry order, text last.
 *
 * Each chip carries its own `remove`, so the bar never has to know whether it is deleting
 * a value from a dimension or clearing the search box. That is the difference between a
 * chip row that keeps working when a dimension is added and one that grows a switch.
 */
export interface FilterChip {
  /** Dimension id, or "text" for the search chip. */
  dimension: string;
  /** Dimension heading: "Status". `undefined` for text, which has no menu. */
  dimensionLabel: string;
  /** The selected value, or the raw query for text. */
  value: string;
  /** What the chip reads: "To Do", "Unassigned", '"header"'. */
  label: string;
  remove: (state: FilterState) => FilterState;
}

export function activeChips(state: FilterState): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const dimension of FILTER_DIMENSIONS) {
    for (const value of state.dims[dimension.id] ?? []) {
      chips.push({
        dimension: dimension.id,
        dimensionLabel: dimension.label,
        value,
        label: dimension.format(value),
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
      // Quoted, because a bare word sitting among status chips reads as a status.
      label: `"${text}"`,
      remove: (current) => withText(current, ""),
    });
  }
  return chips;
}

// ---------------------------------------------------------------- persistence

/**
 * One key, and it is versioned twice over.
 *
 * `:v1` in the key name is the SHAPE of the envelope: if the envelope itself ever has to
 * change incompatibly, `:v2` is a new key and the old one is simply ignored rather than
 * misread. `version` inside is for changes small enough to migrate in place.
 */
export const FILTERS_STORAGE_KEY = "staple:filters:v1";

/** The only set that exists today. Named so that saved filter sets are not a migration. */
export const DEFAULT_FILTER_SET = "default";

/**
 * The envelope. There is exactly one set in it right now and no UI to make a second, and
 * it is still shaped this way on purpose: "save this filter set as My Queue" is the next
 * thing anybody asks for after filters work, and discovering then that the stored value
 * was a bare `FilterState` means either a migration or a second key that has to be kept in
 * step with the first. A named-set map with an `active` pointer costs three lines today.
 */
interface FilterEnvelope {
  version: 1;
  active: string;
  sets: Record<string, FilterState>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Coerce whatever was in storage into a usable state, keeping every part that is
 * well-formed and dropping only the parts that are not.
 *
 * Repair rather than reject. A single corrupt key — a hand-edited localStorage, a
 * half-written value from a killed tab — should cost the user that one key, not their
 * whole filter set. And an UNKNOWN dimension is not corruption: it is state from a newer
 * build, it is kept verbatim, and it round-trips out again untouched.
 */
function sanitize(value: unknown): FilterState {
  if (!isRecord(value)) return emptyFilters();
  const dims: Record<string, string[]> = {};
  const rawDims = value.dims;
  if (isRecord(rawDims)) {
    for (const [id, selected] of Object.entries(rawDims)) {
      if (!Array.isArray(selected)) continue;
      const values = selected.filter((entry): entry is string => typeof entry === "string");
      if (values.length > 0) dims[id] = values;
    }
  }
  return {
    dims,
    text: typeof value.text === "string" ? value.text : "",
    // Strictly `true`. A stored "yes" is not an opt-in; the default it would lift is the
    // one behaviour this ticket exists to guarantee, so it does not get lifted by accident.
    showDone: value.showDone === true,
  };
}

export function encodeFilters(state: FilterState, name: string = DEFAULT_FILTER_SET): string {
  const envelope: FilterEnvelope = { version: 1, active: name, sets: { [name]: state } };
  return JSON.stringify(envelope);
}

/** The stored envelope, or null if there is nothing readable there. */
function parseEnvelope(raw: string | null): { active: string; sets: Record<string, unknown> } | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.sets)) return null;
  const active = typeof parsed.active === "string" ? parsed.active : DEFAULT_FILTER_SET;
  return { active, sets: parsed.sets };
}

export function decodeFilters(raw: string | null): FilterState {
  const envelope = parseEnvelope(raw);
  if (!envelope) return emptyFilters();
  return sanitize(envelope.sets[envelope.active]);
}

/**
 * Read the active set. Never throws: Safari private mode makes `getItem` itself throw, and
 * a tracker that will not render because it could not read a preference is a worse failure
 * than one that opens with the default filter.
 */
export function loadFilters(storage: Storage): FilterState {
  try {
    return decodeFilters(storage.getItem(FILTERS_STORAGE_KEY));
  } catch {
    return emptyFilters();
  }
}

/**
 * Write the active set, leaving any OTHER stored set alone.
 *
 * Read-modify-write rather than blind overwrite, so that the day a "saved filter sets" UI
 * lands, autosaving the working set does not silently delete the saved ones. It costs one
 * extra `getItem` per change and removes a whole class of future data loss.
 */
export function saveFilters(storage: Storage, state: FilterState): void {
  try {
    const existing = parseEnvelope(storage.getItem(FILTERS_STORAGE_KEY));
    const active = existing?.active ?? DEFAULT_FILTER_SET;
    const sets: Record<string, FilterState> = {};
    for (const [name, value] of Object.entries(existing?.sets ?? {})) {
      if (name !== active) sets[name] = sanitize(value);
    }
    sets[active] = state;
    const envelope: FilterEnvelope = { version: 1, active, sets };
    storage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    /* private mode: the filter lasts for this page load */
  }
}
