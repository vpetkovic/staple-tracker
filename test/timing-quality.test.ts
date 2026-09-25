/**
 * Quality states (`docs/timing-semantics.md`, "Quality states" and "Cohort coverage"): one state
 * per record that carries a timing or budget figure, with the reasons that produced it, and the
 * cohort read that counts them over the eligible population.
 *
 * Every history is built by real store calls at instants this suite controls (the write clock
 * is faked, `Date` only), and every budget reading by real ingestion. No attempt, event or
 * sample row is written by hand.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { attemptLinkerFor } from "../src/core/telemetry/attempt-link.js";
import { attemptsOfIssue } from "../src/core/telemetry/attempt-records.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { ingestBudget } from "../src/core/telemetry/ingest.js";
import {
  attemptBurnQuality,
  attemptQuality,
  limitBurnQuality,
  limitReadingQuality,
  sampleQuality,
  wallQuality,
  windowBurnQuality,
  workQuality,
} from "../src/core/telemetry/quality.js";
import { attemptDetail } from "../src/core/telemetry/read-attempts.js";
import { listBudgetSamples, readBudget } from "../src/core/telemetry/read-budget.js";
import { StapleError } from "../src/core/types.js";
import { STATUSLINE_SESSION_ID, epoch, statusline } from "./fixtures/budget-support.js";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
/** Move the write clock to `minutes` after T0. */
const at = (minutes: number): void => void vi.setSystemTime(T0 + minutes * 60_000);
const min = (n: number): number => n * 60;

let store: WorkspaceStore;
let home: string;
const previousHome = process.env.STAPLE_HOME;
const previousClaude = process.env.CLAUDE_CONFIG_DIR;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  home = mkdtempSync(join(tmpdir(), "staple-quality-home-"));
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
  if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousClaude;
});

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** A leaf worked by `agent` from `from` to `to` minutes, commenting every `every` minutes, then done. */
function worked(title: string, opts: { parent?: string; estimate?: number; from: number; to: number; every?: number; agent?: string; kind?: string }): string {
  at(opts.from);
  const issue = store.createIssue({
    title,
    ...(opts.parent ? { parent: opts.parent } : {}),
    ...(opts.estimate !== undefined ? { estimatedSeconds: opts.estimate } : {}),
    ...(opts.kind ? { kind: opts.kind } : {}),
  });
  const agent = opts.agent ?? "w";
  store.checkoutIssue(issue.id, agent);
  if (opts.every !== undefined) {
    for (let m = opts.from + opts.every; m < opts.to; m += opts.every) {
      at(m);
      store.addComment(issue.id, "progress", agent, "agent");
    }
  }
  at(opts.to);
  store.updateIssue(issue.id, { status: "done" }, agent);
  return issue.id;
}

/**
 * The cohort a parent makes: an exact, a timing-floor, a sparse (approximate) and a missing
 * (done without ever starting) leaf, plus an open one, a cancelled one and a nested parent
 * with one exact leaf of its own.
 */
function cohort(): { parent: string; ids: Record<string, string> } {
  const parent = store.createIssue({ title: "Cohort" }).id;
  const ids: Record<string, string> = {};
  ids.exact = worked("exact", { parent, estimate: min(60), from: 0, to: 40, every: 10 });
  ids.floor = worked("floor", { parent, estimate: min(30), from: 41, to: 41.5 });
  ids.sparse = worked("sparse", { parent, estimate: min(120), from: 42, to: 102 });
  at(103);
  ids.missing = store.createIssue({ title: "missing", parent, estimatedSeconds: min(10) }).id;
  store.updateIssue(ids.missing, { status: "done" }, "w");
  ids.open = store.createIssue({ title: "open", parent }).id;
  store.checkoutIssue(ids.open, "w2");
  ids.cancelled = store.createIssue({ title: "cancelled", parent }).id;
  store.updateIssue(ids.cancelled, { status: "cancelled" }, "w");
  ids.nested = store.createIssue({ title: "nested", parent }).id;
  ids.deep = worked("deep", { parent: ids.nested, estimate: min(20), from: 104, to: 114, every: 5 });
  at(120);
  return { parent, ids };
}

