/**
 * Closing the lifecycle capture gaps (`docs/timing-semantics.md`): `workSeconds`, the `wall`
 * partition and their quality, on one device, over the spec's timelines.
 *
 * Every history here is built by real store calls at instants this suite controls: the write
 * clock is faked (`Date` only), so the store, the event writer and the attempt ledger all read
 * the same injected instant, as the spec's "Validating against controlled runs" row asks. No
 * attempt, transition or event row is written by hand, except where a case says it simulates
 * history an older build left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { attemptsOfIssue, transitionsOf } from "../src/core/telemetry/attempt-records.js";
import { viewsOfIssue } from "../src/core/telemetry/attempt-derive.js";
import { StapleError } from "../src/core/types.js";
import type { IssueTiming } from "../src/core/types.js";
import { attemptOptionsFrom } from "../src/commands/attempt.js";
import { attemptOptionsFromInput } from "../src/mcp-attempts.js";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
/** Move the write clock to `minutes` after T0. */
const at = (minutes: number): void => void vi.setSystemTime(T0 + minutes * 60_000);

let store: WorkspaceStore;
const previousHome = process.env.STAPLE_HOME;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  process.env.STAPLE_HOME = mkdtempSync(join(tmpdir(), "staple-timing-home-"));
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.STAPLE_ROLE;
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

const timing = (id: string, asOf: number): IssueTiming => store.timingFor([id], iso(asOf)).get(id)!;
const min = (n: number): number => n * 60;
const buckets = (over: Record<string, number>): Record<string, number> => ({
  work: 0,
  paused: 0,
  silent: 0,
  interrupted: 0,
  unattributed: 0,
  review: 0,
  gated: 0,
  blocked: 0,
  queued: 0,
  resolved: 0,
  ...over,
});
/** The partition invariant: the buckets add up to the span (exact here: every instant is a whole minute). */
function partitions(t: IssueTiming): void {
  expect(t.wall).not.toBeNull();
  const sum = Object.values(t.wall!.buckets).reduce((a, b) => a + b, 0);
  expect(sum).toBe(t.wall!.seconds);
}
function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}
/** Stop this device writing stored orphan ends, as a synchronized device does until a pull reaches the head. */
function holdOrphanEnds(): void {
  store.db.prepare("INSERT INTO sync_state (id, epoch, cursor) VALUES (1, 1, 'c1')").run();
}
function releaseOrphanEnds(): void {
  store.db.prepare("DELETE FROM sync_state WHERE id = 1").run();
}

// ------------------------------------------------------------------ acceptance

