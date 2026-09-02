/**
 * How much of the row a container can afford — R4 (STA-102).
 *
 * ── THE RULE THIS FILE EXISTS TO ENFORCE ──────────────────────────────────────────────
 *
 * A narrower container gets a NARROWER COLUMN SET. It never gets a fork of the row. The
 * moment "the palette version of the row" is a second component, the two drift, and the
 * drift is always in the same direction: the copy stops getting the fixes. So every
 * consumer renders `TaskRowLine`, and the only thing that varies is this config.
 *
 * ── WHY TWO AXES AND NOT ONE ──────────────────────────────────────────────────────────
 *
 * DENSITY is about the box: row height, id width, font sizes. It is a CSS custom-property
 * swap on the list root, so there is exactly one set of rules and two sets of numbers — a
 * change to the row cannot land in one density and miss the other.
 *
 * COLUMNS is about content: which of the thirteen elements are on the row at all. It is
 * separate from density because they genuinely vary independently — the detail panel wants
 * compact rows WITH the working pill, the palette wants compact rows WITHOUT it, and a
 * future wide "compact mode" for the tree would want compact rows with everything.
 *
 * ── COLUMN DEFAULTS FOLLOW ROW SPEC §14, NOT TASTE ────────────────────────────────────
 *
 * §14 fixes the order in which right-side elements drop, least diagnostic first:
 *
 *     date -> label NAMES (pills become dots) -> PR number -> working-pill TEXT
 *
 * and names five that are never dropped at any width: priority glyph, identifier, status
 * icon, title, assignee avatar. The presets below drop a PREFIX of that order and keep all
 * five, which is why they can be read as one system rather than three opinions. A preset
 * that dropped the status icon would be a bug against the spec, and `NEVER_DROPPED` is
 * asserted in the tests so it stays one.
 */

export type TaskListDensity = "comfortable" | "compact";

/**
 * THE ONE LINE — R2 (STA-101).
 *
 * The left-gutter checkbox is an affordance for bulk actions that do not exist yet. It
 * revealed on hover on every row, held 32px of permanent gutter (a 24px track plus its gap)
 * on a list whose title column is the one element that always wants more, and clicking it
 * did nothing a user could then act on. A control that promises an action the app cannot
 * perform is worse than no control.
 *
 * What is NOT deleted is the selection MODEL: the set of selected ids in TreeGrid, Space to
 * toggle, Shift+Arrow to extend, Escape to clear, `aria-selected` on the row and the
 * `--surface-selected` background that makes it visible. That machinery is correct and
 * tested, it is exactly what a bulk-actions epic will build on, and deleting it now to
 * rewrite it later is the expensive way to save nothing.
 *
 * Flip this to `true` and the gutter returns everywhere it ever was. `TREE_COLUMNS` below
 * references it rather than restating `false`, and a test asserts that it does — so the
 * constant cannot quietly become decorative while a hardcoded literal sits beside it.
 */
export const SHOW_ROW_CHECKBOXES = false;

/**
 * One switch per optional element. `false` means ABSENT FROM THE DOM, not hidden — a
 * reserved invisible box in a 420px drawer is width stolen from the title, and it is the
 * failure mode the PR-badge slot was written to avoid in the first place.
 */
export interface TaskListColumns {
  /** Left-gutter multi-select checkbox. Gated by `SHOW_ROW_CHECKBOXES` — see STA-101. */
  select: boolean;
  /** Chevron + connector rails. A flat list has nothing to disclose. */
  disclosure: boolean;
  priority: boolean;
  identifier: boolean;
  status: boolean;
  /**
   * The workspace slug, as a pill before the title.
   *
   * STA-97 §6.3 asked for a 3-char workspace chip on the TREE row and V5 dropped it,
   * correctly: it rendered `STA STA-22`, because a staple identifier already begins with
   * the workspace's prefix. This is a different element for a different reason. It carries
   * the workspace SLUG (`staple`, `workshop`), which is not recoverable from the prefix —
   * prefixes are three letters and two workspaces may share one — and it is only ever on
   * in a surface that mixes workspaces without a heading to say so. That is exactly the
   * command palette (STA-105), and nothing else today.
   */
  workspace: boolean;
  labels: boolean;
  /**
   * The worklog freshness cue — W4 (STA-116), STA-108 spec §3 option C.
   *
   * The only element on the row that answers "can someone else pick this up". It is NOT
   * a second reading of liveness: `claim` below owns the four claim states, and this sits
   * beside it carrying the orthogonal fact of whether a handoff was ever written down.
   *
   * ON in `tree`, OFF in `popup` and OFF BY DEFAULT in `panel`, and each of those three
   * has its own reason rather than being a taste call — see the preset table below. It
   * deliberately does NOT join `NEVER_DROPPED`: §14 gives it a drop position between the
   * PR number and the working-pill text, which is where task-list.css drops it.
   */
  worklog: boolean;
  /** The live "Working…" pill / stale badge / held pill cluster. */
  claim: boolean;
  assignee: boolean;
  date: boolean;
  pr: boolean;
  /** The trailing `⋯`. Pointless where the whole row is already a single-purpose target. */
  actions: boolean;
}

