/**
 * Session pressure (docs/execution-telemetry.md, "Pressure"): per limit, how fast the current
 * window is being used against how fast it COULD be used and still keep the protected reserve at
 * the reset. Machine state, like everything `staple budget` reads: no workspace, no attempts, only
 * this machine's readings of the window.
 *
 * ## Provisional, every figure
 *
 * Sustainable burn, pressure and safe concurrency belong to the admission policy, which is not
 * built. Until it is, this module states a PROVISIONAL reading of the first two, and says so on
 * every report (`pressureRule.provisional`), the way the forecast states its provisional reserve:
 *
 * - OBSERVED BURN is the window's pace (`paceOf`, the forecast's own): the high-water's rise from
 *   the window instance's first reading to its latest, per hour of wall clock. A measurement.
 * - SUSTAINABLE BURN is `max(0, remaining − reserve) / hours to reset`: the pace that would land
 *   exactly on the reserve at the reset.
 * - PRESSURE is observed over sustainable. At {@link UNSAFE_PRESSURE} or over, the pace reaches
 *   the reserve before the reset: `unsafe`. Under it: `within`. A remaining figure already at or
 *   under the reserve is `unsafe` whatever the pace, and its ratio is null (`reserve_reached`):
 *   nothing is sustainable, so there is nothing to divide by.
 * - SAFE CONCURRENCY is not stated at all (`policy_not_defined`): how many agents a pressure
 *   admits is the policy's decision, and a number here would read as one.
 *
 * Unknown is never 0, and never "within": a stale reading, an elapsed or sliding window, or a
 * single reading makes the figure that needs it null with its reason, the state included.
 */
import { MIN_COHORT_SAMPLES } from "./calibration.js";
import type { Missing } from "./budget-store.js";
import { OTHER_USE_MINIMUM, exhaustionAtPace, paceOf, type BudgetExhaustion, type BudgetPace, type ReserveSource } from "./forecast-budget.js";
import type { LimitWindow } from "./budget-store.js";

/** Pressure at or over this ratio of observed to sustainable burn is `unsafe`: PROVISIONAL. */
export const UNSAFE_PRESSURE = 1;

/** A pace measured over less than this reads `low` confidence (`short_span`): the forecast's other-use minimum. */
export const PRESSURE_MIN_SPAN_SECONDS = OTHER_USE_MINIMUM.seconds;

export const PRESSURE_NOTE =
  "provisional until the admission policy defines sustainable burn and pressure: sustainable = (remaining − reserve) / time to reset, pressure = observed pace / sustainable, unsafe at 1 or over";

const HOUR = 3600;
const ms = (instant: string): number => Date.parse(instant);

/** How the reading's rule reads, once per report. */
export interface PressureRule {
  readonly provisional: true;
  /** Pressure at or over this is `unsafe`. */
  readonly unsafeAtRatio: number;
  readonly note: string;
}

export const PRESSURE_RULE: PressureRule = { provisional: true, unsafeAtRatio: UNSAFE_PRESSURE, note: PRESSURE_NOTE };

/** When the pace reaches the reserve: `already` when the remaining figure is at or under it. */
export interface ReserveReach {
  readonly atPace: "already" | BudgetExhaustion["atPace"];
  /** Seconds from `asOf`: 0 when `already`, null when `never`. */
  readonly seconds: number | null;
  readonly at: string | null;
}

/** How far the pace behind the pressure can be trusted. */
export interface PressureConfidence {
  /** `low` with any warning, `medium` otherwise. Never `high`: the rule itself is provisional. */
  readonly label: "low" | "medium";
  readonly readings: number;
  readonly spanSeconds: number;
  /** `small_sample` (under 5 readings), `short_span` (under 30 minutes), `regressions` (the provider's figure went down inside the window). */
  readonly warnings: string[];
}

/** One limit's pressure. MEASURED: `observed`, `lastReadingAgeSeconds`. FORECAST: the rest. */
export interface LimitPressure {
  /** MEASURED: the window's pace, %/hour of wall clock; null under two readings. */
  readonly observed: BudgetPace | null;
  /** MEASURED: how old the latest reading's value is at `asOf`. */
  readonly lastReadingAgeSeconds: number | null;
  /** The reserve the figures protect, in percent of the limit. */
  readonly reservePercent: number;
  /** FORECAST: `max(0, remaining − reserve) / hours to reset`, %/hour. */
  readonly sustainablePercentPerHour: number | null;
  /** FORECAST: observed / sustainable. */
  readonly ratio: number | null;
  /** `unsafe` at {@link UNSAFE_PRESSURE} or over, or at or under the reserve; `within` under; null (with its reason) when either side is unknown. */
  readonly state: "within" | "unsafe" | null;
  /** FORECAST: when the pace uses up what is left. */
  readonly exhaustion: BudgetExhaustion | null;
  /** FORECAST: when the pace reaches the reserve. */
  readonly reserveReach: ReserveReach | null;
  /** Always null: how many agents a pressure admits is the admission policy's (`policy_not_defined`). */
  readonly safeConcurrency: null;
  readonly confidence: PressureConfidence | null;
  readonly missing: Missing;
  readonly missingInputs: Record<string, string[]>;
}

