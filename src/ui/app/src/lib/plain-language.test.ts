/**
 * The plain-language layer (lib/plain-language.ts): the rounding, the phrasing and THE status
 * mapping. Payload-level behaviour is pinned against the real server in
 * detail/forecast-e2e.test.tsx; this file pins the edges no scenario reaches cheaply: every
 * rounding band, every fraction, every status threshold on both sides, a lower bound, a low
 * confidence, an unknown, a leaf in review, and no samples.
 */
import { describe, expect, it } from "vitest";
import {
  AWAITING_HEADLINE,
  STATUS_THRESHOLDS,
  accuracyHeadline,
  barPercent,
  cohortConfidence,
  cohortName,
  cohortSentence,
  confidenceHeadline,
  forecastHeadline,
  gaugeDescription,
  inTen,
  limitHeadline,
  limitName,
  limitSentence,
  limitStatus,
  pathHeadline,
  plainCountdown,
  plainDuration,
  plainLimitReason,
  plainMissing,
  plainRange,
  plainRatio,
  plainRatioRange,
  rangeDescription,
  ratioFigure,
} from "./plain-language";
import type { BudgetLimitForecast, BudgetReserveCheck, BudgetWorkProjection, CalibrationCohort, CompletionForecast, RemainingFigure } from "./types";

const H = 3600;

// ------------------------------------------------------------------ fixtures

const spread = (lower: number, p10: number, p90: number, upper: number) => ({ mean: (p10 + p90) / 2, p10, p50: (p10 + p90) / 2, p90, band: { lower, upper, nominal: 0.9 } });
const figure = (over: Partial<RemainingFigure> = {}): RemainingFigure => ({ expectedSeconds: 15 * H, partial: false, missing: [], simulated: spread(13 * H, 14 * H, 21 * H, 23 * H), ...over });

function completion(over: Partial<CompletionForecast> = {}, units: Partial<CompletionForecast["units"]> = {}): CompletionForecast {
  return {
    set: "exact",
    units: { total: 3, done: 0, awaitingReview: 0, forecast: 3, known: 3, unknownRefs: [], awaitingReviewRefs: [], items: [], truncated: false, ...units },
    settled: false,
    review: { units: 0, refs: [], seconds: null, missing: {} },
    plan: { seconds: null, source: "none" as never, ownSeconds: null, descendantsSeconds: null },
    labor: figure(),
    path: { ...figure({ expectedSeconds: 8.5 * H }), chain: [], chainLength: 0, edgeCount: 0, cycle: [], crossSubtreeBlockerCount: 0, unresolvedCrossSubtreeBlockerCount: 0, crossSubtreeBlockers: [] },
    confidence: { label: "medium", nominal: 0.9, achieved: 0.8, reached: false, reasons: [] },
    warnings: [],
    ...over,
  };
}

const expectedSpread = (expected: number) => ({ expected, simulated: spread(expected, expected, expected, expected) });

function work(over: Partial<BudgetWorkProjection> = {}): BudgetWorkProjection {
  return {
    consumedPercent: expectedSpread(20),
    beforeResetPercent: expectedSpread(20),
    remainingAtResetPercent: expectedSpread(58),
    outlastsResetProbability: 0,
    nextWindowRemainingPercent: null,
    windows: spread(1, 1, 1, 1),
    exhaustionProbability: 0,
    currentWindowExhaustionProbability: 0,
    lowerBound: false,
    ...over,
  };
}

function reserve(over: Partial<BudgetReserveCheck> = {}): BudgetReserveCheck {
  return {
    percent: 20,
    source: "provisional_default",
    note: null,
    basis: "work_alone",
    scope: "through_the_work",
    breachProbability: 0,
    currentWindowBreachProbability: 0,
    alreadyBelow: false,
    draws: 1000,
    withOtherUse: null,
    confidence: { label: "medium", spans: 6, minimum: 5, warnings: [] },
    missing: {},
    missingInputs: {},
    ...over,
  };
}

function limit(over: Partial<BudgetLimitForecast> = {}): BudgetLimitForecast {
  return {
    limitKey: "five_hour",
    windowId: "w",
    status: null,
    resetsAt: null,
    secondsToReset: 3 * H + 56 * 60,
    windowSeconds: 5 * H,
    remainingPercent: 78,
    highWaterPercent: null,
    stale: false,
    quality: { state: "exact", reasons: [] },
    pace: null,
    exhaustion: null,
    workRate: null,
    otherUse: null,
    work: work(),
    reserve: reserve(),
    missing: {},
    missingInputs: {},
    ...over,
  };
}

