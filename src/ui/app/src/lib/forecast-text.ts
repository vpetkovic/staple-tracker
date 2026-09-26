/**
 * The words and the number formats of the forecast and calibration pages.
 *
 * ## Nothing here calculates
 *
 * Every figure on those pages is a field of `GET /api/forecast` or `GET /api/calibration`,
 * which are `staple forecast --json` and `staple calibrate --json` (docs/timing-semantics.md,
 * "Forecasts", "Confidence ranges"). This module turns a field into text: seconds into `3h10m`,
 * a probability into `12%`, a ratio into `×0.85`, a reason code into a sentence. It never adds,
 * divides or compares two figures, so the page cannot disagree with the CLI. The one rule it
 * enforces is the payload's own: a null figure is UNKNOWN, with its reason, and is never drawn
 * as 0.
 *
 * Pure and tested (forecast-text.test.ts), like detail/analytics.ts; the components are layout.
 */
// Relative, as detail/analytics.ts explains: a pure module stays resolvable without the alias.
import { QUALITY_LABEL, REASON_TEXT, formatDuration } from "../detail/analytics";
import type {
  BudgetLimitForecast,
  BudgetWorkProjection,
  CalibrationCohort,
  CalibrationCoverage,
  CompletionConfidence,
  OrderInterval,
  RemainingFigure,
  SimulatedSpread,
  UnitForecast,
} from "./types";

export { formatDuration };

/**
 * An EFFORT duration: hours past a day, never days. `formatDuration` writes 139 hours of work as
 * `5d19h`, which reads as calendar time; effort figures (labor, path, plan, bands, work medians)
 * are hours of work, so they say `139h`. Calendar figures (a reset countdown) keep days.
 */
export function formatEffort(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 86_400) return formatDuration(seconds);
  const s = Math.floor(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return minutes ? `${hours}h${minutes}m` : `${hours}h`;
}

// ------------------------------------------------------------------ number formats

/**
 * A probability (0..1) as a whole percent. The two ends are kept honest: a figure above 0 never
 * reads `0%` and one below 1 never reads `100%`, because "no chance" and "certain" are claims the
 * draws did not make.
 */
export function formatProbability(p: number): string {
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  const whole = Math.round(p * 100);
  if (whole === 0) return "<1%";
  if (whole === 100) return ">99%";
  return `${whole}%`;
}

/** A figure that is already in percent (a limit's remaining, a burn) as a whole percent. */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** An estimate ratio (work / estimate) as a multiplier: `×0.85`. */
export function formatRatio(ratio: number): string {
  return `×${ratio.toFixed(2)}`;
}

/** A 0..1 confidence as the percent it reaches: `75%`, `93.8%`. One decimal only when it matters. */
export function formatConfidence(confidence: number): string {
  const percent = confidence * 100;
  const rounded = Math.round(percent);
  return Math.abs(percent - rounded) < 0.05 ? `${rounded}%` : `${percent.toFixed(1)}%`;
}

/** `a–b`, with one formatter for both ends. */
export function formatRange(lower: number, upper: number, format: (value: number) => string): string {
  return `${format(lower)}–${format(upper)}`;
}

// ------------------------------------------------------------------ reason codes

/**
 * Warnings, calibration's and the forecast's (docs/timing-semantics.md, the two closed lists), as
 * a short chip label and a plain-language tooltip. An unknown code (a newer server) reads as
 * itself, never as nothing.
 */
