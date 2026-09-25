/**
 * Confidence ranges (`docs/timing-semantics.md`, "Confidence ranges"): lower quantiles, the
 * order-statistic intervals and prediction bounds with the confidence each reaches, the
 * heavy-tail test and the fence-clipped expected ratio, timing floors kept apart, the warnings,
 * and duration forecasts.
 *
 * The statistics are checked against an independent brute-force oracle and a seeded Monte
 * Carlo; the cohorts and forecasts are read from histories written by real store calls at
 * instants this suite controls (the write clock is faked, `Date` only). No issue, attempt or
 * event row is written by hand, except the legacy checkout event an older build narrated,
 * which `staple attempt reconstruct` reads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, tx } from "../src/core/db.js";
import { writeEventRow } from "../src/core/event-row.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import {
  CALIBRATION_WARNINGS,
  CONFIDENCE,
  HEAVY_TAIL,
  MIN_BOUNDS_SAMPLES,
  QUANTILES,
  lowerQuantileIndex,
  predictionInterval,
  quantileInterval,
  rangeConfidence,
  spreadOf,
  tailOf,
  type CalibrationCohort,
  type CalibrationReport,
} from "../src/core/telemetry/calibration.js";
import { StapleError } from "../src/core/types.js";

// ------------------------------------------------------------------ the statistics, by oracle

/** `P(r ≤ B ≤ s − 1)` for `B ~ Binomial(n, p)`, summed term by term from exact binomial coefficients. */
function oracleCover(n: number, p: number, r: number, s: number): number {
  let total = 0;
  for (let k = r; k <= s - 1; k += 1) {
    let coefficient = 1;
    for (let j = 1; j <= k; j += 1) coefficient = (coefficient * (n - k + j)) / j;
    total += coefficient * p ** k * (1 - p) ** (n - k);
  }
  return total;
}

