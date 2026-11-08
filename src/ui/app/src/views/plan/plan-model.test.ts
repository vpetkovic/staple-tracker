import { describe, expect, it } from "vitest";
import type { HorizonData, IdeaData, PlanData } from "@/lib/plan-types";
import {
  columnEntries,
  dragWindow,
  horizonsColumns,
  ideasColumns,
  riskOf,
  riskWords,
  timelineGroups,
  timelineRange,
  dayIndex,
  dayOf,
} from "./plan-model";

function idea(id: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id,
    identifier: null,
    promoted: false,
    kind: "idea",
    title: id,
    description: null,
    maturity: "raw",
    stage: "raw",
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 0,
    links: [],
    linkCount: 0,
    resolvedLinks: 0,
    progress: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    missingLinks: [],
    childIds: [],
    openQuestions: 0,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

const now: HorizonData = { id: "now", identifier: "T-now", name: "Now", date: "2026-12-31", rank: 1, status: "backlog", shipped: false, memberCount: 0, ideaCount: 0, lateCount: 0, notStartedCount: 0, late: false };
const next: HorizonData = { id: "next", identifier: "T-next", name: "Next", date: null, rank: 2, status: "backlog", shipped: false, memberCount: 0, ideaCount: 0, lateCount: 0, notStartedCount: 0, late: false };

function plan(ideas: IdeaData[]): PlanData {
  return { enabled: true, today: "2026-11-07", horizons: [now, next], ideas };
}

const ga = idea("ga", { maturity: "shaped", stage: "started", horizonId: "now", linkCount: 1, planned: { start: "2026-09-01", target: "2026-12-19" } });
const r0 = idea("r0", { maturity: "shaped", stage: "scheduled", parentId: "ga", horizonId: "now", notStarted: true, planned: { start: "2026-09-01", target: "2026-09-19" } });
const r2 = idea("r2", { maturity: "shaped", stage: "started", parentId: "ga", horizonId: "now", late: true, linkCount: 1, planned: { start: "2026-09-15", target: "2026-10-31" } });
const r8 = idea("r8", { maturity: "shaped", stage: "scheduled", parentId: "ga", horizonId: "next", planned: { start: "2027-02-02", target: "2027-03-13" } });
const raw = idea("raw");
const sdk = idea("sdk", { maturity: "shaped", stage: "shaped" });

describe("boards", () => {
  it("nest child ideas under their parent's card in the same column, and label one in another column", () => {
    const p = plan([ga, r0, r2, r8, raw, sdk]);
    const columns = horizonsColumns(p);
    const nowColumn = columns.find((column) => column.key === "h:now")!;
    const entries = columnEntries(p, nowColumn);
    expect(entries.map((entry) => entry.idea.id)).toEqual(["ga"]);
    expect(entries[0]!.nested.map((child) => child.id)).toEqual(["r0", "r2"]);
    expect(entries[0]!.descendants).toHaveLength(3);
    const nextEntries = columnEntries(p, columns.find((column) => column.key === "h:next")!);
    expect(nextEntries.map((entry) => [entry.idea.id, entry.parentTitle])).toEqual([["r8", "ga"]]);
    expect(columns[0]!.ideas.map((i) => i.id)).toEqual(["sdk"]);
  });

  it("keeps a started idea and everything under it out of the Ideas lens", () => {
    const columns = ideasColumns(plan([ga, r0, r2, r8, raw, sdk]));
    expect(columns.flatMap((column) => column.ideas.map((i) => i.id))).toEqual(["raw", "sdk"]);
  });

  it("splits late from not started and never lumps them", () => {
    const risk = riskOf([ga, r0, r2, r8]);
    expect(risk).toEqual({ late: 1, notStarted: 1, started: 2 });
    expect(riskWords(risk)).toBe("1 late · 1 not started");
    expect(riskWords(risk, true)).toBe("1 late · 1 not started · 2 started");
    expect(riskWords(riskOf([raw]))).toBeNull();
  });
});

describe("timeline", () => {
  it("groups rows by horizon with children indented under their parent, and folds them", () => {
    const p = plan([ga, r0, r2, r8, raw]);
    const groups = timelineGroups(p);
    expect(groups.map((group) => group.title)).toEqual(["Now", "Next", "No horizon"]);
    expect(groups[0]!.rows.map((row) => [row.idea.id, row.depth])).toEqual([["ga", 0], ["r0", 1], ["r2", 1]]);
    expect(groups[1]!.rows.map((row) => [row.idea.id, row.depth])).toEqual([["r8", 0]]);
    expect(groups[2]!.undated.map((i) => i.id)).toEqual(["raw"]);
    expect(timelineGroups(p, new Set(["ga"]))[0]!.rows.map((row) => row.idea.id)).toEqual(["ga"]);
  });

  it("spans whole months around every date it draws", () => {
    const range = timelineRange(plan([ga, r8]));
    expect(dayOf(range.from)).toBe("2026-09-01");
    expect(dayOf(range.to)).toBe("2027-05-01");
  });

  it("moves a dragged window whole, and never lets an edge cross the other", () => {
    const window = { start: dayIndex("2026-11-01"), end: dayIndex("2026-11-10") };
    expect(dragWindow(window, "move", 3)).toEqual({ start: window.start + 3, end: window.end + 3 });
    expect(dragWindow(window, "start", 20)).toEqual({ start: window.end, end: window.end });
    expect(dragWindow(window, "end", -20)).toEqual({ start: window.start, end: window.start });
  });
});
