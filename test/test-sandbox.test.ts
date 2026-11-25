/**
 * No test can open a database outside the run's scratch home or the temp directory,
 * wherever its working directory is.
 *
 * A test spawned the branch CLI from inside this repository's linked worktree with no
 * `--db`. Resolution walked up from the working directory, followed the worktree to its
 * main checkout and opened the operator's live tracker, and the branch's new migration
 * upgraded it. The env scrub (`test/setup/scrub-env.ts`) could not help: nothing in the
 * environment named the tracker, the working directory did.
 *
 * The run's global setup names its scratch root in `STAPLE_TEST_SANDBOX`; every place a
 * database is resolved or opened refuses a path under neither it nor the temp directory
 * (`src/core/test-sandbox.ts`). These tests rebuild the incident against a decoy: a git
 * repository with its own workspace and a linked worktree, placed where the child (or
 * this worker, for the in-process cases) sees it as outside both.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { Hub } from "../src/core/hub.js";
import { findMigrationRoot } from "../src/core/path-migration.js";
import { TEST_SANDBOX_ENV, assertInTestSandbox } from "../src/core/test-sandbox.js";
import { StapleError } from "../src/core/types.js";
import { findWorkspace, openWorkspace, resolveWorkspace } from "../src/core/workspace.js";
import { bareEnv, runCliAt } from "./fixtures/characterize-support.js";

const scratch = mkdtempSync(join(tmpdir(), "staple-sandbox-guard-"));
/** Where the decoy lives: outside the narrowed sandbox and temp directory below. */
const decoy = join(scratch, "decoy");
const decoyMain = join(decoy, "main");
const decoyWorktree = join(decoy, "wt");
const decoyDb = join(decoyMain, ".staple", "staple.db");
/** The narrowed view: a sandbox and a temp directory that do NOT contain the decoy. */
const narrowSandbox = join(scratch, "sandbox");
const narrowTmp = join(narrowSandbox, "tmp");
const narrowHome = join(narrowSandbox, "home", ".staple");

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

