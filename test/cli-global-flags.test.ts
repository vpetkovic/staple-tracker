/**
 * The global flags (`staple help`, "Global flags") mean the same thing before the command
 * as after it: `staple --json --ws S show REF` is `staple show REF --json --ws S`.
 *
 * Every invocation here runs from a directory with no workspace above it, so a flag that
 * was dropped on the way to the command shows up as a not_found instead of passing by
 * walking up to the right database.
 */
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let repo: string;
let elsewhere: string;
let db: string;

function staple(args: string[], env: Record<string, string> = {}) {
  return runCliAt(elsewhere, args, { STAPLE_HOME: home, HOME: home, USER: "scratch-user", ...env });
}

beforeAll(() => {
  home = tempDir("global-flags-home");
  repo = tempDir("global-flags-repo");
  elsewhere = tempDir("global-flags-elsewhere");
  expect(runCliAt(repo, ["init", "--slug", "flags", "--yes"], { STAPLE_HOME: home, HOME: home }).status).toBe(0);
  db = join(repo, ".staple", "staple.db");
  expect(staple(["new", "First task", "--db", db]).status).toBe(0);
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(repo);
  removeDir(elsewhere);
});

describe("a global flag before the command means what it means after it", () => {
  it("--json before the command prints what --json after it prints", () => {
    const after = staple(["show", "FLA-1", "--db", db, "--json"]);
    const before = staple(["--json", "show", "FLA-1", "--db", db]);
    expect(after.status).toBe(0);
    expect(before.status).toBe(0);
    expect(before.stdout).toBe(after.stdout);
    expect(JSON.parse(before.stdout).issue.identifier).toBe("FLA-1");
  });

  it("--db before the command takes its value, spelled apart or with =", () => {
    const after = staple(["ls", "--db", db, "--json"]);
    expect(after.status).toBe(0);
    expect(staple(["--db", db, "ls", "--json"]).stdout).toBe(after.stdout);
    expect(staple([`--db=${db}`, "--json", "ls"]).stdout).toBe(after.stdout);
  });

  it("--ws before the command selects the registered workspace", () => {
    const result = staple(["--json", "--ws", "flags", "show", "FLA-1"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).issue.identifier).toBe("FLA-1");
  });

  it("a global flag before a command with subcommands reaches it too", () => {
    const after = staple(["queue", "next", "--db", db, "--json"]);
    const before = staple(["--db", db, "--json", "queue", "next"]);
    expect(before.status).toBe(after.status);
    expect(before.stdout).toBe(after.stdout);
  });

  it("refuses one workspace flag given two different values, one on each side", () => {
    const result = staple(["--db", db, "ls", "--db", join(elsewhere, "other.db")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--db");
    expect(result.stderr).toContain("two different values");
  });

  it("a value-taking global flag with no value names the flag", () => {
    const result = staple(["--json", "--ws"]);
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stderr.trim()).message).toContain("--ws needs a value");
  });

  it("global flags with no command after them name what is missing", () => {
    const result = staple(["--db", db]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("needs a command");
  });
});

describe("--agent names who acts, before or after the command", () => {
  it("new --agent records the creator (it was an unknown option)", () => {
    const result = staple(["new", "Second task", "--db", db, "--agent", "eng-a", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).createdBy).toBe("eng-a");
  });

  it("--agent before the command does the same", () => {
    const result = staple(["--agent", "eng-b", "--db", db, "new", "Third task", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).createdBy).toBe("eng-b");
  });

  it("--agent wins over $STAPLE_AGENT, as the verbs that always took it do", () => {
    const result = staple(["comment", "FLA-1", "hello", "--db", db, "--agent", "eng-c", "--json"], { STAPLE_AGENT: "from-env" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).author).toBe("eng-c");
  });

  it("a verb's own spelling still works, and wins over --agent when both are given", () => {
    const own = staple(["comment", "FLA-1", "hi", "--db", db, "--author", "eng-own", "--json"]);
    expect(JSON.parse(own.stdout).author).toBe("eng-own");
    const both = staple(["--agent", "eng-global", "comment", "FLA-1", "hi", "--db", db, "--author", "eng-own", "--json"]);
    expect(JSON.parse(both.stdout).author).toBe("eng-own");
  });

  it("--agent before checkout claims for that agent, the same as after it", () => {
    const result = staple(["--agent", "eng-d", "--ws", "flags", "checkout", "FLA-1", "--json"]);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).assignee).toBe("eng-d");
  });

  it("refuses --agent given two different names, one on each side", () => {
    const result = staple(["--agent", "eng-x", "show", "FLA-1", "--db", db, "--agent", "eng-y"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--agent");
  });

  it("after run drive, --agent is still the harness, and one before the command is not", () => {
    // Before the command it is who acts, so drive still asks for its harness.
    const before = staple(["--agent", "eng-e", "run", "drive", "--db", db, "--json"]);
    expect(before.status).toBe(2);
    expect(before.stderr).toContain("run drive needs --agent");
    // After `run drive` it reaches drive, which refuses an unknown harness by name.
    const after = staple(["run", "drive", "--db", db, "--agent", "no-such-harness", "--json"]);
    expect(after.status).toBe(2);
    expect(after.stderr).not.toContain("run drive needs --agent");
    expect(after.stderr).toContain("no-such-harness");
  });

  it("the reserved goal-run actor is refused through the global flag as well", () => {
    const result = staple(["--agent", "goal-run:M-1", "--db", db, "new", "Nope"]);
    expect(result.status).toBe(2);
  });
});

describe("unknown flags stay precise", () => {
  it("an unknown flag before the command is named and called not global", () => {
    const result = staple(["--frobnicate", "--db", db, "ls"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('"--frobnicate" is not a global flag');
    expect(result.stderr).toContain("--db <path>, --ws <slug|prefix>, --json, --agent <name>");
  });

  it("the same refusal under --json is one JSON line", () => {
    const result = staple(["--json", "--frobnicate", "ls"]);
    expect(result.status).toBe(2);
    const envelope = JSON.parse(result.stderr.trim());
    expect(envelope.code).toBe("validation");
    expect(envelope.message).toContain('"--frobnicate" is not a global flag');
  });

  it("an unknown flag after the command keeps the command's own message", () => {
    const result = staple(["ls", "--db", db, "--frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe("error(validation): Unknown option '--frobnicate'");
  });

  it("an unknown command is still an unknown command", () => {
    const result = staple(["--db", db, "frobnicate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Unknown command "frobnicate"');
  });
});

describe("doctor diagnoses the workspace --db or --ws names", () => {
  type Check = { id: string; status: string; data: Record<string, unknown> };
  const checks = (stdout: string) => new Map((JSON.parse(stdout).checks as Check[]).map((c) => [c.id, c]));

  it("doctor --db checks that database, from a directory with no workspace", () => {
    const result = staple(["doctor", "--db", db, "--json"]);
    const byId = checks(result.stdout);
    expect(byId.get("workspace")!.status).toBe("pass");
    expect(byId.get("workspace")!.data.dbPath).toBe(db);
    expect(byId.get("schema")!.data.dbPath).toBe(db);
    expect(byId.get("workspace-hub-link")!.status).toBe("pass");
  });

  it("--ws before doctor checks the registered workspace", () => {
    const result = staple(["--ws", "flags", "doctor", "--json"]);
    const byId = checks(result.stdout);
    expect(byId.get("workspace")!.status).toBe("pass");
    expect(byId.get("workspace")!.data.slug).toBe("flags");
  });

  it("a workspace doctor cannot find is a failed check, not a crash", () => {
    const result = staple(["doctor", "--ws", "no-such-workspace", "--json"]);
    expect(result.status).toBe(1);
    const workspace = checks(result.stdout).get("workspace")!;
    expect(workspace.status).toBe("fail");
    expect(workspace.data.code).toBe("not_found");
  });

  it("without --db or --ws doctor still walks up from where it runs", () => {
    const byId = checks(staple(["doctor", "--json"]).stdout);
    expect(byId.get("workspace")!.status).toBe("skip");
  });

  it("refuses --dir with --db, which name two different places", () => {
    const result = staple(["doctor", "--db", db, "--dir", repo]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--dir");
  });
});

/**
 * Every example in the help's "Global flags" section runs. Placeholders take this file's
 * scratch values; a doctor example may exit 1 (a check failed), never 2 (a usage error).
 */
describe("the help's global-flag examples are executable", () => {
  function examples(): string[] {
    const help = staple(["help"]).stdout;
    const start = help.indexOf("\nGlobal flags");
    expect(start).toBeGreaterThan(0);
    const section = help.slice(start + 1).split(/\n(?=\S)/)[0]!;
    return section
      .split("\n")
      .map((line) => /^\s+(?:e\.g\.\s+)?staple (.+)$/.exec(line)?.[1])
      .filter((line): line is string => line !== undefined);
  }

  function argv(example: string): string[] {
    const filled = example
      .replaceAll("<slug>", "flags")
      .replaceAll("<ref>", "FLA-1")
      .replaceAll("<name>", "eng-help")
      .replaceAll("<path>", db)
      .replaceAll("<title>", "Help example");
    return [...filled.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
  }

  it("lists examples on both sides of the command", () => {
    const list = examples();
    expect(list.length).toBeGreaterThanOrEqual(3);
    expect(list.some((e) => e.startsWith("--"))).toBe(true);
    expect(list.some((e) => !e.startsWith("--"))).toBe(true);
  });

  it("runs every one against a scratch workspace", () => {
    const failed: Array<{ example: string; status: number; stderr: string }> = [];
    for (const example of examples()) {
      const args = argv(example);
      const result = staple(args);
      const allowed = args.includes("doctor") ? [0, 1] : [0];
      if (!allowed.includes(result.status)) failed.push({ example, status: result.status, stderr: result.stderr });
    }
    expect(failed).toEqual([]);
  }, 120_000);
});
