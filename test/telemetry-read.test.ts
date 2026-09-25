/**
 * The telemetry read surfaces, in process (docs/execution-telemetry.md, "Surfaces",
 * "Bounded reads, coverage and truncation", "Missingness").
 *
 * Every attempt here is made by a real store mutation (checkout, release, status, an
 * attempt report), and every budget row by real ingestion (`ingestBudget` with a
 * real-shaped status line or a manual reading), with its instant chosen through the
 * ingestion's own clock. Where the effective state depends on replicated data, two real
 * devices synchronize through the test service. Nothing writes an attempt or a sample row.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceStore } from "../src/core/store.js";
import { attemptLinkerFor } from "../src/core/telemetry/attempt-link.js";
import { attemptsOfIssue } from "../src/core/telemetry/attempt-records.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { ingestBudget } from "../src/core/telemetry/ingest.js";
import { attemptDetail, inWorkerLane } from "../src/core/telemetry/read-attempts.js";
import { listBudgetSamples, readBudget } from "../src/core/telemetry/read-budget.js";
import { initWorkspace } from "../src/core/workspace.js";
import { STATUSLINE_SESSION_ID, epoch, statusline } from "./fixtures/budget-support.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

let home: string;
let root: string;
let claudeDir: string;
const opened: WorkspaceStore[] = [];
const previous = { home: process.env.STAPLE_HOME, claude: process.env.CLAUDE_CONFIG_DIR };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-read-home-"));
  root = mkdtempSync(join(tmpdir(), "staple-read-root-"));
  claudeDir = join(home, "claude");
  mkdirSync(claudeDir);
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
});
afterEach(() => {
  for (const store of opened.splice(0)) {
    try {
      store.db.close();
    } catch {
      // closed by the test
    }
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [["STAPLE_HOME", previous.home], ["CLAUDE_CONFIG_DIR", previous.claude]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function workspace(slug = "alpha"): WorkspaceStore {
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  const { store } = initWorkspace({ dir, slug });
  opened.push(store);
  return store;
}

/** Budget capture on, and this machine's Claude Code home bound to `personal-max`. */
function captureOn(): void {
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir });
}

const at = (base: string, seconds: number): string => new Date(Date.parse(base) + seconds * 1000).toISOString();

/** One status-line render, ingested as if Claude Code sent it at `instant`. */
function render(instant: string, used: number, resetsAt: string, session: string = STATUSLINE_SESSION_ID) {
  return ingestBudget(
    { source: "claude-statusline", input: statusline({ session_id: session, rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(resetsAt) } } }), configDir: claudeDir },
    { home, attemptLinker: attemptLinkerFor(home), now: () => instant },
  );
}

/** A reading the operator typed off /usage at `instant`. */
function manual(instant: string, used: number, resetsAt?: string, account = "personal-max") {
  return ingestBudget(
    { source: "manual", account, provider: "anthropic", limitKey: "five_hour", used, ...(resetsAt ? { resetsAt } : {}) },
    { home, operator: true, now: () => instant },
  );
}

const fromSession = { harness: "claude_code", harnessSession: STATUSLINE_SESSION_ID } as const;

/** `n` tenures on one issue: each a checkout and a release. */
function tenures(store: WorkspaceStore, ref: string, n: number, agent = "agent-a"): void {
  for (let i = 0; i < n; i += 1) {
    store.checkoutIssue(ref, agent);
    store.releaseIssue(ref, agent);
  }
}

