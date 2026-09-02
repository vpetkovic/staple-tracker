/**
 * A6 (STA-36) — setup-only `init`, the bare command, and the consent surfaces.
 *
 * The plan's TTY/automation matrix is the specification. What this suite proves,
 * row by row:
 *
 *   | `staple` non-TTY        | exit 2, no mutation, names explicit commands  |
 *   | `staple init`           | never starts a server; finite `--json` result  |
 *   | `staple init --global`  | unchanged, still first class                   |
 *   | legacy repo, no consent | adopted in place + the exact migration command |
 *   | legacy repo, `--yes`    | migrated through A5's runner, data intact      |
 *   | ambiguous repo          | refused before anything is written             |
 *   | `.staple/.gitignore`    | written by default, declined by --no-gitignore |
 *
 * Every case runs the real CLI as a child process with no TTY, which is both the
 * environment CI is in and the environment the refusal rows are about.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { diskTree, removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";
import { BARE_NON_TTY_MESSAGE } from "../src/commands/bare.js";
import { WORKSPACE_GITIGNORE_BODY } from "../src/core/workspace-gitignore.js";

let home: string;
let root: string;

beforeAll(() => {
  home = tempDir("a6-init-home");
  root = tempDir("a6-init-root");
});

afterAll(() => {
  removeDir(home);
  removeDir(root);
});

function repo(name: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cli(dir: string, args: string[]) {
  return runCliAt(dir, args, { STAPLE_HOME: home }, 30_000);
}

/** A repository in the pre-migration `.tasks/tasks.db` layout, with real rows in it. */
function legacyRepo(name: string, issues: string[]): string {
  const dir = repo(name);
  // Built by initialising at the legacy path directly, which is what an existing
  // repository looks like: init ADOPTS it rather than creating a second database.
  mkdirSync(join(dir, ".tasks"), { recursive: true });
  const seed = repo(`${name}-seed`);
  expect(cli(seed, ["init", "--slug", name]).status).toBe(0);
  copyFileSync(join(seed, ".staple", "staple.db"), join(dir, ".tasks", "tasks.db"));
  for (const title of issues) {
    expect(cli(dir, ["new", title, "--db", join(dir, ".tasks", "tasks.db")]).status).toBe(0);
  }
  return dir;
}

function titles(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    // Sorted, not `ORDER BY id`: `issues.id` is an opaque identifier, not a
    // sequence, so its ordering says nothing. What is being proven here is that
    // the SET of rows survived the copy, which is exactly A5's own validation.
    return (db.prepare("SELECT title FROM issues").all() as Array<{ title: string }>)
      .map((r) => r.title)
      .sort();
  } finally {
    db.close();
  }
}

// ------------------------------------------------------------- bare command

describe("bare `staple` with no terminal", () => {
  /**
   * MOVES the A1 pin "prints the same help for a bare invocation, `help`, and
   * `--help`". A1 wrote that assertion with a note saying it was "EXPECTED to be
   * rewritten by A6, deliberately, rather than to break by surprise". This is
   * that rewrite: bare `staple` is now the interactive lifecycle, and `help` and
   * `--help` still print the identical help text they always did.
   */
  it("exits 2 and names the explicit commands, without prompting", () => {
    const dir = repo("bare-nontty");
    const result = cli(dir, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(BARE_NON_TTY_MESSAGE);
    expect(result.stderr).toContain("staple init --yes");
    expect(result.stderr).toContain("staple open");
    expect(result.timedOut).toBe(false); // it did not sit waiting on stdin
  }, 40_000);

  /**
   * The load-bearing half. Plan §1: "It returns validation exit code 2 WITHOUT
   * MUTATION." The refusal is checked before any workspace inspection, so the
   * directory has to be byte-for-byte untouched.
   */
  it("writes nothing at all — no .staple, no hub row", () => {
    const dir = repo("bare-nomutation");
    writeFileSync(join(dir, "README.md"), "hello\n");
    const before = diskTree(dir);

    const cleanHome = tempDir("a6-bare-home");
    const result = runCliAt(dir, [], { STAPLE_HOME: cleanHome }, 30_000);

    expect(result.status).toBe(2);
    expect(diskTree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".staple"))).toBe(false);
    // Not even the hub was created: the refusal precedes every open.
    expect(existsSync(join(cleanHome, "hub.db"))).toBe(false);
    removeDir(cleanHome);
  }, 40_000);

  it("`help` and `--help` still print the same help text, exit 0", () => {
    const dir = repo("bare-help");
    const word = cli(dir, ["help"]);
    const flag = cli(dir, ["--help"]);
    expect(word.status).toBe(0);
    expect(flag.status).toBe(0);
    expect(word.stdout).toBe(flag.stdout);
    expect(word.stdout.startsWith("staple — local-first task tracker for coding agents")).toBe(true);
    // …and the help now documents the bare command it used to BE.
    expect(word.stdout).toContain("(no command)");
  }, 40_000);
});

