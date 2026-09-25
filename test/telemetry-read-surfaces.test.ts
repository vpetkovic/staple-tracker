/**
 * The telemetry read surfaces, driven as an agent and a person drive them: the CLI as real
 * child processes, MCP over a real stdio connection, and the web UI's HTTP routes, against
 * one scratch staple home (docs/execution-telemetry.md, "One shape on every surface").
 *
 *   - `show --json`, MCP `get_task`, `/api/agent-context` and `/api/issue` carry the same
 *     `attempts` block, from `WorkspaceStore.attemptSummary`.
 *   - `staple attempts --json` = `list_attempts`, `staple attempt <id> --json` =
 *     `get_attempt`, `staple budget --json` = `get_budget`, `staple budget history --json`
 *     = `list_budget_samples`, value for value, and a cursor from one surface pages the other.
 *   - The attempt tools route by `ws` like every other workspace tool.
 *
 * Only the fields that are a reading of the clock (`idleSeconds`, `asOf`, the `to` of a page
 * that runs up to now) are set aside before comparing.
 */
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { mcpEnvelope, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

let home: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
const WS = "readviews";
const OTHER = "elsewhere";

function run(args: string[], agent = "agent-cli"): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home, STAPLE_AGENT: agent }),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

function cli(args: string[], ws: string | null = WS, agent?: string): Record<string, unknown> {
  const result = run([...args, ...(ws ? ["--ws", ws] : []), "--json"], agent);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
}

/** Drop the fields that read the clock, everywhere in a payload. */
function steady(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(steady);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === "idleSeconds" || key === "asOf" || key === "stale" || key === "heldSeconds" || key === "silentSeconds") continue;
      out[key] = steady(inner);
    }
    return out;
  }
  return value;
}

async function http(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

let ref: string;
let endedId: string;
let otherRef: string;
let otherAttempt: string;

beforeAll(async () => {
  home = tempDir("read-surfaces");
  for (const slug of [WS, OTHER]) {
    const init = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, "init", "--global", slug], {
      cwd: REPO_ROOT,
      env: bareEnv({ STAPLE_HOME: home, HOME: home }),
      encoding: "utf8",
    });
    expect(init.status).toBe(0);
  }
  run(["budget", "capture", "on"]);
  expect(run(["budget", "ingest", "--source", "manual", "--account", "personal-max", "--provider", "anthropic", "--limit-key", "five_hour", "--used", "20", "--resets-at", "4h", "--json"]).status).toBe(0);

  ref = String(cli(["new", "Read me", "--estimate", "2h"]).identifier);
  const first = cli(["checkout", ref, "--account", "personal-max"]);
  endedId = String((first.attempt as Record<string, unknown>).id);
  expect(run(["budget", "ingest", "--source", "manual", "--account", "personal-max", "--provider", "anthropic", "--limit-key", "five_hour", "--used", "26", "--resets-at", "4h", "--json"]).status).toBe(0);
  cli(["attempt", "interrupt", ref, "--reason", "provider_limit"]);
  cli(["checkout", ref, "--account", "personal-max"]);

  otherRef = String(cli(["new", "Elsewhere"], OTHER).identifier);
  otherAttempt = String((cli(["checkout", otherRef], OTHER).attempt as Record<string, unknown>).id);

  mcp = await startMcpClient({ home, cwd: home, agent: "agent-mcp" });
  const previous = process.env.STAPLE_HOME;
  process.env.STAPLE_HOME = home;
  try {
    ui = startUiServer({ port: 0, hub: false, ws: WS });
    await once(ui.server, "listening");
  } finally {
    if (previous === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previous;
  }
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 120_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  removeDir(home);
});

