/**
 * STA-171 — the milestone model is pure, so it gets pure tests: no store, no db.
 *
 * What is pinned is the CONTRACT in `docs/milestones.md`: the UTC inclusive-day
 * date rules, the sparse-rank encoding shared with the queue, the membership
 * refusals, and the count-each-leaf-once progress rollup with its duplicate,
 * nested, cancelled and reopened cases. R3b's store tests build on these; they
 * do not re-prove them.
 */
import { describe, expect, it } from "vitest";
import {
  MEMBER_RANK_STEP,
  MILESTONE_KIND,
  MILESTONE_KIND_MISSING_MESSAGE,
  type ProgressNode,
  assertMembershipAllowed,
  assertMilestoneDates,
  assertMilestoneKindConfigured,
  daysUntil,
  isOverdue,
  milestoneDateBounds,
  milestoneProgress,
  milestoneState,
  nearestMilestone,
  parseMilestoneDate,
  rankBetween,
  renumberedRanks,
  utcDateOf,
} from "../src/core/milestones.js";
import { StapleError, type StatusCategory } from "../src/core/types.js";

function validation(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe("validation");
    return error as StapleError;
  }
  throw new Error("expected a validation error");
}

describe("parseMilestoneDate", () => {
  it("accepts a real calendar day and nothing else", () => {
    expect(parseMilestoneDate("2026-10-31")).toBe("2026-10-31");
    expect(parseMilestoneDate(" 2028-02-29 ")).toBe("2028-02-29");
    for (const bad of ["2026-02-30", "2027-02-29", "2026-13-01", "2026-10-1", "10/31/2026", "2026-10-31T00:00:00Z", ""]) {
      expect(validation(() => parseMilestoneDate(bad)).message, bad).toContain("YYYY-MM-DD");
    }
  });
});

describe("date boundaries", () => {
  it("milestoneDateBounds is the inclusive UTC day", () => {
    expect(milestoneDateBounds("2026-10-31")).toEqual({
      startsAt: "2026-10-31T00:00:00.000Z",
      endsAt: "2026-10-31T23:59:59.999Z",
    });
  });

  it("utcDateOf reads the UTC day, not the local one", () => {
    expect(utcDateOf("2026-10-31T23:59:59.999Z")).toBe("2026-10-31");
    expect(utcDateOf("2026-11-01T00:00:00.000Z")).toBe("2026-11-01");
    // An offset timestamp is normalised to UTC before the day is read.
    expect(utcDateOf("2026-10-31T22:00:00-05:00")).toBe("2026-11-01");
    expect(validation(() => utcDateOf("yesterday")).message).toContain("ISO");
  });

  it("isOverdue turns over at the UTC midnight after the target", () => {
    expect(isOverdue("2026-10-31", "2026-10-31T23:59:59.999Z")).toBe(false);
    expect(isOverdue("2026-10-31", "2026-11-01T00:00:00.000Z")).toBe(true);
    expect(isOverdue("2026-10-31", "2026-10-01T12:00:00.000Z")).toBe(false);
    expect(isOverdue(null, "2099-01-01T00:00:00.000Z")).toBe(false);
  });

  it("daysUntil is 0 on the day, negative after", () => {
    expect(daysUntil("2026-10-31", "2026-10-31T23:59:59.999Z")).toBe(0);
    expect(daysUntil("2026-10-31", "2026-10-31T00:00:00.000Z")).toBe(0);
    expect(daysUntil("2026-10-31", "2026-11-01T00:00:00.000Z")).toBe(-1);
    expect(daysUntil("2026-10-31", "2026-10-01T15:00:00.000Z")).toBe(30);
    // Whole days across a DST change in any local zone — the arithmetic is UTC.
    expect(daysUntil("2026-03-30", "2026-03-28T12:00:00.000Z")).toBe(2);
  });

  it("assertMilestoneDates refuses a start after the target", () => {
    expect(() => assertMilestoneDates({ startDate: "2026-10-01", targetDate: "2026-10-31" })).not.toThrow();
    expect(() => assertMilestoneDates({ startDate: "2026-10-31", targetDate: "2026-10-31" })).not.toThrow();
    expect(() => assertMilestoneDates({ startDate: "2026-10-01", targetDate: null })).not.toThrow();
    expect(() => assertMilestoneDates({ startDate: null, targetDate: null })).not.toThrow();
    const error = validation(() => assertMilestoneDates({ startDate: "2026-11-01", targetDate: "2026-10-31" }));
    expect(error.message).toBe("Start date 2026-11-01 is after target date 2026-10-31.");
    expect(error.detail).toEqual({ startDate: "2026-11-01", targetDate: "2026-10-31" });
  });
});

