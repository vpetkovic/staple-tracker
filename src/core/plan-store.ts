/**
 * The plan layer in the store: the database half of `design/plan.md`.
 *
 * A plan record is an issue with a maturity: an idea (kind `idea`, a draft identifier, no ticket
 * number) or an idea the person promoted in place into an epic (a real number, the same row). A
 * horizon is a milestone with a plan rank. This service owns the plan columns migration 020
 * added to `issues`, the links in `plan_links` and the derived membership in `plan_members`;
 * title, description, parent, documents, comments, files and sync are the issue's own. Every
 * write runs inside the store's journaled scope, so the plan columns travel as fields of the
 * `issue` entity and links as fields of the idea's `milestone` entity.
 *
 * Three rules shape every write:
 *
 *  - The lifecycle decides what a record's state offers (`plan-lifecycle.ts`). Every write is
 *    one of its actions and is refused, naming the state and what it offers, when the state
 *    does not offer it. That check comes first, so the refusal says why for anyone.
 *  - Steering is the person's. Maturity, horizon assignment, horizon definitions and dates,
 *    planned dates, order and the baseline need a `PersonDecision`; a write without one is an
 *    agent's and is refused with `steeringRefusal`. Agents capture raw ideas, edit titles and
 *    briefs, add and resolve questions, add decisions, adopt and unlink work, and promote a
 *    shaped idea (the only state that offers promotion).
 *  - Derived facts are never stored: stage beyond maturity, progress, actual dates, forecast,
 *    lateness and a horizon's members are read or rebuilt from the work every time.
 */
import type { DatabaseSync, StatementSync } from "node:sqlite";
import { insertEvent } from "./event-log.js";
import { moveIdentifier } from "./identifier-moves.js";
import { isIdeaNumber, nextIdeaNumber } from "./idea-numbers.js";
import { newId } from "./ids.js";
import { SCAFFOLD_ORIGIN_KIND, SPARKED_ORIGIN_KIND, scaffoldOriginId, scaffoldTaskId, sparkedByOf, sparkedIdeasOf, sparkedOriginId, type SparkedBy, type SparkedIdea } from "./plan-provenance.js";
import { MILESTONE_KIND, MILESTONE_MEMBERSHIP, rankBetween, renumberedRanks } from "./milestones.js";
import {
  DEFAULT_HORIZONS,
  DELIVERED_NOTE_KEY,
  MATURITY_READ,
  SHAPE_PROPOSAL_KEY,
  aKind,
  IDEA_KIND,
  PLAN_KINDS_MISSING_MESSAGE,
  PROMOTED_KIND,
  assertPlanWindow,
  deriveStage,
  displayRef,
  forecastEnd,
  isDelivered,
  isDraftIdentifier,
  isLate,
  isNotStarted,
  isPlanKind,
  parseDeliveredOn,
  parseMaturity,
  parsePlanDate,
  readMaturity,
  steeringRefusal,
  utcDay,
  type ActualWindow,
  type Maturity,
  type Stage,
  type SteeringWrite,
} from "./plan.js";
import {
  HORIZON_ACTIONS,
  HORIZON_LIFECYCLE,
  IDEA_ACTIONS,
  assertHorizonAction,
  assertIdeaAction,
  horizonState,
  ideaOffered,
  ideaState,
  isRunMode,
  RUN_MODE_IDS,
  RUN_MODES,
  type RunMode,
  maturityAction,
  type HorizonAction,
  type HorizonState,
  type IdeaAction,
  type IdeaState,
  type OfferedAction,
} from "./plan-lifecycle.js";
import { createHash, randomUUID } from "node:crypto";
import { readStoredRepositoryId } from "./repo-identity.js";
import { readLocalLease } from "./cloud/lease-store.js";
import { allPlanLinks, planLinkField, planLinkPurposeOf, planLinkValue, planLinksOf, writePlanLink, type PlanLinkPurpose } from "./plan-links.js";
import { allPlanBlockers, planBlockerField, writePlanBlocker } from "./plan-blockers.js";
import { planRowsByRecord, planRowField, planRowsOf, planRowValue, writePlanRow, type PlanRowValue } from "./plan-rows.js";
import {
  BREAKDOWN_KEY,
  DOCUMENT_SECTIONS,
  LIST_KEYS,
  SECTION_KEYS,
  assertListBody,
  checkPlanPatch,
  completeness,
  dependencyOrder,
  emptySections,
  estimateProblem,
  estimateSeconds,
  gateSentence,
  normalizeRow,
  parsePlanMarkdown,
  planWarnings,
  readSection,
  renderSection,
  dependencyResolver,
  shapedGate,
  type BreakdownRow,
  type BreakdownRowInput,
  type PlanPatch,
  type PlanSections,
} from "./plan-sections.js";
import { LISTED_HORIZON, rebuildPlanMembers } from "./plan-members.js";
import { heldBySubIdeas, orderPlanSteps, planStepOf, type PlanStep, type PlanStepInput } from "./plan-steps.js";
import { holdsHorizon, horizonAccounting, isUmbrella, ownUnits, unitPercent, unitProgress, units, type HorizonAccounting, type OwnUnits, type RecordCounts, type RecordSize, type ScheduledRecord, type Units } from "./plan-accounting.js";
import type { MilestoneProgress } from "./milestones.js";
import type { WorkspaceStore } from "./store.js";
import { RESOLVED_CATEGORIES, StapleError, type PersonDecision, type StatusCategory } from "./types.js";

/** Who is writing. A `person` is the distinction; without one the write is an agent's. */
export interface PlanWriteOptions {
  person?: PersonDecision | null;
}

export interface HorizonView {
  id: string;
  /** The milestone's ticket number: a horizon is real work, so it has one. */
  identifier: string;
  name: string;
  /** YYYY-MM-DD, or null for an undated named horizon (the milestone's target date). */
  date: string | null;
  rank: number;
  /** The milestone's own status, derived from its members like any milestone's. */
  status: string;
  /** Its milestone is done: every member landed and nothing on its plan holds it (`heldByPlan`). */
  shipped: boolean;
  /** Members it holds, put there or derived from its plan records. */
  memberCount: number;
  ideaCount: number;
  /** Plan records on it whose work is past its line. */
  lateCount: number;
  /** Plan records on it with nothing started whose planned start has passed. */
  notStartedCount: number;
  /** Plan records on it whose work has all landed. */
  shippedCount: number;
  /**
   * Its work items (design/plan.md, "Accounting"): the ticket leaves under its members, done and
   * open, and the breakdown rows of the ideas it carries that have no tickets yet, planned.
   */
  units: Units;
  /** Ideas it carries with nothing to count yet: no work, no rows, no sub-ideas. */
  unsizedCount: number;
  /** The non-dropped leaf records it carries by state, and the parents among its records. */
  records: RecordCounts;
  /** Done units over all its units, 0..1; null while it has none. */
  progress: number | null;
  /** `progress` as every surface prints it: whole percent, rounded down; null while it has none. */
  percent: number | null;
  /** All its units are done and nothing on its plan holds it: what derives its milestone done. */
  complete: boolean;
  /** How far agents take it when they pick its work up; null until the person sets it. */
  runMode: RunMode | null;
  /** Its goal: the milestone's acceptance criteria, set by the person. */
  goal: string[];
  /** Its close waits for the person's approval (a goal run gated it, or a person did). */
  awaitingApproval: boolean;
  late: boolean;
  /** Its lifecycle state, and the actions that state offers (`plan-lifecycle.ts`). */
  state: HorizonState;
  actions: OfferedAction[];
  /** What its planned work still needs, in plan order (`plan-steps.ts`); [] when nothing does. */
  planSteps: PlanStep[];
  /** How many of those steps wait on the person (`who` is person): the "Needs you" its header prints. */
  needsYou: number;
}

/**
 * The records a horizon's tree draws (design/plan.md, "Presentation"): every non-dropped record it
 * carries, the ancestors of those (a sub-idea's parent names its group), and each carried record's
 * non-dropped sub-records wherever they are (shown dimmed, with where). In plan order.
 */
export function horizonTreeRecords(ideas: readonly IdeaView[], horizonId: string): IdeaView[] {
  const byId = new Map(ideas.map((idea) => [idea.id, idea]));
  const live = (idea: IdeaView) => idea.stage !== "dropped";
  const carried = ideas.filter((idea) => idea.carriedBy === horizonId && live(idea));
  const wanted = new Set(carried.map((idea) => idea.id));
  for (const idea of carried) {
    for (let parent = idea.parentId === null ? undefined : byId.get(idea.parentId); parent && !wanted.has(parent.id); parent = parent.parentId === null ? undefined : byId.get(parent.parentId)) wanted.add(parent.id);
    for (const child of idea.childIds) if (byId.has(child) && live(byId.get(child)!)) wanted.add(child);
  }
  return ideas.filter((idea) => wanted.has(idea.id));
}

/** The horizon a task's work belongs to, as the task list shows it. */
export interface RowHorizon {
  id: string;
  identifier: string;
  name: string;
  date: string | null;
  rank: number;
}

export interface PlanWindow {
  start: string | null;
  target: string | null;
}

export interface IdeaView {
  id: string;
  /** The ticket number once promoted; null while it is an idea, which has none to show. */
  identifier: string | null;
  /**
   * Its permanent idea number, `I-<PREFIX>-<n>` (`idea-numbers.ts`), before and after promotion.
   * Null only on a record an earlier build left unnumbered, until this build numbers it.
   */
  number: string | null;
  /** Promoted in place: this record is now an epic in the tracker. */
  promoted: boolean;
  /** Its kind: `idea`, or the kind it was promoted to. */
  kind: string;
  title: string;
  description: string | null;
  /** The brief's first written line, for a card to show; null while it has none. The detail carries the whole brief. */
  briefLine: string | null;
  maturity: Maturity;
  stage: Stage;
  parentId: string | null;
  horizonId: string | null;
  planned: PlanWindow;
  /** The window kept when it was started; null before it is started or when it had no window. */
  baseline: PlanWindow | null;
  rank: number;
  /** The issues this record itself links for delivery, by id; some may be missing (see `missingLinks`). */
  links: string[];
  /**
   * The issues it links as exploration (research, a proof of concept), by id: listed on their
   * own, and nothing it is measured by. They do not start it, count toward its progress or dates,
   * or join its horizon. Some may be missing, as links may.
   */
  explorations: string[];
  /** Own links whose issue this device no longer holds (a rewind, say): shown as missing, still unlinkable. */
  missingLinks: string[];
  /** Work it stands for, rolled up from sub-ideas: itself once promoted, and every link. */
  linkCount: number;
  resolvedLinks: number;
  /**
   * Its rollup's work items: the ticket leaves of that work, done and open, and the breakdown rows
   * of itself and every non-dropped sub-record that has no work yet, planned.
   */
  units: Units;
  /** Its own size is unknown: no work, no breakdown rows and no live sub-records. */
  unsized: boolean;
  /**
   * Its own work items, without its sub-records': its own tickets' leaves, else none for an
   * umbrella, else its breakdown rows as planned (`ownUnits`). What a leaf's row in the tree draws.
   */
  own: Units;
  /** An umbrella: no own work, over live sub-records that carry its size. */
  umbrella: boolean;
  /** The horizon that carries it: the one it is scheduled on, else its nearest scheduled ancestor's; null for none. */
  carriedBy: string | null;
  /** Done units over its rollup's units, 0..1; null before any of that work is started. */
  progress: number | null;
  /** `progress` as every surface prints it: whole percent, rounded down; null with it. */
  percent: number | null;
  actual: ActualWindow;
  /** Its work landed, or is forecast to land, past the planned end or the horizon line. */
  late: boolean;
  /** Nothing started yet and the planned start has passed. */
  notStarted: boolean;
  /**
   * The person's mark that it was delivered outside the tracker: the day, which is its actual
   * end, and the note kept with it (the `delivered-note` document). A marked record reads shipped
   * with no ticket. Null while it is not marked.
   */
  delivered: { on: string; note: string | null } | null;
  childIds: string[];
  /** Questions not yet resolved, from the `questions` document. */
  openQuestions: number;
  /**
   * A shaped record whose plan no longer passes the shaped gate (it was edited since): what it
   * lacks. Its maturity stays; Scaffold and Promote are held back until the plan passes again.
   * Empty otherwise.
   */
  planIncomplete: string[];
  /** How much of its plan is written: the starred sections and all ten. */
  completeness: { starred: number; starredTotal: number; filled: number; total: number };
  /**
   * The records it waits on, by id: the ones it is blocked by (`blockedBy`), then those its
   * dependencies and outside depends-on cells name.
   */
  dependsOn: string[];
  /**
   * The plan records it is blocked by, by id: its structured edges (`staple idea block`,
   * update_idea's add_blockers), in the order of their ids. One its ancestors or descendants hold
   * is kept but holds nothing.
   */
  blockedBy: string[];
  /**
   * What holds its Scaffold and Promote back, or null when nothing does: the ideas above it that
   * are not shaped (still raw or exploring, or dropped), nearest first, and the records it or an
   * idea above it is blocked by that have neither shipped nor been dropped. A shaped record held
   * reads `shaped · waiting on parent` (or on its blockers). On a record already promoted it is
   * the flag that an idea above it went back to exploring or was dropped since: its tickets stay.
   */
  heldBy: IdeaHold | null;
  /** Its lifecycle state, and the actions that state offers (`plan-lifecycle.ts`). */
  state: IdeaState;
  actions: OfferedAction[];
  /**
   * An agent's standing proposal that it is ready to be marked shaped (`propose_shape`): shown
   * under Needs you while the record can still be marked shaped, accepted by the person with Mark
   * shaped. Null otherwise.
   */
  shapeProposal: ShapeProposal | null;
  /** What it needs next from planning, while a horizon carries it (`plan-steps.ts`); else null. */
  nextStep: PlanStep | null;
  createdAt: string;
  updatedAt: string;
}

/** What holds a record back from being built (`IdeaView.heldBy`). */
export interface IdeaHold {
  parents: Array<{ id: string; title: string; maturity: Maturity }>;
  blockers: Array<{ id: string; title: string; state: IdeaState }>;
}

/** A hold in a few words: `waiting on parent`, `waiting on parents`, `waiting on blockers`. */
export function holdLabel(hold: IdeaHold): string {
  if (hold.parents.length > 0) return hold.parents.length === 1 ? "waiting on parent" : "waiting on parents";
  return hold.blockers.length === 1 ? "waiting on blocker" : "waiting on blockers";
}

/** A hold as a sentence's object: `parent "SSO" (exploring)`, `"Audit log" (shaped)`. */
export function holdWords(hold: IdeaHold): string {
  const parents = hold.parents.map((parent) => `"${parent.title}" (${parent.maturity})`);
  const blockers = hold.blockers.map((blocker) => `"${blocker.title}" (${blocker.state})`);
  return [
    ...(parents.length > 0 ? [`${parents.length === 1 ? "parent" : "parents"} ${parents.join(", ")}`] : []),
    ...(blockers.length > 0 ? [`${blockers.length === 1 ? "blocker" : "blockers"} ${blockers.join(", ")}`] : []),
  ].join(" and ");
}

/** A record's size and its own units: what a horizon's accounting and its hold read. */
interface RecordSizeView {
  size: RecordSize;
  own: OwnUnits;
}

/**
 * A record's own facts, derived once: its own work, maturity, horizon and stage. The one stage
 * derivation the record's view, its size and a horizon's hold all read, so a link whose issue
 * this device lacks is treated the same way by each (`deriveStage`'s missing links).
 */
interface RecordFacts {
  promoted: boolean;
  ownLinks: string[];
  ownWork: string[];
  ownPresent: string[];
  own: ReturnType<PlanStore["measure"]>;
  maturity: Maturity;
  /** The listed horizon it is scheduled on, or null. */
  horizonId: string | null;
  stage: Stage;
  state: IdeaState;
}

/**
 * The plan's facts, derived once per state of the database from a constant number of reads:
 * the records, the horizons, the work, every link and every breakdown row count. The records'
 * views, each horizon's accounting and each horizon's hold are read from it.
 */
interface PlanFacts {
  rows: PlanRow[];
  byId: Map<string, PlanRow>;
  childIds: Map<string, string[]>;
  horizons: HorizonRow[];
  horizonDates: Map<string, string | null>;
  work: ReturnType<PlanStore["work"]>;
  links: Map<string, string[]>;
  /** Each record's exploration links, read in the same pass: shown, never measured. */
  explorations: Map<string, string[]>;
  /** Each record's structured blockers, by blocked record, read in one statement (`plan-blockers.ts`). */
  blockers: Map<string, string[]>;
  /** What holds each record back (`IdeaView.heldBy`); absent when nothing does. */
  held: Map<string, IdeaHold>;
  /**
   * Each record's standing proposal to be marked shaped (`shape-proposal`), read in one statement
   * on the first view that asks: a pull that re-derives only the horizons never reads it.
   */
  proposals: () => Map<string, ShapeProposal>;
  /** The workspace's status categories, read once for the build. */
  categoryOf: (status: string) => StatusCategory | null;
  records: Map<string, RecordFacts>;
  sizes: Map<string, RecordSizeView>;
  /** Each horizon's carried records: those scheduled on it, and their descendants scheduled on none. */
  carried: Map<string, ScheduledRecord[]>;
  /** The horizon carrying each carried record, by record id. */
  carrier: Map<string, string>;
  /** What each carried record's plan step reads, all but the day (`plan-steps.ts`). */
  stepInputs: Map<string, Omit<PlanStepInput, "today">>;
  /** The carried records' steps on the day they were last derived for. */
  steps: { today: string; byRecord: Map<string, PlanStep> } | null;
  /** Each horizon's accounting, filled on first read in this state (its tickets cost a read). */
  accounting: Map<string, HorizonAccounting>;
}

export interface PlanView {
  enabled: boolean;
  today: string;
  horizons: HorizonView[];
  ideas: IdeaView[];
}

export interface LinkView {
  /** The linked issue is gone from this device (a rewind, say); it can still be unlinked. */
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
  /** `progress` as every surface prints it: whole percent, rounded down. */
  percent: number;
  startedAt: string | null;
  completedAt: string | null;
  milestone: { identifier: string; title: string; state: string; run: { state: string; actor: string } | null } | null;
}

export interface Question {
  text: string;
  resolved: boolean;
  /** Left open on purpose: it does not hold the idea back from being shaped. */
  deferred?: boolean;
}

export interface IdeaDetail {
  idea: IdeaView;
  parent: { id: string; identifier: string | null; title: string } | null;
  children: IdeaView[];
  horizon: HorizonView | null;
  brief: string | null;
  questions: Question[];
  decisions: string[];
  /** Its delivery links: the work it stands for. */
  linked: LinkView[];
  /** Its exploration links (research, proofs of concept): its own list, nothing it is measured by. */
  exploration: LinkView[];
  /** The plan sections (design/plan.md, "Plan sections"). */
  plan: PlanSections;
  /** How much of the plan is written: starred sections and all ten. */
  completeness: { starred: number; starredTotal: number; filled: number; total: number };
  /** What the shaped gate still needs; empty when it may be shaped. */
  missingForShaped: string[];
  /** What is worth a look in the plan without stopping it: estimates that are not durations. */
  planWarnings: string[];
  /**
   * The breakdown as this read saw it. A breakdown write that names it (`breakdownBase`) is
   * refused when the breakdown changed since, so a stale editor never overwrites a newer edit.
   */
  breakdownRevision: string;
  /** What scaffolding it would create, while its state offers scaffolding (held back or not); else null. */
  scaffold: ScaffoldPreview | null;
  /** The ticket whose work sparked it (`capture`'s `sparkedBy`); null when none was named or it is gone. */
  sparkedBy: SparkedBy | null;
  /** The ideas its own work sparked, once it is tracker work (promoted); oldest first. */
  sparked: SparkedIdea[];
  /** The records it is blocked by (`IdeaView.blockedBy`), named; one this device no longer holds is `missing`. */
  blockedBy: BlockerRef[];
  /** The records blocked by it. */
  blocks: BlockerRef[];
  today: string;
}

