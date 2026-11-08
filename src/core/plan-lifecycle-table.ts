/**
 * The plan's lifecycle table (design/plan.md, "Lifecycle"): the states, the actions, which
 * actions each state offers and who may take them. Pure data and pure functions with no imports,
 * so the page and its tests read the very table the store enforces. The refusals are `plan-lifecycle.ts`.
 */
export const IDEA_STATES = ["raw", "exploring", "shaped", "started", "shipped", "dropped"] as const;
export type IdeaState = (typeof IDEA_STATES)[number];

export const HORIZON_STATES = ["planned", "active", "shipped"] as const;
export type HorizonState = (typeof HORIZON_STATES)[number];

/** Who may take an action: anyone (an agent included), or only the person. */
export type Who = "anyone" | "person";

export interface ActionRule {
  /** What the person reads on a button or a menu item. */
  label: string;
  /** What it does, in the words a refusal uses ("cannot be <verb>"). */
  verb: string;
  who: Who;
}

export const IDEA_ACTIONS = {
  edit: { label: "Edit title and brief", verb: "edited", who: "anyone" },
  ask: { label: "Ask a question", verb: "given questions", who: "anyone" },
  decide: { label: "Record a decision", verb: "given decisions", who: "anyone" },
  explore: { label: "Start exploring", verb: "moved to exploring", who: "person" },
  shape: { label: "Mark shaped", verb: "marked shaped", who: "person" },
  unshape: { label: "Back to exploring", verb: "moved back to exploring", who: "person" },
  /** No state offers it: an idea is refined forward from raw and never goes back there. */
  back_to_raw: { label: "Back to raw", verb: "moved back to raw", who: "person" },
  drop: { label: "Drop", verb: "dropped", who: "person" },
  restore: { label: "Restore", verb: "restored", who: "person" },
  schedule: { label: "Schedule on a horizon", verb: "scheduled", who: "person" },
  plan_dates: { label: "Plan dates", verb: "given planned dates", who: "person" },
  reorder: { label: "Reorder", verb: "reordered", who: "person" },
  reparent: { label: "Move under another idea", verb: "moved under another idea", who: "person" },
  promote: { label: "Promote to epic", verb: "promoted", who: "anyone" },
  scaffold: { label: "Scaffold epic and tasks", verb: "scaffolded", who: "anyone" },
  adopt: { label: "Adopt existing work", verb: "linked to work", who: "anyone" },
  unlink: { label: "Unlink work", verb: "unlinked from work", who: "anyone" },
  reset_baseline: { label: "Reset baseline to the plan", verb: "re-baselined", who: "person" },
  open_epic: { label: "Open the epic", verb: "opened as an epic", who: "anyone" },
} as const satisfies Record<string, ActionRule>;
export type IdeaAction = keyof typeof IDEA_ACTIONS;
export const IDEA_ACTION_IDS = Object.keys(IDEA_ACTIONS) as IdeaAction[];

/**
 * The idea table. Raw is captured thinking: it is refined, explored, shaped or dropped, never
 * scheduled or promoted while it is raw. Exploring may reserve a horizon slot. Shaped is ready: it is scheduled, promoted or
 * linked to existing work, or scaffolded: promoted with its task breakdown as the epic's tasks.
 * Started (promoted, or linked to work) is re-planned, not re-shaped, and never promoted again;
 * one that was scaffolded scaffolds again only to add the rows written since. Shipped offers no edits: only linking more work (history that landed
 * elsewhere, or new work, which reopens it) and opening the epic. Dropped can only be restored.
 *
 * A state is the record's own: its maturity, its own promotion and its own links. Work under its
 * sub-ideas is a rollup the record displays, and never moves it from one row to another.
 */
