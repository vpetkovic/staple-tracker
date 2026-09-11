/**
 * The journal seam — the one place a repository mutation becomes a replicable
 * operation.
 *
 * Contract: `docs/sync.md`, "The journal seam and what it owes". That section
 * states seven obligations; this file is where six of them are enforced and the
 * seventh (nothing outside the boundary) is enforced by omission — migrations,
 * snapshots and the hub never call in here.
 *
 * ## There was no seam to hook
 *
 * The mutation inventory found 45 functions running 52 independent
 * `db.prepare(<literal>).run()` sites with nothing between `WorkspaceStore` and
 * `node:sqlite`. So this is not interception. Each logical mutation *declares*
 * what it did, once, and the declaration is what replicates.
 *
 * Declaring beats deriving. A derived seam would have to guess that
 * `checkoutIssue`'s two `UPDATE issues` statements, its event and its ancestor
 * re-derivation are one operation and not four, and it would guess again every
 * time somebody added a statement. A declared intent says `issue.update` on one
 * row, and a new statement inside the same mutation changes nothing.
 *
 * ## Why intents buffer and flush at the end of the scope
 *
 * A mutation touches its rows in whatever order reads it. Buffering means the
 * outbox row is written once, after the mutation has finished deciding what it
 * did, with the merged payload — which is what "one logical mutation journals
 * one envelope, not one per table touched" requires. The flush happens INSIDE
 * the transaction, before the commit, so a throw at any point rolls the domain
 * rows and the outbox row back together and there is no window in which one
 * exists without the other.
 *
 * ## Disarmed by default, and that is the whole privacy posture
 *
 * Journalling requires both a repository identity in `sync_state` and a device
 * id. The device id is machine-local by contract and lives in the staple home,
 * written only by `staple cloud connect` — so {@link resolveDeviceId} returns
 * null on a machine that has never connected, and an unconnected workspace
 * journals nothing at all: no outbox rows, no version rows, no observable
 * difference from the build before this one. The seam still runs, so the scope
 * discipline and the event dedup keys are exercised on every machine; only the
 * recording is withheld.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../config/home.js";
import { connectionPath } from "./cloud/connection.js";
import { readDeviceId } from "./cloud/device.js";
import { cloudError } from "./cloud/errors.js";
import { armRowCapture, ensureRowCapture, takeRowChanges, type RowChange } from "./cloud/row-diff.js";
import { tx } from "./db.js";
import { normalizeTitle, nowIso } from "./types.js";

/**
 * The issue fields derived from others (`DERIVED_ISSUE_FIELDS` in `cloud/apply.ts`, which
 * this module cannot import at load time without a cycle through the applier).
 */
const DERIVED_FIELDS: ReadonlySet<string> = new Set(["normalizedTitle", "depth"]);
/** Both spellings, for provenance a snapshot or an older build's operation names by column. */
const DERIVED_ISSUE_KEYS: ReadonlySet<string> = new Set([...DERIVED_FIELDS, "normalized_title"]);

/** Every entity an operation can name. Closed set — see docs/sync.md. */
export const SYNC_ENTITIES = [
  "issue",
  "comment",
  "document",
  "documentRevision",
  "relation",
  "project",
  "status",
  "kind",
  "setting",
  "milestone",
  "queue",
  "lease",
  "conflict",
] as const;
export type SyncEntity = (typeof SYNC_ENTITIES)[number];

/** `replace` is for ordered collections, `renumber` for issues. */
export const SYNC_VERBS = ["create", "update", "delete", "replace", "renumber"] as const;
export type SyncVerb = (typeof SYNC_VERBS)[number];

/** The wire and outbox shape. One shape for every mutation. */
export interface OperationEnvelope {
  readonly opId: string;
  readonly repoId: string;
  readonly protocol: number;
  readonly schema: number;
  readonly entity: SyncEntity;
  readonly entityId: string;
  readonly verb: SyncVerb;
  readonly baseVersion: number | null;
  readonly payload: Record<string, unknown>;
  readonly deviceId: string;
  readonly actor: string | null;
  readonly clientSeq: number;
  readonly createdAt: string;
}

/** What a mutation declares. The seam supplies everything else. */
export interface JournalIntent {
  readonly entity: SyncEntity;
  readonly entityId: string;
  readonly verb: SyncVerb;
  readonly payload?: Record<string, unknown>;
  readonly actor?: string | null;
}

/**
 * One seeded operation: an entity's current state, journaled because the service
 * does not hold it yet. See {@link Journal.seed}.
 */
export interface SeedIntent {
  readonly entity: SyncEntity;
  readonly entityId: string;
  readonly verb: SyncVerb;
  readonly payload: Record<string, unknown>;
  readonly actor: string | null;
  /**
   * The operation's `createdAt`. A receiver falls back to it for every time column the
   * payload does not carry (`apply.ts` says so on {@link ApplyInput.at}), so a seed
   * stamps each operation with the time its state was written rather than with the
   * moment it was seeded.
   */
  readonly at: string;
  /** How many operations the service already holds for this entity; 0 for a new one. */
  readonly serviceVersion: number;
}

/**
 * The largest payload one operation may carry: the Worker's `MAX_OP_BYTES`
 * (`worker/src/limits.ts`), which is the same on every plan. The journal refuses above
 * it; the push re-checks against the value the service actually advertises.
 */
export const JOURNAL_MAX_OP_BYTES = 512 * 1024;

/** The protocol this build speaks. */
export const SYNC_PROTOCOL = 1;

