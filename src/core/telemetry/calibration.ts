/**
 * Calibration cohorts: how long work of a given class takes against its estimate, from the
 * samples that can be trusted (docs/timing-semantics.md, "Calibration cohorts").
 * `staple calibrate` / MCP `calibration_cohorts` / `GET /api/calibration`, one store method.
 *
 * ## Samples
 *
 * The population is the ratio population of the cohort read (`cohort.ts`): issues resolved
 * `done` with their own estimate and no live estimated descendant. A member is a SAMPLE of an
 * evidence set when the selection of that set admits it:
 *
 * - `exact`, always: exact records only (`include exact`, the definition of `ratio.exact`).
 * - `reconstructed`, only when asked for: reconstructed records with no approximate, missing or
 *   floor reason (`include reconstructed`). It is its own set with its own cohorts, never pooled
 *   with `exact`: backfilled history and captured history are different evidence.
 *
 * Approximate, timing-floor and missing records are never samples. They stay in the
 * denominators and are counted, by state and reason, under `excluded`.
 *
 * ## The estimate a sample divides by
 *
 * Q4's switch: the first `estimateAtStart` that reads the issue's own estimate above 0, among the
 * worker attempts on the issue behind its work (a reconstructed attempt reads none), so a
 * re-estimate made after the work started cannot flatter the ratio; otherwise the current own
 * estimate, with the reason in `estimate.missing.atStart`. A parent data point always reads
 * `parent`: its work is its children's (Q5).
 *
 * ## Dimensions and the fallback
 *
 * A cohort's key is the full combination of {@link DIMENSIONS}. A key with fewer than
 * {@link MIN_COHORT_SAMPLES} samples falls back along {@link LEVELS}, dropping one dimension at
 * a time (model, then area, then work type, then priority, then kind), to the first class that
 * has enough; the path it walked, with the count at each level, is reported. The evidence set is
 * never dropped. When not even the whole set has enough, the cohort reads the whole set and
 * says `below_minimum_everywhere`. A level whose timing-floor members ({@link isFloor})
 * outnumber its samples, with at least the minimum of the two together, also stops the walk:
 * the class is floor-dominated, and a broader one would hide it.
 *
 * ## Snapshot identity
 *
 * Every report carries `snapshot.id`, a SHA-256 over the algorithm version, the repository id,
 * the selection (`since` as given, never resolved against the clock) and every member of the population in id order, so the same data
 * gives the same id on every device and in any order, and a changed sample changes it. It
 * reads replicated data only: no `asOf`, no event sequence (device-local), no wall figure.
 */
import { createHash } from "node:crypto";
import { admitter } from "./cohort.js";
import { TIMING_FLOOR_REASON, TIMING_FLOOR_SECONDS, type WorkState } from "./quality.js";
import { afterPosition, cutPage, type KeysetPosition } from "./read-page.js";

/**
 * Bumped whenever a rule here changes what a snapshot id covers, or what a report derives from
 * the same data: version 2 stops the fallback at a floor-dominated level.
 */
export const CALIBRATION_ALGORITHM = "calibration/2";

/**
 * The smallest class a cohort reads. With 5 samples the range of the samples covers the
 * median with probability 1 − 2·0.5⁵ = 93.75%, the first n at which the range is at least a
 * 90% distribution-free interval for it (4 samples give 87.5%). Fewer, and a median is two or
 * three numbers.
 */
export const MIN_COHORT_SAMPLES = 5;

/** How many member refs a cohort lists; `members.total` says how many there are. */
export const MEMBER_REFS = 20;

/** The confidence every interval here aims at. An interval that cannot reach it says so. */
export const CONFIDENCE = 0.9;

/**
 * The quantiles published, as whole percents: the median, the quartiles (the spread a heavy
 * tail cannot move) and the 10th and 90th percentiles (the band a forecast plans between).
 */
export const QUANTILES = [10, 25, 50, 75, 90] as const;
export type QuantileName = `p${(typeof QUANTILES)[number]}`;

/**
 * The smallest n whose prediction bounds reach {@link CONFIDENCE}: `[min, max]` of n samples
 * holds one more with probability `(n − 1) / (n + 1)`, 0.9 at n = 19.
 */
export const MIN_BOUNDS_SAMPLES = 19;

/**
 * The heavy-tail rule, on `ln(ratio)`, with the standard (averaged) median for the centre and
 * the MAD: a sample is an outlier when its modified z-score `(x − median) / (MAD / 0.6745)`
 * exceeds `z` in either direction (Iglewicz and Hoaglin's 3.5) AND it sits more than
 * `minLogDeviation` (ln 1.05) from the median, so a spread of fractions of a percent never
 * makes one. The cohort is heavy-tailed when at least `minOutliers` samples, and at least
 * `minShare` of them, are outliers. Tested from `minSamples`. On plain lognormal cohorts
 * (seeded, 4 000 per n) the rule flags at most about 1.2% at any n from 10 to 200; with two
 * outliers, or from five samples, it flagged 3–6%. On the maintainers' tracker it flags the
 * estimated done leaves with their sparse records in (12 of 129, 9.3%) and none once the
 * sparse records are out (0 of 108).
 */
export const HEAVY_TAIL = { rule: "log_mad_z", z: 3.5, minSamples: 10, minOutliers: 3, minShare: 0.05, minLogDeviation: Math.log(1.05) } as const;

/** The MAD of a normal sample is 0.6745 of its standard deviation. */
const MAD_SCALE = 0.6745;
/** The mean absolute deviation of a normal sample is 1/1.2533 of its standard deviation: the scale when the MAD is 0. */
const MEAN_AD_SCALE = 1.253314;

