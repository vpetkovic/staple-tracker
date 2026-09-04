/**
 * The pickup queue in the store — the storage half of `docs/queue.md` (STA-167, R2b).
 *
 * The queue is an explicit, human-ordered PLAN: the rows a person put in it, in
 * the order they put them. Nothing here is derived from priority, `created_at`
 * or the configured status order, and nothing here reads the issue tree — this
 * service owns exactly the one table migration 008 added (`queue_entries`) and
 * the plan's `meta.queue_revision`, and it answers exactly two questions: what
 * is in the plan, and in what order.
 *
 * What is deliberately NOT here: the resolver (`effectiveQueue`), eligibility,
 * container expansion, the unqueued band, `strict` enforcement and the human
 * override. Those are R2c's (STA-168) and read this table; R3d (STA-174) reads
 * it for queued milestones. Keeping the ordering data and the ordering POLICY
 * apart is why a plan can be reordered without re-deriving anything, and why a
 * checkout can change eligibility without touching the plan.
 *
 * The rank encoding is the one `milestones.ts` already implements — sparse
 * integers with a step of 1024, a midpoint insert, and a whole-table renumber in
 * the same transaction when a gap is exhausted. It is imported rather than
 * re-derived so the queue and milestone membership can never drift apart.
 *
 * Concurrency is the same shape as milestone membership: every mutation runs in
 * one `BEGIN IMMEDIATE` transaction and bumps `meta.queue_revision`, and a
 * caller that passes a stale `baseRevision` is refused with `revision_conflict`
 * carrying `{ currentRevision }` while the server order stands untouched.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.js";
import { parseIdentifier } from "./ids.js";
import { rankBetween, renumberedRanks } from "./milestones.js";
import type { WorkspaceStore } from "./store.js";
import { type Issue, StapleError, nowIso } from "./types.js";

/**
 * One row of the plan, as every surface prints it.
 *
 * `issueId` is the entry's real identity — the table references `issues.id` and
 * never the identifier — so a rename, a status change or a re-parent leaves the
 * row exactly where it was. `identifier` is what a human types and is resolved
 * on every read.
 */
export interface QueueEntry {
  /** `issues.id`: what the entry actually references, and what survives a rename. */
  issueId: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  /** 1-based position in the WHOLE plan, resolved rows included. */
  planPosition: number;
  /** The sparse encoding behind `planPosition`; an implementation detail nobody types. */
  rank: number;
  /** The issue's parent, untouched by being queued. */
  parent: string | null;
  /** `done` or `cancelled`: kept at its rank, hidden by default, pruned on request. */
  resolved: boolean;
  addedBy: string;
  addedAt: string;
  note: string | null;
}

/**
 * What every mutation answers: the CAS base and the WHOLE plan, resolved rows
 * included. A listing hides resolved rows by asking `entries()` without `all`;
 * a mutation reports what the table now holds, so a caller never has to guess
 * whether a row it just touched was filtered out of the reply.
 */
export interface QueuePlan {
  /** `meta.queue_revision` — the `baseRevision` a mutation is checked against. */
  revision: number;
  entries: QueueEntry[];
}

/** Where an entry goes: before/after another entry, at a 1-based position, or (none) appended. */
export interface QueuePosition {
  before?: string;
  after?: string;
  at?: number;
}

interface EntryRow {
  issue_id: string;
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

const ENTRY_SELECT = `SELECT q.issue_id, q.rank, q.added_by, q.added_at, q.note,
                             i.identifier, i.title, i.kind, i.status, i.parent_id
                        FROM queue_entries q JOIN issues i ON i.id = q.issue_id`;

/** The `meta` key holding the plan's revision. Absent means 0; see `revision()`. */
const QUEUE_REVISION_KEY = "queue_revision";

function hasPosition(position: QueuePosition): boolean {
  return position.before !== undefined || position.after !== undefined || position.at !== undefined;
}

export class QueueStore {
  constructor(private readonly store: WorkspaceStore) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  // ---------- guards ----------