/**
 * Derive the operation id.
 *
 * `sha256(repoId + "\n" + epoch + "\n" + deviceId + "\n" + clientSeq)`, first 32
 * hex characters. Deterministic, never random: a retried push regenerates
 * byte-identical ids and the server's uniqueness check absorbs it. A random id
 * cannot be deduplicated after a lost acknowledgement, which is the one failure
 * the whole scheme exists to survive.
 *
 * The epoch is in the derivation because ids are epoch-scoped exactly as
 * cursors are. Without it a device that re-bootstraps after a restore re-mints
 * ids that collide with operations still in the log — epoch bumps do not
 * truncate, so the originals are definitely still there — and it collides in
 * precisely the path the epoch mechanism exists to make safe.
 */
export function deriveOpId(
  repoId: string,
  epoch: number,
  deviceId: string,
  clientSeq: number,
): string {
  return createHash("sha256")
    .update(`${repoId}\n${epoch}\n${deviceId}\n${clientSeq}`)
    .digest("hex")
    .slice(0, 32);
}

/**
 * This device's identity, or null when there is none.
 *
 * ## What arms the seam, now that machine config exists
 *
 * The device id lives in the staple home, beside the connection records, and is
 * written by exactly one thing: `staple cloud connect`, through
 * {@link ensureDeviceId}. {@link readDeviceId} **never mints** — it returns null
 * when the file is absent — which is what keeps the disarmed property intact:
 * a machine that has never connected anything has no file, so every workspace on
 * it journals nothing, and the observable behaviour is byte-identical to the
 * build before the seam landed.
 *
 * Two independent conditions have to hold before a single outbox row is written,
 * and neither implies the other:
 *
 *   1. this machine has a device id — only `connect` creates one
 *   2. `sync_state.repository_id` is set — {@link Journal.armed} checks it
 *
 * A repo-local workspace on a machine that has never connected journals nothing. A
 * workspace on a machine that has connected SOME repository journals from then on,
 * whether or not its own repository is connected — every workspace with an identity has
 * a `sync_state.repository_id`. That is harmless for privacy, because nothing leaves
 * without its own connection, and harmless for correctness, because the first sync of
 * a repository replaces any journal it made before joining with a seed of its current
 * state (`cloud/seed.ts`). It is also what makes a disconnect safe: edits made while
 * disconnected are journaled and go on the next sync.
 *
 * ## Why the environment still wins
 *
 * `STAPLE_DEVICE_ID` is read first. Tests need to arm the seam without writing to
 * a real home, and an operator running under a container-managed identity needs a
 * way to say so. It is an override, not a fallback: a value in the environment is
 * an explicit statement about which device this is.
 *
 * Reading the home is wrapped because {@link stapleHome} refuses a home it cannot
 * resolve. A workspace whose home is misconfigured must still be fully usable —
 * that is a cloud problem, and this function is called on every ordinary command
 * path — so an unresolvable home reads as "no device", which is the disarmed
 * state and the safe one.
 */
export function resolveDeviceId(): string | null {
  const override = process.env.STAPLE_DEVICE_ID?.trim();
  if (override) return override;
  try {
    return readDeviceId(stapleHome());
  } catch {
    return null;
  }
}

/**
 * Every payload key in one spelling: camelCase, the field name.
 *
 * The seam's callers wrote some fields by field name (`updatedAt`) and some by column
 * (`updated_at` — `updateIssue` journals the changed columns as they are), and the
 * service's fold keeps each key it is sent. So one entity's state held both spellings of
 * one field, a device hydrating applied them in key order, and after a vocabulary migration
 * the stale one won on every fresh device while the tail held the new one. The fold and the
 * snapshot applier now treat the two as one field (`worker/src/fold.ts`, `snapshotToInput`);
 * this is the other half: nothing new is sent in two spellings. Top-level keys only — a
 * nested value (a plan's `entries`) is data, keyed by ids.
 */
export function oneSpelling(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    out[key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())] = value;
  }
  return out;
}

interface SyncStateRow {
  repository_id: string | null;
  epoch: number;
  cursor: string | null;
}

/**
 * One mutation's worth of declarations.
 *
 * `token` is what event dedup keys are derived from. For a locally originated
 * mutation it is a fresh uuid — every event in the scope gets a stable key, and
 * two structurally identical mutations still get different ones, which is right
 * because they are different events. For an applied remote operation it is the
 * `opId`, so a redelivered operation re-derives the same keys and the partial
 * unique index on `events.dedup_key` absorbs the second insert.
 */
class JournalScope {
  readonly intents = new Map<string, JournalIntent & { payload: Record<string, unknown> }>();
  private eventOrdinal = 0;

  constructor(
    readonly token: string,
    /** True while applying a pulled operation: declare nothing outbound. */
    readonly suppressed: boolean,
  ) {}

  nextEventKey(kind: string): string {
    this.eventOrdinal += 1;
    return createHash("sha256")
      .update(`${this.token}\n${kind}\n${this.eventOrdinal}`)
      .digest("hex")
      .slice(0, 32);
  }
}

/**
 * Merge a new declaration into one already made for the same entity.
 *
 * A mutation can touch one entity more than once — `approveGate` updates the
 * same issue's gate state and then its status — and that is still one
 * operation. Verb precedence is delete > create > update: a create followed by
 * an update is a create carrying the update's fields, and anything followed by a
 * delete is a delete, because nothing before it can be observed afterwards.
 */
