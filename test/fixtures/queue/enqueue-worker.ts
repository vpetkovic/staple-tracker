/**
 * One process that enqueues issues at the HEAD of the pickup queue.
 *
 *   tsx enqueue-worker.ts <db-path> <start-at-epoch-ms> <REF,REF,…>
 *
 * Used by `store-queue.test.ts` to race two real connections at the same file
 * (STA-167). Every insert asks for position 1, so each one has to read its
 * neighbours and compute a midpoint against whatever the other process wrote a
 * moment ago — the exact window in which two writers could pick the same rank if
 * the read and the write were not inside one `BEGIN IMMEDIATE` transaction under
 * `UNIQUE (rank)`.
 *
 * It busy-waits to the shared start instant before touching SQLite so the
 * workers collide in the queue rather than politely queueing behind each other's
 * process startup, and emits one line of JSON so the parent can tell a clean run
 * from a crash.
 */
import { openDb } from "../../../src/core/db.js";
import { WorkspaceStore } from "../../../src/core/store.js";

const [path, startAt, refs] = process.argv.slice(2);
const deadline = Number(startAt);

// Spin, do not sleep: setTimeout granularity is coarse enough that the workers
// would land milliseconds apart, which is exactly the collision we want.
while (Date.now() < deadline) {
  /* spin */
}

const db = openDb(path!);
try {
  const store = new WorkspaceStore(db, "test", "TST");
  for (const ref of refs!.split(",")) {
    store.queue().enqueue(ref, { at: 1 }, `worker-${process.pid}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })}\n`,
  );
  process.exitCode = 1;
} finally {
  db.close();
}
