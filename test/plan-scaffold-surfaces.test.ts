/**
 * The shaped gate and Scaffold on every surface (design/plan.md, "Scaffold"): the page (HTTP, as
 * the person), the CLI with --person, and an agent over MCP refuse shaping a plan the gate does
 * not pass, naming what is missing; the three previews of one idea agree; and a confirm creates
 * the tasks once, whichever surface retries.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const WS = "scaffws";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const cli = (...args: string[]) => runCliAsync([...args, "--ws", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });

async function capture(title: string, extra: Record<string, unknown> = {}): Promise<string> {
  const made = await http("/api/plan/capture", { title, ...extra });
  expect(made.status, JSON.stringify(made.body)).toBe(200);
  return (made.body.idea as { idea: { id: string } }).idea.id;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-scaffold-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-scaffold-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await runCliAsync(["init", "--global", WS], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  expect((await runCliAsync(["config", "set", "humanName", "VP"], { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT })).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  expect((await http("/api/plan/enable", {})).status).toBe(200);
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("the shaped gate on every surface", () => {
  it("refuses shaping a thin plan on the page and the CLI, naming what is missing, and lets a ready one through", async () => {
    const thin = await capture("Thin plan", { maturity: "exploring" });
    const page = await http("/api/plan/update", { ref: thin, maturity: "shaped" });
    expect(page.status).toBe(409);
    expect(JSON.stringify(page.body)).toContain("cannot be marked shaped yet: it needs a goal, a task breakdown and acceptance criteria");
    const terminal = await cli("idea", "set", thin, "--maturity", "shaped", "--person");
    expect(terminal.status).not.toBe(0);
    expect(terminal.stderr).toContain("cannot be marked shaped yet");
    // An agent may write the plan; shaping stays the person's.
    expect((await mcp.call("update_idea", { ws: WS, ref: thin, plan: READY_PLAN })).isError).toBeFalsy();
    const agent = await mcp.call("update_idea", { ws: WS, ref: thin, maturity: "shaped" });
    expect(JSON.stringify(agent.content)).toContain("the person's call");
    expect((await http("/api/plan/update", { ref: thin, maturity: "shaped" })).status).toBe(200);
  });

  it("shows what shaping needs on the idea itself", async () => {
    const thin = await capture("Still thin", { maturity: "exploring", plan: { goal: "Something" } });
    const detail = toolPayload(await mcp.call("get_idea", { ws: WS, ref: thin })) as { missingForShaped: string[]; idea: { actions: Array<{ id: string; disabledReason?: string }> } };
    expect(detail.missingForShaped).toEqual(["a task breakdown", "acceptance criteria"]);
    expect(detail.idea.actions.find((action) => action.id === "shape")?.disabledReason).toContain("a task breakdown and acceptance criteria");
  });
});

describe("Scaffold on every surface", () => {
  const PLAN = {
    goal: "Two tasks.",
    acceptance: ["Both done"],
    breakdown: [
      { key: "1", title: "First", estimate: "2h", dependsOn: [], acceptance: "First done", owner: null, notes: null },
      { key: "2", title: "Second", estimate: "1h", dependsOn: ["1"], acceptance: "Second done", owner: null, notes: null },
    ],
  };

  it("previews the same on the page, the CLI and MCP, writes nothing, and creates once on confirm", async () => {
    const id = await capture("Scaffold me", { maturity: "shaped", plan: PLAN });
    const page = (await http("/api/plan/scaffold", { ref: id, preview: true })).body.scaffold;
    const terminal = JSON.parse((await cli("idea", "scaffold", id, "--preview", "--json")).stdout) as unknown;
    const agent = (toolPayload(await mcp.call("scaffold_idea", { ws: WS, ref: id })) as { preview: boolean; scaffold: unknown }).scaffold;
    expect(terminal).toEqual(page);
    expect(agent).toEqual(page);
    expect((await mcp.call("get_idea", { ws: WS, ref: id })).isError).toBeFalsy();
    const before = toolPayload(await mcp.call("list_tasks", { ws: WS })) as { items: unknown[] };

    const confirmed = toolPayload(await mcp.call("scaffold_idea", { ws: WS, ref: id, confirm: true })) as { scaffold: { tasks: Array<{ existing: string }>; epic: { identifier: string } } };
    expect(confirmed.scaffold.epic.identifier).toMatch(/^[A-Z]+-\d+$/);
    const numbers = confirmed.scaffold.tasks.map((task) => task.existing);
    expect(numbers.every((n) => /^[A-Z]+-\d+$/.test(n))).toBe(true);
    // A retry from another surface creates nothing.
    const retried = JSON.parse((await cli("idea", "scaffold", id, "--json")).stdout) as { tasks: Array<{ existing: string }> };
    expect(retried.tasks.map((task) => task.existing)).toEqual(numbers);
    const after = toolPayload(await mcp.call("list_tasks", { ws: WS })) as { items: unknown[] };
    expect(after.items.length - before.items.length).toBe(3);
    const second = toolPayload(await mcp.call("get_task", { ws: WS, ref: numbers[1] })) as { blockedBy: Array<{ identifier: string }>; documents: Array<{ key: string }> };
    expect(second.blockedBy.map((b) => b.identifier)).toEqual([numbers[0]]);
    expect(second.documents.map((d) => d.key)).toContain("context");
  });

  it("imports a plan file from the CLI, saying what it read", async () => {
    const file = join(emptyDir, "PLAN-7-checkout.md");
    writeFileSync(file, "# PLAN-7 — Checkout\n\n## Goal\n\nShip it.\n\n## Task breakdown\n\n| # | Task | Est. |\n|---|---|---|\n| 7.1 | Spike | 3h |\n\n## Acceptance criteria\n\n- Works\n");
    const result = await cli("idea", "import", file);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/^imported PLAN-7 — Checkout \(idea [0-9a-f-]{36}\): 1 task, 4\/10 sections/);
  });
});
