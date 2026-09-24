/**
 * Budget ingestion (docs/execution-telemetry.md, "Limit windows", "Budget samples",
 * "Missingness", "Formats", "Privacy"), driven through the one method every surface
 * calls, `ingestBudget`, against a scratch staple home.
 *
 * Each describe block is one rule of the contract, and each fixture matches the real
 * input in the dimension that rule is about: the status line is Claude Code 2.1.281's
 * documented object, and Codex lines copy the shape and the measured timings of real
 * rollouts (see test/fixtures/budget-support.ts).
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hub } from "../src/core/hub.js";
import { BudgetStore, type BudgetSample, type SampleOutcome } from "../src/core/telemetry/budget-store.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { ingestBudget, type IngestRequest, type IngestResult } from "../src/core/telemetry/ingest.js";
import { StapleError } from "../src/core/types.js";
import { REPO_ROOT, removeDir, tempDir } from "./fixtures/characterize-support.js";
import { readCode, sourceFiles } from "./fixtures/source-scan.js";
import {
  STATUSLINE_SESSION_ID,
  after,
  epoch,
  oldTokenCountLine,
  responseItemLine,
  sessionMetaLine,
  statusline,
  tokenCountLine,
  writeRollout,
} from "./fixtures/budget-support.js";

let home: string;
let claudeDir: string;
let codexDir: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = tempDir("budget-home");
  claudeDir = join(home, "harness", "claude-personal");
  codexDir = join(home, "harness", "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  env = { CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir };
});

afterEach(() => removeDir(home));

/** Capture on, and both harness homes bound, as an operator would set it up. */
function optIn(): void {
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir }, env);
  bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome: codexDir }, env);
}

function ingest(request: IngestRequest, at: string): IngestResult {
  let tick = 0;
  // `now` is read once for the capture instant and once per stored sample.
  return ingestBudget(request, { home, env, now: () => (tick++ === 0 ? at : after(at, tick)) });
}

function withStore<T>(fn: (store: BudgetStore) => T): T {
  const hub = Hub.openAt(home);
  try {
    return fn(new BudgetStore(hub.db));
  } finally {
    hub.close();
  }
}

const samples = (): BudgetSample[] => withStore((store) => store.listSamples());
const stored = (outcomes: SampleOutcome[]): BudgetSample[] => outcomes.flatMap((o) => (o.stored ? [o.sample] : []));
const reasons = (outcomes: SampleOutcome[]): string[] => outcomes.flatMap((o) => (o.stored ? [] : [o.reason]));
const iso = (epochSeconds: number): string => new Date(epochSeconds * 1000).toISOString();

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

const T0 = "2026-09-24T14:00:00.000Z";
const FIVE_HOUR_RESET = 1790269200;
const SEVEN_DAY_RESET = 1790640000;

// ------------------------------------------------------------------ opt-in and bindings

describe("budget capture is opt-in, off by default", () => {
  it("refuses a harness source on a fresh home and stores nothing, even with a binding", () => {
    bindBudgetSource(home, { source: "claude_code_statusline", account: "personal-max", configDir: claudeDir }, env);
    const error = refusal(() => ingest({ source: "claude-statusline", input: statusline() }, T0));
    expect(error.code).toBe("validation");
    expect(error.detail).toMatchObject({ reason: "capture_disabled" });
    expect(samples()).toEqual([]);
  });

  it("stores once the operator turns it on", () => {
    optIn();
    expect(ingest({ source: "claude-statusline", input: statusline() }, T0).storedCount).toBe(2);
  });
});

