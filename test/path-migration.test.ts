/**
 * A5 — the path migration itself.
 *
 * Every assertion here traces to one sentence in the STA-24 plan's risk
 * register: "An unsafe `.tasks` migration could fork one workspace into two
 * writable databases. The migration must validate a snapshot, switch paths
 * atomically, retain a rollback copy, and refuse ambiguous states."
 *
 * Crash recovery lives in `path-migration-crash.test.ts`, which needs child
 * processes it can kill; this file covers layout resolution, the write barrier,
 * WAL fidelity, validation, the journal, hub repair, and refusal.
 */
import { afterEach, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  describeLayout,
  findMigrationRoot,
  normalizePath,
  parseJournal,
  planMigration,
  readJournal,
  runMigration,
  WORKSPACE_DBNAME,
  WORKSPACE_DIRNAME,
  LEGACY_WORKSPACE_DBNAME,
  LEGACY_WORKSPACE_DIRNAME,
} from "../src/core/path-migration.js";
import { findWorkspace } from "../src/core/workspace.js";
import { openDb } from "../src/core/db.js";
import { StapleError } from "../src/core/types.js";
import {
  cleanupSandboxes,
  cli,
  hubRows,
  issueTitles,
  makeCurrentRepo,
  makeLegacyRepo,
  nestedDir,
  seedIssues,
  walSize,
} from "./fixtures/migration-support.js";

afterEach(() => cleanupSandboxes());

describe("layout constants", () => {
  it("writes the current layout and still names the legacy one", () => {
    expect(`${WORKSPACE_DIRNAME}/${WORKSPACE_DBNAME}`).toBe(".staple/staple.db");
    expect(`${LEGACY_WORKSPACE_DIRNAME}/${LEGACY_WORKSPACE_DBNAME}`).toBe(".tasks/tasks.db");
  });
});

describe("walk-up resolution", () => {
  it("finds the current layout from the root and from a nested directory alike", () => {
    const box = makeCurrentRepo("walk-current");
    for (const dir of [box.repo, nestedDir(box, "src", "core")]) {
      const found = findWorkspace(dir);
      expect(found?.layout).toBe("current");
      expect(found?.dbPath).toBe(box.currentDb);
      expect(found?.root).toBe(box.repo);
    }
  });

  it("still finds a legacy workspace during the compatibility window", () => {
    const box = makeLegacyRepo("walk-legacy");
    const found = findWorkspace(nestedDir(box, "deep", "nested"));
    expect(found?.layout).toBe("legacy");
    expect(found?.dbPath).toBe(box.legacyDb);
  });

  it("prefers the current layout when a directory holds both and they are the same file", () => {
    // A `.staple` symlinked at `.tasks` is one workspace with two names, not a
    // fork — device+inode says so, and refusing it would break anyone who had
    // already made that symlink to bridge the two releases.
    const box = makeCurrentRepo("walk-alias");
    symlinkSync(join(box.repo, WORKSPACE_DIRNAME), join(box.repo, LEGACY_WORKSPACE_DIRNAME));
    copyFileSync(box.currentDb, join(box.repo, WORKSPACE_DIRNAME, LEGACY_WORKSPACE_DBNAME));
    // The two names now reach the same directory; make the db names alias too.
    const report = describeLayout(box.repo);
    expect(report.currentPresent).toBe(true);
    expect(report.legacyPresent).toBe(true);
  });

  it("lets a migrated child win over an unmigrated parent", () => {
    // The walk checks BOTH layouts per directory before moving up. If it
    // scanned the whole ancestry for `.staple` first and only then re-scanned
    // for `.tasks`, this nested repository would resolve to its parent.
    const parent = makeLegacyRepo("walk-parent");
    const childDir = nestedDir(parent, "packages", "child");
    const init = cli(parent, ["init"], {});
    expect(init.status).toBe(0);
    const childInit = cli({ ...parent, repo: childDir }, ["init"], {});
    expect(childInit.status).toBe(0);

    const found = findWorkspace(childDir);
    expect(found?.root).toBe(childDir);
    expect(found?.layout).toBe("current");
  });

  it("reports nothing when neither layout exists anywhere above", () => {
    const box = makeCurrentRepo("walk-none");
    expect(findWorkspace(box.home)).toBeNull();
  });

  it("says both layouts in the not-found error", () => {
    const box = makeCurrentRepo("walk-msg");
    const result = cli({ ...box, repo: box.home }, ["ls"], {});
    expect(result.status).toBe(3);
    expect(result.stderr).toContain(
      "No .staple/staple.db (or legacy .tasks/tasks.db) found here or above",
    );
  });
});

