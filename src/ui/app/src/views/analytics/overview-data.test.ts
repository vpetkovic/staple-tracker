/**
 * The Overview's adapter: `AnalyticsReport` as the shapes the widgets draw. Each case builds the
 * smallest report that exercises one mapping and pins what the widget receives.
 */
import { describe, expect, it } from "vitest";
import { seriesColor } from "@/components/analytics/chart-parts";
import type { AnalyticsHeadline, AnalyticsReport, Caveat, EpicRow, RoiResponse, SeriesPoint } from "@/lib/analytics-api";
import {
  againstWords,
  answers,
  burstsOf,
  caveatSentence,
  caveatSentences,
  coverageOf,
  documentBars,
  endedAttempts,
  featureRows,
  featureTitle,
  furtherHistorySentence,
  headlineChange,
  historyGoesFurther,
  isEmptyScope,
  kindParts,
  kindSpeedBars,
  modelBars,
  modelFamily,
  OTHER_LANE,
  outcomeParts,
  parallelPoints,
  priorityParts,
  returnTile,
  sparkValues,
  trendPoints,
  workspaceBars,
  workspaceLanes,
} from "./overview-data";

const HEADLINE: AnalyticsHeadline = { done: 0, epicsDone: 0, bugsFixed: 0, agentHours: 0, ftePeriod: null, peakConcurrency: 0, medianCycleHours: null, attemptSuccessRate: null, plannedHours: 0 };
const SLUGS = ["ai", "ex", "fd", "st", "vp", "wo"];

function report(patch: Partial<AnalyticsReport> = {}, slugs: readonly string[] = SLUGS): AnalyticsReport {
  return {
    asOf: "2026-11-26T12:00:00.000Z",
    scope: { kind: "hub", workspaces: slugs.map((slug) => ({ slug, prefix: slug.toUpperCase(), available: true })) },
    period: { from: "2026-11-01", to: "2026-11-30", tz: "Europe/Belgrade", days: 30, bucket: "day", explicit: true, firstActivity: "2026-08-31", lastActivity: "2026-11-26" },
    definitions: { attemptCapHours: 12, fteHoursPerWeek: 40, fteHoursPerDay: 8, sprintGapDays: 5, sprintMinDone: 10, importWindowSeconds: 120 },
    headline: HEADLINE,
    previous: null,
    series: [],
    delivery: { done: 0, created: 0, cancelled: 0, byKind: {}, byPriority: {}, epicsDone: 0, bugsFixed: 0, daysWithDone: 0, bestDay: null, openNow: {} },
    capacity: { agentHours: 0, agentHoursUncapped: 0, orchestrationHours: 0, attempts: 0, attemptsCapped: 0, agents: 0, activeDays: 0, ftePeriod: null, fteActiveDays: null, workWeeks: 0, peakConcurrency: { count: 0, at: null }, byModel: [] },
    speed: { cycle: { n: 0, medianHours: null, p25Hours: null, p75Hours: null, under1h: 0, under4h: 0 }, lead: { n: 0, medianHours: null, within24h: 0 }, histogram: [], cycleByKind: {}, effortPerTicket: { n: 0, medianHours: null } },
    reliability: { started: 0, outcomes: { completed: 0, yielded: 0, failed: 0, interrupted: 0, orphaned: 0, open: 0 }, successRate: null },
    estimates: { planned: { hours: 0, tickets: 0, ofDone: 0 }, pairs: { n: 0, estimateHours: 0, workHours: 0, medianRatio: null, underEstimate: 0 } },
    rhythm: { heatmap: [], night: 0, weekend: 0 },
    epics: [],
    workspaces: [],
    sprints: [],
    agentTypes: [],
    agents: [],
    record: { comments: 0, documents: 0, files: 0, fileBytes: 0, byDocumentKey: [] },
    caveats: [],
    ...patch,
  };
}