const outboxCount = (db: DatabaseSync): number => (db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;

// ---------------------------------------------------------------------- attempts

describe("list_attempts is bounded", () => {
  it("defaults to 50, states truncation, and a cursor walks the rest in order", () => {
    const store = workspace();
    const issue = store.createIssue({ title: "Many tenures" });
    tenures(store, issue.id, 52);
    const first = store.listAttempts(issue.identifier);
    expect(first.items).toHaveLength(50);
    expect(first.truncated).toBe(true);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.coverage.itemCount).toBe(50);
    const second = store.listAttempts(issue.identifier, { cursor: first.nextCursor! });
    expect(second).toMatchObject({ truncated: false, nextCursor: null });
    expect([...first.items, ...second.items].map((view) => view.ordinal)).toEqual(Array.from({ length: 52 }, (_, i) => i + 1));
  }, 60_000);

  it("never infers truncation from a full page", () => {
    const store = workspace();
    const issue = store.createIssue({ title: "Exactly full" });
    tenures(store, issue.id, 3);
    const page = store.listAttempts(issue.id, { limit: 3 });
    expect(page).toMatchObject({ truncated: false, nextCursor: null });
    expect(page.items).toHaveLength(3);
  });

  it("keeps a cursor stable when attempts are added between pages", () => {
    const store = workspace();
    const issue = store.createIssue({ title: "Growing" });
    tenures(store, issue.id, 5);
    const first = store.listAttempts(issue.id, { limit: 2 });
    tenures(store, issue.id, 3);
    const seen = [...first.items.map((view) => view.id)];
    let cursor = first.nextCursor;
    while (cursor !== null) {
      const page = store.listAttempts(issue.id, { limit: 2, cursor });
      seen.push(...page.items.map((view) => view.id));
      cursor = page.nextCursor;
    }
    expect(seen).toEqual(attemptsOfIssue(store.db, issue.id).map((attempt) => attempt.id));
    expect(new Set(seen).size).toBe(8);
  });

  it("refuses a bad limit, a foreign cursor and a cursor issued for another issue", () => {
    const store = workspace();
    const one = store.createIssue({ title: "One" });
    const two = store.createIssue({ title: "Two" });
    tenures(store, one.id, 3);
    tenures(store, two.id, 3);
    const cursor = store.listAttempts(one.id, { limit: 1 }).nextCursor!;
    expect(() => store.listAttempts(two.id, { cursor })).toThrow(/different arguments/);
    expect(() => store.listAttempts(one.id, { cursor: "not-a-cursor" })).toThrow(/not a cursor/);
    expect(() => store.listAttempts(one.id, { limit: 0 })).toThrow(/positive integer/);
    expect(store.listAttempts(one.id, { limit: 10_000 }).items).toHaveLength(3);
  });
});

describe("the attempts summary on show/get_task", () => {
  it("names the current attempt, the last ended one and the count; a live claim can hold no open attempt", () => {
    const store = workspace();
    const issue = store.createIssue({ title: "Summary" });
    expect(store.attemptSummary(issue.id)).toEqual({ current: null, last: null, count: 0 });
    store.checkoutIssue(issue.id, "agent-a");
    const running = store.attemptSummary(issue.id);
    expect(running).toMatchObject({ current: { state: "running", ordinal: 1 }, last: null, count: 1 });
    store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "provider_limit" });
    // The claim is still held; no attempt is open.
    expect(store.getIssue(issue.id).checkoutAgent).toBe("agent-a");
    expect(store.attemptSummary(issue.id)).toMatchObject({ current: null, last: { outcome: "interrupted", endReason: "provider_limit" }, count: 1 });
    store.checkoutIssue(issue.id, "agent-a");
    const resumed = store.attemptSummary(issue.id);
    expect(resumed).toMatchObject({ current: { ordinal: 2, openedBy: "reclaim" }, last: { ordinal: 1 }, count: 2 });
    expect(resumed.current!.resumesAttemptId).toBe(resumed.last!.id);
  });

  it("describes the worker lane through one predicate", () => {
    expect(inWorkerLane({ id: "a" })).toBe(true);
    expect(inWorkerLane({ id: "a", role: "worker" })).toBe(true);
    expect(inWorkerLane({ id: "a", role: null })).toBe(true);
    expect(inWorkerLane({ id: "a", role: "orchestrator" })).toBe(false);
  });
});