describe("source bindings produce the account", () => {
  it("refuses a reading with neither a binding nor --account, naming the missing binding, and stores nothing", () => {
    setBudgetCapture(home, true);
    const error = refusal(() => ingest({ source: "claude-statusline", input: statusline() }, T0));
    expect(error.code).toBe("validation");
    expect(error.detail).toMatchObject({ reason: "no_binding_configured", source: "claude_code_statusline", lookedUp: claudeDir });
    expect(error.message).toContain(claudeDir);
    expect(samples()).toEqual([]);

    const file = writeRollout(codexDir, "11111111-0000-7000-8000-000000000001", T0, [
      sessionMetaLine({ id: "11111111-0000-7000-8000-000000000001", timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 5000), primary: { used_percent: 6, window_minutes: 300, resets_at: epoch("2026-09-24T19:00:00Z") }, secondary: null }),
    ]);
    const codex = refusal(() => ingest({ source: "codex-rollout", file }, T0));
    expect(codex.detail).toMatchObject({ reason: "no_binding_configured", source: "codex_rollout" });
    expect(samples()).toEqual([]);
  });

  it("takes --account over nothing, and says the account came from the flag", () => {
    setBudgetCapture(home, true);
    const result = ingest({ source: "claude-statusline", input: statusline(), account: "adhoc-label" }, T0);
    expect(result).toMatchObject({ accountRef: "adhoc-label", accountSource: "flag", provider: "anthropic" });
  });

  it("keys a Claude binding by CLAUDE_CONFIG_DIR, so one machine runs two accounts", () => {
    optIn();
    const workDir = join(home, "harness", "claude-work");
    mkdirSync(workDir);
    bindBudgetSource(home, { source: "claude_code_statusline", account: "work-team", configDir: workDir }, env);

    const personal = ingest({ source: "claude-statusline", input: statusline() }, T0);
    const work = ingestBudget({ source: "claude-statusline", input: statusline() }, { home, env: { ...env, CLAUDE_CONFIG_DIR: workDir }, now: () => T0 });
    expect([personal.accountRef, personal.accountSource]).toEqual(["personal-max", "machine_binding"]);
    expect([work.accountRef, work.accountSource]).toEqual(["work-team", "machine_binding"]);
    // --account overrides the binding.
    expect(ingest({ source: "claude-statusline", input: statusline(), account: "override" }, T0).accountRef).toBe("override");
  });

  it("gives a rollout the account of the Codex home that contains it", () => {
    optIn();
    const id = "11111111-0000-7000-8000-000000000002";
    const inside = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 5000), primary: { used_percent: 6, window_minutes: 300, resets_at: epoch("2026-09-24T19:00:00Z") }, secondary: null }),
    ]);
    expect(ingest({ source: "codex-rollout", file: inside }, T0)).toMatchObject({ accountRef: "codex-plus", provider: "openai" });
    const outside = writeRollout(join(home, "elsewhere"), id, T0, [sessionMetaLine({ id, timestamp: T0 })]);
    expect(refusal(() => ingest({ source: "codex-rollout", file: outside }, T0)).detail).toMatchObject({ reason: "no_binding_configured" });
  });
});

// ------------------------------------------------------------------ unknown is never zero

describe("unknown capacity stays unknown", () => {
  beforeEach(optIn);

  it("stores no row when the status line carries no rate_limits (not a subscriber, or before the first response)", () => {
    const result = ingest({ source: "claude-statusline", input: statusline({ rate_limits: undefined }) }, T0);
    expect(result.storedCount).toBe(0);
    expect(reasons(result.outcomes)).toEqual(["not_reported_by_source"]);
    expect(samples()).toEqual([]);
  });

  it("never turns a null used_percentage into 0", () => {
    const result = ingest(
      {
        source: "claude-statusline",
        input: statusline({ rate_limits: { five_hour: { used_percentage: null, resets_at: FIVE_HOUR_RESET }, seven_day: { used_percentage: 41, resets_at: SEVEN_DAY_RESET } } }),
      },
      T0,
    );
    expect(reasons(result.outcomes)).toEqual(["not_reported_by_source"]);
    expect(samples().map((s) => [s.limitKey, s.usedPercent])).toEqual([["seven_day", 41]]);
  });

  it("stores no row for Codex's premium limit, which reports primary and secondary as null", () => {
    const id = "22222222-0000-7000-8000-000000000001";
    const file = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 3000), limitId: "premium", primary: null, secondary: null }),
    ]);
    const result = ingest({ source: "codex-rollout", file }, T0);
    expect(result.outcomes).toEqual([
      { stored: false, reason: "not_reported_by_source", limitKey: "premium.primary", observedAt: after(T0, 3000) },
      { stored: false, reason: "not_reported_by_source", limitKey: "premium.secondary", observedAt: after(T0, 3000) },
    ]);
    expect(samples()).toEqual([]);
  });

  it("stores an old unlabelled Codex line with no reset as window-less evidence, never as a current reading", () => {
    const id = "0199d643-0000-7000-8000-000000000001";
    const file = writeRollout(codexDir, id, "2025-10-12T02:33:04.110Z", [
      sessionMetaLine({ id, timestamp: "2025-10-12T02:33:04.110Z", cliVersion: "0.45.0-alpha.5" }),
      oldTokenCountLine("2025-10-12T02:33:06.507Z", 5, 2),
    ]);
    const [primary, secondary] = stored(ingest({ source: "codex-rollout", file }, T0).outcomes);
    expect(primary).toMatchObject({
      limitKey: "unlabelled.primary",
      windowId: null,
      resetsAt: null,
      resetsAtSource: null,
      // Exactly as reported: 299 minutes, never rounded to 300.
      windowSeconds: 299 * 60,
      windowSecondsSource: "observed",
      confidence: "low",
      source: { kind: "codex_rollout", harnessVersion: "0.45.0-alpha.5", field: "payload.rate_limits.primary" },
    });
    expect(primary!.missing).toMatchObject({ windowId: "reset_not_reported", resetsAt: "reset_not_reported" });
    expect(secondary).toMatchObject({ limitKey: "unlabelled.secondary", windowSeconds: 10079 * 60, windowId: null });
    expect(withStore((store) => store.listWindows())).toEqual([]);
  });

  it("gives every null measurable field a reason, and no field with a value a reason", () => {
    const id = "22222222-0000-7000-8000-000000000002";
    const file = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 3000), primary: { used_percent: 6, window_minutes: 300, resets_at: epoch("2026-09-24T19:00:00Z") }, secondary: null }),
      oldTokenCountLine(after(T0, 9000), 5, 2),
    ]);
    ingest({ source: "codex-rollout", file }, T0);
    ingest(
      { source: "claude-statusline", input: statusline({ rate_limits: { spend_limit: { used_percentage: 112.5, resets_at: FIVE_HOUR_RESET } } }) },
      T0,
    );
    ingest({ source: "manual", account: "personal-max", limitKey: "five_hour", used: "30" }, T0);
    const measurable = ["windowId", "usedPercent", "remainingPercent", "exceeded", "resetsAt", "windowSeconds", "sessionRef", "attemptId"] as const;
    const all = samples();
    expect(all.length).toBeGreaterThanOrEqual(5);
    for (const sample of all) {
      for (const field of measurable) {
        if (sample[field] === null) expect(sample.missing[field], `${sample.limitKey}.${field}`).toEqual(expect.any(String));
        else expect(sample.missing[field], `${sample.limitKey}.${field}`).toBeUndefined();
      }
      // Attempts are not linked in this build: nothing matches, and it says so.
      expect(sample.missing.attemptId).toBe("no_matching_attempt");
    }
    const spend = all.find((s) => s.limitKey === "spend_limit")!;
    expect(spend.missing.windowSeconds).toBe("not_reported_by_source");
    const window = withStore((store) => store.getWindow(spend.windowId!))!;
    expect(window).toMatchObject({ windowSeconds: null, startsAt: null, planTier: null, label: null });
    expect(window.missing).toEqual({ windowSeconds: "not_reported_by_source", startsAt: "not_reported_by_source", planTier: "not_reported_by_source" });
  });
});

