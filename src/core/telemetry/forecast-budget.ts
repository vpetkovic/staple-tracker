/**
 * Budget forecasts (docs/timing-semantics.md, "Forecasts"): per provider account and limit,
 * what is left of the current window, how fast it is going, when it runs out, and what a piece
 * of work would leave at the reset. Kept apart from the completion forecast on purpose: one says
 * how much work is left, this one says what that work costs a provider limit, and neither is
 * folded into the other. Pure: the store reads this machine's hub and hands the rows in.
 *
 * ## The two rates
 *
 * - PACE, `%/hour` of wall clock: the rise of the current window instance's high-water over its
 *   readings, from the first to the latest (`(high-water − first reading) / hours between them`).
 *   Every use of the account moves it, here or elsewhere. It says when the window runs out if
 *   nothing changes.
 * - WORK RATE, `%/work-hour`: the measured burn of this workspace's worker attempts in the same
 *   window instance, over the work they did (`Σ burn / Σ effortSeconds`). An attempt counts when
 *   it started inside the instance and its burn in that instance is known (`attemptBurn`, the
 *   high-water rule). It is what a piece of work of known effort costs.
 *
 * ## A piece of work
 *
 * The work is the completion forecast's remaining LABOR (its expected figure and its draws). It
 * is assumed to run SERIALLY from `asOf`, one work-hour per hour, so the part before the reset is
 * `min(labor, time to reset)`; with parallel agents more of it lands before the reset, so the
 * projection is optimistic for a fan-out. `remainingAtReset = remaining − rate × min(labor, time
 * to reset)`, and it only counts this work: the account's other use comes on top (the pace).
 *
 * ## The reserve
 *
 * The reserve is a parameter. The admission policy that will define it, and what pressure means
 * against it, is not built yet; until it is, a provisional default applies and says it is one.
 * `breachProbability` is the share of draws in which the work leaves less than the reserve at the
 * reset. Each draw pairs the completion forecast's labor draw with a bootstrap draw of the work
 * rate (the attempts resampled with replacement), from a stream seeded by the forecast seed and
 * the limit, so the figure is the same on every read of the same data.
 *
 * Unknown is never 0. A stale reading, a window that elapsed, a sliding window, no attempt burn,
 * or unknown labor makes the figure that needs it null, with the reason in `missing` from the
 * telemetry contract's closed set (`input_missing` names what was missing in `missingInputs`).
 */
import { createHash } from "node:crypto";
import { StapleError } from "../types.js";
import type { Missing } from "./budget-store.js";
import { FORECAST_ALGORITHM, seededRandom, spreadOfDraws, streamSeed, type SimulatedSpread } from "./forecast.js";
import type { BudgetQuality, LimitReading, WindowReading } from "./read-budget.js";

/**
 * The reserve a forecast protects when none is given: PROVISIONAL, until the admission policy
 * defines one. Every report says which applied.
 */
export const PROVISIONAL_RESERVE_PERCENT = 20;

/** Attempts a work rate reads per limit, newest first; `truncated` says when there were more. */
export const RATE_ATTEMPT_LIMIT = 200;

/** `20`, `20%` or `12.5%`: a percent in [0, 100]. */
export function parseReserve(raw: string | number | undefined): { percent: number; source: "argument" | "provisional_default" } {
  if (raw === undefined) return { percent: PROVISIONAL_RESERVE_PERCENT, source: "provisional_default" };
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  const match = /^(\d+(?:\.\d+)?)%?$/.exec(text);
  const percent = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new StapleError("validation", `reserve takes a percent of the limit from 0 to 100 (20 or 20%); got "${raw}".`);
  }
  return { percent, source: "argument" };
}

/** One worker attempt on the account, as the store read its burn in the current window. */
export interface AttemptBurnInput {
  readonly id: string;
  readonly ref: string | null;
  readonly startedAt: string;
  /** Its work (`effortSeconds`). */
  readonly effortSeconds: number;
  /** Its burn in this window instance; null when unknown. */
  readonly burnPercent: number | null;
  readonly lowerBound: boolean;
  readonly attribution: "sole_known" | "shared" | null;
  /** Why `burnPercent` is null. */
  readonly missing: string | null;
}

