/**
 * Milestones in the store — the database half of `docs/milestones.md` (STA-172, R3b).
 *
 * A milestone is an ordinary issue of the reserved `milestone` kind. This
 * service owns the two tables migration 007 added — `milestone_meta` (two
 * calendar dates and the per-milestone `members_revision`) and
 * `milestone_members` (an ORDERED relation that never touches `parent_id`) —
 * and nothing else: title, description, assignee, status, comments, documents
 * and every guard stay exactly what `WorkspaceStore` gives any issue.
 *
 * Every rule with a shape to it — UTC inclusive-day dates, the sparse-rank
 * encoding, membership refusals, the count-each-leaf-once rollup, the derived
 * state — is a pure function in `milestones.ts` and is pinned there. What lives
 * here is the SQL around those functions, the events, and the CAS: each
 * membership mutation bumps the milestone's own `members_revision`, and a
 * caller that passes a stale `baseRevision` is refused with `revision_conflict`
 * and the order stands.
 *
 * One shape everywhere. `get`, every mutation, and every surface (CLI `--json`,
 * MCP, HTTP) return the same `MilestoneView`, so the Milestones page (R3c) and
 * the queue (R3d) consume one structure. `planPosition` and `next` are the
 * QUEUE's two fields on it and R3d (STA-174) fills them from
 * `store.queue()`: the milestone's own row in the plan, and the first eligible
 * effective row that reports it in its `milestonePath`. The traffic runs both
 * ways and does not loop — `queueSeam()` is the one thing the resolver reads
 * here, and it builds no view.
 */
import type { DatabaseSync } from "node:sqlite";
import { insertEvent } from "./event-log.js";
import type { Journal } from "./journal.js";
import { parseIdentifier } from "./ids.js";
import {
  MILESTONE_KIND,
  type MilestoneProgress,
  type MilestoneState,
  type ProgressNode,
  assertMembershipAllowed,
  assertMilestoneDates,
  assertMilestoneKindConfigured,
  milestoneProgress,
  milestoneState,
  parseMilestoneDate,
  rankBetween,
  renumberedRanks,
} from "./milestones.js";
import {
  CRITERION_VERDICTS,
  type CriterionMark,
  type CriterionVerdict,
  criterionMarkField,
  criterionMarkValue,
  type EvidenceItem,
  type GoalCounts,
  type GoalCriterion,
  type GoalPace,
  type MemberPlan,
  goalCounts,
  goalPace,
  isGoalMet,
  judgeCriterion,
  parseEvidence,
} from "./milestone-goal.js";
import { COMPARE_MAX_REFS } from "./plan-rollup.js";
import { writeCriterionMark } from "./milestone-marks.js";
import type { WorkspaceStore } from "./store.js";
import { type Issue, MAX_TREE_DEPTH, StapleError, type StatusCategory, nowIso } from "./types.js";

/** The milestone half of the view: the issue fields a plan needs plus its own metadata. */
export interface MilestoneSummary {
  /** The milestone's issue id: what a write names it by, whatever number it holds. */
  id: string;
  identifier: string;
  title: string;
  status: string;
  kind: string;
  assignee: string | null;
  /** The issue's own description: what the milestone is for. */
  description: string | null;
  /** The issue's own acceptance criteria: the milestone's goal (docs/milestones.md "Goal"). Empty when none. */
  acceptanceCriteria: string[];
  targetDate: string | null;
  startDate: string | null;
  /** Derived on every read; never stored. */
  state: MilestoneState;
  /** The milestone's own row in the pickup plan; null when it is not queued. */
  planPosition: number | null;
}

/** One ordered member, as every surface prints it. */
export interface MilestoneMemberRow {
  /** The member's issue id: what a write names it by, whatever number it holds. */
  issueId: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  /** 1-based, in rank order. */
  position: number;
  /** The sparse encoding behind `position`; an implementation detail nobody types. */
  rank: number;
  /** The member's real parent, untouched by membership. */
  parent: string | null;
  /** The nearest ancestor that is ALSO a direct member here, so a view can indent. */
  nestedUnder: string | null;
  addedBy: string;
  addedAt: string;
  note: string | null;
}

export interface MilestoneView {
  milestone: MilestoneSummary;
  progress: MilestoneProgress;
  /** The `members_revision` CAS base. */
  revision: number;
  members: MilestoneMemberRow[];
  /**
   * The first `eligible` row of the effective queue that reports this milestone
   * in its `milestonePath` — the real next work under this plan, in the position
   * an agent sees it at. Null when nothing under the milestone is takeable.
   */
  next: { identifier: string; position: number } | null;
  /** The goal check: each criterion's verdict with its evidence, and the pace against the target date. */
  goal: MilestoneGoal;
}

/** The milestone's goal as a check reads it now (`milestone-goal.ts`). */
export interface MilestoneGoal {
  criteria: GoalCriterion[];
  counts: GoalCounts;
  /** Every criterion met; true when the milestone has none. */
  met: boolean;
  pace: GoalPace;
}

/** Just the criteria half of {@link MilestoneGoal}: what the run's stop rules read. */
export type MilestoneCriteriaCheck = Omit<MilestoneGoal, "pace">;

/** `milestone criterion`: one criterion judged. */
export interface MarkCriterionInput {
  verdict: CriterionVerdict;
  /** An issue reference, `<ref>:<document key>`, or free text; a `met` mark needs at least one. */
  evidence?: readonly string[];
  note?: string | null;
  /**
   * A follow-up ticket for an `unmet` criterion. Created by the marker's live goal run over
   * this milestone (or `run`), attributed to it, made a member, and counted against its cap.
   */
  followUp?: { title: string; description?: string | null } | null;
  /** The goal run the mark and its follow-up belong to; else the marker's live run over this milestone. */
  run?: string | null;
}

/**
 * The whole milestone side of the pickup queue, in two queries (R3d, STA-174).
 *
 * The resolver needs three facts and needs them for the WHOLE workspace at once:
 * what a queued milestone expands to, the date those rows inherit, and which
 * milestone any given issue belongs to. It deliberately does NOT read
 * `MilestoneView` for them — the view is what the resolver FILLS (`planPosition`
 * and `next`), so building it from the resolver would recur — and it deliberately
 * does not ask per milestone, because a resolver call would then cost one query
 * per plan row.
 */
export interface MilestoneQueueSeam {
  /** Milestone issue id → its DIRECT members' issue ids, in rank order. */
  membersOf: ReadonlyMap<string, readonly string[]>;
  /** Milestone issue id → its target date: the `dueAt` every row it reaches inherits. */
  targetDateOf: ReadonlyMap<string, string | null>;
  /** Issue id → the milestone it is a direct member of; the input to `nearestMilestone`. */
  milestoneOf: ReadonlyMap<string, string>;
}

