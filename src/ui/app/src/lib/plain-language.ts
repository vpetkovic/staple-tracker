/**
 * The plain-language layer of the forecast, budget and estimate-accuracy pages: the sentence a
 * non-technical reader sees first, and the one status word (On track / Tight / At risk / Unknown).
 *
 * ## Presentation, never arithmetic on meaning
 *
 * Every figure here is a field of `GET /api/forecast` or `GET /api/calibration` (the payloads of
 * `staple forecast --json` and `staple calibrate --json`). This module ROUNDS and PHRASES them:
 * 56 340 seconds of expected work reads "about 16 hours", a ratio of 0.083 reads "about 1/12 of
 * the estimate", a probability of 0.12 reads "12%". It never adds two figures, never derives a
 * new quantity, and never hides a caveat the payload states:
 *
 * - a lower bound (`partial`, `lowerBound`) always says "at least" (or "at most" for what is left);
 * - a null figure is "We can't tell yet", with the payload's reason in everyday words, never 0;
 * - a low confidence is said in words ("Rough guess"), never by colour alone.
 *
 * The exact figures stay on the page behind each card's "Show details", formatted by
 * lib/forecast-text.ts exactly as before, so an engineer or an agent loses nothing.
 *
 * The one judgement made here is the status word of a budget limit, and it lives in ONE function,
 * `limitStatus`, whose thresholds are named constants documented in docs/web-ui.md. Pure and tested
 * (plain-language.test.ts).
 */
// Relative, like forecast-text.ts: a pure module stays resolvable without the alias.
import { formatProbability, missingText, warningText } from "./forecast-text";
import type {
  BudgetLimitForecast,
  CalibrationCohort,
  CompletionConfidence,
  CompletionForecast,
  RemainingFigure,
} from "./types";

// ------------------------------------------------------------------ durations

/**
 * A duration, rounded the way a person says it. Rounding only, per band:
 *
 * - under a minute: "less than a minute";
 * - under 50 minutes: the nearest 5 minutes ("40 minutes"; never "0 minutes");
 * - under 10 hours: the nearest half hour ("1 hour", "8½ hours");
 * - under 100 hours: the nearest hour ("15 hours");
 * - from 100 hours: the nearest 5 hours ("140 hours").
 *
 * `number` and `unit` are split so a range can share its unit ("between 14 and 21 hours").
 */
export interface PlainDuration {
  readonly number: string;
  readonly unit: "minute" | "minutes" | "hour" | "hours" | null;
  /** The whole phrase: "8½ hours", "less than a minute". */
  readonly text: string;
}

export function plainDuration(seconds: number): PlainDuration {
  if (!Number.isFinite(seconds) || seconds < 60) return { number: "", unit: null, text: "less than a minute" };
  if (seconds < 3000) {
    const minutes = Math.max(5, Math.round(seconds / 300) * 5);
    return { number: String(minutes), unit: "minutes", text: `${minutes} minutes` };
  }
  let hours: string;
  if (seconds < 36_000) {
    const halves = Math.round(seconds / 1800);
    const whole = Math.floor(halves / 2);
    hours = halves % 2 === 0 ? String(whole) : whole === 0 ? "½" : `${whole}½`;
  } else if (seconds < 360_000) {
    hours = String(Math.round(seconds / 3600));
  } else {
    hours = String(Math.round(seconds / 18_000) * 5);
  }
  const unit = hours === "1" ? "hour" : "hours";
  return { number: hours, unit, text: `${hours} ${unit}` };
}

/**
 * "between 14 and 21 hours", "between 40 minutes and 2 hours", or, when both ends round to the
 * same words, "about 15 hours". The two ends are the payload's own; nothing is widened or moved.
 */
