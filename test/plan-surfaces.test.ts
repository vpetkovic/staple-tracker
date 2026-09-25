/**
 * The certified plan through every door: `staple compare --json`, MCP `compare_plans` and HTTP
 * `/api/compare` answer one payload, and `planSummary` on `show --json`, `get_task`,
 * `/api/issue` and `/api/agent-context` is the same object. One workspace, written through the
 * CLI the way an agent plans an epic, read back through the others.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCli, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "plans";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let epic: string;
let other: string;
let inner: string;
let leaf: string;
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
const mint = (title: string, ...args: string[]): string => String(cliJson("new", title, ...args).identifier);

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-plans-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-plans-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect(cli("init", "--global", WS).status).toBe(0);

  // Epic: container A (a1 1h, a2 2h) -> B 3h -> C 4h, a gap, a cancelled 5h, and an
  // outside blocker on B.
  epic = mint("Epic");
  inner = mint("A", "--parent", epic);
  refs.a1 = mint("a1", "--parent", inner, "--estimate", "1h");
  refs.a2 = mint("a2", "--parent", inner, "--estimate", "2h");
  other = mint("Other epic", "--estimate", "6h");
  refs.b = mint("B", "--parent", epic, "--estimate", "3h", "--blocked-by", `${refs.a2},${other}`);
  refs.c = mint("C", "--parent", epic, "--estimate", "4h", "--blocked-by", refs.b);
  refs.gap = mint("Gap", "--parent", epic);
  refs.dropped = mint("Dropped", "--parent", epic, "--estimate", "5h");
  expect(cli("cancel", refs.dropped, "--ws", WS).status).toBe(0);
  leaf = refs.c;

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

describe("compare: one payload through the CLI, MCP and HTTP", () => {
  it("reports labor, coverage and the path of each ref, and the overlap", async () => {
    const viaCli = cliJson("compare", epic, other, inner);
    const viaMcp = await tool("compare_plans", { refs: [epic, other, inner] });
    const viaHttp = await http(`/api/compare?ws=${WS}&ref=${epic}&ref=${other}&ref=${inner}`);
    expect(viaHttp.status).toBe(200);
    expect(viaMcp).toEqual(viaCli);
    expect(viaHttp.body).toEqual(viaCli);

    const [e, o, a] = viaCli.plans;
    // 1 + 2 + 3 + 4 = 10h: the cancelled 5h is no labor, the gap is not a 0.
    expect(e.labor).toEqual({ seconds: 10 * 3600, source: "descendants", ownSeconds: null, descendantsSeconds: 10 * 3600 });
    expect(e.coverage).toEqual({ planned: 4, unplanned: 1, units: 5, partial: true, unplannedRefs: [refs.gap], cancelled: 1 });
    expect(e.criticalPath).toMatchObject({
      seconds: 9 * 3600,
      partial: true,
      missing: ["unplanned_units"],
      chainLength: 3,
      crossSubtreeBlockers: [{ blocked: refs.b, blocker: other, blockerStatus: "backlog", resolved: false }],
      unresolvedCrossSubtreeBlockerCount: 1,
    });
    expect(e.criticalPath.chain.map((step: { ref: string }) => step.ref)).toEqual([refs.a2, refs.b, refs.c]);
    expect(o).toMatchObject({ ref: other, labor: { seconds: 6 * 3600, source: "own" } });
    expect(a).toMatchObject({ ref: inner, labor: { seconds: 3 * 3600 } });
    expect(viaCli.overlaps).toEqual([{ ref: inner, within: epic }]);
  });

  it("prints no tree: two lines per ref and the overlap note", () => {
    const result = cli("compare", epic, other, "--ws", WS);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[1]).toBe(`  labor ≥10h (descendants) · 4 of 5 units planned · 1 cancelled excluded · unplanned ${refs.gap}`);
    expect(lines[2]).toBe(
      `  critical path ≥9h · ${refs.a2} > ${refs.b} > ${refs.c} · partial: unplanned_units · 1 of 1 outside blockers open (${refs.b} <- ${other})`,
    );
  });

  it("is refused without a ref, on every surface", async () => {
    const bare = cli("compare", "--ws", WS);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/at least one issue/);
    const refused = await mcp.call("compare_plans", { refs: [], ws: WS });
    expect(refused.isError).toBe(true);
    // The UI server answers every staple code but not_found with 409 (`src/ui/server.ts`).
    const viaHttp = await http(`/api/compare?ws=${WS}`);
    expect(viaHttp.status).toBe(409);
    expect(JSON.stringify(viaHttp.body)).toMatch(/at least one issue/);
  });
});

describe("planSummary rides the detail surfaces", () => {
  it("is the same object on show --json, get_task, /api/issue and /api/agent-context", async () => {
    const viaCli = cliJson("show", epic).planSummary;
    expect(viaCli.labor.seconds).toBe(10 * 3600);
    expect((await tool("get_task", { ref: epic })).planSummary).toEqual(viaCli);
    expect((await http(`/api/issue?ws=${WS}&ref=${epic}`)).body.planSummary).toEqual(viaCli);
    expect((await http(`/api/agent-context?ws=${WS}&ref=${epic}`)).body.planSummary).toEqual(viaCli);
    // And it is compare's entry for the same ref, field for field.
    const { ref: _ref, title: _title, kind: _kind, status: _status, ...entry } = cliJson("compare", epic).plans[0];
    expect(entry).toEqual(viaCli);
  });

  it("is null for a leaf, whose plan is its own estimate on timing", async () => {
    expect(cliJson("show", leaf).planSummary).toBeNull();
    expect((await tool("get_task", { ref: leaf })).planSummary).toBeNull();
  });

  it("show prints the plan lines for a parent", () => {
    const out = cli("show", epic, "--ws", WS).stdout;
    expect(out).toContain(`\nlabor ≥10h (descendants) · 4 of 5 units planned`);
    expect(out).toContain(`\ncritical path ≥9h · ${refs.a2} > ${refs.b} > ${refs.c}`);
  });
});
