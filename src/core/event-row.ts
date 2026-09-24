/**
 * The `events` table's one writer, with no journal behind it (`event-log.ts` resolves a key
 * from the journal scope and calls in here).
 */
import type { DatabaseSync } from "node:sqlite";
import { inTransaction } from "./db.js";
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
  /**
   * When the event happened, for one whose time is a replicated fact rather than now: an
   * attempt transition carries its own `at`, and an applied one is dated by it, never by
   * the apply (`telemetry/attempts.ts`). Absent means now.
   */
  readonly createdAt?: string;
}

/**
 * The one `INSERT INTO events`, for a caller that already holds its key.
 *
 * Split from {@link insertEvent} for the applier: an applied attempt transition re-emits its
 * event under its own transition-derived key (`telemetry/attempt-records.ts`), and the path
 * from the applier to the journal is a module cycle (`journal.ts` → `cloud/row-diff.ts` →
 * `cloud/apply.ts`). This half needs no journal, so the table still has one writer.
 */
export function writeEventRow(db: DatabaseSync, input: EventInput & { readonly dedupKey: string | null }): void {
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
  db.prepare(
    `INSERT OR IGNORE INTO events (kind, issue_id, actor, payload, dedup_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    input.kind,
    input.issueId ?? null,
    input.actor ?? null,
    JSON.stringify(input.payload ?? {}),
    input.dedupKey,
    input.createdAt ?? nowIso(),
  );
}
