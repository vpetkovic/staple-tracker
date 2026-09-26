/**
 * Session pressure on `get_budget` (docs/execution-telemetry.md, "Pressure"), from readings
 * ingested the way they arrive: Claude Code status-line JSON through the real status-line
 * source, Codex rollout files through the real rollout source, and `--source manual`, into a
 * scratch staple home. No reading is written by hand, so every figure below is what the page and
 * the CLI read for that history.
 *
 * The figures are PROVISIONAL (the admission policy is not built): sustainable burn is what is
 * left above the reserve over the hours to the reset, pressure is the observed pace over it, and
 * 1 or over is unsafe. Safe concurrency is never a number.
 */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { attemptLinkerFor } from "../src/core/telemetry/attempt-link.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { UNSAFE_PRESSURE } from "../src/core/telemetry/budget-pressure.js";
import { ingestBudget } from "../src/core/telemetry/ingest.js";
import { readBudget, type LimitReading } from "../src/core/telemetry/read-budget.js";
import { STATUSLINE_SESSION_ID, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./fixtures/budget-support.js";

let home: string;
let claudeDir: string;
let codexDir: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-pressure-home-"));
  claudeDir = join(home, "claude");
  codexDir = join(home, "codex");
  mkdirSync(claudeDir);
  mkdirSync(codexDir);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const T0 = "2026-09-25T10:00:00.000Z";
const at = (minutes: number): string => new Date(Date.parse(T0) + minutes * 60_000).toISOString();
const HOUR = 3600;

function bindClaude(account = "personal-max"): void {
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account, configDir: claudeDir });
}

/** One status-line render of the five-hour limit, ingested as Claude Code sends it at `minutes`. */
function render(minutes: number, used: number, resetsAt: string, session: string = STATUSLINE_SESSION_ID): void {
  const input = statusline({ session_id: session, rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(resetsAt) } } });
  ingestBudget({ source: "claude-statusline", input, configDir: claudeDir }, { home, attemptLinker: attemptLinkerFor(home), now: () => at(minutes) });
}

/** A Codex rollout with one token_count line per `[minutes, primary, secondary]`, ingested at the last one. */
function rollout(lines: Array<[number, number, number]>, primaryReset: string, secondaryReset: string): void {
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome: codexDir });
  const session = "33333333-0000-7000-8000-000000000002";
  const file = writeRollout(codexDir, session, at(lines[0]![0] - 1), [
    sessionMetaLine({ id: session, timestamp: at(lines[0]![0] - 1) }),
    ...lines.map(([minutes, primary, secondary]) =>
      tokenCountLine({
        timestamp: at(minutes),
        primary: { used_percent: primary, window_minutes: 300, resets_at: epoch(primaryReset) },
        secondary: { used_percent: secondary, window_minutes: 10080, resets_at: epoch(secondaryReset) },
      }),
    ),
  ]);
  ingestBudget({ source: "codex-rollout", file }, { home, now: () => at(lines[lines.length - 1]![0]) });
}

function limit(minutes: number, account: string, key: string, reserve?: string | number): LimitReading {
  const view = readBudget(home, { now: at(minutes), account, reserve });
  const found = view.accounts[0]!.limits.find((entry) => entry.limitKey === key);
  expect(found, `${account} ${key}`).toBeDefined();
  return found!;
}

