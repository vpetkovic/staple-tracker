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
  FALLBACK_CONFIDENCE,
  STATUS_THRESHOLDS,
  accuracyGroups,
  accuracyHeadline,
  barPercent,
  className,
  cohortConfidence,
  cohortName,
  cohortRangeWords,
  confidenceHeadline,
  forecastHeadline,
  gaugeDescription,
  groupSentence,
  inTen,
  leftFigure,
  limitHeadline,
  limitHelp,
  limitName,
  limitSentence,
  limitStatus,
  notCountedText,
  pathHeadline,
  plainAge,
  plainCountdown,
  plainDuration,
  plainLimitReason,
  plainMissing,
  plainRange,
  plainRatio,
  plainRatioRange,
  providerName,
  rangeWords,
  ratioFigure,
  setSummaryText,
  unreadableLine,
  pressureStatus,
  pressureSentence,
  measuredLine,
  forecastLine,
  plainPace,
  paceUnit,
  aboutText,
  budgetAbsentPlain,
  boundText,
  readingGaugeDescription,
} from "./plain-language";
import type { BudgetLimitReading, LimitPressure } from "./types";
import type { BudgetLimitForecast, BudgetReserveCheck, BudgetWorkProjection, CalibrationCohort, CalibrationSetSummary, CompletionForecast, RemainingFigure } from "./types";

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
    observedAt: "2026-09-26T10:00:00.000Z",
    readingAgeSeconds: 60,
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
    expect(plainDuration(60).text).toBe("a few minutes");
    expect(plainDuration(299).text).toBe("a few minutes");
    expect(plainDuration(300).text).toBe("5 minutes");
    expect(plainDuration(40 * 60 + 100).text).toBe("40 minutes");
    expect(plainDuration(2999).text).toBe("50 minutes");
    // The nearest 5 minutes up to 90 minutes: no jump from "50 minutes" to "1 hour".
    expect(plainDuration(3000).text).toBe("50 minutes");
    expect(plainDuration(3300).text).toBe("55 minutes");
    expect(plainDuration(3600).text).toBe("60 minutes");
    expect(plainDuration(5100).text).toBe("85 minutes");
    expect(plainDuration(5399).text).toBe("90 minutes");
    expect(plainDuration(5400).text).toBe("1½ hours");
    expect(plainDuration(1.5 * H).text).toBe("1½ hours");
    expect(plainDuration(8.4 * H).text).toBe("8½ hours");
    expect(plainDuration(9.9 * H).text).toBe("10 hours");
    expect(plainDuration(15.4 * H).text).toBe("15 hours");
    expect(plainDuration(139 * H).text).toBe("140 hours");
    // Effort, never days: 139 hours of work is not "5 days".
    expect(plainDuration(139 * H).text).not.toMatch(/day/);
  });

  it("puts 'about' only before a number", () => {
    expect(aboutText(plainDuration(15 * H))).toBe("about 15 hours");
    expect(aboutText(plainDuration(120))).toBe("a few minutes");
    expect(aboutText(plainDuration(20))).toBe("less than a minute");
    expect(forecastHeadline(completion({ labor: figure({ expectedSeconds: 120, simulated: null }) }), "full").sentence).toBe("This should take a few minutes of work.");
    expect(pathHeadline(figure({ expectedSeconds: 30 })).sentence).toBe("Less than a minute of it has to happen one step after another, however many people work on it.");
    expect(plainRatio(0.004).words).toBe("a few minutes");
    expect(ratioFigure(0.004)).toBe("A few minutes per 10 estimated hours");
    expect(groupSentence(accuracyGroups([cohort({}, { expected: { value: 0.004, method: "pooled" } })])[0]!).answer).toBe(
      "Bug fixes (high priority): a 10-hour estimate usually takes a few minutes.",
    );
  });

  it("shares the unit across a range, collapses equal ends, and names mixed units in full", () => {
    expect(plainRange(14 * H, 21 * H)).toBe("between 14 and 21 hours");
    expect(plainRange(40 * 60, 2 * H)).toBe("between 40 minutes and 2 hours");
    expect(plainRange(15 * H, 15.2 * H)).toBe("about 15 hours");
    expect(plainRange(10, 30)).toBe("less than a minute");
    expect(plainRange(90, 2 * H)).toBe("between a few minutes and 2 hours");
    // A range that starts under a minute is said by its upper end.
    expect(plainRange(30, 1 * H)).toBe("up to about 60 minutes");
    expect(plainRange(30, 3 * H)).toBe("up to about 3 hours");
    expect(plainRange(30, 200)).toBe("up to a few minutes");
    expect(plainRange(60, 3 * H)).toBe("between a few minutes and 3 hours");
  });

  it("writes a reset countdown the way a clock does, and a reading's age short", () => {
    expect(plainCountdown(3 * H + 56 * 60)).toBe("3h 56m");
    expect(plainCountdown(3 * H)).toBe("3 hours");
    expect(plainCountdown(H)).toBe("1 hour");
    // Rounded once and carried: never "60 minutes" or "0h 60m".
    expect(plainCountdown(3599)).toBe("1 hour");
    expect(plainCountdown(3 * H + 59 * 60 + 50)).toBe("4 hours");
    expect(plainCountdown(84_683)).toBe("23h 31m");
    expect(plainCountdown(25 * 60)).toBe("25 minutes");
    expect(plainCountdown(30)).toBe("1 minute");
    expect(plainCountdown(4 * 86_400 + H)).toBe("4 days 1h");
    expect(plainCountdown(86_400)).toBe("1 day");
    expect(plainAge(12 * 60)).toBe("12 min");
    expect(plainAge(10)).toBe("1 min");
    expect(plainAge(3 * H)).toBe("3h");
    expect(plainAge(3598)).toBe("1h");
    expect(plainAge(84_683)).toBe("1 day");
    expect(plainAge(2 * 86_400)).toBe("2 days");
  });
});