export const WARNING_TEXT: Record<string, { label: string; tip: string }> = {
  small_sample: {
    label: "Few samples",
    tip: "Fewer than 5 samples in the class read, so not even the median's range reaches 90% confidence.",
  },
  bounds_below_confidence: {
    label: "Bounds under 90%",
    tip: "Fewer than 19 samples: the range where the next piece of work lands holds with less than 90% confidence.",
  },
  quantile_below_confidence: {
    label: "Quantiles under 90%",
    tip: "Some ratio quantile's interval reaches less than 90% confidence (p10 and p90 need 22 samples).",
  },
  fallback_used: {
    label: "Broader class",
    tip: "The exact combination of kind, priority, type, area and model had too few samples, so a broader class was read.",
  },
  heavy_tail: {
    label: "Heavy tail",
    tip: "A few runs took far longer than the rest. The expected figure is clipped at the outlier fences and reads low.",
  },
  floor_dominated: {
    label: "Mostly under a minute",
    tip: "More of this class's work finished under a minute than above it: the forecast reads the one-minute floor.",
  },
  floors_excluded: {
    label: "Short runs left out",
    tip: "Work under a minute is never a sample, so the samples leave the shortest work out and read long.",
  },
  reconstructed_only: {
    label: "Reconstructed",
    tip: "Backfilled history rebuilt from older records, not captured as it happened.",
  },
  no_samples: {
    label: "No samples",
    tip: "The class read has no sample at all, so nothing can be forecast from it.",
  },
  unknown_units: {
    label: "Unknown units",
    tip: "Some unit's remaining work is unknown, so the sums are lower bounds: the real figure can only be higher.",
  },
  beyond_class_range: {
    label: "Past every sample",
    tip: "A unit has been worked longer than every sample of its class, so its remaining work is unknown.",
  },
  overrun: {
    label: "Overrun",
    tip: "A unit's work has passed its calibrated expected duration; what is left is read from the longer samples.",
  },
  few_admissible: {
    label: "Few samples left",
    tip: "A unit in progress has fewer than 5 samples longer than its work so far, so its band is a handful of values.",
  },
  awaiting_review: {
    label: "In review",
    tip: "Units in review or waiting for approval weigh 0 as work. Their wait, and any rework, is not forecast.",
  },
  independent_draws: {
    label: "Independent draws",
    tip: "Units are drawn independently. Real overruns tend to come together, so the true band is wider.",
  },
  dependency_cycle: {
    label: "Dependency cycle",
    tip: "The units' dependencies held a cycle, which was broken to walk the path.",
  },
  unresolved_outside_blockers: {
    label: "Outside blocker",
    tip: "A unit waits on an open issue outside this subtree. That wait is not in the path, which is effort, not calendar time.",
  },
};

/**
 * The work rate's own warnings (`RateConfidence.warnings`, `BudgetOtherUse.confidence`). A
 * separate table because `small_sample` means spans or readings here, not cohort samples.
 */
export const RATE_WARNING_TEXT: Record<string, { label: string; tip: string }> = {
  small_sample: {
    label: "Few measurements",
    tip: "Fewer than 5 measured spans (or readings) behind this rate: a figure from one or two is a guess.",
  },
  lower_bound: {
    label: "Lower bound",
    tip: "Some span had no reading at its start, so its rise, and the rate, are at least this.",
  },
  sparse_readings: {
    label: "Sparse readings",
    tip: "Readings sit far from a span's edges, so part of its rise may belong to time outside it.",
  },
  shared_use: {
    label: "Shared account",
    tip: "Someone else used the account during every measured span, so the rate includes their use.",
  },
  concurrent_attempts: {
    label: "Concurrent attempts",
    tip: "Attempts that overlapped were merged into one span and share its rise.",
  },
};

export function warningText(code: string, table: Record<string, { label: string; tip: string }> = WARNING_TEXT): { label: string; tip: string } {
  return table[code] ?? { label: code.replace(/_/g, " "), tip: code };
}

/**
 * Why a figure is unknown: the reason codes of `missing` (the telemetry contract's closed set,
 * docs/execution-telemetry.md "Missingness", and the forecast's own) and of `missingInputs`.
 */
