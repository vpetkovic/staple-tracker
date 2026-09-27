/**
 * STA-82 — the judgement the Analytics tab is made of.
 *
 * What is worth pinning here is not "formatDuration renders 2h". It is the four
 * ways this tab could quietly start lying:
 *
 *   1. **A missing estimate becoming a zero.** Un-estimated work would report as
 *      infinite overrun, and an epic nobody planned would look like a disaster
 *      instead of like an epic nobody planned. This is the failure that would
 *      make the whole feature worse than not having it.
 *   2. **A delta computed from one side.** "0s over" for a task with no estimate
 *      is a sentence that reads as a measurement and is not one.
 *   3. **Totals that cover different work on each side.** If two of five
 *      children were estimated, the estimated total spans two children and the
 *      actual total spans five — and the headline is the number people quote.
 *   4. **A provisional result presented as a finished one.** A task 40% into its
 *      estimate has not "come in under"; it has not finished.
 *
 * STA-90 adds a fifth, which is the one VP actually reported:
 *
 *   5. **A frozen number described as a live one.** "still running" under a task
 *      whose agent died on Friday, and a perpetual stopwatch on an epic that was
 *      only ever auto-flipped by a child. Both read as activity; neither is.
 *      `activityState` is the judgement that separates them, and it is a
 *      separate axis from (4) — an unfinished task can be provisional AND idle.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root,
 * so the app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import {
  IDLE_AFTER_SECONDS,
  NO_ESTIMATE,
  NOT_STARTED,
  activityHint,
  activityState,
  aggregationHint,
  buildBreakdown,
  buildChildRows,
  childPlanHint,
  childQualityText,
  cohortLine,
  computeDelta,
  computeSummary,
  computeTotals,
  explainMissingDelta,
  formatDuration,
  formatOptionalDuration,
  isAggregated,
  isStillRunning,
  spokenSpent,
  plainDelta,
  shortDelta,
  spokenDuration,
  qualityText,
  subtreePlanHint,
  summarySentence,
  totalsCaveat,
} from "./analytics";
import { STALE_CLAIM_SECONDS } from "../lib/claim";
import type { IssueStatus, IssueTiming, SubtreePlan, TimingQualityReport } from "../lib/types";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const agoIso = (seconds: number) => new Date(NOW - seconds * 1000).toISOString();

function timing(over: Partial<IssueTiming> = {}): IssueTiming {
  return {
    estimatedSeconds: null,
    ownActiveSeconds: null,
    activeSeconds: null,
    reviewSeconds: null,
    approximate: false,
    countedThrough: null,
    childCount: 0,
    childrenEstimatedSeconds: null,
    childrenActiveSeconds: null,
    childStatusCounts: {
      backlog: 0, todo: 0, in_progress: 0, in_review: 0, awaiting_approval: 0, done: 0, blocked: 0, cancelled: 0,
    },
    subtreePlan: plan(),
    workSeconds: null,
    estimateRatio: null,
    quality: {
      work: { state: "missing", inputs: [], reasons: ["never_started"], coverage: null, missingInputs: [] },
      wall: { state: "missing", inputs: [], reasons: ["never_started"] },
    },
    ...over,
  };
}

function plan(over: Partial<SubtreePlan> = {}): SubtreePlan {
  return {
    estimatedSeconds: null,
    source: "none",
    descendantsEstimatedSeconds: null,
    contributingCount: 0,
    unplannedCount: 0,
    totalCount: 0,
    ...over,
  };
}

function child(
  identifier: string,
  over: { title?: string; status?: IssueStatus; estimatedSeconds?: number | null } = {},
) {
  return {
    identifier,
    title: over.title ?? `Task ${identifier}`,
    status: over.status ?? ("backlog" as IssueStatus),
    estimatedSeconds: over.estimatedSeconds ?? null,
  };
}

// ------------------------------------------------------------------ formatting

describe("durations keep the second unit that a staleness reading throws away", () => {
  it("renders the shapes the tab is made of", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(90)).toBe("1m30s");
    expect(formatDuration(1200)).toBe("20m");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(11_400)).toBe("3h10m");
    expect(formatDuration(86_400)).toBe("1d");
    expect(formatDuration(100_800)).toBe("1d4h");
  });

  it("matches what `staple show` prints for the same seconds", () => {
    // Mirrored from formatDuration in src/core/types.ts. If these two drift, the
    // page and the CLI describe the same task with two different numbers and
    // there is no way to tell which one is wrong.
    expect(formatDuration(11_400)).toBe("3h10m");
    expect(formatDuration(5400)).toBe("1h30m");
    expect(formatDuration(3600)).toBe("1h");
  });

  it("drops a trailing zero unit instead of printing 2h0m", () => {
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(60)).toBe("1m");
  });

  it("never renders a negative duration from a clock that disagrees with itself", () => {
    expect(formatDuration(-90)).toBe("0s");
  });
});

describe("an absent duration is NAMED, never drawn as zero", () => {
  it("uses the caller's sentence rather than a dash", () => {
    // A dash in a numeric column reads as zero to most people, and zero is a
    // meaningful — and wrong — value in exactly this column.
    // R7b: the ticket's words, and WORDS — the tab sets them in the interface
    // face rather than as a figure, so they must never look like a duration.
    expect(formatOptionalDuration(null, NO_ESTIMATE)).toBe("No estimate");
    expect(formatOptionalDuration(null, NOT_STARTED)).toBe("No work recorded");
    expect(formatOptionalDuration(null, NO_ESTIMATE)).not.toBe("0s");
    expect(NO_ESTIMATE).not.toMatch(/\d/);
    expect(NOT_STARTED).not.toMatch(/\d/);
  });

  it("renders a real duration normally, including a genuine zero", () => {
    expect(formatOptionalDuration(3600, NO_ESTIMATE)).toBe("1h");
    // 0 elapsed is a real reading (work started this instant) and is NOT absent.
    expect(formatOptionalDuration(0, NOT_STARTED)).toBe("0s");
  });
});

// ----------------------------------------------------------------------- delta

describe("a delta needs both sides, and says so when it does not have them", () => {
  it("is null with no estimate", () => {
    expect(computeDelta(null, 3600)).toBeNull();
  });

  it("is null with no actual", () => {
    expect(computeDelta(3600, null)).toBeNull();
  });

  it("is null with neither", () => {
    expect(computeDelta(null, null)).toBeNull();
  });

  it("returns null rather than a zero-filled object, so the caller MUST handle it", () => {
    /**
     * The load-bearing shape choice. A `{difference: 0, direction: "on"}` for a
     * task nobody estimated would render as "on estimate" — a confident, wrong
     * sentence. With null there is nothing to render, so the absence has to be
     * described, which is how it ends up being described honestly.
     */
    const nothing = computeDelta(null, null);
    expect(nothing).toBeNull();
    expect(explainMissingDelta(null, null)).toBe("Nothing to compare yet: there is no estimate and no time spent.");
  });

  it("names WHICH side is missing", () => {
    expect(explainMissingDelta(null, 3600)).toMatch(/There is no estimate/);
    expect(explainMissingDelta(3600, null)).toMatch(/Nobody has worked on it yet/);
  });

  it("declines a non-positive estimate instead of dividing by it", () => {
    // Unreachable through the store (it refuses a non-positive estimate), so
    // this is about a hand-edited database. "Infinity%" is worse than silence.
    expect(computeDelta(0, 3600)).toBeNull();
    expect(computeDelta(-60, 3600)).toBeNull();
  });
});

