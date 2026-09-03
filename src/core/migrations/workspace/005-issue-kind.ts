import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 5 — every issue declares a KIND (STA-124, O1a).
 *
 * Migration 004 made the kind vocabulary real: `workspace_kinds` is a seeded,
 * ordered, editable table. This is the column that points into it, and it is the
 * only thing that made that vocabulary mean anything.
 *
 * ## Why the literals are literals
 *
 * `'task'` and `'epic'` are written out rather than read from
 * `DEFAULT_ISSUE_KIND` / `BUILTIN_KIND_SEED`. A migration is a HISTORICAL FACT,
 * not a live view of the constants file: if this text interpolated today's
 * default, changing that constant tomorrow would silently change what every
 * database already on disk did, and the consolidated snapshot would drift from
 * the walk the moment somebody edited a value in `core/types.ts`. `'epic'` is
 * likewise a fact about what migration 004 seeded, not a lookup.
 *
 * ## Why the backfill runs exactly once
 *
 * Kind is DECLARED, not derived. A task that later grows children stays a task
 * — the UI may SUGGEST promoting it, and a human may accept, but nothing
 * recomputes it behind their back. So there is no trigger here, nothing in
 * `createIssue`, and nothing in `recomputeAncestorStatuses` that touches `kind`.
 *
 * "Had at least one child at migration time" is a one-shot heuristic whose
 * whole job is to give an existing backlog a sensible starting shape instead of
 * flattening years of structure into an undifferentiated pile of `task`. It is
 * honest precisely because it never runs again: the moment this migration
 * finishes, the column is a declaration and only a human or an explicit API call
 * changes it.
 *
 * ## Why there is no companion seed call
 *
 * Unlike 004, this migration writes no vocabulary rows of its own, so the
 * fresh-create fast path needs nothing from `schema.ts`. `ALTER TABLE ADD
 * COLUMN` with a `DEFAULT` appends to the stored `CREATE TABLE issues` text
 * rather than rewriting it — the same mechanism 002 and 003 relied on — so the
 * regenerated `sqlite_master` dump in `consolidated.ts` carries the
 * `, kind TEXT NOT NULL DEFAULT 'task')` tail verbatim, and a freshly created
 * database has no rows to backfill anyway.
 *
 * NOT NULL is safe here only because there is a DEFAULT: SQLite fills every
 * existing row with it during the ALTER. That is the point — "no kind recorded"
 * is not a distinct fact worth modelling the way a missing `estimated_seconds`
 * is (see migration 003). Every issue has always had a kind; before today the
 * tracker just had nowhere to write it down.
 */
export const migration: Migration = {
  version: 5,
  name: "issue-kind",
  up(db: DatabaseSync): void {
    db.exec("ALTER TABLE issues ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
    db.exec(
      `UPDATE issues SET kind = 'epic'
        WHERE id IN (SELECT DISTINCT parent_id FROM issues WHERE parent_id IS NOT NULL)`,
    );
  },
};
