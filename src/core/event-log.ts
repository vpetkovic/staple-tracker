/**
 * One writer for the `events` table.
 *
 * There used to be four: `WorkspaceStore.emitEvent`, `MilestoneStore.emit`,
 * `QueueStore.emit` and `ProjectStore.emit`, each with its own copy of the same
 * `INSERT INTO events`. Three of the four hardcoded `NULL` for `dedup_key`, so
 * three quarters of the event table had no dedup token at all.
 *
 * That was survivable while nothing retried. `docs/sync.md` makes applying a
 * pulled operation re-emit the same local event rather than transporting the
 * `events` rows — the audit trail converges in content while each device keeps
 * its own monotonic `seq`. Re-derivation plus the `sync_applied` ledger already
 * makes double emission impossible, so a dedup key is belt and braces; but an
 * at-least-once transport writing into an unkeyed table is one retry away from a
 * duplicated timeline, and belt and braces is what you want on the table the UI
 * timeline and the timing replay both reconstruct from.
 *
 * ## Where the key comes from
 *
 * Three sources, in order:
 *
 *   1. An explicit key from the caller. `blockers_resolved` and
 *      `children_complete` are level-triggered — the same condition can be
 *      noticed many times and must produce one row — and they derive their own
 *      content keys. Those still win.
 *   2. The enclosing journal scope. Applying a remote operation derives its keys
 *      from the operation id, so a redelivered operation re-derives the same
 *      keys and `INSERT OR IGNORE` absorbs the second write. A local mutation
 *      derives from a per-scope uuid, so every event gets a stable key and two
 *      structurally identical mutations still get different ones — which is
 *      correct, because they are different events.
 *   3. Nothing, when there is no scope at all. Migrations and repair paths write
 *      no events, so in practice this is the disarmed-and-outside-a-mutation
 *      case only.
 */
import type { DatabaseSync } from "node:sqlite";
import { writeEventRow, type EventInput } from "./event-row.js";
import { journalFor } from "./journal.js";

export { EVENT_ORDER, EVENT_ORDER_DESC, writeEventRow, type EventInput } from "./event-row.js";

/**
 * Append one event.
 *
 * `INSERT OR IGNORE` plus the partial unique index on `dedup_key` is what makes
 * a repeated emission a no-op rather than a duplicate row.
 */
export function insertEvent(db: DatabaseSync, input: EventInput): void {
  const journal = journalFor(db);
  // One mutation, one instant (`Journal.mutationAt`): its events share the row's time.
  const createdAt = input.createdAt ?? journal.mutationAt();
  const originDevice = input.originDevice !== undefined ? input.originDevice : journal.deviceIdentity();
  const seq = writeEventRow(db, { ...input, createdAt, originDevice, dedupKey: input.dedupKey ?? journal.eventDedupKey(input.kind) });
  // A local event, written: the operation it belongs to carries it, with its place in this device's order.
  if (seq !== null && input.originSeq === undefined && input.issueId) {
    journal.noteEvent(input.issueId, { issueId: input.issueId, kind: input.kind, at: createdAt, actor: input.actor ?? null, seq, payload: input.payload ?? {} });
  }
}