describe("rankBetween", () => {
  it("first, append, midpoint, exhausted", () => {
    expect(rankBetween(null, null)).toBe(MEMBER_RANK_STEP);
    expect(rankBetween(1024, null)).toBe(2048);
    expect(rankBetween(1024, 2048)).toBe(1536);
    expect(rankBetween(null, 1024)).toBe(512);
    expect(rankBetween(1024, 1027)).toBe(1025);
    expect(rankBetween(1024, 1025)).toBeNull();
    expect(rankBetween(null, 1)).toBeNull();
  });

  it("renumberedRanks restarts at clean multiples of the step", () => {
    expect(renumberedRanks(0)).toEqual([]);
    expect(renumberedRanks(3)).toEqual([1024, 2048, 3072]);
  });
});

describe("assertMembershipAllowed", () => {
  const milestone = { id: "m1", identifier: "STA-190", kind: MILESTONE_KIND };
  const epic = { id: "e1", identifier: "STA-66", kind: "epic" };

  it("allows an epic, a task and any configured kind", () => {
    expect(() => assertMembershipAllowed(milestone, epic, null)).not.toThrow();
    expect(() => assertMembershipAllowed(milestone, { id: "t1", identifier: "STA-146", kind: "task" }, null)).not.toThrow();
    expect(() => assertMembershipAllowed(milestone, { id: "b1", identifier: "STA-9", kind: "zeta" }, null)).not.toThrow();
    // Already in THIS milestone is not a refusal — the store treats it as a replay or a move.
    expect(() => assertMembershipAllowed(milestone, epic, { id: "m1", identifier: "STA-190" })).not.toThrow();
  });

  it("refuses a container that is not a milestone, naming its kind", () => {
    const error = validation(() => assertMembershipAllowed(epic, { id: "t1", identifier: "STA-146", kind: "task" }, null));
    expect(error.message).toBe("STA-66 is an epic, not a milestone.");
    expect(error.detail).toEqual({ identifier: "STA-66", kind: "epic" });
  });

  it("refuses a milestone as a member and a self-member", () => {
    expect(validation(() => assertMembershipAllowed(milestone, milestone, null)).message).toContain("member of itself");
    const other = { id: "m2", identifier: "STA-191", kind: MILESTONE_KIND };
    expect(validation(() => assertMembershipAllowed(milestone, other, null)).message).toContain(
      "milestones cannot be members of milestones",
    );
  });

  it("refuses a second direct milestone and names the first", () => {
    const error = validation(() => assertMembershipAllowed(milestone, epic, { id: "m2", identifier: "STA-191" }));
    expect(error.message).toBe(
      "STA-66 is already in STA-191. Use `staple milestone mv STA-66 --to STA-190` to move it.",
    );
    expect(error.detail).toEqual({ identifier: "STA-66", milestone: "STA-191" });
  });
});

describe("assertMilestoneKindConfigured", () => {
  it("names the kinds add that enables the feature", () => {
    expect(() => assertMilestoneKindConfigured(["milestone", "epic", "task"])).not.toThrow();
    const error = validation(() => assertMilestoneKindConfigured(["epic", "task"]));
    expect(error.message).toBe(MILESTONE_KIND_MISSING_MESSAGE);
    expect(error.message).toContain("staple kinds add milestone");
    expect(error.detail).toEqual({ kind: "milestone" });
  });
});

describe("nearestMilestone", () => {
  it("self before ancestor, nearest ancestor first", () => {
    const memberOf = new Map([
      ["epic", "m1"],
      ["task", "m2"],
      ["programme", "m3"],
    ]);
    expect(nearestMilestone(["task", "epic", "programme"], memberOf)).toBe("m2");
    expect(nearestMilestone(["sibling", "epic", "programme"], memberOf)).toBe("m1");
    expect(nearestMilestone(["orphan"], memberOf)).toBeNull();
    expect(nearestMilestone([], memberOf)).toBeNull();
  });
});

