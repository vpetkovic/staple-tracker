/**
 * Applying a remote operation to the local database.
 *
 * Contract: `docs/sync.md`, "What synchronizes", "Deletion is a tombstone" and
 * "Ordering, cursors and epochs".
 *
 * ## Why this writes rows instead of calling the store
 *
 * The obvious implementation replays each operation through `WorkspaceStore` —
 * `issue.update` becomes `updateIssue`, and the domain rules run. It is wrong,
 * for three reasons that compound:
 *
 *   1. **The store validates intent, and this is not intent.** `createIssue`
 *      refuses a duplicate open title, `checkoutIssue` refuses a claim through
 *      unresolved blockers, `updateIssue` enforces the status-version CAS. Those
 *      guards exist to stop a human doing something incoherent *here and now*.
 *      An operation that already happened somewhere else is not a request; it is
 *      history, and history does not get a veto.
 *   2. **The store allocates.** `createIssue` consumes `meta.next_issue_number`,
 *      which *"never synchronizes: it is a local provisional allocator"*.
 *      Replaying a remote create through it would burn a local number for an
 *      issue that already has an identifier.
 *   3. **The store's signatures are patches, not rows.** There is no store method
 *      that sets `created_at`, and there should not be.
 *
 * So the fold happens here, mechanically, exactly as `worker/src/snapshot.ts`
 * folds it server-side — shallow-merge the payload's fields over the row — and
 * the two agree because they are the same rule written twice against the same
 * contract.
 *
 * ## Echo suppression is not this file's job
 *
 * Every write here runs inside {@link Journal.applyRemote}, which opens a
 * suppressed scope: the same domain write, journalling nothing. Without it the
 * device that applied an operation would journal its own copy, push it, the other
 * device would apply that and journal again, and the two would synchronize for
 * ever. The caller owns that; this file just writes rows.
 *
 * ## Unknown fields are preserved by not being understood
 *
 * A payload field with no column here is ignored on the way in and — because the
 * seam only ever journals what a local mutation changed — is never overwritten on
 * the way out. That is the weak half of *"Unknown fields are preserved, never
 * dropped"*: this build does not resurrect a newer build's field, but it also
 * cannot delete one, because it never writes a full row.
 */
import type { DatabaseSync } from "node:sqlite";
import { renumberedRanks } from "../milestones.js";
import {
  SETTING_DEFINITIONS,
  encodeStoredSetting,
  settingMetaKey,
  type SettingDefinition,
} from "../settings-registry.js";
import { aliasedIssueId, moveIdentifier, recordIdentifierMove } from "../identifier-moves.js";
import { StapleError, normalizeTitle, nowIso } from "../types.js";
import { holderYields, oweSettlement, ownClaimSeq, ownOriginClaimSeq } from "./claims.js";
import {
  isDefined,
  recordRemovalTarget,
  removalTarget,
  usableTarget,
  type VocabularyEntity,
} from "../vocabulary-targets.js";
import type { RemoteOperation, SnapshotEntity } from "./wire.js";

/**
 * Thrown when an operation names a row that has not arrived yet.
 *
 * *"An operation whose referent does not exist yet is deferred to the end of the
 * page and retried once."* This is how the applier says so; the page loop in
 * `sync.ts` owns the deferral, because only it knows what else is in the page.
 */
export class ReferentMissing extends Error {
  constructor(readonly what: string) {
    super(`referent not present yet: ${what}`);
    this.name = "ReferentMissing";
  }
}

// ------------------------------------------------------------ column mapping

type Encoding = "raw" | "json" | "bool";

interface Column {
  readonly column: string;
  readonly encoding: Encoding;
}

function col(column: string, encoding: Encoding = "raw"): Column {
  return { column, encoding };
}

/**
 * The `issues` columns that travel, keyed by the payload name the seam uses.
 *
 * This is `docs/sync.md`'s field inventory for `issues`, plus `checkoutAgent` and
 * `checkoutAt` — which travel, but *"never as a plain field write"*: they are the
 * projection of a lease. They are accepted here because the merged claim
 * operations already carry them as fields and refusing them would drop a claim
 * on the floor; when the lease lane lands, it projects onto the same two columns.
 */
const ISSUE_FIELDS: Record<string, Column> = {
  identifier: col("identifier"),
  title: col("title"),
  normalizedTitle: col("normalized_title"),
  description: col("description"),
  status: col("status"),
  statusVersion: col("status_version"),
  priority: col("priority"),
  parentId: col("parent_id"),
  depth: col("depth"),
  assignee: col("assignee"),
  createdBy: col("created_by"),
  labels: col("labels", "json"),
  acceptanceCriteria: col("acceptance_criteria", "json"),
  blockParentUntilDone: col("block_parent_until_done", "bool"),
  unblockOwner: col("unblock_owner"),
  unblockAction: col("unblock_action"),
  originKind: col("origin_kind"),
  originId: col("origin_id"),
  idempotencyKey: col("idempotency_key"),
  estimatedSeconds: col("estimated_seconds"),
  kind: col("kind"),
  projectId: col("project_id"),
  gateState: col("gate_state"),
  gateOwner: col("gate_owner"),
  gateRequestedBy: col("gate_requested_by"),
  gateRequestedAt: col("gate_requested_at"),
  gateResolvedBy: col("gate_resolved_by"),
  gateResolvedAt: col("gate_resolved_at"),
  gateReleased: col("gate_released", "bool"),
  startedAt: col("started_at"),
  // When the issue entered its current blocked cycle: written with the transition, and
  // travelling with it (`test/cloud-blocked-transition.test.ts`).
  blockedTransitionAt: col("blocked_transition_at"),
  completedAt: col("completed_at"),
  cancelledAt: col("cancelled_at"),
  checkoutAgent: col("checkout_agent"),
  checkoutAt: col("checkout_at"),
  createdAt: col("created_at"),
  updatedAt: col("updated_at"),
};

const COMMENT_FIELDS: Record<string, Column> = {
  issueId: col("issue_id"),
  author: col("author"),
  authorType: col("author_type"),
  body: col("body"),
  idempotencyKey: col("idempotency_key"),
  deletedAt: col("deleted_at"),
  createdAt: col("created_at"),
};

const PROJECT_FIELDS: Record<string, Column> = {
  slug: col("slug"),
  name: col("name"),
  kind: col("kind"),
  sourceKind: col("source_kind"),
  source: col("source"),
  createdAt: col("created_at"),
  updatedAt: col("updated_at"),
};

/**
 * The payload keys the applier understands for each table.
 *
 * Exported because `test/sync-issue-field-coverage.test.ts` checks the seam's
 * `issue.create` payload against the `issues` schema THROUGH this map: a payload
 * key the applier cannot place is not coverage, it is a field that would be
 * dropped on arrival.
 */
export const ISSUE_COLUMNS: Record<string, Column> = withColumnAliases(ISSUE_FIELDS);
/**
 * Also exported for `conflicts.ts`, which has to answer "do these two payload
 * keys name the same thing" before it can say whether two devices contested one
 * field. The seam journals `title` on a create and `normalized_title` on an
 * update, so that question is only answerable through this map — and a second
 * copy of it in the conflict module would drift the first time a column is
 * added, and drift silently, into missed conflicts.
 */
export const COMMENT_COLUMNS: Record<string, Column> = withColumnAliases(COMMENT_FIELDS);
export const PROJECT_COLUMNS: Record<string, Column> = withColumnAliases(PROJECT_FIELDS);

/**
 * Accept a column's own name as well as the camelCase payload key.
 *
 * DIVERGENCE, and one that has to be absorbed rather than argued with: the
 * mutation seam journals TWO naming conventions for the same table.
 * `createIssue` declares `{ estimatedSeconds, acceptanceCriteria, … }`, while
 * `updateIssue` declares `{ ...next }` where `next` is the SQL patch it is about
 * to run — so its keys are `estimated_seconds`, `acceptance_criteria`,
 * `normalized_title`. `docs/sync.md` names the fields in its inventory as
 * columns and gives its envelope example single-word fields, so it settles
 * nothing either.
 *
 * Both are accepted here. Not out of tolerance for ambiguity, but because a
 * receiver that understood only one of them would silently drop half the updates
 * in the fleet — and because once operations exist in a log stamped with one
 * spelling, a receiver has to keep understanding it whatever the emitter does
 * next. Unifying the emitter is a separate, additive change; this is what makes
 * that change safe to land later.
 */
function withColumnAliases(columns: Record<string, Column>): Record<string, Column> {
  const out: Record<string, Column> = { ...columns };
  for (const mapped of Object.values(columns)) {
    if (!(mapped.column in out)) out[mapped.column] = mapped;
  }
  return out;
}

function encode(value: unknown, encoding: Encoding): unknown {
  if (encoding === "bool") {
    if (value === null || value === undefined) return null;
    return value ? 1 : 0;
  }
  if (encoding === "json") {
    if (value === null || value === undefined) return null;
    return typeof value === "string" ? value : JSON.stringify(value);
  }
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return value as never;
}

