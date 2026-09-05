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
 * id. The device id is machine-local by contract and lives in machine config,
 * which this lane does not own — so {@link resolveDeviceId} reads the
 * environment and otherwise returns null, and an unconnected workspace journals
 * nothing at all: no outbox rows, no version rows, no observable difference from
 * the build before this one. The seam still runs, so the scope discipline and
 * the event dedup keys are exercised on every machine; only the recording is
 * withheld.
 */
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { tx } from "./db.js";
import { nowIso } from "./types.js";

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
 * A placeholder with a real contract: the device id is machine-local, belongs in
 * machine config, and the lane that owns machine config has not landed. Reading
 * the environment keeps the seam testable and keeps every production workspace
 * disarmed until a device is genuinely bound. Replace the body, not the callers.
 */
export function resolveDeviceId(): string | null {
  const value = process.env.STAPLE_DEVICE_ID?.trim();
  return value ? value : null;
}

interface SyncStateRow {
  repository_id: string | null;
  epoch: number;
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
}

export class Journal {
  private scope: JournalScope | null = null;

  constructor(
    private readonly db: DatabaseSync,
    private readonly deviceId: string | null,
  ) {}

  /** True when this workspace has both an identity and a bound device. */
  armed(): boolean {
    if (this.deviceId === null) return false;
    return this.state()?.repository_id != null;
  }

  private state(): SyncStateRow | null {
    const row = this.db
      .prepare("SELECT repository_id, epoch FROM sync_state WHERE id = 1")
      .get() as SyncStateRow | undefined;
    return row ?? null;
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

    const key = `${intent.entity} ${intent.entityId}`;
    const existing = scope.intents.get(key);
    if (!existing) {
      scope.intents.set(key, {
        entity: intent.entity,
        entityId: intent.entityId,
        verb: intent.verb,
        payload: { ...(intent.payload ?? {}) },
        actor: intent.actor ?? null,
      });
      return;
    }
    scope.intents.set(key, {
      entity: existing.entity,
      entityId: existing.entityId,
      verb: mergeVerb(existing.verb, intent.verb),
      payload: { ...existing.payload, ...(intent.payload ?? {}) },
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
    try {
      return tx(this.db, () => {
        const result = fn();
        this.flush(scope);
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
      try {
        return apply();
      } finally {
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
  private flush(scope: JournalScope): void {
    if (scope.intents.size === 0) return;
    if (this.deviceId === null) return;
    const state = this.state();
    if (!state?.repository_id) return;

    const createdAt = nowIso();
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
    }
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
      return {
        outboxPruned: Number(outbox.changes),
        appliedPruned: Number(applied.changes),
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
  const created = new Journal(db, resolveDeviceId());
  journals.set(db, created);
  return created;
}

/** Rebind a connection's journal to a device. Test and connect-flow entry point. */
export function bindJournal(db: DatabaseSync, deviceId: string | null): Journal {
  const created = new Journal(db, deviceId);
  journals.set(db, created);
  return created;
}
