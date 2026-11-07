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

export interface HorizonData {
  id: string;
  identifier: string;
  name: string;
  date: string | null;
  rank: number;
  ideaCount: number;
  lateCount: number;
  late: boolean;
}

export interface IdeaData {
  id: string;
  identifier: string;
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
  linkCount: number;
  resolvedLinks: number;
  progress: number | null;
  actual: ActualWindow;
  late: boolean;
  childIds: string[];
  openQuestions: number;
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

export interface IdeaDetailData {
  idea: IdeaData;
  parent: { id: string; identifier: string; title: string } | null;
  children: IdeaData[];
  horizon: HorizonData | null;
  brief: string | null;
  questions: Array<{ text: string; resolved: boolean }>;
  decisions: string[];
  linked: LinkData[];
  today: string;
}

/** What every plan write answers: the whole plan, and the idea's detail when it named one. */
export interface PlanWriteResult {
  plan: PlanData;
  idea: IdeaDetailData | null;
}
