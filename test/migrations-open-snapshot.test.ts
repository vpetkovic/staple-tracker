import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import { SNAPSHOT_DIRNAME, openWorkspace } from "../src/core/open.js";
import { inspectWorkspaceSchema } from "../src/core/schema.js";
import { StapleError } from "../src/core/types.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { FIXTURES, rawMeta, withFixture } from "./fixtures/schema/support.js";

/**
 * STA-163 — what `openWorkspace` does BEFORE it opens a writable handle.
 *
 * `openDb` is not a read: its `PRAGMA journal_mode=WAL` rewrites the header of
 * a rollback-journal file and creates the `-wal`/`-shm` sidecars. So "inspect
 * before opening" has a testable meaning — after a refusal, the file's bytes
 * are identical and no sidecar exists — and "snapshot before migrating" has
 * one too: the snapshot is stamped with the OLD version, and it carries rows
 * that only ever lived in another connection's write-ahead log.
 *
 * The fixtures are real old-format files (see `fixtures/schema/README.md`),
 * copied to a temp directory before every open.
 */

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sidecars(path: string): string[] {
  return ["-wal", "-shm"].filter((suffix) => existsSync(`${path}${suffix}`));
}

function snapshotsBeside(dbPath: string): string[] {
  const dir = join(dirname(dbPath), SNAPSHOT_DIRNAME);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function issueCount(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT count(*) AS c FROM issues").get() as { c: number }).c;
  } finally {
    db.close();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("inspection precedes the writable open", () => {
  it("refuses a workspace stamped newer than this build without writing a byte", () => {
    withFixture(FIXTURES.workspaceV99, (path) => {
      const before = sha256(path);

      let thrown: unknown;
      try {
        openWorkspace(path);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StapleError);
      expect((thrown as StapleError).code).toBe("conflict");
      expect((thrown as StapleError).message).toContain("schema version 99");
      expect((thrown as StapleError).message).toContain(`this build understands ${WORKSPACE_LATEST_VERSION}`);
      // Byte-identical, and no WAL conversion happened: the refusal came from a
      // read-only handle, not from a writable one that stopped in time.
      expect(sha256(path)).toBe(before);
      expect(sidecars(path)).toEqual([]);
      expect(snapshotsBeside(path)).toEqual([]);
    });
  });

  it("reads the schema state through a read-only handle", () => {
    withFixture(FIXTURES.workspaceV6, (path) => {
      const before = sha256(path);

      const state = inspectWorkspaceSchema(path);

      expect(state).toEqual({
        current: 6,
        latest: WORKSPACE_LATEST_VERSION,
        pending: [],
        detection: "stamped",
      });
      expect(sha256(path)).toBe(before);
      expect(sidecars(path)).toEqual([]);
    });
  });

  it("opens an already-current workspace with no snapshot and no snapshot directory", () => {
    withFixture(FIXTURES.workspaceV6, (path) => {
      const opened = openWorkspace(path);
      try {
        expect(opened.upgrade).toBeUndefined();
        expect(existsSync(join(dirname(path), SNAPSHOT_DIRNAME))).toBe(false);
      } finally {
        opened.store.db.close();
      }
    });
  });
});

describe("a pending upgrade takes a verified snapshot first", () => {
  it("reports the versions and an explicit snapshot path, and the snapshot is at the OLD version", () => {
    withFixture(FIXTURES.workspaceV5, (path) => {
      const opened = openWorkspace(path);
      try {
        expect(opened.upgrade).toEqual({
          from: 5,
          to: WORKSPACE_LATEST_VERSION,
          snapshotPath: expect.stringMatching(
            new RegExp(`/${SNAPSHOT_DIRNAME}/workspace-v5\\.db\\.schema-5\\.\\d{8}T\\d{6}Z-\\d+\\.db$`),
          ),
        });
        const { snapshotPath } = opened.upgrade!;
        expect(dirname(snapshotPath)).toBe(join(dirname(path), SNAPSHOT_DIRNAME));
        expect(existsSync(snapshotPath)).toBe(true);
        // The live file moved on; the snapshot did not.
        expect(rawMeta(path, "schema_version")).toBe(String(WORKSPACE_LATEST_VERSION));
        expect(rawMeta(snapshotPath, "schema_version")).toBe("5");
        expect(issueCount(snapshotPath)).toBe(issueCount(path));
        // One self-contained file: VACUUM INTO writes no sidecars of its own.
        expect(sidecars(snapshotPath)).toEqual([]);
      } finally {
        opened.store.db.close();
      }
    });
  });

  it("includes rows another connection committed only to the WAL", () => {
    withFixture(FIXTURES.workspaceV5, (path) => {
      // A live writer, still open — so its commit sits in the WAL and is never
      // checkpointed before the snapshot is taken. A file copy would miss it.
      const writer = openDb(path);
      try {
        const now = "2026-02-01T00:00:00.000Z";
        writer
          .prepare(
            `INSERT INTO issues (id, identifier, title, normalized_title, status, status_version,
                                 priority, depth, labels, origin_kind, created_at, updated_at)
             VALUES ('iss-wal-only', 'LEG-3', 'Only in the WAL', 'only in the wal', 'todo', 0,
                     'low', 0, '[]', 'manual', ?, ?)`,
          )
          .run(now, now);
        expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
        expect(issueCount(path)).toBe(3);

        const opened = openWorkspace(path);
        try {
          expect(issueCount(opened.upgrade!.snapshotPath)).toBe(3);
          expect(issueCount(path)).toBe(3);
        } finally {
          opened.store.db.close();
        }
      } finally {
        writer.close();
      }
    });
  });

  it("names the snapshot path on stderr before the migration runs", () => {
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    withFixture(FIXTURES.workspaceV5, (path) => {
      const opened = openWorkspace(path);
      try {
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`upgrading workspace ${path} from schema 5 to ${WORKSPACE_LATEST_VERSION}`);
        expect(errors[0]).toContain(`pre-upgrade snapshot retained at ${opened.upgrade!.snapshotPath}`);
      } finally {
        opened.store.db.close();
      }
    });
  });

  it("does it once — the next open finds nothing pending and takes no second snapshot", () => {
    withFixture(FIXTURES.workspaceV5, (path) => {
      openWorkspace(path).store.db.close();
      const again = openWorkspace(path);
      try {
        expect(again.upgrade).toBeUndefined();
        expect(snapshotsBeside(path)).toHaveLength(1);
      } finally {
        again.store.db.close();
      }
    });
  });
});

describe("when the snapshot cannot be taken", () => {
  it("refuses to open and leaves the workspace exactly as it was", () => {
    withFixture(FIXTURES.workspaceV5, (path) => {
      // A file where the snapshot directory has to go, so mkdir fails.
      writeFileSync(join(dirname(path), SNAPSHOT_DIRNAME), "in the way\n");
      const before = sha256(path);

      let thrown: unknown;
      try {
        openWorkspace(path);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StapleError);
      expect((thrown as StapleError).code).toBe("conflict");
      expect((thrown as StapleError).message).toContain("Could not take a pre-upgrade snapshot");
      expect((thrown as StapleError).message).toContain("nothing in it was changed");
      // No writable handle was ever opened: same bytes, no WAL, still at 5.
      expect(sha256(path)).toBe(before);
      expect(sidecars(path)).toEqual([]);
      expect(rawMeta(path, "schema_version")).toBe("5");
    });
  });
});
