/**
 * The forecast report: one issue's completion forecast and its budget forecast, side by side
 * and never blended (docs/timing-semantics.md, "Forecasts"). `staple forecast` / MCP
 * `forecast` / `GET /api/forecast` all return this shape from `WorkspaceStore.forecast`.
 */
import { MIN_COHORT_SAMPLES } from "./calibration.js";
import { BAND, FORECAST_DRAWS, FORECAST_SEED, type CompletionForecast } from "./forecast.js";
import { PROVISIONAL_RESERVE_PERCENT, RATE_ATTEMPT_LIMIT, type BudgetForecast } from "./forecast-budget.js";

/** How every forecast is made: the rules `forecast.ts` and `forecast-budget.ts` state, as data. */
export const FORECAST_METHOD = {
  set: "exact",
  minSamples: MIN_COHORT_SAMPLES,
  seed: FORECAST_SEED,
  draws: FORECAST_DRAWS,
  quantile: "lower",
  quantiles: ["p10", "p50", "p90"],
  band: BAND,
  remaining: {
    expected: "unworked: the calibrated expected duration; once work has started: the mean of the admissible remainders, E[D - w | D > w]",
    draws: "a class sample ratio longer than the work so far, uniformly, times the estimate, less the work",
    done: "0",
    awaitingReview: "0 as work, listed under review with its wait not forecast; the subtree is not settled and never high confidence",
    floor: "the 60s floor bound less the work, no spread",
    unknown: "no_samples, no_estimate or beyond_class_range: never 0; sums and paths turn partial",
  },
  labor: "the sum of every unit's remaining work",
  path: "the longest dependency chain of remaining work: effort along the chain, not calendar time",
  confidence: "achieved: the lowest prediction-bounds confidence of the classes drawn from, capped at the band's nominal",
  budget: {
    pace: "the current window's high-water rise per wall-clock hour, first reading to latest",
    workRate: "the window's high-water rise over the union of this workspace's worker attempt spans that started in it, per hour of their effortSeconds; concurrent attempts are one span; bootstrap over spans",
    otherUse: "the pace outside those spans",
    rateAttemptLimit: RATE_ATTEMPT_LIMIT,
    schedule: "the work runs serially from asOf, one work-hour per hour, into the windows after the reset at 100% each",
    breach: "the share of draws (labor draw x work-rate draw) that leave less than the reserve at the reset of any window the work runs in; the work alone, and with other use",
    provisionalReserve: PROVISIONAL_RESERVE_PERCENT,
  },
  caveats: [
    "units are drawn independently; correlated overruns make real bands wider than these",
    "resampling never draws outside a class's sample range",
    "a heavy-tailed class's expected figure is fence-clipped and reads low",
    "the work rate counts other use of the account during an attempt span as the attempts' own; other use outside the spans is measured apart",
    "a parallel fan-out puts more of the work before the reset than the serial schedule does",
  ],
} as const;

export interface ForecastReport {
  readonly asOf: string;
  readonly subject: {
    readonly ref: string;
    readonly title: string;
    readonly kind: string;
    readonly status: string;
    /** `unit`: the issue is its own single plan unit; `subtree`: its units are beneath it. */
    readonly scope: "unit" | "subtree";
  };
  readonly filter: { readonly model: string | null; readonly account: string | null };
  /** What the forecast read. */
  readonly snapshot: {
    /** The completion forecast's inputs: replicated data only, the same on every device. */
    readonly id: string;
    readonly algorithm: string;
    /** The calibration snapshot every unit's class was read from: `staple calibrate`'s unfiltered `snapshot.id`. */
    readonly calibration: { readonly id: string; readonly algorithm: string; readonly members: number; readonly samples: number };
    /** The budget data on THIS machine: its own id, since budget data never synchronizes. */
    readonly budget: { readonly id: string; readonly machineLocal: true };
  };
  readonly method: typeof FORECAST_METHOD;
  readonly completion: Omit<CompletionForecast, "laborDraws">;
  readonly budget: BudgetForecast;
}
