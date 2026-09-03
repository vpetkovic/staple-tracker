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
 *
 * ## Why this migration also writes a ROW
 *
 * `awaiting_approval` is not a hard-coded status. Since 004 the vocabulary is
 * data in `workspace_statuses`, and the gate's semantics come from the row's
 * CATEGORY — `gated` — not from its id. So the status has to EXIST as a row, and
 * there are two ways a database can come by it:
 *
 *  - A database created after this merge gets it from `BUILTIN_STATUS_SEED`,
 *    which migration 004 writes on the walk path and `schema.ts` writes on the
 *    consolidated fresh-create path. By the time the walk reaches 006 the row is
 *    already there and `seedGatedStatus` finds nothing to do.
 *  - A database stamped 4 or 5 BEFORE this merge ran 004 against the older seed,
 *    which had no `awaiting_approval` in it, and 004 will never run again. This
 *    is the only thing that can repair it, and it is why the insert lives here
 *    rather than being left to the seed alone.
 *
 * The insert is guarded on the id, not on a count. The count guard 004 uses
 * answers "were these tables just created", which is the right question for a
 * whole vocabulary; the right question for ONE row that has never existed before
 * is "is it there already", and at 5 -> 6 nobody can yet have removed it. After
 * this migration `removeStatus` may drop it like any other row, and nothing
 * grows it back.
 *
 * Position: immediately after `in_review`, which is where it sits in the life of
 * a ticket. `sort_order` is spaced by ten (see 004), so `in_review + 5` is a free
 * slot that needs no rewrite of the neighbours. A workspace that renamed
 * `in_review` away has no such anchor, so the row lands just before the first
 * resolved status instead, and failing even that, at the end — order is a
 * display decision and any of the three is coherent.
 */
/** The category whose members mean "parked behind a human review gate". */
const GATED_CATEGORY = "gated";

/**
 * Give a database that predates the built-in seed's `awaiting_approval` row the
 * row it never got. A no-op everywhere else. See the header for why.
 */
export function seedGatedStatus(db: DatabaseSync): void {
  const present = db
    .prepare("SELECT id FROM workspace_statuses WHERE id = ?")
    .get("awaiting_approval");
  if (present) return;

  const anchor = db
    .prepare("SELECT sort_order AS o FROM workspace_statuses WHERE id = ?")
    .get("in_review") as { o: number } | undefined;
  const firstResolved = db
    .prepare(
      `SELECT MIN(sort_order) AS o FROM workspace_statuses
        WHERE category IN ('done', 'cancelled')`,
    )
    .get() as { o: number | null } | undefined;
  const last = db.prepare("SELECT MAX(sort_order) AS o FROM workspace_statuses").get() as
    | { o: number | null }
    | undefined;

  const sortOrder =
    anchor !== undefined
      ? anchor.o + 5
      : firstResolved?.o != null
        ? firstResolved.o - 5
        : (last?.o ?? 0) + 10;

  db.prepare(
    `INSERT INTO workspace_statuses (id, label, category, sort_order, is_builtin)
     VALUES (?, ?, ?, ?, 1)`,
  ).run("awaiting_approval", "Awaiting Approval", GATED_CATEGORY, sortOrder);
}

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
    // The status the gate parks a parent in has to exist as a configured row.
    seedGatedStatus(db);
  },
};