export function plainRange(lower: number, upper: number): string {
  const low = plainDuration(lower);
  const high = plainDuration(upper);
  if (low.text === high.text) return high.unit === null ? high.text : `about ${high.text}`;
  const sameUnit = low.unit !== null && high.unit !== null && low.unit.startsWith("hour") === high.unit.startsWith("hour");
  return sameUnit ? `between ${low.number} and ${high.text}` : `between ${low.text} and ${high.text}`;
}

/** A calendar countdown, as a clock would read it: "3h 56m", "4 days 1h", "25 minutes". */
export function plainCountdown(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 3600) {
    const minutes = Math.max(1, Math.round(s / 60));
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days === 0) return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
  const dayText = days === 1 ? "1 day" : `${days} days`;
  return hours ? `${dayText} ${hours}h` : dayText;
}

/** "1 task", "3 tasks". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

// ------------------------------------------------------------------ ratios

/**
 * An estimate ratio (work / estimate) in words. Rounding to the nearest everyday fraction or
 * multiple; the ratio itself is the payload's.
 *
 * - 0.9 to 1.1: "about as long as estimated";
 * - under 0.9: the nearest of 1/2 … 1/20, 2/3 and 3/4 (by ratio, so 0.083 is 1/12, not 1/10);
 *   halves to fifths in words ("half", "a third", "a quarter", "a fifth", "two thirds",
 *   "three quarters"), the rest as "1/12"; under 1/20 is "less than 1/20";
 * - over 1.1: the nearest half up to 3 ("1½ times", "twice", "2½ times"), then the nearest
 *   whole ("4 times").
 *
 * `sentence` completes "Tasks usually take …": "about a fifth of the estimate".
 */
export interface PlainRatio {
  readonly kind: "fraction" | "same" | "times";
  readonly words: string;
  readonly sentence: string;
}

const FRACTION_WORDS: Record<string, string> = {
  "1/2": "half",
  "1/3": "a third",
  "1/4": "a quarter",
  "1/5": "a fifth",
  "2/3": "two thirds",
  "3/4": "three quarters",
};

/** The same fractions as one glyph where Unicode has one, for a card's headline figure. */
export const FRACTION_GLYPH: Record<string, string> = {
  half: "½",
  "a third": "⅓",
  "a quarter": "¼",
  "a fifth": "⅕",
  "two thirds": "⅔",
  "three quarters": "¾",
};

const FRACTIONS: Array<{ name: string; value: number }> = [
  { name: "3/4", value: 3 / 4 },
  { name: "2/3", value: 2 / 3 },
  ...Array.from({ length: 19 }, (_, index) => ({ name: `1/${index + 2}`, value: 1 / (index + 2) })),
];

export function plainRatio(ratio: number): PlainRatio {
  if (ratio >= 0.9 && ratio <= 1.1) return { kind: "same", words: "as long as estimated", sentence: "about as long as estimated" };
  if (ratio < 0.9) {
    if (ratio < 1 / 20) return { kind: "fraction", words: "less than 1/20", sentence: "less than 1/20 of the estimate" };
    let best = FRACTIONS[0]!;
    for (const candidate of FRACTIONS) {
      if (Math.abs(Math.log(ratio / candidate.value)) < Math.abs(Math.log(ratio / best.value))) best = candidate;
    }
    const words = FRACTION_WORDS[best.name] ?? best.name;
    return { kind: "fraction", words, sentence: `about ${words} of the estimate` };
  }
  const rounded = ratio < 3.25 ? Math.round(ratio * 2) / 2 : Math.round(ratio);
  const whole = Math.floor(rounded);
  const words = rounded === 2 ? "twice" : rounded % 1 === 0 ? `${rounded} times` : `${whole}½ times`;
  return { kind: "times", words, sentence: `about ${words} as long as estimated` };
}

// ------------------------------------------------------------------ reasons

/**
 * Why a figure is unknown, in everyday words. The codes are the payload's `missing` and
 * `missingInputs` (docs/execution-telemetry.md "Missingness", docs/timing-semantics.md
 * "Forecasts"); an unlisted code falls back to forecast-text's wording, never to nothing.
 */
