/**
 * One process that tries to claim the HEAD of the pickup queue under
 * `queue.policy = strict`.
 *
 *   tsx checkout-worker.ts <db-path> <agent> <start-at-epoch-ms> <REF> [reorder-to] [override-reason]
 *
 * Used by `queue-concurrency.test.ts` (STA-168) to race two real connections at
 * the same file. `checkoutIssue` computes the strict next-item check and writes
 * the claiming UPDATE inside ONE `BEGIN IMMEDIATE` transaction, which is what
 * has to make "two agents both passed the same next-item check" impossible:
 * whoever loses the race sees the row as claimed and gets a `conflict`, or is
 * handed the second row and gets `out_of_order` for asking for the first.
 *
 * With `reorder-to` the process moves that identifier to plan position 1 instead
 * of claiming anything, which is how the reorder-versus-checkout race is set up.
 * With an `override-reason` (and an empty `reorder-to`) it claims `REF` out of
 * turn, which is how the human-override-versus-checkout race is set up: an
 * override skips ONLY the order check, so it must still lose an ordinary
 * `conflict` to whoever claimed the same row first.
 *
 * It busy-waits to the shared start instant before touching SQLite so the
 * workers collide in the store rather than politely queueing behind each other's
 * process startup, and emits one line of JSON so the parent can tell a clean
 * claim from a refusal from a crash.
 */
import { openDb } from "../../../src/core/db.js";
import { WorkspaceStore } from "../../../src/core/store.js";
import { StapleError } from "../../../src/core/types.js";

const [path, agent, startAt, ref, reorderTo, overrideReason] = process.argv.slice(2);
const deadline = Number(startAt);

// Spin, do not sleep: setTimeout granularity is coarse enough that the workers
// would land milliseconds apart, which is exactly the collision we want.
while (Date.now() < deadline) {
  /* spin */
}

const db = openDb(path!);
try {
  const store = new WorkspaceStore(db, "test", "TST");
  if (reorderTo) {
    store.queue().move(reorderTo, { at: 1 }, agent!);
    process.stdout.write(`${JSON.stringify({ outcome: "reordered", identifier: reorderTo })}\n`);
  } else {
    const issue = store.checkoutIssue(ref!, agent!, undefined, {
      overrideReason: overrideReason || undefined,
    });
    process.stdout.write(`${JSON.stringify({ outcome: "claimed", identifier: issue.identifier })}\n`);
  }
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({
      outcome: "refused",
      code: error instanceof StapleError ? error.code : "unknown",
      message: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
} finally {
  db.close();
}