describe("pressure from status-line readings", () => {
  it("measures the pace, and reads a pace well under the sustainable one as within", () => {
    bindClaude();
    // Five renders over an hour, 10% to 14%; the reset four hours after the last.
    const reset = at(300);
    [[0, 10], [15, 11], [30, 12], [45, 13], [60, 14]].forEach(([m, used]) => render(m!, used!, reset));
    const { pressure, remainingPercent } = limit(61, "personal-max", "five_hour");
    expect(remainingPercent).toBe(86);
    // MEASURED: 4 points over one hour, the last reading a minute old.
    expect(pressure.observed).toMatchObject({ percentPerHour: 4, fromPercent: 10, toPercent: 14, readings: 5, spanSeconds: HOUR });
    expect(pressure.lastReadingAgeSeconds).toBe(60);
    expect(pressure.secondsToReset).toBe(239 * 60);
    // FORECAST: (86 − 20) over the 239 minutes to the reset.
    const sustainable = (66 / (239 * 60)) * HOUR;
    expect(pressure.sustainablePercentPerHour).toBeCloseTo(sustainable, 9);
    expect(pressure.ratio).toBeCloseTo(4 / sustainable, 9);
    expect(pressure.state).toBe("within");
    expect(pressure.exhaustion).toMatchObject({ atPace: "after_reset", seconds: (86 / 4) * HOUR });
    expect(pressure.reserveReach).toMatchObject({ atPace: "after_reset", seconds: (66 / 4) * HOUR, at: new Date(Date.parse(at(61)) + (66 / 4) * HOUR * 1000).toISOString() });
    expect(pressure.confidence).toEqual({ label: "medium", readings: 5, spanSeconds: HOUR, warnings: [] });
    // Safe concurrency is the admission policy's, and says so.
    expect(pressure.safeConcurrency).toBeNull();
    expect(pressure.missing).toEqual({ safeConcurrency: "policy_not_defined" });
  });

  it("says unsafe at a pace that reaches the reserve before the reset, and names the provisional rule", () => {
    bindClaude();
    const reset = at(120);
    [[0, 30], [10, 40], [20, 50], [30, 60], [40, 70]].forEach(([m, used]) => render(m!, used!, reset));
    const view = readBudget(home, { now: at(41) });
    expect(view.reserve).toMatchObject({ percent: 20, source: "provisional_default", note: expect.stringContaining("provisional") });
    expect(view.pressureRule).toMatchObject({ provisional: true, unsafeAtRatio: UNSAFE_PRESSURE, note: expect.stringContaining("provisional") });
    const { pressure } = view.accounts[0]!.limits[0]!;
    // 40 points in 40 minutes: 60%/h, against (30 − 20) over 79 minutes.
    expect(pressure.observed!.percentPerHour).toBeCloseTo(60, 9);
    expect(pressure.ratio).toBeGreaterThanOrEqual(UNSAFE_PRESSURE);
    expect(pressure.state).toBe("unsafe");
    expect(pressure.reserveReach).toMatchObject({ atPace: "before_reset", seconds: (10 / 60) * HOUR });
    expect(pressure.exhaustion).toMatchObject({ atPace: "before_reset" });
  });

  it("is unsafe at or under the reserve whatever the pace, with no ratio to divide by", () => {
    bindClaude();
    const reset = at(240);
    render(0, 81, reset);
    render(30, 81.5, reset);
    const { pressure } = limit(31, "personal-max", "five_hour");
    expect(pressure.sustainablePercentPerHour).toBe(0);
    expect(pressure.ratio).toBeNull();
    expect(pressure.missing.ratio).toBe("reserve_reached");
    expect(pressure.state).toBe("unsafe");
    expect(pressure.reserveReach).toEqual({ atPace: "already", seconds: 0, at: at(31) });
    // A higher reserve moves the line; a lower one clears it.
    expect(limit(31, "personal-max", "five_hour", "10").pressure.state).toBe("within");
  });

  it("reads remaining exactly at the reserve as unsafe: the boundary is at or under", () => {
    bindClaude();
    const reset = at(240);
    render(0, 79, reset);
    render(30, 80, reset);
    const { pressure, remainingPercent } = limit(31, "personal-max", "five_hour");
    expect(remainingPercent).toBe(20);
    expect(pressure).toMatchObject({ state: "unsafe", ratio: null, sustainablePercentPerHour: 0, reserveReach: { atPace: "already" } });
    expect(pressure.missing.ratio).toBe("reserve_reached");
  });

  it("reads a pace exactly at the sustainable one as unsafe: pressure 1 is the line", () => {
    bindClaude();
    // 25% to 30% in 30 minutes: 10%/h. 70 left, reserve 50, two hours to the reset: 10%/h sustainable.
    const reset = at(150);
    render(0, 25, reset);
    render(30, 30, reset);
    const { pressure } = limit(30, "personal-max", "five_hour", "50");
    expect(pressure.observed!.percentPerHour).toBe(10);
    expect(pressure.sustainablePercentPerHour).toBe(10);
    expect(pressure.ratio).toBe(1);
    expect(pressure.state).toBe("unsafe");
    expect(pressure.reserveReach).toMatchObject({ atPace: "after_reset", seconds: 7200 });
  });

  it("keeps a stale reading at or under the reserve unsafe: the high-water only rises until the reset", () => {
    bindClaude();
    const reset = at(240);
    render(0, 85, reset);
    render(10, 95, reset);
    const { pressure, stale } = limit(40, "personal-max", "five_hour");
    expect(stale).toBe(true);
    expect(pressure).toMatchObject({ provisional: true, state: "unsafe", ratio: null, sustainablePercentPerHour: 0, reserveReach: { atPace: "already" }, exhaustion: null });
    expect(pressure.missing).toMatchObject({ ratio: "reserve_reached", exhaustion: "stale" });
    expect(pressure.missing.state).toBeUndefined();
  });

  it("follows the reserve argument, and refuses one out of range", () => {
    bindClaude();
    const reset = at(180);
    [[0, 20], [30, 25], [60, 30]].forEach(([m, used]) => render(m!, used!, reset));
    // 10%/h. Remaining 70 over two hours: reserve 20 → 25%/h sustainable; reserve 55 → 7.5%/h.
    expect(limit(60, "personal-max", "five_hour").pressure).toMatchObject({ reservePercent: 20, state: "within", sustainablePercentPerHour: 25 });
    const high = readBudget(home, { now: at(60), reserve: "55%" });
    expect(high.reserve).toEqual({ percent: 55, source: "argument", note: null });
    expect(high.accounts[0]!.limits[0]!.pressure).toMatchObject({ reservePercent: 55, sustainablePercentPerHour: 7.5, state: "unsafe" });
    expect(() => readBudget(home, { reserve: "150" })).toThrow(/reserve/);
  });

  it("marks low confidence on few readings, a short span, or a regression, with the reasons", () => {
    bindClaude();
    const reset = at(300);
    render(0, 10, reset);
    render(5, 12, reset);
    // An older cache from another session: a regression inside the window.
    render(6, 11, reset, "session-b");
    const { pressure } = limit(7, "personal-max", "five_hour");
    expect(pressure.confidence).toMatchObject({ label: "low", readings: 3, warnings: ["small_sample", "short_span", "regressions"] });
  });
});

