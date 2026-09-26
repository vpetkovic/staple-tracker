/**
 * Budget forecasts (docs/timing-semantics.md, "Forecasts"): per provider account and limit,
 * what is left of the current window, how fast it is going, when it runs out, and what a piece
 * of work would do to it through the reset and the windows after. Kept apart from the
 * completion forecast on purpose: one says how much work is left, this one says what that work
 * costs a provider limit, and neither is folded into the other. Pure: the store reads this
 * machine's hub and the workspace's attempts and hands the rows in.
 *
 * ## The rates
 *
 * - PACE, `%/hour` of wall clock: the rise of the current window instance's high-water from its
 *   first reading to its latest, over the hours between them. Every use of the account moves it.
 * - WORK RATE, `%/work-hour`: the window's high-water rise over the UNION of the spans of this
 *   workspace's worker attempts that started in the instance, over the work done in those spans.
 *   Concurrent attempts are one span: two agents working the same hour while the limit rises 10%
 *   burned 5% per work-hour each, not 10. A span's rise needs a reading inside it; its baseline is
 *   the high-water at or before its start, or its first reading inside (a lower bound). A span
 *   whose baseline or last inside reading sits farther than 10% of its length (and at least two
 *   minutes) from its edge is SPARSE (`sparse_readings`): part of its rise may be other use, or
 *   the reverse. A span with a reading from a session none of its attempts ran in, or from no
 *   session at all, is SHARED (`shared_use`): its rise cannot be shown to be the work's, so the
 *   rate reads only unshared spans when there are any. An attempt with no harness session still
 *   forms a span, but no reading can match it, so any span it is in reads as shared.
 * - OTHER USE, `%/hour`: the pace outside those spans, the rise the attempts did not make over the
 *   time they were not running. It needs 30 minutes outside the spans and two readings there.
 *
 * Each rate's band is a bootstrap (spans resampled with replacement) of `FORECAST_DRAWS` draws of
 * its own, from a stream seeded with the forecast seed and the limit: it never depends on how
 * many draws the completion forecast made, or whether it made any.
 *
 * ## A piece of work, through the reset and after it
 *
 * The work is the completion forecast's remaining LABOR (its expected figure and its draws), run
 * SERIALLY from `asOf`, one work-hour per hour. Before the reset it burns `rate × min(labor, time
 * to reset)`; what is left of it runs on into the next window, which starts at 100% and gets at
 * most one window's length of it (`windowSeconds`), then the next. The first full window after
 * the reset gets the most, so it is the one the reserve is checked against. With parallel agents
 * more of the work lands before the reset; the schedule is stated as `serial_from_as_of`.
 *
 * ## The reserve
 *
 * The reserve is a parameter. The admission policy that will define it is not built; until it is,
 * a provisional default applies and every figure that uses it says so. `breachProbability` is the
 * share of draws in which the work alone (`basis: "work_alone"`) leaves less than the reserve at
 * the reset of any window it runs in (`scope: "through_the_work"`);
 * `currentWindowBreachProbability` checks the current window only. `withOtherUse` adds the other
 * use of the account at its measured rate for the time the work is NOT running in each window:
 * the work rate already holds everything that happened while the work ran. Each draw pairs a completion
 * labor draw with a work-rate draw (and an other-use draw).
 *
 * Unknown is never 0. A stale reading, a window that elapsed, a sliding window, no attempt burn,
 * or unknown labor makes the figure that needs it null, with the reason in `missing` from the
 * telemetry contract's closed set (`input_missing` names what was missing in `missingInputs`).
 */
import { createHash } from "node:crypto";
import { StapleError } from "../types.js";
import type { Missing } from "./budget-store.js";
import { MIN_COHORT_SAMPLES } from "./calibration.js";
import { FORECAST_ALGORITHM, FORECAST_DRAWS, seededRandom, spreadOfDraws, streamSeed, type SimulatedSpread } from "./forecast.js";
import type { BudgetQuality, LimitReading, WindowReading } from "./read-budget.js";

/**
 * The reserve a forecast protects when none is given: PROVISIONAL, until the admission policy
 * defines one. Every report says which applied.
 */
export const PROVISIONAL_RESERVE_PERCENT = 20;

/** Attempts a work rate reads per limit, newest first; `truncated` says when there were more. */
export const RATE_ATTEMPT_LIMIT = 200;

/**
 * A span's readings are SPARSE when the baseline reading (the latest at or before its start) or
 * its last reading inside it sits farther from that edge than this share of the span's length:
 * the rise then belongs partly to time outside the span, and the split between the work rate
 * and other use is a guess.
 */
export const SPARSE_EDGE_SHARE = 0.1;

/**
 * The least edge gap that makes a span sparse, whatever its length: a five-minute span whose
 * baseline reading is a minute before it is read as closely as the cadence allows, not sparse.
 */