const point = (start: string, byWorkspace: SeriesPoint["byWorkspace"], extra: Partial<SeriesPoint> = {}): SeriesPoint => {
  const done = Object.values(byWorkspace).reduce((sum, row) => sum + row.done, 0);
  const agentHours = Object.values(byWorkspace).reduce((sum, row) => sum + row.agentHours, 0);
  return { start, end: start, done, created: 0, agentHours, peakConcurrency: 0, byWorkspace, ...extra };
};

const epic = (patch: Partial<EpicRow>): EpicRow => ({
  workspace: "st",
  identifier: "ST-1",
  title: "Feature",
  status: "in_progress",
  category: "active",
  descendants: 4,
  descendantsDone: 2,
  doneInPeriod: 0,
  startedOn: "2026-10-01",
  lastDoneOn: null,
  completedOn: null,
  agentHours: 3,
  ...patch,
});

describe("which answer is on screen", () => {
  const asked = { scope: "hub", from: "2026-11-01", to: "2026-11-30" };

  it("matches a period and a scope, and tells an answer for another one apart", () => {
    expect(answers(report(), asked, true)).toBe(true);
    expect(answers(report(), { ...asked, from: "2026-10-01" }, true)).toBe(false);
    expect(answers(report(), { ...asked, to: "2026-11-29" }, true)).toBe(false);
    // A workspace's answer while every workspace is asked for, and the other way round.
    const one = report({ scope: { kind: "workspace", workspaces: [{ slug: "st", prefix: "ST", available: true }] } });
    expect(answers(one, asked, true)).toBe(false);
    expect(answers(one, { ...asked, scope: "st" }, true)).toBe(true);
    expect(answers(one, { ...asked, scope: "ex" }, true)).toBe(false);
    expect(answers(report(), { ...asked, scope: "st" }, true)).toBe(false);
  });

  it("treats all time (no from) as its own question, and any scope outside hub mode as the one workspace", () => {
    const allTime = report({ period: { ...report().period, explicit: false } });
    expect(answers(allTime, { scope: "hub", to: "2026-11-30" }, true)).toBe(true);
    expect(answers(report(), { scope: "hub", to: "2026-11-30" }, true)).toBe(false);
    expect(answers(allTime, asked, true)).toBe(false);
    const single = report({ scope: { kind: "workspace", workspaces: [{ slug: "st", prefix: "ST", available: true }] } });
    expect(answers(single, asked, false)).toBe(true);
  });

  it("knows an empty scope, and a clamped all time", () => {
    expect(isEmptyScope(report({ period: { ...report().period, firstActivity: null, lastActivity: null } }))).toBe(true);
    expect(isEmptyScope(report())).toBe(false);
    // An explicit period that starts after the first activity is not a clamp.
    expect(historyGoesFurther(report())).toBe(false);
    const clamped = report({ period: { ...report().period, explicit: false, from: "2016-12-08", firstActivity: "2015-03-02" } });
    expect(historyGoesFurther(clamped)).toBe(true);
    expect(furtherHistorySentence(clamped)).toBe("All time here is Dec 8, 2016 – Nov 30, 2026, the longest period one read covers. The history goes back further, to Mar 2, 2015.");
    expect(historyGoesFurther(report({ period: { ...report().period, explicit: false, from: "2026-08-31" } }))).toBe(false);
  });
});

describe("the change against the period before", () => {
  it("compares with the previous headline, and says nothing without one", () => {
    const previous = { from: "2026-10-02", to: "2026-10-31", headline: { ...HEADLINE, done: 40, medianCycleHours: 2 } };
    const now = report({ headline: { ...HEADLINE, done: 50, medianCycleHours: 1 }, previous });
    expect(headlineChange(now, "done")).toBeCloseTo(0.25);
    expect(headlineChange(now, "medianCycleHours")).toBeCloseTo(-0.5);
    expect(againstWords(now)).toBe("vs prior 30 days");
    const allTime = report({ headline: { ...HEADLINE, done: 50 } });
    expect(headlineChange(allTime, "done")).toBeNull();
    expect(againstWords(allTime)).toBe("");
  });

  it("counts the success rate's base as started less still open", () => {
    expect(endedAttempts(report({ reliability: { started: 20, outcomes: { completed: 15, yielded: 1, failed: 0, interrupted: 1, orphaned: 1, open: 2 }, successRate: 15 / 18 } }))).toBe(18);
  });
});

