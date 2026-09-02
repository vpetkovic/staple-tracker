/**
 * A7 (STA-37) — `staple doctor`.
 *
 * Plan §7 is the specification. Its four load-bearing claims, and where each is
 * proven below:
 *
 *   | "doctor is READ-ONLY"                        | `read-only by default`     |
 *   | "a stable array of checks"                   | `the JSON contract`        |
 *   | "nonzero status when any required check fails" | `the JSON contract`      |
 *   | "--fix … applies only approved … fixes"      | `the consent gate`         |
 *
 * Plus the plan's test-table requirement for doctor: "each fix demonstrated
 * failing before and passing after repair" — which is the shape of both cases in
 * `the repairs`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { diskTree, removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";
import { FIXABLE_CHECKS, type CheckResult, type DoctorReport } from "../src/commands/doctor.js";

let home: string;
let root: string;
let repo: string;

beforeAll(() => {
  home = tempDir("a7-doctor-home");
  root = tempDir("a7-doctor-root");
  repo = join(root, "doctorrepo");
  mkdirSync(repo, { recursive: true });
  expect(runCliAt(repo, ["init"], { STAPLE_HOME: home }).status).toBe(0);
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

function doctor(args: string[], dir = repo, hubHome = home) {
  return runCliAt(dir, ["doctor", ...args], { STAPLE_HOME: hubHome }, 30_000);
}

function report(dir = repo, hubHome = home): DoctorReport {
  const result = doctor(["--json"], dir, hubHome);
  return JSON.parse(result.stdout.trim()) as DoctorReport;
}

/**
 * A disk tree with SQLite's `-wal`/`-shm` sidecars filtered out.
 *
 * Read-only means "changed no staple state", and a sidecar is not staple state:
 * it is SQLite's own scratch, created and removed whenever a connection opens a
 * WAL database. A read-only connection in particular cannot tidy them up on
 * close, so they outlive the process that made them. Everything a user or a
 * later staple could observe — every database, config, journal, guide, and
 * permission bit — is still compared exactly.
 */
function stateTree(dir: string): string[] {
  return diskTree(dir).filter((entry) => !/\.db-(wal|shm) \d+$/.test(entry));
}

