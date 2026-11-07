/**
 * The plan layer on every surface (design/plan.md): the CLI, the MCP tools and the HTTP
 * routes read one plan, refuse an agent's steering with the same `validation`, and let the
 * person steer from the page (HTTP) and from the CLI with `--person`.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type CliResult, type McpHarness } from "./fixtures/contract-support.js";

const WS = "planws";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

async function cli(...args: string[]): Promise<CliResult> {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson(...args: string[]): Promise<unknown> {
  const result = await cli(...args, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

async function mcpCall(name: string, args: Record<string, unknown>) {
  return await mcp.call(name, { ws: WS, ...args });
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface Idea {
  identifier: string;
  maturity: string;
  stage: string;
  horizonId: string | null;
  planned: { start: string | null; target: string | null };
  baseline: { start: string | null; target: string | null } | null;
}
interface Plan {
  enabled: boolean;
  horizons: Array<{ id: string; identifier: string; name: string }>;
  ideas: Idea[];
}

const byId = (plan: Plan, identifier: string) => plan.ideas.find((idea) => idea.identifier === identifier)!;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plan-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-plan-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);
  expect((await cli("new", "Existing epic", "--kind", "epic", "--ws", WS)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the plan on every surface", () => {
  it("is off until enabled, and every surface says so the same way", async () => {
    expect((await cliJson("plan", "show")) as Plan).toMatchObject({ enabled: false });
    expect(toolPayload(await mcpCall("list_ideas", {}))).toMatchObject({ enabled: false });
    expect((await http(`/api/plan?ws=${WS}`)).body).toMatchObject({ enabled: false });
    const refused = await mcpCall("capture_idea", { title: "too early" });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("staple plan enable");
    expect((await cliJson("plan", "enable")) as Plan).toMatchObject({ enabled: true });
  });

  it("captures on every surface and reads the same plan three ways", async () => {
    await cliJson("idea", "new", "From the CLI");
    expect((await mcpCall("capture_idea", { title: "From MCP", brief: "why" })).isError).toBeFalsy();
    expect((await http("/api/plan/capture", { title: "From the page", maturity: "shaped" })).status).toBe(200);
    const fromCli = (await cliJson("plan", "show")) as Plan;
    const fromMcp = toolPayload(await mcpCall("list_ideas", {})) as Plan;
    const fromHttp = (await http(`/api/plan?ws=${WS}`)).body as unknown as Plan;
    const shape = (plan: Plan) => plan.ideas.map((idea) => [idea.identifier, idea.maturity, idea.stage]);
    expect(shape(fromCli)).toEqual([
      ["PLA-5", "raw", "raw"],
      ["PLA-6", "raw", "raw"],
      ["PLA-7", "shaped", "shaped"],
    ]);
    expect(shape(fromMcp)).toEqual(shape(fromCli));
    expect(shape(fromHttp)).toEqual(shape(fromCli));
    // Ideas never reach a task view.
    const tasks = toolPayload(await mcpCall("list_tasks", {})) as { items: Array<{ identifier: string }> };
    expect(tasks.items.map((task) => task.identifier)).toEqual(["PLA-1"]);
  });

  it("refuses an agent's steering on the CLI and over MCP, naming why", async () => {
    for (const result of [
      await cli("idea", "set", "PLA-5", "--maturity", "shaped", "--ws", WS),
      await cli("horizon", "new", "Q2", "--ws", WS),
      await cli("idea", "reset-baseline", "PLA-5", "--ws", WS),
    ]) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("the person's call");
    }
    for (const args of [{ maturity: "shaped" }, { horizon: "Now" }, { planned_target: "2026-12-01" }, { parent: "PLA-6" }]) {
      const result = await mcpCall("update_idea", { ref: "PLA-5", ...args });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("the person's call");
    }
    const start = await mcpCall("start_idea", { ref: "PLA-5" });
    expect(start.isError).toBe(true);
    expect(JSON.stringify(start.content)).toContain("not shaped yet");
    const plan = (await cliJson("plan", "show")) as Plan;
    expect(byId(plan, "PLA-5")).toMatchObject({ maturity: "raw", horizonId: null, planned: { start: null, target: null } });
  });

  it("holds the person rule through the plain tracker tools too", async () => {
    const plan = (await cliJson("plan", "show")) as Plan;
    const now = plan.horizons[0]!;
    for (const [tool, args, words] of [
      ["create_task", { title: "Agent horizon", kind: "horizon" }, "the person's call"],
      ["update_task", { ref: now.identifier, title: "Renamed by an agent" }, "the person's call"],
      ["update_task", { ref: now.identifier, status: "cancelled" }, "the person's call"],
      ["update_task", { ref: "PLA-5", status: "cancelled" }, "its status does not move"],
      ["set_blocked_by", { ref: "PLA-1", blockers: ["PLA-5"] }, "cannot be a blocker"],
    ] as const) {
      const result = await mcpCall(tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(JSON.stringify(result.content)).toContain(words);
    }
    const made = toolPayload(await mcpCall("create_task", { title: "Agent idea via create_task", kind: "idea" })) as { identifier: string };
    const after = (await cliJson("plan", "show")) as Plan;
    expect(byId(after, made.identifier)).toMatchObject({ maturity: "raw", stage: "raw" });
    expect(after.horizons.map((h) => h.name)).toEqual(plan.horizons.map((h) => h.name));
  });

  it("lets the agent do the capture-side edits and link work over MCP", async () => {
    const edited = toolPayload(await mcpCall("update_idea", { ref: "PLA-6", title: "From MCP, renamed", add_question: "Who?", add_decision: "Keep it small" })) as {
      idea: { title: string };
      questions: unknown[];
      decisions: string[];
    };
    expect(edited.idea.title).toBe("From MCP, renamed");
    expect(edited.questions).toEqual([{ text: "Who?", resolved: false }]);
    expect(edited.decisions).toHaveLength(1);
    const adopted = toolPayload(await mcpCall("start_idea", { ref: "PLA-6", adopt: "PLA-1" })) as { idea: { idea: Idea }; epic: null };
    expect(adopted.idea.idea.stage).toBe("started");
    expect(adopted.epic).toBeNull();
    const unlinked = toolPayload(await mcpCall("unlink_idea", { ref: "PLA-6", issue: "PLA-1" })) as { idea: Idea };
    expect(unlinked.idea.stage).toBe("raw");
  });

  it("lets the person steer from the page, and an agent start what the person shaped", async () => {
    const plan = (await http(`/api/plan?ws=${WS}`)).body as unknown as Plan;
    const now = plan.horizons[0]!;
    const steered = await http("/api/plan/update", { ref: "PLA-7", horizon: now.id, plannedStart: "2026-10-01", plannedTarget: "2026-11-30" });
    expect(steered.status).toBe(200);
    expect(byId(steered.body.plan as Plan, "PLA-7")).toMatchObject({ horizonId: now.id, stage: "scheduled" });
    const started = toolPayload(await mcpCall("start_idea", { ref: "PLA-7" })) as { idea: { idea: Idea }; epic: { identifier: string } };
    expect(started.idea.idea).toMatchObject({ stage: "started", baseline: { start: "2026-10-01", target: "2026-11-30" } });
    const epic = (await cliJson("show", started.epic.identifier)) as { documents: Array<{ key: string }>; issue: { kind: string } };
    expect(epic.issue.kind).toBe("epic");
    // A re-plan moves the plan and keeps the baseline; the page's reset moves the baseline.
    await http("/api/plan/update", { ref: "PLA-7", plannedTarget: "2026-12-20" });
    const replanned = (await http(`/api/plan-idea?ws=${WS}&ref=PLA-7`)).body as unknown as { idea: Idea };
    expect(replanned.idea.planned.target).toBe("2026-12-20");
    expect(replanned.idea.baseline).toEqual({ start: "2026-10-01", target: "2026-11-30" });
    const reset = await http("/api/plan/reset-baseline", { ref: "PLA-7" });
    expect(byId(reset.body.plan as Plan, "PLA-7").baseline).toEqual({ start: "2026-10-01", target: "2026-12-20" });
  });

  it("lets a person at the terminal steer with --person, under the configured name", async () => {
    const before = await cli("idea", "set", "PLA-5", "--maturity", "exploring", "--person", "--ws", WS);
    expect(before.status).not.toBe(0);
    expect(before.stderr).toContain("humanName");
    expect((await cli("config", "set", "humanName", "VP")).status).toBe(0);
    const detail = (await cliJson("idea", "set", "PLA-5", "--maturity", "exploring", "--person")) as { idea: Idea };
    expect(detail.idea.maturity).toBe("exploring");
    const horizons = (await cliJson("horizon", "new", "Q2", "--date", "2027-06-30", "--person")) as Array<{ name: string }>;
    // A dated horizon goes in date order ahead of the undated ones.
    expect(horizons.map((h) => h.name)).toEqual(["Q2", "Now", "Next", "Later"]);
  });

  it("keeps the baseline reset away from the model: the MCP tool is app-only", async () => {
    const tools = await mcp.listTools();
    const reset = tools.find((tool) => tool.name === "reset_idea_baseline") as { _meta?: { ui?: { visibility?: string[] } } } | undefined;
    expect(reset?._meta?.ui?.visibility).toEqual(["app"]);
  });
});
