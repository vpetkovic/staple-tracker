/**
 * The forecast pages' words and formats (lib/forecast-text.ts). The payload-level behaviour is
 * pinned against the real server in detail/forecast-e2e.test.tsx; this file pins the edges no
 * scenario reaches cheaply: the ends of a probability, a null that must never read as 0, and the
 * rule for which issues get a forecast.
 */
import { describe, expect, it } from "vitest";
import {
  coverageText,
  confidenceText,
  fallbackText,
  forecastMode,
  formatConfidence,
  formatProbability,
  formatRatio,
  limitMissingText,
  limitRemainingText,
  missingText,
  remainingText,
  reserveLabel,
  resetText,
  warningText,
  RATE_WARNING_TEXT,
} from "./forecast-text";
import type { BudgetLimitForecast, RemainingFigure } from "./types";

const spread = { mean: 5000, p10: 3600, p50: 5100, p90: 9600, band: { lower: 3000, upper: 10200, nominal: 0.9 } };

function limit(over: Partial<BudgetLimitForecast> = {}): BudgetLimitForecast {
  return {
    limitKey: "five_hour",
    windowId: null,
    status: null,
    resetsAt: null,
    secondsToReset: null,
    windowSeconds: null,
    remainingPercent: null,
    highWaterPercent: null,
    stale: null,
    quality: { state: "missing", reasons: [] },
    pace: null,
    exhaustion: null,
    workRate: null,
    otherUse: null,
    work: null,
    reserve: null,
    missing: {},
    missingInputs: {},
    ...over,
  };
}

describe("probabilities", () => {
  it("never rounds a possible outcome to 0% or a doubtful one to 100%", () => {
    expect(formatProbability(0)).toBe("0%");
    expect(formatProbability(1)).toBe("100%");
    expect(formatProbability(0.004)).toBe("<1%");
    expect(formatProbability(0.996)).toBe(">99%");
    expect(formatProbability(0.5065)).toBe("51%");
  });
});

describe("remaining figures", () => {
  it("names an unknown figure with its reasons and never draws 0", () => {
    const unknown: RemainingFigure = { expectedSeconds: null, partial: true, missing: ["no_forecast"], simulated: null };
    const text = remainingText(unknown);
    expect(text.value).toBeNull();
    expect(text.absent).toBe("Unknown: no unit's remaining work is known");
    expect(text.spread).toBeNull();
  });

  it("says a partial figure is a lower bound", () => {
    const text = remainingText({ expectedSeconds: 5942.86, partial: true, missing: ["unknown_units"], simulated: spread });
    expect(text.value).toBe("at least 1h39m");
    expect(text.lowerBound).toBe(true);
    expect(text.spread).toBe("p10–p90 1h–2h40m");
    expect(text.band).toBe("90% band 50m–2h50m");
  });

  it("reads a whole figure as it is", () => {
    expect(remainingText({ expectedSeconds: 9128.57, partial: false, missing: [], simulated: spread }).value).toBe("2h32m");
  });
});

describe("confidence", () => {
  it("says what the bounds reach against the target, and why it is not high", () => {
    const text = confidenceText({ label: "low", nominal: 0.9, achieved: 0.75, reached: false, reasons: ["unknown_units", "awaiting_review"] });
    expect(text).toEqual({
      label: "Low confidence",
      achieved: "the classes' bounds reach 75% of the 90% target",
      reasons: ["Unknown units", "In review"],
    });
  });

  it("says when no class was drawn from rather than inventing a confidence", () => {
    expect(confidenceText({ label: "high", nominal: 0.9, achieved: null, reached: true, reasons: [] }).achieved).toBe(
      "no unit drew from a class, so no bounds were reached",
    );
    expect(confidenceText({ label: "high", nominal: 0.9, achieved: 0.9, reached: true, reasons: [] }).achieved).toBe(
      "the classes' bounds reach the 90% target",
    );
  });

  it("keeps a decimal only where it carries information", () => {
    expect(formatConfidence(0.9375)).toBe("93.8%");
    expect(formatConfidence(0.75)).toBe("75%");
    expect(formatConfidence(0.777777777778)).toBe("77.8%");
  });
});