/** A plan record one is blocked by, or that it blocks, as a detail names it. */
export interface BlockerRef {
  id: string;
  /** Its idea number; null on a record this device does not hold. */
  number: string | null;
  /** Its ticket number once promoted; null while it is an idea. */
  identifier: string | null;
  title: string;
  /** Its lifecycle state; null on a record this device does not hold. */
  state: IdeaState | null;
  missing: boolean;
}

/** One task Scaffold creates from a breakdown row. */
export interface ScaffoldTask {
  /** The breakdown row it comes from; its task's identity follows from it and the idea's. */
  rowId: string;
  key: string;
  title: string;
  estimate: string | null;
  estimatedSeconds: number | null;
  /** Why the estimate as written reads as none; null when it reads, or none was written. */
  estimateWarning: string | null;
  /** Keys of rows in this breakdown it waits on: they become its blockers. */
  blockedBy: string[];
  /** What it waits on outside this breakdown: carried in its context, not as blockers. */
  waitsOutside: string[];
  acceptance: string[];
  /** Its row had no "done when", so it takes the plan's acceptance criteria, flagged to be sharpened. */
  acceptanceInherited: boolean;
  /** The context document it gets: workable from the ticket alone. */
  context: string;
  /** Already created by an earlier scaffold of this idea (then it is not created again). */
  existing: string | null;
}

/** What Scaffold creates: the idea promoted into the epic, its tasks, and its shaped sub-ideas'. */
export interface ScaffoldPreview {
  idea: { id: string; title: string };
  epic: { identifier: string | null; kind: string; planDocument: string; acceptance: string[]; promoted: boolean };
  tasks: ScaffoldTask[];
  children: ScaffoldPreview[];
  /** What the plan lacks, here or in a sub-idea it carries: while any is listed, confirming is refused. */
  problems: string[];
  /** Worth a look, not a stop: estimates that are not durations. */
  warnings: string[];
  /** Exactly what this preview shows. Confirming names it, and is refused when the plan changed since. */
  fingerprint: string;
}

/** The label on a task whose acceptance came from the plan's, until someone sharpens it. */
export const INHERITED_ACCEPTANCE_LABEL = "acceptance-inherited";

export interface CaptureInput {
  title: string;
  /** Plan sections to start with; the shaped gate reads them when it is captured shaped. */
  plan?: PlanPatch | null;
  parent?: string | null;
  brief?: string | null;
  maturity?: string;
  horizon?: string | null;
  plannedStart?: string | null;
  plannedTarget?: string | null;
  /** The ticket whose work sparked it: kept on the idea and listed on the ticket (`plan-provenance.ts`). */
  sparkedBy?: string | null;
}

export interface IdeaPatch {
  title?: string;
  brief?: string | null;
  maturity?: string;
  horizon?: string | null;
  parent?: string | null;
  plannedStart?: string | null;
  plannedTarget?: string | null;
  /** Place this record immediately before that one in the plan order; null moves it to the end. */
  before?: string | null;
  /**
   * The person's mark that it was delivered outside the tracker: the day (required) and an
   * optional note; null clears the mark. A record not marked is cleared as no change.
   */
  delivered?: { on: string; note?: string | null } | null;
  /** Plan sections to replace, each whole; a section left out is left alone. The edit action. */
  plan?: PlanPatch;
  /**
   * The `breakdownRevision` the writer read. Given with a breakdown, the write is refused when
   * the breakdown changed since; left out, the breakdown given replaces it (rows matched by id,
   * else by key).
   */
  breakdownBase?: string;
  /**
   * Propose it shaped: anyone's, held to the shaped gate as the plan stands after this write. The
   * note says why; the person accepts it with Mark shaped or dismisses it (`shapeProposal`).
   */
  proposeShaped?: { note?: string | null };
  /** The person sets a standing proposal aside without shaping it. */
  dismissProposal?: boolean;
}

export interface HorizonPatch {
  name?: string;
  date?: string | null;
  /** Place this horizon immediately before that one; null moves it to the end. */
  before?: string | null;
}

interface PlanRow {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  kind: string;
  status: string;
  parent_id: string | null;
  depth: number;
  created_at: string;
  updated_at: string;
  plan_maturity: string | null;
  plan_horizon_id: string | null;
  plan_start: string | null;
  plan_target: string | null;
  plan_baseline_start: string | null;
  plan_baseline_target: string | null;
  plan_rank: number | null;
  plan_run_mode: string | null;
  plan_delivered_on: string | null;
  /** The idea number a promoted record kept (migration 026); null on an unpromoted idea, which holds it as its identifier. */
  plan_idea_number: string | null;
  /** 1 once a write made it more complete while raw (migration 029); `plan_maturity` already reads it (`MATURITY_READ`). */
  plan_explored: number | null;
}

interface HorizonRow extends PlanRow {
  target_date: string | null;
}

interface WorkRow {
  id: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  parent_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
}

const RANK_STEP = 1024;
// `plan_maturity` is read as every surface sees it: a raw record made more complete reads exploring.
const PLAN_COLUMNS = `id, identifier, title, description, kind, status, parent_id, depth, created_at, updated_at,
  ${MATURITY_READ} AS plan_maturity, plan_horizon_id, plan_start, plan_target, plan_baseline_start, plan_baseline_target, plan_rank, plan_run_mode, plan_delivered_on, plan_idea_number, plan_explored`;

/** Column name to the payload field the issue entity carries it as. */
const FIELD_OF: Record<string, string> = {
  plan_maturity: "planMaturity",
  plan_horizon_id: "planHorizonId",
  plan_start: "planStart",
  plan_target: "planTarget",
  plan_baseline_start: "planBaselineStart",
  plan_baseline_target: "planBaselineTarget",
  plan_rank: "planRank",
  plan_run_mode: "planRunMode",
  plan_delivered_on: "planDeliveredOn",
  plan_explored: "planExplored",
  parent_id: "parentId",
};

const QUESTIONS_KEY = "questions";
const DECISIONS_KEY = "decisions";
const BRIEF_KEY = "brief";

/**
 * The document keys whose write makes a record more complete (design/plan.md, "Maturity moves by
 * enrichment"): its plan sections, questions and decisions. Not its brief, which a capture writes,
 * and not the delivered note or a proposal, which are not the plan.
 */
const ENRICHING_KEYS: ReadonlySet<string> = new Set([...DOCUMENT_SECTIONS.map((name) => SECTION_KEYS[name]), QUESTIONS_KEY, DECISIONS_KEY]);

/** An agent's proposal that a record is ready to be marked shaped: who, when, and why. */
export interface ShapeProposal {
  by: string | null;
  at: string;
  note: string | null;
}

/** What a proposal says when its author gave no reason. */
const PROPOSAL_DEFAULT_NOTE = "Ready to be marked shaped.";

export { scaffoldTaskId };

