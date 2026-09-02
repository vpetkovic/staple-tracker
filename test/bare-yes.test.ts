/**
 * D5 (STA-96) — bare `staple --yes`, mirroring `npx paperclipai onboard --yes`.
 *
 * The contract, row by row (spec: STA-91 plan, section D5):
 *
 *   | TTY, `--yes`         | no prompts; onboard with `init --yes` defaults;   |
 *   |                      | then start the UI exactly as bare already does    |
 *   | non-TTY, `--yes`     | setup happens; the UI server is REFUSED; the      |
 *   |                      | follow-up commands are printed; exit 0            |
 *   | non-TTY, no `--yes`  | the exit-2 refusal, byte-for-byte unchanged       |
 *   | workspace exists     | `--yes` is a setup no-op; bare behaviour holds    |
 *   | legacy `.tasks`      | migrated, because that is what `init --yes` does  |
 *
 * The non-TTY rows run the real CLI as a child with piped stdio, the same
 * environment CI is in — the idiom of init-lifecycle.test.ts. The TTY row runs
 * the real CLI under a real pseudo-terminal (`script(1)`), because "a terminal
 * is attached" IS the behaviour under test and faking `isTTY` would test the
 * fake.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CLI_ENTRY,
  TSX_CLI,
  bareEnv,
  diskTree,
  removeDir,
  runCliAt,
  tempDir,
} from "./fixtures/characterize-support.js";
import { BARE_NON_TTY_MESSAGE, BARE_YES_NON_TTY_MESSAGE } from "../src/commands/bare.js";

let home: string;
let root: string;

beforeAll(() => {
  home = tempDir("d5-yes-home");
  root = tempDir("d5-yes-root");
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

/** A repository in the legacy `.tasks/tasks.db` layout with real rows — the
 * same construction init-lifecycle.test.ts uses. */
function legacyRepo(name: string, issues: string[]): string {
  const dir = repo(name);
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
    return (db.prepare("SELECT title FROM issues").all() as Array<{ title: string }>)
      .map((r) => r.title)
      .sort();
  } finally {
    db.close();
  }
}

// --------------------------------------------------------- non-TTY + --yes

describe("bare `staple --yes` with no terminal", () => {
  it("performs setup, refuses the server, prints the follow-up commands, exits 0", () => {
    const dir = repo("yes-nontty");
    const result = cli(dir, ["--yes"]);

    expect(result.status).toBe(0);
    expect(result.timedOut).toBe(false); // it neither prompted nor served

    // Setup happened, and the output says where.
    expect(result.stdout).toContain('Created workspace "yes-nontty"');
    expect(result.stdout).toContain(join(dir, ".staple", "staple.db"));
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);
    expect(existsSync(join(dir, ".staple", "AGENTS.md"))).toBe(true);

    // The server did not: no listening banner, no URL — and the explicit
    // next commands are named instead.
    expect(result.stdout).not.toContain("http://localhost");
    expect(result.stdout).not.toContain("staple ui —");
    expect(result.stdout).toContain(BARE_YES_NON_TTY_MESSAGE);
    expect(result.stdout).toContain("staple open");
    expect(result.stdout).toContain("staple ui");
  }, 40_000);

  it("is a setup no-op on a workspace that already exists", () => {
    const dir = repo("yes-existing");
    expect(cli(dir, ["init"]).status).toBe(0);
    const before = diskTree(dir);

    const result = cli(dir, ["--yes"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Opened workspace "yes-existing"');
    expect(result.stdout).toContain(BARE_YES_NON_TTY_MESSAGE);
    // Nothing new was minted in the repository (mtimes aside, the tree is the tree).
    expect(diskTree(dir)).toEqual(before);
  }, 40_000);

  it("migrates a legacy .tasks repository, exactly like `init --yes`", () => {
    const dir = legacyRepo("yes-legacy", ["carried one", "carried two"]);
    const result = cli(dir, ["--yes"]);

    expect(result.status).toBe(0);
    expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);
    expect(titles(join(dir, ".staple", "staple.db"))).toEqual(["carried one", "carried two"]);
    // A5's runner semantics, unchanged: moved, not forked, rollback retained.
    expect(existsSync(join(dir, ".tasks", "tasks.db"))).toBe(false);
    expect(existsSync(join(dir, ".staple", "migration.json"))).toBe(true);
    expect(result.stdout).toContain(BARE_YES_NON_TTY_MESSAGE);
  }, 60_000);

  it("still refuses an ambiguous repository — --yes consents to defaults, not to picking a winner", () => {
    const dir = legacyRepo("yes-ambiguous", ["one"]);
    mkdirSync(join(dir, ".staple"), { recursive: true });
    copyFileSync(join(dir, ".tasks", "tasks.db"), join(dir, ".staple", "staple.db"));
    const before = diskTree(dir);

    const result = cli(dir, ["--yes"]);
    expect(result.status).toBe(4);
    expect(result.stderr).toContain("Ambiguous workspace");
    expect(diskTree(dir)).toEqual(before);
  }, 60_000);

  it("rejects anything else on a bare invocation as a usage error", () => {
    const dir = repo("yes-extra");
    const result = cli(dir, ["--yes", "--json"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown option");
    expect(existsSync(join(dir, ".staple"))).toBe(false);
  }, 30_000);
});

// ------------------------------------------------- non-TTY refusal, unchanged

describe("bare `staple` without --yes and without a terminal (pinned unchanged)", () => {
  /** The D2 drill and init-lifecycle.test.ts pin this too; this assertion is the
   * D5-side proof that adding `--yes` did not move a byte of the refusal. */
  it("exits 2 with the exact refusal, mutating nothing", () => {
    const dir = repo("refusal-unchanged");
    writeFileSync(join(dir, "README.md"), "hello\n");
    const before = diskTree(dir);

    const result = cli(dir, []);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(BARE_NON_TTY_MESSAGE);
    expect(result.stderr).toContain("staple init --yes");
    expect(result.stderr).toContain("staple open");
    expect(result.stderr).toContain("staple help");
    expect(result.timedOut).toBe(false);
    expect(diskTree(dir)).toEqual(before);
    expect(existsSync(join(dir, ".staple"))).toBe(false);
  }, 40_000);
});

// -------------------------------------------------------------- TTY + --yes

/**
 * Run the CLI under a real pseudo-terminal via `script(1)`, so both stdin and
 * stdout are TTYs inside the child — the actual condition `isInteractive()`
 * probes. BSD (macOS) and util-linux spell the invocation differently.
 */
function spawnUnderPty(cwd: string, env: Record<string, string>, cliArgs: string[]) {
  const inner = [process.execPath, TSX_CLI, CLI_ENTRY, ...cliArgs];
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", ...inner]
      : ["-qec", inner.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), "/dev/null"];
  // stdin is "ignore", not a pipe: macOS `script` tcgetattr()s its stdin and
  // dies on a socketpair. The child's OWN stdin/stdout are the pty either way,
  // which is what `isInteractive()` probes.
  const child = spawn("script", args, {
    cwd,
    env: bareEnv(env),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (out += String(chunk)));
  let exited = false;
  child.on("exit", () => (exited = true));
  const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await new Promise((r) => setTimeout(r, 100));
    }
    return predicate();
  };
  return {
    output: () => out,
    waitForOutput: (needle: string, timeoutMs = 60_000) =>
      waitFor(() => out.includes(needle), timeoutMs),
    waitForExit: (timeoutMs = 15_000) => waitFor(() => exited, timeoutMs),
    /** Signal the whole group; the pty master closing HUPs the server child. */
    kill: (signal: NodeJS.Signals = "SIGTERM") => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    },
  };
}