export const IDEA_LIFECYCLE: Readonly<Record<IdeaState, readonly IdeaAction[]>> = {
  raw: ["edit", "ask", "decide", "explore", "shape", "drop", "reparent", "reorder"],
  exploring: ["edit", "ask", "decide", "shape", "drop", "schedule", "plan_dates", "reparent", "reorder"],
  shaped: ["edit", "ask", "decide", "unshape", "drop", "schedule", "plan_dates", "reparent", "reorder", "promote", "scaffold", "adopt"],
  started: ["edit", "ask", "decide", "schedule", "plan_dates", "reorder", "scaffold", "adopt", "unlink", "reset_baseline", "open_epic"],
  shipped: ["adopt", "open_epic"],
  dropped: ["restore"],
};

/**
 * A promoted record is an ordinary epic: its title, brief and documents are edited as any epic's,
 * whatever its plan state. These it offers in every state it reaches, on top of the state's row.
 */
export const PROMOTED_ALWAYS: readonly IdeaAction[] = ["edit", "ask", "decide"];

/** What a record offers: its state's row, and for a promoted record the epic's own edits. */
export function ideaOffered(state: IdeaState, promoted = false): readonly IdeaAction[] {
  const row = IDEA_LIFECYCLE[state];
  return promoted ? [...row, ...PROMOTED_ALWAYS.filter((id) => !row.includes(id))] : row;
}

export const HORIZON_ACTIONS = {
  rename: { label: "Rename", verb: "renamed", who: "person" },
  date: { label: "Set the date", verb: "dated", who: "person" },
  reorder: { label: "Reorder", verb: "reordered", who: "person" },
  remove: { label: "Remove", verb: "removed", who: "person" },
  queue: { label: "Queue the horizon", verb: "queued", who: "anyone" },
} as const satisfies Record<string, ActionRule>;
export type HorizonAction = keyof typeof HORIZON_ACTIONS;
export const HORIZON_ACTION_IDS = Object.keys(HORIZON_ACTIONS) as HorizonAction[];

/**
 * The horizon table. Planned holds no open work: it is defined and may be removed (a person's
 * removal is the only way a horizon is cancelled), but there is nothing to queue. Active holds
 * open work: it is queued, and it stays while it holds that work. Shipped (its milestone is
 * done) is only removed, by a person, once nothing is left to do in it.
 */
export const HORIZON_LIFECYCLE: Readonly<Record<HorizonState, readonly HorizonAction[]>> = {
  planned: ["rename", "date", "reorder", "remove"],
  active: ["rename", "date", "reorder", "queue"],
  shipped: ["remove"],
};

/** A record's state from its derived stage: a scheduled idea is in the state of its maturity. */
export function ideaState(view: { stage: string; maturity: string }): IdeaState {
  const state = view.stage === "scheduled" ? view.maturity : view.stage;
  return (IDEA_STATES as readonly string[]).includes(state) ? (state as IdeaState) : "raw";
}

/** A horizon's state: shipped once its milestone is done, active while it holds open work, planned otherwise. */
export function horizonState(view: { shipped: boolean; openWork: number }): HorizonState {
  if (view.shipped) return "shipped";
  return view.openWork > 0 ? "active" : "planned";
}

/**
 * Which action a maturity change is, from where the record stands: null when the maturity is the
 * one it already has (a no-op, whatever the state). Out of dropped it is restoring; to exploring
 * it is going back from shaped and exploring otherwise; to raw it is going back to raw, which no
 * state offers.
 */
export function maturityAction(record: { state: IdeaState; maturity: string }, to: string): IdeaAction | null {
  if (to === record.maturity) return null;
  if (record.state === "dropped") return "restore";
  if (to === "dropped") return "drop";
  if (to === "shaped") return "shape";
  if (to === "exploring") return record.maturity === "shaped" ? "unshape" : "explore";
  if (to === "raw") return "back_to_raw";
  return null;
}

export function ideaOffers(state: IdeaState, action: IdeaAction, promoted = false): boolean {
  return ideaOffered(state, promoted).includes(action);
}

export function horizonOffers(state: HorizonState, action: HorizonAction): boolean {
  return HORIZON_LIFECYCLE[state].includes(action);
}

