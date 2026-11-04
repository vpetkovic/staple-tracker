import { describe, expect, it } from "vitest";
import {
  cancelledSentence,
  daysFrom,
  dueText,
  projectedDue,
  projectionNote,
  plainDue,
  progressBuckets,
  progressDetailSentence,
  progressSegments,
  progressSentence,
  riskSentence,
  shownState,
  waitBreakdown,
} from "./milestone-plain";
import { paceText, shownPace } from "@/lib/goal-text";
import { effective } from "@/views/queue/fixtures";
import { view } from "./fixtures";
import { milestoneRisk } from "./milestones-model";

const NOW = new Date(2026, 8, 27, 15, 30); // 27 Sep 2026, afternoon, local time

describe("plainDue", () => {
  it("counts calendar days, not 24-hour periods", () => {
    expect(daysFrom("2026-09-27", NOW)).toBe(0);
    expect(daysFrom("2026-09-28", NOW)).toBe(1);
    expect(daysFrom("2026-09-20", NOW)).toBe(-7);
  });

  it("says today, tomorrow, a distance ahead and a distance behind", () => {
    expect(plainDue("2026-09-27", "active", NOW)).toBe("Due today");
    expect(plainDue("2026-09-28", "active", NOW)).toBe("Due tomorrow");
    expect(plainDue("2026-10-15", "active", NOW)).toBe("Due 15 Oct, in 18 days");
    expect(plainDue("2026-09-20", "overdue", NOW)).toMatch(/^Was due 20 Sept?, 7 days ago$/);
    expect(plainDue("2027-01-03", "planned", NOW)).toBe("Due 3 Jan 2027, in 98 days");
  });

  it("does not count lateness on finished work, and names a missing date", () => {
    expect(plainDue("2026-09-20", "done", NOW)).toMatch(/^Was due 20 Sept?$/);
    expect(plainDue(null, "active", NOW)).toBe("No due date");
  });
});

describe("progress and risk sentences", () => {
  const progress = (done: number, countable: number, complete = false) => ({
    total: countable,
    countable,
    percent: countable ? Math.floor((done * 100) / countable) : null,
    complete,
    counts: { unstarted: 0, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done, cancelled: 0 },
  });

  it("reads the store's counts", () => {
    expect(progressSentence(progress(1, 4))).toBe("1 of 4 tasks finished (25%).");
    expect(progressSentence(progress(4, 4, true))).toBe("All 4 tasks are finished.");
    expect(progressSentence(progress(0, 0))).toBe("No tasks to count yet.");
  });

  it("names blocked work in the bar's own number, and stays silent when there is none", () => {
    const open = { total: 4, countable: 4, percent: 0, complete: false, counts: { unstarted: 2, ready: 1, active: 0, review: 0, gated: 1, blocked: 0, done: 0, cancelled: 0 } };
    // One gated by status, two not-started tasks the queue holds back: three blocked.
    // Without saying what it waits on, the bucket alone.
    expect(riskSentence(open, { overdue: false, blocked: 2, gated: 1, waitingIn: { unstarted: 2, gated: 1 } })).toBe("3 are blocked.");
    // With the queue's reading: two wait on other tasks, one (gated by status) on a person.
    expect(
      riskSentence(open, {
        overdue: false,
        blocked: 2,
        gated: 1,
        waitingIn: { unstarted: 2, gated: 1 },
        waiting: { onTasksNotStarted: 2, startedOnTasks: {}, startedOnGate: {} },
      }),
    ).toBe("3 are blocked: 2 wait on other tasks, 1 on a person.");
    expect(riskSentence(progress(0, 3), { overdue: true, blocked: 0, gated: 0 })).toBeNull();
    expect(riskSentence(progress(0, 3), null)).toBeNull();
  });

  it("says how many cancelled tasks the count leaves out", () => {
    const withCancelled = (n: number) => ({ ...progress(0, 9), total: 9 + n, counts: { ...progress(0, 9).counts, cancelled: n } });
    expect(cancelledSentence(withCancelled(0))).toBeNull();
    expect(cancelledSentence(withCancelled(1))).toBe("1 cancelled task is not counted.");
    expect(cancelledSentence(withCancelled(2))).toBe("2 cancelled tasks are not counted.");
  });
});