describe("what the delta says when it has both sides", () => {
  it("reports over with the amount and the percentage", () => {
    const delta = computeDelta(7200, 11_400)!;
    expect(delta.direction).toBe("over");
    expect(delta.differenceSeconds).toBe(4200);
    expect(delta.label).toBe("1h10m over (58%)");
  });

  it("reports under with a positive-looking amount and a negative difference", () => {
    // The sign lives in `direction`, not in the printed number: "-20m under"
    // would be a double negative a reader has to unpick.
    const delta = computeDelta(7200, 6000)!;
    expect(delta.direction).toBe("under");
    expect(delta.differenceSeconds).toBe(-1200);
    expect(delta.label).toBe("20m under (17%)");
  });

  it("says 'on estimate' rather than '0s over'", () => {
    const delta = computeDelta(3600, 3600)!;
    expect(delta.direction).toBe("on");
    expect(delta.label).toBe("on estimate");
  });

  it("keeps the ratio usable for rendering as well as the label", () => {
    expect(computeDelta(3600, 7200)!.ratio).toBe(1);
    expect(computeDelta(3600, 1800)!.ratio).toBe(-0.5);
  });
});

// ----------------------------------------------------------------- provisional

describe("work still running is not a result", () => {
  it("treats in_progress and in_review as still accumulating", () => {
    // in_review counts: an unreviewed task is not finished, and a review that
    // sits for two days is exactly the overrun this feature exists to surface.
    expect(isStillRunning("in_progress")).toBe(true);
    expect(isStillRunning("in_review")).toBe(true);
  });

  it("treats everything else as settled", () => {
    for (const status of ["backlog", "todo", "done", "blocked", "cancelled"] as IssueStatus[]) {
      expect(isStillRunning(status)).toBe(false);
    }
  });
});

// --------------------------------------------------------------- is it moving?

describe("a frozen number is not a live one", () => {
  it("says STOPPED when nothing is accumulating", () => {
    /**
     * The epic case, and the whole of VP's first screenshot. An epic that STA-79
     * auto-flipped has no open interval it may count, so the server sends
     * `countedThrough: null` — and there is nothing here for the tab to describe
     * as "running", by construction rather than by remembering to check.
     */
    expect(activityState(null, NOW)).toEqual({ kind: "stopped" });
    expect(activityHint({ kind: "stopped" })).toBeNull();
  });

  it("says RUNNING while the holder is still writing", () => {
    const state = activityState(agoIso(30), NOW);
    expect(state.kind).toBe("running");
    expect(activityHint(state)).toBe("still being worked on");
  });

  it("says IDLE once the evidence goes stale, and names how stale", () => {
    // VP's second screenshot: an agent that stopped, still labelled "still
    // running". The replacement sentence has to say the number is not moving AND
    // why, or it is just a differently-worded lie.
    const state = activityState(agoIso(7200), NOW);
    expect(state).toEqual({ kind: "idle", idleSeconds: 7200 });
    expect(activityHint(state)).toBe("quiet for 2 hours, so the clock has stopped");
  });

  it("flips at exactly the threshold the rest of the app calls stale", () => {
    /**
     * One judgement about silence, one constant. A second, differently-tuned
     * number here would let the same ticket read "silent 35m" in its header and
     * "still running" in its analytics tab at the same moment.
     */
    expect(IDLE_AFTER_SECONDS).toBe(STALE_CLAIM_SECONDS);
    expect(activityState(agoIso(IDLE_AFTER_SECONDS - 1), NOW).kind).toBe("running");
    expect(activityState(agoIso(IDLE_AFTER_SECONDS), NOW).kind).toBe("idle");
  });

  it("never reports a negative idleness from an instant in the future", () => {
    expect(activityState(new Date(NOW + 60_000).toISOString(), NOW)).toEqual({
      kind: "running",
      idleSeconds: 0,
    });
  });

  it("refuses to invent a state from an unparseable instant", () => {
    expect(activityState("not a date", NOW)).toEqual({ kind: "stopped" });
  });
});

