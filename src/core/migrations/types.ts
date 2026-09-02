import type { DatabaseSync } from "node:sqlite";

/**
 * One ordered, immutable schema step.
 *
 * `version` is assigned once and never reused or renumbered — it is the value
 * that lands in `meta.schema_version`, so changing it after a release would
 * silently re-run or silently skip work on somebody's database.
 *
 * `up` runs inside the runner's transaction (and its own SAVEPOINT). It may
 * assume every lower-numbered migration has already been applied to this
 * database, and it must NOT open a transaction of its own.
 */
export interface Migration {
  readonly version: number;
  readonly name: string;
  up(db: DatabaseSync): void;
}

/**
 * A migratable database: the ordered migration list plus everything the runner
 * needs to work out where an unfamiliar file sits on that list.
 */
export interface MigrationTarget {
  /** Used in error messages: "workspace database", "hub database". */
  readonly label: string;
  /**
   * A table that has existed since version 1. Absent => the file is empty and
   * takes the fresh-create path; present but unstamped => version 1.
   */
  readonly sentinelTable: string;
  readonly migrations: readonly Migration[];
  /**
   * The `sqlite_master` dump of a database that walked every migration above.
   * Executed verbatim on a provably empty file instead of replaying the list.
   * Generated, never hand-written — see `migrations-schema-equivalence.test.ts`,
   * which fails with the corrected text when the two paths drift apart.
   *
   * Deliberately has no `IF NOT EXISTS`: it must throw rather than no-op if it
   * is ever reached with tables already present.
   */
  readonly consolidated: string;
}

/** What the runner (and A7's doctor) can see about a database's schema state. */
export interface SchemaState {
  /** 0 = empty file, otherwise the stamped (or inferred) version. */
  readonly current: number;
  /** The highest version this build knows how to produce. */
  readonly latest: number;
  /** Versions that would be applied by the next `runMigrations`. */
  readonly pending: readonly number[];
  /**
   * `empty` — no tables yet, takes the consolidated path.
   * `unstamped` — tables exist with no version row; treated as version 1.
   * `stamped` — a `meta.schema_version` row was read.
   */
  readonly detection: "empty" | "unstamped" | "stamped";
}

/** The version an existing-but-unstamped database is assumed to be at. */
export const UNVERSIONED_BASELINE = 1;

export function latestVersion(target: MigrationTarget): number {
  return target.migrations.reduce((max, m) => Math.max(max, m.version), 0);
}
