/**
 * Removing budget readings (`staple budget forget`, `forget_budget_samples`, `POST
 * /api/budget/forget`; docs/execution-telemetry.md, "Removing a reading").
 *
 * The case this exists for happened on a real machine. While a status-line wrapper was
 * being verified, a synthetic status-line JSON was piped through the live ingest. It
 * stored a fake seven_day reading (30% used, resets 02:23:55) whose reset was about
 * 1.5 h before the real one (35%, resets 04:00). The fake opened a window of its own, and
 * because it was observed after the real window's first reading, it superseded the real
 * window. It then read as current ("70% left"), while the real readings kept joining a
 * window marked superseded.
 *
 * Every reading here goes through the real status-line and rollout sources and
 * `BudgetStore.record`. Every removal goes through `forgetBudgetSamples`. No row is
 * written by hand.
 */
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SurfaceAutoSync } from "../src/core/cloud/auto-triggers.js";
import type { WorkspaceStore } from "../src/core/store.js";
import { attemptLinkerFor } from "../src/core/telemetry/attempt-link.js";
import { bindBudgetSource, setBudgetCapture } from "../src/core/telemetry/budget-config.js";
import { forgetBudgetSamples, type ForgetResult } from "../src/core/telemetry/budget-forget.js";
import { collectLogPath } from "../src/core/telemetry/collection/codex-collect.js";
import { ingestBudget } from "../src/core/telemetry/ingest.js";
import { listBudgetSamples, readBudget, type LimitReading } from "../src/core/telemetry/read-budget.js";
import { StapleError, setClock } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, type UiHandle } from "../src/ui/server.js";
import { CLI_ENTRY, REPO_ROOT, TSX_CLI, bareEnv } from "./fixtures/characterize-support.js";
import { spawnAsync } from "./fixtures/spawn-async.js";
import { mcpEnvelope, startMcpClient, toolPayload, type McpHarness } from "./fixtures/contract-support.js";
import { STATUSLINE_SESSION_ID, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./fixtures/budget-support.js";

/**
 * Ids are random UUIDs, so two sharing an 8-character prefix cannot be arranged by chance.
 * While `uuid.prefix` is set, every id minted in this process starts with it; otherwise
 * ids are the real random ones. The CLI and MCP children are not affected.
 */
const uuid = vi.hoisted(() => ({ prefix: null as string | null, n: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => (uuid.prefix === null ? actual.randomUUID() : `${uuid.prefix}-0000-4000-8000-${(uuid.n++).toString(16).padStart(12, "0")}`),
  };
});

/** The fake payload's session: another Claude Code session on the same config dir. */
const FAKE_SESSION = "77777777-0000-7000-8000-000000000001";

const REAL_SEVEN_DAY_RESET = "2026-10-01T04:00:00.000Z";
const FAKE_SEVEN_DAY_RESET = "2026-10-01T02:23:55.000Z";
const FIVE_HOUR_RESET = "2026-09-26T13:00:00.000Z";
const FAKE_OBSERVED_AT = "2026-09-26T11:17:15.482Z";

let home: string;
let claudeDir: string;
let codexDir: string;

function newHome(): void {
  home = mkdtempSync(join(tmpdir(), "staple-forget-home-"));
  claudeDir = join(home, "claude");
  codexDir = join(home, "codex");
  mkdirSync(claudeDir);
  mkdirSync(codexDir);
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: "claude-max", configDir: claudeDir });
}

/** One status-line render, ingested as Claude Code sends it at `at`. */
function render(at: string, session: string, sevenDay: [number, string], fiveHour: [number, string]): ReturnType<typeof ingestBudget> {
  const input = statusline({
    session_id: session,
    rate_limits: {
      five_hour: { used_percentage: fiveHour[0], resets_at: epoch(fiveHour[1]) },
      seven_day: { used_percentage: sevenDay[0], resets_at: epoch(sevenDay[1]) },
    },
  });
  return ingestBudget({ source: "claude-statusline", input, configDir: claudeDir }, { home, attemptLinker: attemptLinkerFor(home), now: () => at });
}

/**
 * The real machine's shape. Two real renders, then the fake one at the observed instant
 * with its seven_day reset about 1.5 h early, then a real render after it. The fake
 * five_hour reading carries the real reset, so it joins the real five_hour window. It is
 * the highest reading there, which makes the high-water mark wrong as well.
 */
