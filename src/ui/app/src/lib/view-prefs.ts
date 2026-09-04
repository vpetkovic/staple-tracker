/**
 * How the list is ARRANGED, as opposed to what is in it — R1 (STA-100).
 *
 * ── WHY THIS IS NOT A FIELD ON `staple:filters:v1` ────────────────────────────────────
 *
 * The obvious move is to add `groupBy` to `FilterState` and get persistence for free. It is
 * the wrong move, and the reason is that `FilterState` means CONSTRAINTS — which rows are on
 * the page — and three shipped behaviours read it that way:
 *
 *   1. `countActive(filters)` drives the badge on the Filter button and the sentence in
 *      `NoMatchesState` ("2 filters are narrowing this view"). "Grouped by status" narrows
 *      nothing. Every consumer of that number would need a special case for one field.
 *   2. `clearFilters()` is wired to both "Clear filters" buttons. Clearing your filters
 *      would also reset your layout, which is not what either button says it does.
 *   3. The day saved filter sets ship — which the filter envelope is explicitly shaped for —
 *      switching sets would silently re-arrange the list.
 *
 * The one honest argument the other way is that Linear binds grouping to a saved VIEW. That
 * is an argument for this key growing named views later, not for folding a layout preference
 * into a constraint set today. It is versioned identically so it can: `:v1` in the KEY is the
 * envelope shape (an incompatible change becomes `:v2` and the old key is ignored rather than
 * misread), `version` INSIDE is for changes small enough to migrate in place.
 *
 * ── WHY A STRING UNION AND NOT A BOOLEAN ──────────────────────────────────────────────
 *
 * The ticket asks for the shape to let other dimensions follow. `groupByStatus: boolean` is a
 * schema that has to be migrated the day "group by assignee" lands; `groupBy: "none" |
 * "status"` is one that has to be extended. The cost today is zero and the difference is a
 * stored-data migration, which is the expensive kind.
 */

/**
 * ── WHY "pickup" IS A THIRD DIMENSION AND NOT A REARRANGEMENT OF "status" ─────────────
 *
 * V5 (STA-111). Status is a WORKFLOW dimension — a stored field somebody set. Pickup
 * readiness is a DERIVED one: status, plus unresolved blockers, plus who is holding it.
 * Folding the second into the first forces duplicate or ambiguous membership (an
 * in-progress ticket with an unresolved blocker is both "in progress" and "waiting"), and
 * the §1 invariant in tree-model.ts — every task in a group really is what the header says
 * — is exactly what that would break. So they are separate axes, and the registry is what
 * makes a third axis cost one entry.
 */
/**
 * ── WHY THE EPIC AXIS IS `parent` AND NOT `epic` — O3d (STA-129) ──────────────────────
 *
 * The ID names the DATA and the LABEL names the reading. What the grouping actually reads
 * is `issue.parentId` — the TOP-LEVEL ancestor of every row — and "epic" is what that
 * ancestor almost always is, not what it must be. O1a (STA-124) made `kind` a real field
 * and a workspace may add its own kinds; the day somebody groups a page whose top-level
 * rows are `task` or `initiative`, an id spelled `epic` would be a stored preference that
 * lies. The label can say "Epic" because a label is allowed to name the common case.
 */
/**
 * ── WHY `kind` IS AN AXIS AT ALL, AND WHY IT IS NOT `parent` WEARING A HAT — O1c ──────
 *
 * STA-130. The two look alike from a distance — both bucket a flat list by something the
 * issue declares — and they answer opposite questions. `parent` asks WHICH PROJECT this
 * belongs to, so an epic and its tasks land in one group. `kind` asks WHAT SORT OF WORK
 * this is, so that same epic and its tasks land in different ones. Nobody scanning "every
 * bug on the board" wants them scattered across nine epics, and nobody reading an epic
 * wants its tasks split from its bugs. Two readings, two entries.
 *
 * Unlike `parent`, the id and the label agree here: the axis reads `issue.kind` and the
 * header says "Kind". There was no common case to name it after and no lie available.
 */
import {
  DEFAULT_SORT,
  isSortDirection,
  isSortModeId,
  type SortPref,
} from "./sort-modes";

export type GroupBy = "none" | "status" | "pickup" | "parent" | "kind";

