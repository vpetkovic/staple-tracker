/**
 * One process that opens a database and migrates it.
 *
 *   tsx migrate-worker.ts <workspace|hub> <db-path> <start-at-epoch-ms>
 *
 * Used by `migrations-concurrency.test.ts` to race several real processes at
 * the same file. It busy-waits to the shared start instant before touching
 * SQLite so the workers collide inside the migration rather than politely
 * queueing behind each other's process startup, which is what makes the race
 * real rather than theatrical.
 *
 * Emits one line of JSON on stdout so the parent can tell a clean win from a
 * clean loss from a crash.
 */
import { openDb } from "../../../src/core/db.js";
import { describeSchema, runMigrations } from "../../../src/core/migrations/runner.js";
import { WORKSPACE_TARGET } from "../../../src/core/migrations/workspace/index.js";
import { HUB_TARGET } from "../../../src/core/migrations/hub/index.js";

const [kind, path, startAt] = process.argv.slice(2);
const target = kind === "hub" ? HUB_TARGET : WORKSPACE_TARGET;
const deadline = Number(startAt);

// Spin, do not sleep: setTimeout granularity is coarse enough that workers
// would land milliseconds apart, which is exactly the collision we are trying
// to force.
while (Date.now() < deadline) {
  /* spin */
}

const db = openDb(path!);
try {
  const before = describeSchema(db, target);
  runMigrations(db, target);
  const after = describeSchema(db, target);
  process.stdout.write(
    `${JSON.stringify({ ok: true, sawVersion: before.current, endedAt: after.current })}\n`,
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      code: (error as { code?: string }).code ?? "unknown",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exitCode = 1;
} finally {
  db.close();
}
