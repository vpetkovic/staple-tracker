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
import { StapleError, normalizeTitle } from "../types.js";
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
const COMMENT_COLUMNS = withColumnAliases(COMMENT_FIELDS);
const PROJECT_COLUMNS = withColumnAliases(PROJECT_FIELDS);

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
  };
}

/**
 * A folded snapshot entity is an apply with the verb it already carries in
 * `deletedAt`.
 *
 * The server folds `create`, `update` and `renumber` into one merged `state` and
 * records the tombstone separately, so there is exactly one distinction left to
 * make here. The `version` it reports becomes the local entity version, which is
 * what makes the first post-bootstrap local mutation carry a `baseVersion` that
 * means something.
 */
export function snapshotToInput(entity: SnapshotEntity, at: string): ApplyInput {
  return {
    entity: entity.entity,
    entityId: entity.entityId,
    verb: entity.deletedAt === null ? "create" : "delete",
    payload: entity.state,
    actor: null,
    deviceId: null,
    at,
    opId: null,
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
  if (input.verb !== "delete" && isTombstoned(db, input.entity, input.entityId)) return false;

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
      return applyVocabulary(db, input, "workspace_statuses");
    case "kind":
      return applyVocabulary(db, input, "workspace_kinds");
    case "setting":
      return applySetting(db, input);
    case "milestone":
      return applyMilestone(db, input);
    case "queue":
      return applyQueue(db, input);
    case "lease":
    case "conflict":
      /**
       * Not applied by this build, and not an error either.
       *
       * Nothing in the tree journals either entity yet — leases belong to the
       * distributed-claim lane and conflict resolutions to the conflict lane —
       * so this branch is currently unreachable from any device running this
       * code. It is a no-op rather than a throw so that a future device pushing
       * one cannot stall an older device's whole page; the older device simply
       * has no lease table entries to show, which is the same position it is in
       * today.
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

function applyIssue(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb === "delete") return tombstone(db, input, "issues", "id");

  const { payload } = input;
  const pairs = project(payload, ISSUE_COLUMNS);

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
    updateRow(db, "issues", "id", input.entityId, pairs);
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
    throw new StapleError(
      "validation",
      `A remote issue.create for ${input.entityId} carries no identifier. Identifiers are ` +
        `allocated by the originating device and always travel with the create.`,
    );
  }

  const identifier = values.get("identifier") as string;
  const owner = identifierOwner(db, identifier);
  if (owner !== null && owner !== input.entityId) {
    /**
     * Two devices minted the same identifier offline.
     *
     * `docs/sync.md` says this cannot happen because *"the server assigns the
     * canonical number from the repository's own counter and returns it in the
     * push response"* — but the deployed Worker implements no allocator and its
     * push response carries only `{opId, status, seq}`, so the collision is real
     * today. See the lane report.
     *
     * It is recorded as a conflict on the `identifier` field and the rest of the
     * entity is applied under a provisional identifier, because *"No path
     * applies last-write-wins"* and choosing a winner here would be exactly
     * that. The conflict lane resolves it; until then both issues exist, both
     * are reachable, and the contested field is on the record with both values.
     */
    const provisional = provisionalIdentifier(db, identifier);
    recordIdentifierConflict(db, input, identifier, provisional);
    values.set("identifier", provisional);
  }

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
    if (identifierOwner(db, candidate) === null) return candidate;
  }
  throw new StapleError("conflict", `Could not find a free identifier near ${identifier}.`);
}

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
     VALUES (?, 'issue', ?, 'identifier', NULL, ?, ?, NULL, ?, NULL, ?, NULL, ?, ?)`,
  ).run(
    `identifier:${input.entityId}`,
    input.entityId,
    contested,
    provisional,
    input.opId,
    input.deviceId,
    input.at,
    input.at,
  );
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
    if (pairs.length > 0) updateRow(db, "comments", "id", input.entityId, pairs);
    return true;
  }

  const values = new Map(pairs);
  values.set("id", input.entityId);
  if (!values.has("author")) values.set("author", input.actor ?? "unknown");
  if (!values.has("body")) values.set("body", "");
  if (!values.has("created_at")) values.set("created_at", input.at);
  const columns = [...values.keys()];
  db.prepare(
    `INSERT INTO comments (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...([...values.values()] as never[]));
  return true;
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

  db.prepare(
    `INSERT INTO document_revisions (issue_id, key, revision, body, author, change_summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (issue_id, key, revision) DO NOTHING`,
  ).run(
    issueId,
    key,
    revision,
    typeof payload.body === "string" ? payload.body : "",
    input.actor,
    typeof payload.changeSummary === "string" ? payload.changeSummary : null,
    input.at,
  );

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
  ).run(issueId, key, revision, typeof payload.title === "string" ? payload.title : null, input.at);
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

