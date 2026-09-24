import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 13 — execution attempts and their transitions (contract in
 * `docs/execution-telemetry.md`, "Execution attempts" and "Where it lives and what
 * synchronizes").
 *
 * ## Why 13
 *
 * Latest is 012 (the host binding) and this is the next number. The rule in
 * `index.ts` applies: a branch that merges another 013 first makes this one renumber
 * to latest+1 at merge time.
 *
 * ## Two tables, both repository state
 *
 * `attempts` holds one row per tenure of one agent on one issue, and
 * `attempt_transitions` one immutable row per lifecycle change of one. Both replicate
 * (`attempt` and `attemptTransition` operations, protocol 3), so their columns are the
 * contract's stored fields and nothing derived: `ordinal`, `lastActivityAt`,
 * `activeSeconds`, `pausedSeconds`, `contested` and the read-time orphan end are
 * computed when read (`src/core/telemetry/attempts.ts`).
 *
 * No foreign keys. An attempt outlives its issue by design — "its issue no longer
 * exists" is the first clause of the read-time orphan rule — and a pulled
 * transition can land before a restore re-stages the attempt it names. No CHECK on
 * the enumerations either: a value from a newer build is preserved verbatim, never
 * refused (`docs/sync.md`, the unknown-field rule).
 *
 * `claim_scope` and `claim_fencing_token` are columns rather than one JSON value
 * because the orphan rule reads the scope of every stored-open attempt on every
 * read. The self-reported `harness`, `provider_binding`, `estimate_at_start` and
 * `missing` are JSON: nothing selects on them.
 *
 * ## Two columns on `sync_state`
 *
 * The stored orphan end is written only after a pull reached the head of the log,
 * and staple did not persist that fact: `hasMore` was a loop variable. The cursor at
 * which the last pull reached the head, and when, are recorded here; the condition is
 * "the cursor has not moved since", so a pull stopped part-way — or a re-bootstrap
 * that resets the cursor — clears it without a second write. `sync_state` never
 * replicates.
 *
 * ## Purely additive
 *
 * Two new tables and two nullable columns. An upgraded workspace has no attempts
 * until a mutation opens one; history from before this migration is reconstructed
 * only on request (`staple attempt reconstruct`), because a migration writes nowhere
 * near the journal seam and a reconstruction has to replicate.
 */
export const migration: Migration = {
  version: 13,
  name: "execution-attempts",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE attempts (
        id                  TEXT PRIMARY KEY,
        issue_id            TEXT NOT NULL,
        agent               TEXT NOT NULL,
        state               TEXT NOT NULL,
        outcome             TEXT,
        end_reason          TEXT,
        end_detection       TEXT,
        ended_by            TEXT,
        opened_by           TEXT NOT NULL,
        resumes_attempt_id  TEXT,
        started_at          TEXT NOT NULL,
        ended_at            TEXT,
        ended_at_source     TEXT,
        device_id           TEXT,
        claim_scope         TEXT NOT NULL,
        claim_fencing_token INTEGER,
        harness             TEXT,
        provider_binding    TEXT,
        estimate_at_start   TEXT NOT NULL,
        idempotency_key     TEXT,
        provenance          TEXT NOT NULL,
        missing             TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX attempts_issue_idx ON attempts (issue_id, started_at, id);
      CREATE INDEX attempts_stored_open_idx ON attempts (state) WHERE state <> 'ended';
      CREATE INDEX attempts_idempotency_idx ON attempts (issue_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

      CREATE TABLE attempt_transitions (
        id          TEXT PRIMARY KEY,
        attempt_id  TEXT NOT NULL,
        kind        TEXT NOT NULL,
        at          TEXT NOT NULL,
        actor       TEXT,
        detection   TEXT,
        reason      TEXT,
        detail      TEXT NOT NULL DEFAULT '{}',
        concurrency TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX attempt_transitions_attempt_idx ON attempt_transitions (attempt_id, at, id);

      ALTER TABLE sync_state ADD COLUMN head_reached_cursor TEXT;
      ALTER TABLE sync_state ADD COLUMN head_reached_at TEXT;
    `);
  },
};
