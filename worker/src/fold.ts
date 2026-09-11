/**
 * Folding the operation log into per-entity state.
 *
 * This is the same computation `snapshot.ts` performs on read, extracted because a
 * BACKUP is exactly that fold, persisted. A backup computed by a different rule from
 * the one `GET /snapshot` uses would restore into an epoch that hydrates differently
 * from the way it was captured, and the difference would only ever be discovered by
 * whoever was relying on the backup.
 *
 * ## Why this is a file of its own
 *
 * It was written here while `snapshot.ts` was owned by another lane, and duplicating a
 * fold was recorded as a debt to be repaid by deletion rather than reconciliation. It
 * has been: `snapshot.ts` imports `foldLog` and has no private fold. There is one fold,
 * and `worker/test/backups.test.ts` pins a backup against the live `/snapshot` route so
 * that stays true.
 *
 * ## A fold supersedes the keys an operation carried, never the entity (STA-259)
 *
 * Every verb here merges its payload's keys over the state and is silent about every key
 * it did not mention. `replace` is no exception, and that is the whole of the fix: an
 * ordered collection lives entirely under ONE key (`{ members: … }` on a milestone,
 * `{ order: … }` on the plan — `envelope.ts` admits `replace` only for those two
 * entities, and every payload only as a JSON object), so assigning that key's value
 * WHOLE, never merging it element-wise, already IS supersede for the collection. A
 * `replace` may carry other keys beside it — the journal coalesces a milestone's
 * membership with an edit to the same milestone into one operation — and they merge
 * like any other verb's.
 *
 * Superseding the entity was a strictly stronger claim than any operation ever made.
 * This fold used to make it by setting the state to `{ replaced: payload }`, and that
 * wrapper was the bug made structural: to hold one payload as "the whole state" it had
 * to evict every other key. A milestone dated before its membership changed folded to
 * membership alone and hydrated devices with null dates — through a snapshot and through
 * a restored backup identically, because both come out of this function.
 *
 * ## Why `superseded` survives the wrapper
 *
 * With nothing wrapped, the verb is not inferable from the shape of the state AT ALL —
 * which is exactly why it is recorded at fold time rather than reconstructed at restore
 * time. It was always a mistake to ask the shape: the answer means guessing about an
 * entity whose only field happens to be called `replaced`, and guessing is how a plan
 * comes back as an object with a `replaced` key instead of as a plan.
 *
 * ## Per-field provenance, and the one distinction it exists to make (STA-263)
 *
 * A device that hydrates from a snapshot is handed values it neither authored nor
 * relayed. Conflict detection asks the applying device *"have I written this field
 * since the version you claim as your base?"*, and a hydrated device had nothing to
 * answer with, so the next stale write to an inherited field was taken in silence.
 *
 * The tempting fix — mark every field of the folded state as written at the snapshot's
 * version — is WRONG rather than merely coarse. `createIssue` journals ONE `create`
 * carrying the whole field inventory, `priority: input.priority ?? "medium"` among it,
 * so under that rule a later `priority` edit would contest a `medium` nobody ever
 * chose. **Manufacturing conflicts out of defaults is worse than the silence.**
 *
 * So the fold has to distinguish a field somebody SET from a field that merely arrived
 * carrying its default, and the line is one the client already draws for its own
 * writes: `Journal.flush` records provenance for every verb EXCEPT `create`, because
 * *"a create carries no base version and was never one of the operations in between"*.
 * Migration 011's backfill skips creates for the same reason. Here, therefore:
 *
 *   **a field has provenance iff some non-`create` operation carried it, and the
 *   provenance is that of the newest such operation.**
 *
 * A create is always an entity's first operation, so "newest non-create writer" is just
 * "newest writer, unless that writer was the create" — no extra bookkeeping, and the
 * result is that a hydrated device holds field-for-field the same rows a device present
 * for the whole log holds. Untouched defaults are absent from both.
 *
 * `baseVersion` is `version - 1` at merge time: the number of operations folded ahead of
 * this one. That is deliberately NOT the operation's own `base_version` column, which is
 * the sender's claim and may be staler. It is the same number `screenForConflicts`
 * records as `max(localVersion, op.baseVersion)` when the identical operation arrives in
 * the ordered tail — which is what makes the two paths agree.
 *
 * The bound is unchanged, and that is load-bearing: one entry per key ever carried by a
 * non-create operation is a strict subset of `state`'s keys, so this grows with live
 * entities × fields and with no term in history — exactly the bound `sync_field_writes`
 * has, because it is reconstructing that table.
 *
 * The provenance describes the value in `state` and therefore always names the NEWEST
 * writer of that key, even where two devices are arguing about it. That is not the
 * server taking a side: *"the server does not detect conflicts"*, the fold is
 * last-write-wins by construction, and the provenance has to describe the value it is
 * shipping beside rather than some other one.
 */