// ------------------------------------------------------------------ units and normalization

describe("samples normalize remaining capacity to percentages", () => {
  beforeEach(optIn);

  it("keeps usedPercent as reported (fractions, above 100) and derives remaining and exceeded by arithmetic alone", () => {
    const input = statusline({
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: FIVE_HOUR_RESET },
        seven_day: { used_percentage: 100, resets_at: SEVEN_DAY_RESET },
        spend_limit: { used_percentage: 112.5, resets_at: FIVE_HOUR_RESET },
      },
    });
    const byKey = Object.fromEntries(stored(ingest({ source: "claude-statusline", input }, T0).outcomes).map((s) => [s.limitKey, s]));
    expect(byKey.five_hour).toMatchObject({ unit: "percent_of_limit", usedPercent: 23.5, remainingPercent: 76.5, exceeded: false, method: "observed" });
    expect(byKey.seven_day).toMatchObject({ usedPercent: 100, remainingPercent: 0, exceeded: true });
    expect(byKey.spend_limit).toMatchObject({ usedPercent: 112.5, remainingPercent: 0, exceeded: true });
  });

  it("retains provider identity on every sample and window", () => {
    ingest({ source: "claude-statusline", input: statusline() }, T0);
    const sample = samples().find((s) => s.limitKey === "five_hour");
    expect(sample).toMatchObject({ provider: "anthropic", accountRef: "personal-max", source: { kind: "claude_code_statusline", harnessVersion: "2.1.281", field: "rate_limits.five_hour" } });
    expect(withStore((store) => store.getWindow(sample!.windowId!))).toMatchObject({ provider: "anthropic", accountRef: "personal-max", limitKey: "five_hour" });
  });
});

// ------------------------------------------------------------------ resets are absolute