/** Stable within a repository, separate from user-created horizons and scaffolded work. */
function defaultHorizonId(repositoryId: string, name: string): string {
  const hex = createHash("sha256").update(`staple:default-horizon:${repositoryId}:${name}`).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A short digest of a value, as previews and the breakdown name what they showed. */
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

export function parseQuestions(body: string | null): Question[] {
  if (!body) return [];
  const out: Question[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*[-*]\s+\[( |x|X|~)\]\s+(.*)$/.exec(line);
    if (match) out.push({ text: match[2]!.trim(), resolved: match[1] === "x" || match[1] === "X", ...(match[1] === "~" ? { deferred: true } : {}) });
  }
  return out;
}

export function renderQuestions(questions: readonly Question[]): string {
  return questions.map((q) => `- [${q.resolved ? "x" : q.deferred ? "~" : " "}] ${q.text}`).join("\n") + "\n";
}

export function parseDecisions(body: string | null): string[] {
  if (!body) return [];
  return body
    .split("\n")
    .map((line) => /^\s*[-*]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((line) => line.length > 0);
}

/** A record's plan sections from its document bodies by key and its breakdown rows. */
function sectionsFrom(body: (key: string) => string | null, breakdown: BreakdownRow[]): PlanSections {
  const sections = emptySections();
  for (const name of DOCUMENT_SECTIONS) (sections as unknown as Record<string, unknown>)[name] = readSection(name, body(SECTION_KEYS[name]));
  sections.breakdown = breakdown;
  return sections;
}

function oneLine(text: string, what: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new StapleError("validation", `${what} cannot be empty.`);
  return clean;
}

/** A plan record's ticket number to show: none while it is an idea, whose number is its idea number. */
function shownIdentifier(identifier: string): string | null {
  return isDraftIdentifier(identifier) || isIdeaNumber(identifier) ? null : identifier;
}

/** A plan record's permanent idea number (`idea-numbers.ts`): its identifier while an idea, then the one it kept. */
function ideaNumberOf(row: { identifier: string; plan_idea_number?: string | null }): string | null {
  return row.plan_idea_number ?? (isIdeaNumber(row.identifier) ? row.identifier : null);
}

/** The steering word a person-only idea action is refused with (`steeringRefusal`). */
const STEERED_AS: Partial<Record<IdeaAction, SteeringWrite>> = {
  explore: "maturity",
  shape: "maturity",
  dismiss_proposal: "proposal",
  unshape: "maturity",
  drop: "maturity",
  restore: "maturity",
  schedule: "horizon",
  plan_dates: "planned dates",
  reorder: "horizon",
  reparent: "parent",
  reset_baseline: "baseline",
  mark_delivered: "delivery",
  clear_delivered: "delivery",
};

export class PlanStore {
  /** The clock the derived dates read; replaceable so tests can stand on a fixed day. */
  clock: () => Date = () => new Date();

  constructor(private readonly store: WorkspaceStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  today(): string {
    return utcDay(this.clock());
  }

  // ---------- guards ----------

  enabled(): boolean {
    return this.store.planningOn();
  }

  assertEnabled(): void {
    if (!this.store.planningOn()) throw new StapleError("validation", PLAN_KINDS_MISSING_MESSAGE, { kinds: [IDEA_KIND, MILESTONE_KIND] });
  }

  private steer(what: SteeringWrite, subject: string | null, options: PlanWriteOptions): void {
    if (!options.person) throw steeringRefusal(what, subject);
  }

  /** A record's lifecycle state, read from the same derivation every view uses. */
  stateOf(ref: string): IdeaState {
    return this.ideaView(ref).state;
  }

  /**
   * Refuse an idea action its record's state does not offer, naming the state and what it offers;
   * then a person-only action taken without a person. In that order, so the first refusal says why
   * for anyone, and the second only once the action itself is possible.
   */
  private allowIdea(row: PlanRow, action: IdeaAction, options: PlanWriteOptions, state: IdeaState = this.stateOf(row.id)): void {
    assertIdeaAction(displayRef(row), state, action, row.kind !== IDEA_KIND, readMaturity(row.plan_maturity), isDelivered(row.plan_delivered_on));
    if (IDEA_ACTIONS[action].who === "person") this.steer(STEERED_AS[action] ?? "maturity", displayRef(row), options);
  }

  /**
   * A write on an idea's own content from outside the plan: the tracker's edit of its title or
   * description (`staple set`, `update_task`), and any document, file or restore on it. Each is
   * the edit action, held to its state and to who may take it, as `update_idea` is. A promoted
   * record is an ordinary epic, edited by the epic's rules.
   */
  assertEditable(ref: string): void {
    const row = this.row(ref, false);
    if (row.plan_maturity === null || row.kind !== IDEA_KIND) return;
    this.assertEnabled();
    this.allowIdea(row, "edit", {});
  }

  /**
   * A raw document write (`put_document`, `staple doc put`, a restore) on a plan record's section
   * keys, checked before it lands: the breakdown is rows, never a document, and a list section
   * must read as the list it holds. A body that would read as fewer items is refused, not stored.
   */
  assertDocumentWrite(ref: string, key: string, body: string): void {
    const row = this.row(ref, false);
    if (row.plan_maturity === null) return;
    if (key === BREAKDOWN_KEY) {
      throw new StapleError(
        "validation",
        `The task breakdown of ${displayRef(row)} is structured rows, not a document. Edit it with update_idea (plan.breakdown), \`staple idea task\`, or the Plan tab.`,
        { key },
      );
    }
    if (key === DELIVERED_NOTE_KEY) {
      throw new StapleError(
        "validation",
        `The delivered note of ${displayRef(row)} is written with the mark that it was delivered outside the tracker, which is the person's (the Plan view, or staple idea set --delivered YYYY-MM-DD --note T --person).`,
        { key },
      );
    }
    if (key === SHAPE_PROPOSAL_KEY) {
      throw new StapleError(
        "validation",
        `The shaped proposal of ${displayRef(row)} is written by proposing it (update_idea with propose_shaped, or staple idea propose), and the person accepts or dismisses it.`,
        { key },
      );
    }
    if (LIST_KEYS.has(key)) assertListBody(key, body);
    if (key === QUESTIONS_KEY && body.split("\n").some((line) => line.trim() !== "" && !/^\s*[-*]\s+\[( |x|X|~)\]\s+\S/.test(line))) {
      throw new StapleError("validation", `The questions of ${displayRef(row)} are a checklist, one "- [ ] question" per line ("- [x]" resolved, "- [~]" deferred).`, { key });
    }
  }

  /**
   * A raw document write on a record (`put_document`, `staple doc put`, a restore) that wrote one
   * of its plan sections, its questions or its decisions made it more complete: a raw idea moves to
   * exploring (`explore`). Called by the store after the write, in its transaction; the plan
   * layer's own writes move it themselves.
   */
  noteDocumentWrite(id: string, key: string, actor: string | null): void {
    if (!ENRICHING_KEYS.has(key) || !this.enabled()) return;
    this.explore(id, actor, "document");
  }

  /**
   * A write that made a raw idea more complete moves it to exploring, whoever made it (design/plan.md,
   * "Maturity moves by enrichment"): its plan sections or rows, a question, a decision, linked research.
   * Capture, import and title or brief edits never do, and nothing moves an idea to shaped.
   *
   * It writes the synced flag `plan_explored`, never `plan_maturity`, which stays the person's:
   * two devices that enrich one idea offline write the same value, and one that enriches it while
   * the person shapes or drops it on another touches a different field, so every device, a fresh
   * one included, reads the person's maturity with no conflict. Read fresh, after the write it
   * follows: a write that also set the maturity is read as set, and moves nothing.
   */
  private explore(id: string, actor: string | null, cause: string): void {
    const row = this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(id) as unknown as PlanRow | undefined;
    if (!row || row.kind !== IDEA_KIND || row.plan_maturity !== "raw") return;
    this.write(row.id, { plan_explored: 1 }, actor, "idea_explored", { from: "raw", to: "exploring", cause });
  }

  /** Its standing proposal to be marked shaped, or null (an emptied `shape-proposal` is none). */
  private proposalOf(id: string): string | null {
    const body = this.documentBody(id, SHAPE_PROPOSAL_KEY);
    return body && body.trim() !== "" ? body : null;
  }

  private horizonStateOf(id: string): HorizonState {
    return this.horizonOf(id).state;
  }

  /** Refuse a horizon action its state does not offer. Every horizon write but queueing is the person's, checked first by the caller. */
  private allowHorizon(row: PlanRow, action: HorizonAction): void {
    assertHorizonAction(`"${row.title}"`, this.horizonStateOf(row.id), action);
  }

  /** Whether a queue may take this milestone: any milestone that is not a horizon, or a horizon whose state offers queueing. */
  assertQueueable(issueId: string): void {
    if (!this.store.isHorizon(issueId)) return;
    const row = this.row(issueId, false);
    assertHorizonAction(`"${row.title}"`, this.horizonStateOf(row.id), "queue");
  }

  private row(ref: string, forWrite = true): PlanRow {
    const issue = forWrite ? this.store.writeTarget(ref) : this.store.getIssue(ref);
    return this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(issue.id) as unknown as PlanRow;
  }

  /** A plan record: an idea, or one already promoted. */
  private recordRow(ref: string, forWrite = true): PlanRow {
    const row = this.row(ref, forWrite);
    if (row.plan_maturity === null) {
      throw new StapleError("validation", `${displayRef(row)} is not part of the plan (it is ${aKind(row.kind)}). Adopt it onto an idea to link it.`);
    }
    return row;
  }


  /** Whether the plan still lists this horizon: a removed one (a cancelled milestone) holds nothing, as the plan reads it. */
  private listedHorizon(id: string | null): boolean {
    return id !== null && this.db.prepare(`SELECT 1 AS hit FROM issues WHERE id = ? AND ${LISTED_HORIZON}`).get(id) !== undefined;
  }

  private horizonRow(ref: string, forWrite = true): PlanRow {
    const row = this.row(ref, forWrite);
    if (row.kind !== MILESTONE_KIND || row.plan_rank === null) {
      throw new StapleError("validation", `${displayRef(row)} is not a horizon: a horizon is a milestone the plan shows as a column.`);
    }
    if (!this.db.prepare(`SELECT 1 AS hit FROM issues WHERE id = ? AND ${LISTED_HORIZON}`).get(row.id)) {
      throw new StapleError("validation", `${row.title} (${row.identifier}) was removed from the plan; it is a cancelled milestone now.`, { horizon: row.identifier });
    }
    return row;
  }

  // ---------- writes: one place the plan columns change ----------

  private write(id: string, columns: Record<string, unknown>, actor: string | null, event: string, detail: Record<string, unknown> = {}): void {
    const names = Object.keys(columns);
    if (names.length === 0) return;
    const now = this.store.journal.mutationAt();
    this.db
      .prepare(`UPDATE issues SET ${names.map((name) => `${name} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...(names.map((name) => columns[name]) as never[]), now, id);
    const payload: Record<string, unknown> = { updatedAt: now };
    for (const name of names) payload[FIELD_OF[name] ?? name] = columns[name];
    this.store.journal.record({ entity: "issue", entityId: id, verb: "update", payload, actor: actor ?? null });
    insertEvent(this.db, { kind: event, issueId: id, actor, payload: detail });
  }

  /**
   * After a plan write, the horizons' derived members are rebuilt (`plan-members.ts`), and every
   * milestone whose membership moved re-derives its status as one that gained or lost a member does.
   * Then every horizon whose plan hold the write changed re-derives (`rederivePlanHolds`).
   */
  private settleMembership(actor: string | null): void {
    const changed = rebuildPlanMembers(this.db);
    if (changed.length > 0) this.store.rederiveMilestones(changed, "plan", actor);
    this.store.rederivePlanHolds("plan", actor);
  }

  // ---------- enabling ----------

  /**
   * Turn planning on: the `idea` and `milestone` kinds when missing, and the horizons Now, Next
   * and Later, which are milestones. Refused while an issue uses the `idea` kind for other work.
   * Run again on a workspace where planning is on, it numbers what an earlier build left: an
   * idea with no idea number, and a promoted one that kept none (`numberIdeas`).
   */
  enable(actor: string | null, options: PlanWriteOptions = {}): PlanView {
    this.store.setSetting("features.planning", true, actor, options.person);
    return this.view();
  }

  /** Only the feature-setting transaction calls this structural upgrade. */
  initialize(actor: string | null): void {
    if (this.store.planningInitialized()) {
      this.store.journaled(() => {
        this.migrateLegacyLater();
        this.numberIdeas();
        this.settleMembership(actor);
      });
      return;
    }
    const unrelated = this.db.prepare("SELECT identifier FROM issues WHERE kind = ? ORDER BY identifier").all(IDEA_KIND) as Array<{ identifier: string }>;
    if (unrelated.length > 0) {
      const names = unrelated.map((row) => row.identifier);
      throw new StapleError(
        "validation",
        `Planning uses the kind "idea", and ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""} already use it for other work. The idea kind is reserved; these legacy records are kept intact and generic kind migration is refused. A person must resolve the legacy vocabulary before enabling planning.`,
        { issues: names },
      );
    }
    this.store.journaled(() => {
      const ids = this.store.getKinds().map((kind) => kind.id);
      if (!ids.includes(IDEA_KIND)) this.store.addKind({ id: IDEA_KIND, label: "Idea" }, actor);
      if (!ids.includes(MILESTONE_KIND)) this.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, actor);
      const repositoryId = readStoredRepositoryId(this.db);
      DEFAULT_HORIZONS.forEach((name, index) => {
        // Concurrent first enables create the same records, including before either syncs.
        // Isolated in-memory stores without repository identity keep independent random ids.
        const id = repositoryId === null ? undefined : defaultHorizonId(repositoryId, name);
        this.insertHorizon(name, null, (index + 1) * RANK_STEP, actor, id);
      });
      return this.view();
    });
  }

  /** Upgrade the old default bucket through ordinary synchronized issue updates.
   * Keep hand membership, queue and history on a plain milestone rather than cancel open work.
   * Dated Later is intentional and stays. No marker is needed: clearing rank is idempotent.
   */
  migrateLegacyLater(): void {
    if (!this.enabled()) return;
    const sync = this.db.prepare("SELECT epoch FROM sync_state WHERE id = 1").get() as { epoch: number } | undefined;
    // A connected workspace must journal this upgrade. If its device is unavailable, sync
    // retries after binding the real journal, rather than making local-only data changes.
    if ((sync?.epoch ?? 0) > 0 && !this.store.journal.deviceIdentity()) return;
    const legacy = this.horizonRows().filter(row => row.title === "Later" && row.target_date === null);
    if (legacy.length === 0) return;
    this.store.journaled(() => {
      for (const row of legacy) {
        const ideas = this.db.prepare("SELECT id FROM issues WHERE plan_horizon_id = ?").all(row.id) as Array<{ id: string }>;
        for (const idea of ideas) this.write(idea.id, { plan_horizon_id: null }, null, "idea_updated", { fields: ["plan_horizon_id"], upgrade: "unscheduled" });
        this.write(row.id, { plan_rank: null }, null, "horizon_updated", { fields: ["plan_rank"], upgrade: "unscheduled" });
      }
      this.settleMembership(null);
    });
  }

  /**
   * The structural upgrades a workspace owes whenever it is opened or synchronized: the old
   * default horizon (`migrateLegacyLater`) and the idea numbers (`numberIdeas`).
   */
  upgradeRecords(): void {
    this.migrateLegacyLater();
    this.numberIdeas();
  }

  /**
   * Every plan record an earlier build left without an idea number takes one, in the order the
   * records were created (design/plan.md, "Idea numbers"): an idea under a draft identifier, or
   * one an older build gave a ticket number, is renumbered to it, and a promoted one keeps it
   * beside its ticket number. The old identifier keeps resolving (`recordIdentifierMove`).
   *
   * Journaled by `staple`, as a settlement is: a renumber `staple` writes is a claim on the
   * number, settled by the log like a create's (`claims.ts`), so two devices that number before
   * hearing of each other converge on one number per idea with no conflict left open; the kept
   * number is exempt from field contests for the same reason (`conflicts.ts`). A connected
   * workspace whose device is not bound yet waits, as `migrateLegacyLater` does. Idempotent: a
   * workspace with nothing to number costs one indexed-free read.
   */
  numberIdeas(): void {
    if (!this.enabled()) return;
    const owed = this.db
      .prepare(
        `SELECT id, identifier, kind, plan_idea_number FROM issues
          WHERE plan_maturity IS NOT NULL
            AND ((kind = ? AND identifier NOT GLOB 'I-[A-Z]*-[0-9]*') OR (kind <> ? AND plan_idea_number IS NULL))
          ORDER BY created_at, id`,
      )
      .all(IDEA_KIND, IDEA_KIND) as Array<{ id: string; identifier: string; kind: string; plan_idea_number: string | null }>;
    if (owed.length === 0) return;
    const sync = this.db.prepare("SELECT epoch FROM sync_state WHERE id = 1").get() as { epoch: number } | undefined;
    if ((sync?.epoch ?? 0) > 0 && !this.store.journal.deviceIdentity()) return;
    this.store.journaled(() => {
      for (const record of owed) {
        const number = nextIdeaNumber(this.db, this.store.prefix);
        const now = this.store.journal.mutationAt();
        if (record.kind === IDEA_KIND) {
          moveIdentifier(this.db, record.id, number, now);
          this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, record.id);
          this.store.journal.record({ entity: "issue", entityId: record.id, verb: "renumber", payload: { identifier: number }, actor: "staple" });
        } else {
          this.db.prepare("UPDATE issues SET plan_idea_number = ?, updated_at = ? WHERE id = ?").run(number, now, record.id);
          this.store.journal.record({ entity: "issue", entityId: record.id, verb: "update", payload: { planIdeaNumber: number, updatedAt: now }, actor: "staple" });
        }
        insertEvent(this.db, { kind: "idea_numbered", issueId: record.id, actor: "staple", payload: { number, ...(record.kind === IDEA_KIND ? { from: record.identifier } : {}) } });
      }
    });
  }

  // ---------- reads ----------

  private horizonRows(): HorizonRow[] {
    return (
      this.db
        .prepare(
          `SELECT ${PLAN_COLUMNS}, (SELECT target_date FROM milestone_meta m WHERE m.issue_id = issues.id) AS target_date
             FROM issues WHERE ${LISTED_HORIZON}`,
        )
        .all() as unknown as HorizonRow[]
    ).sort((a, b) => (a.plan_rank ?? Number.MAX_SAFE_INTEGER) - (b.plan_rank ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at));
  }

  /**
   * The horizon each issue's work belongs to: the milestone it is a member of (put there or
   * derived from the plan), else its nearest ancestor's, when that milestone is a horizon.
   * What the task list reads for its ◇ chip, its Horizon grouping and its horizon filter.
   */
  horizonsOf(ids: readonly string[]): Map<string, RowHorizon> {
    const out = new Map<string, RowHorizon>();
    if (ids.length === 0 || !this.enabled()) return out;
    const horizons = new Map(this.horizonRows().map((row) => [row.id, { id: row.id, identifier: row.identifier, name: row.title, date: row.target_date, rank: row.plan_rank ?? 0 }]));
    if (horizons.size === 0) return out;
    const memberOf = new Map((this.db.prepare(`SELECT issue_id, milestone_id FROM ${MILESTONE_MEMBERSHIP}`).all() as Array<{ issue_id: string; milestone_id: string }>).map((row) => [row.issue_id, row.milestone_id]));
    const parentOf = new Map((this.db.prepare("SELECT id, parent_id FROM issues").all() as Array<{ id: string; parent_id: string | null }>).map((row) => [row.id, row.parent_id]));
    for (const id of ids) {
      // A horizon is its own: it never falls under "No horizon".
      const own = horizons.get(id);
      if (own) {
        out.set(id, own);
        continue;
      }
      let cursor: string | null = id;
      for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
        const milestone = memberOf.get(cursor);
        if (milestone !== undefined) {
          const horizon = horizons.get(milestone);
          if (horizon) out.set(id, horizon);
          break;
        }
        cursor = parentOf.get(cursor) ?? null;
      }
    }
    return out;
  }

  /** The horizons' issue ids: the task list leaves them out of its rows, and shows each as a heading or a chip. */
  horizonIds(): Set<string> {
    if (!this.enabled()) return new Set();
    return new Set(this.horizonRows().map((row) => row.id));
  }

  /** Every plan record: unpromoted ideas while open, promoted ones whatever their status. */
  private recordRows(resolved: ReadonlySet<string> = this.resolvedStatuses()): PlanRow[] {
    return (this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE plan_maturity IS NOT NULL`).all() as unknown as PlanRow[])
      .filter((row) => row.kind !== IDEA_KIND || !resolved.has(row.status))
      .sort((a, b) => (a.plan_rank ?? Number.MAX_SAFE_INTEGER) - (b.plan_rank ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at));
  }

  private resolvedStatuses(): Set<string> {
    return new Set(this.store.getStatuses().filter((status) => this.store.isResolvedStatus(status.id)).map((status) => status.id));
  }

  /** The whole plan: every horizon in order and every record with its derived facts. */
  view(): PlanView {
    const today = this.today();
    if (!this.enabled()) return { enabled: false, today, horizons: [], ideas: [] };
    const facts = this.facts();
    const ideas = this.viewsOf(facts, today);
    const horizons = facts.horizons.map((row) => this.horizonView(row, ideas, facts));
    return { enabled: true, today, horizons, ideas };
  }

  private horizonView(row: HorizonRow, ideas: readonly IdeaView[], facts: PlanFacts): HorizonView {
    const on = ideas.filter((idea) => idea.horizonId === row.id && idea.stage !== "dropped");
    const lateCount = on.filter((idea) => idea.late).length;
    const memberCount = (
      this.db.prepare("SELECT COUNT(*) AS n FROM milestone_members WHERE milestone_id = ?").get(row.id) as { n: number }
    ).n + (this.db.prepare("SELECT COUNT(*) AS n FROM plan_members WHERE milestone_id = ? AND issue_id NOT IN (SELECT issue_id FROM milestone_members)").get(row.id) as { n: number }).n;
    const open = this.openWorkOf(row.id);
    const own = this.db.prepare("SELECT gate_state, acceptance_criteria FROM issues WHERE id = ?").get(row.id) as { gate_state: string | null; acceptance_criteria: string | null };
    const accounting = this.accountingIn(facts, row.id);
    // Its status never derives done while a record it carries holds it (`heldByPlan`).
    const shipped = this.store.categoryOf(row.status) === "done";
    const planSteps = this.stepsIn(facts, row.id);
    return {
      id: row.id,
      identifier: row.identifier,
      name: row.title,
      date: row.target_date,
      rank: row.plan_rank ?? 0,
      status: row.status,
      shipped,
      memberCount,
      ideaCount: on.length,
      lateCount,
      notStartedCount: on.filter((idea) => idea.notStarted).length,
      shippedCount: on.filter((idea) => idea.stage === "shipped").length,
      units: accounting.units,
      unsizedCount: accounting.unsizedCount,
      records: accounting.records,
      progress: accounting.progress,
      percent: accounting.percent,
      complete: accounting.complete,
      runMode: isRunMode(row.plan_run_mode) ? row.plan_run_mode : null,
      goal: own.acceptance_criteria ? (JSON.parse(own.acceptance_criteria) as string[]) : [],
      awaitingApproval: own.gate_state === "pending",
      late: lateCount > 0,
      ...horizonLifecycle(shipped, open, this.isQueued(row.id)),
      planSteps,
      needsYou: planSteps.filter((step) => step.who === "person").length,
    };
  }

  /** A horizon's plan steps in plan order, from the records it carries. */
  private stepsIn(facts: PlanFacts, horizonId: string): PlanStep[] {
    const steps = this.stepsOn(facts, this.today());
    const carried = facts.rows.filter((row) => facts.carrier.get(row.id) === horizonId);
    return orderPlanSteps(carried.map((row) => ({ id: row.id, rank: row.plan_rank ?? 0, parentId: row.parent_id, step: steps.get(row.id) ?? null })));
  }

  /**
   * A horizon's units (design/plan.md, "Accounting"): the ticket leaves its milestone counts, and
   * the planned units of every non-dropped record it carries. What the plan's horizon, the
   * milestone view of it and every surface over either read. `tickets` is the caller's own count
   * of those leaves, when it has one; derived once per state of the database either way.
   */
  accountingOf(horizonId: string, tickets?: MilestoneProgress): HorizonAccounting {
    return this.accountingIn(this.facts(), horizonId, tickets);
  }

  private accountingIn(facts: PlanFacts, horizonId: string, tickets?: MilestoneProgress): HorizonAccounting {
    const known = facts.accounting.get(horizonId);
    if (known) return known;
    const counted = horizonAccounting(tickets ?? this.store.milestones().leafProgress(horizonId), facts.carried.get(horizonId) ?? []);
    facts.accounting.set(horizonId, counted);
    return counted;
  }

  /**
   * How many records keep this horizon from shipping (design/plan.md, "Accounting"): those it
   * carries that are not dropped, not shipped and not an umbrella (`holdsHorizon`). Read by the
   * horizon's status derivation in both flag states, from the plan's facts.
   */
  holdOf(horizonId: string): number {
    return (this.facts().carried.get(horizonId) ?? []).filter((record) => record.holds).length;
  }

  heldByPlan(horizonId: string): boolean {
    return this.holdOf(horizonId) > 0;
  }

  /**
   * What a listed horizon's status is derived from beside its members: each one's hold. The
   * store compares it, with the horizons' statuses and members, against what it last settled,
   * so a write or a pull that changed none of it re-derives nothing (`rederivePlanHolds`).
   */
  holdsByHorizon(): Map<string, number> {
    const facts = this.facts();
    return new Map(facts.horizons.map((row) => [row.id, (facts.carried.get(row.id) ?? []).filter((record) => record.holds).length]));
  }

  /** One horizon's plan steps in plan order (`plan-steps.ts`); [] with planning off or for an issue that is not a horizon. */
  planStepsOf(horizonId: string): PlanStep[] {
    return this.pickupSteps([horizonId]);
  }

  /**
   * The plan steps a pickup answer carries (design/plan.md, "Plan steps"): those of the horizon it
   * is scoped to, of the horizon of the ticket it answers, and, unscoped, of every queued horizon;
   * each horizon once, in the plan's horizon order. Undefined with planning off, so the answer
   * carries no field at all.
   */
  pickupPlanSteps(input: { scope: string | null; next: string | null }): PlanStep[] | undefined {
    if (!this.enabled()) return undefined;
    const wanted: string[] = [];
    if (input.scope !== null) wanted.push(input.scope);
    else {
      const queued = this.db.prepare("SELECT issue_id FROM queue_entries").all() as Array<{ issue_id: string }>;
      wanted.push(...queued.map((row) => row.issue_id));
    }
    if (input.next !== null) {
      const horizon = this.horizonsOf([input.next]).get(input.next);
      if (horizon) wanted.push(horizon.id);
    }
    return this.pickupSteps(wanted);
  }

  /** The steps of each horizon named (anything else is skipped), in the plan's horizon order. */
  private pickupSteps(horizonIds: Iterable<string>): PlanStep[] {
    if (!this.enabled()) return [];
    const wanted = new Set(horizonIds);
    if (wanted.size === 0) return [];
    const facts = this.facts();
    return facts.horizons.filter((row) => wanted.has(row.id)).flatMap((row) => this.stepsIn(facts, row.id));
  }

  /** Members of a horizon, put there or derived, that are not resolved: the work removing it would strand. */
  private openWorkOf(horizonId: string): number {
    const resolved = [...this.resolvedStatuses()];
    const rows = this.db
      .prepare(`SELECT i.status FROM ${MILESTONE_MEMBERSHIP} m JOIN issues i ON i.id = m.issue_id WHERE m.milestone_id = ?`)
      .all(horizonId) as Array<{ status: string }>;
    return rows.filter((row) => !resolved.includes(row.status)).length;
  }

  private isQueued(issueId: string): boolean {
    return this.db.prepare("SELECT 1 AS hit FROM queue_entries WHERE issue_id = ?").get(issueId) !== undefined;
  }

  /** Every tracker issue (never an unpromoted idea), read once per view: the work's subtrees come from this. */
  private work(): { rows: Map<string, WorkRow>; children: Map<string, string[]> } {
    const all = this.db
      .prepare("SELECT id, identifier, title, kind, status, parent_id, started_at, completed_at, cancelled_at FROM issues")
      .all() as unknown as WorkRow[];
    const rows = new Map<string, WorkRow>();
    const children = new Map<string, string[]>();
    for (const row of all) {
      if (isPlanKind(row.kind)) continue;
      rows.set(row.id, row);
    }
    for (const row of rows.values()) {
      if (row.parent_id === null || !rows.has(row.parent_id)) continue;
      const list = children.get(row.parent_id) ?? [];
      list.push(row.id);
      children.set(row.parent_id, list);
    }
    return { rows, children };
  }

  private subtree(root: string, children: Map<string, string[]>): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      for (const child of children.get(id) ?? []) stack.push(child);
    }
    return out;
  }

  /** Progress and dates over a set of roots, each leaf counted once. */
  private measure(
    roots: readonly string[],
    work: ReturnType<PlanStore["work"]>,
    categoryOf: (status: string) => StatusCategory | null = (status) => this.store.categoryOf(status),
  ): { leaves: number; done: number; resolved: number; start: string | null; end: string | null; progress: number | null } {
    const live = roots.filter((id) => work.rows.has(id));
    if (live.length === 0) return { leaves: 0, done: 0, resolved: 0, start: null, end: null, progress: null };
    const nodes = new Set<string>();
    for (const root of live) for (const id of this.subtree(root, work.children)) nodes.add(id);
    let leaves = 0;
    let done = 0;
    let start: string | null = null;
    let end: string | null = null;
    for (const id of nodes) {
      const row = work.rows.get(id)!;
      if (row.started_at && (start === null || row.started_at < start)) start = row.started_at;
      const finished = row.completed_at ?? row.cancelled_at;
      if (finished && (end === null || finished > end)) end = finished;
      if ((work.children.get(id) ?? []).length > 0) continue;
      const category = categoryOf(row.status);
      if (category === "cancelled") continue;
      leaves += 1;
      if (category === "done") done += 1;
    }
    const resolved = live.filter((id) => isResolvedCategory(categoryOf(work.rows.get(id)!.status))).length;
    const allResolved = resolved === live.length;
    const progress = leaves > 0 ? done / leaves : allResolved ? 1 : 0;
    return {
      leaves,
      done,
      resolved,
      start: start === null ? null : utcDay(start),
      end: allResolved && end !== null ? utcDay(end) : null,
      progress,
    };
  }

  /**
   * The plan's facts and every record's view, derived once per state of the database: a request
   * that checks a state, writes, and answers the plan and a record's detail rebuilds them only
   * when something changed. The key moves with any change this connection makes
   * (`total_changes()`) and any commit another connection makes (`data_version`); the views are
   * rebuilt too when the day they read dates against moves.
   */
  private facts(): PlanFacts {
    const { changes } = this.db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    const { data_version: version } = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    const key = `${changes}:${version}`;
    if (this.viewMemo?.key === key) return this.viewMemo.facts;
    const facts = this.buildPlanFacts();
    this.viewMemo = { key, facts, views: null };
    return facts;
  }

  private ideaViews(today: string): IdeaView[] {
    return this.viewsOf(this.facts(), today);
  }

  /** The views of the facts the memo holds (`facts()` was just read). */
  private viewsOf(facts: PlanFacts, today: string): IdeaView[] {
    const memo = this.viewMemo!;
    if (memo.views?.today === today) return memo.views.list;
    const list = this.buildIdeaViews(today, facts);
    memo.views = { today, list };
    return list;
  }

  private viewMemo: { key: string; facts: PlanFacts; views: { today: string; list: IdeaView[] } | null } | null = null;

  private buildPlanFacts(): PlanFacts {
    const categories = new Map(this.store.getStatuses().map((status) => [status.id, status.category]));
    const categoryOf = (status: string): StatusCategory | null => categories.get(status) ?? null;
    const rows = this.recordRows(new Set([...categories.keys()].filter((status) => isResolvedCategory(categoryOf(status)))));
    const byId = new Map(rows.map((row) => [row.id, row]));
    const childIds = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parent_id === null || !byId.has(row.parent_id)) continue;
      const list = childIds.get(row.parent_id) ?? [];
      list.push(row.id);
      childIds.set(row.parent_id, list);
    }
    const horizons = this.horizonRows();
    const horizonDates = new Map(horizons.map((row) => [row.id, row.target_date]));
    const work = this.work();
    const { delivery: links, exploration: explorations } = allPlanLinks(this.db);
    const breakdowns = planRowsByRecord(this.db);
    // Its own facts first: a record's size reads whether its sub-records are dropped.
    const records = new Map<string, RecordFacts>();
    for (const row of rows) {
      const promoted = row.kind !== IDEA_KIND;
      const ownLinks = links.get(row.id) ?? [];
      // Its own state reads its own work only: itself once promoted, and its own links. Linked
      // work whose issue is gone (a rewind, say) still counts, so the state does not slip back.
      const ownWork = [...(promoted ? [row.id] : []), ...ownLinks];
      const ownPresent = ownWork.filter((id) => work.rows.has(id));
      const own = this.measure(ownPresent, work, categoryOf);
      const maturity = readMaturity(row.plan_maturity);
      const horizonId = row.plan_horizon_id !== null && horizonDates.has(row.plan_horizon_id) ? row.plan_horizon_id : null;
      const stage = deriveStage({
        maturity,
        scheduled: horizonId !== null,
        links: ownWork.length,
        resolvedLinks: own.resolved,
        missingLinks: ownWork.length - ownPresent.length,
        deliveredOn: row.plan_delivered_on,
      });
      records.set(row.id, { promoted, ownLinks, ownWork, ownPresent, own, maturity, horizonId, stage, state: ideaState({ stage, maturity }) });
    }
    const sizes = new Map<string, RecordSizeView>();
    for (const row of rows) {
      const facts = records.get(row.id)!;
      const liveSubRecords = (childIds.get(row.id) ?? []).some((child) => records.get(child)!.stage !== "dropped");
      const size: RecordSize = {
        work: facts.ownPresent.length > 0 ? { done: facts.own.done, open: facts.own.leaves - facts.own.done } : null,
        rows: breakdowns.get(row.id)?.length ?? 0,
        liveSubRecords,
        delivered: isDelivered(row.plan_delivered_on),
      };
      sizes.set(row.id, { size, own: ownUnits(size) });
    }
    /**
     * The horizon that carries a record: the one it is scheduled on, else its nearest scheduled
     * ancestor's, unless that ancestor is dropped. A sub-idea scheduled on another horizon is
     * carried there, and so is everything beneath it that is scheduled on none.
     */
    const carrierOf = (id: string): string | null => {
      const seen = new Set<string>();
      for (let cursor: string | null = id; cursor !== null && !seen.has(cursor); cursor = byId.get(cursor)?.parent_id ?? null) {
        seen.add(cursor);
        const facts = records.get(cursor);
        if (facts === undefined) return null;
        if (facts.horizonId !== null) return facts.stage === "dropped" ? null : facts.horizonId;
      }
      return null;
    };
    const carried = new Map<string, ScheduledRecord[]>();
    const carrier = new Map<string, string>();
    for (const row of rows) {
      const facts = records.get(row.id)!;
      if (facts.stage === "dropped") continue;
      const horizonId = carrierOf(row.id);
      if (horizonId === null) continue;
      carrier.set(row.id, horizonId);
      const { size, own } = sizes.get(row.id)!;
      const list = carried.get(horizonId) ?? [];
      // Delivered outside the tracker with no own work: its done units are counted by no member's leaf.
      list.push({ state: facts.state, own, liveSubRecords: size.liveSubRecords, holds: holdsHorizon(facts.stage, size), delivered: size.delivered === true && size.work === null });
      carried.set(horizonId, list);
    }
    const blockers = allPlanBlockers(this.db);
    const held = holdsOf(rows, byId, records, blockers);
    const stepInputs = this.stepInputsOf(rows, byId, records, sizes, carrier, breakdowns, held);
    let proposals: Map<string, ShapeProposal> | null = null;
    return { rows, byId, childIds, horizons, horizonDates, work, links, explorations, blockers, held, proposals: () => (proposals ??= this.proposals()), categoryOf, records, sizes, carried, carrier, stepInputs, steps: null, accounting: new Map() };
  }

  /** Every record's standing proposal to be marked shaped, in one statement: an emptied one is none. */
  private proposals(): Map<string, ShapeProposal> {
    const out = new Map<string, ShapeProposal>();
    for (const row of this.db
      .prepare(
        `SELECT d.issue_id, r.body, r.author, r.created_at FROM documents d
           JOIN document_revisions r ON r.issue_id = d.issue_id AND r.key = d.key AND r.revision = d.current_revision
          WHERE d.key = ? AND trim(r.body) <> ''`,
      )
      .all(SHAPE_PROPOSAL_KEY) as Array<{ issue_id: string; body: string; author: string | null; created_at: string }>) {
      out.set(row.issue_id, { by: row.author, at: row.created_at, note: row.body.trim() === PROPOSAL_DEFAULT_NOTE ? null : row.body.trim() });
    }
    return out;
  }

  /**
   * What each carried record's plan step reads (design/plan.md, "Plan steps"), from the facts and
   * one read of every plan record's plan documents: a horizon's steps cost a constant, whatever it
   * carries.
   */
  private stepInputsOf(
    rows: readonly PlanRow[],
    byId: ReadonlyMap<string, PlanRow>,
    records: ReadonlyMap<string, RecordFacts>,
    sizes: ReadonlyMap<string, RecordSizeView>,
    carrier: ReadonlyMap<string, string>,
    breakdowns: ReadonlyMap<string, BreakdownRow[]>,
    held: ReadonlyMap<string, IdeaHold>,
  ): Map<string, Omit<PlanStepInput, "today">> {
    const out = new Map<string, Omit<PlanStepInput, "today">>();
    if (carrier.size === 0) return out;
    // A standing proposal rides the same statement: it makes the step the person's.
    const keys = [QUESTIONS_KEY, SHAPE_PROPOSAL_KEY, ...DOCUMENT_SECTIONS.map((name) => SECTION_KEYS[name])];
    const heads = new Map<string, Map<string, string>>();
    for (const row of this.db
      .prepare(
        `SELECT d.issue_id, d.key, r.body FROM documents d
           JOIN document_revisions r ON r.issue_id = d.issue_id AND r.key = d.key AND r.revision = d.current_revision
          WHERE d.key IN (${keys.map(() => "?").join(", ")}) AND d.issue_id IN (SELECT id FROM issues WHERE plan_maturity IS NOT NULL)`,
      )
      .all(...keys) as Array<{ issue_id: string; key: string; body: string }>) {
      const docs = heads.get(row.issue_id) ?? new Map<string, string>();
      docs.set(row.key, row.body);
      heads.set(row.issue_id, docs);
    }
    const sectionsOf = new Map(rows.map((row) => [row.id, sectionsFrom((key) => heads.get(row.id)?.get(key) ?? null, breakdowns.get(row.id) ?? [])]));
    const dependsOn = dependencyResolver(
      rows.map((row) => ({ id: row.id, identifier: shownIdentifier(row.identifier), title: row.title, rowKeys: sectionsOf.get(row.id)!.breakdown.map((entry) => entry.key), parentId: row.parent_id })),
    );
    /** The day a record may start: its own planned start, else its nearest ancestor's. */
    const startOf = (id: string): string | null => {
      const seen = new Set<string>();
      for (let cursor = byId.get(id); cursor !== undefined && !seen.has(cursor.id); cursor = cursor.parent_id === null ? undefined : byId.get(cursor.parent_id)) {
        seen.add(cursor.id);
        // A dropped or shipped ancestor's start holds nothing, as a dropped dependency holds nothing.
        const stage = cursor.id === id ? null : records.get(cursor.id)?.stage;
        if (stage === "dropped" || stage === "shipped") continue;
        if (cursor.plan_start !== null) return cursor.plan_start;
      }
      return null;
    };
    for (const [id, horizonId] of carrier) {
      const row = byId.get(id)!;
      const { ownWork, maturity, horizonId: scheduledOn, state } = records.get(id)!;
      const sections = sectionsOf.get(id)!;
      const questions = parseQuestions(heads.get(id)?.get(QUESTIONS_KEY) ?? null);
      const subIdea = sizes.get(id)!.size.liveSubRecords;
      const parentId = row.parent_id !== null && byId.has(row.parent_id) ? row.parent_id : null;
      out.set(id, {
        id,
        ref: shownIdentifier(row.identifier) ?? id,
        title: row.title,
        parentId,
        parentTitle: parentId === null ? null : byId.get(parentId)!.title,
        horizonId,
        scheduled: scheduledOn !== null,
        state,
        maturity,
        proposed: (heads.get(id)?.get(SHAPE_PROPOSAL_KEY) ?? "").trim() !== "",
        ownWork: ownWork.length > 0,
        openQuestions: questions.filter((q) => !q.resolved && !q.deferred).map((q) => q.text),
        gate: () => shapedGate(sections, questions, { subIdea }),
        // Only a shaped record with no own work reads it, and that one is held to the gate as its view is.
        planIncomplete: maturity === "shaped" && state === "shaped" ? shapedGate(sections, questions, { subIdea }) : [],
        start: startOf(id),
        // The records it is blocked by (its own and its ancestors'), then the ones its text names.
        dependsOn: [
          ...(held.get(id)?.blockers ?? []),
          ...dependsOn(id, sections).flatMap((dep) => {
            const facts = records.get(dep);
            return facts === undefined ? [] : [{ id: dep, title: byId.get(dep)!.title, state: facts.state }];
          }),
        ].filter((dep, index, all) => all.findIndex((other) => other.id === dep.id) === index),
        parents: held.get(id)?.parents ?? [],
        blockerIds: (held.get(id)?.blockers ?? []).map((blocker) => blocker.id),
      });
    }
    return out;
  }

  /** The carried records' plan steps on `today`, derived once per state of the database and day. */
  private stepsOn(facts: PlanFacts, today: string): Map<string, PlanStep> {
    if (facts.steps?.today === today) return facts.steps.byRecord;
    const byRecord = new Map<string, PlanStep>();
    for (const [id, input] of facts.stepInputs) {
      const step = planStepOf({ ...input, today });
      if (step !== null) byRecord.set(id, step);
    }
    /**
     * The waiting records beneath one, which its Scaffold would build too. A sub-idea that is held
     * (`heldBy`) is left out of its parent's Scaffold, which would then make the parent without it:
     * the parent waits for it all the same.
     */
    const waitingBeneath = (id: string, seen = new Set<string>()): PlanStep[] =>
      (facts.childIds.get(id) ?? []).flatMap((child) => {
        if (seen.has(child)) return [];
        seen.add(child);
        const step = byRecord.get(child);
        return [...(step?.need === "wait" ? [step] : []), ...waitingBeneath(child, seen)];
      });
    for (const [id, step] of byRecord) {
      if (step.need !== "scaffold") continue;
      const waiting = waitingBeneath(id);
      if (waiting.length > 0) byRecord.set(id, heldBySubIdeas(step, waiting));
    }
    facts.steps = { today, byRecord };
    return byRecord;
  }

  private buildIdeaViews(today: string, facts: PlanFacts): IdeaView[] {
    const { rows, byId, childIds, horizonDates, work, links, categoryOf, records, sizes } = facts;
    /** The work a record stands for: itself once promoted, its links, and its sub-records' work. */
    const rolledWork = (id: string, seen = new Set<string>()): Set<string> => {
      const out = new Set<string>();
      if (seen.has(id)) return out;
      seen.add(id);
      const row = byId.get(id);
      if (!row) return out;
      if (row.kind !== IDEA_KIND) out.add(row.id);
      for (const link of links.get(row.id) ?? []) out.add(link);
      for (const child of childIds.get(id) ?? []) for (const item of rolledWork(child, seen)) out.add(item);
      return out;
    };
    // Every record's sections first: a depends-on cell may name a row of another record's breakdown.
    const sectionsOf = new Map(rows.map((row) => [row.id, this.sectionsOf(row.id)]));
    const dependsOn = dependencyResolver(
      rows.map((row) => ({ id: row.id, identifier: shownIdentifier(row.identifier), title: row.title, rowKeys: sectionsOf.get(row.id)!.breakdown.map((entry) => entry.key), parentId: row.parent_id })),
    );
    /** Planned units of a record and every non-dropped record beneath it. */
    const rolledPlanned = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const own = records.get(id)!.stage === "dropped" ? 0 : sizes.get(id)!.own.planned;
      return own + (childIds.get(id) ?? []).reduce((sum, child) => sum + rolledPlanned(child, seen), 0);
    };
    /** Done units of records delivered outside the tracker with no own work, itself and beneath it: no ticket leaf counts those. */
    const rolledDelivered = (id: string, seen = new Set<string>()): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const { size, own } = sizes.get(id)!;
      const ownDone = records.get(id)!.stage !== "dropped" && size.delivered === true && size.work === null ? own.done : 0;
      return ownDone + (childIds.get(id) ?? []).reduce((sum, child) => sum + rolledDelivered(child, seen), 0);
    };
    const steps = this.stepsOn(facts, today);
    return rows.map((row) => {
      const { promoted, ownLinks, ownWork, maturity, horizonId, stage, state } = records.get(row.id)!;
      const sized = sizes.get(row.id)!;
      const sections = sectionsOf.get(row.id)!;
      const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
      const delivered = isDelivered(row.plan_delivered_on) ? { on: row.plan_delivered_on, note: this.documentBody(row.id, DELIVERED_NOTE_KEY) || null } : null;
      // The rollup adds its sub-records' work: what the record displays, never its state.
      const workIds = [...rolledWork(row.id)];
      const present = workIds.filter((id) => work.rows.has(id));
      const measured = this.measure(present, work, categoryOf);
      const rolled = units(measured.done + rolledDelivered(row.id), measured.leaves - measured.done, rolledPlanned(row.id));
      const rolledShipped = present.length > 0 && measured.resolved >= present.length;
      // Delivered outside the tracker with no work present: the delivery day is its actual end,
      // and nothing is forecast. Once work is linked, the window is that work's, as for any
      // record, ending no earlier than the delivery day once it has all landed.
      const deliveredAlone = delivered !== null && present.length === 0;
      const actual: ActualWindow = deliveredAlone
        ? { start: null, end: delivered.on, forecastEnd: null }
        : {
            start: measured.start,
            end: delivered !== null && measured.end !== null && delivered.on > measured.end ? delivered.on : measured.end,
            forecastEnd: forecastEnd({ start: measured.start, end: measured.end, progress: measured.progress ?? 0, today }),
          };
      const started = workIds.length > 0;
      const hasBaseline = ownWork.length > 0 && (row.plan_baseline_start !== null || row.plan_baseline_target !== null);
      // An umbrella: a sub-idea that is not dropped stands in for its own rows.
      const subIdea = sizes.get(row.id)!.size.liveSubRecords;
      // Scaffolded before: a started record scaffolds again only then, to add new rows and sub-ideas
      // shaped since. A task of one of its rows exists, or it is a promoted umbrella with no rows,
      // whose Scaffold made the same epic Promote makes and builds nothing but its sub-ideas.
      const scaffolded =
        state === "started" &&
        promoted &&
        (sections.breakdown.length === 0 ? subIdea : planRowsOf(this.db, row.id).some((planRow) => this.issueExists(scaffoldTaskId(row.id, planRow.id))));
      // A shaped plan is held to the gate again before anything is built from it.
      const planIncomplete = maturity === "shaped" && (state === "shaped" || scaffolded) ? this.gateOf(row.id, undefined, subIdea) : [];
      const heldBy = facts.held.get(row.id) ?? null;
      const blockedBy = facts.blockers.get(row.id) ?? [];
      const lifecycle = ideaLifecycle({
        state,
        promoted,
        maturity,
        delivered: delivered !== null,
        ownLinks: ownLinks.length,
        gate: maturity === "raw" || maturity === "exploring" ? () => this.gateOf(row.id, undefined, subIdea) : () => [],
        scaffolded,
        planIncomplete,
        heldBy,
        proposed: facts.proposals().has(row.id),
      });
      return {
        id: row.id,
        identifier: shownIdentifier(row.identifier),
        number: ideaNumberOf(row),
        promoted: row.kind !== IDEA_KIND,
        kind: row.kind,
        title: row.title,
        description: row.description,
        briefLine: firstLine(this.documentBody(row.id, BRIEF_KEY)),
        maturity,
        stage,
        parentId: row.parent_id !== null && byId.has(row.parent_id) ? row.parent_id : null,
        horizonId,
        planned: { start: row.plan_start, target: row.plan_target },
        baseline: hasBaseline ? { start: row.plan_baseline_start, target: row.plan_baseline_target } : null,
        rank: row.plan_rank ?? 0,
        links: ownLinks,
        explorations: facts.explorations.get(row.id) ?? [],
        missingLinks: ownLinks.filter((id) => !work.rows.has(id)),
        linkCount: workIds.length,
        resolvedLinks: measured.resolved,
        units: rolled,
        unsized: sized.own.unsized,
        own: units(sized.own.done, sized.own.open, sized.own.planned),
        umbrella: isUmbrella(sized.size),
        carriedBy: facts.carrier.get(row.id) ?? null,
        progress: started || deliveredAlone ? (unitProgress(rolled) ?? measured.progress) : null,
        percent: started || deliveredAlone ? unitPercent(rolled) : null,
        actual,
        late: isLate({
          plannedTarget: row.plan_target,
          horizonDate: horizonId === null ? null : (horizonDates.get(horizonId) ?? null),
          actual,
          links: workIds.length,
          open: !rolledShipped && stage !== "dropped",
          today,
          // With work present, late reads that work's window, which the delivery day already bounds.
          deliveredOn: deliveredAlone ? delivered.on : null,
        }),
        notStarted: isNotStarted({ plannedStart: row.plan_start, links: workIds.length, dropped: maturity === "dropped", today, deliveredOn: row.plan_delivered_on }),
        delivered,
        childIds: childIds.get(row.id) ?? [],
        openQuestions: questions.filter((q) => !q.resolved).length,
        completeness: completeness(sections, questions, parseDecisions(this.documentBody(row.id, DECISIONS_KEY))),
        dependsOn: [...new Set([...blockedBy.filter((id) => byId.has(id) && !relatedRecords(byId, id, row.id)), ...dependsOn(row.id, sections)])],
        blockedBy,
        heldBy,
        planIncomplete,
        ...lifecycle,
        // A proposal stands while the record can still be marked shaped; once shaped or dropped it is history.
        shapeProposal: lifecycle.actions.some((action) => action.id === "shape") ? (facts.proposals().get(row.id) ?? null) : null,
        nextStep: steps.get(row.id) ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  ideaView(ref: string): IdeaView {
    const row = this.recordRow(ref, false);
    const idea = this.ideaViews(this.today()).find((view) => view.id === row.id);
    if (!idea) throw new StapleError("not_found", `${displayRef(row)} is not an open idea.`);
    return idea;
  }

  /** One record with its brief, questions, decisions, children and linked work. */
  detail(ref: string): IdeaDetail {
    this.assertEnabled();
    const row = this.recordRow(ref, false);
    const today = this.today();
    const facts = this.facts();
    const ideas = this.viewsOf(facts, today);
    const idea = ideas.find((view) => view.id === row.id);
    if (!idea) throw new StapleError("not_found", `${displayRef(row)} is not an open idea.`);
    const horizonRow = facts.horizons.find((h) => h.id === idea.horizonId);
    const parentRow = idea.parentId === null ? undefined : ideas.find((view) => view.id === idea.parentId);
    const work = this.work();
    return {
      idea,
      parent: parentRow ? { id: parentRow.id, identifier: parentRow.identifier, title: parentRow.title } : null,
      children: ideas.filter((view) => view.parentId === idea.id),
      horizon: horizonRow ? this.horizonView(horizonRow, ideas, facts) : null,
      brief: this.documentBody(row.id, BRIEF_KEY),
      questions: parseQuestions(this.documentBody(row.id, QUESTIONS_KEY)),
      decisions: parseDecisions(this.documentBody(row.id, DECISIONS_KEY)),
      linked: idea.links.map((id) => this.linkView(id, work)),
      exploration: idea.explorations.map((id) => this.linkView(id, work)),
      ...this.planOf(row.id, idea),
      ...this.provenanceOf(row.id),
      blockedBy: idea.blockedBy.map((id) => blockerRef(id, ideas.find((view) => view.id === id))),
      blocks: ideas.filter((view) => view.blockedBy.includes(idea.id)).map((view) => blockerRef(view.id, view)),
      today,
    };
  }

  /** The ticket that sparked a record, and the ideas its own work sparked (`plan-provenance.ts`). */
  private provenanceOf(id: string): Pick<IdeaDetail, "sparkedBy" | "sparked"> {
    const origin = this.db.prepare("SELECT id, parent_id, origin_kind, origin_id FROM issues WHERE id = ?").get(id) as {
      id: string;
      parent_id: string | null;
      origin_kind: string;
      origin_id: string | null;
    };
    return { sparkedBy: sparkedByOf(this.db, origin), sparked: sparkedIdeasOf(this.db, id) };
  }

  /** A record's plan sections, as stored: the document sections and the breakdown's rows. */
  sectionsOf(id: string): PlanSections {
    return sectionsFrom(
      (key) => this.documentBody(id, key),
      planRowsOf(this.db, id).map(({ rank: _rank, ...row }) => row),
    );
  }

  /**
   * What the shaped gate finds missing in a record's plan as it stands, its sub-ideas included. The
   * plan read passes whether it has a sub-idea from the records it already holds.
   */
  private gateOf(id: string, sections: PlanSections = this.sectionsOf(id), subIdea: boolean = this.hasSubIdea(id)): string[] {
    return shapedGate(sections, parseQuestions(this.documentBody(id, QUESTIONS_KEY)), { subIdea });
  }

  /**
   * Whether a record has a sub-idea that is not dropped, as the plan lists its records: an umbrella
   * passes the gate's breakdown on its sub-ideas.
   */
  private hasSubIdea(id: string): boolean {
    const children = this.db
      .prepare("SELECT kind, status FROM issues WHERE parent_id = ? AND plan_maturity IS NOT NULL AND plan_maturity <> 'dropped'")
      .all(id) as Array<{ kind: string; status: string }>;
    if (children.length === 0) return false;
    const resolved = this.resolvedStatuses();
    return children.some((child) => child.kind !== IDEA_KIND || !resolved.has(child.status));
  }

  /** The breakdown's revision: a digest of its rows, ids and order. */
  private breakdownRevision(id: string): string {
    return digest(planRowsOf(this.db, id).map(({ rank: _rank, ...row }) => row));
  }

  private issueExists(id: string): boolean {
    return this.db.prepare("SELECT 1 AS hit FROM issues WHERE id = ?").get(id) !== undefined;
  }

  private planOf(id: string, idea: IdeaView): Pick<IdeaDetail, "plan" | "completeness" | "missingForShaped" | "planWarnings" | "breakdownRevision" | "scaffold"> {
    const plan = this.sectionsOf(id);
    const questions = parseQuestions(this.documentBody(id, QUESTIONS_KEY));
    const decisions = parseDecisions(this.documentBody(id, DECISIONS_KEY));
    const offersScaffold = idea.actions.some((action) => action.id === "scaffold");
    return {
      plan,
      completeness: completeness(plan, questions, decisions),
      missingForShaped: shapedGate(plan, questions, { subIdea: this.hasSubIdea(id) }),
      planWarnings: planWarnings(plan),
      breakdownRevision: this.breakdownRevision(id),
      scaffold: offersScaffold ? this.scaffoldPreview(id) : null,
    };
  }

  private linkView(id: string, work: ReturnType<PlanStore["work"]>): LinkView {
    const row = work.rows.get(id);
    if (!row) {
      return {
        missing: true,
        id,
        identifier: id,
        title: "Missing: this issue is no longer on this device",
        kind: "",
        status: "",
        resolved: false,
        leaves: 0,
        doneLeaves: 0,
        progress: 0,
        percent: 0,
        startedAt: null,
        completedAt: null,
        milestone: null,
      };
    }
    const measured = this.measure([id], work);
    return {
      missing: false,
      id,
      identifier: row.identifier,
      title: row.title,
      kind: row.kind,
      status: row.status,
      resolved: this.store.isResolvedStatus(row.status),
      leaves: measured.leaves,
      doneLeaves: measured.done,
      progress: measured.progress ?? 0,
      // Its leaves when it has any, else whether it landed: whole percent, as every surface prints it.
      percent: measured.leaves > 0 ? unitPercent({ done: measured.done, total: measured.leaves }) ?? 0 : measured.progress === 1 ? 100 : 0,
      startedAt: measured.start,
      completedAt: measured.end,
      milestone: this.milestoneOf(id),
    };
  }

  /** The milestone holding a linked issue, and a live run on it, read-only. */
  private milestoneOf(id: string): LinkView["milestone"] {
    try {
      const milestoneId = this.store.milestones().milestoneOf(id);
      if (milestoneId === null) return null;
      const milestone = this.store.milestones().get(milestoneId).milestone;
      const run =
        this.store
          .runs()
          .list({ all: true })
          .find((candidate) => candidate.scope.kind === "milestone" && candidate.scope.issueId === milestone.id && (candidate.state === "active" || candidate.state === "paused")) ?? null;
      return {
        identifier: milestone.identifier,
        title: milestone.title,
        state: milestone.state,
        run: run === null ? null : { state: run.state, actor: run.actor },
      };
    } catch {
      return null;
    }
  }

  /**
   * A document's head body by the record's id, or null when it has none. One indexed read: the
   * plan reads several documents of every record it shows, so this never resolves a reference.
   */
  private documentBody(id: string, key: string): string | null {
    this.headBody ??= this.db.prepare(
      `SELECT r.body FROM documents d JOIN document_revisions r ON r.issue_id = d.issue_id AND r.key = d.key AND r.revision = d.current_revision
        WHERE d.issue_id = ? AND d.key = ?`,
    );
    const row = this.headBody.get(id, key) as { body: string } | undefined;
    return row === undefined ? null : row.body;
  }

  private headBody: StatementSync | null = null;

  // ---------- records ----------

  /** Capture an idea. An agent captures raw ideas only: title, parent and brief. No ticket number. */
  capture(input: CaptureInput, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    return this.captureWith(input, { questions: [], decisions: [] }, actor, options);
  }

  /**
   * Capture with the questions and decisions it starts with (an import's): the shaped gate reads
   * everything the capture writes, questions included, before any of it is written.
   */
  private captureWith(input: CaptureInput, extra: { questions: Question[]; decisions: string[] }, actor: string | null, options: PlanWriteOptions): IdeaView {
    this.assertEnabled();
    const title = oneLine(input.title ?? "", "An idea's title");
    const maturity = input.maturity === undefined ? "raw" : parseMaturity(input.maturity);
    if (maturity !== "raw") this.steer("maturity", null, options);
    // Captured straight into a maturity, it is in that state: what it may carry follows the table.
    const subject = `the idea "${title}"`;
    if (input.horizon) {
      assertIdeaAction(subject, maturity, "schedule");
      this.steer("horizon", null, options);
    }
    if (input.plannedStart || input.plannedTarget) {
      assertIdeaAction(subject, maturity, "plan_dates");
      this.steer("planned dates", null, options);
    }
    const patch = checkPlanPatch(input.plan);
    const sections = mergeSections(emptySections(), patch);
    // A record captured here has no sub-idea yet, so its own rows are its breakdown.
    if (maturity === "shaped") assertShaped(subject, shapedGate(sections, extra.questions));
    if (input.sparkedBy !== undefined && input.sparkedBy !== null && input.sparkedBy.trim() === "") {
      throw new StapleError("validation", "sparkedBy names the ticket whose work sparked the idea; it was empty. Leave it out to capture an idea no ticket sparked.");
    }
    const sparkedBy = input.sparkedBy ? this.sparkingTicket(input.sparkedBy) : null;
    const id = this.store.journaled(() => {
      const ideaId = newId();
      const issue = this.store.createIssue(
        {
          title,
          kind: IDEA_KIND,
          parent: input.parent ?? null,
          createdBy: actor,
          allowDuplicate: true,
          // The ticket that sparked it rides in its own create, as a finding's origin does.
          ...(sparkedBy ? { originKind: SPARKED_ORIGIN_KIND, originId: sparkedOriginId(sparkedBy.id, ideaId) } : {}),
        },
        { plan: true, id: ideaId },
      );
      const columns: Record<string, unknown> = { plan_maturity: maturity, plan_rank: this.nextRecordRank() };
      if (input.horizon) columns.plan_horizon_id = this.horizonRow(input.horizon).id;
      const window = {
        start: input.plannedStart ? parsePlanDate(input.plannedStart) : null,
        target: input.plannedTarget ? parsePlanDate(input.plannedTarget) : null,
      };
      assertPlanWindow(window);
      if (window.start) columns.plan_start = window.start;
      if (window.target) columns.plan_target = window.target;
      this.write(issue.id, columns, actor, "idea_captured", { maturity });
      if (input.brief?.trim()) this.store.putDocument(issue.id, BRIEF_KEY, input.brief, { author: actor }, { plan: true });
      if (input.plan) this.writeSections(issue.id, emptySections(), sections, patch, actor);
      if (extra.questions.length > 0) {
        this.store.putDocument(issue.id, QUESTIONS_KEY, renderQuestions(extra.questions), { author: actor, changeSummary: "imported" }, { plan: true });
      }
      if (extra.decisions.length > 0) {
        this.store.putDocument(issue.id, DECISIONS_KEY, extra.decisions.map((line) => `- ${line}`).join("\n") + "\n", { author: actor, changeSummary: "imported" }, { plan: true });
      }
      this.settleMembership(actor);
      return issue.id;
    });
    return this.ideaView(id);
  }

  /**
   * The ticket an idea names as sparking it: tracker work that exists here. An idea is not one
   * (one part of another is its sub-idea, `parent`), nor is a milestone or a horizon, which hold
   * work rather than do it.
   */
  private sparkingTicket(ref: string): { id: string; identifier: string } {
    const target = this.store.getIssue(ref.trim());
    if (target.kind === IDEA_KIND) {
      throw new StapleError("validation", `${ref.trim()} is an idea, not a ticket. An idea is sparked by the ticket whose work turned it up; to make it part of another idea, give that idea as its parent.`);
    }
    if (target.kind === MILESTONE_KIND) {
      throw new StapleError("validation", `${target.identifier} is a milestone, not a ticket. An idea is sparked by the ticket whose work turned it up.`);
    }
    return { id: target.id, identifier: target.identifier };
  }

  update(ref: string, patch: IdeaPatch, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    const before = this.stateOf(row.id);
    let state = before;
    const allow = (action: IdeaAction) => this.allowIdea(row, action, options, state);
    if (patch.title !== undefined || patch.brief !== undefined || patch.plan !== undefined) allow("edit");
    const planPatch = patch.plan === undefined ? undefined : checkPlanPatch(patch.plan);
    if (planPatch?.breakdown !== undefined && patch.breakdownBase !== undefined && patch.breakdownBase !== this.breakdownRevision(row.id)) {
      throw new StapleError(
        "revision_conflict",
        `The task breakdown of ${displayRef(row)} changed since it was read (it is at ${this.breakdownRevision(row.id)}, not ${patch.breakdownBase}). Re-read it and make the edit again.`,
        { current: this.breakdownRevision(row.id) },
      );
    }
    const current = this.sectionsOf(row.id);
    const sections = planPatch ? mergeSections(current, planPatch) : current;
    // A maturity it already has is no change: nothing to allow and nothing to write.
    const maturity = patch.maturity === undefined ? undefined : parseMaturity(patch.maturity);
    const moves = maturity !== undefined && maturity !== readMaturity(row.plan_maturity);
    if (moves) {
      const action = maturityAction({ state: before, maturity: readMaturity(row.plan_maturity) }, maturity);
      if (action !== null) allow(action);
      // Shaped only when the plan, as this write leaves it, passes the gate: marked shaped, or restored into shaped.
      if (action === "shape" || (action === "restore" && maturity === "shaped")) assertShaped(displayRef(row), this.gateOf(row.id, sections));
      // Restored into raw, it is raw: what it holds follows the table, as a capture into raw does (never scheduled, no dates).
      // A record made more complete reads exploring once restored into raw, which may hold them.
      if (action === "restore" && maturity === "raw" && row.plan_explored === null) assertRestorableToRaw(row, this.listedHorizon(row.plan_horizon_id), planLinksOf(this.db, row.id, "exploration").length > 0);
      // The rest of one write is held to the state its maturity change leads to: shaping a raw idea
      // and scheduling it is one decision. A started or shipped record keeps its state.
      // Restored into raw, a record made more complete reads exploring, and is held to that.
      if (before !== "started" && before !== "shipped") state = maturity === "raw" && row.plan_explored !== null ? "exploring" : maturity;
    }
    if (patch.horizon !== undefined) allow("schedule");
    if (patch.parent !== undefined) allow("reparent");
    if (patch.plannedStart !== undefined || patch.plannedTarget !== undefined) allow("plan_dates");
    if (patch.before !== undefined) allow("reorder");
    // Clearing a mark the record does not carry is no change, as a maturity it already has is.
    const marked = isDelivered(row.plan_delivered_on);
    const delivery = patch.delivered === undefined || (patch.delivered === null && !marked) ? undefined : patch.delivered;
    if (delivery !== undefined) allow(delivery === null ? "clear_delivered" : "mark_delivered");
    const deliveredOn = delivery ? parseDeliveredOn(delivery.on, this.today()) : null;
    if (patch.proposeShaped !== undefined) {
      allow("propose_shape");
      const missing = this.gateOf(row.id, sections);
      if (missing.length > 0) {
        throw new StapleError("validation", `${capitalized(displayRef(row))} cannot be proposed shaped yet: ${gateSentence(missing)}.`, { missing });
      }
    }
    const proposed = this.proposalOf(row.id) !== null;
    if (patch.dismissProposal && patch.proposeShaped !== undefined) throw new StapleError("validation", "One write proposes an idea shaped or dismisses the proposal, not both.");
    if (patch.dismissProposal) {
      allow("dismiss_proposal");
      if (!proposed) throw new StapleError("validation", `Nothing is proposed for ${displayRef(row)}; there is no proposal to dismiss.`);
    }
    this.store.journaled(() => {
      if (patch.title !== undefined) this.store.updateIssue(row.id, { title: oneLine(patch.title, "An idea's title") }, actor);
      if (patch.brief !== undefined) this.store.putDocument(row.id, BRIEF_KEY, patch.brief ?? "", { author: actor }, { plan: true });
      const enriched = planPatch ? this.writeSections(row.id, current, sections, planPatch, actor) : false;
      const columns: Record<string, unknown> = {};
      if (moves) columns.plan_maturity = maturity;
      if (patch.horizon !== undefined) columns.plan_horizon_id = patch.horizon === null ? null : this.horizonRow(patch.horizon).id;
      if (patch.plannedStart !== undefined || patch.plannedTarget !== undefined) {
        const window = {
          start: patch.plannedStart === undefined ? row.plan_start : patch.plannedStart === null ? null : parsePlanDate(patch.plannedStart),
          target: patch.plannedTarget === undefined ? row.plan_target : patch.plannedTarget === null ? null : parsePlanDate(patch.plannedTarget),
        };
        assertPlanWindow(window);
        columns.plan_start = window.start;
        columns.plan_target = window.target;
      }
      if (patch.before !== undefined) columns.plan_rank = this.rankBefore("records", row.id, patch.before, actor);
      if (delivery !== undefined) {
        columns.plan_delivered_on = deliveredOn;
        // The note goes with the mark: written with it, and emptied when the mark is cleared or given none.
        const note = typeof delivery?.note === "string" ? delivery.note.trim() : "";
        if (note !== "" || this.documentBody(row.id, DELIVERED_NOTE_KEY)) this.store.putDocument(row.id, DELIVERED_NOTE_KEY, note, { author: actor }, { plan: true });
      }
      this.write(row.id, columns, actor, "idea_updated", { fields: Object.keys(columns) });
      if (enriched) this.explore(row.id, actor, "plan");
      // The person moved its maturity, marked it delivered (or cleared that), or set the proposal aside: a proposal no longer stands.
      if (proposed && (moves || delivery !== undefined || patch.dismissProposal)) this.store.putDocument(row.id, SHAPE_PROPOSAL_KEY, "", { author: actor, changeSummary: moves ? "proposal settled" : "proposal dismissed" }, { plan: true });
      if (patch.proposeShaped !== undefined) {
        const note = typeof patch.proposeShaped.note === "string" && patch.proposeShaped.note.trim() !== "" ? patch.proposeShaped.note.trim() : PROPOSAL_DEFAULT_NOTE;
        this.store.putDocument(row.id, SHAPE_PROPOSAL_KEY, note, { author: actor, changeSummary: "proposed shaped" }, { plan: true });
      }
      if (patch.parent !== undefined) this.reparent(row, patch.parent, actor);
      this.keepBaselines(row.id, actor);
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /**
   * Each document section that changed, as its own revisioned document (an emptied one keeps an
   * empty revision); and the breakdown, when the patch names it, one row field at a time.
   */
  private writeSections(id: string, before: PlanSections, after: PlanSections, patch: PlanPatch, actor: string | null): boolean {
    let changed = false;
    for (const name of DOCUMENT_SECTIONS) {
      const body = renderSection(name, after);
      if (body === renderSection(name, before)) continue;
      this.store.putDocument(id, SECTION_KEYS[name], body, { author: actor, changeSummary: `${name} updated` }, { plan: true });
      changed = true;
    }
    if (patch.breakdown !== undefined && this.writeBreakdown(id, after.breakdown, actor)) changed = true;
    return changed;
  }

  /**
   * The breakdown as `rows` says, written as only the rows that changed: each is one field of
   * the idea's `milestone` entity (`plan-rows.ts`), a removed row a null. A row keeps its rank
   * while the order allows, so an edit to one row never rewrites the others. One operation.
   */
  private writeBreakdown(id: string, rows: readonly BreakdownRow[], actor: string | null): boolean {
    const current = new Map(planRowsOf(this.db, id).map((row) => [row.id, row]));
    const payload: Record<string, PlanRowValue | null> = {};
    const counts = { added: 0, changed: 0, removed: 0 };
    let previous = -Infinity;
    rows.forEach((row, index) => {
      const held = current.get(row.id);
      let rank: number;
      if (held !== undefined && held.rank > previous) {
        rank = held.rank;
      } else {
        const following = rows.slice(index + 1).map((next) => current.get(next.id)?.rank).find((value): value is number => value !== undefined);
        const floor = previous === -Infinity ? 0 : previous;
        rank = following !== undefined && following > floor + 1e-6 ? (previous === -Infinity ? following - 1024 : (floor + following) / 2) : floor + 1024;
      }
      previous = rank;
      const value = planRowValue(row, rank);
      if (held !== undefined && JSON.stringify(planRowValue(held, held.rank)) === JSON.stringify(value)) return;
      writePlanRow(this.db, id, row.id, value);
      payload[planRowField(row.id)] = value;
      counts[held === undefined ? "added" : "changed"] += 1;
    });
    const kept = new Set(rows.map((row) => row.id));
    for (const rowId of current.keys()) {
      if (kept.has(rowId)) continue;
      writePlanRow(this.db, id, rowId, null);
      payload[planRowField(rowId)] = null;
      counts.removed += 1;
    }
    if (Object.keys(payload).length === 0) return false;
    this.store.journal.record({ entity: "milestone", entityId: id, verb: "update", payload, actor: actor ?? null });
    insertEvent(this.db, { kind: "idea_breakdown_updated", issueId: id, actor, payload: counts });
    return true;
  }

  /** Re-file a record under another record (or at the top), moving its subtree's depth with it. */
  private reparent(row: PlanRow, parentRef: string | null, actor: string | null): void {
    const parent = parentRef === null ? null : this.recordRow(parentRef);
    if (parent !== null) {
      let cursor: string | null = parent.id;
      for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
        if (cursor === row.id) throw new StapleError("validation", `${displayRef(parent)} sits under ${displayRef(row)}; an idea cannot be its own ancestor.`);
        cursor = (this.db.prepare("SELECT parent_id FROM issues WHERE id = ?").get(cursor) as { parent_id: string | null } | undefined)?.parent_id ?? null;
      }
    }
    const depth = parent === null ? 0 : parent.depth + 1;
    this.write(row.id, { parent_id: parent?.id ?? null, depth }, actor, "idea_moved", {});
    const walk = (id: string, level: number): void => {
      for (const child of this.db.prepare("SELECT id FROM issues WHERE parent_id = ?").all(id) as Array<{ id: string }>) {
        this.db.prepare("UPDATE issues SET depth = ? WHERE id = ?").run(level, child.id);
        walk(child.id, level + 1);
      }
    };
    walk(row.id, depth + 1);
  }

  addQuestion(ref: string, text: string, actor: string | null): IdeaDetail {
    const row = this.recordRow(ref);
    this.allowIdea(row, "ask", {});
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    questions.push({ text: oneLine(text, "A question"), resolved: false });
    this.store.journaled(() => {
      this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: "question added" }, { plan: true });
      this.explore(row.id, actor, "question");
    });
    return this.detail(row.id);
  }

  /** Resolve (or reopen) the question at a 1-based position. */
  resolveQuestion(ref: string, position: number, actor: string | null, resolved = true): IdeaDetail {
    const row = this.recordRow(ref);
    this.allowIdea(row, "ask", {});
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    const question = questions[position - 1];
    if (!question) {
      throw new StapleError("validation", `${displayRef(row)} has ${questions.length} question${questions.length === 1 ? "" : "s"}; there is no #${position}.`);
    }
    question.resolved = resolved;
    this.store.journaled(() => {
      this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: resolved ? "question resolved" : "question reopened" }, { plan: true });
      this.explore(row.id, actor, "question");
    });
    return this.detail(row.id);
  }

  /** Defer (or un-defer) the question at a 1-based position: left open on purpose, it no longer holds shaping back. */
  deferQuestion(ref: string, position: number, actor: string | null, deferred = true): IdeaDetail {
    const row = this.recordRow(ref);
    this.allowIdea(row, "ask", {});
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    const question = questions[position - 1];
    if (!question) {
      throw new StapleError("validation", `${displayRef(row)} has ${questions.length} question${questions.length === 1 ? "" : "s"}; there is no #${position}.`);
    }
    question.deferred = deferred;
    if (deferred) question.resolved = false;
    this.store.journaled(() => {
      this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: deferred ? "question deferred" : "question reopened" }, { plan: true });
      this.explore(row.id, actor, "question");
    });
    return this.detail(row.id);
  }

  addDecision(ref: string, text: string, actor: string | null): IdeaDetail {
    const row = this.recordRow(ref);
    this.allowIdea(row, "decide", {});
    const decisions = parseDecisions(this.documentBody(row.id, DECISIONS_KEY));
    decisions.push(`${this.today()}: ${oneLine(text, "A decision")}`);
    this.store.journaled(() => {
      this.store.putDocument(row.id, DECISIONS_KEY, decisions.map((line) => `- ${line}`).join("\n") + "\n", { author: actor, changeSummary: "decision added" }, { plan: true });
      this.explore(row.id, actor, "decision");
    });
    return this.detail(row.id);
  }

  // ---------- into the tracker: Promote, Adopt, Unlink ----------

  /**
   * Promote in place: the idea becomes the epic on the same record. It takes the next ticket
   * number then, and keeps its documents, comments, files, events, links and plan fields; its
   * sub-ideas stay under it. Only a shaped idea offers promotion, to a person or an agent alike,
   * whether or not its parent is promoted.
   *
   * The plan's tree is the tracker's: a record's parent stays its parent through promotion. An
   * epic whose parent is still an idea is top-level work to the tracker (`WorkspaceStore.tree`,
   * and ideas derive nothing), and the moment that parent is promoted the same write makes it the
   * epic above them, so its status is derived from theirs here, in this transaction.
   */
  promote(ref: string, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    // A record already promoted says what it is now, which tells more than its state does.
    if (row.kind !== IDEA_KIND) {
      throw new StapleError("validation", `${row.identifier} is already promoted: it is ${aKind(row.kind)} in the tracker now.`, { identifier: row.identifier });
    }
    this.allowIdea(row, "promote", options);
    this.assertPlanComplete(row, "promoted");
    this.assertNotHeld(row, "promoted");
    this.store.journaled(() => {
      this.promoteRecord(row.id, this.promotedKind(), actor);
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /**
   * A shaped record is built from only while its plan passes the gate: an edit since it was
   * shaped (a cleared goal, an open question, a removed row) holds Scaffold and Promote back,
   * naming what is missing. Its maturity is left as it is; the person decides that.
   */
  private assertPlanComplete(row: PlanRow, verb: "promoted" | "scaffolded"): void {
    const missing = this.gateOf(row.id);
    if (missing.length === 0) return;
    throw new StapleError(
      "validation",
      `${displayRef(row)} is shaped, but its plan is incomplete, so it cannot be ${verb}: ${gateSentence(missing).replace(/ before it is shaped$/, "")}.`,
      { missing },
    );
  }

  /**
   * A shaped sub-idea is built from only once every idea above it is shaped and what it (or an
   * idea above it) is blocked by has shipped: until then Scaffold and Promote are refused, naming
   * what it waits on. Scheduling it, on any horizon, stays open.
   */
  private assertNotHeld(row: PlanRow, verb: "promoted" | "scaffolded"): void {
    const hold = this.ideaView(row.id).heldBy;
    if (hold === null) return;
    throw new StapleError(
      "validation",
      `${displayRef(row)} cannot be ${verb} yet: it is ${this.stateOf(row.id)} · ${holdLabel(hold)}, ${holdWords(hold)}. It waits until every idea above it is shaped and what it is blocked by has shipped.`,
      { heldBy: hold },
    );
  }

  /**
   * The record becomes its epic in place, and sub-records promoted before it now hang under that
   * epic, which derives its status from theirs in the same write. Promotion and Scaffold share it.
   */
  private promoteRecord(id: string, kind: string, actor: string | null): void {
    this.store.promoteInPlace(id, kind, actor);
    const promotedChildren = this.db
      .prepare("SELECT id FROM issues WHERE parent_id = ? AND plan_maturity IS NOT NULL AND kind <> ?")
      .all(id, IDEA_KIND) as Array<{ id: string }>;
    if (promotedChildren.length > 0) this.store.rederiveParents(promotedChildren.map((child) => child.id), "plan", actor);
    this.keepBaselines(id, actor);
  }

  // ---------- a misfiled ticket becomes an idea ----------

  /**
   * Convert a ticket that should have been an idea into one (design/plan.md, "Converting a ticket
   * into an idea"). The same record becomes a raw idea at the end of the plan, keeping its
   * comments, documents, files, history and external links, and its ticket number names it still.
   * Its children convert with it, as its sub-ideas, each keeping its own. A person or an agent may
   * do it, as either may capture a raw idea.
   *
   * Refused, naming every reason, unless the ticket and everything under it is open, unclaimed and
   * not started, with nothing that would make a plan record wait or be waited on: no dependency,
   * no place in the pickup queue or a milestone, no link to an idea. A parent that is ordinary
   * tracker work is left (an idea's parent is an idea); a parent in the plan stays its parent.
   */
  convertTicket(ref: string, actor: string | null): { idea: IdeaView; converted: Array<{ from: string; to: string; title: string }>; detachedFrom: string | null } {
    this.assertEnabled();
    const root = this.row(ref);
    const subject = `${root.identifier} "${root.title}"`;
    if (root.kind === IDEA_KIND || root.plan_maturity !== null) {
      throw new StapleError("validation", `${displayRef(root)} is already part of the plan; only a ticket can be converted into an idea.`, { identifier: root.identifier });
    }
    const subtree = this.subtreeRows(root.id);
    const reasons = subtree.flatMap((row) => this.conversionProblems(row, row.id === root.id).map((problem) => (row.id === root.id ? problem : `${row.identifier} "${row.title}" under it ${problem}`)));
    if (reasons.length > 0) {
      throw new StapleError("validation", `${subject} cannot be converted into an idea: ${reasons.join("; ")}.`, { identifier: root.identifier, reasons });
    }
    const parent = root.parent_id === null ? null : (this.db.prepare("SELECT identifier, kind, plan_maturity FROM issues WHERE id = ?").get(root.parent_id) as { identifier: string; kind: string; plan_maturity: string | null });
    const detachedFrom = parent !== null && parent.kind !== IDEA_KIND && parent.plan_maturity === null ? parent.identifier : null;
    const converted: Array<{ from: string; to: string; title: string }> = [];
    this.store.journaled(() => {
      // Top down, so each child's parent is an idea before the child becomes one.
      for (const row of subtree) {
        const issue = this.store.convertToIdea(row.id, this.nextRecordRank(), actor);
        converted.push({ from: row.identifier, to: issue.identifier, title: row.title });
      }
      this.settleMembership(actor);
    });
    return { idea: this.ideaView(root.id), converted, detachedFrom };
  }

  /** A record and everything under it, parents before their children. */
  private subtreeRows(id: string): PlanRow[] {
    const rows: PlanRow[] = [];
    const children = this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE parent_id = ? ORDER BY created_at, id`);
    const queue = [this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(id) as unknown as PlanRow];
    while (queue.length > 0) {
      const row = queue.shift()!;
      rows.push(row);
      queue.push(...(children.all(row.id) as unknown as PlanRow[]));
    }
    return rows;
  }

  /** Why one record of a conversion cannot become an idea, each as a clause; empty when it can. */
  private conversionProblems(row: PlanRow, isRoot: boolean): string[] {
    const problems: string[] = [];
    const full = this.db.prepare("SELECT status, started_at, checkout_agent, branch, gate_state FROM issues WHERE id = ?").get(row.id) as {
      status: string;
      started_at: string | null;
      checkout_agent: string | null;
      branch: string | null;
      gate_state: string | null;
    };
    if (row.kind === MILESTONE_KIND) problems.push("is a milestone");
    else if (!isRoot && (row.kind === IDEA_KIND || row.plan_maturity !== null)) problems.push("is already part of the plan");
    if (row.identifier.includes("+")) problems.push(`holds a stand-in number until sync settles it; sync first`);
    const category = this.store.categoryOf(full.status);
    if (category === "done" || category === "cancelled") problems.push(`is ${full.status}`);
    // A review gate parks a parent until a person answers it; that is not work started.
    else if (full.gate_state === "pending") problems.push("is parked behind a review gate (approve it or request changes first)");
    else if (category !== "unstarted" && category !== "ready") problems.push(`was started (it is ${full.status})`);
    else if (full.started_at !== null) problems.push(`was started on ${full.started_at.slice(0, 10)}`);
    if (full.checkout_agent !== null) problems.push(`is checked out by ${full.checkout_agent}`);
    else if (readLocalLease(this.db, row.id) !== null) problems.push("is leased by this device");
    if (full.branch !== null) problems.push(`has work on branch ${full.branch}`);
    const named = (sql: string): string[] => (this.db.prepare(sql).all(row.id) as Array<{ identifier: string }>).map((other) => other.identifier);
    const blocks = named("SELECT i.identifier FROM relations r JOIN issues i ON i.id = r.blocked_id WHERE r.blocker_id = ? AND r.type = 'blocks' ORDER BY i.identifier");
    const waits = named("SELECT i.identifier FROM relations r JOIN issues i ON i.id = r.blocker_id WHERE r.blocked_id = ? AND r.type = 'blocks' ORDER BY i.identifier");
    if (blocks.length > 0) problems.push(`blocks ${blocks.join(", ")} (an idea neither blocks nor waits; remove the dependency first)`);
    if (waits.length > 0) problems.push(`waits on ${waits.join(", ")} (an idea neither blocks nor waits; remove the dependency first)`);
    if (this.db.prepare("SELECT 1 AS hit FROM queue_entries WHERE issue_id = ?").get(row.id)) problems.push("is in the pickup queue (dequeue it first)");
    const milestones = named("SELECT i.identifier FROM milestone_members m JOIN issues i ON i.id = m.milestone_id WHERE m.issue_id = ?");
    if (milestones.length > 0) problems.push(`is a member of milestone ${milestones.join(", ")} (remove it first)`);
    const ideas = this.db
      .prepare("SELECT i.identifier, i.plan_idea_number, i.title FROM plan_links l JOIN issues i ON i.id = l.idea_id WHERE l.issue_id = ? ORDER BY i.created_at")
      .all(row.id) as Array<{ identifier: string; plan_idea_number: string | null; title: string }>;
    if (ideas.length > 0) problems.push(`is linked to ${ideas.map((idea) => displayRef(idea)).join(", ")} (unlink it first)`);
    return problems;
  }

  // ---------- import: a plan file becomes an idea ----------

  /**
   * Import a plan written as markdown (`staple idea import`): one idea captured with the file's
   * title, its sections, open questions and decisions, and the file itself attached as its source.
   * Captured raw unless a maturity is given (a person's call, held to the shaped gate like any:
   * the gate reads everything the import writes, its open questions included). One transaction.
   * Answers the idea, how many breakdown rows were read, and what the parser kept elsewhere.
   */
  importPlan(
    file: { name: string; markdown: string },
    input: { parent?: string | null; horizon?: string | null; maturity?: string },
    actor: string | null,
    options: PlanWriteOptions = {},
  ): { idea: IdeaDetail; rows: number; warnings: string[] } {
    this.assertEnabled();
    const parsed = parsePlanMarkdown(file.markdown, file.name.replace(/\.md$/i, ""));
    const sources = [`${file.name} (attached)`, ...parsed.sections.sources];
    const id = this.store.journaled(() => {
      const idea = this.captureWith(
        {
          title: parsed.title,
          brief: parsed.brief,
          parent: input.parent ?? null,
          horizon: input.horizon ?? null,
          maturity: input.maturity,
          plan: { ...parsed.sections, sources },
        },
        { questions: parsed.questions, decisions: parsed.decisions },
        actor,
        options,
      );
      this.store.attachFile(idea.id, { filename: file.name, bytes: new TextEncoder().encode(file.markdown), caption: "The plan this idea was imported from", author: actor });
      return idea.id;
    });
    return { idea: this.detail(id), rows: parsed.sections.breakdown.length, warnings: parsed.warnings };
  }

  // ---------- Scaffold: promote, and the breakdown becomes the epic's tasks ----------

  private promotedKind(): string {
    return this.store.getKinds().some((kind) => kind.id === PROMOTED_KIND) ? PROMOTED_KIND : this.store.defaultKind();
  }

  /**
   * What Scaffold would create, read from the plan as it stands: the epic (this record, promoted),
   * its plan document and acceptance criteria, one task per breakdown row with its estimate,
   * blockers, acceptance and context, and the same for each shaped sub-idea; what the plan lacks
   * (`problems`, which hold the confirm back) and what is worth a look (`warnings`); and the
   * fingerprint of all of it, which the confirm names. The create path builds from this very
   * preview, so what is shown is what is made. Only a record whose state offers Scaffold has one.
   */
  scaffoldPreview(ref: string): ScaffoldPreview {
    this.assertEnabled();
    const row = this.recordRow(ref, false);
    this.scaffoldOffer(row);
    return this.previewOf(row);
  }

  /** The state's offer of Scaffold, refused by name where the state makes none. */
  private scaffoldOffer(row: PlanRow): OfferedAction {
    const offer = this.ideaView(row.id).actions.find((action) => action.id === "scaffold");
    if (offer !== undefined) return offer;
    const state = this.stateOf(row.id);
    if (state === "started") {
      throw new StapleError("validation", `${displayRef(row)} cannot be scaffolded: it was started by promotion or linked work, not by a scaffold. Add tasks to its epic, or adopt more work.`);
    }
    assertIdeaAction(displayRef(row), state, "scaffold", row.kind !== IDEA_KIND);
    throw new StapleError("validation", `${displayRef(row)} offers no Scaffold in its state (${state}).`);
  }

  private previewOf(row: PlanRow): ScaffoldPreview {
    const sections = this.sectionsOf(row.id);
    const decisions = parseDecisions(this.documentBody(row.id, DECISIONS_KEY));
    const keys = new Set(sections.breakdown.map((task) => task.key));
    const titles = new Map(sections.breakdown.map((task) => [task.key, task.title]));
    const identifierOf = (id: string) => (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as { identifier: string } | undefined)?.identifier ?? null;
    const children = (this.db.prepare(`SELECT id FROM issues WHERE parent_id = ? AND plan_maturity IS NOT NULL ORDER BY plan_rank`).all(row.id) as Array<{ id: string }>)
      .map((child) => this.ideaView(child.id))
      // A held sub-idea waits for its own turn: its parent's Scaffold leaves it, and what is beneath it.
      .filter((child) => child.heldBy === null && child.actions.some((action) => action.id === "scaffold"))
      .map((child) => this.previewOf(this.row(child.id, false)));
    const hold = this.ideaView(row.id).heldBy;
    const problems = [
      ...(hold === null ? [] : [`${holdLabel(hold)}: ${holdWords(hold)}`]),
      ...this.gateOf(row.id),
      ...children.flatMap((child) => child.problems.map((problem) => `sub-idea "${child.idea.title}": ${problem}`)),
    ];
    // A held sub-idea is left out, and the preview says so: its parent's epic is made without it.
    const left = (this.db.prepare(`SELECT id FROM issues WHERE parent_id = ? AND plan_maturity IS NOT NULL ORDER BY plan_rank`).all(row.id) as Array<{ id: string }>)
      .map((child) => this.ideaView(child.id))
      .filter((child) => child.heldBy !== null && child.state === "shaped")
      .map((child) => `sub-idea "${child.title}" is left out until its turn: ${holdLabel(child.heldBy!)}, ${holdWords(child.heldBy!)}`);
    const warnings = [...planWarnings(sections), ...left, ...children.flatMap((child) => child.warnings.map((warning) => `sub-idea "${child.idea.title}": ${warning}`))];
    const preview: Omit<ScaffoldPreview, "fingerprint"> = {
      idea: { id: row.id, title: row.title },
      epic: {
        identifier: row.kind === IDEA_KIND ? null : row.identifier,
        kind: row.kind === IDEA_KIND ? this.promotedKind() : row.kind,
        planDocument: epicPlanDocument(row.title, sections, decisions),
        acceptance: sections.acceptance,
        promoted: row.kind !== IDEA_KIND,
      },
      tasks: sections.breakdown.map((task) => {
        const inherited = !task.acceptance && sections.acceptance.length > 0;
        return {
          rowId: task.id,
          key: task.key,
          title: taskTitle(task),
          estimate: task.estimate,
          estimatedSeconds: estimateSeconds(task.estimate),
          estimateWarning: estimateProblem(task.estimate),
          blockedBy: task.dependsOn.filter((dep) => keys.has(dep)),
          waitsOutside: task.dependsOn.filter((dep) => !keys.has(dep)),
          acceptance: task.acceptance ? [task.acceptance] : [...sections.acceptance],
          acceptanceInherited: inherited,
          context: taskContextDocument(row.title, ideaNumberOf(row), sections, task, titles),
          existing: identifierOf(scaffoldTaskId(row.id, task.id)),
        };
      }),
      children,
      problems,
      warnings,
    };
    return { ...preview, fingerprint: digest(preview) };
  }

  /**
   * Scaffold: the idea promotes in place into the epic (stage A), takes its plan document and
   * acceptance criteria, and each breakdown row becomes a child task with its estimate, its
   * blockers (the rows it depends on), its acceptance and a context document. Each shaped
   * sub-idea is scaffolded under it as a child epic.
   *
   * Confirmed only against a preview: `fingerprint` is the one the preview answered, and the
   * write is refused when the plan changed since, or when the plan (here or in a sub-idea it
   * carries) no longer passes the shaped gate. A row's task has an id that follows from the idea
   * and the row, so a retry, a scaffold after rows were added, or a second device scaffolding the
   * same idea offline makes each task once. Scaffold adds the blockers its rows' depends-on name
   * and never removes a blocker someone else set.
   */
  scaffold(ref: string, fingerprint: string | null | undefined, actor: string | null, options: PlanWriteOptions = {}): ScaffoldPreview {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.allowIdea(row, "scaffold", options);
    this.scaffoldOffer(row);
    if (!fingerprint) {
      throw new StapleError("validation", `Preview ${displayRef(row)}'s scaffold first, then confirm it with the preview's fingerprint: what is created is what was shown.`);
    }
    this.assertNotHeld(row, "scaffolded");
    const preview = this.previewOf(row);
    if (preview.problems.length > 0) {
      throw new StapleError("validation", `${displayRef(row)} is shaped, but its plan is incomplete, so it cannot be scaffolded: ${gateSentence(preview.problems).replace(/^it needs /, "").replace(/ before it is shaped$/, "")}.`, {
        missing: preview.problems,
      });
    }
    if (preview.fingerprint !== fingerprint) {
      throw new StapleError("revision_conflict", `Not scaffolded: the plan changed since the preview (it is at ${preview.fingerprint}, not ${fingerprint}). Preview ${displayRef(row)} again and confirm what it shows now.`, {
        fingerprint: preview.fingerprint,
      });
    }
    this.store.journaled(() => this.build(row, preview, actor, options));
    return this.previewOf(this.row(row.id, false));
  }

  /** Make what a checked preview shows, its sub-ideas' after its own. */
  private build(row: PlanRow, preview: ScaffoldPreview, actor: string | null, options: PlanWriteOptions): void {
    if (row.kind === IDEA_KIND) this.promoteRecord(row.id, preview.epic.kind, actor);
    const epic = this.store.getIssue(row.id);
    if (this.documentBody(row.id, "plan") === null) this.store.putDocument(row.id, "plan", preview.epic.planDocument, { author: actor, changeSummary: "scaffolded from the idea" });
    if (preview.epic.acceptance.length > 0 && (epic.acceptanceCriteria ?? []).length === 0) {
      this.store.updateIssue(row.id, { acceptanceCriteria: preview.epic.acceptance }, actor);
    }
    const idOf = new Map(preview.tasks.map((task) => [task.key, scaffoldTaskId(row.id, task.rowId)]));
    const byKey = new Map(preview.tasks.map((task) => [task.key, task]));
    let made = 0;
    // Each after the tasks it waits on, so its blockers ride in its own create.
    for (const task of dependencyOrder(preview.tasks.map((task) => ({ key: task.key, dependsOn: task.blockedBy })))) {
      const planned = byKey.get(task.key)!;
      const id = idOf.get(task.key)!;
      const blockers = planned.blockedBy.map((key) => idOf.get(key)!).filter((blocker) => this.issueExists(blocker));
      if (!this.issueExists(id)) {
        this.store.createIssueResult(
          {
            title: planned.title,
            parent: epic.identifier,
            createdBy: actor,
            acceptanceCriteria: planned.acceptance,
            labels: planned.acceptanceInherited ? [INHERITED_ACCEPTANCE_LABEL] : [],
            estimatedSeconds: planned.estimatedSeconds,
            blockedBy: blockers,
            allowDuplicate: true,
            // Its provenance rides in its own create: every device reads the idea and row it came from.
            originKind: SCAFFOLD_ORIGIN_KIND,
            originId: scaffoldOriginId(row.id, planned.rowId),
          },
          { plan: true, id },
        );
        this.store.putDocument(id, "context", planned.context, { author: actor, changeSummary: "scaffolded from the idea" });
        made += 1;
        continue;
      }
      const held = new Set(this.store.blockersOf(id).map((blocker) => blocker.id));
      const missing = blockers.filter((blocker) => !held.has(blocker));
      if (missing.length > 0) this.store.setBlockedBy(id, [...held, ...missing], actor ?? "staple");
    }
    insertEvent(this.db, { kind: "idea_scaffolded", issueId: row.id, actor, payload: { tasks: preview.tasks.length, created: made } });
    this.settleMembership(actor);
    for (const child of preview.children) {
      const childRow = this.row(child.idea.id);
      this.allowIdea(childRow, "scaffold", options);
      this.build(childRow, child, actor, options);
    }
  }

  /**
   * Adopt: link an existing issue (an epic or a ticket) to a plan record. For delivery (the
   * default) it is the work the record stands for, and starts it; as exploration it is research
   * or a proof of concept, listed on its own and nothing the record is measured by. An issue the
   * record already links the other way is relinked for this purpose, one field either way.
   */
  adopt(ref: string, issueRef: string, actor: string | null, options: { purpose?: PlanLinkPurpose } = {}): IdeaView {
    this.assertEnabled();
    const purpose = options.purpose ?? "delivery";
    const row = this.recordRow(ref);
    this.allowIdea(row, purpose === "exploration" ? "link_research" : "adopt", {});
    const target = this.store.writeTarget(issueRef);
    if (isPlanKind(target.kind) || target.id === row.id) {
      throw new StapleError("validation", `${displayRef(target)} is an idea; only tracker work can be ${purpose === "exploration" ? "linked as research" : "adopted"}.`);
    }
    if (planLinkPurposeOf(this.db, row.id, target.id) === purpose) return this.ideaView(row.id);
    this.store.journaled(() => {
      this.link(row, target.id, actor, purpose);
      if (purpose === "exploration") this.explore(row.id, actor, "research");
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /**
   * Unlink one issue, whichever way it is linked. The issue may be gone (a rewind removed it): a
   * link names it by id, and that id is accepted here even when nothing resolves it any more.
   * Unlinking delivery work is what a started record offers; unlinking research, what any record
   * that links research offers.
   */
  unlink(ref: string, issueRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    const linked = [...planLinksOf(this.db, row.id), ...planLinksOf(this.db, row.id, "exploration")];
    const issueId = linked.includes(issueRef.trim()) ? issueRef.trim() : this.store.getIssue(issueRef).id;
    const purpose = planLinkPurposeOf(this.db, row.id, issueId);
    const notLinked = `${issueRef.trim()} is not linked to ${displayRef(row)}.`;
    try {
      this.allowIdea(row, purpose === "exploration" ? "unlink_research" : "unlink", {});
    } catch (error) {
      // Nothing to unlink, in a state that offers no unlinking of work: say both, the missing link first.
      if (purpose === null && error instanceof StapleError) throw new StapleError(error.code, `${notLinked} ${error.message}`, error.detail);
      throw error;
    }
    if (purpose === null) throw new StapleError("validation", notLinked);
    const identifier = (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? issueId;
    this.store.journaled(() => {
      writePlanLink(this.db, row.id, issueId, null);
      this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planLinkField(issueId)]: null }, actor: actor ?? null });
      insertEvent(this.db, { kind: "idea_unlinked", issueId: row.id, actor, payload: { issue: identifier, ...(purpose === "exploration" ? { purpose } : {}) } });
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /** One link, one row, one field of the record's `milestone` entity (`plan-links.ts`). */
  /**
   * Block a plan record on another (`staple idea block`, update_idea's add_blockers, the Plan tab):
   * it waits on that one, and while it has not shipped (or been dropped) the record's Scaffold and
   * Promote are refused and its plan step waits. One field of the record's `milestone` entity
   * (`plan-blockers.ts`). Either may be an idea or a promoted record; an edit, as its state offers
   * one. Refused for itself, a record above or beneath it (a parent's work holds its sub-ideas',
   * so either wait is a cycle), one that is not part of the plan, and an edge that closes a loop.
   * Blocking it on one it is blocked by already changes nothing.
   */
  block(ref: string, blockerRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.allowIdea(row, "edit", {});
    const blocker = this.recordRow(blockerRef, false);
    if (blocker.id === row.id) throw new StapleError("cycle", `${displayRef(row)} cannot be blocked by itself.`);
    const facts = this.facts();
    if (relatedRecords(facts.byId, blocker.id, row.id)) {
      throw new StapleError(
        "validation",
        `${displayRef(row)} cannot be blocked by ${displayRef(blocker)}: one is above the other in the plan, and a parent's work already holds its sub-ideas'.`,
      );
    }
    if ((facts.blockers.get(row.id) ?? []).includes(blocker.id)) return this.ideaView(row.id);
    /**
     * A loop: the blocker already waits on this record, or on one above or beneath it. A record
     * waits on what it is blocked by, on what the ideas above it are blocked by (it is held with
     * them), and on what the records beneath it are blocked by (its work holds theirs).
     */
    const above = (id: string): string[] => {
      const out: string[] = [];
      const seenUp = new Set<string>([id]);
      for (let at = facts.byId.get(id)?.parent_id ?? null; at !== null && facts.byId.has(at) && !seenUp.has(at); at = facts.byId.get(at)!.parent_id) {
        seenUp.add(at);
        out.push(at);
      }
      return out;
    };
    const beneath = (id: string): string[] => {
      const out: string[] = [];
      const queue = [...(facts.childIds.get(id) ?? [])];
      while (queue.length > 0) {
        const at = queue.shift()!;
        if (out.includes(at)) continue;
        out.push(at);
        queue.push(...(facts.childIds.get(at) ?? []));
      }
      return out;
    };
    const seen = new Set<string>();
    const stack = [blocker.id];
    while (stack.length > 0) {
      const at = stack.pop()!;
      if (relatedRecords(facts.byId, at, row.id)) {
        throw new StapleError("cycle", `${displayRef(row)} cannot be blocked by ${displayRef(blocker)}: ${displayRef(blocker)} already waits on it, or on an idea above or beneath it.`);
      }
      if (seen.has(at)) continue;
      seen.add(at);
      for (const holder of [at, ...above(at), ...beneath(at)]) stack.push(...(facts.blockers.get(holder) ?? []));
    }
    this.store.journaled(() => {
      writePlanBlocker(this.db, row.id, blocker.id, true);
      this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planBlockerField(blocker.id)]: true }, actor: actor ?? null });
      insertEvent(this.db, { kind: "idea_blocked", issueId: row.id, actor, payload: { blocker: blocker.id, title: blocker.title } });
    });
    return this.ideaView(row.id);
  }

  /** Remove one edge `block` made. The other record is untouched. */
  unblock(ref: string, blockerRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.allowIdea(row, "edit", {});
    // A blocker this device no longer holds is still removable by its id.
    const held = this.facts().blockers.get(row.id) ?? [];
    const blockerId = held.includes(blockerRef) ? blockerRef : this.row(blockerRef, false).id;
    if (!held.includes(blockerId)) throw new StapleError("validation", `${displayRef(row)} is not blocked by ${blockerRef}.`);
    this.store.journaled(() => {
      writePlanBlocker(this.db, row.id, blockerId, null);
      this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planBlockerField(blockerId)]: null }, actor: actor ?? null });
      insertEvent(this.db, { kind: "idea_unblocked", issueId: row.id, actor, payload: { blocker: blockerId } });
    });
    return this.ideaView(row.id);
  }

  private link(row: PlanRow, issueId: string, actor: string | null, purpose: PlanLinkPurpose = "delivery"): void {
    const previous = planLinkPurposeOf(this.db, row.id, issueId);
    if (previous === purpose) return;
    const identifier = (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string }).identifier;
    const value = planLinkValue(actor ?? "unknown", this.store.journal.mutationAt(), purpose);
    writePlanLink(this.db, row.id, issueId, value);
    this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planLinkField(issueId)]: value }, actor: actor ?? null });
    // A relink from the other purpose says so: moving work to research can un-start the record.
    insertEvent(this.db, { kind: "idea_linked", issueId: row.id, actor, payload: { issue: identifier, ...(purpose === "exploration" ? { purpose } : {}), ...(previous !== null ? { from: previous } : {}) } });
    if (purpose === "delivery") this.keepBaselines(row.id, actor);
  }

  // ---------- the baseline ----------

  /**
   * The first planned window a record has once it is started itself is kept as its baseline. Run
   * after anything that can start it (a promotion, a link) or give a started record its first
   * window. A sub-idea's start is its own and starts no baseline above it. A baseline that exists
   * is never moved here.
   */
  private keepBaselines(id: string, actor: string | null): void {
    const row = this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(id) as unknown as PlanRow | undefined;
    if (!row || row.plan_maturity === null) return;
    const hasWindow = row.plan_start !== null || row.plan_target !== null;
    const hasBaseline = row.plan_baseline_start !== null || row.plan_baseline_target !== null;
    const started = row.kind !== IDEA_KIND || planLinksOf(this.db, row.id).length > 0;
    if (hasWindow && !hasBaseline && started) {
      this.write(row.id, { plan_baseline_start: row.plan_start, plan_baseline_target: row.plan_target }, actor, "idea_baseline_kept", {
        start: row.plan_start,
        target: row.plan_target,
      });
    }
  }

  /** Reset baseline: the current planned window becomes the baseline. The person's, and only on request. */
  resetBaseline(ref: string, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.allowIdea(row, "reset_baseline", options);
    this.store.journaled(() =>
      this.write(row.id, { plan_baseline_start: row.plan_start, plan_baseline_target: row.plan_target }, actor, "idea_baseline_reset", {
        from: { start: row.plan_baseline_start, target: row.plan_baseline_target },
        to: { start: row.plan_start, target: row.plan_target },
      }),
    );
    return this.ideaView(row.id);
  }

  // ---------- horizons: milestones the plan shows as columns (all the person's) ----------

  private insertHorizon(name: string, date: string | null, rank: number, actor: string | null, id?: string): string {
    const issue = this.store.createIssue({ title: name, kind: MILESTONE_KIND, createdBy: actor, allowDuplicate: true }, { plan: true, id });
    this.write(issue.id, { plan_rank: rank }, actor, "horizon_created", { date });
    if (date !== null) this.store.milestones().update(issue.id, { targetDate: date }, actor, { plan: true });
    return issue.id;
  }

  /** A name names one horizon: the surfaces that take a horizon by name (`--horizon`, list_ideas) resolve it. */
  private assertHorizonNameFree(name: string, except: string | null): void {
    const taken = this.horizonRows().find((row) => row.id !== except && row.title.trim().toLowerCase() === name.toLowerCase());
    if (taken) throw new StapleError("validation", `A horizon is already named ${taken.title} (${taken.identifier}); give this one another name.`, { horizon: taken.identifier });
  }

  /** A dated horizon goes in date order among the dated ones; an undated one goes last. */
  createHorizon(input: { name: string; date?: string | null }, actor: string | null, options: PlanWriteOptions = {}): HorizonView {
    this.assertEnabled();
    this.steer("horizons", null, options);
    const name = oneLine(input.name ?? "", "A horizon's name");
    this.assertHorizonNameFree(name, null);
    const date = input.date ? parsePlanDate(input.date) : null;
    const id = this.store.journaled(() => {
      const rows = this.horizonRows();
      const next = date === null ? undefined : rows.find((row) => row.target_date === null || row.target_date > date);
      const rank = next === undefined ? (rows.at(-1)?.plan_rank ?? 0) + RANK_STEP : this.rankBefore("horizons", null, next.id, actor);
      return this.insertHorizon(name, date, rank, actor);
    });
    return this.horizonOf(id);
  }

  updateHorizon(ref: string, patch: HorizonPatch, actor: string | null, options: PlanWriteOptions = {}): HorizonView {
    this.assertEnabled();
    const row = this.horizonRow(ref);
    this.steer("horizons", row.identifier, options);
    if (patch.name !== undefined) this.allowHorizon(row, "rename");
    if (patch.date !== undefined) this.allowHorizon(row, "date");
    if (patch.before !== undefined) this.allowHorizon(row, "reorder");
    const name = patch.name === undefined ? undefined : oneLine(patch.name, "A horizon's name");
    if (name !== undefined) this.assertHorizonNameFree(name, row.id);
    this.store.journaled(() => {
      if (name !== undefined) this.store.updateIssue(row.id, { title: name }, actor, undefined, { plan: true });
      if (patch.date !== undefined) {
        this.store.milestones().update(row.id, { targetDate: patch.date === null ? null : parsePlanDate(patch.date) }, actor, { plan: true });
      }
      if (patch.before !== undefined) this.write(row.id, { plan_rank: this.rankBefore("horizons", row.id, patch.before, actor) }, actor, "horizon_updated", { fields: ["plan_rank"] });
    });
    return this.horizonOf(row.id);
  }

  /**
   * A horizon's run setting: how far agents take it when they pick its work up (`mode`), and its
   * goal, the milestone's acceptance criteria. Both are the person's; nothing runs from here.
   * Agents read them in every take of the horizon's work (`instructions.ts`, "horizon-run").
   */
  setHorizonRun(ref: string, patch: { mode?: RunMode | null; goal?: readonly string[] }, actor: string | null, options: PlanWriteOptions = {}): HorizonView {
    this.assertEnabled();
    const row = this.horizonRow(ref);
    this.allowHorizon(row, "run");
    this.steer("horizons", row.identifier, options);
    if (patch.mode !== undefined && patch.mode !== null && !isRunMode(patch.mode)) {
      throw new StapleError("validation", `A horizon runs ${RUN_MODE_IDS.map((id) => `${id} (${RUN_MODES[id].label.toLowerCase()})`).join(", ")}; not "${String(patch.mode)}".`);
    }
    this.store.journaled(() => {
      if (patch.mode !== undefined && patch.mode !== row.plan_run_mode) this.write(row.id, { plan_run_mode: patch.mode }, actor, "horizon_updated", { fields: ["plan_run_mode"] });
      if (patch.goal !== undefined) this.store.milestones().update(row.id, { acceptanceCriteria: [...patch.goal] }, actor, { plan: true });
    });
    return this.horizonOf(row.id);
  }

  /**
   * Remove a horizon: the milestone is cancelled (issues are never deleted) and its unstarted
   * ideas become unscheduled. Refused while it holds open work or sits in the queue: cancelling
   * it then would leave that work inside a cancelled milestone, or take the horizon off the queue
   * without anyone deciding to, so the refusal names what to move first.
   */
  removeHorizon(ref: string, actor: string | null, options: PlanWriteOptions = {}): PlanView {
    this.assertEnabled();
    const row = this.horizonRow(ref);
    this.steer("horizons", row.identifier, options);
    // The lifecycle's remove cell, said with what to move first: an active horizon is one holding
    // open work, and this refuses exactly that, and a queued one; planned and done ones may go.
    this.assertRemovable(row);
    this.store.journaled(() => {
      const on = this.db.prepare("SELECT id FROM issues WHERE plan_maturity IS NOT NULL AND plan_horizon_id = ?").all(row.id) as Array<{ id: string }>;
      for (const idea of on) this.write(idea.id, { plan_horizon_id: null }, actor, "idea_updated", { fields: ["plan_horizon_id"] });
      this.settleMembership(actor);
      this.store.updateIssue(row.id, { status: this.store.primaryStatusFor("cancelled") }, actor, undefined, { plan: true });
    });
    return this.view();
  }

  private assertRemovable(row: PlanRow): void {
    const name = `${row.title} (${row.identifier})`;
    if (this.db.prepare("SELECT 1 AS hit FROM queue_entries WHERE issue_id = ?").get(row.id)) {
      throw new StapleError("validation", `${name} is in the queue. Take it off first (staple queue rm ${row.identifier}), then remove the horizon.`, {
        horizon: row.identifier,
        queued: true,
      });
    }
    const resolved = this.resolvedStatuses();
    const byHand = (
      this.db
        .prepare("SELECT i.identifier, i.status FROM milestone_members m JOIN issues i ON i.id = m.issue_id WHERE m.milestone_id = ? ORDER BY m.rank")
        .all(row.id) as Array<{ identifier: string; status: string }>
    )
      .filter((member) => !resolved.has(member.status))
      .map((member) => member.identifier);
    const placedBy = new Map<string, string>();
    for (const record of this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE plan_maturity IS NOT NULL AND plan_horizon_id = ?`).all(row.id) as unknown as PlanRow[]) {
      const work = [...(record.kind === IDEA_KIND ? [] : [record.id]), ...planLinksOf(this.db, record.id)];
      const open = work.some((id) => {
        const status = (this.db.prepare("SELECT status FROM issues WHERE id = ?").get(id) as { status: string } | undefined)?.status;
        return status !== undefined && !resolved.has(status);
      });
      if (open) placedBy.set(record.id, record.kind === IDEA_KIND ? `the idea "${record.title}" (${record.id})` : record.identifier);
    }
    if (byHand.length === 0 && placedBy.size === 0) return;
    const moves = [
      ...[...placedBy.values()].map((what) => `${what}: move it to another horizon or unschedule it (staple idea set <id> --horizon <other|none> --person)`),
      ...byHand.map((identifier) => `${identifier}, placed by hand: staple milestone rm ${row.identifier} ${identifier}`),
    ];
    throw new StapleError("validation", `${name} holds open work, which removing it would leave inside a cancelled milestone. Move it first: ${moves.join("; ")}.`, {
      horizon: row.identifier,
      records: [...placedBy.keys()],
      members: byHand,
    });
  }

  private horizonOf(id: string): HorizonView {
    const horizon = this.view().horizons.find((view) => view.id === id);
    if (!horizon) throw new StapleError("not_found", "That horizon is not open.");
    return horizon;
  }

  // ---------- order ----------

  private nextRecordRank(): number {
    const row = this.db.prepare("SELECT MAX(plan_rank) AS rank FROM issues WHERE plan_maturity IS NOT NULL").get() as { rank: number | null };
    return (row.rank ?? 0) + RANK_STEP;
  }

  /**
   * The rank that puts `id` immediately before `beforeRef` among the plan's records or its
   * horizons (`null`: at the end). Ranks are sparse; when two neighbours leave no room, the rows
   * are renumbered in their current order first.
   */
  private rankBefore(among: "records" | "horizons", id: string | null, beforeRef: string | null, actor: string | null): number {
    const ordered = (among === "records" ? this.recordRows() : this.horizonRows()).filter((row) => row.id !== id);
    if (beforeRef === null) return (ordered.at(-1)?.plan_rank ?? 0) + RANK_STEP;
    const before = among === "records" ? this.recordRow(beforeRef) : this.horizonRow(beforeRef);
    const index = ordered.findIndex((row) => row.id === before.id);
    const lower = index > 0 ? (ordered[index - 1]!.plan_rank ?? null) : null;
    const rank = rankBetween(lower, before.plan_rank ?? null);
    if (rank !== null && before.plan_rank !== null) return rank;
    const ranks = renumberedRanks(ordered.length);
    ordered.forEach((row, position) => {
      if (row.plan_rank !== ranks[position]) this.write(row.id, { plan_rank: ranks[position] }, actor, "plan_renumbered");
      row.plan_rank = ranks[position]!;
    });
    return rankBetween(index > 0 ? ranks[index - 1]! : null, ranks[index]!) ?? ranks[index]! - 1;
  }
}