import { entityKey } from "./cursor.js";
import type { Env } from "./env.js";
import { SyncError } from "./errors.js";
import { MAX_SNAPSHOT_FOLD_OPS, SNAPSHOT_FOLD_PAGE } from "./limits.js";

/**
 * The newest non-`create` write of one field, as `sync_field_writes` would hold it.
 *
 * `deviceId` is absent on purpose. `sync_field_writes.device_id` is written and never
 * read — `localFieldWrites` selects `field, op_id, written_at`, and migration 011's own
 * backfill stores NULL there — so carrying it would add a column of wire per field for
 * something no reader consults.
 */
export interface FieldWrite {
  /** The entity version this write moved OFF. See the module comment. */
  baseVersion: number;
  opId: string;
  /** The operation's client timestamp, as sent. Becomes `written_at`. */
  at: string;
  /**
   * Where in the log this write sits. A hydrating device compares it with the seq of a
   * local claim on the same value — two devices giving two issues one identifier, two
   * projects one slug — so that it settles the claim exactly as a device that read the
   * ordered tail did: the earlier claim keeps the value.
   */
  seq: number;
}

/**
 * A folded entity as a BACKUP stores it, and as a restore materialises it.
 *
 * Everything the fold computes except the per-field provenance, which a restore has no
 * use for: it writes the fold into a NEW epoch where entity versions restart from zero
 * and operation ids are re-minted, so an old epoch's `baseVersion` is on a different
 * scale and its `opId` names a row no device will ever see. Carrying it would be dead
 * weight in every backup blob and a trap for whoever read it next.
 */
export interface BackupEntity {
  entity: string;
  entityId: string;
  /** Operations folded into this entity. A hydrating client's initial version. */
  version: number;
  /** Server timestamp of the tombstone, or null. A tombstone is data, not an absence. */
  deletedAt: number | null;
  lastSeq: number;
  /**
   * True when the last surviving write was a `replace`, so a restore materialises this
   * state under that verb again. It records the VERB, not a shape: it says nothing about
   * which keys the state holds, because a `replace` is authoritative only for the keys
   * it carried. See the module comment.
   */
  superseded: boolean;
  state: Record<string, unknown>;
  /**
   * The client timestamp of the `create` this state descends from, or null when the log
   * holds no create for it (an entity only ever updated — which a build before the seed
   * produced). Carried because a snapshot has no operation of its own to take a time
   * from: without it, a comment or a document revision whose payload did not carry its
   * own `createdAt` — every one written before that field was journaled — was stamped on
   * a hydrating device with the moment it hydrated, while a device that read the same
   * create in the ordered tail stamped it with this. A restore writes it back as the
   * restored operation's time, so the fold of the new epoch carries it too.
   */
  createdAt?: string | null;
  /**
   * The actor of that create, for the same reason: a document revision written before
   * its payload carried its own `author` was attributed on a hydrating device to nobody,
   * and on a device reading the tail to whoever this names.
   */
  createdBy?: string | null;
}

export interface FoldedEntity extends BackupEntity {
  /**
   * The seq of the `create` this state descends from, or null when there is none. This
   * epoch's number, so a backup does not keep it (`forBackup`): a restore re-mints every
   * seq. See {@link FieldWrite.seq} for what it is compared with.
   */
  createdSeq: number | null;
  /**
   * Per-field provenance, keyed by the payload key exactly as the operation spelled it —
   * `estimatedSeconds`, not `estimated_seconds`, which is the spelling
   * `sync_field_writes.field` stores and the reader canonicalizes.
   *
   * Holds ONLY keys carried by a non-`create` operation, which is the whole of STA-263:
   * a key present here is one somebody set, a key absent is one that arrived carrying
   * its default. See the module comment.
   */
  fieldWrites: Record<string, FieldWrite>;
}

export interface FoldResult {
  entities: FoldedEntity[];
  /** Operations read. Recorded on the backup so a human can see what it cost. */
  opCount: number;
  /** The highest `schema_version` seen. Stored, never interpreted by the server. */
  schemaVersion: number;
}