  /**
   * A queue belongs to ONE workspace file and references only its own issues, so
   * a foreign identifier is refused by name — before any lookup could call it
   * `not_found` — and the refusal says which workspace it belongs to. Other
   * workspaces reach the queue only as blockers, through the hub's cross links.
   */
  private assertLocalRef(ref: string): void {
    const parsed = parseIdentifier(ref);
    if (parsed && parsed.prefix !== this.store.prefix) {
      throw new StapleError(
        "validation",
        `${ref.trim().toUpperCase()} belongs to workspace prefix ${parsed.prefix}, not ${this.store.slug} (${this.store.prefix}); a queue holds only its own workspace's issues.`,
        { identifier: ref.trim().toUpperCase(), prefix: parsed.prefix, workspace: this.store.slug },
      );
    }
  }

  private requireIssue(ref: string): Issue {
    this.assertLocalRef(ref);
    return this.store.getIssue(ref);
  }

  // ---------- revision ----------

  /**
   * The revision the plan is currently at.
   *
   * ABSENT means `0`, which is why nothing writes the row until the plan is
   * actually mutated: a freshly initialised workspace keeps exactly the three
   * `meta` keys `characterize-layout.test.ts` pins, and migration 008 seeds
   * nothing.
   */
  revision(): number {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(QUEUE_REVISION_KEY) as
      | { value: string }
      | undefined;
    const value = Number(row?.value ?? 0);
    return Number.isFinite(value) ? value : 0;
  }

  /** Every mutation bumps it exactly once, including a renumber. */
  private bumpRevision(): number {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`,
      )
      .run(QUEUE_REVISION_KEY);
    return this.revision();
  }

  /** The CAS. Absent base = write blind (the CLI's default); present and stale = refused, order untouched. */
  private assertBase(base: number | undefined): void {
    if (base === undefined) return;
    const current = this.revision();
    if (current !== base) {
      throw new StapleError(
        "revision_conflict",
        `The queue is at revision ${current}, not ${base}. Re-read the queue and retry.`,
        { currentRevision: current },
      );
    }
  }

  // ---------- rows ----------

  private rows(): EntryRow[] {
    return this.db.prepare(`${ENTRY_SELECT} ORDER BY q.rank`).all() as unknown as EntryRow[];
  }

  private entryOf(issueId: string): EntryRow | undefined {
    return this.db.prepare(`${ENTRY_SELECT} WHERE q.issue_id = ?`).get(issueId) as unknown as
      | EntryRow
      | undefined;
  }

  private positionOf(issueId: string): number {
    return this.rows().findIndex((row) => row.issue_id === issueId) + 1;
  }

  private toEntry(row: EntryRow, index: number): QueueEntry {
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
      planPosition: index + 1,
      rank: row.rank,
      parent,
      resolved: this.store.isResolvedStatus(row.status),
      addedBy: row.added_by,
      addedAt: row.added_at,
      note: row.note,
    };
  }

  /**
   * The plan, in rank order.
   *
   * A resolved entry is KEPT at its rank and hidden from the default listing
   * (`{ all: true }` shows it), because the plan is also the record of what was
   * planned and because an issue that comes back out of `done` resumes its
   * position with nothing to re-queue. `planPosition` is numbered over the whole
   * plan BEFORE hiding, so hiding a resolved row never renumbers the rows after
   * it — position 3 stays position 3 whether or not position 1 is done.
   */
  entries(options: { all?: boolean } = {}): QueueEntry[] {
    const all = this.rows().map((row, index) => this.toEntry(row, index));
    return options.all === true ? all : all.filter((entry) => !entry.resolved);
  }

  private plan(): QueuePlan {
    return { revision: this.revision(), entries: this.entries({ all: true }) };
  }

  // ---------- ranks ----------

  /**
   * Clean ranks for the rows in their current order. Two passes because
   * `UNIQUE (rank)` is checked per statement: writing `1024` onto row one while
   * row two still holds `1024` would collide, so every row first takes a
   * negative placeholder nothing else can hold.
   */
  private renumber(orderedIssueIds: readonly string[]): void {
    const ranks = renumberedRanks(orderedIssueIds.length);
    const write = this.db.prepare("UPDATE queue_entries SET rank = ? WHERE issue_id = ?");
    orderedIssueIds.forEach((issueId, index) => write.run(-(index + 1), issueId));
    orderedIssueIds.forEach((issueId, index) => write.run(ranks[index]!, issueId));
  }

  /** The 0-based insertion index `position` names among `rows`, or the end. */
  private slotIndex(rows: readonly EntryRow[], position: QueuePosition): number {
    const indexOf = (ref: string): number => {
      const target = this.requireIssue(ref);
      const index = rows.findIndex((row) => row.issue_id === target.id);
      if (index < 0) {
        throw new StapleError("not_found", `${target.identifier} is not in the queue.`, {
          identifier: target.identifier,
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
   * The rank for a row slotted at `position`, renumbering the whole table first
   * when the gap there is exhausted. Runs inside the caller's transaction — the
   * renumber and the insert are one atomic write — and the row being placed must
   * not be in the table (a move deletes first).
   */
  private rankFor(position: QueuePosition): number {
    const rows = this.rows();
    const index = this.slotIndex(rows, position);
    const rank = rankBetween(rows[index - 1]?.rank ?? null, rows[index]?.rank ?? null);
    if (rank !== null) return rank;
    this.renumber(rows.map((row) => row.issue_id));
    const clean = renumberedRanks(rows.length);
    return rankBetween(clean[index - 1] ?? null, clean[index] ?? null)!;
  }

  private insert(
    issueId: string,
    rank: number,
    by: { addedBy: string; addedAt: string; note: string | null },
  ): void {
    this.db
      .prepare(
        `INSERT INTO queue_entries (issue_id, rank, added_by, added_at, note) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(issueId, rank, by.addedBy, by.addedAt, by.note);
  }

