import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.js";
import {
  blockersResolvedDedupKey,
  childrenCompleteDedupKey,
  newId,
  parseIdentifier,
} from "./ids.js";
import {
  CHECKOUT_EXPECTED_CATEGORY_ORDER,
  type ClaimActivity,
  DEFAULT_CHECKOUT_EXPECTED,
  DEFAULT_ISSUE_KIND,
  type GateQueueEntry,
  type GateState,
  INBOX_PICKUP_CATEGORY_ORDER,
  type Issue,
  type IssueComment,
  type IssueDocumentMeta,
  type IssueGate,
  type IssueKind,
  type IssuePriority,
  type IssueStatus,
  type IssueTiming,
  LIST_CATEGORY_ORDER,
  MAX_TREE_DEPTH,
  type QueuedBy,
  REQUIRED_STATUS_CATEGORIES,
  RESOLVED_CATEGORIES,
  StapleError,
  type StapleEvent,
  type StatusCategory,
  WORKABLE_CATEGORIES,
  WORKLOG_KEY,
  type WorklogSummary,
  type WorkspaceKind,
  type WorkspaceStatus,
  assertEstimateSeconds,
  assertPriority,
  assertStatusCategory,
  assertVocabularyId,
  claimGuardMessage,
  normalizeTitle,
  nowIso,
} from "./types.js";
import { SORT_ORDER_STEP } from "./migrations/workspace/004-workspace-settings.js";
import {
  encodeStoredSetting,
  readStoredSetting,
  requireSettingDefinition,
  settingDefinitionsFor,
  settingKeyFromMetaKey,
  settingMetaKey,
  settingValueView,
  validateSettingValue,
  WORKSPACE_SETTING_META_PREFIX,
  type SettingValueView,
} from "./settings-registry.js";

export interface CreateIssueInput {
  title: string;
  description?: string | null;
  status?: IssueStatus;
  /** Declared kind; omit for the workspace's default (see `defaultKind`). */
  kind?: IssueKind;
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
  /**
   * Re-declare the kind. Two-state, not three: absent leaves it alone and a
   * string sets it. There is no null, because there is no "no kind" — the
   * column is NOT NULL with a DEFAULT, so clearing it is not a state the
   * tracker can represent (unlike `estimatedSeconds`, where the absence of an
   * estimate is a real and distinct fact).
   */
  kind?: IssueKind;
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
  kind?: IssueKind[];
  assignee?: string;
  parent?: string | null;
  q?: string;
  includeResolved?: boolean;
}

/**
 * One row of `inbox()`. The issue, plus the three reasons it might not be
 * pickable, each as its own field so a surface never has to infer one from
 * another:
 *
 *  - `unresolvedBlockers` — waiting on other WORK.
 *  - `queuedBy`           — waiting on a HUMAN, somewhere above it.
 *  - `gate`               — the gate this issue itself is holding, if any.
 *
 * `queuedBy` and `gate` are additive (STA-143): every field that was on an inbox
 * entry before is still there, in the same place.
 */
export type InboxEntry = Issue & {
  unresolvedBlockers: string[];
  queuedBy: QueuedBy | null;
  gate: IssueGate | null;
};

interface IssueRow {
  id: string;
  identifier: string;
  title: string;
  normalized_title: string;
  description: string | null;
  status: string;
  status_version: number;
  kind: string;
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
  gate_state: string | null;
  gate_owner: string | null;
  gate_requested_by: string | null;
  gate_requested_at: string | null;
  gate_resolved_by: string | null;
  gate_resolved_at: string | null;
  gate_released: number;
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
    kind: row.kind as IssueKind,
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

/**
 * The memoized vocabulary of ONE open workspace, plus every list the store's
 * guards derive from it. Built once per (connection, settings revision).
 */
interface SettingsSnapshot {
  /** The revision it was built at; see `WorkspaceStore.settings`. */
  revision: string;
  statuses: WorkspaceStatus[];
  kinds: WorkspaceKind[];
  byId: Map<string, WorkspaceStatus>;
  /** Configured ids grouped by category, each group in configured order. */
  byCategory: Map<StatusCategory, string[]>;
  /** Ids in list rank: `LIST_CATEGORY_ORDER` tiers, configured order within. */
  listOrder: string[];
  /** `listOrder` minus the resolved categories — the server-side open status order. */
  openOrder: string[];
  resolved: string[];
  active: string[];
  review: string[];
  workable: string[];
  blocked: string[];
  checkoutExpected: string[];
  pickupOrder: string[];
  /**
   * Registered workspace setting values (R6a, STA-176), keyed by setting key.
   * Only keys with a definition are here — decoded and validated at this READ
   * boundary — so a setting the registry does not know can never reach a caller.
   */
  values: Map<string, { value: unknown; version: number }>;
  /** `setting:*` meta rows nobody in this binary has a definition for. Preserved, never read. */
  unknownSettingKeys: string[];
}

/** One op in an `update_statuses` / `update_kinds` batch. */
export type VocabularyOp =
  | { op: "add"; id: string; label?: string; category?: string; after?: string | null }
  | { op: "rename"; id: string; label: string }
  | { op: "recategorize"; id: string; category: string }
  | { op: "reorder"; ids: string[] }
  | { op: "remove"; id: string; migrateTo?: string | null };

/** One op in a `target: "settings"` batch: set a registered workspace value, or clear it. */
export type SettingOp = { op: "set"; key: string; value: unknown } | { op: "reset"; key: string };

/**
 * SQL literal list for an `IN (…)` fragment.
 *
 * Ids reach the database only through `assertVocabularyId`, so they are already
 * `[a-z][a-z0-9_]*` and cannot carry a quote. The escape is here anyway, because
 * "a validator upstream makes this safe" is exactly the sentence that precedes an
 * injection — the fragment has to be safe to read on its own line.
 */
function sqlIdList(ids: readonly string[]): string {
  if (ids.length === 0) return "(NULL)";
  return `(${ids.map((id) => `'${id.replace(/'/g, "''")}'`).join(",")})`;
}