/**
 * Fold `repo_id = repoId AND epoch = epoch AND seq <= cutoff` into entity state.
 *
 * Mechanical, and knows nothing about what an issue is:
 *
 *   create/update/renumber — shallow-merge the payload's fields over the state
 *   replace                — the same merge, and the value of the key naming the ordered
 *                            collection is assigned WHOLE, which is the supersede. The
 *                            verb is recorded so a restore can reproduce it.
 *   delete                 — record a tombstone; later updates become no-ops
 *   create after a delete  — the entity begins again: the tombstone is lifted and the
 *                            state restarts from this create's payload
 *
 * The tombstone wins over every later update regardless of arrival order, which is what
 * makes convergence order-independent, and it is RETURNED rather than omitted: a device
 * handed silence about a deleted entity cannot tell it from one it has never heard of.
 * That matters more for a restore than for a bootstrap, because a re-bootstrapping
 * device keeps its local rows — so an unmaterialised tombstone means a deleted issue
 * quietly coming back to life on every device that still has it.
 *
 * ## Why a create is the one thing a tombstone yields to
 *
 * A tombstone exists to stop a LATE update — one made before its author saw the delete —
 * from resurrecting what was deleted. A create is not late: it is somebody deciding,
 * after the delete, that the entity exists again, and for an entity keyed by a name
 * rather than a UUID that is an ordinary thing to do. Removing a status and adding it
 * back, or resetting a setting and setting it again, reuses the key. Treating the
 * tombstone as final dropped the second create on every device that hydrated from here,
 * while every device that read the ordered tail applied it — the two halves of a
 * bootstrap disagreeing about whether `blocked` is a status. The client's applier makes
 * the identical exception (`apply.ts`), so both halves agree again.
 */
export async function foldLog(
  env: Env,
  repoId: string,
  epoch: number,
  cutoff: number,
): Promise<FoldResult> {
  const entities = new Map<string, FoldedEntity>();
  let after = 0;
  let opCount = 0;
  let schemaVersion = 0;

  for (;;) {
    const page = await env.DB.prepare(
      `SELECT seq, op_id, entity, entity_id, verb, payload, actor, created_at, server_ts, schema_version
         FROM ops
        WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
        ORDER BY seq
        LIMIT ?5`,
    )
      .bind(repoId, epoch, after, cutoff, SNAPSHOT_FOLD_PAGE)
      .all<{
        seq: number;
        op_id: string;
        entity: string;
        entity_id: string;
        verb: string;
        payload: string;
        actor: string | null;
        created_at: string;
        server_ts: number;
        schema_version: number;
      }>();

    if (page.results.length === 0) break;

    opCount += page.results.length;
    if (opCount > MAX_SNAPSHOT_FOLD_OPS) {
      // The same refusal `GET /snapshot` makes, for the same reason: a truncated
      // fold is a backup that silently omits entities, and restoring one would
      // delete real data while reporting success.
      throw new SyncError("unavailable", "operation log is too large to fold in one pass", {
        maxSnapshotFoldOps: MAX_SNAPSHOT_FOLD_OPS,
      });
    }

    for (const row of page.results) {
      if (row.schema_version > schemaVersion) schemaVersion = row.schema_version;

      const key = entityKey(row.entity, row.entity_id);
      let entry = entities.get(key);
      if (!entry) {
        entry = {
          entity: row.entity,
          entityId: row.entity_id,
          version: 0,
          deletedAt: null,
          lastSeq: row.seq,
          superseded: false,
          state: {},
          fieldWrites: {},
          createdSeq: null,
          createdAt: null,
          createdBy: null,
        };
        entities.set(key, entry);
      }

      entry.version += 1;
      entry.lastSeq = row.seq;

      if (row.verb === "delete") {
        entry.deletedAt = row.server_ts;
        continue;
      }
      if (row.verb === "create") {
        if (entry.deletedAt !== null) {
          // The entity begins again (see the module comment). Nothing of the deleted one
          // survives into it: not its fields, not their provenance, not its verb.
          entry.deletedAt = null;
          entry.state = {};
          entry.fieldWrites = {};
          entry.superseded = false;
        }
        entry.createdSeq = row.seq;
        /**
         * Not a restore's own actor and instant. A restore stages every entity as a
         * `create`; when its backup kept the original creator and time (`forBackup`) it
         * stages under those, and otherwise — a backup from before this build, or a
         * restore by the Worker before it — under `restore:<id>` at the moment it ran.
         * Those say who restored and when, not who wrote the thing and when, and a device
         * dating an old comment or attributing an old revision by them rewrote the truth.
         */
        const restored = typeof row.actor === "string" && row.actor.startsWith("restore:");
        entry.createdAt = restored ? null : row.created_at;
        entry.createdBy = restored ? null : row.actor;
      }
      if (entry.deletedAt !== null) continue;

      const payload = JSON.parse(row.payload) as unknown;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        // No keys, so nothing to be authoritative about. `envelope.ts` refuses every
        // payload that is not a JSON object at ingest, arrays included (STA-262), and a
        // restore stages only folded state, which is always an object. So this is a
        // floor under a log written before that refusal existed, or edited by hand,
        // rather than a case the wire can carry. The floor is "contributes no state".
        continue;
      }

      // EVERY verb merges the keys it carried and is silent about the rest. A `replace`
      // still supersedes the collection it names, because that collection is the value
      // of a single key and the value is assigned whole — merging two plans element by
      // element would invent an order neither human asked for. What it no longer does is
      // discard `startsOn` because it happened to be talking about `members`.
      /**
       * One field, whichever spelling wrote it. Clients journaled some fields by field name
       * (`updatedAt`) and some by column (`updated_at`), and keeping both left one entity's
       * state holding a stale and a fresh value of the same field, applied in key order by a
       * hydrating device — so the stale one could win. A key's other spelling is dropped
       * when it is written, state and provenance alike, so the state holds the latest.
       */
      for (const key of Object.keys(payload as Record<string, unknown>)) {
        const other = otherSpelling(key);
        if (other !== key) {
          delete entry.state[other];
          delete entry.fieldWrites[other];
        }
      }
      Object.assign(entry.state, payload as Record<string, unknown>);
      // So the merge is the same for every verb and only the RECORD of the verb differs.
      entry.superseded = row.verb === "replace";

      /**
       * The same keys again, as provenance — for every verb EXCEPT `create` (STA-263).
       *
       * The exclusion is the fix, not an optimization. A create carries the entity's
       * whole field inventory including the defaults nobody chose, so recording it
       * would make a later edit contest a `medium` that was never a decision. It is
       * also precisely what `Journal.flush` does for a locally authored mutation, so
       * a hydrated device ends up holding the same rows a device that was present for
       * this log holds — and no others.
       *
       * `entry.version` has already been incremented for this row, so `- 1` is the
       * version the write moved off.
       */
      if (row.verb !== "create") {
        for (const field of Object.keys(payload as Record<string, unknown>)) {
          entry.fieldWrites[field] = {
            baseVersion: entry.version - 1,
            opId: row.op_id,
            at: row.created_at,
            seq: row.seq,
          };
        }
      }
    }

    after = page.results[page.results.length - 1]!.seq;
    if (page.results.length < SNAPSHOT_FOLD_PAGE) break;
  }

  const ordered = [...entities.values()].sort((a, b) =>
    entityKey(a.entity, a.entityId) < entityKey(b.entity, b.entityId) ? -1 : 1,
  );

  return { entities: ordered, opCount, schemaVersion };
}

