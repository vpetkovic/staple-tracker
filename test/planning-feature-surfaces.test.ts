import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import { runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
const WS = "larkspur";
let home: string, cwd: string, mcp: McpHarness, ui: UiHandle, origin: string;
const cli = (...args: string[]) => runCliAsync([...args, "--ws", WS, "--json"], { STAPLE_HOME: home, STAPLE_AGENT: "worker" });
async function http(path: string, body?: object) {
  const response = await fetch(`${origin}${path}${path.includes("?") ? "&" : "?"}ws=${WS}`, { method: body ? "POST" : "GET", headers: { "x-staple-token": ui.token, origin, "content-type": "application/json" }, body: body ? JSON.stringify({ ws: WS, actor: "Larkspur owner", ...body }) : undefined });
  return { status: response.status, body: await response.json() };
}
beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "larkspur-flag-"));
  cwd = mkdtempSync(join(tmpdir(), "larkspur-cwd-"));
  process.env.STAPLE_HOME = home;
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home })).status).toBe(0);
  expect((await runCliAsync(["config", "set", "humanName", "Larkspur owner"], { STAPLE_HOME: home })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd, agent: "worker" });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
}, 60_000);
afterAll(async () => { await mcp?.close(); ui?.close(); for (const path of [home, cwd]) if (path) rmSync(path, { recursive: true, force: true }); });

it("CLI, MCP and HTTP refuse OFF, report the readable flag, and restore ON", async () => {
  for (const command of [["plan", "show"], ["idea", "ls"], ["horizon", "ls"]]) {
    const result = await cli(...command);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Planning is off in this workspace");
  }
  for (const name of ["list_ideas", "get_idea", "list_horizons", "capture_idea", "update_idea", "scaffold_idea", "start_idea", "unlink_idea", "reset_idea_baseline"]) {
    const result = await mcp.call(name, { ws: WS, ref: "5eed0000-0000-4000-8000-000000000001", issue: "LAR-1", title: "Larkspur idea" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("Planning is off in this workspace");
  }
  const tools = await mcp.client.listTools();
  expect(tools.tools.find(t => t.name === "list_ideas")?.description).toMatch(/^Experimental, only when features.planning is on\./);
  expect(toolPayload(await mcp.call("get_setting", { ws: WS, key: "features.planning" }))).toMatchObject({ value: false });
  expect((await mcp.call("show_about", { ws: WS })).structuredContent).toMatchObject({ features: { planning: false } });
  const refused = await mcp.call("set_setting", { ws: WS, key: "features.planning", value: true, actor: "Larkspur owner" });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused)).toContain("Only a person");
  expect((await cli("settings", "set", "features.planning", "true")).status).toBe(2);
  expect((await http("/api/plan")).status).toBe(409);
  expect((await http("/api/plan-idea?ref=5eed0000-0000-4000-8000-000000000001")).status).toBe(409);
  expect((await http("/api/plan/enable", {})).status).toBe(409);
  expect((await http("/api/plan/capture", { title: "Larkspur idea" })).status).toBe(409);
  expect((await cli("settings", "set", "features.planning", "true", "--person")).status).toBe(0);
  expect((await cli("plan", "show")).status).toBe(0);
  expect((await mcp.call("list_ideas", { ws: WS })).isError).toBeFalsy();
  expect((await http("/api/plan")).status).toBe(200);
  expect((await http("/api/plan/enable", {})).status).toBe(404);
  expect(mcp.client.getInstructions()).toContain("get_setting");
  expect((await http("/api/bootstrap")).body.features[WS]).toMatchObject({ planning: true });
  expect((await mcp.call("show_about", { ws: WS })).structuredContent).toMatchObject({ features: { planning: true } });
  expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: false }] })).status).toBe(200);
  expect((await http("/api/plan")).status).toBe(409);
  expect((await http("/api/bootstrap")).body.features[WS]).toMatchObject({ planning: false });
});

it("OFF omits plan detail and horizon fields from task and pickup payloads", async () => {
  expect((await cli("settings", "set", "features.planning", "true", "--person")).status).toBe(0);
  const task = JSON.parse((await cli("new", "Larkspur work")).stdout);
  const plan = (await http("/api/plan")).body;
  const horizon = plan.horizons[0];
  const captured = await http("/api/plan/capture", { title: "Larkspur shaped idea", maturity: "shaped", horizon: horizon.id, plan: READY_PLAN });
  const idea = captured.body.idea.idea;
  expect((await http("/api/plan/adopt", { ref: idea.id, issue: task.id })).status).toBe(200);
  expect((await http("/api/plan/horizon-run", { ref: horizon.id, mode: "epic", goal: ["Larkspur ships"] })).status).toBe(200);
  expect((await http("/api/issues")).body.find((r: { issue: { id: string } }) => r.issue.id === task.id).horizon.id).toBe(horizon.id);
  expect(JSON.stringify(toolPayload(await mcp.call("next_task", { ws: WS })))).toContain("horizon-run");
  expect(JSON.stringify(JSON.parse((await cli("queue", "next")).stdout))).toContain("horizon-run");
  expect((await cli("settings", "set", "features.planning", "false", "--person")).status).toBe(0);
  expect((await http(`/api/issue?ref=${idea.id}`)).status).toBe(409);
  expect((await mcp.call("get_task", { ws: WS, ref: idea.id })).isError).toBe(true);
  expect((await http(`/api/issue?ref=${horizon.id}`)).body.issue.kind).toBe("milestone");
  const milestoneWrite = await http("/api/milestone/update", { ref: horizon.id, targetDate: "2027-01-01" });
  expect(milestoneWrite.status).toBe(409); expect(JSON.stringify(milestoneWrite.body)).toContain("Planning is off");
  expect((await mcp.call("update_task", { ws: WS, ref: horizon.id, title: "Agent rename" })).isError).toBe(true);
  expect((await cli("set", horizon.id, "--title", "Agent rename")).status).toBe(2);
  const rows = (await http("/api/issues")).body;
  expect(rows.some((r: { issue: { id: string } }) => r.issue.id === idea.id)).toBe(false);
  expect(rows.every((r: Record<string, unknown>) => !("horizon" in r))).toBe(true);
  expect(JSON.stringify(JSON.parse((await cli("queue", "next")).stdout))).not.toContain("horizon-run");
  const detail = (await http(`/api/issue?ref=${task.id}`)).body;
  expect(detail).not.toHaveProperty("planRecord");
  expect(detail).not.toHaveProperty("horizonPlan");
  for (const name of ["next_task", "list_queue"]) {
    const payload = toolPayload(await mcp.call(name, { ws: WS }));
    expect(JSON.stringify(payload)).not.toMatch(/horizon|planRecord|runMode|plan_maturity/);
  }
});


it("generic parent requests refuse idea parenting over MCP and HTTP in both states", async () => {
  expect((await cli("settings", "set", "features.planning", "true", "--person")).status).toBe(0);
  const task = JSON.parse((await cli("new", "Larkspur parent guard work")).stdout);
  const captured = await http("/api/plan/capture", { title: "Larkspur parent guard idea" });
  const idea = captured.body.idea.idea;
  for (const enabled of [true, false]) {
    expect((await cli("settings", "set", "features.planning", String(enabled), "--person")).status).toBe(0);
    const response = await mcp.call("update_task", { ws: WS, ref: task.id, parent: idea.id });
    expect(response.isError).toBe(true); expect(JSON.stringify(response)).toContain("idea");
    const page = await http("/api/action", { type: "update", ref: task.id, parent: idea.id });
    expect(page.status).toBe(409); expect(JSON.stringify(page.body)).toContain("idea");
  }
});