/**
 * A record's state and the actions it offers, with the preconditions the table cannot know: the
 * epic opens only once promoted, and unlinking needs a link.
 */
function ideaLifecycle(input: {
  state: IdeaState;
  promoted: boolean;
  /** A started record still exploring offers Mark shaped on top of its row. */
  maturity: string;
  /** Marked delivered outside the tracker: its edits and clearing the mark on top of its row. */
  delivered: boolean;
  ownLinks: number;
  /** What the shaped gate still needs, read only when the state offers shaping. */
  gate: () => string[];
  /** Scaffolded before: a started record scaffolds again only then, to add new rows. */
  scaffolded: boolean;
  /** A shaped plan that no longer passes the gate: Scaffold and Promote are held back, saying why. */
  planIncomplete: readonly string[];
  /** Ideas above it not shaped, or blockers not shipped: Scaffold and Promote are held back, saying why. */
  heldBy: IdeaHold | null;
  /** A proposal to be marked shaped stands: only then is it offered for dismissal. */
  proposed: boolean;
}): { state: IdeaState; actions: OfferedAction[] } {
  const actions: OfferedAction[] = [];
  // Mark shaped and Propose shaped read the same gate: once.
  let gated: string[] | null = null;
  const gate = (): string[] => (gated ??= input.gate());
  for (const id of ideaOffered(input.state, input.promoted, input.maturity, input.delivered)) {
    if (id === "open_epic" && !input.promoted) continue;
    // A started record that was promoted or linked some other way has nothing to scaffold into.
    if (id === "scaffold" && input.state === "started" && !input.scaffolded) continue;
    // Nothing to dismiss while nothing is proposed.
    if (id === "dismiss_proposal" && !input.proposed) continue;
    const rule = IDEA_ACTIONS[id];
    const offered: OfferedAction = { id, label: rule.label, who: rule.who };
    if (id === "unlink" && input.ownLinks === 0) offered.disabledReason = "Nothing is linked to it.";
    if (id === "shape" || id === "propose_shape") {
      const missing = gate();
      if (missing.length > 0) offered.disabledReason = `It needs ${gateSentence(missing).replace(/^it needs /, "")}.`;
    }
    if ((id === "scaffold" || id === "promote") && input.planIncomplete.length > 0) {
      offered.disabledReason = `Plan incomplete: it needs ${gateSentence(input.planIncomplete).replace(/^it needs /, "").replace(/ before it is shaped$/, "")}.`;
    } else if ((id === "scaffold" || id === "promote") && input.heldBy !== null) {
      offered.disabledReason = `${capitalized(holdLabel(input.heldBy))}: ${holdWords(input.heldBy)}.`;
    }
    actions.push(offered);
  }
  return { state: input.state, actions };
}