function decoyState(): { issues: number; columns: string } {
  const db = new DatabaseSync(decoyDb, { readOnly: true });
  try {
    const issues = (db.prepare("SELECT count(*) AS n FROM issues").get() as { n: number }).n;
    const columns = (db.prepare("SELECT name FROM pragma_table_info('issues') ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name).join(",");
    return { issues, columns };
  } finally {
    db.close();
  }
}

/** The child's view: the decoy is outside its sandbox and its temp directory. */
const narrowEnv = (): Record<string, string> => ({ [TEST_SANDBOX_ENV]: narrowSandbox, TMPDIR: narrowTmp, STAPLE_HOME: narrowHome });

beforeAll(() => {
  mkdirSync(decoyMain, { recursive: true });
  mkdirSync(narrowTmp, { recursive: true });
  mkdirSync(narrowHome, { recursive: true });
  git(decoyMain, "init", "-q");
  git(decoyMain, "commit", "-q", "--allow-empty", "-m", "init");
  git(decoyMain, "worktree", "add", "-q", decoyWorktree, "-b", "wt");
  // Made under the run's own sandbox, which contains the decoy (it is in the temp directory).
  const init = runCliAt(decoyMain, ["init", "--slug", "decoy", "--yes", "--json"]);
  if (init.status !== 0) throw new Error(`init: ${init.stderr}`);
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the run's sandbox", () => {
  it("is set in every worker, to the run's scratch root that holds its home", () => {
    const sandbox = process.env[TEST_SANDBOX_ENV];
    expect(sandbox).toBeTruthy();
    expect(inject("isolatedHome").stapleHome.startsWith(`${sandbox}/`)).toBe(true);
  });

  it("reaches a child spawned with the inherited environment and through bareEnv", () => {
    const print = ["-e", `process.stdout.write(process.env.${TEST_SANDBOX_ENV} ?? "")`];
    expect(spawnSync(process.execPath, print, { encoding: "utf8" }).stdout).toBe(process.env[TEST_SANDBOX_ENV]);
    expect(spawnSync(process.execPath, print, { encoding: "utf8", env: bareEnv() }).stdout).toBe(process.env[TEST_SANDBOX_ENV]);
  });
});

describe("a spawned CLI inside a worktree whose main checkout is outside the sandbox", () => {
  it("is refused with the sandbox error when it resolves the workspace from its working directory", () => {
    const before = decoyState();
    const run = runCliAt(decoyWorktree, ["new", "probe from the decoy worktree", "--json"], narrowEnv());
    expect(run.status, run.stdout).not.toBe(0);
    const envelope = JSON.parse(run.stderr.trim().split("\n").at(-1) ?? "{}") as { code?: string; message?: string };
    expect(envelope.code).toBe("forbidden");
    expect(envelope.message).toContain(`Test sandbox: refusing to open the workspace database at ${decoyDb}`);
    expect(envelope.message).toContain(TEST_SANDBOX_ENV);
    expect(decoyState()).toEqual(before);
  });

  it("is refused for an explicit --db and for STAPLE_DB too", () => {
    const before = decoyState();
    for (const [args, extra] of [
      [["ls", "--db", decoyDb, "--json"], {}],
      [["ls", "--json"], { STAPLE_DB: decoyDb }],
    ] as const) {
      const run = runCliAt(scratch, [...args], { ...narrowEnv(), ...extra });
      expect(run.status, run.stdout).not.toBe(0);
      expect(run.stderr).toContain("Test sandbox: refusing to open");
    }
    expect(decoyState()).toEqual(before);
  });

  it("opens the same workspace when the sandbox contains it, so the refusal is the guard's", () => {
    const run = runCliAt(decoyWorktree, ["ls", "--json"]);
    expect(run.status, run.stderr).toBe(0);
  });
});

describe("in-process resolution and opens", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = { [TEST_SANDBOX_ENV]: process.env[TEST_SANDBOX_ENV], TMPDIR: process.env.TMPDIR, STAPLE_HOME: process.env.STAPLE_HOME };
    Object.assign(process.env, narrowEnv());
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const refused = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(StapleError);
      expect((error as StapleError).code).toBe("forbidden");
      expect((error as StapleError).message).toContain(TEST_SANDBOX_ENV);
      return;
    }
    throw new Error("expected the sandbox to refuse");
  };

  it("refuses walk-up resolution, an explicit open and a writable open outside the sandbox", () => {
    const before = decoyState();
    refused(() => findWorkspace(decoyWorktree));
    refused(() => findMigrationRoot(decoyWorktree));
    refused(() => openWorkspace(decoyDb));
    // Refused before anything is read: a missing file outside is the guard's error, not not_found.
    refused(() => openWorkspace(join(decoy, "missing", "staple.db")));
    refused(() => resolveWorkspace({ db: decoyDb }));
    refused(() => openDb(join(decoy, "other.db")));
    expect(decoyState()).toEqual(before);
  });

  it("judges a path by where it lands, so a symlink inside the temp directory cannot reach outside", () => {
    const before = decoyState();
    const link = join(narrowTmp, "link-to-decoy");
    symlinkSync(join(decoyMain, ".staple"), link);
    refused(() => openWorkspace(join(link, "staple.db")));
    refused(() => openDb(join(link, "staple.db")));
    const repo = join(narrowTmp, "repo-with-linked-workspace");
    mkdirSync(repo);
    symlinkSync(join(decoyMain, ".staple"), join(repo, ".staple"));
    refused(() => findWorkspace(repo));
    expect(decoyState()).toEqual(before);
  });

  it("refuses a hub outside the sandbox", () => {
    process.env.STAPLE_HOME = join(decoy, "home");
    refused(() => Hub.open());
  });
});

describe("assertInTestSandbox", () => {
  const env = { [TEST_SANDBOX_ENV]: narrowSandbox };
  it("does nothing outside the suite", () => {
    expect(() => assertInTestSandbox("/anywhere/.staple/staple.db", "database", {})).not.toThrow();
    expect(() => assertInTestSandbox("/anywhere/.staple/staple.db", "database", { [TEST_SANDBOX_ENV]: "" })).not.toThrow();
  });

  it("allows the sandbox, the temp directory and :memory:, and refuses the rest", () => {
    expect(() => assertInTestSandbox(join(narrowSandbox, "a", "b.db"), "database", env)).not.toThrow();
    expect(() => assertInTestSandbox(narrowSandbox, "database", env)).not.toThrow();
    expect(() => assertInTestSandbox(join(tmpdir(), "x.db"), "database", env)).not.toThrow();
    expect(() => assertInTestSandbox(":memory:", "database", env)).not.toThrow();
    expect(() => assertInTestSandbox("/home/someone/repo/.staple/staple.db", "database", env)).toThrow(/outside STAPLE_TEST_SANDBOX/);
    // A sibling whose name merely starts with the sandbox's is outside it.
    expect(() => assertInTestSandbox("/sandbox/run-other/x.db", "database", { [TEST_SANDBOX_ENV]: "/sandbox/run" })).toThrow(/outside/);
    expect(() => assertInTestSandbox("/sandbox/run/x.db", "database", { [TEST_SANDBOX_ENV]: "/sandbox/run" })).not.toThrow();
    // A child whose name starts with two dots is still inside.
    expect(() => assertInTestSandbox("/sandbox/run/..cache/x.db", "database", { [TEST_SANDBOX_ENV]: "/sandbox/run" })).not.toThrow();
    expect(() => assertInTestSandbox("/sandbox/run/../x.db", "database", { [TEST_SANDBOX_ENV]: "/sandbox/run" })).toThrow(/outside/);
  });
});