describe("a parent's number is labelled as an aggregation", () => {
  it("recognises a parent by its children, not by its status", () => {
    // Status is exactly the wrong signal here: the epic in VP's screenshot was
    // `in_progress`, which is what made it look like it had a clock.
    expect(isAggregated(timing({ childCount: 3 }))).toBe(true);
    expect(isAggregated(timing({ childCount: 0, activeSeconds: 3600 }))).toBe(false);
  });

  it("names the count, with the singular right", () => {
    expect(aggregationHint(3)).toBe("added up from its 3 sub-tasks");
    expect(aggregationHint(1)).toBe("added up from its 1 sub-task");
  });
});

// ------------------------------------------------------------------ child rows

describe("child rows join the children against the timing map", () => {
  it("keeps the server's ordering", () => {
    // children come back ordered by created_at; re-sorting here would make the
    // tab disagree with the Overview tab's child list for no reason.
    const rows = buildChildRows(
      [child("STA-3"), child("STA-1"), child("STA-2")],
      {},
    );
    expect(rows.map((row) => row.identifier)).toEqual(["STA-3", "STA-1", "STA-2"]);
  });

  it("looks timing up by IDENTIFIER", () => {
    const rows = buildChildRows([child("STA-1", { estimatedSeconds: 5400 })], {
      "STA-1": timing({ estimatedSeconds: 5400, activeSeconds: 3600 }),
    });
    expect(rows[0]!.estimatedSeconds).toBe(5400);
    expect(rows[0]!.actualSeconds).toBe(3600);
    expect(rows[0]!.delta!.direction).toBe("under");
  });

  it("degrades to all-nulls for a child with no timing entry, rather than throwing", () => {
    // Cannot normally happen — the server derives one per direct child — but a
    // detail panel that white-screens over a missing analytics row is worse than
    // one that says "not started".
    const rows = buildChildRows([child("STA-9", { estimatedSeconds: 600 })], {});
    expect(rows[0]!.estimatedSeconds).toBe(600); // falls back to the entity's own field
    expect(rows[0]!.actualSeconds).toBeNull();
    expect(rows[0]!.delta).toBeNull();
  });

  it("marks running children so their delta can be labelled provisional", () => {
    const rows = buildChildRows(
      [child("STA-1", { status: "in_progress" }), child("STA-2", { status: "done" })],
      {},
    );
    expect(rows[0]!.running).toBe(true);
    expect(rows[1]!.running).toBe(false);
  });

  it("carries each child's own activity, so one stalled row does not label the rest", () => {
    const rows = buildChildRows(
      [
        child("STA-1", { status: "in_progress" }),
        child("STA-2", { status: "in_progress" }),
        child("STA-3", { status: "done" }),
      ],
      {
        "STA-1": timing({ countedThrough: agoIso(30) }),
        "STA-2": timing({ countedThrough: agoIso(7200) }),
        "STA-3": timing({ activeSeconds: 600 }),
      },
      NOW,
    );
    expect(rows.map((row) => row.activity.kind)).toEqual(["running", "idle", "stopped"]);
    // Both unfinished rows are still PROVISIONAL — a different axis entirely.
    expect(rows.map((row) => row.running)).toEqual([true, true, false]);
  });

  it("takes the child's HEADLINE actual, so a child that is a parent shows its aggregate", () => {
    const rows = buildChildRows([child("STA-1")], {
      "STA-1": timing({ ownActiveSeconds: null, activeSeconds: 5400, childCount: 2 }),
    });
    expect(rows[0]!.actualSeconds).toBe(5400);
  });

  it("gives an unestimated, unstarted child a null delta and no invented zero", () => {
    const rows = buildChildRows([child("STA-1")], { "STA-1": timing() });
    expect(rows[0]!.estimatedSeconds).toBeNull();
    expect(rows[0]!.actualSeconds).toBeNull();
    expect(rows[0]!.delta).toBeNull();
  });
});

// --------------------------------------------------------------------- totals

describe("totals come from the server, counts come from the rows", () => {
  it("takes both sums from the timing payload rather than re-adding them", () => {
    /**
     * One source, so the page cannot disagree with `staple show`, with
     * `get_task`, or with itself. The mismatched numbers below are deliberate:
     * if this function ever starts summing the rows itself, it will return 900
     * and 300 instead of the server's figures and this test will catch it.
     */
    const rows = buildChildRows(
      [child("STA-1", { estimatedSeconds: 600 }), child("STA-2", { estimatedSeconds: 300 })],
      {
        "STA-1": timing({ estimatedSeconds: 600, activeSeconds: 300 }),
        "STA-2": timing({ estimatedSeconds: 300, activeSeconds: 100 }),
      },
    );
    const totals = computeTotals(
      timing({ childrenEstimatedSeconds: 12_600, childrenActiveSeconds: 15_000 }),
      rows,
    );
    expect(totals.estimatedSeconds).toBe(12_600);
    expect(totals.actualSeconds).toBe(15_000);
  });

  it("counts how much of the plan is missing, and separates moving work from stalled", () => {
    /**
     * PIN MOVED BY STA-90. `runningCount` used to mean "unfinished", because
     * under the two-timestamp scheme those were the same thing — an unfinished
     * task's number always grew. Now they are two facts, and the caveat below
     * says two different sentences about them, so the counts have to be two.
     */
    const rows = buildChildRows(
      [
        child("STA-1", { estimatedSeconds: 600, status: "done" }),
        child("STA-2", { status: "in_progress" }),
        child("STA-3", { status: "in_progress" }),
        child("STA-4"),
      ],
      {
        "STA-2": timing({ countedThrough: agoIso(30) }), // a live agent
        "STA-3": timing({ countedThrough: agoIso(7200) }), // one that stopped
      },
      NOW,
    );
    const totals = computeTotals(timing(), rows);
    expect(totals.childCount).toBe(4);
    expect(totals.plannedCount).toBe(1);
    expect(totals.runningCount).toBe(1);
    expect(totals.idleCount).toBe(1);
  });

  it("has a null delta when no child was estimated", () => {
    const totals = computeTotals(
      timing({ childrenEstimatedSeconds: null, childrenActiveSeconds: 3600 }),
      buildChildRows([child("STA-1")], {}),
    );
    expect(totals.delta).toBeNull();
  });
});