function decodeColumn(value: unknown, encoding: Encoding): unknown {
  if (value === null || value === undefined) return null;
  if (encoding === "bool") return Number(value) !== 0;
  if (encoding === "json" && typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

/**
 * A row as the `create` payload that would reproduce it — the inverse of {@link project}.
 *
 * Exported for the seed (`seed.ts`), which uploads rows that were written while nothing
 * was journaling. Built from the same field maps the applier reads, so every column a
 * receiver can place is carried and no column a receiver would drop is invented; a
 * payload key the applier had no column for would be a field that silently never
 * arrived, which is the failure `test/sync-issue-field-coverage.test.ts` exists to
 * catch for the seam's own creates.
 *
 * Keys are the camelCase payload names, never the column aliases, because that is the
 * spelling `createIssue` journals and the one the fold's provenance is keyed by.
 */
export function payloadFromRow(
  table: "issues" | "comments" | "projects",
  row: Record<string, unknown>,
): Record<string, unknown> {
  const fields = table === "issues" ? ISSUE_FIELDS : table === "comments" ? COMMENT_FIELDS : PROJECT_FIELDS;
  const payload: Record<string, unknown> = {};
  for (const [key, mapped] of Object.entries(fields)) {
    if (!(mapped.column in row)) continue;
    payload[key] = decodeColumn(row[mapped.column], mapped.encoding);
  }
  return payload;
}

/**
 * A queued issue operation's payload with every column it names re-read from the row as
 * it stands now, or null when the issue is gone.
 *
 * For `sync.ts`, and only for an operation that provably never landed: one larger than
 * the service accepts, which the service refuses every time. Rebuilding THAT is safe —
 * nothing has been told its contents — and it is how an issue someone has since edited
 * below the limit gets sent. Keys with no column (`blockedBy`) are kept as queued.
 */
export function refreshedIssuePayload(
  db: DatabaseSync,
  issueId: string,
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const row = db.prepare("SELECT * FROM issues WHERE id = ?").get(issueId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    const mapped = ISSUE_COLUMNS[key];
    out[key] = mapped && mapped.column in row ? decodeColumn(row[mapped.column], mapped.encoding) : value;
  }
  return out;
}

/** Map a payload onto `(column, value)` pairs, dropping fields with no column. */
function project(
  payload: Record<string, unknown>,
  columns: Record<string, Column>,
): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = [];
  for (const [key, value] of Object.entries(payload)) {
    const mapped = columns[key];
    if (!mapped) continue;
    pairs.push([mapped.column, encode(value, mapped.encoding)]);
  }
  return pairs;
}

// ------------------------------------------------------------------ the call

export interface ApplyInput {
  readonly entity: string;
  readonly entityId: string;
  readonly verb: string;
  readonly payload: Record<string, unknown>;
  /** The originating actor, for columns the payload does not name. */
  readonly actor: string | null;
  /** The originating device, recorded on a tombstone. */
  readonly deviceId: string | null;
  /** Client timestamp, used only where a NOT NULL column has nothing better. */
  readonly at: string;
  /** The operation id, recorded on a tombstone. Null for a snapshot entity. */
  readonly opId: string | null;
  /**
   * Where the claims this input makes sit in the log: the operation's seq in the ordered
   * tail, the create's seq for a snapshot entity. Null for a local apply — a conflict
   * resolution on this device — which is a decision and yields to no earlier claim.
   * See `claims.ts`.
   */
  readonly seq?: number | null;
  /** A snapshot entity's per-field write seqs, for a field some later operation set. */
  readonly fieldSeqs?: Readonly<Record<string, number>>;
  /**
   * True when `at` and `actor` are a GENUINE create's own: a `create` operation a device
   * made, or a snapshot entity whose fold names its create's time. Not a restore's — a
   * `restore:<id>` actor, or a snapshot of a create a restore staged, which the fold gives
   * no time (`worker/src/fold.ts`) — and not a moment of hydration.
   */
  readonly atIsCreate?: boolean;
}

function restoreActor(actor: string | null | undefined): boolean {
  return typeof actor === "string" && actor.startsWith("restore:");
}

/**
 * The time and author an older build's comment or revision is canonically written with.
 *
 * A payload from before 0c12bb9 carries no `createdAt` (and a revision's no `author`), so
 * those are the create's: its envelope time and its actor, when the create is a genuine
 * device operation. Every device converges on them — the one that wrote it too, whose
 * store read the clock a millisecond before its journal did, and whose row the applier
 * catch-up re-dates once. When the only create is one a restore staged, there is no true
 * time or author to converge on, and a row this device holds keeps its own
 * (`docs/sync.md`, "A restore's own actor and instant are never a create's").
 */
function canonicalCreate(input: ApplyInput): { at: string; actor: string | null } | null {
  if (input.verb !== "create" || input.atIsCreate !== true) return null;
  return { at: input.at, actor: input.actor };
}

/** The log position of this input's claim on any of `fields`. */
function claimSeqOf(input: ApplyInput, fields: readonly string[]): number | null {
  const bySeq = fields.map((field) => input.fieldSeqs?.[field]).filter((seq): seq is number => typeof seq === "number");
  if (bySeq.length > 0) return Math.max(...bySeq);
  return input.seq ?? null;
}

export function operationToInput(op: RemoteOperation): ApplyInput {
  return {
    entity: op.entity,
    entityId: op.entityId,
    verb: op.verb,
    payload: op.payload,
    // The empty string is how a null actor crosses the wire — see `wire.ts`.
    actor: op.actor === "" ? null : op.actor,
    deviceId: op.deviceId,
    at: op.createdAt,
    opId: op.opId,
    seq: op.seq,
    atIsCreate: op.verb === "create" && !restoreActor(op.actor),
  };
}

/**
 * A folded snapshot entity is an apply with the verb the server folded it to.
 *
 * The verb is taken from the wire rather than derived here, and that is the whole
 * point of this function. Deriving it — `deletedAt === null ? "create" : "delete"`,
 * as this once did — silently loses the one verb a fold cannot express as a merge:
 * `replace`, the ordered-collection verb. A queue plan and a milestone's membership
 * both fold to a `replace`, so a device hydrating from a snapshot was handed them
 * under a verb that meant something else, applied neither, and reported success.
 *
 * With the verb carried, this `ApplyInput` is field-for-field the same record
 * `operationToInput` builds when the identical operation arrives in the ordered
 * tail, and both go through the identical handler. Two paths, one shape.
 *
 * The `version` the server reports becomes the local entity version, which is what
 * makes the first post-bootstrap local mutation carry a `baseVersion` that means
 * something.
 */
/**
 * A snapshot entity's state with one spelling of each field: the one written last.
 *
 * A Worker from before this build folded `updatedAt` and `updated_at` as two keys, and
 * applying both in key order let the stale one win (`oneSpelling` in `journal.ts`). Which
 * is later is in the provenance: the write's seq, else its time; a key only a create set
 * is older than any written after it.
 */
function latestSpelling(entity: SnapshotEntity): Record<string, unknown> {
  const state = { ...entity.state };
  const writes = (entity.fieldWrites ?? {}) as Record<string, { seq?: number; at?: string }>;
  const rank = (key: string): [number, string] => [writes[key]?.seq ?? -1, writes[key]?.at ?? ""];
  for (const key of Object.keys(entity.state)) {
    if (!key.includes("_")) continue;
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    if (!(camel in state) || !(key in state)) continue;
    const [snakeSeq, snakeAt] = rank(key);
    const [camelSeq, camelAt] = rank(camel);
    const snakeLater = snakeSeq !== camelSeq ? snakeSeq > camelSeq : snakeAt > camelAt;
    delete state[snakeLater ? camel : key];
  }
  return state;
}

export function snapshotToInput(entity: SnapshotEntity, at: string): ApplyInput {
  const fieldSeqs: Record<string, number> = {};
  for (const [field, write] of Object.entries(entity.fieldWrites ?? {})) {
    if (typeof write.seq === "number") fieldSeqs[field] = write.seq;
  }
  return {
    entity: entity.entity,
    entityId: entity.entityId,
    verb: entity.verb,
    payload: latestSpelling(entity),
    // The create's actor, when the service sent it: the author a device reading that
    // create in the tail would give a revision or comment whose payload names none.
    actor: typeof entity.createdBy === "string" && entity.createdBy !== "" ? entity.createdBy : null,
    deviceId: null,
    /**
     * The time of the entity's own create when the service sent it, which is the time a
     * device reading that create in the ordered tail uses for every column the payload
     * does not carry — a comment or revision written before its payload carried its own
     * `createdAt`, above all. The moment of hydration only when the service did not say,
     * and for a tombstone, whose time is when this device learned of the delete.
     */
    at: entity.verb !== "delete" && typeof entity.createdAt === "string" ? entity.createdAt : at,
    opId: null,
    seq: typeof entity.createdSeq === "number" ? entity.createdSeq : null,
    fieldSeqs,
    atIsCreate: entity.verb !== "delete" && typeof entity.createdAt === "string",
  };
}

/**
 * Write one operation's effect. Returns false when it was a deliberate no-op.
 *
 * MUST be called inside a transaction, and in practice inside
 * `Journal.applyRemote`. It does not open one: a page applies as one transaction,
 * *"and idempotent: every applied `opId` is recorded, and a re-delivered
 * operation is a no-op."*
 */
export function applyToDatabase(db: DatabaseSync, input: ApplyInput): boolean {
  /**
   * The tombstone wins regardless of arrival order, which is what makes
   * convergence order-independent. Checked before anything is written, and for
   * every verb except `delete` itself — a redelivered delete is idempotent.
   */
  if (input.verb !== "delete" && isTombstoned(db, input.entity, input.entityId)) {
    /**
     * Except a `create`: somebody decided, after the delete, that the entity exists again —
     * a status removed and added back, a setting reset and set. The service's fold makes
     * the same exception (`worker/src/fold.ts`), so a device reading the ordered tail and a
     * device hydrating from the snapshot agree about it; the tombstone still turns away
     * every late update.
     */
    if (input.verb !== "create") return false;
    db.prepare("DELETE FROM sync_tombstones WHERE entity = ? AND entity_id = ?").run(input.entity, input.entityId);
  }

  switch (input.entity) {
    case "issue":
      return applyIssue(db, input);
    case "comment":
      return applyComment(db, input);
    case "documentRevision":
      return applyDocumentRevision(db, input);
    case "document":
      return applyDocument(db, input);
    case "relation":
      return applyRelation(db, input);
    case "project":
      return applyProject(db, input);
    case "status":
      return settingsMoved(db, applyVocabulary(db, input, "workspace_statuses"));
    case "kind":
      return settingsMoved(db, applyVocabulary(db, input, "workspace_kinds"));
    case "setting":
      return settingsMoved(db, applySetting(db, input));
    case "milestone":
      return applyMilestone(db, input);
    case "queue":
      return applyQueue(db, input);
    case "lease":
      return applyLease(db, input);
    case "conflict":
      /**
       * Not applied by this build, and not an error either.
       *
       * Leases belong to the distributed-claim lane and nothing here journals
       * one yet. A `conflict` operation IS journaled now, but it is routed in
       * `sync.ts` to `applyConflictOperation` before it reaches this switch —
       * it settles a record rather than folding fields onto a row, so it has no
       * business in a function whose whole job is the fold. Reaching this branch
       * with either is a no-op rather than a throw so that a newer device
       * pushing one cannot stall an older device's whole page.
       */
      return false;
    default:
      throw new StapleError(
        "validation",
        `Operation names entity "${input.entity}", which this build does not know. ` +
          `Upgrade staple; nothing was applied.`,
      );
  }
}

// ------------------------------------------------------------------ entities

/**
 * A removal's target, recorded, and every issue still holding what it removes moved there.
 *
 * The issues the removing device held were moved by it, each its own operation. What is
 * left is what it could not see: an issue another device moved into it concurrently. It
 * goes where the removal says (`vocabulary-targets.ts`) — on every device, so none holds a
 * status or kind it does not define — and when that move was this device's own, this
 * device journals where it went, so the log agrees.
 */
function moveOffRemoved(db: DatabaseSync, input: ApplyInput, entity: VocabularyEntity): void {
  const row = db.prepare(`SELECT ${entity === "status" ? "category" : "NULL AS category"} FROM ${entity === "status" ? "workspace_statuses" : "workspace_kinds"} WHERE id = ?`).get(input.entityId) as
    | { category: string | null }
    | undefined;
  const category = row?.category ?? (typeof input.payload.category === "string" ? input.payload.category : null);
  const named = typeof input.payload.migrateTo === "string" ? input.payload.migrateTo : null;
  const held = removalTarget(db, entity, input.entityId);
  const to = usableTarget(db, entity, input.entityId, named ?? held?.to ?? null, category);
  if (to === null) return;
  recordRemovalTarget(db, entity, input.entityId, to, false);
  const column = entity === "status" ? "status" : "kind";
  const holding = db.prepare(`SELECT id FROM issues WHERE ${column} = ?`).all(input.entityId) as Array<{ id: string }>;
  for (const issue of holding) {
    db.prepare(`UPDATE issues SET ${column} = ? WHERE id = ?`).run(to, issue.id);
    if (held?.own === true || ownClaimSeq(db, "issue", issue.id, [column]) !== null) {
      oweSettlement(db, { entity: "issue", entityId: issue.id, field: column, from: input.entityId });
    }
  }
}

/**
 * An issue write naming a status or kind this database has removed goes where the removal
 * said instead — the other half of {@link moveOffRemoved}, for a move that arrives after
 * the removal. When the removal was this device's, it journals where the issue went.
 */
function redirectRemoved(db: DatabaseSync, input: ApplyInput, pairs: Array<[string, unknown]>): void {
  for (const [index, [column, value]] of pairs.entries()) {
    if ((column !== "status" && column !== "kind") || typeof value !== "string") continue;
    const entity: VocabularyEntity = column;
    if (isDefined(db, entity, value)) continue;
    const removed = removalTarget(db, entity, value);
    if (removed === null) continue;
    const to = usableTarget(db, entity, value, removed.to, null);
    if (to === null) continue;
    pairs[index] = [column, to];
    if (removed.own) oweSettlement(db, { entity: "issue", entityId: input.entityId, field: column, from: value });
  }
}

/**
 * The vocabulary or a setting changed under the store, so the revision its memo keys on
 * moves (`WorkspaceStore.settings`, `meta.settings_revision`).
 *
 * The store bumps it on every change it makes itself; the applier did not, so a store on
 * the same database — a UI or MCP server, or the command that just synced — went on
 * serving the vocabulary from before the sync. Placing an entry then read the old numbers
 * behind the order and put it first instead of last (`test/cloud-vocabulary-sort-order.test.ts`).
 */
export function settingsMoved(db: DatabaseSync, applied: boolean): boolean {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('settings_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS INTEGER) + 1 AS TEXT)`,
  ).run();
  return applied;
}

function applyIssue(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb === "delete") return tombstone(db, input, "issues", "id");

  const { payload } = input;
  const pairs = project(payload, ISSUE_COLUMNS);
  redirectRemoved(db, input, pairs);

  const exists = db.prepare("SELECT 1 AS hit FROM issues WHERE id = ?").get(input.entityId) as
    | { hit: number }
    | undefined;

  /**
   * A parent that has not arrived is a deferral, not a failure. `parent_id`
   * carries `REFERENCES issues(id)`, so writing it early is a constraint error
   * with a message about SQLite rather than about ordering.
   */
  const parentId = payload.parentId;
  if (typeof parentId === "string" && !issueExists(db, parentId)) {
    throw new ReferentMissing(`issue ${parentId} (parent of ${input.entityId})`);
  }

  if (!exists) {
    insertIssue(db, input, pairs);
  } else if (pairs.length > 0) {
    const before = identifierOf(db, input.entityId);
    displaceIdentifierHolder(db, input, pairs);
    const values = new Map(pairs);
    settleIssueKeys(db, input, values);
    updateRow(db, "issues", "id", input.entityId, [...values]);
    const after = identifierOf(db, input.entityId);
    if (before !== null && after !== null && before !== after) {
      /**
       * The allocator is kept clear of a number that arrives this way exactly as of one that
       * arrives in a create (`advanceIssueNumber`). A settled number reaches every other
       * device as a renumber of an issue it already holds — first as a stand-in, which has
       * no number to advance past — and without this, the next `staple new` on that device
       * minted the settled number again and died on the UNIQUE index. Measured live.
       */
      advanceIssueNumber(db, after);
      // When it moved HERE, not when the operation was written: a hub link made in between
      // named the old number and must follow (`hub.ts`, `followIdentifierMoves`).
      recordIdentifierMove(db, { issueId: input.entityId, from: before, to: after, at: nowIso() });
      if (input.seq !== undefined && input.seq !== null) {
        closeIdentifierConflict(db, input, after);
        giveBackFreedIdentifier(db, before, input);
      }
    }
  }

  // `blockedBy` rides inside the create so a receiver never observes an issue
  // whose declared blockers have not arrived. It is not an `issues` column.
  if (Array.isArray(payload.blockedBy)) {
    writeBlockers(db, input.entityId, payload.blockedBy as unknown[], input);
  }
  return true;
}

