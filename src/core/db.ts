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

/** Run fn inside BEGIN IMMEDIATE .. COMMIT (write lock up front, no upgrade deadlocks). */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
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
