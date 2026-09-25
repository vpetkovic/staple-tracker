/**
 * Budget forecasts (`docs/timing-semantics.md`, "Forecasts"): the pace of a limit's current
 * window, when it runs out, the work rate from attempts' measured burn, what a piece of work
 * leaves at the reset, and the probability it leaves less than the reserve, kept apart from
 * the completion forecast.
 *
 * Real ingestion only: a status line shaped like Claude Code's and a Codex rollout, read by
 * `ingestBudget` into a scratch home's hub, against a real workspace whose attempts are opened
 * by checkout with a harness session, so the account binding is the one the machine resolves.
 * The write clock is controlled with `setClock`; the ingestion clock with its `now`.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WorkspaceStore } from "../src/core/store.js";
import { attemptLinkerFor } from "../src/core/telemetry/attempt-link.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { PROVISIONAL_RESERVE_PERCENT } from "../src/core/telemetry/forecast-budget.js";
import { ingestBudget } from "../src/core/telemetry/ingest.js";
import { setClock } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { STATUSLINE_SESSION_ID, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./fixtures/budget-support.js";

const T0 = Date.parse("2026-09-25T10:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const RESET = iso(300);

let home: string;
let root: string;
let claudeDir: string;
let codexDir: string;
let store: WorkspaceStore;
let clock = T0;
const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
const previous = { home: process.env.STAPLE_HOME, claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-forecast-budget-home-"));
  root = mkdtempSync(join(tmpdir(), "staple-forecast-budget-root-"));
  claudeDir = join(home, "claude");
  codexDir = join(home, "codex");
  mkdirSync(claudeDir);
  mkdirSync(codexDir);
  process.env.STAPLE_HOME = home;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  setClock(() => clock);
  at(0);
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir });
  const dir = join(root, "ws");
  mkdirSync(dir);
  store = initWorkspace({ dir, slug: "ws" }).store;
});
afterEach(() => {
  setClock(null);
  try {
    store.db.close();
  } catch {
    // closed already
  }
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of [["STAPLE_HOME", previous.home], ["CLAUDE_CONFIG_DIR", previous.claude], ["CODEX_HOME", previous.codex]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** One status-line reading of the five-hour limit, captured at `minutes`. */
function reading(minutes: number, used: number, reset: string = RESET): void {
  const input = statusline({ session_id: STATUSLINE_SESSION_ID, rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(reset) } } });
  ingestBudget({ source: "claude-statusline", input, configDir: claudeDir }, { home, now: () => iso(minutes), attemptLinker: attemptLinkerFor(home) });
}

/** A leaf worked with no harness from `from` for `minutes` against a 60-minute estimate: a calibration sample. */
function sample(from: number, minutes: number): void {
  at(from);
  const issue = store.createIssue({ title: `sample ${minutes}m`, estimatedSeconds: 3600 });
  store.checkoutIssue(issue.id, "w", undefined, {});
  for (let m = from + 10; m < from + minutes; m += 10) (at(m), store.addComment(issue.id, "progress", "w", "agent"));
  at(from + minutes);
  store.updateIssue(issue.id, { status: "done" }, "w");
}

/**
 * History before `T0`: five samples (ratios 0.5 … 1.5). Then at T0 an agent checks out `worked`
 * (60-minute estimate) in the status line's session, bound to personal-max, and works an hour
 * while the five-hour limit reads 10%, 16% and 22%: an attempt burn of 12% over 3600 s of work.
 * `worked` is a sixth sample (ratio 1). The work to forecast is `next`, estimated 2 hours.
 */
function history(): { next: string; worked: string } {
  let from = -600;
  for (const minutes of [30, 40, 50, 60, 90]) {
    sample(from, minutes);
    from += minutes + 1;
  }
  at(0);
  const worked = store.createIssue({ title: "worked", estimatedSeconds: 3600 });
  store.checkoutIssue(worked.id, "agent", undefined, { attempt: { harness: "claude_code", harnessSession: STATUSLINE_SESSION_ID } });
  reading(0, 10);
  at(30);
  store.addComment(worked.id, "halfway", "agent", "agent");
  reading(30, 16);
  at(60);
  store.addComment(worked.id, "done", "agent", "agent");
  reading(60, 22);
  store.updateIssue(worked.id, { status: "done" }, "agent");
  at(61);
  const next = store.createIssue({ title: "next", estimatedSeconds: 7200 });
  return { next: next.identifier, worked: worked.identifier };
}

const limitOf = (report: ReturnType<WorkspaceStore["forecast"]>) => {
  const account = report.budget.accounts.find((candidate) => candidate.accountRef === "personal-max")!;
  return account.limits.find((limit) => limit.limitKey === "five_hour")!;
};

