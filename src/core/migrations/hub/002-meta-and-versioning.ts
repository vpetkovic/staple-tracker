import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../types.js";

/**
 * Version 2 — the hub gets a `meta` table, and therefore a version.
 *
 * Until now `migrateHub` was a bare `db.exec(HUB_DDL)` with no meta table and
 * no version row, so a hub database was UNVERSIONED in both directions: nothing
 * could detect an older hub to upgrade it, and nothing could detect a newer hub
 * to refuse it. The runner's downgrade guard had nothing to read on this side.
 *
 * Same shape as the workspace `meta` table on purpose — one key/value store,
 * `schema_version` stamped as TEXT — so the runner stamps and reads both
 * targets with one statement.
 *
 * This is additive and one-way compatible: an older binary opening a version 2
 * hub still runs its `CREATE TABLE IF NOT EXISTS` blob, which no-ops, and never
 * looks at `meta`. It keeps working. That is why versioning arrives as a new
 * table rather than a column on `workspaces`.
 */
export const migration: Migration = {
  version: 2,
  name: "meta-and-versioning",
  up(db: DatabaseSync): void {
    db.exec(`CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`);
  },
};
