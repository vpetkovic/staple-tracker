import { describe, expect, it } from "vitest";
import { daysFrom, plainDue, progressSentence, riskSentence } from "./milestone-plain";

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

  it("names blocked and gated work, and stays silent when there is none", () => {
    expect(riskSentence({ overdue: false, blocked: 1, gated: 2 })).toBe("1 is blocked and 2 wait for approval.");
    expect(riskSentence({ overdue: true, blocked: 0, gated: 0 })).toBeNull();
  });
});