export const SPARSE_EDGE_FLOOR_SECONDS = 120;

/** Other use needs this much time outside the attempts' spans, and this many readings there, to be measured. */
export const OTHER_USE_MINIMUM = { seconds: 1800, readings: 2 } as const;

export const PROVISIONAL_RESERVE_NOTE = "provisional default until the admission policy defines the protected reserve; pass reserve to set it";

export type ReserveSource = "argument" | "provisional_default";

/** `20`, `20%` or `12.5%`: a percent in [0, 100]. */
export function parseReserve(raw: string | number | undefined): { percent: number; source: ReserveSource } {
  if (raw === undefined) return { percent: PROVISIONAL_RESERVE_PERCENT, source: "provisional_default" };
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  const match = /^(\d+(?:\.\d+)?)%?$/.exec(text);
  const percent = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new StapleError("validation", `reserve takes a percent of the limit from 0 to 100 (20 or 20%); got "${raw}".`);
  }
  return { percent, source: "argument" };
}

/** One worker attempt on the account that started in the current window instance. */
export interface AttemptSpanInput {
  readonly id: string;
  readonly ref: string | null;
  readonly startedAt: string;
  /** Its end, or the last instant its record speaks for while it runs. */
  readonly endAt: string;
  /** Its work (`effortSeconds`). */
  readonly effortSeconds: number;
  /** The hashed harness sessions it ran in: a reading from any other session is someone else's use. */
  readonly sessionRefs: readonly string[];
}

/** One limit of one account, as the store read it. */
export interface BudgetLimitInput {
  readonly reading: LimitReading;
  /** The current window instance's readings with a value, by `observedAt`. */
  readonly readings: readonly WindowReading[];
  /** Worker attempts that started inside the current instance, newest first, at most {@link RATE_ATTEMPT_LIMIT}. */
  readonly attempts: readonly AttemptSpanInput[];
  readonly attemptsTruncated: boolean;
  /** Worker attempts on the account that started before the instance and ran into it: never in the rate. */
  readonly attemptsSpanningReset: number;
}

export interface BudgetAccountInput {
  readonly provider: string | null;
  readonly accountRef: string;
  readonly bound: boolean;
  readonly limits: readonly BudgetLimitInput[];
  readonly missing: Missing;
}

/** The pace of the current window: its high-water's rise per hour of wall clock. */
export interface BudgetPace {
  readonly percentPerHour: number;
  readonly fromPercent: number;
  readonly toPercent: number;
  readonly from: string;
  readonly to: string;
  readonly spanSeconds: number;
  readonly readings: number;
}

/** When the window runs out at its pace. */
export interface BudgetExhaustion {
  /** `never`: the pace is 0; `before_reset` or `after_reset` otherwise. */
  readonly atPace: "before_reset" | "after_reset" | "never";
  /** Seconds from `asOf`; null when `never`. */
  readonly seconds: number | null;
  readonly at: string | null;
}

/** How far a rate can be trusted: the spans behind it. */
export interface RateConfidence {
  /** `low` under `MIN_COHORT_SAMPLES` spans, or when a span's rise is a lower bound; `medium` otherwise. */
  readonly label: "low" | "medium";
  readonly spans: number;
  readonly minimum: number;
  /** `small_sample` (under the minimum), `lower_bound`, `sparse_readings`, `shared_use`, `concurrent_attempts`. */
  readonly warnings: string[];
}

/** The work rate: the high-water rise over the union of the attempts' spans, per hour of their work. */
export interface BudgetWorkRate {
  readonly percentPerWorkHour: number;
  /** Merged spans (concurrent attempts are one) with a known rise. */
  readonly spans: number;
  /** Attempts in those spans. */
  readonly attempts: number;
  /** Spans that held more than one attempt at once. */
  readonly concurrentSpans: number;
  /** Spans in the rate whose readings sit far from their edges ({@link SPARSE_EDGE_SHARE}). */
  readonly sparseSpans: number;
  /**
   * Spans with a known rise that held a reading from a session none of their attempts ran in:
   * someone else used the account during them. Left out of the rate when any span is not
   * shared (`sharedExcluded`); in it, and warned `shared_use`, when every span is.
   */
  readonly sharedSpans: number;
  readonly sharedExcluded: number;
  readonly burnPercent: number;
  readonly workSeconds: number;
  /** Some span had no reading at or before its start: its rise, and the rate, are at least this. */
  readonly lowerBound: boolean;
  /** Attempts in the instance left out: no work, or no reading inside their span. */
  readonly excluded: number;
  readonly spanningReset: number;
  readonly truncated: boolean;
  /** The bootstrap draws of the rate, over the spans. */
  readonly simulated: SimulatedSpread;
  readonly confidence: RateConfidence;
}

