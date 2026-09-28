/**
 * Autopilot runs across the CLI and MCP, driven as an agent drives them: `staple run …`
 * as real child processes and `start_run` / `run_status` / `stop_run` over a real MCP
 * connection, against one scratch staple home.
 *
 *   - CLI `--json` and MCP answer the same shapes, because both call one `RunStore`.
 *   - A second start is refused with the same conflict envelope, naming the first run.
 *   - `staple events --follow` streams the run's events as they happen.
 */
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { mcpEnvelope, normalize, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { spawnAsync } from "./fixtures/spawn-async.js";

let home: string;
let mcp: McpHarness;
const WS = "runs";

function env(agent: string): Record<string, string> {
  return bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: agent });
}

async function cli(...args: string[]): Promise<{ status: number; json: Record<string, unknown>; stderr: string }> {
  const result = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args, "--ws", WS, "--json"], {
    cwd: REPO_ROOT,
    env: env("agent-cli"),
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

/** A run with the values that differ per run (ids, instants) made comparable. */
function comparable(run: Record<string, unknown>): unknown {
  return normalize({ ...run, actor: "<actor>" });
}

let epic = "";

beforeAll(async () => {
  home = tempDir("run-surfaces");
  const init = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "init", "--global", WS], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home }),
    encoding: "utf8",
  });
  expect(init.status).toBe(0);
  epic = String((await cli("new", "Epic", "--kind", "epic")).json.identifier);
  expect((await cli("new", "A", "--parent", epic)).status).toBe(0);
  expect((await cli("new", "B", "--parent", epic)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: home, agent: "agent-mcp" });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  removeDir(home);
});

describe("run start, status and stop", () => {
  it("answer one shape on the CLI and over MCP", async () => {
    const fromCli = await cli("run", "start", "--scope", epic, "--max-tickets", "2");
    expect(fromCli.status, fromCli.stderr).toBe(0);
    const fromMcp = await tool("start_run", { scope: epic, max_tickets: 2 });
    expect(fromCli.json).toMatchObject({ actor: "agent-cli", state: "active", scope: { kind: "issue", identifier: epic }, budget: { maxTickets: 2 } });
    expect(fromMcp).toMatchObject({ actor: "agent-mcp" });
    expect(comparable(fromMcp)).toEqual(comparable(fromCli.json));

    const cliStatus = await cli("run", "status");
    const mcpStatus = await tool("run_status", {});
    const cliRuns = cliStatus.json.runs as Array<Record<string, unknown>>;
    const mcpRuns = mcpStatus.runs as Array<Record<string, unknown>>;
    expect(cliRuns).toHaveLength(1);
    expect(mcpRuns).toHaveLength(1);
    expect(cliRuns[0]).toMatchObject({ decision: { stop: false }, facts: { workable: [expect.anything(), expect.anything()] } });
    expect(normalize({ ...mcpRuns[0], run: comparable(mcpRuns[0]!.run as Record<string, unknown>) })).toEqual(
      normalize({ ...cliRuns[0], run: comparable(cliRuns[0]!.run as Record<string, unknown>) }),
    );
    // By id, from the other surface.
    const byId = await tool("run_status", { run_id: fromCli.json.id });
    expect((byId.runs as Array<{ run: { id: string } }>)[0]!.run.id).toBe(fromCli.json.id);

    const stoppedCli = await cli("run", "stop", "-m", "enough");
    const stoppedMcp = await tool("stop_run", { note: "enough" });
    expect(stoppedCli.json).toMatchObject({ state: "stopped", stop: { reason: "stopped_by_human", by: "agent-cli", note: "enough" } });
    expect(stoppedMcp).toMatchObject({ state: "stopped", stop: { reason: "stopped_by_human", by: "agent-mcp", note: "enough" } });

    const all = await cli("run", "status", "--all");
    expect((all.json.runs as Array<{ facts: unknown; decision: { reason: string } }>).map((entry) => [entry.facts, entry.decision.reason])).toEqual([
      [null, "stopped_by_human"],
      [null, "stopped_by_human"],
    ]);
  }, 60_000);

  it("refuse a second live run for the same actor and scope with one envelope, naming the first", async () => {
    const first = await cli("run", "start", "--scope", "queue");
    expect(first.status).toBe(0);
    const again = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "run", "start", "--scope", "queue", "--ws", WS, "--json"], {
      cwd: REPO_ROOT,
      env: env("agent-cli"),
      encoding: "utf8",
    });
    expect(again.status).toBe(4);
    const cliError = JSON.parse(again.stderr.trim()) as Record<string, unknown>;
    expect(cliError).toMatchObject({ code: "conflict", retryable: false, detail: { runId: first.json.id, state: "active" } });

    const viaMcp = await mcp.call("start_run", { ws: WS, scope: "queue", actor: "agent-cli" });
    expect(viaMcp.isError).toBe(true);
    expect(mcpEnvelope(viaMcp)).toEqual(cliError);
    await cli("run", "stop", String(first.json.id));
  }, 60_000);

  it("show in events --follow as they happen", async () => {
    const follower = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, "events", "--follow", "--ws", WS, "--json", "--interval", "25", "--max", "2"], {
      cwd: REPO_ROOT,
      env: env("agent-cli"),
    });
    let stdout = "";
    follower.stdout.setEncoding("utf8");
    follower.stdout.on("data", (chunk: string) => (stdout += chunk));
    const exited = new Promise<number>((resolve) => follower.on("close", (code) => resolve(code ?? -1)));
    // The follower starts at the head of the log: give it time to boot before writing.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const run = await cli("run", "start", "--scope", epic);
    await cli("run", "stop", String(run.json.id), "-m", "seen");
    expect(await exited).toBe(0);
    const kinds = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; payload: { runId: string } });
    expect(kinds.map((event) => event.kind)).toEqual(["run_started", "run_stopped"]);
    expect(kinds.every((event) => event.payload.runId === run.json.id)).toBe(true);
  }, 60_000);
});