export const MISSING_TEXT: Record<string, string> = {
  unknown_units: "some units' remaining work is unknown",
  no_forecast: "no unit's remaining work is known",
  dependency_cycle: "a dependency cycle was broken to walk the path",
  not_forecast: "waits for a review or an approval are not work and are not forecast",
  no_samples: "no calibration samples to read",
  no_estimate: "no estimate to scale",
  beyond_class_range: "worked longer than every sample of its class",
  floor_dominated: "most of its class finished under a minute",
  input_missing: "an input is missing",
  stale: "the latest reading is over 10 minutes old",
  window_elapsed: "the window has already reset",
  no_sample_yet: "no reading yet",
  reset_not_reported: "the provider reports no reset time",
  sliding_window: "a sliding window has no single reset",
  source_unavailable: "this machine has no budget readings or bindings",
  no_eligible_records: "nothing eligible to calibrate from",
  // missingInputs
  attempt_burn: "no attempt of this workspace was measured on this account",
  work_rate: "no measured work rate",
  labor_seconds: "the remaining labor is unknown",
  window_seconds: "the window length is unknown",
  time_outside_attempts: "too little time measured outside the attempts",
  pace: "no pace for the window",
  second_reading: "only one reading so far",
};

export function missingText(code: string): string {
  return MISSING_TEXT[code] ?? code.replace(/_/g, " ");
}

/**
 * The reason a limit's `field` is null, from its `missing` code and, for `input_missing`, the
 * inputs it lacked. Null when the payload gave no reason (the caller then says "unknown" alone).
 */
export function limitMissingText(limit: Pick<BudgetLimitForecast, "missing" | "missingInputs">, field: string): string | null {
  const code = limit.missing[field];
  if (code === undefined) return null;
  const inputs = limit.missingInputs[field];
  if (code === "input_missing" && inputs && inputs.length > 0) return inputs.map(missingText).join("; ");
  return missingText(code);
}

// ------------------------------------------------------------------ completion

/**
 * A remaining figure (labor or path) as the page states it. `value` is null when the payload's is:
 * the reason goes in `absent`, never a 0. A `partial` figure is a lower bound and says so in
 * words, and its bands are lower bounds too.
 */
export interface RemainingText {
  /** The whole statement, `at least 1h39m` for a lower bound. */
  value: string | null;
  /** The duration alone, for the figure's typeface; the words around it are set apart. */
  figure: string | null;
  absent: string | null;
  lowerBound: boolean;
  /** `p10–p90 1h25m–2h10m`, or null without draws. */
  spread: string | null;
  /** `90% band 1h20m–2h30m`, or null without draws. */
  band: string | null;
}

export function remainingText(figure: RemainingFigure): RemainingText {
  const spread = figure.simulated ? spreadText(figure.simulated) : null;
  const band = figure.simulated ? bandText(figure.simulated) : null;
  if (figure.expectedSeconds === null) {
    const reasons = figure.missing.length > 0 ? figure.missing.map(missingText).join("; ") : "no reason given";
    return { value: null, figure: null, absent: `Unknown: ${reasons}`, lowerBound: figure.partial, spread, band };
  }
  const value = formatEffort(figure.expectedSeconds);
  return { value: figure.partial ? `at least ${value}` : value, figure: value, absent: null, lowerBound: figure.partial, spread, band };
}

/** `p10–p90 1h25m–2h10m`: the lower quantiles of the draws. */
export function spreadText(spread: SimulatedSpread): string {
  return `p10–p90 ${formatRange(spread.p10, spread.p90, formatEffort)}`;
}

/** `90% band 1h20m–2h30m`: the 5th to 95th percentile of the draws, at its nominal coverage. */
export function bandText(spread: SimulatedSpread): string {
  return `${formatConfidence(spread.band.nominal)} band ${formatRange(spread.band.lower, spread.band.upper, formatEffort)}`;
}

export const CONFIDENCE_LABEL: Record<CompletionConfidence["label"], string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

/**
 * The confidence line: the label, what the classes' bounds reach against the band's nominal, and
 * the reasons it is not high, in the payload's order.
 */
