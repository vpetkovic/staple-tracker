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
import { tx } from "../src/core/db.js";
import { writeEventRow } from "../src/core/event-row.js";
import { setClock } from "../src/core/types.js";
import { resolveWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CONTRACT_AGENT, runCliAsync, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "quality";
let home: string;
let emptyDir: string;
let mcp: McpHarness;
let ui: UiHandle;
let origin: string;
let token: string;
let epic: string;
let mixed: string;
const refs: Record<string, string> = {};

async function cli(...args: string[]) {
  return await runCliAsync(args, { STAPLE_HOME: home, STAPLE_AGENT: CONTRACT_AGENT });
}
async function cliJson(...args: string[]): Promise<any> {
  const result = await cli(...args, "--ws", WS, "--json");
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
const mint = async (title: string, ...args: string[]): Promise<string> => String((await cliJson("new", title, ...args)).identifier);
/** Every field but the read's own instant, which each call stamps. */
const withoutAsOf = ({ asOf: _asOf, ...rest }: { asOf: string }): Record<string, unknown> => rest;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-quality-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-quality-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect((await cli("init", "--global", WS)).status).toBe(0);

  // An epic with two leaves worked and landed at once (under the floor), one landed without
  // ever starting (missing), one still open and one cancelled: three eligible records.
  epic = await mint("Epic");
  for (const name of ["quick", "quicker"]) {
    refs[name] = await mint(name, "--parent", epic, "--estimate", "1h");
    expect((await cli("checkout", refs[name]!, "--ws", WS)).status).toBe(0);
    expect((await cli("done", refs[name]!, "--ws", WS)).status).toBe(0);
  }
  refs.skipped = await mint("skipped", "--parent", epic, "--kind", "bug");
  expect((await cli("status", refs.skipped, "done", "--ws", WS)).status).toBe(0);
  refs.open = await mint("open", "--parent", epic);
  expect((await cli("checkout", refs.open, "--ws", WS)).status).toBe(0);
  refs.dropped = await mint("dropped", "--parent", epic);
  expect((await cli("cancel", refs.dropped, "--ws", WS)).status).toBe(0);

  /**
   * A second epic with the states the CLI cannot produce in real time: exact and sparse work
   * written at controlled instants through the store every surface reads, a reconstructed
   * leaf and a reconstructed leaf that is also sparse, rebuilt by the real `reconstruct` from
   * the checkout an older build narrated. Each leaf is estimated at 2h.
   */
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
  let clock = T0;
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
  setClock(() => clock);
  const { store } = resolveWorkspace({ ws: WS });
  try {
    mixed = store.createIssue({ title: "Mixed" }).identifier;
    const leaf = (title: string): string => store.createIssue({ title, parent: mixed, estimatedSeconds: 7200 }).id;
    const legacy = (title: string, from: number, to: number, comments: number[]): void => {
      at(from);
      const id = leaf(title);
      tx(store.db, () => writeEventRow(store.db, { kind: "checkout", issueId: id, actor: "old", payload: {}, createdAt: iso(from), dedupKey: `legacy-${id}` }));
      for (const m of comments) {
        at(m);
        store.addComment(id, "progress", "old", "agent");
      }
      at(to);
      store.updateIssue(id, { status: "done" }, "old");
    };
    const worked = (title: string, from: number, to: number, comments: number[]): void => {
      at(from);
      const id = leaf(title);
      store.checkoutIssue(id, "w");
      for (const m of comments) {
        at(m);
        store.addComment(id, "progress", "w", "agent");
      }
      at(to);
      store.updateIssue(id, { status: "done" }, "w");
    };
    legacy("recon", 0, 20, [10]);
    legacy("reconSparse", 21, 101, []);
    worked("exact", 102, 122, [112]);
    worked("sparse", 123, 173, []);
    at(174);
    expect(store.reconstructAttemptHistory().reconstructed).toBe(2);
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

describe("timing quality: one payload through the CLI, MCP and HTTP", () => {
  it("counts each state over the eligible leaves and lists every record with its state", async () => {
    const viaCli = await cliJson("timing", "quality", "--parent", epic);
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
    const viaCli = await cliJson("timing", "quality", "--parent", epic, "--kind", "task", "--exclude", "timing-floor", "--exclude-reason", "sparse");
    const viaMcp = await tool("timing_quality", { parent: epic, kind: ["task"], exclude: ["timing-floor"], exclude_reasons: ["sparse"] });
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${epic}&kind=task&exclude=timing-floor&excludeReason=sparse`);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    expect(viaCli.filter).toEqual({
      kind: ["task"],
      parent: epic,
      since: null,
      include: ["exact", "timing-floor", "approximate", "reconstructed", "missing"],
      exclude: ["timing-floor"],
      excludeReasons: ["sparse"],
    });
    // Kind task: the bug is outside the population; the two task leaves are excluded, and counted.
    expect(viaCli.population.eligible).toBe(2);
    expect(viaCli.items).toEqual([]);
    expect(viaCli.excluded).toEqual({ count: 2, counts: { "timing-floor": 2 }, reasons: { timing_floor: 2 } });
    expect(viaCli.work.counts["timing-floor"]).toBe(2);
  });

  it("walks the same pages with the same cursor", async () => {
    const first = await cliJson("timing", "quality", "--parent", epic, "--limit", "2");
    expect(first.truncated).toBe(true);
    const viaMcp = await tool("timing_quality", { parent: epic, limit: 2, cursor: first.nextCursor });
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${epic}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    const viaCli = await cliJson("timing", "quality", "--parent", epic, "--limit", "2", "--cursor", first.nextCursor);
    expect(viaCli.items.map((item: { identifier: string }) => item.identifier)).toEqual([refs.skipped]);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
  });

  it("refuses a state no issue can carry, on every surface", async () => {
    const bare = await cli("timing", "quality", "--exclude", "provider-unavailable", "--ws", WS);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/budget state/);
    expect((await mcp.call("timing_quality", { exclude: ["provider-unavailable"], ws: WS })).isError).toBe(true);
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&exclude=provider-unavailable`);
    expect(viaHttp.status).toBe(409);
    expect((await cli("timing", "nonsense", "--ws", WS)).status).toBe(2);
  });

  it("prints the counts, the ratio and one line per record", async () => {
    const result = await cli("timing", "quality", "--parent", epic, "--ws", WS);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toBe(`3 eligible (done leaves) of 5 issues · beneath ${epic} · not eligible: 0 parents, 1 open, 1 cancelled`);
    expect(lines[1]).toBe("work   exact 0 (0.0%) · timing-floor 2 (66.7%) · approximate 0 (0.0%) · reconstructed 0 (0.0%) · missing 1 (33.3%)");
    expect(lines.some((line) => line.startsWith(`${refs.skipped} `) && line.includes("missing") && line.includes("never_started"))).toBe(true);
  });
});

describe("timing quality over a mixed population, on every surface", () => {
  const titles = (report: { items: Array<{ title: string }> }): string[] => report.items.map((item) => item.title);

  it("reads each state, and excluding approximate drops the reconstructed record that is sparse", async () => {
    const all = await cliJson("timing", "quality", "--parent", mixed);
    expect(all.items.map((item: { title: string; work: { state: string; reasons: string[] } }) => [item.title, item.work.state, item.work.reasons])).toEqual([
      ["recon", "reconstructed", ["reconstructed"]],
      ["reconSparse", "reconstructed", ["reconstructed", "sparse"]],
      ["exact", "exact", []],
      ["sparse", "approximate", ["sparse"]],
    ]);
    const viaCli = await cliJson("timing", "quality", "--parent", mixed, "--exclude", "approximate");
    const viaMcp = await tool("timing_quality", { parent: mixed, exclude: ["approximate"] });
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${mixed}&exclude=approximate`);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    expect(titles(viaCli)).toEqual(["recon", "exact"]);
    expect(viaCli.excluded).toEqual({ count: 2, counts: { approximate: 1, reconstructed: 1 }, reasons: { reconstructed: 1, sparse: 2 } });
    expect(viaCli.ratio.admitted).toMatchObject({ count: 2, workSeconds: 2400, estimatedSeconds: 14400 });
    expect(viaCli.work.counts).toEqual(all.work.counts);
  });

  it("excludes by a reason that matches, and selects exact alone or with clean reconstructed records", async () => {
    const byReason = await cliJson("timing", "quality", "--parent", mixed, "--exclude-reason", "sparse");
    expect(withoutAsOf(await tool("timing_quality", { parent: mixed, exclude_reasons: ["sparse"] }))).toEqual(withoutAsOf(byReason));
    expect(titles(byReason)).toEqual(["recon", "exact"]);
    expect(byReason.excluded.reasons.sparse).toBe(2);
    const exactOnly = await cliJson("timing", "quality", "--parent", mixed, "--include", "exact");
    expect(withoutAsOf((await http(`/api/timing/quality?ws=${WS}&parent=${mixed}&include=exact`)).body)).toEqual(withoutAsOf(exactOnly));
    expect(titles(exactOnly)).toEqual(["exact"]);
    expect(titles(await cliJson("timing", "quality", "--parent", mixed, "--include", "exact,reconstructed"))).toEqual(["recon", "exact"]);
  });

  it("takes repeated list flags on the CLI as HTTP takes repeated parameters", async () => {
    const repeated = await cliJson("timing", "quality", "--parent", mixed, "--exclude", "approximate", "--exclude", "reconstructed", "--kind", "task", "--kind", "bug");
    const commas = await cliJson("timing", "quality", "--parent", mixed, "--exclude", "approximate,reconstructed", "--kind", "task,bug");
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&parent=${mixed}&exclude=approximate&exclude=reconstructed&kind=task&kind=bug`);
    expect(repeated.filter).toMatchObject({ exclude: ["approximate", "reconstructed"], kind: ["task", "bug"] });
    expect(withoutAsOf(repeated)).toEqual(withoutAsOf(commas));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(repeated));
    expect(titles(repeated)).toEqual(["exact"]);
  });

  it("refuses a reason code outside the closed set, naming the field on every surface", async () => {
    const bare = await cli("timing", "quality", "--exclude-reason", "sprase", "--ws", WS);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/excludeReasons takes work reason codes/);
    const viaMcp = await mcp.call("timing_quality", { exclude_reasons: ["sprase"], ws: WS });
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.content)).not.toContain("--");
    const viaHttp = await http(`/api/timing/quality?ws=${WS}&excludeReason=sprase&since=yesterday`);
    expect(viaHttp.status).toBe(409);
    expect(JSON.stringify(viaHttp.body)).not.toContain("--");
  });
});

describe("the per-record state rides the existing surfaces", () => {
  it("show --json, get_task and /api/issue carry the same work and wall state and reasons", async () => {
    const viaCli = (await cliJson("show", refs.quick!)).timing.quality;
    expect(viaCli.work).toMatchObject({ state: "timing-floor", reasons: ["timing_floor"] });
    expect(viaCli.wall.state).not.toBeNull();
    expect((await tool("get_task", { ref: refs.quick })).timing.quality).toEqual(viaCli);
    expect((await http(`/api/issue?ws=${WS}&ref=${refs.quick}`)).body.timing.quality).toEqual(viaCli);
  });

  it("attempts --json and list_attempts carry each attempt's effort and its state", async () => {
    const viaCli = await cliJson("attempts", refs.quick!);
    expect(viaCli.items[0]).toMatchObject({ quality: { state: "timing-floor", reasons: ["timing_floor"] } });
    expect(typeof viaCli.items[0].effortSeconds).toBe("number");
    expect((await tool("list_attempts", { ref: refs.quick })).items).toEqual(viaCli.items);
  });
});