/**
 * Insert an issue, filling the NOT NULL columns the payload did not name.
 *
 * Every fallback here is a statement about a device older or newer than this one,
 * not about a bug. `normalized_title` is derived, so it is recomputed rather than
 * demanded; the timestamps fall back to the operation's own `createdAt`, which is
 * the closest true thing available.
 *
 * `identifier` has no fallback and is the one field that can genuinely fail. See
 * {@link identifierCollision}.
 */
function insertIssue(db: DatabaseSync, input: ApplyInput, pairs: Array<[string, unknown]>): void {
  const values = new Map(pairs);
  values.set("id", input.entityId);

  const title = (values.get("title") ?? "") as string;
  if (!values.has("normalized_title")) values.set("normalized_title", normalizeTitle(title));
  if (!values.has("created_at")) values.set("created_at", input.at);
  if (!values.has("updated_at")) values.set("updated_at", input.at);
  if (!values.has("identifier")) {
    /**
     * An operation on an issue this database does not hold, carrying no identifier, is
     * not a malformed create: it is an update whose create has not arrived — and only a
     * create carries the identifier. That is a missing referent, and it is reported as
     * one so the page defers it and a sync can recover (see `sync.ts`). A build before
     * the seed produced exactly these, by pushing edits to issues it had never uploaded.
     */
    throw new ReferentMissing(`the create of issue ${input.entityId}, which no operation so far has carried`);
  }

  const identifier = values.get("identifier") as string;
  const owner = identifierOwner(db, identifier);
  if (owner !== null && owner !== input.entityId) {
    /**
     * Two devices minted the same identifier offline, and the earlier claim in the log
     * keeps it (`claims.ts`).
     *
     * When the local holder is this device's own, later claim — not yet sent, or sent
     * after this operation — the holder moves to a stand-in and this device owes the
     * repository its renumber. Otherwise the arriving issue is the later claim: it is
     * applied under the stand-in, and the identifier conflict is recorded so the stand-in
     * is on the record until the device that made that claim renumbers it — whereupon the
     * record is closed (`closeIdentifierConflict`). Nothing is dropped either way: both
     * issues exist, both are reachable, and no value is chosen by arrival order.
     */
    if (holderYields(db, "issue", owner, ["identifier"], claimSeqOf(input, ["identifier"]))) {
      moveIdentifier(db, owner, provisionalIdentifier(db, identifier));
      oweSettlement(db, { entity: "issue", entityId: owner, field: "identifier", from: identifier });
    } else {
      const provisional = provisionalIdentifier(db, identifier);
      recordIdentifierConflict(db, input, identifier, provisional);
      values.set("identifier", provisional);
    }
  }
  settleIssueKeys(db, input, values);

  const columns = [...values.keys()];
  db.prepare(
    `INSERT INTO issues (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...(([...values.values()] as never[]) satisfies never[]));

  advanceIssueNumber(db, values.get("identifier") as string);
}

/**
 * Keep the local provisional allocator ahead of the rows that are locally
 * present.
 *
 * This is NOT synchronizing `meta.next_issue_number`. That counter *"never
 * synchronizes: it is a local provisional allocator, not shared state"*, and
 * nothing here reads or writes another device's value — the input is an
 * identifier that has just been written into THIS database's `issues` table,
 * which carries a `UNIQUE` index on that column.
 *
 * Without this, hydration leaves a workspace in which `staple new` cannot run.
 * A fresh clone bootstraps twelve issues numbered `TST-1` through `TST-12` while
 * its own counter sits at 1, and the very next create fails with a raw
 * `UNIQUE constraint failed: issues.identifier` — not a sync error, not a
 * message anybody can act on, and immediate. Keeping a local allocator clear of
 * local rows is an invariant of the allocator, and it has nothing to do with the
 * counter being shared, which it still is not.
 *
 * It does not eliminate offline collisions between two devices; nothing local
 * can, and the contract's answer to those is a server-side allocator that does
 * not exist yet. See {@link provisionalIdentifier}.
 */
function advanceIssueNumber(db: DatabaseSync, identifier: string): void {
  const dash = identifier.lastIndexOf("-");
  if (dash < 0) return;
  const number = Number(identifier.slice(dash + 1));
  if (!Number.isInteger(number) || number < 1) return;

  const prefix = db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as
    | { value: string }
    | undefined;
  if (prefix && identifier.slice(0, dash) !== prefix.value) return;

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('next_issue_number', ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CASE WHEN CAST(meta.value AS INTEGER) > CAST(excluded.value AS INTEGER)
                    THEN meta.value ELSE excluded.value END`,
  ).run(String(number + 1));
}