/**
 * The queue's answer, read ONCE and shared by every view a `list` builds: the
 * plan positions of the milestones in it, and each milestone's next eligible row.
 */
interface QueueFacts {
  /** Milestone issue id → its 1-based row in the plan; absent when it is not queued. */
  planPositionOf: ReadonlyMap<string, number>;
  /** Milestone identifier → the first eligible effective row that names it. */
  nextOf: ReadonlyMap<string, { identifier: string; position: number }>;
}

/**
 * Which milestone an issue belongs to, for a detail view: its own direct membership,
 * else the nearest ancestor's. `via` names that ancestor, so a view can say why an
 * issue that was never added still counts toward the plan; null for a direct member.
 */
export interface EffectiveMilestone {
  id: string;
  identifier: string;
  title: string;
  status: string;
  targetDate: string | null;
  via: { identifier: string; title: string } | null;
}

/** A `milestone ls` row: the view without its members, plus how many there are. */
export type MilestoneListRow = Omit<MilestoneView, "members" | "goal"> & { memberCount: number };

/** Where a member goes: before/after another member, at a 1-based position, or (none) appended. */
export interface MemberPosition {
  before?: string;
  after?: string;
  at?: number;
}

export interface MilestoneDatePatch {
  targetDate?: string | null;
  startDate?: string | null;
  /** The issue's description; null clears it. */
  description?: string | null;
  /** The issue's acceptance criteria, whole; an empty list clears them. */
  acceptanceCriteria?: string[];
}

export interface CreateMilestoneInput {
  /** Defaults to the epic's title when `fromEpic` is given. */
  title?: string;
  description?: string | null;
  /** The milestone's goal: its acceptance criteria. */
  acceptanceCriteria?: string[];
  targetDate?: string | null;
  startDate?: string | null;
  /** The epic that becomes the one member; its children come along by descent. */
  fromEpic?: string | null;
}

/** What `--preview` returns: the exact plan, and the promise that nothing is re-parented. */
export interface MilestoneCreatePreview {
  preview: true;
  milestone: { title: string; targetDate: string | null; startDate: string | null };
  members: Array<{ identifier: string; position: number }>;
  /** Always empty — returned anyway so the promise is visible rather than inferred. */
  hierarchyChanges: never[];
}

export type MilestoneCreateResult = MilestoneView & { preview: false; hierarchyChanges: never[] };

interface MetaRow {
  issue_id: string;
  target_date: string | null;
  start_date: string | null;
  members_revision: number;
  updated_at: string;
}

interface MemberRow {
  issue_id: string;
  milestone_id: string;
  rank: number;
  added_by: string;
  added_at: string;
  note: string | null;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  parent_id: string | null;
}

interface TreeRow {
  id: string;
  parent_id: string | null;
  status: string;
}

const META_COLUMNS = "issue_id, target_date, start_date, members_revision, updated_at";
const MEMBER_SELECT = `SELECT m.issue_id, m.milestone_id, m.rank, m.added_by, m.added_at, m.note,
                              i.identifier, i.title, i.kind, i.status, i.parent_id
                         FROM milestone_members m JOIN issues i ON i.id = m.issue_id`;

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

/** Criteria as `staple new --criteria` leaves them: trimmed, blanks dropped. */
function cleanCriteria(criteria: readonly string[]): string[] {
  return criteria.map((criterion) => criterion.trim()).filter(Boolean);
}

function hasPosition(position: MemberPosition): boolean {
  return position.before !== undefined || position.after !== undefined || position.at !== undefined;
}

/**
 * Refuse re-declaring a milestone as something else while it still owns
 * members or dates: an issue that is not a milestone cannot own them. Called
 * from `updateIssue` on a kind change; the reverse direction is always allowed
 * (the metadata row appears on first write).
 */
export function assertRekindAllowed(
  db: DatabaseSync,
  row: { id: string; identifier: string; kind: string },
  nextKind: string,
): void {
  if (row.kind !== MILESTONE_KIND || nextKind === MILESTONE_KIND) return;
  const members = (
    db.prepare("SELECT COUNT(*) AS n FROM milestone_members WHERE milestone_id = ?").get(row.id) as { n: number }
  ).n;
  const meta = db
    .prepare("SELECT target_date, start_date FROM milestone_meta WHERE issue_id = ?")
    .get(row.id) as Pick<MetaRow, "target_date" | "start_date"> | undefined;
  const dated = meta !== undefined && (meta.target_date !== null || meta.start_date !== null);
  if (members === 0 && !dated) return;
  throw new StapleError(
    "validation",
    `${row.identifier} is a milestone with ${members} member${members === 1 ? "" : "s"}${dated ? " and dates" : ""}; ` +
      `remove them (\`staple milestone rm\`) and clear its dates before re-declaring it as ${article(nextKind)} ${nextKind}.`,
    { identifier: row.identifier, members, dated },
  );
}

