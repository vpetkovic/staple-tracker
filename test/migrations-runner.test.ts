import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { describeSchema, runMigrations } from "../src/core/migrations/runner.js";
import type { Migration, MigrationTarget } from "../src/core/migrations/types.js";
import { latestVersion } from "../src/core/migrations/types.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { HUB_TARGET } from "../src/core/migrations/hub/index.js";
import { StapleError } from "../src/core/types.js";

/**
 * The runner in isolation, on synthetic targets.
 *
 * Everything here is about the runner's contract — detection, ordering,
 * stamping, idempotence, failure atomicity — not about the real schema, which
 * `migrations-fixtures.test.ts` and `migrations-schema-equivalence.test.ts`
 * cover. Synthetic targets keep those two concerns from being tested through
 * each other: a bug in migration 002 should not make a runner test red.
 */

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  return db;
}

function step(version: number, name: string, sql: string, log?: string[]): Migration {
  return {
    version,
    name,
    up(db) {
      log?.push(name);
      db.exec(sql);
    },
  };
}

function fakeTarget(migrations: Migration[], consolidated: string): MigrationTarget {
  return { label: "test database", sentinelTable: "widgets", migrations, consolidated };
}

const META = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

function simpleTarget(log?: string[]): MigrationTarget {
  return fakeTarget(
    [
      step(1, "initial", `${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`, log),
      step(2, "colour", "ALTER TABLE widgets ADD COLUMN colour TEXT", log),
      step(3, "size", "ALTER TABLE widgets ADD COLUMN size INTEGER", log),
    ],
    `${META};
     CREATE TABLE widgets (id TEXT PRIMARY KEY
     , colour TEXT, size INTEGER)`,
  );
}