/**
 * Every warning a cohort or a forecast can carry, in the order they are listed:
 *
 * - `small_sample`: fewer than {@link MIN_COHORT_SAMPLES} samples in the class read; the median's
 *   interval cannot reach the confidence.
 * - `bounds_below_confidence`: fewer than {@link MIN_BOUNDS_SAMPLES}; the bounds reach less than it.
 * - `fallback_used`: the class read is broader than the key.
 * - `quantile_below_confidence`: a ratio quantile's interval (p10 and p90 last, from 22 samples) reaches less than it.
 * - `heavy_tail`: the ratio's tail fails {@link HEAVY_TAIL}; the expected ratio is clipped at the fences.
 * - `floor_dominated`: the class has more timing-floor members than samples, and at least
 *   {@link MIN_COHORT_SAMPLES} of the two; a forecast reads the floor.
 * - `floors_excluded`: the class has timing-floor members (fewer than samples); the samples leave them out, so they read long.
 * - `reconstructed_only`: the samples are reconstructed history.
 * - `no_samples`: the class read has no sample at all.
 */
export const CALIBRATION_WARNINGS = [
  "small_sample",
  "bounds_below_confidence",
  "quantile_below_confidence",
  "fallback_used",
  "heavy_tail",
  "floor_dominated",
  "floors_excluded",
  "reconstructed_only",
  "no_samples",
] as const;
export type CalibrationWarning = (typeof CALIBRATION_WARNINGS)[number];

export const EVIDENCE_SETS = ["exact", "reconstructed"] as const;
export type EvidenceSet = (typeof EVIDENCE_SETS)[number];