function cohort(over: Partial<CalibrationCohort> = {}, ratio: Partial<CalibrationCohort["ratio"]> = {}): CalibrationCohort {
  const interval = (lower: number, upper: number, confidence: number) => ({ lower, upper, ranks: [1, 2] as const, confidence, reached: confidence >= 0.9 });
  return {
    set: "exact",
    key: { kind: "bug", priority: "high", workType: "unknown", area: "unknown", model: "unknown" },
    keySamples: 13,
    level: 0,
    levelName: "full",
    class: { kind: "bug", priority: "high", workType: "unknown", area: "unknown", model: "unknown" },
    path: [{ level: 0, name: "full", samples: 13, floors: 0 }],
    fallback: "none",
    samples: 13,
    coverage: { samples: 13, eligible: 20, fraction: 0.65, denominator: "ratio_population" },
    ratio: {
      median: 0.08,
      pooled: 0.083,
      min: 0.02,
      max: 0.3,
      expected: { value: 0.083, method: "pooled" },
      quantiles: { p10: 0.05, p25: 0.06, p50: 0.08, p75: 0.12, p90: 0.2 },
      intervals: null,
      bounds: interval(0.03, 0.3, 0.86),
      ...ratio,
    },
    workSeconds: { median: 600, total: 6000, min: 60, max: 3000, quantiles: null, intervals: null, bounds: null },
    tail: { tested: false, outliers: { lower: 0, upper: 0 }, share: null, heavy: false, fences: null, scale: null, fenceClippedPooled: null },
    floors: { count: 0, share: null, dominated: false, seconds: 60, refs: [], truncated: false },
    rangeConfidence: 0.9,
    estimatedSeconds: { total: 0 },
    estimateSources: { at_start: 0, current: 0 },
    members: { total: 13, refs: [], truncated: false },
    excluded: { count: 0, counts: {}, reasons: {} },
    warnings: ["bounds_below_confidence"],
    ...over,
  };
}

// ------------------------------------------------------------------ rounding

describe("durations, rounded as a person says them", () => {
  it("rounds each band as documented", () => {
    expect(plainDuration(30).text).toBe("less than a minute");
    expect(plainDuration(59).text).toBe("less than a minute");
    expect(plainDuration(60).text).toBe("5 minutes");
    expect(plainDuration(40 * 60 + 100).text).toBe("40 minutes");
    expect(plainDuration(2999).text).toBe("50 minutes");
    expect(plainDuration(3000).text).toBe("1 hour");
    expect(plainDuration(1.5 * H).text).toBe("1½ hours");
    expect(plainDuration(8.4 * H).text).toBe("8½ hours");
    expect(plainDuration(9.9 * H).text).toBe("10 hours");
    expect(plainDuration(15.4 * H).text).toBe("15 hours");
    expect(plainDuration(139 * H).text).toBe("140 hours");
    // Effort, never days: 139 hours of work is not "5 days".
    expect(plainDuration(139 * H).text).not.toMatch(/day/);
  });

  it("shares the unit across a range, collapses equal ends, and names mixed units in full", () => {
    expect(plainRange(14 * H, 21 * H)).toBe("between 14 and 21 hours");
    expect(plainRange(40 * 60, 2 * H)).toBe("between 40 minutes and 2 hours");
    expect(plainRange(15 * H, 15.2 * H)).toBe("about 15 hours");
    expect(plainRange(10, 30)).toBe("less than a minute");
  });

  it("writes a reset countdown the way a clock does", () => {
    expect(plainCountdown(3 * H + 56 * 60)).toBe("3h 56m");
    expect(plainCountdown(3 * H)).toBe("3h");
    expect(plainCountdown(25 * 60)).toBe("25 minutes");
    expect(plainCountdown(30)).toBe("1 minute");
    expect(plainCountdown(4 * 86_400 + H)).toBe("4 days 1h");
    expect(plainCountdown(86_400)).toBe("1 day");
  });
});

