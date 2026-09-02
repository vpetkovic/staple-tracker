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
export type GroupBy = "none" | "status" | "pickup" | "parent";

/**
 * The dimensions offered, in menu order. A registry rather than a switch, so a third entry
 * appears in the menu, in the trigger label and in the persistence validator with no edit to
 * any of them — the same trick `FILTER_DIMENSIONS` plays in lib/filters.ts.
 *
 * A NEW DIMENSION APPENDS. O3d (STA-129) added `parent` at the end rather than beside
 * `status` where it arguably belongs by kinship, and O1c (STA-130) will append `kind` after
 * it. Registry order IS menu order, so inserting moves every entry below the insertion
 * point — and the three that exist today are a year of muscle memory for anyone who has
 * used the control. Kinship is not worth a menu that reshuffles under the pointer.
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

export interface ViewPrefs {
  groupBy: GroupBy;
}

export function defaultViewPrefs(): ViewPrefs {
  return { groupBy: DEFAULT_GROUP_BY };
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
  return { groupBy: isGroupBy(parsed.groupBy) ? parsed.groupBy : DEFAULT_GROUP_BY };
}

export function encodeViewPrefs(prefs: ViewPrefs): string {
  return JSON.stringify({ version: 1, groupBy: prefs.groupBy });
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
