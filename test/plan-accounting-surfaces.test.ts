/**
 * A horizon's accounting on every surface (design/plan.md, "Accounting"): the CLI, the MCP tools
 * and the page's HTTP routes read one derivation, so `horizon ls`, `list_horizons`, `/api/plan`,
 * `milestone show`, `milestone ls` and `get_milestone` report the same done, open and planned
 * units and the same percentage. With planning off, the milestone surfaces read as before.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type CliResult, type McpHarness } from "./fixtures/contract-support.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const WS = "acctws";

let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let horizonRef: string;

async function cli(...args: string[]): Promise<CliResult> {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}

async function cliJson(...args: string[]): Promise<unknown> {
  const result = await cli(...args, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as unknown;
}

async function http(path: string, body?: Record<string, unknown>) {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "x-staple-token": token, ...(body ? { "content-type": "application/json", origin } : {}) },
    body: body ? JSON.stringify({ ws: WS, actor: "VP", ...body }) : undefined,
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

interface Horizon {
  id: string;
  identifier: string;
  name: string;
  units: { done: number; open: number; planned: number; total: number };
  unsizedCount: number;
  ideaCount: number;
  records: { leaves: number; parentCount: number };
  progress: number | null;
}
interface Progress {
  countable: number;
  percent: number | null;
  planned?: number;
  unsized?: number;
  counts: { done: number };
}

const rows = (count: number) => Array.from({ length: count }, (_, at) => ({ key: String(at + 1), title: `Step ${at + 1}`, estimate: "1h", dependsOn: [], acceptance: "Done", owner: null, notes: null }));

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-acct-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-acct-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);
  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  // Now, dated: a promoted epic with two tasks (one done), and an idea with three rows and no tickets.
  expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: true }] })).status).toBe(200);
  const plan = (await http(`/api/plan?ws=${WS}`)).body as unknown as { horizons: Horizon[] };
  const now = plan.horizons[0]!;
  horizonRef = now.identifier;
  expect((await http("/api/plan/horizon-update", { ref: now.id, date: "2026-12-18" })).status).toBe(200);
  const checkout = (await http("/api/plan/capture", { title: "Checkout API", maturity: "shaped", plan: READY_PLAN, horizon: now.id })).body as { idea: { idea: { id: string } } };
  const promoted = (await http("/api/plan/promote", { ref: checkout.idea.idea.id })).body as { idea: { idea: { identifier: string } } };
  const epic = promoted.idea.idea.identifier;
  const cart = (await cliJson("new", "Cart", "--parent", epic)) as { identifier: string };
  await cliJson("new", "Receipt", "--parent", epic);
  await cliJson("checkout", cart.identifier);
  await cliJson("done", cart.identifier, "-m", "landed");
  expect((await http("/api/plan/capture", { title: "Invoice search", maturity: "shaped", plan: { ...READY_PLAN, breakdown: rows(3) }, horizon: now.id })).status).toBe(200);
  // And an umbrella being explored, over a sub-idea with nothing written yet: a parent and an unsized leaf.
  const reporting = (await http("/api/plan/capture", { title: "Reporting", maturity: "exploring", horizon: now.id })).body as { idea: { idea: { id: string } } };
  expect((await http("/api/plan/capture", { title: "Audit trail", maturity: "exploring", horizon: now.id, parent: reporting.idea.idea.id })).status).toBe(200);
}, 90_000);

afterAll(async () => {
  await mcp?.close();
  ui?.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(emptyDir, { recursive: true, force: true });
});

describe("a horizon's accounting on every surface", () => {
  it("reads the same units and percentage on the CLI, MCP and the page", async () => {
    const expected = { units: { done: 1, open: 1, planned: 3, total: 5 }, unsizedCount: 1, progress: 0.2, ideaCount: 4, records: { leaves: 3, parentCount: 1 } };
    const fromCli = ((await cliJson("horizon", "ls")) as Horizon[]).find((h) => h.identifier === horizonRef)!;
    const fromMcp = (toolPayload(await mcp.call("list_horizons", { ws: WS })) as Horizon[]).find((h) => h.identifier === horizonRef)!;
    const fromPage = ((await http(`/api/plan?ws=${WS}`)).body as unknown as { horizons: Horizon[] }).horizons.find((h) => h.identifier === horizonRef)!;
    for (const horizon of [fromCli, fromMcp, fromPage]) expect(horizon).toMatchObject(expected);

    const milestone = { countable: 2, planned: 3, unsized: 1, percent: 20, counts: { done: 1 } };
    expect(((await cliJson("milestone", "show", horizonRef)) as { progress: Progress }).progress).toMatchObject(milestone);
    const listed = (await cliJson("milestone", "ls")) as Array<{ milestone: { identifier: string }; progress: Progress }>;
    expect(listed.find((row) => row.milestone.identifier === horizonRef)!.progress).toMatchObject(milestone);
    const got = await mcp.call("get_milestone", { ws: WS, ref: horizonRef });
    expect(got.isError).toBeFalsy();
    expect((toolPayload(got) as { progress: Progress }).progress).toMatchObject(milestone);
  });

  it("prints leaf ideas, the units and the planned work in the CLI's text", async () => {
    const horizons = await cli("horizon", "ls", "--ws", WS);
    expect(horizons.stdout).toMatch(/3 ideas \(\+1 parent\)\s+1\/5 20% · 3 planned · 1 unsized/);
    const shown = await cli("milestone", "show", horizonRef, "--ws", WS);
    expect(shown.stdout).toContain("progress 1/5 20% · 3 planned · 1 unsized · 2 leaves");
  });

  it("reads as a plain milestone with planning off: ticket leaves only, no planned work", async () => {
    expect((await http("/api/settings", { target: "settings", ops: [{ op: "set", key: "features.planning", value: false }] })).status).toBe(200);
    const shown = (await cliJson("milestone", "show", horizonRef)) as { progress: Progress };
    expect(shown.progress).not.toHaveProperty("planned");
    expect(shown.progress).not.toHaveProperty("unsized");
    expect(shown.progress).toMatchObject({ countable: 2, percent: 50 });
    const got = toolPayload(await mcp.call("get_milestone", { ws: WS, ref: horizonRef })) as { progress: Progress };
    expect(got.progress).not.toHaveProperty("planned");
    const text = await cli("milestone", "show", horizonRef, "--ws", WS);
    expect(text.stdout).toContain("progress 1/2 50% · 2 leaves");
  });
});
