import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 9 — tracked projects (contract in docs/web-ui.md, "Projects").
 *
 * ## Why 9
 *
 * Latest on master is 008 (the pickup queue) and this is the next number. The
 * rule in `index.ts` still applies: if another branch merges a 009 first, this
 * one renumbers to latest+1 at merge time and never skips ahead.
 *
 * ## What a project is
 *
 * A named container an issue can belong to — the thing the navigation rail lists
 * under Tasks and the thing the Project filter narrows by. Two kinds:
 * `unmanaged` (no repository) and `managed`, which points at a source: a GitHub
 * link (`source_kind = 'github'`) or a folder on disk (`source_kind = 'local'`).
 * The kind and the source are stored EXPLICITLY, as three columns rather than one
 * URL-shaped string somebody would later have to parse, because the modal that
 * edits them is a discriminated form and the next settings a project grows
 * ("initiating tracker", "repointing") hang off exactly this distinction. Those
 * settings are not modelled here; the table has room for them as columns later.
 *
 * `slug` is the stable, human-typed handle (derived from the name at create time
 * and never re-derived on rename); `id` is the stable machine key every issue
 * points at. Both are unique.
 *
 * ## Why one nullable column on `issues` and no join table
 *
 * An issue belongs to at most one project, and most issues belong to none: the
 * relation is a nullable pointer, exactly like `parent_id`. A join table would
 * admit a second membership the model has no meaning for.
 *
 * The column carries NO `REFERENCES` clause, deliberately. SQLite refuses
 * `ALTER TABLE … DROP COLUMN` on a column that takes part in a foreign key, and
 * `test/store.test.ts` rewinds a current database to the v1 shape column by
 * column to prove the walk; a constraint here would make that rewind impossible.
 * Deleting a project therefore nulls its issues' pointers explicitly, inside the
 * same transaction (`ProjectStore.remove`), which is the `ON DELETE SET NULL`
 * this column would otherwise have declared.
 *
 * `ALTER TABLE ADD COLUMN` appends to the stored `CREATE TABLE issues` text
 * rather than rewriting it, exactly as 003, 005 and 006 did. The regenerated
 * consolidated snapshot carries that appended tail verbatim, which is what keeps
 * the fresh-create fast path byte-equivalent to the walk. NULL with no DEFAULT:
 * every existing issue correctly reads as "in no project".
 *
 * The partial index over `project_id` serves the one query the rail and the
 * filter make — "which issues are in this project" — over the handful of rows
 * that ever hold a value, at no cost to the rows that do not.
 *
 * ## What it seeds: nothing
 *
 * No project exists until somebody creates one. An upgraded workspace behaves
 * exactly as it did.
 */
export const migration: Migration = {
  version: 9,
  name: "projects",
  up(db: DatabaseSync): void {
    db.exec(
      `CREATE TABLE projects (
         id          TEXT PRIMARY KEY,
         slug        TEXT NOT NULL UNIQUE,
         name        TEXT NOT NULL,
         kind        TEXT NOT NULL DEFAULT 'unmanaged',
         source_kind TEXT,
         source      TEXT,
         created_at  TEXT NOT NULL,
         updated_at  TEXT NOT NULL
       )`,
    );
    db.exec("ALTER TABLE issues ADD COLUMN project_id TEXT");
    db.exec("CREATE INDEX issues_project_idx ON issues(project_id) WHERE project_id IS NOT NULL");
  },
};
