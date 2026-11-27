import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 29: one plan record waits on another (`design/plan.md`, "Dependencies between records").
 *
 * One table, one row per edge: `idea_id` is the record that waits, `blocker_id` the record it
 * waits on. The blocker is not a foreign key, as a link's issue is not (`plan_links`): a device
 * may hold an edge before the record it names arrives. The blocked record owns its edges, which
 * go with it.
 *
 * ## On the wire
 *
 * Each edge is one field of the blocked record's `milestone` entity, `planBlocker.<blocker id>`,
 * whose value is `true` and whose null removes it (`plan-blockers.ts`): the shape plan links and
 * breakdown rows use, so two devices adding different edges offline write two fields and both
 * arrive, and two adding the same edge write the same value and agree. The Worker folds the
 * entity's keys without knowing them.
 *
 * ## What it costs
 *
 * Purely additive. As with every migration, the number is the `schema` every operation carries:
 * an older client refuses an operation page stamped 29 with `schema_ahead`, so no older build
 * drops an edge it cannot store.
 */
export const migration: Migration = {
  version: 29,
  name: "plan-blockers",
  up(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE plan_blockers (
        idea_id    TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
        blocker_id TEXT NOT NULL,
        PRIMARY KEY (idea_id, blocker_id)
      );
    `);
  },
};
