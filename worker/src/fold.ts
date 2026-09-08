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
 * ordered collection lives entirely under ONE key (`{ members: … }`, `{ order: … }` —
 * the only two shapes `envelope.ts` admits a `replace` for), so assigning that key's
 * value WHOLE, never merging it element-wise, already IS supersede for the collection.
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
 */

import { entityKey } from "./cursor.js";
import type { Env } from "./env.js";
import { SyncError } from "./errors.js";
import { MAX_SNAPSHOT_FOLD_OPS, SNAPSHOT_FOLD_PAGE } from "./limits.js";

export interface FoldedEntity {
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
 *
 * The tombstone wins regardless of arrival order, which is what makes convergence
 * order-independent, and it is RETURNED rather than omitted: a device handed silence
 * about a deleted entity cannot tell it from one it has never heard of. That matters
 * more for a restore than for a bootstrap, because a re-bootstrapping device keeps
 * its local rows — so an unmaterialised tombstone means a deleted issue quietly
 * coming back to life on every device that still has it.
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
      `SELECT seq, entity, entity_id, verb, payload, server_ts, schema_version
         FROM ops
        WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
        ORDER BY seq
        LIMIT ?5`,
    )
      .bind(repoId, epoch, after, cutoff, SNAPSHOT_FOLD_PAGE)
      .all<{
        seq: number;
        entity: string;
        entity_id: string;
        verb: string;
        payload: string;
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
        };
        entities.set(key, entry);
      }

      entry.version += 1;
      entry.lastSeq = row.seq;

      if (row.verb === "delete") {
        entry.deletedAt = row.server_ts;
        continue;
      }
      if (entry.deletedAt !== null) continue;

      const payload = JSON.parse(row.payload) as unknown;
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        // No keys, so nothing to be authoritative about. `envelope.ts` refuses a null or
        // non-object payload at ingest — it does admit an array, and no emitter produces
        // one for any verb — so this is a floor under a corrupted log rather than a case
        // the wire is expected to carry. The floor is "contributes no state", which is
        // what a non-object payload has always got here.
        continue;
      }

      // EVERY verb merges the keys it carried and is silent about the rest. A `replace`
      // still supersedes the collection it names, because that collection is the value
      // of a single key and the value is assigned whole — merging two plans element by
      // element would invent an order neither human asked for. What it no longer does is
      // discard `startsOn` because it happened to be talking about `members`.
      Object.assign(entry.state, payload as Record<string, unknown>);
      // So the merge is the same for every verb and only the RECORD of the verb differs.
      entry.superseded = row.verb === "replace";
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
export function materializedVerb(entity: FoldedEntity): {
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