function mergeVerb(existing: SyncVerb, incoming: SyncVerb): SyncVerb {
  if (existing === "delete" || incoming === "delete") return "delete";
  if (existing === "create") return "create";
  return incoming;
}

export interface CompactionResult {
  /** Acknowledged outbox rows removed. */
  readonly outboxPruned: number;
  /** Applied-ledger rows removed. */
  readonly appliedPruned: number;
  /** Field-write provenance removed, for tombstoned entities only. */
  readonly fieldWritesPruned: number;
}

/** One entity's fields, written by whichever device made the write. */
export interface FieldWriteRecord {
  readonly entity: string;
  readonly entityId: string;
  readonly fields: readonly string[];
  /** The entity version this write moved OFF — `sync_outbox.base_version`. */
  readonly baseVersion: number;
  readonly opId: string | null;
  readonly deviceId: string | null;
  readonly at: string;
}

/**
 * Record who last wrote which fields of which entity, and at what version.
 *
 * The evidence conflict detection runs on, and the reason it is here rather than
 * beside the detection: **both** paths that can change a field have to leave it.
 * A locally journaled mutation writes it in {@link Journal.flush}; an applied
 * remote operation writes it from the apply path, which is what closes the relay
 * hole — a device that applied another device's `title` had no record it held a
 * `title` anybody had chosen, and handed it over to the next stale write in
 * silence.
 *
 * Only the newest write per field is kept. That is not a compromise for space:
 * detection asks whether *any* write of this field happened at
 * `base_version >= X`, and since `base_version` rises with every operation on the
 * entity, the newest write answers that question exactly. Keeping only it is what
 * bounds the table by live data rather than by history — and a table that never
 * grows with history is a table nothing has to prune on a timer, which is the
 * whole point. The outbox failed here because it is a queue, and a queue is
 * emptied.
 *
 * The `WHERE` on the upsert is a monotonicity guard: operations can arrive out of
 * order (a deferred referent, a replayed page), and an older write must never
 * rewind a newer one's version. `>=` rather than `>` so that a re-delivery of the
 * newest write refreshes its attribution rather than being ignored.
 */
export function recordFieldWrites(db: DatabaseSync, record: FieldWriteRecord): void {
  // A derived column is nobody's write, on every path that records one (`docs/sync.md`, "Derived columns").
  const fields = record.entity === "issue" ? record.fields.filter((field) => !DERIVED_ISSUE_KEYS.has(field)) : record.fields;
  if (fields.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO sync_field_writes
       (entity, entity_id, field, base_version, op_id, device_id, written_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity, entity_id, field) DO UPDATE SET
       base_version = excluded.base_version,
       op_id        = excluded.op_id,
       device_id    = excluded.device_id,
       written_at   = excluded.written_at
      WHERE excluded.base_version >= sync_field_writes.base_version`,
  );
  for (const field of fields) {
    insert.run(
      record.entity,
      record.entityId,
      field,
      record.baseVersion,
      record.opId,
      record.deviceId,
      record.at,
    );
  }
}

/** One inherited field write, as the snapshot fold computed it. */
export interface InheritedFieldWrite {
  /** The payload key as the operation spelled it, which is what `field` stores. */
  readonly field: string;
  /** The entity version that write moved off. */
  readonly baseVersion: number;
  readonly opId: string;
  readonly at: string;
}

/**
 * Record the provenance a hydrating device INHERITED with a snapshot entity (STA-263).
 *
 * The third writer of this table, and the one that closes the last hole in it. A device
 * that bootstrapped held values it had neither authored nor relayed, so it could not
 * answer *"have I written this field since the version you claim?"* for any of them and
 * handed the next stale write whatever it asked for, in silence.
 *
 * Separate from {@link recordFieldWrites} for one reason and it is not cosmetic: those
 * writers record a set of fields that share ONE base version, because they are recording
 * one operation. These rows come from different operations spread across the whole log
 * and each carries its own — which is exactly what stops a snapshot from claiming every
 * field was written at the snapshot's version, the mistake that would contest a `medium`
 * nobody chose. Collapsing the two functions would mean collapsing that distinction.
 *
 * `device_id` is stored NULL. The server's fold does not carry it — nothing reads it,
 * and migration 011's own backfill leaves it null for the same reason — while `op_id`
 * IS carried, so a hydrated device names the operation it is defending and reaches the
 * same conflict id as the device that authored it.
 */
export function recordInheritedFieldWrites(
  db: DatabaseSync,
  entity: string,
  entityId: string,
  writes: readonly InheritedFieldWrite[],
  priorVersion: number,
): void {
  if (entity === "issue") writes = writes.filter((write) => !DERIVED_ISSUE_KEYS.has(write.field));
  if (writes.length === 0) return;
  const insert = db.prepare(
    `INSERT INTO sync_field_writes
       (entity, entity_id, field, base_version, op_id, device_id, written_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT (entity, entity_id, field) DO UPDATE SET
       base_version = excluded.base_version,
       op_id        = excluded.op_id,
       device_id    = excluded.device_id,
       written_at   = excluded.written_at
      WHERE excluded.base_version >= sync_field_writes.base_version`,
  );
  for (const write of writes) {
    /**
     * `max(priorVersion, …)`, and `priorVersion` is the entity version this device
     * held BEFORE the snapshot set it — never the version the snapshot reports.
     *
     * On a first bootstrap there is no prior version, so this is the fold's own
     * per-field number, untouched, and the distinction between a field somebody set
     * and one that arrived carrying its default survives intact. Reading the version
     * AFTER `setEntityVersion` would flatten every field to the entity's version and
     * throw that distinction away — which is the trap this whole ticket exists to
     * avoid, reintroduced one line later.
     *
     * On a RE-bootstrap it matters. `beginBootstrap` deliberately does not rewind
     * `sync_entity_versions`, so a device carries its old counter into the new epoch
     * while the fold's numbers restart at zero. Writing the fold's numbers verbatim
     * would leave every inherited field sitting below the counter that is actually in
     * use, and therefore defenceless against the first operation to arrive.
     *
     * The rule is not invented here: {@link screenForConflicts} records
     * `max(version, op.baseVersion)` for a relayed operation, for the same reason —
     * a value arriving on a lower scale than this device counts on is at least as
     * current as this device is.
     */
    insert.run(
      entity,
      entityId,
      write.field,
      Math.max(priorVersion, write.baseVersion),
      write.opId,
      write.at,
    );
  }
}

/**
 * Put back the provenance for work this device has not pushed yet.
 *
 * {@link beginBootstrap} clears `sync_field_writes` because every row in it is
 * denominated in an epoch that has been replaced. That is right for everything the
 * server can re-supply and wrong for one thing it cannot: the outbox survives a
 * re-bootstrap by design — *"its pending local work survives"* — and the fields
 * those queued operations name are values this device holds and will go on to
 * defend. Without this, a device that re-bootstrapped with work in flight would
 * push its own edit and then hand it to the next stale write in silence, which is
 * the relay defect reached by a third road.
 *
 * Replayed in allocation order so the newest write of each field lands last, which
 * is the same replay migration 011 performs against the same table from the same
 * source. `base_version IS NOT NULL` excludes creates for the same reason it does
 * there and in {@link Journal.flush}: a create was never one of "the operations in
 * between".
 *
 * The outbox's `base_version` values are already on the counter this device kept,
 * because `beginBootstrap` does not rewind it — so unlike the snapshot's numbers
 * they need no lifting.
 *
 * Called AFTER the snapshot half completes, not before it. The ordering is the
 * whole argument: the server's view of the world is older than an operation this
 * device has not yet sent, so this device's un-sent work is the last word.
 */
export function replayOutboxFieldWrites(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT op_id, entity, entity_id, base_version, payload, created_at
         FROM sync_outbox
        WHERE base_version IS NOT NULL
        ORDER BY client_seq`,
    )
    .all() as Array<{
    op_id: string;
    entity: string;
    entity_id: string;
    base_version: number;
    payload: string;
    created_at: string;
  }>;

  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      continue;
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    recordFieldWrites(db, {
      entity: row.entity,
      entityId: row.entity_id,
      fields: Object.keys(payload as Record<string, unknown>),
      baseVersion: row.base_version,
      opId: row.op_id,
      deviceId: null,
      at: row.created_at,
    });
  }
}