describe("the caveat says out loud why a total might mislead", () => {
  it("says plainly that no child has a plan, without claiming there is nothing to compare", () => {
    // The headline may still hold this issue's OWN estimate, so this sentence
    // reports the children and leaves the delta's absence to explainMissingDelta.
    const totals = computeTotals(
      timing({ childrenActiveSeconds: 3600 }),
      buildChildRows([child("STA-1"), child("STA-2")], {}),
    );
    expect(totalsCaveat(totals)).toBe("None of its 2 sub-tasks has an estimate.");
  });

  it("counts a child that INHERITED its plan as planned — the STA-156 caveat", () => {
    /**
     * R7b. STA-156's six direct children carry no own estimate, but STA-157's
     * three tasks give it an 11h plan. Coverage measured on own estimates would
     * print "6 of 6 children have no estimate" under an 11h headline; measured
     * on the effective plan, five are missing and one is not.
     */
    const rows = buildChildRows(
      [
        child("STA-157"),
        child("STA-158"),
        child("STA-159"),
        child("STA-160"),
        child("STA-161"),
        child("STA-162"),
      ],
      {
        "STA-157": timing({
          childCount: 3,
          subtreePlan: plan({
            estimatedSeconds: 39_600,
            source: "descendants",
            descendantsEstimatedSeconds: 39_600,
            contributingCount: 3,
            unplannedCount: 0,
            totalCount: 3,
          }),
        }),
      },
    );
    expect(rows[0]!.plannedSeconds).toBe(39_600);
    expect(rows[0]!.estimatedSeconds).toBeNull();
    const totals = computeTotals(timing(), rows);
    expect(totals.plannedCount).toBe(1);
    expect(totalsCaveat(totals)).toBe(
      "5 of its 6 sub-tasks have no estimate, so the plan leaves some of the work out.",
    );
    expect(totalsCaveat(totals)).not.toMatch(/6 of 6/);
  });

  it("warns when the two sides cover different work — the most quotable number", () => {
    /**
     * Two of five estimated means the estimated total spans two children while
     * the actual spans five. The comparison is apples to oranges, and this
     * headline is exactly the figure someone screenshots.
     */
    const rows = buildChildRows(
      [
        child("STA-1", { estimatedSeconds: 600 }),
        child("STA-2", { estimatedSeconds: 600 }),
        child("STA-3"),
        child("STA-4"),
        child("STA-5"),
      ],
      {},
    );
    const caveat = totalsCaveat(computeTotals(timing(), rows))!;
    expect(caveat).toMatch(/3 of its 5 sub-tasks have no estimate/);
    expect(caveat).toMatch(/the plan leaves some of the work out/);
  });

  it("gets the singular right for one missing plan", () => {
    const rows = buildChildRows(
      [child("STA-1", { estimatedSeconds: 600 }), child("STA-2")],
      {},
    );
    expect(totalsCaveat(computeTotals(timing(), rows))!).toMatch(/1 of its 2 sub-tasks has no estimate/);
  });

  it("warns that a favourable total is provisional while children still run", () => {
    const rows = buildChildRows(
      [
        child("STA-1", { estimatedSeconds: 600, status: "done" }),
        child("STA-2", { estimatedSeconds: 600, status: "in_progress" }),
      ],
      { "STA-2": timing({ countedThrough: agoIso(30) }) },
      NOW,
    );
    expect(totalsCaveat(computeTotals(timing(), rows))!).toBe(
      "1 sub-task is still being worked on, so the time spent is still growing.",
    );
  });

  it("gives the OPPOSITE warning for an unfinished child whose clock stopped", () => {
    // Not a wording tweak. "still growing" and "stopped at the last sign of
    // work" are opposite claims about the same total, and the old status-only
    // count made a stalled epic read as a busy one.
    const rows = buildChildRows(
      [
        child("STA-1", { estimatedSeconds: 600, status: "done" }),
        child("STA-2", { estimatedSeconds: 600, status: "in_progress" }),
      ],
      { "STA-2": timing({ countedThrough: agoIso(7200) }) },
      NOW,
    );
    expect(totalsCaveat(computeTotals(timing(), rows))!).toBe(
      "1 unfinished sub-task has gone quiet, so its clock has stopped.",
    );
  });

  it("says a total containing an approximated child is approximated", () => {
    const rows = buildChildRows(
      [
        child("STA-1", { estimatedSeconds: 600, status: "done" }),
        child("STA-2", { estimatedSeconds: 600, status: "done" }),
      ],
      { "STA-2": timing({ approximate: true }) },
      NOW,
    );
    const totals = computeTotals(timing(), rows);
    expect(totals.approximate).toBe(true);
    expect(totalsCaveat(totals)!).toMatch(/incomplete history/);
  });

  it("says nothing when a fully-estimated, fully-settled epic needs no caveat", () => {
    const rows = buildChildRows(
      [
        child("STA-1", { estimatedSeconds: 600, status: "done" }),
        child("STA-2", { estimatedSeconds: 600, status: "done" }),
      ],
      {},
    );
    expect(totalsCaveat(computeTotals(timing(), rows))).toBeNull();
  });
});