const identifier = (id: string): string => store.getIssue(id).identifier;

// ------------------------------------------------------------------ the precedence

describe("one state per record, from one precedence", () => {
  it("work: missing > reconstructed > approximate > timing-floor > exact, with every reason that holds", () => {
    expect(workQuality({ workSeconds: null, missingReason: "no_worker_attempt", reconstructed: false, inputs: ["partial"] })).toEqual({
      state: "missing",
      reasons: ["no_worker_attempt", "partial"],
    });
    expect(workQuality({ workSeconds: 30, missingReason: null, reconstructed: true, inputs: ["sparse"] })).toEqual({
      state: "reconstructed",
      reasons: ["reconstructed", "sparse", "timing_floor"],
    });
    expect(workQuality({ workSeconds: 30, missingReason: null, reconstructed: false, inputs: ["sparse"] })).toEqual({ state: "approximate", reasons: ["sparse", "timing_floor"] });
    expect(workQuality({ workSeconds: 59, missingReason: null, reconstructed: false, inputs: [] })).toEqual({ state: "timing-floor", reasons: ["timing_floor"] });
    expect(workQuality({ workSeconds: 60, missingReason: null, reconstructed: false, inputs: [] })).toEqual({ state: "exact", reasons: [] });
    expect(workQuality({ workSeconds: 0, missingReason: null, reconstructed: false, inputs: [] }).state).toBe("timing-floor");
  });

  it("wall: missing with its reason when there is none, approximate on any input", () => {
    expect(wallQuality({ present: false, missingReason: "replay_unavailable", inputs: [] })).toEqual({ state: "missing", reasons: ["replay_unavailable"] });
    expect(wallQuality({ present: true, missingReason: null, inputs: ["unattributed", "clock_skew"] })).toEqual({ state: "approximate", reasons: ["clock_skew", "unattributed"] });
    expect(wallQuality({ present: true, missingReason: null, inputs: [] })).toEqual({ state: "exact", reasons: [] });
  });

  it("an attempt is never missing: its figure always exists", () => {
    expect(attemptQuality({ seconds: 0, provenance: "recorded", inputs: [] })).toEqual({ state: "timing-floor", reasons: ["timing_floor"] });
    expect(attemptQuality({ seconds: 600, provenance: "reconstructed", inputs: [] })).toEqual({ state: "reconstructed", reasons: ["reconstructed"] });
    expect(attemptQuality({ seconds: 600, provenance: "recorded", inputs: ["contested"] })).toEqual({ state: "approximate", reasons: ["contested"] });
  });

  it("budget: a null figure is provider-unavailable when the provider does not expose it, missing when capture did not see it", () => {
    const sample = { usedPercent: 10, remainingPercent: 90, method: "observed", confidence: "high", windowId: "w", missing: {} };
    expect(sampleQuality(sample)).toEqual({ state: "exact", reasons: [] });
    expect(sampleQuality({ ...sample, method: "estimated", confidence: "low" })).toEqual({ state: "approximate", reasons: ["estimated", "low_confidence"] });
    expect(sampleQuality({ ...sample, windowId: null, missing: { windowId: "reset_not_reported" } })).toEqual({ state: "approximate", reasons: ["reset_not_reported"] });
    expect(sampleQuality({ ...sample, remainingPercent: null, missing: { remainingPercent: "limit_not_published" } })).toEqual({
      state: "provider-unavailable",
      reasons: ["limit_not_published"],
    });
    const reading = { remainingPercent: null, stale: null, latestSample: null };
    for (const reason of ["sliding_window", "reset_not_reported", "not_subscriber", "not_reported_by_source"]) {
      expect(limitReadingQuality({ ...reading, missing: { remainingPercent: reason } }).state).toBe("provider-unavailable");
    }
    for (const reason of ["window_elapsed", "no_sample_yet", "source_unavailable", "stale"]) {
      expect(limitReadingQuality({ ...reading, missing: { remainingPercent: reason } }).state).toBe("missing");
    }
    expect(limitReadingQuality({ remainingPercent: 40, stale: true, latestSample: sample, missing: {} })).toEqual({ state: "approximate", reasons: ["stale"] });
    expect(windowBurnQuality({ deltaPercent: 3, lowerBound: true, missing: {} })).toEqual({ state: "approximate", reasons: ["lower_bound"] });
    expect(windowBurnQuality({ deltaPercent: null, lowerBound: false, missing: { deltaPercent: "stale" } })).toEqual({ state: "missing", reasons: ["stale"] });
    expect(limitBurnQuality({ burnPercent: null, lowerBound: false, partial: false, missing: { burnPercent: "sliding_window" } }).state).toBe("provider-unavailable");
    expect(limitBurnQuality({ burnPercent: 5, lowerBound: false, partial: true, missing: {} })).toEqual({ state: "approximate", reasons: ["partial"] });
    const known = { burnPercent: 5, quality: { state: "exact" as const, reasons: [] } };
    expect(attemptBurnQuality({ limits: [known], attribution: "sole_known", missing: {} })).toEqual({ state: "exact", reasons: [] });
    expect(attemptBurnQuality({ limits: [known], attribution: "shared", missing: {} })).toEqual({ state: "approximate", reasons: ["shared"] });
    expect(attemptBurnQuality({ limits: [known], attribution: null, missing: { attribution: "source_unavailable" } })).toEqual({ state: "approximate", reasons: ["attribution_unknown"] });
    expect(attemptBurnQuality({ limits: [], attribution: null, missing: { limits: "not_on_this_device" } })).toEqual({ state: "missing", reasons: ["not_on_this_device"] });
    const sliding = { burnPercent: null, quality: { state: "provider-unavailable" as const, reasons: ["sliding_window"] } };
    expect(attemptBurnQuality({ limits: [sliding], attribution: null, missing: {} })).toEqual({ state: "provider-unavailable", reasons: ["sliding_window"] });
  });
});