describe("effective state beside the stored one", () => {
  it("an attempt left open by a status recategorized out of active reads orphaned, and no read writes its end", () => {
    const store = workspace();
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = store.createIssue({ title: "Recategorized" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    // The vocabulary moves every issue carrying it, with no event and no claim change.
    store.db.prepare("UPDATE workspace_statuses SET category = 'review' WHERE id = 'doing'").run();
    const outbox = outboxCount(store.db);

    const [item] = store.listAttempts(issue.id).items;
    expect(item).toMatchObject({
      state: "ended",
      storedState: "running",
      outcome: "orphaned",
      endReason: "left_active",
      endDetection: "derived",
      endedAt: null,
      missing: { endedAt: "end_not_observed" },
    });
    expect(item!.endedAtBound).toBe(item!.lastActivityAt);
    expect(store.attemptSummary(issue.id)).toMatchObject({ current: null, last: { outcome: "orphaned" } });
    expect(store.getAttempt(item!.id).attempt).toMatchObject({ state: "ended", storedState: "running" });
    // Reads wrote nothing: the row is still stored open and nothing was journaled.
    expect(attemptsOfIssue(store.db, issue.id)[0]!.state).toBe("running");
    expect(outboxCount(store.db)).toBe(outbox);
  });
});

describe("coverage of an attempt list", () => {
  it("names the span before capture began, and a reconstructed attempt carries it too", () => {
    const store = workspace();
    const old = store.createIssue({ title: "Worked before capture" });
    store.checkoutIssue(old.id, "agent-old");
    // An older build's claim: its events and started_at stay, the attempt rows it never
    // wrote are taken away again, and it all happened an hour earlier.
    const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
    store.db.prepare("DELETE FROM attempt_transitions WHERE attempt_id IN (SELECT id FROM attempts WHERE issue_id = ?)").run(old.id);
    store.db.prepare("DELETE FROM attempts WHERE issue_id = ?").run(old.id);
    store.db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(hourAgo, old.id);
    store.db.prepare("UPDATE issues SET checkout_at = ?, started_at = ? WHERE id = ?").run(hourAgo, hourAgo, old.id);
    // Capture begins: another issue's checkout records the first attempt.
    const later = store.createIssue({ title: "After capture" });
    store.checkoutIssue(later.id, "agent-new");
    const began = attemptsOfIssue(store.db, later.id)[0]!.startedAt;

    const before = store.listAttempts(old.id);
    expect(before.items).toEqual([]);
    expect(before.coverage).toEqual({ from: hourAgo, to: began, itemCount: 0, gaps: [{ from: hourAgo, to: began, reason: "before_capture_began" }] });
    // Nothing before capture on an issue started after it.
    expect(store.listAttempts(later.id).coverage.gaps).toEqual([]);

    store.reconstructAttemptHistory();
    const rebuilt = store.listAttempts(old.id);
    expect(rebuilt.items).toHaveLength(1);
    expect(rebuilt.coverage.gaps).toEqual([{ from: hourAgo, to: began, reason: "before_capture_began" }]);
    const detail = store.getAttempt(rebuilt.items[0]!.id);
    expect(detail.transitions.items).toEqual([]);
    expect(detail.transitions.coverage.gaps).toEqual([expect.objectContaining({ reason: "before_capture_began" })]);
  });
});

describe("get_attempt", () => {
  it("returns the attempt, bounded transitions with a stable cursor, and the chain oldest first", () => {
    const store = workspace();
    const issue = store.createIssue({ title: "Chained" });
    store.checkoutIssue(issue.id, "agent-a");
    for (let i = 0; i < 4; i += 1) store.recordAttemptEvent(issue.id, "milestone", "agent-a", { label: `step ${i}` });
    const first = attemptsOfIssue(store.db, issue.id)[0]!.id;
    const page = store.getAttempt(first, { limit: 2 });
    expect(page.transitions.items.map((t) => t.kind)).toEqual(["attempt_started", "attempt_milestone"]);
    expect(page.transitions.truncated).toBe(true);
    // A transition added between pages lands after the cursor, and nothing repeats.
    store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "harness_exit" });
    const rest = store.getAttempt(first, { limit: 10, cursor: page.transitions.nextCursor! });
    expect(rest.transitions.items.map((t) => t.kind)).toEqual(["attempt_milestone", "attempt_milestone", "attempt_milestone", "attempt_interrupted"]);
    expect(rest.transitions.truncated).toBe(false);

    store.checkoutIssue(issue.id, "agent-a");
    const second = attemptsOfIssue(store.db, issue.id)[1]!.id;
    const detail = store.getAttempt(second);
    expect(detail.chain.map((entry) => [entry.id, entry.outcome])).toEqual([
      [first, "interrupted"],
      [second, null],
    ]);
    expect(() => store.getAttempt("00000000-0000-4000-8000-000000000000")).toThrow(/No attempt/);
  });
});