describe("workspaces as series", () => {
  // ex is busiest, then st, then ai, then wo; fd and vp did nothing.
  const busy = report({
    series: [
      point("2026-11-01", { ex: { done: 9, agentHours: 20 }, st: { done: 5, agentHours: 4 }, wo: { done: 1, agentHours: 1 } }),
      point("2026-11-02", { ai: { done: 2, agentHours: 3 }, ex: { done: 1, agentHours: 2 }, wo: { done: 0, agentHours: 0.5 } }),
    ],
  });

  it("keeps the three busiest as their own series in the session's order and folds the rest", () => {
    const lanes = workspaceLanes(busy, SLUGS);
    expect(lanes.series.map((series) => series.id)).toEqual(["ai", "ex", "st", OTHER_LANE]);
    expect(lanes.series.at(-1)).toEqual({ id: OTHER_LANE, label: "Other workspaces", color: seriesColor(0) });
    expect(lanes.laneOf("wo")).toBe(OTHER_LANE);
    expect(lanes.laneOf("ex")).toBe("ex");
  });

  it("colours a workspace by its place in the session's list, never by its rank, so a filter never repaints it", () => {
    const lanes = workspaceLanes(busy, SLUGS);
    expect(lanes.colorOf("st")).toBe(seriesColor(4));
    expect(lanes.series.find((series) => series.id === "st")?.color).toBe(seriesColor(4));
    const alone = report({ scope: { kind: "workspace", workspaces: [{ slug: "st", prefix: "ST", available: true }] }, series: [point("2026-11-01", { st: { done: 5, agentHours: 4 } })] });
    const one = workspaceLanes(alone, SLUGS);
    expect(one.series).toEqual([{ id: "st", label: "st", color: seriesColor(4) }]);
  });

  it("gives a busy workspace past the sixth a colour of its own, never the grey of Other workspaces", () => {
    const many = ["ai", "ex", "fd", "st", "vp", "wo", "zz", "yy"];
    const late = report(
      {
        series: [point("2026-11-01", { zz: { done: 9, agentHours: 9 }, ai: { done: 5, agentHours: 5 }, yy: { done: 4, agentHours: 4 }, ex: { done: 1, agentHours: 1 } })],
      },
      many,
    );
    const lanes = workspaceLanes(late, many);
    expect(lanes.series.map((series) => series.id)).toEqual(["ai", "zz", "yy", OTHER_LANE]);
    const colours = lanes.series.map((series) => series.color);
    // Three drawn workspaces and Other: four different colours, and only Other is grey.
    expect(new Set(colours).size).toBe(4);
    expect(colours.slice(0, 3)).not.toContain(seriesColor(0));
    // "zz" is seventh in the list, the same slot as "ai": it moves to the next free one.
    expect(lanes.colorOf("ai")).toBe(seriesColor(1));
    expect(lanes.colorOf("zz")).toBe(seriesColor(2));
    // What a chart draws and what a list dots agree.
    expect(lanes.series.find((series) => series.id === "zz")?.color).toBe(lanes.colorOf("zz"));
  });

  it("draws every active workspace on its own when the scope has four or fewer", () => {
    const small = report({ series: busy.series }, ["ai", "ex", "st", "wo"]);
    expect(workspaceLanes(small, ["ai", "ex", "st", "wo"]).series.map((series) => series.id)).toEqual(["ai", "ex", "st", "wo"]);
  });

  it("stacks each bucket by lane, the folded workspaces added together", () => {
    const lanes = workspaceLanes(busy, SLUGS);
    const hours = trendPoints(busy, "agentHours", lanes);
    expect(hours.map((slot) => slot.values)).toEqual([
      { ai: 0, ex: 20, st: 4, [OTHER_LANE]: 1 },
      { ai: 3, ex: 2, st: 0, [OTHER_LANE]: 0.5 },
    ]);
    expect(trendPoints(busy, "done", lanes)[0]?.values).toEqual({ ai: 0, ex: 9, st: 5, [OTHER_LANE]: 1 });
    expect(hours[0]?.label).toBe("Nov 1");
  });

  it("names week and month buckets, and gives the sparkline at most fourteen columns", () => {
    const weeks = report({ period: { ...report().period, bucket: "week" }, series: [point("2026-11-02", {})] });
    expect(trendPoints(weeks, "done", workspaceLanes(weeks))[0]?.label).toBe("Week of Nov 2");
    const months = report({ period: { ...report().period, bucket: "month" }, series: [point("2026-11-01", {})] });
    expect(trendPoints(months, "done", workspaceLanes(months))[0]?.label).toBe("Nov");
    const long = report({ series: Array.from({ length: 30 }, (_, index) => point(`2026-11-${String(index + 1).padStart(2, "0")}`, { st: { done: 1, agentHours: 2 } })) });
    const spark = sparkValues(long, "done");
    expect(spark.length).toBeLessThanOrEqual(14);
    expect(spark.reduce((sum, value) => sum + value, 0)).toBe(30);
    expect(sparkValues(report({ series: long.series.slice(0, 5) }), "agentHours")).toEqual([2, 2, 2, 2, 2]);
  });

  it("reads agents at once per bucket", () => {
    const concurrency = report({ series: [point("2026-11-01", {}, { peakConcurrency: 3 }), point("2026-11-02", {}, { peakConcurrency: 7 })] });
    expect(parallelPoints(concurrency).map((slot) => slot.values.n)).toEqual([3, 7]);
  });

  it("lists agent time by workspace, most first, each in its own colour", () => {
    const rows = workspaceBars(
      report({
        workspaces: [
          { slug: "st", prefix: "ST", done: 4, created: 5, bugsFixed: 0, epicsDone: 0, agentHours: 3, activeDays: 2, firstActivity: null, lastActivity: null, features: [] },
          { slug: "ex", prefix: "EX", done: 9, created: 9, bugsFixed: 1, epicsDone: 1, agentHours: 12.5, activeDays: 3, firstActivity: null, lastActivity: null, features: [] },
          { slug: "vp", prefix: "VP", done: 0, created: 0, bugsFixed: 0, epicsDone: 0, agentHours: 0, activeDays: 0, firstActivity: null, lastActivity: null, features: [] },
        ],
      }),
      workspaceLanes(report(), SLUGS),
    );
    expect(rows.map((row) => [row.id, row.text, row.detail, row.color])).toEqual([
      ["ex", "13 h", "9 closed", seriesColor(2)],
      ["st", "3 h", "4 closed", seriesColor(4)],
    ]);
  });
});

