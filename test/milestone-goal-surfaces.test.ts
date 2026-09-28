/**
 * Milestone goal mode across the CLI and MCP: `staple milestone new|set|criterion` and
 * `staple run start --gate-owner` as real child processes, and `create_milestone`,
 * `update_milestone`, `mark_milestone_criterion`, `start_run` and `continue_run` over a
 * real MCP connection, against one scratch staple home. Both call one store, so they answer
 * one shape; this pins that they are wired to it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { normalize, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { spawnAsync } from "./fixtures/spawn-async.js";

let home: string;
let mcp: McpHarness;
const WS = "goals";

async function cli(...args: string[]): Promise<{ status: number; json: Record<string, unknown>; stderr: string }> {
  const result = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args, "--ws", WS, "--json"], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: "agent-cli" }),
    encoding: "utf8",
    timeout: 30_000,
  });
  const text = result.stdout.trim();
  return { status: result.status ?? -1, json: text ? (JSON.parse(text) as Record<string, unknown>) : {}, stderr: result.stderr };
}

async function tool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await mcp.call(name, { ws: WS, ...args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result) as Record<string, unknown>;
}

/** The goal half of a view, comparable across two milestones: who marked it and when differ. */
function goalOf(view: Record<string, unknown>): unknown {
  const goal = view.goal as { criteria: Array<Record<string, unknown>> };
  return normalize({ ...goal, criteria: goal.criteria.map((criterion) => ({ ...criterion, markedBy: "<actor>" })) });
}

beforeAll(async () => {
  home = tempDir("goal-surfaces");
  const init = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "init", "--global", WS], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home }),
    encoding: "utf8",
  });
  expect(init.status).toBe(0);
  expect((await cli("kinds", "add", "milestone", "--label", "Milestone")).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: home, agent: "agent-mcp" });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  removeDir(home);
});

describe("goal mode on the CLI and over MCP", () => {
  it("new, set and criterion answer the same milestone view on both surfaces", async () => {
    const viaCli = await cli("milestone", "new", "Via CLI", "-d", "Why", "--criteria", "Docs written;Tests pass");
    expect(viaCli.status, viaCli.stderr).toBe(0);
    const viaMcp = await tool("create_milestone", { title: "Via MCP", description: "Why", acceptance_criteria: ["Docs written", "Tests pass"] });
    const cliRef = String((viaCli.json.milestone as Record<string, unknown>).identifier);
    const mcpRef = String((viaMcp.milestone as Record<string, unknown>).identifier);
    expect(viaCli.json.milestone).toMatchObject({ description: "Why", acceptanceCriteria: ["Docs written", "Tests pass"] });
    expect(viaMcp.milestone).toMatchObject({ description: "Why", acceptanceCriteria: ["Docs written", "Tests pass"] });

    const setCli = await cli("milestone", "set", cliRef, "--criteria", "Docs written;Tests pass;Released");
    const setMcp = await tool("update_milestone", { ref: mcpRef, acceptance_criteria: ["Docs written", "Tests pass", "Released"] });
    expect((setCli.json.milestone as Record<string, unknown>).acceptanceCriteria).toEqual(["Docs written", "Tests pass", "Released"]);
    expect(goalOf(setCli.json)).toEqual(goalOf(setMcp));

    const markCli = await cli("milestone", "criterion", cliRef, "3", "--met", "--evidence", "the release notes");
    const markMcp = await tool("mark_milestone_criterion", { ref: mcpRef, position: 3, verdict: "met", evidence: ["the release notes"] });
    expect(markCli.status, markCli.stderr).toBe(0);
    expect((markCli.json.goal as { counts: unknown }).counts).toEqual({ met: 1, unmet: 0, unknown: 2, total: 3 });
    expect(goalOf(markCli.json)).toEqual(goalOf(markMcp));

    // The same refusal on both: a met criterion needs evidence.
    const refusedCli = await cli("milestone", "criterion", cliRef, "1", "--met");
    expect(refusedCli.status).toBe(2);
    expect(refusedCli.stderr).toContain("needs evidence");
    const refusedMcp = await mcp.call("mark_milestone_criterion", { ws: WS, ref: mcpRef, position: 1, verdict: "met" });
    expect(refusedMcp.isError).toBe(true);
    expect(JSON.stringify(refusedMcp.content)).toContain("needs evidence");
  });

  it("a goal run starts with its gate owner on both surfaces, and continue carries the goal", async () => {
    const m = String(((await cli("milestone", "new", "Run goal", "--criteria", "Shipped")).json.milestone as Record<string, unknown>).identifier);
    const task = String((await cli("new", "The work")).json.identifier);
    expect((await cli("milestone", "add", m, task)).status).toBe(0);

    // No --gate-owner: the milestone is gated to VP.
    const fromCli = await cli("run", "start", "--scope", m, "--goal-cap", "3");
    expect(fromCli.status, fromCli.stderr).toBe(0);
    expect(fromCli.json.goal).toMatchObject({ gateOwner: "VP", childCap: 3, children: [], gatedAt: expect.any(String) });
    const fromMcp = await tool("start_run", { scope: m, goal_cap: 3, actor: "agent-mcp" });
    // The CLI's run already gated the milestone; the MCP run found that gate pending and opened none.
    expect(fromMcp.goal).toMatchObject({ gateOwner: "VP", childCap: 3, gatedAt: null });

    const answer = await cli("run", "continue");
    expect(answer.json).toMatchObject({ action: "take", ref: task, goal: { milestone: { identifier: m }, counts: { total: 1 }, gate: { state: "pending", ownedByRun: true } } });
    const viaMcp = await tool("continue_run", { actor: "agent-mcp" });
    // The CLI run's gate is a goal-run gate: no stop for the MCP run, which waits on the held task.
    expect(viaMcp).toMatchObject({ action: "wait", reason: "waiting_on_others", goal: { gate: { byGoalRun: true, ownedByRun: false } } });
  });

  it("refuses the reserved goal-run actor name on the CLI (env and flag) and over MCP", async () => {
    const epic = String((await cli("new", "Held epic", "--kind", "epic")).json.identifier);
    expect((await cli("new", "Held child", "--parent", epic)).status).toBe(0);
    // Any command, not only a gate: the name is refused before the command runs.
    const viaEnv = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "comment", epic, "hello", "--ws", WS, "--json"], {
      cwd: REPO_ROOT,
      env: bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: "goal-run:mallory" }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(viaEnv.status).toBe(2);
    expect(viaEnv.stderr).toContain("reserved");
    const viaFlag = await cli("run", "start", "--scope", epic, "--actor", "goal-run:mallory");
    expect(viaFlag.status).toBe(2);
    expect(viaFlag.stderr).toContain("reserved");
    const viaMcp = await mcp.call("gate_task", { ws: WS, ref: epic, owner: "VP", actor: "goal-run:mallory" });
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.content)).toContain("reserved");
  });
});