function scenario(): { fakeIds: string[]; fakeSevenDay: string; fakeFiveHour: string } {
  render("2026-09-26T09:00:00.000Z", STATUSLINE_SESSION_ID, [34, REAL_SEVEN_DAY_RESET], [10, FIVE_HOUR_RESET]);
  render("2026-09-26T10:30:00.000Z", STATUSLINE_SESSION_ID, [34.5, REAL_SEVEN_DAY_RESET], [15, FIVE_HOUR_RESET]);
  const fake = render(FAKE_OBSERVED_AT, FAKE_SESSION, [30, FAKE_SEVEN_DAY_RESET], [55, FIVE_HOUR_RESET]);
  render("2026-09-26T11:30:00.000Z", STATUSLINE_SESSION_ID, [35, REAL_SEVEN_DAY_RESET], [20, FIVE_HOUR_RESET]);
  const stored = fake.outcomes.filter((o) => o.stored).map((o) => (o as Extract<typeof o, { stored: true }>).sample);
  expect(stored.map((s) => s.limitKey).sort()).toEqual(["five_hour", "seven_day"]);
  const fakeSevenDay = stored.find((s) => s.limitKey === "seven_day")!.id;
  const fakeFiveHour = stored.find((s) => s.limitKey === "five_hour")!.id;
  return { fakeIds: [fakeSevenDay, fakeFiveHour], fakeSevenDay, fakeFiveHour };
}

const NOW = "2026-09-26T11:31:00.000Z";

function limit(key: string, now = NOW): LimitReading {
  const view = readBudget(home, { now, account: "claude-max" });
  const found = view.accounts[0]!.limits.find((entry) => entry.limitKey === key);
  expect(found, key).toBeDefined();
  return found!;
}

function counts(): { samples: number; windows: number; forgotten: number } {
  const db = new DatabaseSync(join(home, "hub.db"), { readOnly: true });
  try {
    const n = (table: string): number => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return { samples: n("budget_samples"), windows: n("limit_windows"), forgotten: n("budget_forgotten") };
  } finally {
    db.close();
  }
}

const forget = (ids: readonly string[], confirm: boolean): ForgetResult => forgetBudgetSamples({ ids, confirm, via: "cli" }, { home, now: () => NOW });

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