export const PLAIN_MISSING: Record<string, string> = {
  source_unavailable: "no usage has been measured on this machine",
  attempt_burn: "no usage has been measured for this project on this account yet",
  work_rate: "no usage has been measured for this project on this account yet",
  stale: "the last reading is more than 10 minutes old",
  window_elapsed: "the limit has reset since the last reading",
  reset_not_reported: "the provider doesn't say when this limit resets",
  sliding_window: "this limit has no fixed reset time",
  no_sample_yet: "nothing has been read yet",
  second_reading: "there is only one reading so far",
  labor_seconds: "how much work is left is unknown",
  unknown_units: "some tasks can't be estimated yet",
  no_forecast: "none of the remaining tasks can be estimated yet",
  no_samples: "there are no finished tasks to learn from yet",
  no_eligible_records: "there are no finished tasks with an estimate yet",
  no_estimate: "it has no estimate",
  beyond_class_range: "it has already run longer than any similar finished task",
  floor_dominated: "similar tasks mostly finished in under a minute",
  not_forecast: "time waiting for a review or an approval isn't work, so it isn't forecast",
  time_outside_attempts: "too little time has been measured outside this work",
  window_seconds: "the length of the limit's window is unknown",
  pace: "there is no measured pace for this window yet",
  dependency_cycle: "the tasks depend on each other in a loop",
  input_missing: "some information is missing",
};

export function plainMissing(code: string): string {
  return PLAIN_MISSING[code] ?? missingText(code);
}

/** Several reasons as one clause, each said once, in the payload's order. */
export function plainReasons(codes: readonly string[]): string {
  const said = [...new Set(codes.map(plainMissing))];
  return said.length > 0 ? said.join("; ") : "no reason was given";
}

/** Why a limit's `field` is null, in everyday words, from `missing` and, for `input_missing`, `missingInputs`. */
export function plainLimitReason(limit: Pick<BudgetLimitForecast, "missing" | "missingInputs" | "quality">, field: string): string {
  const code = limit.missing[field];
  if (code === undefined) return limit.quality.reasons.length > 0 ? plainReasons(limit.quality.reasons) : "no reason was given";
  const inputs = limit.missingInputs[field];
  if (code === "input_missing" && inputs && inputs.length > 0) return plainReasons(inputs);
  return plainMissing(code);
}

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

// ------------------------------------------------------------------ confidence

/** A confidence label in everyday words. */
export const CONFIDENCE_WORDS: Record<CompletionConfidence["label"], string> = {
  high: "Quite sure",
  medium: "Fairly sure",
  low: "Rough guess",
};

/**
 * Why the forecast is not "Quite sure", in everyday words. The codes are
 * `CompletionConfidence.reasons` (warning codes); a code without a phrase here falls back to its
 * chip label, so a newer server's reason still shows.
 */
const PLAIN_CONFIDENCE_REASON: Record<string, string> = {
  bounds_below_confidence: "there isn't enough history yet to be sure",
  quantile_below_confidence: "there isn't enough history yet to be sure",
  small_sample: "there isn't enough history yet to be sure",
  no_samples: "there are no finished tasks to learn from yet",
  unknown_units: "some tasks can't be estimated yet",
  awaiting_review: "time waiting for review isn't included",
  fallback_used: "some tasks are compared with a broader group of work",
  heavy_tail: "a few past tasks took much longer than the rest",
  beyond_class_range: "a task has already run longer than any similar one",
  overrun: "a task has run past its expected time",
  few_admissible: "few past tasks ran as long as one still in progress",
  floor_dominated: "similar tasks mostly finished in under a minute",
  floors_excluded: "very short tasks aren't counted",
  independent_draws: "tasks that overrun together aren't modelled",
  dependency_cycle: "the tasks depend on each other in a loop",
  unresolved_outside_blockers: "some tasks wait on work outside this one",
  reconstructed_only: "the history was rebuilt from older records",
};