export class Journal {
  private scope: JournalScope | null = null;
  private knownDeviceId: string | null;

  /**
   * `resolve` is set for a journal made by {@link journalFor}: one that found no device
   * id when it was made, and must keep looking.
   *
   * A journal lives as long as its database connection, and a UI or MCP server holds one
   * for its whole life. Resolving the device id once, when the journal was made, meant a
   * server started before this machine's first `staple cloud connect` journaled nothing
   * for as long as it ran — after the connect, after the first sync had seeded the
   * repository — so every issue created and every edit made through it stayed on this
   * machine and nothing ever said so. The device id is a file only `connect` writes, so
   * until it is found it is looked for again on each mutation, and once found it is kept.
   */
  constructor(
    private readonly db: DatabaseSync,
    deviceId: string | null,
    private readonly resolve: (() => string | null) | null = null,
  ) {
    this.knownDeviceId = deviceId;
  }

  private get deviceId(): string | null {
    if (this.knownDeviceId === null && this.resolve !== null) this.knownDeviceId = this.resolve();
    return this.knownDeviceId;
  }

  /** True when this workspace has both an identity and a bound device. */
  armed(): boolean {
    if (this.deviceId === null) return false;
    return this.state()?.repository_id != null;
  }

  private state(): SyncStateRow | null {
    const row = this.db
      .prepare("SELECT repository_id, epoch, cursor FROM sync_state WHERE id = 1")
      .get() as SyncStateRow | undefined;
    return row ?? null;
  }

  /** This workspace's queue will be sent: it is connected here, or has synchronized before. */
  private boundForService(state: SyncStateRow): boolean {
    if (state.epoch > 0 || state.cursor !== null) return true;
    return state.repository_id !== null && existsSync(connectionPath(stapleHome(), state.repository_id));
  }

  /** The dedup key an event should carry, or null outside any scope. */
  eventDedupKey(kind: string): string | null {
    return this.scope ? this.scope.nextEventKey(kind) : null;
  }

  /** True while a mutation scope is open. Read by the characterization tests. */
  get inScope(): boolean {
    return this.scope !== null;
  }

  /**
   * Declare what this mutation did.
   *
   * Throws outside a scope rather than silently doing nothing. A declaration
   * that lands outside a transaction is a mutation that can commit without its
   * operation, which is obligation 1 failing quietly — the loudest possible
   * failure is the cheapest one here.
   */
  record(intent: JournalIntent): void {
    const scope = this.scope;
    if (!scope) {
      throw new Error(
        `journal.record(${intent.entity}.${intent.verb}) outside a mutation scope. ` +
          `Every journaled mutation must run inside WorkspaceStore.mutate / journaled().`,
      );
    }
    if (scope.suppressed) return;

