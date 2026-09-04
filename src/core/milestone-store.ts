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
 * the queue (R3d) consume one structure. `planPosition` and `next` are part of
 * that shape and are `null` until the queue lands: they are the queue's to fill.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.js";
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
import type { WorkspaceStore } from "./store.js";
import { type Issue, MAX_TREE_DEPTH, StapleError, type StatusCategory, nowIso } from "./types.js";

/** The milestone half of the view: the issue fields a plan needs plus its own metadata. */
export interface MilestoneSummary {
  identifier: string;
  title: string;
  status: string;
  kind: string;
  assignee: string | null;
  targetDate: string | null;
  startDate: string | null;
  /** Derived on every read; never stored. */
  state: MilestoneState;
  /** The milestone's row in the pickup plan; null until the queue (R3d) fills it. */
  planPosition: number | null;
}

/** One ordered member, as every surface prints it. */
export interface MilestoneMemberRow {
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
  /** The next eligible row from the queue resolver; null until R3d. */
  next: { identifier: string; position: number } | null;
}

/** A `milestone ls` row: the view without its members, plus how many there are. */
export type MilestoneListRow = Omit<MilestoneView, "members"> & { memberCount: number };

/** Where a member goes: before/after another member, at a 1-based position, or (none) appended. */
export interface MemberPosition {
  before?: string;
  after?: string;
  at?: number;
}

export interface MilestoneDatePatch {
  targetDate?: string | null;
  startDate?: string | null;
}

export interface CreateMilestoneInput {
  /** Defaults to the epic's title when `fromEpic` is given. */
  title?: string;
  description?: string | null;
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

  private requireIssue(ref: string): Issue {
    this.assertLocalRef(ref);
    return this.store.getIssue(ref);
  }

  private requireMilestone(ref: string): Issue {
    const issue = this.requireIssue(ref);
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

  /** The store's INSERT, without a dedup key: none of these is level-triggered. */
  private emit(kind: string, issueId: string, actor: string | null, payload: Record<string, unknown>): void {
    this.db
      .prepare(
        `INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(kind, issueId, actor, JSON.stringify(payload), nowIso());
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

  private view(id: string): MilestoneView {
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
        identifier: issue.identifier,
        title: issue.title,
        status: issue.status,
        kind: issue.kind,
        assignee: issue.assignee,
        targetDate,
        startDate,
        state: milestoneState({ category: this.category(issue.status), targetDate, startDate }, progress, nowIso()),
        planPosition: null,
      },
      progress,
      revision: meta?.members_revision ?? 0,
      members,
      next: null,
    };
  }

  /** One milestone, one shape. `validation` for a non-milestone, `not_found` for nothing. */
  get(ref: string): MilestoneView {
    this.assertKindConfigured();
    return this.view(this.requireMilestone(ref).id);
  }

  /**
   * Every milestone, open ones unless `all`, sorted by plan position (null last —
   * every row, until the queue lands), then target date (null last), then
   * identifier.
   */
  list(options: { all?: boolean } = {}): MilestoneListRow[] {
    this.assertKindConfigured();
    const rows = this.db
      .prepare("SELECT id, status FROM issues WHERE kind = ?")
      .all(MILESTONE_KIND) as Array<{ id: string; status: string }>;
    const views = rows
      .filter((row) => options.all === true || !this.store.isResolvedStatus(row.status))
      .map((row) => {
        const { members, ...rest } = this.view(row.id);
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

  /** The effective milestone of an issue: its own direct membership, else the nearest ancestor's. */
  milestoneOf(ref: string): string | null {
    const issue = this.requireIssue(ref);
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

  // ---------- writes ----------

  /** `set`: only the two dates; everything else is edited where every issue is. */
  update(ref: string, patch: MilestoneDatePatch, actor: string | null): MilestoneView {
    this.assertKindConfigured();
    if (patch.targetDate === undefined && patch.startDate === undefined) {
      throw new StapleError("validation", "update requires targetDate or startDate (null clears one).");
    }
    const milestone = this.requireMilestone(ref);
    return tx(this.db, () => {
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
    return tx(this.db, () => {
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
    return tx(this.db, () => {
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
    return tx(this.db, () => {
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
    return tx(this.db, () => {
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

    // Three writes, validated above so the later ones cannot fail on input.
    // createIssue owns its own transaction, which is why they are not one.
    const issue = this.store.createIssue({
      title,
      description: input.description ?? null,
      kind: MILESTONE_KIND,
      createdBy: actor,
    });
    if (targetDate !== null || startDate !== null) this.update(issue.id, { targetDate, startDate }, actor);
    if (epic !== null) this.addMember(issue.id, epic.id, {}, actor);
    return { ...this.view(issue.id), preview: false, hierarchyChanges: [] };
  }
}
