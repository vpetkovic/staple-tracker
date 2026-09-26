/**
 * The plain-language layer of the forecast, budget and estimate-accuracy pages: the sentence a
 * non-technical reader sees first, and the one status word (On track / Tight / At risk / Unknown).
 *
 * ## Presentation, never arithmetic on meaning
 *
 * Every figure here is a field of `GET /api/forecast` or `GET /api/calibration` (the payloads of
 * `staple forecast --json` and `staple calibrate --json`). This module ROUNDS and PHRASES them:
 * 56 340 seconds of expected work reads "about 16 hours", a ratio of 0.083 reads "a 10-hour
 * estimate usually takes about 50 minutes", a probability of 0.12 reads "12%". It never derives a
 * new quantity, and never hides a caveat the payload states:
 *
 * - a lower bound (`partial`, `lowerBound`) always says "at least" (or "at most" for what is left);
 * - a null figure is "We can't tell yet", with the payload's reason in everyday words, never 0;
 * - a low confidence is said in words ("Rough guess"), never by colour alone;
 * - a cohort that fell back to a broader class is presented as THAT class, never as its own key.
 *
 * The exact figures stay on the page behind each card's "Show details", formatted by
 * lib/forecast-text.ts exactly as before, so an engineer or an agent loses nothing.
 *
 * The one judgement made here is the status word of a budget limit, and it lives in ONE function,
 * `limitStatus`, whose thresholds are named constants documented in docs/web-ui.md. Pure and tested
 * (plain-language.test.ts).
 */
// Relative, like forecast-text.ts: a pure module stays resolvable without the alias.
import { QUALITY_LABEL } from "../detail/analytics";
import { formatProbability, missingText, warningText } from "./forecast-text";
import type {
  BudgetLimitForecast,
  CalibrationCohort,
  CalibrationSetSummary,
  CompletionConfidence,
  CompletionForecast,
  RemainingFigure,
} from "./types";

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** "1 task", "3 tasks". */
export function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

// ------------------------------------------------------------------ durations

/**
 * A duration, rounded the way a person says it. Rounding only, per band:
 *
 * - under a minute: "less than a minute";
 * - under 5 minutes: "a few minutes";
 * - under 90 minutes: the nearest 5 minutes ("40 minutes", "55 minutes", "70 minutes"), so a
 *   typical figure never jumps from "50 minutes" to "1 hour";
 * - under 10 hours: the nearest half hour ("1½ hours", "8½ hours");
 * - under 100 hours: the nearest hour ("15 hours");
 * - from 100 hours: the nearest 5 hours ("140 hours").
 *
 * `number` and `unit` are split so a range can share its unit ("between 14 and 21 hours"); the
 * two phrases without a number have a null unit.
 */
export interface PlainDuration {
  readonly number: string;
  readonly unit: "minutes" | "hour" | "hours" | null;
  /** The whole phrase: "8½ hours", "a few minutes". */
  readonly text: string;
}

export function plainDuration(seconds: number): PlainDuration {
  if (!Number.isFinite(seconds) || seconds < 60) return { number: "", unit: null, text: "less than a minute" };
  if (seconds < 300) return { number: "", unit: null, text: "a few minutes" };
  if (seconds < 5400) {
    const minutes = Math.round(seconds / 300) * 5;
    return { number: String(minutes), unit: "minutes", text: `${minutes} minutes` };
  }
  let hours: string;
  if (seconds < 36_000) {
    const halves = Math.round(seconds / 1800);
    const whole = Math.floor(halves / 2);
    hours = halves % 2 === 0 ? String(whole) : `${whole}½`;
  } else if (seconds < 360_000) {
    hours = String(Math.round(seconds / 3600));
  } else {
    hours = String(Math.round(seconds / 18_000) * 5);
  }
  const unit = hours === "1" ? "hour" : "hours";
  return { number: hours, unit, text: `${hours} ${unit}` };
}

/**
 * "between 14 and 21 hours", "between 40 minutes and 2 hours", "up to about 1 hour" when the
 * lower end is under a minute, or, when both ends round to the same words, "about 15 hours". The two ends are the payload's own; nothing is widened or moved.
 */
