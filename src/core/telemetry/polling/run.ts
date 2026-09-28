/**
 * One live poll run: for every bound home a poller serves, ask its provider once and
 * store what it says (docs/execution-telemetry.md, "Live polling").
 *
 * Nothing here runs unless budget capture AND live polling are on: with either off the
 * run returns at once, having read no sign-in and made no call.
 *
 * ## Cheap and idempotent
 *
 * `staple budget collect` (the 5-minute launch agent) and the Usage page's Refresh both
 * land here. A binding is asked at most once per {@link SCHEDULED_MIN_SECONDS} from the
 * schedule and once per {@link MANUAL_MIN_SECONDS} from Refresh, and not before a 429's
 * Retry-After has passed. What was last asked, and how it went, is kept per binding in
 * `telemetry/usage-poll.json` (no credential, no response body). One run at a time
 * (`telemetry/poll.lock`); a second finds it held and answers `busy`. Each run that asked
 * anybody appends one line to `logs/budget-collect.log`: per binding, the outcome, how
 * many readings were stored and a failure's code. Never a token.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { writeFileAtomic } from "../../../config/atomic.js";
import { readConfig } from "../../../config/file.js";
import { expandHomePath } from "../bindings.js";
import { isKnownBinding, livePollingOn, type KnownBinding } from "../config.js";
import { ingestPolledReadings, type AttemptLinker } from "../ingest.js";
import { acquireLockFile, collectLogPath, rotateLog } from "../collection/codex-collect.js";
import { USAGE_POLLERS, systemSecrets } from "./registry.js";
import type { PollFailureCode, SecretReader, UsagePoller } from "./types.js";

/** The schedule asks a binding at most this often. */
export const SCHEDULED_MIN_SECONDS = 240;
/** Refresh asks a binding at most this often. */
export const MANUAL_MIN_SECONDS = 60;
/** One request's timeout. */
export const POLL_TIMEOUT_MS = 10_000;

export interface PollDeps {
  readonly home: string;
  readonly now?: () => string;
  readonly fetch?: typeof fetch;
  readonly secrets?: SecretReader;
  readonly platform?: NodeJS.Platform;
  readonly userName?: string;
  readonly pollers?: readonly UsagePoller[];
  readonly attemptLinker?: AttemptLinker;
  readonly timeoutMs?: number;
  /** Tests only: runs just before the lock is taken (where another run could finish). */
  readonly beforeLock?: () => void;
}

export interface PollFailureView {
  readonly code: PollFailureCode;
  readonly message: string;
  readonly at: string;
}

/**
 * - `stored`: asked, and the answer went to the store (`storedCount` may be 0: unchanged).
 * - `failed`: asked (or tried to), and `failure` says why.
 * - `fresh`: not asked, the last ask was too recent.
 * - `deferred`: not asked, the provider's Retry-After has not passed.
 * - `busy`: not asked, another run holds the lock.
 * - `skipped`: asked, but capture, live polling or the binding changed meanwhile; nothing stored.
 */
export type PollOutcomeKind = "stored" | "failed" | "fresh" | "deferred" | "busy" | "skipped";

export interface PollOutcome {
  readonly poller: string;
  readonly name: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly dir: string;
  readonly outcome: PollOutcomeKind;
  readonly storedCount: number;
  /** Limits the provider reported with no window running, from this ask or the last one. */
  readonly idle: readonly string[];
  /** This ask's failure, or for `fresh`/`deferred` the last ask's, when it failed. */
  readonly failure: PollFailureView | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
}

export interface PollRun {
  readonly at: string;
  /** False when capture or live polling is off: nothing was read or asked. */
  readonly enabled: boolean;
  readonly skippedReason: "capture_disabled" | "live_polling_off" | null;
  readonly outcomes: readonly PollOutcome[];
}

interface StateEntry {
  readonly poller: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly dir: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly failure: PollFailureView | null;
  readonly retryAt: string | null;
  readonly idle: readonly string[];
}

interface PollState {
  readonly version: 1;
  readonly entries: Readonly<Record<string, StateEntry>>;
}

export function pollStatePath(home: string): string {
  return join(home, "telemetry", "usage-poll.json");
}

function pollLockPath(home: string): string {
  return join(home, "telemetry", "poll.lock");
}

