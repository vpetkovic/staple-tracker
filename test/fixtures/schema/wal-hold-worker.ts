/**
 * Holds a write transaction on a NOT-yet-WAL database for a while.
 *
 *   tsx wal-hold-worker.ts <db-path> <hold-ms>
 *
 * Deliberately does not use `openDb`: the point is to reproduce the state
 * `openDb` has to survive — another process mid-write on a rollback-journal
 * file — without also converting the file to WAL itself.
 *
 * Prints "holding" once the lock is taken so the parent knows when to race it.
 */
import { DatabaseSync } from "node:sqlite";

const [path, holdMs] = process.argv.slice(2);
const db = new DatabaseSync(path!);
db.exec("PRAGMA busy_timeout=5000");
db.exec("CREATE TABLE IF NOT EXISTS holder (a)");
db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT INTO holder VALUES (1)").run();
process.stdout.write("holding\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(holdMs));
db.exec("COMMIT");
db.close();
