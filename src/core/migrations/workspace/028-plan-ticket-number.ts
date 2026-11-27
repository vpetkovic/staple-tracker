import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 28: the ticket number a record kept when it was converted into an idea
 * (`design/plan.md`, "Converting a ticket into an idea").
 *
 * One nullable `issues` column, NULL on every row that never was a ticket turned idea:
 *
 *   plan_ticket_number   `STA-5`, the identifier the record held as a ticket, written when it is
 *                        converted and its identifier becomes an idea number
 *
 * The converting device keeps the old number as an alias (`identifier-moves.ts`), but an alias is
 * device-local. The column is what a device that receives the conversion by sync, or hydrates long
 * after it, resolves the old number from (`WorkspaceStore.lookupRow`), as `plan_idea_number`
 * (migration 026) is for a promotion. It replicates as the `issue` field `planTicketNumber`, left
 * out of a create while null like the plan fields (`SPARSE_ISSUE_FIELDS`). The partial index serves
 * the lookup by reference and costs nothing on the rows that hold none. Additive and nullable; the
 * Worker carries the payload field without knowing it. A device that has not migrated refuses an
 * operation page stamped 28 with `schema_ahead`, as for 26.
 */
export const migration: Migration = {
  version: 28,
  name: "plan-ticket-number",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE issues ADD COLUMN plan_ticket_number TEXT;
      CREATE INDEX issues_plan_ticket_number ON issues(plan_ticket_number) WHERE plan_ticket_number IS NOT NULL;
    `);
  },
};