/** A horizon's state and offers. Removing it is held back while it sits in the queue: take it off first. */
function horizonLifecycle(shipped: boolean, openWork: number, queued: boolean): { state: HorizonState; actions: OfferedAction[] } {
  const state = horizonState({ shipped, openWork });
  return {
    state,
    actions: HORIZON_LIFECYCLE[state].map((id) => ({
      id,
      label: HORIZON_ACTIONS[id].label,
      who: HORIZON_ACTIONS[id].who,
      ...(id === "remove" && queued ? { disabledReason: "It is in the queue; take it off first." } : {}),
      ...(id === "queue" && queued ? { disabledReason: "It is in the queue already." } : {}),
    })),
  };
}

/**
 * Sections with a checked patch applied: each section given replaces the stored one whole. A
 * breakdown row keeps its id: the one it names, else the stored row with its key, else a new one.
 */
export function mergeSections(base: PlanSections, patch: PlanPatch): PlanSections {
  const out: PlanSections = { ...base };
  const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);
  const list = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean) : []);
  if (patch.goal !== undefined) out.goal = text(patch.goal);
  if (patch.context !== undefined) out.context = text(patch.context);
  if (patch.outOfScope !== undefined) out.outOfScope = text(patch.outOfScope);
  if (patch.risks !== undefined) out.risks = text(patch.risks);
  if (patch.acceptance !== undefined) out.acceptance = list(patch.acceptance);
  if (patch.dependencies !== undefined) out.dependencies = list(patch.dependencies);
  if (patch.sources !== undefined) out.sources = list(patch.sources);
  if (patch.breakdown !== undefined) {
    const inputs = patch.breakdown.map((row: BreakdownRowInput) => normalizeRow(row));
    const keys = new Set<string>();
    for (const row of inputs) {
      if (keys.has(row.key)) throw new StapleError("validation", `Two task breakdown rows share the key ${row.key}; each row needs its own.`);
      keys.add(row.key);
    }
    const named = new Set(inputs.map((row) => row.id).filter((id): id is string => id !== null));
    const used = new Set<string>();
    out.breakdown = inputs.map((row) => {
      let id = row.id;
      if (id !== null && used.has(id)) throw new StapleError("validation", `Two task breakdown rows share the id ${id}; each row has its own.`);
      id ??= base.breakdown.find((held) => held.key === row.key && !used.has(held.id) && !named.has(held.id))?.id ?? randomUUID();
      used.add(id);
      return { ...row, id };
    });
  }
  return out;
}