describe("the budget forecast of a piece of work", () => {
  it("measures the pace and the work rate, projects the work to the reset and reads the breach probability off the same draws", () => {
    const { next } = history();
    const report = store.forecast({ ref: next, reserve: "55%" }, iso(61), home);
    // Six samples, pooled 330/360: the expected duration of a 2h estimate is 6600 s.
    expect(report.completion.labor.expectedSeconds).toBeCloseTo(6600, 6);
    const limit = limitOf(report);
    expect(limit).toMatchObject({ status: "current", resetsAt: RESET, remainingPercent: 78, highWaterPercent: 22, stale: false, missing: {}, missingInputs: {} });
    expect(limit.secondsToReset).toBe(239 * 60);
    expect(limit.pace).toMatchObject({ fromPercent: 10, toPercent: 22, readings: 3, spanSeconds: 3600 });
    expect(limit.pace!.percentPerHour).toBeCloseTo(12, 9);
    // 78% at 12%/h is 6.5 hours, after the reset 3h59m away.
    expect(limit.exhaustion!.atPace).toBe("after_reset");
    expect(limit.exhaustion!.seconds).toBeCloseTo(6.5 * 3600, 6);
    expect(limit.workRate).toMatchObject({ attempts: 1, burnPercent: 12, workSeconds: 3600, lowerBound: false, excluded: 0, spanningReset: 0, truncated: false });
    expect(limit.workRate!.percentPerWorkHour).toBeCloseTo(12, 9);
    // 12%/work-hour over 6600 s is 22%, all of it before the reset: 56% left.
    expect(limit.work!.consumedPercent.expected).toBeCloseTo(22, 9);
    expect(limit.work!.beforeResetPercent.expected).toBeCloseTo(22, 9);
    expect(limit.work!.remainingAtResetPercent.expected).toBeCloseTo(56, 9);
    expect(limit.work!.outlastsResetProbability).toBe(0);
    // The draws: durations 1, 1.33, 1.67, 2, 2 and 3 hours, so 66, 62, 58, 54, 54 or 42% left.
    const left = [66, 62, 58, 54, 42];
    for (const figure of [limit.work!.remainingAtResetPercent.simulated.p10, limit.work!.remainingAtResetPercent.simulated.p50, limit.work!.remainingAtResetPercent.simulated.p90]) {
      expect(left.some((value) => Math.abs(value - figure) < 1e-9)).toBe(true);
    }
    // Under 55% in three draws of six: 54, 54 and 42.
    expect(limit.reserve).toMatchObject({ percent: 55, alreadyBelow: false, draws: 2000 });
    expect(limit.reserve!.breachProbability).toBeGreaterThan(0.45);
    expect(limit.reserve!.breachProbability).toBeLessThan(0.55);
    expect(report.budget.reserve).toEqual({ percent: 55, source: "argument", note: null });
    expect(report.budget.work).toEqual({ expectedSeconds: report.completion.labor.expectedSeconds, partial: false, schedule: "serial_from_as_of" });

    // No draw leaves under 40%; every draw leaves under 70%; 80% is under the reserve already.
    expect(limitOf(store.forecast({ ref: next, reserve: 40 }, iso(61), home)).reserve!.breachProbability).toBe(0);
    expect(limitOf(store.forecast({ ref: next, reserve: "70" }, iso(61), home)).reserve).toMatchObject({ breachProbability: 1, alreadyBelow: false });
    expect(limitOf(store.forecast({ ref: next, reserve: "80%" }, iso(61), home)).reserve).toMatchObject({ breachProbability: 1, alreadyBelow: true });
  });

  it("uses a provisional reserve until the admission policy defines one, and says so", () => {
    const { next } = history();
    const report = store.forecast({ ref: next }, iso(61), home);
    expect(report.budget.reserve).toMatchObject({ percent: PROVISIONAL_RESERVE_PERCENT, source: "provisional_default" });
    expect(report.budget.reserve.note).toMatch(/provisional/);
    expect(limitOf(report).reserve!.percent).toBe(PROVISIONAL_RESERVE_PERCENT);
  });

  it("reads the same on every read of the same data, and names the budget data it read", () => {
    const { next } = history();
    const first = store.forecast({ ref: next, reserve: "55" }, iso(61), home);
    expect(store.forecast({ ref: next, reserve: "55" }, iso(61), home)).toEqual(first);
    expect(first.snapshot.budget).toMatchObject({ machineLocal: true });
    expect(first.snapshot.budget.id).toMatch(/^forecast1-budget:[0-9a-f]{32}$/);
    // Another reading changes the budget identity and leaves the completion one alone.
    reading(61, 23);
    const second = store.forecast({ ref: next, reserve: "55" }, iso(61), home);
    expect(second.snapshot.budget.id).not.toBe(first.snapshot.budget.id);
    expect(second.snapshot.id).toBe(first.snapshot.id);
  });

  it("reads a stale reading as unknown for everything projected off it, never as a measurement", () => {
    const { next } = history();
    const limit = limitOf(store.forecast({ ref: next }, iso(75), home));
    expect(limit.stale).toBe(true);
    expect(limit.remainingPercent).toBe(78);
    expect(limit).toMatchObject({ exhaustion: null, work: null, reserve: null, missing: { exhaustion: "stale", work: "stale", reserve: "stale" } });
    // The measured rates still stand: they describe the window's past.
    expect(limit.pace!.percentPerHour).toBeCloseTo(12, 9);
  });

  it("carries nothing across a reset", () => {
    const { next } = history();
    const limit = limitOf(store.forecast({ ref: next }, iso(301), home));
    expect(limit).toMatchObject({ status: "elapsed", remainingPercent: null, pace: null, workRate: null, work: null, reserve: null });
    expect(limit.missing).toMatchObject({ remainingPercent: "window_elapsed", resetsAt: "window_elapsed", pace: "window_elapsed", workRate: "window_elapsed", work: "window_elapsed", reserve: "window_elapsed" });
  });

  it("says which input is missing when no attempt burned in the window, or the work is unknown", () => {
    const { next } = history();
    // Unknown labor: an issue with no estimate has no forecast, so neither has its budget.
    at(62);
    const unplanned = store.createIssue({ title: "unplanned" }).identifier;
    const unknown = limitOf(store.forecast({ ref: unplanned }, iso(62), home));
    expect(unknown.workRate).not.toBeNull();
    expect(unknown).toMatchObject({ work: null, reserve: null, missing: { work: "input_missing" }, missingInputs: { work: ["labor_seconds"] } });

    // A second window instance after the reset, read twice, with no attempt in it.
    reading(310, 3, iso(600));
    reading(340, 5, iso(600));
    const limit = limitOf(store.forecast({ ref: next }, iso(341), home));
    expect(limit.pace!.percentPerHour).toBeCloseTo(4, 9);
    expect(limit.workRate).toBeNull();
    expect(limit.missing).toMatchObject({ workRate: "input_missing", work: "input_missing", reserve: "input_missing" });
    expect(limit.missingInputs).toMatchObject({ workRate: ["attempt_burn"], work: ["work_rate"], reserve: ["work_rate"] });
  });
});