function identifierOwner(db: DatabaseSync, identifier: string): string | null {
  const row = db.prepare("SELECT id FROM issues WHERE identifier = ?").get(identifier) as
    | { id: string }
    | undefined;
  return row?.id ?? null;
}

/**
 * A free identifier in the same namespace, found by suffixing rather than by
 * allocating.
 *
 * `meta.next_issue_number` is deliberately not consulted: it *"never
 * synchronizes"*, so two devices resolving the same collision from their own
 * counters would produce two different replacements and diverge a second time.
 * The suffix is a pure function of the contested identifier and the rows already
 * present, so both devices reach the same answer from the same inputs.
 */
function provisionalIdentifier(db: DatabaseSync, identifier: string): string {
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${identifier}+${n}`;
    // Nor one an issue here has held and moved off: that string still finds that issue
    // (`identifier-moves.ts`), and a link or a note made through it means that issue.
    if (identifierOwner(db, candidate) === null && aliasedIssueId(db, candidate) === null) return candidate;
  }
  throw new StapleError("conflict", `Could not find a free identifier near ${identifier}.`);
}

/**
 * Record the collision in the shape every other conflict is recorded in.
 *
 * `local_*` describes what THIS database holds and `remote_*` what arrived — one
 * convention, so a resolution surface can read any row without asking which
 * detector wrote it. For a collision that means the **provisional** is the local
 * value (it is what this row now carries) and the **contested** identifier is
 * the remote one (it is what the operation asked for). An earlier draft had the
 * two values the other way round while the op and device columns already
 * followed the convention, so `local_value` and `local_op_id` described opposite
 * sides of the same row — and resolving "take the local value" would have driven
 * the write straight into the `UNIQUE` index it was avoiding.
 *
 * `base_value` is NULL and means it: the entity is arriving for the first time,
 * so there is no ancestor the two sides diverged from.
 *
 * `DO NOTHING` because detection must be idempotent. The primary key is a
 * function of the entity, so a redelivery is the same collision, not a new one.
 */
function recordIdentifierConflict(
  db: DatabaseSync,
  input: ApplyInput,
  contested: string,
  provisional: string,
): void {
  db.prepare(
    `INSERT INTO sync_conflicts
       (id, entity, entity_id, field, base_value, local_value, remote_value,
        local_op_id, remote_op_id, local_device_id, remote_device_id,
        local_at, remote_at, detected_at)
     VALUES (?, 'issue', ?, 'identifier', NULL, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    `identifier:${input.entityId}`,
    input.entityId,
    JSON.stringify(provisional),
    JSON.stringify(contested),
    input.opId,
    input.deviceId,
    input.at,
    input.at,
  );
}

/**
 * Move whoever holds an incoming identifier out of the way, on an EXISTING row.
 *
 * `insertIssue` has always done this for arrivals; an update needed it once
 * identifier conflicts became resolvable, because settling one is frequently a
 * SWAP. Two devices that both minted `TST-2` offline end in mirror-image states —
 * each holds its own issue at `TST-2` and the other's at `TST-2+1` — so a
 * decision made on one device replicates to the other as "these two issues
 * exchange numbers", and the first half of that exchange collides with the
 * second half until the second half arrives.
 *
 * Without this, applying the first renumber raises `UNIQUE constraint failed:
 * issues.identifier`, which fails the whole page, rolls back everything in it and
 * leaves the cursor where it was — a single contested display allocation
 * wedging the entire repository, which is the exact failure the conflict machinery
 * exists to prevent.
 *
 * The incumbent goes to a suffixed identifier by the same pure rule
 * {@link provisionalIdentifier} uses, so it is derived from what is present
 * rather than allocated, and a later operation in the same page assigning it its
 * settled number simply lands on top. No conflict is recorded: a `renumber` is
 * already the outcome of a decision somebody made explicitly, and re-opening it
 * here would report the resolution as a fresh disagreement.
 */
function displaceIdentifierHolder(
  db: DatabaseSync,
  input: ApplyInput,
  pairs: Array<[string, unknown]>,
): void {
  const index = pairs.findIndex(([column]) => column === "identifier");
  const incoming = index < 0 ? undefined : pairs[index];
  if (!incoming || typeof incoming[1] !== "string") return;

  const owner = identifierOwner(db, incoming[1]);
  if (owner === null || owner === input.entityId) return;

  /**
   * Only a `renumber` is a decision about who holds a number, and so only a renumber —
   * or a write made here, `seq` null — moves the holder aside unconditionally. Anything
   * else that carries an identifier onto an existing row is a claim like a create's, and
   * the earlier claim keeps it (`claims.ts`). The case that makes this necessary is this
   * device's OWN create coming back on the next pull: it still says `TRA-2`, but this
   * device has since moved its issue off `TRA-2` for an earlier claim, and re-applying
   * the old payload would take the number back from the issue every other device gave
   * it to.
   */
  const decision = input.verb === "renumber" || input.seq === undefined || input.seq === null;
  if (!decision && !holderYields(db, "issue", owner, ["identifier"], claimSeqOf(input, ["identifier"]))) {
    pairs.splice(index, 1);
    return;
  }
  if (!decision) {
    moveIdentifier(db, owner, provisionalIdentifier(db, incoming[1]));
    oweSettlement(db, { entity: "issue", entityId: owner, field: "identifier", from: incoming[1] });
    return;
  }

  moveIdentifier(db, owner, provisionalIdentifier(db, incoming[1]));
  /**
   * And when the issue moved aside is this device's own, and the renumber came from
   * somewhere else, this device settles where it goes (`claims.ts`). Every device moves
   * the same issue to the same stand-in; only the one that created it chooses its next
   * number, so it gets one, and gets it once. A renumber made HERE — a resolution being
   * applied locally, `seq` null — states every assignment itself and owes nothing.
   */
  if (input.seq !== undefined && input.seq !== null && ownClaimSeq(db, "issue", owner, ["identifier"]) !== null) {
    oweSettlement(db, { entity: "issue", entityId: owner, field: "identifier", from: incoming[1] });
  }
}

function identifierOf(db: DatabaseSync, issueId: string): string | null {
  return (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)
    ?.identifier ?? null;
}

/**
 * The device that made a later claim has settled it: the stand-in's record is closed.
 *
 * `insertIssue` opened it when the issue arrived under a stand-in because another issue
 * held its number first. The only way that issue's identifier changes after that is its
 * own device renumbering it (or a person resolving it), and either way nothing is left
 * to decide — so no record may go on claiming otherwise.
 */
function closeIdentifierConflict(db: DatabaseSync, input: ApplyInput, settled: string): void {
  db.prepare(
    `UPDATE sync_conflicts SET resolved_at = ?, resolved_by = ?, resolution = ?
      WHERE entity = 'issue' AND entity_id = ? AND field = 'identifier' AND resolved_at IS NULL`,
  ).run(input.at, input.actor ?? "staple", JSON.stringify(settled), input.entityId);
}

/**
 * An identifier just freed goes back to the issue that was waiting for it.
 *
 * A device that met two claims in an order the log did not — hydrating from a service
 * too old to say where each claim sits — can end with the LATER claim on the number and
 * the earlier one on a stand-in, waiting, its conflict open. When the later claim's device
 * renumbers it, the number is free, and the issue whose open record asks for it takes it:
 * the value every device that read the log in order already gave it.
 */
function giveBackFreedIdentifier(db: DatabaseSync, freed: string, input: ApplyInput): void {
  if (identifierOwner(db, freed) !== null) return;
  const waiting = db
    .prepare(
      `SELECT entity_id FROM sync_conflicts
        WHERE entity = 'issue' AND field = 'identifier' AND resolved_at IS NULL AND remote_value = ?`,
    )
    .all(JSON.stringify(freed)) as Array<{ entity_id: string }>;
  const candidate = waiting.find((row) => (identifierOf(db, row.entity_id) ?? "").startsWith(`${freed}+`));
  if (!candidate) return;
  moveIdentifier(db, candidate.entity_id, freed);
  closeIdentifierConflict(db, { ...input, entityId: candidate.entity_id }, freed);
}

/**
 * The other two unique values an issue can hold: a retry key, and a live external origin.
 *
 * The same rule as the identifier (`claims.ts`): the earlier claim in the log keeps it.
 * Neither has a display form to fall back on, so the later claim simply gives it up —
 * the retry key or the origin is cleared on it, which is what the seed does to a joining
 * device's duplicate — and when that later claim is this device's own, it owes the
 * repository the clearing, as an operation.
 *
 * `values` is the column map about to be written; for an update, the columns it does not
 * name are read from the row, because a status change alone can bring an origin back to
 * life (`issues_live_origin_uq` spans only the open statuses).
 */