export function plainRange(lower: number, upper: number): string {
  const low = plainDuration(lower);
  const high = plainDuration(upper);
  if (low.text === high.text) return high.unit === null ? high.text : `about ${high.text}`;
  // A range that starts under a minute is said by its upper end: "up to about 1 hour".
  if (lower < 60) return high.unit === null ? `up to ${high.text}` : `up to about ${high.text}`;
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

/** How old a reading is, short: "12 min", "3h", "2 days". */
export function plainAge(seconds: number): string {
  const s = Math.max(0, seconds);
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  const days = Math.round(s / 86_400);
  return days === 1 ? "1 day" : `${days} days`;
}

// ------------------------------------------------------------------ ratios

/**
 * An estimate ratio (work / estimate) in words. Rounding only; the ratio itself is the payload's.
 *
 * - 0.9 to 1.1: "about as long as estimated";
 * - 0.85 to 0.9: "a little less than estimated"; over 1.1 to 1.125: "a little longer than
 *   estimated" (so a 10% overrun is never hidden as "1 times");
 * - 0.18 up to 0.85: the nearest of half, a third, a quarter, a fifth, two thirds and three
 *   quarters (by ratio);
 * - under 0.18 (below a fifth): concretely, on a 10-hour estimate — "a 10-hour estimate usually
 *   takes about 50 minutes" — never "1/11" or "1/17";
 * - 1.125 to 1.5: the nearest quarter ("1¼ times", "1½ times"); from 1.5 the nearest half up to 3
 *   ("twice", "2½ times"), then the nearest whole ("4 times").
 */
export interface PlainRatio {
  readonly kind: "fraction" | "same" | "near" | "times" | "small";
  /** "a fifth", "1¼ times", "as long as estimated", or for `small` the duration ("50 minutes"). */
  readonly words: string;
  /** Completes "… usually take": "about a fifth of the estimate". Null for `small`, said as a whole clause. */
  readonly sentence: string | null;
}

/** The yardstick a small ratio is said on: a 10-hour estimate. */
const YARDSTICK_SECONDS = 36_000;
const SMALL_BELOW = 0.18;

const FRACTIONS: Array<{ words: string; glyph: string; value: number }> = [
  { words: "three quarters", glyph: "¾", value: 3 / 4 },
  { words: "two thirds", glyph: "⅔", value: 2 / 3 },
  { words: "half", glyph: "½", value: 1 / 2 },
  { words: "a third", glyph: "⅓", value: 1 / 3 },
  { words: "a quarter", glyph: "¼", value: 1 / 4 },
  { words: "a fifth", glyph: "⅕", value: 1 / 5 },
];

export function plainRatio(ratio: number): PlainRatio {
  if (ratio >= 0.9 && ratio <= 1.1) return { kind: "same", words: "as long as estimated", sentence: "about as long as estimated" };
  if (ratio >= 0.85 && ratio < 0.9) return { kind: "near", words: "a little less than estimated", sentence: "a little less than estimated" };
  if (ratio > 1.1 && ratio < 1.125) return { kind: "near", words: "a little longer than estimated", sentence: "a little longer than estimated" };
  if (ratio < SMALL_BELOW) {
    const words = plainDuration(ratio * YARDSTICK_SECONDS).text;
    return { kind: "small", words, sentence: null };
  }
  if (ratio < 1) {
    let best = FRACTIONS[0]!;
    for (const candidate of FRACTIONS) {
      if (Math.abs(Math.log(ratio / candidate.value)) < Math.abs(Math.log(ratio / best.value))) best = candidate;
    }
    return { kind: "fraction", words: best.words, sentence: `about ${best.words} of the estimate` };
  }
  let words: string;
  if (ratio < 1.5) {
    const quarters = Math.round(ratio * 4) / 4;
    words = quarters === 1.5 ? "1½ times" : "1¼ times";
  } else {
    const rounded = ratio < 3.25 ? Math.round(ratio * 2) / 2 : Math.round(ratio);
    words = rounded === 2 ? "twice" : rounded % 1 === 0 ? `${rounded} times` : `${Math.floor(rounded)}½ times`;
  }
  return { kind: "times", words, sentence: `about ${words} as long as estimated` };
}

/** "Bug fixes (high priority) usually take about a fifth of the estimate", or the concrete clause below a fifth. */
export function ratioClause(name: string, ratio: number): string {
  const plain = plainRatio(ratio);
  if (plain.kind === "small") return `${name}: a 10-hour estimate usually takes about ${plain.words}`;
  return `${name} usually take ${plain.sentence}`;
}

/** A card's headline figure: "About ¾ of the estimate", "About 50 minutes per 10 estimated hours", "About 1¼ times the estimate". */
export function ratioFigure(ratio: number): string {
  const plain = plainRatio(ratio);
  if (plain.kind === "same") return "About as estimated";
  if (plain.kind === "near") return upperFirst(plain.words);
  if (plain.kind === "small") return `About ${plain.words} per 10 estimated hours`;
  if (plain.kind === "times") return `About ${plain.words} the estimate`;
  const glyph = FRACTIONS.find((fraction) => fraction.words === plain.words)?.glyph ?? plain.words;
  return `About ${glyph} of the estimate`;
}

/**
 * Two ratios as a range in words. When either end is below a fifth, the range is said on the
 * 10-hour yardstick ("for a 10-hour estimate, between 30 minutes and 3 hours"); otherwise
 * "between a third and three quarters of the estimate", "between half the estimate and 1½ times
 * the estimate", or one phrase when both ends round alike.
 */
export function plainRatioRange(lower: number, upper: number): string {
  if (lower < SMALL_BELOW || upper < SMALL_BELOW) return `for a 10-hour estimate, ${plainRange(lower * YARDSTICK_SECONDS, upper * YARDSTICK_SECONDS)}`;
  const low = plainRatio(lower);
  const high = plainRatio(upper);
  const standalone = (ratio: PlainRatio): string =>
    ratio.kind === "same"
      ? "the full estimate"
      : ratio.kind === "near"
        ? ratio.words.replace(/estimated$/, "the estimate")
        : ratio.kind === "fraction"
          ? `${ratio.words} of the estimate`
          : `${ratio.words} the estimate`;
  if (low.words === high.words) return low.sentence ?? low.words;
  if (low.kind === "fraction" && high.kind === "fraction") return `between ${low.words} and ${high.words} of the estimate`;
  return `between ${standalone(low)} and ${standalone(high)}`;
}

// ------------------------------------------------------------------ reasons

/**
 * Why a figure is unknown, in everyday words. The codes are the payload's `missing` and
 * `missingInputs` (docs/execution-telemetry.md "Missingness", docs/timing-semantics.md
 * "Forecasts"); an unlisted code falls back to forecast-text's wording, never to nothing.
 */
export const PLAIN_MISSING: Record<string, string> = {
  source_unavailable: "no usage has been measured on this computer",
  attempt_burn: "no usage has been measured for this project on this account yet",
  work_rate: "no usage has been measured for this project on this account yet",
  stale: "the last reading is more than 10 minutes old",
  window_elapsed: "the limit has reset since the last reading",
  reset_not_reported: "the provider doesn't report when this limit resets",
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
 * chip label, so a newer server's reason still shows. `awaiting_review` is not a doubt about the
 * figure but something left out of it, so it is said under "Not counted", not here.
 */
const PLAIN_CONFIDENCE_REASON: Record<string, string> = {
  bounds_below_confidence: "there isn't enough history yet to be sure",
  quantile_below_confidence: "there isn't enough history yet to be sure",
  small_sample: "there isn't enough history yet to be sure",
  no_samples: "there are no finished tasks to learn from yet",
  unknown_units: "some tasks can't be estimated yet",
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

const NOT_A_DOUBT = new Set(["awaiting_review"]);

export function plainConfidenceReasons(codes: readonly string[]): string[] {
  return [...new Set(codes.filter((code) => !NOT_A_DOUBT.has(code)).map((code) => PLAIN_CONFIDENCE_REASON[code] ?? warningText(code).label.toLowerCase()))];
}

/**
 * The confidence sentence under the confidence word (which the card shows as its figure, so the
 * sentence does not repeat it): what it rests on, and why it is not surer. `samples` is
 * `snapshot.calibration.samples`: the finished tasks with measured time the forecast learned from.
 */
export function confidenceHeadline(confidence: CompletionConfidence, samples: number): string {
  const basis = samples === 0 ? "There are no finished tasks with measured time to learn from yet" : `Based on ${count(samples, "finished task")} with measured time`;
  const reasons = plainConfidenceReasons(confidence.reasons);
  return `${basis}.${reasons.length > 0 ? ` Why not surer: ${reasons.join("; ")}.` : ""}`;
}

// ------------------------------------------------------------------ completion

/**
 * The first sentence of the forecast card, and the figure it leads with. The likely range is said
 * once, by the range bar's legend (`rangeLegend`), not here.
 *
 * - settled: every unit is done;
 * - unknown: "We can't tell yet how long this will take", with the payload's reasons;
 * - a lower bound (`partial`): "At least X of work is left, probably more", with how many tasks
 *   can't be estimated (`units.unknownRefs`, the full report's);
 * - otherwise: "about X".
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
  if (mode === "compact") return { sentence: `About ${figure} of work is left on this task.`, figure };
  return { sentence: `This should take about ${figure} of work.`, figure };
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

/**
 * What is left out of the forecast, in words: tasks waiting for review (whose wait is not work)
 * and tasks that can't be estimated. Null when nothing is.
 */
export function notCountedText(awaiting: number, unknown: number): string | null {
  const parts: string[] = [];
  if (awaiting > 0) parts.push(`${count(awaiting, "task")} waiting for review (time waiting for review isn't work)`);
  if (unknown > 0) parts.push(`${count(unknown, "task")} that can't be estimated yet`);
  return parts.length > 0 ? `Not counted: ${parts.join(" and ")}.` : null;
}

/** A leaf in review: its work was handed over; the wait is not work. */
export const AWAITING_HEADLINE = "This task is waiting for review, so there's no work left to forecast. Time spent waiting for a review isn't counted as work.";

// ------------------------------------------------------------------ the range bar's words

/**
 * The range bar says ONE range: the draws' p10–p90, "Most likely between 14 and 19 hours (8 in 10
 * chances)", with "or more" on a lower bound. The 90% band is drawn as the pale edge; in words it
 * is only its upper end, "rarely beyond 20 hours", and only when that rounds to different words
 * than the likely range's upper end and the figure is not a lower bound (whose upper ends promise
 * nothing). The exact quantiles and band are under Show details.
 */
export interface RangeWords {
  readonly likely: string;
  readonly beyond: string | null;
  readonly expected: string;
  /** The text alternative: all of it in one sentence. */
  readonly description: string;
}

export function rangeWords(figure: RemainingFigure): RangeWords | null {
  const spread = figure.simulated;
  if (!spread || figure.expectedSeconds === null) return null;
  const more = figure.partial ? ", or more" : "";
  const likely = `Most likely ${plainRange(spread.p10, spread.p90)}${more} (8 in 10 chances)`;
  const upper = plainDuration(spread.band.upper).text;
  const beyond = !figure.partial && upper !== plainDuration(spread.p90).text ? `rarely beyond ${upper}` : null;
  const expected = `Expected: ${figure.partial ? "at least" : "about"} ${plainDuration(figure.expectedSeconds).text}`;
  const description = `${likely}${beyond ? `; ${beyond}` : ""}. ${expected}${figure.partial ? "; the real figure can only be higher" : ""}.`;
  return { likely, beyond, expected, description };
}

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
 * simulated draws, that the work takes the limit under its reserve before the work ends).
 * docs/web-ui.md states them.
 */
export const STATUS_THRESHOLDS = {
  /** From this chance of going under the reserve, a limit is Tight. */
  tight: 0.1,
  /** From this chance, it is At risk. */
  atRisk: 0.5,
} as const;

export type StatusReason = "no_reading" | "already_below" | "no_projection" | "pace_unknown_work" | "runs_out" | "breach" | "other_use" | "lower_bound" | "pace";

const RANK: Record<PlainStatus, number> = { unknown: -1, on_track: 0, tight: 1, at_risk: 2 };
const byRank = (rank: number): PlainStatus => (rank >= 2 ? "at_risk" : rank === 1 ? "tight" : "on_track");
const fromProbability = (probability: number): PlainStatus =>
  probability >= STATUS_THRESHOLDS.atRisk ? "at_risk" : probability >= STATUS_THRESHOLDS.tight ? "tight" : "on_track";

/**
 * THE status mapping of a budget limit. Reads only payload fields, in this order:
 *
 * 1. `remainingPercent` null → Unknown (`no_reading`).
 * 2. `reserve.alreadyBelow` → At risk (`already_below`).
 * 3. no `work`, no `reserve`, or a null `reserve.breachProbability` → Unknown (`no_projection`):
 *    what is left is known, what this work does to it is not — unless the account's own pace runs
 *    the limit out before the reset (`exhaustion.atPace === "before_reset"`), which is Tight
 *    whatever the work adds (`pace_unknown_work`).
 * 4. `work.remainingAtResetPercent.expected` under 0 (the work alone runs the limit out before
 *    the reset) → At risk (`runs_out`).
 * 5. The breach probability — the WORSE of the work alone and, when the payload has it, the work
 *    with the account's other use (`reserve.withOtherUse.breachProbability`): from
 *    `STATUS_THRESHOLDS.atRisk` At risk, from `STATUS_THRESHOLDS.tight` Tight, below it On track
 *    (`breach`, or `other_use` when the other use is what made it worse).
 * 6. A lower-bound burn (`work.lowerBound`: the real use can only be higher) moves that one step
 *    worse (On track → Tight, Tight → At risk; `lower_bound`), because "On track" would be a
 *    claim the data does not make.
 * 7. When the account's own pace runs the limit out before the reset
 *    (`exhaustion.atPace === "before_reset"`), the result is at least Tight (`pace`).
 *
 * The work rate's confidence does not change the word; the sentence says "a rough guess" beside it.
 */
export function limitStatus(limit: BudgetLimitForecast): { status: PlainStatus; reason: StatusReason } {
  if (limit.remainingPercent === null) return { status: "unknown", reason: "no_reading" };
  if (limit.reserve?.alreadyBelow) return { status: "at_risk", reason: "already_below" };
  const work = limit.work;
  const alone = limit.reserve?.breachProbability ?? null;
  if (work === null || limit.reserve === null || alone === null) {
    // What this work adds is unknown, but the account's own pace already runs the limit out.
    if (limit.exhaustion?.atPace === "before_reset") return { status: "tight", reason: "pace_unknown_work" };
    return { status: "unknown", reason: "no_projection" };
  }
  if (work.remainingAtResetPercent.expected < 0) return { status: "at_risk", reason: "runs_out" };
  const other = limit.reserve.withOtherUse?.breachProbability ?? null;
  let status = fromProbability(alone);
  let reason: StatusReason = "breach";
  if (other !== null && RANK[fromProbability(other)] > RANK[status]) {
    status = fromProbability(other);
    reason = "other_use";
  }
  if (work.lowerBound) {
    status = byRank(RANK[status] + 1);
    reason = "lower_bound";
  }
  if (limit.exhaustion?.atPace === "before_reset" && RANK[status] < RANK.tight) {
    status = "tight";
    reason = "pace";
  }
  return { status, reason };
}

// ------------------------------------------------------------------ budget sentences

/** A provider's everyday name. */
const PROVIDER_NAME: Record<string, { name: string; short: string }> = {
  anthropic: { name: "Claude (Anthropic)", short: "Claude" },
  openai: { name: "Codex (OpenAI)", short: "Codex" },
};

/** "Claude (Anthropic)", "Codex (OpenAI)", else the provider or the account's own label. */
export function providerName(provider: string | null, accountRef: string): { name: string; short: string } {
  if (provider && PROVIDER_NAME[provider]) return PROVIDER_NAME[provider]!;
  if (provider) return { name: upperFirst(provider), short: upperFirst(provider) };
  return { name: accountRef, short: accountRef };
}

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

/** The card's figure: "78% left", and for a stale reading its age, "93% left · 12 min ago". */
export function leftFigure(limit: BudgetLimitForecast): string | null {
  const left = plainLeft(limit);
  if (left === null) return null;
  return limit.stale === true && limit.readingAgeSeconds !== null ? `${left} · ${plainAge(limit.readingAgeSeconds)} ago` : left;
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
 * to be left), `reset` ("Resets in 3h 56m.") and `verdict` (the status's reason in words).
 */
export function limitSentence(limit: BudgetLimitForecast): { opening: string | null; reset: string | null; verdict: string } {
  const { status, reason } = limitStatus(limit);
  const left = plainLeft(limit);
  if (left === null) return { opening: null, reset: null, verdict: `We can't read this limit yet: ${plainLimitReason(limit, "remainingPercent")}.` };
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
      case "pace_unknown_work":
        return "At the account's current pace this limit runs out before it resets; what this work adds is unknown.";
      case "runs_out":
        return "This work alone would use it up before it resets.";
      case "breach": {
        const probability = reserve!.breachProbability!;
        if (status === "on_track") return `This work fits comfortably${rough}.`;
        if (status === "tight") return `This work might dip into ${plainReserve(reserve!)} (${chance(probability, false)})${rough}.`;
        return `This work will probably dip into ${plainReserve(reserve!)} (${chance(probability, false)})${rough}.`;
      }
      case "other_use": {
        const probability = reserve!.withOtherUse!.breachProbability!;
        const verb = status === "tight" ? "might" : "will probably";
        return `Counting other use of this account, this work ${verb} dip into ${plainReserve(reserve!)} (${chance(probability, false)})${rough}.`;
      }
      case "lower_bound": {
        if (status === "tight") return `Probably fits, but we could only measure part of this work, so it may need more${rough}.`;
        const worse = Math.max(reserve!.breachProbability!, reserve!.withOtherUse?.breachProbability ?? 0);
        return `This work might dip into ${plainReserve(reserve!)} (${chance(worse, true)}), and it may need more than we could measure${rough}.`;
      }
      case "pace":
        return `This work fits, but at the account's current pace this limit runs out before it resets${rough}.`;
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

/** "What does this mean?" for a limit card: it describes only the marks the gauge actually draws. */
export function limitHelp(limit: BudgetLimitForecast): string {
  const lines = ["A subscription allows a certain amount of use in each window, then resets."];
  if (limit.remainingPercent === null) return `${lines[0]} We have no current reading of this limit, so there is nothing to draw.`;
  const marks = ["the blue part is what is left"];
  if (limit.work) marks.push("the stripes are what this work is expected to use");
  marks.push("the grey part is already used");
  lines.push(`The bar is the whole allowance: ${marks.join(", ")}.`);
  if (limit.reserve) lines.push("The dashed line is the safety reserve we try not to dip into, so there is always room to finish or pause cleanly.");
  if (limit.stale === true) lines.push("The reading is not recent, so the figure may have moved since.");
  return lines.join(" ");
}

/**
 * The one line for an account's limits that can't be read at all (`remainingPercent` null):
 * "2 other Codex limits can't be read yet: the provider doesn't report them." Their reasons are
 * the payload's `missing.remainingPercent`, said once each.
 */
const UNREADABLE_REASON: Record<string, [one: string, many: string]> = {
  reset_not_reported: ["the provider doesn't say when it resets", "the provider doesn't say when they reset"],
  window_elapsed: ["it has reset since the last reading", "they have reset since the last reading"],
  no_sample_yet: ["nothing has been read yet", "nothing has been read yet"],
  sliding_window: ["it has no fixed reset time", "they have no fixed reset time"],
  source_unavailable: ["no usage has been measured on this computer", "no usage has been measured on this computer"],
};

export function unreadableLine(limits: readonly BudgetLimitForecast[], short: string, others: boolean): string | null {
  if (limits.length === 0) return null;
  const many = limits.length > 1;
  const codes = [...new Set(limits.map((limit) => limit.missing.remainingPercent ?? limit.quality.reasons[0] ?? "no_sample_yet"))];
  const reasons = codes.map((code) => UNREADABLE_REASON[code]?.[many ? 1 : 0] ?? plainMissing(code));
  const noun = `${others ? "other " : ""}${short} limit`;
  return `${count(limits.length, noun)} can't be read yet: ${reasons.join("; ")}.`;
}

// ------------------------------------------------------------------ estimate accuracy

const KIND_NAMES: Record<string, string> = { bug: "Bug fixes", task: "Tasks", epic: "Epics", feature: "Features", chore: "Chores", spike: "Spikes" };
const known = (value: string): boolean => value !== "*" && value !== "unknown";

/** A cohort key as a noun phrase: "Bug fixes (high priority)"; dimensions nobody recorded are left out. */
export function cohortName(key: CalibrationCohort["key"]): string {
  if (key.kind === "*") return "All finished work";
  const kind = KIND_NAMES[key.kind] ?? `${upperFirst(key.kind)}${key.kind.endsWith("s") ? "" : "s"}`;
  const rest: string[] = [];
  if (known(key.priority)) rest.push(`${key.priority} priority`);
  if (known(key.workType)) rest.push(`type ${key.workType}`);
  if (known(key.area)) rest.push(`area ${key.area}`);
  if (known(key.model)) rest.push(`model ${key.model}`);
  return rest.length > 0 ? `${kind} (${rest.join(", ")})` : kind;
}

/** A class a cohort fell back to, named as the group it is: "All finished work", "All bug fixes". */
export function className(key: CalibrationCohort["class"]): string {
  if (key.kind === "*") return "All finished work";
  const name = cohortName(key);
  return `All ${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}

/**
 * How sure a cohort's figure is, from its own fields only:
 *
 * - no samples, or no prediction bounds: Unknown;
 * - bounds under the 90% target, or `small_sample`: "Rough guess";
 * - some quantile's interval under the target: "Fairly sure";
 * - otherwise: "Quite sure".
 */
export type ConfidenceLevel = "high" | "medium" | "low" | "unknown";

export function cohortConfidence(cohort: Pick<CalibrationCohort, "samples" | "ratio" | "warnings">): { word: string; note: string; level: ConfidenceLevel } {
  if (cohort.samples === 0 || cohort.ratio.bounds === null) return { word: "Unknown", note: "not enough data to say", level: "unknown" };
  if (!cohort.ratio.bounds.reached || cohort.warnings.includes("small_sample")) return { word: "Rough guess", note: "not enough data to be sure", level: "low" };
  if (cohort.warnings.includes("quantile_below_confidence")) return { word: "Fairly sure", note: "more data would make it firmer", level: "medium" };
  return { word: "Quite sure", note: "enough data to rely on", level: "high" };
}

/**
 * The cards of a set: a cohort that read its own key is its own card; cohorts that FELL BACK are
 * grouped under ONE card per class they fell back to, named for that class, since the figure is
 * the class's and not theirs. Own cards first in the payload's order, then the class groups in
 * the order their first member appears.
 */
export type AccuracyGroup =
  | { readonly kind: "own"; readonly cohort: CalibrationCohort }
  | { readonly kind: "class"; readonly name: string; readonly figure: CalibrationCohort; readonly members: CalibrationCohort[] };

export function accuracyGroups(cohorts: readonly CalibrationCohort[]): AccuracyGroup[] {
  const own: AccuracyGroup[] = [];
  const classes = new Map<string, { name: string; figure: CalibrationCohort; members: CalibrationCohort[] }>();
  for (const cohort of cohorts) {
    if (cohort.fallback === "none") {
      own.push({ kind: "own", cohort });
      continue;
    }
    // The set is part of the key: an exact and a reconstructed class are never one group.
    const key = `${cohort.set}:${JSON.stringify(cohort.class)}`;
    const group = classes.get(key) ?? { name: className(cohort.class), figure: cohort, members: [] };
    group.members.push(cohort);
    classes.set(key, group);
  }
  return [...own, ...[...classes.values()].map((group) => ({ kind: "class" as const, ...group }))];
}

/**
 * A fallback group's confidence comes from the members' own counts, which are under the minimum
 * by definition: always "Rough guess", never "Quite sure", however many the broader class holds.
 */
export const FALLBACK_CONFIDENCE = { word: "Rough guess", level: "low" as const };

/**
 * A class's clause: "All finished work usually takes …" (a mass noun, `*` kind) but "All bug fixes
 * usually take …" (a plural).
 */
function classClause(name: string, figure: CalibrationCohort): string {
  const clause = ratioClause(name, figure.ratio.expected.value);
  return figure.class.kind === "*" ? clause.replace(/ usually take /, " usually takes ") : clause;
}

/**
 * The card's sentences. An own cohort: "Bug fixes (high priority) usually take about a fifth of
 * the estimate. Based on 13 finished tasks. Rough guess: not enough data to be sure." A class
 * group: "All finished work usually takes …. Based on 9 finished tasks." and, per member, "Bug
 * fixes (high priority): too few of their own (1)", the own count being the fallback path's first
 * level. The ratio phrased is `ratio.expected.value`, the one a forecast scales an estimate by.
 */
export function groupSentence(group: AccuracyGroup): { answer: string; basis: string; confidence: string; alsoFor: string[] } {
  if (group.kind === "own") {
    const { cohort } = group;
    const confidence = cohortConfidence(cohort);
    return {
      answer: `${ratioClause(cohortName(cohort.key), cohort.ratio.expected.value)}.`,
      basis: `Based on ${count(cohort.samples, "finished task")}.`,
      confidence: `${confidence.word}: ${confidence.note}.`,
      alsoFor: [],
    };
  }
  const answer = classClause(group.name, group.figure);
  const lower = (text: string): string => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  const own = (member: CalibrationCohort): number => member.path[0]?.samples ?? member.keySamples;
  const standsIn = `${lower(group.name)} ${group.figure.class.kind === "*" ? "stands" : "stand"} in`;
  const confidence =
    group.members.length === 1
      ? `${FALLBACK_CONFIDENCE.word} for ${lower(cohortName(group.members[0]!.key))}: only ${own(group.members[0]!)} of their own, so ${standsIn}.`
      : `${FALLBACK_CONFIDENCE.word} for ${group.members.map((member) => lower(cohortName(member.key))).join(", ")}: too few of their own (below), so ${standsIn}.`;
  return {
    answer: `${answer}.`,
    basis: `Based on ${count(group.figure.samples, "finished task")}.`,
    confidence,
    alsoFor: group.members.map((member) => `${cohortName(member.key)}: too few of their own (${member.path[0]?.samples ?? member.keySamples})`),
  };
}

/**
 * The page's opening answer: up to three cards in display order, each as its ratio in words, a
 * fallback group named for the class it is ("all finished work"), and how many more follow. The
 * exact set only, so it reads the same whether older history is shown or not.
 */
export function accuracyHeadline(cohorts: readonly CalibrationCohort[]): string {
  const groups = accuracyGroups(cohorts);
  if (groups.length === 0) return "We can't tell yet: there are no finished tasks with measured time to compare with their estimates.";
  const shown = groups.slice(0, 3).map((group, index) => {
    const name = group.kind === "own" ? cohortName(group.cohort.key) : group.name;
    const ratio = group.kind === "own" ? group.cohort.ratio.expected.value : group.figure.ratio.expected.value;
    const clause = ratioClause(index === 0 ? name : `${name.charAt(0).toLowerCase()}${name.slice(1)}`, ratio);
    return group.kind === "class" && group.figure.class.kind === "*" ? clause.replace(/ usually take /, " usually takes ") : clause;
  });
  const more = groups.length > 3 ? `; and ${count(groups.length - 3, "more group")} below` : "";
  return `${shown.join("; ")}${more}.`;
}

/**
 * A set's summary in words: what it rests on, and what is not used here, by the state the
 * payload counts (`excluded.counts`), said for the set it belongs to and for what the page shows.
 * For the older history, `exact` members are "in the measured history", "above" only when the
 * page draws the measured history above it (`shown.measuredAbove`); for the measured history,
 * `reconstructed` members "have timing rebuilt from logs (they're in the older history)", which
 * holds whether or not the older history is shown, so the measured section never changes with the
 * switch; the older history's own `reconstructed` members that are not
 * samples "couldn't be rebuilt reliably".
 */
export function setSummaryText(summary: CalibrationSetSummary, shown: { measuredAbove: boolean } = { measuredAbove: false }): { basis: string; notUsed: string | null } {
  const how = summary.set === "exact" ? "with measured time" : "with timing rebuilt from logs";
  const basis = `Based on ${count(summary.samples, "finished task")} ${how}, out of ${summary.coverage.eligible} finished with an estimate.`;
  const verb = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
  const parts = Object.entries(summary.excluded.counts)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([state, n]) => {
      const k = n!;
      switch (state) {
        case "exact":
          return shown.measuredAbove
            ? verb(k, "is in the measured history above", "are in the measured history above")
            : verb(k, "is in the measured history", "are in the measured history");
        case "approximate":
          return verb(k, "has only approximate timing", "have only approximate timing");
        case "reconstructed":
          return summary.set === "exact"
            ? verb(k, "has timing rebuilt from logs (it's in the older history)", "have timing rebuilt from logs (they're in the older history)")
            : `${k} couldn't be rebuilt reliably`;
        case "timing-floor":
          return `${k} took under a minute`;
        case "missing":
          return verb(k, "has no measured time", "have no measured time");
        default:
          return `${k} ${QUALITY_LABEL[state] ?? state}`;
      }
    });
  if (parts.length === 0) return { basis, notUsed: null };
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return { basis, notUsed: `Not used here: ${list}.` };
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

/** "8 in 10": a coverage (0..1) as a count out of ten, never "0 in 10". */
export function inTen(nominal: number): string {
  const tens = Math.round(nominal * 10);
  return tens === 0 ? "under 1 in 10" : `${tens} in 10`;
}

/** Below this confidence, where the next one lands is not said at all. */
export const NEXT_ONE_MIN_CONFIDENCE = 0.5;

/**
 * The estimate-accuracy bar's words: how 8 in 10 past tasks compared with their estimate (the
 * ratio's p10–p90), where the next one lands (the prediction bounds, at the confidence they
 * reach, in tens) — or, under `NEXT_ONE_MIN_CONFIDENCE`, that there is too little data to say —
 * and the typical figure (`ratio.expected.value`).
 */
export function cohortRangeWords(cohort: Pick<CalibrationCohort, "ratio">): { past: string; next: string; nextKnown: boolean; description: string } | null {
  const { quantiles, bounds, expected } = cohort.ratio;
  if (!quantiles || !bounds) return null;
  const past = `8 in 10 past tasks: ${plainRatioRange(quantiles.p10, quantiles.p90)}`;
  const nextKnown = bounds.confidence >= NEXT_ONE_MIN_CONFIDENCE;
  const next = nextKnown ? `Next one, about ${inTen(bounds.confidence)}: ${plainRatioRange(bounds.lower, bounds.upper)}` : "Too little data to say where the next one lands";
  const typical = plainRatio(expected.value);
  const typicalText = typical.kind === "small" ? `a 10-hour estimate usually takes about ${typical.words}` : typical.sentence;
  return { past, next, nextKnown, description: `${past}. ${next}. Typical: ${typicalText}. The dashed line is the estimate itself.` };
}
