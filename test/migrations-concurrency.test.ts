import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { normalizedSchema } from "../src/core/migrations/dump.js";
import { openDb } from "../src/core/db.js";
import { migrateHub, migrateWorkspace } from "../src/core/schema.js";
import { FIXTURES, fixturePath, schemaObjects } from "./fixtures/schema/support.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { HUB_LATEST_VERSION } from "../src/core/migrations/hub/index.js";

/**
 * Several real processes racing the first open of an old database.
 *
 * This extends the v1 -> v2 upgrade pattern from `store.test.ts` from one
 * process to many, which is the case that actually happens: a repo with three
 * agents attached gets three `staple` invocations within the same second, all
 * of them opening a database that has never seen this build.
 *
 * What makes it load-bearing rather than decorative: migration 002 issues a
 * bare `CREATE UNIQUE INDEX comments_idempotency_uq` with NO `IF NOT EXISTS`,
 * and the consolidated snapshot has no `IF NOT EXISTS` anywhere either. Nothing
 * in the SQL forgives a double application. The only thing standing between
 * these workers and an "index already exists" crash is the `BEGIN IMMEDIATE`
 * serialization plus the version RE-READ the loser performs once it acquires
 * the write lock. Take either away and this test goes red.
 */

const WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/schema/migrate-worker.ts",
);
const HOLD_WORKER = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/schema/wal-hold-worker.ts",
);
const TSX_CLI = join(
  dirname(fileURLToPath(import.meta.url)),
  "../node_modules/tsx/dist/cli.mjs",
);

interface WorkerResult {
  ok: boolean;
  sawVersion?: number;
  endedAt?: number;
  code?: string;
  message?: string;
}

/** Launch `count` workers that all begin migrating at the same instant. */
async function race(kind: "workspace" | "hub", path: string, count: number): Promise<WorkerResult[]> {
  // Enough runway for tsx to boot every child before any of them starts.
  const startAt = Date.now() + 2_500;
  const runs = Array.from({ length: count }, () => {
    return new Promise<WorkerResult>((resolve, reject) => {
      const child = spawn(process.execPath, [TSX_CLI, WORKER, kind, path, String(startAt)], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += String(chunk)));
      child.stderr.on("data", (chunk) => (stderr += String(chunk)));
      child.on("error", reject);
      child.on("close", () => {
        const line = stdout.trim().split("\n").filter(Boolean).pop();
        if (!line) {
          reject(new Error(`worker produced no result. stderr:\n${stderr}`));
          return;
        }
        resolve(JSON.parse(line) as WorkerResult);
      });
    });
  });
  return Promise.all(runs);
}