  private remove(issueId: string): void {
    this.db.prepare("DELETE FROM queue_entries WHERE issue_id = ?").run(issueId);
  }

  // ---------- events ----------

  /**
   * The store's INSERT, without a dedup key: none of these is level-triggered.
   * `issueId` is null for `queue_reordered`, which is a fact about the plan
   * rather than about any one row — the shape `status_config_changed` uses.
   * None of these moves a status, so none joins `STATUS_MOVING_EVENT_KINDS`.
   */
  private emit(
    kind: string,
    issueId: string | null,
    actor: string | null,
    payload: Record<string, unknown>,
  ): void {
    this.db
      .prepare(
        `INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)`,
      )
      .run(kind, issueId, actor, JSON.stringify(payload), nowIso());
  }

  // ---------- writes ----------

  /**
   * Put an issue in the plan at a position, or append it.
   *
   * An issue appears at most once (`PRIMARY KEY (issue_id)`), so enqueueing one
   * that is already there is not an error: with no position it is an idempotent
   * replay — `replayed: true`, no event, no revision bump — and with a position
   * it is a move. Containers are allowed on purpose: queueing an epic or a
   * milestone is how a human says "this whole thing next", and the resolver
   * expands it.
   */
  enqueue(
    ref: string,
    options: QueuePosition & { baseRevision?: number; note?: string | null } = {},
    actor: string | null = null,
  ): QueuePlan & { replayed: boolean } {
    const issue = this.requireIssue(ref);
    return tx(this.db, () => {
      const current = this.entryOf(issue.id);
      if (current !== undefined && !hasPosition(options)) {
        return { ...this.plan(), replayed: true };
      }
      this.assertBase(options.baseRevision);
      if (current !== undefined) {
        this.moveEntry(issue, current, options, actor);
        return { ...this.plan(), replayed: false };
      }
      const rank = this.rankFor(options);
      this.insert(issue.id, rank, {
        addedBy: actor ?? "user",
        addedAt: nowIso(),
        note: options.note ?? null,
      });
      const revision = this.bumpRevision();
      this.emit("queue_enqueued", issue.id, actor, {
        identifier: issue.identifier,
        rank,
        position: this.positionOf(issue.id),
        revision,
      });
      return { ...this.plan(), replayed: false };
    });
  }

  /** Take an issue out of the plan; the others keep their ranks (sparse, so no renumber). */
  dequeue(
    ref: string,
    options: { baseRevision?: number } = {},
    actor: string | null = null,
  ): QueuePlan {
    const issue = this.requireIssue(ref);
    return tx(this.db, () => {
      const current = this.entryOf(issue.id);
      if (current === undefined) {
        throw new StapleError("not_found", `${issue.identifier} is not in the queue.`, {
          identifier: issue.identifier,
        });
      }
      this.assertBase(options.baseRevision);
      const position = this.positionOf(issue.id);
      this.remove(issue.id);
      const revision = this.bumpRevision();
      this.emit("queue_dequeued", issue.id, actor, {
        identifier: issue.identifier,
        position,
        reason: "removed",
        revision,
      });
      return this.plan();
    });
  }