describe("a reset is an absolute instant that keeps its provider source", () => {
  beforeEach(optIn);

  it("converts the status line's epoch seconds exactly and marks it observed_absolute", () => {
    const [five, seven] = stored(ingest({ source: "claude-statusline", input: statusline() }, T0).outcomes);
    expect(five).toMatchObject({ resetsAt: iso(FIVE_HOUR_RESET), resetsAtSource: "observed_absolute", confidence: "high", observedAt: T0, observedAtSource: "capture" });
    expect(seven!.resetsAt).toBe(iso(SEVEN_DAY_RESET));
    const window = withStore((store) => store.getWindow(five!.windowId!))!;
    expect(window).toMatchObject({
      resetsAt: iso(FIVE_HOUR_RESET),
      resetsAtSource: "observed_absolute",
      windowSeconds: 18000,
      windowSecondsSource: "documented",
      label: "5h",
      anchor: "unknown",
      // Only an OBSERVED length places the start.
      startsAt: null,
    });
  });

  it("converts a relative reset typed from a screen at capture time, marks it, and lowers the confidence", () => {
    const [relative] = stored(ingest({ source: "manual", account: "personal-max", provider: "anthropic", limitKey: "five_hour", used: 30, resetsAt: "3h" }, T0).outcomes);
    expect(relative).toMatchObject({ resetsAt: "2026-09-24T17:00:00.000Z", resetsAtSource: "derived_from_relative", confidence: "low", source: { kind: "operator_manual" } });
    const [absolute] = stored(ingest({ source: "manual", account: "other", provider: "anthropic", limitKey: "five_hour", used: 30, resetsAt: "2026-09-24T17:00:00Z" }, T0).outcomes);
    expect(absolute).toMatchObject({ resetsAtSource: "observed_absolute", confidence: "medium" });
  });

  it("converts a Codex relative reset at the line's own timestamp, never at ingestion", () => {
    const id = "33333333-0000-7000-8000-000000000001";
    const line = "2026-09-20T08:00:00.000Z";
    const file = writeRollout(codexDir, id, line, [
      sessionMetaLine({ id, timestamp: line }),
      tokenCountLine({ timestamp: after(line, 1500), primary: { used_percent: 12, window_minutes: 300, resets_at: null, resets_in_seconds: 3600 }, secondary: null }),
    ]);
    // Ingested four days later.
    const [sample] = stored(ingest({ source: "codex-rollout", file }, T0).outcomes);
    expect(sample).toMatchObject({ resetsAt: after(line, 1500 + 3600_000), resetsAtSource: "derived_from_relative", confidence: "low", observedAt: after(line, 1500), observedAtSource: "provider" });
  });

  it("places a Codex window by its observed length and keeps the plan tier", () => {
    const id = "33333333-0000-7000-8000-000000000002";
    const reset = "2026-09-24T19:04:29.000Z";
    const file = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({
        timestamp: after(T0, 4000),
        primary: { used_percent: 6, window_minutes: 300, resets_at: epoch(reset) },
        secondary: { used_percent: 1, window_minutes: 10080, resets_at: epoch("2026-09-30T12:00:00Z") },
      }),
    ]);
    const [primary, secondary] = stored(ingest({ source: "codex-rollout", file }, T0).outcomes);
    expect(primary).toMatchObject({ limitKey: "codex.primary", confidence: "medium", windowSeconds: 18000, windowSecondsSource: "observed" });
    const window = withStore((store) => store.getWindow(primary!.windowId!))!;
    expect(window).toMatchObject({ limitKey: "codex.primary", label: "5h", resetsAt: reset, startsAt: "2026-09-24T14:04:29.000Z", planTier: "plus", missing: {} });
    expect(withStore((store) => store.getWindow(secondary!.windowId!))).toMatchObject({ limitKey: "codex.secondary", label: "7d" });
  });
});

// ------------------------------------------------------------------ Codex forks