/** A seeded generator (mulberry32), so the Monte Carlo reads the same every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("quantiles and intervals", () => {
  it("reads the lower quantile at index floor(p × (n − 1)), in integers", () => {
    expect(QUANTILES).toEqual([10, 25, 50, 75, 90]);
    expect(QUANTILES.map((pct) => lowerQuantileIndex(5, pct))).toEqual([0, 1, 2, 3, 3]);
    // The page's worked figure: the 90th percentile of 124 ratios is index 110.
    expect(lowerQuantileIndex(124, 90)).toBe(110);
    // 0.1 × 30 is 3.0000000000000004 in floating point; the integer form never drifts.
    for (let n = 1; n <= 300; n += 1) for (const pct of QUANTILES) expect(lowerQuantileIndex(n, pct)).toBe(Math.floor((pct * (n - 1)) / 100));
    // The median is the lower median the cohorts already publish.
    const spread = spreadOf([5, 1, 4, 2, 3, 6])!;
    expect(spread.quantiles).toEqual({ p10: 1, p25: 2, p50: 3, p75: 4, p90: 5 });
  });

  it("picks the narrowest order-statistic interval that holds the point and reaches 90%, as a brute-force search does", () => {
    for (const n of [1, 2, 4, 5, 6, 10, 19, 22, 52, 84, 108]) {
      for (const pct of QUANTILES) {
        const p = pct / 100;
        const point = lowerQuantileIndex(n, pct) + 1;
        let best: { width: number; confidence: number } | null = null;
        for (let r = 1; r <= point; r += 1) {
          for (let s = Math.max(point, r + 1); s <= n; s += 1) {
            const confidence = oracleCover(n, p, r, s);
            if (confidence < CONFIDENCE - 1e-12) continue;
            if (best === null || s - r < best.width || (s - r === best.width && confidence > best.confidence)) best = { width: s - r, confidence };
          }
        }
        const chosen = quantileInterval(n, pct);
        const [r, s] = chosen.ranks;
        expect(r).toBeLessThanOrEqual(point);
        expect(s).toBeGreaterThanOrEqual(point);
        if (best === null) {
          // Nothing reaches: the whole range, and the confidence it does reach.
          expect(chosen.ranks, `n ${n} p${pct}`).toEqual([1, n]);
          expect(chosen.confidence).toBeCloseTo(n <= 1 ? 0 : oracleCover(n, p, 1, n), 10);
          expect(chosen.confidence).toBeLessThan(CONFIDENCE);
        } else {
          expect(s - r, `n ${n} p${pct}`).toBe(best.width);
          expect(chosen.confidence).toBeCloseTo(best.confidence, 10);
          expect(chosen.confidence).toBeCloseTo(oracleCover(n, p, r, s), 10);
        }
      }
    }
  });

  it("states what small samples reach, and never more", () => {
    // The median of 5: the range, 1 − 2 · 0.5⁵ = 0.9375, the minimum a cohort rests on.
    expect(quantileInterval(5, 50)).toEqual({ ranks: [1, 5], confidence: 0.9375 });
    expect(quantileInterval(5, 50).confidence).toBe(rangeConfidence(5));
    // Four samples cannot give the median 90%.
    expect(quantileInterval(4, 50)).toEqual({ ranks: [1, 4], confidence: 0.875 });
    // The 90th percentile of 5: even the range reaches only 1 − 0.9⁵ − 0.1⁵.
    expect(quantileInterval(5, 90).confidence).toBeCloseTo(1 - 0.9 ** 5 - 0.1 ** 5, 12);
    // The median of 10, by hand: ranks 2 to 8 hold 1 − (1 + 10 + 45 + 10 + 1) / 1024.
    expect(quantileInterval(10, 50)).toEqual({ ranks: [2, 8], confidence: 957 / 1024 });
    // One sample: a point, which covers nothing with any confidence.
    expect(quantileInterval(1, 50)).toEqual({ ranks: [1, 1], confidence: 0 });
  });

  it("bounds one more sample by (n + 1 − 2k) / (n + 1), reaching 90% from 19 samples", () => {
    expect(MIN_BOUNDS_SAMPLES).toBe(19);
    expect(predictionInterval(1)).toEqual({ ranks: [1, 1], confidence: 0 });
    // Probabilities are published to 12 places.
    expect(predictionInterval(5)).toEqual({ ranks: [1, 5], confidence: 0.666666666667 });
    expect(predictionInterval(18)).toEqual({ ranks: [1, 18], confidence: 0.894736842105 });
    expect(predictionInterval(19)).toEqual({ ranks: [1, 19], confidence: 0.9 });
    expect(predictionInterval(52).ranks).toEqual([2, 51]);
    expect(predictionInterval(52).confidence).toBeCloseTo(49 / 53, 12);
    for (let n = 1; n < MIN_BOUNDS_SAMPLES; n += 1) expect(predictionInterval(n).confidence).toBeLessThan(CONFIDENCE);
    for (let n = MIN_BOUNDS_SAMPLES; n <= 400; n += 1) expect(predictionInterval(n).confidence).toBeGreaterThanOrEqual(CONFIDENCE);
  });

  it("covers as often as it claims on a heavy-tailed distribution (seeded Monte Carlo)", () => {
    const random = seeded(227);
    // Pareto with shape 1.2: a heavy tail with a finite mean. True quantile: (1 − p)^(−1/1.2).
    const draw = (): number => (1 - random()) ** (-1 / 1.2);
    const truth = (pct: number): number => (1 - pct / 100) ** (-1 / 1.2);
    const trials = 4000;
    for (const n of [20, 52]) {
      const covered: Record<number, number> = {};
      let inside = 0;
      for (let trial = 0; trial < trials; trial += 1) {
        const values = Array.from({ length: n }, draw);
        const spread = spreadOf(values)!;
        for (const pct of QUANTILES) {
          const interval = spread.intervals[`p${pct}`];
          if (interval.lower <= truth(pct) && truth(pct) <= interval.upper) covered[pct] = (covered[pct] ?? 0) + 1;
        }
        const next = draw();
        if (spread.bounds.lower <= next && next <= spread.bounds.upper) inside += 1;
      }
      // Within three standard errors of the stated confidence: the claim is the truth, not a floor.
      const tolerance = (confidence: number): number => 3 * Math.sqrt((confidence * (1 - confidence)) / trials);
      for (const pct of QUANTILES) {
        const claimed = quantileInterval(n, pct).confidence;
        expect(Math.abs((covered[pct] ?? 0) / trials - claimed), `n ${n} p${pct}`).toBeLessThan(tolerance(claimed));
      }
      const claimed = predictionInterval(n).confidence;
      expect(Math.abs(inside / trials - claimed), `n ${n} bounds`).toBeLessThan(tolerance(claimed));
    }
  });
});

describe("the heavy-tail test", () => {
  const at = (ratios: number[], estimate = 7200) => ratios.map((ratio) => ({ ratio, estimateSeconds: estimate }));

  /** The rule written out independently: standard medians, z over 3.5 and more than ln 1.05 out. */
  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
  };

  it("flags three samples beyond 3.5 robust deviations of ln(ratio), and clips the expected ratio at the fences", () => {
    expect(HEAVY_TAIL).toEqual({ rule: "log_mad_z", z: 3.5, minSamples: 10, minOutliers: 3, minShare: 0.05, minLogDeviation: Math.log(1.05) });
    const core = [0.15, 0.158, 0.167, 0.175, 0.183, 0.192, 0.2, 0.208];
    const tail = tailOf(at([...core, 4, 4, 4]));
    expect(tail.tested).toBe(true);
    expect(tail.outliers).toEqual({ lower: 0, upper: 3 });
    expect(tail.share).toBeCloseTo(3 / 11, 12);
    expect(tail.heavy).toBe(true);
    expect(tail.scale).toBe("mad");
    // n = 11: the median is the sixth ratio, 0.192; the MAD the sixth deviation, ln(0.192 / 0.167).
    const logs = [...core, 4, 4, 4].map(Math.log);
    const m = median(logs);
    expect(m).toBeCloseTo(Math.log(0.192), 12);
    const scale = median(logs.map((x) => Math.abs(x - m))) / 0.6745;
    expect(scale).toBeCloseTo(Math.log(0.192 / 0.167) / 0.6745, 12);
    expect(tail.fences!.upper).toBeCloseTo(Math.exp(m + 3.5 * scale), 10);
    expect(tail.fences!.lower).toBeCloseTo(Math.exp(m - 3.5 * scale), 10);
    const clipped = (core.reduce((sum, ratio) => sum + ratio, 0) + 3 * tail.fences!.upper) / 11;
    expect(tail.fenceClippedPooled).toBeCloseTo(clipped, 12);
    expect(tail.fenceClippedPooled!).toBeLessThan((core.reduce((sum, ratio) => sum + ratio, 0) + 12) / 11);
  });

  it("does not call two far samples a tail, nor test fewer than ten", () => {
    const two = tailOf(at([0.15, 0.158, 0.167, 0.175, 0.183, 0.192, 0.2, 0.208, 4, 4]));
    expect(two.outliers.upper).toBe(2);
    expect(two.heavy).toBe(false);
    const nine = tailOf(at([0.15, 0.158, 0.167, 0.175, 0.183, 0.192, 4, 4, 4]));
    expect(nine).toEqual({ tested: false, outliers: { lower: 0, upper: 0 }, share: null, heavy: false, fences: null, scale: null, fenceClippedPooled: null });
  });

  it("uses the standard median at even n, where the lower one under-reads the MAD", () => {
    // Ten samples, even: the lower median of the deviations would be the fifth, the standard one
    // averages the fifth and sixth. The fences follow the standard one.
    const ratios = [0.1, 0.11, 0.12, 0.13, 0.14, 0.16, 0.18, 0.2, 0.22, 0.25];
    const logs = ratios.map(Math.log);
    const m = median(logs);
    const scale = median(logs.map((x) => Math.abs(x - m))) / 0.6745;
    expect(tailOf(at(ratios)).fences!.upper).toBeCloseTo(Math.exp(m + 3.5 * scale), 12);
  });

  it("counts a heavy lower tail too, and falls back to the mean absolute deviation when at least half are equal", () => {
    const lower = tailOf(at([0.001, 0.001, 0.001, 0.15, 0.158, 0.167, 0.175, 0.183, 0.192, 0.2, 0.208]));
    expect(lower.outliers).toEqual({ lower: 3, upper: 0 });
    expect(lower.heavy).toBe(true);
    // Eleven of fourteen equal: the MAD is 0, and the mean absolute deviation scales instead,
    // 1.2533 × 3d / 14 for the three at distance d, which puts them at 3.72 deviations.
    const ties = tailOf(at([...Array.from({ length: 11 }, () => 0.2), 50, 50, 50]));
    expect(ties.scale).toBe("mean_absolute_deviation");
    expect(ties.outliers).toEqual({ lower: 0, upper: 3 });
    expect(ties.heavy).toBe(true);
    expect(ties.fences!.upper).toBeCloseTo(0.2 * Math.exp((3.5 * 1.253314 * 3 * Math.log(250)) / 14), 9);
    // Every sample equal: nothing is an outlier, and the fences sit ln 1.05 out.
    const flat = tailOf(at(Array.from({ length: 10 }, () => 0.2)));
    expect(flat).toMatchObject({ tested: true, heavy: false, outliers: { lower: 0, upper: 0 } });
    expect(flat.fences!.upper).toBeCloseTo(0.21, 12);
    expect(flat.fenceClippedPooled).toBeCloseTo(0.2, 12);
  });

  it("never calls a spread of fractions of a percent an outlier", () => {
    // 39 at 1.0 and three at 1.001: the MAD is 0 and the scale tiny, so z is enormous, but no
    // sample is more than ln 1.05 from the median.
    const trivial = tailOf(at([...Array.from({ length: 39 }, () => 1), 1.001, 1.001, 1.001]));
    expect(trivial.outliers).toEqual({ lower: 0, upper: 0 });
    expect(trivial.heavy).toBe(false);
  });

  it("flags at most 2% of plain lognormal cohorts at any n, and finds a real tail (seeded simulation)", () => {
    const random = seeded(1227);
    const normal = (): number => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    const trials = 2000;
    for (const n of [5, 8, 9, 10, 11, 12, 15, 20, 30, 40, 60, 100]) {
      let flagged = 0;
      for (let trial = 0; trial < trials; trial += 1) {
        if (tailOf(at(Array.from({ length: n }, () => Math.exp(0.5 * normal())))).heavy) flagged += 1;
      }
      expect(flagged / trials, `n ${n}`).toBeLessThanOrEqual(0.02);
    }
    // The same core with 15% of the samples forty times the median: found nearly always (at twenty times, about 70%: three must each clear the fence).
    let found = 0;
    for (let trial = 0; trial < trials; trial += 1) {
      const values = Array.from({ length: 20 }, (_, index) => (index < 3 ? 40 : 1) * Math.exp(0.5 * normal()));
      if (tailOf(at(values)).heavy) found += 1;
    }
    expect(found / trials).toBeGreaterThan(0.9);
  });

  it("flags the live tracker's shape: the sparse minority is a heavy tail, the rest is not", () => {
    /**
     * `workSeconds / estimate` of the 129 estimated done leaves on a copy of the maintainers'
     * tracker after `attempt reconstruct` (taken 2026-09-25), to four places: the 108 that are
     * not sparse, and the 21 sparse ones, which are never samples.
     */
    const clean = [0.0252,  0.0278,  0.0316,  0.0337,  0.0338,  0.0401,  0.0405,  0.042,  0.0421,  0.0448,  0.0456,  0.0463,  0.0467,  0.0485,  0.0506,  0.0526,  0.0527,  0.0532,  0.0541,  0.0549,  0.0575,  0.0579,  0.0599,  0.0602,  0.0603,  0.0618,  0.0649,  0.0653,  0.0663,  0.0663,  0.0668,  0.0672,  0.0676,  0.0686,  0.0688,  0.069,  0.0693,  0.0726,  0.073,  0.0733,  0.0737,  0.0744,  0.075,  0.0759,  0.0806,  0.0813,  0.0816,  0.0817,  0.0818,  0.0849,  0.0849,  0.086,  0.0879,  0.0888,  0.0919,  0.0923,  0.0924,  0.0935,  0.0946,  0.0954,  0.0956,  0.0961,  0.0972,  0.0977,  0.0984,  0.0994,  0.0998,  0.1006,  0.1025,  0.1027,  0.1032,  0.1033,  0.1043,  0.1048,  0.105,  0.1092,  0.1161,  0.1205,  0.1222,  0.1249,  0.1286,  0.1294,  0.1319,  0.134,  0.1344,  0.1346,  0.1357,  0.1384,  0.1417,  0.1441,  0.1464,  0.1503,  0.1524,  0.1535,  0.1567,  0.157,  0.1589,  0.1629,  0.1657,  0.17,  0.1704,  0.1736,  0.1836,  0.1941,  0.2208,  0.2343,  0.2476,  0.2933];
    const sparse = [0.0891,  0.1096,  0.1291,  0.1818,  0.2007,  0.2203,  0.3151,  0.3211,  0.5742,  0.8616,  1.1833,  1.5133,  1.5369,  1.5488,  2.0368,  2.1719,  2.4179,  2.4257,  2.8508,  4.0719,  11.4208];
    const without = tailOf(at(clean));
    expect(without).toMatchObject({ tested: true, heavy: false, outliers: { lower: 0, upper: 0 } });
    const all = tailOf(at([...clean, ...sparse]));
    expect(all.heavy).toBe(true);
    expect(all.outliers).toEqual({ lower: 0, upper: 12 });
    expect(all.share).toBeCloseTo(12 / 129, 12);
  });
});