export function confidenceText(confidence: CompletionConfidence): { label: string; achieved: string; reasons: string[] } {
  const achieved =
    confidence.achieved === null
      ? "no unit drew from a class, so no bounds were reached"
      : confidence.reached
        ? `the classes' bounds reach the ${formatConfidence(confidence.nominal)} target`
        : `the classes' bounds reach ${formatConfidence(confidence.achieved)} of the ${formatConfidence(confidence.nominal)} target`;
  return { label: CONFIDENCE_LABEL[confidence.label], achieved, reasons: confidence.reasons.map((code) => warningText(code).label) };
}

/** A unit whose remaining work is unknown, and why: listed, never summed as 0. */
export function unknownUnitReason(unit: UnitForecast): string {
  const codes = Object.values(unit.missing);
  return codes.length > 0 ? codes.map(missingText).join("; ") : missingText(unit.state);
}

// ------------------------------------------------------------------ budget

/** A limit's remaining figure: `78% left`, or unknown with its reason. */
export function limitRemainingText(limit: BudgetLimitForecast): { value: string | null; absent: string | null } {
  if (limit.remainingPercent !== null) return { value: `${formatPercent(limit.remainingPercent)} left`, absent: null };
  const reason = limitMissingText(limit, "remainingPercent") ?? limit.quality.reasons.map(missingText).join("; ");
  return { value: null, absent: reason ? `Unknown: ${reason}` : "Unknown" };
}

/** The reset countdown as the server measured it at `asOf`: `resets in 3h58m`. */
export function resetText(limit: BudgetLimitForecast): string {
  if (limit.secondsToReset === null) {
    const reason = limitMissingText(limit, "secondsToReset") ?? limit.quality.reasons.map(missingText).join("; ");
    return reason ? `reset unknown: ${reason}` : "reset unknown";
  }
  return `resets in ${formatDuration(limit.secondsToReset)}`;
}

/** `The provisional 20% reserve` or `the 30% reserve`: whose reserve it is, always said. */
export function reserveLabel(reserve: { percent: number; source: string }): string {
  return reserve.source === "provisional_default" ? `the provisional ${formatPercent(reserve.percent)} reserve` : `the ${formatPercent(reserve.percent)} reserve`;
}

// ------------------------------------------------------------------ calibration

/** A cohort key as `task · high · type unknown · area unknown · model unknown`; `*` dimensions read "any". */
export function cohortKeyText(key: CalibrationCohort["key"]): string {
  const value = (v: string): string => (v === "*" ? "any" : v);
  return [value(key.kind), value(key.priority), `type ${value(key.workType)}`, `area ${value(key.area)}`, `model ${value(key.model)}`].join(" · ");
}

/** `7 of 10 eligible (70%)`, with the denominator named; no fraction reads as unknown. */
export function coverageText(coverage: CalibrationCoverage): string {
  const share = coverage.fraction === null ? "no eligible records" : formatProbabilityShare(coverage.fraction);
  return `${coverage.samples} of ${coverage.eligible} eligible (${share})`;
}

/** A coverage share: whole percent, one decimal under 10% so a thin share does not round to 0. */
function formatProbabilityShare(fraction: number): string {
  const percent = fraction * 100;
  return percent > 0 && percent < 10 ? `${percent.toFixed(1)}%` : `${Math.round(percent)}%`;
}

/** Which class a cohort read, and whether it fell back to get there. */
export function fallbackText(cohort: Pick<CalibrationCohort, "levelName" | "fallback" | "keySamples" | "samples">): string {
  if (cohort.fallback === "none") return `read at ${cohort.levelName}, its own key`;
  if (cohort.fallback === "below_minimum_everywhere") return `read at ${cohort.levelName}: under the minimum at every level`;
  return `fell back to ${cohort.levelName}: its key has ${cohort.keySamples} sample${cohort.keySamples === 1 ? "" : "s"}`;
}