describe("the bar, from progress and the queue", () => {
  const p = (c: Partial<Record<string, number>>, countable: number, complete = false) => ({
    total: countable + (c.cancelled ?? 0),
    countable,
    percent: 0,
    complete,
    counts: { unstarted: 0, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done: 0, cancelled: 0, ...c },
  });

  it("gives in-review work its own bucket, in the in-review hue, never lumped into in progress", () => {
    // The milestone VP reported: nine tasks, all in review, seven still waiting on another, one cancelled.
    const progress = p({ review: 9, cancelled: 1 }, 9);
    const risk = { overdue: false, blocked: 7, gated: 0, waitingIn: { review: 7 }, waiting: { onTasksNotStarted: 0, startedOnTasks: { review: 7 }, startedOnGate: {} } };
    expect(progressBuckets(progress, risk)).toEqual({ done: 0, review: 9, active: 0, blocked: 0, ready: 0, notStarted: 0 });
    const segments = progressSegments(progress, risk);
    expect(segments.map((s) => [s.key, s.count, s.word])).toEqual([
      ["done", 0, "finished"],
      ["review", 9, "in review"],
      ["active", 0, "in progress"],
      ["blocked", 0, "blocked"],
      ["ready", 0, "to do"],
      ["open", 0, "not started"],
    ]);
    expect(segments.find((s) => s.key === "review")!.color).toBe("var(--status-task-in_review)");
    // The legend sums to the headline's denominator: every countable task in exactly one bucket.
    expect(segments.reduce((sum, s) => sum + s.count, 0)).toBe(progress.countable);
    // The wait is named where it is, not as a "blocked" count the legend contradicts.
    expect(riskSentence(progress, risk)).toBe("7 in review still wait on other tasks.");
    expect(progressDetailSentence({ progress, next: null }, risk)).toBe(
      "7 in review still wait on other tasks. 1 cancelled task is not counted. Nothing here can be picked up right now.",
    );
  });

  it("counts the queue's blocked tasks that have not started in the blocked bucket, so bar and sentence agree", () => {
    // A docs milestone: five tasks, none started by status, four waiting on another by the queue.
    const progress = p({ unstarted: 4, blocked: 1 }, 5);
    const risk = { overdue: false, blocked: 4, gated: 0, waitingIn: { unstarted: 3, blocked: 1 }, waiting: { onTasksNotStarted: 3, startedOnTasks: {}, startedOnGate: {} } };
    expect(progressBuckets(progress, risk)).toEqual({ done: 0, review: 0, active: 0, blocked: 4, ready: 0, notStarted: 1 });
    expect(riskSentence(progress, risk)).toBe("4 are blocked: 3 wait on other tasks, 1 on a person.");
    const blocked = progressSegments(progress, risk).find((s) => s.key === "blocked")!;
    expect(blocked.count).toBe(4);
    expect(blocked.color).toBe("var(--status-task-blocked)");
  });

  it("keeps to-do and not-started apart, in the hues their status glyphs use", () => {
    const progress = p({ ready: 2, unstarted: 3, active: 1 }, 6);
    const segments = progressSegments(progress, null);
    expect(segments.find((s) => s.key === "ready")).toMatchObject({ count: 2, color: "var(--status-task-todo)" });
    expect(segments.find((s) => s.key === "open")).toMatchObject({ count: 3, color: "var(--status-task-backlog)" });
    expect(segments.find((s) => s.key === "active")).toMatchObject({ count: 1, color: "var(--status-task-in_progress)" });
  });
});