// ------------------------------------------------------------------ records

describe("every timing record carries one state", () => {
  it("an issue's work and wall, and each of its attempts, agree", () => {
    const { ids } = cohort();
    const reads = Object.fromEntries(Object.entries(ids).map(([name, id]) => [name, store.timingFor([id], iso(120)).get(id)!]));
    expect(reads.exact!.quality.work).toMatchObject({ state: "exact", reasons: [] });
    expect(reads.floor!.quality.work).toMatchObject({ state: "timing-floor", reasons: ["timing_floor"] });
    expect(reads.sparse!.quality.work).toMatchObject({ state: "approximate", inputs: ["sparse"], reasons: ["sparse"] });
    expect(reads.missing!.quality.work).toMatchObject({ state: "missing", reasons: ["never_started"] });
    expect(reads.missing!.quality.wall).toEqual({ state: "missing", inputs: [], reasons: ["never_started"] });
    expect(reads.cancelled!.quality.work).toMatchObject({ state: null, reasons: [] });
    // Each attempt's effort figure is the issue's, when it is the only one, and so is its state.
    for (const name of ["exact", "floor", "sparse"]) {
      const [attempt] = store.listAttempts(ids[name]!).items;
      expect(attempt!.effortSeconds).toBe(reads[name]!.workSeconds);
      expect(attempt!.quality).toEqual({ state: reads[name]!.quality.work.state, reasons: reads[name]!.quality.work.reasons });
    }
    // The same attempt reads the same on the summary, the list and the detail.
    const summary = store.attemptSummary(ids.open!).current!;
    const listed = store.listAttempts(ids.open!).items[0]!;
    const detail = store.getAttempt(listed.id, {}, home).attempt;
    expect(summary.quality).toEqual(listed.quality);
    expect(detail.quality).toEqual(listed.quality);
    expect(detail.effortSeconds).toBe(listed.effortSeconds);
  });

  it("a write that returns an attempt returns it with its state", () => {
    const issue = store.createIssue({ title: "Paused" });
    store.checkoutIssue(issue.id, "w");
    // Thirty minutes of silence is not longer than thirty: exact.
    at(30);
    store.addComment(issue.id, "progress", "w", "agent");
    // Thirty-one is: the pause's own instant is evidence, and the gap before it is sparse.
    at(61);
    const paused = store.recordAttemptEvent(issue.id, "pause", "w", { reason: "operator" });
    expect(paused).toMatchObject({ effortSeconds: min(61), quality: { state: "approximate", reasons: ["sparse"] } });
    at(62);
    store.recordAttemptEvent(issue.id, "resume", "w");
    at(92);
    const milestone = store.recordAttemptEvent(issue.id, "milestone", "w", { label: "half" });
    expect(milestone).toMatchObject({ effortSeconds: min(91), quality: { state: "approximate", reasons: ["sparse"] } });
  });
});

