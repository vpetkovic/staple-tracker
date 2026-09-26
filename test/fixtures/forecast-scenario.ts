/**
 * The forecast report's scenario: two workspaces and one machine's budget data, written ONCE
 * through the real store and the real budget ingestion, that the Analytics pages are rendered
 * from (`src/ui/app/src/detail/forecast-e2e.test.tsx`) and that the manual Playwright check
 * serves (`staple open` over the same home).
 *
 * WHY A BUILDER. Every state the pages must draw lives in the payloads the store returns for
 * THIS history, not in hand-written JSON: calibration samples that come from checkouts and
 * comments, a unit in progress whose remaining work is conditioned on its work so far, a unit
 * in review, a unit nobody estimated, a dependency chain, reconstructed history rebuilt by the
 * real `reconstruct`, and a provider limit whose work rate is measured from a status line read
 * during a real attempt. An empty workspace beside it gives the "no samples" states.
 *
 * `t0` is the instant the budget-bearing attempt starts. The suites pass a fixed instant and
 * read with the clock pinned; the Playwright seed passes "an hour ago" so the readings are
 * fresh when a real server reads them.
 *
 * Test-only: nothing under `src/` imports this.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { tx } from "../../src/core/db.js";
import { writeEventRow } from "../../src/core/event-row.js";
import type { WorkspaceStore } from "../../src/core/store.js";
import { attemptLinkerFor } from "../../src/core/telemetry/attempt-link.js";
import { bindBudgetSource, setBudgetCapture } from "../../src/core/telemetry/budget-config.js";
import { ingestBudget } from "../../src/core/telemetry/ingest.js";
import { setClock } from "../../src/core/types.js";
import { initWorkspace } from "../../src/core/workspace.js";
import { STATUSLINE_SESSION_ID, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./budget-support.js";

export const FORECAST_WS = "fc";
export const EMPTY_WS = "fc-empty";
export const CLAUDE_ACCOUNT = "personal-max";
export const CODEX_ACCOUNT = "codex-plus";
/** One of `FIXTURE_SESSION_IDS`, so the real-home guard recognises a leaked row. */
const CODEX_SESSION = "33333333-0000-7000-8000-000000000002";

export interface ForecastScenario {
  /** The epic with every unit treatment under it. */
  epic: string;
  /** In progress, worked an hour against 2h, in the status line's session. */
  inProgress: string;
  /** Blocked by `inProgress`, 1h, not started. */
  blocked: string;
  /** Worked, then handed to review. */
  review: string;
  /** No estimate: unknown, never 0. */
  unestimated: string;
  /** Worked and done. */
  done: string;
  /** An open estimated leaf with no parent: the compact forecast. */
  leaf: string;
  /** In the empty workspace: an epic whose units have no samples to read. */
  emptyEpic: string;
  /** In the empty workspace: an epic whose only unit is done (the epic closes with it): a settled forecast. */
  settledEpic: string;
  /** The instant every read should be taken at (a minute after the last reading). */
  readAt: number;
}

/**
 * Seed both workspaces and the budget data into `home` (which must be `STAPLE_HOME`). Leaves
 * the clock set to `readAt`; the caller clears it.
 */
