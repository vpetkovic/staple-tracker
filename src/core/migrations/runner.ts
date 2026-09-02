import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db.js";
import { StapleError } from "../types.js";
import {
  UNVERSIONED_BASELINE,
  latestVersion,
  type MigrationTarget,
  type SchemaState,
} from "./types.js";

function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return row !== undefined;
}

function readStampedVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, "meta")) return null;
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) return null;
  // CAST, not parseInt: match the comparison SQLite itself does in the stamp
  // guard below, so a value this code accepts is a value that guard can order.
  const version = Number.parseInt(row.value, 10);
  return Number.isFinite(version) ? version : null;
}

/**
 * Where an unfamiliar file sits on the migration list.
 *
 * The sentinel table is the fresh/legacy discriminator: a database created by
 * `openDb` and nothing else has no tables at all, while a pre-versioning
 * database has the sentinel and no usable `schema_version`. Today's hub is the
 * second case — `migrateHub` never wrote a version of any kind.
 */
export function describeSchema(db: DatabaseSync, target: MigrationTarget): SchemaState {
  const latest = latestVersion(target);
  let current: number;
  let detection: SchemaState["detection"];

  if (!tableExists(db, target.sentinelTable)) {
    current = 0;
    detection = "empty";
  } else {
    const stamped = readStampedVersion(db);
    if (stamped === null) {
      current = UNVERSIONED_BASELINE;
      detection = "unstamped";
    } else {
      current = stamped;
      detection = "stamped";
    }
  }

  const pending = target.migrations
    .filter((m) => m.version > current)
    .map((m) => m.version)
    .sort((a, b) => a - b);

  return { current, latest, pending, detection };
}

/**
 * Refuse a database stamped newer than this build understands.
 *
 * `conflict` (exit 4) rather than `validation` (exit 2): nothing the caller
 * typed is wrong — the state on disk is ahead of the code. Refusal has to
 * happen before any write, which is why this runs on the cheap read outside
 * the transaction as well as on the authoritative read inside it.
 */
function assertNotNewer(state: SchemaState, target: MigrationTarget, path: string): void {
  if (state.current <= state.latest) return;
  throw new StapleError(
    "conflict",
    `This ${target.label} (${path}) was created by a newer version of staple ` +
      `(schema version ${state.current}; this build understands ${state.latest}). ` +
      `Upgrade staple to open it — an older build must not write to it.`,
  );
}

/** Best-effort filename for error messages; ":memory:" and temp dbs are fine. */
function databasePath(db: DatabaseSync): string {
  try {
    const row = db.prepare("PRAGMA database_list").get() as { file?: string } | undefined;
    return row?.file && row.file.length > 0 ? row.file : ":memory:";
  } catch {
    return "<unknown>";
  }
}

/**
 * Stamp `meta.schema_version`.
 *
 * TEXT, and this exact guard, on purpose. `characterize-layout.test.ts` pins
 * `{ key: "schema_version", value: "2" }` as a string, and an older binary
 * compares with `CAST(meta.value AS INTEGER)` — so the representation has to
 * stay readable by code we have already shipped. The `WHERE` clause makes the
 * stamp monotonic: it can raise a version, never lower one.
 */
function stamp(db: DatabaseSync, version: number): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value
     WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER)`,
  ).run(String(version));
}

function applyPending(db: DatabaseSync, target: MigrationTarget, from: number): void {
  const pending = target.migrations
    .filter((m) => m.version > from)
    .sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    const savepoint = `staple_mig_${migration.version}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      migration.up(db);
      // Stamp inside the migration's own savepoint so the recorded version and
      // the schema it describes commit or roll back as one unit.
      stamp(db, migration.version);
      db.exec(`RELEASE ${savepoint}`);
    } catch (error) {
      // Undo just this migration's partial work, then let the outer
      // BEGIN IMMEDIATE roll the whole run back. Naming the migration is the
      // point: without it a failure reports a bare SQLite message with no clue
      // which step produced it.
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch {
        // transaction already aborted by the failure itself
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new StapleError(
        "conflict",
        `Migration ${String(migration.version).padStart(3, "0")}-${migration.name} failed ` +
          `on this ${target.label}; no changes were applied: ${detail}`,
      );
    }
  }
}

/**
 * Bring a database up to `target`'s latest version.
 *
 * Concurrency: the `BEGIN IMMEDIATE` here is the cross-process guard the old
 * probe-based `migrateWorkspace` carried, and it works the same way. Two
 * processes racing the first open of an old database both want the write lock;
 * the loser blocks on it (`openDb` arms `busy_timeout` before any of this
 * runs), and when it finally gets in it RE-READS the version inside its own
 * transaction and finds the work already done. The old code re-probed for a
 * column at this point; this one re-reads the version, which is the same
 * property applied to the whole schema rather than one column.
 *
 * The read before the transaction is a pure optimisation — it is safe only
 * because it is re-checked under the lock. It keeps every already-current open
 * (which is nearly all of them) from taking an exclusive lock just to discover
 * there is nothing to do.
 */
export function runMigrations(db: DatabaseSync, target: MigrationTarget): void {
  const path = databasePath(db);

  const probe = describeSchema(db, target);
  assertNotNewer(probe, target, path);
  if (probe.current === probe.latest) return;

  tx(db, () => {
    const state = describeSchema(db, target);
    assertNotNewer(state, target, path);
    if (state.current === state.latest) return; // lost the race; winner did it

    if (state.detection === "empty") {
      // Fresh-create fast path. Provably no tables, so the consolidated dump —
      // which carries no IF NOT EXISTS — cannot collide with anything, and the
      // equivalence test proves it lands on the same schema the walk produces.
      db.exec(target.consolidated);
    } else {
      applyPending(db, target, state.current);
    }

    // The walk already stamped each step; this is the fresh path's only stamp,
    // and a harmless monotonic no-op after a walk.
    stamp(db, state.latest);
  });
}