/** The account's use while none of this workspace's attempts ran. */
export interface BudgetOtherUse {
  readonly percentPerHour: number;
  readonly risePercent: number;
  /** Time outside the spans it was measured over, at least {@link OTHER_USE_MINIMUM}`.seconds`. */
  readonly seconds: number;
  /** Readings outside the spans, at least {@link OTHER_USE_MINIMUM}`.readings`. */
  readonly readings: number;
  /**
   * `low` under `MIN_COHORT_SAMPLES` readings outside the spans (`small_sample`), or when a span
   * beside it is sparse (`sparse_readings`: its rise may be the other use's); `medium` otherwise.
   */
  readonly confidence: { readonly label: "low" | "medium"; readonly warnings: string[] };
}

/** What the work does to this limit. */
export interface BudgetWorkProjection {
  /** The whole work's burn at the work rate, whenever it runs. */
  readonly consumedPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
  /** The part of it before the reset, run serially from `asOf`. */
  readonly beforeResetPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
  /** `remaining − beforeReset`: what the work alone leaves at the reset (under 0: it ran out). */
  readonly remainingAtResetPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
  /** The share of draws in which the work runs past the reset. */
  readonly outlastsResetProbability: number;
  /**
   * What the work alone leaves of the first window after the reset: `100 − rate × min(rest,
   * windowSeconds)`, `rest` the work left at the reset (100 when none is). Null, with the reason
   * in `missing`, when the window length is unknown.
   */
  readonly nextWindowRemainingPercent: { readonly expected: number; readonly simulated: SimulatedSpread } | null;
  /** Windows the work runs in, the current one included, over the draws. */
  readonly windows: SimulatedSpread;
  /** The share of draws in which the work alone uses a window's limit up, in any window it runs in. */
  readonly exhaustionProbability: number;
  /** The same, in the current window only. */
  readonly currentWindowExhaustionProbability: number;
  /** The completion forecast is partial, or a span's rise is a lower bound: the burn can only be higher. */
  readonly lowerBound: boolean;
}

export interface BudgetReserveCheck {
  readonly percent: number;
  readonly source: ReserveSource;
  readonly note: string | null;
  /** Only this work's burn; `withOtherUse` adds the rest of the account's. */
  readonly basis: "work_alone";
  /** Every window the work runs in: the current one, then the next ones at 100%. */
  readonly scope: "through_the_work";
  /** The share of draws that leave less than the reserve at the reset of any window the work runs in. */
  readonly breachProbability: number | null;
  /** The same, at the current window's reset only. */
  readonly currentWindowBreachProbability: number;
  /** The remaining figure is already under the reserve: probability 1, whatever the work. */
  readonly alreadyBelow: boolean;
  readonly draws: number;
  /** With the account's other use added at its measured rate; null with a reason when unmeasured. */
  readonly withOtherUse: {
    readonly basis: "work_and_other_use";
    readonly otherPercentPerHour: number;
    /** The other use's confidence, beside the work rate's in `confidence`. */
    readonly otherConfidence: BudgetOtherUse["confidence"];
    readonly breachProbability: number | null;
    readonly currentWindowBreachProbability: number;
    readonly remainingAtResetPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
    /**
     * The first window after the reset with the other use added for the hours the work is not
     * running in it: `100 − rate × min(rest, W) − other × (W − min(rest, W))`. Null when W is unknown.
     */
    readonly nextWindowRemainingPercent: { readonly expected: number; readonly simulated: SimulatedSpread } | null;
  } | null;
  /** The work rate's confidence carries over: a breach figure from one span is a guess. */
  readonly confidence: RateConfidence;
  readonly missing: Missing;
  readonly missingInputs: Record<string, string[]>;
}

export interface BudgetLimitForecast {
  readonly limitKey: string;
  readonly windowId: string | null;
  readonly status: string | null;
  readonly resetsAt: string | null;
  readonly secondsToReset: number | null;
  /** The instance's length, which the windows after the reset last. */
  readonly windowSeconds: number | null;
  /** The reading's high-water remaining, as `get_budget` reports it. */
  readonly remainingPercent: number | null;
  readonly highWaterPercent: number | null;
  readonly stale: boolean | null;
  /** The quality of the reading. */
  readonly quality: BudgetQuality;
  readonly pace: BudgetPace | null;
  readonly exhaustion: BudgetExhaustion | null;
  readonly workRate: BudgetWorkRate | null;
  readonly otherUse: BudgetOtherUse | null;
  readonly work: BudgetWorkProjection | null;
  readonly reserve: BudgetReserveCheck | null;
  /** Why each null figure is null, from the telemetry contract's reason codes. */
  readonly missing: Missing;
  /** For each `input_missing` figure, the inputs it lacked. */
  readonly missingInputs: Record<string, string[]>;
}

