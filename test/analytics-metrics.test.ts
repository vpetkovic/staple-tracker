/**
 * The Analytics read (`src/core/analytics/metrics.ts`) over fixture rows: the definitions the
 * contract states, and the edge cases a real hub has — an empty workspace, attempts with no
 * model or no end, history imported already done, a day boundary in a named time zone, and an
 * attempt longer than the cap.
 *
 * Most cases build rows directly, because the metrics are a pure function of rows. The last
 * block writes a real history through the store and reads it with `readWorkspaceRows`, so the
 * row reader and `issueEffort` are exercised the way the server calls them.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyticsReport, quantileOf, resolvePeriod, roleTallies, type AnalyticsQuery } from "../src/core/analytics/metrics.js";
import { readWorkspaceRows, type AnalyticsAttempt, type AnalyticsIssue, type WorkspaceRows } from "../src/core/analytics/rows.js";
import type { AnalyticsReport } from "../src/core/analytics/contract.js";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

const H = 3600;

let serial = 0;
function issue(over: Partial<AnalyticsIssue> & { id?: string }): AnalyticsIssue {
  serial += 1;
  return {
    id: over.id ?? `i${serial}`,
    identifier: over.identifier ?? `TST-${serial}`,
    title: "A ticket",
    kind: "task",
    status: "done",
    category: "done",
    priority: "medium",
    parentId: null,
    labels: [],
    createdAt: "2026-09-01T10:00:00.000Z",
    startedAt: "2026-09-01T10:00:00.000Z",
    completedAt: "2026-09-01T12:00:00.000Z",
    cancelledAt: null,
    estimatedSeconds: null,
    ...over,
  };
}

function attempt(issueId: string, over: Partial<AnalyticsAttempt> = {}): AnalyticsAttempt {
  serial += 1;
  const startedAt = over.startedAt ?? "2026-09-01T10:00:00.000Z";
  const endAt = over.endAt ?? "2026-09-01T12:00:00.000Z";
  return {
    id: `a${serial}`,
    issueId,
    agent: "worker",
    role: "worker",
    harness: "claude_code",
    model: "claude-opus-5-5",
    startedAt,
    endAt,
    effortSeconds: over.effortSeconds ?? Math.round((Date.parse(endAt) - Date.parse(startedAt)) / 1000),
    standing: "completed",
    provenance: "recorded",
    ...over,
  };
}

function ws(slug: string, issues: AnalyticsIssue[], attempts: AnalyticsAttempt[] = []): WorkspaceRows {
  return { slug, prefix: slug.toUpperCase(), issues, attempts };
}

function read(rows: WorkspaceRows[], query: Partial<AnalyticsQuery> = {}, unavailable: string[] = []): AnalyticsReport {
  return analyticsReport(
    rows,
    {
      kind: rows.length + unavailable.length > 1 ? "hub" : "workspace",
      workspaces: [
        ...rows.map((w) => ({ slug: w.slug, prefix: w.prefix, available: true })),
        ...unavailable.map((slug) => ({ slug, prefix: slug.toUpperCase(), available: false })),
      ],
    },
    { now: "2026-09-30T12:00:00.000Z", tz: "UTC", ...query },
  );
}

const caveat = (report: AnalyticsReport, code: string) => report.caveats.find((c) => c.code === code) ?? null;

describe("an empty workspace", () => {
  it("reads zeros and nulls, never a fabricated figure, and defaults the period to today", () => {
    const report = read([ws("empty", [])]);
    expect(report.period).toMatchObject({ from: "2026-09-30", to: "2026-09-30", days: 1, explicit: false, firstActivity: null, lastActivity: null });
    expect(report.headline).toEqual({
      done: 0,
      epicsDone: 0,
      bugsFixed: 0,
      agentHours: 0,
      ftePeriod: 0,
      peakConcurrency: 0,
      medianCycleHours: null,
      attemptSuccessRate: null,
      plannedHours: 0,
    });
    expect(report.capacity.fteActiveDays).toBeNull();
    expect(report.speed.cycle.medianHours).toBeNull();
    expect(report.estimates.pairs.medianRatio).toBeNull();
    expect(report.caveats).toEqual([]);
    expect(report.previous).toBeNull();
    expect(report.series).toHaveLength(1);
  });
});

describe("delivery, capacity and speed over one period", () => {
  const a = issue({ id: "a", kind: "bug", startedAt: "2026-09-01T10:00:00.000Z", completedAt: "2026-09-01T11:00:00.000Z" });
  const b = issue({ id: "b", startedAt: "2026-09-02T09:00:00.000Z", completedAt: "2026-09-02T13:00:00.000Z", createdAt: "2026-09-01T09:00:00.000Z" });
  const open = issue({ id: "open", status: "in_progress", category: "active", completedAt: null });
  const rows = ws("w", [a, b, open], [
    attempt("a", { startedAt: "2026-09-01T10:00:00.000Z", endAt: "2026-09-01T11:00:00.000Z" }),
    attempt("b", { startedAt: "2026-09-02T09:00:00.000Z", endAt: "2026-09-02T13:00:00.000Z", agent: "other" }),
    attempt("b", { startedAt: "2026-09-02T10:00:00.000Z", endAt: "2026-09-02T11:00:00.000Z", standing: "failed", agent: "other" }),
  ]);

  it("counts tickets done in the period, their kinds and the open ones now", () => {
    const report = read([rows], { from: "2026-09-01", to: "2026-09-07" });
    expect(report.delivery).toMatchObject({ done: 2, bugsFixed: 1, byKind: { bug: 1, task: 1 }, daysWithDone: 2, openNow: { active: 1 } });
    expect(report.delivery.bestDay).toEqual({ date: "2026-09-01", done: 1 });
  });

  it("sums agent-hours, peak concurrency and both FTE figures", () => {
    const report = read([rows], { from: "2026-09-01", to: "2026-09-07" });
    expect(report.capacity).toMatchObject({ agentHours: 6, attempts: 3, agents: 2, activeDays: 2, ftePeriod: 0.15, fteActiveDays: 0.38, workWeeks: 0.15 });
    expect(report.capacity.peakConcurrency).toEqual({ count: 2, at: "2026-09-02T10:00:00.000Z" });
    expect(report.series.map((p) => p.peakConcurrency)).toEqual([1, 2, 0, 0, 0, 0, 0]);
  });

  it("reads cycle and lead time with the lower quantile", () => {
    const report = read([rows], { from: "2026-09-01", to: "2026-09-07" });
    // Cycle: 1 h and 4 h. Lower median of two is the first.
    expect(report.speed.cycle).toMatchObject({ n: 2, medianHours: 1, under1h: 0, under4h: 1 });
    expect(report.speed.lead).toMatchObject({ n: 2, medianHours: 1, within24h: 1 });
    expect(report.speed.histogram.find((bin) => bin.label === "1–2h")!.count).toBe(1);
    expect(report.speed.histogram.find((bin) => bin.label === "4–8h")!.count).toBe(1);
    expect(quantileOf([4, 3, 2, 1], 50)).toBe(2);
  });

  it("divides attempt success by the attempts that have ended", () => {
    const withOpen = ws("w", rows.issues as AnalyticsIssue[], [...rows.attempts, attempt("open", { startedAt: "2026-09-03T09:00:00.000Z", endAt: "2026-09-03T09:30:00.000Z", standing: "open" })]);
    const report = read([withOpen], { from: "2026-09-01", to: "2026-09-07" });
    expect(report.reliability.outcomes).toMatchObject({ completed: 2, failed: 1, open: 1 });
    expect(report.reliability.successRate).toBeCloseTo(2 / 3);
    expect(caveat(report, "open_attempts")).toEqual({ code: "open_attempts", count: 1, of: 4 });
  });

  it("compares against the window of the same length just before", () => {
    const report = read([rows], { from: "2026-09-02", to: "2026-09-02" });
    expect(report.previous).toMatchObject({ from: "2026-09-01", to: "2026-09-01", headline: { done: 1, agentHours: 1 } });
    expect(report.headline).toMatchObject({ done: 1, agentHours: 5 });
  });
});

describe("attempt edge cases", () => {
  it("caps one attempt at 12 agent-hours and reports what the cap removed", () => {
    const t = issue({ id: "t", completedAt: "2026-09-02T06:00:00.000Z" });
    const report = read([ws("w", [t], [attempt("t", { startedAt: "2026-09-01T10:00:00.000Z", endAt: "2026-09-02T06:00:00.000Z" })])], { from: "2026-09-01", to: "2026-09-03" });
    expect(report.capacity.agentHours).toBe(12);
    expect(report.capacity.agentHoursUncapped).toBe(20);
    expect(report.capacity.attemptsCapped).toBe(1);
    expect(caveat(report, "capped_attempts")).toEqual({ code: "capped_attempts", count: 1, of: 1 });
  });

  it("does not count an attempt that ended at midnight as running on the next day", () => {
    const t = issue({ id: "t", completedAt: "2026-09-02T00:00:00.000Z" });
    const report = read([ws("w", [t], [attempt("t", { startedAt: "2026-09-01T23:00:00.000Z", endAt: "2026-09-02T00:00:00.000Z" })])], { from: "2026-09-01", to: "2026-09-02" });
    expect(report.series.map((p) => [p.agentHours, p.peakConcurrency])).toEqual([
      [1, 1],
      [0, 0],
    ]);
    expect(report.capacity.activeDays).toBe(1);
  });

  it("spreads an attempt's hours over the days it ran and clips it to the period", () => {
    const t = issue({ id: "t", completedAt: "2026-09-02T04:00:00.000Z" });
    // 22:00 to 04:00 UTC: 2 h on Sep 1, 4 h on Sep 2.
    const rows = ws("w", [t], [attempt("t", { startedAt: "2026-09-01T22:00:00.000Z", endAt: "2026-09-02T04:00:00.000Z" })]);
    expect(read([rows], { from: "2026-09-01", to: "2026-09-02" }).series.map((p) => p.agentHours)).toEqual([2, 4]);
    expect(read([rows], { from: "2026-09-02", to: "2026-09-02" }).capacity.agentHours).toBe(4);
  });

  it("counts an attempt with no model and says how many have none", () => {
    const t = issue({ id: "t" });
    const report = read([ws("w", [t], [attempt("t", { model: null, harness: null }), attempt("t", { startedAt: "2026-09-01T10:30:00.000Z" })])], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.capacity.attempts).toBe(2);
    expect(report.capacity.byModel).toEqual([
      { model: null, harness: null, attempts: 1, completed: 1, agentHours: 2 },
      { model: "claude-opus-5-5", harness: "claude_code", attempts: 1, completed: 1, agentHours: 1.5 },
    ]);
    expect(caveat(report, "no_model")).toEqual({ code: "no_model", count: 1, of: 2 });
  });

  it("flags reconstructed attempts", () => {
    const t = issue({ id: "t" });
    const report = read([ws("w", [t], [attempt("t", { provenance: "reconstructed" })])], { from: "2026-09-01", to: "2026-09-01" });
    expect(caveat(report, "reconstructed")).toEqual({ code: "reconstructed", count: 1, of: 1 });
  });
});

describe("imported history", () => {
  it("delivers a ticket imported already done but keeps it out of speed", () => {
    const imported = issue({ id: "imp", createdAt: "2026-09-01T08:00:00.000Z", startedAt: "2026-09-01T08:00:00.000Z", completedAt: "2026-09-01T08:00:30.000Z" });
    const worked = issue({ id: "w" });
    const report = read([ws("w", [imported, worked], [attempt("w")])], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.delivery.done).toBe(2);
    expect(report.speed.cycle.n).toBe(1);
    expect(report.speed.histogram.find((bin) => bin.label === "<15m")!.count).toBe(0);
    expect(caveat(report, "closed_on_import")).toEqual({ code: "closed_on_import", count: 1, of: 2 });
    expect(caveat(report, "done_without_agent_time")).toEqual({ code: "done_without_agent_time", count: 1, of: 2 });
  });

  it("does not read a quickly closed ticket that an agent worked as imported", () => {
    const quick = issue({ id: "q", createdAt: "2026-09-01T10:00:00.000Z", startedAt: "2026-09-01T10:00:00.000Z", completedAt: "2026-09-01T10:01:00.000Z" });
    const report = read([ws("w", [quick], [attempt("q", { endAt: "2026-09-01T10:01:00.000Z" })])], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.speed.cycle.n).toBe(1);
    expect(caveat(report, "closed_on_import")).toBeNull();
  });
});

describe("time zones", () => {
  // 02:30 UTC on Wednesday Sep 2 is 22:30 on Tuesday Sep 1 in New York.
  const late = issue({ id: "late", startedAt: "2026-09-02T01:30:00.000Z", completedAt: "2026-09-02T02:30:00.000Z", createdAt: "2026-09-02T01:00:00.000Z" });
  const rows = ws("w", [late]);

  it("places a completion on the reader's calendar day, weekday and hour", () => {
    const ny = read([rows], { from: "2026-09-01", to: "2026-09-02", tz: "America/New_York" });
    expect(ny.series.map((p) => p.done)).toEqual([1, 0]);
    expect(ny.rhythm.heatmap[1]![22]).toBe(1);
    expect(ny.rhythm.night).toBe(1);
    const utc = read([rows], { from: "2026-09-01", to: "2026-09-02", tz: "UTC" });
    expect(utc.series.map((p) => p.done)).toEqual([0, 1]);
    expect(utc.rhythm.heatmap[2]![2]).toBe(1);
  });

  it("refuses a zone it does not know rather than reading UTC", () => {
    expect(() => read([rows], { tz: "Mars/Olympus" })).toThrow(StapleError);
  });
});

describe("planned effort", () => {
  it("counts a parent's estimate only when no descendant carries one", () => {
    const planned = issue({ id: "e1", kind: "epic", estimatedSeconds: 10 * H });
    const child = issue({ id: "c1", parentId: "e1", estimatedSeconds: 2 * H });
    const bare = issue({ id: "e2", kind: "epic", estimatedSeconds: 5 * H });
    const bareChild = issue({ id: "c2", parentId: "e2" });
    const report = read([ws("w", [planned, child, bare, bareChild])], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.estimates.planned).toEqual({ hours: 7, tickets: 2, ofDone: 4 });
    expect(caveat(report, "estimates_partial")).toEqual({ code: "estimates_partial", count: 2, of: 4 });
  });

  it("pairs a done ticket's own estimate with its measured work", () => {
    const t = issue({ id: "t", estimatedSeconds: 4 * H });
    const report = read([ws("w", [t], [attempt("t")])], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.estimates.pairs).toEqual({ n: 1, estimateHours: 4, workHours: 2, medianRatio: 0.5, underEstimate: 1 });
  });
});

describe("epics and sprints", () => {
  it("lists an epic whose descendants were delivered in the period, with their hours", () => {
    const epic = issue({ id: "e", kind: "epic", identifier: "TST-E", title: "The feature" });
    const mid = issue({ id: "m", parentId: "e", status: "backlog", category: "unstarted", completedAt: null });
    const leaf = issue({ id: "l", parentId: "m" });
    const report = read([ws("w", [epic, mid, leaf], [attempt("l")])], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.epics).toEqual([
      expect.objectContaining({ identifier: "TST-E", descendants: 2, descendantsDone: 1, doneInPeriod: 1, completedOn: "2026-09-01", agentHours: 2 }),
    ]);
    expect(report.workspaces[0]!.features).toEqual([{ identifier: "TST-E", title: "The feature", descendantsDone: 1 }]);
  });

  it("splits completion days into sprints at more than five quiet days", () => {
    const tickets: AnalyticsIssue[] = [];
    for (const day of ["01", "02", "03"]) for (let n = 0; n < 4; n += 1) tickets.push(issue({ completedAt: `2026-09-${day}T12:00:00.000Z` }));
    // Sep 4 to Sep 9 is six quiet days: a new run starts on Sep 10, too small to be a sprint.
    tickets.push(issue({ completedAt: "2026-09-10T12:00:00.000Z" }));
    const report = read([ws("w", tickets)], { from: "2026-09-01", to: "2026-09-30" });
    expect(report.sprints.map((s) => [s.start, s.end, s.done])).toEqual([["2026-09-01", "2026-09-03", 12]]);
  });
});

describe("a hub", () => {
  it("keeps each workspace's figures apart and says which workspaces it could not read", () => {
    const one = ws("one", [issue({ id: "x" })], [attempt("x")]);
    const two = ws("two", [issue({ id: "x" }), issue({ id: "y" })]);
    const report = read([one, two], { from: "2026-09-01", to: "2026-09-01" }, ["gone"]);
    expect(report.scope.kind).toBe("hub");
    expect(report.workspaces.map((w) => [w.slug, w.done, w.agentHours])).toEqual([
      ["one", 1, 2],
      ["two", 2, 0],
    ]);
    expect(report.series[0]!.byWorkspace).toEqual({ one: { done: 1, agentHours: 2 }, two: { done: 2, agentHours: 0 } });
    expect(caveat(report, "workspace_unavailable")).toEqual({ code: "workspace_unavailable", count: 1, of: 3 });
  });
});

describe("the paper trail", () => {
  it("counts comments, documents by key and files written inside the period", () => {
    const rows: WorkspaceRows = {
      ...ws("w", []),
      record: {
        comments: ["2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z", "2026-08-31T23:00:00.000Z"],
        documents: [
          { key: "plan", createdAt: "2026-09-01T10:00:00.000Z" },
          { key: "worklog", createdAt: "2026-09-01T10:00:00.000Z" },
          { key: "plan", createdAt: "2026-09-01T12:00:00.000Z" },
          { key: "context", createdAt: "2026-08-01T12:00:00.000Z" },
        ],
        files: [
          { createdAt: "2026-09-01T10:00:00.000Z", size: 1000 },
          { createdAt: "2026-09-02T10:00:00.000Z", size: 5 },
        ],
      },
    };
    expect(read([rows], { from: "2026-09-01", to: "2026-09-01" }).record).toEqual({
      comments: 2,
      documents: 3,
      files: 1,
      fileBytes: 1000,
      byDocumentKey: [
        { key: "plan", count: 2 },
        { key: "worklog", count: 1 },
      ],
    });
  });
});

describe("hours and tickets by the role they are priced at", () => {
  const roleOf = (type: string): string => (type === "documentation" ? "writer" : "engineer");
  const rows = ws(
    "w",
    [
      issue({ id: "docs", title: "Docs for the API", estimatedSeconds: 3 * H }),
      issue({ id: "qa", title: "QA pass over the import", estimatedSeconds: 1 * H }),
      issue({ id: "open", status: "in_progress", category: "active", completedAt: null }),
      issue({ id: "bare", title: "Closed with no agent", estimatedSeconds: 2 * H }),
    ],
    [attempt("docs"), attempt("qa"), attempt("open", { agent: "docs-writer" })],
  );

  it("prices measured hours by attempt and planned hours by ticket, a rule's role included", () => {
    const resolved = resolvePeriod([rows], { now: "2026-09-30T12:00:00.000Z", from: "2026-09-01", to: "2026-09-01" });
    const tallies = roleTallies([rows], resolved, [{ title: "qa", roleId: "qa-engineer" }], roleOf);
    expect(Object.fromEntries([...tallies.measured].map(([id, t]) => [id, [t.hours, t.tickets]]))).toEqual({ writer: [4, 1], "qa-engineer": [2, 1], engineer: [0, 1] });
    expect(Object.fromEntries([...tallies.planned].map(([id, t]) => [id, [t.hours, t.tickets, t.plannedTickets]]))).toEqual({
      writer: [3, 1, 1],
      "qa-engineer": [1, 1, 1],
      engineer: [2, 1, 1],
    });
    // The open ticket's attempt was typed `documentation` by its agent's name: 2 h priced at writer, on no done ticket.
    expect(tallies.otherHours.get("writer")).toBe(2);
    expect(tallies.tickets.get("qa-engineer")).toEqual([
      expect.objectContaining({ identifier: expect.any(String), title: "QA pass over the import", type: "engineering", reason: { code: "rule", detail: "0" }, plannedSeconds: 3600, agentSeconds: 7200 }),
    ]);
  });
});

describe("the period", () => {
  it("clamps all time to the longest period instead of refusing old history", () => {
    const old = issue({ createdAt: "2012-03-01T10:00:00.000Z", startedAt: null, completedAt: null, status: "backlog", category: "unstarted" });
    const report = read([ws("w", [old])], { now: "2026-09-30T12:00:00.000Z" });
    expect(report.period).toMatchObject({ to: "2026-09-30", days: 3660, explicit: false, firstActivity: "2012-03-01" });
    expect(report.period.from > "2012-03-01").toBe(true);
  });

  it("refuses an inverted period, a bad day and an unknown bucket", () => {
    const rows = [ws("w", [])];
    expect(() => read(rows, { from: "2026-09-05", to: "2026-09-01" })).toThrow(/before/);
    expect(() => read(rows, { from: "2026-02-30" })).toThrow(/calendar day/);
    expect(() => read(rows, { from: "2026-09-01", bucket: "year" })).toThrow(/bucket/);
  });

  it("buckets by ISO week, Monday first, clipped to the period", () => {
    const report = read([ws("w", [issue({ completedAt: "2026-09-02T12:00:00.000Z" }), issue({ completedAt: "2026-09-08T12:00:00.000Z" })])], {
      from: "2026-09-02",
      to: "2026-09-10",
      bucket: "week",
    });
    expect(report.series.map((p) => [p.start, p.end, p.done])).toEqual([
      ["2026-09-02", "2026-09-06", 1],
      ["2026-09-07", "2026-09-10", 1],
    ]);
  });
});

describe("read from a real workspace", () => {
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  const at = (minutes: number): void => void vi.setSystemTime(T0 + minutes * 60_000);
  let home: string;
  let store: WorkspaceStore;
  const previousHome = process.env.STAPLE_HOME;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
    home = mkdtempSync(join(tmpdir(), "staple-analytics-home-"));
    process.env.STAPLE_HOME = home;
    const db = openDb(":memory:");
    migrateWorkspace(db);
    store = new WorkspaceStore(db, "test", "TST");
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.STAPLE_HOME;
    else process.env.STAPLE_HOME = previousHome;
  });

  it("reads an attempt's effort, its model and its outcome from the store", () => {
    const id = store.createIssue({ title: "Built", estimatedSeconds: 2 * H }).id;
    at(10);
    store.checkoutIssue(id, "builder", undefined, { attempt: { harness: "claude_code", model: "claude-opus-5-5" } });
    at(70);
    store.updateIssue(id, { status: "done" }, "builder");
    const rows = readWorkspaceRows(store.db, { slug: "test", prefix: "TST" });
    expect(rows.attempts).toEqual([
      expect.objectContaining({ agent: "builder", role: "worker", model: "claude-opus-5-5", harness: "claude_code", effortSeconds: 3600, standing: "completed" }),
    ]);
    const report = read([rows], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.headline).toMatchObject({ done: 1, agentHours: 1, plannedHours: 2, medianCycleHours: 1 });
  });

  it("counts an attempt with no end through its last evidence, not to the read's instant", () => {
    const id = store.createIssue({ title: "Running" }).id;
    store.checkoutIssue(id, "runner");
    at(30);
    store.addComment(id, "halfway", "runner");
    at(600);
    const rows = readWorkspaceRows(store.db, { slug: "test", prefix: "TST" });
    expect(rows.attempts).toEqual([expect.objectContaining({ standing: "open", effortSeconds: 1800, model: null })]);
    // The span ends at the comment, so a later period does not see the attempt still running.
    expect(rows.attempts[0]!.endAt).toBe(new Date(T0 + 30 * 60_000).toISOString());
    const report = read([rows], { from: "2026-09-01", to: "2026-09-01", now: new Date(T0 + 600 * 60_000).toISOString() });
    expect(report.capacity.agentHours).toBe(0.5);
    expect(caveat(report, "open_attempts")).toEqual({ code: "open_attempts", count: 1, of: 1 });
    expect(caveat(report, "no_model")).toEqual({ code: "no_model", count: 1, of: 1 });
  });

  it("leaves milestones out of delivery", () => {
    store.addKind({ id: "milestone", label: "Milestone" });
    const done = store.createIssue({ title: "Milestone", kind: "milestone" }).id;
    store.updateIssue(done, { status: "done" }, "p");
    const report = read([readWorkspaceRows(store.db, { slug: "test", prefix: "TST" })], { from: "2026-09-01", to: "2026-09-01" });
    expect(report.delivery.done).toBe(0);
  });
});