describe("what got built", () => {
  it("names a feature without its tracker tag", () => {
    expect(featureTitle("[EPIC-49] Reference Aggregate APIs")).toBe("Reference Aggregate APIs");
    expect(featureTitle("R4: plan the queue")).toBe("Plan the queue");
    expect(featureTitle("channel connection foundation")).toBe("Channel connection foundation");
  });

  it("lists the features that shipped first, then those that moved, and drops the idle ones", () => {
    const answer = report({
      epics: [
        epic({ identifier: "ST-1", doneInPeriod: 2 }),
        epic({ identifier: "EX-9", workspace: "ex", title: "[EPIC-1] Search", status: "done", category: "done", completedOn: "2026-11-20", descendants: 3, descendantsDone: 3, doneInPeriod: 1, startedOn: "2026-11-02", lastDoneOn: "2026-11-20", agentHours: 7 }),
        epic({ identifier: "ST-2", doneInPeriod: 0 }),
        // Shipped before the period: not this period's.
        epic({ identifier: "ST-3", category: "done", completedOn: "2026-10-01", doneInPeriod: 0 }),
      ],
    });
    const rows = featureRows(answer, workspaceLanes(answer, SLUGS));
    expect(rows.map((row) => [row.ref, row.shipped])).toEqual([
      ["EX-9", true],
      ["ST-1", false],
    ]);
    expect(rows[0]).toMatchObject({ slug: "ex", title: "Search", closed: 3, children: 3, agentHours: 7, spanDays: 19, workspace: { label: "ex", color: seriesColor(2) } });
    expect(rows[1]?.spanDays).toBeNull();
    // One workspace in scope: no workspace label on the rows.
    const one = report({ scope: { kind: "workspace", workspaces: [{ slug: "st", prefix: "ST", available: true }] }, epics: answer.epics });
    expect(featureRows(one, workspaceLanes(one, SLUGS))[0]?.workspace).toBeUndefined();
  });

  it("turns sprints into bursts, oldest first, each feature sized from the epic list", () => {
    const answer = report({
      epics: [epic({ workspace: "ex", identifier: "EX-9", descendants: 12, descendantsDone: 11 })],
      sprints: [
        { start: "2026-11-20", end: "2026-11-25", days: 6, done: 12, agentHours: 9, bestDay: { date: "2026-11-21", done: 5 }, features: [], workspaces: ["st"] },
        { start: "2026-11-02", end: "2026-11-10", days: 9, done: 30, agentHours: 40, bestDay: { date: "2026-11-04", done: 9 }, features: [{ workspace: "ex", identifier: "EX-9", title: "[EPIC-2] Search", descendantsDone: 11 }], workspaces: ["ex"] },
      ],
    });
    expect(burstsOf(answer)).toEqual([
      { from: "2026-11-02", to: "2026-11-10", days: 9, ticketsDone: 30, agentHours: 40, bestDay: { day: "2026-11-04", count: 9 }, features: [{ title: "Search", closed: 11, children: 12 }] },
      { from: "2026-11-20", to: "2026-11-25", days: 6, ticketsDone: 12, agentHours: 9, bestDay: { day: "2026-11-21", count: 5 }, features: [] },
    ]);
  });
});

