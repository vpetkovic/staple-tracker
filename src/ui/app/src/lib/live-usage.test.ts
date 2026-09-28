/**
 * The Usage page's live-check words (`live-usage.ts`), for the outcomes the real-payload test
 * (`views/budget/live-e2e.test.tsx`) does not reach: a check skipped as recent, one waiting out
 * a provider's Retry-After, one blocked by a run in progress, and capture off.
 */
import { describe, expect, it } from "vitest";
import { REFRESH_RESULT_MS, accountLiveLine, idleLimits, providerFor, refreshLines, visibleRefreshLines } from "./live-usage";
import type { PollOutcome, PollingProviderStatus, PollingStatus, RefreshResult } from "./telemetry-types";

const NOW = Date.parse("2026-09-28T09:00:00.000Z");
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

const outcome = (patch: Partial<PollOutcome>): PollOutcome => ({
  poller: "claude",
  name: "Claude",
  provider: "anthropic",
  accountRef: "claude-max",
  dir: "/home/.claude",
  outcome: "stored",
  storedCount: 2,
  idle: [],
  failure: null,
  lastAttemptAt: at(0),
  lastSuccessAt: at(0),
  ...patch,
});

const result = (outcomes: PollOutcome[], enabled = true, skippedReason: "capture_disabled" | "live_polling_off" | null = null): RefreshResult =>
  ({ collect: { poll: { at: at(0), enabled, skippedReason, outcomes } }, polling: { livePolling: enabled, active: enabled, budgetCapture: true, providers: [] } }) as unknown as RefreshResult;

const status = (patch: Partial<PollingProviderStatus>): PollingProviderStatus => ({
  poller: "codex",
  name: "Codex",
  host: "chatgpt.com",
  provider: "openai",
  accountRef: "codex-plus",
  dir: "/home/.codex",
  lastAttemptAt: at(120),
  lastSuccessAt: at(120),
  failure: null,
  retryAt: null,
  idle: ["codex.primary"],
  ...patch,
});

describe("what Refresh says", () => {
  it("a check skipped because it was recent, one waiting on the provider, and one blocked by a running check", () => {
    const lines = refreshLines(
      result([
        outcome({ outcome: "fresh", lastAttemptAt: at(30) }),
        outcome({ poller: "codex", name: "Codex", outcome: "deferred", failure: { code: "rate_limited", message: "Codex asked us to check less often.", at: at(60) } }),
        outcome({ poller: "x", name: "Acme", outcome: "busy" }),
      ]),
      NOW,
    );
    expect(lines).toEqual([
      { tone: "ok", text: "Claude: already checked just now, so it wasn't asked again yet." },
      { tone: "warn", text: "Codex asked us to check less often, so we're waiting before asking again." },
      { tone: "info", text: "Acme: another check is running right now; the page updates when it finishes." },
    ]);
  });

  it("a recent check that FAILED is not called fine: its reason is repeated", () => {
    const failure = { code: "expired" as const, message: "Claude Code's sign-in on this computer has expired.", at: at(20) };
    expect(refreshLines(result([outcome({ outcome: "fresh", failure })]), NOW)).toEqual([{ tone: "warn", text: failure.message }]);
  });

  it("does not repeat the provider's name when its reason already starts with it", () => {
    const failure = { code: "signed_out" as const, message: "Codex isn't signed in for /home/.codex on this computer.", at: at(0) };
    expect(refreshLines(result([outcome({ poller: "codex", name: "Codex", outcome: "failed", failure })]), NOW)).toEqual([{ tone: "warn", text: failure.message }]);
  });

  it("with capture off, says nothing was checked", () => {
    expect(refreshLines(result([], false, "capture_disabled"), NOW)).toEqual([{ tone: "warn", text: "Usage tracking is off on this computer, so nothing was checked." }]);
  });
});

describe("how long Refresh's result stays", () => {
  it("shows the lines for a minute, then drops them, because they say 'just now'", () => {
    const lines = [{ tone: "ok" as const, text: "Updated just now." }];
    expect(visibleRefreshLines({ lines, finishedAt: NOW }, NOW + REFRESH_RESULT_MS - 1)).toEqual(lines);
    expect(visibleRefreshLines({ lines, finishedAt: NOW }, NOW + REFRESH_RESULT_MS)).toBeNull();
    expect(visibleRefreshLines({ lines: null, finishedAt: null }, NOW)).toBeNull();
  });
});

describe("what an account says", () => {
  const polling = (providers: PollingProviderStatus[], active = true): PollingStatus => ({ livePolling: active, active, budgetCapture: true, providers });

  it("names nothing when live checks are off, and finds the account by provider and label when on", () => {
    expect(providerFor(polling([status({})], false), "openai", "codex-plus")).toBeNull();
    expect(providerFor(polling([status({})]), "openai", "codex-plus")?.poller).toBe("codex");
    expect(providerFor(polling([status({})]), "anthropic", "codex-plus")).toBeNull();
  });

  it("says when it was checked, and treats an idle window as full only while the last check succeeded", () => {
    expect(accountLiveLine(status({}), NOW)).toEqual({ tone: "ok", text: "Checked with Codex 2 min ago." });
    expect([...idleLimits(status({}))]).toEqual(["codex.primary"]);
    const failed = status({ failure: { code: "network", message: "We couldn't reach Codex from this computer.", at: at(10) } });
    expect(accountLiveLine(failed, NOW)).toEqual({
      tone: "warn",
      text: "We couldn't check Codex just now. We couldn't reach Codex from this computer. The figures below are from the last good check, 2 min ago.",
    });
    // The failure's own instant, not "just now": an old failure says how old it is.
    expect(accountLiveLine({ ...failed, failure: { ...failed.failure!, at: at(12 * 60) } }, NOW)).toMatchObject({
      text: expect.stringMatching(/^We couldn't check Codex 12 min ago\. /),
    });
    expect([...idleLimits(failed)]).toEqual([]);
    expect(accountLiveLine(status({ lastSuccessAt: null, lastAttemptAt: null }), NOW)).toEqual({ tone: "info", text: "Live checks are on; Codex hasn't been checked yet." });
  });
});