describe("the attempts block on every detail surface", () => {
  it("is one value on show --json, get_task, /api/agent-context and /api/issue", async () => {
    const fromCli = cli(["show", ref]).attempts as Record<string, unknown>;
    const fromMcp = (toolPayload(await mcp.call("get_task", { ref, ws: WS })) as Record<string, unknown>).attempts;
    const fromPane = (await http(`/api/agent-context?ref=${ref}`)).attempts;
    const fromDetail = (await http(`/api/issue?ref=${ref}`)).attempts;
    expect(fromCli).toMatchObject({ count: 2, current: { ordinal: 2, state: "running" }, last: { id: endedId, outcome: "interrupted" } });
    expect(steady(fromMcp)).toEqual(steady(fromCli));
    expect(steady(fromPane)).toEqual(steady(fromCli));
    expect(steady(fromDetail)).toEqual(steady(fromCli));
  }, 60_000);

  it("reads the human show line from the same summary", () => {
    const out = run(["show", ref, "--ws", WS]).stdout;
    expect(out).toMatch(/attempts 2 · current #2 agent-cli running/);
    expect(out).toMatch(/last #1 agent-cli interrupted \(provider_limit\)/);
  }, 30_000);
});

describe("CLI --json and MCP answer one shape", () => {
  it("staple attempts = list_attempts, and a cursor from one pages the other", async () => {
    const all = cli(["attempts", ref]);
    expect(steady(toolPayload(await mcp.call("list_attempts", { ref, ws: WS })))).toEqual(steady(all));
    expect(all).toMatchObject({ truncated: false, nextCursor: null, coverage: { itemCount: 2, gaps: [] } });

    const firstCli = cli(["attempts", ref, "--limit", "1"]);
    expect(firstCli).toMatchObject({ truncated: true, nextCursor: expect.any(String) });
    const secondMcp = toolPayload(await mcp.call("list_attempts", { ref, ws: WS, limit: 1, cursor: firstCli.nextCursor })) as Record<string, unknown>;
    const secondCli = cli(["attempts", ref, "--limit", "1", "--cursor", String(firstCli.nextCursor)]);
    expect(steady(secondMcp)).toEqual(steady(secondCli));
    expect((secondMcp.items as Array<Record<string, unknown>>)[0]).toMatchObject({ ordinal: 2 });
  }, 60_000);

  it("staple attempt <id> = get_attempt, burn included", async () => {
    const fromCli = cli(["attempt", endedId]);
    const fromMcp = toolPayload(await mcp.call("get_attempt", { attempt_id: endedId, ws: WS }));
    expect(steady(fromMcp)).toEqual(steady(fromCli));
    expect(fromCli).toMatchObject({
      attempt: { id: endedId, state: "ended", storedState: "ended" },
      transitions: { truncated: false, coverage: { itemCount: 2 } },
      burn: { accountRef: "personal-max", attribution: expect.any(String), limits: [{ limitKey: "five_hour", burnPercent: 6 }] },
    });
  }, 60_000);

  it("staple budget = get_budget, and staple budget history = list_budget_samples", async () => {
    const view = cli(["budget"], null);
    expect(steady(toolPayload(await mcp.call("get_budget", {})))).toEqual(steady(view));
    expect(view).toMatchObject({ budgetCapture: true, accounts: [{ accountRef: "personal-max", limits: [{ limitKey: "five_hour", highWaterPercent: 26, remainingPercent: 74 }] }] });

    const history = cli(["budget", "history", "--account", "personal-max", "--limit", "1"], null);
    const viaMcp = toolPayload(await mcp.call("list_budget_samples", { account: "personal-max", limit: 1 }));
    expect(steady(viaMcp)).toEqual(steady(history));
    expect(history).toMatchObject({ truncated: true, items: [{ usedPercent: 20 }] });
    const rest = toolPayload(await mcp.call("list_budget_samples", { account: "personal-max", cursor: history.nextCursor })) as Record<string, unknown>;
    expect(rest).toMatchObject({ truncated: false, items: [{ usedPercent: 26 }] });
  }, 60_000);
});

describe("ws targeting", () => {
  it("routes the attempt tools into the named workspace, and never into the last one named", async () => {
    const listed = toolPayload(await mcp.call("list_attempts", { ref: otherRef, ws: OTHER })) as Record<string, unknown>;
    expect((listed.items as Array<Record<string, unknown>>).map((item) => item.id)).toEqual([otherAttempt]);
    expect(toolPayload(await mcp.call("get_attempt", { attempt_id: otherAttempt, ws: OTHER }))).toMatchObject({ attempt: { id: otherAttempt } });
    // The attempt belongs to OTHER: asked of WS, it is not there.
    const wrong = await mcp.call("get_attempt", { attempt_id: otherAttempt, ws: WS });
    expect(wrong.isError).toBe(true);
    expect(mcpEnvelope(wrong)).toMatchObject({ code: "not_found" });
    // Without ws the server resolves its own default (none here), not the last ws named.
    const unnamed = await mcp.call("list_attempts", { ref: otherRef });
    expect(unnamed.isError).toBe(true);
  }, 60_000);
});

describe("refusals keep the envelope and exit codes", () => {
  it("validation for a missing ref, a bad limit or a foreign cursor; not_found for an unknown attempt", () => {
    const noRef = run(["attempts", "--ws", WS, "--json"]);
    expect(noRef.status).toBe(2);
    expect(JSON.parse(noRef.stderr.trim())).toMatchObject({ code: "validation" });
    expect(run(["attempts", ref, "--limit", "0", "--ws", WS, "--json"]).status).toBe(2);
    expect(run(["attempts", ref, "--cursor", "bogus", "--ws", WS, "--json"]).status).toBe(2);
    const unknown = run(["attempt", "00000000-0000-4000-8000-000000000000", "--ws", WS, "--json"]);
    expect(JSON.parse(unknown.stderr.trim())).toMatchObject({ code: "not_found" });
    expect(run(["budget", "history", "--json"]).status).toBe(2);
  }, 60_000);
});
