/**
 * Completion forecasts (`docs/timing-semantics.md`, "Forecasts"): each plan unit's remaining work
 * from its calibrated duration less the work done on it, the remaining labor and the longest
 * chain of remaining work over the certified plan's units, resampled bands with a fixed seed,
 * and the treatment of done, in-review, overrun and unknown units.
 *
 * Every history is written by real store calls at instants this suite controls (the write clock
 * is faked, `Date` only); no issue, attempt or event row is written by hand. The pure checks at
 * the end build their inputs directly, and say so.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { planGraphOf, walkPlanGraph, type PlanNode } from "../src/core/plan-rollup.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import type { DurationForecast } from "../src/core/telemetry/calibration.js";
import { FORECAST_DRAWS, FORECAST_SEED, completionForecast, seededRandom, spreadOfDraws, streamSeed, type ForecastUnitInput } from "../src/core/telemetry/forecast.js";
import type { ForecastReport } from "../src/core/telemetry/forecast-report.js";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const at = (minutes: number): void => void vi.setSystemTime(T0 + minutes * 60_000);
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const min = (n: number): number => n * 60;

let store: WorkspaceStore;
let home: string;
let clock = 0;
const previousHome = process.env.STAPLE_HOME;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  clock = 0;
  home = mkdtempSync(join(tmpdir(), "staple-forecast-home-"));
  process.env.STAPLE_HOME = home;
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

/** A leaf worked from checkout to done, commenting every 10 minutes so its work is exact. */
function worked(minutes: number, estimate = min(60)): string {
  const from = clock;
  clock += minutes + 1;
  at(from);
  const issue = store.createIssue({ title: `sample ${minutes}m`, estimatedSeconds: estimate });
  store.checkoutIssue(issue.id, "w", undefined, {});
  for (let m = from + 10; m < from + minutes; m += 10) (at(m), store.addComment(issue.id, "progress", "w", "agent"));
  at(from + minutes);
  store.updateIssue(issue.id, { status: "done" }, "w");
  return issue.identifier;
}

/** Five samples over a 60-minute estimate: ratios 0.5, 0.667, 0.833, 1 and 1.5; pooled 270/300 = 0.9. */
function fiveSamples(): void {
  for (const minutes of [30, 40, 50, 60, 90]) worked(minutes);
}

const forecast = (ref: string, minutes: number, extra: { reserve?: string } = {}): ForecastReport => store.forecast({ ref, ...extra }, iso(minutes), home);
const unit = (report: ForecastReport, ref: string) => report.completion.units.items.find((item) => item.ref === ref)!;