export interface BudgetAccountForecast {
  readonly provider: string | null;
  readonly accountRef: string;
  readonly bound: boolean;
  readonly limits: BudgetLimitForecast[];
  readonly missing: Missing;
}

export interface BudgetForecast {
  /** Budget data is this machine's alone: it never synchronizes. */
  readonly machineLocal: true;
  readonly budgetCapture: boolean;
  readonly reserve: { readonly percent: number; readonly source: ReserveSource; readonly note: string | null };
  /** The work projected: the completion forecast's remaining labor. */
  readonly work: { readonly expectedSeconds: number | null; readonly partial: boolean; readonly schedule: "serial_from_as_of" };
  readonly accounts: BudgetAccountForecast[];
  readonly missing: Missing;
}

const ms = (instant: string): number => Date.parse(instant);
const HOUR = 3600;

/**
 * The other use of a window the work runs `rest` seconds into, in percent: only the hours the
 * work is not running, since the work rate already holds everything while it runs.
 */
function otherUseBesideWork(otherPerHour: number, rest: number, windowSeconds: number): number {
  return (otherPerHour * (windowSeconds - Math.min(rest, windowSeconds))) / HOUR;
}

/** The pace of a window's readings (by `observedAt`), or null under two readings or no time between them. */
export function paceOf(readings: readonly WindowReading[]): BudgetPace | null {
  if (readings.length < 2) return null;
  const first = readings[0]!;
  const last = readings[readings.length - 1]!;
  const spanSeconds = (ms(last.observedAt) - ms(first.observedAt)) / 1000;
  if (spanSeconds <= 0) return null;
  const toPercent = Math.max(...readings.map((reading) => reading.usedPercent));
  return {
    percentPerHour: (Math.max(0, toPercent - first.usedPercent) / spanSeconds) * HOUR,
    fromPercent: first.usedPercent,
    toPercent,
    from: first.observedAt,
    to: last.observedAt,
    spanSeconds,
    readings: readings.length,
  };
}

/**
 * When `percent` of the limit is used up at `percentPerHour`, from `asOf`: `never` at a pace of
 * 0, else `before_reset` or `after_reset` of a reset `secondsToReset` away. The forecast's
 * exhaustion (all of what is left) and the pressure read's reserve breach (what is left above
 * the reserve) are both this.
 */
export function exhaustionAtPace(percent: number, percentPerHour: number, secondsToReset: number, asOf: string): BudgetExhaustion {
  if (percentPerHour === 0) return { atPace: "never", seconds: null, at: null };
  const seconds = (percent / percentPerHour) * HOUR;
  return { atPace: seconds < secondsToReset ? "before_reset" : "after_reset", seconds, at: new Date(ms(asOf) + seconds * 1000).toISOString() };
}

/** A merged span of attempts, with the rise the window's readings show over it. */
interface Span {
  readonly from: number;
  readonly to: number;
  readonly attempts: number;
  readonly effortSeconds: number;
  /** Null when no reading falls inside it. */
  readonly rise: number | null;
  readonly lowerBound: boolean;
  /** A baseline or last inside reading farther from its edge than {@link SPARSE_EDGE_SHARE} of the span, and {@link SPARSE_EDGE_FLOOR_SECONDS}. */
  readonly sparse: boolean;
  /** A reading inside it came from a session none of its attempts ran in, or named no session. */
  readonly shared: boolean;
}

/** Attempts with work, merged where they overlap, each merged span read against the window's readings. */
function spansOf(attempts: readonly AttemptSpanInput[], readings: readonly WindowReading[]): Span[] {
  const sorted = attempts
    .filter((attempt) => attempt.effortSeconds > 0)
    .map((attempt) => ({ from: ms(attempt.startedAt), to: Math.max(ms(attempt.startedAt), ms(attempt.endAt)), effort: attempt.effortSeconds, sessions: attempt.sessionRefs }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number; attempts: number; effort: number; sessions: Set<string> }> = [];
  for (const attempt of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && attempt.from <= last.to) {
      last.to = Math.max(last.to, attempt.to);
      last.attempts += 1;
      last.effort += attempt.effort;
      for (const session of attempt.sessions) last.sessions.add(session);
    } else merged.push({ from: attempt.from, to: attempt.to, attempts: 1, effort: attempt.effort, sessions: new Set(attempt.sessions) });
  }
  return merged.map((span) => {
    const base = { from: span.from, to: span.to, attempts: span.attempts, effortSeconds: span.effort };
    const before = readings.filter((reading) => ms(reading.observedAt) <= span.from);
    const inside = readings.filter((reading) => ms(reading.observedAt) > span.from && ms(reading.observedAt) <= span.to);
    if (inside.length === 0) return { ...base, rise: null, lowerBound: false, sparse: false, shared: false };
    const baseline = before.length > 0 ? Math.max(...before.map((reading) => reading.usedPercent)) : inside[0]!.usedPercent;
    const top = Math.max(...before.map((reading) => reading.usedPercent), ...inside.map((reading) => reading.usedPercent));
    const edge = Math.max(SPARSE_EDGE_SHARE * (span.to - span.from), SPARSE_EDGE_FLOOR_SECONDS * 1000);
    const baselineGap = before.length > 0 ? span.from - ms(before[before.length - 1]!.observedAt) : 0;
    const endGap = span.to - ms(inside[inside.length - 1]!.observedAt);
    return {
      ...base,
      rise: Math.max(0, top - baseline),
      lowerBound: before.length === 0,
      sparse: baselineGap > edge || endGap > edge,
      // A reading that names no session (a manual reading, a source without one) cannot be shown
      // to be the span's own: it counts as someone else's until it can.
      shared: inside.some((reading) => reading.sessionRef === null || !span.sessions.has(reading.sessionRef)),
    };
  });
}

