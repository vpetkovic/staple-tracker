/**
 * The plan's lifecycle table (design/plan.md, "Lifecycle"): the states, the actions, which
 * actions each state offers and who may take them. Pure data and pure functions with no imports,
 * so the page's tests read the very table the store enforces. The refusals are `plan-lifecycle.ts`.
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
  drop: { label: "Drop", verb: "dropped", who: "person" },
  restore: { label: "Restore", verb: "restored", who: "person" },
  schedule: { label: "Schedule on a horizon", verb: "scheduled", who: "person" },
  plan_dates: { label: "Plan dates", verb: "given planned dates", who: "person" },
  reorder: { label: "Reorder", verb: "reordered", who: "person" },
  reparent: { label: "Move under another idea", verb: "moved under another idea", who: "person" },
  promote: { label: "Promote to epic", verb: "promoted", who: "anyone" },
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
 * linked to existing work. Started (promoted, or linked to work) is re-planned, not re-shaped,
 * and never promoted again. Shipped offers no edits: only linking more work (history that landed
 * elsewhere, or new work, which reopens it) and opening the epic. Dropped can only be restored.
 */
export const IDEA_LIFECYCLE: Readonly<Record<IdeaState, readonly IdeaAction[]>> = {
  raw: ["edit", "ask", "decide", "explore", "shape", "drop", "reparent", "reorder"],
  exploring: ["edit", "ask", "decide", "shape", "drop", "schedule", "plan_dates", "reparent", "reorder"],
  shaped: ["edit", "ask", "decide", "unshape", "drop", "schedule", "plan_dates", "reparent", "reorder", "promote", "adopt"],
  started: ["edit", "ask", "decide", "schedule", "plan_dates", "reorder", "adopt", "unlink", "reset_baseline", "open_epic"],
  shipped: ["adopt", "open_epic"],
  dropped: ["restore"],
};

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
 * Which maturity action a maturity change is, from where it stands: to exploring is exploring
 * from raw, going back from shaped and restoring from dropped. Null when it is not a change, or
 * a change no action makes (back to raw).
 */
export function maturityAction(from: IdeaState, to: string): IdeaAction | null {
  if (from === "dropped") return to === "dropped" ? null : "restore";
  if (to === "dropped") return "drop";
  if (to === "shaped") return from === "shaped" ? null : "shape";
  if (to === "exploring") return from === "raw" ? "explore" : from === "shaped" ? "unshape" : from === "exploring" ? null : "explore";
  if (to === "raw") return from === "raw" ? null : "explore";
  return null;
}

export function ideaOffers(state: IdeaState, action: IdeaAction): boolean {
  return IDEA_LIFECYCLE[state].includes(action);
}

export function horizonOffers(state: HorizonState, action: HorizonAction): boolean {
  return HORIZON_LIFECYCLE[state].includes(action);
}