// ------------------------------------------------------------------ the summary

/**
 * R7b (STA-193). ONE headline for leaf and parent alike, led by the recursive
 * plan. The two named cases are the epic's own: STA-157 (no own estimate, three
 * planned tasks) must lead with 11h rather than "no estimate recorded", and
 * STA-156 above it must lead with that inherited 11h rather than "0 of 6
 * estimated".
 */
describe("the summary leads with the recursive plan", () => {
  const STA_157 = timing({
    childCount: 3,
    childrenEstimatedSeconds: 39_600,
    subtreePlan: plan({
      estimatedSeconds: 39_600,
      source: "descendants",
      descendantsEstimatedSeconds: 39_600,
      contributingCount: 3,
      unplannedCount: 0,
      totalCount: 3,
    }),
  });

  const STA_156 = timing({
    childCount: 6,
    childrenEstimatedSeconds: null, // depth-1: no direct child has an OWN estimate
    subtreePlan: plan({
      estimatedSeconds: 39_600,
      source: "descendants",
      descendantsEstimatedSeconds: 39_600,
      contributingCount: 3,
      unplannedCount: 6,
      totalCount: 9,
    }),
  });

  it("STA-157: an unestimated parent over three planned tasks plans 11h", () => {
    const summary = computeSummary(STA_157);
    expect(summary.plannedSeconds).toBe(39_600);
    expect(summary.planHint).toBe("planned from the estimates of the tasks under it (all 3 have one)");
  });

  it("STA-156: the plan survives an unestimated middle level, whatever depth-1 says", () => {
    const summary = computeSummary(STA_156);
    expect(summary.plannedSeconds).toBe(39_600);
    expect(summary.planHint).toBe("planned from the estimates of the tasks under it (3 of 9 have one)");
  });

  it("uses the own estimate when one is set, and says the descendants disagree", () => {
    const summary = computeSummary(
      timing({
        estimatedSeconds: 21_600,
        childCount: 3,
        subtreePlan: plan({
          estimatedSeconds: 21_600,
          source: "own",
          descendantsEstimatedSeconds: 39_600,
          contributingCount: 3,
          unplannedCount: 0,
          totalCount: 3,
        }),
      }),
    );
    expect(summary.plannedSeconds).toBe(21_600);
    expect(summary.planHint).toMatch(/the tasks under it add up to 11 hours/);
  });

  it("is a leaf's own estimate against its own time, with nothing to add", () => {
    const summary = computeSummary(
      timing({
        estimatedSeconds: 7200,
        ownActiveSeconds: 3600,
        activeSeconds: 3600,
        subtreePlan: plan({ estimatedSeconds: 7200, source: "own" }),
      }),
    );
    expect(summary.plannedSeconds).toBe(7200);
    expect(summary.actualSeconds).toBe(3600);
    expect(summary.delta!.label).toBe("1h under (50%)");
    expect(summary.planHint).toBeNull();
  });

  it("compares the recursive plan with the aggregate actual, not the depth-1 sum", () => {
    const summary = computeSummary({ ...STA_156, activeSeconds: 18_000, childrenActiveSeconds: 18_000 });
    expect(summary.delta!.label).toBe("6h under (55%)");
  });

  it("has no delta, and no invented zero, when either side is missing", () => {
    expect(computeSummary(STA_157).delta).toBeNull();
    expect(computeSummary(timing({ activeSeconds: 600 })).delta).toBeNull();
  });
});

// ---------------------------------------------------------------- the breakdown

describe("the breakdown names the source of every number", () => {
  it("is empty for a leaf, so a leaf gets one summary and nothing else", () => {
    expect(buildBreakdown(timing({ estimatedSeconds: 3600, activeSeconds: 600 }))).toEqual([]);
  });

  it("puts the top-down estimate and the bottom-up plan side by side, each labelled", () => {
    const rows = buildBreakdown(
      timing({
        estimatedSeconds: 21_600,
        ownActiveSeconds: 900,
        activeSeconds: 18_000,
        childCount: 3,
        childrenActiveSeconds: 18_000,
        subtreePlan: plan({
          estimatedSeconds: 21_600,
          source: "own",
          descendantsEstimatedSeconds: 39_600,
          contributingCount: 3,
          unplannedCount: 0,
          totalCount: 3,
        }),
      }),
    );
    expect(rows.map((row) => row.label)).toEqual(["This task itself", "Its sub-tasks"]);
    expect(rows[0]).toMatchObject({
      plannedSeconds: 21_600,
      planSource: "its own estimate",
      actualSeconds: 900,
      actualSource: "time spent on this task itself, not counted at the top",
    });
    expect(rows[1]).toMatchObject({
      plannedSeconds: 39_600,
      planSource: "from the tasks under it (all 3 have one)",
      actualSeconds: 18_000,
      actualSource: "added up from its 3 sub-tasks",
    });
  });

  it("names each absence rather than drawing a zero", () => {
    const rows = buildBreakdown(timing({ childCount: 2, subtreePlan: plan({ unplannedCount: 2, totalCount: 2 }) }));
    expect(rows[0]).toMatchObject({
      plannedSeconds: null,
      planSource: "No estimate of its own",
      actualSeconds: null,
      actualSource: "No time spent on it directly",
    });
    expect(rows[1]).toMatchObject({
      plannedSeconds: null,
      planSource: "None of the 2 tasks under it has an estimate",
      actualSeconds: null,
    });
  });

  it("says there is no live work beneath, not 0 of 0, when every descendant is cancelled", () => {
    const rows = buildBreakdown(timing({ childCount: 2, subtreePlan: plan({ totalCount: 2 }) }));
    expect(rows[1]).toMatchObject({ plannedSeconds: null, planSource: "No open tasks under it" });
    const cancelledOnly = timing({ childCount: 2, subtreePlan: plan({ totalCount: 2 }) });
    expect(summarySentence(computeSummary(cancelledOnly), cancelledOnly.subtreePlan)).toContain("None of the tasks under it is still open.");
  });
});

