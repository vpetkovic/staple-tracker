import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import { describeSchema, runMigrations } from "../src/core/migrations/runner.js";
import { normalizedSchema } from "../src/core/migrations/dump.js";
import type { MigrationTarget } from "../src/core/migrations/types.js";
import { WORKSPACE_LATEST_VERSION, WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { StapleError } from "../src/core/types.js";
import { withCurrentWorkspace } from "./fixtures/schema/generate.js";
import { FIXTURES, rawMeta, withFixture } from "./fixtures/schema/support.js";

/**
 * STA-163 — the schema-6 workspace against the builds that are still around.
 *
 * The live workspace is stamped 6. The retired prototype checkout carries
 * migrations 001-003 and understands 3; builds installed before approval gates
 * understand 5. Both must refuse the file — before any write — rather than
 * open it, ignore the columns they do not know, and write anyway.
 *
 * An "older build" here is this build's migration list cut off where that
 * build's list ended. That is exactly what those checkouts ship: released
 * migrations are immutable and append-only (see `workspace/index.ts`), so a
 * prefix of today's list IS yesterday's list. The refusal is `runner.ts`'s
 * `assertNotNewer`, and this file pins that it fires for the specific versions
 * that exist on real machines, not only for the 99 the downgrade guard uses.
 *
 * "This build" is never a number here. The current workspace is generated at
 * test time (`withCurrentWorkspace`), the checked-in 5 and 6 are OLDER shapes
 * it walks forward, and every expected version is arithmetic on
 * `WORKSPACE_LATEST_VERSION` — so landing a migration changes nothing below.
 */

/** The workspace migration list as a checkout that stopped at `through` shipped it. */
function olderBuild(through: number): MigrationTarget {
  return {
    ...WORKSPACE_TARGET,
    migrations: WORKSPACE_TARGET.migrations.filter((m) => m.version <= through),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe.each([
  [3, "the retired prototype checkout"],
  [5, "a build installed before approval gates"],
])("a build that understands schema %i (%s)", (through) => {
  const older = olderBuild(through);

  it("sees the mismatch on a read-only handle, so refusing needs no write at all", () => {
    withFixture(FIXTURES.workspaceV6, (path) => {
      const before = sha256(path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const state = describeSchema(db, older);
        expect(state.current).toBe(6);
        expect(state.latest).toBe(through);
        expect(state.current).toBeGreaterThan(state.latest);
      } finally {
        db.close();
      }
      expect(sha256(path)).toBe(before);
      expect(existsSync(`${path}-wal`)).toBe(false);
    });
  });

  it("refuses the schema-6 workspace, naming both versions, and leaves it at 6", () => {
    withFixture(FIXTURES.workspaceV6, (path) => {
      const schemaBefore = normalizedSchema(new DatabaseSync(path, { readOnly: true }));

      const db = openDb(path);
      try {
        let thrown: unknown;
        try {
          runMigrations(db, older);
        } catch (error) {
          thrown = error;
        }
        expect(thrown).toBeInstanceOf(StapleError);
        const error = thrown as StapleError;
        expect(error.code).toBe("conflict");
        expect(error.message).toContain("workspace database");
        expect(error.message).toContain("schema version 6");
        expect(error.message).toContain(`this build understands ${through}`);
        expect(error.message).toContain("Upgrade staple");
        expect(error.message).toContain(path);
      } finally {
        db.close();
      }

      expect(rawMeta(path, "schema_version")).toBe("6");
      expect(normalizedSchema(new DatabaseSync(path, { readOnly: true }))).toBe(schemaBefore);
    });
  });
});

/** The versions a workspace stamped `stamped` still lacks — (stamped, latest], by arithmetic alone. */
function pendingAfter(stamped: number): number[] {
  return Array.from({ length: WORKSPACE_LATEST_VERSION - stamped }, (_, i) => stamped + 1 + i);
}

describe("this build", () => {
  it("opens a current workspace with nothing pending", () => {
    withCurrentWorkspace((path) => {
      const db = openDb(path);
      try {
        expect(describeSchema(db, WORKSPACE_TARGET)).toEqual({
          current: WORKSPACE_LATEST_VERSION,
          latest: WORKSPACE_LATEST_VERSION,
          pending: [],
          detection: "stamped",
        });
        expect(() => runMigrations(db, WORKSPACE_TARGET)).not.toThrow();
      } finally {
        db.close();
      }
      expect(rawMeta(path, "schema_version")).toBe(String(WORKSPACE_LATEST_VERSION));
    });
  });

  it.each([
    [5, FIXTURES.workspaceV5],
    [6, FIXTURES.workspaceV6],
  ])("walks the schema-%i fixture forward by exactly the migrations it lacks", (stamped, fixture) => {
    withFixture(fixture, (path) => {
      const db = openDb(path);
      try {
        expect(describeSchema(db, WORKSPACE_TARGET).pending).toEqual(pendingAfter(stamped));
        runMigrations(db, WORKSPACE_TARGET);
        expect(describeSchema(db, WORKSPACE_TARGET).pending).toEqual([]);
      } finally {
        db.close();
      }
      expect(rawMeta(path, "schema_version")).toBe(String(WORKSPACE_LATEST_VERSION));
    });
  });
});