// -------------------------------------------------------------- setup only

describe("`staple init` is setup only", () => {
  it("creates, registers, and exits 0 without binding anything", () => {
    const dir = repo("init-basic");
    const result = cli(dir, ["init"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Created workspace "init-basic"');
    // No listening banner, ever.
    expect(result.stdout).not.toContain("staple ui —");
    expect(result.stdout).not.toContain("http://localhost");
  }, 30_000);

  /**
   * Plan: "`--json` emits one finite result". A1 pinned that `init --json` was a
   * hard parse error ("`init` rejects the documented global flags --db, --ws and
   * --json"); --db and --ws still are, and that half of the pin is unchanged.
   */
  it("--json emits one finite object and nothing else", () => {
    const dir = repo("init-json");
    const result = cli(dir, ["init", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report.action).toBe("create");
    expect(report.slug).toBe("init-json");
    expect(report.created).toBe(true);
    expect(report.layout).toBe("current");
    expect(report.migrated).toBe(false);
    expect(report.gitignoreWritten).toBe(true);
    expect(report.dbPath).toBe(join(dir, ".staple", "staple.db"));
    // One line, one object — a finite result, not a stream.
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
  }, 30_000);

  it("still rejects --db and --ws, which are not init's to interpret", () => {
    const dir = repo("init-flags");
    for (const flag of ["--db", "--ws"]) {
      const result = cli(dir, ["init", flag, "x"]);
      expect(result.status, flag).toBe(2);
      expect(result.stderr, flag).toContain("Unknown option");
    }
  }, 40_000);

  it("keeps `init --global <slug>` working exactly as before", () => {
    const dir = repo("init-global");
    const result = cli(dir, ["init", "--global", "a6global"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Created workspace "a6global"`);
    expect(result.stdout).toContain(`at ${join(home, "workspaces", "a6global.db")} — registered in hub.`);
    expect(result.stdout).toContain("Global workspace — no AGENTS.md guide");
    // A global workspace has no repository, so it gets no guide and no ignore file.
    expect(existsSync(join(dir, ".staple"))).toBe(false);
    expect(existsSync(join(home, "workspaces", ".gitignore"))).toBe(false);
  }, 30_000);
});

// ------------------------------------------------------- the gitignore gate

describe("the `.staple/.gitignore` consent surface", () => {
  /**
   * STA-59's resolution, and the second half of the change A5 flagged and left
   * open. A5's comment on STA-59: a per-directory ignore covering the database
   * but NOT AGENTS.md "dissolves the conflict completely" between plan §3's
   * ignore rule and plan §5's prohibition on a guide inside an ignored
   * directory.
   */
  it("writes .staple/.gitignore by default, ignoring the db but NOT AGENTS.md", () => {
    const dir = repo("ignore-default");
    expect(cli(dir, ["init"]).status).toBe(0);

    const body = readFileSync(join(dir, ".staple", ".gitignore"), "utf8");
    expect(body).toBe(WORKSPACE_GITIGNORE_BODY);
    expect(body).toContain("*.db");
    expect(body).toContain("*.db-wal");
    expect(body).toContain("*.db-shm");
    expect(body).toContain("!AGENTS.md");
    // The whole-directory rule the plan's literal wording describes is NOT here.
    expect(body).not.toMatch(/^\.staple\/$/m);
    expect(body).not.toMatch(/^\*$/m);
  }, 30_000);

  /** Staple's ignore rules live in staple's own directory. Nothing else is edited. */
  it("never touches the repository's own root .gitignore", () => {
    const dir = repo("ignore-root");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
    expect(cli(dir, ["init"]).status).toBe(0);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n");

    const fresh = repo("ignore-noroot");
    expect(cli(fresh, ["init"]).status).toBe(0);
    expect(existsSync(join(fresh, ".gitignore"))).toBe(false);
  }, 40_000);

  it("--no-gitignore declines it, and says so in --json", () => {
    const dir = repo("ignore-declined");
    const result = cli(dir, ["init", "--no-gitignore", "--json"]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report.gitignorePath).toBe(null);
    expect(report.gitignoreWritten).toBe(false);
    expect(existsSync(join(dir, ".staple", ".gitignore"))).toBe(false);
    // The guide is still written: the two files are independently gated.
    expect(existsSync(join(dir, ".staple", "AGENTS.md"))).toBe(true);
  }, 30_000);

  it("never overwrites an edited ignore file on a re-init", () => {
    const dir = repo("ignore-kept");
    expect(cli(dir, ["init"]).status).toBe(0);
    writeFileSync(join(dir, ".staple", ".gitignore"), "# mine\n*.db\n");
    const again = cli(dir, ["init", "--json"]);
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout.trim()).gitignoreWritten).toBe(false);
    expect(readFileSync(join(dir, ".staple", ".gitignore"), "utf8")).toBe("# mine\n*.db\n");
  }, 40_000);
});

// ------------------------------------------------------ the migration gate

describe("the legacy-migration consent surface", () => {
  /**
   * A5's handoff, preserved verbatim in behaviour: "initWorkspace ADOPTS a
   * legacy `.tasks` workspace rather than creating `.staple/staple.db` beside
   * it … Do not change that to auto-migrate without consent — an init that
   * creates the new path unconditionally forks every existing repo on the next
   * init anybody runs."
   */
  it("without consent, adopts the legacy database in place and prints the exact command", () => {
    const dir = legacyRepo("legacy-adopt", ["kept one", "kept two"]);
    const result = cli(dir, ["init"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(join(dir, ".tasks", "tasks.db"));
    expect(result.stdout).toContain("legacy .tasks/ layout");
    expect(result.stdout).toContain("staple migrate");
    // No second canonical database was created. This is the fork, prevented.
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(false);
    expect(titles(join(dir, ".tasks", "tasks.db"))).toEqual(["kept one", "kept two"]);
  }, 60_000);

  it("--yes migrates it through A5's runner, with the rows intact", () => {
    const dir = legacyRepo("legacy-yes", ["moved one", "moved two", "moved three"]);
    const result = cli(dir, ["init", "--yes", "--json"]);

    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    expect(report.action).toBe("migrate");
    expect(report.migrated).toBe(true);
    expect(report.layout).toBe("current");
    expect(report.migrationCommand).toBe(null);

    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);
    expect(titles(join(dir, ".staple", "staple.db"))).toEqual(["moved one", "moved three", "moved two"]);
    // The legacy file is retained as a rollback copy, never deleted, and never
    // left where a second process could keep writing to it.
    expect(existsSync(join(dir, ".tasks", "tasks.db"))).toBe(false);
    expect(existsSync(join(dir, ".staple", "migration.json"))).toBe(true);
  }, 60_000);

  /**
   * The one refusal that must survive `--yes`: two canonical databases whose
   * histories may have diverged. Consent to migrate is not consent to pick a
   * winner, and A5's `assertResolvable` is what says so.
   */
  it("refuses an ambiguous repository even with --yes, before writing anything", () => {
    const dir = legacyRepo("legacy-ambiguous", ["one"]);
    mkdirSync(join(dir, ".staple"), { recursive: true });
      copyFileSync(join(dir, ".tasks", "tasks.db"), join(dir, ".staple", "staple.db"));
    const before = diskTree(dir);

    const result = cli(dir, ["init", "--yes"]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("Ambiguous workspace");
    expect(diskTree(dir)).toEqual(before);
  }, 60_000);
});