// ---------------------------------------------------------- the subtree plan

describe("the subtree plan says where its number came from", () => {
  it("names the coverage when the plan was inherited", () => {
    // STA-156 over STA-157 over three 4h/3h/4h leaves: nobody typed 11h, so
    // the figure has to say what it was built from — over plan UNITS at every
    // depth, not the one direct child the totals row counts. The middle level is
    // a container, not a gap, so the tree is fully planned: 3 of 3, not 3 of 4.
    expect(
      subtreePlanHint(
        plan({
          estimatedSeconds: 39_600,
          source: "descendants",
          descendantsEstimatedSeconds: 39_600,
          contributingCount: 3,
          unplannedCount: 0,
          totalCount: 4,
        }),
      ),
    ).toBe("planned from the estimates of the tasks under it (all 3 have one)");
  });

  it("shows the bottom-up number beside an own estimate, so a disagreement is visible", () => {
    expect(
      subtreePlanHint(
        plan({
          estimatedSeconds: 21_600,
          source: "own",
          descendantsEstimatedSeconds: 39_600,
          contributingCount: 3,
          unplannedCount: 0,
          totalCount: 3,
        }),
      ),
    ).toBe("its own estimate; the tasks under it add up to 11 hours (all 3 have one)");
  });

  it("adds nothing under an own estimate with no planned work beneath it, or under no plan at all", () => {
    expect(subtreePlanHint(plan({ estimatedSeconds: 3600, source: "own" }))).toBeNull();
    expect(subtreePlanHint(plan({ unplannedCount: 2, totalCount: 2 }))).toBeNull();
  });
});

// ------------------------------------------------ the child's effective plan (R7c)

/**
 * R7c (STA-194). A child's `est` is its EFFECTIVE plan — the figure its parent
 * counts it as — with the provenance in words for a tooltip, and the arithmetic
 * the ticket asks for: the parent's planned headline is exactly the sum of what
 * the child rows show.
 */

/** STA-157 as its parent sees it: nothing typed, 11h flowed up from three tasks. */
const INHERITED_11H = plan({
  estimatedSeconds: 39_600,
  source: "descendants",
  descendantsEstimatedSeconds: 39_600,
  contributingCount: 3,
  unplannedCount: 0,
  totalCount: 3,
});

describe("child rows carry the effective plan and say where it came from", () => {
  it("STA-157 under STA-156 plans 11h with no own estimate, and the hint says so", () => {
    const rows = buildChildRows([child("STA-157")], {
      "STA-157": timing({ childCount: 3, childrenEstimatedSeconds: 39_600, subtreePlan: INHERITED_11H }),
    });
    expect(rows[0]!.estimatedSeconds).toBeNull();
    expect(rows[0]!.plannedSeconds).toBe(39_600);
    expect(rows[0]!.planHint).toBe("planned from the estimates of the tasks under it (all 3 have one)");
  });

  it("names a plain own estimate as own — the column mixes typed and flowed-up figures", () => {
    const rows = buildChildRows([child("STA-1", { estimatedSeconds: 3600 })], {
      "STA-1": timing({ estimatedSeconds: 3600, subtreePlan: plan({ estimatedSeconds: 3600, source: "own" }) }),
    });
    expect(rows[0]!.plannedSeconds).toBe(3600);
    expect(rows[0]!.planHint).toBe("its own estimate");
  });

  it("keeps the descendants' disagreement in the hint when the own estimate wins", () => {
    const rows = buildChildRows([child("STA-1", { estimatedSeconds: 21_600 })], {
      "STA-1": timing({
        estimatedSeconds: 21_600,
        childCount: 3,
        subtreePlan: plan({
          estimatedSeconds: 21_600,
          source: "own",
          descendantsEstimatedSeconds: 39_600,
          contributingCount: 3,
          unplannedCount: 0,
          totalCount: 3,
        }),
      }),
    });
    expect(rows[0]!.plannedSeconds).toBe(21_600);
    expect(rows[0]!.planHint).toBe("its own estimate; the tasks under it add up to 11 hours (all 3 have one)");
  });

  it("has no hint when there is no plan to explain", () => {
    const rows = buildChildRows([child("STA-1")], { "STA-1": timing() });
    expect(rows[0]!.plannedSeconds).toBeNull();
    expect(rows[0]!.planHint).toBeNull();
  });

  it("falls back to the own field, and calls it own, when the timing entry is missing", () => {
    const [planned] = buildChildRows([child("STA-9", { estimatedSeconds: 600 })], {});
    expect(planned!.plannedSeconds).toBe(600);
    expect(planned!.planHint).toBe("its own estimate");
    const [bare] = buildChildRows([child("STA-9")], {});
    expect(bare!.planHint).toBeNull();
  });

  it("computes the delta on the effective plan, so an inheriting epic has one at all", () => {
    const rows = buildChildRows([child("STA-157", { status: "in_progress" })], {
      "STA-157": timing({ activeSeconds: 18_000, childCount: 3, subtreePlan: INHERITED_11H }),
    });
    // Against the own estimate this would be null — there is none — and the row would
    // say `—` beside an 11h plan the headline had just compared.
    expect(rows[0]!.delta!.label).toBe("6h under (55%)");
  });

  it("childPlanHint: own says own, inherited says inherited, none says nothing", () => {
    expect(childPlanHint(plan({ estimatedSeconds: 3600, source: "own" }))).toBe("its own estimate");
    expect(childPlanHint(INHERITED_11H)).toBe("planned from the estimates of the tasks under it (all 3 have one)");
    expect(childPlanHint(plan({ unplannedCount: 2, totalCount: 2 }))).toBeNull();
  });
});