describe("milestoneProgress", () => {
  const node = (id: string, category: StatusCategory, parentId: string | null = null): ProgressNode => ({
    id,
    parentId,
    category,
  });
  const zero: Record<StatusCategory, number> = {
    unstarted: 0,
    ready: 0,
    active: 0,
    review: 0,
    gated: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
  };

  it("counts a task reached through its epic and as a direct member once", () => {
    // The worked example from docs/milestones.md: E{T1 done, T2 todo}, T2 again, S done.
    const epic = node("E", "active");
    const t1 = node("T1", "done", "E");
    const t2 = node("T2", "ready", "E");
    const s = node("S", "done");
    const progress = milestoneProgress([epic, t2, s], new Map([["E", [t1, t2]]]));
    expect(progress).toEqual({
      total: 3,
      countable: 3,
      counts: { ...zero, done: 2, ready: 1 },
      percent: 66,
      complete: false,
    });
  });

  it("never counts a parent", () => {
    const epic = node("E", "active");
    const sub = node("SUB", "active", "E");
    const leaf = node("L", "done", "SUB");
    const progress = milestoneProgress([epic], new Map([["E", [sub, leaf]]]));
    expect(progress.total).toBe(1);
    expect(progress.counts.done).toBe(1);
    expect(progress.counts.active).toBe(0);
    expect(progress.complete).toBe(true);
  });

  it("counts a leaf reached through two member epics once", () => {
    // Two members that both descend to the same leaf (a reparented subtree read
    // mid-transaction, or a stale descendant map) must still count it once.
    const a = node("A", "active");
    const b = node("B", "active");
    const leaf = node("L", "done", "A");
    const own = node("M", "ready", "B");
    const progress = milestoneProgress([a, b], new Map([["A", [leaf]], ["B", [own, leaf]]]));
    expect(progress.total).toBe(2);
    expect(progress.counts).toMatchObject({ done: 1, ready: 1, active: 0 });
  });

  it("a childless member is one leaf", () => {
    const progress = milestoneProgress([node("E", "unstarted"), node("T", "done")], new Map());
    expect(progress).toEqual({
      total: 2,
      countable: 2,
      counts: { ...zero, unstarted: 1, done: 1 },
      percent: 50,
      complete: false,
    });
  });

  it("excludes cancelled leaves from the denominator", () => {
    const progress = milestoneProgress(
      [node("A", "done"), node("B", "cancelled"), node("C", "ready")],
      new Map(),
    );
    expect(progress.total).toBe(3);
    expect(progress.countable).toBe(2);
    expect(progress.counts.cancelled).toBe(1);
    expect(progress.percent).toBe(50);
    expect(progress.complete).toBe(false);
  });

  it("percent is null when nothing is countable", () => {
    expect(milestoneProgress([], new Map())).toEqual({
      total: 0,
      countable: 0,
      counts: zero,
      percent: null,
      complete: false,
    });
    const allCancelled = milestoneProgress([node("A", "cancelled"), node("B", "cancelled")], new Map());
    expect(allCancelled.total).toBe(2);
    expect(allCancelled.percent).toBeNull();
    expect(allCancelled.complete).toBe(false);
  });

  it("a cancelled parent does not hide an open leaf", () => {
    const epic = node("E", "cancelled");
    const open = node("T", "ready", "E");
    const progress = milestoneProgress([epic], new Map([["E", [open]]]));
    expect(progress.counts.ready).toBe(1);
    expect(progress.counts.cancelled).toBe(0);
    expect(progress.countable).toBe(1);
  });

  it("a reopened leaf lowers the count on the next read", () => {
    const before = milestoneProgress([node("A", "done"), node("B", "done")], new Map());
    expect(before).toMatchObject({ percent: 100, complete: true });
    // Nothing was added or removed — the same membership, one leaf back in `active`.
    const after = milestoneProgress([node("A", "done"), node("B", "active")], new Map());
    expect(after).toMatchObject({ total: 2, countable: 2, percent: 50, complete: false });
  });

  it("percent rounds down", () => {
    const members = Array.from({ length: 200 }, (_, i) => node(`T${i}`, i === 0 ? "ready" : "done"));
    const progress = milestoneProgress(members, new Map());
    expect(progress.counts.done).toBe(199);
    expect(progress.percent).toBe(99);
    expect(progress.complete).toBe(false);
  });
});

describe("milestoneState", () => {
  const empty = milestoneProgress([], new Map());
  const begun = milestoneProgress([{ id: "T", parentId: null, category: "active" }], new Map());
  const noDates = { targetDate: null, startDate: null };
  const now = "2026-10-15T12:00:00.000Z";

  it("resolved first, then overdue, then active, then planned", () => {
    expect(milestoneState({ category: "done", targetDate: "2026-01-01", startDate: null }, begun, now)).toBe("done");
    expect(milestoneState({ category: "cancelled", ...noDates }, begun, now)).toBe("cancelled");
    expect(milestoneState({ category: "active", targetDate: "2026-10-14", startDate: null }, empty, now)).toBe("overdue");
    expect(milestoneState({ category: "unstarted", targetDate: "2026-10-15", startDate: null }, empty, now)).toBe("planned");
    expect(milestoneState({ category: "unstarted", targetDate: "2026-10-31", startDate: "2026-10-15" }, empty, now)).toBe("active");
    expect(milestoneState({ category: "unstarted", targetDate: "2026-10-31", startDate: "2026-10-16" }, empty, now)).toBe("planned");
    expect(milestoneState({ category: "unstarted", ...noDates }, begun, now)).toBe("active");
    expect(milestoneState({ category: "unstarted", ...noDates }, empty, now)).toBe("planned");
  });

  it("a gated or blocked leaf has not begun; a done one has", () => {
    const gated = milestoneProgress([{ id: "T", parentId: null, category: "gated" }], new Map());
    const blocked = milestoneProgress([{ id: "T", parentId: null, category: "blocked" }], new Map());
    const landed = milestoneProgress([{ id: "T", parentId: null, category: "done" }], new Map());
    expect(milestoneState({ category: "unstarted", ...noDates }, gated, now)).toBe("planned");
    expect(milestoneState({ category: "unstarted", ...noDates }, blocked, now)).toBe("planned");
    expect(milestoneState({ category: "unstarted", ...noDates }, landed, now)).toBe("active");
  });
});