/**
 * The horizon a reference names: its id, its identifier or its name, in any case. A name that
 * names none, or that several horizons carry (two devices can each create one), is refused
 * rather than read as no horizon, which would answer the unscheduled records instead.
 */
export function horizonNamed(view: Pick<PlanView, "horizons">, ref: string): HorizonView {
  const wanted = ref.trim().toLowerCase();
  const exact = view.horizons.find((horizon) => horizon.id === ref || horizon.identifier.toLowerCase() === wanted);
  if (exact) return exact;
  const named = view.horizons.filter((horizon) => horizon.name.trim().toLowerCase() === wanted);
  if (named.length === 1) return named[0]!;
  if (named.length > 1) {
    throw new StapleError("validation", `${named.length} horizons are named "${ref}": ${named.map((horizon) => horizon.identifier).join(", ")}. Name one by its identifier.`, { horizons: named.map((horizon) => horizon.identifier) });
  }
  const known = view.horizons.map((horizon) => `${horizon.name} (${horizon.identifier})`).join(", ");
  throw new StapleError("not_found", `No horizon is named "${ref}". The horizons are: ${known || "none"}.`);
}

/**
 * The records on a horizon: those it carries (`carriedBy`), scheduled on it or following a parent
 * scheduled on it, as its column and counts read them; and the dropped ones scheduled on it, which
 * keep their horizon though nothing carries them.
 */