describe("mix, speed and reliability", () => {
  it("orders kinds and priorities the way people read them, with any other value after", () => {
    const answer = report({ delivery: { ...report().delivery, byKind: { epic: 2, bug: 5, task: 9, research: 1, chore: 0 }, byPriority: { low: 3, critical: 1, medium: 6, someday: 2 } } });
    expect(kindParts(answer)).toEqual([
      { id: "task", label: "Tasks", value: 9 },
      { id: "bug", label: "Bug fixes", value: 5 },
      { id: "epic", label: "Features (epics)", value: 2 },
      { id: "research", label: "Research", value: 1 },
    ]);
    expect(priorityParts(answer).map((part) => part.label)).toEqual(["Critical", "Medium", "Low", "Someday"]);
  });

  it("gives the typical time by kind, most tickets first, leaving out kinds with no median", () => {
    const answer = report({ speed: { ...report().speed, cycleByKind: { bug: { n: 4, medianHours: 0.5 }, task: { n: 10, medianHours: 1.5 }, epic: { n: 0, medianHours: null } } } });
    expect(kindSpeedBars(answer).map((row) => [row.id, row.label, row.value, row.text, row.detail])).toEqual([
      ["task", "Tasks", 1.5, "1.5 h", "10 tickets"],
      ["bug", "Bug fixes", 0.5, "30 min", "4 tickets"],
    ]);
  });

  it("says how attempts ended in plain words, leaving out outcomes nobody had", () => {
    const answer = report({ reliability: { started: 10, outcomes: { completed: 6, yielded: 1, failed: 0, interrupted: 1, orphaned: 1, open: 1 }, successRate: 6 / 9 } });
    expect(outcomeParts(answer)).toEqual([
      { id: "completed", label: "Finished the job", value: 6 },
      { id: "yielded", label: "Handed back", value: 1 },
      { id: "interrupted", label: "Interrupted", value: 1 },
      { id: "orphaned", label: "Session lost", value: 1 },
      { id: "open", label: "Still running", value: 1 },
    ]);
  });

  it("reads the model family from the model the harness reported, and names a harness that reported none", () => {
    expect(modelFamily("claude-opus-5-5", "claude_code")).toBe("Claude Opus");
    expect(modelFamily("opus-5.5", "claude_code")).toBe("Claude Opus");
    expect(modelFamily("claude-fable-5-2", "claude_code")).toBe("Claude Fable");
    expect(modelFamily("claude-sonnet-5-5", null)).toBe("Claude Sonnet");
    expect(modelFamily("gpt-6.1-sol", "codex")).toBe("Codex (GPT)");
    expect(modelFamily("mistral-large", null)).toBe("mistral-large");
    expect(modelFamily(null, "claude_code")).toBe("Claude, model not logged");
    expect(modelFamily(null, "codex")).toBe("Codex, model not logged");
    expect(modelFamily(null, "cursor_agent")).toBe("Cursor agent, model not logged");
    expect(modelFamily(null, null)).toBe("No model logged");
  });

  it("adds attempts up per family, most first, and quiets the rows with no model", () => {
    const answer = report({
      capacity: {
        ...report().capacity,
        byModel: [
          { model: null, harness: null, attempts: 5, completed: 5, agentHours: 3 },
          { model: "claude-opus-5-5", harness: "claude_code", attempts: 4, completed: 4, agentHours: 3 },
          { model: "opus-5.5", harness: "claude_code", attempts: 3, completed: 3, agentHours: 1 },
        ],
      },
    });
    expect(modelBars(answer).map((row) => [row.label, row.value, row.muted])).toEqual([
      ["Claude Opus", 7, false],
      ["No model logged", 5, true],
    ]);
  });
});