/** The dimensions of a cohort key, broadest last. */
export const DIMENSIONS = ["kind", "priority", "workType", "area", "model"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type CohortKey = Record<Dimension, string>;

/** A dimension with no value on a record. */
export const UNKNOWN = "unknown";
/** A dimension a class dropped. */
export const ANY = "*";

/** The fallback order: each level keeps these dimensions. */
export const LEVELS: ReadonlyArray<{ readonly level: number; readonly name: string; readonly keeps: readonly Dimension[] }> = [
  { level: 0, name: "full", keeps: ["kind", "priority", "workType", "area", "model"] },
  { level: 1, name: "without_model", keeps: ["kind", "priority", "workType", "area"] },
  { level: 2, name: "without_area", keeps: ["kind", "priority", "workType"] },
  { level: 3, name: "without_work_type", keeps: ["kind", "priority"] },
  { level: 4, name: "kind", keeps: ["kind"] },
  { level: 5, name: "all", keeps: [] },
];

/** The label prefixes the two label-sourced dimensions read. */
export const LABEL_PREFIX = { workType: "type:", area: "area:" } as const;

/**
 * A label-sourced dimension: the values of every label `<prefix><value>` (prefix matched
 * without case, value lowercased and trimmed), distinct and sorted, joined with `+`;
 * {@link UNKNOWN} when there is none.
 */
export function labelDimension(labels: readonly string[], prefix: string): string {
  const values = new Set<string>();
  for (const label of labels) {
    if (label.toLowerCase().startsWith(prefix)) {
      const value = label.slice(prefix.length).trim().toLowerCase();
      if (value !== "") values.add(value);
    }
  }
  return values.size === 0 ? UNKNOWN : [...values].sort().join("+");
}

/**
 * The model dimension: the `harness.model` of every contributing worker attempt, distinct and
 * sorted, joined with `+`; an attempt that named none counts as {@link UNKNOWN}, and so does a
 * record with no attempt at all.
 */
export function modelDimension(models: ReadonlyArray<string | null>): string {
  if (models.length === 0) return UNKNOWN;
  return [...new Set(models.map((model) => (model === null || model.trim() === "" ? UNKNOWN : model.trim())))].sort().join("+");
}

/** Why a sample divides by the current estimate and not the one its work started from. */
export type EstimateAtStartMissing = "parent" | "no_worker_attempt" | "not_recorded" | "not_own";

/** The estimate a sample divides by. */
export interface SampleEstimate {
  readonly seconds: number;
  /** `at_start`: the first own `estimateAtStart` behind the work; `current`: the issue's own estimate now. */
  readonly source: "at_start" | "current";
  readonly atStartSeconds: number | null;
  readonly currentSeconds: number;
  /** Why `atStartSeconds` is null. */
  readonly missing: { readonly atStart?: EstimateAtStartMissing };
}

/** The evidence behind a record's work figure. */
export interface SampleEvidence {
  readonly state: WorkState;
  readonly reasons: string[];
  /** Worker attempts contributing to `workSeconds`. */
  readonly workerAttempts: number;
  /** Their provenances, distinct and sorted (`recorded`, `reconstructed`). */
  readonly provenance: string[];
  /** Of them, how many named a harness. */
  readonly harnessSupplied: number;
}

/** A member of the population, as the store supplies it. */
export interface CalibrationMember {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly completedAt: string | null;
  readonly workSeconds: number | null;
  readonly estimate: SampleEstimate;
  readonly dimensions: CohortKey;
  readonly evidence: SampleEvidence;
}

/** One sample, as `--samples` lists it. */
export interface CalibrationSample {
  readonly set: EvidenceSet;
  readonly identifier: string;
  readonly title: string;
  readonly completedAt: string | null;
  readonly workSeconds: number;
  readonly estimate: SampleEstimate;
  /** `workSeconds / estimate.seconds`. */
  readonly ratio: number;
  readonly dimensions: CohortKey;
  readonly evidence: SampleEvidence;
}

/** What a class leaves out: the population members in it that are not samples of the set. */
export interface CalibrationExcluded {
  readonly count: number;
  readonly counts: Partial<Record<WorkState, number>>;
  readonly reasons: Record<string, number>;
}

/** `samples / eligible`, with the denominator named. */
export interface CalibrationCoverage {
  readonly samples: number;
  readonly eligible: number;
  /** Null, with `no_eligible_records`, when nothing is eligible. */
  readonly fraction: number | null;
  readonly denominator: "ratio_population";
}

/** How an expected ratio was formed. */
export type ExpectedMethod = "pooled" | "fence_clipped_pooled";

/** A distribution-free interval between two order statistics of a cohort's samples. */
export interface OrderInterval {
  readonly lower: number;
  readonly upper: number;
  /** The 1-based ranks of `lower` and `upper` in the ascending samples. */
  readonly ranks: readonly [number, number];
  /** The probability it covers what it claims, for any continuous distribution. */
  readonly confidence: number;
  /** `confidence` is at least {@link CONFIDENCE}. */
  readonly reached: boolean;
}

/** The spread of one figure over a cohort's samples. */
export interface CalibrationSpread {
  /** The lower quantiles: index `floor(p × (n − 1))` of the ascending samples. */
  readonly quantiles: Record<QuantileName, number>;
  /** For each quantile, the order-statistic interval that covers the class's true quantile. */
  readonly intervals: Record<QuantileName, OrderInterval>;
  /** Where one more sample of the class falls: the prediction interval `[x(k), x(n+1−k)]`. */
  readonly bounds: OrderInterval;
}

/** The heavy-tail test of a cohort's ratios ({@link HEAVY_TAIL}). */
export interface CalibrationTail {
  /** False below `HEAVY_TAIL.minSamples` (10): too few samples to tell a tail from noise. */
  readonly tested: boolean;
  /** Samples beyond each fence. */
  readonly outliers: { readonly lower: number; readonly upper: number };
  /** Outliers over samples; null when not tested. */
  readonly share: number | null;
  readonly heavy: boolean;
  /** The ratios beyond which a sample is an outlier; null when not tested. */
  readonly fences: { readonly lower: number; readonly upper: number } | null;
  /** The scale the z-score divides by: the MAD, or the mean absolute deviation when the MAD is 0. */
  readonly scale: "mad" | "mean_absolute_deviation" | null;
  /**
   * `Σ clamp(ratio, fences) × estimate / Σ estimate`: the pooled ratio with every sample's
   * ratio clipped at the fences (not a winsorisation at a quantile). Null when not tested.
   */
  readonly fenceClippedPooled: number | null;
}

/** The class's timing-floor members: work under {@link TIMING_FLOOR_SECONDS}, never samples, kept visible. */
export interface CalibrationFloors {
  readonly count: number;
  /** Floors over floors and samples; null when both are 0. */
  readonly share: number | null;
  /** More floors than samples, with at least {@link MIN_COHORT_SAMPLES} of the two: a forecast reads the floor, not a ratio. */
  readonly dominated: boolean;
  readonly seconds: number;
  /** Oldest resolution first, at most {@link MEMBER_REFS}. */
  readonly refs: string[];
  readonly truncated: boolean;
}

/** One cohort: an observed key, and the class it reads. */
export interface CalibrationCohort {
  readonly set: EvidenceSet;
  /** The full combination of dimensions its samples share. */
  readonly key: CohortKey;
  /** Samples with exactly that key. */
  readonly keySamples: number;
  /** The level it read: 0 is the full key. */
  readonly level: number;
  readonly levelName: string;
  /** The key with the dropped dimensions as `*`. */
  readonly class: CohortKey;
  /** Every level tried, in order, up to the one read, with its sample and timing-floor counts. */
  readonly path: Array<{ readonly level: number; readonly name: string; readonly samples: number; readonly floors: number }>;
  /**
   * `none`: the key had enough; `below_minimum`: it fell back; `below_minimum_everywhere`: even
   * `all` has too few. A level has enough with {@link MIN_COHORT_SAMPLES} samples, or with that
   * many samples and floors together when the floors outnumber the samples.
   */
  readonly fallback: "none" | "below_minimum" | "below_minimum_everywhere";
  readonly samples: number;
  /** Samples over the population members in the class, whatever their quality. */
  readonly coverage: CalibrationCoverage;
  /**
   * Median is the lower median (`floor((n − 1) / 2)`); pooled is `Σ work / Σ estimate`; `min` and
   * `max` are the sample range, which covers the median with probability `rangeConfidence`.
   */
  readonly ratio: {
    readonly median: number;
    readonly pooled: number;
    readonly min: number;
    readonly max: number;
    /**
     * The ratio a forecast's expected duration uses: `pooled`, or `fence_clipped_pooled` when the
     * tail is heavy. The clipped figure is biased low on a heavy-tailed class: it caps exactly
     * the long runs that make the tail.
     */
    readonly expected: { readonly value: number; readonly method: ExpectedMethod };
    /** Null with no sample. */
    readonly quantiles: CalibrationSpread["quantiles"] | null;
    readonly intervals: CalibrationSpread["intervals"] | null;
    readonly bounds: OrderInterval | null;
  };
  readonly workSeconds: {
    readonly median: number;
    readonly total: number;
    readonly min: number;
    readonly max: number;
    readonly quantiles: CalibrationSpread["quantiles"] | null;
    readonly intervals: CalibrationSpread["intervals"] | null;
    readonly bounds: OrderInterval | null;
  };
  /** The ratio's heavy-tail test. */
  readonly tail: CalibrationTail;
  /** The timing-floor members of the class. */
  readonly floors: CalibrationFloors;
  /**
   * `1 − 2 · 0.5ⁿ`: the probability that `[min, max]` covers the class's true median, for any
   * distribution (0.9375 at the minimum of 5). 0 with no sample.
   */
  readonly rangeConfidence: number;
  readonly estimatedSeconds: { readonly total: number };
  /** How many samples divided by each estimate source. */
  readonly estimateSources: { readonly at_start: number; readonly current: number };
  /** The class's samples, oldest resolution first, at most {@link MEMBER_REFS}. */
  readonly members: { readonly total: number; readonly refs: string[]; readonly truncated: boolean };
  readonly excluded: CalibrationExcluded;
  /** From {@link CALIBRATION_WARNINGS}, in its order. */
  readonly warnings: CalibrationWarning[];
}

/**
 * A duration forecast for one issue from one evidence set ({@link forecastDuration}): the
 * cohort its key reads, times its own estimate.
 */
export interface DurationForecast {
  readonly set: EvidenceSet;
  readonly identifier: string;
  readonly title: string;
  readonly status: string;
  /** The issue's own estimate now; null without one. */
  readonly estimate: { readonly seconds: number | null };
  readonly key: CohortKey;
  /** The class the key reads, as the cohort listing resolves it. */
  readonly cohort: Pick<CalibrationCohort, "level" | "levelName" | "class" | "path" | "fallback" | "samples" | "coverage">;
  /**
   * `ratio`: seconds are the estimate times the ratio's figures; `floor`: the class is
   * floor-dominated, and the work is expected under `floors.seconds`; `no_samples`: nothing to
   * read; `no_estimate`: nothing to multiply.
   */
  readonly state: "ratio" | "floor" | "no_samples" | "no_estimate";
  /** `estimate × ratio.quantiles`; null unless `state` is `ratio`. */
  readonly seconds: Record<QuantileName, number> | null;
  /** `estimate × ratio.bounds`: where this issue's duration falls, at the confidence reached. */
  readonly bounds: OrderInterval | null;
  /**
   * `estimate × ratio.expected`: the one figure that adds along a path (quantiles and bounds do
   * not). For a floor forecast, `{seconds: 60, ratio: null, method: "floor_bound"}`, an upper
   * bound. `fence_clipped_pooled` reads low on a heavy-tailed class, and a sum inherits that.
   */
  readonly expected: { readonly seconds: number; readonly ratio: number | null; readonly method: ExpectedMethod | "floor_bound" } | null;
  readonly heavyTail: boolean;
  readonly floors: Pick<CalibrationFloors, "count" | "share" | "dominated" | "seconds">;
  readonly warnings: CalibrationWarning[];
  /** Why `seconds` is null. */
  readonly missing: Record<string, string>;
}

export interface CalibrationSetSummary {
  readonly set: EvidenceSet;
  readonly samples: number;
  readonly coverage: CalibrationCoverage;
  readonly excluded: CalibrationExcluded;
  /** Distinct full keys among the samples: the cohorts this set lists. */
  readonly cohorts: number;
}

export interface CalibrationFilter {
  readonly kind: string[] | null;
  readonly priority: string[] | null;
  readonly parent: string | null;
  /** The resolved instant: issues resolved at or after it. */
  readonly since: string | null;
  /** The evidence sets read: `exact` always, `reconstructed` when asked for. */
  readonly include: EvidenceSet[];
}

export interface CalibrationReport {
  readonly asOf: string;
  readonly filter: CalibrationFilter;
  /** The identity of the data the report was computed from. */
  readonly snapshot: {
    readonly id: string;
    readonly algorithm: string;
    readonly repositoryId: string | null;
    /** The population the id covers. */
    readonly members: number;
    readonly samples: Partial<Record<EvidenceSet, number>>;
  };
  readonly method: {
    readonly minSamples: number;
    readonly levels: string[];
    readonly median: "lower";
    readonly estimate: "at_start_else_current";
    /** Every quantile here is the lower quantile, index `floor(p × (n − 1))`. */
    readonly quantile: "lower";
    readonly quantiles: QuantileName[];
    /** The confidence every interval aims at. */
    readonly confidence: number;
    /** The quantile intervals and the prediction bounds: order statistics, distribution-free. */
    readonly intervals: "order_statistic";
    readonly minBoundsSamples: number;
    readonly heavyTail: typeof HEAVY_TAIL;
    readonly floorSeconds: number;
  };
  readonly population: {
    /** Issues in the filter (milestones never). */
    readonly issues: number;
    /** The ratio population: done, their own estimate, no live estimated descendant. */
    readonly ratio: number;
    /** Of them, parents. */
    readonly parents: number;
  };
  readonly sets: CalibrationSetSummary[];
  /** What `items` holds. */
  readonly list: "cohorts" | "samples";
  readonly items: CalibrationCohort[] | CalibrationSample[];
  /** A duration forecast per issue asked for (`for`) and per evidence set read, in the order asked. */
  readonly forecasts: DurationForecast[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly missing: Record<string, string>;
}

const SET_SELECTION: Record<EvidenceSet, ReturnType<typeof admitter>> = {
  exact: admitter({ include: ["exact"], exclude: [], excludeReasons: [] }),
  reconstructed: admitter({ include: ["reconstructed"], exclude: [], excludeReasons: [] }),
};

/** Is `member` a sample of `set`: admitted by the set's selection, with a figure and an estimate. */
export function isSample(member: CalibrationMember, set: EvidenceSet): boolean {
  return member.workSeconds !== null && member.estimate.seconds > 0 && SET_SELECTION[set].admits({ work: member.evidence });
}

const FLOOR_SELECTION: Record<EvidenceSet, ReturnType<typeof admitter>> = {
  exact: admitter({ include: ["exact", "timing-floor"], exclude: [], excludeReasons: [] }),
  reconstructed: admitter({ include: ["reconstructed", "timing-floor"], exclude: [], excludeReasons: [] }),
};

/** The state a floor member of each set has: a captured one reads `timing-floor`, a backfilled one `reconstructed`. */
const FLOOR_STATE: Record<EvidenceSet, WorkState> = { exact: "timing-floor", reconstructed: "reconstructed" };

/**
 * Is `member` a timing-floor member of `set`: under the floor, and a sample of the set but for
 * that. An approximate record under the floor is approximate first, and is neither; a captured
 * floor is never the reconstructed set's, nor a backfilled one the exact set's.
 */
export function isFloor(member: CalibrationMember, set: EvidenceSet): boolean {
  return (
    member.workSeconds !== null &&
    member.estimate.seconds > 0 &&
    member.evidence.state === FLOOR_STATE[set] &&
    member.evidence.reasons.includes(TIMING_FLOOR_REASON) &&
    FLOOR_SELECTION[set].admits({ work: member.evidence })
  );
}

const keyString = (key: CohortKey): string => JSON.stringify(DIMENSIONS.map((dimension) => key[dimension]));

/** The class of `key` at `level`: dropped dimensions read `*`. */
export function classAt(key: CohortKey, level: number): CohortKey {
  const keeps = LEVELS[level]!.keeps;
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, keeps.includes(dimension) ? key[dimension] : ANY])) as CohortKey;
}