describe("estimate ratios in words", () => {
  it("finds the nearest everyday fraction from a fifth up", () => {
    expect(plainRatio(0.2).sentence).toBe("about a fifth of the estimate");
    expect(plainRatio(0.18).words).toBe("a fifth");
    expect(plainRatio(0.5).words).toBe("half");
    expect(plainRatio(0.33).words).toBe("a third");
    expect(plainRatio(0.26).words).toBe("a quarter");
    expect(plainRatio(0.7).words).toBe("two thirds");
    expect(plainRatio(0.79).words).toBe("three quarters");
  });

  it("says a ratio below a fifth concretely, on a 10-hour estimate, never as 1/12", () => {
    const small = plainRatio(0.083);
    expect(small).toEqual({ kind: "small", words: "50 minutes", sentence: null });
    expect(plainRatio(0.179).kind).toBe("small");
    expect(plainRatio(0.04).words).toBe("25 minutes");
    expect(plainRatio(0.004).words).toBe("a few minutes");
    expect(plainRatio(0.001).words).toBe("less than a minute");
    expect(ratioFigure(0.083)).toBe("About 50 minutes per 10 estimated hours");
    expect(ratioFigure(0.083)).not.toMatch(/1\/\d/);
  });

  it("says about as long as estimated from 0.9 to 1.1, and never hides a small over- or underrun", () => {
    expect(plainRatio(0.9).kind).toBe("same");
    expect(plainRatio(1.1).sentence).toBe("about as long as estimated");
    expect(plainRatio(0.899).sentence).toBe("a little less than estimated");
    expect(plainRatio(0.85).kind).toBe("near");
    expect(plainRatio(0.849).words).toBe("three quarters");
    expect(plainRatio(1.101).sentence).toBe("a little longer than estimated");
    expect(plainRatio(1.124).kind).toBe("near");
    // 1.1 to 1.5 is never "about 1 times": the nearest quarter.
    expect(plainRatio(1.125).words).toBe("1¼ times");
    expect(plainRatio(1.2).sentence).toBe("about 1¼ times as long as estimated");
    expect(plainRatio(1.37).words).toBe("1¼ times");
    expect(plainRatio(1.38).words).toBe("1½ times");
    expect(plainRatio(1.49).words).toBe("1½ times");
    for (const ratio of [1.11, 1.15, 1.2, 1.3, 1.4, 1.49]) expect(plainRatio(ratio).words).not.toBe("1 times");
  });

  it("says multiples from 1.5 by the half, then by the whole", () => {
    expect(plainRatio(1.5).sentence).toBe("about 1½ times as long as estimated");
    expect(plainRatio(2.1).words).toBe("twice");
    expect(plainRatio(2.6).words).toBe("2½ times");
    expect(plainRatio(4.4).words).toBe("4 times");
  });

  it("writes ranges and figures from the same words", () => {
    expect(plainRatioRange(0.25, 0.5)).toBe("between a quarter and half of the estimate");
    expect(plainRatioRange(0.5, 1.5)).toBe("between half of the estimate and 1½ times the estimate");
    expect(plainRatioRange(0.5, 1)).toBe("between half of the estimate and the full estimate");
    expect(plainRatioRange(0.2, 0.21)).toBe("about a fifth of the estimate");
    expect(plainRatioRange(0.14, 0.25)).toBe("for a 10-hour estimate, between 85 minutes and 2½ hours");
    expect(plainRatioRange(0.001, 0.1)).toBe("for a 10-hour estimate, up to about 60 minutes");
    expect(ratioFigure(0.79)).toBe("About ¾ of the estimate");
    expect(ratioFigure(1)).toBe("About as estimated");
    expect(ratioFigure(1.2)).toBe("About 1¼ times the estimate");
    expect(ratioFigure(1.105)).toBe("A little longer than estimated");
    expect(ratioFigure(2)).toBe("About twice the estimate");
  });
});

// ------------------------------------------------------------------ the forecast