/** A bootstrap of `Σ a / Σ b × scale` over `pairs`, `draws` draws from `random`. */
function bootstrapRatio(pairs: ReadonlyArray<readonly [number, number]>, draws: number, random: () => number, scale: number): Float64Array {
  const out = new Float64Array(draws);
  for (let d = 0; d < draws; d += 1) {
    let a = 0;
    let b = 0;
    for (let k = 0; k < pairs.length; k += 1) {
      const pick = pairs[Math.floor(random() * pairs.length)]!;
      a += pick[0];
      b += pick[1];
    }
    out[d] = b === 0 ? 0 : (a / b) * scale;
  }
  return out;
}

interface LimitContext {
  readonly asOf: string;
  readonly account: BudgetAccountInput;
  readonly labor: { readonly expectedSeconds: number | null; readonly partial: boolean; readonly draws: Float64Array | null };
  readonly reserve: { readonly percent: number; readonly source: ReserveSource };
  readonly seed: number;
  readonly draws: number;
}

function limitForecast(input: BudgetLimitInput, context: LimitContext): BudgetLimitForecast {
  const { reading } = input;
  const missing: Missing = {};
  const missingInputs: Record<string, string[]> = {};
  const window = reading.window;
  const current = reading.status === "current" && window !== null;
  const resetsAt = current ? window.resetsAt : null;
  const secondsToReset = resetsAt === null ? null : Math.max(0, (ms(resetsAt) - ms(context.asOf)) / 1000);
  const windowSeconds = window?.windowSeconds ?? null;
  /** Why a projection off the reading cannot be made, or null when it can. */
  let blocked: string | null = null;
  if (!current) blocked = reading.missing.remainingPercent ?? reading.missing.window ?? "no_sample_yet";
  else if (window.resetsAt === null) blocked = "sliding_window";
  else if (reading.remainingPercent === null) blocked = reading.missing.remainingPercent ?? "no_sample_yet";
  else if (reading.stale === true) blocked = "stale";

  const pace = current ? paceOf(input.readings) : null;
  if (pace === null) {
    if (!current) missing.pace = blocked!;
    else if (input.readings.length === 0) missing.pace = "no_sample_yet";
    else {
      missing.pace = "input_missing";
      missingInputs.pace = ["second_reading"];
    }
  }

  let exhaustion: BudgetExhaustion | null = null;
  if (blocked !== null) missing.exhaustion = blocked;
  else if (pace === null) {
    missing.exhaustion = "input_missing";
    missingInputs.exhaustion = ["pace"];
  } else exhaustion = exhaustionAtPace(reading.remainingPercent!, pace.percentPerHour, secondsToReset!, context.asOf);

  // ---- the work rate, over the union of the attempts' spans
  const spans = current && window.resetsAt !== null ? spansOf(input.attempts, input.readings) : [];
  const measured = spans.filter((span) => span.rise !== null);
  // Someone else's use inside a span is not this work's: read the spans nobody else touched when there are any.
  const clean = measured.filter((span) => !span.shared);
  const known = clean.length > 0 ? clean : measured;
  let workRate: BudgetWorkRate | null = null;
  let rateDraws: Float64Array | null = null;
  const label = `${context.account.provider ?? ""}:${context.account.accountRef}:${reading.limitKey}`;
  if (!current) missing.workRate = blocked!;
  else if (window.resetsAt === null) missing.workRate = "sliding_window";
  else if (known.length === 0) {
    missing.workRate = "input_missing";
    missingInputs.workRate = ["attempt_burn"];
  } else {
    const burn = known.reduce((sum, span) => sum + span.rise!, 0);
    const work = known.reduce((sum, span) => sum + span.effortSeconds, 0);
    rateDraws = bootstrapRatio(
      known.map((span) => [span.rise!, span.effortSeconds] as const),
      context.draws,
      seededRandom(streamSeed(context.seed, `budget:work:${label}`)),
      HOUR,
    );
    const lowerBound = known.some((span) => span.lowerBound);
    const concurrentSpans = known.filter((span) => span.attempts > 1).length;
    const sparseSpans = known.filter((span) => span.sparse).length;
    const sharedSpans = measured.filter((span) => span.shared).length;
    const sharedUsed = known.some((span) => span.shared);
    const warnings: string[] = [];
    if (known.length < MIN_COHORT_SAMPLES) warnings.push("small_sample");
    if (lowerBound) warnings.push("lower_bound");
    if (sparseSpans > 0) warnings.push("sparse_readings");
    if (sharedUsed) warnings.push("shared_use");
    if (concurrentSpans > 0) warnings.push("concurrent_attempts");
    const counted = known.reduce((sum, span) => sum + span.attempts, 0);
    workRate = {
      percentPerWorkHour: (burn / work) * HOUR,
      spans: known.length,
      attempts: counted,
      concurrentSpans,
      sparseSpans,
      sharedSpans,
      sharedExcluded: measured.length - known.length,
      burnPercent: burn,
      workSeconds: work,
      lowerBound,
      excluded: input.attempts.length - measured.reduce((sum, span) => sum + span.attempts, 0),
      spanningReset: input.attemptsSpanningReset,
      truncated: input.attemptsTruncated,
      simulated: spreadOfDraws(rateDraws),
      confidence: { label: known.length < MIN_COHORT_SAMPLES || lowerBound || sparseSpans > 0 || sharedUsed ? "low" : "medium", spans: known.length, minimum: MIN_COHORT_SAMPLES, warnings },
    };
  }

  // ---- other use: the pace outside the attempts' spans
  let otherUse: BudgetOtherUse | null = null;
  if (!current) missing.otherUse = blocked!;
  else if (pace === null) {
    missing.otherUse = "input_missing";
    missingInputs.otherUse = ["pace"];
  } else {
    const from = ms(pace.from);
    const to = ms(pace.to);
    const inSpan = spans.filter((span) => span.to > from && span.from < to);
    if (inSpan.some((span) => span.rise === null)) {
      missing.otherUse = "input_missing";
      missingInputs.otherUse = ["attempt_burn"];
    } else {
      const covered = inSpan.reduce((sum, span) => sum + (Math.min(span.to, to) - Math.max(span.from, from)) / 1000, 0);
      const seconds = pace.spanSeconds - covered;
      const outside = input.readings.filter((reading) => !inSpan.some((span) => ms(reading.observedAt) > span.from && ms(reading.observedAt) <= span.to)).length;
      if (seconds < OTHER_USE_MINIMUM.seconds || outside < OTHER_USE_MINIMUM.readings) {
        // Two minutes between spans with one reading in them is no measure of a rate.
        missing.otherUse = "input_missing";
        missingInputs.otherUse = ["time_outside_attempts"];
      } else {
        const rise = Math.max(0, pace.toPercent - pace.fromPercent - inSpan.reduce((sum, span) => sum + span.rise!, 0));
        const warnings: string[] = [];
        if (outside < MIN_COHORT_SAMPLES) warnings.push("small_sample");
        if (inSpan.some((span) => span.sparse)) warnings.push("sparse_readings");
        otherUse = { percentPerHour: (rise / seconds) * HOUR, risePercent: rise, seconds, readings: outside, confidence: { label: warnings.length > 0 ? "low" : "medium", warnings } };
      }
    }
  }

  // ---- the work, through the reset and the windows after it, and the reserve
  let work: BudgetWorkProjection | null = null;
  let reserve: BudgetReserveCheck | null = null;
  const needs: string[] = [];
  if (workRate === null) needs.push("work_rate");
  if (context.labor.expectedSeconds === null || context.labor.draws === null) needs.push("labor_seconds");
  if (blocked !== null) {
    missing.work = blocked;
    missing.reserve = blocked;
  } else if (needs.length > 0) {
    missing.work = "input_missing";
    missing.reserve = "input_missing";
    missingInputs.work = needs;
    missingInputs.reserve = needs;
  } else {
    const draws = context.draws;
    const rate = workRate!.percentPerWorkHour;
    const labor = context.labor.expectedSeconds!;
    const horizon = secondsToReset!;
    const remaining = reading.remainingPercent!;
    const reserveAt = context.reserve.percent;
    // Other use is one measurement (the pace outside the spans), not a set of spans: no spread of its own.
    const otherDraws = otherUse === null ? null : new Float64Array(draws).fill(otherUse.percentPerHour);
    const consumed = new Float64Array(draws);
    const before = new Float64Array(draws);
    const left = new Float64Array(draws);
    const leftOther = new Float64Array(draws);
    const windows = new Float64Array(draws);
    const nextLeft = new Float64Array(draws);
    const nextLeftOther = new Float64Array(draws);
    let outlasts = 0;
    let exhaustsNow = 0;
    let exhausts = 0;
    let breachNow = 0;
    let breach = 0;
    let breachNowOther = 0;
    let breachOther = 0;
    let needsWindow = false;
    for (let d = 0; d < draws; d += 1) {
      const laborDraw = context.labor.draws![d % context.labor.draws!.length]!;
      const r = rateDraws![d]!;
      consumed[d] = (r * laborDraw) / HOUR;
      before[d] = (r * Math.min(laborDraw, horizon)) / HOUR;
      left[d] = remaining - before[d]!;
      const rest = Math.max(0, laborDraw - horizon);
      if (rest > 0) outlasts += 1;
      if (rest > 0 && windowSeconds === null) needsWindow = true;
      // The first full window after the reset gets the most of what is left: it is the one to check.
      const next = rest > 0 && windowSeconds !== null ? (r * Math.min(rest, windowSeconds)) / HOUR : 0;
      windows[d] = 1 + (rest > 0 && windowSeconds !== null ? Math.ceil(rest / windowSeconds) : 0);
      nextLeft[d] = 100 - next;
      if (left[d]! <= 0) exhaustsNow += 1;
      if (left[d]! <= 0 || 100 - next <= 0) exhausts += 1;
      if (left[d]! < reserveAt) breachNow += 1;
      if (left[d]! < reserveAt || (rest > 0 && 100 - next < reserveAt)) breach += 1;
      if (otherDraws !== null) {
        const o = otherDraws[d]!;
        // The work rate already holds everything that happened while the work ran: other use only
        // fills the hours the work is not running, before this reset and in the next window.
        leftOther[d] = left[d]! - (o * (horizon - Math.min(laborDraw, horizon))) / HOUR;
        const nextOtherUse = windowSeconds === null ? 0 : otherUseBesideWork(o, rest, windowSeconds);
        nextLeftOther[d] = 100 - next - nextOtherUse;
        const nextOther = rest > 0 && windowSeconds !== null ? next + nextOtherUse : 0;
        if (leftOther[d]! < reserveAt) breachNowOther += 1;
        if (leftOther[d]! < reserveAt || (rest > 0 && 100 - nextOther < reserveAt)) breachOther += 1;
      }
    }
    const beforeExpected = (rate * Math.min(labor, horizon)) / HOUR;
    const restExpected = Math.max(0, labor - horizon);
    const nextExpected = windowSeconds === null ? null : (rate * Math.min(restExpected, windowSeconds)) / HOUR;
    if (windowSeconds === null) missing.nextWindowRemainingPercent = window?.missing.windowSeconds ?? "not_reported_by_source";
    work = {
      consumedPercent: { expected: (rate * labor) / HOUR, simulated: spreadOfDraws(consumed) },
      beforeResetPercent: { expected: beforeExpected, simulated: spreadOfDraws(before) },
      remainingAtResetPercent: { expected: remaining - beforeExpected, simulated: spreadOfDraws(left) },
      outlastsResetProbability: outlasts / draws,
      nextWindowRemainingPercent: nextExpected === null ? null : { expected: 100 - nextExpected, simulated: spreadOfDraws(nextLeft) },
      windows: spreadOfDraws(windows),
      exhaustionProbability: exhausts / draws,
      currentWindowExhaustionProbability: exhaustsNow / draws,
      lowerBound: context.labor.partial || workRate!.lowerBound,
    };
    if (needsWindow) {
      missing.windowSeconds = window?.missing.windowSeconds ?? "not_reported_by_source";
    }
    const alreadyBelow = remaining < reserveAt;
    const reserveMissing: Missing = {};
    const reserveInputs: Record<string, string[]> = {};
    if (needsWindow) {
      reserveMissing.breachProbability = "input_missing";
      reserveInputs.breachProbability = ["window_seconds"];
    }
    if (otherUse === null) {
      reserveMissing.withOtherUse = missing.otherUse ?? "input_missing";
      if (missingInputs.otherUse !== undefined) reserveInputs.withOtherUse = missingInputs.otherUse;
    }
    reserve = {
      percent: reserveAt,
      source: context.reserve.source,
      note: context.reserve.source === "provisional_default" ? PROVISIONAL_RESERVE_NOTE : null,
      basis: "work_alone",
      scope: "through_the_work",
      breachProbability: alreadyBelow ? 1 : needsWindow ? null : breach / draws,
      currentWindowBreachProbability: alreadyBelow ? 1 : breachNow / draws,
      alreadyBelow,
      draws,
      withOtherUse:
        otherUse === null
          ? null
          : {
              basis: "work_and_other_use",
              otherPercentPerHour: otherUse.percentPerHour,
              otherConfidence: otherUse.confidence,
              breachProbability: alreadyBelow ? 1 : needsWindow ? null : breachOther / draws,
              currentWindowBreachProbability: alreadyBelow ? 1 : breachNowOther / draws,
              remainingAtResetPercent: {
                expected: remaining - beforeExpected - (otherUse.percentPerHour * (horizon - Math.min(labor, horizon))) / HOUR,
                simulated: spreadOfDraws(leftOther),
              },
              nextWindowRemainingPercent:
                nextExpected === null
                  ? null
                  : {
                      expected: 100 - nextExpected - otherUseBesideWork(otherUse.percentPerHour, restExpected, windowSeconds!),
                      simulated: spreadOfDraws(nextLeftOther),
                    },
            },
      confidence: workRate!.confidence,
      missing: reserveMissing,
      missingInputs: reserveInputs,
    };
  }

  // Every null figure says why, the reading's own included.
  const unknown = (field: string, value: unknown, reason: string | undefined): void => {
    if (value === null && missing[field] === undefined) missing[field] = reason ?? blocked ?? "input_missing";
  };
  unknown("windowId", window?.id ?? null, reading.missing.window);
  unknown("status", reading.status, reading.missing.window);
  unknown("resetsAt", resetsAt, blocked ?? "sliding_window");
  unknown("secondsToReset", secondsToReset, blocked ?? "sliding_window");
  unknown("windowSeconds", windowSeconds, window?.missing.windowSeconds ?? reading.missing.window);
  unknown("remainingPercent", reading.remainingPercent, reading.missing.remainingPercent);
  unknown("highWaterPercent", reading.highWaterPercent, reading.missing.highWaterPercent);
  unknown("stale", reading.stale, reading.missing.stale);
  return {
    limitKey: reading.limitKey,
    windowId: window?.id ?? null,
    status: reading.status,
    resetsAt,
    secondsToReset,
    windowSeconds,
    remainingPercent: reading.remainingPercent,
    highWaterPercent: reading.highWaterPercent,
    stale: reading.stale,
    quality: reading.quality,
    pace,
    exhaustion,
    workRate,
    otherUse,
    work,
    reserve,
    missing,
    missingInputs,
  };
}