const inClass = (dimensions: CohortKey, klass: CohortKey): boolean => DIMENSIONS.every((dimension) => klass[dimension] === ANY || klass[dimension] === dimensions[dimension]);

/** `1 − 2 · 0.5ⁿ`: how often the range of n samples covers the median, whatever the distribution. */
export function rangeConfidence(n: number): number {
  return n === 0 ? 0 : 1 - 2 * 0.5 ** n;
}

/** The lower median: index `floor((n − 1) / 2)` of the ascending list, the page's quantile method. */
export function lowerMedian(values: readonly number[]): number {
  // Callers guard the empty list.
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Index `floor(pct × (n − 1) / 100)` of an ascending list, in integers so no rounding moves it. */
export function lowerQuantileIndex(n: number, pct: number): number {
  return Math.floor((pct * (n - 1)) / 100);
}

/** The lower quantile of an ascending list (non-empty). */
export function lowerQuantile(sorted: readonly number[], pct: number): number {
  return sorted[lowerQuantileIndex(sorted.length, pct)]!;
}

/** The probabilities of `Binomial(n, p)`, from logs so a large n does not underflow the first term. */
function binomialPmf(n: number, p: number): number[] {
  const out: number[] = [];
  let log = n * Math.log(1 - p);
  const step = Math.log(p) - Math.log(1 - p);
  for (let k = 0; k <= n; k += 1) {
    out.push(Math.exp(log));
    log += Math.log(n - k) - Math.log(k + 1) + step;
  }
  return out;
}

/** A probability to 12 places, in [0, 1]: summation noise off, so 1 − 2 · 0.5⁵ reads 0.9375. */
const rounded = (probability: number): number => Math.min(1, Math.max(0, Math.round(probability * 1e12) / 1e12));

/** A rounding margin for "reaches the confidence", far below any figure published. */
const EPSILON = 1e-12;
const reaches = (confidence: number): boolean => confidence >= CONFIDENCE - EPSILON;

const quantileRanks = new Map<string, { ranks: [number, number]; confidence: number }>();

/**
 * The order-statistic interval for the `pct` quantile of n samples: ranks `r ≤ s` (1-based) cover
 * the true quantile with probability `P(r ≤ B ≤ s − 1)`, `B ~ Binomial(n, pct/100)`, for any
 * continuous distribution. Of the pairs that hold the point estimate's rank and reach
 * {@link CONFIDENCE}: the fewest ranks apart, then the highest confidence, then the most
 * centred on the point, then the lowest. When none reaches it, `[x(1), x(n)]` and what it
 * reaches. Depends on n and the quantile only, never on the values.
 */
export function quantileInterval(n: number, pct: number): { ranks: [number, number]; confidence: number } {
  const cacheKey = `${n}:${pct}`;
  const cached = quantileRanks.get(cacheKey);
  if (cached !== undefined) return cached;
  const pmf = binomialPmf(n, pct / 100);
  const cumulative = [0];
  for (const mass of pmf) cumulative.push(cumulative[cumulative.length - 1]! + mass);
  /** `P(r ≤ B ≤ s − 1)`. */
  const cover = (r: number, s: number): number => rounded(cumulative[s]! - cumulative[r]!);
  const point = lowerQuantileIndex(n, pct) + 1;
  let chosen: { ranks: [number, number]; confidence: number } | null = null;
  for (let width = 1; width < n && chosen === null; width += 1) {
    for (let r = Math.max(1, point - width); r <= point && r + width <= n; r += 1) {
      const s = r + width;
      const confidence = cover(r, s);
      if (!reaches(confidence)) continue;
      const centre = Math.abs(r + s - 2 * point);
      if (
        chosen === null ||
        confidence > chosen.confidence + EPSILON ||
        (Math.abs(confidence - chosen.confidence) <= EPSILON && centre < Math.abs(chosen.ranks[0] + chosen.ranks[1] - 2 * point))
      ) {
        chosen = { ranks: [r, s], confidence };
      }
    }
  }
  const result = chosen ?? { ranks: [1, n] as [number, number], confidence: n <= 1 ? 0 : cover(1, n) };
  quantileRanks.set(cacheKey, result);
  return result;
}

/**
 * The prediction interval for one more sample: `[x(k), x(n+1−k)]` holds it with probability
 * `(n + 1 − 2k) / (n + 1)` when the samples and it are exchangeable, whatever the
 * distribution. The largest k that reaches {@link CONFIDENCE}; `k = 1` (the sample range) and
 * what it reaches when none does.
 */
export function predictionInterval(n: number): { ranks: [number, number]; confidence: number } {
  let k = 1;
  while ((n + 1 - 2 * (k + 1)) / (n + 1) >= CONFIDENCE - EPSILON && k + 1 <= n + 1 - (k + 1)) k += 1;
  return { ranks: [k, n + 1 - k], confidence: rounded((n + 1 - 2 * k) / (n + 1)) };
}

const intervalOf = (sorted: readonly number[], at: { ranks: [number, number]; confidence: number }): OrderInterval => ({
  lower: sorted[at.ranks[0] - 1]!,
  upper: sorted[at.ranks[1] - 1]!,
  ranks: at.ranks,
  confidence: at.confidence,
  reached: reaches(at.confidence),
});

/** The quantiles, their intervals and the prediction bounds of a figure; null with no sample. */
export function spreadOf(values: readonly number[]): CalibrationSpread | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const quantiles = {} as Record<QuantileName, number>;
  const intervals = {} as Record<QuantileName, OrderInterval>;
  for (const pct of QUANTILES) {
    quantiles[`p${pct}`] = lowerQuantile(sorted, pct);
    intervals[`p${pct}`] = intervalOf(sorted, quantileInterval(n, pct));
  }
  return { quantiles, intervals, bounds: intervalOf(sorted, predictionInterval(n)) };
}