describe("the due date: the set target, else the projection from the work left", () => {
  const remaining = (forecastHours: number | null, estimateHours: number | null = forecastHours, unknown = 0) => ({
    estimated: forecastHours === null ? 0 : 3,
    unestimated: unknown,
    unknown,
    estimateSeconds: estimateHours === null ? null : estimateHours * 3600,
    forecastSeconds: forecastHours === null ? null : forecastHours * 3600,
  });

  it("projects from the calibrated SUM of the open tasks' estimates, counted from now", () => {
    // 40h estimated, scaled to 54h by how long estimates have really taken: from 15:30 on
    // 27 Sep, 54h lands at 21:30 on 29 Sep. The scaled figure, not the raw one, decides.
    const projection = projectedDue(remaining(54, 40), NOW)!;
    expect(projection.seconds).toBe(54 * 3600);
    expect(projection.estimateSeconds).toBe(40 * 3600);
    expect(projection.at.getTime() - NOW.getTime()).toBe(54 * 3600 * 1000);
    expect(dueText({ targetDate: null, state: "active" }, projection, NOW)).toMatch(/^Due ~29 Sept? \(estimated\)$/);
  });

  it("says 'no earlier than' in the label when some open work has no estimate", () => {
    const projection = projectedDue(remaining(8, 8, 2), NOW)!;
    expect(dueText({ targetDate: null, state: "active" }, projection, NOW)).toMatch(/^Due no earlier than ~27 Sept? \(estimated\)$/);
  });

  it("has nothing to project without estimated work left", () => {
    expect(projectedDue(remaining(null), NOW)).toBeNull();
    expect(projectedDue(null, NOW)).toBeNull();
    expect(dueText({ targetDate: null, state: "planned" }, null, NOW)).toBe("No due date");
  });

  it("lets a target the person set win over the projection", () => {
    const projection = projectedDue(remaining(1), NOW);
    expect(dueText({ targetDate: "2026-10-15", state: "active" }, projection, NOW)).toBe("Due 15 Oct, in 18 days");
  });

  it("says when a finished milestone closed, and never repeats the pill's 'Cancelled'", () => {
    expect(dueText({ targetDate: null, state: "done", closedAt: "2026-09-26T12:00:00.000Z" }, null, NOW)).toMatch(/^Finished 26 Sept?$/);
    expect(dueText({ targetDate: null, state: "done" }, null, NOW)).toBe("Finished");
    expect(dueText({ targetDate: null, state: "cancelled", closedAt: "2026-09-26T12:00:00.000Z" }, null, NOW)).toMatch(/^Closed 26 Sept?$/);
    expect(dueText({ targetDate: null, state: "cancelled" }, null, NOW)).not.toContain("Cancelled");
    // A finished milestone never shows a projection, whatever the estimates say.
    expect(dueText({ targetDate: null, state: "done" }, projectedDue(remaining(1), NOW), NOW)).toBe("Finished");
  });

  it("says in its tooltip what it counted and what it left out", () => {
    expect(projectionNote(projectedDue(remaining(12, 8), NOW)!)).toBe(
      "All open work: 8h estimated, ~12h by the forecast (estimates scaled by how long they have really taken; work in review counts as done), counted from now. Set a date to override it.",
    );
    expect(projectionNote(projectedDue(remaining(1, 1, 1), NOW)!)).toContain(
      "1 open task cannot be forecast (no estimate, or nothing like it finished yet) and is not in it, so the day can only be later.",
    );
  });
});

describe("the due day is the reader's own calendar day", () => {
  /** Run with the process in `zone`, as a browser there would. */
  function inZone<T>(zone: string, fn: () => T): T {
    const was = process.env.TZ;
    process.env.TZ = zone;
    try {
      return fn();
    } finally {
      if (was === undefined) delete process.env.TZ;
      else process.env.TZ = was;
    }
  }

  it("reads 'tomorrow' in New York at 21:30, when it is already the next day in UTC", () => {
    inZone("America/New_York", () => {
      // 21:30 on 28 Sep in New York (EDT) is 01:30 on 29 Sep in UTC.
      const evening = new Date("2026-09-29T01:30:00.000Z");
      expect(daysFrom("2026-09-29", evening)).toBe(1);
      expect(plainDue("2026-09-29", "active", evening)).toBe("Due tomorrow");
      expect(plainDue("2026-09-28", "active", evening)).toBe("Due today");
      // The store, on the UTC day, already calls the 28th late; the page does not.
      expect(shownState({ state: "overdue", targetDate: "2026-09-28" }, evening)).toBe("active");
    });
  });

  it("calls a target late in Tokyo in the morning, before the UTC day has turned", () => {
    inZone("Asia/Tokyo", () => {
      // 08:00 on 29 Sep in Tokyo is 23:00 on 28 Sep in UTC: the store still says due today.
      const morning = new Date("2026-09-28T23:00:00.000Z");
      expect(daysFrom("2026-09-28", morning)).toBe(-1);
      expect(plainDue("2026-09-28", "active", morning)).toMatch(/^Was due 28 Sept?, 1 day ago$/);
      expect(shownState({ state: "active", targetDate: "2026-09-28" }, morning)).toBe("overdue");
    });
  });

  it("judges the pace on the same local day", () => {
    inZone("America/New_York", () => {
      const evening = new Date("2026-09-29T01:30:00.000Z");
      // The check, on the UTC day, says the target is today and 2h of work fits in 22.5h of UTC day.
      const pace = { targetDate: "2026-09-29", daysToTarget: 0, leaves: { done: 1, countable: 2, percent: 50 }, laborSeconds: 7200, remainingSeconds: 7200, partial: false, unplannedRefs: [], verdict: "on_track" as const, message: "" };
      expect(shownPace(pace, evening)).toMatchObject({ daysToTarget: 1, verdict: "on_track" });
      expect(paceText(pace, evening)).toContain("1 day to 29 Sept");
      // And a target the UTC check calls overdue that is today here is not overdue here.
      expect(shownPace({ ...pace, targetDate: "2026-09-28", daysToTarget: -1, verdict: "overdue" }, evening).verdict).toBe("on_track");
    });
  });
});


