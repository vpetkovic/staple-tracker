import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 10 — local sync bookkeeping (contract in docs/sync.md, "The local
 * sync tables").
 *
 * ## Why 10
 *
 * Latest on master is 009 (tracked projects) and this is the next number. The
 * rule in `index.ts` still applies: if another branch merges a 010 first, this
 * one renumbers to latest+1 at merge time and never skips ahead.
 *
 * ## What this is, and what it is emphatically not
 *
 * Eight new tables and two indexes. **No existing table is altered**, no column
 * is added to any of the thirteen tables that already exist, and nothing is
 * seeded. An upgraded workspace behaves in every observable way exactly as it
 * did — the tables land empty and no code path reads them until a repository is
 * connected, which is a separate, explicit consent.
 *
 * That is a deliberate constraint rather than a happy accident. The entity
 * version could have been a `version` column on each of the eight synchronized
 * tables; it is a side table instead because it is sync metadata, not domain
 * state, and putting it beside the domain rows would drag every existing
 * schema-equivalence and fixture test into a negotiation about what an issue is.
 * Purely additive is what keeps this migration reviewable.
 *
 * **Nothing here replicates.** Every row in these tables is this device's record
 * of its own relationship to a shared log — cursors, an outbox, a dedup ledger.
 * The shared log itself lives on the server. Credentials, the user identity and
 * the device secret are not here and never will be: this database synchronizes,
 * so a credential stored in it would replicate itself to every device. They live
 * in the staple home.
 *
 * ## Why no `REFERENCES` clause anywhere
 *
 * Two independent reasons, and the second is the load-bearing one.
 *
 * The keys are polymorphic. `(entity, entity_id)` names a row in one of eight
 * tables depending on the value of `entity`, and SQLite has no way to express a
 * foreign key whose target table is chosen by a sibling column.
 *
 * And a foreign key on `sync_tombstones` would be actively wrong. `ON DELETE
 * CASCADE` would delete the tombstone in the same statement that deletes the row
 * it records, which is precisely the resurrection the tombstone exists to
 * prevent — the local row is removed only after the tombstone is durable, and
 * the tombstone has to outlive it for the compaction horizon. `ON DELETE
 * RESTRICT` would be worse still: it would make deletion impossible.
 *
 * ## The singleton, declared rather than assumed
 *
 * `sync_state` is one row. That is stated in the schema as `id INTEGER PRIMARY
 * KEY CHECK (id = 1)` rather than left to a convention in the code above it,
 * because "there is only ever one" is a constraint and a second row would make
 * every cursor read ambiguous in a way no test would necessarily catch.
 *
 * `INTEGER PRIMARY KEY` is a rowid alias, so unlike every other table here it
 * mints no `sqlite_autoindex_*` row.
 *
 * ## `client_seq_high_water` — the counter that must never be re-derived
 *
 * `sync_outbox.client_seq` is the per-row record of which allocation produced an
 * operation. It is NOT the allocator. The allocator is
 * `sync_state.client_seq_high_water`, it is bumped in the same transaction as
 * the domain write, and it is **never** computed from `MAX(client_seq)`.
 *
 * This matters more than it looks. Operation ids are deterministic — derived
 * from the repository, the epoch, the device and the client sequence — which is
 * what lets a lost acknowledgement be absorbed as a duplicate instead of
 * duplicating work. Determinism cuts both ways: an id that repeats for
 * *different* work is silently discarded by the same dedup that makes retries
 * safe.
 *
 * A counter derived from the outbox repeats. Compaction prunes acknowledged
 * rows; `MAX(client_seq)` over what remains rewinds, possibly to zero; the next
 * genuinely new mutation regenerates an id the server already holds; the server
 * answers `duplicate`; the client marks it acknowledged and moves on. Real work
 * disappears with no error anywhere, on an ordinary maintenance operation.
 *
 * So the high-water mark is persisted, monotonic, and survives an outbox that
 * has been emptied. `epoch` lives on the same single row, so the allocator can
 * read the epoch and bump the sequence in one statement against one row — which
 * is what makes an epoch-scoped operation id expressible without a second read
 * that could interleave.
 *
 * ## Indexes: two, both for reads that certainly exist
 *
 * `sync_outbox_pending_idx` serves the only question the push loop asks — "what
 * have I not had acknowledged, in allocation order" — and is partial, so it
 * costs nothing for the acknowledged rows that accumulate between compactions.
 * `sync_conflicts_open_idx` serves the same shape of question for unresolved
 * conflicts. Every other access in the contract is by primary key.
 *
 * ## What it seeds: nothing
 *
 * Not even the `sync_state` row. An unconnected workspace has no repository
 * identity to record and no cursor to hold, and writing a placeholder row would
 * make "has this workspace ever been connected" un-askable.
 */
export const migration: Migration = {
  version: 10,
  name: "sync-metadata",
  up(db: DatabaseSync): void {
    /**
     * The entity version an operation envelope carries as `baseVersion`. Bumped
     * once per journaled mutation, in the same transaction as the domain write.
     */
    db.exec(
      `CREATE TABLE sync_entity_versions (
         entity    TEXT    NOT NULL,
         entity_id TEXT    NOT NULL,
         version   INTEGER NOT NULL DEFAULT 0,
         PRIMARY KEY (entity, entity_id)
       )`,
    );

    /**
     * Operations journaled locally and not yet accepted. `acknowledged_seq` is
     * NULL until the server accepts, and holds the server-assigned `seq`
     * afterwards. `client_seq` is UNIQUE because two rows sharing one would mint
     * a single operation id for two different operations.
     */
    db.exec(
      `CREATE TABLE sync_outbox (
         op_id            TEXT    PRIMARY KEY,
         client_seq       INTEGER NOT NULL UNIQUE,
         entity           TEXT    NOT NULL,
         entity_id        TEXT    NOT NULL,
         verb             TEXT    NOT NULL,
         base_version     INTEGER,
         payload          TEXT    NOT NULL,
         actor            TEXT,
         created_at       TEXT    NOT NULL,
         acknowledged_seq INTEGER
       )`,
    );
    db.exec(
      "CREATE INDEX sync_outbox_pending_idx ON sync_outbox(client_seq) WHERE acknowledged_seq IS NULL",
    );

    /**
     * The deduplication ledger that makes re-delivery a no-op. An operation is
     * applied exactly once no matter how many times it arrives.
     */
    db.exec(
      `CREATE TABLE sync_applied (
         op_id      TEXT    PRIMARY KEY,
         seq        INTEGER NOT NULL,
         applied_at TEXT    NOT NULL
       )`,
    );

    /**
     * Deletion is a tombstone. An `update` for a tombstoned entity is a no-op
     * regardless of arrival order, which is what makes convergence
     * order-independent. Retained for the compaction horizon and no less.
     */
    db.exec(
      `CREATE TABLE sync_tombstones (
         entity     TEXT NOT NULL,
         entity_id  TEXT NOT NULL,
         deleted_at TEXT NOT NULL,
         device_id  TEXT,
         op_id      TEXT,
         PRIMARY KEY (entity, entity_id)
       )`,
    );

    /**
     * Both sides of a conflict, in full, forever. No path applies
     * last-write-wins, so a conflict is data rather than an error, and the
     * record survives its own resolution — "who chose what, and what the other
     * option was" is the only thing that makes a merged repository auditable.
     */
    db.exec(
      `CREATE TABLE sync_conflicts (
         id               TEXT PRIMARY KEY,
         entity           TEXT NOT NULL,
         entity_id        TEXT NOT NULL,
         field            TEXT NOT NULL,
         base_value       TEXT,
         local_value      TEXT,
         remote_value     TEXT,
         local_op_id      TEXT,
         remote_op_id     TEXT,
         local_device_id  TEXT,
         remote_device_id TEXT,
         local_at         TEXT,
         remote_at        TEXT,
         detected_at      TEXT NOT NULL,
         resolved_at      TEXT,
         resolved_by      TEXT,
         resolution       TEXT
       )`,
    );
    db.exec(
      "CREATE INDEX sync_conflicts_open_idx ON sync_conflicts(detected_at) WHERE resolved_at IS NULL",
    );

    /**
     * The fenced server lease behind a globally exclusive claim. The token and
     * the server expiry live here rather than as new `issues` columns, so `ls`,
     * `show` and `inbox` keep rendering the fields they already render. Client
     * clocks have no authority over `server_expires_at`.
     */
    db.exec(
      `CREATE TABLE sync_leases (
         entity_id         TEXT    PRIMARY KEY,
         fencing_token     INTEGER NOT NULL,
         holder            TEXT    NOT NULL,
         device_id         TEXT,
         server_expires_at TEXT    NOT NULL,
         acquired_at       TEXT    NOT NULL,
         renewed_at        TEXT
       )`,
    );

    /** A read cache of the server's device list. Never authoritative. */
    db.exec(
      `CREATE TABLE sync_devices (
         device_id    TEXT PRIMARY KEY,
         label        TEXT,
         last_seen_at TEXT,
         revoked_at   TEXT
       )`,
    );

    /**
     * One row. `repository_id` is what this database believes it is, which
     * `staple doctor` compares against the git-recoverable manifest at
     * `.staple/repository.json`; the two disagree exactly when a directory was
     * copied or a manifest was hand-edited.
     *
     * `client_seq_high_water` is the operation-id allocator. See the module
     * header for why it is here and not a `MAX()` over the outbox.
     */
    db.exec(
      `CREATE TABLE sync_state (
         id                    INTEGER PRIMARY KEY CHECK (id = 1),
         repository_id         TEXT,
         epoch                 INTEGER NOT NULL DEFAULT 0,
         cursor                TEXT,
         head_seq              INTEGER NOT NULL DEFAULT 0,
         client_seq_high_water INTEGER NOT NULL DEFAULT 0,
         last_sync_at          TEXT,
         bootstrap_cursor      TEXT
       )`,
    );
  },
};
