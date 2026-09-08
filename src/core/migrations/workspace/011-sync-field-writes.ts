import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 11 — field-write provenance (contract in docs/sync.md, "Conflicts are
 * preserved, never resolved silently").
 *
 * ## Why 11
 *
 * Latest is 010 (the local sync tables) and this is the next number. The rule in
 * `index.ts` still applies: if another branch merges an 011 first, this one
 * renumbers to latest+1 at merge time and never skips ahead.
 *
 * ## The question this table exists to answer
 *
 * Conflict detection asks *"which fields of this entity have been written since
 * the version the sender claims as its base?"*. Before this table the answer was
 * read off `sync_outbox`, and the outbox cannot answer it — twice over, both in
 * ordinary use:
 *
 *   - **A relayed value has no outbox row.** A device that *applied* another
 *     device's `title` journaled nothing, so it holds no row naming `title`, and
 *     silently accepted the next stale `title` to arrive.
 *   - **The outbox is transient.** `compact()` prunes acknowledged rows as
 *     routine housekeeping, and the moment it does, even the device that AUTHORED
 *     the value stops being able to defend it.
 *
 * **Detection that expires with housekeeping is not detection.** STA-260 proved
 * both failures for ordered collections and closed them there by dropping the
 * field condition entirely, which is sound for a collection because it
 * replicates as ONE pseudo-field carrying the whole list. A scalar entity has
 * disjoint field sets to protect: dropping the field condition there would make
 * one device's `priority` edit contest another's `estimate`, and *"Disjoint field
 * sets are not a conflict"* is a guarantee, not a nicety. So the fix cannot be to
 * ask less. It has to be to record what `sync_applied` never did — WHICH FIELDS
 * an applied operation touched.
 *
 * ## Why one row per field and not one row per write
 *
 * A log of every field write would grow with history and would therefore need a
 * horizon, and a horizon is the thing that just failed. This keeps only the
 * NEWEST write per `(entity, entity_id, field)`, which is exactly what detection
 * needs and no less: "there exists a local write of this field at
 * `base_version >= X`" is true precisely when the newest such write is at
 * `base_version >= X`, because `base_version` increases monotonically with every
 * operation on the entity.
 *
 * The consequence is the load-bearing one. The row count is bounded by *live
 * entities × fields ever written*, which is the size of the data itself and not
 * of its history, so **nothing time-based ever has to prune this table.** That is
 * what makes the evidence outlive housekeeping rather than merely postpone the
 * bug. `compact()` deletes rows only for entities that already carry a tombstone,
 * and an update to a tombstoned entity is a no-op regardless of arrival order —
 * so those rows could never have been the evidence for any conflict.
 *
 * ## `field` holds the payload key, not the column
 *
 * The wire name, exactly as the operation spelled it — `estimatedSeconds`, not
 * `estimated_seconds`. Two reasons. The writers are `Journal.flush` and the apply
 * path, and neither should have to know the column mapping that lives in
 * `apply.ts`; canonicalization is the reader's job because the reader is where
 * the policy about derived and bookkeeping fields already lives. And a field a
 * *newer* build sends that this one cannot place is still recorded, so an
 * upgraded database can defend it retroactively instead of having lost the
 * evidence while the two builds were mixed.
 *
 * A field may therefore legitimately appear under two spellings; the reader takes
 * the highest `base_version` among the rows that canonicalize to one name, which
 * is the same `MAX` it would take anyway.
 *
 * ## Purely additive, and backfilled from what still survives
 *
 * No existing table is altered. One table, one autoindex for its composite
 * primary key, no secondary index — every read is `(entity, entity_id)` prefixed,
 * which the primary key already serves.
 *
 * The backfill replays `sync_outbox` in allocation order so the last write wins,
 * which reconstructs every attribution an upgraded database can still prove. It
 * cannot recover what compaction already pruned, and it does not pretend to:
 * fields whose rows are gone simply have no provenance until the next write. An
 * unconnected workspace has an empty outbox and gets an empty table, so the
 * upgrade is observably nothing there — which is the same posture 010 took.
 */
export const migration: Migration = {
  version: 11,
  name: "sync-field-writes",
  up(db: DatabaseSync): void {
    /**
     * The newest write of one field of one entity, whoever made it.
     *
     * `base_version` is the entity version the write moved OFF — the same number
     * `sync_outbox.base_version` holds for a local operation, so the comparison
     * in `screenForConflicts` reads identically for a field this device authored
     * and one it relayed.
     *
     * `op_id` and `device_id` are nullable because the write may predate this
     * table (the backfill has op ids but a pre-011 database has no record of
     * which device applied what) — and because attribution is a nicety, while
     * the version comparison is the detection.
     */
    db.exec(
      `CREATE TABLE sync_field_writes (
         entity       TEXT    NOT NULL,
         entity_id    TEXT    NOT NULL,
         field        TEXT    NOT NULL,
         base_version INTEGER NOT NULL,
         op_id        TEXT,
         device_id    TEXT,
         written_at   TEXT    NOT NULL,
         PRIMARY KEY (entity, entity_id, field)
       )`,
    );

    /**
     * Backfill from the outbox, oldest first so the newest write lands last.
     *
     * `base_version IS NOT NULL` excludes creates, exactly as the detection query
     * it replaces did: a create carries no base version and cannot be one of "the
     * operations in between".
     */
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

    for (const row of rows) {
      let payload: unknown;
      try {
        payload = JSON.parse(row.payload);
      } catch {
        // A payload this build cannot parse is not worth failing an upgrade over.
        continue;
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
      for (const field of Object.keys(payload as Record<string, unknown>)) {
        insert.run(row.entity, row.entity_id, field, row.base_version, row.op_id, row.created_at);
      }
    }
  },
};
