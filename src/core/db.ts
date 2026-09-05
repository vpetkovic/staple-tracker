import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * SQLite wrapper: WAL for multi-process safety on one machine, busy_timeout so
 * concurrent agent writers queue instead of erroring, foreign keys on.
 * Claims and guards are single statements or short BEGIN IMMEDIATE
 * transactions — the SQLite equivalent of the row locks a server database would
 * use for the same job.
 */
const BUSY_TIMEOUT_MS = 5_000;

/** Blocking sleep. The whole SQLite surface here is synchronous. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switch to WAL, retrying while another process holds a write transaction.
 *
 * `busy_timeout` does NOT cover this. Converting a rollback-journal database
 * to WAL needs an exclusive lock, and SQLite acquires that one without
 * consulting the busy handler — so with a concurrent writer this pragma fails
 * *instantly* (measured: 0ms, `SQLITE_BUSY`, with busy_timeout set to 5000).
 * The comment this replaced assumed arming `busy_timeout` first was enough; it
 * is enough for every other statement, and not for this one.
 *
 * It matters on the first open of a not-yet-WAL database, which is exactly the
 * case ordered migrations create: process A takes `BEGIN IMMEDIATE` to migrate
 * while processes B..F are still in `openDb`, and B..F die with a raw
 * `Error: database is locked` before any staple code gets a turn. Surfaced by
 * `migrations-concurrency.test.ts`; reproduced with plain `node:sqlite` and no
 * staple code at all, so it predates ordered migrations.
 *
 * Once any process has completed the conversion the pragma is a cheap no-op
 * for everyone else, so this loop runs at most once per database lifetime.
 */
function enableWal(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode=WAL");
      return;
    } catch (error) {
      // Retry ONLY on contention. 5 = SQLITE_BUSY, 6 = SQLITE_LOCKED; anything
      // else (corrupt file, bad permissions) must fail immediately rather than
      // be retried into a five-second stall.
      //
      // And retry only on a thrown error, never on "the pragma succeeded but
      // did not report wal". `:memory:` and temp databases legitimately report
      // `memory` here and can never be WAL, so treating a non-wal result as
      // contention makes every in-memory open block for the full budget.
      const code = (error as { errcode?: number }).errcode;
      if (code !== 5 && code !== 6) throw error;
      if (Date.now() >= deadline) throw error;
    }
    sleepSync(25);
  }
}

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // busy_timeout FIRST so every later statement queues instead of erroring.
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  enableWal(db);
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");
  return db;
}

/**
 * Savepoint names only have to be unique within one nesting stack, but a single
 * monotonic counter is simpler to reason about than a per-database one and
 * costs nothing — the number never resets, so no two live savepoints can ever
 * share a name even across databases.
 */
let savepointSeq = 0;

/** True while this connection has an open transaction, opened by anyone. */
export function inTransaction(db: DatabaseSync): boolean {
  return db.isTransaction;
}

/**
 * Run fn inside a transaction: BEGIN IMMEDIATE .. COMMIT at the outermost call,
 * SAVEPOINT .. RELEASE within one that is already open.
 *
 * ## Why it nests
 *
 * It did not use to, and that was load-bearing in the wrong direction. Callers
 * that needed to compose two mutators could not, so they ran them as separate
 * transactions and documented the resulting hole — `MilestoneStore.create`
 * ("createIssue owns its own transaction, which is why they are not one") and
 * the HTTP create route ("NOT TRANSACTIONAL WITH THE CREATE, and deliberately
 * not pretended to be") are the two worst, and both cite non-re-entrancy as the
 * reason rather than as a preference. `WorkspaceStore.atomically` existed purely
 * to work around it for the settings writers, with its own savepoint logic.
 *
 * Nesting here removes the reason and the duplicate implementation together.
 *
 * ## Why it asks SQLite rather than counting
 *
 * `db.isTransaction` is the connection's own answer, so a transaction opened by
 * anything else on this connection — the migration runner's `BEGIN IMMEDIATE`,
 * `path-migration`'s write barrier — is seen correctly. A depth counter kept
 * beside the connection would be right only about the transactions it opened
 * itself, and wrong in exactly the cases where being wrong means a `BEGIN`
 * inside a `BEGIN`.
 *
 * ## Why a failing inner call still rethrows
 *
 * `ROLLBACK TO` undoes the inner work and leaves the outer transaction open, so
 * a caller that swallowed the error would commit a mutation that half happened.
 * The error is always rethrown; the outer frame decides.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) {
    const savepoint = `staple_tx_${(savepointSeq += 1)}`;
    db.exec(`SAVEPOINT ${savepoint}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      try {
        db.exec(`ROLLBACK TO ${savepoint}`);
        db.exec(`RELEASE ${savepoint}`);
      } catch {
        // the outer transaction is already aborting; it owns the rollback
      }
      throw error;
    }
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // already rolled back (e.g. by a constraint failure aborting the txn)
    }
    throw error;
  }
}

/** Cheap cross-process change signal: bumps whenever another connection commits. */
export function dataVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA data_version").get() as { data_version: number };
  return row.data_version;
}
