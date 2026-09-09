/**
 * The pickup queue in the store — `docs/queue.md` (STA-167 R2b, STA-168 R2c).
 *
 * TWO HALVES, in this order and deliberately not mixed.
 *
 * The PLAN (R2b, everything up to `prune`) is an explicit, human-ordered list:
 * the rows a person put in it, in the order they put them. Nothing in it is
 * derived from priority, `created_at` or the configured status order, and
 * nothing in it reads the issue tree — it owns exactly the one table migration
 * 008 added (`queue_entries`) and the plan's `meta.queue_revision`, and it
 * answers exactly two questions: what is in the plan, and in what order.
 *
 * The RESOLVER (R2c, from `effectiveQueue` down) turns that plan into what an
 * AGENT sees: containers expanded to leaf work, the eligibility ladder, the
 * unqueued band. It READS the plan and never writes it, which is why a plan can
 * be reordered without re-deriving anything and why a checkout can change
 * eligibility without touching the plan. `strict` enforcement and the human
 * override live where the claim happens — `store.checkoutIssue` — and call in
 * here for the order.
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
import { insertEvent } from "./event-log.js";
import type { Journal } from "./journal.js";
import { parseIdentifier } from "./ids.js";
import { milestoneDateBounds, MILESTONE_KIND, nearestMilestone, rankBetween, renumberedRanks } from "./milestones.js";
import type { WorkspaceStore } from "./store.js";
import { type BuiltinIssueKind, type Issue, MAX_TREE_DEPTH, StapleError, nowIso } from "./types.js";

/**
 * The kind an `epicPath` names. `epic` is the SEEDED id (`BUILTIN_KIND_SEED`),
 * typed against that vocabulary so a typo fails the build; a workspace whose
 * operator removed it simply reports an empty epic path for every row.
 */
const EPIC_KIND: BuiltinIssueKind = "epic";

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

/**
 * The entity id the plan replicates under.
 *
 * There is exactly one plan per workspace, so it needs a name rather than an id.
 * A UUID would imply there could be a second.
 */
const QUEUE_PLAN_ENTITY_ID = "@plan";

function hasPosition(position: QueuePosition): boolean {
  return position.before !== undefined || position.after !== undefined || position.at !== undefined;
}

export class QueueStore {
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
   * One of the four emitters, now delegating to the single writer.
   *
   * None of these is level-triggered, so no explicit dedup key is supplied and
   * `insertEvent` derives one from the enclosing mutation; it used to hardcode
   * `NULL`. `issueId` is null for `queue_reordered`, which is a fact about the
   * plan rather than about any one row — the shape `status_config_changed`
   * uses. None of these moves a status, so none joins
   * `STATUS_MOVING_EVENT_KINDS`.
   */
  private emit(
    kind: string,
    issueId: string | null,
    actor: string | null,
    payload: Record<string, unknown>,
  ): void {
    insertEvent(this.db, { kind, issueId, actor, payload });
  }

  // ---------- journal ----------