/** One limit of one account, as the store read it. */
export interface BudgetLimitInput {
  readonly reading: LimitReading;
  /** The current window instance's readings with a value, by `observedAt`. */
  readonly readings: readonly WindowReading[];
  /** Worker attempts that started inside the current instance, newest first, at most {@link RATE_ATTEMPT_LIMIT}. */
  readonly attempts: readonly AttemptBurnInput[];
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

/** The work rate: measured burn per hour of work in this window instance. */
export interface BudgetWorkRate {
  readonly percentPerWorkHour: number;
  /** Attempts in the rate: their burn was known and they did work. */
  readonly attempts: number;
  readonly burnPercent: number;
  readonly workSeconds: number;
  /** Some attempt's burn is a lower bound: the rate is at least this. */
  readonly lowerBound: boolean;
  /** Attempts that shared the account with another attempt: their burn counts the other's use too, so the rate reads high. */
  readonly shared: number;
  /** Attempts whose attribution is unknown. */
  readonly attributionUnknown: number;
  /** Attempts in the instance left out: no known burn, or no work. */
  readonly excluded: number;
  readonly spanningReset: number;
  readonly truncated: boolean;
  /** The bootstrap draws of the rate. */
  readonly simulated: SimulatedSpread;
}

/** What the work does to this limit. */
export interface BudgetWorkProjection {
  /** The whole work's burn at the work rate, whenever it runs. */
  readonly consumedPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
  /** The part of it before the reset, run serially from `asOf`. */
  readonly beforeResetPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
  /** `remaining − beforeReset`: what is left at the reset after this work. */
  readonly remainingAtResetPercent: { readonly expected: number; readonly simulated: SimulatedSpread };
  /** The share of draws in which the work runs past the reset. */
  readonly outlastsResetProbability: number;
  /** The completion forecast is partial, or a burn is a lower bound: the burn can only be higher. */
  readonly lowerBound: boolean;
}

export interface BudgetReserveCheck {
  readonly percent: number;
  /** The share of draws that leave less than the reserve at (and so at or before) the reset. */
  readonly breachProbability: number;
  /** The remaining figure is already under the reserve: probability 1, whatever the work. */
  readonly alreadyBelow: boolean;
  readonly draws: number;
}

export interface BudgetLimitForecast {
  readonly limitKey: string;
  readonly windowId: string | null;
  readonly status: string | null;
  readonly resetsAt: string | null;
  readonly secondsToReset: number | null;
  /** The reading's high-water remaining, as `get_budget` reports it. */
  readonly remainingPercent: number | null;
  readonly highWaterPercent: number | null;
  readonly stale: boolean | null;
  /** The quality of the reading. */
  readonly quality: BudgetQuality;
  readonly pace: BudgetPace | null;
  readonly exhaustion: BudgetExhaustion | null;
  readonly workRate: BudgetWorkRate | null;
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
  readonly reserve: { readonly percent: number; readonly source: "argument" | "provisional_default"; readonly note: string | null };
  /** The work projected: the completion forecast's remaining labor. */
  readonly work: { readonly expectedSeconds: number | null; readonly partial: boolean; readonly schedule: "serial_from_as_of" };
  readonly accounts: BudgetAccountForecast[];
  readonly missing: Missing;
}

const ms = (instant: string): number => Date.parse(instant);
const HOUR = 3600;

function paceOf(readings: readonly WindowReading[]): BudgetPace | null {
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

function limitForecast(
  input: BudgetLimitInput,
  context: {
    readonly asOf: string;
    readonly account: BudgetAccountInput;
    readonly labor: { readonly expectedSeconds: number | null; readonly partial: boolean; readonly draws: Float64Array | null };
    readonly reserve: number;
    readonly seed: number;
  },
): BudgetLimitForecast {
  const { reading } = input;
  const missing: Missing = {};
  const missingInputs: Record<string, string[]> = {};
  const window = reading.window;
  const current = reading.status === "current" && window !== null;
  const resetsAt = current ? window.resetsAt : null;
  const secondsToReset = resetsAt === null ? null : Math.max(0, (ms(resetsAt) - ms(context.asOf)) / 1000);
  /** Why a projection off the reading cannot be made, or null when it can. */
  let blocked: string | null = null;
  if (!current) blocked = reading.missing.remainingPercent ?? reading.missing.window ?? "no_sample_yet";
  else if (window.resetsAt === null) blocked = "sliding_window";
  else if (reading.remainingPercent === null) blocked = reading.missing.remainingPercent ?? "no_sample_yet";
  else if (reading.stale === true) blocked = "stale";
  if (resetsAt === null) missing.secondsToReset = blocked ?? "sliding_window";

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
  } else if (pace.percentPerHour === 0) exhaustion = { atPace: "never", seconds: null, at: null };
  else {
    const seconds = (reading.remainingPercent! / pace.percentPerHour) * HOUR;
    exhaustion = { atPace: seconds < secondsToReset! ? "before_reset" : "after_reset", seconds, at: new Date(ms(context.asOf) + seconds * 1000).toISOString() };
  }

  // ---- the work rate, from attempt burn in this instance
  const pool = input.attempts.filter((attempt) => attempt.burnPercent !== null && attempt.effortSeconds > 0);
  let workRate: BudgetWorkRate | null = null;
  let rateDraws: Float64Array | null = null;
  const draws = context.labor.draws?.length ?? 0;
  if (!current) missing.workRate = blocked!;
  else if (window.resetsAt === null) missing.workRate = "sliding_window";
  else if (pool.length === 0) {
    missing.workRate = "input_missing";
    missingInputs.workRate = ["attempt_burn"];
  } else {
    const burn = pool.reduce((sum, attempt) => sum + attempt.burnPercent!, 0);
    const work = pool.reduce((sum, attempt) => sum + attempt.effortSeconds, 0);
    const random = seededRandom(streamSeed(context.seed, `budget:${context.account.provider ?? ""}:${context.account.accountRef}:${reading.limitKey}`));
    const bootstrap = new Float64Array(Math.max(draws, 1));
    for (let d = 0; d < bootstrap.length; d += 1) {
      let b = 0;
      let w = 0;
      for (let k = 0; k < pool.length; k += 1) {
        const pick = pool[Math.floor(random() * pool.length)]!;
        b += pick.burnPercent!;
        w += pick.effortSeconds;
      }
      bootstrap[d] = (b / w) * HOUR;
    }
    rateDraws = bootstrap;
    workRate = {
      percentPerWorkHour: (burn / work) * HOUR,
      attempts: pool.length,
      burnPercent: burn,
      workSeconds: work,
      lowerBound: pool.some((attempt) => attempt.lowerBound),
      shared: pool.filter((attempt) => attempt.attribution === "shared").length,
      attributionUnknown: pool.filter((attempt) => attempt.attribution === null).length,
      excluded: input.attempts.length - pool.length,
      spanningReset: input.attemptsSpanningReset,
      truncated: input.attemptsTruncated,
      simulated: spreadOfDraws(bootstrap),
    };
  }

  // ---- the work, and the reserve
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
    const rate = workRate!.percentPerWorkHour;
    const labor = context.labor.expectedSeconds!;
    const horizon = secondsToReset!;
    const remaining = reading.remainingPercent!;
    const consumed = new Float64Array(draws);
    const before = new Float64Array(draws);
    const left = new Float64Array(draws);
    let outlasts = 0;
    let breaches = 0;
    for (let d = 0; d < draws; d += 1) {
      const laborDraw = context.labor.draws![d]!;
      consumed[d] = (rateDraws![d]! * laborDraw) / HOUR;
      before[d] = (rateDraws![d]! * Math.min(laborDraw, horizon)) / HOUR;
      left[d] = remaining - before[d]!;
      if (laborDraw > horizon) outlasts += 1;
      if (left[d]! < context.reserve) breaches += 1;
    }
    const beforeExpected = (rate * Math.min(labor, horizon)) / HOUR;
    work = {
      consumedPercent: { expected: (rate * labor) / HOUR, simulated: spreadOfDraws(consumed) },
      beforeResetPercent: { expected: beforeExpected, simulated: spreadOfDraws(before) },
      remainingAtResetPercent: { expected: remaining - beforeExpected, simulated: spreadOfDraws(left) },
      outlastsResetProbability: outlasts / draws,
      lowerBound: context.labor.partial || workRate!.lowerBound,
    };
    const alreadyBelow = remaining < context.reserve;
    reserve = { percent: context.reserve, breachProbability: alreadyBelow ? 1 : breaches / draws, alreadyBelow, draws };
  }