export class MilestoneStore {
  constructor(private readonly store: WorkspaceStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  /** The connection's one journal seam. Shared with every other store. */
  private get journal(): Journal {
    return this.store.journal;
  }

  /** One logical mutation: one transaction, one journal scope. Re-entrant. */
  private journaled<T>(fn: () => T): T {
    return this.store.journaled(fn);
  }

  // ---------- guards ----------

  private assertKindConfigured(): void {
    assertMilestoneKindConfigured(this.store.getKinds().map((kind) => kind.id));
  }

  /** A foreign identifier is refused by name, before any lookup could say `not_found`. */
  private assertLocalRef(ref: string): void {
    const parsed = parseIdentifier(ref);
    if (parsed && parsed.prefix !== this.store.prefix) {
      throw new StapleError(
        "validation",
        `${ref.trim().toUpperCase()} belongs to workspace prefix ${parsed.prefix}, not ${this.store.slug} (${this.store.prefix}); milestones cannot span workspaces.`,
        { identifier: ref.trim().toUpperCase(), prefix: parsed.prefix, workspace: this.store.slug },
      );
    }
  }

  /**
   * An issue a milestone call names. For a write — the milestone, a member, a neighbour, the
   * epic it is made from — refused through a number this device's issue moved off while that
   * one may be meant (`WorkspaceStore.writeTarget`); a read is answered with the notice.
   */
  private requireIssue(ref: string, forWrite = true): Issue {
    this.assertLocalRef(ref);
    return forWrite ? this.store.writeTarget(ref) : this.store.getIssue(ref);
  }

  private requireMilestone(ref: string, forWrite = true): Issue {
    const issue = this.requireIssue(ref, forWrite);
    if (issue.kind !== MILESTONE_KIND) {
      throw new StapleError(
        "validation",
        `${issue.identifier} is ${article(issue.kind)} ${issue.kind}, not a milestone.`,
        { identifier: issue.identifier, kind: issue.kind },
      );
    }
    return issue;
  }

  // ---------- meta + revision ----------

  private meta(id: string): MetaRow | undefined {
    return this.db.prepare(`SELECT ${META_COLUMNS} FROM milestone_meta WHERE issue_id = ?`).get(id) as
      | MetaRow
      | undefined;
  }

  /** The row is lazy: it appears on the first write, so a dateless, memberless milestone is just an issue. */
  private ensureMeta(id: string, now: string): void {
    this.db.prepare("INSERT OR IGNORE INTO milestone_meta (issue_id, updated_at) VALUES (?, ?)").run(id, now);
  }

  private revisionOf(id: string): number {
    return this.meta(id)?.members_revision ?? 0;
  }

  private bumpRevision(id: string, now: string): number {
    this.ensureMeta(id, now);
    const row = this.db
      .prepare(
        `UPDATE milestone_meta SET members_revision = members_revision + 1, updated_at = ?
          WHERE issue_id = ? RETURNING members_revision`,
      )
      .get(now, id) as { members_revision: number };
    return row.members_revision;
  }

  /** The CAS. Absent base = write blind (the CLI's default); present and stale = refused, order untouched. */
  private assertBase(milestone: Issue, base: number | undefined): void {
    if (base === undefined) return;
    const current = this.revisionOf(milestone.id);
    if (current !== base) {
      throw new StapleError(
        "revision_conflict",
        `${milestone.identifier} members are at revision ${current}, not ${base}. Re-read the milestone and retry.`,
        { currentRevision: current },
      );
    }
  }

  // ---------- members ----------

  private memberRows(milestoneId: string): MemberRow[] {
    return this.db
      .prepare(`${MEMBER_SELECT} WHERE m.milestone_id = ? ORDER BY m.rank`)
      .all(milestoneId) as unknown as MemberRow[];
  }

  private membershipOf(issueId: string): MemberRow | undefined {
    return this.db.prepare(`${MEMBER_SELECT} WHERE m.issue_id = ?`).get(issueId) as unknown as
      | MemberRow
      | undefined;
  }

  private positionOf(milestoneId: string, issueId: string): number {
    return this.memberRows(milestoneId).findIndex((row) => row.issue_id === issueId) + 1;
  }

  /**
   * Clean ranks for the rows in their current order. Two passes because
   * `UNIQUE (milestone_id, rank)` is checked per statement: writing `1024` onto
   * row one while row two still holds `1024` would collide, so every row first
   * takes a negative placeholder nothing else can hold.
   */
  private renumber(milestoneId: string, orderedIssueIds: readonly string[]): void {
    const ranks = renumberedRanks(orderedIssueIds.length);
    const write = this.db.prepare("UPDATE milestone_members SET rank = ? WHERE milestone_id = ? AND issue_id = ?");
    orderedIssueIds.forEach((issueId, index) => write.run(-(index + 1), milestoneId, issueId));
    orderedIssueIds.forEach((issueId, index) => write.run(ranks[index]!, milestoneId, issueId));
  }

  /** The 0-based insertion index `position` names among `rows`, or the end. */
  private slotIndex(milestone: Issue, rows: readonly MemberRow[], position: MemberPosition): number {
    const indexOf = (ref: string): number => {
      const target = this.requireIssue(ref);
      const index = rows.findIndex((row) => row.issue_id === target.id);
      if (index < 0) {
        throw new StapleError("not_found", `${target.identifier} is not a member of ${milestone.identifier}.`, {
          identifier: target.identifier,
          milestone: milestone.identifier,
        });
      }
      return index;
    };
    if (position.before !== undefined) return indexOf(position.before);
    if (position.after !== undefined) return indexOf(position.after) + 1;
    if (position.at !== undefined) {
      if (!Number.isInteger(position.at) || position.at < 1) {
        throw new StapleError("validation", `--at is a 1-based position; got ${position.at}.`);
      }
      return Math.min(position.at - 1, rows.length);
    }
    return rows.length;
  }

  /**
   * The rank for a row slotted at `position`, renumbering the milestone first
   * when the gap there is exhausted. Runs inside the caller's transaction, and
   * the row being placed must not be in the table (a move deletes first).
   */
  private rankFor(milestone: Issue, position: MemberPosition): number {
    const rows = this.memberRows(milestone.id);
    const index = this.slotIndex(milestone, rows, position);
    const rank = rankBetween(rows[index - 1]?.rank ?? null, rows[index]?.rank ?? null);
    if (rank !== null) return rank;
    this.renumber(
      milestone.id,
      rows.map((row) => row.issue_id),
    );
    const clean = renumberedRanks(rows.length);
    return rankBetween(clean[index - 1] ?? null, clean[index] ?? null)!;
  }

  private insertMember(
    milestoneId: string,
    issueId: string,
    rank: number,
    by: { addedBy: string; addedAt: string; note: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO milestone_members (issue_id, milestone_id, rank, added_by, added_at, note)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(issueId, milestoneId, rank, by.addedBy, by.addedAt, by.note);
  }

  private deleteMember(issueId: string): void {
    this.db.prepare("DELETE FROM milestone_members WHERE issue_id = ?").run(issueId);
  }

  // ---------- events ----------

  /**
   * One of the four emitters, now delegating to the single writer.
   *
   * None of these is level-triggered, so no explicit dedup key is supplied and
   * `insertEvent` derives one from the enclosing mutation. It used to hardcode
   * `NULL`, which left an at-least-once transport one retry away from a
   * duplicated timeline.
   */
  private emit(kind: string, issueId: string, actor: string | null, payload: Record<string, unknown>): void {
    insertEvent(this.db, { kind, issueId, actor, payload });
  }

  // ---------- journal ----------

  /**
   * Declare a membership change as a whole-order `replace`, on the milestone.
   *
   * Not one operation per member, and the reason is in the schema.
   * `milestone_members` has `UNIQUE (milestone_id, rank)` over dense-ish
   * integers assigned by `renumberedRanks`, so two devices each inserting a
   * member offline produce rows that collide on arrival — a per-member `create`
   * would replicate a constraint violation. Sending the resulting ORDER instead
   * makes the merge a list merge, which is a problem with answers, rather than a
   * unique-index conflict, which is not.
   *
   * It also collapses the four membership mutators into one shape: add, remove,
   * move and reorder all end with "this milestone's members are now these, in
   * this order", which is exactly what a receiver needs and all it needs.
   */
  private recordMembership(milestoneId: string, actor: string | null): void {
    const rows = this.db
      .prepare("SELECT issue_id, added_by, added_at, note FROM milestone_members WHERE milestone_id = ? ORDER BY rank")
      .all(milestoneId) as Array<{ issue_id: string; added_by: string; added_at: string; note: string | null }>;
    this.journal.record({
      entity: "milestone",
      entityId: milestoneId,
      verb: "replace",
      // Who added each member, when, and its note ride beside the order; see `recordPlan`.
      payload: {
        members: rows.map((row) => row.issue_id),
        entries: Object.fromEntries(
          rows.map((row) => [row.issue_id, { addedBy: row.added_by, addedAt: row.added_at, note: row.note }]),
        ),
      },
      actor,
    });
  }

  // ---------- reads ----------

  /** The parent chain of `id`, nearest first, bounded like every other walk. */
  private ancestorIds(id: string): string[] {
    const out: string[] = [];
    let current = id;
    for (let depth = 0; depth < MAX_TREE_DEPTH; depth += 1) {
      const row = this.db.prepare("SELECT parent_id FROM issues WHERE id = ?").get(current) as
        | { parent_id: string | null }
        | undefined;
      if (!row || row.parent_id === null || out.includes(row.parent_id)) break;
      out.push(row.parent_id);
      current = row.parent_id;
    }
    return out;
  }

  /** Every descendant of `rootId`, at any depth, as progress nodes. */
  private descendants(rootId: string): ProgressNode[] {
    const out: ProgressNode[] = [];
    let frontier = [rootId];
    const seen = new Set<string>([rootId]);
    for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth += 1) {
      const rows = this.db
        .prepare(`SELECT id, parent_id, status FROM issues WHERE parent_id IN (${frontier.map(() => "?").join(",")})`)
        .all(...(frontier as never[])) as unknown as TreeRow[];
      frontier = [];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push({ id: row.id, parentId: row.parent_id, category: this.category(row.status) });
        frontier.push(row.id);
      }
    }
    return out;
  }