describe("version detection", () => {
  it("calls an empty file version 0 and takes the consolidated path", () => {
    const db = memoryDb();
    const log: string[] = [];
    const target = simpleTarget(log);

    expect(describeSchema(db, target)).toEqual({
      current: 0,
      latest: 3,
      pending: [1, 2, 3],
      detection: "empty",
    });

    runMigrations(db, target);

    // The fresh path executes the snapshot, so no migration's `up` ever ran.
    expect(log).toEqual([]);
    expect(describeSchema(db, target)).toEqual({
      current: 3,
      latest: 3,
      pending: [],
      detection: "stamped",
    });
    db.close();
  });

  it("calls a sentinel-present, version-row-absent database version 1", () => {
    // This is exactly today's hub: real tables, no version anywhere.
    const db = memoryDb();
    const target = simpleTarget();
    db.exec(`${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`);

    expect(describeSchema(db, target)).toEqual({
      current: 1,
      latest: 3,
      pending: [2, 3],
      detection: "unstamped",
    });
    db.close();
  });

  it("treats a missing meta table as unstamped rather than crashing", () => {
    // A pre-A4 hub has no `meta` table at all, so the version read has to cope
    // with the table itself being absent, not just the row.
    const db = memoryDb();
    const target = simpleTarget();
    db.exec("CREATE TABLE widgets (id TEXT PRIMARY KEY)");

    expect(describeSchema(db, target).detection).toBe("unstamped");
    expect(describeSchema(db, target).current).toBe(1);
    db.close();
  });

  it("treats an unparseable version row as unstamped", () => {
    const db = memoryDb();
    const target = simpleTarget();
    db.exec(`${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', 'banana')");

    expect(describeSchema(db, target).current).toBe(1);
    db.close();
  });

  it("reports the real targets at their current latest versions", () => {
    // The two targets version INDEPENDENTLY and are expected to diverge — the
    // workspace gained 003-issue-estimate (STA-81), 004-workspace-settings
    // (STA-140), 005-issue-kind (STA-124) and 006-approval-gates (STA-143) while
    // the hub gained none of them. Pinned as two separate numbers precisely so a
    // migration added to one target cannot be silently assumed to have been added
    // to both.
    expect(latestVersion(WORKSPACE_TARGET)).toBe(6);
    expect(latestVersion(HUB_TARGET)).toBe(2);
  });
});

describe("ordered application", () => {
  it("runs only the pending migrations, in version order", () => {
    const db = memoryDb();
    const log: string[] = [];
    const target = simpleTarget(log);
    db.exec(`${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '1')");

    runMigrations(db, target);

    expect(log).toEqual(["colour", "size"]);
    const columns = (
      db.prepare("PRAGMA table_info(widgets)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["id", "colour", "size"]);
    db.close();
  });

  it("applies migrations in version order even when the list is out of order", () => {
    const db = memoryDb();
    const log: string[] = [];
    const target = fakeTarget(
      [
        step(3, "size", "ALTER TABLE widgets ADD COLUMN size INTEGER", log),
        step(1, "initial", `${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`, log),
        step(2, "colour", "ALTER TABLE widgets ADD COLUMN colour TEXT", log),
      ],
      "unused",
    );
    db.exec(`${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`);

    runMigrations(db, target);

    expect(log).toEqual(["colour", "size"]);
    db.close();
  });

  it("stamps each step as it goes, not just the final version", () => {
    // "records completion in the database" per step, not one stamp at the end:
    // migration 3 must be able to see that 2 has already been recorded. That is
    // what lets a future migration branch on the version it is upgrading from.
    const seen: string[] = [];
    const db = memoryDb();
    const target = fakeTarget(
      [
        step(1, "initial", `${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`),
        step(2, "colour", "ALTER TABLE widgets ADD COLUMN colour TEXT"),
        {
          version: 3,
          name: "observe",
          up(inner) {
            const row = inner.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as
              | { value: string }
              | undefined;
            seen.push(row?.value ?? "<none>");
            inner.exec("ALTER TABLE widgets ADD COLUMN size INTEGER");
          },
        },
      ],
      "unused",
    );
    db.exec(`${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`);

    runMigrations(db, target);
    expect(seen).toEqual(["2"]);
    db.close();
  });

  it("is a no-op on reopen, and takes no write transaction to decide that", () => {
    const db = memoryDb();
    const log: string[] = [];
    const target = simpleTarget(log);
    runMigrations(db, target);
    log.length = 0;

    for (let i = 0; i < 5; i += 1) runMigrations(db, target);
    expect(log).toEqual([]);

    // Proof there is no open transaction left behind and none was needed: a
    // BEGIN IMMEDIATE here would fail if the runner had left one dangling.
    db.exec("BEGIN IMMEDIATE");
    db.exec("COMMIT");
    db.close();
  });
});

describe("stamp representation", () => {
  it("writes the version as TEXT, matching what old binaries CAST", () => {
    const db = memoryDb();
    runMigrations(db, simpleTarget());
    const row = db.prepare("SELECT typeof(value) AS t, value FROM meta WHERE key='schema_version'").get() as {
      t: string;
      value: string;
    };
    expect(row.t).toBe("text");
    expect(row.value).toBe("3");
    db.close();
  });

  it("never lowers a version: the stamp guard is monotonic", () => {
    // A hypothetical caller that stamped 5 by hand must not be walked back to 3
    // by a normal open. The guard is `CAST(meta.value) < CAST(excluded.value)`,
    // and it is the same guard shipped binaries already use.
    const db = memoryDb();
    const target = simpleTarget();
    runMigrations(db, target);
    db.exec("UPDATE meta SET value = '5' WHERE key = 'schema_version'");

    expect(() => runMigrations(db, target)).toThrowError(StapleError);
    expect(
      (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string })
        .value,
    ).toBe("5");
    db.close();
  });
});

describe("failure atomicity", () => {
  it("rolls the whole run back and names the migration that failed", () => {
    const db = memoryDb();
    const target = fakeTarget(
      [
        step(1, "initial", `${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`),
        step(2, "colour", "ALTER TABLE widgets ADD COLUMN colour TEXT"),
        step(3, "broken", "ALTER TABLE widgets ADD COLUMN colour TEXT"), // duplicate column
      ],
      "unused",
    );
    db.exec(`${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`);

    let thrown: unknown;
    try {
      runMigrations(db, target);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(StapleError);
    expect((thrown as StapleError).message).toContain("003-broken");
    expect((thrown as StapleError).message).toContain("no changes were applied");

    // 002 succeeded before 003 blew up, and it is gone anyway: the outer
    // BEGIN IMMEDIATE makes the run all-or-nothing, so a half-migrated database
    // is never left on disk for the next process to trip over.
    const columns = (
      db.prepare("PRAGMA table_info(widgets)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toEqual(["id"]);
    expect(
      db.prepare("SELECT value FROM meta WHERE key='schema_version'").get(),
    ).toBeUndefined();

    // The connection is usable afterwards — the transaction really did unwind.
    db.exec("BEGIN IMMEDIATE");
    db.exec("COMMIT");
    db.close();
  });

  it("leaves an empty database empty when the consolidated snapshot fails", () => {
    const db = memoryDb();
    const target = fakeTarget(
      [step(1, "initial", `${META}; CREATE TABLE widgets (id TEXT PRIMARY KEY)`)],
      "CREATE TABLE widgets (id TEXT PRIMARY KEY); CREATE TABLE widgets (oops TEXT);",
    );

    expect(() => runMigrations(db, target)).toThrow();
    expect(db.prepare("SELECT count(*) AS n FROM sqlite_master").get()).toEqual({ n: 0 });
    db.close();
  });
});
