import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import { migrateHub, migrateWorkspace } from "../src/core/schema.js";
import { normalizedSchema } from "../src/core/migrations/dump.js";
import { StapleError } from "../src/core/types.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { HUB_LATEST_VERSION } from "../src/core/migrations/hub/index.js";
import { CLI_ENTRY, TSX_CLI, bareEnv } from "./fixtures/characterize-support.js";
import { FIXTURES, fixturePath, withFixture } from "./fixtures/schema/support.js";

/**
 * Refusing a database written by a newer build.
 *
 * The plan's stance is "refusal of a database created by a newer unsupported
 * version". Refusal means throwing before any write — an old binary that opens
 * a v3 file, ignores the columns it does not recognise and writes anyway is how
 * you corrupt someone's history. So the guard runs on the cheap read outside
 * the transaction, not only on the authoritative read inside it, and the file
 * must come back untouched.
 *
 * `conflict` (exit 4) rather than `validation` (exit 2): nothing the caller
 * typed is wrong. The state on disk is ahead of the code.
 */

describe.each([
  ["workspace", FIXTURES.workspaceV99, migrateWorkspace, "workspace database", WORKSPACE_LATEST_VERSION],
  ["hub", FIXTURES.hubV99, migrateHub, "hub database", HUB_LATEST_VERSION],
] as const)("a %s stamped newer than this build", (_label, fixture, migrate, description, latest) => {
  it("throws a conflict naming the version, the build, and the fix", () => {
    withFixture(fixture, (path) => {
      const db = openDb(path);
      try {
        let thrown: unknown;
        try {
          migrate(db);
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBeInstanceOf(StapleError);
        const error = thrown as StapleError;
        expect(error.code).toBe("conflict");
        expect(error.message).toContain(description);
        expect(error.message).toContain("schema version 99");
        // Derived, not literal: the two targets version independently (the
        // workspace is at 3 since STA-81, the hub still at 2), and hard-coding
        // one number here made this assertion quietly wrong for one of them.
        expect(error.message).toContain(`this build understands ${latest}`);
        expect(error.message).toContain("Upgrade staple");
        // The path is in the message so a user with several databases knows
        // which one to stop touching.
        expect(error.message).toContain(path);
      } finally {
        db.close();
      }
    });
  });

  it("does not write a single byte before refusing", () => {
    withFixture(fixture, (path) => {
      const before = normalizedSchema(new DatabaseSync(path));
      const db = openDb(path);
      try {
        expect(() => migrate(db)).toThrowError(StapleError);
      } finally {
        db.close();
      }

      const after = new DatabaseSync(path);
      try {
        expect(normalizedSchema(after)).toBe(before);
        expect(
          (after.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {
            value: string;
          }).value,
        ).toBe("99");
      } finally {
        after.close();
      }
    });
  });

  it("refuses again on the next open — it is not a one-shot check", () => {
    withFixture(fixture, (path) => {
      for (let i = 0; i < 3; i += 1) {
        const db = openDb(path);
        try {
          expect(() => migrate(db)).toThrowError(StapleError);
        } finally {
          db.close();
        }
      }
    });
  });
});

describe("the boundary", () => {
  it("accepts a database at exactly the latest version", () => {
    withFixture(FIXTURES.workspaceV2, (path) => {
      const db = openDb(path);
      try {
        expect(() => migrateWorkspace(db)).not.toThrow();
      } finally {
        db.close();
      }
    });
  });

  it("refuses at latest + 1, not only at some far-future number", () => {
    withFixture(FIXTURES.workspaceV2, (path) => {
      /**
       * Derived from WORKSPACE_LATEST_VERSION rather than written as a literal.
       * This test was pinned at '3' when latest was 2; STA-81 made 3 a REAL
       * version, so the literal silently stopped testing the boundary and
       * started testing an ordinary successful upgrade. Computing it means the
       * boundary moves with the migration list instead of rotting beside it.
       */
      const tooNew = WORKSPACE_LATEST_VERSION + 1;
      const setup = new DatabaseSync(path);
      setup.exec(`UPDATE meta SET value = '${tooNew}' WHERE key = 'schema_version'`);
      setup.close();

      const db = openDb(path);
      try {
        expect(() => migrateWorkspace(db)).toThrowError(
          new RegExp(`schema version ${tooNew}`),
        );
      } finally {
        db.close();
      }
    });
  });
});

describe("through the CLI", () => {
  it("exits 4 with the error envelope rather than a stack trace", () => {
    const home = mkdtempSync(join(tmpdir(), "staple-guard-home-"));
    const project = mkdtempSync(join(tmpdir(), "staple-guard-repo-"));
    try {
      mkdirSync(join(project, ".tasks"), { recursive: true });
      copyFileSync(fixturePath(FIXTURES.workspaceV99), join(project, ".tasks", "tasks.db"));

      const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "ls"], {
        cwd: project,
        env: bareEnv({ STAPLE_HOME: home }),
        encoding: "utf8",
        timeout: 30_000,
      });

      expect(result.status).toBe(4);
      expect(result.stderr).toContain("error(conflict)");
      expect(result.stderr).toContain("Upgrade staple");
      // Not the raw-Node-error leak A1 pinned for mistyped flags: this path
      // goes through StapleError, so it formats as an envelope.
      expect(result.stderr).not.toContain("at ");
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  }, 40_000);
});
