import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 20: the plan layer (`design/plan.md`).
 *
 * Ideas and horizons are issues of the reserved kinds `idea` and `horizon`, so their title,
 * brief, parent, documents, comments, events and sync come from the issue they are. What an
 * issue cannot already say lives in seven nullable `issues` columns, meaningful on the plan
 * kinds only and NULL on every other row:
 *
 *   plan_maturity         raw | exploring | shaped | dropped (an idea's maturity)
 *   plan_horizon_id       the horizon an idea is scheduled into
 *   plan_start            YYYY-MM-DD, the start of an idea's planned window
 *   plan_target           YYYY-MM-DD, an idea's planned end, or a horizon's date
 *   plan_baseline_start   the planned window kept when the idea was started
 *   plan_baseline_target  (both written together, and reset only on request)
 *   plan_rank             the order of horizons, and of ideas inside a column
 *
 * They replicate as fields of the `issue` entity (`ISSUE_FIELDS`). A horizon with a rank is
 * also what says planning is on in this workspace: only the plan layer writes one, so a
 * workspace that had its own `idea` or `horizon` kind before keeps every issue it had.
 *
 * `plan_links` holds one row per link from an idea to tracker work. Each row replicates as
 * its own field of the idea's `milestone` entity (`planLink.<issue id>`), the shape criterion
 * marks already use, so two devices linking different work never touch the same field and
 * both links arrive. `issue_id` has no foreign key: a link whose issue is gone (a rewind,
 * say) stays visible as missing and can still be unlinked.
 *
 * No new entity and no protocol change: the Worker carries the payload fields without knowing
 * them. A device that has not migrated refuses an operation page stamped 20 with
 * `schema_ahead`; the snapshot route checks the protocol only, so an older build hydrating
 * from a snapshot drops these fields. Mixed old and new builds on one repository are out of
 * scope for this layer.
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
      CREATE INDEX issues_plan_ranked_idx ON issues(kind) WHERE plan_rank IS NOT NULL;
      CREATE TABLE plan_links (
        idea_id   TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        issue_id  TEXT NOT NULL,
        linked_by TEXT NOT NULL,
        linked_at TEXT NOT NULL,
        PRIMARY KEY (idea_id, issue_id)
      );
    `);
  },
};
