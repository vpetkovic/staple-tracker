/**
 * Calibration cohorts through every door: `staple calibrate --json`, MCP `calibration_cohorts`
 * and HTTP `/api/calibration` answer one payload from one store method, with the same filters,
 * the same evidence sets, the same listings, the same cursor and the same snapshot id.
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
import { CONTRACT_AGENT, runCli, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";

const WS = "calibration";
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
/** Every field but the read's own instant, which each call stamps. */
const withoutAsOf = ({ asOf: _asOf, ...rest }: { asOf: string }): Record<string, unknown> => rest;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-calibration-home-"));
  emptyDir = mkdtempSync(join(tmpdir(), "staple-calibration-cwd-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  expect(cli("init", "--global", WS).status).toBe(0);

  /**
   * One epic: three exact task leaves by opus and two by sonnet (all area:ui), one exact bug,
   * one sparse task, and one leaf an older build worked, rebuilt by the real `reconstruct`.
   * Every history is written through the store at controlled instants; each leaf is 2h.
   */
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
  let clock = T0;
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
  setClock(() => clock);
  const { store } = resolveWorkspace({ ws: WS });
  try {
    epic = store.createIssue({ title: "Calibrated", kind: "epic" }).identifier;
    let t = 0;
    const worked = (title: string, opts: { minutes: number; model?: string; kind?: string; every?: number | null }): void => {
      at(t);
      const issue = store.createIssue({ title, parent: epic, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high", ...(opts.kind ? { kind: opts.kind } : {}) });
      store.checkoutIssue(issue.id, "w", undefined, opts.model ? { attempt: { harness: "claude_code", model: opts.model } } : {});
      if (opts.every !== null) for (let m = t + 10; m < t + opts.minutes; m += 10) (at(m), store.addComment(issue.id, "progress", "w", "agent"));
      at(t + opts.minutes);
      store.updateIssue(issue.id, { status: "done" }, "w");
      refs[title] = issue.identifier;
      t += opts.minutes + 1;
    };
    worked("opus 1", { minutes: 20, model: "opus" });
    worked("opus 2", { minutes: 30, model: "opus" });
    worked("opus 3", { minutes: 40, model: "opus" });
    worked("sonnet 1", { minutes: 60, model: "sonnet" });
    worked("sonnet 2", { minutes: 60, model: "sonnet" });
    worked("bug", { minutes: 20, kind: "bug" });
    worked("sparse", { minutes: 45, model: "opus", every: null });
    at(t);
    const legacy = store.createIssue({ title: "legacy", parent: epic, estimatedSeconds: 7200 });
    tx(store.db, () => writeEventRow(store.db, { kind: "checkout", issueId: legacy.id, actor: "old", payload: {}, createdAt: iso(t), dedupKey: `legacy-${legacy.id}` }));
    at(t + 20);
    store.updateIssue(legacy.id, { status: "done" }, "old");
    refs.legacy = legacy.identifier;
    at(t + 21);
    expect(store.reconstructAttemptHistory().reconstructed).toBe(1);
    // Open work outside the epic, to forecast: one estimated, one not.
    refs.next = store.createIssue({ title: "next", estimatedSeconds: 14400, labels: ["area:ui"], priority: "high" }).identifier;
    refs.unplanned = store.createIssue({ title: "unplanned", labels: ["area:ui"], priority: "high" }).identifier;
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

describe("calibration cohorts: one payload through the CLI, MCP and HTTP", () => {
  it("lists the cohorts of trusted samples, with the fallback, coverage and one snapshot id", async () => {
    const viaCli = cliJson("calibrate", "--parent", epic);
    const viaMcp = await tool("calibration_cohorts", { parent: epic });
    const viaHttp = await http(`/api/calibration?ws=${WS}&parent=${epic}`);
    expect(viaHttp.status).toBe(200);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));

    expect(viaCli.population).toEqual({ issues: 8, ratio: 8, parents: 0 });
    expect(viaCli.sets).toEqual([
      {
        set: "exact",
        samples: 6,
        coverage: { samples: 6, eligible: 8, fraction: 0.75, denominator: "ratio_population" },
        excluded: { count: 2, counts: { approximate: 1, reconstructed: 1 }, reasons: { reconstructed: 1, sparse: 1 } },
        cohorts: 3,
      },
    ]);
    expect(viaCli.list).toBe("cohorts");
    expect(viaCli.items.map((cohort: any) => [cohort.key.kind, cohort.key.model, cohort.keySamples, cohort.levelName, cohort.samples, cohort.coverage.eligible])).toEqual([
      ["bug", "unknown", 1, "all", 6, 8],
      ["task", "opus", 3, "without_model", 5, 6],
      ["task", "sonnet", 2, "without_model", 5, 6],
    ]);
    expect(viaCli.snapshot.id).toMatch(/^calibration2:[0-9a-f]{32}$/);
    expect(viaCli.method).toEqual({
      minSamples: 5,
      levels: ["full", "without_model", "without_area", "without_work_type", "kind", "all"],
      median: "lower",
      estimate: "at_start_else_current",
      quantile: "lower",
      quantiles: ["p10", "p25", "p50", "p75", "p90"],
      confidence: 0.9,
      intervals: "order_statistic",
      minBoundsSamples: 19,
      heavyTail: { rule: "log_mad_z", z: 3.5, minOutliers: 2, minShare: 0.05 },
      floorSeconds: 60,
    });
    expect(viaCli.forecasts).toEqual([]);
  });

  it("adds reconstructed history as its own set only when asked, the same way on every surface", async () => {
    const viaCli = cliJson("calibrate", "--parent", epic, "--include", "reconstructed");
    const viaMcp = await tool("calibration_cohorts", { parent: epic, include: ["reconstructed"] });
    const viaHttp = await http(`/api/calibration?ws=${WS}&parent=${epic}&include=reconstructed`);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    expect(viaCli.sets.map((set: any) => [set.set, set.samples])).toEqual([
      ["exact", 6],
      ["reconstructed", 1],
    ]);
    const reconstructed = viaCli.items.filter((cohort: any) => cohort.set === "reconstructed");
    expect(reconstructed).toHaveLength(1);
    expect(reconstructed[0]).toMatchObject({ samples: 1, fallback: "below_minimum_everywhere", warnings: ["small_sample", "bounds_below_confidence", "fallback_used", "reconstructed_only"], members: { total: 1, refs: [refs.legacy], truncated: false } });
    expect(viaCli.snapshot.id).not.toBe(cliJson("calibrate", "--parent", epic).snapshot.id);
  });

  it("filters by kind and priority, with commas or repeats, on every surface", async () => {
    const viaCli = cliJson("calibrate", "--parent", epic, "--kind", "task", "--kind", "bug", "--priority", "high,low");
    const commas = cliJson("calibrate", "--parent", epic, "--kind", "task,bug", "--priority", "high", "--priority", "low");
    const viaMcp = await tool("calibration_cohorts", { parent: epic, kind: ["task", "bug"], priority: ["high", "low"] });
    const viaHttp = await http(`/api/calibration?ws=${WS}&parent=${epic}&kind=task&kind=bug&priority=high,low`);
    expect(withoutAsOf(commas)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    expect(viaCli.filter).toEqual({ kind: ["bug", "task"], priority: ["high", "low"], parent: epic, since: null, include: ["exact"] });
    // The legacy leaf is medium: outside the filter.
    expect(viaCli.population.ratio).toBe(7);
    expect(cliJson("calibrate", "--parent", epic, "--kind", "bug").items.map((cohort: any) => cohort.levelName)).toEqual(["all"]);
  });

  it("lists the samples and walks the same pages with the same cursor", async () => {
    const first = cliJson("calibrate", "--parent", epic, "--samples", "--limit", "4");
    expect(first.list).toBe("samples");
    expect(first.truncated).toBe(true);
    expect(first.items.map((sample: any) => sample.identifier)).toEqual([refs["opus 1"], refs["opus 2"], refs["opus 3"], refs["sonnet 1"]]);
    expect(first.items[0]).toMatchObject({ set: "exact", workSeconds: 1200, estimate: { seconds: 7200, source: "at_start" }, dimensions: { kind: "task", priority: "high", workType: "unknown", area: "ui", model: "opus" } });
    const viaCli = cliJson("calibrate", "--parent", epic, "--samples", "--limit", "4", "--cursor", first.nextCursor);
    const viaMcp = await tool("calibration_cohorts", { parent: epic, list: "samples", limit: 4, cursor: first.nextCursor });
    const viaHttp = await http(`/api/calibration?ws=${WS}&parent=${epic}&list=samples&limit=4&cursor=${encodeURIComponent(first.nextCursor)}`);
    expect(viaCli.items.map((sample: any) => sample.identifier)).toEqual([refs["sonnet 2"], refs.bug]);
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    // One snapshot for the cohorts and the samples of the same data.
    expect(viaCli.snapshot).toEqual(cliJson("calibrate", "--parent", epic).snapshot);
  });

  it("forecasts the issues asked for, from the cohort each key reads, the same on every surface", async () => {
    const viaCli = cliJson("calibrate", "--parent", epic, "--for", refs.next!, "--for", refs.unplanned!, "--include", "reconstructed");
    const commas = cliJson("calibrate", "--parent", epic, "--for", `${refs.next},${refs.unplanned}`, "--include", "reconstructed");
    const viaMcp = await tool("calibration_cohorts", { parent: epic, for: [refs.next, refs.unplanned], include: ["reconstructed"] });
    const viaHttp = await http(`/api/calibration?ws=${WS}&parent=${epic}&for=${refs.next}&for=${refs.unplanned}&include=reconstructed`);
    expect(withoutAsOf(commas)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaMcp)).toEqual(withoutAsOf(viaCli));
    expect(withoutAsOf(viaHttp.body)).toEqual(withoutAsOf(viaCli));
    expect(viaCli.forecasts.map((forecast: any) => [forecast.identifier, forecast.set, forecast.state, forecast.cohort.levelName, forecast.cohort.samples])).toEqual([
      [refs.next, "exact", "ratio", "without_model", 5],
      [refs.next, "reconstructed", "ratio", "all", 1],
      [refs.unplanned, "exact", "no_estimate", "without_model", 5],
      [refs.unplanned, "reconstructed", "no_estimate", "all", 1],
    ]);
    // Work 20, 30, 40, 60, 60 minutes over 2h: the median ratio 1/3 of a 4h estimate.
    const [next] = viaCli.forecasts;
    expect(next.seconds.p50).toBeCloseTo(4800, 6);
    expect(next.bounds).toMatchObject({ lower: 2400, upper: 7200, reached: false });
    expect(next.expected).toMatchObject({ method: "pooled" });
    expect(next.warnings).toEqual(["bounds_below_confidence", "fallback_used"]);
    expect(viaCli.forecasts[1].warnings).toEqual(["small_sample", "bounds_below_confidence", "fallback_used", "reconstructed_only"]);
    // Asking for a forecast leaves the data's identity alone.
    expect(viaCli.snapshot.id).toBe(cliJson("calibrate", "--parent", epic, "--include", "reconstructed").snapshot.id);
    const missing = cli("calibrate", "--for", "NOPE-1", "--ws", WS);
    expect(missing.status).not.toBe(0);
    expect((await http(`/api/calibration?ws=${WS}&for=NOPE-1`)).status).toBe(404);
  });

  it("refuses an approximate set on every surface, naming the field", async () => {
    const bare = cli("calibrate", "--include", "approximate", "--ws", WS);
    expect(bare.status).toBe(2);
    expect(bare.stderr).toMatch(/never calibration samples/);
    const viaMcp = await mcp.call("calibration_cohorts", { include: ["approximate"], ws: WS });
    expect(viaMcp.isError).toBe(true);
    expect(JSON.stringify(viaMcp.content)).not.toContain("--");
    const viaHttp = await http(`/api/calibration?ws=${WS}&include=approximate`);
    expect(viaHttp.status).toBe(409);
    expect((await http(`/api/calibration?ws=${WS}&list=nothing`)).status).toBe(409);
    expect(cli("calibrate", "stray", "--ws", WS).status).toBe(2);
  });

  it("prints the snapshot, the sets and three lines per cohort", () => {
    const result = cli("calibrate", "--parent", epic, "--ws", WS);
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.trimEnd().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^snapshot calibration2:[0-9a-f]{32} · beneath ${epic}$`));
    expect(lines[1]).toBe("8 eligible (done, own estimate) of 8 issues · minimum 5 samples per cohort");
    expect(lines[2]).toBe("exact         6 samples (75.0% of 8) in 3 cohorts · not samples: approximate 1, reconstructed 1");
    expect(lines[6]).toBe("exact         kind=task priority=high workType=unknown area=ui model=opus · 3 own → without_model (full 3, without_model 5)");
    expect(lines[7]).toMatch(/^ {14}kind=task priority=high workType=unknown area=ui: n 5 \(83\.3% of 6\) · ratio median 0\.333, range 0\.167–0\.500, pooled 0\.350 · work median 40m/);
    expect(lines[8]).toBe(
      "              ratio p10 0.167 p25 0.250 p50 0.333 p75 0.500 p90 0.500 · bounds 0.167–0.500 (66.7%, below target) · expected 0.350 (pooled) · tail ok (0 beyond the fences)",
    );
    const forecast = cli("calibrate", "--parent", epic, "--for", refs.next!, "--ws", WS).stdout.trimEnd().split("\n").at(-1);
    expect(forecast).toBe(
      `forecast      ${refs.next} exact · est 4h · kind=task priority=high workType=unknown area=ui n 5 → p50 1h20m, p10–p90 40m–2h · bounds 40m–2h (66.7%, below target) · expected 1h24m (pooled) · bounds_below_confidence, fallback_used`,
    );
  });
});
