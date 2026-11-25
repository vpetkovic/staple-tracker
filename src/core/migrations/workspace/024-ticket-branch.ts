import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 24: the branch a ticket is worked on (`src/core/ticket-branch.ts`).
 *
 * Two nullable `issues` columns, NULL on every row nobody set them on:
 *
 *   branch        the git branch the work lives on, as `git` names it (`feat/x`)
 *   base_commit   the commit that branch was cut from, abbreviated or full hex
 *
 * They replicate as the `issue` fields `branch` and `baseCommit`, left out of a create while
 * null like the plan fields (`SPARSE_ISSUE_FIELDS`). The pull requests opened for the branch
 * are not here: they are links in the integrations link store (migration 022), the one
 * record of a ticket's pull requests.
 *
 * Additive and nullable. No new entity and no protocol change: the Worker carries the payload
 * fields without knowing them. A device that has not migrated refuses an operation page
 * stamped 24 with `schema_ahead`, as for 20.
 */
export const migration: Migration = {
  version: 24,
  name: "ticket-branch",
  up(db: DatabaseSync): void {
    db.exec(`
      ALTER TABLE issues ADD COLUMN branch TEXT;
      ALTER TABLE issues ADD COLUMN base_commit TEXT;
    `);
  },
};