/** The standard median: the middle value, or the mean of the two middle values. Only the tail test reads it. */
export function standardMedian(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

/**
 * The heavy-tail test ({@link HEAVY_TAIL}) over samples' ratios and the estimates they divided
 * by. On `ln(ratio)`: the standard median m, the MAD (the standard median of `|x − m|`), and
 * the scale `MAD / 0.6745`, or `1.2533 × mean |x − m|` when the MAD is 0 (at least half the
 * samples equal). The fences sit `max(z × scale, ln 1.05)` either side of m; a sample beyond
 * one is an outlier. The lower median, the published quantiles' method, under-reads the MAD
 * at even n and was the source of false positives there, so the test alone uses this one.
 */
export function tailOf(samples: ReadonlyArray<{ readonly ratio: number; readonly estimateSeconds: number }>): CalibrationTail {
  const n = samples.length;
  if (n < HEAVY_TAIL.minSamples) {
    return { tested: false, outliers: { lower: 0, upper: 0 }, share: null, heavy: false, fences: null, scale: null, fenceClippedPooled: null };
  }
  const logs = samples.map((sample) => Math.log(sample.ratio));
  const m = standardMedian(logs);
  const deviations = logs.map((x) => Math.abs(x - m));
  const mad = standardMedian(deviations);
  const kind: "mad" | "mean_absolute_deviation" = mad > 0 ? "mad" : "mean_absolute_deviation";
  const scale = mad > 0 ? mad / MAD_SCALE : (MEAN_AD_SCALE * deviations.reduce((sum, d) => sum + d, 0)) / n;
  const half = Math.max(HEAVY_TAIL.z * scale, HEAVY_TAIL.minLogDeviation);
  const fences = { lower: Math.exp(m - half), upper: Math.exp(m + half) };
  const lower = logs.filter((x) => m - x > half).length;
  const upper = logs.filter((x) => x - m > half).length;
  const outliers = lower + upper;
  const estimateTotal = samples.reduce((sum, sample) => sum + sample.estimateSeconds, 0);
  const clipped = samples.reduce((sum, sample) => sum + Math.min(fences.upper, Math.max(fences.lower, sample.ratio)) * sample.estimateSeconds, 0) / estimateTotal;
  return {
    tested: true,
    outliers: { lower, upper },
    share: outliers / n,
    heavy: outliers >= HEAVY_TAIL.minOutliers && outliers / n >= HEAVY_TAIL.minShare,
    fences,
    scale: kind,
    fenceClippedPooled: clipped,
  };
}

function tally(values: ReadonlyArray<readonly string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reasons of values) for (const reason of reasons) out[reason] = (out[reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function excludedOf(members: readonly CalibrationMember[]): CalibrationExcluded {
  const counts: Partial<Record<WorkState, number>> = {};
  for (const member of members) counts[member.evidence.state] = (counts[member.evidence.state] ?? 0) + 1;
  const ordered = (["exact", "timing-floor", "approximate", "reconstructed", "missing"] as const).filter((state) => counts[state] !== undefined);
  return { count: members.length, counts: Object.fromEntries(ordered.map((state) => [state, counts[state]!])), reasons: tally(members.map((member) => member.evidence.reasons)) };
}

function coverageOf(samples: number, eligible: number): CalibrationCoverage {
  return { samples, eligible, fraction: eligible === 0 ? null : samples / eligible, denominator: "ratio_population" };
}

const byResolution = (a: CalibrationMember, b: CalibrationMember): number => {
  const x = a.completedAt ?? "";
  const y = b.completedAt ?? "";
  return x === y ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : x < y ? -1 : 1;
};

function sampleOf(member: CalibrationMember, set: EvidenceSet): CalibrationSample {
  return {
    set,
    identifier: member.identifier,
    title: member.title,
    completedAt: member.completedAt,
    workSeconds: member.workSeconds!,
    estimate: member.estimate,
    ratio: member.workSeconds! / member.estimate.seconds,
    dimensions: member.dimensions,
    evidence: member.evidence,
  };
}

/**
 * The cohort `key` reads in `set`: the first class along {@link LEVELS} with at least
 * {@link MIN_COHORT_SAMPLES} samples, or the whole set when none has. `population` is every
 * member (samples of the set or not), for coverage and exclusions. Exported so a later reader
 * (an estimate suggestion for one issue) resolves a class exactly as the listing does.
 */
export function resolveCohort(set: EvidenceSet, key: CohortKey, population: readonly CalibrationMember[]): CalibrationCohort {
  const samples = population.filter((member) => isSample(member, set));
  const floorMembers = population.filter((member) => isFloor(member, set));
  const path: Array<{ level: number; name: string; samples: number; floors: number }> = [];
  let chosen = LEVELS.length - 1;
  let enough = false;
  // A key with no model to match (an issue nobody has started) starts without the model.
  const start = key.model === ANY ? 1 : 0;
  for (const { level, name } of LEVELS.filter((step) => step.level >= start)) {
    const klass = classAt(key, level);
    const count = samples.filter((member) => inClass(member.dimensions, klass)).length;
    const floors = floorMembers.filter((member) => inClass(member.dimensions, klass)).length;
    path.push({ level, name, samples: count, floors });
    // Enough samples, or enough evidence that the class's work is mostly under the floor.
    if (count >= MIN_COHORT_SAMPLES || (floors > count && count + floors >= MIN_COHORT_SAMPLES)) {
      chosen = level;
      enough = true;
      break;
    }
  }
  const klass = classAt(key, chosen);
  const members = samples.filter((member) => inClass(member.dimensions, klass)).sort(byResolution);
  const floored = floorMembers.filter((member) => inClass(member.dimensions, klass)).sort(byResolution);
  const eligible = population.filter((member) => inClass(member.dimensions, klass));
  const records = members.map((member) => sampleOf(member, set));
  const workTotal = records.reduce((sum, sample) => sum + sample.workSeconds, 0);
  const estimateTotal = records.reduce((sum, sample) => sum + sample.estimate.seconds, 0);
  const n = records.length;
  // A listed cohort has a sample of its own key; a key resolved from elsewhere (an empty set) reads 0.
  const extreme = (values: number[], of: (values: number[]) => number): number => (values.length === 0 ? 0 : of(values));
  const ratios = records.map((sample) => sample.ratio);
  const works = records.map((sample) => sample.workSeconds);
  const ratioSpread = spreadOf(ratios);
  const workSpread = spreadOf(works);
  const tail = tailOf(records.map((sample) => ({ ratio: sample.ratio, estimateSeconds: sample.estimate.seconds })));
  const pooled = estimateTotal === 0 ? 0 : workTotal / estimateTotal;
  const floors: CalibrationFloors = {
    count: floored.length,
    share: floored.length + n === 0 ? null : floored.length / (floored.length + n),
    // More floors than samples, and enough of the two to be evidence rather than one record.
    dominated: floored.length > n && floored.length + n >= MIN_COHORT_SAMPLES,
    seconds: TIMING_FLOOR_SECONDS,
    refs: floored.slice(0, MEMBER_REFS).map((member) => member.identifier),
    truncated: floored.length > MEMBER_REFS,
  };
  const raised = new Set<CalibrationWarning>();
  if (n < MIN_COHORT_SAMPLES) raised.add("small_sample");
  if (ratioSpread !== null && !ratioSpread.bounds.reached) raised.add("bounds_below_confidence");
  if (ratioSpread !== null && Object.values(ratioSpread.intervals).some((interval) => !interval.reached)) raised.add("quantile_below_confidence");
  if (chosen > start) raised.add("fallback_used");
  if (tail.heavy) raised.add("heavy_tail");
  if (floors.dominated) raised.add("floor_dominated");
  else if (floors.count > 0) raised.add("floors_excluded");
  if (set === "reconstructed") raised.add("reconstructed_only");
  if (n === 0) raised.add("no_samples");
  return {
    set,
    key,
    keySamples: path[0]!.samples,
    level: chosen,
    levelName: LEVELS[chosen]!.name,
    class: klass,
    path,
    fallback: chosen === start && enough ? "none" : enough ? "below_minimum" : "below_minimum_everywhere",
    samples: n,
    coverage: coverageOf(n, eligible.length),
    ratio: {
      median: extreme(ratios, lowerMedian),
      pooled,
      min: extreme(ratios, (v) => Math.min(...v)),
      max: extreme(ratios, (v) => Math.max(...v)),
      expected: tail.heavy ? { value: tail.fenceClippedPooled!, method: "fence_clipped_pooled" } : { value: pooled, method: "pooled" },
      quantiles: ratioSpread?.quantiles ?? null,
      intervals: ratioSpread?.intervals ?? null,
      bounds: ratioSpread?.bounds ?? null,
    },
    workSeconds: {
      median: extreme(works, lowerMedian),
      total: workTotal,
      min: extreme(works, (v) => Math.min(...v)),
      max: extreme(works, (v) => Math.max(...v)),
      quantiles: workSpread?.quantiles ?? null,
      intervals: workSpread?.intervals ?? null,
      bounds: workSpread?.bounds ?? null,
    },
    tail,
    floors,
    rangeConfidence: rangeConfidence(n),
    estimatedSeconds: { total: estimateTotal },
    estimateSources: { at_start: records.filter((sample) => sample.estimate.source === "at_start").length, current: records.filter((sample) => sample.estimate.source === "current").length },
    members: { total: n, refs: records.slice(0, MEMBER_REFS).map((sample) => sample.identifier), truncated: n > MEMBER_REFS },
    excluded: excludedOf(eligible.filter((member) => !isSample(member, set))),
    warnings: CALIBRATION_WARNINGS.filter((code) => raised.has(code)),
  };
}

/** The issue a forecast is for, as the store supplies it. */
export interface ForecastSubject {
  readonly identifier: string;
  readonly title: string;
  readonly status: string;
  /** Its own estimate; null or 0 without one. */
  readonly estimateSeconds: number | null;
  /**
   * Its key, by the rules a member's is read by, except the model: an issue with no worker
   * attempt yet has no model to match, and reads `*` (its walk starts without the model), unless
   * the caller names the model it will run on.
   */
  readonly dimensions: CohortKey;
}

/**
 * A duration forecast for one issue in `set`: the cohort its key reads (exactly as the
 * listing resolves it), times its own current estimate. A floor-dominated class reads the
 * floor, not a ratio: the work is expected under {@link TIMING_FLOOR_SECONDS}, and no seconds
 * are multiplied from the minority that took longer. The cohort's warnings carry over.
 */
export function forecastDuration(set: EvidenceSet, subject: ForecastSubject, population: readonly CalibrationMember[]): DurationForecast {
  const cohort = resolveCohort(set, subject.dimensions, population);
  const estimate = subject.estimateSeconds !== null && subject.estimateSeconds > 0 ? subject.estimateSeconds : null;
  // The floor needs no estimate: the work is expected under the floor whatever was planned.
  const state: DurationForecast["state"] = cohort.floors.dominated ? "floor" : estimate === null ? "no_estimate" : cohort.samples === 0 ? "no_samples" : "ratio";
  const missing: Record<string, string> = {};
  if (state === "floor") missing.seconds = "floor_dominated";
  else if (state === "no_estimate") missing.seconds = "no_estimate";
  else if (state === "no_samples") missing.seconds = "no_samples";
  const scaled = state === "ratio" ? estimate! : null;
  const scale = (interval: OrderInterval): OrderInterval => ({ ...interval, lower: interval.lower * scaled!, upper: interval.upper * scaled! });
  return {
    set,
    identifier: subject.identifier,
    title: subject.title,
    status: subject.status,
    estimate: { seconds: estimate },
    key: subject.dimensions,
    cohort: { level: cohort.level, levelName: cohort.levelName, class: cohort.class, path: cohort.path, fallback: cohort.fallback, samples: cohort.samples, coverage: cohort.coverage },
    state,
    seconds: scaled === null ? null : (Object.fromEntries(Object.entries(cohort.ratio.quantiles!).map(([name, value]) => [name, value * scaled])) as Record<QuantileName, number>),
    bounds: scaled === null ? null : scale(cohort.ratio.bounds!),
    // A floor forecast still adds its bound along a path, so a sum never silently drops it.
    expected:
      state === "floor"
        ? { seconds: cohort.floors.seconds, ratio: null, method: "floor_bound" }
        : scaled === null
          ? null
          : { seconds: cohort.ratio.expected.value * scaled, ratio: cohort.ratio.expected.value, method: cohort.ratio.expected.method },
    heavyTail: cohort.tail.heavy,
    floors: { count: cohort.floors.count, share: cohort.floors.share, dominated: cohort.floors.dominated, seconds: cohort.floors.seconds },
    warnings: cohort.warnings,
    missing,
  };
}

/**
 * The snapshot id: SHA-256 over the algorithm, the repository, the selection (`since` as given), the
 * minimum and every member in id order. A sample contributes its figure, the estimate it divides
 * by (and the current one) and its dimensions; any other member contributes what keeps it out (its state and reasons)
 * and its dimensions, and not its figure, which for an unsettled record can move with `asOf`.
 */
export function snapshotId(input: {
  readonly repositoryId: string | null;
  readonly selection: { readonly kind: readonly string[] | null; readonly priority: readonly string[] | null; readonly parentId: string | null; readonly since: string | null; readonly include: readonly EvidenceSet[] };
  readonly members: readonly CalibrationMember[];
}): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([CALIBRATION_ALGORITHM, input.repositoryId, input.selection, MIN_COHORT_SAMPLES]));
  const members = [...input.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const member of members) {
    const set = input.selection.include.find((candidate) => isSample(member, candidate)) ?? null;
    const dims = DIMENSIONS.map((dimension) => member.dimensions[dimension]);
    const record =
      set === null
        ? [member.id, null, member.completedAt, member.evidence.state, member.evidence.reasons, dims]
        : [member.id, set, member.completedAt, member.evidence.state, member.evidence.reasons, dims, member.workSeconds, member.estimate.seconds, member.estimate.source, member.estimate.currentSeconds];
    hash.update("\n");
    hash.update(JSON.stringify(record));
  }
  return `${CALIBRATION_ALGORITHM.replace("/", "")}:${hash.digest("hex").slice(0, 32)}`;
}

/** The keyset of a cohort: its set, then its key. */
const cohortPosition = (cohort: CalibrationCohort): KeysetPosition => ({ at: cohort.set, id: keyString(cohort.key) });
/** The keyset of a sample: its set and resolution instant, then its issue's id (as cohort members are ordered). */
const samplePosition = (row: { readonly id: string; readonly sample: CalibrationSample }): KeysetPosition => ({
  at: `${row.sample.set}\u0000${row.sample.completedAt ?? ""}`,
  id: row.id,
});

/** The report over `members` (the ratio population in the filter). */
export function calibrationReport(input: {
  readonly asOf: string;
  readonly filter: CalibrationFilter;
  readonly repositoryId: string | null;
  readonly parentId: string | null;
  /** `since` as the caller gave it: what the snapshot id hashes (a resolved relative one moves with the clock). */
  readonly sinceGiven: string | null;
  readonly population: CalibrationReport["population"];
  readonly members: readonly CalibrationMember[];
  readonly list: "cohorts" | "samples";
  readonly after: KeysetPosition | null;
  readonly limit: number;
  readonly scope: unknown;
  /** The issues to forecast, in the order asked. */
  readonly forecast?: readonly ForecastSubject[];
}): CalibrationReport {
  const { filter, members } = input;
  const sets: CalibrationSetSummary[] = [];
  const cohorts: CalibrationCohort[] = [];
  /** Every sample with its issue's id, in listing order: by set, then as `byResolution` orders members. */
  const samples: Array<{ id: string; sample: CalibrationSample }> = [];
  for (const set of filter.include) {
    const own = members.filter((member) => isSample(member, set)).sort(byResolution);
    const keys = new Map<string, CohortKey>();
    for (const member of own) keys.set(keyString(member.dimensions), member.dimensions);
    for (const k of [...keys.keys()].sort()) cohorts.push(resolveCohort(set, keys.get(k)!, members));
    for (const member of own) samples.push({ id: member.id, sample: sampleOf(member, set) });
    sets.push({
      set,
      samples: own.length,
      coverage: coverageOf(own.length, members.length),
      excluded: excludedOf(members.filter((member) => !isSample(member, set))),
      cohorts: keys.size,
    });
  }
  const missing: Record<string, string> = {};
  if (members.length === 0) missing.items = "no_eligible_records";
  else if (samples.length === 0) missing.items = "no_samples";
  const snapshot = {
    id: snapshotId({
      repositoryId: input.repositoryId,
      selection: { kind: filter.kind, priority: filter.priority, parentId: input.parentId, since: input.sinceGiven, include: filter.include },
      members,
    }),
    algorithm: CALIBRATION_ALGORITHM,
    repositoryId: input.repositoryId,
    members: members.length,
    samples: Object.fromEntries(sets.map((summary) => [summary.set, summary.samples])),
  };
  const method = {
    minSamples: MIN_COHORT_SAMPLES,
    levels: LEVELS.map((level) => level.name),
    median: "lower" as const,
    estimate: "at_start_else_current" as const,
    quantile: "lower" as const,
    quantiles: QUANTILES.map((pct) => `p${pct}` as QuantileName),
    confidence: CONFIDENCE,
    intervals: "order_statistic" as const,
    minBoundsSamples: MIN_BOUNDS_SAMPLES,
    heavyTail: HEAVY_TAIL,
    floorSeconds: TIMING_FLOOR_SECONDS,
  };
  const forecasts = (input.forecast ?? []).flatMap((subject) => filter.include.map((set) => forecastDuration(set, subject, members)));
  const base = { asOf: input.asOf, filter, snapshot, method, population: input.population, sets, list: input.list, forecasts, missing };
  if (input.list === "samples") {
    const page = cutPage(
      samples.filter((row) => afterPosition(samplePosition(row), input.after)),
      input.limit,
      "calibration_samples",
      input.scope,
      samplePosition,
    );
    return { ...base, items: page.items.map((row) => row.sample), truncated: page.truncated, nextCursor: page.nextCursor };
  }
  const page = cutPage(
    cohorts.filter((cohort) => afterPosition(cohortPosition(cohort), input.after)),
    input.limit,
    "calibration_cohorts",
    input.scope,
    cohortPosition,
  );
  return { ...base, items: page.items, truncated: page.truncated, nextCursor: page.nextCursor };
}