/** `awaiting_approval` -> `Awaiting Approval`, so `--label` is optional, not required. */
function defaultLabel(id: string): string {
  return id
    .split("_")
    .filter(Boolean)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * The gate states that QUEUE the descendants underneath them (STA-143).
 *
 * `pending` is obvious. `changes_requested` is VP's explicit decision and the
 * one rule here somebody will want to re-litigate, so the reasoning is written
 * down rather than left to be inferred:
 *
 * A reviewer who asks for changes has NOT released the work. The parent comes
 * back to `todo` so whoever picks up the reviewer's comment can act on it, but
 * the children stay behind the queue, because the alternative — releasing an
 * entire subtree the reviewer just objected to — is the exact stampede the gate
 * exists to prevent. The queue therefore ends in exactly two ways: `approve`
 * (whole or per-child), or a fresh `gate` cycle that supersedes this one.
 *
 * `approved` is deliberately NOT here: an approved gate is history, and history
 * does not hold a queue.
 */
const GATE_QUEUEING_STATES: readonly GateState[] = ["pending", "changes_requested"];

/** `gate` and `request-changes` and `approve` all act on a gate that is not yet finished. */
function isActiveGate(state: string | null): boolean {
  return state !== null && (GATE_QUEUEING_STATES as readonly string[]).includes(state);
}

/**
 * One row as the gate walks need it (STA-143, widened by STA-154).
 *
 * `hasChildren` and `hasOpenDescendant` are computed once for the whole
 * workspace by `gateWalkIndex` rather than queried per row, because the
 * eligibility rules in `isQueueEligible` need them for EVERY id in a batch and
 * a per-row `EXISTS (SELECT …)` would put N queries behind one list render.
 */
interface GateWalkNode {
  id: string;
  parentId: string | null;
  identifier: string;
  title: string;
  status: IssueStatus;
  gateState: string | null;
  gateOwner: string;
  released: boolean;
  hasChildren: boolean;
  /** Is any descendant of this row still open? False for a leaf. */
  hasOpenDescendant: boolean;
}

interface GateWalkIndex {
  nodes: Map<string, GateWalkNode>;
  /** `parent id -> child ids`, in row order, for the pre-order walk in `gateQueueOf`. */
  children: Map<string, string[]>;
}

/**
 * The gate half of a row, or null when no gate was ever requested.
 *
 * A SIBLING of the issue rather than fields on it — see `IssueGate` in
 * core/types.ts. The practical consequence is that `Issue`, `issueShape` in
 * src/mcp.ts, and every payload pinned against them are untouched by this
 * feature: `gate` rides beside them exactly as `claim` does.
 */
function rowToGate(row: Pick<IssueRow, "gate_state" | "gate_owner" | "gate_requested_by" | "gate_requested_at" | "gate_resolved_by" | "gate_resolved_at">): IssueGate | null {
  if (!row.gate_state) return null;
  return {
    state: row.gate_state as GateState,
    // Written non-null by `gateIssue`; the fallback exists only so a row
    // hand-edited into a half-state renders as a string rather than crashing.
    owner: row.gate_owner ?? "?",
    requestedBy: row.gate_requested_by,
    requestedAt: row.gate_requested_at ?? "",
    resolvedBy: row.gate_resolved_by,
    resolvedAt: row.gate_resolved_at,
  };
}

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
 * The `payload.derived` marker written on each rung of the parent-status
 * derivation (STA-98). Present on a `status_changed` event, it means "this was a
 * REPORT about the children, not a human acting on this issue" — which is what
 * `isDerivationOwned` reads to decide reversibility, what the timing replay
 * reads to refuse to bill the interval, and what a timeline can render as
 * provenance.
 *
 * The value names the RUNG so a reader can see WHY, and `in_progress` keeps
 * STA-79's exact `child_started`: that rung's behaviour did not change, so its
 * wire format must not either.
 *
 * Anything consuming these must test for "is a string", never for one value —
 * a new rung must never silently fall out of an exclusion.
 */
const DERIVED_MARKERS = {
  active: "child_started",
  review: "child_in_review",
  workable: "children_workable",
  blocked: "children_blocked",
  done: "children_resolved",
  cancelled: "children_cancelled",
} as const satisfies Record<DerivedRung, string>;

/**
 * What the ladder decided, as a CATEGORY-shaped verdict rather than a status id
 * (STA-140). `workable` is the two-member band {unstarted, ready}; the others
 * name the category the parent should be moved into. Which concrete status that
 * becomes is the workspace's business — see `primaryStatusFor`.
 *
 * `done`/`cancelled` are STA-153's two closing rungs: a parent whose children
 * have ALL landed is finished, and saying so is the same kind of report as
 * saying it is in progress.
 */
type DerivedRung = "active" | "review" | "workable" | "blocked" | "done" | "cancelled";

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

  // ---------- workspace settings: statuses and kinds (STA-140) ----------

  /** Per-connection memo. Never read directly — go through `settings()`. */
  private settingsCache: SettingsSnapshot | null = null;

  private txDepth = 0;
  private savepointSeq = 0;

  /**
   * A transaction that NESTS, unlike `tx` (whose `BEGIN IMMEDIATE` throws inside
   * another transaction). Only the settings writers use it, and only because
   * `applyStatusOps` composes them: "add awaiting_approval, then reorder" is one
   * intention and must not be able to half-apply, while each op also has to work
   * on its own from the CLI.
   *
   * Outermost call takes the real write lock; inner calls take a SAVEPOINT, so a
   * failing op rolls back its own work and rethrows into the outer rollback.
   */
  private atomically<T>(fn: () => T): T {
    if (this.txDepth > 0) {
      const savepoint = `staple_cfg_${(this.savepointSeq += 1)}`;
      this.db.exec(`SAVEPOINT ${savepoint}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE ${savepoint}`);
        return result;
      } catch (error) {
        try {
          this.db.exec(`ROLLBACK TO ${savepoint}`);
          this.db.exec(`RELEASE ${savepoint}`);
        } catch {
          // the outer transaction is already aborting; it owns the rollback
        }
        throw error;
      }
    }
    this.txDepth += 1;
    try {
      return tx(this.db, fn);
    } finally {
      this.txDepth -= 1;
    }
  }

  /**
   * The revision the vocabulary is currently at.
   *
   * A single primary-key read of `meta.settings_revision`, and ABSENT means "0" —
   * which is why nothing writes the row until a setting actually changes, so a
   * freshly initialised workspace still has exactly the three `meta` keys
   * `characterize-layout.test.ts` pins.
   *
   * The row exists because the cache below has to survive a SECOND PROCESS. A
   * long-lived UI or MCP server holds one `WorkspaceStore` for hours; a CLI
   * `staple statuses add` runs in a different process against the same file.
   * Invalidating only on our own writes would leave that server serving a
   * vocabulary the operator has already changed — the exact failure that makes
   * caches worse than no cache.
   */
  private settingsRevision(): string {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'settings_revision'")
      .get() as { value: string } | undefined;
    return row?.value ?? "0";
  }

  /** Bump the revision so every other connection's snapshot is stale. */
  private bumpSettingsRevision(): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES ('settings_revision', '1')
         ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`,
      )
      .run();
    this.settingsCache = null;
  }

  /**
   * The configured vocabulary and everything derived from it, memoized.
   *
   * Rebuilt only when the revision moved. This is on the hot path — `issuesQuery`
   * needs the resolved-status list on every list call — so the steady state is
   * one indexed `meta` read and a map lookup.
   */
  private settings(): SettingsSnapshot {
    const revision = this.settingsRevision();
    const cached = this.settingsCache;
    if (cached && cached.revision === revision) return cached;

    const statuses = (
      this.db
        .prepare(
          `SELECT id, label, category, sort_order, is_builtin FROM workspace_statuses
            ORDER BY sort_order, id`,
        )
        .all() as Array<{
        id: string;
        label: string;
        category: string;
        sort_order: number;
        is_builtin: number;
      }>
    ).map((row) => ({
      id: row.id,
      label: row.label,
      category: row.category as StatusCategory,
      sortOrder: row.sort_order,
      isBuiltin: row.is_builtin === 1,
    }));

    const kinds = (
      this.db
        .prepare(`SELECT id, label, sort_order, is_builtin FROM workspace_kinds ORDER BY sort_order, id`)
        .all() as Array<{ id: string; label: string; sort_order: number; is_builtin: number }>
    ).map((row) => ({
      id: row.id,
      label: row.label,
      sortOrder: row.sort_order,
      isBuiltin: row.is_builtin === 1,
    }));

    const byId = new Map(statuses.map((status) => [status.id, status]));
    const byCategory = new Map<StatusCategory, string[]>();
    for (const status of statuses) {
      const list = byCategory.get(status.category);
      if (list) list.push(status.id);
      else byCategory.set(status.category, [status.id]);
    }
    /**
     * Tiered by CATEGORY first, configured order second. That split is the whole
     * ordering contract: reordering statuses reorders the tree, but it can never
     * lift `done` above `in_progress`, because the tier is not configurable.
     */
    const inCategories = (categories: readonly StatusCategory[]): string[] =>
      categories.flatMap((category) => byCategory.get(category) ?? []);

    /**
     * Registered values, decoded through the registry so an unreadable row is
     * refused HERE with its key in the sentence rather than wherever the value
     * is first used. Rows for keys with no definition are counted, not parsed.
     */
    const values = new Map<string, { value: unknown; version: number }>();
    const unknownSettingKeys: string[] = [];
    const stored = new Map(
      (
        this.db
          .prepare("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key")
          .all(`${WORKSPACE_SETTING_META_PREFIX}%`) as Array<{ key: string; value: string }>
      ).map((row) => [settingKeyFromMetaKey(row.key) ?? row.key, row.value]),
    );
    const where = `workspace ${this.slug}`;
    for (const definition of settingDefinitionsFor("workspace")) {
      const text = stored.get(definition.key);
      if (text === undefined) continue;
      const decoded = readStoredSetting(definition, text, where);
      values.set(definition.key, { value: decoded.value, version: decoded.version });
      stored.delete(definition.key);
    }
    for (const key of stored.keys()) unknownSettingKeys.push(key);

    const snapshot: SettingsSnapshot = {
      revision,
      statuses,
      kinds,
      values,
      unknownSettingKeys,
      byId,
      byCategory,
      listOrder: inCategories(LIST_CATEGORY_ORDER),
      openOrder: inCategories(LIST_CATEGORY_ORDER.filter((c) => !RESOLVED_CATEGORIES.includes(c))),
      resolved: inCategories(RESOLVED_CATEGORIES),
      active: byCategory.get("active") ?? [],
      review: byCategory.get("review") ?? [],
      workable: inCategories(WORKABLE_CATEGORIES),
      blocked: inCategories(["gated", "blocked"]),
      checkoutExpected: inCategories(CHECKOUT_EXPECTED_CATEGORY_ORDER),
      pickupOrder: inCategories(INBOX_PICKUP_CATEGORY_ORDER),
    };
    this.settingsCache = snapshot;
    return snapshot;
  }

  /** The workspace's statuses, in configured order. */
  getStatuses(): WorkspaceStatus[] {
    return this.settings().statuses.map((status) => ({ ...status }));
  }

  /** The workspace's kind vocabulary, in configured order. O1a reads this. */
  getKinds(): WorkspaceKind[] {
    return this.settings().kinds.map((kind) => ({ ...kind }));
  }

  /**
   * The configured kind ids in configured order — `KIND_RANK` for THIS
   * workspace, where the rank of a kind is simply its index (STA-124).
   *
   * The seed twin in `core/types.ts` is the static `KIND_RANK` map, which is
   * what a surface with no store (the browser) uses instead.
   */
  kindOrder(): string[] {
    return this.settings().kinds.map((kind) => kind.id);
  }

  /**
   * The kind a create with no `kind` writes.
   *
   * `DEFAULT_ISSUE_KIND` when the workspace still has it, and otherwise the
   * FIRST configured kind — because `removeKind` is allowed to delete `task`,
   * and a default pointing at a kind that no longer exists would write rows
   * that fail their own validation.
   *
   * Deliberately NOT "the first configured kind" unconditionally. That would
   * mean reordering the vocabulary silently changed what every new issue is:
   * move `epic` to the front to make it sort first on a board, and suddenly
   * every ticket anyone files is an epic. Ordering is a display decision and it
   * must not double as a semantic one.
   */
  defaultKind(): string {
    const kinds = this.settings().kinds;
    /**
     * `kinds.default` (R6a) is the operator's choice, and it is honoured only
     * while it names a configured kind: `removeKind` resets it in the same
     * transaction, so a stale value here means a hand-edited row, and the seed
     * rule below is the right answer for that rather than a refusal on create.
     */
    const chosen = this.getSetting("kinds.default") as string;
    if (kinds.some((kind) => kind.id === chosen)) return chosen;
    if (kinds.some((kind) => kind.id === DEFAULT_ISSUE_KIND)) return DEFAULT_ISSUE_KIND;
    const first = kinds[0]?.id;
    if (first === undefined) {
      throw new StapleError(
        "validation",
        `This workspace has no kinds configured, and an issue must declare one. ` +
          `Add one with: staple kinds add ${DEFAULT_ISSUE_KIND}`,
      );
    }
    return first;
  }

  /** The configured status ids in list rank; the tree/board group order. */
  statusOrder(): string[] {
    return [...this.settings().listOrder];
  }

  /** Configured open statuses in list rank — the per-workspace OPEN_STATUS_ORDER. */
  openStatusOrder(): string[] {
    return [...this.settings().openOrder];
  }

  /** Configured pickup order for the agent inbox: active, review, ready, unstarted. */
  inboxPickupOrder(): string[] {
    return [...this.settings().pickupOrder];
  }

  /** What a bare `checkout` claims from, in the order the refusal sentence names. */
  checkoutExpectedStatuses(): string[] {
    return [...this.settings().checkoutExpected];
  }

  /** The category of a configured status, or null when the id is not configured. */
  categoryOf(status: string): StatusCategory | null {
    return this.settings().byId.get(status)?.category ?? null;
  }

  /** Is this status one of the "finished" categories (done/cancelled)? */
  isResolvedStatus(status: string): boolean {
    const category = this.categoryOf(status);
    return category !== null && RESOLVED_CATEGORIES.includes(category);
  }

  isActiveStatus(status: string): boolean {
    return this.categoryOf(status) === "active";
  }

  /**
   * The status a code path that means a CATEGORY should actually write.
   *
   * The first configured status of that category — so `release` lands in whatever
   * the operator calls "ready" and the derivation's rung 4 lands in whatever they
   * call "blocked". Throws rather than guessing when the category is empty:
   * `removeStatus` refuses to empty a `REQUIRED_STATUS_CATEGORIES` member, so
   * reaching this is a bug or a hand-edited database, and either deserves a
   * sentence rather than a silent write to the wrong column.
   */
  primaryStatusFor(category: StatusCategory): string {
    const first = this.settings().byCategory.get(category)?.[0];
    if (first === undefined) {
      throw new StapleError(
        "validation",
        `This workspace has no status in the "${category}" category, and one is required here. ` +
          `Add one with: staple statuses add <id> --category ${category}`,
      );
    }
    return first;
  }

  /** Validate a status id against THIS workspace's configuration. */
  assertConfiguredStatus(value: string): void {
    if (this.settings().byId.has(value)) return;
    throw new StapleError(
      "validation",
      `Unknown status "${value}" in workspace ${this.slug}. Valid: ${this.settings().listOrder.join(", ")}`,
    );
  }

  /** Validate a kind id against THIS workspace's configuration. */
  assertConfiguredKind(value: string): void {
    if (this.settings().kinds.some((kind) => kind.id === value)) return;
    throw new StapleError(
      "validation",
      `Unknown kind "${value}" in workspace ${this.slug}. Valid: ${this.settings().kinds.map((k) => k.id).join(", ")}`,
    );
  }

  /** `('done','cancelled')` for the seeded seven — configured ids otherwise. */
  private resolvedSql(): string {
    return sqlIdList(this.settings().resolved);
  }

  /**
   * `CASE status WHEN … THEN n … ELSE n END` in list rank.
   *
   * Generated rather than written out, which is what makes "reorder the statuses
   * and the tree reorders" true. A status not in the table sorts last rather than
   * first: a row carrying an id nobody configured is a data problem, and burying
   * it is better than putting it at the top of everyone's inbox.
   */
  private statusRankSql(column = "status"): string {
    const order = this.settings().listOrder;
    const arms = order.map((id, index) => `WHEN '${id.replace(/'/g, "''")}' THEN ${index}`).join(" ");
    return `CASE ${column} ${arms} ELSE ${order.length} END`;
  }

  // ---------- workspace settings: writes ----------

  private requireStatusRow(id: string): WorkspaceStatus {
    const row = this.settings().byId.get(id);
    if (!row) {
      throw new StapleError(
        "not_found",
        `No status "${id}" in workspace ${this.slug}. Configured: ${this.settings().listOrder.join(", ")}`,
      );
    }
    return row;
  }

  private requireKindRow(id: string): WorkspaceKind {
    const row = this.settings().kinds.find((kind) => kind.id === id);
    if (!row) {
      throw new StapleError(
        "not_found",
        `No kind "${id}" in workspace ${this.slug}. Configured: ${this.settings().kinds.map((k) => k.id).join(", ")}`,
      );
    }
    return row;
  }

  /** How many issues currently carry this status. The remove guard's evidence. */
  statusUsageCount(id: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM issues WHERE status = ?").get(id) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * How many issues carry this kind — 0 until O1a (STA-124) adds `issues.kind`.
   *
   * The column probe is deliberate rather than a hardcoded 0: O1a lands on this
   * same branch right after O7a, and a counter that starts telling the truth the
   * moment the column exists is one fewer edit for it to remember.
   */
  kindUsageCount(id: string): number {
    const hasColumn = (
      this.db.prepare("SELECT name FROM pragma_table_info('issues')").all() as Array<{ name: string }>
    ).some((column) => column.name === "kind");
    if (!hasColumn) return 0;
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM issues WHERE kind = ?").get(id) as
      | { n: number }
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * `sort_order` for a row inserted after `after` (or at the end when null).
   *
   * Rows are seeded ten apart precisely so this is an arithmetic mean rather than
   * a rewrite of the column. When the gap is exhausted the whole table is
   * renormalised, which is rare and cheap on a table this size.
   */
  private insertionOrder(rows: Array<{ id: string; sortOrder: number }>, after: string | null | undefined): number {
    if (rows.length === 0) return SORT_ORDER_STEP;
    if (after === undefined || after === null) {
      return rows[rows.length - 1]!.sortOrder + SORT_ORDER_STEP;
    }
    const index = rows.findIndex((row) => row.id === after);
    if (index === -1) {
      throw new StapleError("not_found", `Cannot place after "${after}": no such entry in workspace ${this.slug}`);
    }
    const previous = rows[index]!.sortOrder;
    const next = rows[index + 1]?.sortOrder;
    if (next === undefined) return previous + SORT_ORDER_STEP;
    if (next - previous > 1) return Math.floor((previous + next) / 2);
    return Number.NaN; // caller renormalises, then retries
  }

  private renormalize(table: "workspace_statuses" | "workspace_kinds"): void {
    const ids = (
      this.db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, id`).all() as Array<{ id: string }>
    ).map((row) => row.id);
    const update = this.db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
    ids.forEach((id, index) => update.run((index + 1) * SORT_ORDER_STEP, id));
  }

  addStatus(
    input: { id: string; label?: string; category: string; after?: string | null },
    actor?: string | null,
  ): WorkspaceStatus {
    const id = assertVocabularyId(input.id, "status");
    const category = input.category.trim().toLowerCase();
    assertStatusCategory(category);
    const label = (input.label ?? "").trim() || defaultLabel(id);
    return this.atomically(() => {
      if (this.settings().byId.has(id)) {
        throw new StapleError("duplicate", `Status "${id}" already exists in workspace ${this.slug}`);
      }
      let order = this.insertionOrder(this.settings().statuses, input.after);
      if (Number.isNaN(order)) {
        this.renormalize("workspace_statuses");
        this.settingsCache = null;
        order = this.insertionOrder(this.settings().statuses, input.after);
      }
      this.db
        .prepare(
          `INSERT INTO workspace_statuses (id, label, category, sort_order, is_builtin) VALUES (?, ?, ?, ?, 0)`,
        )
        .run(id, label, category, order);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "status_config_changed",
        actor: actor ?? null,
        payload: { action: "add", id, label, category },
      });
      return this.requireStatusRow(id);
    });
  }

  renameStatus(id: string, label: string, actor?: string | null): WorkspaceStatus {
    const next = label.trim();
    if (!next) throw new StapleError("validation", "Status label cannot be empty");
    return this.atomically(() => {
      const before = this.requireStatusRow(id);
      this.db.prepare("UPDATE workspace_statuses SET label = ? WHERE id = ?").run(next, id);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "status_config_changed",
        actor: actor ?? null,
        payload: { action: "rename", id, from: before.label, to: next },
      });
      return this.requireStatusRow(id);
    });
  }

  /**
   * Move a status to a different category — i.e. give it different BEHAVIOUR.
   *
   * Included because "I called it `in_review` but it should behave as blocked" is
   * a real correction, and the alternative is remove-and-re-add, which forces a
   * migrate-to and rewrites every row twice.
   */
  recategorizeStatus(id: string, category: string, actor?: string | null): WorkspaceStatus {
    const next = category.trim().toLowerCase();
    assertStatusCategory(next);
    return this.atomically(() => {
      const before = this.requireStatusRow(id);
      if (before.category === next) return before;
      this.assertCategoryStaysPopulated(before, next);
      this.db.prepare("UPDATE workspace_statuses SET category = ? WHERE id = ?").run(next, id);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "status_config_changed",
        actor: actor ?? null,
        payload: { action: "recategorize", id, from: before.category, to: next },
      });
      return this.requireStatusRow(id);
    });
  }

  /**
   * The one rule protecting the code paths that write a CATEGORY rather than an
   * id: `release` needs a `ready`, `checkout` needs an `active`, `done` needs a
   * `done`. Emptying one of those is not a preference, it is a workspace that
   * cannot complete a task.
   */
  private assertCategoryStaysPopulated(row: WorkspaceStatus, movingTo: StatusCategory | null): void {
    if (!REQUIRED_STATUS_CATEGORIES.includes(row.category)) return;
    if (movingTo === row.category) return;
    const remaining = (this.settings().byCategory.get(row.category) ?? []).filter((id) => id !== row.id);
    if (remaining.length > 0) return;
    throw new StapleError(
      "validation",
      `"${row.id}" is the only status in the "${row.category}" category, and staple writes into that ` +
        `category (checkout, release, done, cancel and the derived parent rungs all do). ` +
        `Add another "${row.category}" status first, then retry.`,
    );
  }

  /**
   * Set the whole order at once. `ids` must be a PERMUTATION of the configured
   * ids — a partial list is refused rather than interpreted, because "the ones
   * you left out go… somewhere" is the kind of guess that silently reorders a
   * board nobody touched.
   */
  reorderStatuses(ids: string[], actor?: string | null): WorkspaceStatus[] {
    return this.atomically(() => {
      const normalized = ids.map((id) => assertVocabularyId(id, "status"));
      this.assertPermutation(normalized, this.settings().statuses.map((s) => s.id), "status");
      const update = this.db.prepare("UPDATE workspace_statuses SET sort_order = ? WHERE id = ?");
      normalized.forEach((id, index) => update.run((index + 1) * SORT_ORDER_STEP, id));
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "status_config_changed",
        actor: actor ?? null,
        payload: { action: "reorder", order: normalized },
      });
      return this.getStatuses();
    });
  }

  private assertPermutation(given: string[], configured: string[], what: "status" | "kind"): void {
    const seen = new Set<string>();
    for (const id of given) {
      if (seen.has(id)) throw new StapleError("validation", `"${id}" appears twice in the new ${what} order`);
      seen.add(id);
    }
    const missing = configured.filter((id) => !seen.has(id));
    const unknown = given.filter((id) => !configured.includes(id));
    if (unknown.length > 0) {
      throw new StapleError("validation", `Unknown ${what}${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    }
    if (missing.length > 0) {
      throw new StapleError(
        "validation",
        `A reorder must list every ${what}. Missing: ${missing.join(", ")}. ` +
          `Send all ${configured.length} in the order you want.`,
      );
    }
  }

  /**
   * Remove a status. Two independent guards, and neither is a warning:
   *
   *  - rows still carry it -> `--migrate-to <status>` is REQUIRED, and every such
   *    row is moved in the same transaction. Without it the issues would keep an
   *    id with no configuration, which is the state every guard in this file
   *    would then have to have an opinion about.
   *  - it is the last member of a category the code writes into -> refused
   *    outright. See `assertCategoryStaysPopulated`.
   *
   * The migration is a bare status rewrite: no events per issue, no timestamps,
   * no derivation. It is a RENAME of a vocabulary entry from the rows' point of
   * view, not seven hundred status transitions, and logging it as transitions
   * would poison every interval the timing replay reconstructs.
   */
  removeStatus(id: string, opts: { migrateTo?: string | null } = {}, actor?: string | null): { migrated: number } {
    return this.atomically(() => {
      const row = this.requireStatusRow(id);
      this.assertCategoryStaysPopulated(row, null);
      const used = this.statusUsageCount(id);
      let migrated = 0;
      if (used > 0) {
        const target = opts.migrateTo?.trim();
        if (!target) {
          throw new StapleError(
            "conflict",
            `${used} issue${used === 1 ? "" : "s"} still ${used === 1 ? "has" : "have"} status "${id}". ` +
              `Pass --migrate-to <status> to move ${used === 1 ? "it" : "them"} first.`,
            { status: id, issues: used },
          );
        }
        if (target === id) {
          throw new StapleError("validation", "--migrate-to must name a different status");
        }
        this.requireStatusRow(target);
        const result = this.db
          .prepare("UPDATE issues SET status = ?, updated_at = ? WHERE status = ?")
          .run(target, nowIso(), id);
        migrated = Number(result.changes);
      }
      this.db.prepare("DELETE FROM workspace_statuses WHERE id = ?").run(id);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "status_config_changed",
        actor: actor ?? null,
        payload: { action: "remove", id, migrateTo: opts.migrateTo ?? null, migrated },
      });
      return { migrated };
    });
  }

  addKind(input: { id: string; label?: string; after?: string | null }, actor?: string | null): WorkspaceKind {
    const id = assertVocabularyId(input.id, "kind");
    const label = (input.label ?? "").trim() || defaultLabel(id);
    return this.atomically(() => {
      if (this.settings().kinds.some((kind) => kind.id === id)) {
        throw new StapleError("duplicate", `Kind "${id}" already exists in workspace ${this.slug}`);
      }
      let order = this.insertionOrder(this.settings().kinds, input.after);
      if (Number.isNaN(order)) {
        this.renormalize("workspace_kinds");
        this.settingsCache = null;
        order = this.insertionOrder(this.settings().kinds, input.after);
      }
      this.db
        .prepare("INSERT INTO workspace_kinds (id, label, sort_order, is_builtin) VALUES (?, ?, ?, 0)")
        .run(id, label, order);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "kind_config_changed",
        actor: actor ?? null,
        payload: { action: "add", id, label },
      });
      return this.requireKindRow(id);
    });
  }

  renameKind(id: string, label: string, actor?: string | null): WorkspaceKind {
    const next = label.trim();
    if (!next) throw new StapleError("validation", "Kind label cannot be empty");
    return this.atomically(() => {
      const before = this.requireKindRow(id);
      this.db.prepare("UPDATE workspace_kinds SET label = ? WHERE id = ?").run(next, id);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "kind_config_changed",
        actor: actor ?? null,
        payload: { action: "rename", id, from: before.label, to: next },
      });
      return this.requireKindRow(id);
    });
  }

  reorderKinds(ids: string[], actor?: string | null): WorkspaceKind[] {
    return this.atomically(() => {
      const normalized = ids.map((id) => assertVocabularyId(id, "kind"));
      this.assertPermutation(normalized, this.settings().kinds.map((k) => k.id), "kind");
      const update = this.db.prepare("UPDATE workspace_kinds SET sort_order = ? WHERE id = ?");
      normalized.forEach((id, index) => update.run((index + 1) * SORT_ORDER_STEP, id));
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "kind_config_changed",
        actor: actor ?? null,
        payload: { action: "reorder", order: normalized },
      });
      return this.getKinds();
    });
  }

  /**
   * Same contract as `removeStatus`, minus the category guard — kinds have no
   * behaviour, so emptying the list is merely useless rather than incoherent.
   * The last kind is still protected: O1a's `issues.kind` is NOT NULL, so a
   * workspace with no kinds could not create an issue.
   */
  removeKind(id: string, opts: { migrateTo?: string | null } = {}, actor?: string | null): { migrated: number } {
    return this.atomically(() => {
      this.requireKindRow(id);
      if (this.settings().kinds.length === 1) {
        throw new StapleError("validation", `"${id}" is the only kind left; a workspace needs at least one.`);
      }
      const used = this.kindUsageCount(id);
      let migrated = 0;
      if (used > 0) {
        const target = opts.migrateTo?.trim();
        if (!target) {
          throw new StapleError(
            "conflict",
            `${used} issue${used === 1 ? "" : "s"} still ${used === 1 ? "has" : "have"} kind "${id}". ` +
              `Pass --migrate-to <kind> to move ${used === 1 ? "it" : "them"} first.`,
            { kind: id, issues: used },
          );
        }
        if (target === id) throw new StapleError("validation", "--migrate-to must name a different kind");
        this.requireKindRow(target);
        const result = this.db
          .prepare("UPDATE issues SET kind = ?, updated_at = ? WHERE kind = ?")
          .run(target, nowIso(), id);
        migrated = Number(result.changes);
      }
      this.db.prepare("DELETE FROM workspace_kinds WHERE id = ?").run(id);
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "kind_config_changed",
        actor: actor ?? null,
        payload: { action: "remove", id, migrateTo: opts.migrateTo ?? null, migrated },
      });
      // A default that names a kind which no longer exists is not a setting, it
      // is a dangling pointer; clear it here so `defaultKind()` never has to guess.
      if (this.getSetting("kinds.default") === id) this.resetSetting("kinds.default", actor);
      return { migrated };
    });
  }

  /**
   * Apply a batch of ops in ONE transaction, in the order given.
   *
   * The MCP write tools take a batch rather than one op per call because "add
   * `awaiting_approval` and put it after `in_review`" is one intention, and
   * splitting it across two round trips leaves a window where the board is
   * visibly wrong. Ordered, not set-based: `add` then `reorder` in the same
   * batch has to see the added row.
   */
  applyStatusOps(ops: readonly VocabularyOp[], actor?: string | null): WorkspaceStatus[] {
    return this.atomically(() => {
      for (const op of ops) {
        switch (op.op) {
          case "add":
            this.addStatus(
              { id: op.id, label: op.label, category: op.category ?? "", after: op.after },
              actor,
            );
            break;
          case "rename":
            this.renameStatus(op.id, op.label, actor);
            break;
          case "recategorize":
            this.recategorizeStatus(op.id, op.category, actor);
            break;
          case "reorder":
            this.reorderStatuses(op.ids, actor);
            break;
          case "remove":
            this.removeStatus(op.id, { migrateTo: op.migrateTo }, actor);
            break;
          default:
            throw new StapleError("validation", `Unknown status op "${(op as { op: string }).op}"`);
        }
      }
      return this.getStatuses();
    });
  }

  applyKindOps(ops: readonly VocabularyOp[], actor?: string | null): WorkspaceKind[] {
    return this.atomically(() => {
      for (const op of ops) {
        switch (op.op) {
          case "add":
            this.addKind({ id: op.id, label: op.label, after: op.after }, actor);
            break;
          case "rename":
            this.renameKind(op.id, op.label, actor);
            break;
          case "reorder":
            this.reorderKinds(op.ids, actor);
            break;
          case "remove":
            this.removeKind(op.id, { migrateTo: op.migrateTo }, actor);
            break;
          case "recategorize":
            throw new StapleError("validation", "Kinds have no category — only statuses do.");
          default:
            throw new StapleError("validation", `Unknown kind op "${(op as { op: string }).op}"`);
        }
      }
      return this.getKinds();
    });
  }

  // ---------- workspace settings: registered values (R6a, STA-176) ----------

  /**
   * The effective value of ONE registered workspace setting: the stored value
   * when there is one, the definition's default otherwise. Refuses a key the
   * registry does not know or one that is global — a global preference lives in
   * config.json and asking a workspace for it would be asking the wrong store.
   */
  getSetting(key: string): unknown {
    const definition = requireSettingDefinition(key, "workspace");
    return this.settings().values.get(key)?.value ?? definition.default;
  }

  /** Every registered workspace setting with its provenance, in registry order. */
  settingValues(): SettingValueView[] {
    const values = this.settings().values;
    return settingDefinitionsFor("workspace").map((definition) => {
      const stored = values.get(definition.key);
      return stored
        ? settingValueView(definition, stored.value, "workspace")
        : settingValueView(definition, definition.default, "default");
    });
  }

  /** `setting:*` rows this binary has no definition for. Reported, preserved, never rewritten. */
  unknownSettingKeys(): string[] {
    return [...this.settings().unknownSettingKeys];
  }

  /**
   * Persist a registered workspace value. The WRITE boundary: the registry
   * validates the shape, and the store adds the one rule only it can check —
   * `kinds.default` must name a configured kind. Bumps the settings revision so
   * every other connection's snapshot is stale, and logs actor, previous and
   * new value as a `setting_changed` event.
   */
  setSetting(key: string, value: unknown, actor?: string | null): SettingValueView {
    const definition = requireSettingDefinition(key, "workspace");
    const next = validateSettingValue(definition, value, `workspace ${this.slug}`);
    if (key === "kinds.default") this.assertConfiguredKind(next as string);
    return this.atomically(() => {
      const from = this.getSetting(key);
      this.db
        .prepare(
          `INSERT INTO meta (key, value) VALUES (?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(settingMetaKey(key), encodeStoredSetting(definition, next));
      this.bumpSettingsRevision();
      this.emitEvent({
        kind: "setting_changed",
        actor: actor ?? null,
        payload: { action: "set", key, from, to: next },
      });
      return settingValueView(definition, next, "workspace");
    });
  }

  /** Clear a stored value so the definition's default applies again. A no-op when nothing is stored. */
  resetSetting(key: string, actor?: string | null): SettingValueView {
    const definition = requireSettingDefinition(key, "workspace");
    return this.atomically(() => {
      const stored = this.settings().values.get(key);
      if (stored) {
        this.db.prepare("DELETE FROM meta WHERE key = ?").run(settingMetaKey(key));
        this.bumpSettingsRevision();
        this.emitEvent({
          kind: "setting_changed",
          actor: actor ?? null,
          payload: { action: "reset", key, from: stored.value, to: definition.default },
        });
      }
      return settingValueView(definition, definition.default, "default");
    });
  }

  /** Apply a batch of setting ops in ONE transaction, in order — the `target: "settings"` twin of `applyStatusOps`. */
  applySettingOps(ops: readonly SettingOp[], actor?: string | null): SettingValueView[] {
    return this.atomically(() => {
      for (const op of ops) {
        switch (op.op) {
          case "set":
            this.setSetting(op.key, op.value, actor);
            break;
          case "reset":
            this.resetSetting(op.key, actor);
            break;
          default:
            throw new StapleError("validation", `Unknown setting op "${(op as { op: string }).op}"`);
        }
      }
      return this.settingValues();
    });
  }

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
    if (input.status) this.assertConfiguredStatus(input.status);
    // Validated against THIS workspace's vocabulary, not a compile-time union —
    // which is what makes `staple kinds add milestone` work with no code change.
    // Before the transaction, like status and priority above, so a bad kind
    // cannot be discovered halfway through a create that has already consumed
    // an issue number.
    if (input.kind) this.assertConfiguredKind(input.kind);
    const kind = input.kind ?? this.defaultKind();
    // Validated BEFORE the transaction, like priority and status above: a bad
    // estimate must not be discovered halfway through a create that has already
    // consumed an issue number.
    const estimatedSeconds =
      input.estimatedSeconds == null ? null : assertEstimateSeconds(input.estimatedSeconds);

    /**
     * Default status: the workspace's READY status when the issue is assigned,
     * its UNSTARTED one otherwise. Same rule as before ("todo when assigned,
     * backlog otherwise") stated in categories, so a renamed vocabulary keeps it.
     */
    const status: IssueStatus =
      input.status ?? this.primaryStatusFor(input.assignee ? "ready" : "unstarted");
    const statusCategory = this.categoryOf(status);
    if ((input.unblockOwner || input.unblockAction) && statusCategory !== "blocked") {
      throw new StapleError("validation", "unblockOwner/unblockAction require a status in the \"blocked\" category");
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
             WHERE normalized_title = ? AND status NOT IN ${this.resolvedSql()}
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
             id, identifier, title, normalized_title, description, status, kind, priority,
             parent_id, depth, assignee, created_by, labels, acceptance_criteria,
             block_parent_until_done, unblock_owner, unblock_action, origin_kind, origin_id,
             idempotency_key, blocked_transition_at, estimated_seconds, started_at,
             created_at, updated_at
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
           RETURNING *`,
        )
        .get(
          id,
          identifier,
          title,
          normalized,
          input.description ?? null,
          status,
          kind,
          input.priority ?? "medium",
          parent?.id ?? null,
          parent ? parent.depth + 1 : 0,
          input.assignee ?? null,
          input.createdBy ?? null,
          JSON.stringify(input.labels ?? []),
          input.acceptanceCriteria ? JSON.stringify(input.acceptanceCriteria) : null,
          input.blockParentUntilDone ? 1 : 0,
          statusCategory === "blocked" ? (input.unblockOwner ?? null) : null,
          statusCategory === "blocked" ? (input.unblockAction ?? null) : null,
          input.originKind ?? "manual",
          input.originId ?? null,
          input.idempotencyKey ?? null,
          statusCategory === "blocked" ? now : null,
          estimatedSeconds,
          statusCategory === "active" ? now : null,
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
      // Transition site 1 of 5: a child appearing under a parent changes the
      // child landscape as surely as one moving does. The rule is about state,
      // not about which call produced it — so this is no longer gated on the
      // child being born `in_progress` (STA-98 widened it from STA-79's flip).
      // A backlog child born under a backlog/todo parent is still a no-op: the
      // workable band absorbs it without a write.
      if (parent) {
        this.recomputeAncestorStatuses(row, input.createdBy ?? null);
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
   * BFS over the whole "blocks" graph: adding each proposed blocker may not
   * create a path from the issue back to that blocker.
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

  /** Replace the full blocked-by set — set replacement, never incremental add. */
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
      (b) => !this.isResolvedStatus(b.status),
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
         WHERE r.type = 'blocks' AND b.status NOT IN ${this.resolvedSql()}
           AND r.blocked_id IN (${issueIds.map(() => "?").join(",")})
         ORDER BY b.identifier`,
      )
      .all(...(issueIds as never[])) as Array<{ blocked_id: string; identifier: string }>;
    for (const row of rows) byIssue.get(row.blocked_id)?.push(row.identifier);
    return byIssue;
  }

  /**
   * The OPEN issues each of `issueIds` blocks, by identifier, in ONE query — O6 (STA-138).
   *
   * The mirror image of `unresolvedBlockersFor`, and it is deliberately written as its
   * reflection rather than as a generalised helper with a direction flag: the two SELECTs
   * differ in which end of the edge they join and WHICH END'S STATUS they filter on, and a
   * flag hides exactly that distinction. Here it is the DEPENDENT's status that matters — a
   * cancelled task waiting on you is not waiting on you.
   *
   * The badge could have been fed a bare count. Identifiers cost the same query, and they
   * are what lets the badge's tooltip name what it is counting without a second fetch.
   */
  openDependentsFor(issueIds: readonly string[]): Map<string, string[]> {
    const byIssue = new Map<string, string[]>(issueIds.map((id) => [id, []]));
    if (issueIds.length === 0) return byIssue;
    const rows = this.db
      .prepare(
        `SELECT r.blocker_id AS blocker_id, d.identifier AS identifier
         FROM relations r JOIN issues d ON d.id = r.blocked_id
         WHERE r.type = 'blocks' AND d.status NOT IN ${this.resolvedSql()}
           AND r.blocker_id IN (${issueIds.map(() => "?").join(",")})
         ORDER BY d.identifier`,
      )
      .all(...(issueIds as never[])) as Array<{ blocker_id: string; identifier: string }>;
    for (const row of rows) byIssue.get(row.blocker_id)?.push(row.identifier);
    return byIssue;
  }

  private maybeEmitBlockersResolved(dependent: IssueRow): void {
    const all = this.blockersOf(dependent.id);
    if (all.length === 0) return;
    const unresolved = all.filter(
      (b) => !this.isResolvedStatus(b.status),
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
   * The blocked OPEN children of each of `issueIds`, with the descriptor the
   * child was blocked with — one query for the whole set.
   *
   * This is what a derived-blocked parent renders instead of an unblock
   * descriptor of its own (STA-98). The parent deliberately has none: the fact
   * being reported lives on the child, and copying it onto the parent would
   * create a second copy that goes stale the moment the child moves.
   *
   * Ordered by `created_at`, so a parent waiting on several children reads them
   * in the order they were raised.
   */
  blockingChildrenOf(
    issueIds: readonly string[],
  ): Map<string, Array<{ identifier: string; title: string; unblockOwner: string | null; unblockAction: string | null }>> {
    const byParent = new Map<
      string,
      Array<{ identifier: string; title: string; unblockOwner: string | null; unblockAction: string | null }>
    >(issueIds.map((id) => [id, []]));
    if (issueIds.length === 0) return byParent;
    const rows = this.db
      .prepare(
        `SELECT parent_id, identifier, title, unblock_owner, unblock_action
           FROM issues
          WHERE status = 'blocked'
            AND parent_id IN (${issueIds.map(() => "?").join(",")})
          ORDER BY created_at, rowid`,
      )
      .all(...(issueIds as never[])) as Array<{
      parent_id: string;
      identifier: string;
      title: string;
      unblock_owner: string | null;
      unblock_action: string | null;
    }>;
    for (const row of rows) {
      byParent.get(row.parent_id)?.push({
        identifier: row.identifier,
        title: row.title,
        unblockOwner: row.unblock_owner,
        unblockAction: row.unblock_action,
      });
    }
    return byParent;
  }

  /**
   * Is this row's CURRENT status something derivation wrote, rather than
   * something a human or an agent asserted?
   *
   * Read from the event log, not from a column — no schema change, and the
   * answer stays correct for every row already in every database, because the
   * log has carried `payload.derived` since STA-79.
   *
   * Two conditions, both load-bearing:
   *
   *  - the NEWEST status-moving event is a `status_changed` carrying a `derived`
   *    marker. Any other newest kind — a `checkout`, a `release`, a plain manual
   *    `status_changed` — means somebody acted on this issue last, and their
   *    statement outranks the derivation that preceded it. This is also what
   *    makes a claim and a derivation structurally unable to fight: the instant
   *    an agent checks an epic out, the epic becomes immune.
   *  - that event's `to` must equal the row's actual status. If the log cannot
   *    explain the row — a hand-edit, an import, a history written by another
   *    tool — this returns false and the row is treated as MANUAL, so derivation
   *    keeps its hands off. Declining beats guessing, the same instinct as
   *    `reconstructIntervals`.
   */
  private isDerivationOwned(row: Pick<IssueRow, "id" | "status">): boolean {
    const event = this.db
      .prepare(
        `SELECT kind, payload FROM events
          WHERE issue_id = ?
            AND kind IN (${STATUS_MOVING_EVENT_KINDS.map(() => "?").join(",")})
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(row.id, ...(STATUS_MOVING_EVENT_KINDS as readonly string[])) as
      | { kind: string; payload: string }
      | undefined;
    if (!event || event.kind !== "status_changed") return false;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.payload) as Record<string, unknown>;
    } catch {
      return false;
    }
    return typeof payload.derived === "string" && payload.to === row.status;
  }

  /**
   * The ladder: what a parent's status SHOULD read, given its children.
   *
   * The OPEN rungs are computed over open children only — a `done` child
   * contributes nothing to rungs 1-4. Returns null for "no derivation applies",
   * which is a distinct outcome from any status: it means leave the parent
   * exactly as it is.
   *
   * Every rung is stated in CATEGORIES since STA-140, never in status ids, so a
   * renamed, added or reordered status keeps exactly these semantics:
   *
   *  0. NO CHILDREN AT ALL            -> null
   *  1. any open child `active`       -> `active`
   *  2. else any open `review`        -> `review`
   *  3. else any open `unstarted`/`ready` -> the WORKABLE BAND
   *  4. else (all open blocked/gated) -> `blocked`
   *  5. nothing open, every child `cancelled` -> `cancelled`
   *  6. nothing open, at least one `done`     -> `done`
   *
   * Rung 4 is why `blocked` is EXCLUSIVE: it is last of the open rungs, so it
   * wins only when it is all that remains. One blocked child beside one backlog
   * child derives the workable band, because there is still work an agent can
   * pick up underneath. `gated` falls into the same rung as `blocked` — an
   * approval nobody has given is not work an agent can pick up, and it is not a
   * reason to demote a parent.
   *
   * That rung is also where a GATED CHILD lands (STA-143). The approval-gates
   * branch used to drop `awaiting_approval` children from the list entirely, so
   * a gate was invisible upward; the category ladder makes that both unnecessary
   * and unsafe. Unnecessary, because rung 4 exists and says the true thing — an
   * epic parked behind a review is not pickable, exactly like a blocked one.
   * Unsafe, because dropping it would empty `open` and hand the parent to rungs
   * 5/6, which read "nothing open" as FINISHED: a grandparent whose only
   * remaining child is parked behind a human review would auto-close. A gate is
   * the one thing that must never be mistaken for a completion.
   *
   * Rungs 5 and 6 are STA-153, and they REPLACE STA-98's refinement 2 ("resolved
   * never derives upward"). A parent whose every child has landed is finished:
   * leaving it in `in_progress` was the lie the ticket exists to remove. The two
   * rungs are asymmetric on purpose — `cancelled` needs unanimity, because one
   * shipped child means the parent shipped something, so any mix of done and
   * cancelled reads `done`. `children_complete` still fires: it is the wake that
   * tells the owner to write the summary the automatic close cannot write.
   *
   * Rung 0 is now the ONLY "nothing to say" answer, and it is the ticket's
   * explicit carve-out: a leaf — an issue with no children at all — is untouched
   * by every rule here, forever.
   */
  private deriveStatusFromChildren(childStatuses: readonly string[]): DerivedRung | null {
    if (childStatuses.length === 0) return null; // rung 0: a leaf is nobody's parent
    const open = childStatuses.filter((status) => !this.isResolvedStatus(status));
    if (open.length === 0) {
      return childStatuses.every((status) => this.categoryOf(status) === "cancelled")
        ? "cancelled"
        : "done";
    }
    const categories = new Set(open.map((status) => this.categoryOf(status)));
    if (categories.has("active")) return "active";
    if (categories.has("review")) return "review";
    if (WORKABLE_CATEGORIES.some((category) => categories.has(category))) return "workable";
    return "blocked";
  }

  /**
   * Recompute every ancestor's derived status after a child transition, and
   * write the ones derivation is allowed to write. (STA-98, generalizing
   * STA-79's one-way `in_progress` flip.)
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
   * ## Which ancestors may be written — the reversibility law
   *
   * Derivation may only change what derivation set, so:
   *
   * - `backlog`/`todo`: always. This is STA-79's law unchanged: the pre-work band
   *   is the ABSENCE of a statement about the parent, not a statement, so
   *   derivation is free to speak into it.
   * - EVERYTHING ELSE — `in_progress`, `in_review`, `blocked`, and since STA-153
   *   `done`/`cancelled` too: only when `isDerivationOwned` says derivation
   *   itself wrote it. A manual `blocked` with an unblockOwner, a manual
   *   `in_review`, a genuinely claimed epic, an epic a human closed by hand —
   *   all immune, permanently, until whoever set them moves them.
   *
   * STA-153 deleted the one exception this law used to carry ("resolved is
   * terminal in both directions") rather than adding a second rule beside it, so
   * closing and re-opening a parent are governed by the same sentence as every
   * other rung. What follows from that is the whole of the new behaviour:
   * a parent the tracker put in `in_progress` closes itself when its last child
   * lands, and re-opens when a child comes back; a parent a HUMAN closed, or
   * cancelled, or parked, stays where the human put it. The parents VP saw stuck
   * in `in_progress` are in the first set by construction — they got there
   * through STA-79's derivation, never through a human.
   *
   * ## The workable band
   *
   * Rung 3 targets a BAND — {`backlog`, `todo`} — rather than a value. A parent
   * already in either is left completely alone: no write, no version bump, no
   * event. That is what stops the rule generating churn in the two directions
   * that would only ever be noise: a `todo` epic a human deliberately readied is
   * never demoted to `backlog`, and creating a `backlog` child under a
   * `backlog`/`todo` parent changes nothing at all.
   *
   * Entering the band writes `backlog`, not `todo`. `todo` in this tracker means
   * READY FOR PICKUP — `inbox` orders the ready list in_progress -> in_review ->
   * todo -> backlog — and an epic is never picked up, its children are. Deriving
   * epics into `todo` would seed the top of the pickup queue with rows no agent
   * should ever claim. `backlog` says the honest thing: there is open, workable,
   * unstarted work underneath, and nothing is in flight.
   *
   * ## The walk
   *
   * Iterative, bounded by `MAX_TREE_DEPTH`, and cycle-proof — `createIssue` caps
   * depth, but a walk over possibly-corrupt `parent_id` links must not be the
   * thing that hangs. It CONTINUES past an ancestor it did not write rather than
   * stopping at it: stopping would make the outcome depend on history, where an
   * epic parked in `in_review` would permanently shield its own parent. What
   * propagates upward is each ancestor's CURRENT status, so an immune ancestor
   * stops propagating its own value without stopping the walk.
   *
   * Runs inside the caller's transaction, so every ancestor write commits with
   * the child's own transition — there is no window where the child has moved
   * and an epic still reports the old thing.
   */
  private recomputeAncestorStatuses(
    child: Pick<IssueRow, "id" | "identifier" | "parent_id">,
    actor: string | null,
  ): void {
    const now = nowIso();
    const seen = new Set<string>([child.id]);
    let cursor = child.parent_id;
    let hops = 0;
    while (cursor && hops < MAX_TREE_DEPTH && !seen.has(cursor)) {
      seen.add(cursor);
      const ancestor = this.db.prepare("SELECT * FROM issues WHERE id = ?").get(cursor) as unknown as
        | IssueRow
        | undefined;
      if (!ancestor) break;
      this.deriveOneAncestor(ancestor, child.identifier, actor, now);
      cursor = ancestor.parent_id;
      hops += 1;
    }
  }

  /** One rung of the walk: decide, check permission, CAS, and log. */
  private deriveOneAncestor(
    ancestor: IssueRow,
    trigger: string,
    actor: string | null,
    now: string,
  ): void {
    /**
     * A PARKED parent is immune, in both directions (STA-143).
     *
     * The gate is a statement by a human about this issue — the strongest kind
     * of statement in the reversibility law — so derivation may not speak over
     * it. Concretely: a child that is still in flight when the gate goes up
     * would otherwise derive the active rung and un-park the parent the moment
     * it moved, silently discarding the review.
     *
     * Stated as a CATEGORY (STA-140), not as the id `awaiting_approval`, so a
     * workspace that renamed the row or added a second gated status gets the
     * same immunity with no line changing here. And stated explicitly rather
     * than left to `isDerivationOwned` returning false — it would, since the
     * newest status-moving event on a parked parent is a plain `status_changed`
     * with no `derived` marker, but "only the gate's own transitions may leave
     * the gated category" is a rule of this feature, not an accident of what the
     * log happens to hold, and a rule nobody can see is a rule that gets
     * refactored away.
     */
    if (this.categoryOf(ancestor.status) === "gated") return;

    const childStatuses = (
      this.db.prepare("SELECT status FROM issues WHERE parent_id = ?").all(ancestor.id) as Array<{
        status: string;
      }>
    ).map((row) => row.status);
    const target = this.deriveStatusFromChildren(childStatuses);
    if (target === null) return; // rung 0: no children, so nothing to report

    /**
     * AN OPEN GATE OUTRANKS THE CLOSING RUNGS (STA-143 x STA-153).
     *
     * STA-153 made a parent close itself when its last child lands. STA-143 made
     * a parent something a human has to sign off. Where those meet, the human
     * wins: an issue whose gate is `pending` or `changes_requested` may not be
     * closed by rungs 5/6, because the review IS the remaining work and an
     * automatic `done` would answer the question the gate was asked to put to a
     * person.
     *
     * `pending` is already covered by the category immunity above — the parent
     * sits in the gated category while it waits. `changes_requested` is not, and
     * it is the case that matters: `requestChanges` deliberately moves the parent
     * back into the workable band so the work can resume, so the parent is in
     * `todo` with an unanswered gate on it, and the last child landing again
     * would otherwise close it out from under the reviewer who asked for the
     * changes. Re-gating is the resubmit loop; auto-closing would skip it.
     *
     * Only the CLOSING rungs are refused. Rungs 1-4 still apply, so a parent
     * with changes requested still reports that work has restarted underneath —
     * that is a report, and reports are what derivation is for.
     */
    if ((target === "done" || target === "cancelled") && isActiveGate(ancestor.gate_state)) return;

    /**
     * Everything below is stated in CATEGORIES (STA-140). The band, the
     * reversibility law and the write target were literal ids; they are now the
     * `unstarted`/`ready` pair, the ancestor's own category, and the FIRST
     * configured status of the target category — so a workspace that renamed
     * `blocked` to `waiting` derives into `waiting` without a line changing here.
     */
    const ancestorCategory = this.categoryOf(ancestor.status);
    const inPreWorkBand =
      ancestorCategory !== null && WORKABLE_CATEGORIES.includes(ancestorCategory);

    // The workable band is satisfied by either of its members.
    if (target === "workable" && inPreWorkBand) return;
    /**
     * Entering the band writes the UNSTARTED status, never the READY one, and
     * that is the same decision as before under a different name: `ready` means
     * READY FOR PICKUP and heads the inbox, while an epic is never picked up —
     * its children are. Deriving epics into `ready` would seed the top of every
     * agent's queue with rows nobody should claim.
     */
    const next = this.primaryStatusFor(target === "workable" ? "unstarted" : target);
    if (next === ancestor.status) return;

    // Reversibility law: outside the pre-work band, only what derivation set.
    if (!inPreWorkBand && !this.isDerivationOwned(ancestor)) return;

    /**
     * `started_at` is stamped once and never rewound, so an epic that lights up,
     * goes quiet and lights up again keeps the instant work FIRST began under it.
     *
     * A derived `blocked` gets `blocked_transition_at` but explicitly NO
     * descriptor: `unblock_owner`/`unblock_action` are forced NULL, because the
     * fact belongs to the blocking child and the UI borrows it from there. Any
     * descriptor left over from an earlier manual block would be a stale lie, so
     * leaving `blocked` clears all three exactly as `updateIssue` does.
     *
     * A derived close stamps the SAME timestamp a manual one does —
     * `completed_at` for the done category, `cancelled_at` for cancelled — so
     * every consumer that reads "when did this finish" keeps working without
     * learning that a parent finishes differently from a leaf (STA-153).
     *
     * A derived RE-OPEN clears both, for the same reason the blocked descriptor
     * is cleared on the way out: a row that is open again while still carrying
     * the instant it completed is a stale lie, and derivation cleans up exactly
     * what derivation stamped.
     *
     * Nothing here touches `assignee`, `checkout_agent` or `checkout_at`. That
     * omission is the guard exemption made structural rather than promised.
     */
    const columns: Record<string, unknown> = {
      status: next,
      updated_at: now,
    };
    if (target === "active") columns.started_at = ancestor.started_at ?? now;
    const wasResolved = ancestorCategory !== null && RESOLVED_CATEGORIES.includes(ancestorCategory);
    if (target === "done") {
      columns.completed_at = now;
      if (wasResolved) columns.cancelled_at = null;
    } else if (target === "cancelled") {
      columns.cancelled_at = now;
      if (wasResolved) columns.completed_at = null;
    } else if (wasResolved) {
      columns.completed_at = null;
      columns.cancelled_at = null;
    }
    if (target === "blocked") {
      columns.blocked_transition_at = now;
      columns.unblock_owner = null;
      columns.unblock_action = null;
    } else if (ancestorCategory === "blocked" || ancestorCategory === "gated") {
      columns.blocked_transition_at = null;
      columns.unblock_owner = null;
      columns.unblock_action = null;
    }

    // Compare-and-swap on the status the decision was made from, and gate the
    // event on the write, so an event can never claim a transition that did not
    // land. `status_version` bumps because anyone holding an
    // `expectedStatusVersion` for this epic must be forced to re-read.
    // `RETURNING *` because a close has to hand the FRESH row to
    // `afterResolution` below — the row as it now is, not as it was decided from.
    const assignments = Object.keys(columns).map((c) => `${c} = ?`).join(", ");
    const written = this.db
      .prepare(
        `UPDATE issues SET ${assignments}, status_version = status_version + 1
          WHERE id = ? AND status = ? RETURNING *`,
      )
      .get(...(Object.values(columns) as never[]), ancestor.id, ancestor.status) as unknown as
      | IssueRow
      | undefined;
    if (!written) return;

    /**
     * Reuses `status_changed` rather than minting a kind, for a concrete reason:
     * the UI timeline already renders `status_changed` as "status backlog →
     * in_progress", while an unknown kind falls to its fail-soft branch and
     * prints raw underscore-prose. Reuse renders correctly with no UI change;
     * `derived`/`derivedFrom` are additive, and they are what tells a consumer —
     * the timeline, the timing replay, and `isDerivationOwned` itself — that this
     * was not a human acting on the epic. The actor is the child's actor, because
     * they caused it.
     *
     * The marker names the RUNG that fired, not just "derived", so a timeline can
     * say why. `in_progress` keeps STA-79's exact `child_started` value: that
     * rung's behaviour did not change, so neither should its wire format.
     */
    this.emitEvent({
      kind: "status_changed",
      issueId: ancestor.id,
      actor,
      payload: {
        identifier: ancestor.identifier,
        from: ancestor.status,
        to: next,
        derived: DERIVED_MARKERS[target],
        derivedFrom: trigger,
      },
    });

    /**
     * A derived close is a resolution like any other, so it runs the WHOLE
     * resolution hook rather than a hand-picked half of it (STA-153):
     *
     *  - anything `blocks`-dependent on this epic is woken, because "the epic is
     *    done" is exactly the fact those dependents were waiting for, and an
     *    automatic close that skipped the wake would strand them;
     *  - the epic's OWN parent gets `children_complete` when this was its last
     *    open child, which is what makes the wake transitive up a chain that is
     *    closing itself level by level.
     *
     * It cannot recurse: `afterResolution` only emits events. The walk in
     * `recomputeAncestorStatuses` is what climbs, and it is bounded.
     */
    if (this.isResolvedStatus(next)) this.afterResolution(written);
  }

  /**
   * Fires after an issue reaches done/cancelled: dependency wakes + parent
   * completion. Called from the manual transition in `updateIssue` and from a
   * derived close in `deriveOneAncestor` — the two ways an issue can resolve.
   */
  private afterResolution(row: IssueRow): void {
    for (const dependent of this.dependentsOf(row.id)) {
      this.maybeEmitBlockersResolved(dependent);
    }
    if (row.parent_id) {
      const siblings = this.db
        .prepare("SELECT id, identifier, status, title FROM issues WHERE parent_id = ?")
        .all(row.parent_id) as Array<{ id: string; identifier: string; status: string; title: string }>;
      const open = siblings.filter(
        (s) => !this.isResolvedStatus(s.status),
      );
      if (open.length === 0 && siblings.length > 0) {
        const parent = this.db
          .prepare("SELECT * FROM issues WHERE id = ?")
          .get(row.parent_id) as unknown as IssueRow | undefined;
        if (parent && !this.isResolvedStatus(parent.status)) {
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

  // ---------- approval gates (STA-143) ----------

  /**
   * The gate on one issue, or null when none was ever requested.
   *
   * A read of stored columns, unlike `queuedBy` below which is a derivation.
   * Both are siblings of the issue on every surface, which is deliberate: a
   * caller looking at one row wants "is this parked" and "is this queued" side
   * by side, and conflating them into one field would lose the distinction
   * between holding a queue and standing in one.
   */
  gate(ref: string): IssueGate | null {
    return rowToGate(this.requireRow(ref));
  }

  /** One batched read of `gate` for a whole page. Absent id => absent key. */
  gateFor(issueIds: readonly string[]): Map<string, IssueGate> {
    const gates = new Map<string, IssueGate>();
    if (issueIds.length === 0) return gates;
    const rows = this.db
      .prepare(
        `SELECT id, gate_state, gate_owner, gate_requested_by, gate_requested_at,
                gate_resolved_by, gate_resolved_at
           FROM issues
          WHERE gate_state IS NOT NULL
            AND id IN (${issueIds.map(() => "?").join(",")})`,
      )
      .all(...(issueIds as never[])) as Array<
      Pick<
        IssueRow,
        | "id"
        | "gate_state"
        | "gate_owner"
        | "gate_requested_by"
        | "gate_requested_at"
        | "gate_resolved_by"
        | "gate_resolved_at"
      >
    >;
    for (const row of rows) {
      const gate = rowToGate(row);
      if (gate) gates.set(row.id, gate);
    }
    return gates;
  }

  /**
   * The narrow projection the ancestor walks run against: one scan of the four
   * facts a gate walk needs, for the whole workspace.
   *
   * A recursive CTE per issue would be the textbook answer and is the wrong one
   * here. `queuedByFor` is called on every list, every inbox and every checkout,
   * usually for tens to hundreds of ids at once, and the ancestor chains overlap
   * almost completely — the same epic is the parent of everything on the page.
   * One narrow scan shared by the whole batch beats N walks through the b-tree,
   * and it is the same trade `claimActivityFor` and `worklogSummaryFor` already
   * make.
   */
  private gateWalkIndex(): GateWalkIndex {
    const rows = this.db
      .prepare(
        "SELECT id, parent_id, identifier, title, status, gate_state, gate_owner, gate_released FROM issues",
      )
      .all() as Array<{
      id: string;
      parent_id: string | null;
      identifier: string;
      title: string;
      status: string;
      gate_state: string | null;
      gate_owner: string | null;
      gate_released: number;
    }>;
    const nodes = new Map<string, GateWalkNode>(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          parentId: row.parent_id,
          identifier: row.identifier,
          title: row.title,
          status: row.status as IssueStatus,
          gateState: row.gate_state,
          gateOwner: row.gate_owner ?? "?",
          released: row.gate_released === 1,
          hasChildren: false,
          hasOpenDescendant: false,
        },
      ]),
    );

    /** Child ids in insertion order, which is `createChild` order — see `gateQueueOf`. */
    const children = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.parent_id) continue;
      const parent = nodes.get(row.parent_id);
      if (!parent) continue;
      parent.hasChildren = true;
      const siblings = children.get(row.parent_id);
      if (siblings) siblings.push(row.id);
      else children.set(row.parent_id, [row.id]);
    }

    /**
     * `hasOpenDescendant` for every node, in one pass — NOT one subtree walk per
     * node.
     *
     * Climb from each OPEN row marking its ancestors, and stop the moment an
     * ancestor is already marked, because everything above it is already true.
     * Every edge is therefore visited at most twice across the whole index,
     * which is the budget this method has: `queuedByFor` runs on every list,
     * every inbox and every checkout.
     */
    for (const node of nodes.values()) {
      if (this.isResolvedStatus(node.status)) continue;
      let cursor = node.parentId;
      const seen = new Set<string>([node.id]);
      let hops = 0;
      while (cursor && hops < MAX_TREE_DEPTH && !seen.has(cursor)) {
        seen.add(cursor);
        const ancestor = nodes.get(cursor);
        if (!ancestor || ancestor.hasOpenDescendant) break;
        ancestor.hasOpenDescendant = true;
        cursor = ancestor.parentId;
        hops += 1;
      }
    }

    return { nodes, children };
  }

  /**
   * IS THIS ROW ELIGIBLE TO STAND IN A QUEUE AT ALL — VP's review, STA-154.
   *
   * Two rules, both learned from one screen on which neither held:
   *
   *  1. **A resolved row is never queued.** A queue is a queue of work still to
   *     do. Holding back something already finished releases nobody and blocks
   *     nobody, and a `done` row reading "Queued · awaiting VP on STA-119" is a
   *     claim the reviewer cannot act on. VP's snapshot had four of them under
   *     one parent, and they are what made the real queue unreadable.
   *
   *  2. **A parent that has children but nothing open underneath is not
   *     queued.** It has nothing to release, so approving it is a no-op — and a
   *     reviewer who ticks a no-op, approves it, and finds the row unchanged
   *     concludes the gate is broken. That was STA-122, exactly.
   *
   * The second rule is deliberately scoped to rows that HAVE children. An open
   * leaf also has an empty subtree, and it is the single most important thing a
   * gate holds: it IS the work. "Nothing open underneath" is only ever a
   * statement about a container.
   */
  private isQueueEligible(node: GateWalkNode): boolean {
    if (this.isResolvedStatus(node.status)) return false;
    if (node.hasChildren && !node.hasOpenDescendant) return false;
    return true;
  }

  /**
   * Which gate, if any, each of `issueIds` is QUEUED BEHIND.
   *
   * ## The walk
   *
   * Start at the issue and climb. The first ancestor holding an ACTIVE gate
   * (`GATE_QUEUEING_STATES`) is the answer. The issue's own gate is never the
   * answer — a parent holding a gate is not standing in its own queue — so the
   * search starts at `parent_id`.
   *
   * ## Release is a property of the SUBTREE, not of one row
   *
   * `gate_released` is set on the children a reviewer named, but a released
   * child's own descendants have to come with it: releasing STA-113 and leaving
   * its three subtasks queued behind the same gate would release nothing an
   * agent could actually work.
   *
   * So the walk carries a `released` flag upward. Any node on the path from the
   * issue to the gate — including the issue itself — that is flagged releases
   * everything below it from the NEXT gate encountered. The flag is then spent
   * (`released = false`) and the climb continues, because a release granted by
   * one reviewer says nothing about an OUTER gate somebody else is holding: a
   * child released from its epic's gate is still queued behind a gate on the
   * program above it.
   *
   * Bounded by `MAX_TREE_DEPTH` with a `seen` set, like every other walk in this
   * file: a corrupt `parent_id` cycle must not be the thing that hangs a list.
   */
  queuedByFor(issueIds: readonly string[]): Map<string, QueuedBy> {
    const queued = new Map<string, QueuedBy>();
    if (issueIds.length === 0) return queued;
    const index = this.gateWalkIndex();
    for (const id of issueIds) {
      const answer = this.queuedByIn(index, id);
      if (answer) queued.set(id, answer);
    }
    return queued;
  }

  /** The walk itself, against an index the caller already built. */
  private queuedByIn(index: GateWalkIndex, id: string): QueuedBy | null {
    const self = index.nodes.get(id);
    if (!self) return null;
    // Eligibility comes FIRST. A resolved row and an emptied-out parent are not
    // queued no matter what stands above them — see `isQueueEligible`.
    if (!this.isQueueEligible(self)) return null;
    let released = self.released;
    let cursor = self.parentId;
    const seen = new Set<string>([id]);
    let hops = 0;
    while (cursor && hops < MAX_TREE_DEPTH && !seen.has(cursor)) {
      seen.add(cursor);
      const node = index.nodes.get(cursor);
      if (!node) break;
      if (isActiveGate(node.gateState)) {
        if (!released) return { identifier: node.identifier, owner: node.gateOwner };
        // Released from THIS gate only; keep climbing for an outer one.
        released = false;
      } else if (node.released) {
        released = true;
      }
      cursor = node.parentId;
      hops += 1;
    }
    return null;
  }

  /**
   * THE QUEUE THIS GATE IS HOLDING — the reviewer's checklist (STA-154).
   *
   * `queuedByFor` answers "is this row queued" for a page of rows. This answers
   * the reviewer's question from the other end: standing at the gate, what am I
   * actually deciding about? Both go through `queuedByIn`, so the checklist and
   * every row caption on the page cannot disagree about one ticket — which is
   * the whole reason this is a store method and not a filter in the browser.
   *
   * A row is in the queue when it is a descendant of `ref`, it is eligible
   * (open, and not a container with nothing open underneath), and the gate it
   * stands in is THIS one. That last clause is what stops an inner gate's
   * subtree appearing here: `store.approveGate` would happily release it — it
   * is a descendant — but the decision belongs to whoever holds the inner gate,
   * and offering it is offering to overrule them.
   *
   * The result is a flat PRE-ORDER list, and `depth` counts the LISTED chain
   * rather than the real one. A row whose real parent was skipped is re-parented
   * onto the nearest listed ancestor, because an indent under a row that is not
   * on screen is a hole, and a hole in a checklist is a decision nobody can
   * reason about. See `GateQueueEntry`.
   *
   * Answers `[]` rather than refusing when there is no active gate: the detail
   * panel asks this of every issue it renders.
   */
  gateQueueOf(ref: string): GateQueueEntry[] {
    const row = this.requireRow(ref);
    if (!isActiveGate(row.gate_state)) return [];
    const index = this.gateWalkIndex();

    const out: GateQueueEntry[] = [];
    const walk = (parentId: string, depth: number): void => {
      if (depth > MAX_TREE_DEPTH) return;
      for (const childId of index.children.get(parentId) ?? []) {
        const node = index.nodes.get(childId);
        if (!node) continue;
        const listed = this.queuedByIn(index, childId)?.identifier === row.identifier;
        if (listed) {
          out.push({
            id: node.id,
            identifier: node.identifier,
            title: node.title,
            status: node.status,
            parentId: node.parentId,
            depth,
          });
        }
        // Recurse either way. A skipped row may still have listed work beneath
        // it (a done parent with an open subtask), and that work is re-parented
        // onto this level rather than left indented under nothing.
        walk(childId, listed ? depth + 1 : depth);
      }
    };
    walk(row.id, 1);
    return out;
  }

  /** Single-issue `queuedByFor`. Accepts any ref the rest of the store accepts. */
  queuedBy(ref: string): QueuedBy | null {
    const row = this.requireRow(ref);
    return this.queuedByFor([row.id]).get(row.id) ?? null;
  }

  /** Every descendant id of `rootId`, bounded like every other walk here. */
  private descendantIds(rootId: string): string[] {
    const out: string[] = [];
    let frontier = [rootId];
    const seen = new Set<string>([rootId]);
    for (let depth = 0; depth < MAX_TREE_DEPTH && frontier.length > 0; depth += 1) {
      const rows = this.db
        .prepare(
          `SELECT id FROM issues WHERE parent_id IN (${frontier.map(() => "?").join(",")})`,
        )
        .all(...(frontier as never[])) as Array<{ id: string }>;
      frontier = [];
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        out.push(row.id);
        frontier.push(row.id);
      }
    }
    return out;
  }

  /**
   * Park a parent behind a human review gate.
   *
   * Refusals, both deliberate:
   *
   *  - **No children.** A gate exists to queue the work underneath it. On a leaf
   *    there is nothing to queue, and the thing the caller actually wants is
   *    `in_review` — which already means "finished, waiting on a human" and
   *    already ranks READY in the inbox. Two statuses that mean review with no
   *    way to tell which one you need is exactly the confusion this refusal
   *    prevents.
   *  - **A gate that is still PENDING.** Re-gating would move the owner out
   *    from under a reviewer who has not answered yet.
   *
   * Note which state is NOT refused: `changes_requested`. That is the main loop
   * of this whole feature — the reviewer said "fix it", somebody fixed it, and
   * `staple gate` again is how it goes back for a re-read. Refusing it would
   * leave a subtree queued behind an objection with no way to answer it. An
   * `approved` gate can be re-gated too; that is simply a new review cycle.
   *
   * The claim is cleared. Nobody is working a parked parent by definition, and
   * leaving `checkout_agent` set would make the epic accrue idle time and show
   * up as a stale claim somebody should steal — the precise misreading (STA-108
   * sitting in_progress for 56 minutes while it waited on a human) that this
   * whole feature exists to end. `assignee` is left alone: who owns the work is
   * still true while it waits.
   */
  gateIssue(
    ref: string,
    opts: { owner: string; comment?: string },
    actor?: string | null,
  ): Issue {
    const owner = opts.owner?.trim();
    if (!owner) {
      throw new StapleError("validation", "gate requires --owner: name the human who must approve");
    }
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (this.isResolvedStatus(row.status)) {
        throw new StapleError(
          "conflict",
          `Cannot gate ${row.identifier}: it is already ${row.status}.`,
          { currentStatus: row.status },
        );
      }
      /**
       * WHERE THE GATE PARKS ITS PARENT IS A CONFIGURATION QUESTION (STA-140).
       *
       * The first status in the `gated` category, which on a default workspace
       * is `awaiting_approval`. Resolved before the write so a workspace that
       * has no gated status fails HERE, with `primaryStatusFor`'s sentence
       * naming the command that fixes it, rather than writing an id the
       * workspace does not have and failing a validation somewhere downstream.
       */
      const parkedStatus = this.primaryStatusFor("gated");
      const children = (
        this.db.prepare("SELECT id FROM issues WHERE parent_id = ?").all(row.id) as Array<{
          id: string;
        }>
      ).length;
      if (children === 0) {
        throw new StapleError(
          "validation",
          `Cannot gate ${row.identifier}: it has no children, so there is nothing to queue. Use \`staple status ${row.identifier} in_review\` for a leaf awaiting a human.`,
        );
      }
      if (row.gate_state === "pending") {
        throw new StapleError(
          "conflict",
          `${row.identifier} is already gated, awaiting ${row.gate_owner ?? "?"}. Resolve that gate before opening another.`,
          { currentStatus: row.status, gateState: row.gate_state, gateOwner: row.gate_owner },
        );
      }
      const now = nowIso();
      const updated = this.db
        .prepare(
          `UPDATE issues SET
             status = ?,
             status_version = status_version + 1,
             gate_state = 'pending',
             gate_owner = ?,
             gate_requested_by = ?,
             gate_requested_at = ?,
             gate_resolved_by = NULL,
             gate_resolved_at = NULL,
             checkout_agent = NULL,
             checkout_at = NULL,
             unblock_owner = NULL, unblock_action = NULL, blocked_transition_at = NULL,
             updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(parkedStatus, owner, actor ?? null, now, now, row.id) as unknown as IssueRow;

      /**
       * TWO events, and the pairing is load-bearing.
       *
       * `status_changed` keeps the timing replay exact: every status-writing
       * site in this file must emit a kind in `STATUS_MOVING_EVENT_KINDS`, or
       * the replay silently stops explaining the row and every affected issue
       * degrades to `approximate` with nothing going red. Emitting the status
       * move under the kind that already means "status moved" costs nothing and
       * needs no new case in `statusAfterEvent`.
       *
       * `gate_requested` carries the SEMANTICS — who was asked, by whom — which
       * `status_changed` has no field for and no business inventing one for.
       */
      this.emitEvent({
        kind: "status_changed",
        issueId: row.id,
        actor,
        payload: { identifier: row.identifier, from: row.status, to: parkedStatus },
      });
      this.emitEvent({
        kind: "gate_requested",
        issueId: row.id,
        actor,
        payload: {
          identifier: row.identifier,
          owner,
          previousStatus: row.status,
          previousHolder: row.checkout_agent,
        },
      });
      if (opts.comment) {
        this.insertComment(row.id, actor ?? "unknown", actor ? "agent" : "system", opts.comment);
      }
      // Transition site 6 of 7: parking a parent changes its status, so its own
      // ancestors have to be recomputed like any other transition. The gated row
      // reaches their ladder at rung 4 — an approval nobody has given is not
      // work anyone can pick up — so a grandparent with nothing else open reads
      // `blocked`, never `done` (see deriveStatusFromChildren).
      this.recomputeAncestorStatuses(updated, actor ?? null);
      return rowToIssue(updated);
    });
  }

  /**
   * Resolve a gate by approving it — wholly, or one named child at a time.
   *
   * ## Whole-gate approve
   *
   * The gate becomes `approved`, every descendant's `gate_released` is reset to
   * 0 (the per-child flags have done their job and a stale one would leak into
   * the NEXT gate cycle), and the parent's status is re-derived from its
   * children by the ordinary ladder — so an epic whose children are all backlog
   * comes back as `backlog`, not as whatever it happened to be before it was
   * parked. With nothing open underneath, it lands in `todo`: the work is
   * approved and somebody should close it, which is a pickup-able fact.
   *
   * ## Per-child approve
   *
   * Each named ref must be a DESCENDANT of the gated issue — approving a
   * stranger's ticket "as part of" this gate is a typo, not an intention, and
   * refusing it is cheaper than explaining the released row later. The parent
   * stays parked and the gate stays active, which is the entire point: the
   * reviewer is letting one thread proceed, not ending the review.
   *
   * ## What "an active gate" means here
   *
   * Both `pending` and `changes_requested` are accepted. Requesting changes does
   * not end the review — the children are still queued behind it (see
   * `GATE_QUEUEING_STATES`) — so approve has to be able to end it, or a reviewer
   * who asks for changes has trapped the subtree until somebody opens a whole
   * new gate cycle.
   */
  approveGate(
    ref: string,
    opts: { children?: readonly string[]; comment?: string } = {},
    actor?: string | null,
  ): Issue {
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (!isActiveGate(row.gate_state)) {
        throw new StapleError(
          "conflict",
          row.gate_state === "approved"
            ? `${row.identifier} has no gate awaiting approval — it was already approved${row.gate_resolved_by ? ` by ${row.gate_resolved_by}` : ""}.`
            : `${row.identifier} has no gate to approve. Park it first with \`staple gate ${row.identifier} --owner <who>\`.`,
          { currentStatus: row.status, gateState: row.gate_state },
        );
      }
      const now = nowIso();

      if (opts.children && opts.children.length > 0) {
        const descendants = new Set(this.descendantIds(row.id));
        const released: string[] = [];
        for (const childRef of opts.children) {
          const child = this.requireRow(childRef);
          if (!descendants.has(child.id)) {
            throw new StapleError(
              "validation",
              `${child.identifier} is not underneath ${row.identifier}, so this gate cannot release it.`,
              { identifier: child.identifier, gate: row.identifier },
            );
          }
          this.db
            .prepare("UPDATE issues SET gate_released = 1, updated_at = ? WHERE id = ?")
            .run(now, child.id);
          released.push(child.identifier);
          this.emitEvent({
            kind: "gate_child_approved",
            issueId: child.id,
            actor,
            payload: { identifier: child.identifier, gate: row.identifier, owner: row.gate_owner },
          });
        }
        if (opts.comment) {
          this.insertComment(row.id, actor ?? "unknown", actor ? "agent" : "system", opts.comment);
        }
        // The parent does not move: partial approval is not resolution. Re-read
        // so the caller sees the row as it now stands rather than as it was.
        return rowToIssue(this.requireRow(row.id));
      }

      // ---- whole-gate approve ----
      const descendants = this.descendantIds(row.id);
      if (descendants.length > 0) {
        this.db
          .prepare(
            `UPDATE issues SET gate_released = 0, updated_at = ?
              WHERE gate_released = 1 AND id IN (${descendants.map(() => "?").join(",")})`,
          )
          .run(now, ...(descendants as never[]));
      }

      const childStatuses = (
        this.db.prepare("SELECT status FROM issues WHERE parent_id = ?").all(row.id) as Array<{
          status: string;
        }>
      ).map((r) => r.status);
      const derived = this.deriveStatusFromChildren(childStatuses);
      /**
       * WHERE AN APPROVED PARENT LANDS.
       *
       * The ladder decides, because "what does this parent's own work look like
       * now" is exactly the ladder's question and the gate has stopped being the
       * answer to it. Three cases and each is deliberate:
       *
       *  - The ladder declines (rung 0: no children at all). Its "leave it
       *    alone" answer is not available to us — leaving it alone means leaving
       *    it parked, which is precisely the state this call exists to clear —
       *    so the READY status, the same landing request-changes uses. `gate`
       *    refuses a childless issue, so this is only reachable if the children
       *    were reparented or deleted while the gate was open.
       *  - The workable band, which enters at the UNSTARTED status for the same
       *    reason rung 3 does: an epic is never picked up, its children are.
       *  - Anything else, including `done` and `cancelled` (STA-153). A gate
       *    whose whole subtree landed while the reviewer was reading it SHOULD
       *    close on approval — that is the normal auto-close rule resuming the
       *    moment the human answers, and the auto-close guard in
       *    `deriveOneAncestor` is scoped to gates that are still OPEN precisely
       *    so that this one is not.
       */
      const next: IssueStatus =
        derived === null
          ? this.primaryStatusFor("ready")
          : this.primaryStatusFor(derived === "workable" ? "unstarted" : derived);
      const nextCategory = this.categoryOf(next);

      const updated = this.db
        .prepare(
          `UPDATE issues SET
             status = ?,
             status_version = status_version + 1,
             gate_state = 'approved',
             gate_resolved_by = ?,
             gate_resolved_at = ?,
             gate_released = 0,
             started_at = CASE WHEN ? = 1 THEN COALESCE(started_at, ?) ELSE started_at END,
             blocked_transition_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
             completed_at = CASE WHEN ? = 1 THEN ? ELSE completed_at END,
             cancelled_at = CASE WHEN ? = 1 THEN ? ELSE cancelled_at END,
             unblock_owner = NULL, unblock_action = NULL,
             updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(
          next,
          actor ?? null,
          now,
          nextCategory === "active" ? 1 : 0,
          now,
          nextCategory === "blocked" ? 1 : 0,
          now,
          nextCategory === "done" ? 1 : 0,
          now,
          nextCategory === "cancelled" ? 1 : 0,
          now,
          now,
          row.id,
        ) as unknown as IssueRow;

      this.emitEvent({
        kind: "status_changed",
        issueId: row.id,
        actor,
        payload: { identifier: row.identifier, from: row.status, to: next },
      });
      this.emitEvent({
        kind: "gate_approved",
        issueId: row.id,
        actor,
        payload: {
          identifier: row.identifier,
          owner: row.gate_owner,
          releasedDescendants: descendants.length,
          to: next,
        },
      });
      if (opts.comment) {
        this.insertComment(row.id, actor ?? "unknown", actor ? "agent" : "system", opts.comment);
      }
      /**
       * An approval that CLOSES the parent is a resolution like any other, so it
       * runs the whole hook before the walk, in the order STA-153 established:
       * dependents of a just-finished epic get woken, and the level above gets
       * its own `children_complete` before `recomputeAncestorStatuses` closes
       * it — the reverse order swallows the wake exactly when it matters.
       */
      if (this.isResolvedStatus(next)) this.afterResolution(updated);
      // Transition site 7 of 7 — unparking is a transition like any other.
      this.recomputeAncestorStatuses(updated, actor ?? null);
      return rowToIssue(updated);
    });
  }

  /**
   * Resolve a gate by sending it back with a comment.
   *
   * The comment is MANDATORY, and it is stored as a real comment rather than
   * only as event payload. A reviewer's objection is the single most important
   * thing anyone picking this ticket up next needs to read, and event payloads
   * are not where anyone reads. It rides in the `gate_changes_requested` event
   * too, so a timeline can render the objection inline without a second query.
   *
   * The parent returns to `todo` — pickable by ANYONE, with no automatic
   * re-checkout of whoever last held it. Nobody is woken up; the work simply
   * becomes available again with the reviewer's note attached.
   *
   * The children STAY QUEUED. See `GATE_QUEUEING_STATES` for why: "changes
   * requested" is not "released", and draining the queue on an objection is the
   * opposite of what the reviewer asked for.
   */
  requestChanges(ref: string, opts: { comment: string }, actor?: string | null): Issue {
    const comment = opts.comment?.trim();
    if (!comment) {
      throw new StapleError(
        "validation",
        "request-changes requires a comment (-m): say what has to change, or approve instead.",
      );
    }
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (!isActiveGate(row.gate_state)) {
        throw new StapleError(
          "conflict",
          `${row.identifier} has no gate awaiting a decision. Park it first with \`staple gate ${row.identifier} --owner <who>\`.`,
          { currentStatus: row.status, gateState: row.gate_state },
        );
      }
      const now = nowIso();
      // The READY status of this workspace, not the literal `todo` — the same
      // resolution `release` makes, for the same reason: this row is now
      // somebody's to pick up.
      const next = this.primaryStatusFor("ready");
      const updated = this.db
        .prepare(
          `UPDATE issues SET
             status = ?,
             status_version = status_version + 1,
             gate_state = 'changes_requested',
             gate_resolved_by = ?,
             gate_resolved_at = ?,
             checkout_agent = NULL,
             checkout_at = NULL,
             unblock_owner = NULL, unblock_action = NULL, blocked_transition_at = NULL,
             updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(next, actor ?? null, now, now, row.id) as unknown as IssueRow;

      this.emitEvent({
        kind: "status_changed",
        issueId: row.id,
        actor,
        payload: { identifier: row.identifier, from: row.status, to: next },
      });
      this.emitEvent({
        kind: "gate_changes_requested",
        issueId: row.id,
        actor,
        payload: { identifier: row.identifier, owner: row.gate_owner, comment },
      });
      this.insertComment(row.id, actor ?? "unknown", actor ? "agent" : "system", comment);
      this.recomputeAncestorStatuses(updated, actor ?? null);
      return rowToIssue(updated);
    });
  }

  // ---------- update ----------

  updateIssue(ref: string, patch: UpdateIssueInput, actor?: string | null): Issue {
    if (patch.status) this.assertConfiguredStatus(patch.status);
    if (patch.kind) this.assertConfiguredKind(patch.kind);
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
      // Two-state: absent leaves it alone, a string sets it. Re-declaring the
      // kind is a plain field write with no guard of its own — unlike status, a
      // kind carries no category and therefore no behaviour to violate.
      if (patch.kind !== undefined) next.kind = patch.kind;
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
      /**
       * Every guard below reads a CATEGORY (STA-140). `in_progress requires an
       * assignee` is really "the ACTIVE category requires an assignee", and
       * `completed_at` is stamped by entering the DONE category, so a workspace
       * that renamed `done` to `shipped` still stamps it.
       */
      const categoryBefore = this.categoryOf(row.status);
      const categoryAfter = this.categoryOf(statusAfter);

      if ((patch.unblockOwner !== undefined || patch.unblockAction !== undefined) &&
          categoryAfter !== "blocked") {
        throw new StapleError(
          "validation",
          "unblockOwner/unblockAction require a status in the \"blocked\" category",
        );
      }

      if (statusChanging) {
        /**
         * THE GATED CATEGORY is reachable and leavable ONLY through the gate
         * commands (STA-143). Both directions are refused here, and both matter:
         *
         *  - INTO it, because a status written without a gate would be a parked
         *    parent with no owner, no requester and no way to approve it — a
         *    dead end that looks like a review.
         *  - OUT OF it, because a parked parent is a promise to a human that
         *    nothing moves until they answer. `staple status <ref> todo` must
         *    not be a quieter `approve` that leaves the gate row saying
         *    `pending` forever while the queue silently drains.
         *
         * This includes `done` and `cancelled`: resolve the gate first, then
         * close the ticket. That is one extra command in exchange for never
         * having a resolved issue that still carries an unanswered gate.
         *
         * Keyed off the CATEGORY (STA-140), so a workspace that renamed
         * `awaiting_approval`, or added a second gated status of its own, gets
         * the same protection — and so does a workspace that removed the gated
         * vocabulary entirely, where the guard simply never fires because no
         * status can be in a category with no members.
         */
        if (categoryAfter === "gated") {
          throw new StapleError(
            "validation",
            `Cannot set "${statusAfter}" directly — park the issue with \`staple gate <ref> --owner <who>\`, which records who must approve it.`,
          );
        }
        if (categoryBefore === "gated") {
          throw new StapleError(
            "validation",
            `${row.identifier} is parked behind a review gate${row.gate_owner ? ` awaiting ${row.gate_owner}` : ""}; resolve it with \`staple approve ${row.identifier}\` or \`staple request-changes ${row.identifier} -m "..."\` before changing its status.`,
            { currentStatus: row.status, gateOwner: row.gate_owner },
          );
        }
        const assigneeAfter =
          patch.assignee !== undefined ? patch.assignee : row.assignee;
        if (categoryAfter === "active") {
          if (!assigneeAfter) {
            throw new StapleError("validation", `${statusAfter} requires an assignee`);
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
        if (categoryAfter === "done") next.completed_at = now;
        if (categoryAfter === "cancelled") next.cancelled_at = now;
        if (categoryAfter === "blocked") {
          next.blocked_transition_at = now;
          if (patch.unblockOwner !== undefined) next.unblock_owner = patch.unblockOwner;
          if (patch.unblockAction !== undefined) next.unblock_action = patch.unblockAction;
        }
        if (categoryBefore === "blocked" && categoryAfter !== "blocked") {
          next.unblock_owner = null;
          next.unblock_action = null;
          next.blocked_transition_at = null;
        }
        if (categoryBefore === "active" && categoryAfter !== "active") {
          next.checkout_agent = null;
          next.checkout_at = null;
        }
        next.status = patch.status;
        next.status_version = row.status_version + 1;
      } else if (categoryAfter === "blocked") {
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
        /**
         * The wake goes FIRST, and the order is load-bearing since STA-153.
         * `afterResolution` asks "is the parent still open?" before it wakes it,
         * and the parent is exactly what the recompute below is about to close.
         * Running the recompute first would mean the last child of an epic
         * silently swallowed the `children_complete` that tells the epic's owner
         * to go and write the summary. Reading the world as it was when the
         * child landed, then reacting to it, also makes the log read
         * cause-then-effect: child moved -> children complete -> epic closed.
         */
        if (this.isResolvedStatus(patch.status!)) {
          this.afterResolution(updated);
        }
        // Transition site 2 of 5, and the one the generalization widened most:
        // EVERY status change recomputes the ancestors, not only a start.
        // Guarded above like any manual transition; the ancestors it derives
        // from it are not (see the method). Emitted after the child's own event,
        // so the log reads cause-then-effect.
        this.recomputeAncestorStatuses(updated, actor ?? null);
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
    if (!this.isActiveStatus(row.status) || !row.checkout_agent || !row.checkout_at) return null;
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
            AND i.status IN ${sqlIdList(this.settings().active)}
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

  /**
   * Batch "latest worklog" for a list, keyed by issue id — the same batching shape and
   * the same contract as `claimActivityFor` above, and for the same reason: a list of 114
   * rows against a page polled every 1.5s cannot afford one lookup per row.
   *
   * ## The contract, which is the point of the method
   *
   * This is the ONE definition of "latest worklog" on the server. The row cue, the
   * Overview panel and the handoff filter all read it, so they cannot disagree about
   * which revision is current or how old it is — a disagreement that would otherwise
   * appear as the list and the drawer telling you different things about one ticket.
   *
   * An issue with no worklog is **absent from the map**, not present with a null value —
   * identical to `claimActivityFor`, so callers already know the shape. Routes turn that
   * absence into an explicit `worklog: null` on the wire; the map itself stays honest.
   *
   * ## Why the LEFT JOIN, and why on all three key columns
   *
   * `documents` holds the current revision number but not who wrote it; the author lives
   * on `document_revisions`. Both sides are primary-key lookups — `documents(issue_id,
   * key)` and `document_revisions(issue_id, key, revision)` — so this stays one indexed
   * query and needs no new index and no schema change. It is a LEFT join rather than an
   * inner one so an unsigned revision (`author IS NULL`, which `putDocument` permits)
   * still yields a summary instead of silently dropping the row: "there is a worklog and
   * nobody signed it" is a true and useful answer, and losing it would understate
   * coverage in exactly the direction this epic exists to fix.
   */
  worklogSummaryFor(issueIds: string[]): Map<string, WorklogSummary> {
    const out = new Map<string, WorklogSummary>();
    if (issueIds.length === 0) return out;
    const placeholders = issueIds.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT d.issue_id AS issue_id, d.key AS key, d.current_revision AS revisions,
                d.updated_at AS updated_at, r.author AS author
           FROM documents d
           LEFT JOIN document_revisions r
             ON r.issue_id = d.issue_id AND r.key = d.key AND r.revision = d.current_revision
          WHERE d.key = ? AND d.issue_id IN (${placeholders})`,
      )
      .all(WORKLOG_KEY, ...(issueIds as never[])) as Array<{
      issue_id: string;
      key: string;
      revisions: number;
      updated_at: string;
      author: string | null;
    }>;
    for (const row of rows) {
      out.set(row.issue_id, {
        key: row.key,
        revisions: row.revisions,
        updatedAt: row.updated_at,
        author: row.author,
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
   *                               recomputeAncestorStatuses' derived flips)
   *  - `checkout`              -> `in_progress` (the claim UPDATE)
   *  - `claim_stolen`          -> `in_progress` (the takeover UPDATE)
   *  - `release`,
   *    `claim_released_stale`  -> `todo` (the release UPDATE)
   *
   * Returning null for an unreadable payload is load-bearing: it is what routes
   * a history this code cannot trust into the `approximate` fallback instead of
   * silently producing a confident wrong number.
   */
  private statusAfterEvent(kind: string, payload: Record<string, unknown>): IssueStatus | null {
    /**
     * A status the replay can TRUST is one this workspace still configures. A
     * removed status is deliberately unreadable here rather than passed through:
     * the replay's whole contract is that it either reproduces the row's current
     * status exactly or declines and routes to `approximate`, and reasoning about
     * a vocabulary entry that no longer exists is precisely the guessing that
     * contract exists to forbid. (`removeStatus` migrates the ROWS, never the
     * event log — history is what happened.)
     */
    const asStatus = (value: unknown): IssueStatus | null =>
      typeof value === "string" && this.settings().byId.has(value) ? value : null;
    switch (kind) {
      case "issue_created":
        return asStatus(payload.status);
      case "status_changed":
        return asStatus(payload.to);
      case "checkout":
      case "claim_stolen":
        return this.primaryStatusFor("active");
      case "release":
      case "claim_released_stale":
        return this.primaryStatusFor("ready");
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
   * **An interval opened by a derived flip is dropped, not counted.** A parent's
   * status is derived from its children (STA-79, generalized by STA-98), and any
   * such flip carries a `payload.derived` marker. That is a REPORT about the
   * children, and billing the epic's own clock for it is defect #1 of the old
   * scheme. The interval is still tracked (it has to be, so the next transition
   * closes the right thing) — it simply contributes nothing.
   *
   * The test is "carries a `derived` marker", NOT equality against one value.
   * STA-98 added rungs beyond `child_started`, and matching one string would
   * have silently started billing epics again for the new ones — a regression
   * that changes numbers without failing anything. It applies to `in_review`
   * too: a derived review window is the identical lie in a different bucket.
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
  private reconstructIntervals(
    currentStatus: string,
    events: readonly { kind: string; createdAt: string; payload: Record<string, unknown> }[],
    clampAt: string,
  ): OwnTiming | null {
    const first = events[0];
    if (!first || first.kind !== "issue_created") return null;
    let status = this.statusAfterEvent(first.kind, first.payload);
    if (!status) return null;

    let openAt: string | null = null;
    // A derived open interval is tracked but never counted, in EITHER bucket.
    // Creation is never derived — nothing flips an issue that does not exist yet.
    let openDerived = false;
    let active = 0;
    let review = 0;
    let sawActive = false;
    let sawReview = false;
    /**
     * Which bucket an interval belongs to is a CATEGORY question (STA-140): the
     * `active` category accrues the actual, `review` accrues the queue, and every
     * other category is simply not an interval — which is still how blocked and
     * parked time costs nothing without a special case.
     */
    const opensInterval = (id: string): boolean => {
      const category = this.categoryOf(id);
      return category === "active" || category === "review";
    };
    if (opensInterval(status)) openAt = first.createdAt;

    for (let i = 1; i < events.length; i += 1) {
      const event = events[i]!;
      const to = this.statusAfterEvent(event.kind, event.payload);
      if (!to) return null;
      if (to === status) continue;
      if (openAt !== null) {
        const seconds = secondsBetween(openAt, event.createdAt);
        if (!openDerived) {
          if (this.categoryOf(status) === "active") {
            active += seconds;
            sawActive = true;
          } else {
            review += seconds;
            sawReview = true;
          }
        }
        openAt = null;
      }
      if (opensInterval(to)) {
        openAt = event.createdAt;
        openDerived = typeof event.payload.derived === "string";
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
      if (!openDerived) {
        if (this.categoryOf(status) === "active") {
          active += seconds;
          sawActive = true;
          countedThrough = end;
        } else {
          review += seconds;
          sawReview = true;
        }
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
  private approximateActiveOf(
    row: Pick<IssueRow, "status" | "started_at" | "completed_at">,
    now: string,
  ): number | null {
    if (!row.started_at) return null;
    const category = this.categoryOf(row.status);
    if (category === "done") {
      return row.completed_at ? secondsBetween(row.started_at, row.completed_at) : null;
    }
    if (category === "active" || category === "review") {
      return secondsBetween(row.started_at, now);
    }
    return null;
  }

  /**
   * Every CONFIGURED status at zero — so a caller can index any status the
   * workspace has without a guard.
   *
   * Keys follow `sort_order`, NOT the list rank, and that is deliberate: for the
   * seeded seven it reproduces the previous `ISSUE_STATUSES` key order byte for
   * byte, so nothing that compares this object as JSON moves. The list rank is
   * for SORTING ROWS; this is a dictionary, and a dictionary reordering itself
   * because somebody added a status would be a gratuitous wire change.
   */
  private zeroStatusCounts(): Record<string, number> {
    return Object.fromEntries(this.settings().statuses.map((s) => [s.id, 0]));
  }

  /** The all-absent struct, for an id that no longer resolves to a row. */
  private emptyTiming(): IssueTiming {
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
      childStatusCounts: this.zeroStatusCounts(),
      subtreePlan: {
        estimatedSeconds: null,
        source: "none",
        descendantsEstimatedSeconds: null,
        contributingCount: 0,
        totalCount: 0,
      },
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
   * 4. The RECURSIVE plan (STA-192) lives beside it as `subtreePlan`, and gets
   *    through the same double-count problem with one rule: an issue contributes
   *    its own estimate if it has one, otherwise its children's contributions.
   *    Own wins, so the estimates under an estimated parent are shadowed for
   *    every ancestor rather than added — and a parent with no estimate passes
   *    its children's plan straight up. See `SubtreePlan` in core/types.ts.
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
        this.reconstructIntervals(row.status, eventsByIssue.get(row.id) ?? [], clampAt) ?? {
          ownActiveSeconds: this.approximateActiveOf(row, now),
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
      const childStatusCounts = this.zeroStatusCounts();
      let childrenEstimatedSeconds: number | null = null;
      let childrenActiveSeconds: number | null = null;
      let childApproximate = false;
      // The recursive plan (STA-192), accumulated from each child's already-final
      // `subtreePlan` — the same deepest-first order the actuals rely on.
      let descendantsEstimatedSeconds: number | null = null;
      let contributingCount = 0;
      let totalCount = 0;
      for (const child of children) {
        // Only configured statuses get a bucket; an orphaned id is counted
        // nowhere rather than inventing a key no consumer's schema knows about.
        const bucket = childStatusCounts[child.status];
        if (bucket !== undefined) childStatusCounts[child.status] = bucket + 1;
        if (child.estimated_seconds != null) {
          childrenEstimatedSeconds = (childrenEstimatedSeconds ?? 0) + child.estimated_seconds;
        }
        const childTiming = timings.get(child.id);
        if (childTiming?.activeSeconds != null) {
          childrenActiveSeconds = (childrenActiveSeconds ?? 0) + childTiming.activeSeconds;
        }
        if (childTiming?.approximate) childApproximate = true;
        const childPlan = childTiming?.subtreePlan;
        if (childPlan) {
          // The child's EFFECTIVE plan is its contribution — own if it has one,
          // else what flowed up through it. Never both, which is the whole rule.
          if (childPlan.estimatedSeconds != null) {
            descendantsEstimatedSeconds =
              (descendantsEstimatedSeconds ?? 0) + childPlan.estimatedSeconds;
          }
          // A child that contributed its own estimate is ONE contributing item,
          // and shadows whatever its subtree counted; otherwise its count flows up.
          contributingCount += childPlan.source === "own" ? 1 : childPlan.contributingCount;
          totalCount += 1 + childPlan.totalCount;
        }
      }
      const hasChildren = children.length > 0;
      const ownEstimate = row.estimated_seconds ?? null;
      timings.set(row.id, {
        estimatedSeconds: ownEstimate,
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
        subtreePlan: {
          // Own wins; otherwise the children's plan flows up unchanged.
          estimatedSeconds: ownEstimate ?? descendantsEstimatedSeconds,
          source:
            ownEstimate != null ? "own" : descendantsEstimatedSeconds != null ? "descendants" : "none",
          descendantsEstimatedSeconds,
          contributingCount,
          totalCount,
        },
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
    return this.timingFor([row.id]).get(row.id) ?? this.emptyTiming();
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
    return { timing: all.get(row.id) ?? this.emptyTiming(), childrenTiming };
  }
  // ---------- checkout / release ----------

  /**
   * Atomic claim: wins iff status is in expectedStatuses
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
    /**
     * Defaults to the CONFIGURED claimable set (`ready`, `unstarted`, `blocked`,
     * in that order) rather than the built-in triple, so a workspace that renamed
     * or added a queue status can still claim out of it. Callers that pass an
     * explicit list are validated against the workspace's own vocabulary.
     */
    expectedStatuses?: readonly IssueStatus[],
    opts: { stealIfIdleSeconds?: number } = {},
  ): Issue {
    if (!agent?.trim()) throw new StapleError("validation", "agent is required for checkout");
    const expected = expectedStatuses ?? this.checkoutExpectedStatuses();
    for (const status of expected) this.assertConfiguredStatus(status);
    const activeStatus = this.primaryStatusFor("active");
    const stealIfIdleSeconds = assertIdleThreshold(opts.stealIfIdleSeconds, "stealIfIdleSeconds");
    return tx(this.db, () => {
      const row = this.requireRow(ref);
      if (this.isActiveStatus(row.status) && row.checkout_agent === agent) {
        return rowToIssue(row); // crash-recovery re-claim
      }
      /**
       * The queue guard (STA-143), and its position in this method is the whole
       * design:
       *
       *  - AFTER the crash-recovery re-claim, so an agent already holding a
       *    ticket when a gate went up above it can still resume after a crash.
       *    It is mid-flight work, not a fresh pickup, and refusing it would
       *    orphan the claim it is trying to recover.
       *  - BEFORE everything else, so `--steal-if-stale` cannot route around it.
       *    A stale holder and a closed gate are unrelated facts, and a takeover
       *    is an answer to the first one only. The reviewer's decision does not
       *    become less binding because some other agent went quiet.
       *
       * Its own error code — `gated`, non-retryable — because the instruction it
       * carries is not "pick a different task right now" but "this one opens
       * when a human opens it". The message names both the gate and its owner so
       * an agent reading only the sentence knows exactly who to chase.
       */
      const queued = this.queuedByFor([row.id]).get(row.id);
      if (queued) {
        throw new StapleError(
          "gated",
          `${row.identifier} is queued behind ${queued.identifier}, awaiting approval by ${queued.owner}. Pick a different task — approval is a human action, not a retry.`,
          {
            currentStatus: row.status,
            queuedBy: { identifier: queued.identifier, owner: queued.owner },
          },
        );
      }
      const now = nowIso();
      const placeholders = expected.map(() => "?").join(",");
      const claimed = this.db
        .prepare(
          `UPDATE issues SET
             status = ?,
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
                 AND b.status NOT IN ${this.resolvedSql()}
             )
           RETURNING *`,
        )
        .get(activeStatus, agent, agent, now, now, now, row.id, ...expected) as unknown as
        | IssueRow
        | undefined;
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
                     status = ?,
                     status_version = status_version + 1,
                     assignee = ?,
                     checkout_agent = ?,
                     checkout_at = ?,
                     started_at = COALESCE(started_at, ?),
                     unblock_owner = NULL, unblock_action = NULL, blocked_transition_at = NULL,
                     updated_at = ?
                   WHERE id = ? AND status IN ${sqlIdList(this.settings().active)} AND checkout_agent = ?
                   RETURNING *`,
                )
                .get(activeStatus, agent, agent, now, now, now, row.id, claim.heldBy) as unknown as
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
                // Transition site 4 of 5. A takeover is a fresh start by a new
                // agent; if the epic went quiet in the meantime it must light up
                // again, attributed to whoever took over.
                this.recomputeAncestorStatuses(stolen, agent);
                return rowToIssue(stolen);
              }
            }
            // Too fresh to steal, or we lost the race — refuse against whatever
            // the CURRENT state is, so the sentence never names a stale holder.
            const current = this.claimActivityOfRow(this.requireRow(ref), now) ?? claim;
            throw new StapleError("conflict", claimGuardMessage("Checkout", current), {
              currentStatus: row.status,
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
            : `Checkout refused: status is "${row.status}"${row.checkout_agent ? ` (held by ${row.checkout_agent})` : ""}, expected one of ${expected.join(", ")}. Pick a different task — do not retry.`,
          { currentStatus: row.status, heldBy: row.checkout_agent, blockers: unresolved },
        );
      }
      this.emitEvent({
        kind: "checkout",
        issueId: row.id,
        actor: agent,
        payload: { identifier: row.identifier },
      });
      // Transition site 3 of 5, and the one that matters most in practice: a
      // plain `staple checkout` IS how work starts, and its UPDATE above sets
      // status = 'in_progress' directly. Hooking only `updateIssue` would have
      // missed the common case entirely.
      this.recomputeAncestorStatuses(claimed, agent);
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
      if (!this.isActiveStatus(row.status)) {
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
          `UPDATE issues SET status = ?, status_version = status_version + 1,
             checkout_agent = NULL, checkout_at = NULL, updated_at = ?
           WHERE id = ? RETURNING *`,
        )
        .get(this.primaryStatusFor("ready"), nowIso(), row.id) as unknown as IssueRow;
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
      // Transition site 5 of 5, and one STA-79 structurally could not have: a
      // release writes `todo`, which its one-way flip into in_progress had
      // nothing to say about. A recompute must see it, or an epic keeps
      // reporting in_progress after its last child was handed back.
      this.recomputeAncestorStatuses(updated, agent ?? null);
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
      where.push(`status NOT IN ${this.resolvedSql()}`);
    }
    if (filters.kind && filters.kind.length > 0) {
      where.push(`kind IN (${filters.kind.map(() => "?").join(",")})`);
      params.push(...filters.kind);
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
    /**
     * The status rank is GENERATED from the workspace's configuration (STA-140)
     * rather than written out, which is what makes "reorder the statuses and the
     * list reorders" true. For the seeded statuses it produces exactly the
     * hardcoded `CASE` it replaced, with the gated band (STA-143) slotted where
     * `LIST_CATEGORY_ORDER` puts it — beside `blocked`, above the workable band.
     * That is the same judgement `blocked` has always had: work that needs
     * somebody's attention ranks above work that is merely waiting to be picked
     * up, and a parked parent is the most attention-needing row on the list.
     */
    const sql = `SELECT * FROM issues ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY
        ${this.statusRankSql()},
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
   * ready even if its status says todo. Blocked work and gate-held work are
   * listed separately.
   *
   * ## Three buckets, and what each one MEANS to an agent
   *
   *  - `ready`   — take one of these.
   *  - `queued`  — real, unclaimed work that a HUMAN has to release. Checkout is
   *                refused (`gated`), and no amount of waiting or retrying moves
   *                it: the queue drains when a person approves.
   *  - `blocked` — waiting on other WORK (a blocker, or a manual block with a
   *                descriptor). It drains when that work lands.
   *
   * The distinction is the reason `queued` is not folded into `blocked`. Both
   * mean "not now", but they answer "who unsticks this" with different kinds of
   * answer, and an agent that cannot tell them apart either nags a human about a
   * dependency or waits patiently for a human who was never told.
   *
   * ## Why a parked parent lands in `queued` and not in `blocked`
   *
   * An `awaiting_approval` issue has no `queuedBy` — it is not standing in a
   * queue, it IS the queue — but it is gate-held work all the same, and its
   * `gate` field names the owner. Putting it in `blocked` would render it as
   * "? must act", because a parked parent has no unblock descriptor and
   * deliberately never gets one. Putting it beside the children it is holding
   * reads correctly on every surface: one QUEUED section, the gate at the top of
   * it, the work it is holding underneath.
   *
   * `ready` therefore excludes both, and that is the whole "gated is never
   * ready" rule. It is enforced by CATEGORY (STA-140): `gated` is absent from
   * `INBOX_PICKUP_CATEGORY_ORDER`, so any status an operator files under it
   * inherits the rule without a line changing here.
   */
  inbox(
    assignee?: string,
    page?: { limit: number; offset: number },
  ): {
    ready: Array<InboxEntry>;
    queued: Array<InboxEntry>;
    blocked: Array<InboxEntry>;
    hasMore: boolean;
  } {
    const filters: IssueFilters = assignee ? { assignee } : {};
    // The three buckets partition ONE window over the open issues, so the page
    // is over the scan, not over any one list.
    const { items, hasMore } = page
      ? this.listIssuesPage(filters, page)
      : { items: this.listIssues(filters), hasMore: false };
    const ids = items.map((i) => i.id);
    const blockersByIssue = this.unresolvedBlockersFor(ids);
    const queuedByIssue = this.queuedByFor(ids);
    const gatesByIssue = this.gateFor(ids);
    const ready: InboxEntry[] = [];
    const queued: InboxEntry[] = [];
    const blocked: InboxEntry[] = [];
    for (const issue of items) {
      const unresolved = blockersByIssue.get(issue.id) ?? [];
      const entry: InboxEntry = {
        ...issue,
        unresolvedBlockers: unresolved,
        queuedBy: queuedByIssue.get(issue.id) ?? null,
        gate: gatesByIssue.get(issue.id) ?? null,
      };
      /**
       * "Not ready" is a CATEGORY question since STA-140: `gated` and `blocked`
       * both mean an agent cannot pick this up, and an unresolved dependency
       * means it regardless of what the status says. Everything left is ready,
       * already in `inboxPickupOrder()` because `issuesQuery` sorted it there.
       *
       * Which of the two NOT-READY buckets it lands in is the STA-143 question,
       * and gate first: a queued issue with unresolved blockers is still gated,
       * and naming the gate is the more actionable of the two facts — the
       * blocker cannot even be worked until the gate opens.
       */
      const category = this.categoryOf(issue.status);
      if (entry.queuedBy || category === "gated") queued.push(entry);
      else if (category === "blocked" || unresolved.length > 0) blocked.push(entry);
      else ready.push(entry);
    }
    return { ready, queued, blocked, hasMore };
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