export function plainConfidenceReasons(codes: readonly string[]): string[] {
  return [...new Set(codes.map((code) => PLAIN_CONFIDENCE_REASON[code] ?? warningText(code).label.toLowerCase()))];
}

/**
 * The confidence sentence: the word, what it rests on, and why it is not higher.
 * `samples` is `snapshot.calibration.samples`: the finished tasks with measured time the forecast
 * learned from.
 */
export function confidenceHeadline(confidence: CompletionConfidence, samples: number): string {
  const word = CONFIDENCE_WORDS[confidence.label];
  const basis =
    samples === 0 ? "there are no finished tasks with measured time to learn from yet" : `based on ${count(samples, "finished task")} with measured time`;
  const reasons = plainConfidenceReasons(confidence.reasons);
  return `${word}: ${basis}.${reasons.length > 0 ? ` Why not surer: ${reasons.join("; ")}.` : ""}`;
}

// ------------------------------------------------------------------ completion

/**
 * The first sentence of the forecast card, and the figure it leads with.
 *
 * - settled: every unit is done;
 * - unknown: "We can't tell yet how long this will take", with the payload's reasons;
 * - a lower bound (`partial`): "At least about X of work is left, and probably more", with how
 *   many tasks can't be estimated (`units.unknownRefs`, the full report's);
 * - otherwise: "about X", and "probably between A and B" from the draws' p10 and p90.
 *
 * `figure` is the rounded headline number ("15 hours"), or null when there is none.
 */
export interface Headline {
  readonly sentence: string;
  readonly figure: string | null;
}

export function forecastHeadline(completion: CompletionForecast, mode: "full" | "compact"): Headline {
  if (completion.settled) return { sentence: "Everything here is done: there is nothing left to forecast.", figure: null };
  const labor = completion.labor;
  if (labor.expectedSeconds === null) {
    return { sentence: `We can't tell yet how long ${mode === "full" ? "this" : "this task"} will take: ${plainReasons(labor.missing)}.`, figure: null };
  }
  const figure = plainDuration(labor.expectedSeconds).text;
  if (labor.partial) {
    const unknown = completion.units.unknownRefs.length;
    const why = unknown > 0 ? `${count(unknown, "task")} can't be estimated yet` : "part of it can't be estimated yet";
    return { sentence: `At least ${figure} of work is left, probably more: ${why}.`, figure: `at least ${figure}` };
  }
  const range = labor.simulated ? ` — probably ${plainRange(labor.simulated.p10, labor.simulated.p90)}` : "";
  if (mode === "compact") return { sentence: `About ${figure} of work is left on this task${range}.`, figure };
  return { sentence: `This should take about ${figure} of work${range}.`, figure };
}

/** The critical path's sentence: how much of the work has to happen one step after another. */
export function pathHeadline(path: RemainingFigure): Headline {
  if (path.expectedSeconds === null) {
    return { sentence: `We can't tell how much of it has to happen in order: ${plainReasons(path.missing)}.`, figure: null };
  }
  const figure = plainDuration(path.expectedSeconds).text;
  if (path.partial) return { sentence: `At least ${figure} of it has to happen one step after another.`, figure: `at least ${figure}` };
  return { sentence: `About ${figure} of it has to happen one step after another, however many people work on it.`, figure };
}

/** A leaf in review: its work was handed over; the wait is not work. */
export const AWAITING_HEADLINE = "This task is waiting for review, so there's no work left to forecast. Time spent waiting for a review isn't counted as work.";

// ------------------------------------------------------------------ the status word

export type PlainStatus = "on_track" | "tight" | "at_risk" | "unknown";

export const STATUS_WORDS: Record<PlainStatus, string> = {
  on_track: "On track",
  tight: "Tight",
  at_risk: "At risk",
  unknown: "Unknown",
};