  /**
   * Declare a plan change as a whole-order `replace`, on the plan.
   *
   * The plan is ONE ordered collection with `UNIQUE (rank)` scoped to the whole
   * table — table-global, not per-container as `milestone_members` at least is —
   * so it is the worst case in the schema for a per-row merge: two devices each
   * enqueueing offline produce two rows that cannot both land. The order is the
   * only shape of this fact that merges, so the order is what replicates.
   *
   * It is also what the plan MEANS. A human reordering the queue is not making N
   * independent statements about N issues; they are saying "this, then this,
   * then that", and every surface reads it back as one list against one
   * `queue_revision` CAS token.
   */
  private recordPlan(actor: string | null): void {
    const order = (
      this.db
        .prepare("SELECT issue_id FROM queue_entries ORDER BY rank")
        .all() as Array<{ issue_id: string }>
    ).map((row) => row.issue_id);
    this.journal.record({
      entity: "queue",
      entityId: QUEUE_PLAN_ENTITY_ID,
      verb: "replace",
      payload: { order },
      actor,
    });
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
    return this.journaled(() => {
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
      // After the replay guard, so re-enqueueing a queued issue with no position
      // returns `replayed: true` above and mints no second operation.
      this.recordPlan(actor ?? null);
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
    return this.journaled(() => {
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
      this.recordPlan(actor ?? null);
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
    return this.journaled(() => {
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
    this.recordPlan(actor ?? null);
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
    return this.journaled(() => {
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
      this.recordPlan(actor ?? null);
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
    return this.journaled(() => {
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
      // One operation for the whole prune, however many rows it dropped: the
      // plan is one entity, and N events narrating it locally is not N facts.
      this.recordPlan(actor ?? null);
      return this.plan();
    });
  }

  // ---------- the resolver (docs/queue.md "The resolver") ----------

  /** Every issue in the file, keyed by id: the tree the expansion walks. */
  private nodes(): Map<string, IssueNode> {
    const rows = this.db
      .prepare("SELECT id, identifier, title, kind, status, parent_id, checkout_agent FROM issues")
      .all() as unknown as IssueNode[];
    return new Map(rows.map((row) => [row.id, row]));
  }

  /**
   * `store.queue().effectiveQueue()` — the ONE deterministic next-item
   * algorithm, and the only thing in the codebase that computes effective order.
   *
   * Inputs are exactly the ones docs/queue.md names: the `queue_entries` table,
   * the issue tree, status categories, local `blocks` edges and (injected) hub
   * cross links, gates, live claims, milestone membership order and the calling
   * actor. Same inputs, same output, on every surface and after a restart —
   * there is no clock, no random tiebreak and no per-surface fallback in here.
   */
  effectiveQueue(options: EffectiveQueueOptions | string | null = {}): EffectiveQueue {
    const opts: EffectiveQueueOptions =
      typeof options === "string" || options === null ? { actor: options } : options;
    const actor = opts.actor ?? null;
    const nodes = this.nodes();
    /**
     * The milestone side, for the whole workspace, in two queries (R3d,
     * STA-174): what a queued milestone expands to, the date those rows inherit,
     * and which milestone an issue belongs to. Deliberately not `milestones().get()`
     * — that view's `planPosition` and `next` are computed from THIS function.
     */
    const seam = this.store.milestones().queueSeam();

    /**
     * PRESENTATION SORT, borrowed whole rather than restated: `listIssues` is
     * what the inbox and the list already order by, so "siblings inside a
     * container expand in presentation sort" and "the unqueued band is in
     * presentation sort" are the SAME sort by construction, not by agreement.
     */
    const presentation = this.store.listIssues({});
    const presentationIndex = new Map(presentation.map((issue, index) => [issue.id, index]));
    const openChildren = new Map<string, IssueNode[]>();
    for (const node of nodes.values()) {
      if (node.parent_id === null || this.store.isResolvedStatus(node.status)) continue;
      const siblings = openChildren.get(node.parent_id) ?? [];
      siblings.push(node);
      openChildren.set(node.parent_id, siblings);
    }
    for (const siblings of openChildren.values()) {
      siblings.sort(
        (a, b) =>
          (presentationIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (presentationIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }

    interface Raw {
      node: IssueNode;
      planPosition: number | null;
      via: string | null;
      dueAt: string | null;
      unqueued: boolean;
    }
    const emitted = new Set<string>();
    const raw: Raw[] = [];

    /**
     * STEP 1 — EXPAND. A leaf is one effective row. A container (an issue with
     * at least one OPEN child — the same "nothing open underneath" test gates
     * use, so a parent a human resolved after its children finished is a leaf)
     * is never emitted as itself; it expands in place, depth-first, to its open
     * leaf descendants. An issue reached twice is emitted once, at its FIRST
     * occurrence, which is what `emitted` enforces.
     */
    const expand = (
      node: IssueNode,
      planPosition: number | null,
      via: string | null,
      dueAt: string | null,
      depth: number,
    ): void => {
      if (emitted.has(node.id) || depth > MAX_TREE_DEPTH) return;
      /**
       * A milestone is a container over its MEMBERSHIP rather than over its
       * children — nothing is ever re-parented into one — so it expands in
       * MEMBERSHIP ORDER FIRST, THEN HIERARCHY ORDER: each direct member in rank
       * order, each member expanded by the tree rule below, then the milestone's
       * own open children (if a human ever parented anything under it) by that
       * same rule. Membership is read on every call, so a `milestone mv` is
       * visible on the next read with no queue write. Its target date rides
       * along as `dueAt`: an explanation of urgency, never an input to order.
       * It rides as the day's INCLUSIVE END (`milestoneDateBounds(target).endsAt`,
       * docs/milestones.md "Dates"), so a consumer comparing `dueAt` to `now` is
       * on time all through the target day instead of overdue from its 00:00Z.
       */
      if (node.kind === MILESTONE_KIND) {
        const target = seam.targetDateOf.get(node.id) ?? null;
        const due = target === null ? null : milestoneDateBounds(target).endsAt;
        for (const memberId of seam.membersOf.get(node.id) ?? []) {
          const memberNode = nodes.get(memberId);
          if (memberNode) expand(memberNode, planPosition, via ?? node.identifier, due, depth + 1);
        }
        for (const child of openChildren.get(node.id) ?? []) {
          expand(child, planPosition, via ?? node.identifier, due, depth + 1);
        }
        return;
      }
      const children = openChildren.get(node.id) ?? [];
      if (children.length > 0) {
        for (const child of children) expand(child, planPosition, via ?? node.identifier, dueAt, depth + 1);
        return;
      }
      emitted.add(node.id);
      raw.push({ node, planPosition, via, dueAt, unqueued: false });
    };

    const planEntries = this.entries({ all: true });
    for (const entry of planEntries) {
      const node = nodes.get(entry.issueId);
      if (node) expand(node, entry.planPosition, null, null, 0);
    }

    /**
     * STEP 2 — THE UNQUEUED BAND. Every open leaf not reached by step 1 follows,
     * in presentation sort. The queue is a PREFIX, not a filter: unqueued work is
     * still work, it is just later. Containers stay out of it for the same reason
     * they stay out of step 1 — a row here is a thing an agent may be told to
     * take, and an epic with open children is not one.
     */
    for (const issue of presentation) {
      if (emitted.has(issue.id)) continue;
      if ((openChildren.get(issue.id) ?? []).length > 0) continue;
      // A milestone is a container over its MEMBERSHIP rather than over its
      // children, so "has no open child" does not make it a leaf. Nobody checks
      // out a milestone; its members are what an agent takes.
      if (issue.kind === MILESTONE_KIND) continue;
      const node = nodes.get(issue.id);
      if (!node) continue;
      emitted.add(node.id);
      raw.push({ node, planPosition: null, via: null, dueAt: null, unqueued: true });
    }

    /**
     * STEP 3 — CLASSIFY. Hard constraints only, first match wins, and rank is
     * NOT on the ladder: the queue can only order what is already takeable. Rows
     * are never dropped for being ineligible — the plan is shown whole, so a
     * human can see what their order is waiting on.
     */
    const ids = raw.map((row) => row.node.id);
    const blockers = this.store.unresolvedBlockersFor(ids);
    const gates = this.store.queuedByFor(ids);
    const claims = this.store.claimActivityFor(ids);

    /** The row's own id first, then its parent, then the grandparent — one walk, two paths. */
    const chainOf = (id: string): string[] => {
      const chain = [id];
      let current = nodes.get(id)?.parent_id ?? null;
      for (let depth = 0; depth < MAX_TREE_DEPTH && current !== null; depth += 1) {
        if (chain.includes(current)) break;
        chain.push(current);
        current = nodes.get(current)?.parent_id ?? null;
      }
      return chain;
    };

    const rows: EffectiveQueueRow[] = raw.map((row, index) => {
      const node = row.node;
      /**
       * WHERE THIS ROW SITS IN THE PLAN, both ways (R3d). The milestone path is
       * MEMBERSHIP-derived — the nearest milestone the row or an ancestor is a
       * member of — so a row reached through a queued milestone and a row that
       * merely belongs to one report the same thing, and `via` stays the field
       * that says which container it was expanded out of. The epic path is the
       * ANCESTOR epics, outermost first; the row itself is never in its own path.
       */
      const chain = chainOf(node.id);
      const milestoneId = nearestMilestone(chain, seam.milestoneOf);
      const milestonePath = milestoneId === null ? [] : [nodes.get(milestoneId)?.identifier ?? milestoneId];
      const epicPath = chain
        .slice(1)
        .filter((id) => nodes.get(id)?.kind === EPIC_KIND)
        .map((id) => nodes.get(id)!.identifier)
        .reverse();
      const category = this.store.categoryOf(node.status);
      const local = blockers.get(node.id) ?? [];
      const cross = (opts.crossBlockers?.get(node.identifier) ?? []).filter(
        (blocker) => !blocker.resolved || blocker.unresolvable,
      );
      const gate = gates.get(node.id) ?? null;
      const claim = claims.get(node.id) ?? null;
      let eligibility: QueueEligibility = "eligible";
      let reason: string | null = null;
      let detail: Record<string, unknown> | null = null;
      if (this.store.isResolvedStatus(node.status)) {
        eligibility = "resolved";
        reason = `${node.identifier} is ${node.status}.`;
        detail = { status: node.status };
      } else if (gate !== null || category === "gated") {
        // The gate is named BEFORE the blocker, as the inbox does: a blocker
        // cannot even be worked until a human opens the gate above it.
        eligibility = "gated";
        reason = gate
          ? `${node.identifier} is queued behind ${gate.identifier}, awaiting approval by ${gate.owner}.`
          : `${node.identifier} is awaiting approval.`;
        detail = gate ? { queuedBy: { identifier: gate.identifier, owner: gate.owner } } : { status: node.status };
      } else if (local.length > 0 || cross.length > 0 || category === "blocked") {
        eligibility = "blocked";
        const named = [...local, ...cross.map((blocker) => blocker.identifier)];
        reason =
          named.length > 0
            ? `${node.identifier} is blocked by ${named.join(", ")}.`
            : `${node.identifier} is blocked.`;
        detail = {
          blockers: local,
          crossBlockers: cross.map((blocker) => ({
            identifier: blocker.identifier,
            unresolvable: blocker.unresolvable,
          })),
        };
      } else if (category === "active" && node.checkout_agent !== null && node.checkout_agent !== actor) {
        eligibility = "claimed";
        reason = `${node.identifier} is held by ${node.checkout_agent}.`;
        detail = { heldBy: node.checkout_agent, idleSeconds: claim?.idleSeconds ?? null };
      }
      return {
        issueId: node.id,
        identifier: node.identifier,
        title: node.title,
        kind: node.kind,
        status: node.status,
        position: index + 1,
        planPosition: row.planPosition,
        via: row.via,
        unqueued: row.unqueued,
        eligibility,
        reason,
        detail,
        dueAt: row.dueAt,
        milestonePath,
        epicPath,
        parent: row.node.parent_id === null ? null : (nodes.get(row.node.parent_id)?.identifier ?? null),
      };
    });

    const nextIndex = rows.findIndex((row) => row.eligibility === "eligible");
    return {
      revision: this.revision(),
      rows,
      next: nextIndex < 0 ? null : rows[nextIndex]!,
      skipped: nextIndex < 0 ? rows : rows.slice(0, nextIndex),
    };
  }

  /**
   * THE listing every surface answers — `{revision, entries, effective}` — so a
   * script reading the CLI's `--json`, a tool call and an HTTP GET parse the
   * same object. `all` shows resolved plan rows; `actor` is whose eligibility
   * the effective half is computed for.
   */
  view(options: { all?: boolean } & EffectiveQueueOptions = {}): QueueView {
    const effective = this.effectiveQueue(options);
    return {
      revision: effective.revision,
      entries: this.entries({ all: options.all }),
      effective: effective.rows,
    };
  }

  /**
   * ONE entry point for every mutation, on every surface. CLI, MCP and HTTP each
   * parse their own arguments into `QueueMutationInput` and hand them here, so
   * the verb set, the refusals and the answer shape cannot drift between them —
   * a cross-surface contract test is then checking one code path from three
   * directions rather than three implementations against each other.
   */
  mutate(verb: QueueVerb, input: QueueMutationInput = {}, actor: string | null = null): QueueView {
    const position: QueuePosition = { before: input.before, after: input.after, at: input.at };
    const ref = (): string => {
      if (!input.ref?.trim()) {
        throw new StapleError("validation", `staple queue ${verb} needs an issue reference.`);
      }
      return input.ref;
    };
    const baseRevision = input.baseRevision;
    let replayed = false;
    switch (verb) {
      case "add":
        replayed = this.enqueue(ref(), { ...position, baseRevision, note: input.note }, actor).replayed;
        break;
      case "rm":
        this.dequeue(ref(), { baseRevision }, actor);
        break;
      case "mv":
        this.move(ref(), { ...position, baseRevision }, actor);
        break;
      case "reorder":
        this.reorder(input.order ?? [], { baseRevision }, actor);
        break;
      case "prune":
        this.prune({ baseRevision }, actor);
        break;
      default:
        throw new StapleError("validation", `Unknown queue verb "${verb as string}". Use: ls, add, rm, mv, reorder, next, prune`);
    }
    const view = this.view({ all: input.all, actor });
    return verb === "add" ? { ...view, replayed } : view;
  }
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE RESOLVER — R2c (STA-168), docs/queue.md "The resolver".
 *
 * Everything above this line is the PLAN: rows a human put in a table, in the
 * order they put them. Everything below is the one deterministic function that
 * turns that plan into what an AGENT sees — containers expanded to leaf work,
 * every row classified by the eligibility ladder, and the unqueued band after
 * the plan. `inbox`, `queue`, `queue next`, the strict checkout guard, MCP,
 * HTTP and the editor's preview all read THIS and nothing else, which is what
 * makes "the same revision and the same order on every surface" structural
 * rather than aspirational.
 * ────────────────────────────────────────────────────────────────────────────
 */

/** The eligibility ladder, in order. The first rule that matches wins. */
export type QueueEligibility = "resolved" | "gated" | "blocked" | "claimed" | "eligible";

/** One row of the effective order — what an agent receives. */
export interface EffectiveQueueRow {
  issueId: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  /** 1-based position in EFFECTIVE order — the number `next` and `out_of_order` speak. */
  position: number;
  /**
   * The PLAN row this came from: its own entry, or the container's. Null in the
   * unqueued band. Reported beside `position` wherever the two differ, because
   * they answer different questions — what a human wrote, and what an agent gets.
   */
  planPosition: number | null;
  /** The queued container this row was expanded out of; null when queued directly or unqueued. */
  via: string | null;
  /** True for a row after the last plan row: still work, just later. */
  unqueued: boolean;
  eligibility: QueueEligibility;
  /** A sentence for a human; null when the row is eligible. */
  reason: string | null;
  /** The machine-readable half of `reason`; null when the row is eligible. */
  detail: Record<string, unknown> | null;
  /**
   * The target date of the milestone this row was reached through, as the
   * inclusive END of that day (`2026-10-31T23:59:59.999Z`). It explains urgency
   * and is NEVER an input to order or eligibility — a date does not get to
   * reorder a plan somebody wrote by hand.
   */
  dueAt: string | null;
  /**
   * The milestone this row belongs to — its own membership, else the nearest
   * ancestor's — as identifiers, outermost first. At most one element today,
   * because a milestone cannot be a member of a milestone; an array because it
   * is a path, and because `epicPath` beside it is genuinely a path.
   */
  milestonePath: string[];
  /** The row's ANCESTOR epics, outermost first. The row itself is never in it. */
  epicPath: string[];
  parent: string | null;
}

/** What `effectiveQueue` answers: the whole order, plus the pickup decision. */
export interface EffectiveQueue {
  revision: number;
  rows: EffectiveQueueRow[];
  /** The first `eligible` row for the actor, or null when nothing is takeable. */
  next: EffectiveQueueRow | null;
  /** The rows before `next`, each carrying why it was passed over. */
  skipped: EffectiveQueueRow[];
}

/**
 * THE one shape every surface answers, for a read and for a mutation alike:
 * the plan, the effective order, and the revision both were computed at.
 */
export interface QueueView {
  revision: number;
  entries: QueueEntry[];
  effective: EffectiveQueueRow[];
  /** Only on `add`: the issue was already in the plan and nothing was written. */
  replayed?: boolean;
}

/** The mutating verbs, spelled the same on every surface. */
export type QueueVerb = "add" | "rm" | "mv" | "reorder" | "prune";

/** Everything any verb can take. Each surface parses its own arguments into this. */
export interface QueueMutationInput extends QueuePosition {
  ref?: string;
  order?: readonly string[];
  baseRevision?: number;
  note?: string | null;
  /** Passed through to the view: show resolved entries too. */
  all?: boolean;
}

/**
 * A cross-workspace blocker as the hub reports it. The resolver takes these
 * INJECTED rather than fetching them: `cross_links` live in the hub database,
 * and `Hub.crossBlockersOf` opens one workspace file per link, which is not a
 * cost the inbox can pay per row. `unresolvable` (the blocker's file is not on
 * this machine) reads as blocked, exactly as it does everywhere else.
 */
export interface CrossBlockerLite {
  identifier: string;
  resolved: boolean;
  unresolvable: boolean;
}

export interface EffectiveQueueOptions {
  /** Whose view this is. A row held by somebody ELSE is `claimed`; a row held by the actor is not. */
  actor?: string | null;
  /** Cross-workspace blockers by issue identifier; absent means none are known. */
  crossBlockers?: ReadonlyMap<string, readonly CrossBlockerLite[]>;
}

interface IssueNode {
  id: string;
  identifier: string;
  title: string;
  kind: string;
  status: string;
  parent_id: string | null;
  checkout_agent: string | null;
}
