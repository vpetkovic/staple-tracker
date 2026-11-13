import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 21: an idea delivered outside the tracker (`design/plan.md`, "Delivered outside the
 * tracker").
 *
 * One nullable `issues` column, NULL on every row the mark never touched:
 *
 *   plan_delivered_on   YYYY-MM-DD, the day the person says the record was delivered outside
 *                       the tracker; a marked record reads shipped with no ticket
 *
 * It replicates as the `issue` field `planDeliveredOn`, one of the plan fields left out of a
 * create while null (`PLAN_ISSUE_FIELDS`). The note that goes with the mark is a document on the
 * record (`delivered-note`), which synchronizes as documents already do.
 *
 * Additive and nullable, run for every workspace whatever `features.planning` says: the flag
 * gates behaviour, not schema. No new entity and no protocol change: the Worker carries the
 * payload field without knowing it. A device that has not migrated refuses an operation page
 * stamped 21 with `schema_ahead`, as for 20.
 */
export const migration: Migration = {
  version: 21,
  name: "plan-delivered",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE issues ADD COLUMN plan_delivered_on TEXT;`);
  },
};
