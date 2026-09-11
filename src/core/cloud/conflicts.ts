/**
 * Conflicts: detection, preservation, and explicit resolution.
 *
 * Contract: `docs/sync.md`, "Conflicts are preserved, never resolved silently".
 *
 * ## The one rule everything here serves
 *
 * **No path applies last-write-wins.** Before this file existed, two devices
 * editing one field offline both ended up holding whichever value carried the
 * higher server `seq` — the loser was overwritten in place, with nothing
 * anywhere recording that there had been two answers. That is the behaviour this
 * module removes, and the negative assertion at the top of
 * `test/cloud-conflicts.test.ts` is what pins it.
 *
 * So a contested field is **withheld** from the apply and written to
 * `sync_conflicts` with both sides in full. Withholding is not "local wins": the
 * local value is the *incumbent*, the remote value is retained verbatim and is
 * one keystroke from being adopted, and neither is marked correct. Nothing has
 * been decided until a human or an agent decides it.
 *
 * ## Detection, and why the version comparison is sound
 *
 * *"an incoming operation conflicts when its `baseVersion` is behind the local
 * entity version and its payload field set intersects the fields changed by the
 * local operations in between."* Three conditions, and the third is mine:
 *
 *   1. `op.baseVersion < sync_entity_versions.version` — the sender had seen
 *      fewer operations on this entity than this device has.
 *   2. The field is named by a `sync_field_writes` row for the same entity with
 *      `base_version >= op.baseVersion` — those are exactly "the local
 *      operations in between".
 *   3. The remote value differs from what the row currently holds.
 *
 * `sync_entity_versions.version` is a per-device counter, so (1) looks like it
 * is comparing two devices' private clocks. It is not, quite: **every** device
 * bumps the counter once for every operation on that entity it has ever seen,
 * whether it journaled the operation or applied it. Two devices that have seen
 * the same operations therefore hold the same number, and "behind" means
 * "emitted without having seen everything I have". That is a Lamport counter
 * doing exactly what it is good for, and nothing here needs it to be more.
 *
 * Condition (3) is not decoration. A device pulls its own operations back and
 * applies them, so the echo of a local write always trips (1) and (2); it is
 * only (3) that stops every ordinary write being reported as a conflict with
 * itself. It also stops two devices that made the *same* call about an open
 * conflict from forking a second time over their agreement.
 *
 * ## Condition (2) is evidence, and evidence has to outlive housekeeping
 *
 * That condition used to be read off `sync_outbox`, and the outbox is the wrong
 * witness twice over. It is a queue of what this device has to SEND, and the
 * question is what this device HOLDS. A device that **applied** another device's
 * `title` journaled nothing — obligation 4, and the reason two devices do not
 * synchronize forever — so it had no row naming `title` and handed the value to
 * the next stale write in silence. And `compact()` prunes acknowledged rows as
 * routine, documented housekeeping, after which even the **author** could no
 * longer defend its own edit. **Detection that expires with housekeeping is not
 * detection.**
 *
 * So the evidence lives in `sync_field_writes` (migration 011): the newest write
 * of each field of each entity, with the version it moved off, written by all
 * THREE paths by which this database can come to hold a field — `Journal.flush`
 * for a local mutation, {@link screenForConflicts} for an applied remote one, and
 * `recordInheritedFieldWrites` for one folded into a snapshot (STA-263). Only the
 * newest write per field is kept, which is all detection asks for, and which
 * bounds the table by live entities rather than by history: nothing time-based
 * ever prunes it, so nothing time-based can expire it.
 *
 * The third path needs the SERVER's help and is why it arrived separately. A fold
 * ships one value per field and cannot say which of them anybody chose, so a
 * device recording the snapshot's fields wholesale would claim every default the
 * `create` carried — contesting a `medium` nobody picked. `worker/src/fold.ts`
 * therefore carries per-field provenance for the keys a NON-CREATE operation
 * touched, which is the same line `Journal.flush` draws for local writes, and the
 * result is that a bootstrapped device holds field-for-field what a device
 * present for the whole log holds.
 *
 * **{@link screenForConflicts} therefore writes as well as reads**, in the
 * caller's transaction, immediately before the apply it screens for. Its name
 * says less than it does; the ordering constraints are spelled out on it.
 *
 * ## What is never contested
 *
 * `updated_at` is bumped by every write on every device, so an intersection on
 * it is guaranteed and means nothing — treating it as contestable would make
 * *"Disjoint field sets are not a conflict"* false for every concurrent pair of
 * edits in the fleet. It is bookkeeping and it rides along.
 *
 * `normalized_title` and `status_version` are derived from `title` and `status`.
 * They are never a conflict in their own right, and they are withheld exactly
 * when their source is withheld — a row holding one device's title under the
 * other device's normalization is a corruption no user could explain.
 *
 * `documentRevision` and `relation` carry immutable rows; `events` are
 * re-derived and never transported. None of them can diverge, so none is
 * screened.
 *
 * ## Ordered collections conflict whole
 *
 * `queue_entries` and `milestone_members` replicate as whole-list `replace`
 * operations with rank recomputed on apply, precisely so their `UNIQUE` rank
 * constraints are structurally unreachable. They are screened as ONE pseudo-field
 * holding the entire plan — *"both plans are retained and the human picks one, or
 * edits a third"* — and never row by row, which would put the constraint back in
 * reach for no gain.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../../config/home.js";
import { carryIdentifierMovesToHub } from "../hub-follow.js";
import { moveIdentifier } from "../identifier-moves.js";
import { journalFor, recordFieldWrites, type SyncEntity, type SyncVerb } from "../journal.js";
import { settingMetaKey } from "../settings-registry.js";
import { StapleError, nowIso } from "../types.js";
import {
  COMMENT_COLUMNS,
  ISSUE_COLUMNS,
  PROJECT_COLUMNS,
  applyToDatabase,
  operationToInput,
  splitDocumentKey,
  type ApplyInput,
} from "./apply.js";
import type { RemoteOperation } from "./wire.js";

// ------------------------------------------------------------------- shapes

export type ResolutionChoice = "local" | "remote" | "custom";

/** One contested field, with both sides retained in full. */
export interface ConflictRecord {
  readonly id: string;
  readonly entity: string;
  readonly entityId: string;
  readonly field: string;
  /** The value both sides diverged from, or undefined when it is unrecoverable. */
  readonly baseValue: unknown;
  /** What this database holds. Incumbent, not winner. */
  readonly localValue: unknown;
  /** What arrived and was withheld. Retained verbatim. */
  readonly remoteValue: unknown;
  readonly localOpId: string | null;
  readonly remoteOpId: string | null;
  readonly localDeviceId: string | null;
  readonly remoteDeviceId: string | null;
  readonly localAt: string | null;
  readonly remoteAt: string | null;
  readonly detectedAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
  /** The value that was chosen. Meaningful only when `resolvedAt` is set. */
  readonly resolvedValue: unknown;
  /**
   * Which side the chosen value turned out to be, ON THIS DEVICE.
   *
   * Derived rather than replicated. The two devices in a conflict hold mirrored
   * records — A's local is B's remote — so a stored "remote" would read as a
   * lie on the other machine. The VALUE converges; the label is relative and is
   * computed against the row it is being shown beside.
   */
  readonly resolvedChoice: ResolutionChoice | null;
}

