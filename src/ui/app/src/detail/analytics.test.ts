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
  buildChildRows,
  computeDelta,
  computeTotals,
  explainMissingDelta,
  formatDuration,
  formatOptionalDuration,
  headline,
  isAggregated,
  isStillRunning,
  totalsCaveat,
} from "./analytics";
import { STALE_CLAIM_SECONDS } from "../lib/claim";
import type { IssueStatus, IssueTiming } from "../lib/types";

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
      backlog: 0, todo: 0, in_progress: 0, in_review: 0, done: 0, blocked: 0, cancelled: 0,
    },
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
    expect(formatOptionalDuration(null, NO_ESTIMATE)).toBe("no estimate recorded");
    expect(formatOptionalDuration(null, NOT_STARTED)).toBe("not started");
    expect(formatOptionalDuration(null, NO_ESTIMATE)).not.toBe("0s");
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
    expect(explainMissingDelta(null, null)).toBe("No estimate and no time recorded yet.");
  });

  it("names WHICH side is missing", () => {
    expect(explainMissingDelta(null, 3600)).toMatch(/No estimate recorded/);
    expect(explainMissingDelta(3600, null)).toMatch(/Not started yet/);
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
    expect(activityHint(state)).toBe("still running");
  });

  it("says IDLE once the evidence goes stale, and names how stale", () => {
    // VP's second screenshot: an agent that stopped, still labelled "still
    // running". The replacement sentence has to say the number is not moving AND
    // why, or it is just a differently-worded lie.
    const state = activityState(agoIso(7200), NOW);
    expect(state).toEqual({ kind: "idle", idleSeconds: 7200 });
    expect(activityHint(state)).toBe("idle 2h — clock stopped at last activity");
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
    expect(aggregationHint(3)).toBe("aggregated from 3 children");
    expect(aggregationHint(1)).toBe("aggregated from 1 child");
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
    expect(totals.estimatedCount).toBe(1);
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
  it("refuses to compare at all when nothing was estimated", () => {
    const totals = computeTotals(
      timing({ childrenActiveSeconds: 3600 }),
      buildChildRows([child("STA-1"), child("STA-2")], {}),
    );
    expect(totalsCaveat(totals)).toBe(
      "No child has an estimate, so there is no plan to compare against.",
    );
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
    expect(caveat).toMatch(/3 of 5 children have no estimate/);
    expect(caveat).toMatch(/different work on each side/);
  });

  it("gets the singular right for one missing estimate", () => {
    const rows = buildChildRows(
      [child("STA-1", { estimatedSeconds: 600 }), child("STA-2")],
      {},
    );
    expect(totalsCaveat(computeTotals(timing(), rows))!).toMatch(/1 of 2 child has no estimate/);
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
      "1 still running, so the actual is still growing.",
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
      "1 unfinished but idle, so its clock has stopped at the last sign of work.",
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
    expect(totalsCaveat(totals)!).toMatch(/no usable history/);
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

// ------------------------------------------------------------------- headline

describe("the headline is a duration, not a productivity multiplier", () => {
  it("reports time saved when execution beat the plan", () => {
    const totals = computeTotals(
      timing({ childrenEstimatedSeconds: 14_400, childrenActiveSeconds: 3600 }),
      [],
    );
    expect(headline(totals)).toBe("3h less than planned.");
  });

  it("reports the overrun just as plainly when it did not", () => {
    // Symmetric on purpose: a readout that only celebrates wins is marketing.
    const totals = computeTotals(
      timing({ childrenEstimatedSeconds: 3600, childrenActiveSeconds: 14_400 }),
      [],
    );
    expect(headline(totals)).toBe("3h more than planned.");
  });

  it("says so when the plan was matched exactly", () => {
    const totals = computeTotals(
      timing({ childrenEstimatedSeconds: 3600, childrenActiveSeconds: 3600 }),
      [],
    );
    expect(headline(totals)).toBe("Execution matched the plan exactly.");
  });

  it("explains itself instead of printing a number when a side is missing", () => {
    const totals = computeTotals(timing({ childrenActiveSeconds: 3600 }), []);
    expect(headline(totals)).toMatch(/No estimate recorded/);
    expect(headline(totals)).not.toMatch(/\d+h/);
  });

  it("never claims a multiplier", () => {
    // A multiplier ("3.2x faster") reads as a claim about people; a duration
    // reads as a measurement, which is all this data can honestly support.
    // Richer framings are STA-83's brainstorm, deliberately not invented here.
    const totals = computeTotals(
      timing({ childrenEstimatedSeconds: 14_400, childrenActiveSeconds: 3600 }),
      [],
    );
    expect(headline(totals)).not.toMatch(/x|times|faster/i);
  });
});