export function ideasOnHorizon(view: PlanView, ref: string): IdeaView[] {
  const horizon = horizonNamed(view, ref);
  return view.ideas.filter((idea) => idea.carriedBy === horizon.id || (idea.state === "dropped" && idea.horizonId === horizon.id));
}

/** Where a record sits, in words: its horizon, `<horizon> (via parent)` when it follows one, else `unscheduled`. */
export function horizonWords(idea: Pick<IdeaView, "horizonId" | "carriedBy">, view: Pick<PlanView, "horizons">): string {
  const on = view.horizons.find((horizon) => horizon.id === idea.horizonId);
  if (on) return on.name;
  const via = view.horizons.find((horizon) => horizon.id === idea.carriedBy);
  return via ? `${via.name} (via parent)` : "unscheduled";
}

/** The first line with text in it, trimmed and without the Markdown marker that opens it (a heading, quote or list item); null for none. */
function firstLine(text: string | null): string | null {
  return text?.split("\n").map((line) => line.trim().replace(/^(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, "").trim()).find((line) => line !== "") ?? null;
}

/**
 * A dropped record keeps its horizon and planned dates. Raw holds neither (it offers no schedule
 * and no plan dates), and a record restored into raw could not shed them: so it is restored to
 * exploring or shaped instead, which hold both.
 */
function assertRestorableToRaw(row: Pick<PlanRow, "identifier" | "title" | "plan_start" | "plan_target">, onHorizon: boolean, research = false): void {
  const held = [onHorizon ? "a horizon" : null, row.plan_start !== null || row.plan_target !== null ? "planned dates" : null, research ? "linked research" : null].filter(
    (part): part is string => part !== null,
  );
  if (held.length === 0) return;
  const subject = displayRef(row);
  throw new StapleError(
    "validation",
    `${subject.charAt(0).toUpperCase()}${subject.slice(1)} cannot be restored to raw while it holds ${held.join(" and ")}, which a raw idea never has: restore it to exploring or shaped.`,
    { state: "dropped", action: "restore", held },
  );
}

/** The shaped gate as a refusal: what the plan still needs, named. */
function capitalized(text: string): string {
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

function assertShaped(subject: string, missing: readonly string[]): void {
  if (missing.length === 0) return;
  throw new StapleError("validation", `${subject.charAt(0).toUpperCase()}${subject.slice(1)} cannot be marked shaped yet: ${gateSentence(missing)}.`, { missing });
}

/** A task's title from its row: the key leads, so the plan and the tracker name it alike. */
function taskTitle(row: BreakdownRow): string {
  const clean = row.title.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\s+/g, " ").trim();
  return /^\d/.test(row.key) ? `${row.key} ${clean}` : clean;
}

/** The epic's plan document: the idea's goal, context, decisions, scope and risks, as one page. */
function epicPlanDocument(title: string, sections: PlanSections, decisions: readonly string[]): string {
  const parts = [`# ${title}`];
  if (sections.goal) parts.push(`## Goal\n\n${sections.goal}`);
  if (sections.context) parts.push(`## Context and constraints\n\n${sections.context}`);
  if (decisions.length > 0) parts.push(`## Decisions\n\n${decisions.map((decision) => `- ${decision}`).join("\n")}`);
  if (sections.dependencies.length > 0) parts.push(`## Dependencies\n\n${sections.dependencies.map((dep) => `- ${dep}`).join("\n")}`);
  if (sections.outOfScope) parts.push(`## Out of scope\n\n${sections.outOfScope}`);
  if (sections.risks) parts.push(`## Risks\n\n${sections.risks}`);
  if (sections.sources.length > 0) parts.push(`## Sources\n\n${sections.sources.map((source) => `- ${source}`).join("\n")}`);
  return parts.join("\n\n") + "\n";
}

/** The most of the idea's context a task's own page carries; the epic's plan holds all of it. */
const CONTEXT_EXCERPT = 2000;

/**
 * A task's context document: workable from the ticket alone. What the epic is for, this task,
 * what done means, what it waits on, and the constraints and scope it must respect.
 */
function taskContextDocument(epicTitle: string, ideaNumber: string | null, sections: PlanSections, row: BreakdownRow, titles: ReadonlyMap<string, string>): string {
  // A snapshot, written once: the number and key as they read at scaffold. A stand-in number
  // (`I-STA-5+12`) is not one to keep; the ticket's provenance reads both as they stand now.
  const number = ideaNumber !== null && isIdeaNumber(ideaNumber) && !ideaNumber.includes("+") ? ideaNumber : null;
  const from = `${number === null ? `Scaffolded from breakdown row ${row.key} of the idea` : `Scaffolded from idea ${number}, breakdown row ${row.key}`}, as numbered at scaffold; \`staple show\` names both as they stand now.`;
  const parts = [`# ${taskTitle(row)}`, `Part of **${epicTitle}**. ${from} The epic's plan document holds the whole plan.`];
  if (sections.goal) parts.push(`## What the epic is for\n\n${sections.goal}`);
  const facts = [row.estimate ? `Estimate: ${row.estimate}` : null, row.owner ? `Owner: ${row.owner}` : null, row.notes ? `Notes: ${row.notes}` : null].filter(Boolean);
  if (facts.length > 0) parts.push(`## This task\n\n${facts.join("\n\n")}`);
  if (row.acceptance) parts.push(`## Done when\n\n${row.acceptance}`);
  else if (sections.acceptance.length > 0) {
    parts.push(
      `## Done when (inherited)\n\nThis row had no "done when" of its own, so it takes the plan's acceptance criteria. Sharpen them to this task, then remove the \`${INHERITED_ACCEPTANCE_LABEL}\` label.\n\n${sections.acceptance.map((item) => `- ${item}`).join("\n")}`,
    );
  } else parts.push("## Done when\n\nNo acceptance was written for this row; agree it before starting.");
  if (row.dependsOn.length > 0) {
    const lines = row.dependsOn.map((dep) => (titles.has(dep) ? `- ${dep} ${titles.get(dep)} (a blocker in this epic)` : `- ${dep} (outside this plan)`));
    parts.push(`## Waits on\n\n${lines.join("\n")}`);
  }
  if (sections.context) {
    const excerpt = sections.context.length > CONTEXT_EXCERPT ? `${sections.context.slice(0, CONTEXT_EXCERPT).trimEnd()}\n\n(continued in the epic's plan document)` : sections.context;
    parts.push(`## Context and constraints\n\n${excerpt}`);
  }
  if (sections.outOfScope) parts.push(`## Out of scope\n\n${sections.outOfScope}`);
  return parts.join("\n\n") + "\n";
}

function blockerRef(id: string, view: IdeaView | undefined): BlockerRef {
  if (view === undefined) return { id, number: null, identifier: null, title: "Missing: this record is no longer on this device", state: null, missing: true };
  return { id, number: view.number, identifier: view.identifier, title: view.title, state: view.state, missing: false };
}

/** Whether one record is the other, or above or beneath it, in the plan's tree. */
function relatedRecords(byId: ReadonlyMap<string, Pick<PlanRow, "parent_id">>, a: string, b: string): boolean {
  if (a === b) return true;
  const above = (of: string, ancestor: string): boolean => {
    const seen = new Set<string>();
    for (let at = byId.get(of)?.parent_id ?? null; at !== null && !seen.has(at); at = byId.get(at)?.parent_id ?? null) {
      if (at === ancestor) return true;
      seen.add(at);
    }
    return false;
  };
  return above(a, b) || above(b, a);
}

/**
 * What holds each record back (design/plan.md, "Sub-ideas and blockers"), from facts already read:
 * the ideas above it that are not shaped and have not shipped (a dropped one included), nearest
 * first, and the records it or an idea above it is blocked by that have neither shipped nor been
 * dropped. A blocker this device does not hold, or one above or beneath the record, holds nothing.
 */
function holdsOf(
  rows: readonly PlanRow[],
  byId: ReadonlyMap<string, PlanRow>,
  records: ReadonlyMap<string, RecordFacts>,
  blockers: ReadonlyMap<string, readonly string[]>,
): Map<string, IdeaHold> {
  const out = new Map<string, IdeaHold>();
  for (const row of rows) {
    // A shipped or dropped record is built from no more: nothing holds it.
    const own = records.get(row.id)!.state;
    if (own === "shipped" || own === "dropped") continue;
    const chain: string[] = [];
    const seen = new Set<string>([row.id]);
    for (let at = row.parent_id; at !== null && byId.has(at) && !seen.has(at); at = byId.get(at)!.parent_id) {
      seen.add(at);
      chain.push(at);
    }
    const parents = chain
      .filter((id) => {
        const facts = records.get(id)!;
        return facts.maturity !== "shaped" && facts.state !== "shipped";
      })
      .map((id) => ({ id, title: byId.get(id)!.title, maturity: records.get(id)!.maturity }));
    const waiting: IdeaHold["blockers"] = [];
    for (const holder of [row.id, ...chain]) {
      for (const blocker of blockers.get(holder) ?? []) {
        const facts = records.get(blocker);
        if (facts === undefined || facts.state === "shipped" || facts.state === "dropped") continue;
        if (relatedRecords(byId, blocker, holder) || relatedRecords(byId, blocker, row.id) || waiting.some((entry) => entry.id === blocker)) continue;
        waiting.push({ id: blocker, title: byId.get(blocker)!.title, state: facts.state });
      }
    }
    if (parents.length > 0 || waiting.length > 0) out.set(row.id, { parents, blockers: waiting });
  }
  return out;
}

function isResolvedCategory(category: StatusCategory | null): boolean {
  return category !== null && RESOLVED_CATEGORIES.includes(category);
}
