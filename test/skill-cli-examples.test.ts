/**
 * Every CLI example in the bundled skill (skills/staple/SKILL.md) runs against a scratch
 * workspace through the packaged entry point (`src/package/staple.ts`, what `staple` runs),
 * so a skill that documents a flag the parser refuses fails here instead of in an agent's
 * session.
 *
 * An example is any inline code that starts with `staple `, any code in the table's CLI
 * column, and any code right after the word "CLI" (`(CLI \`new ...\`)`). Placeholders take
 * this file's scratch values. An example that cannot run on a scratch machine is listed in
 * NOT_RUN with the reason, and a listed one that is no longer in the skill fails the test.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT, TSX_CLI, bareEnv, removeDir, runCliAt, tempDir } from "./fixtures/characterize-support.js";

const SKILL = join(REPO_ROOT, "skills", "staple", "SKILL.md");
const PACKAGE_ENTRY = join(REPO_ROOT, "src", "package", "staple.ts");

/** Examples that need more than a scratch workspace, and why. */
const NOT_RUN: Record<string, string> = {
  "branch <ref> --discover": "asks the local gh for the branch's pull requests at GitHub",
};

/** The CLI examples in the skill, in document order, without the leading `staple `. */
export function skillExamples(markdown: string): string[] {
  const examples: string[] = [];
  let cliColumn = -1;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) {
      cliColumn = -1;
      continue;
    }
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.includes("CLI")) {
      cliColumn = cells.indexOf("CLI");
      continue;
    }
    if (cliColumn < 0 || /^-+$/.test(cells[0] ?? "")) continue;
    // A flag after the cell's first example modifies it: `attention --json` (`--hub` ...).
    const spans = [...(cells[cliColumn] ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
    for (const span of spans) {
      if (span.startsWith("-") && examples.length > 0 && span !== spans[0]) examples.push(`${spans[0]} ${span}`);
      else examples.push(span);
    }
  }
  const text = markdown.replace(/\s+/g, " ");
  for (const match of text.matchAll(/(CLI \(?)?`([^`]+)`/g)) {
    const span = match[2]!;
    if (span.startsWith("staple ")) examples.push(span.slice("staple ".length));
    else if (match[1] !== undefined && !span.startsWith("-")) examples.push(span);
  }
  return examples;
}

let home: string;
let repo: string;
let elsewhere: string;

/** Example `index` as argv: placeholders filled, `[optional]` parts kept, `...` as "none". */
function argv(example: string, index: number): string[] {
  const filled = example
    .replace(/\[([^\]]+)\]/g, "$1")
    .replaceAll("...", "none")
    .replaceAll("<ref>", "SKI-1")
    .replaceAll("<slug>", "skill")
    .replaceAll("<name>", "eng-skill")
    .replaceAll("<sha>", "0123abc")
    .replaceAll("<query>", "First")
    .replaceAll("<title>", `Skill example ${index}`); // a title is unique among open issues
  return [...filled.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]!);
}

function staple(args: string[], cwd = repo) {
  const result = spawnSync(process.execPath, [TSX_CLI, PACKAGE_ENTRY, ...args], {
    cwd,
    env: bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: "eng-skill" }),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

beforeAll(() => {
  home = tempDir("skill-examples-home");
  repo = tempDir("skill-examples-repo");
  elsewhere = tempDir("skill-examples-elsewhere");
  expect(runCliAt(repo, ["init", "--slug", "skill", "--yes"], { STAPLE_HOME: home, HOME: home }).status).toBe(0);
  expect(staple(["new", "First task", "--json"]).status).toBe(0);
}, 60_000);

afterAll(() => {
  removeDir(home);
  removeDir(repo);
  removeDir(elsewhere);
});

describe("the skill's CLI examples", () => {
  const examples = skillExamples(readFileSync(SKILL, "utf8"));

  it("are found, on both sides of the command", () => {
    expect(examples.length).toBeGreaterThanOrEqual(15);
    expect(examples).toContain("--json --ws <slug> show <ref>");
    expect(examples).toContain("doctor --ws <slug> --json");
    expect(examples.some((e) => e.includes("--agent <name>"))).toBe(true);
  });

  it("every example left out is still in the skill", () => {
    for (const skipped of Object.keys(NOT_RUN)) expect(examples).toContain(skipped);
  });

  it("run against a scratch workspace", () => {
    const failed: Array<{ example: string; status: number; stderr: string }> = [];
    for (const [index, example] of examples.entries()) {
      if (NOT_RUN[example] !== undefined) continue;
      // A doctor example runs where no workspace is found, so only the one it names can pass.
      const result = staple(argv(example, index), example.startsWith("doctor") ? elsewhere : repo);
      // doctor exits 1 when a check fails on this scratch machine: a diagnosis, not a usage error.
      const allowed = example.startsWith("doctor") ? [0, 1] : [0];
      if (!allowed.includes(result.status)) failed.push({ example, status: result.status, stderr: result.stderr.trim() });
      // The documented doctor invocation diagnoses the workspace it names, not the one found from here.
      if (example.startsWith("doctor") && example.includes("--json")) {
        const workspace = (JSON.parse(result.stdout).checks as Array<{ id: string; status: string; data: { slug?: string } }>).find((c) => c.id === "workspace");
        if (workspace?.status !== "pass" || workspace.data.slug !== "skill") failed.push({ example, status: result.status, stderr: `workspace check: ${JSON.stringify(workspace)}` });
      }
    }
    expect(failed).toEqual([]);
  }, 180_000);
});