describe("the parent's headline is the sum of the child rows' plans", () => {
  // STA-156 as the server hands it over: six direct children, one of them (STA-157)
  // inheriting 11h from grandchildren, the other five with nothing anywhere beneath.
  const STA_156 = timing({
    childCount: 6,
    childrenEstimatedSeconds: null,
    subtreePlan: plan({
      estimatedSeconds: 39_600,
      source: "descendants",
      descendantsEstimatedSeconds: 39_600,
      contributingCount: 3,
      unplannedCount: 6,
      totalCount: 9,
    }),
  });
  const rows = buildChildRows(
    ["STA-157", "STA-158", "STA-159", "STA-160", "STA-161", "STA-162"].map((id) => child(id)),
    { "STA-157": timing({ childCount: 3, childrenEstimatedSeconds: 39_600, subtreePlan: INHERITED_11H }) },
  );

  it("adds the visible child contributions to exactly the planned headline", () => {
    const visible = rows.reduce((sum, row) => sum + (row.plannedSeconds ?? 0), 0);
    expect(visible).toBe(39_600);
    expect(visible).toBe(computeSummary(STA_156).plannedSeconds);
    // ...and to the Children row of the breakdown — the same number under another label.
    expect(visible).toBe(buildBreakdown(STA_156).find((row) => row.label === "Its sub-tasks")!.plannedSeconds);
  });

  it("counts the inheriting child as planned, so the coverage caveat agrees with the sum", () => {
    expect(computeTotals(STA_156, rows).plannedCount).toBe(1);
    expect(totalsCaveat(computeTotals(STA_156, rows))).toMatch(/5 of its 6 sub-tasks have no estimate/);
  });

  it("is the same arithmetic as the spoken sentence", () => {
    expect(summarySentence(computeSummary(STA_156), STA_156.subtreePlan)).toMatch(/^Planned 11 hours\./);
  });
});

// ------------------------------------------------------ the spoken headline (R7c)

describe("the spoken headline says planned, actual, difference, coverage, source — in that order", () => {
  const STA_156 = timing({
    childCount: 6,
    activeSeconds: 18_000,
    childrenActiveSeconds: 18_000,
    subtreePlan: plan({
      estimatedSeconds: 39_600,
      source: "descendants",
      descendantsEstimatedSeconds: 39_600,
      contributingCount: 3,
      unplannedCount: 6,
      totalCount: 9,
    }),
  });

  it("reads the STA-156 headline as one sentence", () => {
    expect(summarySentence(computeSummary(STA_156), STA_156.subtreePlan)).toBe(
      "Planned 11 hours. 5 hours spent. 6 hours under the plan. 3 of the 9 tasks under it have an estimate. The plan comes from the estimates of the tasks under it.",
    );
  });

  it("names every absence in words, never as a dash", () => {
    const empty = timing();
    expect(summarySentence(computeSummary(empty), empty.subtreePlan)).toBe(
      "No estimate yet. No time spent yet.",
    );
  });

  it("keeps the order whatever the figures are", () => {
    const leaf = timing({
      estimatedSeconds: 7200,
      ownActiveSeconds: 3600,
      activeSeconds: 3600,
      subtreePlan: plan({ estimatedSeconds: 7200, source: "own" }),
    });
    const sentence = summarySentence(computeSummary(leaf), leaf.subtreePlan);
    const at = (word: string) => {
      const index = sentence.indexOf(word);
      expect(index, word).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at("Planned ")).toBeLessThan(at(" spent."));
    expect(at(" spent.")).toBeLessThan(at("under the plan."));
    expect(at("under the plan.")).toBeLessThan(at("The plan is"));
    expect(sentence).toMatch(/The plan is its own estimate\.$/);
  });

  it("rides a qualifying hint beside the figure it qualifies, not at the end", () => {
    const live = timing({
      estimatedSeconds: 7200,
      activeSeconds: 1800,
      subtreePlan: plan({ estimatedSeconds: 7200, source: "own" }),
    });
    const sentence = summarySentence(computeSummary(live), live.subtreePlan, {
      actual: "still being worked on",
      difference: "not finished, so this can still change",
    });
    expect(sentence).toContain("30 minutes spent (still being worked on).");
    expect(sentence).toContain("1 hour 30 minutes under the plan (not finished, so this can still change).");
  });
});

// ------------------------------------------------------------------ quality states