// ------------------------------------------------------------------------ burn

describe("an attempt's burn", () => {
  it("brackets the attempt by high-water in each window instance and sums across a reset", () => {
    captureOn();
    const store = workspace();
    const issue = store.createIssue({ title: "Burning" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: fromSession });
    const attempt = attemptsOfIssue(store.db, issue.id)[0]!;
    const start = attempt.startedAt;
    const firstReset = at(start, 120);
    const secondReset = at(start, 5 * 3600);
    render(at(start, -60), 50, firstReset); // before the attempt: the baseline
    render(at(start, 30), 58, firstReset);
    render(at(start, 45), 55, firstReset, "session-a"); // an older cache: a regression
    render(at(start, 60), 60, firstReset);
    render(at(start, 90), 54, firstReset, "session-a"); // the last reading in the window, and below its high-water
    render(at(start, 180), 5, secondReset); // the next window: no reading before the attempt
    render(at(start, 240), 8, secondReset);
    render(at(start, 900), 30, secondReset); // after `now`: not counted

    const detail = attemptDetail(store.db, attempt.id, { home, device: null, slug: "alpha", now: at(start, 300) });
    expect(detail.burn).toMatchObject({ provider: "anthropic", accountRef: "personal-max", attribution: "sole_known", missing: {} });
    const [limit] = detail.burn.limits;
    expect(limit).toMatchObject({ limitKey: "five_hour", burnPercent: 13, coverage: { known: 2, total: 2 }, partial: false, regressionCount: 2 });
    expect(limit!.windows.map((w) => [w.fromPercent, w.toPercent, w.deltaPercent, w.lowerBound])).toEqual([
      [50, 60, 10, false],
      [5, 8, 3, true],
    ]);
    // The readings from the attempt's own session while it ran were linked to it at
    // ingestion (the attempt is still open, so the one after `now` too); the one before it
    // started and the other session's were not.
    expect(detail.burn.linkedSampleCount).toBe(5);
  });

  it("is shared when another attempt this machine started ran on the account meanwhile", () => {
    captureOn();
    const one = workspace("alpha");
    const two = workspace("bravo");
    const mine = one.createIssue({ title: "Mine" });
    one.checkoutIssue(mine.id, "agent-a", undefined, { attempt: fromSession });
    const theirs = two.createIssue({ title: "Theirs" });
    two.checkoutIssue(theirs.id, "agent-b", undefined, { attempt: { harness: "claude_code", harnessSession: "session-b" } });
    const attempt = attemptsOfIssue(one.db, mine.id)[0]!;
    render(at(attempt.startedAt, -10), 10, at(attempt.startedAt, 3600));
    render(at(attempt.startedAt, 10), 12, at(attempt.startedAt, 3600));
    const detail = attemptDetail(one.db, attempt.id, { home, device: null, slug: "alpha", now: at(attempt.startedAt, 60) });
    expect(detail.burn.attribution).toBe("shared");
    expect(detail.burn.limits[0]!.burnPercent).toBe(2);
  });

  it("reads a measured zero as 0, and no reading as null with a reason, never 0", () => {
    captureOn();
    const store = workspace();
    const issue = store.createIssue({ title: "Idle burn" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: fromSession });
    const attempt = attemptsOfIssue(store.db, issue.id)[0]!;
    const reset = at(attempt.startedAt, 3600);
    // Nothing yet, with capture configured.
    const none = attemptDetail(store.db, attempt.id, { home, device: null, slug: "alpha", now: at(attempt.startedAt, 60) }).burn;
    expect(none).toMatchObject({ limits: [], attribution: null, missing: { limits: "no_sample_yet" } });
    // A reading before and a heartbeat after, unchanged: a measured zero.
    render(at(attempt.startedAt, -10), 40, reset);
    render(at(attempt.startedAt, 400), 40, reset);
    const zero = attemptDetail(store.db, attempt.id, { home, device: null, slug: "alpha", now: at(attempt.startedAt, 500) }).burn;
    expect(zero.limits[0]).toMatchObject({ burnPercent: 0, coverage: { known: 1, total: 1 } });
  });

  it("names why it cannot be joined: no account, capture off, or no reading during the attempt", () => {
    const store = workspace();
    const plain = store.createIssue({ title: "No harness reported" });
    store.checkoutIssue(plain.id, "agent-a");
    const unbound = store.getAttempt(attemptsOfIssue(store.db, plain.id)[0]!.id).burn;
    expect(unbound).toMatchObject({ limits: [], attribution: null, linkedSampleCount: null, missing: { limits: "no_provider_binding" } });

    const flagged = store.createIssue({ title: "Account passed, capture off" });
    store.checkoutIssue(flagged.id, "agent-a", undefined, { attempt: { account: "team-max" } });
    expect(store.getAttempt(attemptsOfIssue(store.db, flagged.id)[0]!.id).burn).toMatchObject({ linkedSampleCount: 0, missing: { limits: "source_unavailable", attribution: "source_unavailable" } });

    captureOn();
    const issue = store.createIssue({ title: "Before any reading" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: fromSession });
    const attempt = attemptsOfIssue(store.db, issue.id)[0]!;
    // Readings of the account exist, but only in a window that ended before the attempt.
    render(at(attempt.startedAt, -7200), 10, at(attempt.startedAt, -3600));
    const stale = attemptDetail(store.db, attempt.id, { home, device: null, slug: "alpha", now: at(attempt.startedAt, 60) }).burn;
    expect(stale.limits[0]).toMatchObject({ burnPercent: null, missing: { burnPercent: "stale" } });
    expect(stale.attribution).toBeNull();
  });
});