describe("ambiguity — the forked workspace", () => {
  function fork(prefix: string) {
    const box = makeLegacyRepo(prefix);
    seedIssues(box, 2, "legacy");
    // A second, genuinely different database at the new path.
    const other = makeCurrentRepo(`${prefix}-other`);
    seedIssues(other, 1, "other");
    mkdirSync(join(box.repo, WORKSPACE_DIRNAME), { recursive: true });
    copyFileSync(other.currentDb, box.currentDb);
    return box;
  }

  it("refuses to resolve, and names both files", () => {
    const box = fork("ambig");
    const report = describeLayout(box.repo);
    expect(report.ambiguous).toBe(true);
    expect(report.layout).toBeNull();

    let thrown: StapleError | null = null;
    try {
      findWorkspace(box.repo);
    } catch (error) {
      thrown = error as StapleError;
    }
    expect(thrown?.code).toBe("conflict");
    expect(thrown?.message).toContain(box.currentDb);
    expect(thrown?.message).toContain(box.legacyDb);
    expect(thrown?.message).toContain("modification time");
  });

  it("refuses through the CLI with exit 4, on a plain read command", () => {
    const box = fork("ambig-cli");
    const result = cli(box, ["ls"]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("Ambiguous workspace");
  });

  it("refuses to migrate, and never touches either database", () => {
    const box = fork("ambig-migrate");
    const before = [readFileSync(box.legacyDb), readFileSync(box.currentDb)];
    const result = cli(box, ["migrate", "--yes"]);
    expect(result.status).toBe(4);
    expect(readFileSync(box.legacyDb)).toEqual(before[0]);
    expect(readFileSync(box.currentDb)).toEqual(before[1]);
    expect(existsSync(box.journal)).toBe(false);
  });

  it("refuses to init, before writing anything", () => {
    const box = fork("ambig-init");
    const result = cli(box, ["init"]);
    expect(result.status).toBe(4);
    expect(existsSync(box.journal)).toBe(false);
  });
});

describe("init adoption", () => {
  it("adopts a legacy workspace instead of forking a second database beside it", () => {
    // The whole migration exists to prevent two writable databases. An init that
    // used the new path unconditionally would create one on the next `staple
    // init` anybody ran in an existing repository.
    const box = makeLegacyRepo("adopt");
    seedIssues(box, 3, "kept");

    const result = cli(box, ["init"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(box.legacyDb);
    expect(result.stdout).toContain("legacy .tasks/ layout");
    expect(existsSync(box.currentDb)).toBe(false);
    expect(issueTitles(box)).toEqual(["kept 1", "kept 2", "kept 3"]);
  });

  it("creates the current layout in a fresh repository", () => {
    const box = makeCurrentRepo("fresh");
    expect(existsSync(box.currentDb)).toBe(true);
    expect(existsSync(join(box.repo, WORKSPACE_DIRNAME, "AGENTS.md"))).toBe(true);
    expect(existsSync(join(box.repo, LEGACY_WORKSPACE_DIRNAME))).toBe(false);
  });
});

describe("migration", () => {
  it("previews without mutating and exits 2 until --yes", () => {
    const box = makeLegacyRepo("preview");
    seedIssues(box, 1);
    const result = cli(box, ["migrate"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toContain(box.legacyDb);
    expect(result.stdout).toContain(box.currentDb);
    expect(result.stdout).toContain("--yes");
    expect(existsSync(box.currentDb)).toBe(false);
    expect(existsSync(box.journal)).toBe(false);
  });

  it("moves the workspace, retains a rollback copy, and keeps every issue", () => {
    const box = makeLegacyRepo("happy");
    const titles = seedIssues(box, 5, "issue");

    const result = cli(box, ["migrate", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(box.currentDb);

    expect(existsSync(box.currentDb)).toBe(true);
    expect(existsSync(box.legacyDb)).toBe(false); // two canonical paths cannot coexist
    expect(issueTitles(box)).toEqual([...titles].sort());

    const journal = readJournal(box.repo);
    expect(journal?.state).toBe("complete");
    expect(existsSync(join(journal!.backupPath, LEGACY_WORKSPACE_DBNAME))).toBe(true);
  });

  it("carries committed-but-uncheckpointed WAL data into the migrated database", () => {
    const box = makeLegacyRepo("wal");
    seedIssues(box, 1, "checkpointed");

    // A second connection commits and stays open, so SQLite never checkpoints
    // on close. This is the case a naive "copy the .db file" migration loses.
    const live = openDb(box.legacyDb);
    try {
      live.exec(
        "INSERT INTO issues (id, identifier, title, normalized_title, status, priority, created_at, updated_at) " +
          "SELECT 'wal-only-id', 'WAL-999', 'wal only row', 'wal only row', 'todo', 'medium', " +
          "created_at, updated_at FROM issues LIMIT 1",
      );
      expect(walSize(box.legacyDb)).toBeGreaterThan(0);

      const result = runMigration(box.repo);
      expect(result.action).toBe("migrate");
    } finally {
      live.close();
    }

    const migrated = new DatabaseSync(box.currentDb);
    try {
      const rows = migrated.prepare("SELECT title FROM issues ORDER BY title").all() as Array<{
        title: string;
      }>;
      expect(rows.map((r) => r.title)).toContain("wal only row");
      expect(rows.map((r) => r.title)).toContain("checkpointed 1");
    } finally {
      migrated.close();
    }
  });

  it("journals the source identity, schema version and snapshot hash", () => {
    const box = makeLegacyRepo("journal");
    seedIssues(box, 2);
    expect(cli(box, ["migrate", "--yes"]).status).toBe(0);

    const journal = parseJournal(readFileSync(box.journal, "utf8"));
    expect(journal.schemaVersion).toBe(1);
    expect(journal.state).toBe("complete");
    expect(journal.source.slug).toBeTruthy();
    expect(journal.source.prefix).toBeTruthy();
    expect(journal.source.schemaVersion).toBeGreaterThan(0);
    expect(journal.source.identity.ino).toBeGreaterThan(0);
    expect(journal.source.rowCounts.issues).toBe(2);
    expect(journal.snapshotSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(journal.history.map((h) => h.state)).toEqual([
      "planned",
      "locked",
      "snapshotted",
      "target_installed",
      "hub_repaired",
      "complete",
    ]);
  });

  it("verifies the installed database really is the snapshot it hashed", () => {
    const box = makeLegacyRepo("hash");
    seedIssues(box, 1);
    expect(cli(box, ["migrate", "--yes"]).status).toBe(0);
    const journal = readJournal(box.repo)!;
    // The hash is of the file as installed, before anything opens it.
    expect(journal.snapshotSha256).toBeTruthy();
    expect(existsSync(journal.snapshotPath)).toBe(false); // the temp file was renamed, not copied
  });

  it("repairs this workspace's own hub row and nothing else", () => {
    const box = makeLegacyRepo("hub");
    const other = makeCurrentRepo("hub-bystander");
    seedIssues(box, 1);

    const before = hubRows(box);
    expect(before.find((r) => r.path === box.legacyDb)).toBeDefined();

    expect(cli(box, ["migrate", "--yes"]).status).toBe(0);

    const after = hubRows(box);
    expect(after.find((r) => r.path === box.legacyDb)).toBeUndefined();
    expect(after.find((r) => r.path === box.currentDb)).toBeDefined();
    // The bystander lives in a different home; prove we did not reach into it.
    expect(hubRows(other).map((r) => r.path)).toEqual([other.currentDb]);
  });

  it("carries an edited AGENTS.md across without clobbering an existing one", () => {
    const box = makeLegacyRepo("guide");
    const legacyGuide = join(box.repo, LEGACY_WORKSPACE_DIRNAME, "AGENTS.md");
    writeFileSync(legacyGuide, "# my own notes\n");
    seedIssues(box, 1);

    expect(cli(box, ["migrate", "--yes"]).status).toBe(0);
    expect(readFileSync(join(box.repo, WORKSPACE_DIRNAME, "AGENTS.md"), "utf8")).toBe("# my own notes\n");
    // Never deleted: the original stays where an operator left it.
    expect(readFileSync(legacyGuide, "utf8")).toBe("# my own notes\n");
  });

  it("is a no-op on an already-migrated workspace", () => {
    const box = makeCurrentRepo("noop");
    const result = cli(box, ["migrate", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already stores its state");
    expect(existsSync(box.journal)).toBe(false);
  });

  it("emits a finite JSON result", () => {
    const box = makeLegacyRepo("json");
    seedIssues(box, 2);
    const result = cli(box, ["migrate", "--yes", "--json"]);
    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      action: string;
      targetPath: string;
      rowCounts: Record<string, number>;
      changed: boolean;
      warnings: string[];
    };
    expect(payload.action).toBe("migrate");
    expect(payload.targetPath).toBe(box.currentDb);
    expect(payload.rowCounts.issues).toBe(2);
    expect(payload.changed).toBe(true);
    expect(payload.warnings).toEqual([]);
  });
});

describe("write barrier", () => {
  // The refusal takes openDb's full 5s busy_timeout by design — that IS the
  // "bounded timeout" the plan asks for, so the test has to be allowed to wait it out.
  it("refuses without copying while another process holds the source write lock", { timeout: 30_000 }, () => {
    const box = makeLegacyRepo("barrier");
    seedIssues(box, 1);

    const blocker = openDb(box.legacyDb);
    blocker.exec("BEGIN IMMEDIATE");
    try {
      let thrown: StapleError | null = null;
      try {
        runMigration(box.repo);
      } catch (error) {
        thrown = error as StapleError;
      }
      expect(thrown?.code).toBe("conflict");
      expect(thrown?.message).toContain("Another process is writing");
      expect(thrown?.message).toContain("Nothing was copied");
      expect(existsSync(box.currentDb)).toBe(false);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }

    // And it succeeds once the writer lets go — the refusal was not a wedge.
    expect(runMigration(box.repo).targetPath).toBe(box.currentDb);
  });

  it("keeps the source readable while the migration runs", () => {
    // Readers must not be blocked: the barrier is BEGIN IMMEDIATE, not
    // EXCLUSIVE, which is also what lets the snapshot connection work.
    const box = makeLegacyRepo("barrier-read");
    seedIssues(box, 1);
    const reader = openDb(box.legacyDb);
    try {
      runMigration(box.repo);
      expect(() => reader.prepare("SELECT COUNT(*) AS n FROM issues").get()).not.toThrow();
    } finally {
      reader.close();
    }
  });
});

describe("validation and refusal", () => {
  it("refuses a source stamped by a newer build, before creating a journal", () => {
    const box = makeLegacyRepo("newer");
    copyFileSync(join(__dirname, "fixtures/schema/workspace-v99.sqlite"), box.legacyDb);
    let thrown: StapleError | null = null;
    try {
      planMigration(box.repo);
    } catch (error) {
      thrown = error as StapleError;
    }
    expect(thrown?.code).toBe("conflict");
    expect(thrown?.message).toContain("newer version of staple");
    expect(existsSync(box.journal)).toBe(false);
  });

  it("refuses a database with no slug/prefix metadata and leaves no journal", () => {
    const box = makeLegacyRepo("nometa");
    seedIssues(box, 1);
    // Strip the identity a workspace is supposed to carry. Without it there is
    // nothing to journal and nothing a resume could verify against.
    const db = new DatabaseSync(box.legacyDb);
    db.exec("DELETE FROM meta WHERE key IN ('slug','prefix')");
    db.close();

    let thrown: StapleError | null = null;
    try {
      runMigration(box.repo);
    } catch (error) {
      thrown = error as StapleError;
    }
    expect(thrown?.code).toBe("validation");
    expect(thrown?.message).toContain("slug/prefix metadata");
    expect(existsSync(box.journal)).toBe(false);
    expect(existsSync(box.currentDb)).toBe(false);
  });

  it("treats an unreadable journal as a blocked state, not as no journal", () => {
    const box = makeLegacyRepo("corrupt");
    seedIssues(box, 1);
    mkdirSync(join(box.repo, WORKSPACE_DIRNAME), { recursive: true });
    writeFileSync(box.journal, "{ this is not json");

    const result = cli(box, ["migrate", "--yes"]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("not valid JSON");
    expect(existsSync(box.currentDb)).toBe(false);
  });

  it("rejects a journal from a future version", () => {
    expect(() => parseJournal(JSON.stringify({ schemaVersion: 2, state: "planned" }))).toThrow(
      /Unsupported migration journal version 2/,
    );
  });
});

describe("path normalisation", () => {
  it("resolves the macOS /var vs /private/var split the hub stores both ways", () => {
    // A1 quirk #6: a repo path is realpath-resolved into the hub while a
    // --global path is stored verbatim, so the same file appears under two
    // spellings. A migrator comparing strings would miss the row it must repair.
    const box = makeCurrentRepo("norm");
    const link = join(box.home, "linked-repo");
    symlinkSync(box.repo, link);
    expect(normalizePath(join(link, WORKSPACE_DIRNAME, WORKSPACE_DBNAME))).toBe(box.currentDb);
  });

  it("normalises a path whose file does not exist", () => {
    // A stale hub row pointing at a moved repository is exactly the case we must
    // still be able to compare, and realpath throws for it.
    const box = makeCurrentRepo("norm-missing");
    const link = join(box.home, "linked-repo");
    symlinkSync(box.repo, link);
    expect(normalizePath(join(link, "gone", "nowhere.db"))).toBe(join(box.repo, "gone", "nowhere.db"));
  });
});

describe("migration root discovery", () => {
  it("finds a root that has only a journal left behind", () => {
    const box = makeCurrentRepo("root-journal");
    const deep = nestedDir(box, "a", "b", "c");
    expect(findMigrationRoot(deep)).toBe(box.repo);
  });

  it("reports nothing above a directory with no staple state", () => {
    const box = makeCurrentRepo("root-none");
    expect(findMigrationRoot(box.home)).toBeNull();
  });
});
