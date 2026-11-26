/**
 * `staple checkpoint` and the `checkpoint` MCP tool write the same handoff through the same
 * operation: the worklog replaced as Done, Next and Files touched, and the branch set when
 * one is given. Exit codes follow the rest of the CLI: 2 for a blank branch, 3 for a
 * ticket that does not exist.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveWorkspace } from "../src/core/workspace.js";
import { CLI_ENTRY, CONTRACT_AGENT, REPO_ROOT, TSX_CLI, cliEnvelope, runCliAsync, startMcpClient, type McpHarness } from "./fixtures/contract-support.js";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ref: string;

async function cli(...args: string[]) {
  return await runCliAsync([...args, "--ws", "app"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}
async function cliJson(...args: string[]): Promise<any> {
  const result = await cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-checkpoint-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-checkpoint-cwd-"));
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", "app"], { STAPLE_HOME: home })).status).toBe(0);
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  const { store } = resolveWorkspace({ ws: "app" });
  try {
    ref = store.createIssue({ title: "Hand off" }).identifier;
  } finally {
    store.db.close();
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("staple checkpoint", () => {
  it("replaces the worklog and sets the branch in one call", async () => {
    const first = await cliJson("checkpoint", ref, "--done", "Parsed it.", "--next", "Wire it.", "--files", "src/a.ts", "--branch", "feat/hand-off");
    expect(first).toMatchObject({ ref, key: "worklog", revision: 1, branchChanged: true, branch: { name: "feat/hand-off", source: "field", setBy: CONTRACT_AGENT } });
    expect(first.body).toBe("## Done\n\nParsed it.\n\n## Next\n\nWire it.\n\n## Files touched\n\nsrc/a.ts\n");
    const doc = await cliJson("doc", ref, "worklog");
    expect(doc).toMatchObject({ revision: 1, body: first.body, author: CONTRACT_AGENT });

    const second = await cliJson("checkpoint", ref, "--done", "Wired it.");
    expect(second).toMatchObject({ revision: 2, body: "## Done\n\nWired it.\n\n## Next\n\n## Files touched\n", branchChanged: false, branch: { name: "feat/hand-off" } });
    expect((await cliJson("doc", ref, "worklog", "--revisions")).length).toBe(2);
    const show = await cli("show", ref);
    expect(show.stdout).toMatch(/^branch feat\/hand-off$/m);
  });

  it("prints the revision and the branch in the terminal", async () => {
    const result = await cli("checkpoint", ref, "--next", "Review.", "--branch", "feat/renamed");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`${ref}  worklog @ revision 3`);
    expect(result.stdout).toContain("branch feat/renamed");
    expect(result.stdout).toContain("empty: Done, Files touched");
  });

  it("reads one section from stdin with -", () => {
    const run = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "checkpoint", ref, "--done", "-", "--next", "n", "--ws", "app", "--json"], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: home, STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT, NODE_NO_WARNINGS: "1" },
      input: "- line one\n- line two\n",
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout).body).toBe("## Done\n\n- line one\n- line two\n\n## Next\n\nn\n\n## Files touched\n");
  });

  it("takes a markdown list as a section, and still refuses a flag with no text", async () => {
    const listed = await cliJson("checkpoint", ref, "--done", "- one\n- two", "--next", "-1 is not stdin", "--files", "none");
    expect(listed.body).toBe("## Done\n\n- one\n- two\n\n## Next\n\n-1 is not stdin\n\n## Files touched\n\nnone\n");
    const forgotten = await cli("checkpoint", ref, "--done", "--json");
    expect(forgotten.status).toBe(2);
  });

  it("refuses a blank branch with exit 2 and writes nothing", async () => {
    const before = (await cliJson("doc", ref, "worklog")).revision;
    const result = await cli("checkpoint", ref, "--done", "d", "--branch", "", "--json");
    expect(result.status).toBe(2);
    expect(cliEnvelope(result)).toMatchObject({ code: "validation" });
    expect((await cliJson("doc", ref, "worklog")).revision).toBe(before);
  });

  it("refuses two sections from stdin with exit 2", async () => {
    const result = await cli("checkpoint", ref, "--done", "-", "--next", "-", "--json");
    expect(result.status).toBe(2);
  });

  it("answers exit 3 for a ticket that does not exist", async () => {
    const result = await cli("checkpoint", ref.replace(/\d+$/, "999"), "--done", "d", "--json");
    expect(result.status).toBe(3);
    expect(cliEnvelope(result)).toMatchObject({ code: "not_found" });
  });

  it("documents itself in staple checkpoint --help and staple help", async () => {
    const own = await cli("checkpoint", "--help");
    expect(own.status).toBe(0);
    expect(own.stdout).toContain("staple checkpoint <ref>");
    expect(own.stdout).toContain("--files");
    expect((await cli("help")).stdout).toContain("checkpoint <ref>");
  });
});

describe("the checkpoint MCP tool", () => {
  it("writes the same handoff as the CLI", async () => {
    const result = await mcp.call("checkpoint", { ws: "app", ref, done: "From MCP.", next: "Ship.", filesTouched: "src/mcp.ts", branch: "feat/from-mcp" });
    expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
    const answer = result.structuredContent as any;
    expect(answer).toMatchObject({ ref, key: "worklog", branchChanged: true, branch: { name: "feat/from-mcp", setBy: CONTRACT_AGENT } });
    expect(answer.body).toBe("## Done\n\nFrom MCP.\n\n## Next\n\nShip.\n\n## Files touched\n\nsrc/mcp.ts\n");
    const doc = await cliJson("doc", ref, "worklog");
    expect(doc).toMatchObject({ revision: answer.revision, body: answer.body });

    const thin = await mcp.call("checkpoint", { ws: "app", ref, next: "Only next." });
    expect(thin.isError, JSON.stringify(thin.content)).toBeFalsy();
    expect(thin.structuredContent).toMatchObject({ revision: answer.revision + 1, body: "## Done\n\n## Next\n\nOnly next.\n\n## Files touched\n", branchChanged: false, branch: { name: "feat/from-mcp" } });
  });

  it("refuses a blank branch and a missing ticket", async () => {
    const blank = await mcp.call("checkpoint", { ws: "app", ref, done: "d", branch: "" });
    expect(blank.isError).toBe(true);
    expect(JSON.stringify(blank.content)).toContain("validation");
    const missing = await mcp.call("checkpoint", { ws: "app", ref: ref.replace(/\d+$/, "999"), done: "d" });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.content)).toContain("not_found");
  });
});