describe("Codex fork-copied history is skipped, only as the leading run", () => {
  beforeEach(optIn);

  const PARENT = "01a0216a-0000-7c00-8f4b-000000000001";
  const CHILD = "01a0216c-0000-7e20-8e9f-000000000002";
  const RESET = epoch("2026-08-27T23:22:37Z");
  const week = (used: number, reset = RESET) => ({ used_percent: used, window_minutes: 10080, resets_at: reset });
  const PARENT_START = "2026-08-20T22:40:00.000Z";
  // The fork instant is the OUTER timestamp of the child's session_meta.
  const FORK = "2026-08-20T23:05:41.200Z";

  /** The parent keeps running after the fork, and sees the same account percentages. */
  function parent(lines: string[] = []): void {
    writeRollout(codexDir, PARENT, PARENT_START, [
      sessionMetaLine({ id: PARENT, timestamp: PARENT_START }),
      responseItemLine(after(PARENT_START, 1000), "a prompt ingestion must not read"),
      tokenCountLine({ timestamp: "2026-08-20T22:50:00.000Z", primary: week(1), secondary: null }),
      tokenCountLine({ timestamp: "2026-08-20T22:55:00.000Z", primary: week(2), secondary: null }),
      // One second of reset jitter, as measured in real rollouts.
      tokenCountLine({ timestamp: "2026-08-20T23:00:00.000Z", primary: week(2, RESET + 1), secondary: null }),
      // AFTER the fork instant: excluded from the copy test.
      tokenCountLine({ timestamp: after(FORK, 5000), primary: week(3), secondary: null }),
      ...lines,
    ]);
  }

  it("skips copies stamped 1 ms after the fork and a later copy matched by pre-fork content, and keeps the rest", () => {
    parent();
    const file = writeRollout(codexDir, CHILD, FORK, [
      sessionMetaLine({ id: CHILD, timestamp: FORK, forkedFromId: PARENT, cliVersion: "0.149.0" }),
      tokenCountLine({ timestamp: after(FORK, 1), primary: week(1), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 1), primary: week(2), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 1), primary: week(2, RESET + 1), secondary: null }),
      // 13.6 s later, outside any burst, but equal to a reading the parent took before the fork.
      tokenCountLine({ timestamp: after(FORK, 13_645), primary: week(2, RESET + 1), secondary: null }),
      // The fork's own first reading. Equal to a parent reading taken AFTER the fork: kept.
      tokenCountLine({ timestamp: after(FORK, 20_676), primary: week(3), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 60_000), primary: week(4), secondary: null }),
      // Equal to a pre-fork parent reading, but after the leading run ended: kept.
      tokenCountLine({ timestamp: after(FORK, 90_000), primary: week(2), secondary: null }),
    ]);
    const result = ingest({ source: "codex-rollout", file }, T0);
    expect(reasons(result.outcomes).filter((r) => r === "fork_copied")).toHaveLength(4);
    expect(result.outcomes.slice(0, 4).map((o) => (o.stored ? "stored" : o.reason))).toEqual(["fork_copied", "fork_copied", "fork_copied", "fork_copied"]);
    expect(stored(result.outcomes).map((s) => [s.observedAt, s.usedPercent])).toEqual([
      [after(FORK, 20_676), 3],
      [after(FORK, 60_000), 4],
      [after(FORK, 90_000), 2],
    ]);
    // Copies are skipped, not deduplicated: none of them reached the store.
    expect(samples().some((s) => Date.parse(s.observedAt) < Date.parse(after(FORK, 20_000)))).toBe(false);
  });

  it("catches copies stamped 0 to 3 ms after the fork by the opening burst when the ancestor is missing", () => {
    // No parent file on this machine.
    const file = writeRollout(codexDir, CHILD, FORK, [
      sessionMetaLine({ id: CHILD, timestamp: FORK, forkedFromId: PARENT }),
      tokenCountLine({ timestamp: FORK, primary: week(36), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 1), primary: week(51), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 2), primary: week(70), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 3), primary: week(83), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 9_000), primary: week(84), secondary: null }),
    ]);
    const result = ingest({ source: "codex-rollout", file }, T0);
    expect(result.skipped).toEqual({ fork_copied: 4, not_reported_by_source: 1 });
    expect(stored(result.outcomes).map((s) => s.usedPercent)).toEqual([84]);
  });

  it("drops a fork's genuine first reading that lands inside the burst, and dates the next one by its own line", () => {
    parent();
    const file = writeRollout(codexDir, CHILD, FORK, [
      sessionMetaLine({ id: CHILD, timestamp: FORK, forkedFromId: PARENT }),
      // Same millisecond as the fork instant, content no ancestor ever had: the
      // documented loss of the heuristic. One reading lost, none mis-dated.
      tokenCountLine({ timestamp: FORK, primary: week(9), secondary: null }),
      tokenCountLine({ timestamp: after(FORK, 4_000), primary: week(10), secondary: null }),
    ]);
    const result = ingest({ source: "codex-rollout", file }, T0);
    expect(reasons(result.outcomes)).toEqual(["fork_copied", "not_reported_by_source"]);
    expect(stored(result.outcomes).map((s) => [s.observedAt, s.usedPercent])).toEqual([[after(FORK, 4_000), 10]]);
  });

  it("walks the ancestor chain: a fork of a fork skips a copy only the grandparent explains", () => {
    const GRAND = "01a05d56-0000-7000-8000-000000000003";
    const MIDDLE = "01a05d7c-0000-7000-8000-000000000004";
    const grandStart = "2026-09-03T22:40:00.000Z";
    const middleFork = "2026-09-03T23:09:38.449Z";
    const childFork = "2026-09-03T23:12:20.277Z";
    const r = epoch("2026-09-04T03:29:47Z");
    const five = (used: number) => ({ used_percent: used, window_minutes: 300, resets_at: r });
    writeRollout(codexDir, GRAND, grandStart, [
      sessionMetaLine({ id: GRAND, timestamp: grandStart }),
      tokenCountLine({ timestamp: "2026-09-03T23:00:00.000Z", primary: five(4), secondary: null }),
    ]);
    // The middle fork's copied history was trimmed: it holds only its own later readings.
    writeRollout(codexDir, MIDDLE, middleFork, [
      sessionMetaLine({ id: MIDDLE, timestamp: middleFork, forkedFromId: GRAND }),
      tokenCountLine({ timestamp: after(middleFork, 30_000), primary: five(5), secondary: null }),
    ]);
    const file = writeRollout(codexDir, CHILD, childFork, [
      sessionMetaLine({ id: CHILD, timestamp: childFork, forkedFromId: MIDDLE }),
      // 8.2 s after the fork (the real gap), equal to the GRANDPARENT's pre-fork reading.
      tokenCountLine({ timestamp: after(childFork, 8_231), primary: five(4), secondary: null }),
      tokenCountLine({ timestamp: after(childFork, 22_245), primary: five(6), secondary: null }),
    ]);
    const result = ingest({ source: "codex-rollout", file }, T0);
    expect(result.outcomes[0]).toMatchObject({ stored: false, reason: "fork_copied" });
    expect(stored(result.outcomes).map((s) => s.usedPercent)).toEqual([6]);
  });

  it("hashes the fork's own id as its session, not the parent's session_id", () => {
    parent();
    const file = writeRollout(codexDir, CHILD, FORK, [
      sessionMetaLine({ id: CHILD, timestamp: FORK, forkedFromId: PARENT }),
      tokenCountLine({ timestamp: after(FORK, 20_000), primary: week(7), secondary: null }),
    ]);
    const [sample] = stored(ingest({ source: "codex-rollout", file }, T0).outcomes);
    expect(sample!.sessionRef).toBe(createHash("sha256").update(`codex:${CHILD}`).digest("hex").slice(0, 16));
  });

  it("stores nothing twice when the same rollout is replayed", () => {
    parent();
    const parentFile = writeRollout(codexDir, PARENT, PARENT_START, [
      sessionMetaLine({ id: PARENT, timestamp: PARENT_START }),
      tokenCountLine({ timestamp: "2026-08-20T22:50:00.000Z", primary: week(1), secondary: null }),
      tokenCountLine({ timestamp: "2026-08-20T22:55:00.000Z", primary: week(2), secondary: null }),
      tokenCountLine({ timestamp: "2026-08-20T23:30:00.000Z", primary: week(2), secondary: null }),
    ]);
    const first = ingest({ source: "codex-rollout", file: parentFile }, T0);
    expect(first.storedCount).toBe(3);
    const again = ingest({ source: "codex-rollout", file: parentFile }, T0);
    expect(again.storedCount).toBe(0);
    expect(again.skipped).toEqual({ unchanged: 3, not_reported_by_source: 3 });
    expect(samples()).toHaveLength(3);
  });
});

