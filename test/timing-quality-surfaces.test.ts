/**
 * Timing quality through every door: `staple timing quality --json`, MCP `timing_quality` and
 * HTTP `/api/timing/quality` answer one payload from one store method, with the same filters,
 * the same exclusions and the same cursor. One workspace, written through the CLI the way
 * agents work it, read back through the others.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCli, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "quality";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let epic: string;
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
/** Every field but the read's own instant, which each call stamps. */
const withoutAsOf = ({ asOf: _asOf, ...rest }: { asOf: string }): Record<string, unknown> => rest;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-quality-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-quality-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect(cli("init", "--global", WS).status).toBe(0);

  // An epic with two leaves worked and landed at once (under the floor), one landed without
  // ever starting (missing), one still open and one cancelled: three eligible records.
  epic = mint("Epic");
  for (const name of ["quick", "quicker"]) {
    refs[name] = mint(name, "--parent", epic, "--estimate", "1h");
    expect(cli("checkout", refs[name]!, "--ws", WS).status).toBe(0);
    expect(cli("done", refs[name]!, "--ws", WS).status).toBe(0);
  }
  refs.skipped = mint("skipped", "--parent", epic, "--kind", "bug");
  expect(cli("status", refs.skipped, "done", "--ws", WS).status).toBe(0);
  refs.open = mint("open", "--parent", epic);
  expect(cli("checkout", refs.open, "--ws", WS).status).toBe(0);
  refs.dropped = mint("dropped", "--parent", epic);
  expect(cli("cancel", refs.dropped, "--ws", WS).status).toBe(0);

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

describe("timing quality: one payload through the CLI, MCP and HTTP", () => {
  it("counts each state over the eligible leaves and lists every record with its state", async () => {
    const viaCli = cliJson("timing", "quality", "--parent", epic);
    const viaMcp = await tool("timing_quality", { parent: epic });
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${epic}`);
    expect(viaHttp.status).toBe(200);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));

    expect(viaCli.population).toEqual({ issues: 5, eligible: 3, notEligible: { parents: 0, open: 1, cancelled: 1 } });
    expect(viaCli.work.counts).toEqual({ exact: 0, "timing-floor": 2, approximate: 0, reconstructed: 0, missing: 1 });
    expect(viaCli.items.map((item: { identifier: string; work: { state: string; reasons: string[] } }) => [item.identifier, item.work.state, item.work.reasons])).toEqual([
      [refs.quick, "timing-floor", ["timing_floor"]],
      [refs.quicker, "timing-floor", ["timing_floor"]],
      [refs.skipped, "missing", ["never_started"]],
    ]);
    // The ratio population: the two leaves with their own estimate. Neither is exact.
    expect(viaCli.ratio.total).toBe(2);
    expect(viaCli.ratio.exact).toMatchObject({ count: 0, ratio: null, coverage: { known: 0, total: 2, partial: true }, missing: { ratio: "input_missing" } });
    expect(viaCli.ratio.admitted.count).toBe(2);
  });

  it("filters and excludes the same way on every surface", async () => {
    const viaCli = cliJson("timing", "quality", "--parent", epic, "--kind", "task", "--exclude", "timing-floor", "--exclude-reason", "sparse");
    const viaMcp = await tool("timing_quality", { parent: epic, kind: ["task"], exclude: ["timing-floor"], exclude_reasons: ["sparse"] });
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${epic}&kind=task&exclude=timing-floor&excludeReason=sparse`);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    expect(viaCli.filter).toEqual({ kind: ["task"], parent: epic, since: null, exclude: ["timing-floor"], excludeReasons: ["sparse"] });
    // Kind task: the bug is outside the population; the two task leaves are excluded, and counted.
    expect(viaCli.population.eligible).toBe(2);
    expect(viaCli.items).toEqual([]);
    expect(viaCli.excluded).toEqual({ count: 2, counts: { "timing-floor": 2 }, reasons: { sparse: 0 } });
    expect(viaCli.work.counts["timing-floor"]).toBe(2);
  });

  it("walks the same pages with the same cursor", async () => {
    const first = cliJson("timing", "quality", "--parent", epic, "--limit", "2");
    expect(first.truncated).toBe(true);
    const viaMcp = await tool("timing_quality", { parent: epic, limit: 2, cursor: first.nextCursor });
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${epic}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    const viaCli = cliJson("timing", "quality", "--parent", epic, "--limit", "2", "--cursor", first.nextCursor);
    expect(viaCli.items.map((item: { identifier: string }) => item.identifier)).toEqual([refs.skipped]);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
  });

  it("refuses a state no issue can carry, on every surface", async () => {
    const bare = cli("timing", "quality", "--exclude", "provider-unavailable", "--ws", WS);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/budget state/);
    expect((await mcp.call("timing_quality", { exclude: ["provider-unavailable"], ws: WS })).isError).toBe(true);
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&exclude=provider-unavailable`);
    expect(viaHttp.status).toBe(409);
    expect(cli("timing", "nonsense", "--ws", WS).status).toBe(2);
  });

  it("prints the counts, the ratio and one line per record", () => {
    const result = cli("timing", "quality", "--parent", epic, "--ws", WS);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`3 eligible (done leaves) of 5 issues · beneath ${epic} · not eligible: 0 parents, 1 open, 1 cancelled`);
    expect(lines[1]).toBe("work   exact 0 (0.0%) · timing-floor 2 (66.7%) · approximate 0 (0.0%) · reconstructed 0 (0.0%) · missing 1 (33.3%)");
    expect(lines.some((line) => line.startsWith(`${refs.skipped} `) && line.includes("missing") && line.includes("never_started"))).toBe(true);
  });
});

describe("the per-record state rides the existing surfaces", () => {
  it("show --json, get_task and /api/issue carry the same work and wall state and reasons", async () => {
    const viaCli = cliJson("show", refs.quick!).timing.quality;
    expect(viaCli.work).toMatchObject({ state: "timing-floor", reasons: ["timing_floor"] });
    expect(viaCli.wall.state).not.toBeNull();
    expect((await tool("get_task", { ref: refs.quick })).timing.quality).toEqual(viaCli);
    expect((await http(`/api/issue?ws=${WS}&ref=${refs.quick}`)).body.timing.quality).toEqual(viaCli);
  });

  it("attempts --json and list_attempts carry each attempt's effort and its state", async () => {
    const viaCli = cliJson("attempts", refs.quick!);
    expect(viaCli.items[0]).toMatchObject({ quality: { state: "timing-floor", reasons: ["timing_floor"] } });
    expect(typeof viaCli.items[0].effortSeconds).toBe("number");
    expect((await tool("list_attempts", { ref: refs.quick })).items).toEqual(viaCli.items);
  });
});
