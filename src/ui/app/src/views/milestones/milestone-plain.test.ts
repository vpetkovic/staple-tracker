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
} from "./milestone-plain";

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
        waiting: { onTasksNotStarted: 2, onTasksStarted: {}, onPerson: 1 },
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
    const risk = { overdue: false, blocked: 7, gated: 0, waitingIn: { review: 7 }, waiting: { onTasksNotStarted: 0, onTasksStarted: { review: 7 }, onPerson: 0 } };
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
    const risk = { overdue: false, blocked: 4, gated: 0, waitingIn: { unstarted: 3, blocked: 1 }, waiting: { onTasksNotStarted: 3, onTasksStarted: {}, onPerson: 1 } };
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
  const remaining = (forecastHours: number | null, estimateHours: number | null = forecastHours, unestimated = 0) => ({
    estimated: forecastHours === null ? 0 : 3,
    unestimated,
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
      "12h of work left (8h estimated, scaled by how long estimates have really taken), counted from now. Set a date to override it.",
    );
    expect(projectionNote(projectedDue(remaining(1, 1, 1), NOW)!)).toContain("1 open task has no estimate and is not included, so it can only be later.");
  });
});

describe("the due day is the UTC day the store judges overdue by", () => {
  it("agrees with the store near midnight, whatever the local time zone", () => {
    const zone = process.env.TZ;
    try {
      // 23:30 on 27 Sep in Los Angeles is 06:30 on 28 Sep in UTC: the store's day is the 28th.
      process.env.TZ = "America/Los_Angeles";
      const lateEvening = new Date("2026-09-28T06:30:00.000Z");
      expect(daysFrom("2026-09-28", lateEvening)).toBe(0);
      expect(plainDue("2026-09-28", "active", lateEvening)).toBe("Due today");
      // The 27th ended in UTC, so the store says overdue; the words say late too.
      expect(plainDue("2026-09-27", "overdue", lateEvening)).toMatch(/^Was due 27 Sept?, 1 day ago$/);
    } finally {
      if (zone === undefined) delete process.env.TZ;
      else process.env.TZ = zone;
    }
  });
});
