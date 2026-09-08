/**
 * Folding the operation log into per-entity state.
 *
 * This is the same computation `snapshot.ts` performs on read, extracted because a
 * BACKUP is exactly that fold, persisted. A backup computed by a different rule from
 * the one `GET /snapshot` uses would restore into an epoch that hydrates differently
 * from the way it was captured, and the difference would only ever be discovered by
 * whoever was relying on the backup.
 *
 * ## Why this is a new file rather than an export from `snapshot.ts`
 *
 * `snapshot.ts` is owned by another lane this wave and is explicitly not to be edited
 * here. Duplicating a fold is a real cost and it is recorded as one: when that lane
 * lands, `snapshot.ts` should import `foldLog` from here and delete its private
 * `fold`. The two are deliberately written to produce the same state for the same log
 * so that the refactor is a deletion rather than a reconciliation, and
 * `worker/test/backups.test.ts` pins that equivalence against the live `/snapshot`
 * route so it cannot quietly drift in the meantime.
 *
 * ## The one field this fold has that the snapshot's does not
 *
 * `superseded`. The snapshot represents a `replace` by setting the state to
 * `{ replaced: payload }`, which is unambiguous to a hydrating client because a
 * client never has to turn it back into an operation. A restore does, and inferring
 * "was this a replace?" from the shape of the state means guessing about an entity
 * whose only field happens to be called `replaced`. Guessing about that is how a
 * plan comes back as an object with a `replaced` key instead of as a plan, so the
 * verb is recorded at fold time instead of being reconstructed at restore time.
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
  /** True when the last surviving write was a `replace`. See the module comment. */
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
 *   replace                — supersede the state wholesale (ordered collections only)
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
      if (row.verb === "replace") {
        // Ordered collections replicate whole. Merging two plans would invent an
        // order neither human asked for, so a replace supersedes rather than merges.
        entry.state = { replaced: payload } as Record<string, unknown>;
        entry.superseded = true;
      } else if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
        Object.assign(entry.state, payload as Record<string, unknown>);
        entry.superseded = false;
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
export function materializedVerb(entity: FoldedEntity): {
  verb: string;
  payload: Record<string, unknown> | unknown;
} {
  if (entity.deletedAt !== null) return { verb: "delete", payload: {} };
  if (entity.superseded) return { verb: "replace", payload: entity.state.replaced };
  // `create` rather than `update`: the new epoch has no prior version of anything, so
  // an `update` would carry a `baseVersion` describing a timeline that does not exist.
  return { verb: "create", payload: entity.state };
}