  return {
    limitKey: reading.limitKey,
    windowId: window?.id ?? null,
    status: reading.status,
    resetsAt,
    secondsToReset,
    remainingPercent: reading.remainingPercent,
    highWaterPercent: reading.highWaterPercent,
    stale: reading.stale,
    quality: reading.quality,
    pace,
    exhaustion,
    workRate,
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
  readonly reserve: { readonly percent: number; readonly source: "argument" | "provisional_default" };
  readonly seed: number;
  /** Why there is no account at all, when there is none. */
  readonly absent: string;
}): BudgetForecast {
  const missing: Missing = {};
  if (input.accounts.length === 0) missing.accounts = input.absent;
  return {
    machineLocal: true,
    budgetCapture: input.budgetCapture,
    reserve: {
      percent: input.reserve.percent,
      source: input.reserve.source,
      note: input.reserve.source === "provisional_default" ? "provisional default until the admission policy defines the protected reserve; pass reserve to set it" : null,
    },
    work: { expectedSeconds: input.labor.expectedSeconds, partial: input.labor.partial, schedule: "serial_from_as_of" },
    accounts: input.accounts.map((account) => ({
      provider: account.provider,
      accountRef: account.accountRef,
      bound: account.bound,
      limits: account.limits.map((limit) =>
        limitForecast(limit, { asOf: input.asOf, account, labor: input.labor, reserve: input.reserve.percent, seed: input.seed }),
      ),
      missing: account.missing,
    })),
    missing,
  };
}

/**
 * The identity of the budget data a forecast read on THIS machine: every limit's window, its
 * readings and the attempt burns in its rate, and the reserve. Budget data never synchronizes,
 * so this id is the machine's, apart from the completion snapshot every device shares.
 */
export function budgetSnapshotId(accounts: readonly BudgetAccountInput[], reserve: number): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([FORECAST_ALGORITHM, "budget", reserve]));
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
          limit.attempts.map((attempt) => [attempt.id, attempt.burnPercent, attempt.effortSeconds]),
        ]),
      );
    }
  }
  return `${FORECAST_ALGORITHM.replace("/", "")}-budget:${hash.digest("hex").slice(0, 32)}`;
}
