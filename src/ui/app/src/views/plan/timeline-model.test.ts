/**
 * The Timeline lens's arithmetic: the range presets' pixels, the end label after each bar, which
 * links show for the row in focus, the notch, the arrow's elbow, and which pointers and keys may
 * move a planned window.
 */
import { describe, expect, it } from "vitest";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { dayIndex } from "./plan-model";
import { datesBody, elbowPath, endLabel, linkView, monthLabel, notched, nudge, pxPerDay, startsDrag, timelineRows, todayScroll } from "./timeline-model";

const ZERO = { done: 0, open: 0, planned: 0, total: 0 };
const DATES = [{ id: "plan_dates", label: "Change the planned dates", who: "person" as const }];

function idea(id: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id, identifier: null, number: null, promoted: false, kind: "idea", title: `Idea ${id}`, description: null, briefLine: null,
    maturity: "shaped", stage: "scheduled", parentId: null, horizonId: null, planned: { start: null, target: null }, baseline: null, rank: 0,
    links: [], explorations: [], missingLinks: [], linkCount: 0, resolvedLinks: 0, units: ZERO, unsized: false, own: ZERO, umbrella: false, carriedBy: null,
    nextStep: null, shapeProposal: null, progress: null, percent: null, actual: { start: null, end: null, forecastEnd: null }, late: false, notStarted: false,
    delivered: null, childIds: [], openQuestions: 0, planIncomplete: [], completeness: { starred: 3, starredTotal: 3, filled: 5, total: 10 },
    dependsOn: [], blockedBy: [], heldBy: null, state: "shaped", actions: [], createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

const today = dayIndex("2026-11-25");

describe("range presets", () => {
  it("fits 92, 183 or 365 days in the visible chart, and the whole span for All", () => {
    expect(pxPerDay("3m", 920, 400)).toBe(10);
    expect(pxPerDay("6m", 1830, 400)).toBe(10);
    expect(pxPerDay("1y", 730, 400)).toBe(2);
    // All leaves a small margin so a fitted chart never scrolls sideways.
    expect(pxPerDay("all", 808, 400)).toBe(2);
    expect(pxPerDay("all", 808, 400) * 400).toBeLessThan(808);
  });

  it("never draws a day under one pixel", () => {
    expect(pxPerDay("all", 300, 900)).toBe(1);
  });

  it("brings today a third of the way in, never before the start", () => {
    expect(todayScroll(1000, 600)).toBe(800);
    expect(todayScroll(100, 600)).toBe(0);
  });
});

describe("the end label", () => {
  it("says when a shipped record shipped", () => {
    expect(endLabel(idea("s", { state: "shipped", actual: { start: "2026-10-01", end: "2026-11-14", forecastEnd: null }, planned: { start: null, target: "2026-10-01" } }), today)).toEqual({ text: "shipped Nov 14", late: false });
  });

  it("says a forecast past the planned end, and by how much, as late", () => {
    const over = idea("f", { state: "started", planned: { start: "2026-08-01", target: "2026-09-26" }, actual: { start: "2026-08-10", end: null, forecastEnd: "2026-12-15" } });
    expect(endLabel(over, today)).toEqual({ text: "forecast Dec 15 · 80d over", late: true });
  });

  it("says how long ago a planned end passed with nothing shipped, as late", () => {
    expect(endLabel(idea("p", { planned: { start: "2026-08-01", target: "2026-09-26" } }), today)).toEqual({ text: "60d past Sep 26", late: true });
  });

  it("gives the forecast inside the plan, else where the plan ends", () => {
    const inside = idea("i", { state: "started", planned: { start: "2026-11-01", target: "2027-01-30" }, actual: { start: "2026-11-02", end: null, forecastEnd: "2026-12-06" } });
    expect(endLabel(inside, today)).toEqual({ text: "forecast Dec 6", late: false });
    expect(endLabel(idea("t", { planned: { start: "2026-12-01", target: "2027-01-30" } }), today)).toEqual({ text: "to Jan 30", late: false });
  });

  it("says where a plan with only a start begins, and nothing without dates", () => {
    expect(endLabel(idea("s", { planned: { start: "2026-12-01", target: null } }), today)).toEqual({ text: "from Dec 1", late: false });
    expect(endLabel(idea("n"), today)).toBeNull();
  });
});

describe("links on demand", () => {
  const edges = [{ from: "a", to: "b" }, { from: "b", to: "c" }, { from: "x", to: "y" }];

  it("draws none until a row is in focus", () => {
    expect(linkView(edges, null, false)).toEqual({ drawn: [], related: null });
  });

  it("draws the links touching the row in focus and keeps those rows undimmed", () => {
    const view = linkView(edges, "b", false);
    expect(view.drawn).toEqual([{ from: "a", to: "b" }, { from: "b", to: "c" }]);
    expect([...(view.related ?? [])].sort()).toEqual(["a", "b", "c"]);
  });

  it("dims nothing for a row with no links", () => {
    expect(linkView(edges, "lonely", false)).toEqual({ drawn: [], related: null });
  });

  it("draws every link with Show all links on, and dims nothing", () => {
    expect(linkView(edges, "b", true)).toEqual({ drawn: edges, related: null });
  });
});

describe("the notch", () => {
  it("marks a row that starts before something it waits on ends, and not one that starts after", () => {
    const a = idea("a", { planned: { start: "2026-10-01", target: "2026-10-10" } });
    const early = idea("early", { planned: { start: "2026-10-05", target: "2026-10-20" }, dependsOn: ["a"] });
    const after = idea("after", { planned: { start: "2026-10-11", target: "2026-10-20" }, dependsOn: ["a"] });
    const ideas = new Map([a, early, after].map((entry) => [entry.id, entry]));
    expect([...notched([{ from: "a", to: "early" }, { from: "a", to: "after" }], ideas)]).toEqual(["early"]);
  });

  it("leaves a shipped row alone: its order is history", () => {
    const a = idea("a", { planned: { start: "2026-10-01", target: "2026-10-10" } });
    const landed = idea("landed", { state: "shipped", planned: { start: "2026-10-05", target: "2026-10-20" }, dependsOn: ["a"] });
    const ideas = new Map([a, landed].map((entry) => [entry.id, entry]));
    expect([...notched([{ from: "a", to: "landed" }], ideas)]).toEqual([]);
  });
});

describe("the arrow", () => {
  it("turns down just past the first bar with rounded corners when the second starts later", () => {
    expect(elbowPath(100, 14, 200, 82)).toBe("M100 14 H103 Q108 14 108 19 V77 Q108 82 113 82 H200");
  });

  it("doubles back between the rows when the second starts first", () => {
    expect(elbowPath(100, 82, 60, 14)).toBe("M100 82 H103 Q108 82 108 77 V74 Q108 69 103 69 H55 Q50 69 50 64 V19 Q50 14 55 14 H60");
  });
});

describe("moving a planned window", () => {
  const movable = idea("m", { planned: { start: "2026-11-02", target: "2026-11-09" }, actions: DATES });

  it("lets a mouse or a pen drag, never a finger, and only where the dates are offered", () => {
    expect(startsDrag(movable, "mouse")).toBe(true);
    expect(startsDrag(movable, "pen")).toBe(true);
    expect(startsDrag(movable, "touch")).toBe(false);
    expect(startsDrag({ ...movable, actions: [] }, "mouse")).toBe(false);
  });

  it("nudges a week with the arrow keys, the end alone with Shift", () => {
    expect(nudge(movable, "ArrowRight", false)).toEqual({ plannedStart: "2026-11-09", plannedTarget: "2026-11-16" });
    expect(nudge(movable, "ArrowLeft", true)).toEqual({ plannedStart: "2026-11-02", plannedTarget: "2026-11-02" });
    expect(nudge(movable, "Enter", false)).toBeNull();
  });

  it("refuses the nudge where the dates are not offered", () => {
    expect(nudge({ ...movable, actions: [] }, "ArrowRight", false)).toBeNull();
  });

  it("keeps a target-only window without a start", () => {
    const target = idea("t", { planned: { start: null, target: "2026-12-01" }, actions: DATES });
    expect(nudge(target, "ArrowRight", true)).toEqual({ plannedTarget: "2026-12-08" });
    expect(datesBody(target, { start: 10, end: dayIndex("2026-12-03") })).toEqual({ plannedTarget: "2026-12-03" });
  });
});

describe("folding", () => {
  const parent = idea("parent", { planned: { start: "2026-11-01", target: "2026-12-01" } });
  const child = idea("child", { parentId: "parent", planned: { start: "2026-11-05", target: "2026-11-20" } });
  const plan: PlanData = { enabled: true, today: "2026-11-25", horizons: [], ideas: [parent, child] };
  const rows = (filtering: boolean) => timelineRows(plan, new Set(["parent"]), filtering).flatMap((group) => group.rows.map((row) => row.idea.id));

  it("hides a folded parent's rows, but never while a focus or filter is on", () => {
    expect(rows(false)).toEqual(["parent"]);
    expect(rows(true)).toEqual(["parent", "child"]);
  });
});

describe("the axis", () => {
  const aug = dayIndex("2026-08-01");
  const jan = dayIndex("2027-01-01");
  it("prints short names on wide months, a letter on narrow ones, nothing on the narrowest", () => {
    expect(monthLabel(aug, 60, false)).toEqual({ text: "Aug", year: false });
    expect(monthLabel(aug, 30, false)).toEqual({ text: "A", year: false });
    expect(monthLabel(aug, 10, false)).toEqual({ text: "", year: false });
  });

  it("prints the year in bold on January and on the first month", () => {
    expect(monthLabel(jan, 60, false)).toEqual({ text: "Jan 2027", year: true });
    expect(monthLabel(aug, 60, true)).toEqual({ text: "Aug 2026", year: true });
    expect(monthLabel(jan, 10, false)).toEqual({ text: "2027", year: true });
  });
});
