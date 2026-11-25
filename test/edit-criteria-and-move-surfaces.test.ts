/**
 * Editing a ticket's criteria and moving it to another parent through the two doors an agent
 * uses: MCP `update_task` and the CLI verbs `staple criteria` and `staple move`. The store owns
 * the semantics (`store-edit-criteria-and-move.test.ts`); this owns the parse, the exit codes and
 * the printed shape, through the real binaries.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_AGENT, cliEnvelope, mcpErrorProse, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "contract";

let home: string;
let emptyDir: string;
let mcp: McpHarness;

async function cli(...args: string[]) {
  return await runCliAsync([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson(...args: string[]): Promise<Record<string, any>> {
  const result = await cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, any>;
}

async function mcpCall(tool: string, input: Record<string, unknown>): Promise<Record<string, any>> {
  const result = await mcp.call(tool, { ...input, ws: WS });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, any>;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-edit-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-edit-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("acceptance criteria", () => {
  it("CLI: lists, adds, removes and replaces them, and says what changed", async () => {
    const t = await cliJson("new", "Scope moved", "--criteria", "a;b;c");
    let out = await cliJson("criteria", t.identifier, "--rm", "1,3", "--add", "d", "--add", "e;f");
    expect(out.acceptanceCriteria).toEqual(["b", "d", "e", "f"]);
    expect(out.criteriaChange).toMatchObject({ from: ["a", "b", "c"], to: ["b", "d", "e", "f"], changed: true });

    const listed = await cli("criteria", t.identifier);
    expect(listed.stdout).toBe("  1. b\n  2. d\n  3. e\n  4. f\n");

    const human = await cli("criteria", t.identifier, "--set", "x;y");
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain("criteria 4 -> 2");
    expect(human.stdout).toContain("  1. x\n  2. y");

    out = await cliJson("criteria", t.identifier, "--clear");
    expect(out.acceptanceCriteria).toEqual([]);
  }, 60_000);

  it("CLI: refuses a position that is not there, an empty --set, and --set with --add (exit 2)", async () => {
    const t = await cliJson("new", "Guarded", "--criteria", "a");
    for (const args of [["--rm", "2"], ["--rm", "x"], ["--set", " ; "], ["--set", "z", "--add", "y"]]) {
      const result = await cli("criteria", t.identifier, ...args, "--json");
      expect(result.status, args.join(" ")).toBe(2);
      expect(cliEnvelope(result)).toMatchObject({ code: "validation" });
    }
    expect((await cliJson("show", t.identifier)).issue.acceptanceCriteria).toEqual(["a"]);
  }, 60_000);

  it("MCP: update_task replaces, adds and removes them and answers criteriaChange", async () => {
    const t = await mcpCall("create_task", { title: "Agent edits", acceptance_criteria: ["a", "b"] });
    let out = await mcpCall("update_task", { ref: t.identifier, remove_criteria: [1], add_criteria: ["c"] });
    expect(out.acceptanceCriteria).toEqual(["b", "c"]);
    expect(out.criteriaChange).toEqual({ from: ["a", "b"], to: ["b", "c"], changed: true, marks: { kept: [], reworded: [], cleared: [] } });
    out = await mcpCall("update_task", { ref: t.identifier, acceptance_criteria: ["only"] });
    expect(out.acceptanceCriteria).toEqual(["only"]);
    const shown = await mcpCall("get_task", { ref: t.identifier });
    expect(shown.issue.acceptanceCriteria).toEqual(["only"]);
  }, 60_000);
});

describe("moving to another parent", () => {
  it("CLI: moves a ticket under another parent and to the top level", async () => {
    const old = await cliJson("new", "Old epic", "--kind", "epic");
    const next = await cliJson("new", "New epic", "--kind", "epic");
    const child = await cliJson("new", "Child", "--parent", old.identifier);
    const out = await cliJson("move", child.identifier, "--parent", next.identifier);
    expect(out).toMatchObject({ parentId: next.id, depth: 1, parentChange: { from: old.identifier, to: next.identifier, changed: true } });

    const human = await cli("move", child.identifier, "--none");
    expect(human.status, human.stderr).toBe(0);
    expect(human.stdout).toContain(`parent ${next.identifier} -> top level`);
    expect((await cliJson("show", child.identifier)).issue.parentId).toBeNull();
  }, 60_000);

  it("CLI: needs a parent or --none, and refuses a loop (exit 2)", async () => {
    const epic = await cliJson("new", "Loop epic", "--kind", "epic");
    const child = await cliJson("new", "Loop child", "--parent", epic.identifier);
    const missing = await cli("move", child.identifier, "--json");
    expect(missing.status).toBe(2);
    expect(cliEnvelope(missing)).toMatchObject({ code: "validation" });
    const loop = await cli("move", epic.identifier, "--parent", child.identifier, "--json");
    expect(loop.status).not.toBe(0);
    expect(cliEnvelope(loop)).toMatchObject({ code: "cycle" });
  }, 60_000);

  it("MCP: update_task moves it, answers parentChange, and refuses a loop", async () => {
    const old = await mcpCall("create_task", { title: "MCP old epic", kind: "epic" });
    const next = await mcpCall("create_task", { title: "MCP new epic", kind: "epic" });
    const child = await mcpCall("create_task", { title: "MCP child", parent: old.identifier });
    let out = await mcpCall("update_task", { ref: child.identifier, parent: next.identifier });
    expect(out).toMatchObject({ parentId: next.id, parentChange: { from: old.identifier, to: next.identifier, changed: true } });
    out = await mcpCall("update_task", { ref: child.identifier, parent: null });
    expect(out).toMatchObject({ parentId: null, parentChange: { from: next.identifier, to: null, changed: true } });

    await mcpCall("update_task", { ref: child.identifier, parent: old.identifier });
    const loop = await mcp.call("update_task", { ref: old.identifier, parent: child.identifier, ws: WS });
    expect(loop.isError).toBe(true);
    expect(mcpErrorProse(loop)).toContain("cannot move beneath itself");
  }, 60_000);
});