describe("forgetting the fake status-line readings", () => {
  beforeEach(newHome);
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("reproduces the false current window the fake opened", () => {
    scenario();
    const sevenDay = limit("seven_day");
    // The bug: the fake window is current, and the real one is superseded by it.
    expect(sevenDay).toMatchObject({ status: "current", remainingPercent: 70, highWaterPercent: 30 });
    expect(sevenDay.window!.resetsAt).toBe(FAKE_SEVEN_DAY_RESET);
    expect(limit("five_hour")).toMatchObject({ highWaterPercent: 55, remainingPercent: 45 });
  });

  it("previews without consent: the readings, their windows, and the real window current after; nothing is removed", () => {
    const { fakeIds, fakeSevenDay } = scenario();
    const before = counts();
    const viewBefore = readBudget(home, { now: NOW });
    const preview = forget(fakeIds.map((id) => id.slice(0, 9)), false);
    expect(preview.applied).toBe(false);
    expect(preview.auditLog).toBeNull();
    expect(preview.readings.map((r) => r.id).sort()).toEqual([...fakeIds].sort());
    expect(preview.readings.find((r) => r.id === fakeSevenDay)).toMatchObject({ usedPercent: 30, resetsAt: FAKE_SEVEN_DAY_RESET, observedAt: FAKE_OBSERVED_AT });
    const sevenDay = preview.limits.find((l) => l.limitKey === "seven_day")!;
    expect(sevenDay.before).toMatchObject({ status: "current", remainingPercent: 70, window: { resetsAt: FAKE_SEVEN_DAY_RESET } });
    expect(sevenDay.after).toMatchObject({ status: "current", remainingPercent: 65, highWaterPercent: 35, window: { resetsAt: REAL_SEVEN_DAY_RESET, supersededBy: null }, latestSample: { usedPercent: 35 } });
    const removed = preview.windows.find((w) => w.limitKey === "seven_day")!;
    expect(removed).toMatchObject({ outcome: "removed", samplesLeft: 0, resetsAt: FAKE_SEVEN_DAY_RESET });
    expect(removed.released).toEqual([{ windowId: sevenDay.after.window!.id, resetsAt: REAL_SEVEN_DAY_RESET, supersededBy: null }]);
    expect(preview.windows.find((w) => w.limitKey === "five_hour")).toMatchObject({ outcome: "kept", samplesLeft: 3 });
    // Nothing changed: rows, the read and the budget log.
    expect(counts()).toEqual(before);
    expect(readBudget(home, { now: NOW })).toEqual(viewBefore);
    expect(existsSync(collectLogPath(home))).toBe(false);
  });

  it("with consent, the real seven_day window is current again in the summary, the pressure and the forecast", () => {
    const { fakeIds } = scenario();
    const result = forget(fakeIds, true);
    expect(result.applied).toBe(true);

    // The budget summary (`staple budget`, get_budget, GET /api/budget, the pressure panel's data).
    const sevenDay = limit("seven_day");
    expect(sevenDay).toMatchObject({ status: "current", highWaterPercent: 35, remainingPercent: 65, regressionCount: 0, sampleCount: 3 });
    expect(sevenDay.window).toMatchObject({ resetsAt: REAL_SEVEN_DAY_RESET, supersededBy: null, supersededReason: null, status: "current" });
    expect(sevenDay.latestSample).toMatchObject({ usedPercent: 35, observedAt: "2026-09-26T11:30:00.000Z" });
    // The pressure is read off the real window: its reset and its readings.
    expect(sevenDay.pressure.secondsToReset).toBe((Date.parse(REAL_SEVEN_DAY_RESET) - Date.parse(NOW)) / 1000);
    expect(sevenDay.pressure.observed).toMatchObject({ fromPercent: 34, toPercent: 35, readings: 3 });
    // The five_hour high-water is recomputed at read from the readings left.
    expect(limit("five_hour")).toMatchObject({ status: "current", highWaterPercent: 20, remainingPercent: 80, regressionCount: 0, sampleCount: 3 });
    // History no longer holds them, and no window is left without a reading.
    const history = listBudgetSamples(home, { account: "claude-max", now: NOW });
    expect(history.items.map((s) => s.id).filter((id) => fakeIds.includes(id))).toEqual([]);
    expect(counts()).toEqual({ samples: 6, windows: 2, forgotten: 2 });
  });

  it("the forecast reports the real window as current", () => {
    const root = mkdtempSync(join(tmpdir(), "staple-forget-root-"));
    const saved = { home: process.env.STAPLE_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
    process.env.STAPLE_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    setClock(() => Date.parse(NOW));
    let store: WorkspaceStore | null = null;
    try {
      const { fakeIds } = scenario();
      mkdirSync(join(root, "ws"));
      store = initWorkspace({ dir: join(root, "ws"), slug: "ws" }).store;
      const issue = store.createIssue({ title: "next", estimatedSeconds: 3600 });
      const sevenDayOf = () => store!.forecast({ ref: issue.identifier }, NOW, home).budget.accounts.find((a) => a.accountRef === "claude-max")!.limits.find((l) => l.limitKey === "seven_day")!;
      expect(sevenDayOf()).toMatchObject({ status: "current", resetsAt: FAKE_SEVEN_DAY_RESET, remainingPercent: 70 });
      forget(fakeIds, true);
      expect(sevenDayOf()).toMatchObject({ status: "current", resetsAt: REAL_SEVEN_DAY_RESET, remainingPercent: 65, highWaterPercent: 35 });
    } finally {
      setClock(null);
      store?.db.close();
      rmSync(root, { recursive: true, force: true });
      for (const [key, value] of [["STAPLE_HOME", saved.home], ["CLAUDE_CONFIG_DIR", saved.claude]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("writes one audit line to the budget log", () => {
    const { fakeIds } = scenario();
    const result = forget(fakeIds, true);
    expect(result.auditLog).toBe(collectLogPath(home));
    const lines = readFileSync(collectLogPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, any>);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ at: NOW, action: "forget", via: "cli" });
    expect(lines[0]!.readings.map((r: { id: string }) => r.id).sort()).toEqual([...fakeIds].sort());
    expect(lines[0]!.windows.map((w: { outcome: string }) => w.outcome).sort()).toEqual(["kept", "removed"]);
  });

  it("refuses an unknown id with not_found and removes nothing, even beside a valid one", () => {
    const { fakeIds } = scenario();
    const before = counts();
    const error = refusal(() => forget([fakeIds[0]!, "0000dead0000"], true));
    expect(error.code).toBe("not_found");
    expect(error.detail).toMatchObject({ reason: "not_found", ids: ["0000dead0000"] });
    expect(counts()).toEqual(before);
    expect(refusal(() => forget(["not-an-id!"], true)).code).toBe("not_found");
    expect(refusal(() => forget([], true)).code).toBe("validation");
    expect(counts()).toEqual(before);
  });

  it("refuses an ambiguous prefix and removes nothing", () => {
    uuid.prefix = "97379345";
    try {
      scenario();
    } finally {
      uuid.prefix = null;
    }
    const before = counts();
    const error = refusal(() => forget(["97379345"], true));
    expect(error.code).toBe("validation");
    expect(error.detail).toMatchObject({ reason: "ambiguous_id" });
    expect(error.message).toContain("Nothing was removed");
    expect(counts()).toEqual(before);
  });

  it("refuses a prefix shorter than 8 characters, even one that names a single reading", () => {
    const { fakeSevenDay } = scenario();
    const before = counts();
    for (const ref of [fakeSevenDay.slice(0, 3), fakeSevenDay.slice(0, 7), "%", "_"]) {
      const error = refusal(() => forget([ref], true));
      expect(error.code, ref).toBe("validation");
      expect(error.detail, ref).toMatchObject({ reason: "id_too_short" });
      expect(error.message, ref).toContain("at least 8 characters");
    }
    // Exactly 8 is enough.
    expect(forget([fakeSevenDay.slice(0, 8)], false).readings.map((r) => r.id)).toEqual([fakeSevenDay]);
    expect(counts()).toEqual(before);
  });

  it("never lets LIKE wildcards match: %, _ and a 9737934_ prefix name nothing", () => {
    // Every id starts 97379345, so a wildcard that reached LIKE would match all of them.
    uuid.prefix = "97379345";
    try {
      scenario();
    } finally {
      uuid.prefix = null;
    }
    const before = counts();
    for (const ref of ["9737934_", "973793%%", "%%%%%%%%", "________", "97379345%"]) {
      const error = refusal(() => forget([ref], true));
      expect(error.code, ref).toBe("not_found");
    }
    expect(counts()).toEqual(before);
  });

  it("re-derives a kept window's fields when its opening reading is the one removed", () => {
    // Two Codex sessions on one account. The first line read opens the five-hour window
    // with its own reset (60 s late, inside the tolerance), window length and plan; the
    // other session's two readings then join it. Removing the opening reading must not
    // leave the window carrying the fields only that reading reported.
    bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome: codexDir });
    const reset = "2026-09-26T14:00:00.000Z";
    const late = "2026-09-26T14:01:00.000Z";
    const line = (at: string, used: number, primaryReset: string, planType: string) =>
      tokenCountLine({
        timestamp: at,
        planType,
        primary: { used_percent: used, window_minutes: 300, resets_at: epoch(primaryReset) },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: epoch(REAL_SEVEN_DAY_RESET) },
      });
    const first = "33333333-0000-7000-8000-000000000001";
    const second = "33333333-0000-7000-8000-000000000002";
    const opener = writeRollout(codexDir, first, "2026-09-26T09:59:00.000Z", [
      sessionMetaLine({ id: first, timestamp: "2026-09-26T09:59:00.000Z" }),
      line("2026-09-26T10:00:00.000Z", 50, late, "pro"),
    ]);
    const rest = writeRollout(codexDir, second, "2026-09-26T10:04:00.000Z", [
      sessionMetaLine({ id: second, timestamp: "2026-09-26T10:04:00.000Z" }),
      line("2026-09-26T10:05:00.000Z", 10, reset, "plus"),
      line("2026-09-26T10:10:00.000Z", 12, reset, "plus"),
    ]);
    const openedBy = ingestBudget({ source: "codex-rollout", file: opener }, { home, now: () => NOW });
    ingestBudget({ source: "codex-rollout", file: rest }, { home, now: () => NOW });
    const openerId = openedBy.outcomes.map((o) => (o as Extract<typeof o, { stored: true }>).sample).find((s) => s.limitKey === "codex.primary")!.id;
    const primary = () => readBudget(home, { now: NOW, account: "codex-plus" }).accounts[0]!.limits.find((l) => l.limitKey === "codex.primary")!;
    expect(primary().window).toMatchObject({ resetsAt: late, planTier: "pro", startsAt: "2026-09-26T09:01:00.000Z", windowSeconds: 18_000 });

    const result = forget([openerId], true);
    const change = result.windows[0]!;
    expect(change).toMatchObject({ outcome: "kept", samplesLeft: 2, resetsAt: reset });
    const next = listBudgetSamples(home, { account: "codex-plus", now: NOW }).items.find((s) => s.limitKey === "codex.primary" && s.usedPercent === 10)!;
    expect(change.rederivedFrom).toBe(next.id);
    const after = primary();
    expect(after.window).toMatchObject({ resetsAt: reset, startsAt: "2026-09-26T09:00:00.000Z", windowSeconds: 18_000, windowSecondsSource: "observed", planTier: null });
    expect(after.window!.missing).toMatchObject({ planTier: "opening_reading_removed" });
    expect(after).toMatchObject({ highWaterPercent: 12, remainingPercent: 88 });
    // Removing a reading that did not open its window leaves the fields alone.
    const later = listBudgetSamples(home, { account: "codex-plus", now: NOW }).items.find((s) => s.limitKey === "codex.primary" && s.usedPercent === 12)!;
    const plain = forget([later.id], true);
    expect(plain.windows[0]).toMatchObject({ outcome: "kept", rederivedFrom: null });
  });

  it("keeps the removal when the audit line cannot be written, and says so", () => {
    const { fakeIds } = scenario();
    // `logs` is a file, so the log directory cannot be made: a real unwritable path.
    writeFileSync(join(home, "logs"), "not a directory");
    const result = forget(fakeIds, true);
    expect(result).toMatchObject({ applied: true, auditLog: null });
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("The readings were removed, but the audit line could not be written");
    expect(counts()).toMatchObject({ forgotten: 2 });
    expect(limit("seven_day").window!.resetsAt).toBe(REAL_SEVEN_DAY_RESET);
  });

  it("says on the preview that a removal cannot be undone", () => {
    const { fakeIds } = scenario();
    expect(forget(fakeIds, false).note).toMatch(/cannot be undone.*Codex rollout re-read does not bring it back/);
  });

  it("keeps a forgotten reading forgotten when the same input is replayed, and stores a new observation", () => {
    // A Codex rollout carries the provider's timestamps, so reading it again re-mints the
    // same dedup key: the case the tombstone exists for.
    bindBudgetSource(home, { source: "codex_rollout", account: "codex-plus", codexHome: codexDir });
    const session = "33333333-0000-7000-8000-000000000001";
    const file = writeRollout(codexDir, session, "2026-09-26T08:59:00.000Z", [
      sessionMetaLine({ id: session, timestamp: "2026-09-26T08:59:00.000Z" }),
      tokenCountLine({
        timestamp: "2026-09-26T09:00:00.000Z",
        primary: { used_percent: 12, window_minutes: 300, resets_at: epoch(FIVE_HOUR_RESET) },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: epoch(REAL_SEVEN_DAY_RESET) },
      }),
    ]);
    const first = ingestBudget({ source: "codex-rollout", file }, { home, now: () => NOW });
    expect(first.storedCount).toBe(2);
    const ids = first.outcomes.map((o) => (o as Extract<typeof o, { stored: true }>).sample.id);
    forget(ids, true);
    const replay = ingestBudget({ source: "codex-rollout", file }, { home, now: () => NOW });
    expect(replay).toMatchObject({ storedCount: 0, skipped: { forgotten: 2 } });
    expect(readBudget(home, { now: NOW, account: "codex-plus" }).accounts[0]!.limits).toEqual([]);

    // A status-line render is captured when it arrives: the same payload later is a new observation.
    const { fakeIds } = scenario();
    forget(fakeIds, true);
    const again = render("2026-09-26T11:40:00.000Z", FAKE_SESSION, [30, FAKE_SEVEN_DAY_RESET], [55, FIVE_HOUR_RESET]);
    expect(again.storedCount).toBe(2);
  });

  it("a window a removed window did NOT displace stays as it was", () => {
    // Remove only a real reading that shares its window with others: the window is kept,
    // no supersede link moves, and the fake window stays current.
    scenario();
    const real = listBudgetSamples(home, { account: "claude-max", now: NOW }).items.find((s) => s.limitKey === "seven_day" && s.usedPercent === 34.5)!;
    const result = forget([real.id], true);
    expect(result.windows).toEqual([expect.objectContaining({ outcome: "kept", samplesLeft: 2, released: [] })]);
    expect(limit("seven_day").window!.resetsAt).toBe(FAKE_SEVEN_DAY_RESET);
  });

  it("a released window whose overlap with a standing window is real is superseded again", () => {
    // Three instances: A (real, first), B (fake, displaced A), C (a later moved reset that
    // displaced B). Removing B releases A, and A overlaps C, which was first seen later,
    // so A is superseded again, now by C. The settle is openWindow's rule, not a blanket release.
    const A = "2026-10-01T04:00:00.000Z";
    const B = "2026-10-01T02:23:55.000Z";
    const C = "2026-10-01T06:00:00.000Z";
    render("2026-09-26T09:00:00.000Z", STATUSLINE_SESSION_ID, [34, A], [10, FIVE_HOUR_RESET]);
    const fake = render(FAKE_OBSERVED_AT, FAKE_SESSION, [30, B], [10, FIVE_HOUR_RESET]);
    render("2026-09-26T11:45:00.000Z", STATUSLINE_SESSION_ID, [36, C], [10, FIVE_HOUR_RESET]);
    const fakeId = fake.outcomes.map((o) => (o as Extract<typeof o, { stored: true }>).sample).find((s) => s?.limitKey === "seven_day")!.id;
    const result = forget([fakeId], true);
    const change = result.windows.find((w) => w.limitKey === "seven_day")!;
    expect(change.outcome).toBe("removed");
    const standing = readBudget(home, { now: NOW }).accounts[0]!.limits.find((l) => l.limitKey === "seven_day")!.window!;
    expect(standing.resetsAt).toBe(C);
    expect(change.released).toEqual([{ windowId: expect.any(String), resetsAt: A, supersededBy: standing.id }]);
    const windows = readBudget(home, { now: NOW }).accounts[0]!.limits.find((l) => l.limitKey === "seven_day")!;
    expect(windows.window!.resetsAt).toBe(C);
  });
});