  /** Categories come from the configured statuses at read time, never from the ids. */
  private category(status: string): StatusCategory {
    return this.store.categoryOf(status) ?? "unstarted";
  }

  /**
   * Everything the queue resolver needs from milestones, for the whole
   * workspace, in two queries — see `MilestoneQueueSeam`. This is the ONLY
   * method the resolver calls here.
   */
  queueSeam(): MilestoneQueueSeam {
    const rows = this.db
      .prepare("SELECT milestone_id, issue_id FROM milestone_members ORDER BY milestone_id, rank")
      .all() as Array<{ milestone_id: string; issue_id: string }>;
    const membersOf = new Map<string, string[]>();
    const milestoneOf = new Map<string, string>();
    for (const row of rows) {
      const members = membersOf.get(row.milestone_id) ?? [];
      members.push(row.issue_id);
      membersOf.set(row.milestone_id, members);
      milestoneOf.set(row.issue_id, row.milestone_id);
    }
    const dates = this.db.prepare("SELECT issue_id, target_date FROM milestone_meta").all() as Array<{
      issue_id: string;
      target_date: string | null;
    }>;
    return {
      membersOf,
      targetDateOf: new Map(dates.map((row) => [row.issue_id, row.target_date])),
      milestoneOf,
    };
  }

  /**
   * The queue's half of the view (R3d). One `queue().view()` read answers both
   * numbers for every milestone at once, which is why `list` builds it once and
   * hands it to each row rather than resolving the queue per milestone.
   */
  private queueFacts(): QueueFacts {
    const view = this.store.queue().view({ all: true });
    const nextOf = new Map<string, { identifier: string; position: number }>();
    for (const row of view.effective) {
      if (row.eligibility !== "eligible") continue;
      for (const milestone of row.milestonePath) {
        if (!nextOf.has(milestone)) nextOf.set(milestone, { identifier: row.identifier, position: row.position });
      }
    }
    return {
      planPositionOf: new Map(view.entries.map((entry) => [entry.issueId, entry.planPosition])),
      nextOf,
    };
  }

  private view(id: string, facts: QueueFacts = this.queueFacts()): MilestoneView {
    const base = this.baseView(id, facts);
    return { ...base, goal: this.goalOf(id, base) };
  }

