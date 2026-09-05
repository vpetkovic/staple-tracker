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
import { inTransaction } from "./db.js";
import { journalFor } from "./journal.js";
import { nowIso } from "./types.js";

export interface EventInput {
  readonly kind: string;
  readonly issueId?: string | null;
  readonly actor?: string | null;
  readonly payload?: Record<string, unknown>;
  /**
   * An explicit, content-derived key for a level-triggered event. Absent means
   * "derive one from the enclosing mutation"; explicit `null` is not a way to
   * ask for no key, because obligation 6 does not have an opt-out.
   */
  readonly dedupKey?: string | null;
}

/**
 * Append one event.
 *
 * `INSERT OR IGNORE` plus the partial unique index on `dedup_key` is what makes
 * a repeated emission a no-op rather than a duplicate row.
 */
export function insertEvent(db: DatabaseSync, input: EventInput): void {
  /**
   * Obligation 1 made structural instead of merely tested.
   *
   * Every domain event accompanies a domain write, so an event emitted outside a
   * transaction is a mutation that was not in one — and that is the failure this
   * whole lane exists to remove, in the form it is easiest to reintroduce by
   * accident: a new mutator that forgets to wrap itself. There is no legitimate
   * caller, so this throws rather than warns.
   */
  if (!inTransaction(db)) {
    throw new Error(
      `insertEvent(${input.kind}) outside a transaction. Every event accompanies a domain write, ` +
        `so its mutation must run inside WorkspaceStore.journaled().`,
    );
  }
  const dedupKey = input.dedupKey ?? journalFor(db).eventDedupKey(input.kind);
  db.prepare(
    `INSERT OR IGNORE INTO events (kind, issue_id, actor, payload, dedup_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.kind,
    input.issueId ?? null,
    input.actor ?? null,
    JSON.stringify(input.payload ?? {}),
    dedupKey,
    nowIso(),
  );
}