export interface ResolveRequest {
  readonly id: string;
  readonly choice: ResolutionChoice;
  /** Required for `custom`, ignored otherwise. */
  readonly value?: unknown;
  readonly actor?: string | null;
}

/** An identifier an incumbent issue gave up so the chosen value could be used. */
export interface Renumbering {
  readonly issueId: string;
  readonly from: string;
  readonly to: string;
}

export interface ResolveOutcome {
  readonly conflict: ConflictRecord;
  /** False when the conflict already held this exact resolution. */
  readonly changed: boolean;
  readonly renumbered: readonly Renumbering[];
}

// -------------------------------------------------------------- field policy

interface FieldPolicy {
  /** The canonical name — the column, so `normalizedTitle` and `normalized_title` agree. */
  readonly name: string;
  /** Set when this field only exists as a function of another. */
  readonly derivedFrom?: string;
  /** Bumped by every write everywhere; contesting it is meaningless. */
  readonly bookkeeping?: boolean;
}

const BOOKKEEPING = new Set(["updated_at"]);
const DERIVED: Record<string, string> = {
  normalized_title: "title",
  status_version: "status",
};

/** The whole-plan pseudo-field an ordered collection replicates as. */
const WHOLE: Record<string, string> = {
  queue: "order",
  milestone: "members",
};

function policy(entity: string, key: string): FieldPolicy | null {
  const named = (name: string): FieldPolicy => ({
    name,
    derivedFrom: DERIVED[name],
    bookkeeping: BOOKKEEPING.has(name),
  });

  switch (entity) {
    case "issue":
      return ISSUE_COLUMNS[key] ? named(ISSUE_COLUMNS[key]!.column) : null;
    case "comment":
      return COMMENT_COLUMNS[key] ? named(COMMENT_COLUMNS[key]!.column) : null;
    case "project":
      return PROJECT_COLUMNS[key] ? named(PROJECT_COLUMNS[key]!.column) : null;
    case "document":
      if (key === "currentRevision" || key === "current_revision") return named("current_revision");
      if (key === "title") return named("title");
      if (key === "updatedAt" || key === "updated_at") return named("updated_at");
      return null;
    case "milestone":
      if (key === "members") return { name: "members" };
      if (key === "targetDate" || key === "target_date") return named("target_date");
      if (key === "startDate" || key === "start_date") return named("start_date");
      if (key === "updatedAt" || key === "updated_at") return named("updated_at");
      return null;
    case "queue":
      return key === "order" ? { name: "order" } : null;
    case "status":
    case "kind":
      if (key === "order") return { name: "order" };
      if (key === "label" || key === "category") return named(key);
      return null;
    case "setting":
      return key === "value" ? { name: "value" } : null;
    /**
     * Not screened, and each for its own reason. `documentRevision` rows are
     * *"immutable once written"*; a `relation` is an edge that exists or does
     * not; a `lease` is arbitrated by the server's fencing token, not by this
     * device; and a `conflict` operation is itself the resolution machinery.
     */
    default:
      return null;
  }
}

/** Verbs that can carry a field-level divergence at all. */
function screenable(verb: string): boolean {
  return verb === "update" || verb === "renumber" || verb === "replace";
}

// ------------------------------------------------------------ reading state

/**
 * What this database currently holds for a canonical field.
 *
 * `present: false` means the row is not here — a create that has not arrived, or
 * an entity this build has no table for. An absent row cannot contest anything,
 * so detection stops rather than inventing a local side.
 */
function readField(
  db: DatabaseSync,
  entity: string,
  entityId: string,
  name: string,
): { present: boolean; value: unknown } {
  const scalar = (table: string, key: string, column: string): { present: boolean; value: unknown } => {
    const row = db.prepare(`SELECT ${column} AS v FROM ${table} WHERE ${key} = ?`).get(entityId) as
      | { v: unknown }
      | undefined;
    return row === undefined ? { present: false, value: null } : { present: true, value: row.v };
  };
  const list = (sql: string, ...params: unknown[]): { present: boolean; value: unknown } => ({
    present: true,
    value: (db.prepare(sql).all(...(params as never[])) as Array<{ id: string }>).map((r) => r.id),
  });

  switch (entity) {
    case "issue":
      return scalar("issues", "id", name);
    case "comment":
      return scalar("comments", "id", name);
    case "project":
      return scalar("projects", "id", name);
    case "document": {
      const [issueId, key] = splitDocumentKey(entityId);
      const row = db
        .prepare(`SELECT ${name} AS v FROM documents WHERE issue_id = ? AND key = ?`)
        .get(issueId, key) as { v: unknown } | undefined;
      return row === undefined ? { present: false, value: null } : { present: true, value: row.v };
    }
    case "milestone":
      if (name === "members") {
        return list(
          "SELECT issue_id AS id FROM milestone_members WHERE milestone_id = ? ORDER BY rank",
          entityId,
        );
      }
      return scalar("milestone_meta", "issue_id", name);
    case "queue":
      return list("SELECT issue_id AS id FROM queue_entries ORDER BY rank");
    case "status":
    case "kind": {
      const table = entity === "status" ? "workspace_statuses" : "workspace_kinds";
      if (name === "order") return list(`SELECT id FROM ${table} ORDER BY sort_order`);
      return scalar(table, "id", name);
    }
    case "setting": {
      const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(settingMetaKey(entityId)) as
        | { value: unknown }
        | undefined;
      return { present: true, value: row?.value ?? null };
    }
    default:
      return { present: false, value: null };
  }
}