// ------------------------------------------------------------------ window identity

describe("window identity", () => {
  beforeEach(optIn);

  const five = (used: number, resetsAt: number) =>
    statusline({ rate_limits: { five_hour: { used_percentage: used, resets_at: resetsAt } } });

  it("joins a reset that jitters within the tolerance, and opens a new instance, superseding the old, when it moves further", () => {
    const first = stored(ingest({ source: "claude-statusline", input: five(20, FIVE_HOUR_RESET) }, T0).outcomes)[0]!;
    // 17 s of jitter, the largest seen in recorded samples: the same window, and the same reading.
    const jitter = ingest({ source: "claude-statusline", input: five(20, FIVE_HOUR_RESET + 17) }, after(T0, 30_000));
    expect(reasons(jitter.outcomes)).toEqual(["unchanged"]);
    const joined = stored(ingest({ source: "claude-statusline", input: five(21, FIVE_HOUR_RESET + 17) }, after(T0, 40_000)).outcomes)[0]!;
    expect(joined.windowId).toBe(first.windowId);

    // A provider-side reset moves it an hour while the window is current.
    const moved = stored(ingest({ source: "claude-statusline", input: five(2, FIVE_HOUR_RESET + 3600) }, after(T0, 60_000)).outcomes)[0]!;
    expect(moved.windowId).not.toBe(first.windowId);
    const [old, replacement] = withStore((store) => [store.getWindow(first.windowId!, after(T0, 60_000)), store.getWindow(moved.windowId!, after(T0, 60_000))]);
    expect(old).toMatchObject({ supersededBy: moved.windowId, supersededReason: "reset_moved", status: "superseded" });
    expect(replacement).toMatchObject({ supersededBy: null, status: "current" });
    // Both readings are kept: staple does not decide which one was right.
    expect(samples()).toHaveLength(3);
  });

  it("opens the next instance without superseding once the previous one has elapsed", () => {
    const first = stored(ingest({ source: "claude-statusline", input: five(80, FIVE_HOUR_RESET) }, T0).outcomes)[0]!;
    const afterReset = iso(FIVE_HOUR_RESET + 60);
    const next = stored(ingest({ source: "claude-statusline", input: five(3, FIVE_HOUR_RESET + 5 * 3600) }, afterReset).outcomes)[0]!;
    expect(next.windowId).not.toBe(first.windowId);
    expect(withStore((store) => store.getWindow(first.windowId!, afterReset))).toMatchObject({ supersededBy: null, status: "elapsed" });
  });
});

// ------------------------------------------------------------------ cadence