describe("estimate ratios in words", () => {
  it("finds the nearest everyday fraction by ratio", () => {
    expect(plainRatio(0.2).sentence).toBe("about a fifth of the estimate");
    expect(plainRatio(0.08).sentence).toBe("about 1/13 of the estimate");
    expect(plainRatio(0.083).words).toBe("1/12");
    expect(plainRatio(0.5).words).toBe("half");
    expect(plainRatio(0.33).words).toBe("a third");
    expect(plainRatio(0.26).words).toBe("a quarter");
    expect(plainRatio(0.7).words).toBe("two thirds");
    expect(plainRatio(0.79).words).toBe("three quarters");
    expect(plainRatio(0.04).sentence).toBe("less than 1/20 of the estimate");
  });

  it("says about as long as estimated from 0.9 to 1.1, and multiples above", () => {
    expect(plainRatio(0.9).kind).toBe("same");
    expect(plainRatio(1.1).sentence).toBe("about as long as estimated");
    expect(plainRatio(0.89).kind).toBe("fraction");
    expect(plainRatio(1.11).kind).toBe("times");
    expect(plainRatio(1.5).sentence).toBe("about 1½ times as long as estimated");
    expect(plainRatio(2.1).words).toBe("twice");
    expect(plainRatio(2.6).words).toBe("2½ times");
    expect(plainRatio(4.4).words).toBe("4 times");
  });

  it("writes ranges and figures from the same words", () => {
    expect(plainRatioRange(0.14, 0.25)).toBe("between 1/7 and a quarter of the estimate");
    expect(plainRatioRange(0.5, 1.5)).toBe("between half of the estimate and 1½ times the estimate");
    expect(plainRatioRange(0.2, 0.21)).toBe("about a fifth of the estimate");
    expect(ratioFigure(0.79)).toBe("About ¾ of the estimate");
    expect(ratioFigure(0.083)).toBe("About 1/12 of the estimate");
    expect(ratioFigure(1)).toBe("About as estimated");
    expect(ratioFigure(2)).toBe("About twice the estimate");
  });
});

// ------------------------------------------------------------------ the forecast