// ------------------------------------------------------------------ codec

/**
 * Compare a payload value against a column value.
 *
 * They are not the same representation and cannot be made so: the payload holds
 * `["a","b"]` and `false`, the column holds `'["a","b"]'` and `0`. Comparing
 * without normalizing would report every list and every boolean as contested on
 * every concurrent write. Both sides are canonicalized to JSON, which also gives
 * order-sensitivity for the ordered collections for free — a reordered plan is a
 * different plan.
 */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") {
    // A column holding JSON text and a payload holding the parsed value are the
    // same value spelled twice. Parse when it parses; otherwise it is a string.
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return JSON.stringify(parsed);
    } catch {
      /* a plain string, which is the common case */
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return JSON.stringify(value ? 1 : 0);
  if (typeof value === "bigint") return JSON.stringify(Number(value));
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function encodeValue(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function decodeValue(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

/**
 * The conflict's identity, and why it is symmetric.
 *
 * Two devices hold mirrored views of one disagreement — A's local operation is
 * B's remote one. An id derived from `(local, remote)` in that order would
 * differ on the two machines, and a resolution emitted by one would then name a
 * row the other does not have. Sorting the pair makes both devices compute the
 * same id from the same two operations, which is what lets the decision
 * replicate at all.
 */
export function conflictId(
  entity: string,
  entityId: string,
  field: string,
  opIdA: string | null,
  opIdB: string | null,
): string {
  const pair = [opIdA ?? "", opIdB ?? ""].sort();
  return createHash("sha256")
    .update(`${entity}\n${entityId}\n${field}\n${pair[0]}\n${pair[1]}`)
    .digest("hex")
    .slice(0, 32);
}

// --------------------------------------------------------------- detection

interface LocalSide {
  readonly opId: string | null;
  readonly at: string | null;
  readonly baseValue: unknown;
}

/**
 * The fields written on this device since the version the sender claims.
 *
 * `base_version >= op.baseVersion` is the whole test: a write recorded as moving
 * the entity from version v to v+1, where v is at or after the version the remote
 * claimed as its base, is by definition a change the remote did not have.
 *
 * ## Why this reads `sync_field_writes` and not the outbox
 *
 * It used to read the outbox, and the outbox cannot answer this question. It is a
 * queue of what this device has to SEND, and the question is what this device
 * HOLDS. The two differ in both directions, and both are ordinary:
 *
 *   - **A relayed value was never in the outbox.** A device that APPLIED another
 *     device's `title` journaled nothing — that is obligation 4, and it is what
 *     stops two devices synchronizing forever — so it held a title somebody had
 *     chosen with no row anywhere saying so, and handed it to the next stale
 *     write to arrive. In silence, with no conflict on any record.
 *   - **The outbox is emptied.** `compact()` prunes acknowledged rows as routine,
 *     documented, safe housekeeping. The moment it ran, the device that AUTHORED
 *     the value stopped being able to defend it. **Detection that expires with
 *     housekeeping is not detection.**
 *
 * STA-260 hit both of these on ordered collections and closed them by dropping
 * this condition entirely, which is sound there and only there: a collection
 * replicates as ONE pseudo-field, so it has no disjoint field sets to protect.
 * A scalar entity does, and *"Disjoint field sets are not a conflict"* is a
 * guarantee — dropping the condition would make one device's `priority` edit
 * contest another's `estimate`. So the answer is not to ask less. It is to record
 * what `sync_applied` never did: which FIELDS an applied operation touched.
 * {@link recordFieldWrites} is where that happens, on both paths.
 *
 * Ordered ascending so the highest `base_version` for a canonical name is the one
 * that survives the loop. Two spellings of one field can both be present — the
 * table stores the payload key as sent — and `MAX` over them is the same `MAX`
 * this would take over one spelling.
 */
function localFieldWrites(
  db: DatabaseSync,
  entity: string,
  entityId: string,
  baseVersion: number,
): Map<string, LocalSide> {
  const rows = db
    .prepare(
      `SELECT field, op_id, written_at FROM sync_field_writes
        WHERE entity = ? AND entity_id = ? AND base_version >= ?
        ORDER BY base_version`,
    )
    .all(entity, entityId, baseVersion) as Array<{
    field: string;
    op_id: string | null;
    written_at: string;
  }>;

  const writes = new Map<string, LocalSide>();
  for (const row of rows) {
    const named = policy(entity, row.field);
    if (!named || named.bookkeeping || named.derivedFrom) continue;
    writes.set(named.name, { opId: row.op_id, at: row.written_at, baseValue: undefined });
  }
  return writes;
}

/**
 * The value the field held at the divergence point.
 *
 * The newest local operation BEFORE the remote's base version that named this
 * field wrote the value both devices then shared — the two histories are
 * identical up to that point, so the last write before it is the common
 * ancestor.
 *
 * Returns `undefined` when there is no such row, which happens once outbox
 * compaction has pruned it. That is a genuine gap and it is left visible rather
 * than filled with the local value, which would read as "they agreed and then
 * one of them changed it" when in fact nothing is known.
 */
function baseValueFor(
  db: DatabaseSync,
  entity: string,
  entityId: string,
  baseVersion: number,
  field: string,
): unknown {
  const rows = db
    .prepare(
      `SELECT payload FROM sync_outbox
        WHERE entity = ? AND entity_id = ? AND (base_version IS NULL OR base_version < ?)
        ORDER BY client_seq DESC`,
    )
    .all(entity, entityId, baseVersion) as Array<{ payload: string }>;

  for (const row of rows) {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    for (const [key, value] of Object.entries(payload)) {
      if (policy(entity, key)?.name === field) return value;
    }
  }
  return undefined;
}

/**
 * Screen a remote operation and return what may still be applied.
 *
 * Returns the input with every contested field — and every field derived from a
 * contested one — removed, or `null` when nothing contentful is left. The
 * conflicts are recorded as a side effect, in the caller's transaction, because
 * a conflict that was detected but not durably written would be a field silently
 * dropped, which is worse than the last-write-wins this replaces.
 */
export function screenForConflicts(
  db: DatabaseSync,
  op: RemoteOperation,
  localDeviceId: string | null,
): ApplyInput | null {
  // The same record the applier builds, so what a screened operation carries — its seq
  // above all, which settles claims on unique values (`claims.ts`) — cannot drift.
  const input: ApplyInput = operationToInput(op);

  /**
   * A device cannot disagree with itself.
   *
   * Own operations come back on the next pull — the push acknowledgement moves
   * the outbox, not the cursor — and they are replayed against a database that
   * has moved on since. Every one of them therefore looks "behind" and
   * intersects the very local operation that produced it. Screening them
   * reports a device's own sequential edits as a conflict with themselves: three
   * enqueues between two syncs came back as two conflicts on a plan nobody else
   * had touched.
   *
   * The value comparison below catches the last of such a run and nothing
   * earlier, which is exactly the shape of bug that looks fixed in a two-write
   * test. So the origin is checked first, and checked on the device id the
   * operation carries rather than on anything inferred.
   */
  if (localDeviceId !== null && op.deviceId === localDeviceId) return input;

  if (!screenable(op.verb) || op.baseVersion === null) return input;

  const version = entityVersion(db, op.entity, op.entityId);
  const kept =
    op.baseVersion >= version ? input : contest(db, op, op.baseVersion, localDeviceId);

  /**
   * Whatever survived is now a value this device holds, and it has to be
   * defensible tomorrow.
   *
   * This is the half of the fix the outbox could never provide. A relayed field
   * gets provenance here — the same provenance a locally authored one gets from
   * {@link Journal.flush} — so the two are indistinguishable to detection, which
   * is exactly right: the question is what this database holds, not who typed it.
   *
   * Recorded AFTER screening and BEFORE the version bump the caller does. After,
   * because a row written first would be found by the very screen that is running
   * and the operation would contest itself. Withheld fields are deliberately not
   * recorded: the incumbent still stands, and overwriting its provenance with the
   * op that lost to it would say the stale value is what this device holds.
   *
   * `max(version, op.baseVersion)` rather than `version` alone: the sender is
   * asserting it had seen `baseVersion` operations on this entity, and every
   * device counts the same events, so a value arriving from further ahead than
   * this device has counted is at least that current. Understating it would leave
   * the field defenceless against a write that is genuinely staler.
   */
  if (kept !== null) {
    recordFieldWrites(db, {
      entity: op.entity,
      entityId: op.entityId,
      fields: Object.keys(kept.payload),
      baseVersion: Math.max(version, op.baseVersion),
      opId: op.opId,
      deviceId: op.deviceId,
      at: op.createdAt,
    });
  }
  return kept;
}

/**
 * The screen proper: everything from here on knows the sender is behind.
 *
 * Split out so {@link screenForConflicts} has ONE place where a surviving
 * operation is recorded, rather than four early returns each of which would have
 * to remember to do it — a field that reached the row without leaving provenance
 * is the original bug wearing a different hat.
 */
function contest(
  db: DatabaseSync,
  op: RemoteOperation,
  baseVersion: number,
  localDeviceId: string | null,
): ApplyInput | null {
  const input: ApplyInput = {
    entity: op.entity,
    entityId: op.entityId,
    verb: op.verb,
    payload: op.payload,
    actor: op.actor === "" ? null : op.actor,
    deviceId: op.deviceId,
    at: op.createdAt,
    opId: op.opId,
  };

  /** Canonical field name -> the newest write of it this device holds. */
  const localWrites = localFieldWrites(db, op.entity, op.entityId, baseVersion);

  /**
   * An ordered collection is contested by the version comparison ALONE.
   *
   * For every other entity, condition (2) — "the field is named by a write this
   * device holds" — is what keeps *"Disjoint field sets are not a conflict"*
   * true: without it, one device's `priority` edit would contest another's
   * `estimate`. An ordered collection has no disjoint field sets to protect.
   * It replicates as ONE pseudo-field carrying the whole list, so any local
   * operation on it necessarily named that field, and condition (1) has already
   * proved a local operation happened — `baseVersion < version` means this
   * database has seen operations on this entity that the sender had not.
   * Consulting the field record therefore adds no information here.
   *
   * ## This branch is a floor, and it stays one
   *
   * STA-260 introduced it because the outbox could not name the incumbent in two
   * ordinary situations; `sync_field_writes` now can, so for a relayed or a
   * compacted order this branch is no longer what saves the plan — the ordinary
   * field record does, WITH an attribution, and the conflict id therefore
   * converges across the fleet where it previously could not.
   *
   * STA-263 closed the second of the two cases this branch was left standing for.
   * A device that bootstrapped from a snapshot used to hold values it had neither
   * authored nor relayed with no per-field provenance behind them; the fold now
   * carries it, so an inherited plan is defended by the ordinary field record,
   * WITH the operation id, exactly like a relayed one.
   *
   * It is still not dead, because one case cannot be reconstructed by anybody: a
   * database upgraded to 011 whose outbox had ALREADY been compacted has nothing
   * to backfill from. The evidence was destroyed before the table existed, and no
   * migration and no fold can bring it back.
   *
   * There, `localOpId` is `null`, the two ORDERS are still retained in full — and
   * it is the orders, not the operation ids, that a human is being asked to choose
   * between — and {@link settleOpenFor} is what closes a record whose id no other
   * device computes. That path is exercised by the "no provenance at all" case in
   * `test/cloud-scalar-conflict-evidence.test.ts`.
   */
  const wholeField = WHOLE[op.entity];
  if (wholeField !== undefined && !localWrites.has(wholeField)) {
    for (const key of Object.keys(op.payload)) {
      if (policy(op.entity, key)?.name !== wholeField) continue;
      localWrites.set(wholeField, { opId: null, at: null, baseValue: undefined });
      break;
    }
  }

  if (localWrites.size === 0) return input;

  const contested = new Set<string>();
  const detectedAt = nowIso();

  for (const [key, remoteValue] of Object.entries(op.payload)) {
    const named = policy(op.entity, key);
    if (!named || named.bookkeeping || named.derivedFrom) continue;
    const side = localWrites.get(named.name);
    if (!side) continue;

    const local = readField(db, op.entity, op.entityId, named.name);
    if (!local.present) continue;
    if (sameValue(local.value, remoteValue)) continue;

    contested.add(named.name);
    record(db, {
      id: conflictId(op.entity, op.entityId, named.name, side.opId, op.opId),
      entity: op.entity,
      entityId: op.entityId,
      field: named.name,
      baseValue: baseValueFor(db, op.entity, op.entityId, baseVersion, named.name),
      localValue: local.value,
      remoteValue,
      localOpId: side.opId,
      remoteOpId: op.opId,
      localDeviceId,
      remoteDeviceId: op.deviceId,
      localAt: side.at,
      remoteAt: op.createdAt,
      detectedAt,
    });
    if (named.name === wholeField) {
      keepEntries(
        db,
        conflictId(op.entity, op.entityId, named.name, side.opId, op.opId),
        heldEntries(db, op.entity, op.entityId),
        op.payload.entries,
      );
    }
  }

  if (contested.size === 0) return input;

  /**
   * A whole-plan pseudo-field contested means the operation carries nothing this
   * device may apply — an ordered collection is replaced entire or not at all.
   */
  if (wholeField !== undefined && contested.has(wholeField)) return null;

  const kept: Record<string, unknown> = {};
  let contentful = false;
  for (const [key, value] of Object.entries(op.payload)) {
    const named = policy(op.entity, key);
    // A field this build cannot place is passed through untouched: it cannot be
    // screened, and dropping it would delete a newer build's data.
    if (!named) {
      kept[key] = value;
      contentful = true;
      continue;
    }
    if (contested.has(named.name)) continue;
    if (named.derivedFrom && contested.has(named.derivedFrom)) continue;
    kept[key] = value;
    if (!named.bookkeeping) contentful = true;
  }

  return contentful ? { ...input, payload: kept } : null;
}

// ------------------------------------------------- the entries a plan record keeps

/**
 * Who added each entry of a plan or a milestone, when, and its note — keyed by issue id,
 * the shape its operations carry as `entries`.
 *
 * A record of a contested plan holds the two ORDERS, because the order is what somebody
 * is asked to choose between. The entries are not what is contested, but they are what a
 * resolution has to write back: resolved from the orders alone, "keep mine" put every
 * entry back without its note, on every device. So each side's entries are kept beside
 * the record, device-local in `meta` (`conflict_entries:<id>`), written when it is
 * detected and forgotten once it is closed.
 */
type Entries = Record<string, { addedBy: string; addedAt: string; note: string | null }>;

function entriesKey(conflictId: string): string {
  return `conflict_entries:${conflictId}`;
}

function heldEntries(db: DatabaseSync, entity: string, entityId: string): Entries {
  const rows = (
    entity === "queue"
      ? db.prepare("SELECT issue_id, added_by, added_at, note FROM queue_entries").all()
      : db.prepare("SELECT issue_id, added_by, added_at, note FROM milestone_members WHERE milestone_id = ?").all(entityId)
  ) as Array<{ issue_id: string; added_by: string; added_at: string; note: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.issue_id, { addedBy: row.added_by, addedAt: row.added_at, note: row.note }]));
}

function keepEntries(db: DatabaseSync, conflictId: string, local: Entries, remote: unknown): void {
  const theirs = remote !== null && typeof remote === "object" && !Array.isArray(remote) ? remote : {};
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").run(
    entriesKey(conflictId),
    JSON.stringify({ local, remote: theirs }),
  );
}