describe("ingestion cadence, per window and harness session", () => {
  beforeEach(optIn);

  const render = (sessionId: string, used: number, resetsAt = FIVE_HOUR_RESET) =>
    statusline({ session_id: sessionId, rate_limits: { five_hour: { used_percentage: used, resets_at: resetsAt } } });

  it("stores a change, skips a re-render, and stores an unchanged reading as a heartbeat once the last is over 300 s old", () => {
    const at = (s: number) => after(T0, s * 1000);
    const run = (used: number, seconds: number, resetsAt?: number) =>
      ingest({ source: "claude-statusline", input: render("session-a", used, resetsAt) }, at(seconds)).outcomes[0]!;
    expect(run(23.5, 0).stored).toBe(true);
    expect(run(23.5, 30)).toMatchObject({ stored: false, reason: "unchanged" });
    expect(run(23.5, 60, FIVE_HOUR_RESET + 17)).toMatchObject({ stored: false, reason: "unchanged" });
    expect(run(23.5, 300)).toMatchObject({ stored: false, reason: "unchanged" });
    const heartbeat = run(23.5, 301);
    expect(heartbeat).toMatchObject({ stored: true, sample: { heartbeat: true, usedPercent: 23.5, observedAtSource: "capture" } });
    expect(run(23.5, 320)).toMatchObject({ stored: false, reason: "unchanged" });
    expect(run(24, 330)).toMatchObject({ stored: true, sample: { heartbeat: false, usedPercent: 24 } });
  });

  it("compares each session with its own latest reading, so two alternating caches do not store every render", () => {
    const a = (used: number, s: number) => ingest({ source: "claude-statusline", input: render("session-a", used) }, after(T0, s * 1000)).outcomes[0]!;
    const b = (used: number, s: number) => ingest({ source: "claude-statusline", input: render("session-b", used) }, after(T0, s * 1000)).outcomes[0]!;
    expect(a(40, 0).stored).toBe(true);
    expect(b(40, 5).stored).toBe(true); // B's first reading, although A just said the same
    expect(a(40, 10)).toMatchObject({ stored: false, reason: "unchanged" });
    expect(b(35, 15).stored).toBe(true);
    expect(a(40, 20)).toMatchObject({ stored: false, reason: "unchanged" });
    expect(b(35, 25)).toMatchObject({ stored: false, reason: "unchanged" });
    expect(samples()).toHaveLength(3);
  });

  it("compares a backfilled reading with its neighbour by observedAt, not with the latest one recorded", () => {
    const id = "44444444-0000-7000-8000-000000000001";
    const r = epoch("2026-09-24T19:00:00Z");
    const later = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 600_000), primary: { used_percent: 5, window_minutes: 300, resets_at: r }, secondary: null }),
    ]);
    ingest({ source: "codex-rollout", file: later }, T0);
    // The same session's earlier line arrives second (the file grew at its head in this
    // fixture, as a restored backup would). Nothing earlier is stored, so it is kept.
    writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 5_000), primary: { used_percent: 5, window_minutes: 300, resets_at: r }, secondary: null }),
    ]);
    const backfill = ingest({ source: "codex-rollout", file: later }, T0);
    expect(stored(backfill.outcomes).map((s) => s.observedAt)).toEqual([after(T0, 5_000)]);
  });
});

// ------------------------------------------------------------------ regressions

describe("regressions within a window", () => {
  beforeEach(optIn);

  it("stores every reading as reported, flags a reading below the running high-water, and reads current pressure at high-water", () => {
    const render = (sessionId: string, used: number, s: number) =>
      ingest(
        { source: "claude-statusline", input: statusline({ session_id: sessionId, rate_limits: { five_hour: { used_percentage: used, resets_at: FIVE_HOUR_RESET } } }) },
        after(T0, s * 1000),
      );
    render("session-a", 40, 0);
    render("session-b", 35, 10); // an older cache: below 40
    render("session-b", 38, 20); // above the previous reading, still below the high-water
    render("session-a", 42, 30);
    render("session-b", 39, 40); // the latest reading is not the highest
    const windowId = samples()[0]!.windowId!;
    const view = withStore((store) => store.samplesInWindow(windowId));
    expect(view.map((s) => [s.usedPercent, s.regression])).toEqual([
      [40, false],
      [35, true],
      [38, true],
      [42, false],
      [39, true],
    ]);
    expect(withStore((store) => store.windowHighWater(windowId))).toEqual({
      windowId,
      highWaterPercent: 42,
      remainingPercent: 58,
      regressionCount: 3,
      sampleCount: 5,
      missing: {},
    });
  });
});