describe("pauses, resumes and terminal transitions", () => {
  it("a pause is never work, a resume opens a new working interval, and the partition says where each second went", () => {
    const x = store.createIssue({ title: "Paused and resumed", estimatedSeconds: 3600 });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.addComment(x.id, "halfway", "agent-a");
    at(20);
    store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "checkpoint_before_reset" });
    at(50);
    store.recordAttemptEvent(x.id, "resume", "agent-a");
    at(60);
    store.addComment(x.id, "nearly", "agent-a");
    at(70);
    store.updateIssue(x.id, { status: "done" }, "agent-a");

    const t = timing(x.id, 90);
    // Category time counts the pause; work does not.
    expect(t.ownActiveSeconds).toBe(min(70));
    expect(t.workSeconds).toBe(min(40));
    expect(t.ownWorkSeconds).toBe(min(40));
    expect(t.quality.work).toEqual({ state: "exact", inputs: [], coverage: null, missingInputs: [] });
    // The resume is a new interval: work before the pause and after it, the pause between.
    expect(t.wall).toEqual({ startAt: iso(0), endAt: iso(70), through: null, seconds: min(70), buckets: buckets({ work: min(40), paused: min(30) }) });
    expect(t.quality.wall).toEqual({ state: "exact", inputs: [] });
    expect(t.leadSeconds).toBe(0);
    expect(t.estimateRatio).toBeCloseTo(2400 / 3600, 10);
    partitions(t);
  });

  it("a terminal transition closes every open interval, a pause included", () => {
    const x = store.createIssue({ title: "Done while paused" });
    store.checkoutIssue(x.id, "agent-a");
    at(5);
    store.addComment(x.id, "started", "agent-a");
    at(10);
    store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "awaiting_input" });
    at(30);
    store.updateIssue(x.id, { status: "done" }, "agent-a");

    const [attempt] = viewsOfIssue(store.db, x.id, iso(90));
    expect(attempt).toMatchObject({ state: "ended", outcome: "completed", endedAt: iso(30), pausedSeconds: min(20) });
    const t = timing(x.id, 90);
    expect(t.workSeconds).toBe(min(10));
    expect(t.wall).toMatchObject({ endAt: iso(30), buckets: buckets({ work: min(10), paused: min(20) }) });
    partitions(t);
    // Read again much later: nothing is open, so nothing grows.
    expect(timing(x.id, 5000)).toEqual(t);
  });

  it("an open pause stays paused through asOf, and an open attempt's silence is provisional", () => {
    const x = store.createIssue({ title: "Still paused" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.addComment(x.id, "work", "agent-a");
    at(20);
    store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "awaiting_reset" });
    const paused = timing(x.id, 60);
    expect(paused.wall).toMatchObject({ endAt: null, through: iso(60), buckets: buckets({ work: min(20), paused: min(40) }) });
    // Work reads the replicated evidence: the pause is the last of it.
    expect(paused.workSeconds).toBe(min(20));

    const y = store.createIssue({ title: "Silent" });
    at(100);
    store.checkoutIssue(y.id, "agent-b");
    at(110);
    store.addComment(y.id, "one line", "agent-b");
    const silent = timing(y.id, 140);
    expect(silent.wall).toMatchObject({ buckets: buckets({ work: min(10), silent: min(30) }) });
    expect(silent.workSeconds).toBe(min(10));
    partitions(silent);
    // The agent writes again: the silence becomes work.
    at(150);
    store.addComment(y.id, "back", "agent-b");
    expect(timing(y.id, 150).wall!.buckets).toMatchObject({ work: min(50), silent: 0 });
  });

  it("a cancelled issue reports what ran and no comparable work", () => {
    const x = store.createIssue({ title: "Cancelled" });
    store.checkoutIssue(x.id, "agent-a");
    at(15);
    store.updateIssue(x.id, { status: "cancelled" }, "agent-a");
    const t = timing(x.id, 20);
    expect(t.workSeconds).toBeNull();
    expect(t.ownWorkSeconds).toBe(min(15));
    expect(t.missing.workSeconds).toBe("not_applicable_cancelled");
    expect(t.quality.work.state).toBeNull();
  });
});