/** The budget forecast of `accounts` for a piece of work of `labor` remaining effort. */
export function budgetForecast(input: {
  readonly asOf: string;
  readonly budgetCapture: boolean;
  readonly accounts: readonly BudgetAccountInput[];
  readonly labor: { readonly expectedSeconds: number | null; readonly partial: boolean; readonly draws: Float64Array | null };
  readonly reserve: { readonly percent: number; readonly source: ReserveSource };
  readonly seed: number;
  /** Why there is no account at all, when there is none. */
  readonly absent: string;
}): BudgetForecast {
  const missing: Missing = {};
  if (input.accounts.length === 0) missing.accounts = input.absent;
  return {
    machineLocal: true,
    budgetCapture: input.budgetCapture,
    reserve: { percent: input.reserve.percent, source: input.reserve.source, note: input.reserve.source === "provisional_default" ? PROVISIONAL_RESERVE_NOTE : null },
    work: { expectedSeconds: input.labor.expectedSeconds, partial: input.labor.partial, schedule: "serial_from_as_of" },
    accounts: input.accounts.map((account) => ({
      provider: account.provider,
      accountRef: account.accountRef,
      bound: account.bound,
      limits: account.limits.map((limit) =>
        limitForecast(limit, { asOf: input.asOf, account, labor: input.labor, reserve: input.reserve, seed: input.seed, draws: FORECAST_DRAWS }),
      ),
      missing: account.missing,
    })),
    missing,
  };
}

/**
 * The identity of the budget data a forecast read on THIS machine at `asOf`: the instant (the time
 * to every reset is measured from it), every limit's window, its readings and the attempt spans in
 * its rate, and the reserve. Budget data never synchronizes, so this id is the machine's, apart
 * from the completion snapshot every device shares.
 */
export function budgetSnapshotId(asOf: string, accounts: readonly BudgetAccountInput[], reserve: number): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([FORECAST_ALGORITHM, "budget", asOf, reserve]));
  for (const account of accounts) {
    for (const limit of account.limits) {
      hash.update("\n");
      hash.update(
        JSON.stringify([
          account.provider,
          account.accountRef,
          limit.reading.limitKey,
          limit.reading.window?.id ?? null,
          limit.reading.status,
          limit.reading.remainingPercent,
          limit.reading.stale,
          limit.readings.map((reading) => reading.id),
          limit.attempts.map((attempt) => [attempt.id, attempt.startedAt, attempt.endAt, attempt.effortSeconds]),
        ]),
      );
    }
  }
  return `${FORECAST_ALGORITHM.replace("/", "")}-budget:${hash.digest("hex").slice(0, 32)}`;
}
