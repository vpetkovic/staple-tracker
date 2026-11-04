/**
 * Autopilot runs across the CLI and MCP, driven as an agent drives them: `staple run …`
 * as real child processes and `start_run` / `run_status` / `stop_run` over a real MCP
 * connection, against one scratch staple home.
 *
 *   - CLI `--json` and MCP answer the same shapes, because both call one `RunStore`.
 *   - A second start is refused with the same conflict envelope, naming the first run.
 *   - `staple events --follow` streams the run's events as they happen.
 *   - `run continue` reaches every stop reason, a wait and a take through the CLI alone,
 *     the way a driver loop does, and `continue_run` answers the same shape.
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
  return cliAs("agent-cli", ...args);
}

async function cliAs(agent: string, ...args: string[]): Promise<{ status: number; json: Record<string, unknown>; stderr: string }> {
  const result = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args, "--ws", WS, "--json"], {
    cwd: REPO_ROOT,
    env: env(agent),
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

/** An epic with open children, titled uniquely (the store refuses duplicate open titles). */
async function epicWith(name: string, children: number): Promise<{ epic: string; kids: string[] }> {
  const epicRef = String((await cli("new", `${name} epic`, "--kind", "epic")).json.identifier);
  const kids: string[] = [];
  for (let i = 1; i <= children; i += 1) kids.push(String((await cli("new", `${name} ${i}`, "--parent", epicRef)).json.identifier));
  return { epic: epicRef, kids };
}