    const key = `${intent.entity}\u0000${intent.entityId}`;
    const existing = scope.intents.get(key);
    if (!existing) {
      scope.intents.set(key, {
        entity: intent.entity,
        entityId: intent.entityId,
        verb: intent.verb,
        payload: oneSpelling(intent.payload ?? {}),
        actor: intent.actor ?? null,
      });
      return;
    }
    /**
     * Deleted, then brought back, in one mutation — a batch that removes a status and adds
     * it again, a reset followed by a set. The net effect is an entity that exists with
     * what the second half wrote, and that is what travels: a `create` carrying only its
     * payload. Merged the ordinary way this was a `delete`, so the origin kept the entity
     * and every receiver removed it.
     */
    if (existing.verb === "delete" && (intent.verb === "create" || intent.verb === "update")) {
      scope.intents.set(key, {
        entity: existing.entity,
        entityId: existing.entityId,
        verb: "create",
        payload: oneSpelling(intent.payload ?? {}),
        actor: intent.actor ?? existing.actor ?? null,
      });
      return;
    }
    scope.intents.set(key, {
      entity: existing.entity,
      entityId: existing.entityId,
      verb: mergeVerb(existing.verb, intent.verb),
      payload: { ...existing.payload, ...oneSpelling(intent.payload ?? {}) },
      actor: intent.actor ?? existing.actor ?? null,
    });
  }

  /**
   * Run one logical mutation: a transaction, a scope, and a flush before commit.
   *
   * Re-entrant. An inner call joins the outer scope rather than opening a second
   * one, so `MilestoneStore.create` composing `createIssue` + `update` +
   * `addMember` is one transaction with one scope — and the three intents it
   * declares are three operations only if they name three different entities,
   * which they do.
   */
  run<T>(fn: () => T): T {
    if (this.scope) return tx(this.db, fn);

    const scope = new JournalScope(randomUUID(), false);
    this.scope = scope;
    /**
     * With a device to journal for, the rows the mutation touches are read before and after
     * (`cloud/row-diff.ts`): every synchronized column it changed travels, whether or not the
     * mutation named it. Armed and disarmed inside the transaction, so a throw rolls the
     * capture back with everything else.
     */
    const capturing = this.deviceId !== null;
    if (capturing) ensureRowCapture(this.db);
    try {
      return tx(this.db, () => {
        if (capturing) armRowCapture(this.db, true, true);
        const result = fn();
        const changes = capturing ? takeRowChanges(this.db) : [];
        if (capturing) armRowCapture(this.db, false);
        this.flush(scope, changes);
        return result;
      });
    } finally {
      this.scope = null;
    }
  }

  /**
   * Apply a pulled operation: the same domain write, journalling nothing.
   *
   * This is obligation 4. Without it the device that applied an operation
   * journals its own copy, pushes it, the other device applies that and journals
   * again, and the two synchronize forever. Returns null when the operation is
   * already in the ledger, which makes redelivery free.
   *
   * The ledger row is written BEFORE the domain write, inside the same
   * transaction. Order matters only for readability — either both land or
   * neither does — but writing it first means the invariant reads as "an applied
   * operation is recorded", not "a recorded operation was applied".
   */
  applyRemote<T>(op: { opId: string; seq: number }, apply: () => T): T | null {
    return tx(this.db, () => {
      const seen = this.db
        .prepare("SELECT 1 AS hit FROM sync_applied WHERE op_id = ?")
        .get(op.opId) as { hit: number } | undefined;
      if (seen) return null;

      this.db
        .prepare("INSERT INTO sync_applied (op_id, seq, applied_at) VALUES (?, ?, ?)")
        .run(op.opId, op.seq, nowIso());

      const outer = this.scope;
      const scope = new JournalScope(op.opId, true);
      this.scope = scope;
      // What an applied operation writes is somebody else's change: nothing of it is journaled.
      const capturing = armRowCapture(this.db, false);
      try {
        return apply();
      } finally {
        if (capturing) armRowCapture(this.db, true);
        this.scope = outer;
      }
    });
  }

  // ------------------------------------------------------------------ flush

