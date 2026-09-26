/**
 * The words and number formats of the Budget view (views/budget/BudgetView.tsx).
 *
 * As lib/forecast-text.ts: every figure is a field of `GET /api/budget` (`staple budget --json`),
 * and this module only turns a field into text. It never divides or compares two figures, so the
 * page cannot disagree with the CLI; pressure, sustainable pace and the reserve reach are the
 * store's (src/core/telemetry/budget-pressure.ts). The ONE exception is the ticking clock:
 * `tickSeconds` moves a countdown or an age by the seconds the page has held the payload, so a
 * reset countdown keeps counting between reads. That is the page's own clock since the answer
 * arrived, not a comparison of the server's instants with the browser's, so a phone whose clock
 * is off still counts right.
 *
 * Pure and tested (budget-text.test.ts).
 */
// Relative, as forecast-text.ts explains: a pure module stays resolvable without the alias.
import { formatDuration } from "../detail/analytics";
import { MISSING_TEXT, formatPercent, missingText } from "./forecast-text";
import type { BudgetAccountView, BudgetLimitReading, BudgetView, LimitPressure, ReserveReach } from "./types";

/** How often the page re-reads the budget. Readings arrive at a status line's pace, not faster. */
export const BUDGET_REFRESH_MS = 30_000;

/** The reasons this view adds to forecast-text's: pressure's own, and its missing inputs. */
export const PRESSURE_MISSING_TEXT: Record<string, string> = {
  policy_not_defined: "needs the admission policy, which is not built yet",
  reserve_reached: "already at or under the reserve: no pace is sustainable",
  observed: "no observed pace yet",
  not_reported_by_source: "the source does not report it",
};

export function pressureMissingText(code: string): string {
  return PRESSURE_MISSING_TEXT[code] ?? (MISSING_TEXT[code] !== undefined ? missingText(code) : code.replace(/_/g, " "));
}

/** Why `field` of a pressure (or a reading) is null: its code, or the inputs it lacked. Null when no reason was given. */
export function whyUnknown(record: { missing: Record<string, string>; missingInputs?: Record<string, string[]> }, field: string): string | null {
  const code = record.missing[field];
  if (code === undefined) return null;
  const inputs = record.missingInputs?.[field];
  if (code === "input_missing" && inputs && inputs.length > 0) return inputs.map(pressureMissingText).join("; ");
  return pressureMissingText(code);
}

/** The pressure's own confidence warnings, as chips: `small_sample` means readings here. */
export const PRESSURE_WARNING_TEXT: Record<string, { label: string; tip: string }> = {
  small_sample: {
    label: "Few readings",
    tip: "Fewer than 5 readings in this window: the pace, and the pressure from it, rest on very little.",
  },
  short_span: {
    label: "Short span",
    tip: "The readings cover less than 30 minutes: a burst reads as a pace.",
  },
  regressions: {
    label: "Regressions",
    tip: "The provider's figure went down inside this window (an older cached reading): the high-water is kept, the pace may read high.",
  },
};

// ------------------------------------------------------------------ figures

/** A pace in percent of the limit per hour: one decimal under 10, whole above. */
export function perHourText(value: number): string {
  const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
  return `${rounded}%/h`;
}

