import { describe, expect, it } from "vitest";
import {
  accountAbsentText,
  machineAbsentText,
  perHourText,
  percentText,
  pressureStateText,
  reachText,
  tickSeconds,
  whyUnknown,
} from "./budget-text";
import type { BudgetAccountView, LimitPressure } from "./types";

const pressure = (fields: Partial<LimitPressure>): LimitPressure => ({
  provisional: true,
  observed: null,
  lastReadingAgeSeconds: null,
  secondsToReset: null,
  reservePercent: 20,
  sustainablePercentPerHour: null,
  ratio: null,
  state: null,
  exhaustion: null,
  reserveReach: null,
  safeConcurrency: null,
  confidence: null,
  missing: {},
  missingInputs: {},
  ...fields,
});

describe("budget text", () => {
  it("formats paces and percents without inventing precision", () => {
    expect(perHourText(4)).toBe("4%/h");
    expect(perHourText(0.25)).toBe("0.3%/h");
    expect(perHourText(16.54)).toBe("17%/h");
    expect(percentText(40.3)).toBe("40.3%");
    expect(percentText(40)).toBe("40%");
  });

  it("ticks a countdown down and an age up, never below 0", () => {
    expect(tickSeconds(100, 30, "down")).toBe(70);
    expect(tickSeconds(10, 30, "down")).toBe(0);
    expect(tickSeconds(60, 5, "up")).toBe(65);
  });

  it("says the state in a word, and an unknown state with its reason, never as within", () => {
    expect(pressureStateText(pressure({ state: "unsafe", ratio: 4 }), 1)).toEqual({ tone: "unsafe", word: "Unsafe", detail: "pace is ×4.00 the sustainable pace (unsafe at ×1.00)" });
    expect(pressureStateText(pressure({ state: "unsafe", missing: { ratio: "reserve_reached" } }), 1)).toMatchObject({ word: "Unsafe", detail: "already at or under the reserve" });
    expect(pressureStateText(pressure({ state: "within", ratio: 0.24 }), 1)).toMatchObject({ tone: "within", word: "Within" });
    expect(pressureStateText(pressure({ missing: { state: "stale" } }), 1)).toEqual({ tone: "unknown", word: "Unknown", detail: "the latest reading is over 10 minutes old" });
    expect(pressureStateText(pressure({ missing: { state: "input_missing" }, missingInputs: { state: ["observed"] } }), 1).detail).toBe("no observed pace yet");
  });

  it("names the policy that safe concurrency waits for", () => {
    expect(whyUnknown(pressure({ missing: { safeConcurrency: "policy_not_defined" } }), "safeConcurrency")).toBe("needs the admission policy, which is not built yet");
    expect(whyUnknown(pressure({}), "safeConcurrency")).toBeNull();
  });

  it("says when the pace reaches the reserve", () => {
    expect(reachText({ atPace: "already", seconds: 0, at: "x" })).toBe("already at or under it");
    expect(reachText({ atPace: "before_reset", seconds: 1800, at: "x" })).toBe("in 30m, before the reset");
    expect(reachText({ atPace: "never", seconds: null, at: null })).toBe("never, at a pace of 0");
  });

  it("explains an account or a machine with nothing, with the setup hint", () => {
    const account = (missing: Record<string, string>, bound: boolean): BudgetAccountView => ({ provider: null, accountRef: "a", bound, limits: [], missing });
    expect(accountAbsentText(account({ limits: "source_unavailable" }, false), true)).toMatchObject({ reason: "Unknown: no source is bound to it.", hint: expect.stringContaining("`staple budget setup --claude-account <label> --codex-account <label>`") });
    expect(accountAbsentText(account({ limits: "source_unavailable" }, true), false).reason).toBe("Unknown: budget capture is off.");
    expect(accountAbsentText(account({ limits: "no_sample_yet" }, true), true).reason).toMatch(/^No reading yet/);
    expect(machineAbsentText({ budgetCapture: false, accounts: [] })?.reason).toMatch(/capture is off/);
    expect(machineAbsentText({ budgetCapture: true, accounts: [account({}, true)] })).toBeNull();
  });
});