  /**
   * Turn the scope's declarations into outbox rows.
   *
   * Runs inside the caller's transaction, immediately before it commits. Each
   * intent bumps its entity version, allocates one client sequence and derives
   * one operation id — in that order, all in this transaction, so a rollback
   * takes the version bump and the sequence allocation with it and the next
   * attempt derives the same id from the same inputs.
   */
  private flush(scope: JournalScope, changes: readonly RowChange[] = []): void {
    if (this.deviceId === null) return;
    if (scope.intents.size === 0 && changes.length === 0) return;
    const state = this.state();
    if (!state?.repository_id) return;
    this.mergeRowChanges(scope, changes);
    if (scope.intents.size === 0) return;

    const createdAt = nowIso();
    /**
     * Refused here, on the device, before a row is written — *"a document revision
     * larger than the payload cap is refused at journal time, with the same code, so the
     * failure surfaces where the human is"*. The service refuses an oversized payload
     * for the whole batch, so an outbox holding one would fail the same push on every
     * sync and nothing queued behind it would ever leave. The throw rolls the mutation
     * back with it: the scope runs inside the mutation's transaction.
     *
     * Only for an operation that is going to a service: this workspace is connected
     * here, or has synchronized before (so its queue is sent, as it stands, the next time
     * it is). A journal is also armed in a workspace that has never been connected, on a
     * machine that connected something else, and refusing a write THERE would forbid a
     * large document in a tracker that syncs nowhere. Its first sync replaces that
     * journal with a seed, and the seed names an oversized revision and leaves it behind.
     */
    for (const intent of scope.intents.values()) {
      const bytes = Buffer.byteLength(JSON.stringify(intent.payload), "utf8");
      if (bytes > JOURNAL_MAX_OP_BYTES && this.boundForService(state)) {
        throw cloudError(
          "payload_too_large",
          `This ${intent.entity} change is ${bytes} bytes, and this workspace syncs to a service that ` +
            `takes at most ${JOURNAL_MAX_OP_BYTES} bytes per operation, so it could never be sent. ` +
            `Nothing was written. Shorten it, or keep the large content outside the tracker and link to it.`,
          { bytes, maxBytes: JOURNAL_MAX_OP_BYTES },
        );
      }
    }
    for (const intent of scope.intents.values()) {
      const baseVersion = this.bumpEntityVersion(intent.entity, intent.entityId);
      const clientSeq = this.allocateClientSeq();
      const opId = deriveOpId(state.repository_id, state.epoch, this.deviceId, clientSeq);
      this.db
        .prepare(
          `INSERT INTO sync_outbox
             (op_id, client_seq, entity, entity_id, verb, base_version, payload, actor, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          opId,
          clientSeq,
          intent.entity,
          intent.entityId,
          intent.verb,
          intent.verb === "create" ? null : baseVersion,
          JSON.stringify(intent.payload),
          intent.actor ?? null,
          createdAt,
        );

      /**
       * The same fields again, in the one place that outlives the outbox.
       *
       * Not a duplicate of the row above: the outbox is a queue and is emptied
       * by {@link compact} the moment the server acknowledges, while conflict
       * detection has to be able to say "I have written this field since the
       * version you claim" for as long as the value stands. Reading that off a
       * queue was the defect — a device stopped being able to defend its own
       * edit as soon as routine housekeeping ran.
       *
       * A `create` is skipped because it carries no base version and was never
       * one of "the operations in between".
       */
      if (intent.verb !== "create") {
        recordFieldWrites(this.db, {
          entity: intent.entity,
          entityId: intent.entityId,
          fields: Object.keys(intent.payload),
          baseVersion,
          opId,
          deviceId: this.deviceId,
          at: createdAt,
        });
      }

      /**
       * A deletion made here is a tombstone here at once, not only when it comes back on
       * the next pull. Until then it is this device's only record that the entity was
       * deleted, and a set made in between has to go out as a `create` — after a delete
       * only a create brings an entity back, in the service's fold and in every applier
       * (`WorkspaceStore.setSetting`). Sent as an `update` it was dropped by the fold, and
       * when the delete came back here it removed the value on this device as well. The
       * create lifts the tombstone when it comes back, as on every other device.
       */
      if (intent.verb === "delete") {
        this.db
          .prepare(
            `INSERT INTO sync_tombstones (entity, entity_id, deleted_at, device_id, op_id)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (entity, entity_id) DO NOTHING`,
          )
          .run(intent.entity, intent.entityId, createdAt, this.deviceId, opId);
      }
    }
  }

  /**
   * Fold what the rows say changed into what the mutation declared (`cloud/row-diff.ts`).
   *
   * Every synchronized column the mutation changed joins its entity's operation with the
   * value the row now holds — over a value the declaration named, since the row is what the
   * mutation left. An entity the mutation changed and declared nothing about gets an
   * operation of its own: an `update`, or a `create` for a row it inserted, attributed to
   * the mutation's actor. A declared `delete` is left as it is.
   *
   * A derived issue column is never part of the change (`docs/sync.md`, "Derived
   * columns"): no provenance, never contested, and ignored by this build's applier, which
   * computes it. What an issue operation does carry, as the row holds it, is a copy for the
   * builds from before this one, whose applier reads it — the normalized title beside any
   * title, and the depth on a create.
   */
  private mergeRowChanges(scope: JournalScope, changes: readonly RowChange[]): void {
    const actor = [...scope.intents.values()].find((intent) => intent.actor !== null)?.actor ?? null;
    for (const change of changes) {
      const key = `${change.entity}\u0000${change.entityId}`;
      const existing = scope.intents.get(key);
      if (existing?.verb === "delete") continue;
      scope.intents.set(
        key,
        existing
          ? { ...existing, payload: { ...existing.payload, ...change.fields } }
          : { entity: change.entity, entityId: change.entityId, verb: change.created ? "create" : "update", payload: { ...change.fields }, actor },
      );
    }
    for (const [key, intent] of scope.intents) {
      if (intent.entity !== "issue" || intent.verb === "delete") continue;
      const payload = Object.fromEntries(Object.entries(intent.payload).filter(([field]) => !DERIVED_FIELDS.has(field)));
      if (typeof payload.title === "string") payload.normalizedTitle = normalizeTitle(payload.title);
      if (intent.verb === "create") {
        const row = this.db.prepare("SELECT depth FROM issues WHERE id = ?").get(intent.entityId) as { depth: number } | undefined;
        if (row) payload.depth = row.depth;
      }
      scope.intents.set(key, { ...intent, payload });
    }
  }

  /** True when this entity's last word, here, was a delete. */
  isTombstoned(entity: SyncEntity, entityId: string): boolean {
    return (
      this.db.prepare("SELECT 1 AS hit FROM sync_tombstones WHERE entity = ? AND entity_id = ?").get(entity, entityId) !==
      undefined
    );
  }

  /**
   * Bump the entity's version and return what it was.
   *
   * The returned value is the envelope's `baseVersion`: the version immediately
   * before this mutation, which is what a receiver compares against to decide
   * whether it is applying in order.
   */
  private bumpEntityVersion(entity: SyncEntity, entityId: string): number {
    const row = this.db
      .prepare(
        `INSERT INTO sync_entity_versions (entity, entity_id, version) VALUES (?, ?, 1)
         ON CONFLICT (entity, entity_id) DO UPDATE SET version = version + 1
         RETURNING version`,
      )
      .get(entity, entityId) as { version: number };
    return row.version - 1;
  }

  /**
   * Allocate the next client sequence.
   *
   * From `sync_state.client_seq_high_water`, and **never** from
   * `MAX(sync_outbox.client_seq)`. That derivation is the obvious optimization
   * and it destroys data silently: outbox compaction prunes acknowledged rows,
   * the maximum rewinds, the device re-mints operation ids the server already
   * holds, the server deduplicates them and returns each original `seq`, and the
   * client marks genuinely new work as acknowledged. No error is raised
   * anywhere, and the two databases disagree from then on. The same collision
   * follows a re-bootstrap, against a log that certainly still holds the
   * originals because epoch bumps do not truncate.
   *
   * A counter that only moves forward, stored where nothing prunes it, costs one
   * column. This is that column being used.
   */
  private allocateClientSeq(): number {
    const row = this.db
      .prepare(
        `UPDATE sync_state SET client_seq_high_water = client_seq_high_water + 1
          WHERE id = 1
      RETURNING client_seq_high_water`,
      )
      .get() as { client_seq_high_water: number } | undefined;
    if (!row) {
      throw new Error("sync_state has no row: the journal is armed without an identity.");
    }
    return row.client_seq_high_water;
  }

  // ------------------------------------------------------------------- seed

  /**
   * Journal the state a workspace already held, as ordinary operations (the seed).
   *
   * Everything a device held before it first synchronized was written while the seam
   * was disarmed, or while it was armed but talking to nobody, so the outbox either
   * has no record of it or has a partial one. {@link seedRepository} decides WHAT has
   * to travel; this is only the allocation, kept here so that `client_seq`, the
   * operation id and the entity version are still produced in exactly one file.
   *
   * Each intent is an ordinary operation and fits the model unchanged: one client
   * sequence from `client_seq_high_water`, an id derived from the repository, the
   * epoch this database is on, the device and that sequence — so a retried push of a
   * seed is absorbed like any other retry.
   *
   * ## The version is SET, not bumped, and that is the point
   *
   * `serviceVersion` is how many operations the service already holds for the entity.
   * After this operation it holds one more, and conflict detection only works when
   * every device's counter for an entity counts the same operations (see the
   * `sync.ts` note on echoes). A local counter carried over from a pre-connect journal,
   * or from a repository this workspace was forked from, counts operations the service
   * never received, so bumping it would leave this device permanently ahead of every
   * device that hydrates the entity from the service — and a counter that is ahead
   * stops seeing concurrent edits as conflicts.
   *
   * ## A create records no provenance; a merge does
   *
   * `create` is the verb for an entity the service does not hold, and like every create
   * it leaves nothing in `sync_field_writes` — the same line {@link flush} draws and the
   * server's fold draws. Any row already there for such an entity describes a write the
   * service never received, so it is removed. The other verbs appear only for a
   * collection the service already holds and that gained local members on joining; they
   * are real edits of a real base and are recorded exactly as `flush` records one.
   */
  seed(intents: readonly SeedIntent[]): number {
    if (intents.length === 0) return 0;
    if (this.deviceId === null) {
      throw new Error("journal.seed on a journal with no device: the seed is written by sync only.");
    }
    const state = this.state();
    if (!state?.repository_id) {
      throw new Error("journal.seed on a workspace with no repository identity.");
    }
    const setVersion = this.db.prepare(
      `INSERT INTO sync_entity_versions (entity, entity_id, version) VALUES (?, ?, ?)
       ON CONFLICT (entity, entity_id) DO UPDATE SET version = excluded.version`,
    );
    const clearProvenance = this.db.prepare(
      "DELETE FROM sync_field_writes WHERE entity = ? AND entity_id = ?",
    );
    const insert = this.db.prepare(
      `INSERT INTO sync_outbox
         (op_id, client_seq, entity, entity_id, verb, base_version, payload, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const intent of intents) {
      setVersion.run(intent.entity, intent.entityId, intent.serviceVersion + 1);
      const clientSeq = this.allocateClientSeq();
      const opId = deriveOpId(state.repository_id, state.epoch, this.deviceId, clientSeq);
      const create = intent.verb === "create";
      insert.run(
        opId,
        clientSeq,
        intent.entity,
        intent.entityId,
        intent.verb,
        create ? null : intent.serviceVersion,
        JSON.stringify(intent.payload),
        intent.actor,
        intent.at,
      );
      if (create) {
        clearProvenance.run(intent.entity, intent.entityId);
      } else {
        recordFieldWrites(this.db, {
          entity: intent.entity,
          entityId: intent.entityId,
          fields: Object.keys(intent.payload),
          baseVersion: intent.serviceVersion,
          opId,
          deviceId: this.deviceId,
          at: intent.at,
        });
      }
    }
    return intents.length;
  }

  /**
   * Take one unsent operation out of the queue, with the provenance it recorded.
   *
   * For an operation the service will refuse whatever happens — larger than the payload
   * it advertises — which would otherwise fail the same batch on every push and hold
   * back everything queued behind it. The caller names what it withheld; the domain row
   * it described is untouched.
   */
  withhold(opId: string): void {
    this.db.prepare("DELETE FROM sync_field_writes WHERE op_id = ?").run(opId);
    this.db.prepare("DELETE FROM sync_outbox WHERE op_id = ? AND acknowledged_seq IS NULL").run(opId);
  }

  // ------------------------------------------------------------- compaction

  /**
   * Prune what has been accepted, and nothing else.
   *
   * Acknowledged outbox rows and applied-ledger entries older than the horizon
   * go. Unacknowledged operations, tombstones and conflicts stay: an
   * unacknowledged row is work the server has not confirmed, a tombstone is what
   * stops a delete being resurrected by a late update, and a conflict is the
   * audit record of a decision. Compaction that touched any of the three would
   * change what the repository converges to, which is the one thing it must not
   * do.
   *
   * `client_seq_high_water` is untouched by construction — it lives in
   * `sync_state`, which this does not write. That is the entire reason it is a
   * column instead of a query.
   */
  compact(before: string = nowIso()): CompactionResult {
    return tx(this.db, () => {
      const outbox = this.db
        .prepare(
          "DELETE FROM sync_outbox WHERE acknowledged_seq IS NOT NULL AND created_at < ?",
        )
        .run(before);
      const applied = this.db
        .prepare("DELETE FROM sync_applied WHERE applied_at < ?")
        .run(before);
      /**
       * Field-write provenance is NOT pruned on the horizon, and that is the
       * point of the table. It is bounded by live entities rather than by
       * history, so it never needs to be — and the moment it were, detection
       * would expire with housekeeping again.
       *
       * The one exception is not an exception to that rule. An entity with a
       * tombstone cannot be contested at all: *"an `update` for a tombstoned
       * entity is a no-op regardless of arrival order"*, so its provenance can
       * never be the evidence for any conflict, and keeping it would be keeping
       * rows about something that no longer exists. Deleting them cannot change
       * what the repository converges to, which is the bar compaction has to
       * clear.
       */
      const fields = this.db
        .prepare(
          `DELETE FROM sync_field_writes
             WHERE EXISTS (
               SELECT 1 FROM sync_tombstones t
                WHERE t.entity = sync_field_writes.entity
                  AND t.entity_id = sync_field_writes.entity_id
             )`,
        )
        .run();
      return {
        outboxPruned: Number(outbox.changes),
        appliedPruned: Number(applied.changes),
        fieldWritesPruned: Number(fields.changes),
      };
    });
  }

  // ------------------------------------------------------------------ reads

  /** Pending operations in allocation order — what a push would send. */
  pending(limit = 500): OperationEnvelope[] {
    const state = this.state();
    const rows = this.db
      .prepare(
        `SELECT op_id, client_seq, entity, entity_id, verb, base_version, payload, actor, created_at
           FROM sync_outbox WHERE acknowledged_seq IS NULL ORDER BY client_seq LIMIT ?`,
      )
      .all(limit) as Array<{
      op_id: string;
      client_seq: number;
      entity: string;
      entity_id: string;
      verb: string;
      base_version: number | null;
      payload: string;
      actor: string | null;
      created_at: string;
    }>;
    return rows.map((row) => ({
      opId: row.op_id,
      repoId: state?.repository_id ?? "",
      protocol: SYNC_PROTOCOL,
      schema: this.schemaVersion(),
      entity: row.entity as SyncEntity,
      entityId: row.entity_id,
      verb: row.verb as SyncVerb,
      baseVersion: row.base_version,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      deviceId: this.deviceId ?? "",
      actor: row.actor,
      clientSeq: row.client_seq,
      createdAt: row.created_at,
    }));
  }

  /**
   * The schema version an envelope declares, read from the database.
   *
   * Read rather than hard-coded: `meta.schema_version` is what this file
   * actually is, and a constant beside the migration set would be one refactor
   * away from claiming a version the rows were not written under. It is the one
   * `meta` key that never replicates — a receiver uses it to decide whether it
   * can understand the payload, which is the opposite of adopting it.
   */
  private schemaVersion(): number {
    const row = this.db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    return Number(row?.value ?? 0);
  }

  /** The version an entity is at locally. 0 when it has never been journaled. */
  entityVersion(entity: SyncEntity, entityId: string): number {
    const row = this.db
      .prepare("SELECT version FROM sync_entity_versions WHERE entity = ? AND entity_id = ?")
      .get(entity, entityId) as { version: number } | undefined;
    return row?.version ?? 0;
  }
}

/**
 * One journal per database connection.
 *
 * `WorkspaceStore`, `MilestoneStore`, `QueueStore` and `ProjectStore` all hold
 * the same `DatabaseSync`, and "one seam" is only true if they hold the same
 * journal — otherwise a milestone create composing an issue create would open
 * two scopes and journal the composition twice. Keyed on the connection because
 * that is what a transaction is scoped to.
 */
const journals = new WeakMap<DatabaseSync, Journal>();

export function journalFor(db: DatabaseSync): Journal {
  const existing = journals.get(db);
  if (existing) return existing;
  const created = new Journal(db, resolveDeviceId(), resolveDeviceId);
  journals.set(db, created);
  return created;
}

/** Rebind a connection's journal to a device. Test and connect-flow entry point. */
export function bindJournal(db: DatabaseSync, deviceId: string | null): Journal {
  const created = new Journal(db, deviceId);
  journals.set(db, created);
  return created;
}