/**
 * The dimensions offered, in menu order. A registry rather than a switch, so a third entry
 * appears in the menu, in the trigger label and in the persistence validator with no edit to
 * any of them — the same trick `FILTER_DIMENSIONS` plays in lib/filters.ts.
 *
 * A NEW DIMENSION APPENDS. O3d (STA-129) added `parent` at the end rather than beside
 * `status` where it arguably belongs by kinship, and O1c (STA-130) appended `kind` after
 * it — as instructed, and for the same reason. Registry order IS menu order, so inserting
 * moves every entry below the insertion point — and the four that exist today are a year of
 * muscle memory for anyone who has used the control. Kinship is not worth a menu that
 * reshuffles under the pointer.
 *
 * (`FILTER_DIMENSIONS` in lib/filters.ts took the OTHER decision on the same day and it is
 * not an inconsistency: that registry states no append rule, argues its order semantically
 * per entry, and its menu has a search box over it. This one has neither.)
 */
export const GROUP_BY_OPTIONS: readonly { id: GroupBy; label: string; hint: string }[] = [
  {
    id: "none",
    label: "No grouping",
    // Said plainly, because this is the default and the default should explain itself.
    hint: "one flat list, sub-tasks nested under their parent",
  },
  {
    id: "status",
    label: "Status",
    hint: "collapsible headers with counts; a task sits in the group of its own status",
  },
  {
    id: "pickup",
    // The label the trigger shows as "Group: Pickup order". Named for the QUESTION it
    // answers rather than the mechanism, which is why it is not "Readiness".
    label: "Pickup order",
    hint: "what to grab next — up next, in flight, waiting; the inbox's own ordering",
  },
  {
    id: "parent",
    // O3d (STA-129). The trigger reads "Group: Epic".
    label: "Epic",
    hint: "the parent heads the group; every task sits under its top-level ancestor",
  },
  {
    id: "kind",
    // O1c (STA-130). The trigger reads "Group: Kind".
    label: "Kind",
    // Names the vocabulary rather than listing it: the five built-ins are only the seed,
    // and a workspace that added `milestone` would be reading a hint that omits it.
    hint: "epics, tasks, bugs and the rest, each in their own section",
  },
];

/**
 * FLAT IS THE DEFAULT, and this constant is the whole of that decision.
 *
 * V5 shipped status grouping as a fixture. It is a good triage view — "what is happening
 * right now" — and it is the wrong default, because it places a task in the group of its own
 * status, which splits a parent from its child whenever the two differ. The first question
 * anybody asks a tracker is "what does this project look like", and that is the one question
 * the grouped view cannot answer.
 */
export const DEFAULT_GROUP_BY: GroupBy = "none";

export const VIEW_PREFS_STORAGE_KEY = "staple:view:v1";

/**
 * ── WHY SORT IS SCOPED AND GROUPING IS NOT — R4a (STA-186) ────────────────────────────
 *
 * `groupBy` is one value for the whole app and stays that way: it is a claim about how you
 * read a list, it is the same claim in every workspace, and re-choosing it per workspace
 * would be a preference the user has to set five times to mean one thing.
 *
 * Sort is not that. "Queue position" is the right order for the workspace you are actively
 * pulling work from and the wrong one for the archive next door; "Updated" is right in the
 * tree and meaningless in the milestones view, which has its own plan order. So the sort
 * preference is stored per WORKSPACE and per VIEW, keyed by `sortScopeKey`, and every scope
 * that has never been set resolves to `DEFAULT_SORT` rather than inheriting a neighbour's.
 *
 * THE KEY IS UNCHANGED and the change is additive. `:v1` in the STORAGE KEY names the
 * envelope shape — an incompatible one becomes `:v2` and the old key is ignored rather than
 * misread — and `version` INSIDE is for changes small enough to migrate in place. This is
 * one of those: a v1 payload has no `sort`, decodes to an empty map, and every scope
 * resolves to the default, which is byte-for-byte the order that payload was written under.
 * Nobody loses a layout and nothing has to be reset.
 */
export interface ViewPrefs {
  groupBy: GroupBy;
  /** Sort preference per `sortScopeKey`. Absent scopes are `DEFAULT_SORT`. */
  sort: Record<string, SortPref>;
}

/**
 * WHICH SORT THIS IS THE SORT FOR — the workspace and the view, in one string.
 *
 * `""` is a real workspace value: it means hub mode, every workspace at once, and it is a
 * genuinely different reading from any single workspace's, so it gets its own scope rather
 * than being folded into one. Spelled `*` in the key so the string is never empty on one
 * side of the separator and a stored key stays readable in devtools.
 */
export function sortScopeKey(workspace: string, view: string): string {
  return `${workspace || "*"}::${view}`;
}

export function defaultViewPrefs(): ViewPrefs {
  return { groupBy: DEFAULT_GROUP_BY, sort: {} };
}