describe("the paper trail", () => {
  it("keeps the six most written document keys and folds the rest into one quiet row", () => {
    const keys = ["context", "worklog", "plan", "brief", "goal", "sources", "rules", "spec"].map((key, index) => ({ key, count: 80 - index * 10 }));
    const rows = documentBars(report({ record: { ...report().record, byDocumentKey: keys } }));
    expect(rows.map((row) => [row.label, row.value])).toEqual([
      ["Context", 80],
      ["Worklogs", 70],
      ["Plans", 60],
      ["Briefs", 50],
      ["Goal", 40],
      ["Sources", 30],
      ["Other (2 types)", 30],
    ]);
    expect(rows.at(-1)?.muted).toBe(true);
    expect(documentBars(report({ record: { ...report().record, byDocumentKey: keys.slice(0, 3) } }))).toHaveLength(3);
  });
});

describe("caveats", () => {
  const caveats: Caveat[] = [
    { code: "no_model", count: 279, of: 374 },
    { code: "reconstructed", count: 12, of: 374 },
    { code: "open_attempts", count: 9, of: 374 },
    { code: "capped_attempts", count: 1, of: 374 },
    { code: "done_without_agent_time", count: 40, of: 362 },
    { code: "closed_on_import", count: 3, of: 362 },
    { code: "estimates_partial", count: 116, of: 362 },
    { code: "workspace_unavailable", count: 1, of: 6 },
    { code: "default_cost_model", count: 1, of: null },
  ];
  const answer = report({ caveats, scope: { kind: "hub", workspaces: [{ slug: "st", prefix: "ST", available: true }, { slug: "gh", prefix: "GH", available: false }] } });
  const say = (code: Caveat["code"]) => caveatSentence(caveats.find((caveat) => caveat.code === code)!, answer);

  it("says each Overview caveat as a sentence with its counts", () => {
    expect(say("no_model")).toBe("279 of 374 attempts did not log their model, so the model split covers only the rest.");
    expect(say("reconstructed")).toBe("12 of 374 attempts have times rebuilt from older logs, which are less precise than times recorded as the work happened.");
    expect(say("open_attempts")).toBe("9 attempts had not ended when this was read, or lost their session. Their time counts up to their last activity.");
    expect(say("capped_attempts")).toBe("1 attempt ran longer than 12 hours and counts as 12.");
    expect(say("done_without_agent_time")).toBe("40 of 362 finished tickets have no agent time recorded, so the agent time here leaves their work out.");
    expect(say("closed_on_import")).toBe("3 tickets closed on import (finished within minutes of being created, with no agent) are counted as delivered and left out of speed.");
    expect(say("estimates_partial")).toBe("116 of 362 finished tickets have no estimate, so planned effort covers only the rest.");
    expect(say("workspace_unavailable")).toBe("1 workspace could not be opened on this computer (gh), so its work is missing from every figure.");
  });

  it("lists every Overview caveat for the method notes and leaves the Return lens's own codes to it", () => {
    expect(caveatSentences(answer).map((note) => note.code)).toEqual(["workspace_unavailable", "capped_attempts", "open_attempts", "reconstructed", "done_without_agent_time", "closed_on_import", "estimates_partial", "no_model"]);
    expect(caveatSentences(report())).toEqual([]);
  });

  it("turns a count of records without something into the widget's partial-data note", () => {
    expect(coverageOf(answer, "estimates_partial", "finished tickets", "have an estimate")).toEqual({ covered: 246, total: 362, noun: "finished tickets", have: "have an estimate" });
    expect(coverageOf(answer, "default_cost_model", "x", "y")).toBeNull();
    expect(coverageOf(report(), "no_model", "attempts", "logged their model")).toBeNull();
    // A caveat that counts nothing is no caveat.
    expect(coverageOf(report({ caveats: [{ code: "no_model", count: 0, of: 10 }] }), "no_model", "attempts", "logged their model")).toBeNull();
  });
});