function splitDocumentKey(entityId: string): [string, string] {
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
  db.prepare("DELETE FROM relations WHERE blocked_id = ? AND type = 'blocks'").run(blockedId);
  const insert = db.prepare(
    `INSERT INTO relations (blocker_id, blocked_id, type, created_by, created_at)
     VALUES (?, ?, 'blocks', ?, ?)
     ON CONFLICT (blocker_id, blocked_id, type) DO NOTHING`,
  );
  for (const id of ids) insert.run(id, blockedId, input.actor, input.at);
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
  const exists = db.prepare("SELECT 1 AS hit FROM projects WHERE id = ?").get(input.entityId) as
    | { hit: number }
    | undefined;

  if (exists) {
    if (pairs.length > 0) updateRow(db, "projects", "id", input.entityId, pairs);
    return true;
  }

  const values = new Map(pairs);
  values.set("id", input.entityId);
  if (!values.has("slug")) values.set("slug", input.entityId);
  if (!values.has("name")) values.set("name", values.get("slug"));
  if (!values.has("created_at")) values.set("created_at", input.at);
  if (!values.has("updated_at")) values.set("updated_at", input.at);
  const columns = [...values.keys()];
  db.prepare(
    `INSERT INTO projects (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
  ).run(...([...values.values()] as never[]));
  return true;
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
    return true;
  }

  if (input.verb === "delete") {
    /**
     * A vocabulary delete carries `migrateTo`, and the rows that moved are
     * journaled as their own `issue.update` operations by the originating
     * device. So this removes the definition and nothing else — re-running the
     * migration locally would be a second, conflicting authority over rows the
     * origin has already decided about.
     */
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND is_builtin = 0`).run(input.entityId);
    return true;
  }

  const label = input.payload.label;
  const category = input.payload.category;
  const exists = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE id = ?`).get(input.entityId) as
    | { hit: number }
    | undefined;

  if (!exists) {
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
 * A milestone: its dates, or its whole ordered membership.
 *
 * `replace` is the ordered-collection verb and this is one of the two entities it
 * is for. `rank` is never transported — it is recomputed densely from list order
 * inside this transaction — which is what makes `UNIQUE (milestone_id, rank)`
 * structurally unreachable no matter what two devices did offline.
 */
function applyMilestone(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb === "replace") {
    const members = input.payload.members;
    if (!Array.isArray(members)) return false;
    if (!issueExists(db, input.entityId)) throw new ReferentMissing(`milestone ${input.entityId}`);
    const ids = members.filter((id): id is string => typeof id === "string");
    for (const id of ids) {
      if (!issueExists(db, id)) throw new ReferentMissing(`issue ${id} (member of ${input.entityId})`);
    }

    db.prepare("DELETE FROM milestone_members WHERE milestone_id = ?").run(input.entityId);
    const ranks = renumberedRanks(ids.length);
    const insert = db.prepare(
      `INSERT INTO milestone_members (issue_id, milestone_id, rank, added_by, added_at, note)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT (issue_id) DO UPDATE SET
         milestone_id = excluded.milestone_id, rank = excluded.rank`,
    );
    ids.forEach((id, index) => insert.run(id, input.entityId, ranks[index]!, input.actor ?? "sync", input.at));

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
    return true;
  }

  if (!issueExists(db, input.entityId)) throw new ReferentMissing(`milestone ${input.entityId}`);
  const target = input.payload.targetDate;
  const start = input.payload.startDate;
  db.prepare(
    `INSERT INTO milestone_meta (issue_id, target_date, start_date, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (issue_id) DO UPDATE SET
       target_date = excluded.target_date,
       start_date  = excluded.start_date,
       updated_at  = excluded.updated_at`,
  ).run(
    input.entityId,
    typeof target === "string" ? target : null,
    typeof start === "string" ? start : null,
    input.at,
  );
  return true;
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

  db.prepare("DELETE FROM queue_entries").run();
  const ranks = renumberedRanks(ids.length);
  const insert = db.prepare(
    "INSERT INTO queue_entries (issue_id, rank, added_by, added_at, note) VALUES (?, ?, ?, ?, NULL)",
  );
  ids.forEach((id, index) => insert.run(id, ranks[index]!, input.actor ?? "sync", input.at));

  // The local CAS token, bumped so an open editor notices. Local, never sent.
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('queue_revision', '1')
     ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)`,
  ).run();
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
  db.prepare(
    `INSERT INTO sync_tombstones (entity, entity_id, deleted_at, device_id, op_id)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (entity, entity_id) DO NOTHING`,
  ).run(input.entity, input.entityId, input.at, input.deviceId, input.opId);
  db.prepare(`DELETE FROM ${table} WHERE ${key} = ?`).run(input.entityId);
  return true;
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