// ---------------------------------------------------------------------- budget

describe("get_budget", () => {
  it("reads each current window by high-water, and unknown as null with its reason", () => {
    const now = new Date().toISOString();
    expect(readBudget(home, { now })).toEqual({ asOf: now, budgetCapture: false, accounts: [] });
    // An account named with no ingestion path at all.
    expect(readBudget(home, { account: "nobody", now }).accounts).toEqual([
      { provider: null, accountRef: "nobody", bound: false, limits: [], missing: { limits: "source_unavailable" } },
    ]);
    captureOn();
    expect(readBudget(home, { now }).accounts).toEqual([
      { provider: "anthropic", accountRef: "personal-max", bound: true, limits: [], missing: { limits: "no_sample_yet" } },
    ]);

    const reset = at(now, 3600);
    render(at(now, -120), 30, reset);
    render(at(now, -60), 25, reset, "session-a"); // an older cache
    const [limit] = readBudget(home, { now }).accounts[0]!.limits;
    expect(limit).toMatchObject({
      limitKey: "five_hour",
      status: "current",
      highWaterPercent: 30,
      remainingPercent: 70,
      regressionCount: 1,
      sampleCount: 2,
      stale: false,
      missing: {},
      latestSample: { usedPercent: 25, regression: true },
    });

    // After the reset nothing carries forward: unknown, not the old value and not 0.
    const later = at(reset, 60);
    const [elapsed] = readBudget(home, { now: later }).accounts[0]!.limits;
    expect(elapsed).toMatchObject({ status: "elapsed", latestSample: null, highWaterPercent: null, remainingPercent: null, stale: null });
    expect(elapsed!.missing).toMatchObject({ remainingPercent: "window_elapsed", highWaterPercent: "window_elapsed" });
    // Read long after the last reading was recorded, a current window reads stale.
    expect(readBudget(home, { now: at(now, 1800) }).accounts[0]!.limits[0]!.stale).toBe(true);
  });

  it("never feeds a current reading from a sample that reported no reset", () => {
    const now = new Date().toISOString();
    manual(now, 44);
    const [limit] = readBudget(home, { now, account: "personal-max" }).accounts[0]!.limits;
    expect(limit).toMatchObject({ status: null, window: null, remainingPercent: null, missing: { window: "reset_not_reported", remainingPercent: "reset_not_reported" } });
  });
});