function check(id: string, dir = repo, hubHome = home): CheckResult {
  const found = report(dir, hubHome).checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check "${id}"`);
  return found;
}

// ------------------------------------------------------------ the JSON shape

describe("the JSON contract", () => {
  /**
   * "Doctor JSON uses a stable check result shape" — STA-37's acceptance
   * criterion. Pinned as the exact key set of EVERY result, so a field cannot
   * appear on some checks and not others, and cannot be added silently.
   */
  it("every check result has exactly the same keys", () => {
    const parsed = report();
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.checks.length).toBeGreaterThan(10);
    for (const result of parsed.checks) {
      expect(Object.keys(result).sort(), result.id).toEqual(["data", "detail", "fix", "id", "status", "title"]);
      expect(typeof result.id).toBe("string");
      expect(typeof result.title).toBe("string");
      expect(["pass", "warn", "fail", "skip"]).toContain(result.status);
      expect(typeof result.detail).toBe("string");
      expect(typeof result.data).toBe("object");
      if (result.fix !== null) {
        expect(Object.keys(result.fix).sort()).toEqual(["command", "description", "id"]);
        // A fix handle's id IS the --only token, always.
        expect(result.fix.id).toBe(result.id);
      }
    }
  }, 40_000);

  it("pins the check id list, in order", () => {
    expect(report().checks.map((c) => c.id)).toEqual([
      "node-runtime",
      "home",
      "home-space",
      "config",
      "locator",
      "hub-database",
      "hub-registrations",
      "workspace",
      "workspace-hub-link",
      "migration-journal",
      "orphan-workspaces",
      "ui-port",
      "runtime",
      "ui-assets",
      "harnesses",
    ]);
  }, 40_000);

  it("the summary counts every check exactly once, and ok mirrors the failure count", () => {
    const parsed = report();
    const total = parsed.summary.pass + parsed.summary.warn + parsed.summary.fail + parsed.summary.skip;
    expect(total).toBe(parsed.checks.length);
    expect(parsed.ok).toBe(parsed.summary.fail === 0);
  }, 40_000);

  it("exits 0 on a healthy machine and 1 when a check fails", () => {
    expect(doctor(["--json"]).status).toBe(0);

    // Manufacture a failure: two slugs registered against one database path.
    const broken = tempDir("a7-doctor-broken");
    const brokenRepo = join(root, "brokenrepo");
    mkdirSync(brokenRepo, { recursive: true });
    expect(runCliAt(brokenRepo, ["init"], { STAPLE_HOME: broken }).status).toBe(0);
    const db = new DatabaseSync(join(broken, "hub.db"));
    try {
      const path = join(brokenRepo, ".staple", "staple.db");
      db.prepare(
        "INSERT INTO workspaces (slug, prefix, path, kind, added_at) VALUES ('twin','TWN',?,'repo','2026-01-01T00:00:00.000Z')",
      ).run(path);
    } finally {
      db.close();
    }

    const result = doctor(["--json"], brokenRepo, broken);
    expect(result.status).toBe(1);
    const parsed = JSON.parse(result.stdout.trim()) as DoctorReport;
    expect(parsed.ok).toBe(false);
    expect(parsed.checks.find((c) => c.id === "hub-registrations")!.status).toBe("fail");
    removeDir(broken);
  }, 60_000);
});

// -------------------------------------------------------------- read-only

describe("read-only by default", () => {
  /**
   * Plan §7's first sentence, checked the only way that means anything: run it
   * and diff the world. Both the machine home and the repository, whole trees,
   * permission bits included.
   */
  it("changes nothing in the home or the repository", () => {
    const homeBefore = stateTree(home);
    const repoBefore = stateTree(repo);

    expect(doctor([]).status).toBe(0);
    expect(doctor(["--json"]).status).toBe(0);
    // …including with --fix, which without --only is a refusal.
    expect(doctor(["--fix"]).status).toBe(2);
    expect(doctor(["--fix", "--yes"]).status).toBe(2);
    // …and with --only but no consent. (On this healthy machine the named check
    // already passes, so the answer is "nothing to do"; the preview-without-
    // consent path is proven on a genuinely broken fixture below.)
    expect(doctor(["--fix", "--only", "hub-registrations"]).status).toBe(0);

    expect(stateTree(home)).toEqual(homeBefore);
    expect(stateTree(repo)).toEqual(repoBefore);
  }, 60_000);

  /**
   * A4's handoff: "surface `detection: 'unstamped'` as a doctor warning."
   *
   * The trap this avoids is subtle: `Hub.open()` runs `migrateHub()`, which
   * STAMPS an unstamped database — so a doctor built on the ordinary opener
   * would silently repair the thing it was asked to report, and the warning
   * would be unobservable. Doctor opens read-only for exactly this reason, and
   * this test proves it by checking that the hub is STILL unstamped afterwards.
   */
  it("warns about an unstamped hub without stamping it", () => {
    const unstamped = tempDir("a7-unstamped-home");
    const dir = join(root, "unstampedrepo");
    mkdirSync(dir, { recursive: true });
    expect(runCliAt(dir, ["init"], { STAPLE_HOME: unstamped }).status).toBe(0);

    const hubDb = join(unstamped, "hub.db");
    const db = new DatabaseSync(hubDb);
    try {
      db.prepare("DELETE FROM meta WHERE key = 'schema_version'").run();
    } finally {
      db.close();
    }

    const result = check("hub-database", dir, unstamped);
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("no recorded schema version");
    expect(result.data.detection).toBe("unstamped");

    // Still unstamped: doctor reported, it did not repair.
    const after = new DatabaseSync(hubDb, { readOnly: true });
    try {
      const row = after.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      expect(row).toBeUndefined();
    } finally {
      after.close();
    }
    removeDir(unstamped);
  }, 60_000);

  /**
   * A5's ambiguity refusal throws out of `findWorkspace`. Doctor exists to
   * EXPLAIN that state, so it must report it rather than be stopped by it — and
   * every other check must still run.
   */
  it("explains an ambiguous workspace instead of dying on it", () => {
    const dir = join(root, "ambiguousrepo");
    mkdirSync(dir, { recursive: true });
    expect(runCliAt(dir, ["init"], { STAPLE_HOME: home }).status).toBe(0);
    mkdirSync(join(dir, ".tasks"), { recursive: true });
    copyFileSync(join(dir, ".staple", "staple.db"), join(dir, ".tasks", "tasks.db"));

    const parsed = report(dir);
    const workspace = parsed.checks.find((c) => c.id === "workspace")!;
    expect(workspace.status).toBe("fail");
    expect(workspace.detail).toContain("Ambiguous workspace");
    expect(workspace.data.ambiguous).toBe(true);
    // Every other check still ran — a guard per check, not one try around the run.
    expect(parsed.checks).toHaveLength(15);
    expect(parsed.checks.find((c) => c.id === "node-runtime")!.status).toBe("pass");
  }, 60_000);
});

// ------------------------------------------------------------- consent gate

describe("the consent gate for --fix", () => {
  /**
   * Plan's TTY matrix: "Requires `--only <check-id>` and `--yes`; bare
   * `--fix --yes` is rejected."
   */
  it("refuses bare --fix, with and without --yes, and names the repairable checks", () => {
    for (const args of [["--fix"], ["--fix", "--yes"]]) {
      const result = doctor(args);
      expect(result.status, args.join(" ")).toBe(2);
      expect(result.stderr).toContain("repairs one named check at a time");
      for (const id of FIXABLE_CHECKS) expect(result.stderr).toContain(id);
    }
  }, 40_000);

  it("refuses an --only that names no repair", () => {
    const result = doctor(["--fix", "--only", "node-runtime", "--yes"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("is not a repairable check");
  }, 30_000);

  /**
   * `--only` without `--yes` PREVIEWS rather than erroring out blindly: showing
   * someone what a repair would do is the step that makes their `--yes` mean
   * something. It still exits 2 and still mutates nothing.
   */
  it("--only without --yes previews the repair and applies nothing", () => {
    const stale = tempDir("a7-preview-home");
    const dir = staleSpellingRepo(stale);
    const before = stateTree(stale);

    const result = runCliAt(dir, ["doctor", "--fix", "--only", "hub-registrations"], { STAPLE_HOME: stale }, 30_000);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing to repair without --yes");
    expect(result.stderr).toContain("hub-registrations");
    expect(stateTree(stale)).toEqual(before);
    removeDir(stale);
  }, 60_000);

  it("says so, and changes nothing, when the named check already passes", () => {
    const result = doctor(["--fix", "--only", "hub-registrations", "--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already passes");
  }, 30_000);
});

/**
 * A hub row whose stored path is a non-canonical spelling of a real file — A1's
 * quirk #6 ("hub paths are stored in two spellings on macOS"), reproduced
 * portably by inserting an un-normalised path with a `/./` segment in it.
 */
function staleSpellingRepo(hubHome: string): string {
  const dir = join(root, `stale-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  expect(runCliAt(dir, ["init"], { STAPLE_HOME: hubHome }).status).toBe(0);
  const canonical = join(dir, ".staple", "staple.db");
  // Built by concatenation, not `join`: `path.join` normalises `/./` away, which
  // is exactly the difference this fixture needs to preserve.
  const wonky = `${join(dir, ".staple")}/./staple.db`;
  const db = new DatabaseSync(join(hubHome, "hub.db"));
  try {
    db.prepare("UPDATE workspaces SET path = ? WHERE path = ?").run(wonky, canonical);
  } finally {
    db.close();
  }
  return dir;
}