/**
 * The operation a folded entity becomes when a restore materialises it.
 *
 * This is the inverse of the fold, and it has to be an inverse rather than an
 * approximation: re-folding the operations this produces must yield the state it was
 * given, or a restored epoch hydrates devices into something that is not what was
 * backed up.
 *
 * A tombstone materialises as a bare `delete` and drops the state the entity had
 * before it was deleted. That is not a loss — a tombstone IS the payload, the fold
 * discards later updates to a deleted entity anyway, and reproducing the corpse would
 * mean writing two operations per deleted entity for a state nothing reads.
 */
/** `updated_at` for `updatedAt` and back; a key with neither shape is its own. */
export function otherSpelling(key: string): string {
  if (key.includes("_")) return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (/[A-Z]/.test(key)) return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return key;
}

export function materializedVerb(entity: BackupEntity): {
  verb: string;
  payload: Record<string, unknown>;
} {
  if (entity.deletedAt !== null) return { verb: "delete", payload: {} };
  // The WHOLE state either way, because the fold no longer holds a `replace` apart from
  // the rest of the entity — and it must be the whole state, or a restore would emit an
  // operation that says less than the fold knew. Re-folding this yields exactly the state
  // it was given, `superseded` included, which is what makes it an inverse rather than an
  // approximation.
  //
  // `create` rather than `update` when nothing was superseded: the new epoch has no prior
  // version of anything, so an `update` would carry a `baseVersion` describing a timeline
  // that does not exist.
  return { verb: entity.superseded ? "replace" : "create", payload: entity.state };
}

/**
 * What a BACKUP stores: the fold minus this epoch's per-field provenance.
 *
 * A restore materialises these into a new epoch whose entity versions restart at zero
 * and whose operation ids are freshly minted, so `fieldWrites` would describe a
 * timeline that no longer exists — the same reason `materializedVerb` emits `create`
 * rather than `update`. Dropped here rather than ignored at the read side, so a backup
 * blob never carries bytes nothing will ever read, and so a later reader is not offered
 * provenance it would be wrong to trust.
 */
export function forBackup(entity: FoldedEntity): BackupEntity {
  const { fieldWrites: _thisEpochsProvenance, createdSeq: _thisEpochsSeq, ...rest } = entity;
  return rest;
}