// ------------------------------------------------------------------ the cohort

describe("cohort coverage", () => {
  it("counts every state over the eligible population, the done leaves, and never over open, cancelled or parents", () => {
    const { parent, ids } = cohort();
    const report = store.timingQuality({ parent }, iso(120));
    expect(report.population).toEqual({ issues: 8, eligible: 5, notEligible: { parents: 1, open: 1, cancelled: 1 } });
    expect(report.work.counts).toEqual({ exact: 2, "timing-floor": 1, approximate: 1, reconstructed: 0, missing: 1 });
    expect(report.work.coverage).toEqual({ exact: 2 / 5, "timing-floor": 1 / 5, approximate: 1 / 5, reconstructed: 0, missing: 1 / 5 });
    expect(report.work.reasons).toEqual({ never_started: 1, sparse: 1, timing_floor: 1 });
    expect(report.wall.counts).toEqual({ exact: 4, approximate: 0, missing: 1 });
    expect(report.items.map((item) => item.identifier)).toEqual(["exact", "floor", "sparse", "missing", "deep"].map((name) => identifier(ids[name]!)));
    // The ratio population is every eligible leaf with its own estimate; the exact aggregate is exact records only.
    expect(report.ratio.total).toBe(5);
    expect(report.ratio.exact).toMatchObject({ states: ["exact"], count: 2, workSeconds: min(50), estimatedSeconds: min(80), coverage: { known: 2, total: 5, partial: true } });
    expect(report.ratio.exact.ratio).toBeCloseTo(50 / 80);
    // Nothing excluded: the admitted aggregate takes every record with a figure, timing-floor and approximate included.
    expect(report.ratio.admitted).toMatchObject({ count: 4, workSeconds: min(50) + 30 + min(60), estimatedSeconds: min(80 + 30 + 120) });
    expect(report.excluded).toEqual({ count: 0, counts: {}, reasons: {} });
  });

  it("excludes approximate records explicitly, keeps timing-floor visible, and never moves the counts", () => {
    const { parent, ids } = cohort();
    const all = store.timingQuality({ parent }, iso(120));
    const report = store.timingQuality({ parent, exclude: ["approximate"] }, iso(120));
    expect(report.filter.exclude).toEqual(["approximate"]);
    expect(report.items.map((item) => item.identifier)).toEqual(["exact", "floor", "missing", "deep"].map((name) => identifier(ids[name]!)));
    expect(report.items.find((item) => item.work.state === "timing-floor")).toBeDefined();
    expect(report.work).toEqual(all.work);
    expect(report.wall).toEqual(all.wall);
    expect(report.population).toEqual(all.population);
    expect(report.excluded).toEqual({ count: 1, counts: { approximate: 1 }, reasons: {} });
    expect(report.ratio.exact).toEqual(all.ratio.exact);
    expect(report.ratio.admitted).toMatchObject({ states: ["exact", "timing-floor", "reconstructed", "missing"], count: 3, workSeconds: min(50) + 30 });
    // By reason, whatever the state: the same record, named by what makes it approximate.
    const byReason = store.timingQuality({ parent, excludeReasons: ["sparse"] }, iso(120));
    expect(byReason.items.map((item) => item.identifier)).toEqual(report.items.map((item) => item.identifier));
    expect(byReason.excluded).toEqual({ count: 1, counts: {}, reasons: { sparse: 1 } });
    // Timing-floor leaves only when it is excluded by name.
    const floorless = store.timingQuality({ parent, exclude: ["timing-floor"] }, iso(120));
    expect(floorless.items.map((item) => item.work.state)).not.toContain("timing-floor");
    expect(floorless.work.counts["timing-floor"]).toBe(1);
  });

  it("filters by kind, parent and resolution time, and says what it filtered on", () => {
    const { parent, ids } = cohort();
    at(130);
    const bug = worked("a bug elsewhere", { kind: "bug", from: 130, to: 140, every: 5 });
    const everything = store.timingQuality({}, iso(150));
    expect(everything.population.eligible).toBe(6);
    const bugs = store.timingQuality({ kind: ["bug"] }, iso(150));
    expect(bugs.items.map((item) => item.identifier)).toEqual([identifier(bug)]);
    expect(bugs.filter.kind).toEqual(["bug"]);
    // Beneath the nested parent only: its one leaf.
    const nested = store.timingQuality({ parent: ids.nested! }, iso(150));
    expect(nested.items.map((item) => item.identifier)).toEqual([identifier(ids.deep!)]);
    expect(nested.filter.parent).toBe(identifier(ids.nested!));
    // Resolved at or after 100 minutes: sparse (done at 102), missing (103), deep (114), the bug (140); open issues fall outside.
    const recent = store.timingQuality({ since: iso(100) }, iso(150));
    expect(recent.items.map((item) => item.identifier)).toEqual(["sparse", "missing", "deep"].map((name) => identifier(ids[name]!)).concat(identifier(bug)));
    expect(recent.population.notEligible.open).toBe(0);
    // A duration means that long ago, from the read's instant.
    expect(store.timingQuality({ since: "50m" }, iso(150)).filter.since).toBe(iso(100));
    expect(store.timingQuality({ parent }, iso(150)).population.eligible).toBe(5);
  });

  it("refuses what it cannot filter on", () => {
    expect(refusal(() => store.timingQuality({ kind: ["nope"] })).code).toBe("validation");
    expect(refusal(() => store.timingQuality({ exclude: ["provider-unavailable"] })).message).toContain("budget state");
    expect(refusal(() => store.timingQuality({ exclude: ["approx"] })).code).toBe("validation");
    expect(refusal(() => store.timingQuality({ excludeReasons: ["Sparse!"] })).code).toBe("validation");
    expect(refusal(() => store.timingQuality({ parent: "TST-999" })).code).toBe("not_found");
    expect(refusal(() => store.timingQuality({ since: "yesterday" })).code).toBe("validation");
  });

  it("with nothing eligible, coverage is null with a reason, never a zero", () => {
    const report = store.timingQuality({}, iso(0));
    expect(report.population.eligible).toBe(0);
    expect(report.work.coverage).toBeNull();
    expect(report.work.missing).toEqual({ coverage: "no_eligible_records" });
    expect(report.ratio.exact).toMatchObject({ ratio: null, workSeconds: null, missing: { ratio: "no_eligible_records" } });
  });

  it("pages by resolution instant with a keyset cursor that holds when records are added between pages", () => {
    const { parent, ids } = cohort();
    const first = store.timingQuality({ parent, limit: 2 }, iso(120));
    expect(first.truncated).toBe(true);
    expect(first.items.map((item) => item.identifier)).toEqual(["exact", "floor"].map((name) => identifier(ids[name]!)));
    // A leaf resolved later is added between the pages: it lands after, and nothing shifts.
    worked("late", { parent, from: 121, to: 131, every: 5 });
    const second = store.timingQuality({ parent, limit: 2, cursor: first.nextCursor! }, iso(140));
    expect(second.items.map((item) => item.identifier)).toEqual(["sparse", "missing"].map((name) => identifier(ids[name]!)));
    const third = store.timingQuality({ parent, limit: 2, cursor: second.nextCursor! }, iso(140));
    expect(third.items.map((item) => item.title)).toEqual(["deep", "late"]);
    expect(third.truncated).toBe(false);
    expect(third.nextCursor).toBeNull();
    // A cursor is for the arguments it was issued for.
    expect(refusal(() => store.timingQuality({ parent, exclude: ["missing"], cursor: first.nextCursor! })).code).toBe("validation");
    expect(refusal(() => store.timingQuality({ parent, limit: 0 })).code).toBe("validation");
  });
});