describe("a leaf nobody has started", () => {
  it("is its own unit, forecast from the class calibrate --for reads, with draws only at the class's ratios", () => {
    fiveSamples();
    at(clock);
    const next = store.createIssue({ title: "next", estimatedSeconds: min(120) }).identifier;
    const report = forecast(next, clock);
    const calibrated = store.calibration({ for: [next] }, iso(clock)).forecasts[0]!;

    expect(report.subject).toMatchObject({ ref: next, scope: "unit" });
    // The calibration snapshot the classes came from is exactly `staple calibrate`'s.
    expect(report.snapshot.calibration.id).toBe(store.calibration({}, iso(clock)).snapshot.id);
    expect(report.snapshot.calibration).toMatchObject({ members: 5, samples: 5 });
    const leaf = unit(report, next);
    expect(leaf).toMatchObject({ treatment: "forecast", state: "ratio", workSeconds: null, admissibleSamples: 5, overrun: false, cohort: { levelName: "without_model", samples: 5 } });
    expect(leaf.expected!.durationSeconds).toBeCloseTo(calibrated.expected!.seconds, 9);
    expect(leaf.expected!.durationSeconds).toBeCloseTo(0.9 * 7200, 9);
    expect(leaf.expected!.remainingSeconds).toBeCloseTo(6480, 9);
    // Resampling draws the class's own durations and nothing between them.
    const durations = [3600, 4800, 6000, 7200, 10800];
    for (const figure of [leaf.simulated!.p10, leaf.simulated!.p50, leaf.simulated!.p90, leaf.simulated!.band.lower, leaf.simulated!.band.upper]) {
      expect(durations.some((value) => Math.abs(value - figure) < 1e-6)).toBe(true);
    }
    expect(leaf.simulated!.band).toMatchObject({ lower: 3600, upper: 10800, nominal: 0.9 });
    expect(leaf.simulated!.mean).toBeGreaterThan(6000);
    expect(leaf.simulated!.mean).toBeLessThan(7000);
    // One unit: the path and the labor are the same figure.
    expect(report.completion.labor.expectedSeconds).toBeCloseTo(6480, 9);
    expect(report.completion.path.expectedSeconds).toBeCloseTo(6480, 9);
    expect(report.completion.path.simulated).toEqual(report.completion.labor.simulated);
    expect(report.completion.path.chain.map((step) => step.ref)).toEqual([next]);
    // Five samples: the bounds reach 4/6, and the band cannot claim more than the class does.
    expect(report.completion.confidence).toEqual({ label: "medium", nominal: 0.9, achieved: 0.666666666667, reached: false, reasons: ["bounds_below_confidence"] });
    expect(report.completion.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence"]);
  });

  it("reads the same forecast on every read of the same data, and another one when a sample changes", () => {
    fiveSamples();
    at(clock);
    const next = store.createIssue({ title: "next", estimatedSeconds: min(120) }).identifier;
    const first = forecast(next, clock + 5);
    expect(forecast(next, clock + 5)).toEqual(first);
    expect(first.snapshot.id).toMatch(/^forecast1:[0-9a-f]{32}$/);
    expect(first.method).toMatchObject({ seed: FORECAST_SEED, draws: FORECAST_DRAWS, band: { lower: 5, upper: 95, nominal: 0.9 } });
    worked(45);
    const second = forecast(next, clock + 5);
    expect(second.snapshot.calibration.id).not.toBe(first.snapshot.calibration.id);
    expect(second.snapshot.id).not.toBe(first.snapshot.id);
    expect(second.completion.labor.expectedSeconds).not.toBe(first.completion.labor.expectedSeconds);
  });

  it("with no samples in its class, or no estimate, is unknown, never 0", () => {
    at(0);
    const lone = store.createIssue({ title: "lone", estimatedSeconds: min(60) }).identifier;
    const report = forecast(lone, 1);
    expect(unit(report, lone)).toMatchObject({ state: "no_samples", expected: null, missing: { expected: "no_samples" } });
    expect(report.completion.labor).toEqual({ expectedSeconds: null, partial: true, missing: ["no_forecast"], simulated: null });
    expect(report.completion.path).toMatchObject({ expectedSeconds: null, partial: true, missing: ["no_forecast"], simulated: null });
    expect(report.completion.confidence.label).toBe("low");
    clock = 2;
    fiveSamples();
    at(clock);
    const unplanned = store.createIssue({ title: "unplanned" }).identifier;
    expect(unit(forecast(unplanned, clock), unplanned)).toMatchObject({ state: "no_estimate", expected: null, missing: { expected: "no_estimate" } });
  });
});

describe("a leaf in progress", () => {
  it("has its expected duration less its work left, and draws conditioned on it not being done", () => {
    fiveSamples();
    const from = clock;
    at(from);
    const open = store.createIssue({ title: "open", estimatedSeconds: min(120) });
    store.checkoutIssue(open.id, "w", undefined, {});
    for (let m = 10; m <= 70; m += 10) (at(from + m), store.addComment(open.id, "progress", "w", "agent"));

    const report = forecast(open.identifier, from + 70);
    const leaf = unit(report, open.identifier);
    expect(leaf.workSeconds).toBe(4200);
    // Expected 0.9 × 7200 = 6480, less 4200 of work.
    expect(leaf.expected!.remainingSeconds).toBeCloseTo(2280, 9);
    // Only samples longer than 70 minutes can be its duration: 80, 100, 120 and 180 minutes.
    expect(leaf.admissibleSamples).toBe(4);
    const left = [600, 1800, 3000, 6600];
    for (const figure of [leaf.simulated!.p10, leaf.simulated!.p50, leaf.simulated!.p90]) expect(left.some((value) => Math.abs(value - figure) < 1e-6)).toBe(true);
    expect(leaf.simulated!.band).toMatchObject({ lower: 600, upper: 6600 });
    expect(leaf.overrun).toBe(false);

    // Past its expected duration: the expected figure reads 0 and says overrun; the draws still say what may be left.
    for (let m = 80; m <= 110; m += 10) (at(from + m), store.addComment(open.id, "progress", "w", "agent"));
    const over = unit(forecast(open.identifier, from + 110), open.identifier);
    expect(over).toMatchObject({ state: "ratio", overrun: true, admissibleSamples: 2, workSeconds: 6600 });
    expect(over.expected!.remainingSeconds).toBe(0);
    expect(over.simulated!.band).toMatchObject({ lower: 600, upper: 4200 });
    expect(forecast(open.identifier, from + 110).completion.warnings).toContain("overrun");
    // The work so far is an input: more of it is other data, and another snapshot.
    expect(forecast(open.identifier, from + 110).snapshot.id).not.toBe(report.snapshot.id);
    expect(forecast(open.identifier, from + 110).snapshot.calibration.id).toBe(report.snapshot.calibration.id);

    // Past every sample of its class: unknown, never 0.
    for (let m = 120; m <= 190; m += 10) (at(from + m), store.addComment(open.id, "progress", "w", "agent"));
    const beyond = forecast(open.identifier, from + 190);
    expect(unit(beyond, open.identifier)).toMatchObject({ state: "beyond_class_range", expected: null, admissibleSamples: 0, missing: { expected: "beyond_class_range" } });
    expect(beyond.completion.labor.expectedSeconds).toBeNull();
    expect(beyond.completion.warnings).toEqual(expect.arrayContaining(["unknown_units", "beyond_class_range"]));
    expect(beyond.completion.confidence).toMatchObject({ label: "low", reasons: expect.arrayContaining(["unknown_units"]) });
  });
});

describe("an epic", () => {
  /**
   * An epic with a done unit, one in review, a chain A → B → P (P a parent with its own
   * estimate over an open child, one unit), a parallel C and an unestimated U. Estimates: A 2h,
   * B 1h, P 2h, C 2h. Expected remaining at 0.9: A 6480, B 3240, P 6480, C 6480.
   */
  function epic(): { epic: string; refs: Record<string, string> } {
    fiveSamples();
    at(clock);
    const root = store.createIssue({ title: "epic", kind: "epic" });
    const child = (title: string, estimate: number | null, extra: Record<string, unknown> = {}) =>
      store.createIssue({ title, parent: root.id, ...(estimate === null ? {} : { estimatedSeconds: estimate }), ...extra });
    const d = child("done, never estimated", null);
    store.updateIssue(d.id, { status: "done" }, "w");
    const r = child("in review", min(60));
    store.updateIssue(r.id, { status: "in_review" }, "w");
    const a = child("A", min(120));
    const b = child("B", min(60), { blockedBy: [a.id] });
    const p = child("P", min(120), { blockedBy: [b.id] });
    const inside = store.createIssue({ title: "inside P", parent: p.id, estimatedSeconds: min(60) });
    const c = child("C", min(120));
    const u = child("U", null);
    return { epic: root.identifier, refs: { d: d.identifier, r: r.identifier, a: a.identifier, b: b.identifier, p: p.identifier, inside: inside.identifier, c: c.identifier, u: u.identifier } };
  }

  it("adds every unit's remaining work once and walks the longest chain of it, partial over the unknown unit", () => {
    const { epic: ref, refs } = epic();
    const report = forecast(ref, clock + 1);
    const { units, labor, path } = report.completion;
    expect(report.subject.scope).toBe("subtree");
    expect(units).toMatchObject({ total: 7, done: 1, awaitingReview: 1, forecast: 5, known: 4, unknownRefs: [refs.u], awaitingReviewRefs: [refs.r], truncated: false });
    expect(unit(report, refs.d!)).toMatchObject({ treatment: "done", expected: null, simulated: null });
    expect(unit(report, refs.r!)).toMatchObject({ treatment: "awaiting_review", expected: null, simulated: null });
    // The parent with its own estimate is one unit; the child inside it is not another.
    expect(units.items.map((item) => item.ref)).not.toContain(refs.inside);
    expect(labor.expectedSeconds).toBeCloseTo(6480 + 3240 + 6480 + 6480, 6);
    expect(labor).toMatchObject({ partial: true, missing: ["unknown_units"] });
    expect(path.expectedSeconds).toBeCloseTo(6480 + 3240 + 6480, 6);
    expect(path.chain.map((step) => step.ref)).toEqual([refs.a, refs.b, refs.p]);
    expect(path).toMatchObject({ partial: true, missing: ["unknown_units"], edgeCount: 2 });
    // A chain is never longer than the whole labor, in any band.
    expect(path.simulated!.p50).toBeLessThanOrEqual(labor.simulated!.p50);
    expect(path.simulated!.band.upper).toBeLessThanOrEqual(labor.simulated!.band.upper);
    expect(path.simulated!.band.lower).toBeGreaterThanOrEqual(3 * 1800);
    expect(report.completion.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "unknown_units", "awaiting_review"]);
    expect(report.completion.confidence.label).toBe("low");
    // Not the plan's remaining path, which weighs estimates, not forecasts.
    expect(store.comparePlans([ref]).plans[0]!.remainingPath.seconds).toBe(min(120) + min(60) + min(120));
    expect(report.completion.plan).toMatchObject({ source: "descendants" });
  });

  it("drops a unit once it is done, and its chain follows what is left", () => {
    const { epic: ref, refs } = epic();
    at(clock + 1);
    store.updateIssue(refs.a!, { status: "done" }, "w");
    store.updateIssue(refs.u!, { status: "cancelled" }, "w");
    const report = forecast(ref, clock + 2);
    expect(report.completion.units).toMatchObject({ total: 6, done: 2, forecast: 3, known: 3, unknownRefs: [] });
    expect(report.completion.labor).toMatchObject({ partial: false, missing: [] });
    expect(report.completion.labor.expectedSeconds).toBeCloseTo(3240 + 6480 + 6480, 6);
    expect(report.completion.path.chain.map((step) => step.ref)).toEqual([refs.b, refs.p]);
    expect(report.completion.path.expectedSeconds).toBeCloseTo(3240 + 6480, 6);
    expect(report.completion.confidence).toMatchObject({ label: "medium", achieved: 0.666666666667 });
  });

  it("reads 0 left, not unknown, once every unit is done", () => {
    worked(30);
    at(clock);
    const root = store.createIssue({ title: "finished", kind: "epic" });
    const only = store.createIssue({ title: "only", parent: root.id, estimatedSeconds: min(60) });
    store.updateIssue(only.id, { status: "done" }, "w");
    const report = forecast(root.identifier, clock + 1);
    expect(report.completion.labor).toMatchObject({ expectedSeconds: 0, partial: false, missing: [] });
    expect(report.completion.path).toMatchObject({ expectedSeconds: 0, partial: false });
    expect(report.completion.confidence).toEqual({ label: "high", nominal: 0.9, achieved: null, reached: true, reasons: [] });
  });

  it("refuses an empty ref and a bad reserve, naming the field", () => {
    expect(() => store.forecast({ ref: " " }, iso(0), home)).toThrow(/forecast needs ref/);
    at(0);
    const one = store.createIssue({ title: "one" }).identifier;
    for (const reserve of ["abc", "101", "-5", "20 %"]) expect(() => store.forecast({ ref: one, reserve }, iso(0), home)).toThrow(/reserve takes a percent/);
    expect(() => store.forecast({ ref: one, model: " " }, iso(0), home)).toThrow(/model must name a model/);
  });
});