describe("the details add up to the bar, whatever the mix", () => {
  /**
   * Many milestones' worth of leaves, each a status and a queue verdict the resolver could give
   * it: held for a blocker, queued behind an approval gate, or free. Whatever the mix, the two
   * "blocked" rows of the details add up to the bar's blocked bucket, and every countable leaf
   * is in exactly one bucket.
   */
  const STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked", "awaiting_approval"] as const;
  const CATEGORY: Record<(typeof STATUSES)[number], keyof ReturnType<typeof counts0>> = {
    backlog: "unstarted",
    todo: "ready",
    in_progress: "active",
    in_review: "review",
    blocked: "blocked",
    awaiting_approval: "gated",
  };
  function counts0() {
    return { unstarted: 0, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done: 0, cancelled: 0 };
  }
  let seed = 7;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;

  it("splits the blocked bucket exactly into 'on other tasks' and 'on a person'", () => {
    for (let trial = 0; trial < 300; trial += 1) {
      const leaves = Array.from({ length: 1 + Math.floor(random() * 12) }, (_, i) => {
        const status = pick(STATUSES);
        // A status parked for a person is held by the queue too; anything else may or may not be.
        const eligibility =
          status === "blocked" ? "blocked" : status === "awaiting_approval" ? "gated" : pick(["eligible", "blocked", "gated"] as const);
        return { identifier: `STA-${i}`, status, eligibility };
      });
      const counts = counts0();
      for (const leaf of leaves) counts[CATEGORY[leaf.status]] += 1;
      const progress = { total: leaves.length, countable: leaves.length, percent: 0, complete: false, counts };
      const risk = milestoneRisk(
        view({ milestone: { identifier: "STA-1" } }),
        leaves.map((leaf) => effective({ ...leaf, milestonePath: ["STA-1"] })),
      );
      const w = waitBreakdown(progress, risk);
      const b = progressBuckets(progress, risk);
      expect(w.onTasks + w.onPerson, JSON.stringify(leaves)).toBe(b.blocked);
      expect(w.onTasks).toBeGreaterThanOrEqual(0);
      expect(w.onPerson).toBeGreaterThanOrEqual(0);
      expect(b.done + b.review + b.active + b.blocked + b.ready + b.notStarted).toBe(progress.countable);
      // Started work that waits is never filed as blocked: it is drawn in review or in progress.
      const started = leaves.filter((leaf) => (leaf.status === "in_review" || leaf.status === "in_progress") && leaf.eligibility !== "eligible").length;
      expect(w.startedOnTasks.active + w.startedOnTasks.review + w.startedOnGate.active + w.startedOnGate.review).toBe(started);
    }
  });

  it("files started work held behind an epic's approval gate as started, not as waiting on a person", () => {
    // The reviewer's repro: a gated epic whose children are in review, in progress and to do.
    const leaves = [
      { identifier: "STA-2", status: "in_review", eligibility: "gated" },
      { identifier: "STA-3", status: "in_review", eligibility: "gated" },
      { identifier: "STA-4", status: "in_progress", eligibility: "gated" },
      { identifier: "STA-5", status: "todo", eligibility: "gated" },
      { identifier: "STA-6", status: "backlog", eligibility: "blocked" },
    ] as const;
    const progress = { total: 5, countable: 5, percent: 0, complete: false, counts: { ...counts0(), review: 2, active: 1, ready: 1, unstarted: 1 } };
    const risk = milestoneRisk(view({ milestone: { identifier: "STA-1" } }), leaves.map((leaf) => effective({ ...leaf, milestonePath: ["STA-1"] })));
    expect(waitBreakdown(progress, risk)).toEqual({
      blocked: 2,
      onTasks: 1,
      onPerson: 1,
      startedOnTasks: { active: 0, review: 0 },
      startedOnGate: { active: 1, review: 2 },
    });
    expect(riskSentence(progress, risk)).toBe(
      "2 are blocked: 1 waits on other tasks, 1 on a person. 1 in progress and 2 in review wait for an approval.",
    );
  });
});