/**
 * The thresholds of `limitStatus`, on the payload's own breach probability (the chance, over the
 * simulated draws, that the work alone takes the limit under its reserve before the work ends).
 * docs/web-ui.md states them.
 */
export const STATUS_THRESHOLDS = {
  /** From this chance of going under the reserve, a limit is Tight. */
  tight: 0.1,
  /** From this chance, it is At risk. */
  atRisk: 0.5,
} as const;

export type StatusReason = "no_reading" | "already_below" | "no_projection" | "runs_out" | "breach" | "lower_bound";

/**
 * THE status mapping of a budget limit. Reads only payload fields, in this order:
 *
 * 1. `remainingPercent` null → Unknown (`no_reading`).
 * 2. `reserve.alreadyBelow` → At risk (`already_below`).
 * 3. no `work`, no `reserve`, or a null `reserve.breachProbability` → Unknown (`no_projection`):
 *    what is left is known, what this work does to it is not.
 * 4. `work.remainingAtResetPercent.expected` under 0 (the work alone runs the limit out before
 *    the reset) → At risk (`runs_out`).
 * 5. The breach probability: from `STATUS_THRESHOLDS.atRisk` At risk, from
 *    `STATUS_THRESHOLDS.tight` Tight, below it On track (`breach`).
 * 6. A lower-bound burn (`work.lowerBound`: the real use can only be higher) moves that one step
 *    worse (On track → Tight, Tight → At risk; `lower_bound`), because "On track" would be a
 *    claim the data does not make.
 *
 * The work rate's confidence does not change the word; the sentence says "a rough guess" beside it.
 */
export function limitStatus(limit: BudgetLimitForecast): { status: PlainStatus; reason: StatusReason } {
  if (limit.remainingPercent === null) return { status: "unknown", reason: "no_reading" };
  if (limit.reserve?.alreadyBelow) return { status: "at_risk", reason: "already_below" };
  const work = limit.work;
  const probability = limit.reserve?.breachProbability ?? null;
  if (work === null || limit.reserve === null || probability === null) return { status: "unknown", reason: "no_projection" };
  if (work.remainingAtResetPercent.expected < 0) return { status: "at_risk", reason: "runs_out" };
  const base: PlainStatus = probability >= STATUS_THRESHOLDS.atRisk ? "at_risk" : probability >= STATUS_THRESHOLDS.tight ? "tight" : "on_track";
  if (!work.lowerBound) return { status: base, reason: "breach" };
  return { status: base === "on_track" ? "tight" : "at_risk", reason: "lower_bound" };
}

// ------------------------------------------------------------------ budget sentences

/** A limit's everyday name, from its window length when the provider reports one. */
export function limitName(limit: Pick<BudgetLimitForecast, "limitKey" | "windowSeconds">): string {
  const seconds = limit.windowSeconds;
  if (seconds !== null && seconds > 0) {
    if (seconds === 86_400) return "Daily limit";
    if (seconds === 604_800) return "Weekly limit";
    if (seconds % 86_400 === 0) return `${seconds / 86_400}-day limit`;
    if (seconds % 3600 === 0) return `${seconds / 3600}-hour limit`;
  }
  const named: Record<string, string> = { five_hour: "5-hour limit", seven_day: "Weekly limit", seven_day_opus: "Weekly Opus limit" };
  return named[limit.limitKey] ?? `${upperFirst(limit.limitKey.replace(/[._]/g, " "))} limit`;
}

/** "78% left" or null. What is left is the payload's `remainingPercent`, rounded. */
export function plainLeft(limit: BudgetLimitForecast): string | null {
  return limit.remainingPercent === null ? null : `${Math.round(limit.remainingPercent)}% left`;
}

/** The safety reserve, named once per card: "the 20% safety reserve". */
export function plainReserve(reserve: { percent: number }): string {
  return `the ${Math.round(reserve.percent)}% safety reserve`;
}