// ----------------------------------------------------------------- repairs

describe("the repairs", () => {
  /**
   * Fix 1, demonstrated failing before and passing after, per the plan's test
   * table.
   *
   * A5's handoff: "A5 repaired exactly ONE hub row — the migrated workspace's
   * own … the general repair is yours." This is the general one.
   */
  it("hub-registrations: warns, repoints, then passes — and is idempotent", () => {
    const stale = tempDir("a7-stale-home");
    const dir = staleSpellingRepo(stale);

    // BEFORE
    const before = check("hub-registrations", dir, stale);
    expect(before.status).toBe("warn");
    expect(before.fix).not.toBeNull();
    expect(before.fix!.command).toBe("staple doctor --fix --only hub-registrations --yes");

    // FIX
    const applied = runCliAt(
      dir,
      ["doctor", "--fix", "--only", "hub-registrations", "--yes", "--json"],
      { STAPLE_HOME: stale },
      30_000,
    );
    expect(applied.status).toBe(0);
    const outcome = JSON.parse(applied.stdout.trim()) as { changed: boolean; data: { repointed: unknown[] } };
    expect(outcome.changed).toBe(true);
    expect(outcome.data.repointed).toHaveLength(1);

    // AFTER
    expect(check("hub-registrations", dir, stale).status).toBe("pass");

    // Idempotent: running it again is a no-op that says so.
    const again = runCliAt(dir, ["doctor", "--fix", "--only", "hub-registrations", "--yes"], { STAPLE_HOME: stale }, 30_000);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already passes");
    removeDir(stale);
  }, 90_000);

  /**
   * Fix 2: `rollback_required`.
   *
   * A5's handoff: "`rollback_required` is YOURS to clear via `doctor --fix` —
   * only an operator chooses between divergent histories."
   *
   * The state is manufactured the way A5's runner records it: a journal at
   * `rollback_required` with both databases on disk. `--keep legacy` is the
   * conservative side, and the one exercised here in full.
   */
  it("migration-journal: fails, refuses without --keep, then resolves and passes", () => {
    const fixHome = tempDir("a7-journal-home");
    const dir = join(root, "journalrepo");
    mkdirSync(join(dir, ".tasks"), { recursive: true });
    mkdirSync(join(dir, ".staple"), { recursive: true });

    // A real legacy workspace…
    const seed = join(root, "journalseed");
    mkdirSync(seed, { recursive: true });
    expect(runCliAt(seed, ["init", "--slug", "journalrepo"], { STAPLE_HOME: fixHome }).status).toBe(0);
    copyFileSync(join(seed, ".staple", "staple.db"), join(dir, ".tasks", "tasks.db"));
    // …and a "migrated" target beside it.
    copyFileSync(join(seed, ".staple", "staple.db"), join(dir, ".staple", "staple.db"));

    writeFileSync(
      join(dir, ".staple", "migration.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          migrationId: "deadbeef1234",
          state: "rollback_required",
          sourcePath: join(dir, ".tasks", "tasks.db"),
          targetPath: join(dir, ".staple", "staple.db"),
          snapshotPath: join(dir, ".staple", "staple.db.migrate-deadbeef1234.tmp"),
          backupPath: join(dir, ".staple", "rollback-deadbeef1234"),
          source: {
            slug: "journalrepo",
            prefix: "JOU",
            schemaVersion: 2,
            identity: { dev: 1, ino: 1 },
            rowCounts: {},
          },
          snapshotSha256: "0".repeat(64),
          hub: { pathBefore: null, pathAfter: null, error: null },
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          history: [{ state: "rollback_required", at: "2026-01-01T00:00:00.000Z" }],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // BEFORE: a failure, with a fix that spells out both sides.
    const before = check("migration-journal", dir, fixHome);
    expect(before.status).toBe("fail");
    expect(before.data.state).toBe("rollback_required");
    expect(before.fix!.command).toContain("--keep legacy|new");
    expect(before.detail).toContain("Staple will not choose between them");

    // CONSENT: --yes alone is not enough. The operator has to name a side.
    const noKeep = runCliAt(
      dir,
      ["doctor", "--fix", "--only", "migration-journal", "--yes"],
      { STAPLE_HOME: fixHome },
      30_000,
    );
    expect(noKeep.status).toBe(2);
    expect(noKeep.stderr).toContain("staple will not choose for you");
    // Nothing moved.
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);
    expect(existsSync(join(dir, ".tasks", "tasks.db"))).toBe(true);

    // …and a nonsense side is refused too.
    const badKeep = runCliAt(
      dir,
      ["doctor", "--fix", "--only", "migration-journal", "--yes", "--keep", "whichever"],
      { STAPLE_HOME: fixHome },
      30_000,
    );
    expect(badKeep.status).toBe(2);
    expect(badKeep.stderr).toContain('--keep must be "new" or "legacy"');

    // FIX
    const applied = runCliAt(
      dir,
      ["doctor", "--fix", "--only", "migration-journal", "--yes", "--keep", "legacy", "--json"],
      { STAPLE_HOME: fixHome },
      30_000,
    );
    expect(applied.status).toBe(0);
    const outcome = JSON.parse(applied.stdout.trim()) as {
      changed: boolean;
      data: { keep: string; movedAside: string; canonicalPath: string };
    };
    expect(outcome.changed).toBe(true);
    expect(outcome.data.keep).toBe("legacy");

    // NEITHER DATABASE WAS DELETED — the declined one was moved aside.
    expect(existsSync(join(dir, ".tasks", "tasks.db"))).toBe(true);
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(false);
    expect(existsSync(join(outcome.data.movedAside, "staple.db"))).toBe(true);

    // AFTER: the journal is complete, and the workspace resolves again.
    const after = check("migration-journal", dir, fixHome);
    expect(after.status).toBe("pass");
    expect(runCliAt(dir, ["ls"], { STAPLE_HOME: fixHome }, 30_000).status).toBe(0);

    // Running the fix again refuses, because there is no longer a decision to make.
    const again = runCliAt(
      dir,
      ["doctor", "--fix", "--only", "migration-journal", "--yes", "--keep", "legacy"],
      { STAPLE_HOME: fixHome },
      30_000,
    );
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("already passes");

    removeDir(fixHome);
  }, 90_000);

  it("exposes exactly two repairable checks, and no more", () => {
    // A deliberately small set. Plan §7 constrains what doctor may repair much
    // more than what it may report, and every addition here is a new way for a
    // diagnostic command to change somebody's data.
    expect(FIXABLE_CHECKS).toEqual(["hub-registrations", "migration-journal"]);
  });
});

// ------------------------------------------------------------ human output

describe("human output", () => {
  it("groups results and ends with the exact repair commands", () => {
    const stale = tempDir("a7-human-home");
    const dir = staleSpellingRepo(stale);
    const result = runCliAt(dir, ["doctor"], { STAPLE_HOME: stale }, 30_000);

    expect(result.stdout).toContain("\nWARN\n");
    expect(result.stdout).toContain("\nPASS\n");
    expect(result.stdout).toContain("\nREPAIRS\n");
    expect(result.stdout).toContain("staple doctor --fix --only hub-registrations --yes");
    expect(result.stdout).toMatch(/\d+ passed, \d+ warning\(s\), \d+ failure\(s\), \d+ skipped\./);
    removeDir(stale);
  }, 60_000);

  it("reads the workspace from --dir rather than the cwd", () => {
    const elsewhere = tempDir("a7-elsewhere");
    const parsed = JSON.parse(
      runCliAt(elsewhere, ["doctor", "--json", "--dir", repo], { STAPLE_HOME: home }, 30_000).stdout.trim(),
    ) as DoctorReport;
    expect(parsed.checks.find((c) => c.id === "workspace")!.data.dbPath).toBe(join(repo, ".staple", "staple.db"));
    removeDir(elsewhere);
  }, 40_000);
});

describe("the guide file is what a fresh clone gets", () => {
  /**
   * Not a doctor check, but the property STA-59's resolution turns on and the
   * only place the whole chain is visible at once: the ignore file exists, it
   * covers the database, and it deliberately does not cover the guide.
   */
  it("ignores the database and spares AGENTS.md", () => {
    const body = readFileSync(join(repo, ".staple", ".gitignore"), "utf8");
    expect(body).toContain("*.db");
    expect(body).toContain("!AGENTS.md");
    expect(existsSync(join(repo, ".staple", "AGENTS.md"))).toBe(true);
  });
});
