import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.js";
import {
  blockersResolvedDedupKey,
  childrenCompleteDedupKey,
  newId,
  parseIdentifier,
} from "./ids.js";
import {
  type ClaimActivity,
  DEFAULT_CHECKOUT_EXPECTED,
  type Issue,
  type IssueComment,
  type IssueDocumentMeta,
  type IssuePriority,
  type IssueStatus,
  MAX_TREE_DEPTH,
  RESOLVED_STATUSES,
  StapleError,
  type StapleEvent,
  assertPriority,
  assertStatus,
  claimGuardMessage,
  normalizeTitle,
  nowIso,
} from "./types.js";

export interface CreateIssueInput {
  title: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority;
  parent?: string | null;
  assignee?: string | null;
  createdBy?: string | null;
  labels?: string[];
  acceptanceCriteria?: string[];
  blockedBy?: string[];
  blockParentUntilDone?: boolean;
  unblockOwner?: string | null;
  unblockAction?: string | null;
  originKind?: string;
  originId?: string | null;
  idempotencyKey?: string | null;
  allowDuplicate?: boolean;
}

export interface UpdateIssueInput {
  title?: string;
  description?: string | null;
  status?: IssueStatus;
  priority?: IssuePriority;
  assignee?: string | null;
  labels?: string[];
  acceptanceCriteria?: string[];
  unblockOwner?: string | null;
  unblockAction?: string | null;
  expectedStatusVersion?: number;
  comment?: string;
}

/**
 * Idempotent writes report whether they created anything. `replayed: true` means
 * the key had been used before and the ORIGINAL row is being returned — the
 * caller's retry was absorbed, not applied twice.
 */
export interface CreateIssueResult {
  issue: Issue;
  replayed: boolean;
}

export interface AddCommentResult {
  comment: IssueComment;
  replayed: boolean;
}

export interface IssueFilters {
  status?: IssueStatus[];
  assignee?: string;
  parent?: string | null;
  q?: string;
  includeResolved?: boolean;
}

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  normalized_title: string;
  description: string | null;
  status: string;
  status_version: number;
  priority: string;
  parent_id: string | null;
  depth: number;
  assignee: string | null;
  created_by: string | null;
  labels: string;
  acceptance_criteria: string | null;
  block_parent_until_done: number;
  unblock_owner: string | null;
  unblock_action: string | null;
  origin_kind: string;
  origin_id: string | null;
  idempotency_key: string | null;
  checkout_agent: string | null;
  checkout_at: string | null;
  blocked_transition_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

function rowToIssue(row: IssueRow): Issue {
  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    description: row.description,
    status: row.status as IssueStatus,
    statusVersion: row.status_version,
    priority: row.priority as IssuePriority,
    parentId: row.parent_id,
    depth: row.depth,
    assignee: row.assignee,
    createdBy: row.created_by,
    labels: JSON.parse(row.labels) as string[],
    acceptanceCriteria: row.acceptance_criteria
      ? (JSON.parse(row.acceptance_criteria) as string[])
      : null,
    blockParentUntilDone: row.block_parent_until_done === 1,
    unblockOwner: row.unblock_owner,
    unblockAction: row.unblock_action,
    originKind: row.origin_kind,
    originId: row.origin_id,
    idempotencyKey: row.idempotency_key,
    checkoutAgent: row.checkout_agent,
    checkoutAt: row.checkout_at,
    blockedTransitionAt: row.blocked_transition_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface CommentRow {
  id: string;
  issue_id: string;
  author: string;
  author_type: string;
  body: string;
  idempotency_key: string | null;
  deleted_at: string | null;
  created_at: string;
}

function rowToComment(row: CommentRow): IssueComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    author: row.author,
    authorType: row.author_type as never,
    body: row.body,
    idempotencyKey: row.idempotency_key,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
  };
}

const RESOLVED_SQL = "('done','cancelled')";

/** Whole seconds between two ISO-8601 instants, floored at 0 (clocks can skew). */
function secondsBetween(from: string, to: string): number {
  const delta = (Date.parse(to) - Date.parse(from)) / 1000;
  return Number.isFinite(delta) ? Math.max(0, Math.floor(delta)) : 0;
}

/**
 * Idleness thresholds are a promise about time, so a NaN or a negative one must
 * fail loudly: `stealIfIdleSeconds: -1` would otherwise mean "steal anything",
 * which is exactly the automatic behaviour this ticket exists to prevent.
 * 0 is allowed and honest — "take it however fresh it is" — but it has to be typed.
 */
function assertIdleThreshold(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) {
    throw new StapleError("validation", `${name} must be a non-negative number of seconds`);
  }
  return value;
}

export class WorkspaceStore {
  constructor(
    readonly db: DatabaseSync,
    readonly slug: string,
    readonly prefix: string,
  ) {}

  // ---------- lookup ----------

  /** Resolve a reference — uuid, identifier (WS-12), or bare number — to a row. */
  private findRow(ref: string): IssueRow | undefined {
    const trimmed = ref.trim();
    const byId = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(trimmed) as
      | IssueRow
      | undefined;
    if (byId) return byId;
    const parsed = parseIdentifier(trimmed) ?? parseIdentifier(`${this.prefix}-${trimmed}`);
    if (parsed) {
      return this.db
        .prepare("SELECT * FROM issues WHERE identifier = ?")
        .get(`${parsed.prefix}-${parsed.number}`) as unknown as IssueRow | undefined;
    }
    return undefined;
  }

  private requireRow(ref: string): IssueRow {
    const row = this.findRow(ref);
    if (!row) throw new StapleError("not_found", `No issue matches "${ref}" in workspace ${this.slug}`);
    return row;
  }

  getIssue(ref: string): Issue {
    return rowToIssue(this.requireRow(ref));
  }

  // ---------- events ----------

  private emitEvent(input: {
    kind: string;
    issueId?: string | null;
    actor?: string | null;
    payload?: Record<string, unknown>;
    dedupKey?: string | null;
  }): void {
    // INSERT OR IGNORE + partial unique index = level-triggered dedup.
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (kind, issue_id, actor, payload, dedup_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.kind,
        input.issueId ?? null,
        input.actor ?? null,
        JSON.stringify(input.payload ?? {}),
        input.dedupKey ?? null,
        nowIso(),
      );
  }