describe("reason codes", () => {
  it("has a label and a tooltip for every warning of both closed lists", () => {
    const codes = [
      "small_sample", "bounds_below_confidence", "quantile_below_confidence", "fallback_used", "heavy_tail", "floor_dominated",
      "floors_excluded", "reconstructed_only", "no_samples", "unknown_units", "beyond_class_range", "overrun", "few_admissible",
      "awaiting_review", "independent_draws", "dependency_cycle", "unresolved_outside_blockers",
    ];
    for (const code of codes) {
      const { label, tip } = warningText(code);
      expect(label).not.toBe(code);
      expect(tip.length).toBeGreaterThan(20);
    }
  });

  it("reads a code it does not know as itself rather than as nothing", () => {
    expect(warningText("brand_new_warning")).toEqual({ label: "brand new warning", tip: "brand_new_warning" });
    expect(missingText("brand_new_reason")).toBe("brand new reason");
  });

  it("uses the rate table for the rate's own small_sample", () => {
    expect(warningText("small_sample", RATE_WARNING_TEXT).label).toBe("Few measurements");
    expect(warningText("small_sample").label).toBe("Few samples");
  });

  it("names the missing inputs of an input_missing figure", () => {
    const l = limit({ missing: { workRate: "input_missing", reserve: "stale" }, missingInputs: { workRate: ["attempt_burn"] } });
    expect(limitMissingText(l, "workRate")).toBe("no attempt of this workspace was measured on this account");
    expect(limitMissingText(l, "reserve")).toBe("the latest reading is over 10 minutes old");
    expect(limitMissingText(l, "work")).toBeNull();
  });
});

describe("budget lines", () => {
  it("reads an unknown remaining figure and reset as unknown with the reading's reason", () => {
    const l = limit({ quality: { state: "missing", reasons: ["window_elapsed"] } });
    expect(limitRemainingText(l)).toEqual({ value: null, absent: "Unknown: the window has already reset" });
    expect(resetText(l)).toBe("reset unknown: the window has already reset");
  });

  it("reads a known one as left, and the reset as a countdown", () => {
    const l = limit({ remainingPercent: 78, secondsToReset: 14_280 });
    expect(limitRemainingText(l)).toEqual({ value: "78% left", absent: null });
    expect(resetText(l)).toBe("resets in 3h58m");
  });

  it("always says whose reserve it is", () => {
    expect(reserveLabel({ percent: 20, source: "provisional_default" })).toBe("the provisional 20% reserve");
    expect(reserveLabel({ percent: 30, source: "argument" })).toBe("the 30% reserve");
  });
});

describe("calibration lines", () => {
  it("names the coverage's denominator and keeps a thin share off 0%", () => {
    expect(coverageText({ samples: 7, eligible: 10, fraction: 0.7, denominator: "ratio_population" })).toBe("7 of 10 eligible (70%)");
    expect(coverageText({ samples: 8, eligible: 137, fraction: 0.058394160583941604, denominator: "ratio_population" })).toBe("8 of 137 eligible (5.8%)");
    expect(coverageText({ samples: 0, eligible: 0, fraction: null, denominator: "ratio_population" })).toBe("0 of 0 eligible (no eligible records)");
  });

  it("says how a cohort reached its class", () => {
    expect(fallbackText({ levelName: "full", fallback: "none", keySamples: 7, samples: 7 })).toBe("read at full, its own key");
    expect(fallbackText({ levelName: "all", fallback: "below_minimum", keySamples: 1, samples: 8 })).toBe("fell back to all: its key has 1 sample");
    expect(fallbackText({ levelName: "all", fallback: "below_minimum_everywhere", keySamples: 1, samples: 1 })).toBe(
      "read at all: under the minimum at every level",
    );
  });

  it("writes a ratio as a multiplier", () => {
    expect(formatRatio(0.8452380952380952)).toBe("×0.85");
  });
});

describe("which issues get a forecast", () => {
  it("gives an open parent the full forecast, estimated or not", () => {
    expect(forecastMode({ childCount: 3, estimatedSeconds: null, resolved: false })).toBe("full");
    expect(forecastMode({ childCount: 3, estimatedSeconds: 7200, resolved: false })).toBe("full");
  });

  it("gives an open leaf the compact one only with its own estimate", () => {
    expect(forecastMode({ childCount: 0, estimatedSeconds: 7200, resolved: false })).toBe("compact");
    expect(forecastMode({ childCount: 0, estimatedSeconds: null, resolved: false })).toBeNull();
    expect(forecastMode({ childCount: 0, estimatedSeconds: 0, resolved: false })).toBeNull();
  });

  it("gives nothing to a resolved issue", () => {
    expect(forecastMode({ childCount: 3, estimatedSeconds: null, resolved: true })).toBeNull();
    expect(forecastMode({ childCount: 0, estimatedSeconds: 7200, resolved: true })).toBeNull();
  });
});