describe("the forecast headline", () => {
  it("leads with the expected figure and the likely range (p10 to p90)", () => {
    const headline = forecastHeadline(completion(), "full");
    expect(headline).toEqual({ sentence: "This should take about 15 hours of work — probably between 14 and 21 hours.", figure: "15 hours" });
    expect(forecastHeadline(completion(), "compact").sentence).toBe("About 15 hours of work is left on this task — probably between 14 and 21 hours.");
  });

  it("keeps a lower bound as 'at least', says why, and gives no range it cannot promise", () => {
    const partial = completion({ labor: figure({ partial: true }) }, { unknownRefs: ["STA-1", "STA-2"] });
    const headline = forecastHeadline(partial, "full");
    expect(headline.sentence).toBe("At least 15 hours of work is left, probably more: 2 tasks can't be estimated yet.");
    expect(headline.figure).toBe("at least 15 hours");
    expect(forecastHeadline(completion({ labor: figure({ partial: true }) }), "compact").sentence).toContain("part of it can't be estimated yet");
  });

  it("says it can't tell yet, with the payload's reason, when the figure is unknown — never 0", () => {
    const unknown = completion({ labor: figure({ expectedSeconds: null, missing: ["no_forecast"], simulated: null }) });
    const headline = forecastHeadline(unknown, "full");
    expect(headline).toEqual({ sentence: "We can't tell yet how long this will take: none of the remaining tasks can be estimated yet.", figure: null });
    expect(headline.sentence).not.toMatch(/\b0\b/);
    expect(forecastHeadline(completion({ labor: figure({ expectedSeconds: null, missing: [], simulated: null }) }), "full").sentence).toContain("no reason was given");
  });

  it("says a settled forecast is done", () => {
    expect(forecastHeadline(completion({ settled: true }), "full").sentence).toBe("Everything here is done: there is nothing left to forecast.");
  });

  it("says a leaf in review has nothing left to forecast and that the wait is not work", () => {
    expect(AWAITING_HEADLINE).toMatch(/^This task is waiting for review, so there's no work left to forecast\./);
    expect(AWAITING_HEADLINE).toContain("isn't counted as work");
  });

  it("phrases the critical path, lower bound and unknown included", () => {
    expect(pathHeadline(figure({ expectedSeconds: 8.5 * H })).sentence).toBe("About 8½ hours of it has to happen one step after another, however many people work on it.");
    expect(pathHeadline(figure({ expectedSeconds: 8.5 * H, partial: true }))).toEqual({ sentence: "At least 8½ hours of it has to happen one step after another.", figure: "at least 8½ hours" });
    expect(pathHeadline(figure({ expectedSeconds: null, missing: ["dependency_cycle"] })).sentence).toBe(
      "We can't tell how much of it has to happen in order: the tasks depend on each other in a loop.",
    );
  });

  it("describes the likely-range bar in words, with 'or more' on a lower bound", () => {
    expect(rangeDescription(figure())).toBe(
      "Likely between 14 and 21 hours (8 in 10 chances). Very likely between 13 and 23 hours (9 in 10). Expected: about 15 hours.",
    );
    expect(rangeDescription(figure({ partial: true }))).toBe(
      "Likely between 14 and 21 hours, or more (8 in 10 chances). Very likely between 13 and 23 hours, or more (9 in 10). Expected: at least 15 hours.",
    );
    expect(rangeDescription(figure({ simulated: null }))).toBeNull();
    expect(rangeDescription(figure({ expectedSeconds: null }))).toBeNull();
  });
});

describe("confidence in words", () => {
  it("names the label, what it rests on, and why it is not surer", () => {
    expect(confidenceHeadline({ label: "high", nominal: 0.9, achieved: 0.95, reached: true, reasons: [] }, 25)).toBe("Quite sure: based on 25 finished tasks with measured time.");
    expect(confidenceHeadline({ label: "medium", nominal: 0.9, achieved: 0.8, reached: false, reasons: ["bounds_below_confidence", "awaiting_review"] }, 8)).toBe(
      "Fairly sure: based on 8 finished tasks with measured time. Why not surer: there isn't enough history yet to be sure; time waiting for review isn't included.",
    );
  });

  it("says each reason once, and reads an unknown code as its label rather than nothing", () => {
    const line = confidenceHeadline({ label: "low", nominal: 0.9, achieved: 0.5, reached: false, reasons: ["small_sample", "bounds_below_confidence", "brand_new"] }, 1);
    expect(line).toBe("Rough guess: based on 1 finished task with measured time. Why not surer: there isn't enough history yet to be sure; brand new.");
  });

  it("with no samples, says there is nothing to learn from yet", () => {
    expect(confidenceHeadline({ label: "low", nominal: 0.9, achieved: null, reached: false, reasons: ["no_samples"] }, 0)).toBe(
      "Rough guess: there are no finished tasks with measured time to learn from yet. Why not surer: there are no finished tasks to learn from yet.",
    );
  });
});

// ------------------------------------------------------------------ the status mapping

describe("limitStatus: the one status mapping", () => {
  it("is Unknown with no reading, and Unknown with no projection of this work", () => {
    expect(limitStatus(limit({ remainingPercent: null }))).toEqual({ status: "unknown", reason: "no_reading" });
    expect(limitStatus(limit({ work: null }))).toEqual({ status: "unknown", reason: "no_projection" });
    expect(limitStatus(limit({ reserve: null }))).toEqual({ status: "unknown", reason: "no_projection" });
    expect(limitStatus(limit({ reserve: reserve({ breachProbability: null }) }))).toEqual({ status: "unknown", reason: "no_projection" });
  });

  it("is At risk when already under the reserve, even with nothing projected", () => {
    expect(limitStatus(limit({ work: null, reserve: reserve({ alreadyBelow: true, breachProbability: null }) }))).toEqual({ status: "at_risk", reason: "already_below" });
  });

  it("is At risk when the work alone runs the limit out", () => {
    expect(limitStatus(limit({ work: work({ remainingAtResetPercent: expectedSpread(-5) }) }))).toEqual({ status: "at_risk", reason: "runs_out" });
    expect(limitStatus(limit({ work: work({ remainingAtResetPercent: expectedSpread(0) }) })).status).toBe("on_track");
  });

  it("maps the breach probability at the documented thresholds, both sides of each", () => {
    expect(STATUS_THRESHOLDS).toEqual({ tight: 0.1, atRisk: 0.5 });
    const at = (p: number) => limitStatus(limit({ reserve: reserve({ breachProbability: p }) })).status;
    expect(at(0)).toBe("on_track");
    expect(at(0.0999)).toBe("on_track");
    expect(at(0.1)).toBe("tight");
    expect(at(0.4999)).toBe("tight");
    expect(at(0.5)).toBe("at_risk");
    expect(at(1)).toBe("at_risk");
  });

  it("moves a lower-bound burn one step worse: 'On track' is never claimed from part of the work", () => {
    const lower = (p: number) => limitStatus(limit({ work: work({ lowerBound: true }), reserve: reserve({ breachProbability: p }) }));
    expect(lower(0)).toEqual({ status: "tight", reason: "lower_bound" });
    expect(lower(0.2)).toEqual({ status: "at_risk", reason: "lower_bound" });
    expect(lower(0.7)).toEqual({ status: "at_risk", reason: "lower_bound" });
  });

  it("does not change the word for a low-confidence rate; the sentence says 'rough guess'", () => {
    const low = limit({ reserve: reserve({ confidence: { label: "low", spans: 1, minimum: 5, warnings: ["small_sample"] } }) });
    expect(limitStatus(low).status).toBe("on_track");
    expect(limitHeadline(low)).toBe("78% left, resets in 3h 56m. This work fits comfortably (a rough guess: little usage measured so far).");
  });
});

describe("budget sentences", () => {
  it("says each status in words, with 'at least' wherever the burn is a lower bound", () => {
    expect(limitHeadline(limit())).toBe("78% left, resets in 3h 56m. This work fits comfortably.");
    expect(limitHeadline(limit({ reserve: reserve({ breachProbability: 0.2 }) }))).toBe("78% left, resets in 3h 56m. This work might dip into the 20% safety reserve (20% chance).");
    expect(limitHeadline(limit({ reserve: reserve({ breachProbability: 0.6 }) }))).toBe(
      "78% left, resets in 3h 56m. This work will probably dip into the 20% safety reserve (60% chance).",
    );
    expect(limitHeadline(limit({ work: work({ lowerBound: true }) }))).toBe(
      "78% left, resets in 3h 56m. This work should fit, but only part of it could be measured, so it may use more.",
    );
    expect(limitHeadline(limit({ work: work({ lowerBound: true }), reserve: reserve({ breachProbability: 0.2 }) }))).toBe(
      "78% left, resets in 3h 56m. This work might dip into the 20% safety reserve (at least 20% chance), and it may use more than we could measure.",
    );
    expect(limitHeadline(limit({ reserve: reserve({ alreadyBelow: true, percent: 90 }) }))).toBe("78% left, resets in 3h 56m. It's already below the 90% safety reserve.");
    expect(limitHeadline(limit({ work: work({ remainingAtResetPercent: expectedSpread(-3) }) }))).toBe("78% left, resets in 3h 56m. This work alone would use it up before it resets.");
  });

  it("says what is unknown and why, in everyday words, never as 0%", () => {
    const unmeasured = limit({ work: null, missing: { work: "input_missing" }, missingInputs: { work: ["attempt_burn"] } });
    expect(limitHeadline(unmeasured)).toBe("78% left, resets in 3h 56m. We can't tell yet what this work does to it: no usage has been measured for this project on this account yet.");
    const stale = limit({ remainingPercent: null, secondsToReset: null, missing: { remainingPercent: "window_elapsed" } });
    expect(limitHeadline(stale)).toBe("We can't tell how much is left: the limit has reset since the last reading.");
    expect(limitSentence(stale).opening).toBeNull();
    expect(plainLimitReason(limit({ quality: { state: "missing", reasons: ["stale"] } }), "work")).toBe("the last reading is more than 10 minutes old");
    expect(plainLimitReason(limit(), "work")).toBe("no reason was given");
    expect(plainMissing("brand_new_code")).toBe("brand new code");
  });

  it("splits the sentence so a card showing '78% left' does not repeat it", () => {
    expect(limitSentence(limit())).toEqual({ opening: "78% left, resets in 3h 56m.", reset: "Resets in 3h 56m.", verdict: "This work fits comfortably." });
    expect(limitSentence(limit({ secondsToReset: null })).opening).toBe("78% left.");
  });

  it("describes the gauge's every mark, with at least / at most on a lower bound", () => {
    expect(gaugeDescription(limit())).toBe("78% left now. This work would use 20%, leaving about 58% when it resets. Safety reserve: 20%.");
    expect(gaugeDescription(limit({ work: work({ lowerBound: true }) }))).toBe("78% left now. This work would use at least 20%, leaving at most 58% when it resets. Safety reserve: 20%.");
    expect(gaugeDescription(limit({ work: work({ remainingAtResetPercent: expectedSpread(-4), consumedPercent: expectedSpread(82) }) }))).toBe(
      "78% left now. This work would use 82%, more than is left before it resets. Safety reserve: 20%.",
    );
    expect(gaugeDescription(limit({ work: null, reserve: null }))).toBe("78% left now. What this work would use is unknown.");
    expect(gaugeDescription(limit({ remainingPercent: null }))).toBe("No reading: how much is left is unknown.");
  });

  it("names a limit from its window, else from its key", () => {
    expect(limitName({ limitKey: "x", windowSeconds: 5 * H })).toBe("5-hour limit");
    expect(limitName({ limitKey: "x", windowSeconds: 604_800 })).toBe("Weekly limit");
    expect(limitName({ limitKey: "x", windowSeconds: 86_400 })).toBe("Daily limit");
    expect(limitName({ limitKey: "seven_day", windowSeconds: null })).toBe("Weekly limit");
    expect(limitName({ limitKey: "codex.primary", windowSeconds: null })).toBe("Codex primary limit");
  });
});

// ------------------------------------------------------------------ estimate accuracy

describe("estimate accuracy in words", () => {
  it("writes a cohort as the sentences the page shows", () => {
    expect(cohortSentence(cohort())).toEqual({
      answer: "Bug fixes, high priority: usually take about 1/12 of the estimate.",
      basis: "Based on 13 finished tasks.",
      confidence: "Rough guess: not enough data to be sure.",
      fallback: null,
    });
  });

  it("says where a fallen-back cohort's figure comes from", () => {
    expect(cohortSentence(cohort({ fallback: "below_minimum", levelName: "all" })).fallback).toBe("Too few of these alone, so this uses all finished work.");
    expect(cohortSentence(cohort({ fallback: "below_minimum", levelName: "kind" })).fallback).toBe("Too few of these alone, so this uses all bug fixes.");
    expect(cohortSentence(cohort({ fallback: "below_minimum", levelName: "without_model" })).fallback).toBe("Too few of these alone, so this uses a broader group of similar work.");
  });

  it("grades a cohort's confidence from its own fields", () => {
    const reached = { lower: 0.1, upper: 0.3, ranks: [1, 20] as const, confidence: 0.92, reached: true };
    expect(cohortConfidence(cohort({ warnings: [] }, { bounds: reached })).word).toBe("Quite sure");
    expect(cohortConfidence(cohort({ warnings: ["quantile_below_confidence"] }, { bounds: reached })).word).toBe("Fairly sure");
    expect(cohortConfidence(cohort({ warnings: ["small_sample"] }, { bounds: reached })).word).toBe("Rough guess");
    expect(cohortConfidence(cohort()).word).toBe("Rough guess");
    expect(cohortConfidence(cohort({ samples: 0 })).level).toBe("unknown");
    expect(cohortConfidence(cohort({}, { bounds: null })).level).toBe("unknown");
  });

  it("names a cohort without the dimensions nobody recorded", () => {
    expect(cohortName({ kind: "task", priority: "*", workType: "unknown", area: "ui", model: "*" })).toBe("Tasks, area ui");
    expect(cohortName({ kind: "*", priority: "*", workType: "*", area: "*", model: "*" })).toBe("All work");
    expect(cohortName({ kind: "spike", priority: "low", workType: "unknown", area: "unknown", model: "unknown" })).toBe("Spikes, low priority");
  });

  it("opens the page with up to three cohorts in the payload's order, and how many follow", () => {
    const task = cohort({ key: { kind: "task", priority: "high", workType: "unknown", area: "unknown", model: "unknown" } }, { expected: { value: 0.2, method: "pooled" } });
    expect(accuracyHeadline([task, cohort()])).toBe("Tasks, high priority usually take about a fifth of the estimate; bug fixes, high priority about 1/12.");
    expect(accuracyHeadline([task, cohort(), task, cohort()])).toMatch(/, and 1 more group below\.$/);
    const same = cohort({}, { expected: { value: 1, method: "pooled" } });
    expect(accuracyHeadline([task, same])).toBe("Tasks, high priority usually take about a fifth of the estimate; bug fixes, high priority about as long as estimated.");
    expect(accuracyHeadline([])).toBe("We can't tell yet: there are no finished tasks with measured time to compare with their estimates.");
  });
});

describe("geometry", () => {
  it("positions a value on a bar, clamped, and never divides by nothing", () => {
    expect(barPercent(50, 200)).toBe(25);
    expect(barPercent(-5, 100)).toBe(0);
    expect(barPercent(150, 100)).toBe(100);
    expect(barPercent(5, 0)).toBe(0);
    expect(barPercent(Number.NaN, 10)).toBe(0);
  });

  it("says a coverage in tens, never '0 in 10'", () => {
    expect(inTen(0.9)).toBe("9 in 10");
    expect(inTen(0.778)).toBe("8 in 10");
    expect(inTen(0.02)).toBe("under 1 in 10");
  });
});
