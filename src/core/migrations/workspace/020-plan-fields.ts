import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 20: the plan layer (`design/plan.md`).
 *
 * An idea is an issue of the reserved kind `idea` until it is promoted in place into an epic;
 * a horizon is a milestone that the plan shows as a column. Title, brief, parent, documents,
 * comments, events and sync come from the issue they are. What an issue cannot already say
 * lives in seven nullable `issues` columns, NULL on every row the plan never wrote:
 *
 *   plan_maturity         raw | exploring | shaped | dropped; set on every plan record, promoted or not
 *   plan_horizon_id       the horizon (milestone) a plan record is scheduled into
 *   plan_start            YYYY-MM-DD, the start of a plan record's planned window
 *   plan_target           YYYY-MM-DD, its planned end
 *   plan_baseline_start   the planned window kept when it was started
 *   plan_baseline_target  (both written together, and reset only on request)
 *   plan_rank             the order of horizons, and of plan records inside a column
 *
 * They replicate as fields of the `issue` entity (`ISSUE_FIELDS`). A milestone with a rank is a
 * horizon, and is also what says planning is on in this workspace: only the plan layer writes
 * one, so a workspace that had its own `idea` kind before keeps every issue it had.
 *
 * An unpromoted idea holds a draft identifier, `~` and its UUID's hex (`plan.ts`), and never a
 * ticket number: promotion takes the next number then.
 *
 * `plan_members` is this device's own: one row per issue a horizon holds through the plan (a
 * promoted record on the horizon, and the work its records link), rebuilt from the synced
 * fields above by one deterministic function on every device and never journaled. Readers of
 * a milestone's membership union it with `milestone_members`.
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
      CREATE TABLE plan_members (
        issue_id     TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
        milestone_id TEXT    NOT NULL    REFERENCES issues(id) ON DELETE CASCADE,
        position     INTEGER NOT NULL
      );
      CREATE INDEX plan_members_milestone_idx ON plan_members(milestone_id, position);
    `);
  },
};