function settleIssueKeys(db: DatabaseSync, input: ApplyInput, values: Map<string, unknown>): void {
  const current = (db.prepare("SELECT idempotency_key, origin_kind, origin_id, status FROM issues WHERE id = ?").get(
    input.entityId,
  ) ?? {}) as Record<string, unknown>;
  const read = (column: string): unknown => (values.has(column) ? values.get(column) : current[column]);

  const key = read("idempotency_key");
  if (values.has("idempotency_key") && typeof key === "string") {
    const holder = db
      .prepare("SELECT id FROM issues WHERE idempotency_key = ? AND id <> ?")
      .get(key, input.entityId) as { id: string } | undefined;
    if (holder) {
      const fields = ["idempotencyKey", "idempotency_key"];
      if (holderYields(db, "issue", holder.id, fields, claimSeqOf(input, fields))) {
        db.prepare("UPDATE issues SET idempotency_key = NULL WHERE id = ?").run(holder.id);
        oweSettlement(db, { entity: "issue", entityId: holder.id, field: "idempotencyKey", from: key });
      } else if ("idempotency_key" in current) {
        // An existing issue keeps the key it has (see `settleProjectSlug`).
        values.delete("idempotency_key");
      } else {
        values.set("idempotency_key", null);
      }
    }
  }

  const kind = read("origin_kind");
  const originId = read("origin_id");
  const status = read("status");
  const touchesOrigin = values.has("origin_kind") || values.has("origin_id") || values.has("status");
  if (
    touchesOrigin &&
    typeof kind === "string" &&
    kind !== "manual" &&
    typeof originId === "string" &&
    status !== "done" &&
    status !== "cancelled"
  ) {
    const holder = db
      .prepare(
        `SELECT id FROM issues
          WHERE origin_kind = ? AND origin_id = ? AND status NOT IN ('done','cancelled') AND id <> ?`,
      )
      .get(kind, originId, input.entityId) as { id: string } | undefined;
    if (holder) {
      const fields = ["originKind", "origin_kind", "originId", "origin_id", "status"];
      if (holderYields(db, "issue", holder.id, fields, claimSeqOf(input, fields), ownOriginClaimSeq)) {
        db.prepare("UPDATE issues SET origin_id = NULL WHERE id = ?").run(holder.id);
        oweSettlement(db, { entity: "issue", entityId: holder.id, field: "originId", from: originId });
      } else {
        values.set("origin_id", null);
      }
    }
  }
}

function issueExists(db: DatabaseSync, id: string): boolean {
  return (db.prepare("SELECT 1 AS hit FROM issues WHERE id = ?").get(id) as { hit: number } | undefined) !== undefined;
}

