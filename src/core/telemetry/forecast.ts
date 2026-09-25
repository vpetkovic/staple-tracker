/**
 * Completion forecasts (docs/timing-semantics.md, "Forecasts"): how much work is left on an
 * issue or a subtree, and how long its dependency chain still runs, from the calibrated
 * duration of each plan unit. `staple forecast` / MCP `forecast` / `GET /api/forecast`, one
 * store method; this module is pure, and the store hands it the rows.
 *
 * ## Units and what is left of each
 *
 * The units are the certified plan's (`plan-rollup.ts`): every unit once, never a parent's
 * estimate on top of its descendants'. Each is treated by its status category:
 *
 * - `done`: nothing is left. It weighs 0 and is left off the chain, as on the remaining path.
 * - `review` and `gated`: `awaiting_review`. The worker's work was handed over; what is left is
 *   the reviewer's or approver's wait, which is not work and is not forecast, and rework after
 *   a review is not forecast either. It weighs 0 like a done unit, and is counted and listed.
 * - anything else: `forecast`. Its calibrated duration (`forecastDuration`, the `exact` set:
 *   the cohort its key reads times its own estimate) minus the work already done on it.
 *
 * The EXPECTED figure of a forecast unit is `max(0, expected.seconds − workSeconds)`: the one
 * calibrated figure that adds, less what was already worked. A unit whose work already passed
 * its expected duration reads 0 there and says `overrun`. The DRAWS condition on the unit not
 * being done: each draw picks one of the class's sample ratios `r` with `r × estimate` above the
 * work so far, uniformly, and the unit has `r × estimate − work` left. A unit whose work passed
 * every sample of its class has no admissible ratio: `beyond_class_range`, unknown. A
 * floor-dominated class reads the floor bound (60 s) minus the work, with no spread. A unit with
 * no samples or no estimate is unknown. An unknown unit is never 0: a sum over it is partial and
 * a lower bound, and a path through it says so.
 *
 * ## Sums and paths
 *
 * LABOR is the sum of the units' remaining work. The PATH is the longest dependency chain of
 * remaining work through the plan's unit graph (`walkPlanGraph` with these weights): effort
 * along the chain, not calendar time, so waits for review, approval or a free agent are not in
 * it. Quantiles do not add, so the bands of a sum or a path come from resampling: every draw
 * draws every unit once (in the graph's walk order, from one seeded stream) and reads the sum
 * and the longest chain of that draw. The seed and the number of draws are fixed, so the same
 * data gives the same figures on every device.
 *
 * Draws are independent between units. Real overruns are correlated (one misjudged area runs
 * long on every ticket in it), so the bands of a sum are narrower than the truth can be; the
 * report says so in `method.caveats`. Resampling never draws outside a class's sample range,
 * so a band is no more trustworthy than the prediction bounds of the classes it drew from:
 * `confidence.achieved` is the lowest of those.
 */
import { createHash } from "node:crypto";
import { CALIBRATION_WARNINGS, CONFIDENCE, lowerQuantile, type CalibrationWarning, type CohortKey, type DurationForecast } from "./calibration.js";
import { PLAN_LIST_LIMIT, compareRefs, walkPlanGraph, type CrossSubtreeBlocker, type PathStep, type PlanGraph, type PlanLabor, type PlanNode } from "../plan-rollup.js";

/** Bumped whenever a rule here changes what a snapshot id covers, or what a forecast derives from the same data. */
export const FORECAST_ALGORITHM = "forecast/1";
/** The seed every forecast draws from. Fixed: the same data gives the same draws everywhere. */
export const FORECAST_SEED = 20260925;
/** Draws per forecast. At 2 000 a band's edge moves by well under a percent between seeds on the live tracker. */
export const FORECAST_DRAWS = 2000;
/** The band published: the 5th to 95th percentile of the draws, a 90% band under the draw model. */
export const BAND = { lower: 5, upper: 95, nominal: CONFIDENCE } as const;
/** The units a forecast lists; `units.truncated` says when more exist. */
export const UNIT_LIST_LIMIT = 50;
/** A rounding margin for "reaches the confidence". */
const EPSILON = 1e-12;

