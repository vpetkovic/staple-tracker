import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";
import { BUILTIN_KIND_SEED, BUILTIN_STATUS_SEED } from "../../types.js";

/**
 * Version 4 — the workspace vocabulary becomes DATA (STA-140, O7a).
 *
 * Statuses and kinds were compile-time arrays in `core/types.ts`. They are now
 * two ordered tables, so a workspace can add, rename, reorder and remove them,
 * and so the configured ORDER is the canonical order everywhere — group headers,
 * board columns, tree sort.
 *
 * ## Why `category` is a column and the behaviour is not
 *
 * A status row carries a `category` from a FIXED set (see `STATUS_CATEGORIES`).
 * Every guard in the store — checkout, derived parent rungs, resolved detection,
 * inbox pickup — keys off that category and never off the id. That is what makes
 * a custom status safe: it inherits a behaviour that already has tests, rather
 * than arriving as an id nothing knows what to do with. The category set is
 * deliberately NOT a table: making it editable would mean making the guards
 * editable, which is a rules engine, not a tracker.
 *
 * ## `sort_order` is spaced by ten
 *
 * So `statuses add … --after todo` can slot a row between two neighbours with a
 * single INSERT instead of rewriting the column. `reorderStatuses` renormalises
 * back to a clean 10, 20, 30 … afterwards.
 *
 * ## `is_builtin` is informational, not a permission
 *
 * It records which rows migration 004 seeded, which is what lets a UI say "this
 * one came with staple" and what lets the idempotent re-seed know what it owns.
 * It does NOT protect a row: removing `in_review` because your team does not
 * review is a legitimate configuration. The real protection is
 * `REQUIRED_STATUS_CATEGORIES` — you may not empty a category the code writes
 * into — and the migrate-to requirement for a status rows still reference.
 *
 * ## The seed runs from here AND from `migrateWorkspace`
 *
 * `up()` seeds so that every database already on disk gets its vocabulary as
 * part of the walk. But the fresh-create fast path does not walk: it executes
 * `CONSOLIDATED_DDL`, which is a `sqlite_master` dump and therefore carries no
 * ROWS at all. `schema.ts` calls the same `seedWorkspaceSettings` after
 * `runMigrations` to cover that path. The function is count-guarded per table
 * and uses INSERT OR IGNORE, so it is a no-op on every later open — and, in
 * particular, it never resurrects a status somebody deliberately removed.
 */

export const WORKSPACE_SETTINGS_DDL = `
CREATE TABLE workspace_statuses (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  category TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX workspace_statuses_order_idx ON workspace_statuses(sort_order);

CREATE TABLE workspace_kinds (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  is_builtin INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX workspace_kinds_order_idx ON workspace_kinds(sort_order);
`;

/** The gap between two seeded rows; see the `--after` note above. */
export const SORT_ORDER_STEP = 10;

function tableIsEmpty(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return (row?.n ?? 0) === 0;
}

/**
 * Seed the built-in vocabulary, but ONLY into a table that is still empty.
 *
 * The emptiness guard is the whole contract. Re-seeding row by row would mean a
 * workspace that removed `in_review` grew it back on the next open, which is the
 * one behaviour that would make the feature useless. An empty table, by
 * contrast, can only mean "the tables were just created" — `removeStatus`
 * refuses to empty a required category, so the operator cannot reach zero rows.
 */
export function seedWorkspaceSettings(db: DatabaseSync): void {
  if (tableIsEmpty(db, "workspace_statuses")) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO workspace_statuses (id, label, category, sort_order, is_builtin)
       VALUES (?, ?, ?, ?, 1)`,
    );
    BUILTIN_STATUS_SEED.forEach((status, index) => {
      insert.run(status.id, status.label, status.category, (index + 1) * SORT_ORDER_STEP);
    });
  }
  if (tableIsEmpty(db, "workspace_kinds")) {
    const insert = db.prepare(
      `INSERT OR IGNORE INTO workspace_kinds (id, label, sort_order, is_builtin) VALUES (?, ?, ?, 1)`,
    );
    BUILTIN_KIND_SEED.forEach((kind, index) => {
      insert.run(kind.id, kind.label, (index + 1) * SORT_ORDER_STEP);
    });
  }
}

export const migration: Migration = {
  version: 4,
  name: "workspace-settings",
  up(db: DatabaseSync): void {
    db.exec(WORKSPACE_SETTINGS_DDL);
    seedWorkspaceSettings(db);
  },
};