// ------------------------------------------------------------------ the three surfaces

/** The CLI, without blocking: this file serves HTTP in-process (test/fixtures/spawn-async.ts). */
async function cli(args: string[]): Promise<{ status: number; stdout: string; stderr: string }> {
  const result = await spawnAsync(process.execPath, [TSX_CLI, CLI_ENTRY, "budget", ...args], {
    cwd: REPO_ROOT,
    env: bareEnv({ STAPLE_HOME: home, HOME: home, CLAUDE_CONFIG_DIR: claudeDir, CODEX_HOME: codexDir }),
    timeout: 30_000,
  });
  return { status: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** A result without the instant it was judged at, which differs between two calls. */
const shape = (result: Record<string, unknown>): Record<string, unknown> => {
  const { asOf: _asOf, auditLog: _log, ...rest } = result;
  return rest;
};

describe("CLI, MCP and HTTP call the one method", () => {
  let mcp: McpHarness;
  let ui: UiHandle;
  let origin: string;
  let root: string;
  const saved: Record<string, string | undefined> = {};

  async function http(path: string, init: { method?: string; body?: unknown; origin?: string; token?: boolean } = {}): Promise<{ status: number; body: Record<string, any> }> {
    const res = await fetch(`${origin}${path}`, {
      method: init.method ?? "POST",
      headers: {
        ...(init.token === false ? {} : { "x-staple-token": ui.token }),
        "content-type": "application/json",
        ...(init.origin ? { origin: init.origin } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  beforeAll(async () => {
    newHome();
    root = mkdtempSync(join(tmpdir(), "staple-forget-surfaces-"));
    for (const key of ["STAPLE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) saved[key] = process.env[key];
    process.env.STAPLE_HOME = home;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    process.env.CODEX_HOME = codexDir;
    const ws = initWorkspace({ dir: join(root, "repo"), slug: "forgethttp" });
    ws.store.db.close();
    ui = startUiServer({ port: 0, hub: false, db: join(root, "repo", ".staple", "staple.db") });
    await once(ui.server, "listening");
    origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
    mcp = await startMcpClient({ home, cwd: home, env: { HOME: home } });
  }, 60_000);

  afterAll(async () => {
    await mcp?.close();
    ui?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("previews the same on all three, and applies once", async () => {
    const { fakeIds } = scenario();
    const before = counts();

    // CLI without --yes: the preview, and the refusal every consent command gives (exit 2).
    const cliPreview = await cli(["forget", ...fakeIds, "--json"]);
    expect(cliPreview.status).toBe(2);
    const envelope = JSON.parse(cliPreview.stderr.trim().split("\n").pop()!) as { code: string; detail: { reason: string; preview: Record<string, unknown> } };
    expect(envelope).toMatchObject({ code: "validation", detail: { reason: "consent_required" } });
    const human = await cli(["forget", fakeIds[0]!]);
    expect(human.status).toBe(2);
    expect(human.stderr).toContain("would remove 1 reading(s)");
    expect(human.stderr).toContain("Re-run with --yes");
    expect(human.stderr).toContain("A removal cannot be undone");

    const mcpPreview = toolPayload(await mcp.call("forget_budget_samples", { ids: fakeIds })) as Record<string, unknown>;
    const httpPreview = await http("/api/budget/forget", { body: { ids: fakeIds } });
    expect(httpPreview.status).toBe(200);
    expect(mcpPreview.applied).toBe(false);
    expect(shape(mcpPreview)).toEqual(shape(envelope.detail.preview));
    expect(shape(httpPreview.body)).toEqual(shape(envelope.detail.preview));
    expect(counts()).toEqual(before);

    // MCP applies with confirm; the rest then find nothing to remove.
    const applied = toolPayload(await mcp.call("forget_budget_samples", { ids: fakeIds, confirm: true })) as Record<string, unknown>;
    expect(applied.applied).toBe(true);
    expect(counts()).toEqual({ samples: before.samples - 2, windows: before.windows - 1, forgotten: 2 });
    const log = readFileSync(collectLogPath(home), "utf8").trim().split("\n").map((line) => JSON.parse(line) as { via: string });
    expect(log.map((line) => line.via)).toEqual(["mcp"]);

    const gone = await mcp.call("forget_budget_samples", { ids: [fakeIds[0]], confirm: true });
    expect(gone.isError).toBe(true);
    expect(mcpEnvelope(gone)).toMatchObject({ code: "not_found" });
    expect((await http("/api/budget/forget", { body: { ids: [fakeIds[0]], confirm: true } })).status).toBe(404);
    expect((await cli(["forget", fakeIds[0]!, "--yes"])).status).toBe(3);
  }, 90_000);

  it("the CLI applies with --yes and prints what it did", async () => {
    render("2026-09-26T11:50:00.000Z", FAKE_SESSION, [31, FAKE_SEVEN_DAY_RESET], [56, FIVE_HOUR_RESET]);
    const id = listBudgetSamples(home, { account: "claude-max", now: NOW }).items.find((s) => s.usedPercent === 31)!.id;
    const done = await cli(["forget", id, "--yes", "--json"]);
    expect(done.status, done.stderr).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({ applied: true, readings: [{ id, usedPercent: 31 }], auditLog: collectLogPath(home) });
  }, 60_000);

  it("MCP consent is the boolean true: a string, a number or null is refused and removes nothing", async () => {
    render("2026-09-26T11:52:00.000Z", FAKE_SESSION, [33, FAKE_SEVEN_DAY_RESET], [58, FIVE_HOUR_RESET]);
    const id = listBudgetSamples(home, { account: "claude-max", now: NOW }).items.find((s) => s.usedPercent === 33)!.id;
    const before = counts();
    for (const confirm of ["true", "false", 1, null]) {
      const result = await mcp.call("forget_budget_samples", { ids: [id], confirm });
      expect(result.isError, JSON.stringify(confirm)).toBe(true);
      expect(counts(), JSON.stringify(confirm)).toEqual(before);
    }
    const preview = toolPayload(await mcp.call("forget_budget_samples", { ids: [id], confirm: false })) as { applied: boolean };
    expect(preview.applied).toBe(false);
    expect((await http("/api/budget/forget", { body: { ids: [id], confirm: "true" } })).status).toBe(400);
    expect(counts()).toEqual(before);
    const done = toolPayload(await mcp.call("forget_budget_samples", { ids: [id], confirm: true })) as { applied: boolean };
    expect(done.applied).toBe(true);
  });

  it("an audit line that cannot be written is a warning on all three surfaces, and the removal stands", async () => {
    const readings = [34, 35, 36].map((used, i) => {
      render(`2026-09-26T12:0${i}:00.000Z`, FAKE_SESSION, [used, FAKE_SEVEN_DAY_RESET], [60 + i, FIVE_HOUR_RESET]);
      return listBudgetSamples(home, { account: "claude-max", now: NOW }).items.find((s) => s.usedPercent === used)!.id;
    });
    const logs = join(home, "logs");
    renameSync(logs, `${logs}.kept`);
    writeFileSync(logs, "not a directory");
    try {
      const before = counts().samples;
      const cliDone = await cli(["forget", readings[0]!, "--yes", "--json"]);
      expect(cliDone.status, cliDone.stderr).toBe(0);
      expect(JSON.parse(cliDone.stdout)).toMatchObject({ applied: true, auditLog: null });
      expect(cliDone.stderr).toContain("warning: The readings were removed, but the audit line could not be written");
      const human = await cli(["forget", readings[1]!, "--yes"]);
      expect(human.status, human.stderr).toBe(0);
      expect(human.stderr).not.toContain("    at ");
      const mcpDone = await mcp.call("forget_budget_samples", { ids: [readings[2]], confirm: true });
      expect(mcpDone.isError).toBeFalsy();
      expect(toolPayload(mcpDone)).toMatchObject({ applied: true, auditLog: null, warnings: [expect.stringContaining("could not be written")] });
      expect(counts().samples).toBe(before - 3);
      render("2026-09-26T12:10:00.000Z", FAKE_SESSION, [37, FAKE_SEVEN_DAY_RESET], [70, FIVE_HOUR_RESET]);
      const id = listBudgetSamples(home, { account: "claude-max", now: NOW }).items.find((s) => s.usedPercent === 37)!.id;
      const httpDone = await http("/api/budget/forget", { body: { ids: [id], confirm: true } });
      expect(httpDone.status, JSON.stringify(httpDone.body)).toBe(200);
      expect(httpDone.body).toMatchObject({ applied: true, auditLog: null, warnings: [expect.stringContaining("could not be written")] });
    } finally {
      rmSync(logs, { force: true });
      renameSync(`${logs}.kept`, logs);
    }
  }, 90_000);

  it("the HTTP route is POST-only, Origin-checked, token-gated, type-checked, and never arms the sync trigger", async () => {
    render("2026-09-26T11:55:00.000Z", FAKE_SESSION, [32, FAKE_SEVEN_DAY_RESET], [57, FIVE_HOUR_RESET]);
    const id = listBudgetSamples(home, { account: "claude-max", now: NOW }).items.find((s) => s.usedPercent === 32)!.id;
    const before = counts();
    expect((await http("/api/budget/forget", { method: "GET" })).status).toBe(405);
    expect((await http("/api/budget/forget", { body: { ids: [id], confirm: true }, origin: "https://evil.example" })).status).toBe(403);
    expect((await http("/api/budget/forget", { body: { ids: [id], confirm: true }, token: false })).status).toBe(401);
    expect((await http("/api/budget/forget", { body: { ids: id, confirm: true } })).status).toBe(400);
    expect((await http("/api/budget/forget", { body: { ids: [id], confirm: "yes" } })).status).toBe(400);
    // A body that is not a JSON object is the caller's mistake: 400 invalid_body, never a 500.
    for (const raw of ["null", "[]", "7", '"ids"', "{not json"]) {
      const res = await fetch(`${origin}/api/budget/forget`, { method: "POST", headers: { "x-staple-token": ui.token, "content-type": "application/json" }, body: raw });
      const answer = (await res.json()) as Record<string, any>;
      expect(res.status, raw).toBe(400);
      expect(answer, raw).toMatchObject({ code: "validation", detail: { reason: "invalid_body" } });
    }
    expect(counts()).toEqual(before);

    const spy = vi.spyOn(SurfaceAutoSync.prototype, "postWrite");
    try {
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
      const svg = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" fill="#f00"/></svg>';
      expect((await http("/api/glyph/sanitize", { body: { svg, label: "Dot" } })).status).toBe(200);
      await settle();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      const done = await http("/api/budget/forget", { body: { ids: [id], confirm: true } });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body).toMatchObject({ applied: true, readings: [{ id }] });
      await settle();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    expect(counts().samples).toBe(before.samples - 1);
  });
});