function applyComment(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb === "delete") return tombstone(db, input, "comments", "id");

  const issueId = input.payload.issueId;
  if (typeof issueId === "string" && !issueExists(db, issueId)) {
    throw new ReferentMissing(`issue ${issueId} (subject of comment ${input.entityId})`);
  }

  const pairs = project(input.payload, COMMENT_COLUMNS);
  const exists = db.prepare("SELECT 1 AS hit FROM comments WHERE id = ?").get(input.entityId) as
    | { hit: number }
    | undefined;

  if (exists) {
    const values = new Map(pairs);
    // An older build's comment is dated by its genuine create everywhere, the writer too;
    // never by a restore's (`canonicalCreate`).
    const canonical = typeof input.payload.createdAt === "string" ? null : canonicalCreate(input);
    if (canonical !== null) values.set("created_at", canonical.at);
    settleCommentKey(db, input, values);
    if (values.size > 0) updateRow(db, "comments", "id", input.entityId, [...values]);
    return true;
  }
  // A comment this database does not hold, and an operation that does not say which issue
  // it is on: its create has not arrived. See `insertIssue`.
  if (typeof (issueId ?? input.payload.issue_id) !== "string") {
    throw new ReferentMissing(`the create of comment ${input.entityId}, which no operation so far has carried`);
  }

  const values = new Map(pairs);
  values.set("id", input.entityId);
  if (!values.has("author")) values.set("author", input.actor ?? "unknown");
  if (!values.has("body")) values.set("body", "");
  if (!values.has("created_at")) values.set("created_at", input.at);
  settleCommentKey(db, input, values);
  const columns = [...values.keys()];
  db.prepare(
    `INSERT INTO comments (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...([...values.values()] as never[]));
  return true;
}

/**
 * A retry key is unique per issue, and two devices can retry one agent's comment. The
 * earlier claim in the log keeps the key (`claims.ts`, and `settleIssueKeys` for the
 * same rule on issues) — on an arriving comment, and on this device's own comment coming
 * back on the next pull still carrying a key it has since given up.
 */
function settleCommentKey(db: DatabaseSync, input: ApplyInput, values: Map<string, unknown>): void {
  const key = values.get("idempotency_key");
  if (typeof key !== "string") return;
  const issueId =
    (values.get("issue_id") as string | undefined) ??
    (db.prepare("SELECT issue_id FROM comments WHERE id = ?").get(input.entityId) as { issue_id: string } | undefined)
      ?.issue_id;
  if (issueId === undefined) return;
  const holder = db
    .prepare("SELECT id FROM comments WHERE issue_id = ? AND idempotency_key = ? AND id <> ?")
    .get(issueId, key, input.entityId) as { id: string } | undefined;
  if (!holder) return;
  const fields = ["idempotencyKey", "idempotency_key"];
  if (holderYields(db, "comment", holder.id, fields, claimSeqOf(input, fields))) {
    db.prepare("UPDATE comments SET idempotency_key = NULL WHERE id = ?").run(holder.id);
    oweSettlement(db, { entity: "comment", entityId: holder.id, field: "idempotencyKey", from: key });
  } else {
    values.delete("idempotency_key");
    if (!db.prepare("SELECT 1 AS hit FROM comments WHERE id = ?").get(input.entityId)) values.set("idempotency_key", null);
  }
}

/**
 * A document revision, and the head pointer it establishes.
 *
 * The seam journals the revision and not the `documents` row, deliberately: *"the
 * revision carries the head it establishes, so applying it moves both."* Applying
 * them as two operations would let a receiver see a head pointing at a body that
 * had not arrived.
 *
 * `document_revisions` rows are immutable once written, so a redelivered revision
 * is ignored rather than rewritten — but the head pointer still advances, because
 * the pointer is the mutable half.
 */
function applyDocumentRevision(db: DatabaseSync, input: ApplyInput): boolean {
  const { payload } = input;
  const issueId = payload.issueId;
  const key = payload.key;
  const revision = payload.revision;
  if (typeof issueId !== "string" || typeof key !== "string" || typeof revision !== "number") {
    throw new StapleError(
      "validation",
      `A documentRevision operation for ${input.entityId} is missing issueId, key or revision.`,
    );
  }
  if (!issueExists(db, issueId)) {
    throw new ReferentMissing(`issue ${issueId} (owner of document ${key})`);
  }

  /**
   * `author` and `createdAt` are read from the payload when it carries them, and from the
   * operation otherwise. The operation's actor and time are right for a revision arriving
   * in the ordered tail, and wrong for one arriving in a snapshot, which has neither: a
   * snapshot entity is applied with a null actor at the moment of hydration, so every
   * revision of every document read as written by nobody, just now. A revision is
   * immutable, so the values it was written with are the only true ones — and a revision
   * this database already holds keeps them (`DO NOTHING`), whatever a restore restages.
   */
  const author = typeof payload.author === "string" ? payload.author : input.actor;
  const createdAt = typeof payload.createdAt === "string" ? payload.createdAt : input.at;
  db.prepare(
    `INSERT INTO document_revisions (issue_id, key, revision, body, author, change_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (issue_id, key, revision) DO NOTHING`,
  ).run(
    issueId,
    key,
    revision,
    typeof payload.body === "string" ? payload.body : "",
    author,
    typeof payload.changeSummary === "string" ? payload.changeSummary : null,
    createdAt,
  );
  // A revision held already: an older build's is dated and attributed by its genuine
  // create on every device, the writer too; never by a restore's (`canonicalCreate`).
  const canonical = canonicalCreate(input);
  if (canonical !== null) {
    const where = "WHERE issue_id = ? AND key = ? AND revision = ?";
    if (typeof payload.createdAt !== "string") {
      db.prepare(`UPDATE document_revisions SET created_at = ? ${where}`).run(canonical.at, issueId, key, revision);
    }
    if (typeof payload.author !== "string" && canonical.actor !== null) {
      db.prepare(`UPDATE document_revisions SET author = ? ${where}`).run(canonical.actor, issueId, key, revision);
    }
  }

  /**
   * The head only ever moves forward. A revision arriving out of order — which
   * the page's `seq` ordering makes unlikely but not impossible across a
   * bootstrap boundary — must not drag `current_revision` backwards.
   */
  db.prepare(
    `INSERT INTO documents (issue_id, key, current_revision, title, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (issue_id, key) DO UPDATE SET
       current_revision = MAX(current_revision, excluded.current_revision),
       title            = COALESCE(excluded.title, title),
       updated_at       = excluded.updated_at`,
  ).run(issueId, key, revision, typeof payload.title === "string" ? payload.title : null, createdAt);
  return true;
}

/** A bare `document` operation: the head pointer and its title, nothing else. */
function applyDocument(db: DatabaseSync, input: ApplyInput): boolean {
  const [issueId, key] = splitDocumentKey(input.entityId);
  if (!issueExists(db, issueId)) throw new ReferentMissing(`issue ${issueId}`);
  const revision = typeof input.payload.currentRevision === "number" ? input.payload.currentRevision : 0;
  db.prepare(
    `INSERT INTO documents (issue_id, key, current_revision, title, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (issue_id, key) DO UPDATE SET
       current_revision = MAX(current_revision, excluded.current_revision),
       title            = COALESCE(excluded.title, title),
       updated_at       = excluded.updated_at`,
  ).run(
    issueId,
    key,
    revision,
    typeof input.payload.title === "string" ? input.payload.title : null,
    input.at,
  );
  return true;
}

/** Exported so `conflicts.ts` reads a document's current value from the same key. */
export function splitDocumentKey(entityId: string): [string, string] {
  const slash = entityId.indexOf("/");
  if (slash < 0) {
    throw new StapleError("validation", `A document entity id must be "<issueId>/<key>": ${entityId}`);
  }
  return [entityId.slice(0, slash), entityId.slice(slash + 1)];
}

/**
 * The whole blocker set for one blocked issue.
 *
 * Set replacement, not per-edge operations: the mutation deletes the set and
 * re-inserts it, so a receiver applying N creates would never learn about the
 * edges that were removed. `relations.id` is a local AUTOINCREMENT surrogate and
 * is not transported; the natural key is `(blocker_id, blocked_id, type)`, which
 * the `UNIQUE` constraint already declares.
 */
function applyRelation(db: DatabaseSync, input: ApplyInput): boolean {
  const blockedBy = input.payload.blockedBy;
  if (!Array.isArray(blockedBy)) return false;
  if (!issueExists(db, input.entityId)) throw new ReferentMissing(`issue ${input.entityId}`);
  writeBlockers(db, input.entityId, blockedBy as unknown[], input);
  return true;
}

function writeBlockers(
  db: DatabaseSync,
  blockedId: string,
  blockers: readonly unknown[],
  input: ApplyInput,
): void {
  const ids = blockers.filter((id): id is string => typeof id === "string");
  for (const id of ids) {
    if (!issueExists(db, id)) throw new ReferentMissing(`issue ${id} (blocker of ${blockedId})`);
  }
  /**
   * Each edge's own author and time: as the operation describes it (`edges`, which every
   * build since this one sends), else as this database already holds it, else the
   * operation's. The set is replaced — an edge it no longer names goes — but an edge it
   * still names is not re-made: re-inserted with the operation's actor and time, the
   * device that seeded the repository rewrote its own edges when its seed came back, and
   * every other device dated all of an issue's edges with one instant.
   */
  const described =
    input.payload.edges !== null && typeof input.payload.edges === "object" && !Array.isArray(input.payload.edges)
      ? (input.payload.edges as Record<string, { createdBy?: unknown; createdAt?: unknown }>)
      : {};
  /**
   * A set from a build that sends no `edges` — applied here in the ordered tail, where the
   * operation's actor and time are known. A device hydrating from the snapshot has neither
   * for the edges it added, so this device journals the edges as it now holds them, and the
   * fold carries them to every device (`settleOne` in `claims.ts`).
   */
  if (ids.length > 0 && input.payload.edges === undefined && input.opId !== null && typeof input.seq === "number") {
    oweSettlement(db, { entity: "relation", entityId: blockedId, field: "edges", from: "" });
  }
  const held = new Map(
    (
      db.prepare("SELECT blocker_id, created_by, created_at FROM relations WHERE blocked_id = ? AND type = 'blocks'").all(blockedId) as Array<{
        blocker_id: string;
        created_by: string | null;
        created_at: string;
      }>
    ).map((row) => [row.blocker_id, row]),
  );
  const remove = db.prepare("DELETE FROM relations WHERE blocker_id = ? AND blocked_id = ? AND type = 'blocks'");
  for (const id of held.keys()) if (!ids.includes(id)) remove.run(id, blockedId);
  const upsert = db.prepare(
    `INSERT INTO relations (blocker_id, blocked_id, type, created_by, created_at)
     VALUES (?, ?, 'blocks', ?, ?)
     ON CONFLICT (blocker_id, blocked_id, type) DO UPDATE SET created_by = excluded.created_by, created_at = excluded.created_at`,
  );
  for (const id of ids) {
    const facts = described[id];
    const kept = held.get(id);
    const createdAt = typeof facts?.createdAt === "string" ? facts.createdAt : (kept?.created_at ?? input.at);
    const createdBy =
      facts !== undefined && (typeof facts.createdBy === "string" || facts.createdBy === null)
        ? facts.createdBy
        : kept !== undefined
          ? kept.created_by
          : input.actor;
    upsert.run(id, blockedId, createdBy, createdAt);
  }
}

/**
 * A project row.
 *
 * `source` is preserved on the way in when the incoming value is null and this
 * row is `source_kind = 'local'` — the redaction's other half. *"That value is
 * replaced with `null` on the way out and the local value is preserved on the way
 * in."* Without this, one round trip through the server would erase every local
 * project's path.
 */
function applyProject(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb === "delete") {
    /**
     * Deleting a project detaches its issues rather than cascading. `issues.
     * project_id` has no `ON DELETE` clause, and the local mutation journals the
     * detachment as its own `issue.update` per issue — so those arrive
     * separately and this only has to remove the row.
     */
    return tombstone(db, input, "projects", "id");
  }

  const payload = { ...input.payload };
  if (payload.source === null) {
    const kind =
      typeof payload.sourceKind === "string"
        ? payload.sourceKind
        : ((
            db.prepare("SELECT source_kind FROM projects WHERE id = ?").get(input.entityId) as
              | { source_kind: string | null }
              | undefined
          )?.source_kind ?? null);
    if (kind === "local") delete payload.source;
  }

  const pairs = project(payload, PROJECT_COLUMNS);
  settleProjectSlug(db, input, pairs);
  const exists = db.prepare("SELECT 1 AS hit FROM projects WHERE id = ?").get(input.entityId) as
    | { hit: number }
    | undefined;

  if (exists) {
    if (pairs.length > 0) updateRow(db, "projects", "id", input.entityId, pairs);
    return true;
  }
  /**
   * A project this database does not hold, and no slug: its create has not arrived. It
   * used to be inserted anyway with its UUID for a slug — a row that looked real, named
   * nobody, and never matched the device that made it. See `insertIssue`.
   */
  if (typeof payload.slug !== "string") {
    throw new ReferentMissing(`the create of project ${input.entityId}, which no operation so far has carried`);
  }

  const values = new Map(pairs);
  values.set("id", input.entityId);
  if (!values.has("name")) values.set("name", values.get("slug"));
  if (!values.has("created_at")) values.set("created_at", input.at);
  if (!values.has("updated_at")) values.set("updated_at", input.at);
  const columns = [...values.keys()];
  db.prepare(
    `INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...([...values.values()] as never[]));
  return true;
}

/**
 * Two devices creating a project of the same slug: the earlier claim in the log keeps it
 * (`claims.ts`). The later one takes the first free `<slug>-N` here — a stand-in, since
 * slugs are compared by people rather than by other rows — and when it is this device's
 * own, this device journals the slug it now has, so every device and the fold agree.
 * Rewrites `pairs` in place.
 */
function settleProjectSlug(db: DatabaseSync, input: ApplyInput, pairs: Array<[string, unknown]>): void {
  const index = pairs.findIndex(([column]) => column === "slug");
  if (index < 0) return;
  const slug = pairs[index]![1];
  if (typeof slug !== "string") return;
  const holder = db.prepare("SELECT id FROM projects WHERE slug = ? AND id <> ?").get(slug, input.entityId) as
    | { id: string }
    | undefined;
  if (!holder) return;
  const free = (): string => {
    let n = 2;
    while (db.prepare("SELECT 1 AS hit FROM projects WHERE slug = ?").get(`${slug}-${n}`)) n += 1;
    return `${slug}-${n}`;
  };
  if (holderYields(db, "project", holder.id, ["slug"], claimSeqOf(input, ["slug"]))) {
    db.prepare("UPDATE projects SET slug = ? WHERE id = ?").run(free(), holder.id);
    oweSettlement(db, { entity: "project", entityId: holder.id, field: "slug", from: slug });
  } else if (db.prepare("SELECT 1 AS hit FROM projects WHERE id = ?").get(input.entityId)) {
    // An existing project keeps the slug it has — which is never this one, the index being
    // unique. The case is this device's own create coming back after it gave the slug up.
    pairs.splice(index, 1);
  } else {
    pairs[index] = ["slug", free()];
  }
}

/** The sentinel entity id the vocabulary ORDER travels on. Mirrors `store.ts`. */
const VOCABULARY_ORDER_ID = "@order";

/**
 * A status or kind row, or the singleton that carries their order.
 *
 * The order is one entity — `@order` — because sort positions are the same class
 * of problem as ranks: two devices reordering offline produce numbers that mean
 * nothing to each other. Sending the list and recomputing the positions on
 * arrival is the only merge that does not invent an order neither human asked
 * for.
 */
function applyVocabulary(
  db: DatabaseSync,
  input: ApplyInput,
  table: "workspace_statuses" | "workspace_kinds",
): boolean {
  if (input.entityId === VOCABULARY_ORDER_ID) {
    const order = input.payload.order;
    if (!Array.isArray(order)) return false;
    const write = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
    // Two passes: `sort_order` is not unique, but writing final positions in one
    // pass over a list that is a permutation of itself is still the shape that
    // trips a unique index the day somebody adds one. Cheap insurance.
    order.forEach((id, index) => {
      if (typeof id === "string") write.run(-(index + 1), id);
    });
    order.forEach((id, index) => {
      if (typeof id === "string") write.run((index + 1) * 1000, id);
    });
    /**
     * And every entry the order does not name goes after it, in the order it had.
     *
     * An order lists what its author held when it was written. An entry added since —
     * here, or concurrently on another device — is not in it, and left at its old
     * position it would land wherever that number happens to fall among the new ones: on
     * the device that wrote the order, reading its own order back on the next pull, a
     * status added after it jumped to the top. After the listed ones is where a receiver
     * puts an entry it has never seen, so every device ends in the same order.
     */
    const listed = new Set(order.filter((id): id is string => typeof id === "string"));
    const rest = (db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, id`).all() as Array<{ id: string }>).filter(
      (row) => !listed.has(row.id),
    );
    rest.forEach((row, index) => write.run((listed.size + index + 1) * 1000, row.id));
    return true;
  }

  if (input.verb === "delete") {
    /**
     * A vocabulary delete carries `migrateTo`, and the rows that moved are
     * journaled as their own `issue.update` operations by the originating
     * device (`removeStatus`, `removeKind`). So this removes the definition and
     * nothing else — re-running the migration locally would be a second,
     * conflicting authority over rows the origin has already decided about.
     *
     * A built-in is removed like any other. Every device starts with the same
     * built-ins, but a person can remove one (`removeStatus` allows it, under the
     * same guards), and skipping it here left that status on every device but the
     * one where it was removed — and on none that hydrated from the snapshot, which
     * folds the delete.
     */
    writeTombstone(db, input);
    moveOffRemoved(db, input, table === "workspace_statuses" ? "status" : "kind");
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(input.entityId);
    return true;
  }

  const label = input.payload.label;
  const category = input.payload.category;
  const exists = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE id = ?`).get(input.entityId) as
    | { hit: number }
    | undefined;

  if (!exists) {
    /**
     * A status is its category — every guard in the store keys off it — and only its
     * create carries one. A status this database does not hold, arriving without one, is
     * an update whose create has not arrived; it used to be inserted under a category
     * that does not exist. See `insertIssue`.
     */
    if (table === "workspace_statuses" && typeof category !== "string") {
      throw new ReferentMissing(`the create of status ${input.entityId}, which no operation so far has carried`);
    }
    const next = db.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1000 AS n FROM ${table}`).get() as {
      n: number;
    };
    if (table === "workspace_statuses") {
      db.prepare(
        `INSERT INTO workspace_statuses (id, label, category, sort_order, is_builtin) VALUES (?, ?, ?, ?, 0)`,
      ).run(
        input.entityId,
        typeof label === "string" ? label : input.entityId,
        typeof category === "string" ? category : "open",
        next.n,
      );
    } else {
      db.prepare(
        `INSERT INTO workspace_kinds (id, label, sort_order, is_builtin) VALUES (?, ?, ?, 0)`,
      ).run(input.entityId, typeof label === "string" ? label : input.entityId, next.n);
    }
    return true;
  }

  if (typeof label === "string") {
    db.prepare(`UPDATE ${table} SET label = ? WHERE id = ?`).run(label, input.entityId);
  }
  if (table === "workspace_statuses" && typeof category === "string") {
    db.prepare("UPDATE workspace_statuses SET category = ? WHERE id = ?").run(
      category,
      input.entityId,
    );
  }
  return true;
}

function settingDefinition(key: string): SettingDefinition | null {
  return SETTING_DEFINITIONS.find((definition) => definition.key === key) ?? null;
}

/**
 * A `setting:*` meta row.
 *
 * DIVERGENCE, and a small one worth naming: the seam journals `{ value }` and not
 * the `{ v, value }` storage envelope, so the definition VERSION does not travel.
 * For a key this build has a definition for that costs nothing — the value is
 * re-encoded at this build's version, which is what a local write would have
 * done. For a key it has never heard of, the value is preserved but is stored at
 * version 1, which is the one case where an older device round-tripping a newer
 * device's setting does not reproduce it byte for byte. The contract's promise is
 * that the setting is *preserved*, and it is; exact envelope fidelity needs the
 * version in the payload, which is an emitter change.
 */
function applySetting(db: DatabaseSync, input: ApplyInput): boolean {
  const metaKey = settingMetaKey(input.entityId);
  if (input.verb === "delete") {
    // A tombstone, as for every deletion: a late `update` of this setting is turned away,
    // and a `create` — a reset setting set again — lifts it (`applyToDatabase`).
    writeTombstone(db, input);
    db.prepare("DELETE FROM meta WHERE key = ?").run(metaKey);
    return true;
  }
  if (!("value" in input.payload)) return false;

  const definition = settingDefinition(input.entityId);
  const encoded = definition
    ? encodeStoredSetting(definition, input.payload.value as never)
    : JSON.stringify({ v: 1, value: input.payload.value });

  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(metaKey, encoded);
  return true;
}

/**
 * A milestone: its dates, its whole ordered membership, or both.
 *
 * `replace` is the ordered-collection verb and this is one of the two entities it
 * is for. `rank` is never transported — it is recomputed densely from list order
 * inside this transaction — which is what makes `UNIQUE (milestone_id, rank)`
 * structurally unreachable no matter what two devices did offline.
 *
 * ## Why membership is recognised by its shape rather than by the verb
 *
 * A `members` array means "these are the members, in this order", and it means that
 * regardless of which verb carried it. Gating on `verb === "replace"` made this
 * handler's correctness depend on a verb surviving every hop of the wire, and when
 * the snapshot route did not carry one, membership was not dropped loudly — it fell
 * through to the dates branch and wrote two NULLs over the milestone instead.
 *
 * `applyQueue` has always keyed off `payload.order` for the same reason. The two
 * ordered collections now agree, and a verb that goes missing again costs a
 * diagnosis rather than a silent hydration into the wrong state.
 *
 * ## Why every facet is applied, and only the facets the payload named (STA-259)
 *
 * A milestone holds two facts that travel as two different payload shapes against the
 * same entity key: dates as `{ targetDate, startDate }`, membership as `{ members }`.
 * This handler used to treat them as alternatives — apply the members and RETURN, else
 * write the dates — and both halves of that were wrong the moment one payload carried
 * both, which is exactly what a fold produces. A snapshot ships one entity per entity
 * and a restore materialises one operation per folded entity, so there is no server-side
 * way to split them back apart; the receiver has to apply what it was handed.
 *
 *   - Members present and dates ignored was a silent DROP.
 *   - Absent date keys written as NULL was a silent OVERWRITE, which is worse: it
 *     destroyed values that were never in question. An operation about membership said
 *     nothing whatsoever about dates, and this wrote both of them to NULL.
 *
 * So each facet is applied when, and only when, the payload names it. The distinction
 * that carries the weight is PRESENT-AND-NULL versus ABSENT: `{ targetDate: null }`
 * means "cleared" and is honoured, which is how `MilestoneStore.update` clears a date;
 * no `targetDate` key at all means "I have no opinion" and the stored value stands. A
 * payload naming neither facet is a no-op rather than an eraser.
 */
function applyMilestone(db: DatabaseSync, input: ApplyInput): boolean {
  const members = input.payload.members;
  const hasMembers = Array.isArray(members);
  const hasTarget = "targetDate" in input.payload;
  const hasStart = "startDate" in input.payload;
  if (!hasMembers && !hasTarget && !hasStart) return false;

  if (!issueExists(db, input.entityId)) throw new ReferentMissing(`milestone ${input.entityId}`);

  if (hasMembers) {
    const ids = members.filter((id): id is string => typeof id === "string");
    for (const id of ids) {
      if (!issueExists(db, id)) throw new ReferentMissing(`issue ${id} (member of ${input.entityId})`);
    }

    const held = entryMetadata(
      db
        .prepare(
          `SELECT issue_id, added_by, added_at, note FROM milestone_members
            WHERE milestone_id = ? OR issue_id IN (SELECT value FROM json_each(?))`,
        )
        .all(input.entityId, JSON.stringify(ids)) as unknown as EntryRow[],
    );
    db.prepare("DELETE FROM milestone_members WHERE milestone_id = ?").run(input.entityId);
    const ranks = renumberedRanks(ids.length);
    const insert = db.prepare(
      `INSERT INTO milestone_members (issue_id, milestone_id, rank, added_by, added_at, note)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (issue_id) DO UPDATE SET
         milestone_id = excluded.milestone_id, rank = excluded.rank,
         added_by = excluded.added_by, added_at = excluded.added_at, note = excluded.note`,
    );
    ids.forEach((id, index) => {
      const entry = entryFor(id, input, held);
      insert.run(id, input.entityId, ranks[index]!, entry.addedBy, entry.addedAt, entry.note);
    });

    /**
     * `members_revision` is a device-local CAS counter for the local editor and
     * does not replicate; it is bumped on apply like any other local write so
     * that an open editor's optimistic-concurrency check notices the change.
     */
    db.prepare(
      `INSERT INTO milestone_meta (issue_id, members_revision, updated_at)
       VALUES (?, 1, ?)
       ON CONFLICT (issue_id) DO UPDATE SET
         members_revision = members_revision + 1, updated_at = excluded.updated_at`,
    ).run(input.entityId, input.at);
  }

  if (hasTarget || hasStart) {
    const target = input.payload.targetDate;
    const start = input.payload.startDate;
    /**
     * The `CASE` is the "silent about what it did not name" rule, in SQL. On INSERT the
     * row is new and an unnamed column is null because it has no prior value to keep; on
     * conflict, an unnamed column keeps the value it already had rather than taking the
     * null this statement had to bind for it.
     */
    db.prepare(
      `INSERT INTO milestone_meta (issue_id, target_date, start_date, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (issue_id) DO UPDATE SET
         target_date = CASE WHEN ? = 1 THEN excluded.target_date ELSE milestone_meta.target_date END,
         start_date  = CASE WHEN ? = 1 THEN excluded.start_date  ELSE milestone_meta.start_date  END,
         updated_at  = excluded.updated_at`,
    ).run(
      input.entityId,
      typeof target === "string" ? target : null,
      typeof start === "string" ? start : null,
      input.at,
      hasTarget ? 1 : 0,
      hasStart ? 1 : 0,
    );
  }

  return true;
}

interface EntryRow {
  issue_id: string;
  added_by: string;
  added_at: string;
  note: string | null;
}

interface EntryMetadata {
  readonly addedBy: string;
  readonly addedAt: string;
  readonly note: string | null;
}

function entryMetadata(rows: readonly EntryRow[]): Map<string, EntryMetadata> {
  return new Map(rows.map((row) => [row.issue_id, { addedBy: row.added_by, addedAt: row.added_at, note: row.note }]));
}

/**
 * Who added one entry of an ordered collection, when, and with what note.
 *
 * The list travels as ids, because the ORDER is what is contested and what the rank
 * is recomputed from; the per-entry facts travel beside it, in `entries`, keyed by
 * issue id — `docs/sync.md`: *"`added_by`, `added_at` and `note` ride along"*. Before
 * they did, a note written on one device never reached another, and every apply wrote
 * the applying operation's actor and time over every entry, so a plan reordered on one
 * device erased every other device's record of who queued what.
 *
 * An operation that says nothing about an entry — one from a build before `entries`,
 * or a conflict resolution that carries only the order — leaves what this database
 * already holds for it. Only an entry nobody has described takes the operation's actor
 * and time.
 */
function entryFor(id: string, input: ApplyInput, held: Map<string, EntryMetadata>): EntryMetadata {
  const described = input.payload.entries;
  const carried =
    described !== null && typeof described === "object" && !Array.isArray(described)
      ? (described as Record<string, unknown>)[id]
      : undefined;
  if (carried !== null && typeof carried === "object" && !Array.isArray(carried)) {
    const entry = carried as Record<string, unknown>;
    return {
      addedBy: typeof entry.addedBy === "string" ? entry.addedBy : (held.get(id)?.addedBy ?? input.actor ?? "sync"),
      addedAt: typeof entry.addedAt === "string" ? entry.addedAt : (held.get(id)?.addedAt ?? input.at),
      note: typeof entry.note === "string" ? entry.note : null,
    };
  }
  return held.get(id) ?? { addedBy: input.actor ?? "sync", addedAt: input.at, note: null };
}

/**
 * The plan, replaced whole.
 *
 * `queue_entries.rank` is `UNIQUE` across the WHOLE table rather than per
 * container, which makes it the worst case in the schema for a per-row merge and
 * is exactly why no per-row queue operation exists on the wire. The delete and
 * re-insert happen in one transaction, so the constraint is never observed in an
 * intermediate state.
 */
function applyQueue(db: DatabaseSync, input: ApplyInput): boolean {
  const order = input.payload.order;
  if (!Array.isArray(order)) return false;
  const ids = order.filter((id): id is string => typeof id === "string");
  for (const id of ids) {
    if (!issueExists(db, id)) throw new ReferentMissing(`issue ${id} (queued)`);
  }

  const held = entryMetadata(
    db.prepare("SELECT issue_id, added_by, added_at, note FROM queue_entries").all() as unknown as EntryRow[],
  );
  db.prepare("DELETE FROM queue_entries").run();
  const ranks = renumberedRanks(ids.length);
  const insert = db.prepare(
    "INSERT INTO queue_entries (issue_id, rank, added_by, added_at, note) VALUES (?, ?, ?, ?, ?)",
  );
  ids.forEach((id, index) => {
    const entry = entryFor(id, input, held);
    insert.run(id, ranks[index]!, entry.addedBy, entry.addedAt, entry.note);
  });

  // The local CAS token, bumped so an open editor notices. Local, never sent.
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('queue_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run();
  return true;
}

// -------------------------------------------------------------------- leases

/**
 * A pulled lease operation, projected onto the checkout model.
 *
 * *"Pulled lease operations project deterministically onto `checkout_agent` and
 * `checkout_at`, so `ls`, `show` and `inbox` keep rendering the fields they
 * already render; the token and the server expiry live in the sync tables, not
 * in new `issues` columns."*
 *
 * ## Deterministic means "a function of the operations, and of nothing else"
 *
 * Not of the clock, and not of arrival order. Every decision below is a
 * comparison of fencing tokens, which are allocated by one counter on one server
 * and are therefore totally ordered no matter which device is reading them. Two
 * machines that apply the same operations reach the same two columns, whatever
 * order the pages arrived in and whatever their clocks say.
 *
 * `expires_at` is written and never read. Nothing here — nothing anywhere in the
 * client — decides that a lease has ended by looking at a timestamp. Expiry is
 * the server's, and the way that stays true is that the client has no code that
 * could make the other choice.
 *
 * ## Why a delete names its holder
 *
 * A release that arrives after a takeover must not free work the new holder is
 * doing. The tombstone-shaped instinct — "delete means gone" — is wrong for a
 * lease, because a lease is a claim on a slot that somebody else may now own.
 * So a delete clears the checkout only when the holder it names is still the
 * holder, and its fencing token is not older than the row it is trying to clear.
 */
function applyLease(db: DatabaseSync, input: ApplyInput): boolean {
  if (!issueExists(db, input.entityId)) {
    throw new ReferentMissing(`issue ${input.entityId} (subject of a lease)`);
  }

  const payload = input.payload;
  const incoming = typeof payload.fencingToken === "number" ? payload.fencingToken : null;
  const holder = typeof payload.holder === "string" ? payload.holder : input.actor;
  const existing = db
    .prepare("SELECT fencing_token AS token, holder FROM sync_leases WHERE entity_id = ?")
    .get(input.entityId) as { token: number; holder: string } | undefined;

  if (input.verb === "delete") {
    /**
     * Stale on either axis is ignored: an older token, or a holder who is no
     * longer the one recorded. Both describe a release for a lease generation
     * that has already been superseded, and acting on either would hand a
     * running agent's work back to the pool.
     */
    if (existing && incoming !== null && incoming < existing.token) return false;
    if (existing && holder !== null && existing.holder !== holder) return false;

    db.prepare("DELETE FROM sync_leases WHERE entity_id = ?").run(input.entityId);
    db.prepare(
      `UPDATE issues SET checkout_agent = NULL, checkout_at = NULL, updated_at = ?
        WHERE id = ? AND checkout_agent = ?`,
    ).run(input.at, input.entityId, holder);
    return true;
  }

  if (incoming === null || holder === null) return false;
  // A create or an update carrying a superseded token is a replay. Keeping the
  // newer row is the whole reason the mirror is fenced as well as the server.
  if (existing && incoming < existing.token) return false;

  const serverExpiresAt =
    typeof payload.serverExpiresAt === "string" ? payload.serverExpiresAt : null;
  if (serverExpiresAt === null) return false;
  const acquiredAt = typeof payload.acquiredAt === "string" ? payload.acquiredAt : input.at;
  const renewedAt = typeof payload.renewedAt === "string" ? payload.renewedAt : null;
  const deviceId = typeof payload.deviceId === "string" ? payload.deviceId : input.deviceId;

  db.prepare(
    `INSERT INTO sync_leases
       (entity_id, fencing_token, holder, device_id, server_expires_at, acquired_at, renewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_id) DO UPDATE SET
       fencing_token     = excluded.fencing_token,
       holder            = excluded.holder,
       device_id         = excluded.device_id,
       server_expires_at = excluded.server_expires_at,
       acquired_at       = excluded.acquired_at,
       renewed_at        = excluded.renewed_at`,
  ).run(input.entityId, incoming, holder, deviceId, serverExpiresAt, acquiredAt, renewedAt);

  /**
   * The projection. `acquired_at` and not `input.at`: the checkout time a human
   * reads should be when the lease was granted, by the clock that granted it,
   * not when the operation happened to be journaled on the far machine.
   *
   * A renewal moves nothing here. It extends an expiry that no local surface
   * renders and that no local decision reads; rewriting `checkout_at` on every
   * beat would make an issue's age reset every thirty seconds.
   */
  if (input.verb === "create") {
    db.prepare(
      "UPDATE issues SET checkout_agent = ?, checkout_at = ?, updated_at = ? WHERE id = ?",
    ).run(holder, acquiredAt, input.at, input.entityId);
  }
  return true;
}

// ---------------------------------------------------------------- tombstones

function isTombstoned(db: DatabaseSync, entity: string, entityId: string): boolean {
  const row = db
    .prepare("SELECT 1 AS hit FROM sync_tombstones WHERE entity = ? AND entity_id = ?")
    .get(entity, entityId) as { hit: number } | undefined;
  return row !== undefined;
}

/**
 * Write the tombstone, then remove the row.
 *
 * That order is the contract's: *"the local row is removed only after the
 * tombstone is durable in the same transaction."* A crash between them leaves
 * either both or neither, and "tombstone without row" is the harmless one.
 */
function tombstone(db: DatabaseSync, input: ApplyInput, table: string, key: string): boolean {
  writeTombstone(db, input);
  db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(input.entityId);
  return true;
}

function writeTombstone(db: DatabaseSync, input: ApplyInput): void {
  db.prepare(
    `INSERT INTO sync_tombstones (entity, entity_id, deleted_at, device_id, op_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (entity, entity_id) DO NOTHING`,
  ).run(input.entity, input.entityId, input.at, input.deviceId, input.opId);
}

// --------------------------------------------------------------------- utils

function updateRow(
  db: DatabaseSync,
  table: string,
  key: string,
  id: string,
  pairs: Array<[string, unknown]>,
): void {
  const set = pairs.map(([column]) => `${column} = ?`).join(", ");
  db.prepare(`UPDATE ${table} SET ${set} WHERE ${key} = ?`).run(
    ...([...pairs.map(([, value]) => value), id] as never[]),
  );
}

/**
 * Set the local entity version to what the server folded.
 *
 * Called on the bootstrap path only. An incremental apply must NOT do this: the
 * local version counts this device's own journaled mutations too, and overwriting
 * it with the server's fold count would make the next local operation claim a
 * `baseVersion` that the receiver has already seen.
 */
/**
 * The entity version this device currently holds, or 0 when it holds none.
 *
 * Read by the bootstrap immediately BEFORE {@link setEntityVersion}, because the
 * two answers differ on exactly the path that matters: a re-bootstrap carries a
 * counter across an epoch change, and inherited provenance has to be expressed on
 * the counter in use rather than on the fold's restarted one.
 */
export function localEntityVersion(db: DatabaseSync, entity: string, entityId: string): number {
  const row = db
    .prepare("SELECT version FROM sync_entity_versions WHERE entity = ? AND entity_id = ?")
    .get(entity, entityId) as { version: number } | undefined;
  return row?.version ?? 0;
}

export function setEntityVersion(
  db: DatabaseSync,
  entity: string,
  entityId: string,
  version: number,
): void {
  db.prepare(
    `INSERT INTO sync_entity_versions (entity, entity_id, version) VALUES (?, ?, ?)
     ON CONFLICT (entity, entity_id) DO UPDATE SET version = MAX(version, excluded.version)`,
  ).run(entity, entityId, version);
}

/**
 * Bump the local entity version by one, the way a journaled mutation would.
 *
 * An applied remote operation is a mutation of this entity as far as this
 * database is concerned, so its version has to move — otherwise the next local
 * edit would carry a `baseVersion` from before the remote change and every
 * receiver would read it as a conflict.
 */
export function bumpEntityVersion(db: DatabaseSync, entity: string, entityId: string): void {
  db.prepare(
    `INSERT INTO sync_entity_versions (entity, entity_id, version) VALUES (?, ?, 1)
     ON CONFLICT (entity, entity_id) DO UPDATE SET version = version + 1`,
  ).run(entity, entityId);
}