/**
 * The sort for one scope — the default until the user has chosen one there.
 *
 * Takes the MAP rather than the whole `ViewPrefs`, and so does `withSortForScope` below,
 * because both callers hold the map: `App.tsx` keeps it in its own state so that switching
 * workspace resolves a new scope without re-reading storage, and the setter only ever has the
 * map in hand. A `ViewPrefs`-shaped signature would have made both of them assemble an
 * envelope, including a `groupBy` neither is changing.
 */
export function sortForScope(sort: Readonly<Record<string, SortPref>>, scope: string): SortPref {
  return sort[scope] ?? DEFAULT_SORT;
}

/**
 * One scope changed, the rest untouched — and a scope set back to the default is REMOVED
 * rather than stored. A stored default is indistinguishable from a chosen one, so the day
 * `DEFAULT_SORT` changes, every workspace anybody ever opened would be pinned to the old
 * default by a preference they never made.
 */
export function withSortForScope(
  sort: Readonly<Record<string, SortPref>>,
  scope: string,
  next: SortPref,
): Record<string, SortPref> {
  const out = { ...sort };
  if (next.mode === DEFAULT_SORT.mode && next.direction === DEFAULT_SORT.direction) {
    delete out[scope];
  } else {
    out[scope] = next;
  }
  return out;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function isGroupBy(value: unknown): value is GroupBy {
  return typeof value === "string" && GROUP_BY_OPTIONS.some((option) => option.id === value);
}

/**
 * Repair rather than reject, the same rule lib/filters.ts follows: a hand-edited key or a
 * half-written value from a killed tab should cost the user that one preference, not their
 * whole session. An UNKNOWN dimension is treated as absent rather than kept, which is the one
 * place this differs from the filter envelope — an unknown filter dimension round-trips out
 * untouched because a newer build understands it, but an unknown GROUPING would have to be
 * rendered by a `buildGroups` that has never heard of it.
 */
export function decodeViewPrefs(raw: string | null): ViewPrefs {
  if (raw === null) return defaultViewPrefs();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return defaultViewPrefs();
  }
  if (!isRecord(parsed)) return defaultViewPrefs();
  return {
    groupBy: isGroupBy(parsed.groupBy) ? parsed.groupBy : DEFAULT_GROUP_BY,
    /**
     * THE MIGRATION, and it is the whole of it: a v1 payload has no `sort`, so this reads
     * `undefined` and every scope falls back to `DEFAULT_SORT` — which is the order that
     * payload was written under. Repair rather than reject applies per SCOPE too, so one
     * hand-edited entry costs the user that one view's sort and not the map.
     */
    sort: decodeSortMap(parsed.sort),
  };
}

function decodeSortMap(raw: unknown): Record<string, SortPref> {
  if (!isRecord(raw)) return {};
  const out: Record<string, SortPref> = {};
  for (const [scope, value] of Object.entries(raw)) {
    if (!isRecord(value)) continue;
    if (!isSortModeId(value.mode) || !isSortDirection(value.direction)) continue;
    out[scope] = { mode: value.mode, direction: value.direction };
  }
  return out;
}

/**
 * `version: 2` — R4a added `sort` beside `groupBy`. In place, per the note on the key above:
 * a build that predates this reads the payload, finds the `groupBy` it understands, and
 * ignores a field it has never heard of, which is exactly the behaviour a v1 reader has.
 */
export function encodeViewPrefs(prefs: ViewPrefs): string {
  return JSON.stringify({ version: 2, groupBy: prefs.groupBy, sort: prefs.sort });
}

/**
 * Never throws. Safari private mode makes `getItem` itself throw, and a tracker that will not
 * render because it could not read a layout preference is a worse failure than one that opens
 * flat.
 */
export function loadViewPrefs(storage: Storage): ViewPrefs {
  try {
    return decodeViewPrefs(storage.getItem(VIEW_PREFS_STORAGE_KEY));
  } catch {
    return defaultViewPrefs();
  }
}

export function saveViewPrefs(storage: Storage, prefs: ViewPrefs): void {
  try {
    storage.setItem(VIEW_PREFS_STORAGE_KEY, encodeViewPrefs(prefs));
  } catch {
    // A full or blocked storage must not take the page down with it. The preference is
    // lost on reload and nothing else is.
  }
}

/** The label the control's trigger shows. */
export function groupByLabel(groupBy: GroupBy): string {
  return GROUP_BY_OPTIONS.find((option) => option.id === groupBy)?.label ?? "No grouping";
}
