/**
 * The plan layer as the page reads it: a hand mirror of `PlanView`, `IdeaView`,
 * `HorizonView` and `IdeaDetail` in `src/core/plan-store.ts` (the app does not import from
 * the core, as it mirrors the milestone types).
 */
export type Maturity = "raw" | "exploring" | "shaped" | "dropped";
export type Stage = "raw" | "exploring" | "shaped" | "scheduled" | "started" | "shipped" | "dropped";

export interface PlanWindow {
  start: string | null;
  target: string | null;
}

export interface ActualWindow {
  start: string | null;
  end: string | null;
  forecastEnd: string | null;
}

/** The lifecycle states (`src/core/plan-lifecycle.ts`). */
export type IdeaState = "raw" | "exploring" | "shaped" | "started" | "shipped" | "dropped";
export type HorizonState = "planned" | "active" | "shipped";

/**
 * One action a record's lifecycle state offers, as the server computed it from the core table.
 * The page renders these and nothing else: it never decides on its own what a state allows.
 */
export interface OfferedAction {
  id: string;
  label: string;
  who: "anyone" | "person";
  /** Offered in this state but cannot run yet, and why. */
  disabledReason?: string;
}

/** One plan step as the server derives it (`src/core/plan-steps.ts`): what a record needs next, and who acts. */
export interface PlanStepData {
  ideaId: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  horizonId: string;
  state: IdeaState;
  need: "answer_questions" | "write_plan" | "mark_shaped" | "fix_plan" | "wait" | "scaffold" | "brainstorm";
  who: "person" | "agent" | "nobody";
  instruction: string;
  questions?: string[];
  missing?: string[];
  waitingOn?: { start?: string; records?: Array<{ id: string; title: string; state: IdeaState }> };
}

/** Work items as the server counts them (`plan-accounting.ts`). */
export interface PlanUnits {
  done: number;
  open: number;
  planned: number;
  total: number;
}

export interface HorizonData {
  id: string;
  identifier: string;
  name: string;
  date: string | null;
  rank: number;
  /** The milestone's status; a horizon is a milestone. */
  status: string;
  /** Its milestone is done: every member landed and nothing on its plan holds it. What folds its column. */
  shipped: boolean;
  memberCount: number;
  ideaCount: number;
  lateCount: number;
  notStartedCount: number;
  /** Records on it whose work has all landed. */
  shippedCount: number;
  /** Its work items: ticket leaves done and open, and its ideas' breakdown rows with no tickets yet. */
  units: PlanUnits;
  /** Ideas it carries with nothing to count yet. */
  unsizedCount: number;
  /** The leaf ideas it carries by state, and the parents among them: what its counts print. */
  records: { leaves: number; shipped: number; started: number; shaped: number; exploring: number; raw: number; parentCount: number };
  /** Done units over all its units, 0..1; null while it has none. */
  progress: number | null;
  /** The server's whole percent of its units, rounded down: what the page prints. */
  percent: number | null;
  /** All its units are done and nothing on its plan holds it. A 100 that is not complete says so. */
  complete: boolean;
  /** How far agents take it when they pick its work up; null until the person sets it. */
  runMode: "work" | "goal" | "epic" | null;
  /** Its goal: the milestone's acceptance criteria. */
  goal: string[];
  /** Its close waits for the person's approval. */
  awaitingApproval: boolean;
  late: boolean;
  state: HorizonState;
  actions: OfferedAction[];
}

export interface IdeaData {
  id: string;
  /** The ticket number once promoted; null while it is an idea, which has none. */
  identifier: string | null;
  /** Promoted in place: the record is an epic in the tracker now. */
  promoted: boolean;
  kind: string;
  title: string;
  description: string | null;
  maturity: Maturity;
  stage: Stage;
  parentId: string | null;
  horizonId: string | null;
  planned: PlanWindow;
  baseline: PlanWindow | null;
  rank: number;
  links: string[];
  missingLinks: string[];
  linkCount: number;
  resolvedLinks: number;
  /** Its rollup's work items, its sub-ideas' planned rows included. */
  units: PlanUnits;
  /** Its own size is unknown: no work, no rows, no sub-ideas. */
  unsized: boolean;
  /** Done units over its rollup's units; null before any of its work is started. */
  progress: number | null;
  /** The server's whole percent of its rollup's units, rounded down; null with `progress`. */
  percent: number | null;
  actual: ActualWindow;
  late: boolean;
  notStarted: boolean;
  /** The person's mark that it was delivered outside the tracker: the day (its actual end) and the note. */
  delivered: { on: string; note: string | null } | null;
  childIds: string[];
  openQuestions: number;
  /** A shaped plan that no longer passes the shaped gate: what it lacks. Scaffold and Promote wait for it. */
  planIncomplete: string[];
  /** Written sections and dependencies, derived by the server from the plan. */
  completeness: { starred: number; starredTotal: number; filled: number; total: number };
  dependsOn: string[];
  state: IdeaState;
  actions: OfferedAction[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanData {
  enabled: boolean;
  today: string;
  horizons: HorizonData[];
  ideas: IdeaData[];
}

export interface LinkData {
  missing: boolean;
  id: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  resolved: boolean;
  leaves: number;
  doneLeaves: number;
  progress: number;
  /** The server's whole percent of its leaves, rounded down. */
  percent: number;
  startedAt: string | null;
  completedAt: string | null;
  milestone: { identifier: string; title: string; state: string; run: { state: string; actor: string } | null } | null;
}

/** One task breakdown row (`src/core/plan-sections.ts`). */
export interface BreakdownRow {
  /** Stable for the row's life; a new row in the editor has none until it is saved. */
  id?: string;
  key: string;
  title: string;
  estimate: string | null;
  dependsOn: string[];
  acceptance: string | null;
  owner: string | null;
  notes: string | null;
}

/** An idea's plan sections, mirrored from `PlanSections`. */
export interface PlanSections {
  goal: string | null;
  context: string | null;
  breakdown: BreakdownRow[];
  acceptance: string[];
  dependencies: string[];
  outOfScope: string | null;
  risks: string | null;
  sources: string[];
}

export interface ScaffoldTaskData {
  rowId: string;
  key: string;
  title: string;
  estimate: string | null;
  estimatedSeconds: number | null;
  estimateWarning: string | null;
  blockedBy: string[];
  waitsOutside: string[];
  acceptance: string[];
  acceptanceInherited: boolean;
  context: string;
  existing: string | null;
}

export interface ScaffoldPreviewData {
  idea: { id: string; title: string };
  epic: { identifier: string | null; kind: string; planDocument: string; acceptance: string[]; promoted: boolean };
  tasks: ScaffoldTaskData[];
  children: ScaffoldPreviewData[];
  problems: string[];
  warnings: string[];
  fingerprint: string;
}

export interface IdeaDetailData {
  idea: IdeaData;
  parent: { id: string; identifier: string | null; title: string } | null;
  children: IdeaData[];
  horizon: HorizonData | null;
  brief: string | null;
  questions: Array<{ text: string; resolved: boolean; deferred?: boolean }>;
  decisions: string[];
  linked: LinkData[];
  plan: PlanSections;
  completeness: { starred: number; starredTotal: number; filled: number; total: number };
  missingForShaped: string[];
  planWarnings: string[];
  breakdownRevision: string;
  scaffold: ScaffoldPreviewData | null;
  today: string;
}

/** What every plan write answers: the whole plan, and the idea's detail when it named one. */
export interface PlanWriteResult {
  plan: PlanData;
  idea: IdeaDetailData | null;
}