/**
 * The limit card's sentence: what is left, when it resets, and what this work does to it, with
 * the status's reason in words. `at least` / `at most` stay wherever the burn is a lower bound.
 */
export function limitHeadline(limit: BudgetLimitForecast): string {
  const parts = limitSentence(limit);
  return parts.opening === null ? parts.verdict : `${parts.opening} ${parts.verdict}`;
}

/**
 * `limitHeadline` in two parts, so a card that already shows "78% left" as its figure can say the
 * rest without repeating it: `opening` ("78% left, resets in 3h 56m.", null when nothing is known
 * to be left) and `verdict` (the status's reason in words, with the reset when there is an opening).
 */
export function limitSentence(limit: BudgetLimitForecast): { opening: string | null; reset: string | null; verdict: string } {
  const { status, reason } = limitStatus(limit);
  const left = plainLeft(limit);
  if (left === null) return { opening: null, reset: null, verdict: `We can't tell how much is left: ${plainLimitReason(limit, "remainingPercent")}.` };
  const reset = limit.secondsToReset !== null ? `Resets in ${plainCountdown(limit.secondsToReset)}.` : null;
  const opening = `${upperFirst(left)}${reset ? `, ${reset.charAt(0).toLowerCase()}${reset.slice(1, -1)}` : ""}.`;
  const reserve = limit.reserve;
  const rough = reserve?.confidence.label === "low" ? " (a rough guess: little usage measured so far)" : "";
  const chance = (probability: number, atLeast: boolean): string => `${atLeast ? "at least " : ""}${formatProbability(probability)} chance`;
  const verdict = ((): string => {
    switch (reason) {
      case "already_below":
        return `It's already below ${plainReserve(reserve!)}.`;
      case "no_projection":
        return `We can't tell yet what this work does to it: ${plainLimitReason(limit, limit.work === null ? "work" : "reserve")}.`;
      case "runs_out":
        return "This work alone would use it up before it resets.";
      case "breach": {
        const probability = reserve!.breachProbability!;
        if (status === "on_track") return `This work fits comfortably${rough}.`;
        if (status === "tight") return `This work might dip into ${plainReserve(reserve!)} (${chance(probability, false)})${rough}.`;
        return `This work will probably dip into ${plainReserve(reserve!)} (${chance(probability, false)})${rough}.`;
      }
      case "lower_bound": {
        const probability = reserve!.breachProbability!;
        if (status === "tight") return `This work should fit, but only part of it could be measured, so it may use more${rough}.`;
        return `This work might dip into ${plainReserve(reserve!)} (${chance(probability, true)}), and it may use more than we could measure${rough}.`;
      }
      default:
        return "";
    }
  })();
  return { opening, reset, verdict };
}

/**
 * The gauge's text alternative: every mark it draws, in words. `after` is
 * `work.remainingAtResetPercent.expected`; under 0 it says the work runs the limit out.
 */
export function gaugeDescription(limit: BudgetLimitForecast): string {
  const left = plainLeft(limit);
  if (left === null) return "No reading: how much is left is unknown.";
  const parts = [`${upperFirst(left)} now.`];
  const work = limit.work;
  if (work) {
    const uses = `${work.lowerBound ? "at least " : ""}${Math.round(work.consumedPercent.expected)}%`;
    const after = work.remainingAtResetPercent.expected;
    parts.push(
      after < 0
        ? `This work would use ${uses}, more than is left before it resets.`
        : `This work would use ${uses}, leaving ${work.lowerBound ? "at most " : "about "}${Math.round(after)}% when it resets.`,
    );
  } else {
    parts.push("What this work would use is unknown.");
  }
  if (limit.reserve) parts.push(`Safety reserve: ${Math.round(limit.reserve.percent)}%.`);
  return parts.join(" ");
}

// ------------------------------------------------------------------ estimate accuracy