/** The entries a resolution to `chosen` writes: each chosen issue's, from the side chosen. */
function entriesFor(db: DatabaseSync, conflict: ConflictRecord, choice: ResolutionChoice, chosen: unknown): Entries | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(entriesKey(conflict.id)) as { value: string } | undefined;
  if (row === undefined || !Array.isArray(chosen)) return null;
  const kept = JSON.parse(row.value) as { local: Entries; remote: Entries };
  const from = choice === "local" ? kept.local : choice === "remote" ? kept.remote : { ...kept.remote, ...kept.local };
  const picked: Entries = {};
  for (const id of chosen) {
    if (typeof id === "string" && from[id] !== undefined) picked[id] = from[id]!;
  }
  return picked;
}

/** Forget the entries of every record that is closed now. */
function forgetClosedEntries(db: DatabaseSync): void {
  db.prepare(
    `DELETE FROM meta WHERE key LIKE 'conflict_entries:%'
       AND substr(key, 18) IN (SELECT id FROM sync_conflicts WHERE resolved_at IS NOT NULL)`,
  ).run();
}

// ------------------------------------------- a snapshot re-read on this timeline

/**
 * A snapshot entity, less every value a record on this device is still open about.
 *
 * A device re-reading the snapshot of the timeline it is already on — the applier
 * catch-up, or the recovery of a stuck tail (`sync.ts`) — is handed the fold, and the fold
 * holds the last write of every value: for anything contested here, the other side.
 * Applied as it came, it replaced the value this device holds while the record went on
 * asking which of the two to keep; resolving it "local" then wrote back a value the
 * device no longer had. So what an open record is about is withheld from the re-read,
 * exactly as the screen withholds it from an operation: a field on its own, or a plan or
 * a milestone's members whole. `keeps` answers for the provenance the entity carries.
 */
