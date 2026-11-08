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
 * Two rules shape every write:
 *
 *  - Steering is the person's. Maturity, horizon assignment, horizon definitions and dates,
 *    planned dates, order and the baseline need a `PersonDecision`; a write without one is an
 *    agent's and is refused with `steeringRefusal`. Agents capture raw ideas, edit titles and
 *    briefs, add and resolve questions, add decisions, adopt and unlink work, and promote an
 *    idea the person has marked shaped.
 *  - Derived facts are never stored: stage beyond maturity, progress, actual dates, forecast,
 *    lateness and a horizon's members are read or rebuilt from the work every time.
 */
import type { DatabaseSync } from "node:sqlite";
import { insertEvent } from "./event-log.js";
import { moveIdentifier } from "./identifier-moves.js";
import { MILESTONE_KIND, rankBetween, renumberedRanks } from "./milestones.js";
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
import { planLinkField, planLinksOf, writePlanLink } from "./plan-links.js";
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
  late: boolean;
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
  today: string;
}

export interface CaptureInput {
  title: string;
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
  plan_maturity, plan_horizon_id, plan_start, plan_target, plan_baseline_start, plan_baseline_target, plan_rank`;

/** Column name to the payload field the issue entity carries it as. */
const FIELD_OF: Record<string, string> = {
  plan_maturity: "planMaturity",
  plan_horizon_id: "planHorizonId",
  plan_start: "planStart",
  plan_target: "planTarget",
  plan_baseline_start: "planBaselineStart",
  plan_baseline_target: "planBaselineTarget",
  plan_rank: "planRank",
  parent_id: "parentId",
};

const QUESTIONS_KEY = "questions";
const DECISIONS_KEY = "decisions";
const BRIEF_KEY = "brief";

export function parseQuestions(body: string | null): Question[] {
  if (!body) return [];
  const out: Question[] = [];
  for (const line of body.split("\n")) {
    const match = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (match) out.push({ text: match[2]!.trim(), resolved: match[1] !== " " });
  }
  return out;
}

export function renderQuestions(questions: readonly Question[]): string {
  return questions.map((q) => `- [${q.resolved ? "x" : " "}] ${q.text}`).join("\n") + "\n";
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

  /** An idea not yet promoted. */
  private ideaRow(ref: string, forWrite = true): PlanRow {
    const row = this.recordRow(ref, forWrite);
    if (row.kind !== IDEA_KIND) {
      throw new StapleError("validation", `${row.identifier} is already promoted: it is ${aKind(row.kind)} in the tracker now.`, { identifier: row.identifier });
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
      late: lateCount > 0,
    };
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

  private ideaViews(today: string): IdeaView[] {
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
    return rows.map((row) => {
      const workIds = [...rolledWork(row.id)];
      // Linked work whose issue is gone (a rewind, say) still counts: the stage does not slip back.
      const present = workIds.filter((id) => work.rows.has(id));
      const missing = workIds.length - present.length;
      const measured = this.measure(present, work);
      const maturity = readMaturity(row.plan_maturity);
      const horizonId = row.plan_horizon_id !== null && horizonDates.has(row.plan_horizon_id) ? row.plan_horizon_id : null;
      const stage = deriveStage({ maturity, scheduled: horizonId !== null, links: workIds.length, resolvedLinks: measured.resolved, missingLinks: missing });
      const actual: ActualWindow = {
        start: measured.start,
        end: measured.end,
        forecastEnd: forecastEnd({ start: measured.start, end: measured.end, progress: measured.progress ?? 0, today }),
      };
      const started = workIds.length > 0;
      const hasBaseline = row.plan_baseline_start !== null || row.plan_baseline_target !== null;
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
        baseline: started && hasBaseline ? { start: row.plan_baseline_start, target: row.plan_baseline_target } : null,
        rank: row.plan_rank ?? 0,
        links: planLinksOf(this.db, row.id),
        missingLinks: planLinksOf(this.db, row.id).filter((id) => !work.rows.has(id)),
        linkCount: workIds.length,
        resolvedLinks: measured.resolved,
        progress: started ? measured.progress : null,
        actual,
        late: isLate({
          plannedTarget: row.plan_target,
          horizonDate: horizonId === null ? null : (horizonDates.get(horizonId) ?? null),
          actual,
          links: workIds.length,
          open: stage !== "shipped" && stage !== "dropped",
          today,
        }),
        notStarted: isNotStarted({ plannedStart: row.plan_start, links: workIds.length, dropped: maturity === "dropped", today }),
        childIds: childIds.get(row.id) ?? [],
        openQuestions: parseQuestions(this.documentBody(row.id, QUESTIONS_KEY)).filter((q) => !q.resolved).length,
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
      today,
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

  private documentBody(id: string, key: string): string | null {
    const known = this.store.listDocuments(id).some((doc) => doc.key === key);
    return known ? this.store.getDocument(id, key).body : null;
  }

  // ---------- records ----------

  /** Capture an idea. An agent captures raw ideas only: title, parent and brief. No ticket number. */
  capture(input: CaptureInput, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const title = oneLine(input.title ?? "", "An idea's title");
    const maturity = input.maturity === undefined ? "raw" : parseMaturity(input.maturity);
    if (maturity !== "raw") this.steer("maturity", null, options);
    if (input.horizon) this.steer("horizon", null, options);
    if (input.plannedStart || input.plannedTarget) this.steer("planned dates", null, options);
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
      if (input.brief?.trim()) this.store.putDocument(issue.id, BRIEF_KEY, input.brief, { author: actor });
      this.settleMembership(actor);
      return issue.id;
    });
    return this.ideaView(id);
  }

  update(ref: string, patch: IdeaPatch, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    const name = displayRef(row);
    if (patch.maturity !== undefined) this.steer("maturity", name, options);
    if (patch.horizon !== undefined) this.steer("horizon", name, options);
    if (patch.parent !== undefined) this.steer("parent", name, options);
    if (patch.plannedStart !== undefined || patch.plannedTarget !== undefined) this.steer("planned dates", name, options);
    if (patch.before !== undefined) this.steer("horizon", name, options);
    this.store.journaled(() => {
      if (patch.title !== undefined) this.store.updateIssue(row.id, { title: oneLine(patch.title, "An idea's title") }, actor);
      if (patch.brief !== undefined) this.store.putDocument(row.id, BRIEF_KEY, patch.brief ?? "", { author: actor });
      const columns: Record<string, unknown> = {};
      if (patch.maturity !== undefined) columns.plan_maturity = parseMaturity(patch.maturity);
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

  /** Re-file a record under another record (or at the top), moving its subtree's depth with it. */
  private reparent(row: PlanRow, parentRef: string | null, actor: string | null): void {
    const parent = parentRef === null ? null : this.recordRow(parentRef);
    if (parent !== null) {
      if (row.kind !== IDEA_KIND && parent.kind === IDEA_KIND) {
        throw new StapleError("validation", `${row.identifier} is promoted; it cannot sit under ${displayRef(parent)}, which is not.`);
      }
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
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    questions.push({ text: oneLine(text, "A question"), resolved: false });
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: "question added" });
    return this.detail(row.id);
  }

  /** Resolve (or reopen) the question at a 1-based position. */
  resolveQuestion(ref: string, position: number, actor: string | null, resolved = true): IdeaDetail {
    const row = this.recordRow(ref);
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    const question = questions[position - 1];
    if (!question) {
      throw new StapleError("validation", `${displayRef(row)} has ${questions.length} question${questions.length === 1 ? "" : "s"}; there is no #${position}.`);
    }
    question.resolved = resolved;
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: resolved ? "question resolved" : "question reopened" });
    return this.detail(row.id);
  }

  addDecision(ref: string, text: string, actor: string | null): IdeaDetail {
    const row = this.recordRow(ref);
    const decisions = parseDecisions(this.documentBody(row.id, DECISIONS_KEY));
    decisions.push(`${this.today()}: ${oneLine(text, "A decision")}`);
    this.store.putDocument(row.id, DECISIONS_KEY, decisions.map((line) => `- ${line}`).join("\n") + "\n", { author: actor, changeSummary: "decision added" });
    return this.detail(row.id);
  }

  // ---------- into the tracker: Promote, Adopt, Unlink ----------

  /**
   * Promote in place: the idea becomes the epic on the same record. It takes the next ticket
   * number then, and keeps its documents, comments, files, events, links and plan fields; its
   * sub-ideas stay under it. A person may promote any idea that is not dropped; an agent only one
   * the person marked shaped. An idea under an idea that is not promoted yet waits for it.
   */
  promote(ref: string, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.ideaRow(ref);
    const maturity = readMaturity(row.plan_maturity);
    if (!options.person && maturity !== "shaped") throw steeringRefusal("promote", displayRef(row));
    if (maturity === "dropped") throw new StapleError("validation", `${displayRef(row)} is dropped; restore it before promoting it.`);
    if (row.parent_id !== null) {
      const parent = this.db.prepare("SELECT identifier, title, kind, plan_maturity FROM issues WHERE id = ?").get(row.parent_id) as
        | { identifier: string; title: string; kind: string; plan_maturity: string | null }
        | undefined;
      if (parent?.kind === IDEA_KIND) {
        throw new StapleError("validation", `${displayRef(row)} sits under ${displayRef(parent)}, which is not promoted yet. Promote the parent first, so the epic has an epic above it.`);
      }
    }
    const kinds = this.store.getKinds().map((kind) => kind.id);
    const kind = kinds.includes(PROMOTED_KIND) ? PROMOTED_KIND : this.store.defaultKind();
    this.store.journaled(() => {
      this.store.promoteInPlace(row.id, kind, actor);
      this.keepBaselines(row.id, actor);
      this.settleMembership(actor);
    });
    return this.ideaView(row.id);
  }

  /** Adopt: link an existing issue (an epic or a ticket) to a plan record. */
  adopt(ref: string, issueRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
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
   * The first planned window a record has once it is started is kept as its baseline. Run after
   * anything that can start one (a promotion, a link, on it or on a sub-idea) or give a started
   * record its first window: it and every record above it that is started, has a window and has
   * no baseline yet gets one. A baseline that exists is never moved here.
   */
  private keepBaselines(id: string, actor: string | null): void {
    let cursor: string | null = id;
    for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
      const row = this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(cursor) as unknown as PlanRow | undefined;
      if (!row || row.plan_maturity === null) return;
      const hasWindow = row.plan_start !== null || row.plan_target !== null;
      const hasBaseline = row.plan_baseline_start !== null || row.plan_baseline_target !== null;
      if (hasWindow && !hasBaseline && this.isStarted(row.id)) {
        this.write(row.id, { plan_baseline_start: row.plan_start, plan_baseline_target: row.plan_target }, actor, "idea_baseline_kept", {
          start: row.plan_start,
          target: row.plan_target,
        });
      }
      cursor = row.parent_id;
    }
  }

  /** Started: promoted, or links work, itself or through a sub-idea. */
  private isStarted(id: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    const row = this.db.prepare("SELECT kind FROM issues WHERE id = ?").get(id) as { kind: string } | undefined;
    if (row !== undefined && row.kind !== IDEA_KIND) return true;
    if (planLinksOf(this.db, id).length > 0) return true;
    const children = this.db.prepare("SELECT id FROM issues WHERE parent_id = ? AND plan_maturity IS NOT NULL").all(id) as Array<{ id: string }>;
    return children.some((child) => this.isStarted(child.id, seen));
  }

  /** Reset baseline: the current planned window becomes the baseline. The person's, and only on request. */
  resetBaseline(ref: string, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.recordRow(ref);
    this.steer("baseline", displayRef(row), options);
    if (!this.isStarted(row.id)) {
      throw new StapleError("validation", `${displayRef(row)} is not started, so it has no baseline to reset.`);
    }
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
   * Remove a horizon: the milestone is cancelled (issues are never deleted) and its unstarted
   * ideas become unscheduled. Refused while it holds open work or sits in the queue: cancelling
   * it then would leave that work inside a cancelled milestone, or take the horizon off the queue
   * without anyone deciding to, so the refusal names what to move first.
   */
  removeHorizon(ref: string, actor: string | null, options: PlanWriteOptions = {}): PlanView {
    this.assertEnabled();
    const row = this.horizonRow(ref);
    this.steer("horizons", row.identifier, options);
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