// ------------------------------------------------------------------ the draws, by construction

/** A synthetic ratio forecast for a unit (a pure input to `completionForecast`, not a store row). */
function ratioForecast(identifier: string, estimate: number, ratio: number): DurationForecast {
  return {
    set: "exact",
    identifier,
    title: identifier,
    status: "todo",
    estimate: { seconds: estimate },
    key: { kind: "task", priority: "medium", workType: "unknown", area: "unknown", model: "*" },
    cohort: { level: 1, levelName: "without_model", class: { kind: "task", priority: "medium", workType: "unknown", area: "unknown", model: "*" }, path: [], fallback: "none", samples: 30, coverage: { samples: 30, eligible: 30, fraction: 1, denominator: "ratio_population" } },
    state: "ratio",
    seconds: null,
    bounds: { lower: ratio * estimate, upper: ratio * estimate, ranks: [2, 29], confidence: 0.9354838709677419, reached: true },
    expected: { seconds: ratio * estimate, ratio, method: "pooled" },
    heavyTail: false,
    floors: { count: 0, share: 0, dominated: false, seconds: 60 },
    warnings: [],
    missing: {},
  };
}

describe("the resampled path", () => {
  it("is the plan walk's longest chain on every draw when every unit weighs one value (random DAGs)", () => {
    const random = seededRandom(7);
    for (let trial = 0; trial < 25; trial += 1) {
      const size = 3 + Math.floor(random() * 30);
      const nodes = new Map<string, PlanNode>();
      nodes.set("root", { id: "root", identifier: "X-0", parentId: null, estimatedSeconds: null, status: "todo", cancelled: false, done: false });
      for (let i = 1; i <= size; i += 1) {
        nodes.set(`n${i}`, { id: `n${i}`, identifier: `X-${i}`, parentId: "root", estimatedSeconds: 600 + Math.floor(random() * 7200), status: "todo", cancelled: false, done: random() < 0.2 });
      }
      const edges = [];
      for (let i = 1; i <= size; i += 1) for (let j = i + 1; j <= size; j += 1) if (random() < 0.15) edges.push({ blockerId: `n${i}`, blockedId: `n${j}` });
      const graph = planGraphOf("root", nodes, edges);
      const units = new Map<string, ForecastUnitInput>();
      for (const node of graph.units) {
        const ratio = 0.25 + random();
        units.set(node.id, { node, title: node.identifier, category: node.done ? "done" : "ready", workSeconds: null, duration: node.done ? null : ratioForecast(node.identifier, node.estimatedSeconds!, ratio), ratios: [ratio] });
      }
      const result = completionForecast({ graph, units, labor: { seconds: null, source: "none", ownSeconds: null, descendantsSeconds: null }, outside: [], seed: FORECAST_SEED, draws: 50 });
      const walked = walkPlanGraph(graph, { weightOf: (unit) => (unit.done ? 0 : units.get(unit.id)!.duration!.expected!.seconds), include: (unit) => !unit.done });
      expect(result.path.expectedSeconds).toBeCloseTo(walked.seconds!, 6);
      // Every draw is that same value, so the draws' band collapses onto the walk.
      expect(result.path.simulated!.band.lower).toBeCloseTo(walked.seconds!, 6);
      expect(result.path.simulated!.band.upper).toBeCloseTo(walked.seconds!, 6);
      expect(result.labor.simulated!.p50).toBeCloseTo(result.labor.expectedSeconds!, 6);
    }
  });

  it("draws from one seeded stream, so a label never shifts another stream", () => {
    const a = seededRandom(streamSeed(FORECAST_SEED, "completion"));
    const b = seededRandom(streamSeed(FORECAST_SEED, "completion"));
    const values = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(values);
    expect(streamSeed(FORECAST_SEED, "budget:x")).not.toBe(streamSeed(FORECAST_SEED, "completion"));
    expect(spreadOfDraws([5, 1, 4, 2, 3, 6])).toMatchObject({ mean: 3.5, p10: 1, p50: 3, p90: 5 });
  });
});