describe("the dedup key is the last guard against storing a reading twice", () => {
  it("refuses a replayed reading even when a same-instant reading of the same session is its cadence neighbour", () => {
    // Two readings at one millisecond with different values: the shape of the real
    // copy bursts (36 then 51 under one timestamp). The cadence compares the replay with
    // the later-recorded of the two and sees a change; the dedup key still refuses it.
    const reading = (used: number) => ({
      limitKey: "codex.primary",
      unit: "percent_of_limit" as const,
      usedPercent: used,
      resetsAt: "2026-09-24T19:00:00.000Z",
      resetsAtSource: "observed_absolute" as const,
      windowSeconds: 18000,
      windowSecondsSource: "observed" as const,
      planTier: "plus",
      method: "observed" as const,
      confidence: "medium" as const,
      source: { kind: "codex_rollout" as const, harnessVersion: "0.156.1", field: "payload.rate_limits.primary" },
      observedAt: T0,
      observedAtSource: "provider" as const,
      sessionRef: "4be07a51f2e39c1d",
      missing: {},
    });
    const input = (used: number, recordedAt: string) => ({ reading: reading(used), provider: "openai", accountRef: "codex-plus", recordedAt, attempt: { reason: "no_matching_attempt" as const } });
    withStore((store) => {
      expect(store.record(input(36, after(T0, 10))).stored).toBe(true);
      expect(store.record(input(51, after(T0, 20))).stored).toBe(true);
      expect(store.record(input(36, after(T0, 30)))).toMatchObject({ stored: false, reason: "unchanged" });
      expect(store.listSamples()).toHaveLength(2);
    });
  });
});

// ------------------------------------------------------------------ formats and privacy

describe("the dedup key and sessionRef are the contract's digests", () => {
  beforeEach(optIn);

  const sha = (text: string, chars: number) => createHash("sha256").update(text, "utf8").digest("hex").slice(0, chars);

  it("hashes the compact JSON tuple, with numbers as JSON writes them and null for a missing value", () => {
    const [five] = stored(ingest({ source: "claude-statusline", input: statusline() }, T0).outcomes);
    const ref = sha(`claude_code:${STATUSLINE_SESSION_ID}`, 16);
    expect(five!.sessionRef).toBe(ref);
    expect(five!.dedupKey).toBe(sha(`["claude_code_statusline","personal-max","five_hour","${ref}","${iso(FIVE_HOUR_RESET)}",23.5,"${T0}"]`, 32));

    const id = "55555555-0000-7000-8000-000000000001";
    const file = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      tokenCountLine({ timestamp: after(T0, 1234), primary: { used_percent: 6.0, window_minutes: 300, resets_at: epoch("2026-09-24T19:04:29Z") }, secondary: null }),
    ]);
    const [codex] = stored(ingest({ source: "codex-rollout", file }, T0).outcomes);
    const codexRef = sha(`codex:${id}`, 16);
    expect(codex!.dedupKey).toBe(sha(`["codex_rollout","codex-plus","codex.primary","${codexRef}","2026-09-24T19:04:29.000Z",6,"${after(T0, 1234)}"]`, 32));

    const [manual] = stored(ingest({ source: "manual", account: "personal-max", limitKey: "seven_day", used: 41 }, T0).outcomes);
    expect(manual!.dedupKey).toBe(sha(`["operator_manual","personal-max","seven_day",null,null,41,"${T0}"]`, 32));
  });
});

describe("privacy: inputs are parsed for their rate-limit fields and the rest is discarded", () => {
  beforeEach(optIn);

  it("keeps no raw session id, path, repository or prompt text anywhere in hub.db", () => {
    ingest({ source: "claude-statusline", input: statusline() }, T0);
    const id = "66666666-0000-7000-8000-000000000001";
    const file = writeRollout(codexDir, id, T0, [
      sessionMetaLine({ id, timestamp: T0 }),
      responseItemLine(after(T0, 100), "SECRET PROMPT TEXT"),
      tokenCountLine({ timestamp: after(T0, 2000), primary: { used_percent: 6, window_minutes: 300, resets_at: epoch("2026-09-24T19:00:00Z") }, secondary: null }),
    ]);
    ingest({ source: "codex-rollout", file }, T0);
    const dump = withStore((store) =>
      JSON.stringify([
        store.db.prepare("SELECT * FROM budget_samples").all(),
        store.db.prepare("SELECT * FROM limit_windows").all(),
      ]),
    );
    for (const secret of [STATUSLINE_SESSION_ID, id, "/home/operator", "example-repo", "example-owner", "SECRET PROMPT", codexDir, claudeDir]) {
      expect(dump, secret).not.toContain(secret);
    }
  });
});

describe("budget data does not leave the machine", () => {
  it("is named by no sync, journal or Worker code, so nothing can carry it", () => {
    const roots = [join(REPO_ROOT, "src", "core", "cloud"), join(REPO_ROOT, "worker", "src")];
    const offenders = roots
      .flatMap((root) => sourceFiles(root))
      .filter((file) => /budget_samples|limit_windows|BudgetStore|core\/telemetry/.test(readCode(file)));
    expect(offenders).toEqual([]);
  });
});