/** A cohort key as a noun phrase: "Bug fixes, high priority"; `*` dimensions are left out. */
export function cohortName(key: CalibrationCohort["key"]): string {
  const kinds: Record<string, string> = { bug: "Bug fixes", task: "Tasks", epic: "Epics", feature: "Features", chore: "Chores", "*": "All work" };
  const kind = kinds[key.kind] ?? `${upperFirst(key.kind)}${key.kind.endsWith("s") ? "" : "s"}`;
  const known = (value: string): boolean => value !== "*" && value !== "unknown";
  const parts = [kind];
  if (known(key.priority)) parts.push(`${key.priority} priority`);
  if (known(key.workType)) parts.push(`type ${key.workType}`);
  if (known(key.area)) parts.push(`area ${key.area}`);
  if (known(key.model)) parts.push(`model ${key.model}`);
  return parts.join(", ");
}

/**
 * How sure a cohort's figure is, from its own fields only:
 *
 * - no samples, or no prediction bounds: Unknown;
 * - bounds under the 90% target, or `small_sample`: "Rough guess";
 * - some quantile's interval under the target: "Fairly sure";
 * - otherwise: "Quite sure".
 */
export function cohortConfidence(cohort: Pick<CalibrationCohort, "samples" | "ratio" | "warnings">): { word: string; note: string; level: "high" | "medium" | "low" | "unknown" } {
  if (cohort.samples === 0 || cohort.ratio.bounds === null) return { word: "Unknown", note: "not enough data to say", level: "unknown" };
  if (!cohort.ratio.bounds.reached || cohort.warnings.includes("small_sample")) return { word: "Rough guess", note: "not enough data to be sure", level: "low" };
  if (cohort.warnings.includes("quantile_below_confidence")) return { word: "Fairly sure", note: "more data would make it firmer", level: "medium" };
  return { word: "Quite sure", note: "enough data to rely on", level: "high" };
}

/** A cohort card's headline figure: "About ¾ of the estimate", "About 1/12 of the estimate", "About twice the estimate". */
export function ratioFigure(ratio: number): string {
  const plain = plainRatio(ratio);
  if (plain.kind === "same") return "About as estimated";
  if (plain.kind === "times") return `About ${plain.words} the estimate`;
  if (plain.words.startsWith("less than")) return "Under 1/20 of the estimate";
  return `About ${FRACTION_GLYPH[plain.words] ?? plain.words} of the estimate`;
}

/**
 * Two ratios as a range in words: "between 1/7 and 1/4 of the estimate", "between half the
 * estimate and twice the estimate", or "about a fifth of the estimate" when both round alike.
 */
export function plainRatioRange(lower: number, upper: number): string {
  const low = plainRatio(lower);
  const high = plainRatio(upper);
  const standalone = (ratio: PlainRatio): string =>
    ratio.kind === "same" ? "the full estimate" : ratio.kind === "fraction" ? `${ratio.words} of the estimate` : `${ratio.words} the estimate`;
  if (low.words === high.words) return low.sentence;
  if (low.kind === "fraction" && high.kind === "fraction") return `between ${low.words} and ${high.words} of the estimate`;
  return `between ${standalone(low)} and ${standalone(high)}`;
}

/** Where a cohort's figure comes from when its own group was too small. */
function fallbackPlain(cohort: Pick<CalibrationCohort, "fallback" | "levelName" | "key">): string | null {
  if (cohort.fallback === "none") return null;
  if (cohort.levelName === "all") return "Too few of these alone, so this uses all finished work.";
  if (cohort.levelName === "kind") return `Too few of these alone, so this uses all ${cohortName({ ...cohort.key, priority: "*", workType: "*", area: "*", model: "*" }).toLowerCase()}.`;
  return "Too few of these alone, so this uses a broader group of similar work.";
}

/**
 * The cohort card's sentences: "Bug fixes, high priority: usually take about 1/12 of the
 * estimate. Based on 13 finished tasks. Rough guess: not enough data to be sure."
 * The ratio phrased is `ratio.expected.value`, the one a forecast scales an estimate by.
 */