// ---------------------------------------------------------------- the cohorts, from the store

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
  home = mkdtempSync(join(tmpdir(), "staple-ranges-home-"));
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

interface Worked {
  estimate?: number | null;
  /** Work, in minutes; under 1 is a timing floor. */
  minutes?: number;
  kind?: string;
  priority?: "critical" | "high" | "medium" | "low";
  labels?: string[];
  model?: string;
}

/** A leaf worked from checkout to done, commenting every 10 minutes so the work stays exact. */
function worked(title: string, opts: Worked = {}): { id: string; identifier: string } {
  const minutes = opts.minutes ?? 20;
  const from = clock;
  clock += Math.ceil(minutes) + 1;
  at(from);
  const issue = store.createIssue({
    title,
    ...(opts.estimate === null ? {} : { estimatedSeconds: opts.estimate ?? min(120) }),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.labels ? { labels: opts.labels } : {}),
  });
  store.checkoutIssue(issue.id, "w", undefined, opts.model ? { attempt: { harness: "claude_code", model: opts.model } } : {});
  for (let m = from + 10; m < from + minutes; m += 10) {
    at(m);
    store.addComment(issue.id, "progress", "w", "agent");
  }
  at(from + minutes);
  store.updateIssue(issue.id, { status: "done" }, "w");
  return { id: issue.id, identifier: issue.identifier };
}