/**
 * Warnings of a completion forecast beyond the calibration ones its units carry, in this order:
 *
 * - `unknown_units`: some unit's remaining work is unknown (no samples, no estimate, or beyond
 *   its class); the sums and the path are lower bounds.
 * - `beyond_class_range`: a unit has already been worked longer than every sample of its class.
 * - `overrun`: a unit's work passed its expected duration; its expected remaining reads 0, and
 *   only its draws (conditioned on it not being done) say what may be left.
 * - `awaiting_review`: units in review or gated weigh 0; review waits and rework are not forecast.
 * - `dependency_cycle`: the unit graph held a cycle, broken to walk it.
 * - `unresolved_outside_blockers`: a unit waits on an open issue outside the subtree; the path
 *   does not include it.
 */
export const FORECAST_WARNINGS = ["unknown_units", "beyond_class_range", "overrun", "awaiting_review", "dependency_cycle", "unresolved_outside_blockers"] as const;
export type ForecastWarning = (typeof FORECAST_WARNINGS)[number];

/** The pseudo-random stream every draw reads: mulberry32, a 32-bit state, uniform on [0, 1). */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stream's seed: the forecast seed mixed with a label (FNV-1a), so one stream never shifts another. */
export function streamSeed(seed: number, label: string): number {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < label.length; i += 1) {
    hash ^= label.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The spread of a set of draws: the mean, the lower quantiles p10/p50/p90, and the 90% band. */
export interface SimulatedSpread {
  readonly mean: number;
  readonly p10: number;
  readonly p50: number;
  readonly p90: number;
  /** The 5th and 95th percentiles of the draws. */
  readonly band: { readonly lower: number; readonly upper: number; readonly nominal: number };
}

/** The spread of `values` (non-empty), by the lower-quantile rule calibration uses. */
export function spreadOfDraws(values: ArrayLike<number>): SimulatedSpread {
  const sorted = Array.from(values).sort((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    mean: sum / sorted.length,
    p10: lowerQuantile(sorted, 10),
    p50: lowerQuantile(sorted, 50),
    p90: lowerQuantile(sorted, 90),
    band: { lower: lowerQuantile(sorted, BAND.lower), upper: lowerQuantile(sorted, BAND.upper), nominal: BAND.nominal },
  };
}

export type UnitTreatment = "done" | "awaiting_review" | "forecast";

/** One plan unit, as the store supplies it. */
export interface ForecastUnitInput {
  readonly node: PlanNode;
  readonly title: string;
  /** Its status category; null for a status the workspace no longer defines. */
  readonly category: string | null;
  /** The work already done on it (`timing.workSeconds`); null reads as none yet. */
  readonly workSeconds: number | null;
  /** Its calibrated duration from the `exact` set; null for a done unit, which needs none. */
  readonly duration: DurationForecast | null;
  /** The sample ratios of the class `duration` read, ascending (`classRatios`). */
  readonly ratios: readonly number[];
}

/** One unit's remaining work. */
export interface UnitForecast {
  readonly ref: string;
  readonly title: string;
  readonly status: string;
  readonly treatment: UnitTreatment;
  readonly estimateSeconds: number | null;
  readonly workSeconds: number | null;
  /**
   * `done`, `awaiting_review`, the calibrated forecast's state (`ratio`, `floor`, `no_samples`,
   * `no_estimate`), or `beyond_class_range`.
   */
  readonly state: DurationForecast["state"] | "done" | "awaiting_review" | "beyond_class_range";
  /**
   * `durationSeconds`: the calibrated expected duration (or the floor bound); `remainingSeconds`:
   * `max(0, duration − work)`, the figure that adds. Null when the unit is unknown.
   */
  readonly expected: { readonly durationSeconds: number; readonly remainingSeconds: number; readonly method: string } | null;
  /** The draws of its remaining work; null for a unit with nothing left or nothing known. */
  readonly simulated: SimulatedSpread | null;
  /** The class its duration read; null for a done or awaiting-review unit. */
  readonly cohort: { readonly levelName: string; readonly class: CohortKey; readonly samples: number } | null;
  /** How many of the class's samples a draw could pick: those longer than the work so far. */
  readonly admissibleSamples: number | null;
  readonly overrun: boolean;
  readonly warnings: CalibrationWarning[];
  /** Why `expected` is null. */
  readonly missing: Record<string, string>;
}

/** A sum or path of remaining work. */
export interface RemainingFigure {
  /** The sum of the known units' expected remaining work; null when none is known. */
  readonly expectedSeconds: number | null;
  /** Some unit that counts is unknown (or a cycle was broken): the figure is a lower bound. */
  readonly partial: boolean;
  /** Why the figure is partial or null: `unknown_units`, `no_forecast`, `dependency_cycle`. */
  readonly missing: string[];
  /** The draws; null when no unit that counts is known. A partial sum's draws are lower bounds too. */
  readonly simulated: SimulatedSpread | null;
}

export interface CompletionPath extends RemainingFigure {
  /** The expected chain, first to last, at most `PATH_CHAIN_LIMIT` steps, each at its expected remaining work. */
  readonly chain: PathStep[];
  readonly chainLength: number;
  readonly edgeCount: number;
  readonly cycle: string[];
  readonly crossSubtreeBlockerCount: number;
  readonly unresolvedCrossSubtreeBlockerCount: number;
  /** Unresolved outside blockers first, at most `PLAN_LIST_LIMIT`. */
  readonly crossSubtreeBlockers: CrossSubtreeBlocker[];
}

export interface CompletionConfidence {
  /**
   * `high`: nothing unknown, every class's bounds reach 90%, no heavy tail. `medium`: nothing
   * unknown and every class has at least the minimum of samples. `low`: anything else.
   */
  readonly label: "high" | "medium" | "low";
  /** The band's nominal coverage under the draw model. */
  readonly nominal: number;
  /**
   * The lowest confidence the prediction bounds of the classes drawn from reach (capped at
   * `nominal`): resampling cannot do better than the classes it resamples. Null when no unit
   * drew from a class (all floors, or nothing left).
   */
  readonly achieved: number | null;
  readonly reached: boolean;
  /** Why the label is not `high`, in the order the warnings are listed. */
  readonly reasons: string[];
}

export interface CompletionForecast {
  /** The evidence set every unit's duration read. */
  readonly set: "exact";
  readonly units: {
    readonly total: number;
    readonly done: number;
    readonly awaitingReview: number;
    /** Units with work left to forecast. */
    readonly forecast: number;
    /** Of them, those whose remaining work is known. */
    readonly known: number;
    readonly unknownRefs: string[];
    readonly awaitingReviewRefs: string[];
    /** The units, by identifier, at most {@link UNIT_LIST_LIMIT}. */
    readonly items: UnitForecast[];
    readonly truncated: boolean;
  };
  /** The certified plan's labor, for reference: the estimates, not a forecast. */
  readonly plan: PlanLabor;
  /** Remaining LABOR: every unit's remaining work, added. */
  readonly labor: RemainingFigure;
  /** Remaining PATH: the longest dependency chain of remaining work. */
  readonly path: CompletionPath;
  readonly confidence: CompletionConfidence;
  /** Calibration warnings of the units that drew (in their order), then {@link FORECAST_WARNINGS}. */
  readonly warnings: Array<CalibrationWarning | ForecastWarning>;
  /** The labor draws, in draw order: what the budget forecast projects. Not published. */
  readonly laborDraws: Float64Array;
}

interface UnitPlan {
  readonly unit: UnitForecast;
  /** Draws its remaining work; null when it weighs a constant. */
  readonly draw: ((random: () => number) => number) | null;
  /** Its weight when `draw` is null (0 for done, awaiting review, floors known at a constant, and unknown units). */
  readonly constant: number;
  /** Its remaining work is known. */
  readonly known: boolean;
}

function planUnit(input: ForecastUnitInput): UnitPlan {
  const { node } = input;
  const base = {
    ref: node.identifier,
    title: input.title,
    status: node.status,
    estimateSeconds: node.estimatedSeconds,
    workSeconds: input.workSeconds,
  };
  if (node.done) {
    return {
      unit: { ...base, treatment: "done", state: "done", expected: null, simulated: null, cohort: null, admissibleSamples: null, overrun: false, warnings: [], missing: {} },
      draw: null,
      constant: 0,
      known: true,
    };
  }
  if (input.category === "review" || input.category === "gated") {
    return {
      unit: { ...base, treatment: "awaiting_review", state: "awaiting_review", expected: null, simulated: null, cohort: null, admissibleSamples: null, overrun: false, warnings: [], missing: {} },
      draw: null,
      constant: 0,
      known: true,
    };
  }
  const duration = input.duration!;
  const work = input.workSeconds ?? 0;
  const cohort = { levelName: duration.cohort.levelName, class: duration.cohort.class, samples: duration.cohort.samples };
  const common = { ...base, treatment: "forecast" as const, cohort, simulated: null, warnings: duration.warnings };
  if (duration.state === "floor") {
    const bound = duration.expected!.seconds;
    const remaining = Math.max(0, bound - work);
    return {
      unit: { ...common, state: "floor", expected: { durationSeconds: bound, remainingSeconds: remaining, method: "floor_bound" }, admissibleSamples: null, overrun: work >= bound, missing: {} },
      draw: null,
      constant: remaining,
      known: true,
    };
  }
  if (duration.state !== "ratio") {
    return {
      unit: { ...common, state: duration.state, expected: null, admissibleSamples: null, overrun: false, missing: { expected: duration.missing.seconds ?? duration.state } },
      draw: null,
      constant: 0,
      known: false,
    };
  }
  const estimate = duration.estimate.seconds!;
  // Conditioned on the unit not being done: only a sample longer than the work so far can be its duration.
  const admissible = input.ratios.filter((ratio) => ratio * estimate > work);
  if (admissible.length === 0) {
    return {
      unit: { ...common, state: "beyond_class_range", expected: null, admissibleSamples: 0, overrun: true, missing: { expected: "beyond_class_range" } },
      draw: null,
      constant: 0,
      known: false,
    };
  }
  const expectedDuration = duration.expected!.seconds;
  return {
    unit: {
      ...common,
      state: "ratio",
      expected: { durationSeconds: expectedDuration, remainingSeconds: Math.max(0, expectedDuration - work), method: duration.expected!.method },
      admissibleSamples: admissible.length,
      overrun: work > 0 && expectedDuration <= work,
      missing: {},
    },
    draw: (random) => admissible[Math.floor(random() * admissible.length)]! * estimate - work,
    constant: 0,
    known: true,
  };
}

/** The graph's nodes in dependency order (every predecessor first), from its cycle-free predecessor lists. */
function topologicalOrder(graph: PlanGraph): string[] {
  const out: string[] = [];
  const state = new Map<string, "open" | "done">();
  for (const start of graph.order) {
    if (state.has(start)) continue;
    const stack: Array<[string, number]> = [[start, 0]];
    state.set(start, "open");
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const preds = graph.predecessors.get(top[0]) ?? [];
      if (top[1] < preds.length) {
        const next = preds[top[1]++]!;
        if (!state.has(next)) {
          state.set(next, "open");
          stack.push([next, 0]);
        }
        continue;
      }
      state.set(top[0], "done");
      out.push(top[0]);
      stack.pop();
    }
  }
  return out;
}

/** The completion forecast of the subtree `graph` covers. `units` holds every unit of the graph. */
export function completionForecast(input: {
  readonly graph: PlanGraph;
  readonly units: ReadonlyMap<string, ForecastUnitInput>;
  readonly labor: PlanLabor;
  readonly outside: readonly CrossSubtreeBlocker[];
  readonly seed: number;
  readonly draws: number;
}): CompletionForecast {
  const { graph, labor, outside, draws } = input;
  const ordered = [...graph.units].sort((a, b) => compareRefs(a.identifier, b.identifier));
  const plans = new Map(ordered.map((node) => [node.id, planUnit(input.units.get(node.id)!)]));
  const forecastPlans = ordered.map((node) => plans.get(node.id)!).filter((plan) => plan.unit.treatment === "forecast");
  const known = forecastPlans.filter((plan) => plan.known);
  const unknown = forecastPlans.filter((plan) => !plan.known);

  // ---- the draws: every unit once per draw, in identifier order, from one stream
  const topo = topologicalOrder(graph);
  const index = new Map(topo.map((id, i) => [id, i]));
  const predecessorIndex = topo.map((id) => (graph.predecessors.get(id) ?? []).map((pred) => index.get(pred)!));
  const slotOf = new Map(ordered.map((node, slot) => [node.id, slot]));
  const unitSlot = topo.map((id) => slotOf.get(id) ?? -1);
  const random = seededRandom(streamSeed(input.seed, "completion"));
  const laborDraws = new Float64Array(draws);
  const pathDraws = new Float64Array(draws);
  const unitDraws = ordered.map((node) => (plans.get(node.id)!.draw === null ? null : new Float64Array(draws)));
  const weights = new Float64Array(ordered.length);
  const best = new Float64Array(topo.length);
  for (let d = 0; d < draws; d += 1) {
    let sum = 0;
    for (let u = 0; u < ordered.length; u += 1) {
      const plan = plans.get(ordered[u]!.id)!;
      const value = plan.draw === null ? plan.constant : plan.draw(random);
      weights[u] = value;
      sum += value;
      if (unitDraws[u] !== null) unitDraws[u]![d] = value;
    }
    let longest = 0;
    for (let n = 0; n < topo.length; n += 1) {
      let before = 0;
      for (const pred of predecessorIndex[n]!) if (best[pred]! > before) before = best[pred]!;
      best[n] = before + (unitSlot[n]! >= 0 ? weights[unitSlot[n]!]! : 0);
      if (best[n]! > longest) longest = best[n]!;
    }
    laborDraws[d] = sum;
    pathDraws[d] = longest;
  }

  // ---- the units, with their own spreads
  const items: UnitForecast[] = ordered.map((node, u) => {
    const plan = plans.get(node.id)!;
    return unitDraws[u] === null ? plan.unit : { ...plan.unit, simulated: spreadOfDraws(unitDraws[u]!) };
  });

  // ---- labor
  const nothingLeft = forecastPlans.length === 0;
  const laborMissing: string[] = [];
  if (!nothingLeft && known.length === 0) laborMissing.push("no_forecast");
  else if (unknown.length > 0) laborMissing.push("unknown_units");
  const laborFigure: RemainingFigure = {
    expectedSeconds: nothingLeft ? 0 : known.length === 0 ? null : known.reduce((sum, plan) => sum + (plan.unit.expected?.remainingSeconds ?? plan.constant), 0),
    partial: unknown.length > 0,
    missing: laborMissing,
    simulated: nothingLeft || known.length > 0 ? spreadOfDraws(laborDraws) : null,
  };

  // ---- the expected path: the plan's walk with remaining-work weights
  const walked = walkPlanGraph(
    graph,
    {
      weightOf: (unit) => {
        const plan = plans.get(unit.id)!;
        return plan.known ? (plan.unit.expected?.remainingSeconds ?? plan.constant) : null;
      },
      include: (unit) => plans.get(unit.id)!.unit.treatment === "forecast",
    },
    labor,
  );
  const sortedOutside = [...outside].sort((a, b) => Number(a.resolved) - Number(b.resolved) || compareRefs(a.blocked, b.blocked) || compareRefs(a.blocker, b.blocker));
  const unresolvedOutside = outside.filter((blocker) => !blocker.resolved).length;
  const pathFigure: CompletionPath = {
    expectedSeconds: walked.seconds,
    partial: walked.partial,
    missing: walked.missing.map((code) => (code === "no_plan" ? "no_forecast" : code === "unplanned_units" ? "unknown_units" : code)),
    simulated: walked.seconds === null ? null : spreadOfDraws(pathDraws),
    chain: walked.chain,
    chainLength: walked.chainLength,
    edgeCount: graph.edgeCount,
    cycle: [...graph.cycleUnits].map((id) => graph.unitById.get(id)!.identifier).sort(compareRefs),
    crossSubtreeBlockerCount: outside.length,
    unresolvedCrossSubtreeBlockerCount: unresolvedOutside,
    crossSubtreeBlockers: sortedOutside.slice(0, PLAN_LIST_LIMIT),
  };

  // ---- warnings and confidence
  const raised = new Set<string>();
  for (const plan of forecastPlans) for (const warning of plan.unit.warnings) raised.add(warning);
  if (unknown.length > 0) raised.add("unknown_units");
  if (forecastPlans.some((plan) => plan.unit.state === "beyond_class_range")) raised.add("beyond_class_range");
  if (forecastPlans.some((plan) => plan.unit.overrun && plan.unit.state !== "beyond_class_range")) raised.add("overrun");
  const awaiting = ordered.filter((node) => plans.get(node.id)!.unit.treatment === "awaiting_review");
  if (awaiting.length > 0) raised.add("awaiting_review");
  if (graph.cycleUnits.size > 0) raised.add("dependency_cycle");
  if (unresolvedOutside > 0) raised.add("unresolved_outside_blockers");
  const warnings = [...CALIBRATION_WARNINGS, ...FORECAST_WARNINGS].filter((code) => raised.has(code));

  const confidences = ordered
    .filter((node) => plans.get(node.id)!.draw !== null)
    .map((node) => input.units.get(node.id)!.duration!.bounds!.confidence);
  const achieved = confidences.length === 0 ? null : Math.min(BAND.nominal, ...confidences);
  const reached = achieved !== null && achieved >= BAND.nominal - EPSILON && unknown.length === 0;
  const reasons: string[] = [];
  if (unknown.length > 0) reasons.push("unknown_units");
  for (const code of ["small_sample", "no_samples", "bounds_below_confidence", "heavy_tail"] as const) if (raised.has(code)) reasons.push(code);
  if (!nothingLeft && achieved === null && unknown.length === 0) reasons.push("no_class_drawn");
  const low = unknown.length > 0 || raised.has("small_sample") || raised.has("no_samples") || (!nothingLeft && achieved === null);
  const label: CompletionConfidence["label"] = low ? "low" : reached && !raised.has("heavy_tail") ? "high" : "medium";

  const awaitingRefs = awaiting.map((node) => node.identifier);
  return {
    set: "exact",
    units: {
      total: ordered.length,
      done: ordered.filter((node) => plans.get(node.id)!.unit.treatment === "done").length,
      awaitingReview: awaiting.length,
      forecast: forecastPlans.length,
      known: known.length,
      unknownRefs: unknown.map((plan) => plan.unit.ref).slice(0, PLAN_LIST_LIMIT),
      awaitingReviewRefs: awaitingRefs.slice(0, PLAN_LIST_LIMIT),
      items: items.slice(0, UNIT_LIST_LIMIT),
      truncated: items.length > UNIT_LIST_LIMIT,
    },
    plan: labor,
    labor: laborFigure,
    path: pathFigure,
    confidence: { label, nominal: BAND.nominal, achieved, reached, reasons },
    warnings: warnings as Array<CalibrationWarning | ForecastWarning>,
    laborDraws,
  };
}

/**
 * The identity of what a completion forecast read: the calibration snapshot it drew its
 * classes from, the algorithm, the seed and the draws, and every unit's own inputs (status,
 * estimate, work so far, key) and the graph's edges, in id order. Replicated data only, so the
 * same data gives the same id on every device.
 */
export function completionSnapshotId(input: {
  readonly calibrationSnapshotId: string;
  readonly rootId: string;
  readonly seed: number;
  readonly draws: number;
  readonly units: ReadonlyMap<string, ForecastUnitInput>;
  readonly graph: PlanGraph;
  readonly outside: readonly CrossSubtreeBlocker[];
}): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([FORECAST_ALGORITHM, input.calibrationSnapshotId, input.rootId, input.seed, input.draws]));
  for (const id of [...input.units.keys()].sort()) {
    const unit = input.units.get(id)!;
    hash.update("\n");
    hash.update(
      JSON.stringify([id, unit.node.status, unit.category, unit.node.estimatedSeconds, unit.workSeconds, unit.duration === null ? null : unit.duration.key]),
    );
  }
  for (const id of [...input.graph.predecessors.keys()].sort()) {
    hash.update("\n");
    hash.update(JSON.stringify([id, input.graph.predecessors.get(id)]));
  }
  for (const blocker of [...input.outside].sort((a, b) => compareRefs(a.blocked, b.blocked) || compareRefs(a.blocker, b.blocker))) {
    hash.update("\n");
    hash.update(JSON.stringify([blocker.blocked, blocker.blocker, blocker.resolved]));
  }
  return `${FORECAST_ALGORITHM.replace("/", "")}:${hash.digest("hex").slice(0, 32)}`;
}