/** An order-statistic interval of ratios with the confidence it reaches: `×0.50–×1.50 at 75%`. */
export function intervalText(interval: OrderInterval, format: (value: number) => string): string {
  return `${formatRange(interval.lower, interval.upper, format)} at ${formatConfidence(interval.confidence)}`;
}

// ------------------------------------------------------------------ which issues get one

/**
 * Which forecast the Analytics tab asks for. An open parent gets the full report (labor, path,
 * units, budget). An open leaf gets the compact one only when it has its own estimate: without one
 * its forecast is "unknown: no estimate", which the headline above already says as "No estimate".
 * A leaf in review or awaiting approval has handed its work over: there is nothing to forecast
 * about it, only a wait that is not work, so it gets one line saying so (`awaiting`) and no
 * request. A resolved issue has nothing left to forecast.
 */
export type ForecastMode = "full" | "compact" | "awaiting" | null;

export function forecastMode(input: { childCount: number; estimatedSeconds: number | null; category: string }): ForecastMode {
  if (input.category === "done" || input.category === "cancelled") return null;
  if (input.childCount > 0) return "full";
  if (input.category === "review" || input.category === "gated") return "awaiting";
  return input.estimatedSeconds !== null && input.estimatedSeconds > 0 ? "compact" : null;
}

// ------------------------------------------------------------------ budget projections

/**
 * What the work alone leaves at the reset. Under 0 the work alone runs the limit out before the
 * reset, which is said in words rather than as a negative percent. A lower-bound burn leaves at
 * most this much.
 */
export function leftAtResetText(expected: number, lowerBound: boolean): string {
  if (expected < 0) return "runs the limit out before the reset";
  return `leaves ${lowerBound ? "at most " : ""}${formatPercent(expected)} at the reset`;
}

/**
 * What the work alone does to a limit, as one sentence: what it uses (across about the draws'
 * median number of windows when it needs more than one window's worth) and what it leaves at the
 * reset.
 */
export function workUseText(work: Pick<BudgetWorkProjection, "consumedPercent" | "remainingAtResetPercent" | "windows" | "lowerBound">): string {
  const uses = `${work.lowerBound ? "uses at least" : "uses"} ${formatPercent(work.consumedPercent.expected)}`;
  const across = work.consumedPercent.expected > 100 ? ` across about ${work.windows.p50} windows` : "";
  return `The work alone ${uses}${across} and ${leftAtResetText(work.remainingAtResetPercent.expected, work.lowerBound)}`;
}

/**
 * A breach chance against `reserve` (its label), marked "at least" when the burn behind it is a
 * lower bound (it can only be higher). "At least 0%" is true and says nothing, so a lower-bound 0
 * says what the draws showed instead: none went under, from a burn that may be higher. `figure` is
 * null then, and `clause` is the whole statement.
 */
export function breachText(probability: number, lowerBound: boolean, reserve: string): { figure: string | null; clause: string } {
  if (lowerBound && probability <= 0) return { figure: null, clause: `no draw went under ${reserve} (the burn is a lower bound)` };
  return { figure: `${lowerBound ? "at least " : ""}${formatProbability(probability)}`, clause: `chance of going under ${reserve}` };
}

/** The instant a read was taken, as the local clock time a countdown is measured from: `as of 08:39`. */
export function asOfText(iso: string): string {
  return `as of ${new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

// ------------------------------------------------------------------ calibration sets

/** `3 reconstructed, 2 approximate`: the states a set leaves out, in words. */
export function excludedStatesText(counts: Partial<Record<string, number>>): string {
  return Object.entries(counts)
    .map(([state, count]) => `${count} ${QUALITY_LABEL[state] ?? state}`)
    .join(", ");
}

/** `3 rebuilt from history, 2 silences over 30 min`: the reasons behind them, in words. */
export function excludedReasonsText(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .map(([reason, count]) => `${count} ${REASON_TEXT[reason] ?? reason.replace(/_/g, " ")}`)
    .join(", ");
}