/** What the reading of one limit hands in. */
export interface PressureInput {
  readonly asOf: string;
  readonly status: string | null;
  readonly window: LimitWindow | null;
  readonly remainingPercent: number | null;
  readonly stale: boolean | null;
  readonly regressionCount: number | null;
  /** The reading's own reasons, which a figure off it inherits. */
  readonly missing: Missing;
  /** The current instance's readings with a value, by `observedAt`. */
  readonly readings: ReadonlyArray<{ readonly id: string; readonly observedAt: string; readonly usedPercent: number; readonly sessionRef: string | null }>;
  readonly latestObservedAt: string | null;
  readonly reserve: { readonly percent: number; readonly source: ReserveSource };
}

export function limitPressure(input: PressureInput): LimitPressure {
  const missing: Missing = {};
  const missingInputs: Record<string, string[]> = {};
  const window = input.window;
  const current = input.status === "current" && window !== null;
  const secondsToReset = current && window.resetsAt !== null ? (ms(window.resetsAt) - ms(input.asOf)) / 1000 : null;

  /** Why nothing can be projected off the reading, or null when it can. The forecast's order. */
  let blocked: string | null = null;
  if (!current) blocked = input.missing.remainingPercent ?? input.missing.window ?? "no_sample_yet";
  else if (window.resetsAt === null) blocked = "sliding_window";
  else if (input.remainingPercent === null) blocked = input.missing.remainingPercent ?? "no_sample_yet";
  else if (input.stale === true) blocked = "stale";
  else if (secondsToReset! <= 0) blocked = "window_elapsed";

  // ---- measured
  const observed = current ? paceOf(input.readings) : null;
  if (observed === null) {
    if (!current) missing.observed = blocked!;
    else if (input.readings.length === 0) missing.observed = "no_sample_yet";
    else {
      missing.observed = "input_missing";
      missingInputs.observed = ["second_reading"];
    }
  }
  const lastReadingAgeSeconds = current && input.latestObservedAt !== null ? Math.max(0, (ms(input.asOf) - ms(input.latestObservedAt)) / 1000) : null;
  if (lastReadingAgeSeconds === null) missing.lastReadingAgeSeconds = current ? "no_sample_yet" : blocked!;

  let confidence: PressureConfidence | null = null;
  if (observed !== null) {
    const warnings: string[] = [];
    if (observed.readings < MIN_COHORT_SAMPLES) warnings.push("small_sample");
    if (observed.spanSeconds < PRESSURE_MIN_SPAN_SECONDS) warnings.push("short_span");
    if ((input.regressionCount ?? 0) > 0) warnings.push("regressions");
    confidence = { label: warnings.length > 0 ? "low" : "medium", readings: observed.readings, spanSeconds: observed.spanSeconds, warnings };
  } else missing.confidence = missing.observed!;

  // ---- forecast
  const reserve = input.reserve.percent;
  let sustainable: number | null = null;
  let ratio: number | null = null;
  let state: LimitPressure["state"] = null;
  let exhaustion: BudgetExhaustion | null = null;
  let reserveReach: ReserveReach | null = null;
  if (blocked !== null) {
    for (const field of ["sustainablePercentPerHour", "ratio", "state", "exhaustion", "reserveReach"]) missing[field] = blocked;
  } else {
    const remaining = input.remainingPercent!;
    const above = remaining - reserve;
    sustainable = (Math.max(0, above) / secondsToReset!) * HOUR;
    if (above <= 0) {
      // Already at or under the reserve: unsafe whatever the pace, and nothing to divide by.
      state = "unsafe";
      missing.ratio = "reserve_reached";
      reserveReach = { atPace: "already", seconds: 0, at: input.asOf };
    }
    if (observed === null) {
      for (const field of ["exhaustion", ...(above > 0 ? ["ratio", "reserveReach", "state"] : [])]) {
        missing[field] = "input_missing";
        missingInputs[field] = ["observed"];
      }
    } else {
      exhaustion = exhaustionAtPace(remaining, observed.percentPerHour, secondsToReset!, input.asOf);
      if (above > 0) {
        ratio = observed.percentPerHour / sustainable;
        state = ratio >= UNSAFE_PRESSURE ? "unsafe" : "within";
        reserveReach = exhaustionAtPace(above, observed.percentPerHour, secondsToReset!, input.asOf);
      }
    }
  }
  missing.safeConcurrency = "policy_not_defined";
  if (state !== null) delete missing.state;

  return {
    observed,
    lastReadingAgeSeconds,
    reservePercent: reserve,
    sustainablePercentPerHour: sustainable,
    ratio,
    state,
    exhaustion,
    reserveReach,
    safeConcurrency: null,
    confidence,
    missing,
    missingInputs,
  };
}