describe("the Return tile", () => {
  const roi = (assumed: string[], measured: number | null, planned: number | null, plannedHours = 100) =>
    ({
      model: { model: { scenario: { mode: "solo" }, solo: { assumed, entries: [] }, company: { assumed: ["director.hourlyRate"], entries: [] }, roles: { roles: [{ id: "software-engineer", title: "Software Engineer" }], assumed: [] } } },
      measured: { returnOnTotalCost: measured },
      planned: { returnOnTotalCost: planned, valueHours: plannedHours },
    }) as unknown as RoiResponse;

  it("reads both ends from the ROI route and says whether the profile in use still holds defaults", () => {
    expect(returnTile(roi(["director.hourlyRate"], 2.7, 8))).toEqual({ measured: 2.7, planned: 8, assumed: true });
    // The company profile's defaults do not mark the solo profile's figure.
    expect(returnTile(roi([], 2.7, null))).toEqual({ measured: 2.7, planned: null, assumed: false });
  });

  it("has no planned end when no finished ticket carries an estimate, whatever the route divides out", () => {
    // The route answers 0 for the planned return when nothing was estimated; that is no count, not a return of 0.
    expect(returnTile(roi([], 2.4, 0, 0))).toEqual({ measured: 2.4, planned: null, assumed: false });
  });

  it("does not call a removed role's unset rate a default still to set", () => {
    expect(returnTile(roi(["roles.technical-writer.hourlyRate"], 2.7, 8)).assumed).toBe(false);
    expect(returnTile(roi(["roles.software-engineer.hourlyRate"], 2.7, 8)).assumed).toBe(true);
  });
});