function useCopy(fixture: string): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "staple-race-"));
  const path = join(dir, "tasks.db");
  copyFileSync(fixturePath(fixture), path);
  return { path, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The schema a database created by this build has. */
function freshSchema(migrate: (db: DatabaseSync) => void): string {
  const db = new DatabaseSync(":memory:");
  try {
    migrate(db);
    return normalizedSchema(db);
  } finally {
    db.close();
  }
}

describe("six processes racing the first open of a v1 workspace", () => {
  it("all succeed, and the upgrade happens exactly once", async () => {
    const { path, cleanup } = useCopy(FIXTURES.workspaceV1);
    try {
      const results = await race("workspace", path, 6);

      // Not one crash. A losing worker that failed to re-read the version under
      // the lock would have tried `ALTER TABLE comments ADD COLUMN
      // idempotency_key` a second time and died with "duplicate column name".
      const failures = results.filter((r) => !r.ok);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      // Every worker converges on the SAME latest version — derived, so appending
      // a migration (STA-81 appended 003) moves the target instead of reddening
      // a race test that is not about version numbers at all.
      expect(results.every((r) => r.endedAt === WORKSPACE_LATEST_VERSION)).toBe(true);

      // At least one worker genuinely observed the pre-migration state, so the
      // race was real and not an artefact of the first worker finishing early.
      expect(results.some((r) => r.sawVersion === 1)).toBe(true);

      // The index exists once. SQLite would have refused a second CREATE, so
      // this is the assertion that fails if serialization regresses.
      const objects = schemaObjects(path);
      expect(objects.filter((o) => o === "index:comments_idempotency_uq")).toHaveLength(1);

      const db = new DatabaseSync(path);
      try {
        expect(normalizedSchema(db)).toBe(freshSchema(migrateWorkspace));
        expect(
          (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as {
            value: string;
          }).value,
        ).toBe(String(WORKSPACE_LATEST_VERSION));
        // The rows the upgrade was protecting are still there.
        expect((db.prepare("SELECT count(*) AS n FROM comments").get() as { n: number }).n).toBe(1);
        expect((db.prepare("SELECT count(*) AS n FROM issues").get() as { n: number }).n).toBe(2);
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  }, 120_000);
});

describe("six processes racing the first open of a pre-A4 hub", () => {
  it("all succeed, and meta is created exactly once", async () => {
    const { path, cleanup } = useCopy(FIXTURES.hubV1);
    try {
      const results = await race("hub", path, 6);

      const failures = results.filter((r) => !r.ok);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      expect(results.every((r) => r.endedAt === HUB_LATEST_VERSION)).toBe(true);
      expect(results.some((r) => r.sawVersion === 1)).toBe(true);

      // Hub migration 002 is a bare `CREATE TABLE meta` — a second application
      // would have thrown "table meta already exists".
      expect(schemaObjects(path).filter((o) => o === "table:meta")).toHaveLength(1);

      const db = new DatabaseSync(path);
      try {
        expect(normalizedSchema(db)).toBe(freshSchema(migrateHub));
        expect((db.prepare("SELECT count(*) AS n FROM workspaces").get() as { n: number }).n).toBe(
          1,
        );
      } finally {
        db.close();
      }
    } finally {
      cleanup();
    }
  }, 120_000);
});

describe("openDb survives a concurrent writer on a not-yet-WAL database", () => {
  /**
   * REGRESSION for a pre-existing `openDb` bug this ticket's race tests found.
   *
   * `PRAGMA journal_mode=WAL` needs an exclusive lock and SQLite acquires it
   * WITHOUT consulting the busy handler, so it used to fail instantly —
   * measured at 0ms, with `busy_timeout` set to 5000 — whenever another process
   * held a write transaction on a rollback-journal file. Reproduced with plain
   * `node:sqlite` and no staple code, so it predates ordered migrations; it
   * surfaced here because migrating is precisely when one process holds a long
   * write transaction while others are still opening.
   *
   * `openDb` now retries the conversion for the same 5s budget every other
   * statement gets. Without that retry this test throws
   * `Error: database is locked` out of `openDb`.
   */
  it("returns immediately for databases that can never be WAL", () => {
    /**
     * REGRESSION for a bug in the fix above, caught by the full suite.
     *
     * `PRAGMA journal_mode=WAL` reports `memory` for `:memory:` and temp
     * databases — they cannot be WAL, ever. A retry loop that treats "succeeded
     * but did not report wal" as contention therefore blocks for the entire
     * busy budget on every in-memory open, which is most of the unit suite. The
     * loop must retry on a thrown BUSY/LOCKED only, never on the reported mode.
     */
    const started = Date.now();
    for (let i = 0; i < 20; i += 1) openDb(":memory:").close();
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("waits for the writer instead of failing instantly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "staple-wal-"));
    const path = join(dir, "held.db");
    try {
      const holder = spawn(process.execPath, [TSX_CLI, HOLD_WORKER, path, "1500"], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      // Attach the exit listener BEFORE awaiting anything: the holder can exit
      // while we are busy in `openDb`, and a listener added after the event has
      // already fired never runs — the await below would hang to the timeout.
      const holderExited = new Promise<void>((resolve) => holder.on("close", () => resolve()));

      await new Promise<void>((resolve, reject) => {
        holder.stdout.on("data", (chunk) => {
          if (String(chunk).includes("holding")) resolve();
        });
        holder.on("error", reject);
        holder.on("close", () => reject(new Error("holder exited before taking the lock")));
      });

      const started = Date.now();
      const db = openDb(path);
      try {
        const elapsed = Date.now() - started;
        expect(
          (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
        ).toBe("wal");
        // It genuinely waited rather than getting lucky: the holder sits on the
        // lock for 1500ms and openDb only returns once it lets go.
        expect(elapsed).toBeGreaterThan(500);
      } finally {
        db.close();
      }
      await holderExited;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("six processes racing the CREATION of a brand new workspace", () => {
  it("all succeed, and the consolidated snapshot runs exactly once", async () => {
    // The nastiest case: no file at all, so every worker's pre-transaction read
    // says "empty" and every one of them wants to execute the consolidated DDL
    // — which carries no `IF NOT EXISTS` at all, on purpose. Five of the six
    // must discover inside their own transaction that the database is already
    // at the latest version and do nothing.
    const dir = mkdtempSync(join(tmpdir(), "staple-race-new-"));
    const path = join(dir, "tasks.db");
    try {
      const results = await race("workspace", path, 6);

      const failures = results.filter((r) => !r.ok);
      expect(failures, JSON.stringify(failures, null, 2)).toEqual([]);
      expect(results.every((r) => r.endedAt === WORKSPACE_LATEST_VERSION)).toBe(true);
      expect(results.filter((r) => r.sawVersion === 0).length).toBeGreaterThan(0);

      const db = new DatabaseSync(path);
      try {
        expect(normalizedSchema(db)).toBe(freshSchema(migrateWorkspace));
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