function readState(home: string): PollState {
  try {
    const parsed = JSON.parse(readFileSync(pollStatePath(home), "utf8")) as Partial<PollState>;
    if (parsed?.version === 1 && parsed.entries !== null && typeof parsed.entries === "object") return { version: 1, entries: parsed.entries };
  } catch {
    // Absent or damaged: every binding is simply due.
  }
  return { version: 1, entries: {} };
}

function dirOf(binding: KnownBinding): string {
  return expandHomePath(binding.source === "claude_code_statusline" ? binding.configDir : binding.home);
}

const keyOf = (poller: UsagePoller, binding: KnownBinding): string => `${poller.id}:${dirOf(binding)}:${binding.accountRef}`;

/** Each bound home a poller serves, with the poller. */
function targets(bindings: readonly unknown[], pollers: readonly UsagePoller[]): Array<{ poller: UsagePoller; binding: KnownBinding }> {
  return bindings.filter(isKnownBinding).flatMap((binding) => {
    const poller = pollers.find((candidate) => candidate.isAvailable(binding));
    return poller === undefined ? [] : [{ poller, binding }];
  });
}

const ageMs = (now: string, then: string | null): number => (then === null ? Number.POSITIVE_INFINITY : Date.parse(now) - Date.parse(then));

function outcomeOf(poller: UsagePoller, binding: KnownBinding, entry: StateEntry | undefined, outcome: PollOutcomeKind, storedCount = 0): PollOutcome {
  return {
    poller: poller.id,
    name: poller.name,
    provider: binding.provider,
    accountRef: binding.accountRef,
    dir: dirOf(binding),
    outcome,
    storedCount,
    idle: entry?.idle ?? [],
    failure: entry?.failure ?? null,
    lastAttemptAt: entry?.lastAttemptAt ?? null,
    lastSuccessAt: entry?.lastSuccessAt ?? null,
  };
}