/** A percent of a limit, one decimal only when it has one: `40%`, `40.3%`. */
export function percentText(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}%`;
}

/** Pressure as a multiplier of the sustainable pace: `×0.24`. */
export function pressureRatioText(ratio: number): string {
  return `×${ratio.toFixed(2)}`;
}

/** A countdown or an age, moved on by the seconds the page has held the payload; never below 0. */
export function tickSeconds(seconds: number, heldSeconds: number, direction: "down" | "up"): number {
  return Math.max(0, direction === "down" ? seconds - heldSeconds : seconds + heldSeconds);
}

/** `12s ago`, `4m ago`. */
export function ageText(seconds: number): string {
  return `${formatDuration(seconds)} ago`;
}

/** The instant as a local wall-clock time, with the day when it is not today: `14:05` or `Sat 09:00`. */
export function clockText(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** `The provisional 20% reserve` / `the 30% reserve`, as forecast-text says it. */
export function reserveText(reserve: BudgetView["reserve"]): string {
  return reserve.source === "provisional_default"
    ? `${formatPercent(reserve.percent)} of each limit, a provisional default until an admission policy sets one`
    : `${formatPercent(reserve.percent)} of each limit, as asked`;
}

// ------------------------------------------------------------------ the pressure state

export type PressureTone = "unsafe" | "within" | "unknown";

/** The state as a word, never a colour alone, and the one line that says why. */
export function pressureStateText(pressure: LimitPressure, unsafeAt: number): { tone: PressureTone; word: string; detail: string } {
  if (pressure.state === "unsafe") {
    if (pressure.ratio === null) return { tone: "unsafe", word: "Unsafe", detail: "already at or under the reserve" };
    return { tone: "unsafe", word: "Unsafe", detail: `pace is ${pressureRatioText(pressure.ratio)} the sustainable pace (unsafe at ${pressureRatioText(unsafeAt)})` };
  }
  if (pressure.state === "within") {
    return { tone: "within", word: "Within", detail: `pace is ${pressureRatioText(pressure.ratio!)} the sustainable pace` };
  }
  return { tone: "unknown", word: "Unknown", detail: whyUnknown(pressure, "state") ?? "no reason given" };
}

/** When the pace reaches the reserve, in words. */
export function reachText(reach: ReserveReach): string {
  if (reach.atPace === "already") return "already at or under it";
  if (reach.atPace === "never") return "never, at a pace of 0";
  const when = `in ${formatDuration(reach.seconds!)}`;
  return reach.atPace === "before_reset" ? `${when}, before the reset` : `${when}, after the reset`;
}

/** When the pace uses the limit up, in words. */
export function exhaustionText(exhaustion: NonNullable<LimitPressure["exhaustion"]>): string {
  if (exhaustion.atPace === "never") return "never, at a pace of 0";
  const when = `in ${formatDuration(exhaustion.seconds!)}`;
  return exhaustion.atPace === "before_reset" ? `${when}, before the reset` : `${when}, after the reset`;
}

// ------------------------------------------------------------------ what is unknown, and what to do

/** The command that sets collection up (and its long form, for a build without it). */
export const SETUP_HINT = "Set up collection with `staple budget setup`, or `staple budget capture on` and `staple budget bind`.";

/** Why the whole machine shows nothing, with what to do about it. */
export function machineAbsentText(view: Pick<BudgetView, "budgetCapture" | "accounts">): { reason: string; hint: string } | null {
  if (view.accounts.length > 0) return null;
  if (!view.budgetCapture) return { reason: "Budget capture is off on this machine, and no account has readings.", hint: SETUP_HINT };
  return { reason: "Capture is on, but no account is bound and no reading has arrived.", hint: SETUP_HINT };
}

/** Why an account has no limits: its `missing.limits`, with what to do about it. */
export function accountAbsentText(account: BudgetAccountView, budgetCapture: boolean): { reason: string; hint: string | null } {
  const code = account.missing.limits;
  if (code === "no_sample_yet") {
    return {
      reason: "No reading yet: capture is on and a source is bound, and nothing has arrived.",
      hint: "Readings arrive with the next status-line render, or `staple budget collect` for Codex.",
    };
  }
  if (code === "source_unavailable") {
    const why = !budgetCapture ? "budget capture is off" : account.bound ? "no ingestion path runs for it" : "no source is bound to it";
    return { reason: `Unknown: ${why}.`, hint: SETUP_HINT };
  }
  return { reason: `Unknown: ${code === undefined ? "no limits read" : pressureMissingText(code)}.`, hint: null };
}

/**
 * A limit with no current window: nothing about it can be measured now. One line says why
 * (`window_elapsed`: nothing carries across a reset; `reset_not_reported`: the reading joins no
 * window), instead of every figure repeating it.
 */
export function noWindowText(limit: BudgetLimitReading): { reason: string; hint: string | null } | null {
  if (limit.status === "current") return null;
  const code = limit.missing.remainingPercent ?? limit.missing.window;
  const reason = `Unknown: ${code === undefined ? "no current window" : pressureMissingText(code)}.`;
  if (code === "window_elapsed") return { reason, hint: "Nothing carries across a reset: the next reading starts the new window." };
  if (code === "reset_not_reported") return { reason, hint: "A reading without a reset instant joins no window; a typed reading takes --resets-at." };
  return { reason, hint: null };
}

/** A limit's remaining figure, or unknown with the reading's reason. */
export function remainingText(limit: BudgetLimitReading): { value: string | null; absent: string | null } {
  if (limit.remainingPercent !== null) return { value: `${formatPercent(limit.remainingPercent)} left`, absent: null };
  const reason = whyUnknown(limit, "remainingPercent") ?? limit.quality.reasons.map(pressureMissingText).join("; ");
  return { value: null, absent: reason ? `Unknown: ${reason}` : "Unknown" };
}

/** How the reading arrived: `status line`, `Codex rollout`, `typed by hand`. */
export function sourceText(kind: string): string {
  return ({ claude_code_statusline: "status line", codex_rollout: "Codex rollout", operator_manual: "typed by hand" } as Record<string, string>)[kind] ?? kind.replace(/_/g, " ");
}