describe("pressure from Codex rollouts", () => {
  it("reads each limit of the account on its own window", () => {
    // Primary 20 → 60 in an hour, two hours before its reset; the weekly limit barely moves.
    rollout([[0, 20, 40], [30, 40, 40.1], [60, 60, 40.2]], at(180), at(60 * 24 * 3));
    const primary = limit(61, "codex-plus", "codex.primary").pressure;
    expect(primary.observed!.percentPerHour).toBeCloseTo(40, 9);
    expect(primary.state).toBe("unsafe");
    expect(primary.confidence).toMatchObject({ label: "low", warnings: ["small_sample"] });
    const weekly = limit(61, "codex-plus", "codex.secondary").pressure;
    // 0.2%/h against (59.8 − 20) over about 71 hours: about half the sustainable pace.
    expect(weekly.observed!.percentPerHour).toBeCloseTo(0.2, 9);
    expect(weekly.ratio).toBeLessThan(UNSAFE_PRESSURE);
    expect(weekly.state).toBe("within");
  });
});

describe("unknown pressure is unknown, with its reason, and never within", () => {
  it("keeps the measured pace of a stale window and projects nothing off it", () => {
    bindClaude();
    const reset = at(300);
    [[0, 10], [10, 12], [20, 14]].forEach(([m, used]) => render(m!, used!, reset));
    const { pressure, stale } = limit(50, "personal-max", "five_hour");
    expect(stale).toBe(true);
    expect(pressure.observed).toMatchObject({ percentPerHour: 12 });
    expect(pressure.lastReadingAgeSeconds).toBe(30 * 60);
    expect(pressure).toMatchObject({ state: null, ratio: null, sustainablePercentPerHour: null, exhaustion: null, reserveReach: null });
    expect(pressure.missing).toMatchObject({ state: "stale", ratio: "stale", sustainablePercentPerHour: "stale", exhaustion: "stale", reserveReach: "stale" });
  });

  it("needs a second reading for a pace, and says so on everything that needs the pace", () => {
    bindClaude();
    render(0, 30, at(240));
    const { pressure } = limit(1, "personal-max", "five_hour");
    expect(pressure.observed).toBeNull();
    expect(pressure.missing).toMatchObject({ observed: "input_missing", confidence: "input_missing", state: "input_missing", ratio: "input_missing" });
    expect(pressure.missingInputs).toMatchObject({ observed: ["second_reading"], state: ["observed"], ratio: ["observed"] });
    // What does not need the pace is known.
    expect(pressure.sustainablePercentPerHour).toBeCloseTo((50 / (239 * 60)) * HOUR, 9);
    expect(pressure.state).toBeNull();
  });

  it("reads an elapsed window as elapsed, not as the last value", () => {
    bindClaude();
    const reset = at(60);
    render(0, 40, reset);
    render(30, 50, reset);
    const { pressure, status } = limit(90, "personal-max", "five_hour");
    expect(status).toBe("elapsed");
    expect(pressure).toMatchObject({ observed: null, lastReadingAgeSeconds: null, secondsToReset: null, state: null, sustainablePercentPerHour: null });
    expect(pressure.missing).toMatchObject({ observed: "window_elapsed", state: "window_elapsed", lastReadingAgeSeconds: "window_elapsed", secondsToReset: "window_elapsed" });
  });

  it("reads a reading with no reset as reset_not_reported", () => {
    setBudgetCapture(home, true);
    ingestBudget({ source: "manual", account: "hand-typed", provider: "anthropic", limitKey: "five_hour", used: "44" }, { home, operator: true, now: () => at(0) });
    const { pressure } = limit(1, "hand-typed", "five_hour");
    expect(pressure.state).toBeNull();
    expect(pressure.missing).toMatchObject({ state: "reset_not_reported", observed: "reset_not_reported" });
  });

  it("names why an account has no limits at all: no binding, or capture on and nothing yet", () => {
    // No binding, capture off.
    expect(readBudget(home, { now: at(0), account: "nobody" }).accounts).toEqual([
      { provider: null, accountRef: "nobody", bound: false, limits: [], missing: { limits: "source_unavailable" } },
    ]);
    expect(readBudget(home, { now: at(0) })).toMatchObject({ budgetCapture: false, accounts: [] });
    // Bound with capture on and no reading yet.
    bindClaude();
    expect(readBudget(home, { now: at(0) }).accounts).toEqual([
      { provider: "anthropic", accountRef: "personal-max", bound: true, limits: [], missing: { limits: "no_sample_yet" } },
    ]);
    // Bound with capture off: no ingestion path runs for it.
    setBudgetCapture(home, false);
    expect(readBudget(home, { now: at(0) }).accounts[0]!.missing).toEqual({ limits: "source_unavailable" });
  });
});