/** Ask every due binding once. `manual`: the Usage page's Refresh (a shorter floor). */
export async function runUsagePollers(options: { readonly manual?: boolean }, deps: PollDeps): Promise<PollRun> {
  const now = deps.now ?? (() => new Date().toISOString());
  const at = now();
  const telemetry = readConfig(deps.home).config.telemetry;
  if (!telemetry.budgetCapture) return { at, enabled: false, skippedReason: "capture_disabled", outcomes: [] };
  if (!livePollingOn(telemetry)) return { at, enabled: false, skippedReason: "live_polling_off", outcomes: [] };
  const pollers = deps.pollers ?? USAGE_POLLERS;
  const due = targets(telemetry.bindings, pollers);
  if (due.length === 0) return { at, enabled: true, skippedReason: null, outcomes: [] };

  deps.beforeLock?.();
  if (!acquireLockFile(pollLockPath(deps.home), Date.parse(at))) {
    const held = readState(deps.home);
    return { at, enabled: true, skippedReason: null, outcomes: due.map(({ poller, binding }) => outcomeOf(poller, binding, held.entries[keyOf(poller, binding)], "busy")) };
  }
  try {
    // Read under the lock: a run that finished just before this one took it has written
    // what it asked, and this run must not ask again or write its older view back.
    const state = readState(deps.home);
    const context = {
      fetch: deps.fetch ?? globalThis.fetch,
      now,
      platform: deps.platform ?? process.platform,
      userName: deps.userName ?? userInfo().username,
      secrets: deps.secrets ?? systemSecrets,
      timeoutMs: deps.timeoutMs ?? POLL_TIMEOUT_MS,
    };
    const floorMs = (options.manual === true ? MANUAL_MIN_SECONDS : SCHEDULED_MIN_SECONDS) * 1000;
    const entries: Record<string, StateEntry> = { ...state.entries };
    const outcomes = await Promise.all(
      due.map(async ({ poller, binding }): Promise<PollOutcome> => {
        const key = keyOf(poller, binding);
        const previous = entries[key];
        if (previous?.retryAt != null && ageMs(at, previous.retryAt) < 0) return outcomeOf(poller, binding, previous, "deferred");
        if (ageMs(at, previous?.lastAttemptAt ?? null) < floorMs) return outcomeOf(poller, binding, previous, "fresh");
        const attemptAt = now();
        let result;
        try {
          result = await poller.poll(binding, context);
        } catch {
          // A poller is written never to throw; if one does, its error is not quoted (it could hold a secret).
          result = { ok: false as const, code: "unexpected_response" as const, message: `${poller.name}'s check failed unexpectedly, so no reading was stored.` };
        }
        const base = { poller: poller.id, provider: binding.provider, accountRef: binding.accountRef, dir: dirOf(binding) };
        if (!result.ok) {
          const failureView: PollFailureView = { code: result.code, message: result.message, at: attemptAt };
          const retryAt = result.retryAfterSeconds !== undefined ? new Date(Date.parse(attemptAt) + result.retryAfterSeconds * 1000).toISOString() : null;
          const entry: StateEntry = { ...base, lastAttemptAt: attemptAt, lastSuccessAt: previous?.lastSuccessAt ?? null, failure: failureView, retryAt, idle: previous?.idle ?? [] };
          entries[key] = entry;
          return outcomeOf(poller, binding, entry, "failed");
        }
        let stored = 0;
        let kind: PollOutcomeKind = "stored";
        try {
          stored = ingestPolledReadings({ binding, items: result.items }, { home: deps.home, now, attemptLinker: deps.attemptLinker }).storedCount;
        } catch {
          kind = "skipped";
        }
        const entry: StateEntry = { ...base, lastAttemptAt: attemptAt, lastSuccessAt: kind === "stored" ? attemptAt : (previous?.lastSuccessAt ?? null), failure: null, retryAt: null, idle: [...result.idle] };
        entries[key] = entry;
        return outcomeOf(poller, binding, entry, kind, stored);
      }),
    );
    const asked = outcomes.filter((outcome) => outcome.outcome === "stored" || outcome.outcome === "failed" || outcome.outcome === "skipped");
    if (asked.length > 0) {
      mkdirSync(join(deps.home, "telemetry"), { recursive: true, mode: 0o700 });
      writeFileAtomic(pollStatePath(deps.home), `${JSON.stringify({ version: 1, entries })}\n`, { mode: 0o600 });
      const logPath = collectLogPath(deps.home);
      mkdirSync(join(deps.home, "logs"), { recursive: true, mode: 0o700 });
      rotateLog(logPath);
      const line = {
        at,
        poll: asked.map((outcome) => ({
          poller: outcome.poller,
          accountRef: outcome.accountRef,
          outcome: outcome.outcome,
          storedCount: outcome.storedCount,
          ...(outcome.idle.length > 0 ? { idle: outcome.idle } : {}),
          ...(outcome.outcome === "failed" && outcome.failure !== null ? { failure: outcome.failure.code } : {}),
        })),
      };
      appendFileSync(logPath, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    }
    return { at, enabled: true, skippedReason: null, outcomes };
  } finally {
    rmSync(pollLockPath(deps.home), { force: true });
  }
}

export interface PollingProviderStatus {
  readonly poller: string;
  readonly name: string;
  readonly host: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly dir: string;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  /** The last ask's failure; null when it succeeded or nothing has been asked. */
  readonly failure: PollFailureView | null;
  readonly retryAt: string | null;
  readonly idle: readonly string[];
}

export interface PollingStatus {
  /** Live polling as configured: `telemetry.livePolling`. */
  readonly livePolling: boolean;
  /** Whether it actually runs: live polling AND capture on. */
  readonly active: boolean;
  readonly budgetCapture: boolean;
  readonly providers: readonly PollingProviderStatus[];
}

/** What the page and `budget status` show: per bound home a poller serves, its last ask. Reads only. */
export function usagePollingStatus(home: string, pollers: readonly UsagePoller[] = USAGE_POLLERS): PollingStatus {
  const telemetry = readConfig(home).config.telemetry;
  const state = readState(home);
  const livePolling = livePollingOn(telemetry);
  return {
    livePolling,
    active: livePolling && telemetry.budgetCapture,
    budgetCapture: telemetry.budgetCapture,
    providers: targets(telemetry.bindings, pollers).map(({ poller, binding }) => {
      const entry = state.entries[keyOf(poller, binding)];
      return {
        poller: poller.id,
        name: poller.name,
        host: poller.host,
        provider: binding.provider,
        accountRef: binding.accountRef,
        dir: dirOf(binding),
        lastAttemptAt: entry?.lastAttemptAt ?? null,
        lastSuccessAt: entry?.lastSuccessAt ?? null,
        failure: entry?.failure ?? null,
        retryAt: entry?.retryAt ?? null,
        idle: entry?.idle ?? [],
      };
    }),
  };
}
