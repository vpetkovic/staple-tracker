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
  /** Null only on a `classify` step of a record no horizon carries. */
  horizonId: string | null;
  state: IdeaState;
  need: "answer_questions" | "write_plan" | "mark_shaped" | "fix_plan" | "wait" | "scaffold" | "brainstorm" | "classify";
  who: "person" | "agent" | "nobody";
  instruction: string;
  questions?: string[];
  missing?: string[];
  waitingOn?: { start?: string; records?: Array<{ id: string; title: string; state: IdeaState }>; parents?: Array<{ id: string; title: string; maturity: Maturity }> };
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
  /** What its planned work still needs, in plan order; [] when nothing does. */
  planSteps: PlanStepData[];
  /** How many of those steps wait on the person: the "Needs you" its header prints. */
  needsYou: number;
}

export interface IdeaData {
  id: string;
  /** The ticket number once promoted; null while it is an idea, which has none. */
  identifier: string | null;
  /** Its permanent idea number, `I-<PREFIX>-<n>`, before and after promotion; null only on a record an earlier build left unnumbered. */
  number: string | null;
  /** Promoted in place: the record is an epic in the tracker now. */
  promoted: boolean;
  kind: string;
  title: string;
  description: string | null;
  /** The brief's first written line; null while it has none. */
  briefLine: string | null;
  maturity: Maturity;
  stage: Stage;
  parentId: string | null;
  horizonId: string | null;
  planned: PlanWindow;
  baseline: PlanWindow | null;
  rank: number;
  links: string[];
  /** Research and proofs of concept it links: shown on their own, never measured. */
  explorations: string[];
  missingLinks: string[];
  linkCount: number;
  resolvedLinks: number;
  /** Its rollup's work items, its sub-ideas' planned rows included. */
  units: PlanUnits;
  /** Its own size is unknown: no work, no rows, no sub-ideas. */
  unsized: boolean;
  /** Its own work items, without its sub-ideas': what a leaf's row in the tree draws. */
  own: PlanUnits;
  /** No own work, over sub-ideas that carry its size. */
  umbrella: boolean;
  /** The horizon that carries it: the one it is scheduled on, else its nearest scheduled parent's; null for none. */
  carriedBy: string | null;
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
  /** The records it waits on: those it is blocked by, then those its plan's text names. */
  dependsOn: string[];
  /** The plan records it is blocked by (its structured edges), by id. */
  blockedBy: string[];
  /**
   * What holds Scaffold and Promote back: the ideas above it not shaped, and the blockers (its own
   * and its ancestors') not shipped; null when nothing does. On a promoted record, the flag that an
   * idea above it went back to exploring or was dropped.
   */
  heldBy: IdeaHold | null;
  state: IdeaState;
  actions: OfferedAction[];
  /** An agent's standing proposal that it is ready to be marked shaped: who, when and why. The person accepts it with Mark shaped. */
  shapeProposal: { by: string | null; at: string; note: string | null } | null;
  /** What it needs next from planning while a horizon carries it; else null. */
  nextStep: PlanStepData | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdeaHold {
  parents: Array<{ id: string; title: string; maturity: Maturity }>;
  blockers: Array<{ id: string; title: string; state: IdeaState }>;
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
  /** Its research and proofs of concept: its own list, nothing it is measured by. */
  exploration: LinkData[];
  plan: PlanSections;
  completeness: { starred: number; starredTotal: number; filled: number; total: number };
  missingForShaped: string[];
  planWarnings: string[];
  breakdownRevision: string;
  scaffold: ScaffoldPreviewData | null;
  /** The records it is blocked by, named; one this device no longer holds is `missing`. Absent from an older server. */
  blockedBy?: BlockerRefData[];
  /** The records blocked by it. Absent from an older server. */
  blocks?: BlockerRefData[];
  today: string;
}

/** A plan record one is blocked by, or that it blocks (`core/plan-store.ts`, BlockerRef). */
export interface BlockerRefData {
  id: string;
  number: string | null;
  identifier: string | null;
  title: string;
  state: IdeaState | null;
  missing: boolean;
}

/** A hold in a few words, as the CLI prints it: `waiting on parent`, `waiting on blockers`. */
export function holdLabel(hold: IdeaHold): string {
  if (hold.parents.length > 0) return hold.parents.length === 1 ? "waiting on parent" : "waiting on parents";
  return hold.blockers.length === 1 ? "waiting on blocker" : "waiting on blockers";
}

/** What a hold waits on, for a tooltip or a sentence: `SSO (exploring)`. */
export function holdNames(hold: IdeaHold): string {
  return [...hold.parents.map((parent) => `${parent.title} (${parent.maturity})`), ...hold.blockers.map((blocker) => `${blocker.title} (${blocker.state})`)].join(", ");
}

/**
 * The chip a record wears for its hold: a shaped one reads `waiting on parent` (or on its
 * blockers); a promoted one under an idea that went back to exploring or was dropped is flagged
 * `parent not shaped`. Null when it wears none.
 */
export function holdChip(idea: Pick<IdeaData, "state" | "heldBy">): string | null {
  if (!idea.heldBy) return null;
  if (idea.state === "shaped") return holdLabel(idea.heldBy);
  if (idea.state === "started" && idea.heldBy.parents.length > 0) return "parent not shaped";
  return null;
}

/** What every plan write answers: the whole plan, and the idea's detail when it named one. */
export interface PlanWriteResult {
  plan: PlanData;
  idea: IdeaDetailData | null;
}

/** What a discovered plan file is to the tracker (`PlanFileState` in plan-store.ts). */
export type PlanFileState = "new" | "imported" | "changed" | "ignored";

/** The idea a plan file was imported as. */
export interface PlanFileIdea {
  id: string;
  number: string | null;
  identifier: string | null;
  title: string;
}

/** One plan file under the workspace root (`PlanFileView`): a file, or a folder with assets imported as one. */
export interface PlanFileData {
  path: string;
  kind: "file" | "folder";
  main: string;
  files: string[];
  format: "markdown" | "html" | "jsx";
  title: string;
  status: string | null;
  done: boolean;
  hash: string;
  bytes: number;
  problem: string | null;
  state: PlanFileState;
  idea: PlanFileIdea | null;
  /** An idea came from this path and the file has changed since (an ignored file can be both). */
  changedSinceImport: boolean;
  /** Other ideas imported from the same file as it stands. */
  alsoImportedAs: PlanFileIdea[];
}

/** The Plan files tray (`PlanFilesView`): where it looks, what it found, how many of each. */
export interface PlanFilesData {
  paths: string[];
  files: PlanFileData[];
  truncated: boolean;
  counts: Record<PlanFileState, number>;
  unavailable: string | null;
}

/** What an import or an ignore from the tray answers: the plan, and the tray as it now reads. */
export interface PlanFilesWriteResult extends PlanWriteResult {
  files: PlanFilesData;
  imported?: Array<{ path: string; idea: PlanFileIdea }>;
}

/**
 * Whether a reference names this record by its idea number: `I-STA-12` in any case, or the short
 * `I-12` its own workspace takes (`src/core/idea-numbers.ts`).
 */
export function namesIdeaNumber(idea: Pick<IdeaData, "number">, ref: string): boolean {
  if (idea.number === null) return false;
  const wanted = ref.trim().toUpperCase();
  if (wanted === idea.number) return true;
  const short = /^I-(\d+)$/.exec(wanted);
  return short !== null && idea.number.endsWith(`-${Number(short[1])}`);
}
