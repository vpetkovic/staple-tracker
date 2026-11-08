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

export interface HorizonData {
  id: string;
  identifier: string;
  name: string;
  date: string | null;
  rank: number;
  /** The milestone's status; a horizon is a milestone. */
  status: string;
  /** Its derived done: every member landed. */
  shipped: boolean;
  memberCount: number;
  ideaCount: number;
  lateCount: number;
  notStartedCount: number;
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
  progress: number | null;
  actual: ActualWindow;
  late: boolean;
  notStarted: boolean;
  childIds: string[];
  openQuestions: number;
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
  startedAt: string | null;
  completedAt: string | null;
  milestone: { identifier: string; title: string; state: string; run: { state: string; actor: string } | null } | null;
}

/** One task breakdown row (`src/core/plan-sections.ts`). */
export interface BreakdownRow {
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
  key: string;
  title: string;
  estimate: string | null;
  estimatedSeconds: number | null;
  blockedBy: string[];
  waitsOutside: string[];
  acceptance: string[];
  context: string;
  existing: string | null;
}

export interface ScaffoldPreviewData {
  idea: { id: string; title: string };
  epic: { identifier: string | null; kind: string; planDocument: string; acceptance: string[]; promoted: boolean };
  tasks: ScaffoldTaskData[];
  children: ScaffoldPreviewData[];
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
  scaffold: ScaffoldPreviewData | null;
  today: string;
}

/** What every plan write answers: the whole plan, and the idea's detail when it named one. */
export interface PlanWriteResult {
  plan: PlanData;
  idea: IdeaDetailData | null;
}