  /** The view without its goal: what `list` returns per row, and what the goal's pace reads. */
  private baseView(id: string, facts: QueueFacts): Omit<MilestoneView, "goal"> {
    const issue = this.store.getIssue(id);
    const meta = this.meta(id);
    const rows = this.memberRows(id);
    const memberIds = new Set(rows.map((row) => row.issue_id));
    const identifierOf = new Map(rows.map((row) => [row.issue_id, row.identifier]));

    const members: MilestoneMemberRow[] = rows.map((row, index) => {
      const nestedUnder = this.ancestorIds(row.issue_id).find((ancestor) => memberIds.has(ancestor)) ?? null;
      const parent =
        row.parent_id === null
          ? null
          : ((this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(row.parent_id) as
              | { identifier: string }
              | undefined)?.identifier ?? null);
      return {
        issueId: row.issue_id,
        identifier: row.identifier,
        title: row.title,
        kind: row.kind,
        status: row.status,
        position: index + 1,
        rank: row.rank,
        parent,
        nestedUnder: nestedUnder === null ? null : (identifierOf.get(nestedUnder) ?? null),
        addedBy: row.added_by,
        addedAt: row.added_at,
        note: row.note,
      };
    });

    const nodes: ProgressNode[] = rows.map((row) => ({
      id: row.issue_id,
      parentId: row.parent_id,
      category: this.category(row.status),
    }));
    const descendantsByMember = new Map(rows.map((row) => [row.issue_id, this.descendants(row.issue_id)]));
    const progress = milestoneProgress(nodes, descendantsByMember);

    const targetDate = meta?.target_date ?? null;
    const startDate = meta?.start_date ?? null;
    return {
      milestone: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        kind: issue.kind,
        assignee: issue.assignee,
        description: issue.description,
        acceptanceCriteria: issue.acceptanceCriteria ?? [],
        targetDate,
        startDate,
        state: milestoneState({ category: this.category(issue.status), targetDate, startDate }, progress, nowIso()),
        planPosition: facts.planPositionOf.get(id) ?? null,
      },
      progress,
      revision: meta?.members_revision ?? 0,
      members,
      next: facts.nextOf.get(issue.identifier) ?? null,
    };
  }

  /** One milestone, one shape. `validation` for a non-milestone, `not_found` for nothing. */
  get(ref: string): MilestoneView {
    this.assertKindConfigured();
    return this.view(this.requireMilestone(ref, false).id);
  }

  /**
   * Every milestone, open ones unless `all`, sorted by plan position (null last —
   * an unqueued milestone follows every queued one), then target date (null
   * last), then identifier.
   */
  list(options: { all?: boolean } = {}): MilestoneListRow[] {
    this.assertKindConfigured();
    const rows = this.db
      .prepare("SELECT id, status FROM issues WHERE kind = ?")
      .all(MILESTONE_KIND) as Array<{ id: string; status: string }>;
    // One resolver read for the whole list, not one per milestone.
    const facts = this.queueFacts();
    const views = rows
      .filter((row) => options.all === true || !this.store.isResolvedStatus(row.status))
      .map((row) => {
        const { members, ...rest } = this.baseView(row.id, facts);
        return { ...rest, memberCount: members.length };
      });
    const nullsLast = (a: number | string | null, b: number | string | null): number => {
      if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1;
      return a < b ? -1 : a > b ? 1 : 0;
    };
    const number = (identifier: string): number => parseIdentifier(identifier)?.number ?? 0;
    return views.sort(
      (a, b) =>
        nullsLast(a.milestone.planPosition, b.milestone.planPosition) ||
        nullsLast(a.milestone.targetDate, b.milestone.targetDate) ||
        number(a.milestone.identifier) - number(b.milestone.identifier),
    );
  }

  /** `milestoneOf` with the names a detail view prints; see `EffectiveMilestone`. */
  effectiveMilestone(ref: string): EffectiveMilestone | null {
    const issue = this.requireIssue(ref, false);
    const titled = (id: string) =>
      this.db.prepare("SELECT identifier, title FROM issues WHERE id = ?").get(id) as {
        identifier: string;
        title: string;
      };
    for (const id of [issue.id, ...this.ancestorIds(issue.id)]) {
      const membership = this.membershipOf(id);
      if (!membership) continue;
      const milestone = this.store.getIssue(membership.milestone_id);
      return {
        id: membership.milestone_id,
        identifier: milestone.identifier,
        title: milestone.title,
        status: milestone.status,
        targetDate: this.meta(membership.milestone_id)?.target_date ?? null,
        via: id === issue.id ? null : titled(id),
      };
    }
    return null;
  }

  /** The effective milestone of an issue: its own direct membership, else the nearest ancestor's. */
  milestoneOf(ref: string): string | null {
    const issue = this.requireIssue(ref, false);
    for (const id of [issue.id, ...this.ancestorIds(issue.id)]) {
      const membership = this.membershipOf(id);
      if (membership) {
        return (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(membership.milestone_id) as {
          identifier: string;
        }).identifier;
      }
    }
    return null;
  }

  // ---------- goal (milestone-goal.ts) ----------

  private marksOf(milestoneId: string): Map<number, CriterionMark> {
    const rows = this.db
      .prepare("SELECT * FROM milestone_criterion_marks WHERE milestone_id = ? ORDER BY position")
      .all(milestoneId) as Array<{
      position: number;
      criterion: string;
      verdict: string;
      evidence: string;
      note: string | null;
      marked_by: string;
      run_id: string | null;
      marked_at: string;
    }>;
    return new Map(
      rows.map((row) => [
        row.position,
        {
          position: row.position,
          criterion: row.criterion,
          verdict: row.verdict as CriterionVerdict,
          evidence: JSON.parse(row.evidence) as string[],
          note: row.note,
          markedBy: row.marked_by,
          runId: row.run_id,
          markedAt: row.marked_at,
        },
      ]),
    );
  }

  /** The issue a ticket or document evidence names, in this workspace; null when there is none. */
  private evidenceIssue(ref: string): { id: string; identifier: string; status: string } | null {
    const parsed = parseIdentifier(ref);
    if (parsed === null || parsed.prefix !== this.store.prefix) return null;
    return (
      (this.db.prepare("SELECT id, identifier, status FROM issues WHERE identifier = ?").get(ref) as
        | { id: string; identifier: string; status: string }
        | undefined) ?? null
    );
  }

  /**
   * Whether one piece of evidence holds: a ticket while it is done, a document while it
   * exists. `markedAt` is when it was cited, for `lapsed`.
   */
  private evidenceItem(value: string, markedAt: string): EvidenceItem {
    const parsed = parseEvidence(value);
    if (parsed.kind === "text") return { ...parsed, status: null, holds: true, problem: null, lapsed: false };
    const issue = this.evidenceIssue(parsed.ref!);
    // A mark cites only what exists, so a cited issue that is gone was there and has lapsed.
    if (issue === null) return { ...parsed, status: null, holds: false, problem: `${parsed.ref} is not an issue in this workspace`, lapsed: true };
    if (parsed.kind === "document") {
      const exists = this.db
        .prepare("SELECT 1 AS hit FROM documents WHERE issue_id = ? AND key = ?")
        .get(issue.id, parsed.document!.toLowerCase());
      return exists
        ? { ...parsed, ref: issue.identifier, status: issue.status, holds: true, problem: null, lapsed: false }
        : { ...parsed, ref: issue.identifier, status: issue.status, holds: false, problem: `${issue.identifier} has no document "${parsed.document}"`, lapsed: true };
    }
    const done = this.store.categoryOf(issue.status) === "done";
    return {
      ...parsed,
      ref: issue.identifier,
      status: issue.status,
      holds: done,
      problem: done ? null : `${issue.identifier} is ${issue.status}, not done`,
      lapsed: !done && this.leftDoneSince(issue.id, markedAt),
    };
  }

  /**
   * Whether a ticket that is not done now was done at some point since `since`: it then left
   * done after that instant, and every status change writes a `status_changed` event naming
   * the status it left. A change in the very millisecond of the mark, and a device without
   * the event (history it never received), read false: the cautious "does not hold yet".
   */
  private leftDoneSince(issueId: string, since: string): boolean {
    const rows = this.db
      .prepare("SELECT payload FROM events WHERE issue_id = ? AND kind = 'status_changed' AND created_at > ?")
      .all(issueId, since) as Array<{ payload: string }>;
    return rows.some((row) => {
      const from = (JSON.parse(row.payload) as { from?: unknown }).from;
      return typeof from === "string" && this.store.categoryOf(from) === "done";
    });
  }

  /**
   * Each criterion of the milestone as a check reads it now: the stop rules of a goal run
   * read this (`run-store.ts`), and it is the criteria half of every view's `goal`.
   */
  criteriaCheck(ref: string): MilestoneCriteriaCheck {
    this.assertKindConfigured();
    const issue = this.requireMilestone(ref, false);
    const marks = this.marksOf(issue.id);
    const criteria = (issue.acceptanceCriteria ?? []).map((text, index) => {
      const mark = marks.get(index + 1) ?? null;
      return judgeCriterion(index + 1, text, mark, (mark?.evidence ?? []).map((value) => this.evidenceItem(value, mark!.markedAt)));
    });
    const counts = goalCounts(criteria);
    return { criteria, counts, met: isGoalMet(counts) };
  }

  /**
   * Pace against the target date, from the certified plans `compare` reads: one per member
   * that is not nested under another member (a nested one is inside that member's plan).
   */
  private paceOf(view: Omit<MilestoneView, "goal">): GoalPace {
    const top = view.members.filter((member) => member.nestedUnder === null);
    const plans: MemberPlan[] = [];
    for (let index = 0; index < top.length; index += COMPARE_MAX_REFS) {
      const chunk = top.slice(index, index + COMPARE_MAX_REFS).map((member) => member.issueId);
      for (const plan of this.store.comparePlans(chunk).plans) {
        plans.push({
          ref: plan.ref,
          resolved: this.store.isResolvedStatus(plan.status),
          laborSeconds: plan.labor.seconds,
          remainingSeconds: plan.remainingPath.seconds,
          partial: plan.coverage.partial || plan.remainingPath.partial,
          unplannedRefs: plan.coverage.unplannedRefs,
        });
      }
    }
    return goalPace({ targetDate: view.milestone.targetDate, now: nowIso(), progress: view.progress, plans });
  }

  private goalOf(id: string, view: Omit<MilestoneView, "goal">): MilestoneGoal {
    return { ...this.criteriaCheck(id), pace: this.paceOf(view) };
  }

  /**
   * Judge one criterion (`milestone criterion`): a verdict, the evidence it rests on, and for
   * an unmet one optionally a follow-up ticket. The tracker records the judgement and decides
   * what it is still worth at each check (`judgeCriterion`); it never judges the criterion
   * itself. A `met` mark needs evidence. A ticket or document cited must exist in this
   * workspace; a ticket that is not done yet may be cited, and the criterion reads `unknown`
   * until it is.
   *
   * A mark replicates, as the milestone field `criterion<n>`; two devices judging the same
   * criterion concurrently are a field conflict, preserved until someone picks a side. A
   * follow-up is an ordinary issue and membership, created by the goal run
   * (`RunStore.createGoalChild`), which enforces the run's cap. The run stays machine-local.
   */
  markCriterion(ref: string, position: number, input: MarkCriterionInput, actor: string | null): MilestoneView {
    this.assertKindConfigured();
    if (!(CRITERION_VERDICTS as readonly string[]).includes(input.verdict)) {
      throw new StapleError("validation", `A criterion's verdict is met, unmet or unknown; got "${String(input.verdict)}".`);
    }
    const milestone = this.requireMilestone(ref);
    const criteria = milestone.acceptanceCriteria ?? [];
    if (criteria.length === 0) {
      throw new StapleError(
        "validation",
        `${milestone.identifier} has no acceptance criteria to judge; give it some with \`staple milestone set ${milestone.identifier} --criteria "a;b"\`.`,
        { identifier: milestone.identifier },
      );
    }
    if (!Number.isInteger(position) || position < 1 || position > criteria.length) {
      throw new StapleError("validation", `${milestone.identifier} has criteria 1 to ${criteria.length}; got ${position}.`, {
        identifier: milestone.identifier,
        criteria: criteria.length,
      });
    }
    const evidence = (input.evidence ?? []).map((value) => value.trim()).filter(Boolean);
    for (const value of evidence) {
      const parsed = parseEvidence(value);
      if (parsed.kind === "text") continue;
      this.assertLocalRef(parsed.ref!);
      const issue = this.evidenceIssue(parsed.ref!);
      if (issue === null) throw new StapleError("not_found", `Evidence ${value}: ${parsed.ref} is not an issue in this workspace.`, { evidence: value });
      if (parsed.kind === "document" && !this.db.prepare("SELECT 1 AS hit FROM documents WHERE issue_id = ? AND key = ?").get(issue.id, parsed.document!.toLowerCase())) {
        throw new StapleError("not_found", `Evidence ${value}: ${issue.identifier} has no document "${parsed.document}".`, { evidence: value });
      }
    }
    const followUp = input.followUp ?? null;
    if (followUp !== null && input.verdict !== "unmet") {
      throw new StapleError("validation", "A follow-up ticket is for an unmet criterion; mark it unmet.");
    }
    if (input.verdict === "met" && evidence.length === 0) {
      throw new StapleError(
        "validation",
        `A met criterion needs evidence: --evidence <ticket, ticket:document, or text> (${milestone.identifier} criterion ${position}).`,
      );
    }
    const text = criteria[position - 1]!;
    return this.journaled(() => {
      const runs = this.store.runs();
      const run = input.run != null ? runs.get(input.run) : actor === null ? null : runs.liveGoalRunOf(actor, milestone.id);
      if (run !== null && (run.scope.kind !== "milestone" || run.scope.issueId !== milestone.id)) {
        throw new StapleError("validation", `Run ${run.id} is not a goal run over ${milestone.identifier}.`, { runId: run.id });
      }
      if (followUp !== null) {
        if (run === null) {
          throw new StapleError(
            "validation",
            `A follow-up is created by a goal run over ${milestone.identifier}, and ${actor ?? "you"} has none live; file it with \`staple new\` and \`staple milestone add\`.`,
            { identifier: milestone.identifier },
          );
        }
        const child = runs.createGoalChild(run.id, "follow_up", {
          title: followUp.title,
          description: followUp.description ?? null,
          criterion: { position, text },
        });
        evidence.push(child.identifier);
      }
      const mark = criterionMarkValue({
        criterion: text,
        verdict: input.verdict,
        evidence,
        note: input.note?.trim() ? input.note.trim() : null,
        markedBy: actor ?? "user",
        runId: run?.id ?? null,
        markedAt: this.journal.mutationAt(),
      });
      writeCriterionMark(this.db, milestone.id, position, mark);
      // A mark is a change to the milestone, and says when, as a date edit does: the row diff
      // carries `updatedAt` with it, so a device hydrating from the log holds the same time.
      this.ensureMeta(milestone.id, mark.markedAt);
      this.db.prepare("UPDATE milestone_meta SET updated_at = ? WHERE issue_id = ?").run(mark.markedAt, milestone.id);
      /**
       * The mark replicates as one field of the milestone (`criterion<n>`, see
       * `criterionMarkField`): a field of an entity the protocol already carries, so no new
       * entity and no protocol change. The run it names is this machine's; the id travels as
       * a label and is never looked up elsewhere.
       */
      this.journal.record({
        entity: "milestone",
        entityId: milestone.id,
        verb: "update",
        payload: { [criterionMarkField(position)]: mark },
        actor: actor ?? null,
      });
      // The event names no issue: it is this device's note of the judgement, never transported.
      insertEvent(this.db, {
        kind: "milestone_criterion_marked",
        issueId: null,
        actor,
        payload: { milestone: milestone.identifier, position, criterion: text, verdict: input.verdict, evidence, runId: run?.id ?? null },
      });
      return this.view(milestone.id);
    });
  }

  // ---------- writes ----------

  /** `set`: the two dates, and the goal (description, criteria) kept on the issue itself. */
  update(ref: string, patch: MilestoneDatePatch, actor: string | null): MilestoneView {
    this.assertKindConfigured();
    const goalPatch = patch.description !== undefined || patch.acceptanceCriteria !== undefined;
    if (patch.targetDate === undefined && patch.startDate === undefined && !goalPatch) {
      throw new StapleError(
        "validation",
        "update requires targetDate, startDate (null clears one), description (null clears it) or acceptanceCriteria (empty clears them).",
      );
    }
    const milestone = this.requireMilestone(ref);
    return this.journaled(() => {
      /**
       * The goal lives on the issue: description and criteria are the issue's own fields,
       * edited through `updateIssue` so they journal and replicate as any issue edit does.
       * Criteria are trimmed and emptied of blanks, as `staple new --criteria` splits them.
       */
      if (goalPatch) {
        this.store.updateIssue(
          milestone.id,
          {
            ...(patch.description !== undefined ? { description: patch.description?.trim() ? patch.description.trim() : null } : {}),
            ...(patch.acceptanceCriteria !== undefined ? { acceptanceCriteria: cleanCriteria(patch.acceptanceCriteria) } : {}),
          },
          actor,
        );
      }
      if (patch.targetDate === undefined && patch.startDate === undefined) return this.view(milestone.id);
      const meta = this.meta(milestone.id);
      const previous = { targetDate: meta?.target_date ?? null, startDate: meta?.start_date ?? null };
      const next = {
        targetDate:
          patch.targetDate === undefined
            ? previous.targetDate
            : patch.targetDate === null
              ? null
              : parseMilestoneDate(patch.targetDate),
        startDate:
          patch.startDate === undefined
            ? previous.startDate
            : patch.startDate === null
              ? null
              : parseMilestoneDate(patch.startDate),
      };
      assertMilestoneDates(next);
      const now = nowIso();
      this.ensureMeta(milestone.id, now);
      this.db
        .prepare("UPDATE milestone_meta SET target_date = ?, start_date = ?, updated_at = ? WHERE issue_id = ?")
        .run(next.targetDate, next.startDate, now, milestone.id);
      this.emit("milestone_updated", milestone.id, actor, { ...next, previous });
      this.journal.record({
        entity: "milestone",
        entityId: milestone.id,
        verb: "update",
        payload: { targetDate: next.targetDate, startDate: next.startDate },
        actor: actor ?? null,
      });
      return this.view(milestone.id);
    });
  }

  /**
   * Add a member at a position (or append). A present member with no position
   * is an idempotent replay — `replayed: true`, no event; with a position it is
   * a move. Both directions of the guard live in `assertMembershipAllowed`.
   */
  addMember(
    milestoneRef: string,
    ref: string,
    options: MemberPosition & { baseRevision?: number; note?: string | null } = {},
    actor: string | null,
  ): MilestoneView & { replayed: boolean } {
    this.assertKindConfigured();
    const milestone = this.requireMilestone(milestoneRef);
    const member = this.requireIssue(ref);
    return this.journaled(() => {
      const current = this.membershipOf(member.id);
      const currentMilestone =
        current === undefined
          ? null
          : { id: current.milestone_id, identifier: this.store.getIssue(current.milestone_id).identifier };
      assertMembershipAllowed(milestone, member, currentMilestone);
      if (current !== undefined && !hasPosition(options)) {
        return { ...this.view(milestone.id), replayed: true };
      }
      this.assertBase(milestone, options.baseRevision);
      if (current !== undefined) {
        this.moveWithin(milestone, member, current, options, actor);
        return { ...this.view(milestone.id), replayed: false };
      }
      const now = nowIso();
      const rank = this.rankFor(milestone, options);
      this.insertMember(milestone.id, member.id, rank, { addedBy: actor ?? "user", addedAt: now, note: options.note ?? null });
      const revision = this.bumpRevision(milestone.id, now);
      const position = this.positionOf(milestone.id, member.id);
      this.emit("milestone_member_added", milestone.id, actor, {
        identifier: member.identifier,
        rank,
        position,
        revision,
      });
      this.emit("milestone_joined", member.id, actor, { milestone: milestone.identifier, revision });
      // Declared only on the write path: the idempotent replay above returns
      // before reaching here, so a repeated add mints no second operation.
      this.recordMembership(milestone.id, actor ?? null);
      // A member reports upward like a child, so joining can move the milestone's status.
      this.store.rederiveMilestones([milestone.id], member.identifier, actor ?? null);
      return { ...this.view(milestone.id), replayed: false };
    });
  }

  /** Move a row inside one milestone: delete, re-rank, re-insert with its original attribution. */
  private moveWithin(
    milestone: Issue,
    member: Issue,
    current: MemberRow,
    position: MemberPosition,
    actor: string | null,
  ): void {
    const fromPosition = this.positionOf(milestone.id, member.id);
    this.deleteMember(member.id);
    const rank = this.rankFor(milestone, position);
    this.insertMember(milestone.id, member.id, rank, {
      addedBy: current.added_by,
      addedAt: current.added_at,
      note: current.note,
    });
    const revision = this.bumpRevision(milestone.id, nowIso());
    const toPosition = this.positionOf(milestone.id, member.id);
    this.recordMembership(milestone.id, actor ?? null);
    this.emit("milestone_member_moved", milestone.id, actor, {
      identifier: member.identifier,
      fromPosition,
      toPosition,
      rank,
      revision,
    });
  }

  /** Remove a member; the others keep their ranks (sparse, so no renumber). `not_found` for a non-member. */
  removeMember(
    milestoneRef: string,
    ref: string,
    options: { baseRevision?: number } = {},
    actor: string | null,
  ): MilestoneView {
    this.assertKindConfigured();
    const milestone = this.requireMilestone(milestoneRef);
    const member = this.requireIssue(ref);
    return this.journaled(() => {
      const current = this.membershipOf(member.id);
      if (current === undefined || current.milestone_id !== milestone.id) {
        throw new StapleError("not_found", `${member.identifier} is not a member of ${milestone.identifier}.`, {
          identifier: member.identifier,
          milestone: milestone.identifier,
        });
      }
      this.assertBase(milestone, options.baseRevision);
      const position = this.positionOf(milestone.id, member.id);
      this.deleteMember(member.id);
      const revision = this.bumpRevision(milestone.id, nowIso());
      this.emit("milestone_member_removed", milestone.id, actor, { identifier: member.identifier, position, revision });
      this.emit("milestone_left", member.id, actor, { milestone: milestone.identifier, revision });
      this.recordMembership(milestone.id, actor ?? null);
      this.store.rederiveMilestones([milestone.id], member.identifier, actor ?? null);
      return this.view(milestone.id);
    });
  }

  /**
   * Move a member within its milestone (`before`/`after`/`at`) or to another one
   * (`to`, optionally positioned). The base revision is checked against the
   * milestone whose order the caller is editing: the destination for `to`, the
   * member's own milestone otherwise.
   */
  moveMember(
    ref: string,
    options: MemberPosition & { to?: string; baseRevision?: number } = {},
    actor: string | null,
  ): MilestoneView {
    this.assertKindConfigured();
    const member = this.requireIssue(ref);
    const target = options.to === undefined ? null : this.requireMilestone(options.to);
    if (target === null && !hasPosition(options)) {
      throw new StapleError("validation", `mv ${member.identifier} needs one of --before, --after, --at or --to.`);
    }
    return this.journaled(() => {
      const current = this.membershipOf(member.id);
      if (current === undefined) {
        throw new StapleError("not_found", `${member.identifier} is not a member of any milestone.`, {
          identifier: member.identifier,
        });
      }
      const from = this.store.getIssue(current.milestone_id);
      if (target === null || target.id === from.id) {
        if (!hasPosition(options)) return this.view(from.id);
        this.assertBase(from, options.baseRevision);
        this.moveWithin(from, member, current, options, actor);
        return this.view(from.id);
      }
      assertMembershipAllowed(target, member, null);
      this.assertBase(target, options.baseRevision);
      const now = nowIso();
      const fromPosition = this.positionOf(from.id, member.id);
      this.deleteMember(member.id);
      const fromRevision = this.bumpRevision(from.id, now);
      this.emit("milestone_member_removed", from.id, actor, {
        identifier: member.identifier,
        position: fromPosition,
        movedTo: target.identifier,
        revision: fromRevision,
      });
      const rank = this.rankFor(target, options);
      this.insertMember(target.id, member.id, rank, { addedBy: actor ?? "user", addedAt: now, note: current.note });
      const revision = this.bumpRevision(target.id, now);
      const toPosition = this.positionOf(target.id, member.id);
      this.emit("milestone_member_moved", target.id, actor, {
        identifier: member.identifier,
        from: from.identifier,
        to: target.identifier,
        fromPosition,
        toPosition,
        rank,
        revision,
      });
      this.emit("milestone_left", member.id, actor, { milestone: from.identifier, revision: fromRevision });
      this.emit("milestone_joined", member.id, actor, { milestone: target.identifier, revision });
      // Two milestones changed, so two operations: the source lost a member and
      // the destination gained one, and a receiver that saw only the second
      // would show the member in both places.
      this.recordMembership(from.id, actor ?? null);
      this.recordMembership(target.id, actor ?? null);
      this.store.rederiveMilestones([from.id, target.id], member.identifier, actor ?? null);
      return this.view(target.id);
    });
  }

  /** Bulk reorder: the whole membership, as a permutation, atomically, one revision bump, one event. */
  reorderMembers(
    milestoneRef: string,
    refs: readonly string[],
    options: { baseRevision?: number } = {},
    actor: string | null,
  ): MilestoneView {
    this.assertKindConfigured();
    const milestone = this.requireMilestone(milestoneRef);
    return this.journaled(() => {
      const rows = this.memberRows(milestone.id);
      const given = refs.map((ref) => this.requireIssue(ref));
      const configured = new Set(rows.map((row) => row.issue_id));
      const seen = new Set<string>();
      for (const issue of given) {
        if (!configured.has(issue.id)) {
          throw new StapleError("validation", `${issue.identifier} is not a member of ${milestone.identifier}.`, {
            identifier: issue.identifier,
            milestone: milestone.identifier,
          });
        }
        if (seen.has(issue.id)) {
          throw new StapleError("validation", `${issue.identifier} is listed twice.`, { identifier: issue.identifier });
        }
        seen.add(issue.id);
      }
      if (given.length !== rows.length) {
        const missing = rows.filter((row) => !seen.has(row.issue_id)).map((row) => row.identifier);
        throw new StapleError(
          "validation",
          `reorder needs every member of ${milestone.identifier}, in the new order; missing ${missing.join(", ")}.`,
          { milestone: milestone.identifier, missing },
        );
      }
      this.assertBase(milestone, options.baseRevision);
      this.renumber(
        milestone.id,
        given.map((issue) => issue.id),
      );
      const revision = this.bumpRevision(milestone.id, nowIso());
      this.emit("milestone_members_reordered", milestone.id, actor, {
        order: given.map((issue) => issue.identifier),
        revision,
      });
      this.recordMembership(milestone.id, actor ?? null);
      return this.view(milestone.id);
    });
  }

  /**
   * Create a milestone, optionally from an epic: the epic becomes the ONE
   * member and its children come along by descent, so re-parenting is
   * impossible by construction. `preview` validates everything and writes
   * nothing, returning the exact plan the commit will make.
   */
  create(
    input: CreateMilestoneInput & { preview?: boolean },
    actor: string | null,
  ): MilestoneCreatePreview | MilestoneCreateResult {
    this.assertKindConfigured();
    const targetDate = input.targetDate == null ? null : parseMilestoneDate(input.targetDate);
    const startDate = input.startDate == null ? null : parseMilestoneDate(input.startDate);
    assertMilestoneDates({ startDate, targetDate });

    const epic = input.fromEpic == null ? null : this.requireIssue(input.fromEpic);
    if (epic !== null) {
      const current = this.membershipOf(epic.id);
      assertMembershipAllowed(
        { id: "", identifier: input.title?.trim() || epic.title, kind: MILESTONE_KIND },
        epic,
        current === undefined
          ? null
          : { id: current.milestone_id, identifier: this.store.getIssue(current.milestone_id).identifier },
      );
    }
    const title = input.title?.trim() || epic?.title;
    if (!title) throw new StapleError("validation", "A milestone needs a title, or --from-epic to take the epic's.");
    const members = epic === null ? [] : [{ identifier: epic.identifier, position: 1 }];

    if (input.preview === true) {
      return { preview: true, milestone: { title, targetDate, startDate }, members, hierarchyChanges: [] };
    }

    /**
     * Three writes, now ONE transaction.
     *
     * They used to be three, and the comment that stood here said why:
     * "createIssue owns its own transaction, which is why they are not one." So
     * a crash between them left a milestone issue with no dates and no member —
     * a milestone in name only, which every read path then had to tolerate. The
     * reason was `tx`'s non-re-entrancy, and `tx` nests now, so the reason is
     * gone and the hole closes without restructuring any of the three.
     *
     * The composition also journals correctly by construction: the inner calls
     * join this scope rather than opening their own, so the create, the dates
     * and the membership are three operations on two entities committed
     * together, not three transactions a receiver could see a prefix of.
     */
    return this.journaled(() => {
      const criteria = cleanCriteria(input.acceptanceCriteria ?? []);
      const issue = this.store.createIssue({
        title,
        description: input.description?.trim() ? input.description.trim() : null,
        kind: MILESTONE_KIND,
        createdBy: actor,
        ...(criteria.length > 0 ? { acceptanceCriteria: criteria } : {}),
      });
      if (targetDate !== null || startDate !== null) this.update(issue.id, { targetDate, startDate }, actor);
      if (epic !== null) this.addMember(issue.id, epic.id, {}, actor);
      return { ...this.view(issue.id), preview: false, hierarchyChanges: [] };
    });
  }
}
