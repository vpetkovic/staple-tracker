import type { DatabaseSync } from "node:sqlite";
import { describeSchema, runMigrations } from "./migrations/runner.js";
import type { SchemaState } from "./migrations/types.js";
import { WORKSPACE_TARGET, WORKSPACE_LATEST_VERSION } from "./migrations/workspace/index.js";
import { seedWorkspaceSettings } from "./migrations/workspace/004-workspace-settings.js";
import { HUB_TARGET, HUB_LATEST_VERSION } from "./migrations/hub/index.js";

/**
 * Schema entry points.
 *
 * The schema itself lives in `./migrations/{workspace,hub}/` as numbered,
 * transactional migrations. This file is the thin, stable surface every caller
 * already imports (`workspace.ts`, `open.ts`, `hub.ts`) — nothing outside
 * `migrations/` needs to know how many migrations there are or how they run.
 *
 * What replaced what: `migrateWorkspace` used to exec a `CREATE ... IF NOT
 * EXISTS` blob and then walk an `ADDED_COLUMNS` list, asking
 * `PRAGMA table_info` whether each column already existed. That probe model
 * could only ever express additive, individually-idempotent column adds — no
 * ordering, no backfills, no drops — and it had no version to compare, so
 * nothing could refuse a database written by a newer build. `migrateHub` was
 * worse: a bare `db.exec(HUB_DDL)` with no meta table at all, leaving the hub
 * unversioned in both directions.
 */

export const WORKSPACE_SCHEMA_VERSION = WORKSPACE_LATEST_VERSION;
export const HUB_SCHEMA_VERSION = HUB_LATEST_VERSION;

export { WORKSPACE_TARGET, HUB_TARGET };
export type { SchemaState };

/**
 * Bring a workspace database up to `WORKSPACE_SCHEMA_VERSION`.
 *
 * Safe to call on every open, including concurrently from several processes:
 * the runner serializes first-opens behind `BEGIN IMMEDIATE` and re-reads the
 * version under that lock. Throws `StapleError("conflict")` if the file was
 * written by a newer build.
 */
export function migrateWorkspace(db: DatabaseSync): void {
  runMigrations(db, WORKSPACE_TARGET);
  /**
   * The one thing `runMigrations` structurally cannot do (STA-140).
   *
   * A consolidated snapshot is a `sqlite_master` dump — schema, never rows — so
   * the fresh-create fast path produces the two settings TABLES and none of the
   * vocabulary that gives them meaning. Migration 004's own `up()` seeds for the
   * walk path; this call covers the fast one, from the same function.
   *
   * It is count-guarded and therefore idempotent: on every open after the first
   * it reads two COUNT(*)s off tiny tables and writes nothing. Notably it does
   * NOT re-insert row by row, so a status an operator removed stays removed.
   */
  seedWorkspaceSettings(db);
}

/** Bring a hub database up to `HUB_SCHEMA_VERSION`. Same guarantees. */
export function migrateHub(db: DatabaseSync): void {
  runMigrations(db, HUB_TARGET);
}

/**
 * Read-only schema state for diagnostics — current version, latest known,
 * pending versions, and how the version was determined. A7's `doctor` reports
 * both databases through this; it performs no writes and takes no locks.
 */
export function workspaceSchemaState(db: DatabaseSync): SchemaState {
  return describeSchema(db, WORKSPACE_TARGET);
}

export function hubSchemaState(db: DatabaseSync): SchemaState {
  return describeSchema(db, HUB_TARGET);
}