export function cohortSentence(cohort: CalibrationCohort): { answer: string; basis: string; confidence: string; fallback: string | null } {
  const name = cohortName(cohort.key);
  const confidence = cohortConfidence(cohort);
  return {
    answer: `${name}: usually take ${plainRatio(cohort.ratio.expected.value).sentence}.`,
    basis: `Based on ${count(cohort.samples, "finished task")}.`,
    confidence: `${confidence.word}: ${confidence.note}.`,
    fallback: fallbackPlain(cohort),
  };
}

/**
 * The page's opening answer: up to three cohorts in the payload's order, each as its ratio in
 * words ("Tasks, high priority usually take about a fifth of the estimate; bug fixes, high
 * priority about 1/12"), and how many more follow. No cohort is picked by a figure.
 */
export function accuracyHeadline(cohorts: readonly CalibrationCohort[]): string {
  if (cohorts.length === 0) return "We can't tell yet: there are no finished tasks with measured time to compare with their estimates.";
  const shown = cohorts.slice(0, 3).map((cohort, index) => {
    const ratio = plainRatio(cohort.ratio.expected.value);
    const name = index === 0 ? cohortName(cohort.key) : cohortName(cohort.key).toLowerCase();
    if (index === 0) return `${name} usually take ${ratio.sentence}`;
    return ratio.kind === "same" ? `${name} ${ratio.sentence}` : `${name} about ${ratio.words}`;
  });
  const more = cohorts.length > 3 ? `, and ${count(cohorts.length - 3, "more group")} below` : "";
  return `${shown.join("; ")}${more}.`;
}

// ------------------------------------------------------------------ visual geometry

/**
 * Where a value sits on a bar from 0 to `max`, as a percent of its width, clamped to the bar.
 * Geometry for drawing only: the value and `max` are the caller's payload figures.
 */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(100, Math.max(0, (value / max) * 100));
}

/** "8 in 10": a nominal coverage (0..1) as a count out of ten, for the bands' legend. */
export function inTen(nominal: number): string {
  const tens = Math.round(nominal * 10);
  return tens === 0 ? "under 1 in 10" : `${tens} in 10`;
}

/**
 * The likely-range bar's text alternative: the likely band (the draws' p10 to p90, 8 in 10), the
 * wider band (p5 to p95 at its nominal coverage) and the expected figure, with "at least" when
 * the figure is a lower bound.
 */
export function rangeDescription(figure: RemainingFigure): string | null {
  const spread = figure.simulated;
  if (!spread || figure.expectedSeconds === null) return null;
  const more = figure.partial ? ", or more" : "";
  return (
    `Likely ${plainRange(spread.p10, spread.p90)}${more} (8 in 10 chances). ` +
    `Very likely ${plainRange(spread.band.lower, spread.band.upper)}${more} (${inTen(spread.band.nominal)}). ` +
    `Expected: ${figure.partial ? "at least" : "about"} ${plainDuration(figure.expectedSeconds).text}.`
  );
}

/**
 * The estimate-accuracy bar's text alternative: how 8 in 10 past tasks compared with their
 * estimate (the ratio's p10–p90), where the next one lands (the prediction bounds, at the
 * confidence they reach, in tens), and the typical figure (`ratio.expected.value`).
 */
export function cohortRangeDescription(cohort: Pick<CalibrationCohort, "ratio">): string | null {
  const { quantiles, bounds, expected } = cohort.ratio;
  if (!quantiles || !bounds) return null;
  return (
    `8 in 10 past tasks took ${plainRatioRange(quantiles.p10, quantiles.p90)}. ` +
    `The next one will likely take ${plainRatioRange(bounds.lower, bounds.upper)} (about ${inTen(bounds.confidence)} chances). ` +
    `Typical: ${plainRatio(expected.value).sentence}. The dashed line is the estimate itself.`
  );
}