export function seedForecastScenario(home: string, t0: number): ForecastScenario {
  const iso = (minutes: number): string => new Date(t0 + minutes * 60_000).toISOString();
  let clock = t0;
  const at = (minutes: number): void => void (clock = t0 + minutes * 60_000);
  setClock(() => clock);

  const claudeDir = join(home, "claude");
  const codexDir = join(home, "codex");
  mkdirSync(claudeDir, { recursive: true });
  mkdirSync(codexDir, { recursive: true });
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: CLAUDE_ACCOUNT, configDir: claudeDir });
  bindBudgetSource(home, { source: "codex_rollout", account: CODEX_ACCOUNT, codexHome: codexDir });

  /** A five-hour-limit reading from the status line, at `minutes`, with the reset five hours after t0. */
  const reading = (minutes: number, used: number): void => {
    const input = statusline({ session_id: STATUSLINE_SESSION_ID, rate_limits: { five_hour: { used_percentage: used, resets_at: epoch(iso(300)) } } });
    ingestBudget({ source: "claude-statusline", input, configDir: claudeDir }, { home, now: () => iso(minutes), attemptLinker: attemptLinkerFor(home) });
  };

  // A checkout resolves its harness's account binding from the harness's own config dir, as a
  // real session does: point the two harness variables at the bound dirs while seeding.
  const previous = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  const main = initWorkspace({ global: true, slug: FORECAST_WS }).store;
  let scenario: Omit<ForecastScenario, "emptyEpic" | "settledEpic" | "readAt">;
  try {
    scenario = seedMain(main, { at, reading, iso });
  } finally {
    main.db.close();
    for (const [key, value] of [["CLAUDE_CONFIG_DIR", previous.claude], ["CODEX_HOME", previous.codex]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  // A Codex account with readings and no attempt of the workspace: its work rate is unknown.
  const file = writeRollout(codexDir, CODEX_SESSION, iso(0), [
    sessionMetaLine({ id: CODEX_SESSION, timestamp: iso(0) }),
    tokenCountLine({ timestamp: iso(1), primary: { used_percent: 20, window_minutes: 300, resets_at: epoch(iso(300)) }, secondary: { used_percent: 40, window_minutes: 10080, resets_at: epoch(iso(60 * 24 * 3)) } }),
    tokenCountLine({ timestamp: iso(31), primary: { used_percent: 30, window_minutes: 300, resets_at: epoch(iso(300)) }, secondary: { used_percent: 41, window_minutes: 10080, resets_at: epoch(iso(60 * 24 * 3)) } }),
    tokenCountLine({ timestamp: iso(61), primary: { used_percent: 40, window_minutes: 300, resets_at: epoch(iso(300)) }, secondary: { used_percent: 42, window_minutes: 10080, resets_at: epoch(iso(60 * 24 * 3)) } }),
  ]);
  ingestBudget({ source: "codex-rollout", file }, { home, now: () => iso(61) });

  at(62);
  const empty = initWorkspace({ global: true, slug: EMPTY_WS }).store;
  let emptyEpic: string;
  let settledEpic: string;
  try {
    emptyEpic = empty.createIssue({ title: "Nothing measured yet", kind: "epic" }).identifier;
    empty.createIssue({ title: "First unit", parent: emptyEpic, estimatedSeconds: 7200 });
    empty.createIssue({ title: "Second unit", parent: emptyEpic, estimatedSeconds: 3600 });
    // No estimate on the unit, so it stays out of the ratio population and the set stays empty.
    settledEpic = empty.createIssue({ title: "Landed", kind: "epic" }).identifier;
    const landed = empty.createIssue({ title: "The only unit", parent: settledEpic });
    empty.updateIssue(landed.id, { status: "done" }, "w");
  } finally {
    empty.db.close();
  }
  at(62);
  return { ...scenario, emptyEpic, settledEpic, readAt: t0 + 62 * 60_000 };
}

function seedMain(
  store: WorkspaceStore,
  { at, reading, iso }: { at: (minutes: number) => void; reading: (minutes: number, used: number) => void; iso: (minutes: number) => string },
): Omit<ForecastScenario, "emptyEpic" | "settledEpic" | "readAt"> {
  /** A leaf worked `minutes` from `from`, with a comment every ten minutes, then moved to `status`. */
  const worked = (from: number, minutes: number, fields: { title: string; parent?: string; estimatedSeconds: number; kind?: string }, status = "done"): string => {
    at(from);
    const issue = store.createIssue({ priority: "high", ...fields });
    store.checkoutIssue(issue.id, "w", undefined, {});
    for (let m = from + 10; m < from + minutes; m += 10) (at(m), store.addComment(issue.id, "progress", "w", "agent"));
    at(from + minutes);
    store.updateIssue(issue.id, { status }, "w");
    return issue.identifier;
  };

  // Captured history: six task/high samples against one hour, ratios 0.5 to 1.5.
  let from = -1200;
  for (const minutes of [30, 40, 45, 50, 60, 90]) {
    worked(from, minutes, { title: `Sample ${minutes}m`, estimatedSeconds: 3600 });
    from += minutes + 1;
  }
  // One bug: its key has a single sample, so its cohort falls back to the whole set.
  worked(from, 25, { title: "Sample bug 25m", estimatedSeconds: 3600, kind: "bug" });
  from += 26;

  // Backfilled history: three leaves an older build worked (a bare checkout event), rebuilt by
  // the real `reconstruct` into the reconstructed set.
  for (const minutes of [20, 35, 80]) {
    at(from);
    const legacy = store.createIssue({ title: `Legacy ${minutes}m`, estimatedSeconds: 3600, priority: "high" });
    tx(store.db, () => writeEventRow(store.db, { kind: "checkout", issueId: legacy.id, actor: "old", payload: {}, createdAt: iso(from), dedupKey: `legacy-${legacy.id}` }));
    at(from + minutes);
    store.updateIssue(legacy.id, { status: "done" }, "old");
    from += minutes + 1;
  }
  at(from);
  store.reconstructAttemptHistory();

  // The epic.
  at(-300);
  const epic = store.createIssue({ title: "Forecast report", kind: "epic", priority: "high" }).identifier;
  const done = worked(-290, 40, { title: "Scaffold the report", parent: epic, estimatedSeconds: 3600 });
  const review = worked(-240, 50, { title: "Write the copy", parent: epic, estimatedSeconds: 3600 }, "in_review");
  const unestimated = store.createIssue({ title: "Polish the narrow layout", parent: epic, priority: "high" }).identifier;
  const inProgressIssue = store.createIssue({ title: "Build the forecast block", parent: epic, estimatedSeconds: 7200, priority: "high" });
  const blocked = store.createIssue({ title: "Wire the calibration view", parent: epic, estimatedSeconds: 3600, priority: "high" }).identifier;
  store.setBlockedBy(blocked, [inProgressIssue.identifier], "w");
  const leaf = store.createIssue({ title: "Standalone estimate", estimatedSeconds: 10_800, priority: "high" }).identifier;

  // The attempt the work rate is measured from: an hour in the status line's session, the
  // five-hour limit reading 10%, 16% and 22%.
  at(0);
  store.checkoutIssue(inProgressIssue.id, "agent", undefined, { attempt: { harness: "claude_code", harnessSession: STATUSLINE_SESSION_ID } });
  reading(0, 10);
  at(30);
  store.addComment(inProgressIssue.id, "halfway", "agent", "agent");
  reading(30, 16);
  at(60);
  store.addComment(inProgressIssue.id, "still going", "agent", "agent");
  reading(60, 22);

  return { epic, inProgress: inProgressIssue.identifier, blocked, review, unestimated, done, leaf };
}
