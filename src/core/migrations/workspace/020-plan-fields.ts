import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 20: the plan layer (`design/plan.md`).
 *
 * Ideas and horizons are issues of the reserved kinds `idea` and `horizon`, so their title,
 * brief, parent, documents, comments, events and sync come from the issue they are. What an
 * issue cannot already say lives in eight nullable `issues` columns, meaningful on the plan
 * kinds only and NULL on every other row:
 *
 *   plan_maturity         raw | exploring | shaped | dropped (an idea's maturity)
 *   plan_horizon_id       the horizon an idea is scheduled into
 *   plan_start            YYYY-MM-DD, the start of an idea's planned window
 *   plan_target           YYYY-MM-DD, an idea's planned end, or a horizon's date
 *   plan_baseline_start   the planned window kept when the idea was started
 *   plan_baseline_target  (both written together, and reset only on request)
 *   plan_rank             the order of horizons, and of ideas inside a column
 *   plan_links            JSON array of the issue ids an idea started or adopted
 *
 * They replicate as fields of the `issue` entity (`ISSUE_FIELDS`), which every sync path
 * already folds generically. No new entity and no protocol change: the Worker carries the
 * payload fields without knowing them, and a device that has not migrated refuses a page
 * stamped 20 with `schema_ahead` until it upgrades. Additive: nothing existing is touched
 * and no row is written.
 *
 * No CHECK on `plan_maturity`: the store validates what it writes, and an applied
 * operation must never fail on a value a later build added to the vocabulary.
 */
export const migration: Migration = {
  version: 20,
  name: "plan-fields",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE issues ADD COLUMN plan_maturity TEXT;
      ALTER TABLE issues ADD COLUMN plan_horizon_id TEXT;
      ALTER TABLE issues ADD COLUMN plan_start TEXT;
      ALTER TABLE issues ADD COLUMN plan_target TEXT;
      ALTER TABLE issues ADD COLUMN plan_baseline_start TEXT;
      ALTER TABLE issues ADD COLUMN plan_baseline_target TEXT;
      ALTER TABLE issues ADD COLUMN plan_rank INTEGER;
      ALTER TABLE issues ADD COLUMN plan_links TEXT;
    `);
  },
};