export function withoutOpenContests(
  db: DatabaseSync,
  input: ApplyInput,
): { input: ApplyInput | null; keeps: (key: string) => boolean } {
  const contested = new Set(
    (
      db
        .prepare("SELECT field FROM sync_conflicts WHERE entity = ? AND entity_id = ? AND resolved_at IS NULL")
        .all(input.entity, input.entityId) as Array<{ field: string }>
    ).map((row) => row.field),
  );
  if (contested.size === 0) return { input, keeps: () => true };
  const whole = WHOLE[input.entity];
  if (whole !== undefined && contested.has(whole)) return { input: null, keeps: () => false };
  const keeps = (key: string): boolean => {
    const named = policy(input.entity, key);
    if (!named) return true;
    return !contested.has(named.name) && !(named.derivedFrom !== undefined && contested.has(named.derivedFrom));
  };
  const payload = Object.fromEntries(Object.entries(input.payload).filter(([key]) => keeps(key)));
  return { input: { ...input, payload }, keeps };
}

function entityVersion(db: DatabaseSync, entity: string, entityId: string): number {
  const row = db
    .prepare("SELECT version FROM sync_entity_versions WHERE entity = ? AND entity_id = ?")
    .get(entity, entityId) as { version: number } | undefined;
  return row?.version ?? 0;
}