describe("list_budget_samples", () => {
  it("reports capture gaps: nothing before the first reading, silence between, and silence up to now", () => {
    const base = "2026-09-24T09:00:00.000Z";
    const reset = at(base, 5 * 3600);
    manual(at(base, 1800), 10, reset);
    manual(at(base, 2100), 11, reset);
    manual(at(base, 6000), 12, reset);
    const now = at(base, 7200);
    const page = listBudgetSamples(home, { account: "personal-max", since: base, now });
    expect(page.items.map((s) => s.usedPercent)).toEqual([10, 11, 12]);
    expect(page.coverage).toEqual({
      from: base,
      to: now,
      itemCount: 3,
      gaps: [
        { from: base, to: at(base, 1800), reason: "no_sample_yet" },
        { from: at(base, 2100), to: at(base, 6000), reason: "stale" },
        { from: at(base, 6000), to: now, reason: "stale" },
      ],
    });
    // A later page begins where the cursor stopped; an earlier reading makes a leading gap stale.
    const tail = listBudgetSamples(home, { account: "personal-max", since: at(base, 2000), now, limit: 1 });
    expect(tail.coverage.gaps).toEqual([]);
    expect(tail.coverage.to).toBe(at(base, 2100));
    const rest = listBudgetSamples(home, { account: "personal-max", since: at(base, 2000), now, cursor: tail.nextCursor! });
    expect(rest.coverage).toMatchObject({ from: at(base, 2100), gaps: [{ reason: "stale" }, { reason: "stale" }] });
  });

  it("keeps a cursor stable when readings arrive between pages, earlier and later ones alike", () => {
    const base = "2026-09-24T09:00:00.000Z";
    const reset = at(base, 5 * 3600);
    for (let i = 0; i < 6; i += 1) manual(at(base, i * 60), 10 + i, reset);
    const first = listBudgetSamples(home, { account: "personal-max", limit: 3, now: at(base, 600) });
    expect(first.items.map((s) => s.usedPercent)).toEqual([10, 11, 12]);
    manual(at(base, 30), 99, reset); // a backfill before the cursor: not part of this walk
    manual(at(base, 900), 20, reset); // a new reading after it
    const rest = listBudgetSamples(home, { account: "personal-max", limit: 10, cursor: first.nextCursor!, now: at(base, 1000) });
    expect(rest.items.map((s) => s.usedPercent)).toEqual([13, 14, 15, 20]);
    expect(rest.truncated).toBe(false);
    expect(() => listBudgetSamples(home, { account: "other-acct", cursor: first.nextCursor! })).toThrow(/different arguments/);
  });

  it("clamps a page to 500 and says so", () => {
    const base = "2026-09-24T09:00:00.000Z";
    for (let i = 0; i < 501; i += 1) manual(at(base, i), i % 2 === 0 ? 10 : 11, at(base, 5 * 3600));
    const page = listBudgetSamples(home, { account: "personal-max", limit: 1000, now: at(base, 600) });
    expect(page.items).toHaveLength(500);
    expect(page.truncated).toBe(true);
    expect(listBudgetSamples(home, { account: "personal-max", now: at(base, 600) }).items).toHaveLength(50);
  }, 120_000);

  it("needs an account", () => {
    expect(() => listBudgetSamples(home, { account: "" })).toThrow(/needs --account/);
  });
});

