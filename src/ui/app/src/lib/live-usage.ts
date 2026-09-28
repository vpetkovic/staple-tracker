/**
 * The Usage page's words for live checks (docs/execution-telemetry.md, "Live polling"): what a
 * Refresh did, per provider, and what each account's last check says. Pure, so a test with no
 * browser pins it; every sentence is chosen from a value the server sent (an outcome, a failure
 * code), and a failure's own sentence is the server's, written by the poller in plain words.
 */
import { plainAge } from "./plain-language";
import type { PollOutcome, PollingProviderStatus, PollingStatus, RefreshResult } from "./telemetry-types";

export type LiveTone = "ok" | "info" | "warn";

export interface LiveLine {
  readonly tone: LiveTone;
  readonly text: string;
}

const ago = (iso: string | null, nowMs: number): string | null => (iso === null ? null : plainAge(Math.max(0, (nowMs - Date.parse(iso)) / 1000)));

/** "just now" under a minute, else "12 min ago". */
function agoText(iso: string | null, nowMs: number): string {
  if (iso === null) return "a moment ago";
  return nowMs - Date.parse(iso) < 60_000 ? "just now" : `${ago(iso, nowMs)} ago`;
}

/** "Codex: <reason>", unless the reason already starts with the name ("Codex isn't signed in…"). */
function named(name: string, message: string): string {
  return message.startsWith(name) ? message : `${name}: ${message}`;
}

function outcomeLine(outcome: PollOutcome, nowMs: number): LiveLine {
  switch (outcome.outcome) {
    case "stored":
      return { tone: "ok", text: `${outcome.name}: updated just now.` };
    case "failed":
      return { tone: "warn", text: named(outcome.name, outcome.failure?.message ?? "the check failed, so no reading was stored.") };
    case "fresh":
      return outcome.failure !== null
        ? { tone: "warn", text: named(outcome.name, outcome.failure.message) }
        : { tone: "ok", text: `${outcome.name}: already checked ${agoText(outcome.lastAttemptAt, nowMs)}, so it wasn't asked again yet.` };
    case "deferred":
      return { tone: "warn", text: `${outcome.name} asked us to check less often, so we're waiting before asking again.` };
    case "busy":
      return { tone: "info", text: `${outcome.name}: another check is running right now; the page updates when it finishes.` };
    case "skipped":
      return { tone: "info", text: `${outcome.name}: a setting changed during the check, so nothing was stored.` };
  }
}

/** How long a Refresh's result lines stay: they say "just now", so they go before that stops being true. */
export const REFRESH_RESULT_MS = 60_000;

/** The result lines to show at `nowMs`: none once they are a minute old (the account lines carry the age from then on). */
export function visibleRefreshLines(state: { readonly lines: readonly LiveLine[] | null; readonly finishedAt: number | null }, nowMs: number = Date.now()): readonly LiveLine[] | null {
  if (state.lines === null || state.finishedAt === null) return null;
  return nowMs - state.finishedAt < REFRESH_RESULT_MS ? state.lines : null;
}

/** What one press of Refresh did, in one or more short lines. */
export function refreshLines(result: RefreshResult, nowMs: number = Date.now()): LiveLine[] {
  const { poll } = result.collect;
  if (!poll.enabled) {
    if (poll.skippedReason === "capture_disabled") return [{ tone: "warn", text: "Usage tracking is off on this computer, so nothing was checked." }];
    return [
      { tone: "ok", text: "Updated just now from what this computer has recorded." },
      {
        tone: "info",
        text: "Live checks are off, so new Claude and Codex readings only arrive while those tools are running. Turn them on under Settings, Usage.",
      },
    ];
  }
  if (poll.outcomes.length === 0) return [{ tone: "ok", text: "Updated just now. No Claude or Codex account is linked for live checks." }];
  const lines = poll.outcomes.map((outcome) => outcomeLine(outcome, nowMs));
  return lines.every((line) => line.tone === "ok" && line.text.endsWith("updated just now.")) ? [{ tone: "ok", text: "Updated just now." }] : lines;
}

/** The live-check status of one account on the page, or null when live checks do not cover it. */
export function providerFor(polling: PollingStatus | null, provider: string | null, accountRef: string): PollingProviderStatus | null {
  if (polling === null || !polling.active) return null;
  return polling.providers.find((entry) => entry.accountRef === accountRef && (provider === null || entry.provider === provider)) ?? null;
}

/**
 * The line under an account's name: when its last live check failed, the plain reason (never a
 * silent old figure); otherwise how long ago it was checked.
 */
export function accountLiveLine(status: PollingProviderStatus | null, nowMs: number = Date.now()): LiveLine | null {
  if (status === null) return null;
  if (status.failure !== null) {
    const since = status.lastSuccessAt === null ? "" : ` The figures below are from the last good check, ${agoText(status.lastSuccessAt, nowMs)}.`;
    return { tone: "warn", text: `We couldn't check ${status.name} ${agoText(status.failure.at, nowMs)}. ${status.failure.message}${since}` };
  }
  if (status.lastSuccessAt === null) return { tone: "info", text: `Live checks are on; ${status.name} hasn't been checked yet.` };
  return { tone: "ok", text: `Checked with ${status.name} ${agoText(status.lastSuccessAt, nowMs)}.` };
}

/** The limits the last good check reported with no window running (nothing used since the reset). */
export function idleLimits(status: PollingProviderStatus | null): ReadonlySet<string> {
  return new Set(status === null || status.failure !== null ? [] : status.idle);
}