  /** Move an entry to a new position. `not_found` if it is not in the plan. */
  move(
    ref: string,
    options: QueuePosition & { baseRevision?: number },
    actor: string | null = null,
  ): QueuePlan {
    const issue = this.requireIssue(ref);
    if (!hasPosition(options)) {
      throw new StapleError("validation", `mv ${issue.identifier} needs one of --before, --after or --at.`);
    }
    return tx(this.db, () => {
      const current = this.entryOf(issue.id);
      if (current === undefined) {
        throw new StapleError("not_found", `${issue.identifier} is not in the queue.`, {
          identifier: issue.identifier,
        });
      }
      this.assertBase(options.baseRevision);
      this.moveEntry(issue, current, options, actor);
      return this.plan();
    });
  }

  /**
   * Delete, re-rank, re-insert with the entry's ORIGINAL attribution: moving a
   * row does not make the mover its author. Shared by `move` and by an
   * `enqueue` that named a position for an issue already in the plan.
   */
  private moveEntry(
    issue: Issue,
    current: EntryRow,
    position: QueuePosition,
    actor: string | null,
  ): void {
    const fromPosition = this.positionOf(issue.id);
    this.remove(issue.id);
    const rank = this.rankFor(position);
    this.insert(issue.id, rank, {
      addedBy: current.added_by,
      addedAt: current.added_at,
      note: current.note,
    });
    const revision = this.bumpRevision();
    this.emit("queue_moved", issue.id, actor, {
      identifier: issue.identifier,
      fromPosition,
      toPosition: this.positionOf(issue.id),
      rank,
      revision,
    });
  }

  /**
   * Bulk reorder: the whole plan, as a permutation, atomically — one
   * transaction, one revision bump, one event. A partial list is refused by
   * name rather than being interpreted, because "the rows you did not mention"
   * has no obviously right answer and a drag-and-drop editor always knows the
   * whole order.
   */
  reorder(
    refs: readonly string[],
    options: { baseRevision?: number } = {},
    actor: string | null = null,
  ): QueuePlan {
    return tx(this.db, () => {
      const rows = this.rows();
      const given = refs.map((ref) => this.requireIssue(ref));
      const queued = new Set(rows.map((row) => row.issue_id));
      const seen = new Set<string>();
      for (const issue of given) {
        if (!queued.has(issue.id)) {
          throw new StapleError("validation", `${issue.identifier} is not in the queue.`, {
            identifier: issue.identifier,
          });
        }
        if (seen.has(issue.id)) {
          throw new StapleError("validation", `${issue.identifier} is listed twice.`, {
            identifier: issue.identifier,
          });
        }
        seen.add(issue.id);
      }
      if (given.length !== rows.length) {
        const missing = rows.filter((row) => !seen.has(row.issue_id)).map((row) => row.identifier);
        throw new StapleError(
          "validation",
          `reorder needs every queue entry, in the new order; missing ${missing.join(", ")}.`,
          { missing },
        );
      }
      this.assertBase(options.baseRevision);
      this.renumber(given.map((issue) => issue.id));
      const revision = this.bumpRevision();
      this.emit("queue_reordered", null, actor, {
        order: given.map((issue) => issue.identifier),
        revision,
      });
      return this.plan();
    });
  }

  /**
   * Drop every resolved entry in one transaction, one `queue_dequeued` per row
   * with `reason: "pruned"`. This is the ONLY thing that removes an entry
   * automatically-looking, and it is still a deliberate human act: until it
   * runs, a reopened issue resumes its position, and after it runs that issue is
   * unqueued and sits in the unqueued band. Pruning an already-clean queue
   * changes nothing and does not bump the revision.
   */
  prune(options: { baseRevision?: number } = {}, actor: string | null = null): QueuePlan {
    return tx(this.db, () => {
      const rows = this.rows();
      this.assertBase(options.baseRevision);
      const resolved = rows
        .map((row, index) => ({ row, position: index + 1 }))
        .filter(({ row }) => this.store.isResolvedStatus(row.status));
      if (resolved.length === 0) return this.plan();
      for (const { row } of resolved) this.remove(row.issue_id);
      const revision = this.bumpRevision();
      for (const { row, position } of resolved) {
        this.emit("queue_dequeued", row.issue_id, actor, {
          identifier: row.identifier,
          position,
          reason: "pruned",
          revision,
        });
      }
      return this.plan();
    });
  }
}