/** A leaf an older build worked (a narrated checkout, no attempt), rebuilt later by reconstruct. */
function legacy(title: string, minutes: number): { id: string; identifier: string } {
  const from = clock;
  clock += Math.ceil(minutes) + 1;
  at(from);
  const issue = store.createIssue({ title, estimatedSeconds: min(120) });
  tx(store.db, () => writeEventRow(store.db, { kind: "checkout", issueId: issue.id, actor: "old", payload: {}, createdAt: iso(from), dedupKey: `legacy-${issue.id}` }));
  for (let m = from + 10; m < from + minutes; m += 10) {
    at(m);
    store.addComment(issue.id, "progress", "old", "agent");
  }
  at(from + minutes);
  store.updateIssue(issue.id, { status: "done" }, "old");
  return { id: issue.id, identifier: issue.identifier };
}

const read = (query: Parameters<WorkspaceStore["calibration"]>[0] = {}): CalibrationReport => store.calibration({ limit: 500, ...query }, iso(clock + 1));
const cohorts = (report: CalibrationReport): CalibrationCohort[] => report.items as CalibrationCohort[];

describe("cohort ranges", () => {
  it("publishes the ratio's and the work's quantiles, their intervals and bounds, with what they reach", () => {
    for (const minutes of [20, 30, 40, 60, 60]) worked(`t${minutes}`, { minutes, priority: "high" });
    const [cohort] = cohorts(read());
    expect(cohort!.samples).toBe(5);
    // Ratios 1/6, 1/4, 1/3, 1/2, 1/2: lower quantiles at indices 0, 1, 2, 3, 3.
    expect(cohort!.ratio.quantiles).toEqual({ p10: 20 / 120, p25: 30 / 120, p50: 40 / 120, p75: 60 / 120, p90: 60 / 120 });
    expect(cohort!.workSeconds.quantiles).toEqual({ p10: min(20), p25: min(30), p50: min(40), p75: min(60), p90: min(60) });
    expect(cohort!.ratio.intervals!.p50).toEqual({ lower: 20 / 120, upper: 60 / 120, ranks: [1, 5], confidence: 0.9375, reached: true });
    expect(cohort!.ratio.intervals!.p90).toMatchObject({ ranks: [1, 5], reached: false });
    expect(cohort!.ratio.bounds).toEqual({ lower: 20 / 120, upper: 60 / 120, ranks: [1, 5], confidence: 0.666666666667, reached: false });
    expect(cohort!.workSeconds.bounds).toEqual({ lower: min(20), upper: min(60), ranks: [1, 5], confidence: 0.666666666667, reached: false });
    expect(cohort!.ratio.expected).toEqual({ value: 210 / 600, method: "pooled" });
    // Five samples cannot tell a tail from noise: untested.
    expect(cohort!.tail).toMatchObject({ tested: false, heavy: false });
    expect(cohort!.floors).toEqual({ count: 0, share: 0, dominated: false, seconds: 60, refs: [], truncated: false });
    expect(cohort!.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence"]);
  });

  it("reaches 90% bounds from 19 samples, and every quantile's interval from 22", () => {
    for (let i = 0; i < 19; i += 1) worked(`t${i}`, { minutes: 15 + i });
    const [cohort] = cohorts(read());
    expect(cohort!.ratio.bounds).toMatchObject({ lower: 15 / 120, upper: 33 / 120, confidence: 0.9, reached: true });
    expect(cohort!.ratio.intervals!.p50.reached).toBe(true);
    expect(cohort!.ratio.intervals!.p90.reached).toBe(false);
    expect(cohort!.warnings).toEqual(["quantile_below_confidence"]);
    for (let i = 19; i < 22; i += 1) worked(`t${i}`, { minutes: 15 + i });
    const [more] = cohorts(read());
    expect(Object.values(more!.ratio.intervals!).every((interval) => interval.reached)).toBe(true);
    expect(more!.warnings).toEqual([]);
  });

  it("reads a heavy-tailed cohort's expected ratio clipped at the fences, never pooled", () => {
    for (let i = 0; i < 8; i += 1) worked(`core ${i}`, { minutes: 18 + i, labels: ["type:feature"] });
    // Three tickets estimated at five minutes that took twenty: 4 × the estimate.
    for (let i = 0; i < 3; i += 1) worked(`under ${i}`, { minutes: 20, estimate: min(5), labels: ["type:feature"] });
    const [cohort] = cohorts(read());
    expect(cohort!.tail).toMatchObject({ tested: true, heavy: true, outliers: { lower: 0, upper: 3 } });
    expect(cohort!.ratio.pooled).toBeCloseTo(232 / 975, 12);
    expect(cohort!.ratio.expected.method).toBe("fence_clipped_pooled");
    expect(cohort!.ratio.expected.value).toBeCloseTo(cohort!.tail.fenceClippedPooled!, 12);
    expect(cohort!.ratio.expected.value).toBeCloseTo((172 + 3 * cohort!.tail.fences!.upper * 5) / 975, 12);
    // The quantiles are order statistics: the tail moves p90 only.
    expect(cohort!.ratio.quantiles!.p50).toBeCloseTo(23 / 120, 12);
    expect(cohort!.ratio.quantiles!.p90).toBe(4);
    expect(cohort!.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "heavy_tail"]);
  });

  it("keeps the pooled ratio when only two samples sit far out", () => {
    for (let i = 0; i < 8; i += 1) worked(`core ${i}`, { minutes: 18 + i });
    for (let i = 0; i < 2; i += 1) worked(`under ${i}`, { minutes: 20, estimate: min(5) });
    const [cohort] = cohorts(read());
    expect(cohort!.tail).toMatchObject({ tested: true, heavy: false, outliers: { lower: 0, upper: 2 } });
    expect(cohort!.ratio.expected).toEqual({ value: cohort!.ratio.pooled, method: "pooled" });
  });

  it("keeps timing floors apart: counted and listed per class, never samples, and a warning that the samples read long", () => {
    for (const minutes of [20, 30, 40, 60, 60]) worked(`t${minutes}`, { minutes });
    const floorA = worked("floor a", { minutes: 0.5 });
    const floorB = worked("floor b", { minutes: 0.75 });
    const [cohort] = cohorts(read());
    expect(cohort!.samples).toBe(5);
    expect(cohort!.floors).toEqual({ count: 2, share: 2 / 7, dominated: false, seconds: 60, refs: [floorA.identifier, floorB.identifier], truncated: false });
    expect(cohort!.excluded.counts).toEqual({ "timing-floor": 2 });
    expect(cohort!.path).toEqual([{ level: 0, name: "full", samples: 5, floors: 2 }]);
    expect(cohort!.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "floors_excluded"]);
  });

  it("files a floor under its own evidence set: a captured floor is never the reconstructed set's, nor a backfilled one the exact set's", () => {
    for (let i = 0; i < 5; i += 1) worked(`exact ${i}`, { minutes: 20 + i });
    const captured = worked("captured floor", { minutes: 0.5 });
    for (let i = 0; i < 5; i += 1) legacy(`legacy ${i}`, 20 + i);
    const backfilled = legacy("legacy floor", 0.5);
    at(clock);
    expect(store.reconstructAttemptHistory().reconstructed).toBe(6);
    const report = read({ include: ["reconstructed"] });
    const bySet = (set: string) => cohorts(report).find((cohort) => cohort.set === set)!;
    expect(bySet("exact").floors).toMatchObject({ count: 1, refs: [captured.identifier] });
    expect(bySet("reconstructed").floors).toMatchObject({ count: 1, refs: [backfilled.identifier] });
    expect(bySet("reconstructed").warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "floors_excluded", "reconstructed_only"]);
  });

  it("reads a class its floors outnumber at its own key, floor_dominated, instead of falling back past it", () => {
    for (let i = 0; i < 5; i += 1) worked(`task ${i}`, { minutes: 20 + i });
    worked("chore", { kind: "chore", minutes: 20 });
    for (let i = 0; i < 4; i += 1) worked(`tiny ${i}`, { kind: "chore", minutes: 0.5 });
    const chore = cohorts(read()).find((cohort) => cohort.key.kind === "chore")!;
    expect(chore.levelName).toBe("full");
    expect(chore.path).toEqual([{ level: 0, name: "full", samples: 1, floors: 4 }]);
    expect(chore.samples).toBe(1);
    expect(chore.floors).toMatchObject({ count: 4, share: 0.8, dominated: true });
    expect(chore.warnings).toEqual(["small_sample", "bounds_below_confidence", "quantile_below_confidence", "floor_dominated"]);
  });

  it("does not call one floor record a floor-dominated class: floors and samples must make five", () => {
    worked("tiny", { kind: "chore", minutes: 0.5 });
    at(clock);
    const open = store.createIssue({ title: "next chore", kind: "chore", estimatedSeconds: min(30) });
    const [forecast] = read({ for: [open.identifier] }).forecasts;
    expect(forecast!.floors).toMatchObject({ count: 1, dominated: false });
    expect(forecast!.state).toBe("no_samples");
    expect(forecast!.warnings).toEqual(["small_sample", "fallback_used", "floors_excluded", "no_samples"]);
  });

  it("warns reconstructed_only on the reconstructed set, and fallback_used on a broader class", () => {
    for (let i = 0; i < 5; i += 1) worked(`task ${i}`, { minutes: 20 + i });
    worked("bug", { kind: "bug" });
    const bug = cohorts(read()).find((cohort) => cohort.key.kind === "bug")!;
    expect(bug.levelName).toBe("all");
    expect(bug.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "fallback_used"]);
    expect(CALIBRATION_WARNINGS).toEqual([
      "small_sample",
      "bounds_below_confidence",
      "quantile_below_confidence",
      "fallback_used",
      "heavy_tail",
      "floor_dominated",
      "floors_excluded",
      "reconstructed_only",
      "no_samples",
    ]);
  });
});