/**
 * What §14 says survives at every width: the priority glyph, the identifier, the status
 * icon, the title, the assignee avatar and the working pill's dot. Title is not listed
 * because it is not optional — there is no switch for it.
 *
 * Not enforced at runtime; a preset is a literal, and a test is the right place to catch a
 * literal that got it wrong. `task-list.test.tsx` asserts every preset against this, which
 * is what stops "the palette one can lose the status icon, it's only a popup" from ever
 * being a five-second decision.
 */
export const NEVER_DROPPED = ["priority", "identifier", "status", "assignee", "claim"] as const;

export type TaskListPreset = "tree" | "panel" | "popup";

interface PresetShape {
  density: TaskListDensity;
  columns: TaskListColumns;
  /** How many label pills fit before the `+N`. 0 degrades to the dot cluster. */
  labelMax: number;
}

const TREE_COLUMNS: TaskListColumns = {
  select: SHOW_ROW_CHECKBOXES,
  disclosure: true,
  priority: true,
  identifier: true,
  status: true,
  workspace: false,
  labels: true,
  worklog: true,
  claim: true,
  assignee: true,
  date: true,
  pr: true,
  actions: true,
};

/**
 * The three shipped containers.
 *
 *   tree  — the full row, 36px, exactly what STA-97 shipped except for the checkbox gutter,
 *           which R2 (STA-101) switched off at `SHOW_ROW_CHECKBOXES`. The baseline; the other
 *           two are stated as departures FROM it rather than as independent lists, so a new
 *           element added to the row shows up here first and is then explicitly kept or
 *           dropped in the narrow presets instead of being silently absent from both.
 *   panel — the detail view's children list. ~420px of drawer. §14 order says the date
 *           goes first, then the PR number, then the worklog cue; the working pill stays
 *           because "is an agent on this child right now" is the single most useful thing
 *           an epic's children list can tell you, and labels degrade to dots rather than
 *           disappearing. The cue is off BY DEFAULT rather than forbidden: an epic reader
 *           is asking about status, not about handoff, and 420px has no room to answer a
 *           question nobody asked — but a caller who does want it can override it on.
 *   popup — command palette results. Narrower still and, crucially, MIXED WORKSPACE, so
 *           the workspace pill comes ON as the optional right-hand metadata goes off. It
 *           drops §14's order one step further than `panel` — the labels go entirely
 *           rather than degrading to dots — because a palette row is read in under a
 *           second on the way to pressing enter, and a colour with no name to anchor it is
 *           not readable in that second. The worklog cue goes for the same reason, and for
 *           one more: the handoff filter that will eventually feed this list (§3F) selects
 *           FOR stale worklogs, so every result would carry an identical glyph and the
 *           column would be a column of noise. What it does NOT drop is the never-drop set: the
 *           assignee avatar and the working pill stay, because "someone already has this"
 *           is the single most valuable thing a search result can tell you before you
 *           open it.
 */
export const TASK_LIST_PRESETS: Record<TaskListPreset, PresetShape> = {
  tree: {
    density: "comfortable",
    columns: TREE_COLUMNS,
    labelMax: 2,
  },
  panel: {
    density: "compact",
    columns: {
      ...TREE_COLUMNS,
      select: false,
      disclosure: false,
      date: false,
      pr: false,
      worklog: false,
      actions: false,
    },
    labelMax: 0,
  },
  popup: {
    density: "compact",
    columns: {
      ...TREE_COLUMNS,
      select: false,
      disclosure: false,
      workspace: true,
      labels: false,
      date: false,
      pr: false,
      worklog: false,
      actions: false,
    },
    labelMax: 0,
  },
};

export interface TaskListConfig extends PresetShape {}

/**
 * A preset plus per-call overrides.
 *
 * The overrides are not a loophole — the tree needs one: its label capacity is a live
 * measurement of the viewport (§14 cannot be done in CSS, because the `+N` changes with the
 * cap and no media query can recount), so it passes `labelMax` every render.
 */
export function resolveTaskListConfig(
  preset: TaskListPreset,
  over?: { density?: TaskListDensity; columns?: Partial<TaskListColumns>; labelMax?: number },
): TaskListConfig {
  const base = TASK_LIST_PRESETS[preset];
  return {
    density: over?.density ?? base.density,
    columns: over?.columns ? { ...base.columns, ...over.columns } : base.columns,
    labelMax: over?.labelMax ?? base.labelMax,
  };
}