  listEvents(since = 0, limit = 200): StapleEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?")
      .all(since, limit) as Array<{
      seq: number;
      kind: string;
      issue_id: string | null;
      actor: string | null;
      payload: string;
      dedup_key: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      seq: row.seq,
      kind: row.kind,
      issueId: row.issue_id,
      actor: row.actor,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      dedupKey: row.dedup_key,
      createdAt: row.created_at,
    }));
  }

  // ---------- creation ----------

  createIssue(input: CreateIssueInput): Issue {
    return this.createIssueResult(input).issue;
  }

  /** createIssue, plus whether an idempotency key replayed an earlier create. */
  createIssueResult(input: CreateIssueInput): CreateIssueResult {
    const title = input.title?.trim();
    if (!title) throw new StapleError("validation", "Title is required");
    if (input.priority) assertPriority(input.priority);
    if (input.status) assertStatus(input.status);

    // Paperclip default: todo when assigned, backlog otherwise.
    const status: IssueStatus = input.status ?? (input.assignee ? "todo" : "backlog");
    if ((input.unblockOwner || input.unblockAction) && status !== "blocked") {
      throw new StapleError("validation", "unblockOwner/unblockAction require status \"blocked\"");
    }

    return tx(this.db, () => {
      // Idempotency replay: the same key always returns the original issue.
      if (input.idempotencyKey) {
        const existing = this.db
          .prepare("SELECT * FROM issues WHERE idempotency_key = ?")
          .get(input.idempotencyKey) as unknown as IssueRow | undefined;
        if (existing) return { issue: rowToIssue(existing), replayed: true };
      }

      let parent: IssueRow | null = null;
      if (input.parent) {
        parent = this.requireRow(input.parent);
        if (parent.depth + 1 > MAX_TREE_DEPTH) {
          throw new StapleError("validation", `Tree depth cap (${MAX_TREE_DEPTH}) exceeded`);
        }
      }

      // Duplicate guard: same normalized title among open siblings.
      const normalized = normalizeTitle(title);
      if (!input.allowDuplicate) {
        const dup = this.db
          .prepare(
            `SELECT identifier FROM issues
             WHERE normalized_title = ? AND status NOT IN ${RESOLVED_SQL}
               AND parent_id IS ?`,
          )
          .get(normalized, parent?.id ?? null) as { identifier: string } | undefined;
        if (dup) {
          throw new StapleError(
            "duplicate",
            `An open issue with this title already exists (${dup.identifier}). Pass allowDuplicate to bypass, or use an idempotencyKey for safe retries.`,
            { identifier: dup.identifier },
          );
        }
      }

      const blockerRows = (input.blockedBy ?? []).map((ref) => this.requireRow(ref));

      const id = newId();
      const number = this.nextIssueNumber();
      const identifier = `${this.prefix}-${number}`;
      const now = nowIso();
      const row = this.db
        .prepare(
          `INSERT INTO issues (
             id, identifier, title, normalized_title, description, status, priority,
             parent_id, depth, assignee, created_by, labels, acceptance_criteria,
             block_parent_until_done, unblock_owner, unblock_action, origin_kind, origin_id,
             idempotency_key, blocked_transition_at, started_at, created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           RETURNING *`,
        )
        .get(
          id,
          identifier,
          title,
          normalized,
          input.description ?? null,
          status,
          input.priority ?? "medium",
          parent?.id ?? null,
          parent ? parent.depth + 1 : 0,
          input.assignee ?? null,
          input.createdBy ?? null,
          JSON.stringify(input.labels ?? []),
          input.acceptanceCriteria ? JSON.stringify(input.acceptanceCriteria) : null,
          input.blockParentUntilDone ? 1 : 0,
          status === "blocked" ? (input.unblockOwner ?? null) : null,
          status === "blocked" ? (input.unblockAction ?? null) : null,
          input.originKind ?? "manual",
          input.originId ?? null,
          input.idempotencyKey ?? null,
          status === "blocked" ? now : null,
          status === "in_progress" ? now : null,
          now,
          now,
        ) as unknown as IssueRow;

      for (const blocker of blockerRows) {
        this.insertEdge(blocker.id, id, input.createdBy ?? null);
      }
      // "Block parent until done" is a real dependency edge: child blocks parent.
      if (input.blockParentUntilDone && parent) {
        this.assertNoCycle(parent.id, [id]);
        this.insertEdge(id, parent.id, input.createdBy ?? null);
      }

      this.emitEvent({
        kind: "issue_created",
        issueId: id,
        actor: input.createdBy ?? null,
        payload: { identifier, title, status },
      });
      return { issue: rowToIssue(row), replayed: false };
    });
  }

  createChild(parentRef: string, input: Omit<CreateIssueInput, "parent">): Issue {
    return this.createIssue({ ...input, parent: parentRef });
  }

  private nextIssueNumber(): number {
    const row = this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('next_issue_number', '2')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)
         RETURNING CAST(value AS INTEGER) - 1 AS n`,
      )
      .get() as { n: number };
    return row.n;
  }

  // ---------- relations ----------

  private insertEdge(blockerId: string, blockedId: string, createdBy: string | null): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO relations (blocker_id, blocked_id, type, created_by, created_at)
         VALUES (?, ?, 'blocks', ?, ?)`,
      )
      .run(blockerId, blockedId, createdBy, nowIso());
  }

  /**
   * BFS over the whole "blocks" graph, cloned from Paperclip's
   * assertNoBlockingCycles: adding each proposed blocker may not create a path
   * from the issue back to that blocker.
   */
  private assertNoCycle(issueId: string, blockerIds: string[]): void {
    if (blockerIds.length === 0) return;
    const edges = this.db
      .prepare("SELECT blocker_id, blocked_id FROM relations WHERE type = 'blocks'")
      .all() as Array<{ blocker_id: string; blocked_id: string }>;
    const adjacency = new Map<string, string[]>();
    for (const edge of edges) {
      const list = adjacency.get(edge.blocker_id) ?? [];
      list.push(edge.blocked_id);
      adjacency.set(edge.blocker_id, list);
    }
    for (const blockerId of blockerIds) {
      if (blockerId === issueId) {
        throw new StapleError("cycle", "Issue cannot be blocked by itself");
      }
      const queue = [...(adjacency.get(issueId) ?? [])];
      const visited = new Set<string>([issueId]);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === blockerId) {
          throw new StapleError("cycle", "Blocking relations cannot contain cycles");
        }
        if (visited.has(current)) continue;
        visited.add(current);
        queue.push(...(adjacency.get(current) ?? []));
      }
    }
  }

  /** Replace the full blocked-by set (Paperclip's set-replacement semantics). */
  setBlockedBy(ref: string, blockerRefs: string[], actor?: string | null): Issue {
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      const blockers = blockerRefs.map((blockerRef) => this.requireRow(blockerRef));
      const deduped = [...new Map(blockers.map((b) => [b.id, b])).values()];
      this.assertNoCycle(
        row.id,
        deduped.map((b) => b.id),
      );
      this.db
        .prepare("DELETE FROM relations WHERE blocked_id = ? AND type = 'blocks'")
        .run(row.id);
      for (const blocker of deduped) this.insertEdge(blocker.id, row.id, actor ?? null);
      this.emitEvent({
        kind: "blockers_changed",
        issueId: row.id,
        actor,
        payload: { identifier: row.identifier, blockedBy: deduped.map((b) => b.identifier) },
      });
      // Level check: the new set may already be fully resolved.
      this.maybeEmitBlockersResolved(row);
      return rowToIssue(this.requireRow(row.id));
    });
  }

  blockersOf(issueId: string): IssueRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM relations r JOIN issues i ON i.id = r.blocker_id
         WHERE r.blocked_id = ? AND r.type = 'blocks' ORDER BY i.identifier`,
      )
      .all(issueId) as unknown as IssueRow[];
  }

  dependentsOf(issueId: string): IssueRow[] {
    return this.db
      .prepare(
        `SELECT i.* FROM relations r JOIN issues i ON i.id = r.blocked_id
         WHERE r.blocker_id = ? AND r.type = 'blocks' ORDER BY i.identifier`,
      )
      .all(issueId) as unknown as IssueRow[];
  }

  unresolvedBlockersOf(issueId: string): IssueRow[] {
    return this.blockersOf(issueId).filter(
      (b) => !(RESOLVED_STATUSES as readonly string[]).includes(b.status),
    );
  }

  /**
   * Unresolved blocker identifiers for a whole set of issues in ONE query.
   * The inbox used to call unresolvedBlockersOf() per issue (two round trips
   * each); a page of 50 issues is now a single scan of the relations index.
   */
  unresolvedBlockersFor(issueIds: string[]): Map<string, string[]> {
    const byIssue = new Map<string, string[]>(issueIds.map((id) => [id, []]));
    if (issueIds.length === 0) return byIssue;
    const rows = this.db
      .prepare(
        `SELECT r.blocked_id AS blocked_id, b.identifier AS identifier
         FROM relations r JOIN issues b ON b.id = r.blocker_id
         WHERE r.type = 'blocks' AND b.status NOT IN ${RESOLVED_SQL}
           AND r.blocked_id IN (${issueIds.map(() => "?").join(",")})
         ORDER BY b.identifier`,
      )
      .all(...(issueIds as never[])) as Array<{ blocked_id: string; identifier: string }>;
    for (const row of rows) byIssue.get(row.blocked_id)?.push(row.identifier);
    return byIssue;
  }

  private maybeEmitBlockersResolved(dependent: IssueRow): void {
    const all = this.blockersOf(dependent.id);
    if (all.length === 0) return;
    const unresolved = all.filter(
      (b) => !(RESOLVED_STATUSES as readonly string[]).includes(b.status),
    );
    if (unresolved.length > 0) return;
    this.emitEvent({
      kind: "blockers_resolved",
      issueId: dependent.id,
      payload: {
        identifier: dependent.identifier,
        assignee: dependent.assignee,
        blockers: all.map((b) => b.identifier),
      },
      dedupKey: blockersResolvedDedupKey({
        dependentId: dependent.id,
        blockerIds: all.map((b) => b.id),
        blockedTransitionAt: dependent.blocked_transition_at,
      }),
    });
  }

  /** Fires after an issue reaches done/cancelled: dependency wakes + parent completion. */
  private afterResolution(row: IssueRow): void {
    for (const dependent of this.dependentsOf(row.id)) {
      this.maybeEmitBlockersResolved(dependent);
    }
    if (row.parent_id) {
      const siblings = this.db
        .prepare("SELECT id, identifier, status, title FROM issues WHERE parent_id = ?")
        .all(row.parent_id) as Array<{ id: string; identifier: string; status: string; title: string }>;
      const open = siblings.filter(
        (s) => !(RESOLVED_STATUSES as readonly string[]).includes(s.status),
      );
      if (open.length === 0 && siblings.length > 0) {
        const parent = this.db
          .prepare("SELECT * FROM issues WHERE id = ?")
          .get(row.parent_id) as unknown as IssueRow | undefined;
        if (parent && !(RESOLVED_STATUSES as readonly string[]).includes(parent.status)) {
          this.emitEvent({
            kind: "children_complete",
            issueId: parent.id,
            payload: {
              identifier: parent.identifier,
              assignee: parent.assignee,
              children: siblings.map((s) => ({
                identifier: s.identifier,
                title: s.title,
                status: s.status,
              })),
            },
            dedupKey: childrenCompleteDedupKey(
              parent.id,
              siblings.map((s) => s.id),
            ),
          });
        }
      }
    }
  }

  // ---------- update ----------

  updateIssue(ref: string, patch: UpdateIssueInput, actor?: string | null): Issue {
    if (patch.status) assertStatus(patch.status);
    if (patch.priority) assertPriority(patch.priority);
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (
        patch.expectedStatusVersion !== undefined &&
        patch.expectedStatusVersion !== row.status_version
      ) {
        throw new StapleError(
          "conflict",
          `Status version mismatch: expected ${patch.expectedStatusVersion}, current ${row.status_version}. Re-read the issue first.`,
          { currentStatusVersion: row.status_version, currentStatus: row.status },
        );
      }

      const now = nowIso();
      const next: Record<string, unknown> = { updated_at: now };
      if (patch.title !== undefined) {
        const title = patch.title.trim();
        if (!title) throw new StapleError("validation", "Title cannot be empty");
        next.title = title;
        next.normalized_title = normalizeTitle(title);
      }
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.priority !== undefined) next.priority = patch.priority;
      if (patch.assignee !== undefined) next.assignee = patch.assignee;
      if (patch.labels !== undefined) next.labels = JSON.stringify(patch.labels);
      if (patch.acceptanceCriteria !== undefined) {
        next.acceptance_criteria = JSON.stringify(patch.acceptanceCriteria);
      }

      const statusAfter = patch.status ?? (row.status as IssueStatus);
      const statusChanging = patch.status !== undefined && patch.status !== row.status;

      if ((patch.unblockOwner !== undefined || patch.unblockAction !== undefined) &&
          statusAfter !== "blocked") {
        throw new StapleError("validation", "unblockOwner/unblockAction require status \"blocked\"");
      }

      if (statusChanging) {
        const assigneeAfter =
          patch.assignee !== undefined ? patch.assignee : row.assignee;
        if (patch.status === "in_progress") {
          if (!assigneeAfter) {
            throw new StapleError("validation", "in_progress requires an assignee");
          }
          const unresolved = this.unresolvedBlockersOf(row.id);
          if (unresolved.length > 0) {
            throw new StapleError(
              "validation",
              `Cannot start: unresolved blockers ${unresolved.map((b) => b.identifier).join(", ")}`,
              { blockers: unresolved.map((b) => b.identifier) },
            );
          }
          next.started_at = row.started_at ?? now;
        }
        if (patch.status === "done") next.completed_at = now;
        if (patch.status === "cancelled") next.cancelled_at = now;
        if (patch.status === "blocked") {
          next.blocked_transition_at = now;
          if (patch.unblockOwner !== undefined) next.unblock_owner = patch.unblockOwner;
          if (patch.unblockAction !== undefined) next.unblock_action = patch.unblockAction;
        }
        if (row.status === "blocked" && patch.status !== "blocked") {
          next.unblock_owner = null;
          next.unblock_action = null;
          next.blocked_transition_at = null;
        }
        if (row.status === "in_progress" && patch.status !== "in_progress") {
          next.checkout_agent = null;
          next.checkout_at = null;
        }
        next.status = patch.status;
        next.status_version = row.status_version + 1;
      } else if (statusAfter === "blocked") {
        if (patch.unblockOwner !== undefined) next.unblock_owner = patch.unblockOwner;
        if (patch.unblockAction !== undefined) next.unblock_action = patch.unblockAction;
      }

      const columns = Object.keys(next);
      const updated = this.db
        .prepare(
          `UPDATE issues SET ${columns.map((c) => `${c} = ?`).join(", ")} WHERE id = ? RETURNING *`,
        )
        .get(...columns.map((c) => next[c] as never), row.id) as unknown as IssueRow;

      if (statusChanging) {
        this.emitEvent({
          kind: "status_changed",
          issueId: row.id,
          actor,
          payload: { identifier: row.identifier, from: row.status, to: patch.status },
        });
        if ((RESOLVED_STATUSES as readonly string[]).includes(patch.status!)) {
          this.afterResolution(updated);
        }
      }
      if (patch.comment) {
        this.insertComment(row.id, actor ?? "unknown", actor ? "agent" : "system", patch.comment);
      }
      return rowToIssue(updated);
    });
  }

  // ---------- claim liveness (derived, never stored) ----------

  /**
   * Newest timestamp the HOLDER produced on this issue: their own events and
   * their own comments, floored at the checkout itself. One query, computed at
   * read time — there is no `last_activity_at` column and deliberately so, since
   * every write path would have to remember to touch it.
   *
   * Only `actor = holder` / `author = holder` rows count. Another agent
   * commenting on your ticket must not make a dead holder look alive.
   */
  private lastActivityOf(issueId: string, holder: string, checkoutAt: string): string {
    const row = this.db
      .prepare(
        `SELECT MAX(t) AS t FROM (
           SELECT MAX(created_at) AS t FROM events   WHERE issue_id = ? AND actor  = ?
           UNION ALL
           SELECT MAX(created_at) AS t FROM comments WHERE issue_id = ? AND author = ? AND deleted_at IS NULL
         )`,
      )
      .get(issueId, holder, issueId, holder) as { t: string | null } | undefined;
    const newest = row?.t ?? null;
    // ISO-8601 UTC from nowIso() sorts lexicographically == chronologically.
    return newest && newest > checkoutAt ? newest : checkoutAt;
  }

  private claimActivityOfRow(row: IssueRow, now: string = nowIso()): ClaimActivity | null {
    if (row.status !== "in_progress" || !row.checkout_agent || !row.checkout_at) return null;
    const lastActivityAt = this.lastActivityOf(row.id, row.checkout_agent, row.checkout_at);
    return {
      heldBy: row.checkout_agent,
      checkoutAt: row.checkout_at,
      lastActivityAt,
      heldSeconds: secondsBetween(row.checkout_at, now),
      idleSeconds: secondsBetween(lastActivityAt, now),
    };
  }

  /** Liveness for one issue; null when nobody is holding it. */
  claimActivity(ref: string): ClaimActivity | null {
    return this.claimActivityOfRow(this.requireRow(ref));
  }

  /**
   * Batch liveness for a list, keyed by issue id — mirrors unresolvedBlockersFor:
   * ONE query for a whole page instead of N+1. Ids that are not held are simply
   * absent from the map.
   */
  claimActivityFor(issueIds: string[]): Map<string, ClaimActivity> {
    const out = new Map<string, ClaimActivity>();
    if (issueIds.length === 0) return out;
    const now = nowIso();
    const placeholders = issueIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT i.id AS id, i.checkout_agent AS holder, i.checkout_at AS checkout_at,
                MAX(COALESCE(a.t, i.checkout_at)) AS last_activity_at
           FROM issues i
           LEFT JOIN (
             SELECT e.issue_id AS issue_id, e.actor AS who, e.created_at AS t FROM events e
             UNION ALL
             SELECT c.issue_id AS issue_id, c.author AS who, c.created_at AS t
               FROM comments c WHERE c.deleted_at IS NULL
           ) a ON a.issue_id = i.id AND a.who = i.checkout_agent
          WHERE i.id IN (${placeholders})
            AND i.status = 'in_progress'
            AND i.checkout_agent IS NOT NULL
            AND i.checkout_at IS NOT NULL
          GROUP BY i.id`,
      )
      .all(...(issueIds as never[])) as Array<{
      id: string;
      holder: string;
      checkout_at: string;
      last_activity_at: string;
    }>;
    for (const row of rows) {
      const lastActivityAt =
        row.last_activity_at > row.checkout_at ? row.last_activity_at : row.checkout_at;
      out.set(row.id, {
        heldBy: row.holder,
        checkoutAt: row.checkout_at,
        lastActivityAt,
        heldSeconds: secondsBetween(row.checkout_at, now),
        idleSeconds: secondsBetween(lastActivityAt, now),
      });
    }
    return out;
  }

  // ---------- checkout / release ----------

  /**
   * Atomic claim, Paperclip semantics: wins iff status is in expectedStatuses
   * AND no unresolved blockers — otherwise a conflict that callers must treat
   * as "pick a different task", never retry. Idempotent when the same agent
   * already holds the issue.
   *
   * `stealIfIdleSeconds` opts into ONE extra, explicit outcome: if the issue is
   * held by someone else whose last activity is at least that old, take it. This
   * is the only way a claim ever changes hands without its holder releasing it,
   * and nothing invokes it on its own — no sweeper, no TTL, no daemon. A caller
   * passes it because a human said "that agent is dead, continue".
   */
  checkoutIssue(
    ref: string,
    agent: string,
    expectedStatuses: readonly IssueStatus[] = DEFAULT_CHECKOUT_EXPECTED,
    opts: { stealIfIdleSeconds?: number } = {},
  ): Issue {
    if (!agent?.trim()) throw new StapleError("validation", "agent is required for checkout");
    for (const status of expectedStatuses) assertStatus(status);
    const stealIfIdleSeconds = assertIdleThreshold(opts.stealIfIdleSeconds, "stealIfIdleSeconds");
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (row.status === "in_progress" && row.checkout_agent === agent) {
        return rowToIssue(row); // crash-recovery re-claim
      }
      const now = nowIso();
      const placeholders = expectedStatuses.map(() => "?").join(",");
      const claimed = this.db
        .prepare(
          `UPDATE issues SET
             status = 'in_progress',
             status_version = status_version + 1,
             assignee = ?,
             checkout_agent = ?,
             checkout_at = ?,
             started_at = COALESCE(started_at, ?),
             unblock_owner = NULL, unblock_action = NULL, blocked_transition_at = NULL,
             updated_at = ?
           WHERE id = ? AND status IN (${placeholders})
             AND NOT EXISTS (
               SELECT 1 FROM relations r JOIN issues b ON b.id = r.blocker_id
               WHERE r.blocked_id = issues.id AND r.type = 'blocks'
                 AND b.status NOT IN ${RESOLVED_SQL}
             )
           RETURNING *`,
        )
        .get(agent, agent, now, now, now, row.id, ...expectedStatuses) as unknown as IssueRow | undefined;
      if (!claimed) {
        const unresolved = this.unresolvedBlockersOf(row.id).map((b) => b.identifier);
        // Explicit takeover. Blockers still win: taking over dead work must not
        // bypass a dependency the dead agent was correctly waiting on.
        if (stealIfIdleSeconds !== undefined && unresolved.length === 0) {
          const claim = this.claimActivityOfRow(row, now);
          if (claim) {
            if (claim.idleSeconds >= stealIfIdleSeconds) {
              /**
               * Compare-and-swap on the HOLDER, not just the id: two agents
               * racing to rescue the same dead claim both see it as stale, but
               * only one UPDATE matches `checkout_agent = <previousHolder>`. The
               * loser gets 0 rows and falls through to a conflict built from the
               * re-read row, naming the winner — never a silent double-steal.
               */
              const stolen = this.db
                .prepare(
                  `UPDATE issues SET
                     status = 'in_progress',
                     status_version = status_version + 1,
                     assignee = ?,
                     checkout_agent = ?,
                     checkout_at = ?,
                     started_at = COALESCE(started_at, ?),
                     unblock_owner = NULL, unblock_action = NULL, blocked_transition_at = NULL,
                     updated_at = ?
                   WHERE id = ? AND status = 'in_progress' AND checkout_agent = ?
                   RETURNING *`,
                )
                .get(agent, agent, now, now, now, row.id, claim.heldBy) as unknown as
                | IssueRow
                | undefined;
              if (stolen) {
                /**
                 * A steal emits ONLY `claim_stolen` — never also `checkout`. One
                 * transition, one event, strictly more information: a timeline
                 * consumer gets an unambiguous takeover marker instead of a
                 * checkout it would have to infer was hostile.
                 */
                this.emitEvent({
                  kind: "claim_stolen",
                  issueId: row.id,
                  actor: agent,
                  payload: {
                    identifier: row.identifier,
                    previousHolder: claim.heldBy,
                    previousLastActivityAt: claim.lastActivityAt,
                    previousIdleSeconds: claim.idleSeconds,
                    stealIfIdleSeconds,
                  },
                });
                return rowToIssue(stolen);
              }
            }
            // Too fresh to steal, or we lost the race — refuse against whatever
            // the CURRENT state is, so the sentence never names a stale holder.
            const current = this.claimActivityOfRow(this.requireRow(ref), now) ?? claim;
            throw new StapleError("conflict", claimGuardMessage("Checkout", current), {
              currentStatus: "in_progress",
              heldBy: current.heldBy,
              blockers: [],
              lastActivityAt: current.lastActivityAt,
              idleSeconds: current.idleSeconds,
              heldSeconds: current.heldSeconds,
              stealIfIdleSeconds,
            });
          }
        }
        throw new StapleError(
          "conflict",
          unresolved.length > 0
            ? `Checkout refused: unresolved blockers ${unresolved.join(", ")}. Pick a different task.`
            : `Checkout refused: status is "${row.status}"${row.checkout_agent ? ` (held by ${row.checkout_agent})` : ""}, expected one of ${expectedStatuses.join(", ")}. Pick a different task — do not retry.`,
          { currentStatus: row.status, heldBy: row.checkout_agent, blockers: unresolved },
        );
      }
      this.emitEvent({
        kind: "checkout",
        issueId: row.id,
        actor: agent,
        payload: { identifier: row.identifier },
      });
      return rowToIssue(claimed);
    });
  }

  /**
   * Give a claim back. `ifIdleSeconds` turns this into the explicit
   * release-if-stale affordance: free a claim held by an agent that has been
   * silent at least that long. Passing it means "only if it is genuinely idle",
   * so the idleness gate is applied to the CURRENT HOLDER whoever asks — and it
   * stands in for the ownership check, since freeing a dead agent's claim is the
   * entire point. Without it, behaviour is exactly as before.
   */
  releaseIssue(ref: string, agent?: string | null, opts: { ifIdleSeconds?: number } = {}): Issue {
    const ifIdleSeconds = assertIdleThreshold(opts.ifIdleSeconds, "ifIdleSeconds");
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (row.status !== "in_progress") {
        throw new StapleError("conflict", `Cannot release: status is "${row.status}"`);
      }
      const claim = ifIdleSeconds === undefined ? null : this.claimActivityOfRow(row);
      if (ifIdleSeconds !== undefined) {
        // Same guard, same sentence shape as the checkout steal — one formatter,
        // so the two refusals can never drift apart.
        if (!claim || claim.idleSeconds < ifIdleSeconds) {
          throw new StapleError(
            "conflict",
            claimGuardMessage("Release", claim ?? this.claimActivityOfRow(row)!),
            {
              currentStatus: row.status,
              heldBy: row.checkout_agent,
              lastActivityAt: claim?.lastActivityAt,
              idleSeconds: claim?.idleSeconds,
              heldSeconds: claim?.heldSeconds,
              ifIdleSeconds,
            },
          );
        }
      } else if (agent && row.checkout_agent && row.checkout_agent !== agent) {
        throw new StapleError(
          "conflict",
          `Cannot release: held by ${row.checkout_agent}, not ${agent}`,
        );
      }
      const updated = this.db
        .prepare(
          `UPDATE issues SET status = 'todo', status_version = status_version + 1,
             checkout_agent = NULL, checkout_at = NULL, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(nowIso(), row.id) as unknown as IssueRow;
      // Dedicated event for the stale path, mirroring claim_stolen: a plain
      // `release` cannot say whose claim was cut short, or how dead it looked.
      this.emitEvent(
        claim
          ? {
              kind: "claim_released_stale",
              issueId: row.id,
              actor: agent ?? null,
              payload: {
                identifier: row.identifier,
                previousHolder: claim.heldBy,
                previousLastActivityAt: claim.lastActivityAt,
                previousIdleSeconds: claim.idleSeconds,
                ifIdleSeconds,
              },
            }
          : {
              kind: "release",
              issueId: row.id,
              actor: agent ?? null,
              payload: { identifier: row.identifier },
            },
      );
      return rowToIssue(updated);
    });
  }

  // ---------- comments ----------

  private insertComment(
    issueId: string,
    author: string,
    authorType: string,
    body: string,
    idempotencyKey: string | null = null,
  ): IssueComment {
    const id = newId();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO comments (id, issue_id, author, author_type, body, idempotency_key, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(id, issueId, author, authorType, body, idempotencyKey, now);
    this.emitEvent({
      kind: "comment_added",
      issueId,
      actor: author,
      payload: { commentId: id, preview: body.slice(0, 120) },
    });
    return {
      id,
      issueId,
      author,
      authorType: authorType as never,
      body,
      idempotencyKey,
      deletedAt: null,
      createdAt: now,
    };
  }

  addComment(
    ref: string,
    body: string,
    author = "user",
    authorType: "user" | "agent" | "system" = "user",
    opts: { idempotencyKey?: string | null } = {},
  ): IssueComment {
    return this.addCommentResult(ref, body, author, authorType, opts).comment;
  }

  /**
   * addComment, plus whether an idempotency key replayed an earlier comment.
   * The key is scoped to the issue (partial unique index), so the same retry
   * token used on two different issues posts to both — which is what a caller
   * retrying two distinct calls means.
   */
  addCommentResult(
    ref: string,
    body: string,
    author = "user",
    authorType: "user" | "agent" | "system" = "user",
    opts: { idempotencyKey?: string | null } = {},
  ): AddCommentResult {
    if (!body?.trim()) throw new StapleError("validation", "Comment body is required");
    const key = opts.idempotencyKey?.trim() || null;
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (key) {
        const existing = this.db
          .prepare("SELECT * FROM comments WHERE issue_id = ? AND idempotency_key = ?")
          .get(row.id, key) as CommentRow | undefined;
        if (existing) return { comment: rowToComment(existing), replayed: true };
      }
      return { comment: this.insertComment(row.id, author, authorType, body, key), replayed: false };
    });
  }

  listComments(ref: string, limit = 100): IssueComment[] {
    const row = this.requireRow(ref);
    const rows = this.db
      .prepare(
        `SELECT * FROM comments WHERE issue_id = ? AND deleted_at IS NULL
         ORDER BY created_at, rowid LIMIT ?`,
      )
      .all(row.id, limit) as unknown as CommentRow[];
    return rows.map(rowToComment);
  }

  /** One page of listComments. Comments are append-only, so offsets stay stable. */
  listCommentsPage(
    ref: string,
    page: { limit: number; offset: number },
  ): { items: IssueComment[]; hasMore: boolean } {
    const row = this.requireRow(ref);
    const rows = this.db
      .prepare(
        `SELECT * FROM comments WHERE issue_id = ? AND deleted_at IS NULL
         ORDER BY created_at, rowid LIMIT ? OFFSET ?`,
      )
      .all(row.id, page.limit + 1, page.offset) as unknown as CommentRow[];
    return { items: rows.slice(0, page.limit).map(rowToComment), hasMore: rows.length > page.limit };
  }

  // ---------- documents (keyed, revisioned) ----------

  putDocument(
    ref: string,
    key: string,
    body: string,
    opts: {
      baseRevision?: number | null;
      author?: string | null;
      changeSummary?: string | null;
      title?: string | null;
    } = {},
  ): { key: string; revision: number } {
    const cleanKey = key.trim().toLowerCase();
    if (!/^[a-z0-9._-]{1,64}$/.test(cleanKey)) {
      throw new StapleError("validation", "Document key must be 1-64 chars of a-z 0-9 . _ -");
    }
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      const current = this.db
        .prepare("SELECT current_revision FROM documents WHERE issue_id = ? AND key = ?")
        .get(row.id, cleanKey) as { current_revision: number } | undefined;
      const currentRevision = current?.current_revision ?? 0;
      if (opts.baseRevision != null && opts.baseRevision !== currentRevision) {
        throw new StapleError(
          "revision_conflict",
          `Document "${cleanKey}" is at revision ${currentRevision}, not ${opts.baseRevision}. Re-read it and merge before writing.`,
          { currentRevision },
        );
      }
      const revision = currentRevision + 1;
      const now = nowIso();
      this.db
        .prepare(
          `INSERT INTO document_revisions (issue_id, key, revision, body, author, change_summary, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        )
        .run(row.id, cleanKey, revision, body, opts.author ?? null, opts.changeSummary ?? null, now);
      this.db
        .prepare(
          `INSERT INTO documents (issue_id, key, current_revision, title, updated_at)
           VALUES (?,?,?,?,?)
           ON CONFLICT(issue_id, key) DO UPDATE SET
             current_revision = excluded.current_revision,
             title = COALESCE(excluded.title, documents.title),
             updated_at = excluded.updated_at`,
        )
        .run(row.id, cleanKey, revision, opts.title ?? null, now);
      this.emitEvent({
        kind: "doc_updated",
        issueId: row.id,
        actor: opts.author ?? null,
        payload: { key: cleanKey, revision, changeSummary: opts.changeSummary ?? null },
      });
      return { key: cleanKey, revision };
    });
  }

  getDocument(
    ref: string,
    key: string,
    revision?: number,
  ): { key: string; revision: number; body: string; title: string | null; author: string | null; createdAt: string } {
    const row = this.requireRow(ref);
    const meta = this.db
      .prepare("SELECT * FROM documents WHERE issue_id = ? AND key = ?")
      .get(row.id, key.trim().toLowerCase()) as
      | { key: string; current_revision: number; title: string | null }
      | undefined;
    if (!meta) throw new StapleError("not_found", `No document "${key}" on ${row.identifier}`);
    const target = revision ?? meta.current_revision;
    const rev = this.db
      .prepare(
        "SELECT * FROM document_revisions WHERE issue_id = ? AND key = ? AND revision = ?",
      )
      .get(row.id, meta.key, target) as
      | { body: string; author: string | null; created_at: string }
      | undefined;
    if (!rev) throw new StapleError("not_found", `No revision ${target} of "${key}"`);
    return {
      key: meta.key,
      revision: target,
      body: rev.body,
      title: meta.title,
      author: rev.author,
      createdAt: rev.created_at,
    };
  }

  listDocuments(ref: string): IssueDocumentMeta[] {
    const row = this.requireRow(ref);
    const rows = this.db
      .prepare("SELECT * FROM documents WHERE issue_id = ? ORDER BY key")
      .all(row.id) as Array<{
      issue_id: string;
      key: string;
      current_revision: number;
      title: string | null;
      updated_at: string;
    }>;
    return rows.map((r) => ({
      issueId: r.issue_id,
      key: r.key,
      currentRevision: r.current_revision,
      title: r.title,
      updatedAt: r.updated_at,
    }));
  }

  listDocumentRevisions(
    ref: string,
    key: string,
  ): Array<{ revision: number; author: string | null; changeSummary: string | null; createdAt: string }> {
    const row = this.requireRow(ref);
    return (
      this.db
        .prepare(
          `SELECT revision, author, change_summary, created_at FROM document_revisions
           WHERE issue_id = ? AND key = ? ORDER BY revision DESC`,
        )
        .all(row.id, key.trim().toLowerCase()) as Array<{
        revision: number;
        author: string | null;
        change_summary: string | null;
        created_at: string;
      }>
    ).map((r) => ({
      revision: r.revision,
      author: r.author,
      changeSummary: r.change_summary,
      createdAt: r.created_at,
    }));
  }

  restoreDocumentRevision(ref: string, key: string, revision: number, author?: string): { key: string; revision: number } {
    const old = this.getDocument(ref, key, revision);
    return this.putDocument(ref, key, old.body, {
      author: author ?? null,
      changeSummary: `restore revision ${revision}`,
    });
  }

  // ---------- queries ----------

  listIssues(filters: IssueFilters = {}): Issue[] {
    const { sql, params } = this.issuesQuery(filters);
    return (this.db.prepare(sql).all(...(params as never[])) as unknown as IssueRow[]).map(rowToIssue);
  }

  /**
   * One page of listIssues. Reads limit + 1 rows so hasMore costs nothing extra
   * (no second COUNT), then trims. Ordering is the same computed rank as
   * listIssues, which is why the page is addressed by offset — see the cursor
   * note in types.ts.
   */
  listIssuesPage(filters: IssueFilters, page: { limit: number; offset: number }): {
    items: Issue[];
    hasMore: boolean;
  } {
    const { sql, params } = this.issuesQuery(filters);
    const rows = this.db
      .prepare(`${sql} LIMIT ? OFFSET ?`)
      .all(...([...params, page.limit + 1, page.offset] as never[])) as unknown as IssueRow[];
    return { items: rows.slice(0, page.limit).map(rowToIssue), hasMore: rows.length > page.limit };
  }

  private issuesQuery(filters: IssueFilters = {}): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filters.status && filters.status.length > 0) {
      where.push(`status IN (${filters.status.map(() => "?").join(",")})`);
      params.push(...filters.status);
    } else if (!filters.includeResolved) {
      where.push(`status NOT IN ${RESOLVED_SQL}`);
    }
    if (filters.assignee) {
      where.push("assignee = ?");
      params.push(filters.assignee);
    }
    if (filters.parent !== undefined) {
      if (filters.parent === null) where.push("parent_id IS NULL");
      else {
        where.push("parent_id = ?");
        params.push(this.requireRow(filters.parent).id);
      }
    }
    if (filters.q) {
      where.push("(title LIKE ? OR identifier LIKE ? OR description LIKE ?)");
      const like = `%${filters.q}%`;
      params.push(like, like, like);
    }
    const sql = `SELECT * FROM issues ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        CASE status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'blocked' THEN 2
          WHEN 'todo' THEN 3 WHEN 'backlog' THEN 4 WHEN 'done' THEN 5 ELSE 6 END,
        CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
        created_at,
        rowid`;
    // rowid breaks created_at ties in insertion order. Without it two issues
    // written in the same millisecond order arbitrarily, which offset paging
    // turns into a skipped or duplicated row.
    return { sql, params };
  }

  /**
   * Agent inbox: ready work in pickup order (in_progress -> in_review -> todo
   * -> backlog), dependency-aware — an issue with unresolved blockers is not
   * ready even if its status says todo. Blocked work is listed separately.
   */
  inbox(
    assignee?: string,
    page?: { limit: number; offset: number },
  ): {
    ready: Array<Issue & { unresolvedBlockers: string[] }>;
    blocked: Array<Issue & { unresolvedBlockers: string[] }>;
    hasMore: boolean;
  } {
    const filters: IssueFilters = assignee ? { assignee } : {};
    // ready/blocked partition ONE window over the open issues, so the page is
    // over the scan, not over either list.
    const { items, hasMore } = page
      ? this.listIssuesPage(filters, page)
      : { items: this.listIssues(filters), hasMore: false };
    const blockersByIssue = this.unresolvedBlockersFor(items.map((i) => i.id));
    const ready: Array<Issue & { unresolvedBlockers: string[] }> = [];
    const blocked: Array<Issue & { unresolvedBlockers: string[] }> = [];
    for (const issue of items) {
      const unresolved = blockersByIssue.get(issue.id) ?? [];
      const entry = { ...issue, unresolvedBlockers: unresolved };
      if (issue.status === "blocked" || unresolved.length > 0) blocked.push(entry);
      else ready.push(entry);
    }
    return { ready, blocked, hasMore };
  }

  /**
   * Issue + everything an agent needs to act: ancestry, children, relations,
   * comments, docs. Document BODIES are opt-in (`includeDocuments`) — they are
   * the largest thing in this payload and most callers only need to know which
   * documents exist before fetching one.
   */
  context(
    ref: string,
    opts: { includeDocuments?: boolean } = {},
  ): {
    issue: Issue;
    ancestors: Issue[];
    children: Issue[];
    blockedBy: Array<{ identifier: string; title: string; status: IssueStatus }>;
    blocks: Array<{ identifier: string; title: string; status: IssueStatus }>;
    comments: IssueComment[];
    documents: Array<IssueDocumentMeta & { body?: string }>;
  } {
    const row = this.requireRow(ref);
    const ancestors: Issue[] = [];
    let cursor = row.parent_id;
    let hops = 0;
    while (cursor && hops < MAX_TREE_DEPTH) {
      const parent = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(cursor) as
        | IssueRow
        | undefined;
      if (!parent) break;
      ancestors.unshift(rowToIssue(parent));
      cursor = parent.parent_id;
      hops += 1;
    }
    const children = (
      this.db
        .prepare("SELECT * FROM issues WHERE parent_id = ? ORDER BY created_at")
        .all(row.id) as unknown as IssueRow[]
    ).map(rowToIssue);
    const toRef = (r: IssueRow) => ({
      identifier: r.identifier,
      title: r.title,
      status: r.status as IssueStatus,
    });
    const documents: Array<IssueDocumentMeta & { body?: string }> = this.listDocuments(row.id);
    return {
      issue: rowToIssue(row),
      ancestors,
      children,
      blockedBy: this.blockersOf(row.id).map(toRef),
      blocks: this.dependentsOf(row.id).map(toRef),
      comments: this.listComments(row.id, 20),
      documents: opts.includeDocuments
        ? documents.map((doc) => ({ ...doc, body: this.getDocument(row.id, doc.key).body }))
        : documents,
    };
  }

  /** Nested subtree (or all roots when no ref given). */
  tree(ref?: string): Array<{ issue: Issue; children: unknown[] }> {
    const build = (parentId: string | null, depth: number): Array<{ issue: Issue; children: unknown[] }> => {
      if (depth > MAX_TREE_DEPTH) return [];
      const rows = this.db
        .prepare(
          parentId === null
            ? "SELECT * FROM issues WHERE parent_id IS NULL ORDER BY created_at"
            : "SELECT * FROM issues WHERE parent_id = ? ORDER BY created_at",
        )
        .all(...(parentId === null ? [] : [parentId])) as unknown as IssueRow[];
      return rows.map((r) => ({ issue: rowToIssue(r), children: build(r.id, depth + 1) }));
    };
    if (ref) {
      const row = this.requireRow(ref);
      return [{ issue: rowToIssue(row), children: build(row.id, 1) }];
    }
    return build(null, 0);
  }

  /** All blocks edges, for graph rendering. */
  edges(): Array<{ blocker: string; blocked: string }> {
    const rows = this.db
      .prepare(
        `SELECT b.identifier AS blocker, d.identifier AS blocked
         FROM relations r
         JOIN issues b ON b.id = r.blocker_id
         JOIN issues d ON d.id = r.blocked_id
         WHERE r.type = 'blocks'`,
      )
      .all() as Array<{ blocker: string; blocked: string }>;
    return rows;
  }
}