describe("bare `staple --yes` at a terminal", () => {
  it("skips every prompt, onboards with defaults, and starts the UI", async () => {
    const dir = repo("yes-tty");
    const ttyHome = tempDir("d5-yes-tty-home");
    // A pty on macOS always reports a display; pin the browser off so the test
    // never launches a real one.
    expect(runCliAt(dir, ["config", "set", "browser", "never"], { STAPLE_HOME: ttyHome }).status).toBe(0);

    const pty = spawnUnderPty(dir, { STAPLE_HOME: ttyHome }, ["--yes"]);
    try {
      // Onboarded…
      expect(await pty.waitForOutput('Created workspace "yes-tty"')).toBe(true);
      // …and then the server, which non-TTY --yes must never reach.
      expect(await pty.waitForOutput("http://localhost")).toBe(true);

      // No question was ever printed: --yes at a terminal is silent consent.
      expect(pty.output()).not.toContain("[Y/n]");
      expect(pty.output()).not.toContain("[y/N]");
      expect(pty.output()).not.toContain("Move it now?");

      expect(existsSync(join(dir, ".staple", "staple.db"))).toBe(true);

      pty.kill("SIGTERM");
      await pty.waitForExit();
    } finally {
      pty.kill("SIGKILL");
      removeDir(ttyHome);
    }
  }, 120_000);

  it("migrates a legacy repository without asking — the default the prompt would offer", async () => {
    const dir = legacyRepo("yes-tty-legacy", ["kept across"]);
    const ttyHome = tempDir("d5-yes-ttyleg-home");
    expect(runCliAt(dir, ["config", "set", "browser", "never"], { STAPLE_HOME: ttyHome }).status).toBe(0);

    const pty = spawnUnderPty(dir, { STAPLE_HOME: ttyHome }, ["--yes"]);
    try {
      expect(await pty.waitForOutput("http://localhost")).toBe(true);
      expect(pty.output()).toContain("Migrated this repository's state");
      expect(pty.output()).not.toContain("Move it now?");
      expect(titles(join(dir, ".staple", "staple.db"))).toEqual(["kept across"]);
      pty.kill("SIGTERM");
      await pty.waitForExit();
    } finally {
      pty.kill("SIGKILL");
      removeDir(ttyHome);
    }
  }, 120_000);
});