describe("sparse data produces an explicit approximation flag", () => {
  it("marks a gap of more than 30 minutes between replicated evidence inside working time, and nothing is subtracted", () => {
    const x = store.createIssue({ title: "Sparse", estimatedSeconds: 3600 });
    store.checkoutIssue(x.id, "agent-a");
    at(45);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    const t = timing(x.id, 50);
    expect(t.workSeconds).toBe(min(45));
    expect(t.quality.work).toMatchObject({ state: "approximate", inputs: ["sparse"] });
    // Ineligible for the ratio: its quality is not exact.
    expect(t.estimateRatio).toBeNull();
  });

  it("does not mark a pause as a gap, nor a silence broken by a comment", () => {
    const x = store.createIssue({ title: "Dense" });
    store.checkoutIssue(x.id, "agent-a");
    at(20);
    store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "awaiting_reset" });
    at(80);
    store.recordAttemptEvent(x.id, "resume", "agent-a");
    at(100);
    store.addComment(x.id, "done", "agent-a");
    at(110);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    expect(timing(x.id, 120).quality.work).toMatchObject({ state: "exact", inputs: [] });
  });

  it("the capture gap: a row that started before its first worker attempt is a lower bound", () => {
    const x = store.createIssue({ title: "Started before capture" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    // As an older build left it: the start is earlier than any attempt.
    store.db.prepare("UPDATE issues SET started_at = ? WHERE id = ?").run(iso(-30), x.id);
    const t = timing(x.id, 20);
    expect(t.quality.work).toMatchObject({ state: "approximate", inputs: ["capture_gap"] });
    // With no worker attempt at all it is missing.
    store.db.prepare("DELETE FROM attempts WHERE issue_id = ?").run(x.id);
    expect(timing(x.id, 20)).toMatchObject({ workSeconds: null, missing: { workSeconds: "no_worker_attempt" }, quality: { work: { state: "missing" } } });
  });

  it("an attempt that ends more than a second before it starts is clock skew, on both axes", () => {
    const x = store.createIssue({ title: "Skewed" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    // Another device's clock, behind this one's: its end reads before its start.
    store.db.prepare("UPDATE attempts SET started_at = ?, ended_at = ? WHERE issue_id = ?").run(iso(5), iso(2), x.id);
    const t = timing(x.id, 20);
    expect(t.quality.work.inputs).toContain("clock_skew");
    expect(t.quality.wall.inputs).toContain("clock_skew");
  });

  it("under a minute is timing-floor, and zero-length intervals at one instant are counted as zero", () => {
    // Born in the active category and done in the same millisecond.
    const x = store.createIssue({ title: "Instant", status: "in_progress", createdBy: "agent-a" });
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    const t = timing(x.id, 1);
    expect(t.workSeconds).toBe(0);
    expect(t.quality.work.state).toBe("timing-floor");
    expect(t.wall).toMatchObject({ seconds: 0, buckets: buckets({}) });
  });
});

// ------------------------------------------------------------ boundary rules

describe("one mutation, one instant", () => {
  it("the checkout's event, the row's claim and the attempt's start are the same instant, so there is no unattributed sliver", () => {
    const x = store.createIssue({ title: "One instant" });
    at(5);
    /**
     * A clock that moves a millisecond on every read: a writer that reads it for itself gets
     * an instant of its own, so only one instant handed to every writer passes below.
     */
    const RealDate = Date;
    let tick = T0 + 5 * 60_000;
    class TickingDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super((tick += 1) - 1);
        else super(...(args as [number]));
      }
      static override now(): number {
        return (tick += 1) - 1;
      }
    }
    globalThis.Date = TickingDate as DateConstructor;
    try {
      store.checkoutIssue(x.id, "agent-a");
    } finally {
      globalThis.Date = RealDate;
    }
    at(5);
    const event = store.db.prepare("SELECT created_at FROM events WHERE issue_id = ? AND kind = 'checkout'").get(x.id) as { created_at: string };
    const row = store.db.prepare("SELECT checkout_at, started_at FROM issues WHERE id = ?").get(x.id) as { checkout_at: string; started_at: string };
    const [attempt] = attemptsOfIssue(store.db, x.id);
    const [started] = transitionsOf(store.db, attempt!.id);
    expect(new Set([event.created_at, row.checkout_at, row.started_at, attempt!.startedAt, started!.at]).size).toBe(1);
    at(15);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    const ended = store.db.prepare("SELECT created_at FROM events WHERE issue_id = ? AND kind = 'status_changed'").get(x.id) as { created_at: string };
    expect(attemptsOfIssue(store.db, x.id)[0]!.endedAt).toBe(ended.created_at);
    expect(timing(x.id, 20).wall!.buckets.unattributed).toBe(0);
  });

  it("history an older build wrote, with the attempt a second off its checkout, is snapped to the category boundary", () => {
    const x = store.createIssue({ title: "Older build" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    // The ledger read its own clock then: its start a second after the checkout, its end a second before the close.
    store.db.prepare("UPDATE attempts SET started_at = ?, ended_at = ? WHERE issue_id = ?").run(
      new Date(T0 + 1000).toISOString(),
      new Date(T0 + 10 * 60_000 - 1000).toISOString(),
      x.id,
    );
    const t = timing(x.id, 20);
    expect(t.wall!.buckets).toMatchObject({ work: min(10), unattributed: 0 });
    expect(t.quality.wall).toEqual({ state: "exact", inputs: [] });
  });
});

describe("the adversarial timelines", () => {
  it("recategorise then re-open by the same agent: no overlap, and the number does not move when the stored end is written", () => {
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const x = store.createIssue({ title: "Recategorized" });
    store.checkoutIssue(x.id, "agent-a");
    store.updateIssue(x.id, { status: "doing" }, "agent-a");
    holdOrphanEnds();
    at(10);
    store.addComment(x.id, "before", "agent-a");
    at(20);
    store.recategorizeStatus("doing", "review", "vp");
    at(30);
    // Back into the active category by a status write: a new worker attempt, the successor,
    // and the first reads superseded (clause 5) rather than revived.
    store.updateIssue(x.id, { status: "in_progress" }, "agent-a");
    at(40);
    store.addComment(x.id, "after, the successor's", "agent-a");

    const [first, second] = attemptsOfIssue(store.db, x.id);
    expect(first!.state).toBe("running");
    const derived = timing(x.id, 45);
    // The first attempt's evidence stops at the successor's start: the comment at 40 is the successor's.
    expect(derived.ownWorkSeconds).toBe(min(10) + min(10));
    expect(derived.quality.work.inputs).toContain("orphan_provisional");

    // The opening device writes the stored end (dated at its last activity, 40), and nothing moves.
    releaseOrphanEnds();
    at(45);
    store.addComment(store.createIssue({ title: "Unrelated" }).id, "a mutating command", "vp");
    expect(attemptsOfIssue(store.db, x.id)[0]).toMatchObject({ id: first!.id, state: "ended", endDetection: "inferred", endedAt: iso(40) });
    const stored = timing(x.id, 45);
    expect(stored.ownWorkSeconds).toBe(derived.ownWorkSeconds);
    expect(stored.quality.work.inputs).not.toContain("orphan_provisional");
    at(50);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    expect(attemptsOfIssue(store.db, x.id)[1]).toMatchObject({ id: second!.id, endedAt: iso(50) });
    expect(timing(x.id, 60).workSeconds).toBe(min(10) + min(20));
  });

  it("a stored orphan end filters at itself: evidence the agent wrote after giving the tenure up is not added later", () => {
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const x = store.createIssue({ title: "Given up" });
    store.checkoutIssue(x.id, "agent-a");
    store.updateIssue(x.id, { status: "doing" }, "agent-a");
    at(10);
    store.addComment(x.id, "last work", "agent-a");
    at(20);
    store.recategorizeStatus("doing", "review", "vp");
    at(25);
    store.addComment(store.createIssue({ title: "Unrelated" }).id, "a mutating command", "vp");
    expect(attemptsOfIssue(store.db, x.id)[0]).toMatchObject({ state: "ended", endReason: "left_active", endedAt: iso(10) });
    const before = timing(x.id, 60).ownWorkSeconds;
    at(40);
    store.addComment(x.id, "a remark, long after", "agent-a");
    expect(timing(x.id, 60).ownWorkSeconds).toBe(before);
    expect(before).toBe(min(10));
    // No row bound (the issue is in review, not done or cancelled): the end is unbounded.
    expect(timing(x.id, 60).quality.work.inputs).toContain("end_unbounded");
  });

  it("a steal plus a late comment by the old holder: the comment is the successor's tenure, not the old one's", () => {
    const x = store.createIssue({ title: "Stolen" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.addComment(x.id, "last word", "agent-a");
    at(30);
    store.checkoutIssue(x.id, "agent-b", undefined, { stealIfIdleSeconds: 60 });
    at(40);
    store.addComment(x.id, "I was still here", "agent-a");
    at(50);
    store.updateIssue(x.id, { status: "done" }, "agent-b");
    const [old] = attemptsOfIssue(store.db, x.id);
    expect(old).toMatchObject({ endReason: "claim_stolen", endDetection: "inferred", endedAt: iso(10) });
    const t = timing(x.id, 60);
    expect(t.workSeconds).toBe(min(10) + min(20));
    // Elapsed: the silence before the steal is an interruption.
    expect(t.wall!.buckets).toMatchObject({ work: min(30), interrupted: min(20) });
    partitions(t);
  });

  it("a stale release plus a late comment: the release instant limits the evidence", () => {
    const x = store.createIssue({ title: "Released stale" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.addComment(x.id, "last word", "agent-a");
    at(60);
    store.releaseIssue(x.id, "vp", { ifIdleSeconds: 60 });
    at(70);
    store.addComment(x.id, "too late", "agent-a");
    const t = timing(x.id, 80);
    expect(t.ownWorkSeconds).toBe(min(10));
    // The released issue waits in the queue; before the release, the silence was an interruption.
    expect(t.wall!.buckets).toMatchObject({ work: min(10), interrupted: min(50), queued: min(20) });
    partitions(t);
  });

  it("a past pause inside a completed attempt is its own bucket, and review runs to asOf", () => {
    const x = store.createIssue({ title: "Reviewed" });
    store.checkoutIssue(x.id, "agent-a");
    at(5);
    store.addComment(x.id, "working", "agent-a");
    at(10);
    store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "checkpoint_before_reset" });
    at(40);
    store.recordAttemptEvent(x.id, "resume", "agent-a");
    at(50);
    store.addComment(x.id, "done", "agent-a");
    at(60);
    store.updateIssue(x.id, { status: "in_review" }, "agent-a");
    const t = timing(x.id, 90);
    expect(t.workSeconds).toBe(min(30));
    expect(t.reviewSeconds).toBe(min(30));
    expect(t.wall).toMatchObject({ through: iso(90), buckets: buckets({ work: min(30), paused: min(30), review: min(30) }) });
    partitions(t);
  });

  it("the interruption gap before a completed successor is interrupted time, never work", () => {
    const x = store.createIssue({ title: "Interrupted then resumed" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.addComment(x.id, "progress", "agent-a");
    at(15);
    store.recordAttemptEvent(x.id, "interrupt", "agent-a", { reason: "provider_limit" });
    at(45);
    store.checkoutIssue(x.id, "agent-a");
    at(50);
    store.addComment(x.id, "resumed", "agent-a");
    at(60);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    const [first, second] = attemptsOfIssue(store.db, x.id);
    expect(second).toMatchObject({ openedBy: "reclaim", resumesAttemptId: first!.id });
    const t = timing(x.id, 70);
    expect(t.workSeconds).toBe(min(30));
    expect(t.wall!.buckets).toMatchObject({ work: min(30), interrupted: min(30) });
    expect(t.ownActiveSeconds).toBe(min(60));
    partitions(t);
  });

  it("reopening a done issue: the resolved stretch is its own bucket and the span runs to the last resolution", () => {
    const x = store.createIssue({ title: "Reopened" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    at(20);
    store.updateIssue(x.id, { status: "todo" }, "vp");
    const open = timing(x.id, 25);
    expect(open.wall).toMatchObject({ endAt: null, through: iso(25), buckets: buckets({ work: min(10), resolved: min(10), queued: min(5) }) });
    at(30);
    store.checkoutIssue(x.id, "agent-a");
    at(40);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    const t = timing(x.id, 50);
    expect(t.workSeconds).toBe(min(20));
    expect(t.wall).toEqual({ startAt: iso(0), endAt: iso(40), through: null, seconds: min(40), buckets: buckets({ work: min(20), resolved: min(10), queued: min(10) }) });
    partitions(t);
  });

  it("a dependency edge added and removed mid-progress: category wins while active, edges decide blocked or queued after", () => {
    const x = store.createIssue({ title: "Dependent" });
    const y = store.createIssue({ title: "Dependency" });
    at(5);
    store.setBlockedBy(x.id, [y.id], "vp");
    at(15);
    store.setBlockedBy(x.id, [], "vp");
    at(20);
    store.checkoutIssue(x.id, "agent-a");
    at(25);
    store.setBlockedBy(x.id, [y.id], "vp");
    at(30);
    store.releaseIssue(x.id, "agent-a");
    at(40);
    store.updateIssue(y.id, { status: "done" }, "vp");
    at(50);
    store.checkoutIssue(x.id, "agent-a");
    at(60);
    store.updateIssue(x.id, { status: "done" }, "agent-a");
    const t = timing(x.id, 70);
    // The pre-work wait is lead time, not part of the span.
    expect(t.leadSeconds).toBe(min(20));
    expect(t.wall).toEqual({ startAt: iso(20), endAt: iso(60), through: null, seconds: min(40), buckets: buckets({ work: min(20), blocked: min(10), queued: min(10) }) });
    // Every edge that mattered is explained by a blockers_changed event.
    expect(t.quality.wall).toEqual({ state: "exact", inputs: [] });
    partitions(t);
  });

  it("an edge no event explains is taken from its created_at, and the partition says so", () => {
    const x = store.createIssue({ title: "Old dependent" });
    const y = store.createIssue({ title: "Old dependency" });
    store.checkoutIssue(x.id, "agent-a");
    at(10);
    store.releaseIssue(x.id, "agent-a");
    at(12);
    store.setBlockedBy(x.id, [y.id], "vp");
    // As an older build left it: the edge, and no event narrating it.
    store.db.prepare("DELETE FROM events WHERE issue_id = ? AND kind = 'blockers_changed'").run(x.id);
    const t = timing(x.id, 20);
    expect(t.wall!.buckets).toMatchObject({ queued: min(2), blocked: min(8) });
    expect(t.quality.wall).toEqual({ state: "approximate", inputs: ["edge_history_incomplete"] });
  });
});

describe("blockers_changed from every edge-writing path", () => {
  const events = (id: string): Array<Record<string, unknown>> =>
    (store.db.prepare("SELECT payload, created_at FROM events WHERE issue_id = ? AND kind = 'blockers_changed' ORDER BY seq").all(id) as Array<{ payload: string; created_at: string }>).map(
      (row) => ({ ...(JSON.parse(row.payload) as Record<string, unknown>), at: row.created_at }),
    );

  it("a create with blockers, and a child that blocks its parent until done, each say what the set became", () => {
    const blocker = store.createIssue({ title: "Blocker" });
    const parent = store.createIssue({ title: "Parent" });
    at(3);
    const blocked = store.createIssue({ title: "Blocked at birth", blockedBy: [blocker.id] });
    expect(events(blocked.id)).toEqual([{ identifier: blocked.identifier, blockedBy: [blocker.identifier], blockedByIds: [blocker.id], at: iso(3) }]);
    at(4);
    const child = store.createIssue({ title: "Child", parent: parent.id, blockParentUntilDone: true });
    expect(events(parent.id)).toEqual([{ identifier: parent.identifier, blockedBy: [child.identifier], blockedByIds: [child.id], at: iso(4) }]);
  });

  it("a blocker set replaced keeps the created_at of every edge it keeps", () => {
    const x = store.createIssue({ title: "Dependent" });
    const y = store.createIssue({ title: "Kept" });
    const z = store.createIssue({ title: "Dropped" });
    at(5);
    store.setBlockedBy(x.id, [y.id, z.id], "vp");
    at(10);
    store.setBlockedBy(x.id, [y.id], "vp");
    const edges = store.db.prepare("SELECT blocker_id, created_at FROM relations WHERE blocked_id = ?").all(x.id);
    expect(edges).toEqual([{ blocker_id: y.id, created_at: iso(5) }]);
    expect(events(x.id).map((event) => event.blockedByIds)).toEqual([[y.id, z.id], [y.id]]);
  });
});

describe("parents: work is the children's, with coverage", () => {
  it("sums the direct children that owe work, and says how many of them it could measure", () => {
    const epic = store.createIssue({ title: "Epic" });
    const done = store.createIssue({ title: "Done child", parent: epic.id });
    const cancelled = store.createIssue({ title: "Cancelled child", parent: epic.id });
    store.createIssue({ title: "Never started", parent: epic.id });
    const unmeasured = store.createIssue({ title: "Unmeasured", parent: epic.id });
    store.checkoutIssue(done.id, "agent-a");
    store.checkoutIssue(cancelled.id, "agent-b");
    store.checkoutIssue(unmeasured.id, "agent-c");
    at(10);
    store.updateIssue(done.id, { status: "done" }, "agent-a");
    store.updateIssue(cancelled.id, { status: "cancelled" }, "agent-b");
    // Work before capture: a start and no attempt.
    store.db.prepare("DELETE FROM attempts WHERE issue_id = ?").run(unmeasured.id);
    const t = timing(epic.id, 20);
    expect(t.workSeconds).toBe(min(10));
    expect(t.quality.work).toEqual({
      state: "approximate",
      inputs: ["partial"],
      coverage: { known: 1, total: 2, partial: true },
      missingInputs: [unmeasured.identifier],
    });
    // A parent's elapsed buckets are its own derived category, undivided by attempts.
    expect(Object.keys(t.wall!.buckets).sort()).toEqual(["active", "blocked", "gated", "queued", "resolved", "review"]);
    expect(t.wall!.buckets.active).toBe(min(20));
  });

  it("is input_missing when no child could be measured, and never_started when none owes work", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createIssue({ title: "Child", parent: epic.id });
    expect(timing(epic.id, 1)).toMatchObject({ workSeconds: null, missing: { workSeconds: "never_started" } });
    store.checkoutIssue(child.id, "agent-a");
    store.db.prepare("DELETE FROM attempts WHERE issue_id = ?").run(child.id);
    expect(timing(epic.id, 1)).toMatchObject({ workSeconds: null, missing: { workSeconds: "input_missing" }, quality: { work: { missingInputs: [child.identifier] } } });
  });
});

// ------------------------------------------------------------ the orchestrator lane

describe("the orchestrator lane", () => {
  it("opens only by attempt open, holds no claim, and its time is orchestration, never work", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createIssue({ title: "Child", parent: epic.id });
    // A second child keeps the epic open when the first is done.
    store.createIssue({ title: "Still open", parent: epic.id });
    const opened = store.openOrchestratorAttempt(epic.id, "orch", "orchestrator");
    expect(opened).toMatchObject({ role: "orchestrator", openedBy: "orchestrate", claim: { scope: "none", fencingToken: null }, state: "running" });
    expect(store.getIssue(epic.id)).toMatchObject({ status: "backlog", checkoutAgent: null });
    store.checkoutIssue(child.id, "agent-a");
    at(10);
    store.addComment(child.id, "dispatch note", "orch");
    at(15);
    store.addComment(child.id, "working", "agent-a");
    at(20);
    store.updateIssue(child.id, { status: "done" }, "agent-a");
    at(30);
    store.endOrchestratorAttempt(epic.id, "orch", "orchestrator");
    expect(viewsOfIssue(store.db, epic.id)[0]).toMatchObject({ state: "ended", outcome: "yielded", endReason: "coordination_ended", endDetection: "reported" });

    const t = timing(epic.id, 40);
    expect(t.orchestrationSeconds).toBe(min(30));
    expect(t.workSeconds).toBe(min(20));
    expect(timing(child.id, 40)).toMatchObject({ workSeconds: min(20), orchestrationSeconds: null, missing: { orchestrationSeconds: "no_orchestrator_attempt" } });
    expect(store.orchestrationSummary(epic.id)).toMatchObject({ current: null, count: 1 });
    expect(store.attemptSummary(epic.id).count).toBe(0);
  });

  it("is refused for any other role, and nothing else sets one: not checkout, not STAPLE_ROLE", () => {
    const x = store.createIssue({ title: "Leaf" });
    expect(refusal(() => store.openOrchestratorAttempt(x.id, "orch", undefined)).code).toBe("validation");
    expect(refusal(() => store.openOrchestratorAttempt(x.id, "orch", "worker")).code).toBe("validation");
    expect(refusal(() => attemptOptionsFrom({ role: "orchestrator" })).code).toBe("validation");
    expect(refusal(() => attemptOptionsFromInput({ role: "orchestrator" })).code).toBe("validation");
    process.env.STAPLE_ROLE = "orchestrator";
    store.checkoutIssue(x.id, "orch");
    expect(attemptsOfIssue(store.db, x.id)[0]).toMatchObject({ role: "worker", openedBy: "checkout" });
  });

  it("never touches the worker lane: no superseded_by_merge, and a release ends the worker's attempt alone", () => {
    const x = store.createIssue({ title: "Coordinated leaf" });
    store.checkoutIssue(x.id, "agent-a");
    at(5);
    store.openOrchestratorAttempt(x.id, "reviewer", "orchestrator");
    const read = () => Object.fromEntries(viewsOfIssue(store.db, x.id).map((view) => [view.role, [view.state, view.endReason]]));
    expect(read()).toEqual({ worker: ["running", null], orchestrator: ["running", null] });
    at(10);
    store.releaseIssue(x.id, "agent-a");
    expect(read()).toEqual({ worker: ["ended", "released"], orchestrator: ["running", null] });
    // The resume rule reads the worker lane: an orchestrator attempt that ended orphaned is not resumed by a checkout.
    at(15);
    store.openOrchestratorAttempt(store.createIssue({ title: "Elsewhere" }).id, "reviewer", "orchestrator");
    expect(viewsOfIssue(store.db, x.id).find((view) => view.role === "orchestrator")).toMatchObject({ outcome: "orphaned", endReason: "superseded_by_newer" });
    at(20);
    store.checkoutIssue(x.id, "agent-b");
    expect(attemptsOfIssue(store.db, x.id).at(-1)).toMatchObject({ agent: "agent-b", role: "worker", resumesAttemptId: null });
  });

  it("an actor holding one attempt in each lane must say which one an event is for", () => {
    const x = store.createIssue({ title: "Both lanes" });
    store.checkoutIssue(x.id, "dual");
    const orchestrator = store.openOrchestratorAttempt(x.id, "dual", "orchestrator");
    expect(refusal(() => store.recordAttemptEvent(x.id, "pause", "dual", { reason: "operator" })).code).toBe("validation");
    expect(store.recordAttemptEvent(x.id, "pause", "dual", { reason: "operator", role: "worker" })).toMatchObject({ role: "worker", state: "paused" });
    expect(store.recordAttemptEvent(x.id, "milestone", "dual", { label: "dispatched", attemptId: orchestrator.id })).toMatchObject({ role: "orchestrator" });
    // The concurrency context counts both lanes, and reports the split.
    const latest = transitionsOf(store.db, orchestrator.id).at(-1)!;
    expect(latest.concurrency).toMatchObject({ openAttemptsInWorkspace: 2, openAttemptsInWorkspaceByRole: { worker: 1, orchestrator: 1 } });
  });

  it("a newer orchestrator attempt by the same agent supersedes the older one in any state, bounded at its start", () => {
    const one = store.createIssue({ title: "First" });
    const two = store.createIssue({ title: "Second" });
    store.openOrchestratorAttempt(one.id, "orch", "orchestrator");
    at(10);
    store.addComment(one.id, "coordinating", "orch");
    at(20);
    const newer = store.openOrchestratorAttempt(two.id, "orch", "orchestrator");
    // Derived: read at once, before any command writes it down.
    const [older] = viewsOfIssue(store.db, one.id, iso(30));
    expect(older).toMatchObject({ state: "ended", outcome: "orphaned", endReason: "superseded_by_newer" });
    expect(timing(one.id, 30).orchestrationSeconds).toBe(min(10));
    at(25);
    // The opening device writes the stored end on its next mutating command, and the number holds,
    // though this comment by the same agent comes later.
    store.addComment(one.id, "after it was superseded", "orch");
    expect(attemptsOfIssue(store.db, one.id)[0]).toMatchObject({ state: "ended", endReason: "superseded_by_newer", endDetection: "inferred", endedAt: iso(10) });
    expect(timing(one.id, 30).orchestrationSeconds).toBe(min(10));
    // Ended by the newer one although the newer one has ended too: no revival.
    store.endOrchestratorAttempt(two.id, "orch", "orchestrator");
    expect(viewsOfIssue(store.db, one.id, iso(30))[0]).toMatchObject({ state: "ended", endReason: "superseded_by_newer" });
    expect(timing(one.id, 30).orchestrationSeconds).toBe(min(10));
    expect(newer.id).not.toBe(older!.id);
  });

  it("the first clause that holds names the reason, and the earliest bound limits the evidence; descendants are evidence", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createIssue({ title: "Child", parent: epic.id });
    const other = store.createIssue({ title: "Elsewhere" });
    store.openOrchestratorAttempt(epic.id, "orch", "orchestrator");
    store.checkoutIssue(child.id, "agent-a");
    // Nothing writes the stored end until both clauses hold, so the read-time rule decides.
    holdOrphanEnds();
    at(10);
    store.addComment(child.id, "on the child", "orch");
    at(15);
    // The child's close derives the epic's: resolved at 15.
    store.updateIssue(child.id, { status: "done" }, "agent-a");
    expect(store.getIssue(epic.id).status).toBe("done");
    at(17);
    store.addComment(child.id, "after the epic resolved", "orch");
    at(20);
    store.openOrchestratorAttempt(other.id, "orch", "orchestrator");
    const [view] = viewsOfIssue(store.db, epic.id, iso(30));
    // Resolved (clause 2) and superseded (clause 3) both hold: the first names it, the earliest bound (15) limits it.
    expect(view).toMatchObject({ role: "orchestrator", state: "ended", outcome: "orphaned", endReason: "issue_resolved" });
    expect(timing(epic.id, 30).orchestrationSeconds).toBe(min(10));
    releaseOrphanEnds();
    at(25);
    store.addComment(other.id, "a mutating command", "vp");
    expect(attemptsOfIssue(store.db, epic.id)[0]).toMatchObject({ state: "ended", endReason: "issue_resolved", endedAt: iso(10) });
    expect(timing(epic.id, 30).orchestrationSeconds).toBe(min(10));
  });

  it("reconstruction builds worker attempts only, and an orchestrator attempt does not mark where capture began", () => {
    const x = store.createIssue({ title: "History" });
    store.openOrchestratorAttempt(x.id, "orch", "orchestrator");
    // As an older build left it, after the orchestrator attempt opened: a checkout and a release.
    const event = store.db.prepare("INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at) VALUES (?, ?, ?, '{}', ?, ?)");
    event.run("checkout", x.id, "agent-old", "old-1", iso(10));
    event.run("release", x.id, "agent-old", "old-2", iso(20));
    expect(store.reconstructAttemptHistory().reconstructed).toBe(1);
    expect(attemptsOfIssue(store.db, x.id).map((attempt) => [attempt.role, attempt.provenance])).toEqual([
      ["orchestrator", "recorded"],
      ["worker", "reconstructed"],
    ]);
  });
});
