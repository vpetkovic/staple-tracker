/**
 * The plan layer in the store: the database half of `design/plan.md`.
 *
 * Ideas and horizons are issues of the reserved kinds `idea` and `horizon`. This service owns
 * the plan columns migration 020 added to `issues` and nothing else: title, description,
 * parent, documents, comments and sync are the issue's own. Every write runs inside the
 * store's journaled scope, so the plan columns travel as fields of the `issue` entity.
 *
 * Two rules shape every write:
 *
 *  - Steering is the person's. Maturity, horizon assignment, horizon definitions and dates,
 *    planned dates, order and the baseline need a `PersonDecision`; a write without one is an
 *    agent's and is refused with `steeringRefusal`. Agents capture raw ideas, edit titles and
 *    briefs, add and resolve questions, add decisions, adopt and unlink work, and start an
 *    idea the person has marked shaped.
 *  - Derived facts are never stored: stage beyond maturity, progress, actual dates, forecast
 *    and lateness are read from the linked work every time a view is built.
 */
import type { DatabaseSync } from "node:sqlite";
import { insertEvent } from "./event-log.js";
import { rankBetween, renumberedRanks } from "./milestones.js";
import {
  DEFAULT_HORIZONS,
  HORIZON_KIND,
  IDEA_KIND,
  PLAN_KINDS_MISSING_MESSAGE,
  assertPlanWindow,
  deriveStage,
  forecastEnd,
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
import type { WorkspaceStore } from "./store.js";
import { StapleError, type PersonDecision } from "./types.js";

/** Who is writing. A `person` is the distinction; without one the write is an agent's. */
export interface PlanWriteOptions {
  person?: PersonDecision | null;
}

export interface HorizonView {
  id: string;
  identifier: string;
  name: string;
  /** YYYY-MM-DD, or null for an undated horizon such as Later. */
  date: string | null;
  rank: number;
  ideaCount: number;
  /** Ideas on it whose linked work is past its line. */
  lateCount: number;
  /** Ideas on it with nothing linked whose planned start has passed. */
  notStartedCount: number;
  late: boolean;
}

export interface PlanWindow {
  start: string | null;
  target: string | null;
}

export interface IdeaView {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  maturity: Maturity;
  stage: Stage;
  parentId: string | null;
  horizonId: string | null;
  planned: PlanWindow;
  /** The window kept when the idea was started; null before it is started or when it had no window. */
  baseline: PlanWindow | null;
  rank: number;
  /** The issues this idea itself links, by id; some may be missing (see `missingLinks`). */
  links: string[];
  /** Own links whose issue this device no longer holds (a rewind, say): shown as missing, still unlinkable. */
  missingLinks: string[];
  /** Linked issues, own and rolled up from child ideas. */
  linkCount: number;
  resolvedLinks: number;
  /** Done leaves over counted leaves of the linked work, 0..1; null with nothing linked. */
  progress: number | null;
  actual: ActualWindow;
  /** Linked work landed, or is forecast to land, past the planned end or the horizon line. */
  late: boolean;
  /** Nothing linked yet and the planned start has passed. */
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
  parent: { id: string; identifier: string; title: string } | null;
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
  /** Place this idea immediately before that one in the plan order; null moves it to the end. */
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
    if (!this.store.planningOn()) throw new StapleError("validation", PLAN_KINDS_MISSING_MESSAGE, { kinds: [IDEA_KIND, HORIZON_KIND] });
  }

  private steer(what: SteeringWrite, identifier: string | null, options: PlanWriteOptions): void {
    if (!options.person) throw steeringRefusal(what, identifier);
  }

  private row(ref: string, forWrite = true): PlanRow {
    const issue = forWrite ? this.store.writeTarget(ref) : this.store.getIssue(ref);
    return this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(issue.id) as unknown as PlanRow;
  }

  private ideaRow(ref: string, forWrite = true): PlanRow {
    const row = this.row(ref, forWrite);
    if (row.kind !== IDEA_KIND) {
      throw new StapleError("validation", `${row.identifier} is not an idea (it is a ${row.kind}).`, { identifier: row.identifier });
    }
    return row;
  }

  private horizonRow(ref: string, forWrite = true): PlanRow {
    const row = this.row(ref, forWrite);
    if (row.kind !== HORIZON_KIND) {
      throw new StapleError("validation", `${row.identifier} is not a horizon (it is a ${row.kind}).`, { identifier: row.identifier });
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
    for (const name of names) {
      const value = columns[name];
      payload[FIELD_OF[name] ?? name] = value;
    }
    this.store.journal.record({ entity: "issue", entityId: id, verb: "update", payload, actor: actor ?? null });
    insertEvent(this.db, { kind: event, issueId: id, actor, payload: detail });
  }

  // ---------- enabling ----------

  /** Add the two kinds when they are missing and seed Now / Next / Later when no horizon exists. */
  enable(actor: string | null): PlanView {
    if (this.store.planningOn()) return this.view();
    /**
     * A workspace may already use `idea` or `horizon` as a kind of its own. Its issues are not
     * plans, and turning planning on would take them out of every task view, the queue and
     * checkout, so it is refused, naming them, until they are re-kinded.
     */
    const unrelated = this.db
      .prepare("SELECT identifier FROM issues WHERE kind IN (?, ?) ORDER BY identifier")
      .all(IDEA_KIND, HORIZON_KIND) as Array<{ identifier: string }>;
    if (unrelated.length > 0) {
      const names = unrelated.map((row) => row.identifier);
      throw new StapleError(
        "validation",
        `Planning uses the kinds "idea" and "horizon", and ${names.slice(0, 10).join(", ")}${names.length > 10 ? ` and ${names.length - 10} more` : ""} already use one of them for other work. Re-kind ${names.length === 1 ? "it" : "them"} first (staple set <ref> --kind <other>), then turn planning on.`,
        { issues: names },
      );
    }
    return this.store.journaled(() => {
      const ids = this.store.getKinds().map((kind) => kind.id);
      if (!ids.includes(IDEA_KIND)) this.store.addKind({ id: IDEA_KIND, label: "Idea" }, actor);
      if (!ids.includes(HORIZON_KIND)) this.store.addKind({ id: HORIZON_KIND, label: "Horizon" }, actor);
      DEFAULT_HORIZONS.forEach((name, index) => this.insertHorizon(name, null, (index + 1) * RANK_STEP, actor));
      return this.view();
    });
  }

  // ---------- reads ----------

  private horizonRows(): PlanRow[] {
    const resolved = this.resolvedStatuses();
    return (this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE kind = ?`).all(HORIZON_KIND) as unknown as PlanRow[])
      .filter((row) => !resolved.has(row.status))
      .sort((a, b) => (a.plan_rank ?? Number.MAX_SAFE_INTEGER) - (b.plan_rank ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at));
  }

  private ideaRows(): PlanRow[] {
    const resolved = this.resolvedStatuses();
    return (this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE kind = ?`).all(IDEA_KIND) as unknown as PlanRow[])
      .filter((row) => !resolved.has(row.status))
      .sort((a, b) => (a.plan_rank ?? Number.MAX_SAFE_INTEGER) - (b.plan_rank ?? Number.MAX_SAFE_INTEGER) || a.created_at.localeCompare(b.created_at));
  }

  private resolvedStatuses(): Set<string> {
    return new Set(this.store.getStatuses().filter((status) => this.store.isResolvedStatus(status.id)).map((status) => status.id));
  }

  /** The whole plan: every horizon in order and every idea with its derived facts. */
  view(): PlanView {
    const today = this.today();
    if (!this.enabled()) return { enabled: false, today, horizons: [], ideas: [] };
    const ideas = this.ideaViews(today);
    const horizons = this.horizonRows().map((row) => this.horizonView(row, ideas));
    return { enabled: true, today, horizons, ideas };
  }

  private horizonView(row: PlanRow, ideas: readonly IdeaView[]): HorizonView {
    const on = ideas.filter((idea) => idea.horizonId === row.id && idea.stage !== "dropped");
    const lateCount = on.filter((idea) => idea.late).length;
    return {
      id: row.id,
      identifier: row.identifier,
      name: row.title,
      date: row.plan_target,
      rank: row.plan_rank ?? 0,
      ideaCount: on.length,
      lateCount,
      notStartedCount: on.filter((idea) => idea.notStarted).length,
      late: lateCount > 0,
    };
  }

  /** Every non-plan issue, read once per view: the links' subtrees come from this. */
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

  /** Progress and dates over a set of linked roots, each leaf counted once. */
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
    const rows = this.ideaRows();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const childIds = new Map<string, string[]>();
    for (const row of rows) {
      if (row.parent_id === null || !byId.has(row.parent_id)) continue;
      const list = childIds.get(row.parent_id) ?? [];
      list.push(row.id);
      childIds.set(row.parent_id, list);
    }
    const horizonDates = new Map(this.horizonRows().map((row) => [row.id, row.plan_target]));
    const work = this.work();
    const rolledLinks = (id: string, seen = new Set<string>()): Set<string> => {
      const out = new Set<string>();
      if (seen.has(id)) return out;
      seen.add(id);
      const row = byId.get(id);
      if (!row) return out;
      for (const link of planLinksOf(this.db, row.id)) out.add(link);
      for (const child of childIds.get(id) ?? []) for (const link of rolledLinks(child, seen)) out.add(link);
      return out;
    };
    return rows.map((row) => {
      const links = [...rolledLinks(row.id)];
      // A link whose issue is gone (a rewind, say) still counts as linked: the stage does not slip back.
      const present = links.filter((id) => work.rows.has(id));
      const missing = links.length - present.length;
      const measured = this.measure(present, work);
      const maturity = readMaturity(row.plan_maturity);
      const horizonId = row.plan_horizon_id !== null && horizonDates.has(row.plan_horizon_id) ? row.plan_horizon_id : null;
      const stage = deriveStage({ maturity, scheduled: horizonId !== null, links: links.length, resolvedLinks: measured.resolved, missingLinks: missing });
      const actual: ActualWindow = {
        start: measured.start,
        end: measured.end,
        forecastEnd: forecastEnd({ start: measured.start, end: measured.end, progress: measured.progress ?? 0, today }),
      };
      const started = links.length > 0;
      const hasBaseline = row.plan_baseline_start !== null || row.plan_baseline_target !== null;
      return {
        id: row.id,
        identifier: row.identifier,
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
        linkCount: links.length,
        resolvedLinks: measured.resolved,
        progress: started ? measured.progress : null,
        actual,
        late: isLate({
          plannedTarget: row.plan_target,
          horizonDate: horizonId === null ? null : (horizonDates.get(horizonId) ?? null),
          actual,
          links: links.length,
          open: stage !== "shipped" && stage !== "dropped",
          today,
        }),
        notStarted: isNotStarted({ plannedStart: row.plan_start, links: links.length, dropped: maturity === "dropped", today }),
        childIds: childIds.get(row.id) ?? [],
        openQuestions: parseQuestions(this.documentBody(row.id, QUESTIONS_KEY)).filter((q) => !q.resolved).length,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  ideaView(ref: string): IdeaView {
    const row = this.ideaRow(ref, false);
    const idea = this.ideaViews(this.today()).find((view) => view.id === row.id);
    if (!idea) throw new StapleError("not_found", `${row.identifier} is not an open idea.`, { identifier: row.identifier });
    return idea;
  }

  /** One idea with its brief, questions, decisions, children and linked work. */
  detail(ref: string): IdeaDetail {
    this.assertEnabled();
    const row = this.ideaRow(ref, false);
    const today = this.today();
    const ideas = this.ideaViews(today);
    const idea = ideas.find((view) => view.id === row.id);
    if (!idea) throw new StapleError("not_found", `${row.identifier} is not an open idea.`, { identifier: row.identifier });
    const horizons = this.horizonRows();
    const horizonRow = horizons.find((h) => h.id === idea.horizonId);
    const parentRow = idea.parentId === null ? undefined : ideas.find((view) => view.id === idea.parentId);
    const work = this.work();
    const linked = idea.links.map((id) => this.linkView(id, work));
    return {
      idea,
      parent: parentRow ? { id: parentRow.id, identifier: parentRow.identifier, title: parentRow.title } : null,
      children: ideas.filter((view) => view.parentId === idea.id),
      horizon: horizonRow ? this.horizonView(horizonRow, ideas) : null,
      brief: this.documentBody(row.id, BRIEF_KEY),
      questions: parseQuestions(this.documentBody(row.id, QUESTIONS_KEY)),
      decisions: parseDecisions(this.documentBody(row.id, DECISIONS_KEY)),
      linked,
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
          .find((candidate) => candidate.scope.kind === "milestone" && candidate.scope.issueId === milestoneId && (candidate.state === "active" || candidate.state === "paused")) ?? null;
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

  // ---------- ideas ----------

  /** Capture an idea. An agent captures raw ideas only: title, parent and brief. */
  capture(input: CaptureInput, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const title = oneLine(input.title ?? "", "An idea's title");
    const maturity = input.maturity === undefined ? "raw" : parseMaturity(input.maturity);
    if (maturity !== "raw") this.steer("maturity", null, options);
    if (input.horizon) this.steer("horizon", null, options);
    if (input.plannedStart || input.plannedTarget) this.steer("planned dates", null, options);
    const id = this.store.journaled(() => {
      const issue = this.store.createIssue({
        title,
        kind: IDEA_KIND,
        parent: input.parent ?? null,
        createdBy: actor,
        allowDuplicate: true,
      }, { plan: true });
      const columns: Record<string, unknown> = { plan_maturity: maturity, plan_rank: this.nextRank(IDEA_KIND) };
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
      return issue.id;
    });
    return this.ideaView(id);
  }

  update(ref: string, patch: IdeaPatch, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.ideaRow(ref);
    if (patch.maturity !== undefined) this.steer("maturity", row.identifier, options);
    if (patch.horizon !== undefined) this.steer("horizon", row.identifier, options);
    if (patch.parent !== undefined) this.steer("parent", row.identifier, options);
    if (patch.plannedStart !== undefined || patch.plannedTarget !== undefined) this.steer("planned dates", row.identifier, options);
    if (patch.before !== undefined) this.steer("horizon", row.identifier, options);
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
      if (patch.before !== undefined) columns.plan_rank = this.rankBefore(IDEA_KIND, row.id, patch.before, actor);
      this.write(row.id, columns, actor, "idea_updated", { fields: Object.keys(columns) });
      if (patch.parent !== undefined) this.reparent(row, patch.parent, actor);
      this.keepBaselines(row.id, actor);
    });
    return this.ideaView(row.id);
  }

  /** Re-file an idea under another idea (or at the top), moving its subtree's depth with it. */
  private reparent(row: PlanRow, parentRef: string | null, actor: string | null): void {
    const parent = parentRef === null ? null : this.ideaRow(parentRef);
    if (parent !== null) {
      let cursor: string | null = parent.id;
      for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
        if (cursor === row.id) {
          throw new StapleError("validation", `${parent.identifier} sits under ${row.identifier}; an idea cannot be its own ancestor.`);
        }
        cursor = (this.db.prepare("SELECT parent_id FROM issues WHERE id = ?").get(cursor) as { parent_id: string | null } | undefined)?.parent_id ?? null;
      }
    }
    const depth = parent === null ? 0 : parent.depth + 1;
    this.write(row.id, { parent_id: parent?.id ?? null, depth }, actor, "idea_moved", { parent: parent?.identifier ?? null });
    const walk = (id: string, level: number): void => {
      for (const child of this.db.prepare("SELECT id FROM issues WHERE parent_id = ?").all(id) as Array<{ id: string }>) {
        this.db.prepare("UPDATE issues SET depth = ? WHERE id = ?").run(level, child.id);
        walk(child.id, level + 1);
      }
    };
    walk(row.id, depth + 1);
  }

  addQuestion(ref: string, text: string, actor: string | null): IdeaDetail {
    const row = this.ideaRow(ref);
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    questions.push({ text: oneLine(text, "A question"), resolved: false });
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: "question added" });
    return this.detail(row.id);
  }

  /** Resolve (or reopen) the question at a 1-based position. */
  resolveQuestion(ref: string, position: number, actor: string | null, resolved = true): IdeaDetail {
    const row = this.ideaRow(ref);
    const questions = parseQuestions(this.documentBody(row.id, QUESTIONS_KEY));
    const question = questions[position - 1];
    if (!question) {
      throw new StapleError("validation", `${row.identifier} has ${questions.length} question${questions.length === 1 ? "" : "s"}; there is no #${position}.`);
    }
    question.resolved = resolved;
    this.store.putDocument(row.id, QUESTIONS_KEY, renderQuestions(questions), { author: actor, changeSummary: resolved ? "question resolved" : "question reopened" });
    return this.detail(row.id);
  }

  addDecision(ref: string, text: string, actor: string | null): IdeaDetail {
    const row = this.ideaRow(ref);
    const decisions = parseDecisions(this.documentBody(row.id, DECISIONS_KEY));
    decisions.push(`${this.today()}: ${oneLine(text, "A decision")}`);
    this.store.putDocument(row.id, DECISIONS_KEY, decisions.map((line) => `- ${line}`).join("\n") + "\n", { author: actor, changeSummary: "decision added" });
    return this.detail(row.id);
  }

  // ---------- links: Start, Adopt, Unlink ----------

  /**
   * Start: create an epic from the idea, its brief stored as the epic's `plan` document, and
   * link it. A person may start any idea; an agent only one the person marked shaped.
   */
  start(ref: string, input: { title?: string } = {}, actor: string | null, options: PlanWriteOptions = {}): { idea: IdeaView; epic: { id: string; identifier: string } } {
    this.assertEnabled();
    const row = this.ideaRow(ref);
    if (!options.person && readMaturity(row.plan_maturity) !== "shaped") throw steeringRefusal("start", row.identifier);
    const kinds = this.store.getKinds().map((kind) => kind.id);
    const epic = this.store.journaled(() => {
      const issue = this.store.createIssue({
        title: oneLine(input.title ?? row.title, "The epic's title"),
        description: row.description,
        kind: kinds.includes("epic") ? "epic" : undefined,
        createdBy: actor,
        allowDuplicate: true,
      });
      const brief = this.documentBody(row.id, BRIEF_KEY);
      if (brief?.trim()) this.store.putDocument(issue.id, "plan", brief, { author: actor, changeSummary: `from ${row.identifier}` });
      this.link(row, issue.id, actor);
      return issue;
    });
    return { idea: this.ideaView(row.id), epic: { id: epic.id, identifier: epic.identifier } };
  }

  /** Adopt: link an existing issue (an epic or a ticket) to the idea. */
  adopt(ref: string, issueRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.ideaRow(ref);
    const target = this.store.writeTarget(issueRef);
    if (isPlanKind(target.kind)) {
      throw new StapleError("validation", `${target.identifier} is ${target.kind === IDEA_KIND ? "an idea" : "a horizon"}; only tracker work can be adopted.`);
    }
    if (planLinksOf(this.db, row.id).includes(target.id)) return this.ideaView(row.id);
    this.store.journaled(() => this.link(row, target.id, actor));
    return this.ideaView(row.id);
  }

  /**
   * Unlink one issue. The issue may be gone (a rewind removed it): a link names it by id, and
   * that id is accepted here even when nothing resolves it any more.
   */
  unlink(ref: string, issueRef: string, actor: string | null): IdeaView {
    this.assertEnabled();
    const row = this.ideaRow(ref);
    const links = planLinksOf(this.db, row.id);
    const issueId = links.includes(issueRef.trim()) ? issueRef.trim() : this.store.getIssue(issueRef).id;
    if (!links.includes(issueId)) {
      throw new StapleError("validation", `${issueRef.trim()} is not linked to ${row.identifier}.`);
    }
    const identifier = (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? issueId;
    this.store.journaled(() => {
      writePlanLink(this.db, row.id, issueId, null);
      this.store.journal.record({ entity: "milestone", entityId: row.id, verb: "update", payload: { [planLinkField(issueId)]: null }, actor: actor ?? null });
      insertEvent(this.db, { kind: "idea_unlinked", issueId: row.id, actor, payload: { issue: identifier } });
    });
    return this.ideaView(row.id);
  }

  /** One link, one row, one field of the idea's `milestone` entity (`plan-links.ts`). */
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
   * The first planned window an idea has once it is started is kept as its baseline. Run
   * after anything that can start an idea (a link on it or on a child idea) or give a started
   * idea its first window: the idea and every idea above it that is started, has a window and
   * has no baseline yet gets one. A baseline that exists is never moved here.
   */
  private keepBaselines(id: string, actor: string | null): void {
    let cursor: string | null = id;
    for (let hops = 0; cursor !== null && hops < 64; hops += 1) {
      const row = this.db.prepare(`SELECT ${PLAN_COLUMNS} FROM issues WHERE id = ?`).get(cursor) as unknown as PlanRow | undefined;
      if (!row || row.kind !== IDEA_KIND) return;
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

  private isStarted(id: string, seen = new Set<string>()): boolean {
    if (seen.has(id)) return false;
    seen.add(id);
    if (planLinksOf(this.db, id).length > 0) return true;
    const children = this.db.prepare("SELECT id FROM issues WHERE parent_id = ? AND kind = ?").all(id, IDEA_KIND) as Array<{ id: string }>;
    return children.some((child) => this.isStarted(child.id, seen));
  }

  /** Reset baseline: the current planned window becomes the baseline. The person's, and only on request. */
  resetBaseline(ref: string, actor: string | null, options: PlanWriteOptions = {}): IdeaView {
    this.assertEnabled();
    const row = this.ideaRow(ref);
    this.steer("baseline", row.identifier, options);
    if (!this.isStarted(row.id)) {
      throw new StapleError("validation", `${row.identifier} is not started, so it has no baseline to reset.`, { identifier: row.identifier });
    }
    this.store.journaled(() =>
      this.write(row.id, { plan_baseline_start: row.plan_start, plan_baseline_target: row.plan_target }, actor, "idea_baseline_reset", {
        from: { start: row.plan_baseline_start, target: row.plan_baseline_target },
        to: { start: row.plan_start, target: row.plan_target },
      }),
    );
    return this.ideaView(row.id);
  }

  // ---------- horizons (all the person's) ----------

  private insertHorizon(name: string, date: string | null, rank: number, actor: string | null): string {
    const issue = this.store.createIssue({ title: name, kind: HORIZON_KIND, createdBy: actor }, { plan: true });
    this.write(issue.id, { plan_target: date, plan_rank: rank }, actor, "horizon_created", { date });
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
      let rank: number;
      const next = date === null ? undefined : rows.find((row) => row.plan_target === null || row.plan_target > date);
      if (next === undefined) {
        rank = (rows.at(-1)?.plan_rank ?? 0) + RANK_STEP;
      } else {
        rank = this.rankBefore(HORIZON_KIND, null, next.id, actor);
      }
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
      const columns: Record<string, unknown> = {};
      if (patch.date !== undefined) columns.plan_target = patch.date === null ? null : parsePlanDate(patch.date);
      if (patch.before !== undefined) columns.plan_rank = this.rankBefore(HORIZON_KIND, row.id, patch.before, actor);
      this.write(row.id, columns, actor, "horizon_updated", { fields: Object.keys(columns) });
    });
    return this.horizonOf(row.id);
  }

  /** Remove a horizon: it is cancelled (issues are never deleted) and its ideas become unscheduled. */
  removeHorizon(ref: string, actor: string | null, options: PlanWriteOptions = {}): PlanView {
    this.assertEnabled();
    const row = this.horizonRow(ref);
    this.steer("horizons", row.identifier, options);
    this.store.journaled(() => {
      const on = this.db.prepare("SELECT id FROM issues WHERE kind = ? AND plan_horizon_id = ?").all(IDEA_KIND, row.id) as Array<{ id: string }>;
      for (const idea of on) this.write(idea.id, { plan_horizon_id: null }, actor, "idea_updated", { fields: ["plan_horizon_id"] });
      this.store.updateIssue(row.id, { status: this.store.primaryStatusFor("cancelled") }, actor, undefined, { plan: true });
    });
    return this.view();
  }

  private horizonOf(id: string): HorizonView {
    const horizon = this.view().horizons.find((view) => view.id === id);
    if (!horizon) throw new StapleError("not_found", "That horizon is not open.");
    return horizon;
  }

  // ---------- order ----------

  private nextRank(kind: string): number {
    const row = this.db.prepare("SELECT MAX(plan_rank) AS rank FROM issues WHERE kind = ?").get(kind) as { rank: number | null };
    return (row.rank ?? 0) + RANK_STEP;
  }

  /**
   * The rank that puts `id` immediately before `beforeRef` among the open rows of a kind
   * (`null`: at the end). Ranks are sparse; when two neighbours leave no room, the kind's
   * rows are renumbered in their current order first.
   */
  private rankBefore(kind: string, id: string | null, beforeRef: string | null, actor: string | null): number {
    const ordered = (kind === IDEA_KIND ? this.ideaRows() : this.horizonRows()).filter((row) => row.id !== id);
    if (beforeRef === null) return (ordered.at(-1)?.plan_rank ?? 0) + RANK_STEP;
    const before = this.row(beforeRef);
    if (before.kind !== kind) throw new StapleError("validation", `${before.identifier} is not ${kind === IDEA_KIND ? "an idea" : "a horizon"}.`);
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
