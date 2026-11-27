import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 26: the number an idea keeps once it is promoted (`src/core/idea-numbers.ts`,
 * design/plan.md, "Idea numbers").
 *
 * One nullable `issues` column, NULL on every row that never was an idea:
 *
 *   plan_idea_number   `I-<PREFIX>-<n>`, the number the record held as an idea, written when it
 *                      is promoted (or scaffolded) and its identifier becomes the ticket number
 *
 * An unpromoted idea holds its number as its identifier, so it needs no column. It replicates
 * as the `issue` field `planIdeaNumber`, left out of a create while null like the plan fields
 * (`SPARSE_ISSUE_FIELDS`). The partial index serves the lookup of a kept number by reference
 * (`WorkspaceStore.lookupRow`) and costs nothing on the rows that hold none.
 *
 * The numbering of ideas that predate it is not here: a migration journals nothing, and every
 * device must read the same numbers, so the plan layer numbers them through ordinary journaled
 * writes (`PlanStore.numberIdeas`). Additive and nullable; the Worker carries the payload field
 * without knowing it. A device that has not migrated refuses an operation page stamped 26 with
 * `schema_ahead`, as for 20.
 */
export const migration: Migration = {
  version: 26,
  name: "idea-numbers",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE issues ADD COLUMN plan_idea_number TEXT;
      CREATE INDEX issues_plan_idea_number ON issues(plan_idea_number) WHERE plan_idea_number IS NOT NULL;
    `);
  },
};