// ------------------------------------------------------------------ budget records

describe("every budget record carries one state", () => {
  let claudeDir: string;
  beforeEach(() => {
    vi.useRealTimers();
    claudeDir = join(home, "claude");
    mkdirSync(claudeDir, { recursive: true });
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
  });
  const after = (base: string, seconds: number): string => new Date(Date.parse(base) + seconds * 1000).toISOString();
  const captureOn = (): void => {
    setBudgetCapture(home, true);
    bindBudgetSource(home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir });
  };
  const render = (instant: string, used: number, resetsAt: string) =>
    ingestBudget(
      { source: "claude-statusline", input: statusline({ session_id: STATUSLINE_SESSION_ID, rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(resetsAt) } } }), configDir: claudeDir },
      { home, attemptLinker: attemptLinkerFor(home), now: () => instant },
    );
  const manual = (instant: string, used: number, resetsAt?: string) =>
    ingestBudget({ source: "manual", account: "typed", provider: "anthropic", limitKey: "five_hour", used, ...(resetsAt ? { resetsAt } : {}) }, { home, operator: true, now: () => instant });

  it("samples, readings and burns, on ingestion and on every read", () => {
    captureOn();
    const issue = store.createIssue({ title: "Burning" });
    store.checkoutIssue(issue.id, "w", undefined, { attempt: { harness: "claude_code", harnessSession: STATUSLINE_SESSION_ID } });
    const attempt = attemptsOfIssue(store.db, issue.id)[0]!;
    const start = attempt.startedAt;
    const reset = after(start, 3600);
    const stored = render(after(start, -60), 20, reset);
    // The stored sample an ingestion returns carries its state: observed, documented surface.
    expect(stored.outcomes[0]).toMatchObject({ stored: true, sample: { quality: { state: "exact", reasons: [] } } });
    render(after(start, 120), 26, reset);

    const now = after(start, 180);
    const history = listBudgetSamples(home, { account: "personal-max", now });
    expect(history.items.map((sample) => sample.quality.state)).toEqual(["exact", "exact"]);
    const [limit] = readBudget(home, { now }).accounts[0]!.limits;
    expect(limit!.quality).toEqual({ state: "exact", reasons: [] });
    expect(limit!.latestSample!.quality).toEqual({ state: "exact", reasons: [] });
    // Read long after the last reading: the value may have moved since.
    expect(readBudget(home, { now: after(start, 1800) }).accounts[0]!.limits[0]!.quality).toEqual({ state: "approximate", reasons: ["stale"] });
    // After the reset nothing carries forward: missing, because capture has not seen the new window.
    expect(readBudget(home, { now: after(reset, 60) }).accounts[0]!.limits[0]!.quality).toEqual({ state: "missing", reasons: ["window_elapsed"] });

    const burn = attemptDetail(store.db, attempt.id, { home, device: null, slug: "test", now }).burn;
    expect(burn.limits[0]).toMatchObject({ burnPercent: 6, quality: { state: "exact", reasons: [] } });
    expect(burn.limits[0]!.windows[0]!.quality).toEqual({ state: "exact", reasons: [] });
    // This store has no presence index to say whether another attempt shared the account:
    // the burn is measured, and its attribution to this attempt alone is not known.
    expect(burn.attribution).toBeNull();
    expect(burn.quality).toEqual({ state: "approximate", reasons: ["attribution_unknown"] });
  });

  it("a reading the provider gave no reset for is approximate, and the limit it cannot place is provider-unavailable", () => {
    const now = new Date().toISOString();
    const stored = manual(now, 44);
    expect(stored.outcomes[0]).toMatchObject({ stored: true, sample: { quality: { state: "approximate", reasons: ["reset_not_reported"] } } });
    const [limit] = readBudget(home, { now, account: "typed" }).accounts[0]!.limits;
    expect(limit!.quality).toEqual({ state: "provider-unavailable", reasons: ["reset_not_reported"] });
  });

  it("a burn that cannot be joined is missing, with the reason", () => {
    const issue = store.createIssue({ title: "No harness reported" });
    store.checkoutIssue(issue.id, "w");
    expect(store.getAttempt(attemptsOfIssue(store.db, issue.id)[0]!.id, {}, home).burn.quality).toEqual({ state: "missing", reasons: ["no_provider_binding"] });
  });
});
