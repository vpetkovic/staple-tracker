import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 29: an idea made more complete since it was captured (design/plan.md, "Maturity moves
 * by enrichment").
 *
 * One nullable `issues` column, NULL on every row an enrichment never touched:
 *
 *   plan_explored   1 once a plan section, breakdown row, question, decision or research link
 *                   was written on the record while it was raw. Never written back to NULL.
 *
 * Its maturity reads `exploring` while the person's `plan_maturity` is still `raw`
 * (`MATURITY_READ`, plan.ts); any maturity the person sets later is read as set. It is a flag and
 * not a write of `plan_maturity` so that it converges with no conflict: two devices that enrich
 * one idea offline write the same value, and a person who shapes or drops the idea on one device
 * while an agent enriches it on another touch different fields, so the person's maturity stands
 * on every device and in both folds.
 *
 * It replicates as the `issue` field `planExplored`, left out of a create while null like the
 * plan fields (`SPARSE_ISSUE_FIELDS`). Additive and nullable; the Worker carries the payload
 * field without knowing it. A device that has not migrated refuses an operation page stamped 29
 * with `schema_ahead`, as for 20.
 */
export const migration: Migration = {
  version: 29,
  name: "plan-explored",
  up(db: DatabaseSync): void {
    db.exec(`ALTER TABLE issues ADD COLUMN plan_explored INTEGER;`);
  },
};