describe("duration forecasts", () => {
  it("multiplies an open issue's own estimate by the ratio's quantiles, bounds and expected ratio of the class its key reads", () => {
    for (const minutes of [20, 30, 40, 60, 60]) worked(`t${minutes}`, { minutes, priority: "high", labels: ["area:sync"] });
    at(clock);
    const open = store.createIssue({ title: "next", priority: "high", labels: ["area:sync"], estimatedSeconds: min(240) });
    const report = read({ for: [open.identifier] });
    expect(report.forecasts).toHaveLength(1);
    const [forecast] = report.forecasts;
    const [cohort] = cohorts(report);
    expect(forecast).toMatchObject({
      set: "exact",
      identifier: open.identifier,
      status: "backlog",
      estimate: { seconds: min(240) },
      // Nobody has started it: no model to match, so the walk starts without the model.
      key: { kind: "task", priority: "high", workType: "unknown", area: "sync", model: "*" },
      cohort: { level: 1, levelName: "without_model", fallback: "none", samples: 5 },
      state: "ratio",
      heavyTail: false,
      warnings: ["bounds_below_confidence", "quantile_below_confidence"],
      missing: {},
    });
    expect(forecast!.seconds).toEqual({ p10: min(40), p25: min(60), p50: min(80), p75: min(120), p90: min(120) });
    expect(forecast!.bounds).toEqual({ lower: min(40), upper: min(120), ranks: [1, 5], confidence: 0.666666666667, reached: false });
    expect(forecast!.expected).toEqual({ seconds: (210 / 600) * min(240), ratio: 210 / 600, method: "pooled" });
    // The class the forecast read holds exactly the listed cohort's samples.
    expect(forecast!.cohort.class).toEqual({ ...cohort!.class, model: "*" });
    expect(forecast!.cohort.samples).toBe(cohort!.samples);
    // The forecast is not part of the data: asking for one leaves the snapshot alone.
    expect(report.snapshot.id).toBe(read().snapshot.id);
  });

  it("reads the model of an open issue's own attempts, and falls back like any key", () => {
    for (let i = 0; i < 5; i += 1) worked(`opus ${i}`, { minutes: 20 + i, model: "opus" });
    at(clock);
    const open = store.createIssue({ title: "in flight", estimatedSeconds: min(60) });
    store.checkoutIssue(open.id, "w", undefined, { attempt: { harness: "claude_code", model: "sonnet" } });
    const [forecast] = read({ for: [open.id] }).forecasts;
    expect(forecast!.key.model).toBe("sonnet");
    expect(forecast!.cohort).toMatchObject({ levelName: "without_model", fallback: "below_minimum", samples: 5 });
    expect(forecast!.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "fallback_used"]);
  });

  it("never files an unstarted issue under the samples that named no model, and lets the caller pin the model", () => {
    // Five runs with no harness named took their whole estimate; twenty opus runs took a fifth.
    for (let i = 0; i < 5; i += 1) worked(`bare ${i}`, { minutes: 20, estimate: min(20) });
    for (let i = 0; i < 20; i += 1) worked(`opus ${i}`, { minutes: 24, model: "opus" });
    at(clock);
    const open = store.createIssue({ title: "new", estimatedSeconds: min(60) });
    const [unpinned] = read({ for: [open.identifier] }).forecasts;
    // Every sample of task/medium, whatever its model: 20 of 25 read 0.2, so p50 is 12 minutes, not an hour.
    expect(unpinned!.key.model).toBe("*");
    expect(unpinned!.cohort).toMatchObject({ levelName: "without_model", fallback: "none", samples: 25 });
    expect(unpinned!.seconds!.p50).toBeCloseTo(min(12), 6);
    const [opus] = read({ for: [open.identifier], model: "opus" }).forecasts;
    expect(opus!.key.model).toBe("opus");
    expect(opus!.cohort).toMatchObject({ levelName: "full", samples: 20 });
    expect(opus!.seconds!.p50).toBeCloseTo(min(12), 6);
    const [bare] = read({ for: [open.identifier], model: "unknown" }).forecasts;
    expect(bare!.cohort).toMatchObject({ levelName: "full", samples: 5 });
    expect(bare!.seconds!.p50).toBeCloseTo(min(60), 6);
    // A pin overrides the model an attempt named, and changes nothing but the forecasts.
    expect(read({ for: [open.identifier], model: "opus" }).snapshot.id).toBe(read().snapshot.id);
  });

  it("forecasts the floor for a floor-dominated class, and says why there are no seconds", () => {
    worked("chore", { kind: "chore", minutes: 20, estimate: min(30) });
    for (let i = 0; i < 4; i += 1) worked(`tiny ${i}`, { kind: "chore", minutes: 0.5, estimate: min(30) });
    at(clock);
    const open = store.createIssue({ title: "tiny next", kind: "chore", estimatedSeconds: min(30) });
    const unplanned = store.createIssue({ title: "tiny unplanned", kind: "chore" });
    const [forecast, noEstimate] = read({ for: [open.identifier, unplanned.identifier] }).forecasts;
    expect(forecast).toMatchObject({
      state: "floor",
      seconds: null,
      bounds: null,
      // A path sum adds the bound, never nothing.
      expected: { seconds: 60, ratio: null, method: "floor_bound" },
      floors: { count: 4, share: 0.8, dominated: true, seconds: 60 },
      missing: { seconds: "floor_dominated" },
      warnings: ["small_sample", "bounds_below_confidence", "quantile_below_confidence", "floor_dominated"],
    });
    // The floor needs no estimate.
    expect(noEstimate).toMatchObject({ state: "floor", expected: { seconds: 60, method: "floor_bound" }, missing: { seconds: "floor_dominated" } });
  });

  it("names a missing estimate and an empty set, per evidence set, in the order asked", () => {
    for (let i = 0; i < 5; i += 1) worked(`task ${i}`, { minutes: 20 + i });
    at(clock);
    const bare = store.createIssue({ title: "unestimated" });
    const planned = store.createIssue({ title: "planned", estimatedSeconds: min(60) });
    const report = read({ for: [bare.identifier, planned.identifier], include: ["reconstructed"] });
    expect(report.forecasts.map((forecast) => [forecast.identifier, forecast.set, forecast.state, forecast.missing])).toEqual([
      [bare.identifier, "exact", "no_estimate", { seconds: "no_estimate" }],
      [bare.identifier, "reconstructed", "no_estimate", { seconds: "no_estimate" }],
      [planned.identifier, "exact", "ratio", {}],
      [planned.identifier, "reconstructed", "no_samples", { seconds: "no_samples" }],
    ]);
    expect(report.forecasts[3]!.warnings).toEqual(["small_sample", "fallback_used", "reconstructed_only", "no_samples"]);
    expect(report.forecasts[3]!.seconds).toBeNull();
  });

  it("refuses an unknown issue and more issues than the limit", () => {
    const refusal = (fn: () => unknown): StapleError => {
      try {
        fn();
      } catch (error) {
        if (error instanceof StapleError) return error;
        throw error;
      }
      throw new Error("expected a refusal");
    };
    expect(refusal(() => read({ for: ["TST-999"] })).code).toBe("not_found");
    const a = store.createIssue({ title: "a" }).identifier;
    const b = store.createIssue({ title: "b" }).identifier;
    expect(refusal(() => store.calibration({ for: [a, b], limit: 1 })).message).toMatch(/for takes at most 1 issues/);
    expect(refusal(() => store.calibration({ model: "opus" })).message).toMatch(/name them with for/);
    expect(refusal(() => store.calibration({ for: [a], model: " " })).code).toBe("validation");
  });
});
