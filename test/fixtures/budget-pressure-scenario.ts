/**
 * The Budget view's scenario: one machine's budget data, written through the real ingestion (a
 * Claude Code status line through the status-line source, a Codex rollout file through the
 * rollout source, a reading typed by hand) that the page is rendered from
 * (`src/ui/app/src/views/budget/budget-e2e.test.tsx`) and that the Playwright check serves
 * (seeded with `t0` an hour ago so the readings are fresh when a real server reads them).
 *
 * Every state the page must draw is here, from readings, not hand-written JSON:
 *   - `personal-max` (status line): the five-hour limit well within its sustainable pace, the
 *     seven-day limit barely moving;
 *   - `codex-plus` (Codex rollout): the primary limit burning 40%/h two hours from its reset,
 *     UNSAFE; the weekly limit within;
 *   - `team-max` (a second status line): readings that stopped 40 minutes ago, STALE;
 *   - `spare-max` (a third status line): bound, nothing arrived yet, NO SAMPLE YET;
 *   - `hand-typed`: a reading typed by hand with no reset, unbound: RESET NOT REPORTED.
 *
 * `t0` is the first reading; `readAt` is a minute after the last. Test-only.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { attemptLinkerFor } from "../../src/core/telemetry/attempt-link.js";
import { bindBudgetSource, setBudgetCapture } from "../../src/core/telemetry/budget-config.js";
import { ingestBudget } from "../../src/core/telemetry/ingest.js";
import { STATUSLINE_SESSION_ID, epoch, sessionMetaLine, statusline, tokenCountLine, writeRollout } from "./budget-support.js";

export const PRESSURE_ACCOUNTS = {
  within: "personal-max",
  unsafe: "codex-plus",
  stale: "team-max",
  empty: "spare-max",
  unbound: "hand-typed",
} as const;

/** One of `FIXTURE_SESSION_IDS`, so the real-home guard recognises a leaked row. */
const CODEX_SESSION = "33333333-0000-7000-8000-000000000001";

export interface BudgetPressureScenario {
  /** The instant every read should be taken at. */
  readAt: number;
}

/** Seed `home` (a scratch staple home) with the scenario's readings, the first at `t0`. */
export function seedBudgetPressureScenario(home: string, t0: number): BudgetPressureScenario {
  // Whole seconds: a status line reports its reset as epoch seconds.
  const base = Math.floor(t0 / 1000) * 1000;
  const iso = (minutes: number): string => new Date(base + minutes * 60_000).toISOString();
  const dirs = { within: join(home, "claude"), stale: join(home, "claude-team"), empty: join(home, "claude-spare"), codex: join(home, "codex") };
  for (const dir of Object.values(dirs)) mkdirSync(dir, { recursive: true });
  setBudgetCapture(home, true);
  bindBudgetSource(home, { source: "claude_code_statusline", account: PRESSURE_ACCOUNTS.within, configDir: dirs.within });
  bindBudgetSource(home, { source: "claude_code_statusline", account: PRESSURE_ACCOUNTS.stale, configDir: dirs.stale });
  bindBudgetSource(home, { source: "claude_code_statusline", account: PRESSURE_ACCOUNTS.empty, configDir: dirs.empty });
  bindBudgetSource(home, { source: "codex_rollout", account: PRESSURE_ACCOUNTS.unsafe, codexHome: dirs.codex });

  const render = (configDir: string, minutes: number, fiveHour: number, sevenDay: number, fiveReset: string, sevenReset: string): void => {
    const input = statusline({
      session_id: STATUSLINE_SESSION_ID,
      rate_limits: { five_hour: { used_percentage: fiveHour, resets_at: epoch(fiveReset) }, seven_day: { used_percentage: sevenDay, resets_at: epoch(sevenReset) } },
    });
    ingestBudget({ source: "claude-statusline", input, configDir }, { home, attemptLinker: attemptLinkerFor(home), now: () => iso(minutes) });
  };

  // Within: five renders over the hour, 10% to 14% of the five-hour limit, its reset 3h59m after the read.
  for (const [minutes, five, seven] of [[0, 10, 30], [15, 11, 30.05], [30, 12, 30.1], [45, 13, 30.15], [60, 14, 30.2]] as const) {
    render(dirs.within, minutes, five, seven, iso(300), iso(60 * 24 * 4));
  }
  // Stale: two renders that stopped 40 minutes before the read.
  render(dirs.stale, 0, 50, 60, iso(200), iso(60 * 24 * 2));
  render(dirs.stale, 21, 55, 61, iso(200), iso(60 * 24 * 2));

  // Unsafe: the Codex primary limit 20% to 60% in an hour, two hours before its reset.
  const file = writeRollout(dirs.codex, CODEX_SESSION, iso(-1), [
    sessionMetaLine({ id: CODEX_SESSION, timestamp: iso(-1) }),
    ...[[0, 20, 40], [20, 33, 40.1], [40, 47, 40.2], [60, 60, 40.3]].map(([minutes, primary, secondary]) =>
      tokenCountLine({
        timestamp: iso(minutes!),
        primary: { used_percent: primary!, window_minutes: 300, resets_at: epoch(iso(181)) },
        secondary: { used_percent: secondary!, window_minutes: 10080, resets_at: epoch(iso(60 * 24 * 3)) },
      }),
    ),
  ]);
  ingestBudget({ source: "codex-rollout", file }, { home, now: () => iso(60) });

  // Unbound, typed by hand with no reset: it joins no window.
  ingestBudget({ source: "manual", account: PRESSURE_ACCOUNTS.unbound, provider: "anthropic", limitKey: "five_hour", used: "44" }, { home, operator: true, now: () => iso(55) });

  return { readAt: base + 61 * 60_000 };
}