interface NewConflict {
  readonly id: string;
  readonly entity: string;
  readonly entityId: string;
  readonly field: string;
  readonly baseValue: unknown;
  readonly localValue: unknown;
  readonly remoteValue: unknown;
  readonly localOpId: string | null;
  readonly remoteOpId: string | null;
  readonly localDeviceId: string | null;
  readonly remoteDeviceId: string | null;
  readonly localAt: string | null;
  readonly remoteAt: string | null;
  readonly detectedAt: string;
}

/**
 * Write the record, once.
 *
 * `DO NOTHING` rather than `DO UPDATE`: the id is a function of the two
 * operations, so a second insert is the same disagreement seen again — a
 * re-delivered page, or the same pair reaching this device by another route —
 * and the first detection is the true one. Re-detecting must not move
 * `detected_at`, and must certainly not reopen something already resolved.
 */
function record(db: DatabaseSync, conflict: NewConflict): void {
  db.prepare(
    `INSERT INTO sync_conflicts
       (id, entity, entity_id, field, base_value, local_value, remote_value,
        local_op_id, remote_op_id, local_device_id, remote_device_id,
        local_at, remote_at, detected_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO NOTHING`,
  ).run(
    conflict.id,
    conflict.entity,
    conflict.entityId,
    conflict.field,
    encodeValue(conflict.baseValue),
    encodeValue(conflict.localValue),
    encodeValue(conflict.remoteValue),
    conflict.localOpId,
    conflict.remoteOpId,
    conflict.localDeviceId,
    conflict.remoteDeviceId,
    conflict.localAt,
    conflict.remoteAt,
    conflict.detectedAt,
  );
}

// ------------------------------------------------------------------- reads

interface ConflictRow {
  id: string;
  entity: string;
  entity_id: string;
  field: string;
  base_value: string | null;
  local_value: string | null;
  remote_value: string | null;
  local_op_id: string | null;
  remote_op_id: string | null;
  local_device_id: string | null;
  remote_device_id: string | null;
  local_at: string | null;
  remote_at: string | null;
  detected_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
  resolution: string | null;
}

const SELECT_CONFLICT = `SELECT id, entity, entity_id, field, base_value, local_value, remote_value,
       local_op_id, remote_op_id, local_device_id, remote_device_id, local_at, remote_at,
       detected_at, resolved_at, resolved_by, resolution
  FROM sync_conflicts`;

function view(row: ConflictRow): ConflictRecord {
  const localValue = decodeValue(row.local_value);
  const remoteValue = decodeValue(row.remote_value);
  const resolvedValue = row.resolved_at === null ? undefined : decodeValue(row.resolution);
  const resolvedChoice: ResolutionChoice | null =
    row.resolved_at === null
      ? null
      : sameValue(resolvedValue, localValue)
        ? "local"
        : sameValue(resolvedValue, remoteValue)
          ? "remote"
          : "custom";

  return {
    id: row.id,
    entity: row.entity,
    entityId: row.entity_id,
    field: row.field,
    baseValue: decodeValue(row.base_value),
    localValue,
    remoteValue,
    localOpId: row.local_op_id,
    remoteOpId: row.remote_op_id,
    localDeviceId: row.local_device_id,
    remoteDeviceId: row.remote_device_id,
    localAt: row.local_at,
    remoteAt: row.remote_at,
    detectedAt: row.detected_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
    resolvedValue,
    resolvedChoice,
  };
}

/** Open conflicts, oldest first. Pass `includeResolved` for the audit trail. */
export function listConflicts(
  db: DatabaseSync,
  options: { includeResolved?: boolean } = {},
): ConflictRecord[] {
  const where = options.includeResolved ? "" : " WHERE resolved_at IS NULL";
  const rows = db
    .prepare(`${SELECT_CONFLICT}${where} ORDER BY detected_at, id`)
    .all() as unknown as ConflictRow[];
  return rows.map(view);
}

export function getConflict(db: DatabaseSync, id: string): ConflictRecord | null {
  const row = db.prepare(`${SELECT_CONFLICT} WHERE id = ?`).get(id) as ConflictRow | undefined;
  return row === undefined ? null : view(row);
}

export function countOpenConflicts(db: DatabaseSync): number {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM sync_conflicts WHERE resolved_at IS NULL").get() as {
      n: number;
    }
  ).n;
}

// -------------------------------------------------------------- resolution

/**
 * The verb a resolution emits for an entity.
 *
 * An ordered collection is replaced whole because that is the only shape it
 * replicates in; an identifier is a `renumber` because that is what the change
 * is, and a receiver that treats it as an ordinary update would be right by
 * accident rather than by contract.
 */
function resolutionVerb(entity: string, field: string): SyncVerb {
  if (WHOLE[entity] === field) return "replace";
  if (entity === "issue" && field === "identifier") return "renumber";
  return "update";
}

/**
 * Settle a conflict by choosing a value, on the record.
 *
 * The whole of the ticket's bar is in the ordering here:
 *
 *   1. Already resolved identically -> no-op. Resolving twice is not two
 *      decisions and must not emit two operations.
 *   2. Already resolved differently -> refused. A resolution is not overwritten
 *      by a later opinion; disagreeing with one is a new decision about the
 *      current value, which is an ordinary edit and conflicts as one.
 *   3. The domain write goes through `applyToDatabase`, so a resolution writes
 *      rows by exactly the rule an applied operation does, for every entity,
 *      with no second implementation to drift.
 *   4. Both the domain change and the decision are journaled inside ONE scope,
 *      so they are one transaction and two operations — a NEW pair, carrying a
 *      `baseVersion` the seam allocates fresh. Neither of the operations that
 *      disagreed is touched. History is appended to.
 */
