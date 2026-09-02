/**
 * Runs one path migration in its own process, so a test can kill it.
 *
 * Crash recovery cannot be proven from inside the test process. A thrown error
 * unwinds through `finally`, which releases the SQLite barrier, closes handles
 * and tidies temporary files — the exact cleanup a real crash does not perform.
 * `STAPLE_MIGRATE_CRASH_AT=<state>` makes the runner SIGKILL itself the instant
 * that journal transition is durable, and only a separate process can survive
 * being on the receiving end of that.
 *
 * Usage: migrate-child.ts <root>
 * Prints one line of JSON on success or on a handled StapleError; prints
 * nothing at all when it is killed.
 */
import { runMigration } from "../../src/core/path-migration.js";
import { StapleError } from "../../src/core/types.js";

const root = process.argv[2];
if (!root) {
  console.error("usage: migrate-child.ts <root>");
  process.exit(64);
}

try {
  console.log(JSON.stringify({ ok: true, result: runMigration(root) }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      code: error instanceof StapleError ? error.code : "unknown",
      message: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exitCode = 1;
}
