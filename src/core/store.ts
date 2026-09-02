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
  ISSUE_STATUSES,
  type IssueTiming,
  MAX_TREE_DEPTH,
  RESOLVED_STATUSES,
  StapleError,
  type StapleEvent,
  assertEstimateSeconds,
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
  /** Plan-time estimate in whole seconds; omit or null for none. */
  estimatedSeconds?: number | null;
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
  /**
   * Same three-state convention every other nullable patch field uses (see
   * `assignee`): absent leaves the estimate alone, a number sets it, and an
   * explicit null clears it. There is no in-band "clear" value — 0 is a
   * validation error precisely so that an accidental empty/unset variable
   * cannot masquerade as a deliberate erase.
   */
  estimatedSeconds?: number | null;
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
  estimated_seconds: number | null;
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
    // SQLite hands back whatever was stored; a legacy row is NULL, never 0.
    estimatedSeconds: row.estimated_seconds ?? null,
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
 * Every event kind that MOVES an issue's status — the replay's input filter, and
 * a list that must stay exhaustive.
 *
 * If a new status-writing site is added to this file without adding its event
 * kind here, the replay silently stops reproducing the row's status, every
 * affected issue quietly degrades to `approximate`, and the numbers get worse
 * without anything failing. `test/store-timing.test.ts` pins the set against the
 * store's actual behaviour precisely because a stale list here is invisible.
 *
 * See `WorkspaceStore.statusAfterEvent` for what each one means.
 */
const STATUS_MOVING_EVENT_KINDS = [
  "issue_created",
  "status_changed",
  "checkout",
  "claim_stolen",
  "release",
  "claim_released_stale",
] as const;

/**
 * What the interval replay produces for ONE issue, before rollups: the issue's
 * own numbers with no opinion yet about children.
 */
interface OwnTiming {
  ownActiveSeconds: number | null;
  reviewSeconds: number | null;
  approximate: boolean;
  countedThrough: string | null;
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
    // Validated BEFORE the transaction, like priority and status above: a bad
    // estimate must not be discovered halfway through a create that has already
    // consumed an issue number.
    const estimatedSeconds =
      input.estimatedSeconds == null ? null : assertEstimateSeconds(input.estimatedSeconds);

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
             idempotency_key, blocked_transition_at, estimated_seconds, started_at,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
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
          estimatedSeconds,
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
      // Transition site 1 of 4: born in_progress under a parent. Rare, but it is
      // still a child entering in_progress, and the rule is about state, not
      // about which call produced it.
      if (status === "in_progress") {
        this.markAncestorsInProgress(row, input.createdBy ?? null);
      }
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