export function resolveConflict(db: DatabaseSync, request: ResolveRequest): ResolveOutcome {
  const outcome = decide(db, request);
  // A settled identifier moved an issue; this machine's hub cross-links follow it.
  if (outcome.renumbered.length > 0 || (outcome.changed && outcome.conflict.field === "identifier")) {
    carryIdentifierMovesToHub(db, stapleHome());
  }
  return outcome;
}

function decide(db: DatabaseSync, request: ResolveRequest): ResolveOutcome {
  const journal = journalFor(db);

  return journal.run(() => {
    const conflict = getConflict(db, request.id);
    if (conflict === null) {
      throw new StapleError("not_found", `No conflict "${request.id}".`);
    }

    const chosen = chooseValue(conflict, request);

    if (conflict.resolvedAt !== null) {
      if (sameValue(conflict.resolvedValue, chosen)) {
        return { conflict, changed: false, renumbered: [] };
      }
      throw new StapleError(
        "conflict",
        `Conflict ${conflict.id} was already resolved by ${conflict.resolvedBy ?? "someone"} at ` +
          `${conflict.resolvedAt}. A resolution is not overturned in place — edit the field if you ` +
          `want it to say something else, and that edit is on the record as its own decision.`,
      );
    }

    const renumbered = freeIdentifier(db, conflict, chosen);
    const actor = request.actor ?? null;
    const at = nowIso();
    const verb = resolutionVerb(conflict.entity, conflict.field);

    /**
     * Every write the decision implies, as one list.
     *
     * For an ordinary field that is one write. For an identifier it is TWO, and
     * the second is the reason this is a list rather than a value: the deciding
     * device may already hold the losing issue at the right number, so locally
     * that write is a no-op — but the device in the mirror-image state does not,
     * and a decision that only journaled what happened to change HERE would
     * arrive there as half a swap. The assignment is stated in full so that any
     * device reaches the same allocation from any starting point.
     */
    const writes: Array<{ entityId: string; value: unknown }> = [
      { entityId: conflict.entityId, value: chosen },
    ];
    for (const assignment of otherIdentifierAssignment(db, conflict, chosen, renumbered)) {
      writes.push(assignment);
    }

    // A plan or a milestone's members go back with each entry's author, time and note.
    const entries = WHOLE[conflict.entity] === conflict.field ? entriesFor(db, conflict, request.choice, chosen) : null;
    for (const write of writes) {
      const payload: Record<string, unknown> = { [conflict.field]: write.value };
      if (entries !== null) payload.entries = entries;
      applyToDatabase(db, {
        entity: conflict.entity,
        entityId: write.entityId,
        verb,
        payload,
        actor,
        deviceId: null,
        at,
        opId: null,
      });
      journal.record({
        entity: conflict.entity as SyncEntity,
        entityId: write.entityId,
        verb,
        payload,
        actor,
      });
    }

    close(db, conflict.id, at, actor, chosen);
    settleOpenFor(db, conflict.entity, conflict.entityId, conflict.field, at, actor, chosen);
    forgetClosedEntries(db);

    /**
     * The decision replicates as its own operation so that every other device
     * closes the SAME record rather than merely observing the field settle. It
     * carries the value and not the side: "remote" is a label relative to the
     * device that used it, and the other machine's remote is its local.
     */
    journal.record({
      entity: "conflict",
      entityId: conflict.id,
      verb: "update",
      payload: {
        resolvedAt: at,
        resolvedBy: actor,
        value: chosen,
        entity: conflict.entity,
        targetId: conflict.entityId,
        field: conflict.field,
      },
      actor,
    });

    return { conflict: getConflict(db, conflict.id)!, changed: true, renumbered };
  });
}

function chooseValue(conflict: ConflictRecord, request: ResolveRequest): unknown {
  if (request.choice === "local") return conflict.localValue;
  if (request.choice === "remote") return conflict.remoteValue;
  if (request.value === undefined) {
    throw new StapleError(
      "validation",
      `A custom resolution needs the value to resolve to. Pass one, or choose "local" ` +
        `(${JSON.stringify(conflict.localValue)}) or "remote" (${JSON.stringify(conflict.remoteValue)}).`,
    );
  }
  return request.value;
}

function close(
  db: DatabaseSync,
  id: string,
  at: string,
  actor: string | null,
  value: unknown,
): void {
  db.prepare(
    "UPDATE sync_conflicts SET resolved_at = ?, resolved_by = ?, resolution = ? WHERE id = ?",
  ).run(at, actor, JSON.stringify(value ?? null), id);
}

/**
 * A decision about a field settles every OPEN record about that same field here.
 *
 * A conflict id is a function of the two operation ids, sorted, so that two
 * devices holding mirrored views of one disagreement compute the same id and a
 * resolution emitted by either closes the record on both. That derivation needs
 * both ids, and there is one case where this device cannot supply its own: an
 * ordered collection whose incumbent order was APPLIED rather than authored
 * here, or authored here and then compacted out of the outbox. Those records are
 * real — they retain both orders, which is the point — but their id is derived
 * from `(null, remote)` and no other device computes it.
 *
 * Without this, such a record would outlive its own resolution: the field
 * settles, every device converges, and this one still reports an open conflict
 * about a plan that was decided. That is a false alarm, and a false alarm about
 * the exact mechanism that exists to be trusted is expensive.
 *
 * So the rule is stated on the FIELD rather than on the record id: once someone
 * has decided what this collection holds, no record on this device may still
 * claim it is undecided. Nothing is discarded — the row keeps both values, and
 * now names the value chosen and who chose it, which is the audit shape the
 * contract asks for. Records already closed are untouched, including ones closed
 * to a different value, exactly as before: *"a resolution is not overwritten by
 * a later opinion"*.
 */
