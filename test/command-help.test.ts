/**
 * `staple <command> --help` and `-h`: every command answers with help, exit 0, and does
 * nothing else — no workspace resolved, no home created, no server, no install.
 *
 * `staple -h` is `staple --help`. The commands are read off `staple help` itself (the first word of every entry line,
 * `start|checkout` alternatives split), so a command added to the help later is covered
 * without touching this file. Commands with a page of their own (`run`, `queue`, ...)
 * print it; every other one prints its own entries of `staple help`.
 */
import { readdirSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { removeDir, runCliAt, runCliAtAsync, tempDir } from "./fixtures/characterize-support.js";

let home: string;
let scratch: string;

beforeAll(() => {
  home = tempDir("command-help-home");
  scratch = tempDir("command-help-cwd");
});

afterAll(() => {
  removeDir(home);
  removeDir(scratch);
});

/** Every command `staple help` names at the start of an entry line. */
function helpCommands(): string[] {
  const help = runCliAt(scratch, ["help"], { STAPLE_HOME: home, HOME: home }).stdout;
  const names = new Set<string>();
  for (const line of help.split("\n")) {
    const entry = /^ {2}([a-z][a-z-]*(?:\|[a-z][a-z-]*)*)(?:\s|$)/.exec(line);
    if (entry) for (const name of entry[1]!.split("|")) names.add(name);
  }
  return [...names].sort();
}

describe("every command answers --help and -h", () => {
  it("reads the command list off staple help, groups included", () => {
    const names = helpCommands();
    for (const name of ["milestone", "kinds", "statuses", "settings", "doc", "hub", "cloud", "budget", "run", "queue", "new", "init", "open", "install"]) {
      expect(names).toContain(name);
    }
  }, 30_000);

  it("prints help, exit 0, and touches nothing, for every command and both spellings", async () => {
    const names = helpCommands();
    const env = { STAPLE_HOME: home, HOME: home, STAPLE_AGENT: "help-probe" };
    const results = await Promise.all(
      names.flatMap((name) =>
        ["--help", "-h"].map(async (flag) => ({ name, flag, result: await runCliAtAsync(scratch, [name, flag], env, 60_000) })),
      ),
    );
    const failures = results
      .filter(({ result }) => result.status !== 0 || !result.stdout.startsWith("staple ") || result.stderr.includes("error("))
      .map(({ name, flag, result }) => `${name} ${flag}: exit ${result.status} ${JSON.stringify((result.stderr || result.stdout).slice(0, 120))}`);
    expect(failures).toEqual([]);
    // Help acted on nothing: no workspace, no home, no install.
    expect(readdirSync(scratch)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  }, 180_000);

  it("prints help, exit 0, and touches nothing, for every subcommand staple help names, and every run hook verb", async () => {
    const env = { STAPLE_HOME: home, HOME: home, STAPLE_AGENT: "help-probe" };
    const help = runCliAt(scratch, ["help"], env).stdout;
    const argvs = new Set<string>();
    for (const line of help.split("\n")) {
      const entry = /^ {2}([a-z][a-z-]*(?:\|[a-z][a-z-]*)*) ([a-z][a-z-]*(?:\|[a-z][a-z-]*)*)(?:\s|$)/.exec(line);
      if (!entry) continue;
      for (const command of entry[1]!.split("|")) for (const sub of entry[2]!.split("|")) argvs.add(`${command} ${sub}`);
    }
    // The hook verbs live on run hook's own page: install, bind, unbind and one <provider>-stop each.
    const hookPage = runCliAt(scratch, ["run", "hook", "--help"], env).stdout;
    const hooks = [...hookPage.matchAll(/staple run hook ([a-z]+-stop)/g)].map((match) => match[1]!);
    expect(hooks.length).toBeGreaterThanOrEqual(7);
    for (const verb of ["install", "bind", "unbind", ...hooks]) argvs.add(`run hook ${verb}`);
    for (const sub of ["connect", "sync", "backup", "restore", "devices"]) argvs.add(`cloud ${sub}`);
    expect(argvs.size).toBeGreaterThan(50);
    const results = await Promise.all(
      [...argvs].flatMap((argv) =>
        ["--help", "-h"].map(async (flag) => ({ argv, flag, result: await runCliAtAsync(scratch, [...argv.split(" "), flag], env, 60_000) })),
      ),
    );
    const failures = results
      .filter(({ result }) => result.status !== 0 || !result.stdout.startsWith("staple ") || result.stderr.includes("error("))
      .map(({ argv, flag, result }) => `${argv} ${flag}: exit ${result.status} ${JSON.stringify((result.stderr || result.stdout).slice(0, 120))}`);
    expect(failures).toEqual([]);
    expect(readdirSync(scratch)).toEqual([]);
    expect(readdirSync(home)).toEqual([]);
  }, 300_000);

  it("a group's page is its entries of staple help: milestone names criterion, kinds shows the verbs it shares", () => {
    const env = { STAPLE_HOME: home, HOME: home };
    const milestone = runCliAt(scratch, ["milestone", "criterion", "--help"], env);
    expect(milestone.status, milestone.stderr).toBe(0);
    expect(milestone.stdout).toContain("milestone criterion <ref> <n> (--met|--unmet|--unknown)");
    expect(milestone.stdout).toContain("milestone new <title>");
    expect(milestone.stdout).not.toContain("queue next");
    const kinds = runCliAt(scratch, ["kinds", "-h"], env);
    expect(kinds.stdout).toContain("kinds ls|add|rename|reorder|rm");
    expect(kinds.stdout).toContain("statuses add <id>");
    // After `--` a "--help" is an argument, not a request for help.
    const literal = runCliAt(scratch, ["new", "--db", `${scratch}/absent/x.db`, "--", "--help"], env);
    expect(literal.stdout.startsWith("staple new")).toBe(false);
  }, 60_000);
});