  /**
   * Fires after an issue ENTERS `in_progress`: every ancestor still sitting in a
   * pre-work status starts reading as in_progress too, so an epic whose children
   * are being worked stops reporting `backlog`. (STA-79.)
   *
   * ## This is a derivation, not a claim — and that is why it skips the guard
   *
   * Starting work normally requires an assignee and zero unresolved blockers.
   * Both rules are deliberately NOT applied here, and the exemption is explicit:
   * this method writes the ancestor row itself instead of routing through
   * `updateIssue`, precisely so the bypass is visible at the write rather than
   * hidden behind a flag threaded through the guard.
   *
   * The guard governs *permission to claim*. This status is a *report*.
   *
   * - **Assignee.** An epic has none and usually should not — nobody claims an
   *   epic, they claim its children. Synthesising one would be a lie with teeth:
   *   the epic would look held, would surface in that agent's assigned work, and
   *   would acquire claim liveness. So `assignee`, `checkout_agent` and
   *   `checkout_at` are all left exactly as they were. That is load-bearing —
   *   `claimActivityOfRow` returns null without a `checkout_agent`, so a derived
   *   ancestor can never look held, never look stale, and can never be stolen.
   * - **Blockers.** A blocker answers "may this be started". It does not make the
   *   observed fact — work IS happening underneath — untrue. Refusing the flip
   *   there would reinstate exactly the lie this exists to remove.
   *
   * Manual and direct transitions keep the guard untouched. Only this
   * system-driven path is exempt.
   *
   * ## What is left alone
   *
   * Only `backlog` and `todo` ancestors move. `in_progress` has nothing to say;
   * `in_review` and `done` are AHEAD of the child and must not be rewound;
   * `cancelled` is terminal; and `blocked` is a statement the user made about an
   * epic being worked around — a derivation does not overrule a human.
   *
   * The walk CONTINUES past an untouched ancestor rather than stopping at it.
   * Stopping would make the outcome depend on history: an epic parked in
   * `in_review` would permanently shield its own parent from ever flipping.
   * Continuing keeps the rule level-triggered — a function of current state only.
   *
   * Note what is deliberately absent: there is no mirror-image rule closing an
   * ancestor when its children finish. `children_complete` already announces
   * that, and epic closure stays a deliberate human act.
   *
   * Runs inside the caller's transaction, so the ancestor flip commits with the
   * child's own transition — no window where the child is in_progress and the
   * epic still reads backlog.
   */
  private markAncestorsInProgress(
    child: Pick<IssueRow, "id" | "identifier" | "parent_id">,
    actor: string | null,
  ): void {
    const now = nowIso();
    // Iterative, bounded, and cycle-proof: `createIssue` caps depth, but a walk
    // over possibly-corrupt `parent_id` links should not be the thing that hangs.
    const seen = new Set<string>([child.id]);
    let cursor = child.parent_id;
    let hops = 0;
    while (cursor && hops < MAX_TREE_DEPTH && !seen.has(cursor)) {
      seen.add(cursor);
      const ancestor = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(cursor) as unknown as
        | IssueRow
        | undefined;
      if (!ancestor) break;
      if (ancestor.status === "backlog" || ancestor.status === "todo") {
        const result = this.db
          .prepare(
            `UPDATE issues SET
               status = 'in_progress',
               status_version = status_version + 1,
               started_at = COALESCE(started_at, ?),
               updated_at = ?
             WHERE id = ? AND status IN ('backlog', 'todo')`,
          )
          .run(now, now, ancestor.id);
        // Gate the event on the write, so an event can never claim a flip that
        // did not land. `status_version` bumps because anyone holding an
        // `expectedStatusVersion` for this epic must be forced to re-read.
        if (Number(result.changes) > 0) {
          /**
           * Reuses `status_changed` rather than minting a kind, for a concrete
           * reason: the UI timeline already renders `status_changed` as
           * "status backlog → in_progress", while an unknown kind falls to its
           * fail-soft branch and prints raw underscore-prose. Reuse renders
           * correctly with no UI change; `derived`/`derivedFrom` are additive,
           * and they are what tells a consumer this was not a human acting on
           * the epic. The actor is the child's actor, because they caused it.
           *
           * No dedupKey, matching every other `status_changed` — and none is
           * needed, since the flip only ever fires from backlog/todo and so
           * cannot repeat without an intervening transition out of in_progress.
           */
          this.emitEvent({
            kind: "status_changed",
            issueId: ancestor.id,
            actor,
            payload: {
              identifier: ancestor.identifier,
              from: ancestor.status,
              to: "in_progress",
              derived: "child_started",
              derivedFrom: child.identifier,
            },
          });
        }
      }
      cursor = ancestor.parent_id;
      hops += 1;
    }
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
      // Three-state, exactly like assignee above: absent -> untouched,
      // null -> cleared, number -> validated and set.
      if (patch.estimatedSeconds !== undefined) {
        next.estimated_seconds =
          patch.estimatedSeconds === null ? null : assertEstimateSeconds(patch.estimatedSeconds);
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
        // Transition site 2 of 4. Guarded above like any manual start; the
        // ancestors it derives from that start are not (see the method).
        if (patch.status === "in_progress") {
          this.markAncestorsInProgress(updated, actor ?? null);
        }
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

  // ---------- estimate vs actual (derived, never stored) ----------

  /**
   * The status an event leaves the issue in, or null if it is not a transition
   * this replay can read.
   *
   * ## Why this is a table and not "`status_changed` events"
   *
   * The obvious implementation of interval reconstruction reads `status_changed`
   * and nothing else. It is wrong, and it is wrong in the direction that hurts
   * most: `checkoutIssue` sets `status = 'in_progress'` in its own atomic UPDATE
   * and emits `checkout`, never `status_changed` — and `staple checkout` is HOW
   * WORK STARTS. A replay that watched only `status_changed` would miss the
   * beginning of nearly every interval in the database.
   *
   * The full set, one row per status-writing site in this file:
   *
   *  - `issue_created`         -> `payload.status` (createIssue; an issue can be
   *                               born `in_progress`, which opens an interval)
   *  - `status_changed`        -> `payload.to` (updateIssue's patch, and
   *                               markAncestorsInProgress' derived flip)
   *  - `checkout`              -> `in_progress` (the claim UPDATE)
   *  - `claim_stolen`          -> `in_progress` (the takeover UPDATE)
   *  - `release`,
   *    `claim_released_stale`  -> `todo` (the release UPDATE)
   *
   * Returning null for an unreadable payload is load-bearing: it is what routes
   * a history this code cannot trust into the `approximate` fallback instead of
   * silently producing a confident wrong number.
   */
  private static statusAfterEvent(kind: string, payload: Record<string, unknown>): IssueStatus | null {
    const asStatus = (value: unknown): IssueStatus | null =>
      typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value)
        ? (value as IssueStatus)
        : null;
    switch (kind) {
      case "issue_created":
        return asStatus(payload.status);
      case "status_changed":
        return asStatus(payload.to);
      case "checkout":
      case "claim_stolen":
        return "in_progress";
      case "release":
      case "claim_released_stale":
        return "todo";
      default:
        return null;
    }
  }

  /**
   * Replay one issue's status-moving events into summed intervals, or null when
   * the log cannot support the answer.
   *
   * ## The rules, and what each one buys
   *
   * **Entering `in_progress` opens an interval, leaving it closes one.** That is
   * the whole fix for "blocked time counts as work": a blocked window is not an
   * interval, so it costs nothing, and no special case had to be written for it.
   * `in_review` runs through the identical machinery into a separate bucket.
   *
   * **A transition to the status we are already in is a no-op.** `claim_stolen`
   * fires on an issue that is already `in_progress`; a takeover changes who is
   * working, not whether work is happening, and treating it as close-then-reopen
   * would round the interval twice for no reason.
   *
   * **An interval opened by a derived flip is dropped, not counted.** STA-79
   * marks an ancestor `in_progress` when a child starts, tagged
   * `payload.derived === "child_started"`. That is a REPORT about the children,
   * and billing the epic's own clock for it is defect #1 of the old scheme. The
   * interval is still tracked (it has to be, so the next transition closes the
   * right thing) — it simply contributes nothing.
   *
   * **An OPEN interval ends at `clampAt`, never at `now`.** See `timingFor` for
   * where `clampAt` comes from and what it costs.
   *
   * **The replay must land on the row's actual status.** If it does not, the log
   * and the row disagree — an import, a hand-edit, a history written by another
   * tool — and this function declines rather than guesses. Same for a log that
   * does not begin with `issue_created`.
   *
   * Zero is not null: an interval that opened and closed inside the same second
   * reports 0 seconds, because it happened. Null is reserved for "never ran".
   */
  private static reconstructIntervals(
    currentStatus: string,
    events: readonly { kind: string; createdAt: string; payload: Record<string, unknown> }[],
    clampAt: string,
  ): OwnTiming | null {
    const first = events[0];
    if (!first || first.kind !== "issue_created") return null;
    let status = WorkspaceStore.statusAfterEvent(first.kind, first.payload);
    if (!status) return null;

    let openAt: string | null = null;
    // A derived open interval is tracked but never counted. Creation is never
    // derived — nothing flips an issue that does not exist yet.
    let openDerived = false;
    let active = 0;
    let review = 0;
    let sawActive = false;
    let sawReview = false;
    if (status === "in_progress" || status === "in_review") openAt = first.createdAt;

    for (let i = 1; i < events.length; i += 1) {
      const event = events[i]!;
      const to = WorkspaceStore.statusAfterEvent(event.kind, event.payload);
      if (!to) return null;
      if (to === status) continue;
      if (openAt !== null) {
        const seconds = secondsBetween(openAt, event.createdAt);
        if (status === "in_progress") {
          if (!openDerived) {
            active += seconds;
            sawActive = true;
          }
        } else {
          review += seconds;
          sawReview = true;
        }
        openAt = null;
      }
      if (to === "in_progress" || to === "in_review") {
        openAt = event.createdAt;
        openDerived = to === "in_progress" && event.payload.derived === "child_started";
      }
      status = to;
    }

    if (status !== currentStatus) return null;

    let countedThrough: string | null = null;
    if (openAt !== null) {
      // Guard against a clock that ran backwards between two writes: the clamp
      // can never pull an interval's end before its own start.
      const end = clampAt > openAt ? clampAt : openAt;
      const seconds = secondsBetween(openAt, end);
      if (status === "in_progress") {
        if (!openDerived) {
          active += seconds;
          sawActive = true;
          countedThrough = end;
        }
      } else {
        review += seconds;
        sawReview = true;
      }
    }

    return {
      ownActiveSeconds: sawActive ? active : null,
      reviewSeconds: sawReview ? review : null,
      approximate: false,
      countedThrough,
    };
  }

  /**
   * The pre-STA-90 answer, kept as the FALLBACK for histories the replay cannot
   * read — and only reachable behind `approximate: true`.
   *
   *  - `done`                      -> `completedAt - startedAt`. A `done` row
   *                                   with no `completed_at` is null rather than
   *                                   "now minus started", which would report a
   *                                   finished task as still running.
   *  - `in_progress` / `in_review` -> `now - startedAt`.
   *  - `cancelled`, `backlog`,
   *    `todo`, `blocked`,
   *    never started               -> null.
   *
   * Every defect this shape has is exactly why STA-90 replaced it: `started_at`
   * is never cleared, so a task parked in `todo` or pushed to `blocked` and then
   * restarted is billed for the whole span. It survives here because a foreign
   * database with no usable event log still deserves a number, and a number
   * labelled approximate is more useful than a blank column.
   */
  private static approximateActiveOf(
    row: Pick<IssueRow, "status" | "started_at" | "completed_at">,
    now: string,
  ): number | null {
    if (!row.started_at) return null;
    if (row.status === "done") {
      return row.completed_at ? secondsBetween(row.started_at, row.completed_at) : null;
    }
    if (row.status === "in_progress" || row.status === "in_review") {
      return secondsBetween(row.started_at, now);
    }
    return null;
  }

  /** Every status at zero — so a caller can index any status without a guard. */
  private static zeroStatusCounts(): Record<IssueStatus, number> {
    return Object.fromEntries(ISSUE_STATUSES.map((s) => [s, 0])) as Record<IssueStatus, number>;
  }

  /** The all-absent struct, for an id that no longer resolves to a row. */
  private static emptyTiming(): IssueTiming {
    return {
      estimatedSeconds: null,
      ownActiveSeconds: null,
      activeSeconds: null,
      reviewSeconds: null,
      approximate: false,
      countedThrough: null,
      childCount: 0,
      childrenEstimatedSeconds: null,
      childrenActiveSeconds: null,
      childStatusCounts: WorkspaceStore.zeroStatusCounts(),
    };
  }

  /**
   * Estimate-vs-actual for a set of issues, keyed by issue id. FOUR queries,
   * whatever the size of the tree underneath them.
   *
   * Unlike `claimActivityFor`, EVERY requested id gets an entry. A claim is
   * absent when nobody holds the issue; timing always has something true to say
   * (an unestimated, unstarted leaf is all-nulls with `childCount: 0`), and a
   * surface that must render a row for every issue should not have to invent
   * the empty case itself.
   *
   * ## Where the clamp comes from, and what it costs
   *
   * An open `in_progress` interval has no end yet, and the tempting end is `now`.
   * `now` is the bug VP reported: an agent that died on Friday is several days
   * into its estimate by Monday, and an epic auto-flipped by a child ticks
   * forever with nobody working it.
   *
   * So an open interval is counted through the last moment there is EVIDENCE of
   * work:
   *
   *  - **Held issue** -> the holder's `lastActivityAt`, straight out of
   *    `claimActivityFor` — the same C1 derivation the stale-claim badge and the
   *    steal threshold use. Reused rather than reimplemented so "this claim is
   *    dead" and "this clock has stopped" can never become two different
   *    judgements about the same silence.
   *  - **No holder** (reachable: `staple status X in_progress` with an assignee
   *    but no checkout) -> the newest event on the issue. Weaker, since any
   *    actor's event counts, but it is the only evidence there is.
   *
   * THE RESOLUTION LIMIT, stated plainly: this measures an agent's WRITE CADENCE,
   * not its thinking. An agent that works silently for twenty minutes and then
   * comments is credited from its previous write to that comment — so a long
   * silent stretch before a crash is not counted at all. The trade is deliberate
   * and one-directional: under-counting silence beats billing a dead process for
   * a weekend, because the second error compounds without limit and the first
   * one cannot.
   *
   * ## Rollup: DIRECT children, but each child contributes its HEADLINE
   *
   * 1. The parent view renders its direct children as a table. A total that does
   *    not equal the sum of the rows on screen is a table that lies; depth-1 is
   *    the only depth whose arithmetic a reader can audit.
   * 2. A child that is itself a parent contributes its own aggregate, because
   *    that IS the number its row shows. The table still adds up, and an
   *    epic-of-epics reports its grandchildren's work instead of the zero it
   *    would report if parents had no stopwatch and no aggregate either.
   * 3. Estimates do NOT cascade that way: `childrenEstimatedSeconds` sums the
   *    children's own estimates only. A parent's estimate is a plan for its whole
   *    subtree, so folding it together with its children's would double-count it.
   *
   * That recursion is why this resolves a bounded DESCENDANT CLOSURE up front
   * (one recursive CTE, capped at MAX_TREE_DEPTH) and then rolls up deepest-first
   * — rather than issuing a query per level, which is precisely the N+1 this file
   * batches away everywhere else.
   *
   * Sums skip nulls and stay null when NOTHING contributed: `childrenEstimated`
   * is null when no child recorded an estimate, never 0. The two are different
   * facts and a surface has to be able to say the first one.
   */
  timingFor(issueIds: string[]): Map<string, IssueTiming> {
    const out = new Map<string, IssueTiming>();
    if (issueIds.length === 0) return out;
    const now = nowIso();
    const roots = issueIds.map(() => "?").join(",");

    // 1/4 — the descendant closure. UNION (not UNION ALL) dedupes, so a corrupt
    // parent cycle terminates on its own; the depth cap is the belt to that
    // braces.
    const rows = this.db
      .prepare(
        `WITH RECURSIVE closure(id, depth) AS (
             SELECT id, 0 FROM issues WHERE id IN (${roots})
             UNION
             SELECT i.id, closure.depth + 1
               FROM issues i JOIN closure ON i.parent_id = closure.id
              WHERE closure.depth < ?
           )
           SELECT i.id AS id, i.parent_id AS parent_id, i.status AS status,
                  i.estimated_seconds AS estimated_seconds,
                  i.started_at AS started_at, i.completed_at AS completed_at,
                  MAX(closure.depth) AS depth
             FROM closure JOIN issues i ON i.id = closure.id
            GROUP BY i.id`,
      )
      .all(...(issueIds as never[]), MAX_TREE_DEPTH) as Array<
      Pick<
        IssueRow,
        "id" | "parent_id" | "status" | "estimated_seconds" | "started_at" | "completed_at"
      > & { depth: number }
    >;
    if (rows.length === 0) return out;
    const ids = rows.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(",");

    // 2/4 — every status-moving event over the closure, in seq order.
    const eventRows = this.db
      .prepare(
        `SELECT issue_id, kind, payload, created_at
           FROM events
          WHERE issue_id IN (${placeholders})
            AND kind IN (${STATUS_MOVING_EVENT_KINDS.map(() => "?").join(",")})
          ORDER BY issue_id, seq`,
      )
      .all(...([...ids, ...STATUS_MOVING_EVENT_KINDS] as never[])) as Array<{
      issue_id: string;
      kind: string;
      payload: string;
      created_at: string;
    }>;
    const eventsByIssue = new Map<
      string,
      Array<{ kind: string; createdAt: string; payload: Record<string, unknown> }>
    >();
    for (const row of eventRows) {
      let list = eventsByIssue.get(row.issue_id);
      if (!list) eventsByIssue.set(row.issue_id, (list = []));
      let payload: Record<string, unknown> = {};
      try {
        payload = JSON.parse(row.payload) as Record<string, unknown>;
      } catch {
        // A payload that will not parse is a payload the replay cannot read;
        // `statusAfterEvent` sees {} and refuses, routing to the fallback.
      }
      list.push({ kind: row.kind, createdAt: row.created_at, payload });
    }

    // 3/4 — the no-holder clamp: newest event of ANY kind on the issue.
    const newestEvent = new Map<string, string>();
    for (const row of this.db
      .prepare(
        `SELECT issue_id, MAX(created_at) AS t FROM events
          WHERE issue_id IN (${placeholders}) GROUP BY issue_id`,
      )
      .all(...(ids as never[])) as Array<{ issue_id: string; t: string | null }>) {
      if (row.t) newestEvent.set(row.issue_id, row.t);
    }

    // 4/4 — the held clamp, from C1 itself.
    const claims = this.claimActivityFor(ids);

    const ownTimings = new Map<string, OwnTiming>();
    for (const row of rows) {
      const clampAt = claims.get(row.id)?.lastActivityAt ?? newestEvent.get(row.id) ?? now;
      ownTimings.set(
        row.id,
        WorkspaceStore.reconstructIntervals(row.status, eventsByIssue.get(row.id) ?? [], clampAt) ?? {
          ownActiveSeconds: WorkspaceStore.approximateActiveOf(row, now),
          reviewSeconds: null,
          approximate: true,
          countedThrough: null,
        },
      );
    }

    const childrenOf = new Map<string, typeof rows>();
    for (const row of rows) {
      if (!row.parent_id) continue;
      let list = childrenOf.get(row.parent_id);
      if (!list) childrenOf.set(row.parent_id, (list = []));
      list.push(row);
    }

    // Deepest first, so a parent always reads children that are already final.
    const timings = new Map<string, IssueTiming>();
    for (const row of [...rows].sort((a, b) => b.depth - a.depth)) {
      const own = ownTimings.get(row.id)!;
      const children = childrenOf.get(row.id) ?? [];
      const childStatusCounts = WorkspaceStore.zeroStatusCounts();
      let childrenEstimatedSeconds: number | null = null;
      let childrenActiveSeconds: number | null = null;
      let childApproximate = false;
      for (const child of children) {
        if ((ISSUE_STATUSES as readonly string[]).includes(child.status)) {
          childStatusCounts[child.status as IssueStatus] += 1;
        }
        if (child.estimated_seconds != null) {
          childrenEstimatedSeconds = (childrenEstimatedSeconds ?? 0) + child.estimated_seconds;
        }
        const childTiming = timings.get(child.id);
        if (childTiming?.activeSeconds != null) {
          childrenActiveSeconds = (childrenActiveSeconds ?? 0) + childTiming.activeSeconds;
        }
        if (childTiming?.approximate) childApproximate = true;
      }
      const hasChildren = children.length > 0;
      timings.set(row.id, {
        estimatedSeconds: row.estimated_seconds ?? null,
        ownActiveSeconds: own.ownActiveSeconds,
        // The headline. `cancelled` declines to report an actual at all — see
        // IssueTiming — and a parent reports its aggregation, never a stopwatch.
        activeSeconds:
          row.status === "cancelled" ? null : hasChildren ? childrenActiveSeconds : own.ownActiveSeconds,
        reviewSeconds: own.reviewSeconds,
        // OR, not "whichever fed the headline": if anything in this struct came
        // from the fallback, the struct says so. Over-flagging is safe;
        // under-flagging is a number claiming a provenance it does not have.
        approximate: own.approximate || childApproximate,
        // A parent's headline is an aggregate, so an instant describing the
        // parent's OWN open interval would be labelling the wrong number. Its
        // children carry their own liveness, which is where a reader should look.
        countedThrough: hasChildren ? null : own.countedThrough,
        childCount: children.length,
        childrenEstimatedSeconds,
        childrenActiveSeconds,
        childStatusCounts,
      });
    }

    for (const id of issueIds) {
      const timing = timings.get(id);
      if (timing) out.set(id, timing);
    }
    return out;
  }

  /**
   * Timing for one issue. Always returns a value — see `timingFor` for why this
   * differs from `claimActivity`, which returns null for an unheld issue.
   */
  timing(ref: string): IssueTiming {
    const row = this.requireRow(ref);
    return this.timingFor([row.id]).get(row.id) ?? WorkspaceStore.emptyTiming();
  }

  /**
   * The `{ timing, childrenTiming }` pair every DETAIL surface attaches beside a
   * context payload — MCP `get_task`, HTTP `/api/issue`, HTTP `/api/agent-context`
   * and CLI `show --json`.
   *
   * It exists as ONE store method rather than as four hand-assembled literals for
   * the same reason `/api/agent-context` calls `store.context()` instead of
   * rebuilding it: the surfaces are held equal by sharing the code, not by four
   * authors remembering the same shape. `test/ui-agent-context.test.ts` asserts
   * deep equality between get_task and that route, and it can only keep doing so
   * if both spread the identical expression.
   *
   * `childrenTiming` is keyed by child IDENTIFIER (`STA-42`), not by the internal
   * uuid. Both join fine against the `children: Issue[]` already in the payload,
   * so the tiebreak is legibility: this is a document an agent reads and a human
   * debugs, and a map keyed by `4408738e-7edd-…` is unreadable in both roles —
   * and unpinnable in a golden, where uuids are tokenized as values but keys are
   * not. Identifier is the handle every other cross-referencing payload in this
   * codebase uses (see the graph route's `parent`).
   *
   * DIRECT children only — see `timingFor` for why depth-1 is the honest rollup.
   */
  detailTiming(ref: string): {
    timing: IssueTiming;
    childrenTiming: Record<string, IssueTiming>;
  } {
    const row = this.requireRow(ref);
    const children = this.db
      .prepare("SELECT id, identifier FROM issues WHERE parent_id = ? ORDER BY created_at")
      .all(row.id) as Array<{ id: string; identifier: string }>;
    const all = this.timingFor([row.id, ...children.map((child) => child.id)]);
    const childrenTiming: Record<string, IssueTiming> = {};
    for (const child of children) {
      const timing = all.get(child.id);
      if (timing) childrenTiming[child.identifier] = timing;
    }
    return { timing: all.get(row.id) ?? WorkspaceStore.emptyTiming(), childrenTiming };
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
                // Transition site 4 of 4. A takeover is a fresh start by a new
                // agent; if the epic went quiet in the meantime it must light up
                // again, attributed to whoever took over.
                this.markAncestorsInProgress(stolen, agent);
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
      // Transition site 3 of 4, and the one that matters most in practice: a
      // plain `staple checkout` IS how work starts, and its UPDATE above sets
      // status = 'in_progress' directly. Hooking only `updateIssue` would have
      // missed the common case entirely.
      this.markAncestorsInProgress(claimed, agent);
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