describe("with no budget on this machine", () => {
  it("reads unknown with the contract's reason, never 0", () => {
    const { next } = history();
    const empty = mkdtempSync(join(tmpdir(), "staple-forecast-empty-"));
    try {
      const report = store.forecast({ ref: next }, iso(61), empty);
      expect(report.budget).toMatchObject({ accounts: [], missing: { accounts: "source_unavailable" }, budgetCapture: false });
      expect(report.completion.labor.expectedSeconds).toBeCloseTo(6600, 6);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("a Codex rollout's two limits", () => {
  it("forecasts each limit of the account on its own, from its own readings", () => {
    const { next } = history();
    bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome: codexDir });
    const id = "33333333-0000-7000-8000-000000000001";
    const weekly = iso(60 * 24 * 3);
    const file = writeRollout(codexDir, id, iso(0), [
      sessionMetaLine({ id, timestamp: iso(0) }),
      tokenCountLine({ timestamp: iso(1), primary: { used_percent: 20, window_minutes: 300, resets_at: epoch(RESET) }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: epoch(weekly) } }),
      tokenCountLine({ timestamp: iso(31), primary: { used_percent: 30, window_minutes: 300, resets_at: epoch(RESET) }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: epoch(weekly) } }),
      tokenCountLine({ timestamp: iso(61), primary: { used_percent: 40, window_minutes: 300, resets_at: epoch(RESET) }, secondary: { used_percent: 42, window_minutes: 10080, resets_at: epoch(weekly) } }),
    ]);
    ingestBudget({ source: "codex-rollout", file }, { home, now: () => iso(61) });
    const report = store.forecast({ ref: next, account: "codex-plus" }, iso(62), home);
    expect(report.budget.accounts.map((account) => account.accountRef)).toEqual(["codex-plus"]);
    const [primary, secondary] = report.budget.accounts[0]!.limits;
    expect(primary!.limitKey).toBe("codex.primary");
    expect(primary!.pace!.percentPerHour).toBeCloseTo(20, 9);
    // 60% left at 20%/h is 3 hours, before the reset 3h58m away.
    expect(primary!.exhaustion!.atPace).toBe("before_reset");
    expect(primary!.exhaustion!.seconds).toBeCloseTo(3 * 3600, 6);
    expect(secondary!.limitKey).toBe("codex.secondary");
    expect(secondary!.pace!.percentPerHour).toBeCloseTo(2, 9);
    expect(secondary!.remainingPercent).toBe(58);
    // No attempt of this workspace ran on the Codex account: its work rate is unknown, and says why.
    for (const limit of [primary!, secondary!]) {
      expect(limit.workRate).toBeNull();
      expect(limit.missingInputs.workRate).toEqual(["attempt_burn"]);
    }
  });
});