function settleOpenFor(
  db: DatabaseSync,
  entity: string,
  entityId: string,
  field: string,
  at: string,
  actor: string | null,
  value: unknown,
): void {
  db.prepare(
    `UPDATE sync_conflicts SET resolved_at = ?, resolved_by = ?, resolution = ?
      WHERE entity = ? AND entity_id = ? AND field = ? AND resolved_at IS NULL`,
  ).run(at, actor, JSON.stringify(value ?? null), entity, entityId, field);
}

/**
 * Where the identifier that was NOT chosen ends up.
 *
 * Only identifiers have a second half: the two values in the conflict are two
 * numbers in one `UNIQUE` namespace, so settling which issue owns one settles
 * which issue owns the other. If the incumbent was moved, that is the answer; if
 * it was not, the answer is whichever issue is already sitting on the losing
 * value, and saying so out loud is what makes the decision portable to a device
 * whose issues are the other way round.
 */
function otherIdentifierAssignment(
  db: DatabaseSync,
  conflict: ConflictRecord,
  chosen: unknown,
  renumbered: readonly Renumbering[],
): Array<{ entityId: string; value: unknown }> {
  if (conflict.entity !== "issue" || conflict.field !== "identifier") return [];
  if (renumbered.length > 0) {
    return renumbered.map((move) => ({ entityId: move.issueId, value: move.to }));
  }

  const other = sameValue(chosen, conflict.localValue) ? conflict.remoteValue : conflict.localValue;
  if (typeof other !== "string") return [];
  const holder = db.prepare("SELECT id FROM issues WHERE identifier = ?").get(other) as
    | { id: string }
    | undefined;
  if (holder === undefined || holder.id === conflict.entityId) return [];
  return [{ entityId: holder.id, value: other }];
}

/**
 * Make room for a chosen identifier by moving whoever currently holds it.
 *
 * `issues.identifier` carries a `UNIQUE` index, so "give this issue that number"
 * is only expressible if the incumbent gives it up. Doing that silently would be
 * the same sin this module exists to remove, so the move is journaled as its own
 * `renumber` operation and reported back to the caller for every surface to
 * show. The replacement is found by suffixing rather than by allocating, for the
 * same reason the applier does it: `meta.next_issue_number` never synchronizes,
 * so two devices consulting their own counters would diverge a second time.
 */
function freeIdentifier(
  db: DatabaseSync,
  conflict: ConflictRecord,
  chosen: unknown,
): Renumbering[] {
  if (conflict.entity !== "issue" || conflict.field !== "identifier") return [];
  if (typeof chosen !== "string") return [];

  const holder = db.prepare("SELECT id FROM issues WHERE identifier = ?").get(chosen) as
    | { id: string }
    | undefined;
  if (holder === undefined || holder.id === conflict.entityId) return [];

  let replacement: string | null = null;
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${chosen}+${n}`;
    const taken = db.prepare("SELECT 1 AS hit FROM issues WHERE identifier = ?").get(candidate);
    if (taken === undefined) {
      replacement = candidate;
      break;
    }
  }
  if (replacement === null) {
    throw new StapleError("conflict", `Could not find a free identifier near ${chosen}.`);
  }

  /**
   * The row moves here so the chosen value is free by the time it is written;
   * the OPERATION for the move is journaled by the caller's assignment loop,
   * which states the whole allocation in one place.
   */
  moveIdentifier(db, holder.id, replacement);
  return [{ issueId: holder.id, from: chosen, to: replacement }];
}

// ----------------------------------------------- applying somebody's decision

/**
 * Apply a `conflict` operation: another device settled something.
 *
 * Idempotent, and deliberately narrow. It closes an OPEN record and applies the
 * chosen value; a record already closed to the same value is a re-delivery and a
 * no-op; a record already closed to a DIFFERENT value is left exactly as it is.
 *
 * That last case looks like a silent winner and is not one. Two devices
 * resolving the same conflict differently also emit two ordinary domain
 * operations for the field, and those meet each other in
 * {@link screenForConflicts} and produce a fresh conflict — with the same id on
 * both machines, because the id is symmetric. The live disagreement is therefore
 * on the record everywhere, identically, and what the historical row says about
 * which decision reached which machine first is history rather than state.
 *
 * The conflict may be unknown here: a device that bootstrapped after the
 * disagreement never detected it. Recording a stranger's conflict from a
 * resolution would be recording a settled argument as an open one, so the
 * decision's effect is applied and nothing is opened.
 */
export function applyConflictOperation(db: DatabaseSync, op: RemoteOperation): boolean {
  const { payload } = op;
  const entity = typeof payload.entity === "string" ? payload.entity : null;
  const targetId = typeof payload.targetId === "string" ? payload.targetId : null;
  const field = typeof payload.field === "string" ? payload.field : null;
  if (entity === null || targetId === null || field === null) return false;

  const value = payload.value;
  const at = typeof payload.resolvedAt === "string" ? payload.resolvedAt : op.createdAt;
  const resolvedBy = typeof payload.resolvedBy === "string" ? payload.resolvedBy : op.actor || null;

  const existing = getConflict(db, op.entityId);
  if (existing !== null && existing.resolvedAt !== null) return false;

  const current = readField(db, entity, targetId, field);
  if (current.present && !sameValue(current.value, value)) {
    applyToDatabase(db, {
      entity,
      entityId: targetId,
      verb: resolutionVerb(entity, field),
      payload: { [field]: value },
      actor: op.actor === "" ? null : op.actor,
      deviceId: op.deviceId,
      at,
      opId: op.opId,
    });
  }

  if (existing !== null) close(db, op.entityId, at, resolvedBy, value);
  /**
   * And any record this device opened about the same field, whose id the
   * deciding device could not have named — see {@link settleOpenFor}.
   */
  settleOpenFor(db, entity, targetId, field, at, resolvedBy, value);
  forgetClosedEntries(db);
  return true;
}

/** Exported for the surfaces, which all render the same summary line. */
export function conflictsSummary(db: DatabaseSync): { open: number; resolved: number } {
  const row = db
    .prepare(
      `SELECT SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open,
              SUM(CASE WHEN resolved_at IS NULL THEN 0 ELSE 1 END) AS resolved
         FROM sync_conflicts`,
    )
    .get() as { open: number | null; resolved: number | null };
  return { open: row.open ?? 0, resolved: row.resolved ?? 0 };
}
