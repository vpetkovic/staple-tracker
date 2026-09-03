import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 6 — approval gates (STA-143).
 *
 * ## Why 6 and not 4
 *
 * This number has moved twice, and that history is the argument for where it
 * landed. It shipped as 006 first, holding 004 and 005 open for a
 * concurrently-developed epic. That reservation was withdrawn once master's
 * latest was 003 and the other epic had posted no migration: there was nothing
 * to reserve for, and a gap bought nothing. So it came back to 004.
 *
 * It is 006 again now, for a reason the earlier correction did not have
 * available. The other epic HAS posted its migrations. The O integration branch
 * carries 004-workspace-settings and 005-issue-kind, and the tracker database is
 * already stamped 5 by them. This epic merges AFTER that branch, so its
 * migration takes latest+1 = 6. The sequence is contiguous in MERGE ORDER, which
 * is the only order that matters — a number is not reserved by being written
 * down, it is earned by the merge that precedes it.
 *
 * Why contiguity is not bookkeeping: `applyPending` filters `version > current`
 * and the `meta` stamp is MONOTONIC, so a database that walks to 6 can never
 * afterwards receive a 4 or a 5. A hole in the sequence is not "unused space" —
 * it is space that becomes permanently unreachable for every database that steps
 * over it. Merge after the O integration branch (004 workspace settings, 005
 * issue kind); a database that steps over 004/005 never receives them.
 *
 * The rule that follows: **whichever epic merges second renumbers its migration
 * to latest+1 at merge time; never skip ahead.** Two branches may not both claim
 * a number, and neither may skip one to avoid the collision.
 *
 * ## Why columns on `issues` and not a `gates` table
 *
 * A gate is at most one per issue and its whole life is a state field plus two
 * (who, when) pairs. A side table would buy nothing but a join on the hottest
 * read in the system — `queuedByFor` walks ancestors on every list, inbox and
 * checkout — and would let a row exist with two gates, which is a state the
 * model has no meaning for.
 *
 * ## Nullability
 *
 * Every gate column except `gate_released` is nullable with no DEFAULT, so every
 * row that predates this migration reads as "no gate was ever requested" rather
 * than as a gate in some invented state. `gate_released` is the exception: it is
 * a boolean about a gate that does not exist yet, and "not released" is the
 * honest reading of that for every existing row, so `NOT NULL DEFAULT 0` is
 * correct rather than convenient. SQLite allows a NOT NULL add-column precisely
 * when a non-null default is supplied, which is the case here.
 *
 * `ALTER TABLE ADD COLUMN` appends to the stored `CREATE TABLE issues` text
 * rather than rewriting it, exactly as 002 and 003 did. The regenerated
 * consolidated snapshot carries that appended tail verbatim, which is what keeps
 * the fresh-create fast path byte-equivalent to the walk.
 */
export const migration: Migration = {
  version: 6,
  name: "approval-gates",
  up(db: DatabaseSync): void {
    // Life of the gate: null | pending | approved | changes_requested.
    db.exec("ALTER TABLE issues ADD COLUMN gate_state TEXT");
    // Who has to act. Recorded once at gate time and kept through resolution,
    // so a resolved gate can still say who it was waiting on.
    db.exec("ALTER TABLE issues ADD COLUMN gate_owner TEXT");
    db.exec("ALTER TABLE issues ADD COLUMN gate_requested_by TEXT");
    db.exec("ALTER TABLE issues ADD COLUMN gate_requested_at TEXT");
    db.exec("ALTER TABLE issues ADD COLUMN gate_resolved_by TEXT");
    db.exec("ALTER TABLE issues ADD COLUMN gate_resolved_at TEXT");
    /**
     * Per-CHILD release, on the child. Granular approval releases named children
     * one at a time while the parent stays parked, so the flag has to live where
     * the decision applies — a list of released refs on the parent would need
     * parsing on every ancestor walk and could name rows that no longer exist.
     */
    db.exec("ALTER TABLE issues ADD COLUMN gate_released INTEGER NOT NULL DEFAULT 0");
    /**
     * Partial, so it indexes only the handful of rows that ever hold a gate
     * rather than every issue in the workspace. This is the "what needs a human"
     * query — the Pending approval section (STA-144) and any future human action
     * center read it directly.
     */
    db.exec(
      `CREATE INDEX issues_gate_state_idx
         ON issues(gate_state) WHERE gate_state IS NOT NULL`,
    );
  },
};