describe("the forecast headline", () => {
  it("leads with the expected figure; the range is the bar's to say, once", () => {
    const headline = forecastHeadline(completion(), "full");
    expect(headline).toEqual({ sentence: "This should take about 15 hours of work.", figure: "15 hours" });
    expect(forecastHeadline(completion(), "compact").sentence).toBe("About 15 hours of work is left on this task.");
  });

  it("keeps a lower bound as 'at least', and says why", () => {
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

  it("names what is not counted: tasks in review (their wait is not work) and tasks with no estimate", () => {
    expect(notCountedText(2, 0)).toBe("Not counted: 2 tasks waiting for review (time waiting for review isn't work).");
    expect(notCountedText(1, 1)).toBe("Not counted: 1 task waiting for review (time waiting for review isn't work) and 1 task that can't be estimated yet.");
    expect(notCountedText(0, 0)).toBeNull();
  });

  it("phrases the critical path, lower bound and unknown included", () => {
    expect(pathHeadline(figure({ expectedSeconds: 8.5 * H })).sentence).toBe("About 8½ hours of it has to happen one step after another, however many people work on it.");
    expect(pathHeadline(figure({ expectedSeconds: 8.5 * H, partial: true }))).toEqual({ sentence: "At least 8½ hours of it has to happen one step after another.", figure: "at least 8½ hours" });
    expect(pathHeadline(figure({ expectedSeconds: null, missing: ["dependency_cycle"] })).sentence).toBe(
      "We can't tell how much of it has to happen in order: the tasks depend on each other in a loop.",
    );
  });

  it("says ONE range, the wide band only as 'rarely beyond' when that says something new", () => {
    expect(rangeWords(figure())).toEqual({
      likely: "Most likely between 14 and 21 hours (8 in 10 chances)",
      beyond: "rarely beyond 23 hours",
      expected: "Expected: about 15 hours",
      description: "Most likely between 14 and 21 hours (8 in 10 chances); rarely beyond 23 hours. Expected: about 15 hours.",
    });
    // The wide band rounds to the same words as the likely range's upper end: nothing more to say.
    expect(rangeWords(figure({ simulated: spread(13 * H, 14 * H, 21 * H, 21.2 * H) }))!.beyond).toBeNull();
  });

  it("keeps 'or more' on a lower bound, and promises no upper end", () => {
    const words = rangeWords(figure({ partial: true }))!;
    expect(words.likely).toBe("Most likely between 14 and 21 hours, or more (8 in 10 chances)");
    expect(words.beyond).toBeNull();
    expect(words.description).toBe("Most likely between 14 and 21 hours, or more (8 in 10 chances). Expected: at least 15 hours; the real figure can only be higher.");
    expect(rangeWords(figure({ simulated: null }))).toBeNull();
    expect(rangeWords(figure({ expectedSeconds: null }))).toBeNull();
  });
});

describe("confidence in words", () => {
  it("says what it rests on and why it is not surer, without repeating the word the card shows", () => {
    expect(confidenceHeadline({ label: "high", nominal: 0.9, achieved: 0.95, reached: true, reasons: [] }, 25)).toBe("Based on 25 finished tasks with measured time.");
    expect(confidenceHeadline({ label: "medium", nominal: 0.9, achieved: 0.8, reached: false, reasons: ["bounds_below_confidence", "awaiting_review"] }, 8)).toBe(
      "Based on 8 finished tasks with measured time. Why not surer: there isn't enough history yet to be sure.",
    );
  });

  it("leaves the review wait to 'Not counted': it is not a doubt about the figure", () => {
    expect(confidenceHeadline({ label: "medium", nominal: 0.9, achieved: 0.8, reached: false, reasons: ["awaiting_review"] }, 8)).toBe("Based on 8 finished tasks with measured time.");
  });

  it("says each reason once, and reads an unknown code as its label rather than nothing", () => {
    const line = confidenceHeadline({ label: "low", nominal: 0.9, achieved: 0.5, reached: false, reasons: ["small_sample", "bounds_below_confidence", "brand_new"] }, 1);
    expect(line).toBe("Based on 1 finished task with measured time. Why not surer: there isn't enough history yet to be sure; brand new.");
  });

  it("with no samples, says there is nothing to learn from yet", () => {
    expect(confidenceHeadline({ label: "low", nominal: 0.9, achieved: null, reached: false, reasons: ["no_samples"] }, 0)).toBe(
      "There are no finished tasks with measured time to learn from yet. Why not surer: there are no finished tasks to learn from yet.",
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

  it("is Tight, not Unknown, when this work's use is unknown but the account's pace runs out before the reset", () => {
    const paced = (atPace: "before_reset" | "after_reset") => limit({ work: null, exhaustion: { atPace, seconds: 3600, at: null } });
    expect(limitStatus(paced("before_reset"))).toEqual({ status: "tight", reason: "pace_unknown_work" });
    expect(limitSentence(paced("before_reset")).verdict).toBe("At the account's current pace this limit runs out before it resets; what this work adds is unknown.");
    expect(limitStatus(paced("after_reset"))).toEqual({ status: "unknown", reason: "no_projection" });
    // Already under the reserve still says At risk first.
    expect(limitStatus(limit({ work: null, exhaustion: { atPace: "before_reset", seconds: 3600, at: null }, reserve: reserve({ alreadyBelow: true }) })).status).toBe("at_risk");
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

  it("takes the worse of the work alone and the work with the account's other use, both sides", () => {
    const withOther = (alone: number, other: number | null) =>
      limitStatus(
        limit({
          reserve: reserve({
            breachProbability: alone,
            withOtherUse:
              other === null
                ? null
                : {
                    basis: "work_and_other_use",
                    otherPercentPerHour: 5,
                    otherConfidence: { label: "medium", warnings: [] },
                    breachProbability: other,
                    currentWindowBreachProbability: other,
                    remainingAtResetPercent: expectedSpread(30),
                    nextWindowRemainingPercent: null,
                  },
          }),
        }),
      );
    expect(withOther(0, 0.0999)).toEqual({ status: "on_track", reason: "breach" });
    expect(withOther(0, 0.1)).toEqual({ status: "tight", reason: "other_use" });
    expect(withOther(0.2, 0.6)).toEqual({ status: "at_risk", reason: "other_use" });
    // The work alone already says worse: the other use changes nothing.
    expect(withOther(0.6, 0.2)).toEqual({ status: "at_risk", reason: "breach" });
    expect(withOther(0.05, null)).toEqual({ status: "on_track", reason: "breach" });
  });

  it("is at least Tight when the account's pace runs the limit out before the reset, both sides", () => {
    const paced = (atPace: "before_reset" | "after_reset" | "never", p = 0) =>
      limitStatus(limit({ exhaustion: { atPace, seconds: 3600, at: null }, reserve: reserve({ breachProbability: p }) }));
    expect(paced("before_reset")).toEqual({ status: "tight", reason: "pace" });
    expect(paced("after_reset")).toEqual({ status: "on_track", reason: "breach" });
    expect(paced("never")).toEqual({ status: "on_track", reason: "breach" });
    // It never softens a worse status.
    expect(paced("before_reset", 0.6)).toEqual({ status: "at_risk", reason: "breach" });
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
      "78% left, resets in 3h 56m. Probably fits, but we could only measure part of this work, so it may need more.",
    );
    expect(limitHeadline(limit({ work: work({ lowerBound: true }), reserve: reserve({ breachProbability: 0.2 }) }))).toBe(
      "78% left, resets in 3h 56m. This work might dip into the 20% safety reserve (at least 20% chance), and it may need more than we could measure.",
    );
    expect(limitHeadline(limit({ reserve: reserve({ alreadyBelow: true, percent: 90 }) }))).toBe("78% left, resets in 3h 56m. It's already below the 90% safety reserve.");
    expect(limitHeadline(limit({ work: work({ remainingAtResetPercent: expectedSpread(-3) }) }))).toBe("78% left, resets in 3h 56m. This work alone would use it up before it resets.");
    expect(limitHeadline(limit({ exhaustion: { atPace: "before_reset", seconds: 3600, at: null } }))).toBe(
      "78% left, resets in 3h 56m. This work fits, but at the account's current pace this limit runs out before it resets.",
    );
  });

  it("says what is unknown and why, in everyday words, never as 0%", () => {
    const unmeasured = limit({ work: null, missing: { work: "input_missing" }, missingInputs: { work: ["attempt_burn"] } });
    expect(limitHeadline(unmeasured)).toBe("78% left, resets in 3h 56m. We can't tell yet what this work does to it: no usage has been measured for this project on this account yet.");
    const elapsed = limit({ remainingPercent: null, secondsToReset: null, missing: { remainingPercent: "window_elapsed" } });
    expect(limitHeadline(elapsed)).toBe("We can't read this limit yet: the limit has reset since the last reading.");
    expect(limitSentence(elapsed).opening).toBeNull();
    expect(plainLimitReason(limit({ quality: { state: "missing", reasons: ["stale"] } }), "work")).toBe("the last reading is more than 10 minutes old");
    expect(plainLimitReason(limit(), "work")).toBe("no reason was given");
    expect(plainMissing("brand_new_code")).toBe("brand new code");
  });

  it("splits the sentence so a card showing '78% left' does not repeat it", () => {
    expect(limitSentence(limit())).toEqual({ opening: "78% left, resets in 3h 56m.", reset: "Resets in 3h 56m.", verdict: "This work fits comfortably." });
    expect(limitSentence(limit({ secondsToReset: null })).opening).toBe("78% left.");
  });

  it("gives a stale figure its age, and a fresh one none", () => {
    expect(leftFigure(limit())).toBe("78% left");
    expect(leftFigure(limit({ stale: true, readingAgeSeconds: 12 * 60, remainingPercent: 93 }))).toBe("93% left · 12 min ago");
    expect(leftFigure(limit({ stale: true, readingAgeSeconds: null }))).toBe("78% left");
    expect(leftFigure(limit({ remainingPercent: null }))).toBeNull();
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

  it("explains only the marks the gauge draws", () => {
    const full = limitHelp(limit());
    expect(full).toContain("stripes");
    expect(full).toContain("dashed line");
    const bare = limitHelp(limit({ work: null, reserve: null }));
    expect(bare).not.toContain("stripes");
    expect(bare).not.toContain("dashed");
    expect(limitHelp(limit({ remainingPercent: null }))).not.toMatch(/stripes|dashed|blue/);
    expect(limitHelp(limit({ stale: true }))).toContain("The reading is not recent");
  });

  it("names a provider for people, and collapses the limits that can't be read into one line", () => {
    expect(providerName("anthropic", "personal-max")).toEqual({ name: "Claude (Anthropic)", short: "Claude" });
    expect(providerName("openai", "codex-plus")).toEqual({ name: "Codex (OpenAI)", short: "Codex" });
    expect(providerName("mistral", "m")).toEqual({ name: "Mistral", short: "Mistral" });
    expect(providerName(null, "my-account").name).toBe("my-account");
    const unreported = limit({ remainingPercent: null, missing: { remainingPercent: "reset_not_reported" } });
    // reset_not_reported: the limit has samples; the provider doesn't say when it RESETS.
    expect(unreadableLine([unreported, unreported], "Codex", true)).toBe("2 other Codex limits can't be read yet: the provider doesn't say when they reset.");
    expect(unreadableLine([unreported], "Codex", false)).toBe("1 Codex limit can't be read yet: the provider doesn't say when it resets.");
    const elapsed = limit({ remainingPercent: null, missing: { remainingPercent: "window_elapsed" } });
    expect(unreadableLine([elapsed, unreported], "Codex", false)).toBe(
      "2 Codex limits can't be read yet: they have reset since the last reading; the provider doesn't say when they reset.",
    );
    expect(unreadableLine([], "Codex", true)).toBeNull();
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

const ALL = { kind: "*", priority: "*", workType: "*", area: "*", model: "*" };
const fellBack = (kind: string, priority: string, own: number, level = "all", klass = ALL, samples = 9) =>
  cohort({
    key: { kind, priority, workType: "unknown", area: "unknown", model: "unknown" },
    keySamples: own,
    fallback: "below_minimum",
    levelName: level,
    class: klass,
    samples,
    path: [
      { level: 0, name: "full", samples: own, floors: 0 },
      { level: 5, name: level, samples, floors: 0 },
    ],
    warnings: ["fallback_used"],
  }, { expected: { value: 0.2, method: "pooled" } });

describe("estimate accuracy in words", () => {
  it("writes an own cohort as the sentences the page shows", () => {
    const [group] = accuracyGroups([cohort({}, { expected: { value: 0.2, method: "pooled" } })]);
    expect(groupSentence(group!)).toEqual({
      answer: "Bug fixes (high priority) usually take about a fifth of the estimate.",
      basis: "Based on 13 finished tasks.",
      confidence: "Rough guess: not enough data to be sure.",
      alsoFor: [],
    });
    expect(groupSentence(accuracyGroups([cohort()])[0]!).answer).toBe("Bug fixes (high priority): a 10-hour estimate usually takes about 50 minutes.");
  });

  it("gives cohorts that fell back ONE card for the class, named for it, with their own counts", () => {
    const task = cohort({ key: { kind: "task", priority: "high", workType: "unknown", area: "unknown", model: "unknown" }, samples: 8 }, { expected: { value: 0.2, method: "pooled" } });
    const bug = fellBack("bug", "high", 1);
    const spike = fellBack("spike", "critical", 3);
    const groups = accuracyGroups([bug, task, spike]);
    expect(groups.map((group) => group.kind)).toEqual(["own", "class"]);
    const klass = groups[1]!;
    expect(klass.kind === "class" && klass.name).toBe("All finished work (every kind)");
    expect(klass.kind === "class" && klass.members).toEqual([bug, spike]);
    const words = groupSentence(klass);
    expect(words.answer).toBe("All finished work (every kind) usually takes about a fifth of the estimate.");
    expect(words.basis).toBe("Based on 9 finished tasks.");
    expect(words.alsoFor).toEqual(["Bug fixes (high priority): too few of their own (1)", "Spikes (critical priority): too few of their own (3)"]);
    // Never "Quite sure", however many the broader class holds; said for the kinds it stands in for.
    expect(words.confidence).toBe("Rough guess for bug fixes (high priority), spikes (critical priority): too few of their own (below), so all finished work (every kind) stands in.");
    expect(groupSentence(accuracyGroups([fellBack("spike", "critical", 3, "all", ALL, 108)])[0]!).confidence).toBe(
      "Rough guess for spikes (critical priority): only 3 of their own, so all finished work (every kind) stands in.",
    );
    expect(FALLBACK_CONFIDENCE.level).toBe("low");
  });

  it("never groups an exact and a reconstructed cohort under one class card", () => {
    const exact = fellBack("bug", "high", 1);
    const older = { ...fellBack("spike", "critical", 3, "all", ALL, 108), set: "reconstructed" as const };
    const groups = accuracyGroups([exact, older]);
    expect(groups.length).toBe(2);
    expect(groups.map((group) => group.kind === "class" && group.members.map((member) => member.set))).toEqual([["exact"], ["reconstructed"]]);
  });

  it("keeps separate classes apart: a kind-level fallback is its own group", () => {
    const kindClass = { ...ALL, kind: "chore" };
    const groups = accuracyGroups([fellBack("chore", "critical", 1, "kind", kindClass, 6), fellBack("chore", "high", 1, "kind", kindClass, 6), fellBack("bug", "high", 1)]);
    expect(groups.map((group) => (group.kind === "class" ? [group.name, group.members.length] : null))).toEqual([
      ["All chores (every priority)", 2],
      ["All finished work (every kind)", 1],
    ]);
    expect(className({ kind: "task", priority: "high", workType: "*", area: "*", model: "*" })).toBe("All tasks (high priority)");
  });

  it("agrees the verb with the class: 'All finished work usually takes', 'All bug fixes usually take'", () => {
    const bugClass = { ...ALL, kind: "bug" };
    const half = (member: CalibrationCohort): CalibrationCohort => ({ ...member, ratio: { ...member.ratio, expected: { value: 0.5, method: "pooled" } } });
    const kindGroup = accuracyGroups([half(fellBack("bug", "medium", 2, "kind", bugClass, 15))])[0]!;
    expect(groupSentence(kindGroup).answer).toBe("All bug fixes (every priority) usually take about half of the estimate.");
    expect(groupSentence(kindGroup).confidence).toBe("Rough guess for bug fixes (medium priority): only 2 of their own, so all bug fixes (every priority) stand in.");
    expect(accuracyHeadline([half(fellBack("bug", "medium", 2, "kind", bugClass, 15))])).toBe("All bug fixes (every priority) usually take about half of the estimate.");
    const allGroup = accuracyGroups([half(fellBack("bug", "high", 1))])[0]!;
    expect(groupSentence(allGroup).answer).toBe("All finished work (every kind) usually takes about half of the estimate.");
    expect(accuracyHeadline([half(fellBack("bug", "high", 1))])).toBe("All finished work (every kind) usually takes about half of the estimate.");
  });

  it("grades an own cohort's confidence from its own fields", () => {
    const reached = { lower: 0.1, upper: 0.3, ranks: [1, 20] as const, confidence: 0.92, reached: true };
    expect(cohortConfidence(cohort({ warnings: [] }, { bounds: reached })).word).toBe("Quite sure");
    expect(cohortConfidence(cohort({ warnings: ["quantile_below_confidence"] }, { bounds: reached })).word).toBe("Fairly sure");
    expect(cohortConfidence(cohort({ warnings: ["small_sample"] }, { bounds: reached })).word).toBe("Rough guess");
    expect(cohortConfidence(cohort()).word).toBe("Rough guess");
    expect(cohortConfidence(cohort({ samples: 0 })).level).toBe("unknown");
    expect(cohortConfidence(cohort({}, { bounds: null })).level).toBe("unknown");
  });

  it("names a cohort without the dimensions nobody recorded", () => {
    expect(cohortName({ kind: "task", priority: "*", workType: "unknown", area: "ui", model: "*" })).toBe("Tasks (area ui)");
    expect(cohortName(ALL)).toBe("All finished work");
    expect(cohortName({ kind: "spike", priority: "low", workType: "unknown", area: "unknown", model: "unknown" })).toBe("Spikes (low priority)");
    expect(cohortName({ kind: "task", priority: "unknown", workType: "unknown", area: "unknown", model: "unknown" })).toBe("Tasks");
  });

  it("opens the page with up to three cards in display order, a fallback named for its class", () => {
    const task = cohort({ key: { kind: "task", priority: "high", workType: "unknown", area: "unknown", model: "unknown" } }, { expected: { value: 0.2, method: "pooled" } });
    // Cards that say the same thing are said once, together.
    expect(accuracyHeadline([fellBack("bug", "high", 1), task])).toBe("Tasks (high priority) and all finished work (every kind) usually take about a fifth of the estimate.");
    const third = cohort({ key: { kind: "chore", priority: "low", workType: "unknown", area: "unknown", model: "unknown" } }, { expected: { value: 0.5, method: "pooled" } });
    expect(accuracyHeadline([task, third, fellBack("bug", "high", 1)])).toBe(
      "Tasks (high priority) and all finished work (every kind) usually take about a fifth of the estimate; chores (low priority) usually take about half of the estimate.",
    );
    expect(accuracyHeadline([task, cohort({ key: { kind: "chore", priority: "low", workType: "unknown", area: "unknown", model: "unknown" } })])).toBe(
      "Tasks (high priority) usually take about a fifth of the estimate; chores (low priority): a 10-hour estimate usually takes about 50 minutes.",
    );
    expect(accuracyHeadline([fellBack("bug", "high", 1)])).not.toContain("Bug fixes");
    const other = (kind: string) => cohort({ key: { kind, priority: "high", workType: "unknown", area: "unknown", model: "unknown" } }, { expected: { value: 1, method: "pooled" } });
    expect(accuracyHeadline([task, other("chore"), other("feature"), other("epic")])).toMatch(/; and 1 more group below\.$/);
    expect(accuracyHeadline([task, other("chore")])).toBe("Tasks (high priority) usually take about a fifth of the estimate; chores (high priority) usually take about as long as estimated.");
    expect(accuracyHeadline([])).toBe("We can't tell yet: there are no finished tasks with measured time to compare with their estimates.");
  });

  it("says what a set leaves out by state, for the set it belongs to", () => {
    const summary = (set: "exact" | "reconstructed", counts: Record<string, number>, samples: number): CalibrationSetSummary => ({
      set,
      samples,
      coverage: { samples, eligible: 138, fraction: samples / 138, denominator: "ratio_population" },
      excluded: { count: Object.values(counts).reduce((a, b) => a + b, 0), counts, reasons: {} },
      cohorts: 2,
    });
    expect(setSummaryText(summary("exact", { approximate: 2, reconstructed: 127 }, 9))).toEqual({
      basis: "Based on 9 finished tasks with measured time, out of 138 finished with an estimate.",
      notUsed: "Not used here: 2 have only approximate timing and 127 have timing rebuilt from logs (they're in the older history).",
    });
    // The measured history says the same whether the older history is shown or not.
    expect(setSummaryText(summary("exact", { reconstructed: 127 }, 9), { measuredAbove: true })).toEqual(setSummaryText(summary("exact", { reconstructed: 127 }, 9)));
    const olderSummary = summary("reconstructed", { exact: 10, approximate: 2, reconstructed: 19 }, 108);
    const older = setSummaryText(olderSummary, { measuredAbove: true });
    expect(older.basis).toBe("Based on 108 finished tasks with timing rebuilt from logs, out of 138 finished with an estimate.");
    expect(older.notUsed).toBe("Not used here: 10 are in the measured history above, 2 have only approximate timing and 19 couldn't be rebuilt reliably.");
    // "Above" only when the page draws the measured history above it.
    expect(setSummaryText(olderSummary).notUsed).toBe("Not used here: 10 are in the measured history, 2 have only approximate timing and 19 couldn't be rebuilt reliably.");
    // Never the blanket "their timing isn't exact": the exact ones are exact.
    expect(older.notUsed).not.toMatch(/isn't exact/);
    expect(setSummaryText(summary("exact", { approximate: 1 }, 3)).notUsed).toBe("Not used here: 1 has only approximate timing.");
    expect(setSummaryText(summary("exact", {}, 3)).notUsed).toBeNull();
    expect(setSummaryText(summary("exact", { "timing-floor": 2, missing: 1 }, 3)).notUsed).toBe("Not used here: 2 took under a minute and 1 has no measured time.");
  });

  it("says too little data to say where the next one lands, below half confidence", () => {
    const low = cohortRangeWords(cohort({}, { bounds: { lower: 0.1, upper: 0.5, ranks: [1, 1], confidence: 0.4999, reached: false } }))!;
    expect(low.nextKnown).toBe(false);
    expect(low.next).toBe("Too little data to say where the next one lands");
    expect(low.description).not.toMatch(/in 10 chances|under 1 in 10/);
    const enough = cohortRangeWords(cohort({}, { bounds: { lower: 0.1, upper: 0.5, ranks: [1, 1], confidence: 0.5, reached: false } }))!;
    expect(enough.nextKnown).toBe(true);
    expect(enough.next).toMatch(/^Next one, about 5 in 10: /);
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

// ------------------------------------------------------------------ the Budget view

function pressure(over: Partial<LimitPressure> = {}): LimitPressure {
  return {
    provisional: true,
    observed: { percentPerHour: 4.2, fromPercent: 10, toPercent: 14, from: "a", to: "b", spanSeconds: 3600, readings: 6 },
    lastReadingAgeSeconds: 60,
    secondsToReset: 3 * H + 56 * 60,
    reservePercent: 20,
    sustainablePercentPerHour: 15.4,
    ratio: 0.27,
    state: "within",
    exhaustion: null,
    reserveReach: { atPace: "after_reset", seconds: 20 * H, at: null },
    safeConcurrency: null,
    confidence: null,
    missing: {},
    missingInputs: {},
    ...over,
  };
}

function reading(over: Partial<BudgetLimitReading> = {}, pressureOver: Partial<LimitPressure> = {}): BudgetLimitReading {
  return {
    limitKey: "five_hour",
    status: "current",
    window: null,
    latestSample: null,
    highWaterPercent: 22,
    remainingPercent: 78,
    regressionCount: 0,
    sampleCount: 6,
    stale: false,
    missing: {},
    quality: { state: "exact", reasons: [] },
    pressure: pressure(pressureOver),
    ...over,
  };
}

describe("the Budget view's status: the store's provisional state, said honestly", () => {
  it("maps within to On track, unsafe to At risk, and no state or no window to Unknown", () => {
    expect(pressureStatus(reading())).toEqual({ status: "on_track", reason: "within" });
    expect(pressureStatus(reading({}, { state: "unsafe", ratio: 1.4 }))).toEqual({ status: "at_risk", reason: "unsafe" });
    expect(pressureStatus(reading({}, { state: null, missing: { state: "stale" } }))).toEqual({ status: "unknown", reason: "unknown" });
    expect(pressureStatus(reading({ status: "elapsed" }))).toEqual({ status: "unknown", reason: "no_reading" });
    expect(pressureStatus(reading({ remainingPercent: null }))).toEqual({ status: "unknown", reason: "no_reading" });
  });

  it("says each state in a sentence, the reset first", () => {
    expect(pressureSentence(reading(), 3 * H + 56 * 60)).toBe("Resets in 3h 56m. At your current pace you'll stay above the reserve.");
    expect(pressureSentence(reading({}, { state: "unsafe", ratio: null, reserveReach: { atPace: "already", seconds: null, at: null } }), null)).toBe("It's already at or below the 20% reserve.");
    expect(pressureSentence(reading({}, { state: "unsafe", ratio: 1.4, reserveReach: { atPace: "before_reset", seconds: 70 * 60, at: null } }), H)).toBe(
      "Resets in 1 hour. At your current pace you'll reach the 20% reserve in 1h 10m, before it resets.",
    );
    expect(pressureSentence(reading({}, { state: "unsafe", ratio: 1.4, reserveReach: null }), null)).toBe("At your current pace you'll use up everything above the 20% reserve by the reset.");
    // At a ratio of exactly 1 the reserve is reached at the reset: the headline says so, and the
    // Forecast frame's safe pace is the pace being used, so the two agree.
    const atOne = reading({}, { state: "unsafe", ratio: 1, sustainablePercentPerHour: 4.2, reserveReach: { atPace: "after_reset", seconds: 4 * H, at: null } });
    expect(pressureSentence(atOne, null)).toBe("At your current pace you'll use up everything above the 20% reserve by the reset.");
    expect(forecastLine(atOne)).toBe("To keep the 20% reserve until it resets, use no more than about 4.2% an hour.");
    expect(measuredLine(atOne, 60)).toBe("Using about 4.2% an hour lately; last read 1 min ago.");
    expect(pressureSentence(reading({}, { state: null, missing: { state: "stale" } }), null)).toBe("We can't tell where your pace is heading: the last reading is more than 10 minutes old.");
    expect(pressureSentence(reading({}, { state: null, missing: { state: "input_missing" }, missingInputs: { state: ["second_reading"] } }), null)).toBe(
      "We can't tell where your pace is heading: there is only one reading so far.",
    );
  });

  it("keeps the measured line to what was measured, and the forecast line to the safe pace", () => {
    expect(measuredLine(reading(), 60)).toBe("Using about 4.2% an hour lately; last read 1 min ago.");
    expect(measuredLine(reading({}, { observed: null, missing: { observed: "input_missing" }, missingInputs: { observed: ["second_reading"] } }), null)).toBe(
      "No pace measured yet: there is only one reading so far.",
    );
    // An idle limit: no use, never "Using none".
    const idle = reading({}, { observed: { percentPerHour: 0, fromPercent: 10, toPercent: 10, from: "a", to: "b", spanSeconds: 3600, readings: 4 } });
    expect(measuredLine(idle, 60)).toBe("No use lately; last read 1 min ago.");
    // A stale reading: "as of", never "lately".
    expect(measuredLine(reading({ stale: true }), 3 * H)).toBe("Using about 4.2% an hour as of 3h ago.");
    expect(measuredLine({ ...idle, stale: true }, 3 * H)).toBe("No use as of 3h ago.");
    expect(forecastLine(reading())).toBe("To keep the 20% reserve until it resets, use no more than about 15% an hour.");
    // The reach is the headline's to say, once.
    expect(forecastLine(reading({}, { reserveReach: { atPace: "before_reset", seconds: 2 * H, at: null } }))).not.toMatch(/reach/);
    expect(forecastLine(reading({}, { sustainablePercentPerHour: null, missing: { sustainablePercentPerHour: "stale" } }))).toBe(
      "We can't work out a safe pace yet: the last reading is more than 10 minutes old.",
    );
  });

  it("never says 'stay under under 1%': a small safe pace has one decimal", () => {
    // The ordinary weekly case: 78% left, a 20% reserve, a week to go.
    const weekly = reading({ window: { id: "w", label: null, resetsAt: null, windowSeconds: 604_800, status: "current" } }, { sustainablePercentPerHour: 0.35 });
    expect(forecastLine(weekly)).toBe("To keep the 20% reserve until it resets, use no more than about 8.4% a day.");
    expect(forecastLine(reading({}, { sustainablePercentPerHour: 0.35 }))).toBe("To keep the 20% reserve until it resets, use no more than about 0.4% an hour.");
    expect(forecastLine(reading({}, { sustainablePercentPerHour: 0.01 }))).toBe("To keep the 20% reserve until it resets, use next to nothing (less than 0.1% an hour).");
    for (const pace of [0.01, 0.35, 0.99, 1.49]) expect(forecastLine(reading({}, { sustainablePercentPerHour: pace }))).not.toMatch(/under under|stay under none|no more than less than/);
  });

  it("keeps an at-risk pace distinguishable from its safe pace, in the same unit", () => {
    // 0.4 against 0.118, 1.49 against 1.0: both read "under 1%" or "about 1%" with whole numbers.
    const a = reading({}, { state: "unsafe", observed: { percentPerHour: 0.4, fromPercent: 1, toPercent: 2, from: "a", to: "b", spanSeconds: 3600, readings: 5 }, sustainablePercentPerHour: 0.118 });
    expect(measuredLine(a, 60)).toContain("about 0.4% an hour");
    expect(forecastLine(a)).toContain("about 0.1% an hour");
    const b = reading({}, { state: "unsafe", observed: { percentPerHour: 1.49, fromPercent: 1, toPercent: 2, from: "a", to: "b", spanSeconds: 3600, readings: 5 }, sustainablePercentPerHour: 1.0 });
    expect(measuredLine(b, 60)).toContain("about 1.5% an hour");
    expect(forecastLine(b)).toContain("about 1% an hour");
    // A weekly limit says both frames per day.
    const weekly = { id: "w", label: null, resetsAt: null, windowSeconds: 604_800, status: "current" as const };
    expect(measuredLine(reading({ window: weekly }), 60)).toBe("Using about 101% a day lately; last read 1 min ago.");
    expect(forecastLine(reading({ window: weekly }))).toBe("To keep the 20% reserve until it resets, use no more than about 370% a day.");
  });

  it("says 'already at the reserve', and 'almost any pace' when the reset is too close to matter", () => {
    expect(forecastLine(reading({}, { state: "unsafe", ratio: null, sustainablePercentPerHour: null, reserveReach: { atPace: "already", seconds: null, at: null }, missing: { ratio: "reserve_reached" } }))).toBe(
      "Already at or below the 20% reserve; any more use eats into it.",
    );
    expect(forecastLine(reading({}, { sustainablePercentPerHour: 0, reserveReach: { atPace: "already", seconds: null, at: null } }))).not.toMatch(/none|under/);
    expect(forecastLine(reading({}, { sustainablePercentPerHour: 250 }))).toBe("Almost any pace is safe until the reset.");
    expect(forecastLine(reading({}, { sustainablePercentPerHour: 77 }))).toBe("To keep the 20% reserve until it resets, use no more than about 77% an hour.");
  });

  it("says paces, the gauge, the binding and an empty account in plain words", () => {
    expect(plainPace(12.4)).toBe("about 12% an hour");
    expect(plainPace(9.94)).toBe("about 9.9% an hour");
    expect(plainPace(0.4)).toBe("about 0.4% an hour");
    expect(plainPace(0.04)).toBe("less than 0.1% an hour");
    expect(plainPace(0.35, "day")).toBe("about 8.4% a day");
    expect(paceUnit(604_800)).toBe("day");
    expect(paceUnit(18_000)).toBe("hour");
    expect(paceUnit(null)).toBe("hour");
    expect(readingGaugeDescription(78, 12.5)).toBe("78% left now. Safety reserve: 12.5%.");
    expect(boundText(true)).toBe("measured on this computer");
    expect(boundText(false)).toBe("not set up on this computer");
    expect(budgetAbsentPlain(undefined, false, false)).toMatch(/^Usage tracking is off on this computer/);
    expect(budgetAbsentPlain("no_sample_yet", true, true)).toMatch(/^Set up, but no reading has arrived yet/);
    expect(budgetAbsentPlain("source_unavailable", true, true)).toMatch(/^Set up, but nothing is collecting/);
    expect(budgetAbsentPlain("source_unavailable", true, false)).toMatch(/^Not set up on this computer yet/);
  });

  it("collapses a Budget view limit with no window by its window reason too", () => {
    expect(unreadableLine([reading({ status: "elapsed", remainingPercent: null, missing: { window: "window_elapsed" } })], "Claude", true)).toBe(
      "1 other Claude limit can't be read yet: it has reset since the last reading.",
    );
  });
});