// ------------------------------------------------------------ across devices

describe("across two devices", () => {
  const REPO = "5eed0000-0000-4000-8000-0000000a7e21";
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });

  it("two offline checkouts read as one contested open attempt, and the other device's burn is not on this device", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Contested" });
    await a.sync();
    await b.sync();
    a.use();
    a.store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { account: "personal-max" } });
    b.use();
    b.store.checkoutIssue(issue.id, "agent-b", undefined, { attempt: { account: "personal-max" } });
    await a.sync();
    await b.sync();
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();

    const [older, newer] = attemptsOfIssue(a.db, issue.id);
    for (const machine of [a, b, fresh]) {
      machine.use();
      const page = machine.store.listAttempts(issue.id);
      expect(page.items.map((view) => [view.id, view.state, view.storedState, view.outcome, view.endReason, view.contested]), machine.label).toEqual([
        [older!.id, "ended", "running", "orphaned", "superseded_by_merge", true],
        [newer!.id, "running", "running", null, null, true],
      ]);
      expect(machine.store.attemptSummary(issue.id)).toMatchObject({ current: { id: newer!.id }, last: { id: older!.id }, count: 2 });
    }
    // Budget data does not replicate: an attempt opened elsewhere has no burn here.
    const aAttempt = attemptsOfIssue(a.db, issue.id).find((attempt) => attempt.agent === "agent-a")!;
    a.use();
    expect(a.store.getAttempt(aAttempt.id).burn.missing.limits).not.toBe("not_on_this_device");
    b.use();
    expect(b.store.getAttempt(aAttempt.id).burn).toMatchObject({ limits: [], missing: { limits: "not_on_this_device" } });
    fresh.use();
    expect(fresh.store.getAttempt(aAttempt.id).burn.missing.limits).toBe("not_on_this_device");
  }, 60_000);

  it("no budget row, and no read, ever becomes an operation", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.use();
    setBudgetCapture(a.home, true);
    bindBudgetSource(a.home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir });
    const issue = a.store.createIssue({ title: "Burning while connected" });
    a.store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: fromSession });
    const attempt = attemptsOfIssue(a.db, issue.id)[0]!;
    const reset = at(attempt.startedAt, 3600);
    const ingest = (instant: string, used: number) =>
      ingestBudget(
        { source: "claude-statusline", input: statusline({ rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(reset) } } }), configDir: claudeDir },
        { home: a.home, attemptLinker: attemptLinkerFor(a.home), now: () => instant },
      );
    ingest(at(attempt.startedAt, -5), 71);
    ingest(new Date().toISOString(), 72);
    await a.sync();
    const before = outboxCount(a.db);

    // Every read surface, on a connected device.
    const detail = a.store.getAttempt(attempt.id);
    expect(detail.burn.limits[0]!.burnPercent).toBe(1);
    a.store.listAttempts(issue.id);
    a.store.attemptSummary(issue.id);
    readBudget(a.home);
    const samples = listBudgetSamples(a.home, { account: "personal-max" });
    expect(outboxCount(a.db)).toBe(before);

    // And nothing in the log the device sent names a sample, a window or a reading.
    a.store.recordAttemptEvent(issue.id, "milestone", "agent-a", { label: "after reading" });
    await a.sync();
    const sent = a.db.prepare("SELECT entity, payload FROM sync_outbox").all() as Array<{ entity: string; payload: string }>;
    expect(sent.length).toBeGreaterThan(0);
    const log = JSON.stringify(sent);
    for (const sample of samples.items) {
      expect(log).not.toContain(sample.id);
      expect(log).not.toContain(sample.windowId!);
    }
    expect(log).not.toMatch(/usedPercent|remainingPercent|budget_samples|limit_windows/);
    expect(new Set(sent.map((row) => row.entity))).not.toContain("budgetSample");
  }, 60_000);
});