describe("run continue, driven through the CLI as a driver loop drives it", () => {
  /** One `run continue` as `agent`; exit 0 for take, wait and stop alike. */
  async function next(agent: string, ...flags: string[]): Promise<Record<string, unknown>> {
    const result = await cliAs(agent, "run", "continue", ...flags);
    expect(result.status, result.stderr).toBe(0);
    return result.json;
  }

  it("no_run: an actor with no live run gets a stop, exit 0, and no run", async () => {
    expect(await next("nobody")).toMatchObject({ action: "stop", reason: "no_run", run: null, recorded: null });
  }, 60_000);

  it("take, resume, record, wait on review, then scope_empty completes the run", async () => {
    const { epic: scope, kids: [x1, x2] } = await epicWith("Loop", 2);
    const who = "drv-loop";
    expect((await cliAs(who, "run", "start", "--scope", scope)).status).toBe(0);
    expect(await next(who)).toMatchObject({ action: "take", ref: x1, resumed: false });
    expect((await cli("show", x1!)).json).toMatchObject({ issue: { checkoutAgent: who } });
    expect(await next(who)).toMatchObject({ action: "take", ref: x1, resumed: true });
    expect((await cliAs(who, "status", x1!, "in_review")).status).toBe(0);
    expect(await next(who)).toMatchObject({ action: "take", ref: x2, recorded: { ref: x1, outcome: "done", source: "attempt" } });
    expect((await cliAs(who, "status", x2!, "in_review")).status).toBe(0);
    // Both in review: nothing to take, but the scope is not empty.
    expect(await next(who)).toMatchObject({ action: "wait", reason: "waiting_on_others", retryAfterSeconds: 60, recorded: { ref: x2, outcome: "done" } });
    expect((await cli("done", x1!)).status).toBe(0);
    expect((await cli("done", x2!)).status).toBe(0);
    expect(await next(who)).toMatchObject({ action: "stop", reason: "scope_empty", run: { state: "completed", counts: { taken: 2, done: 2, failed: 0 } } });
  }, 120_000);

  it("failure_streak: two --outcome failed in a row stop the run", async () => {
    const { epic: scope } = await epicWith("Streak", 3);
    const who = "drv-streak";
    await cliAs(who, "run", "start", "--scope", scope);
    await next(who);
    expect(await next(who, "--outcome", "failed", "--reason", "red")).toMatchObject({ action: "take", recorded: { outcome: "failed", reason: "red" } });
    expect(await next(who, "--outcome", "failed", "--reason", "red again")).toMatchObject({ action: "stop", reason: "failure_streak", run: { state: "stopped" } });
  }, 120_000);

  it("run status counts a retried ticket once against --max-tickets, in text and JSON", async () => {
    const { epic: scope } = await epicWith("Retry count", 2);
    const who = "drv-retry-count";
    await cliAs(who, "run", "start", "--scope", scope, "--max-tickets", "5");
    const first = await next(who);
    expect(await next(who, "--outcome", "failed", "--reason", "build broke")).toMatchObject({ action: "take", ref: first.ref });
    expect((await cliAs(who, "run", "status")).json).toMatchObject({ runs: [{ run: { counts: { tickets: 1, taken: 2, failed: 1, open: 1 } } }] });
    const text = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "run", "status", "--ws", WS], { cwd: REPO_ROOT, env: env(who), encoding: "utf8", timeout: 30_000 });
    expect(text.status, text.stderr).toBe(0);
    expect(text.stdout).toContain("1/5 tickets (2 takes)");
    expect(text.stdout).not.toContain("2/5 tickets");
  }, 120_000);

  it("budget tickets, time and ceiling each stop a run", async () => {
    const { epic: scope } = await epicWith("Budget", 3);
    await cliAs("drv-tickets", "run", "start", "--scope", scope, "--max-tickets", "1");
    const first = await next("drv-tickets");
    // A failed ticket is retried once without spending the budget; a finished one spends it.
    expect(await next("drv-tickets", "--outcome", "failed", "--reason", "x")).toMatchObject({ action: "take", ref: first.ref });
    expect((await cliAs("drv-tickets", "status", String(first.ref), "in_review")).status).toBe(0);
    expect(await next("drv-tickets")).toMatchObject({ action: "stop", reason: "budget", detail: { budget: "tickets", maxTickets: 1 } });

    await cliAs("drv-time", "run", "start", "--scope", scope, "--until", "1s");
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(await next("drv-time")).toMatchObject({ action: "stop", reason: "budget", detail: { budget: "time" } });

    // Budget readings are machine-level: no --ws.
    const budget = (...args: string[]) =>
      spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", ...args, "--json"], { cwd: REPO_ROOT, env: env("agent-cli"), encoding: "utf8", timeout: 30_000 });
    expect((await budget("capture", "on")).status).toBe(0);
    const reading = await budget("ingest", "--source", "manual", "--account", "acct", "--provider", "anthropic", "--limit-key", "five_hour", "--used", "95", "--resets-at", new Date(Date.now() + 3_600_000).toISOString());
    expect(reading.status, reading.stderr).toBe(0);
    await cliAs("drv-ceiling", "run", "start", "--scope", scope, "--ceiling", "90", "--ceiling-account", "acct");
    expect(await next("drv-ceiling")).toMatchObject({ action: "stop", reason: "budget", detail: { budget: "ceiling", usedPercent: 95, accountRef: "acct" } });
  }, 120_000);

  it("stopped_by_human, gate_pending and vp_blocked stop a run; a stop is the same answer when asked again", async () => {
    const human = await epicWith("Human", 2);
    const started = await cliAs("drv-human", "run", "start", "--scope", human.epic);
    await cli("run", "stop", String(started.json.id), "-m", "enough");
    expect(await next("drv-human", "--run", String(started.json.id))).toMatchObject({ action: "stop", reason: "stopped_by_human", run: { stop: { by: "agent-cli", note: "enough" } } });
    expect(await next("drv-human")).toMatchObject({ action: "stop", reason: "no_run" });

    const gated = await epicWith("Gated", 2);
    await cliAs("drv-gate", "run", "start", "--scope", gated.epic);
    expect((await cli("gate", gated.epic, "--owner", "VP")).status).toBe(0);
    expect(await next("drv-gate")).toMatchObject({ action: "stop", reason: "gate_pending", detail: { gates: [expect.objectContaining({ identifier: gated.epic, owner: "VP" })] } });

    const blocked = await epicWith("Blocked", 2);
    await cliAs("drv-block", "run", "start", "--scope", blocked.epic);
    const taken = await next("drv-block");
    expect((await cliAs("drv-block", "block", String(taken.ref), "--owner", "VP", "--action", "decide")).status).toBe(0);
    expect(await next("drv-block")).toMatchObject({ action: "stop", reason: "vp_blocked", recorded: { ref: taken.ref, outcome: "failed" } });
  }, 120_000);

  it("pause answers wait without taking; resume takes again; CLI and MCP answer one shape", async () => {
    const { epic: scope, kids: [p1] } = await epicWith("Pause", 2);
    await cliAs("agent-mcp", "run", "start", "--scope", scope);
    const paused = await cliAs("agent-mcp", "run", "pause");
    expect(paused.json).toMatchObject({ state: "paused" });
    const fromCli = await next("agent-mcp");
    expect(fromCli).toMatchObject({ action: "wait", reason: "paused", recorded: null });
    const fromMcp = await tool("continue_run", {});
    expect(normalize(fromMcp)).toEqual(normalize(fromCli));
    expect(await tool("resume_run", {})).toMatchObject({ state: "active" });
    const take = await tool("continue_run", {});
    expect(take).toMatchObject({ action: "take", ref: p1, resumed: false });
    // The same call from the CLI now resumes it: one store, one answer.
    expect(await next("agent-mcp")).toMatchObject({ action: "take", ref: p1, resumed: true });
    // A stated failure over MCP is recorded and releases the ticket, as on the CLI.
    const failed = await tool("continue_run", { outcome: "failed", reason: "mcp says no" });
    expect(failed).toMatchObject({ action: "take", recorded: { ref: p1, outcome: "failed", reason: "mcp says no", source: "stated" } });
    expect(await tool("pause_run", {})).toMatchObject({ state: "paused" });
    await tool("stop_run", { note: "done here" });
  }, 120_000);

  it("a run stopped mid-ticket: run stop settles the held ticket itself; one handed on is settled by the next continue without --run", async () => {
    const { epic: scope } = await epicWith("Midway", 2);
    const who = "drv-midway";
    const started = await cliAs(who, "run", "start", "--scope", scope);
    const taken = await next(who);
    const stopped = await cli("run", "stop", String(started.json.id), "-m", "pulled");
    // Still held when it was stopped: failed and released by the stop, on the record.
    expect(stopped.json).toMatchObject({ tickets: [expect.objectContaining({ identifier: taken.ref, outcome: "failed", reason: "stopped_by_human: pulled" })] });
    expect((await cli("show", String(taken.ref))).json).toMatchObject({ issue: { checkoutAgent: null } });
    expect(await next(who)).toMatchObject({ action: "stop", reason: "no_run" });

    // Handed on before the stop, it is the continue that settles it, answering the run's reason.
    const again = await cliAs(who, "run", "start", "--scope", scope);
    const second = await next(who);
    expect((await cliAs(who, "status", String(second.ref), "in_review")).status).toBe(0);
    await cli("run", "stop", String(again.json.id), "-m", "pulled again");
    expect(await next(who, "--outcome", "failed", "--reason", "run was stopped")).toMatchObject({
      action: "stop",
      reason: "stopped_by_human",
      recorded: { ref: second.ref, outcome: "failed", reason: "run was stopped" },
    });
    expect(await next(who)).toMatchObject({ action: "stop", reason: "no_run" });
  }, 120_000);

  it("refuses a bad outcome and a stray flag before touching anything", async () => {
    const bad = await cliAs("drv-bad", "run", "continue", "--outcome", "maybe");
    expect(bad.status).toBe(2);
    expect(JSON.parse(bad.stderr.trim())).toMatchObject({ code: "validation" });
    const stray = await cliAs("drv-bad", "run", "status", "--outcome", "done");
    expect(stray.status).toBe(2);
  }, 60_000);

  // Last: it switches the shared workspace to strict and puts it back.
  it("under queue.policy strict a scoped run follows the whole plan, unless started with --override -m", async () => {
    const { epic: scope, kids: [s1] } = await epicWith("Strict", 2);
    const head = String((await cli("new", "Strict plan head")).json.identifier);
    expect((await cli("queue", "add", head)).status).toBe(0);
    expect((await cli("settings", "set", "queue.policy", "strict")).status).toBe(0);
    try {
      await cliAs("drv-plain", "run", "start", "--scope", scope);
      expect(await next("drv-plain")).toMatchObject({ action: "wait", reason: "out_of_order", detail: { expected: [head] } });
      await cliAs("drv-plain", "run", "stop");

      const bare = await cliAs("drv-over", "run", "start", "--scope", scope, "--override");
      expect(bare.status).toBe(2);
      const started = await cliAs("drv-over", "run", "start", "--scope", scope, "--override", "-m", "epic first today");
      expect(started.json).toMatchObject({ override: "epic first today" });
      expect(await next("drv-over")).toMatchObject({ action: "take", ref: s1 });
      const log = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "events", "--ws", WS, "--json"], { cwd: REPO_ROOT, env: env("agent-cli"), encoding: "utf8", timeout: 30_000 });
      const overridden = log.stdout
        .trim()
        .split("\n")
        .flatMap((line) => {
          const parsed = JSON.parse(line) as unknown;
          return (Array.isArray(parsed) ? parsed : ((parsed as { events?: unknown[] }).events ?? [parsed])) as Array<{ kind: string; actor: string; payload: Record<string, unknown> }>;
        })
        .filter((event) => event.kind === "queue_overridden");
      expect(overridden).toEqual([expect.objectContaining({ actor: "drv-over", payload: expect.objectContaining({ identifier: s1, reason: "epic first today", expected: [head] }) })]);
      await cliAs("drv-over", "run", "stop");
      // MCP takes the same reason.
      const viaMcp = await tool("start_run", { scope, override_reason: "from mcp" });
      expect(viaMcp).toMatchObject({ override: "from mcp" });
      await tool("stop_run", {});
    } finally {
      await cli("settings", "set", "queue.policy", "advisory");
    }
  }, 120_000);
});
