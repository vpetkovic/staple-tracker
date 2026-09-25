/**
 * Forecasts through every door: `staple forecast --json`, MCP `forecast` and HTTP
 * `/api/forecast` answer one payload from one store method, with completion and budget as
 * separate blocks, the same snapshot ids and the same refusals; the human rendering says the
 * same figures in a few lines.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setClock } from "../src/core/types.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCli, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "forecasts";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
const refs: Record<string, string> = {};

function cli(...args: string[]) {
  return runCli(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}
function cliJson(...args: string[]): any {
  const result = cli(...args, "--ws", WS, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}
async function http(path: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": token } });
  return { status: response.status, body: await response.json() };
}
async function tool(name: string, args: Record<string, unknown>): Promise<any> {
  const result = await mcp.call(name, { ...args, ws: WS });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  return toolPayload(result);
}
/** Every field but the read's own instant, and what is measured from it (the time left to a reset, the budget snapshot). */
function stable(report: any): Record<string, unknown> {
  const { asOf: _asOf, ...rest } = report;
  const out = JSON.parse(JSON.stringify(rest, (key, value) => (key === "secondsToReset" ? "<from asOf>" : value)));
  expect(out.snapshot.budget.id).toMatch(/^forecast2-budget:[0-9a-f]{32}$/);
  out.snapshot.budget.id = "<from asOf>";
  return out;
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-forecast-surfaces-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-forecast-surfaces-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect(cli("init", "--global", WS).status).toBe(0);

  /**
   * One epic: five exact task leaves worked 20, 30, 40, 60 and 60 minutes against 2 hours (all
   * area:ui, pooled ratio 210/600 = 0.35), then open work under it: A (4h) blocking B (2h), and
   * C with no estimate. Every history is written through the store at controlled instants.
   */
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  let clock = T0;
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
  setClock(() => clock);
  const { store } = resolveWorkspace({ ws: WS });
  try {
    refs.epic = store.createIssue({ title: "Forecast me", kind: "epic" }).identifier;
    let t = 0;
    for (const minutes of [20, 30, 40, 60, 60]) {
      at(t);
      const issue = store.createIssue({ title: `sample ${minutes}m`, parent: refs.epic, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high" });
      store.checkoutIssue(issue.id, "w", undefined, {});
      for (let m = t + 10; m < t + minutes; m += 10) (at(m), store.addComment(issue.id, "progress", "w", "agent"));
      at(t + minutes);
      store.updateIssue(issue.id, { status: "done" }, "w");
      t += minutes + 1;
    }
    at(t);
    const a = store.createIssue({ title: "A", parent: refs.epic, estimatedSeconds: 14400, labels: ["area:ui"], priority: "high" });
    const b = store.createIssue({ title: "B", parent: refs.epic, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high", blockedBy: [a.id] });
    const c = store.createIssue({ title: "C", parent: refs.epic, labels: ["area:ui"], priority: "high" });
    Object.assign(refs, { a: a.identifier, b: b.identifier, c: c.identifier });
  } finally {
    setClock(null);
    store.db.close();
  }

  mcp = await startMcpClient({ home, cwd: emptyDir, agent: CONTRACT_AGENT });
  ui = startUiServer({ port: 0, hub: false, ws: WS });
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

describe("forecast: one payload through the CLI, MCP and HTTP", () => {
  it("forecasts the epic's remaining labor and chain, apart from the budget, the same on every surface", async () => {
    const viaCli = cliJson("forecast", refs.epic!, "--reserve", "25%");
    const viaMcp = await tool("forecast", { ref: refs.epic, reserve: "25%" });
    const viaHttp = await http(`/api/forecast?ws=${WS}&ref=${refs.epic}&reserve=25%25`);
    expect(viaHttp.status).toBe(200);
    expect(stable(viaMcp)).toEqual(stable(viaCli));
    expect(stable(viaHttp.body)).toEqual(stable(viaCli));

    expect(Object.keys(viaCli)).toEqual(["asOf", "subject", "filter", "snapshot", "method", "completion", "budget"]);
    expect(viaCli.subject).toMatchObject({ ref: refs.epic, kind: "epic", scope: "subtree" });
    expect(viaCli.snapshot.id).toMatch(/^forecast2:[0-9a-f]{32}$/);
    // The classes came from the calibration `staple calibrate` reads, unfiltered.
    expect(viaCli.snapshot.calibration.id).toBe(cliJson("calibrate").snapshot.id);
    const { completion } = viaCli;
    expect(completion.units).toMatchObject({ total: 8, done: 5, awaitingReview: 0, forecast: 3, known: 2, unknownRefs: [refs.c] });
    // 0.35 × 4h = 5040 s and 0.35 × 2h = 2520 s, on one chain; C is unknown.
    expect(completion.labor.expectedSeconds).toBeCloseTo(7560, 6);
    expect(completion.path.expectedSeconds).toBeCloseTo(7560, 6);
    expect(completion.path.chain.map((step: any) => step.ref)).toEqual([refs.a, refs.b]);
    expect(completion.labor).toMatchObject({ partial: true, missing: ["unknown_units"] });
    expect(completion).not.toHaveProperty("laborDraws");
    // Every unit's own figure agrees with the one `calibrate --for` publishes.
    const calibrated = cliJson("calibrate", "--for", refs.a!).forecasts[0];
    expect(completion.units.items.find((item: any) => item.ref === refs.a).expected.durationSeconds).toBeCloseTo(calibrated.expected.seconds, 9);
    // The budget half: this home has no budget at all, and says so rather than reading 0.
    expect(viaCli.budget).toMatchObject({ machineLocal: true, budgetCapture: false, accounts: [], missing: { accounts: "source_unavailable" } });
    expect(viaCli.budget.reserve).toEqual({ percent: 25, source: "argument", note: null });
    expect(viaCli.budget.work).toEqual({ expectedSeconds: completion.labor.expectedSeconds, partial: true, schedule: "serial_from_as_of" });

    // A pinned model is one filter on every surface.
    const pinned = cliJson("forecast", refs.a!, "--model", "opus");
    expect(stable(await tool("forecast", { ref: refs.a, model: "opus" }))).toEqual(stable(pinned));
    expect(stable((await http(`/api/forecast?ws=${WS}&ref=${refs.a}&model=opus`)).body)).toEqual(stable(pinned));
    expect(pinned.filter).toEqual({ model: "opus", account: null });
    expect(pinned.subject.scope).toBe("unit");
  });

  it("refuses a missing issue, no issue and a bad reserve on every surface", async () => {
    expect(cli("forecast", "NOPE-1", "--ws", WS).status).not.toBe(0);
    expect((await http(`/api/forecast?ws=${WS}&ref=NOPE-1`)).status).toBe(404);
    expect((await http(`/api/forecast?ws=${WS}`)).status).toBe(409);
    expect(cli("forecast", "--ws", WS).status).toBe(2);
    expect(cli("forecast", refs.a!, refs.b!, "--ws", WS).status).toBe(2);
    const bare = cli("forecast", refs.a!, "--reserve", "150", "--ws", WS);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/reserve takes a percent/);
    const viaMcp = await mcp.call("forecast", { ref: refs.a, reserve: "150", ws: WS });
    expect(viaMcp.isError).toBe(true);
    expect((await http(`/api/forecast?ws=${WS}&ref=${refs.a}&reserve=150`)).status).toBe(409);
  });

  it("prints the subject, completion and budget in a few lines", () => {
    const result = cli("forecast", refs.epic!, "--ws", WS);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^${refs.epic} · Forecast me \\(epic, backlog\\) · snapshot forecast2:[0-9a-f]{32} over calibration2:[0-9a-f]{32}$`));
    expect(lines[1]).toBe(`completion  8 units · 5 done · 0 awaiting review · 3 to forecast, 2 known · unknown ${refs.c}`);
    expect(lines[2]).toMatch(/^ {2}labor {5}expected ≥2h6m · p10–p90 .+ · 90% band .+ · unknown_units · plan ≥?\d.* \(descendants\)$/);
    expect(lines[3]).toMatch(new RegExp(`^ {2}path {6}expected ≥2h6m · ${refs.a} > ${refs.b} · p10–p90 `));
    expect(lines[4]).toMatch(/^ {2}confidence low · bounds reach 66\.7% of 90\.0% · unknown_units, bounds_below_confidence · warnings /);
    expect(lines[5]).toBe("budget      this machine · reserve 20.0% (provisional default, until the admission policy defines one) · work ≥2h6m, serial from now");
    expect(lines[6]).toBe("  no account: source_unavailable");
  });
});