describe("quality states are named, never decided, here", () => {
  it("prints the server's state and its reasons in words, and nothing for a cancelled issue", () => {
    expect(qualityText({ state: "exact", reasons: [] })).toBe("measured exactly");
    expect(qualityText({ state: "approximate", reasons: ["sparse", "capture_gap"] })).toBe("approximate, because it had pauses of over 30 minutes and some work happened before tracking started");
    // The state's own reason would only repeat it.
    expect(qualityText({ state: "timing-floor", reasons: ["timing_floor"] })).toBe("took under a minute");
    expect(qualityText({ state: "reconstructed", reasons: ["reconstructed", "sparse"] })).toBe("rebuilt from history, because it had pauses of over 30 minutes");
    expect(qualityText({ state: "missing", reasons: ["no_worker_attempt"] })).toBe("not measured, because no work session was recorded");
    // A code from a newer server is shown verbatim rather than dropped.
    expect(qualityText({ state: "approximate", reasons: ["brand_new"] })).toBe("approximate, because brand new");
    expect(qualityText({ state: null, reasons: [] })).toBeNull();
    // Never worked is "not started", not "not measured".
    expect(qualityText({ state: "missing", reasons: ["never_started"] })).toBe("not started");
  });

  it("puts the work figure beside a child's state, since the row's ran is category time", () => {
    expect(childQualityText({ workState: "reconstructed", workSeconds: 1010, workReasons: ["reconstructed"] })).toBe("17 minutes of agent work, rebuilt from history");
    expect(childQualityText({ workState: "missing", workSeconds: null, workReasons: ["never_started"] })).toBe("not started");
    expect(childQualityText({ workState: "missing", workSeconds: null, workReasons: ["no_worker_attempt"] })).toBe("not measured");
    expect(childQualityText({ workState: null, workSeconds: null, workReasons: [] })).toBeNull();
  });

  it("carries each child's work state onto its row", () => {
    const rows = buildChildRows(
      [{ identifier: "STA-1", title: "one", status: "done", estimatedSeconds: null }],
      { "STA-1": timing({ quality: { work: { state: "approximate", inputs: ["sparse"], reasons: ["sparse"], coverage: null, missingInputs: [] }, wall: { state: "exact", inputs: [], reasons: [] } } }) },
      NOW,
    );
    expect(rows[0]!.workState).toBe("approximate");
    expect(buildChildRows([{ identifier: "STA-2", title: "two", status: "done", estimatedSeconds: null }], {}, NOW)[0]!.workState).toBeNull();
  });

  it("sums a cohort over its eligible leaves, leaving zero states out", () => {
    const report = {
      population: { issues: 9, eligible: 8, notEligible: { parents: 1, open: 0, cancelled: 0 } },
      work: { counts: { exact: 6, "timing-floor": 1, approximate: 1, reconstructed: 0, missing: 0 } },
    } as unknown as TimingQualityReport;
    expect(cohortLine(report)).toBe("Of the 8 finished tasks under it: 6 measured exactly (75%), 1 took under a minute, 1 approximate.");
    expect(cohortLine({ ...report, population: { ...report.population, eligible: 0 } })).toBeNull();
  });
});

// ------------------------------------------------------------------ the Time tab's words

describe("durations in words keep formatDuration's precision", () => {
  it("says each unit in words, two at most, largest first", () => {
    expect(spokenDuration(45)).toBe("45 seconds");
    expect(spokenDuration(1)).toBe("1 second");
    expect(spokenDuration(1200)).toBe("20 minutes");
    expect(spokenDuration(231)).toBe("4 minutes");
    expect(spokenDuration(3600)).toBe("1 hour");
    expect(spokenDuration(21_600)).toBe("6 hours");
    expect(spokenDuration(11_400)).toBe("3 hours 10 minutes");
    expect(spokenDuration(21_360)).toBe("5 hours 56 minutes");
    expect(spokenDuration(187_200)).toBe("2 days 4 hours");
    expect(spokenDuration(86_400)).toBe("1 day");
  });

  it("carries a rounded minute into the hour rather than saying 60 minutes", () => {
    expect(spokenDuration(3590)).toBe("1 hour");
  });

  it("never says NaN", () => {
    expect(spokenDuration(Number.NaN)).toBe("0 seconds");
  });
});

describe("the difference as a sentence", () => {
  it("says what is left while the work is running, and the verdict once it is not", () => {
    const under = computeDelta(21_600, 240)!;
    expect(plainDelta(under, true)).toBe("5 hours 56 minutes left in the plan");
    expect(plainDelta(under, false)).toBe("Finished 5 hours 56 minutes under the plan");
    const over = computeDelta(3600, 4800)!;
    expect(plainDelta(over, true)).toBe("20 minutes over the plan so far");
    expect(plainDelta(over, false)).toBe("Took 20 minutes longer than planned");
    expect(plainDelta(computeDelta(3600, 3600)!, false)).toBe("Right on the plan");
  });

  it("has a short form for a sub-task row, with no percentage", () => {
    expect(shortDelta(computeDelta(10_800, 3600)!)).toBe("2 hours under the plan");
    expect(shortDelta(computeDelta(3600, 4800)!)).toBe("20 minutes over the plan");
    expect(shortDelta(computeDelta(3600, 3600)!)).toBe("right on the plan");
  });
});

describe("the spoken summary at the edges", () => {
  it("says an absent plan as a fact, never as a plan that comes from no estimate", () => {
    const leaf = timing({ activeSeconds: 600 });
    const sentence = summarySentence(computeSummary(leaf), leaf.subtreePlan);
    expect(sentence).toBe("No estimate yet. 10 minutes spent.");
    expect(sentence).not.toMatch(/comes from no estimate/);
  });

  it("says a few seconds as less than a minute, never as 0 seconds", () => {
    const blink = timing({ estimatedSeconds: 3600, activeSeconds: 0, subtreePlan: plan({ estimatedSeconds: 3600, source: "own" }) });
    const sentence = summarySentence(computeSummary(blink), blink.subtreePlan);
    expect(sentence).toContain("Less than a minute spent.");
    expect(sentence).not.toMatch(/\b0 seconds\b/);
    expect(spokenSpent(0)).toBe("less than a minute");
    expect(spokenSpent(59)).toBe("less than a minute");
    expect(spokenSpent(60)).toBe("1 minute");
  });

  it("lets a timing-floor state speak for itself on a sub-task", () => {
    expect(childQualityText({ workState: "timing-floor", workSeconds: 0, workReasons: ["timing_floor"] })).toBe("took under a minute");
  });
});
