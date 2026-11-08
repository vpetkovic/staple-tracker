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
import { MILESTONE_KIND, MILESTONE_MEMBERSHIP, rankBetween, renumberedRanks } from "./milestones.js";
import {
  DEFAULT_HORIZONS,
  aKind,
  IDEA_KIND,
  PLAN_KINDS_MISSING_MESSAGE,
  PROMOTED_KIND,
  assertPlanWindow,
  deriveStage,
  displayRef,
  draftIdentifier,
  forecastEnd,
  isDraftIdentifier,
  isLate,
  isNotStarted,
  isPlanKind,
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
import { planLinkField, planLinksOf, writePlanLink } from "./plan-links.js";
import { planRowField, planRowsOf, planRowValue, writePlanRow, type PlanRowValue } from "./plan-rows.js";
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
import type { WorkspaceStore } from "./store.js";
import { StapleError, type PersonDecision } from "./types.js";

/** Who is writing. A `person` is the distinction; without one the write is an agent's. */
export interface PlanWriteOptions {
  person?: PersonDecision | null;
}

export interface HorizonView {
  id: string;
  /** The milestone's ticket number: a horizon is real work, so it has one. */
  identifier: string;
  name: string;
  /** YYYY-MM-DD, or null for an undated horizon such as Later (the milestone's target date). */
  date: string | null;
  rank: number;
  /** The milestone's own status, derived from its members like any milestone's. */
  status: string;
  /** Its derived done: every member landed. */
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
  /** Members landed over members it holds, 0..1; null while it holds none. */
  progress: number | null;
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
  /** Promoted in place: this record is now an epic in the tracker. */
  promoted: boolean;
  /** Its kind: `idea`, or the kind it was promoted to. */
  kind: string;
  title: string;
  description: string | null;
  maturity: Maturity;
  stage: Stage;
  parentId: string | null;
  horizonId: string | null;
  planned: PlanWindow;
  /** The window kept when it was started; null before it is started or when it had no window. */
  baseline: PlanWindow | null;
  rank: number;
  /** The issues this record itself links, by id; some may be missing (see `missingLinks`). */
  links: string[];
  /** Own links whose issue this device no longer holds (a rewind, say): shown as missing, still unlinkable. */
  missingLinks: string[];
  /** Work it stands for, rolled up from sub-ideas: itself once promoted, and every link. */
  linkCount: number;
  resolvedLinks: number;
  /** Done leaves over counted leaves of that work, 0..1; null before it is started. */
  progress: number | null;
  actual: ActualWindow;
  /** Its work landed, or is forecast to land, past the planned end or the horizon line. */
  late: boolean;
  /** Nothing started yet and the planned start has passed. */
  notStarted: boolean;
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
  /** The records it waits on, by id: those its dependencies and outside depends-on cells name. */
  dependsOn: string[];
  /** Its lifecycle state, and the actions that state offers (`plan-lifecycle.ts`). */
  state: IdeaState;
  actions: OfferedAction[];
  createdAt: string;
  updatedAt: string;
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
  linked: LinkView[];
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
  today: string;
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
  /** Plan sections to replace, each whole; a section left out is left alone. The edit action. */
  plan?: PlanPatch;
  /**
   * The `breakdownRevision` the writer read. Given with a breakdown, the write is refused when
   * the breakdown changed since; left out, the breakdown given replaces it (rows matched by id,
   * else by key).
   */
  breakdownBase?: string;
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
const PLAN_COLUMNS = `id, identifier, title, description, kind, status, parent_id, depth, created_at, updated_at,
  plan_maturity, plan_horizon_id, plan_start, plan_target, plan_baseline_start, plan_baseline_target, plan_rank, plan_run_mode`;

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
  parent_id: "parentId",
};

const QUESTIONS_KEY = "questions";
const DECISIONS_KEY = "decisions";
const BRIEF_KEY = "brief";

/**
 * The task Scaffold makes from a breakdown row has an id that follows from the idea's and the
 * row's, the same on every device: two devices scaffolding one idea offline create the same
 * records, and sync merges them as one (design/plan.md, "Scaffold").
 */
export function scaffoldTaskId(ideaId: string, rowId: string): string {
  const hex = createHash("sha256").update(`staple:plan-scaffold:${ideaId}:${rowId}`).digest("hex");
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

function oneLine(text: string, what: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) throw new StapleError("validation", `${what} cannot be empty.`);
  return clean;
}

/** A plan record's number to show: none while it is an idea. */
function shownIdentifier(identifier: string): string | null {
  return isDraftIdentifier(identifier) ? null : identifier;
}

/** The steering word a person-only idea action is refused with (`steeringRefusal`). */
const STEERED_AS: Partial<Record<IdeaAction, SteeringWrite>> = {
  explore: "maturity",
  shape: "maturity",
  unshape: "maturity",
  drop: "maturity",
  restore: "maturity",
  schedule: "horizon",
  plan_dates: "planned dates",
  reorder: "horizon",
  reparent: "parent",
  reset_baseline: "baseline",
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

  private assertEnabled(): void {
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
    assertIdeaAction(displayRef(row), state, action, row.kind !== IDEA_KIND);
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
    if (LIST_KEYS.has(key)) assertListBody(key, body);
    if (key === QUESTIONS_KEY && body.split("\n").some((line) => line.trim() !== "" && !/^\s*[-*]\s+\[( |x|X|~)\]\s+\S/.test(line))) {
      throw new StapleError("validation", `The questions of ${displayRef(row)} are a checklist, one "- [ ] question" per line ("- [x]" resolved, "- [~]" deferred).`, { key });
    }
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
   */
  private settleMembership(actor: string | null): void {
    const changed = rebuildPlanMembers(this.db);
    if (changed.length > 0) this.store.rederiveMilestones(changed, "plan", actor);
  }

  // ---------- enabling ----------

  /**
   * Turn planning on: the `idea` and `milestone` kinds when missing, and the horizons Now, Next
   * and Later, which are milestones. Refused while an issue uses the `idea` kind for other work.
   * Run again on a workspace where planning is on, it converts what an earlier build left: a
   * numbered idea back to a draft identifier.
   */
  enable(actor: string | null): PlanView {
    if (this.store.planningOn()) {
      this.store.journaled(() => {
        this.migrateLegacyLater();
        this.draftNumberedIdeas(actor);
        this.settleMembership(actor);
      });
      return this.view();
    }
    const unrelated = this.db.prepare("SELECT identifier FROM issues WHERE kind = ? ORDER BY identifier").all(IDEA_KIND) as Array<{ identifier: string }>;
    if (unrelated.length > 0) {
      const names = unrelated.map((row) => row.identifier);
      throw new StapleError(
        "validation",
        `Planning uses the kind "idea", and ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""} already use it for other work. Re-kind ${names.length === 1 ? "it" : "them"} first (staple set <ref> --kind <other>), then turn planning on.`,
        { issues: names },
      );
    }
    return this.store.journaled(() => {
      const ids = this.store.getKinds().map((kind) => kind.id);
      if (!ids.includes(IDEA_KIND)) this.store.addKind({ id: IDEA_KIND, label: "Idea" }, actor);
      if (!ids.includes(MILESTONE_KIND)) this.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, actor);
      DEFAULT_HORIZONS.forEach((name, index) => this.insertHorizon(name, null, (index + 1) * RANK_STEP, actor));
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

  /** An idea an earlier build numbered takes its draft identifier: ideas hold no ticket number. */
  private draftNumberedIdeas(actor: string | null): void {
    const numbered = this.db
      .prepare("SELECT id, identifier FROM issues WHERE kind = ? AND plan_maturity IS NOT NULL AND identifier NOT LIKE '~%'")
      .all(IDEA_KIND) as Array<{ id: string; identifier: string }>;
    for (const idea of numbered) {
      const draft = draftIdentifier(idea.id);
      const now = this.store.journal.mutationAt();
      moveIdentifier(this.db, idea.id, draft, now);
      this.db.prepare("UPDATE issues SET updated_at = ? WHERE id = ?").run(now, idea.id);
      this.store.journal.record({ entity: "issue", entityId: idea.id, verb: "renumber", payload: { identifier: draft }, actor: actor ?? null });
      insertEvent(this.db, { kind: "idea_drafted", issueId: idea.id, actor, payload: { from: idea.identifier } });
    }
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
  private recordRows(): PlanRow[] {
    const resolved = this.resolvedStatuses();
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
    const ideas = this.ideaViews(today);
    const horizons = this.horizonRows().map((row) => this.horizonView(row, ideas));
    return { enabled: true, today, horizons, ideas };
  }

  private horizonView(row: HorizonRow, ideas: readonly IdeaView[]): HorizonView {
    const on = ideas.filter((idea) => idea.horizonId === row.id && idea.stage !== "dropped");
    const lateCount = on.filter((idea) => idea.late).length;
    const memberCount = (
      this.db.prepare("SELECT COUNT(*) AS n FROM milestone_members WHERE milestone_id = ?").get(row.id) as { n: number }
    ).n + (this.db.prepare("SELECT COUNT(*) AS n FROM plan_members WHERE milestone_id = ? AND issue_id NOT IN (SELECT issue_id FROM milestone_members)").get(row.id) as { n: number }).n;
    const open = this.openWorkOf(row.id);
    const own = this.db.prepare("SELECT gate_state, acceptance_criteria FROM issues WHERE id = ?").get(row.id) as { gate_state: string | null; acceptance_criteria: string | null };
    return {
      id: row.id,
      identifier: row.identifier,
      name: row.title,
      date: row.target_date,
      rank: row.plan_rank ?? 0,
      status: row.status,
      shipped: this.store.categoryOf(row.status) === "done",
      memberCount,
      ideaCount: on.length,
      lateCount,
      notStartedCount: on.filter((idea) => idea.notStarted).length,
      shippedCount: on.filter((idea) => idea.stage === "shipped").length,
      progress: memberCount > 0 ? (memberCount - open) / memberCount : null,
      runMode: isRunMode(row.plan_run_mode) ? row.plan_run_mode : null,
      goal: own.acceptance_criteria ? (JSON.parse(own.acceptance_criteria) as string[]) : [],
      awaitingApproval: own.gate_state === "pending",
      late: lateCount > 0,
      ...horizonLifecycle(this.store.categoryOf(row.status) === "done", open, this.isQueued(row.id)),
    };
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
      const category = this.store.categoryOf(row.status);
      if (category === "cancelled") continue;
      leaves += 1;
      if (category === "done") done += 1;
    }
    const resolved = live.filter((id) => this.store.isResolvedStatus(work.rows.get(id)!.status)).length;
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
   * Every record's view, derived once per state of the database: a request that checks a state,
   * writes, and answers the plan and a record's detail rebuilds it only when something changed.
   * The key moves with any change this connection makes (`total_changes()`), any commit another
   * connection makes (`data_version`), and the day the dates are read against.
   */
  private ideaViews(today: string): IdeaView[] {
    const { changes } = this.db.prepare("SELECT total_changes() AS changes").get() as { changes: number };
    const { data_version: version } = this.db.prepare("PRAGMA data_version").get() as { data_version: number };
    const key = `${changes}:${version}:${today}`;
    if (this.viewMemo?.key === key) return this.viewMemo.views;
    const views = this.buildIdeaViews(today);
    this.viewMemo = { key, views };
    return views;
  }

  private viewMemo: { key: string; views: IdeaView[] } | null = null;

  private buildIdeaViews(today: string): IdeaView[] {
    const rows = this.recordRows();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const childIds = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parent_id === null || !byId.has(row.parent_id)) continue;
      const list = childIds.get(row.parent_id) ?? [];
      list.push(row.id);
      childIds.set(row.parent_id, list);
    }
    const horizonDates = new Map(this.horizonRows().map((row) => [row.id, row.target_date]));
    const work = this.work();
    /** The work a record stands for: itself once promoted, its links, and its sub-records' work. */
    const rolledWork = (id: string, seen = new Set<string>()): Set<string> => {
      const out = new Set<string>();
      if (seen.has(id)) return out;
      seen.add(id);
      const row = byId.get(id);
      if (!row) return out;
      if (row.kind !== IDEA_KIND) out.add(row.id);
      for (const link of planLinksOf(this.db, row.id)) out.add(link);
      for (const child of childIds.get(id) ?? []) for (const item of rolledWork(child, seen)) out.add(item);
      return out;
    };
    // Every record's sections first: a depends-on cell may name a row of another record's breakdown.
    const sectionsOf = new Map(rows.map((row) => [row.id, this.sectionsOf(row.id)]));
    const dependsOn = dependencyResolver(
      rows.map((row) => ({ id: row.id, identifier: shownIdentifier(row.identifier), title: row.title, rowKeys: sectionsOf.get(row.id)!.breakdown.map((entry) => entry.key) })),
    );
    return rows.map((row) => {
      const promoted = row.kind !== IDEA_KIND;
      const sections = sectionsOf.get(row.id)!;
      const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
      const ownLinks = planLinksOf(this.db, row.id);
      // Its own state reads its own work only: itself once promoted, and its own links. Linked
      // work whose issue is gone (a rewind, say) still counts, so the state does not slip back.
      const ownWork = [...(promoted ? [row.id] : []), ...ownLinks];
      const ownPresent = ownWork.filter((id) => work.rows.has(id));
      const own = this.measure(ownPresent, work);
      const maturity = readMaturity(row.plan_maturity);
      const horizonId = row.plan_horizon_id !== null && horizonDates.has(row.plan_horizon_id) ? row.plan_horizon_id : null;
      const stage = deriveStage({
        maturity,
        scheduled: horizonId !== null,
        links: ownWork.length,
        resolvedLinks: own.resolved,
        missingLinks: ownWork.length - ownPresent.length,
      });
      // The rollup adds its sub-records' work: what the record displays, never its state.
      const workIds = [...rolledWork(row.id)];
      const present = workIds.filter((id) => work.rows.has(id));
      const measured = this.measure(present, work);
      const rolledShipped = present.length > 0 && measured.resolved >= present.length;
      const actual: ActualWindow = {
        start: measured.start,
        end: measured.end,
        forecastEnd: forecastEnd({ start: measured.start, end: measured.end, progress: measured.progress ?? 0, today }),
      };
      const started = workIds.length > 0;
      const hasBaseline = ownWork.length > 0 && (row.plan_baseline_start !== null || row.plan_baseline_target !== null);
      const state = ideaState({ stage, maturity });
      // Scaffolded before: a started record scaffolds again only then, to add new rows.
      const scaffolded = state === "started" && promoted && planRowsOf(this.db, row.id).some((planRow) => this.issueExists(scaffoldTaskId(row.id, planRow.id)));
      // A shaped plan is held to the gate again before anything is built from it.
      const planIncomplete = maturity === "shaped" && (state === "shaped" || scaffolded) ? this.gateOf(row.id) : [];
      return {
        id: row.id,
        identifier: shownIdentifier(row.identifier),
        promoted: row.kind !== IDEA_KIND,
        kind: row.kind,
        title: row.title,
        description: row.description,
        maturity,
        stage,
        parentId: row.parent_id !== null && byId.has(row.parent_id) ? row.parent_id : null,
        horizonId,
        planned: { start: row.plan_start, target: row.plan_target },
        baseline: hasBaseline ? { start: row.plan_baseline_start, target: row.plan_baseline_target } : null,
        rank: row.plan_rank ?? 0,
        links: ownLinks,
        missingLinks: ownLinks.filter((id) => !work.rows.has(id)),
        linkCount: workIds.length,
        resolvedLinks: measured.resolved,
        progress: started ? measured.progress : null,
        actual,
        late: isLate({
          plannedTarget: row.plan_target,
          horizonDate: horizonId === null ? null : (horizonDates.get(horizonId) ?? null),
          actual,
          links: workIds.length,
          open: !rolledShipped && stage !== "dropped",
          today,
        }),
        notStarted: isNotStarted({ plannedStart: row.plan_start, links: workIds.length, dropped: maturity === "dropped", today }),
        childIds: childIds.get(row.id) ?? [],
        openQuestions: questions.filter((q) => !q.resolved).length,
        completeness: completeness(sections, questions, parseDecisions(this.documentBody(row.id, DECISIONS_KEY))),
        dependsOn: dependsOn(row.id, sections),
        planIncomplete,
        ...ideaLifecycle({
          state,
          promoted,
          ownLinks: ownLinks.length,
          gate: maturity === "raw" || maturity === "exploring" ? () => this.gateOf(row.id) : () => [],
          scaffolded,
          planIncomplete,
        }),
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
    const ideas = this.ideaViews(today);
    const idea = ideas.find((view) => view.id === row.id);
    if (!idea) throw new StapleError("not_found", `${displayRef(row)} is not an open idea.`);
    const horizonRow = this.horizonRows().find((h) => h.id === idea.horizonId);
    const parentRow = idea.parentId === null ? undefined : ideas.find((view) => view.id === idea.parentId);
    const work = this.work();
    return {
      idea,
      parent: parentRow ? { id: parentRow.id, identifier: parentRow.identifier, title: parentRow.title } : null,
      children: ideas.filter((view) => view.parentId === idea.id),
      horizon: horizonRow ? this.horizonView(horizonRow, ideas) : null,
      brief: this.documentBody(row.id, BRIEF_KEY),
      questions: parseQuestions(this.documentBody(row.id, QUESTIONS_KEY)),
      decisions: parseDecisions(this.documentBody(row.id, DECISIONS_KEY)),
      linked: idea.links.map((id) => this.linkView(id, work)),
      ...this.planOf(row.id, idea),
      today,
    };
  }

  /** A record's plan sections, as stored: the document sections and the breakdown's rows. */
  sectionsOf(id: string): PlanSections {
    const sections = emptySections();
    for (const name of DOCUMENT_SECTIONS) (sections as unknown as Record<string, unknown>)[name] = readSection(name, this.documentBody(id, SECTION_KEYS[name]));
    sections.breakdown = planRowsOf(this.db, id).map(({ rank: _rank, ...row }) => row);
    return sections;
  }

  /** What the shaped gate finds missing in a record's plan as it stands. */
  private gateOf(id: string): string[] {
    return shapedGate(this.sectionsOf(id), parseQuestions(this.documentBody(id, QUESTIONS_KEY)));
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
      missingForShaped: shapedGate(plan, questions),
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
    if (maturity === "shaped") assertShaped(subject, sections, extra.questions);
    const id = this.store.journaled(() => {
      const issue = this.store.createIssue({ title, kind: IDEA_KIND, parent: input.parent ?? null, createdBy: actor, allowDuplicate: true }, { plan: true });
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
      // Shaped only when the plan, as this write leaves it, passes the gate.
      if (action === "shape") assertShaped(displayRef(row), sections, parseQuestions(this.documentBody(row.id, QUESTIONS_KEY)));
      // The rest of one write is held to the state its maturity change leads to: shaping a raw idea
      // and scheduling it is one decision. A started or shipped record keeps its state.
      if (before !== "started" && before !== "shipped") state = maturity;
    }
    if (patch.horizon !== undefined) allow("schedule");
    if (patch.parent !== undefined) allow("reparent");
    if (patch.plannedStart !== undefined || patch.plannedTarget !== undefined) allow("plan_dates");
    if (patch.before !== undefined) allow("reorder");
    this.store.journaled(() => {
      if (patch.title !== undefined) this.store.updateIssue(row.id, { title: oneLine(patch.title, "An idea's title") }, actor);
      if (patch.brief !== undefined) this.store.putDocument(row.id, BRIEF_KEY, patch.brief ?? "", { author: actor }, { plan: true });
      if (planPatch) this.writeSections(row.id, current, sections, planPatch, actor);
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
      this.write(row.id, columns, actor, "idea_updated", { fields: Object.keys(columns) });
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
  private writeSections(id: string, before: PlanSections, after: PlanSections, patch: PlanPatch, actor: string | null): void {
    for (const name of DOCUMENT_SECTIONS) {
      const body = renderSection(name, after);
      if (body === renderSection(name, before)) continue;
      this.store.putDocument(id, SECTION_KEYS[name], body, { author: actor, changeSummary: `${name} updated` }, { plan: true });
    }
    if (patch.breakdown !== undefined) this.writeBreakdown(id, after.breakdown, actor);
  }

  /**
   * The breakdown as `rows` says, written as only the rows that changed: each is one field of
   * the idea's `milestone` entity (`plan-rows.ts`), a removed row a null. A row keeps its rank
   * while the order allows, so an edit to one row never rewrites the others. One operation.
   */
  private writeBreakdown(id: string, rows: readonly BreakdownRow[], actor: string | null): void {
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
    if (Object.keys(payload).length === 0) return;
    this.store.journal.record({ entity: "milestone", entityId: id, verb: "update", payload, actor: actor ?? null });
    insertEvent(this.db, { kind: "idea_breakdown_updated", issueId: id, actor, payload: counts });
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
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: "question added" }, { plan: true });
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
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: resolved ? "question resolved" : "question reopened" }, { plan: true });
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
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: deferred ? "question deferred" : "question reopened" }, { plan: true });
    return this.detail(row.id);
  }

  addDecision(ref: string, text: string, actor: string | null): IdeaDetail {
    const row = this.recordRow(ref);
    this.allowIdea(row, "decide", {});
    const decisions = parseDecisions(this.documentBody(row.id, DECISIONS_KEY));
    decisions.push(`${this.today()}: ${oneLine(text, "A decision")}`);
    this.store.putDocument(row.id, DECISIONS_KEY, decisions.map((line) => `- ${line}`).join("\n") + "\n", { author: actor, changeSummary: "decision added" }, { plan: true });
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
      .filter((child) => child.actions.some((action) => action.id === "scaffold"))
      .map((child) => this.previewOf(this.row(child.id, false)));
    const problems = [
      ...this.gateOf(row.id),
      ...children.flatMap((child) => child.problems.map((problem) => `sub-idea "${child.idea.title}": ${problem}`)),
    ];
    const warnings = [...planWarnings(sections), ...children.flatMap((child) => child.warnings.map((warning) => `sub-idea "${child.idea.title}": ${warning}`))];
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
          context: taskContextDocument(row.title, sections, task, titles),
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

  /** Adopt: link an existing issue (an epic or a ticket) to a plan record. */
  adopt(ref: string, issueRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.allowIdea(row, "adopt", {});
    const target = this.store.writeTarget(issueRef);
    if (isPlanKind(target.kind) || target.id === row.id) {
      throw new StapleError("validation", `${displayRef(target)} is an idea; only tracker work can be adopted.`);
    }
    if (planLinksOf(this.db, row.id).includes(target.id)) return this.ideaView(row.id);
    this.store.journaled(() => {
      this.link(row, target.id, actor);
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /**
   * Unlink one issue. The issue may be gone (a rewind removed it): a link names it by id, and
   * that id is accepted here even when nothing resolves it any more.
   */
  unlink(ref: string, issueRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.allowIdea(row, "unlink", {});
    const links = planLinksOf(this.db, row.id);
    const issueId = links.includes(issueRef.trim()) ? issueRef.trim() : this.store.getIssue(issueRef).id;
    if (!links.includes(issueId)) {
      throw new StapleError("validation", `${issueRef.trim()} is not linked to ${displayRef(row)}.`);
    }
    const identifier = (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? issueId;
    this.store.journaled(() => {
      writePlanLink(this.db, row.id, issueId, null);
      this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planLinkField(issueId)]: null }, actor: actor ?? null });
      insertEvent(this.db, { kind: "idea_unlinked", issueId: row.id, actor, payload: { issue: identifier } });
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /** One link, one row, one field of the record's `milestone` entity (`plan-links.ts`). */
  private link(row: PlanRow, issueId: string, actor: string | null): void {
    if (planLinksOf(this.db, row.id).includes(issueId)) return;
    const identifier = (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string }).identifier;
    const value = { linkedBy: actor ?? "unknown", linkedAt: this.store.journal.mutationAt() };
    writePlanLink(this.db, row.id, issueId, value);
    this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planLinkField(issueId)]: value }, actor: actor ?? null });
    insertEvent(this.db, { kind: "idea_linked", issueId: row.id, actor, payload: { issue: identifier } });
    this.keepBaselines(row.id, actor);
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

  private insertHorizon(name: string, date: string | null, rank: number, actor: string | null): string {
    const issue = this.store.createIssue({ title: name, kind: MILESTONE_KIND, createdBy: actor, allowDuplicate: true }, { plan: true });
    this.write(issue.id, { plan_rank: rank }, actor, "horizon_created", { date });
    if (date !== null) this.store.milestones().update(issue.id, { targetDate: date }, actor, { plan: true });
    return issue.id;
  }

  /** A dated horizon goes in date order among the dated ones; an undated one goes last. */
  createHorizon(input: { name: string; date?: string | null }, actor: string | null, options: PlanWriteOptions = {}): HorizonView {
    this.assertEnabled();
    this.steer("horizons", null, options);
    const name = oneLine(input.name ?? "", "A horizon's name");
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
    this.store.journaled(() => {
      if (patch.name !== undefined) this.store.updateIssue(row.id, { title: oneLine(patch.name, "A horizon's name") }, actor, undefined, { plan: true });
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
  ownLinks: number;
  /** What the shaped gate still needs, read only when the state offers shaping. */
  gate: () => string[];
  /** Scaffolded before: a started record scaffolds again only then, to add new rows. */
  scaffolded: boolean;
  /** A shaped plan that no longer passes the gate: Scaffold and Promote are held back, saying why. */
  planIncomplete: readonly string[];
}): { state: IdeaState; actions: OfferedAction[] } {
  const actions: OfferedAction[] = [];
  for (const id of ideaOffered(input.state, input.promoted)) {
    if (id === "open_epic" && !input.promoted) continue;
    // A started record that was promoted or linked some other way has nothing to scaffold into.
    if (id === "scaffold" && input.state === "started" && !input.scaffolded) continue;
    const rule = IDEA_ACTIONS[id];
    const offered: OfferedAction = { id, label: rule.label, who: rule.who };
    if (id === "unlink" && input.ownLinks === 0) offered.disabledReason = "Nothing is linked to it.";
    if (id === "shape") {
      const missing = input.gate();
      if (missing.length > 0) offered.disabledReason = `It needs ${gateSentence(missing).replace(/^it needs /, "")}.`;
    }
    if ((id === "scaffold" || id === "promote") && input.planIncomplete.length > 0) {
      offered.disabledReason = `Plan incomplete: it needs ${gateSentence(input.planIncomplete).replace(/^it needs /, "").replace(/ before it is shaped$/, "")}.`;
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

/** The shaped gate as a refusal: what the plan still needs, named. */
function assertShaped(subject: string, sections: PlanSections, questions: readonly Question[]): void {
  const missing = shapedGate(sections, questions);
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
function taskContextDocument(epicTitle: string, sections: PlanSections, row: BreakdownRow, titles: ReadonlyMap<string, string>): string {
  const parts = [`# ${taskTitle(row)}`, `Part of **${epicTitle}**. The epic's plan document holds the whole plan.`];
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
