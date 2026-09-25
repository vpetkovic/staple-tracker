/**
 * The budget read surfaces (docs/execution-telemetry.md, "Surfaces", "Regressions within a
 * window", "Linking samples to attempts", "Missingness"): `staple budget` / `get_budget`,
 * `staple budget history` / `list_budget_samples`, and the burn `get_attempt` reports.
 *
 * Machine state. Everything here reads this machine's `hub.db` through a read-only handle
 * and never writes it, and nothing here goes near a workspace journal: limit windows and
 * budget samples never replicate, so a read of them never becomes an operation.
 *
 * Unknown is never zero. Every measurable field that has no value is `null` with a reason
 * from the contract's closed set in the record's `missing`, and a sum no member contributed
 * to is `null`, not `0`.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { readConfig } from "../../config/file.js";
import { StapleError, nowIso } from "../types.js";
import type { AttemptTransition } from "./attempt-records.js";
import type { AttemptView } from "./attempt-derive.js";
import { BudgetStore, WINDOW_TOLERANCE_SECONDS, type BudgetSample, type LimitWindow, type Missing, type WindowSampleView } from "./budget-store.js";
import { isKnownBinding, type TelemetryConfig } from "./config.js";
import { assertAccountRef, normalizeInstant, parseRelativeSeconds } from "./formats.js";
import {
  GAP_SECONDS,
  coverage,
  cutPage,
  decodeKeysetCursor,
  gapsIn,
  pageLimit,
  type KeysetPosition,
  type PageRequest,
  type TelemetryPage,
} from "./read-page.js";

const ms = (instant: string): number => Date.parse(instant);
const WINDOW_TOLERANCE_MS = WINDOW_TOLERANCE_SECONDS * 1000;

/** This machine's hub, read-only, or null when it has none or it predates budget samples. */
function openHubForRead(home: string): DatabaseSync | null {
  const path = join(home, "hub.db");
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('budget_samples', 'limit_windows')").all();
  if (tables.length < 2) {
    db.close();
    return null;
  }
  return db;
}

function withHub<T>(home: string, fn: (hub: DatabaseSync | null) => T): T {
  const hub = openHubForRead(home);
  try {
    return fn(hub);
  } finally {
    hub?.close();
  }
}

function telemetryOf(home: string): TelemetryConfig {
  return readConfig(home).config.telemetry;
}

interface AccountKey {
  readonly provider: string | null;
  readonly accountRef: string;
}

/** Accounts this machine has a source binding for. */
function boundAccounts(telemetry: TelemetryConfig): AccountKey[] {
  return telemetry.bindings.filter(isKnownBinding).map((binding) => ({ provider: binding.provider, accountRef: binding.accountRef }));
}

/**
 * Why an account has no reading at all: capture is running for it and nothing has arrived
 * (`no_sample_yet`), or no ingestion path is configured for it (`source_unavailable`).
 */
function absentReason(telemetry: TelemetryConfig, accountRef: string): "no_sample_yet" | "source_unavailable" {
  const bound = boundAccounts(telemetry).some((account) => account.accountRef === accountRef);
  return telemetry.budgetCapture && bound ? "no_sample_yet" : "source_unavailable";
}

// ------------------------------------------------------------------ get_budget

/** One limit of one account, as it reads now. */
export interface LimitReading {
  readonly limitKey: string;
  /** The status of `window`: `current` or `elapsed`, or null when no window exists for it. */
  readonly status: string | null;
  /** The current window instance, else the newest one (elapsed or superseded), else null. */
  readonly window: LimitWindow | null;
  /** The newest sample of the current window by `observedAt`. Never one from an elapsed window. */
  readonly latestSample: BudgetSample | null;
  /** The highest `usedPercent` observed in the current window: the conservative reading. */
  readonly highWaterPercent: number | null;
  /** `max(0, 100 − highWaterPercent)`; for a sliding window, the latest sample's. */
  readonly remainingPercent: number | null;
  readonly regressionCount: number | null;
  readonly sampleCount: number | null;
  /** True when the latest sample's value is older than capture allows: `now − observedAt` over 600 s. */
  readonly stale: boolean | null;
  readonly missing: Missing;
}

export interface AccountBudget {
  readonly provider: string | null;
  readonly accountRef: string;
  /** Whether a source binding on this machine names this account. */
  readonly bound: boolean;
  readonly limits: LimitReading[];
  readonly missing: Missing;
}

export interface BudgetView {
  /** The instant `status`, `stale` and `window_elapsed` were judged at. */
  readonly asOf: string;
  readonly budgetCapture: boolean;
  readonly accounts: AccountBudget[];
}

function limitReading(store: BudgetStore, provider: string | null, accountRef: string, limitKey: string, now: string): LimitReading {
  const windows = store.listWindows({ accountRef, limitKey }, now).filter((window) => provider === null || window.provider === provider);
  const missing: Missing = {};
  const current = windows.filter((window) => window.status === "current").sort((a, b) => ((a.resetsAt ?? "") < (b.resetsAt ?? "") ? 1 : -1))[0];
  if (current === undefined) {
    // The newest instance still standing; a superseded one only when every instance is.
    const newest = [...windows].reverse().find((window) => window.supersededBy === null) ?? windows[windows.length - 1] ?? null;
    // Nothing carries forward across a reset: the last sample of an elapsed window says
    // nothing about the next one. A limit only ever seen without a reset joins no window.
    const reason = newest === null ? "reset_not_reported" : "window_elapsed";
    for (const field of ["latestSample", "highWaterPercent", "remainingPercent", "stale"]) missing[field] = reason;
    if (newest === null) {
      missing.window = reason;
      missing.regressionCount = reason;
      missing.sampleCount = reason;
    }
    const high = newest === null ? null : store.windowHighWater(newest.id);
    return {
      limitKey,
      status: newest?.status ?? null,
      window: newest,
      latestSample: null,
      highWaterPercent: null,
      remainingPercent: null,
      regressionCount: high?.regressionCount ?? null,
      sampleCount: high?.sampleCount ?? null,
      stale: null,
      missing,
    };
  }
  const samples = store.samplesInWindow(current.id);
  const latest = samples[samples.length - 1] ?? null;
  const high = store.windowHighWater(current.id)!;
  let highWaterPercent = high.highWaterPercent;
  let remainingPercent = high.remainingPercent;
  if (current.resetsAt === null) {
    // High-water is undefined for a sliding window: current pressure is the latest sample.
    highWaterPercent = null;
    missing.highWaterPercent = "sliding_window";
    remainingPercent = latest?.remainingPercent ?? null;
  } else {
    Object.assign(missing, high.missing);
  }
  if (latest === null) {
    missing.latestSample = "no_sample_yet";
    missing.stale = "no_sample_yet";
    if (remainingPercent === null) missing.remainingPercent = "no_sample_yet";
  }
  return {
    limitKey,
    status: current.status,
    window: current,
    latestSample: latest,
    highWaterPercent,
    remainingPercent,
    regressionCount: high.regressionCount,
    sampleCount: high.sampleCount,
    // Judged on `observedAt`, as history's gaps are: a backfilled reading recorded a minute
    // ago can be two hours old, and it is the age of the value that makes it stale.
    stale: latest === null ? null : ms(now) - ms(latest.observedAt) > GAP_SECONDS * 1000,
    missing,
  };
}

/**
 * `staple budget [--account A]` / `get_budget`: per account, each limit's current window
 * with its latest sample, `status` and `missing`. Accounts are those this machine holds
 * readings for and those a source binding names (so a bound account nothing has arrived
 * for reads `no_sample_yet`, not an empty success).
 */
export function readBudget(home: string, query: { account?: string; now?: string } = {}): BudgetView {
  const now = query.now ?? nowIso();
  const account = query.account === undefined ? undefined : assertAccountRef(query.account, "--account");
  const telemetry = telemetryOf(home);
  return withHub(home, (hub) => {
    const keys = new Map<string, AccountKey>();
    const add = (key: AccountKey) => {
      const id = `${key.provider ?? ""}\u0000${key.accountRef}`;
      if (!keys.has(id)) keys.set(id, key);
    };
    if (hub !== null) {
      const rows = hub
        .prepare(
          `SELECT provider, account_ref AS accountRef FROM limit_windows
           UNION SELECT provider, account_ref AS accountRef FROM budget_samples
           ORDER BY accountRef, provider`,
        )
        .all() as Array<{ provider: string; accountRef: string }>;
      rows.forEach(add);
    }
    boundAccounts(telemetry).forEach(add);
    let accounts = [...keys.values()];
    // A provider-less binding key duplicates a row the hub already names under a provider.
    accounts = accounts.filter((key) => key.provider !== null || !accounts.some((other) => other !== key && other.accountRef === key.accountRef));
    if (account !== undefined) {
      accounts = accounts.filter((key) => key.accountRef === account);
      if (accounts.length === 0) accounts = [{ provider: null, accountRef: account }];
    }
    accounts.sort((a, b) => (a.accountRef === b.accountRef ? ((a.provider ?? "") < (b.provider ?? "") ? -1 : 1) : a.accountRef < b.accountRef ? -1 : 1));
    const store = hub === null ? null : new BudgetStore(hub);
    return {
      asOf: now,
      budgetCapture: telemetry.budgetCapture,
      accounts: accounts.map((key): AccountBudget => {
        const limitKeys =
          hub === null
            ? []
            : (
                hub
                  .prepare(
                    `SELECT limit_key AS k FROM limit_windows WHERE account_ref = ? AND (? IS NULL OR provider = ?)
                     UNION SELECT limit_key AS k FROM budget_samples WHERE account_ref = ? AND (? IS NULL OR provider = ?)
                     ORDER BY k`,
                  )
                  .all(key.accountRef, key.provider, key.provider, key.accountRef, key.provider, key.provider) as Array<{ k: string }>
              ).map((row) => row.k);
        const missing: Missing = {};
        if (limitKeys.length === 0) missing.limits = absentReason(telemetry, key.accountRef);
        return {
          provider: key.provider,
          accountRef: key.accountRef,
          bound: boundAccounts(telemetry).some((bound) => bound.accountRef === key.accountRef),
          limits: store === null ? [] : limitKeys.map((limitKey) => limitReading(store, key.provider, key.accountRef, limitKey, now)),
          missing,
        };
      }),
    };
  });
}

// ------------------------------------------------------------ list_budget_samples

/** A sample in a history page: `regression` is derived within its window, never stored. */
export type HistorySample = BudgetSample & { readonly regression: boolean };

/** `--since`: an ISO instant, or a duration in the existing vocabulary meaning "that long ago". */
export function parseSince(raw: string | undefined, now: string): string | null {
  if (raw === undefined) return null;
  const instant = normalizeInstant(raw);
  if (instant !== null) return instant;
  const seconds = parseRelativeSeconds(raw);
  if (seconds !== null) return new Date(ms(now) - seconds * 1000).toISOString();
  throw new StapleError("validation", `--since takes an ISO-8601 instant with a zone (2026-09-24T09:00:00Z) or a duration (90m, 2h, 3d); got "${raw}".`);
}

const sampleKey = (sample: BudgetSample): KeysetPosition => ({ at: sample.observedAt, id: sample.id });

/**
 * `staple budget history --account A` / `list_budget_samples`: one account's samples by
 * `observedAt`, oldest first, bounded, with coverage. `gaps` are the spans in which no
 * sample and no heartbeat was stored for the account — nobody was looking — each `stale`,
 * or `no_sample_yet` before the account's first sample ever. Judged on `observedAt`, the
 * instant each value was true.
 *
 * `since` bounds the FIRST page only, resolved against the clock once. A cursor is already
 * past it: every row after the cursor is at or after the instant `since` named when the walk
 * began. Resolving a relative `since` (`2h`) again on a later page would move it forward and
 * silently skip the rows between.
 */
export function listBudgetSamples(
  home: string,
  query: { account: string; since?: string; now?: string } & PageRequest,
): TelemetryPage<HistorySample> {
  if (query.account === undefined || query.account.trim() === "") throw new StapleError("validation", "Budget history needs --account: the label of the account to read.");
  const account = assertAccountRef(query.account, "--account");
  const now = query.now ?? nowIso();
  const limit = pageLimit(query.limit);
  const resolved = parseSince(query.since, now);
  // Fingerprinted as given, so a relative `since` keeps naming the same walk.
  const scope = { account, since: query.since ?? null };
  const position = query.cursor === undefined ? null : decodeKeysetCursor("budget_samples", scope, query.cursor);
  const since = position === null ? resolved : null;
  const telemetry = telemetryOf(home);
  return withHub(home, (hub) => {
    const store = hub === null ? null : new BudgetStore(hub);
    const rows = store === null ? [] : store.samplesAfter({ accountRef: account, since, after: position, limit: limit + 1 });
    const page = cutPage(rows, limit, "budget_samples", scope, sampleKey);
    const items = page.items.map((sample) => {
      const high = store === null || sample.usedPercent === null ? null : store.highWaterBefore(sample);
      return { ...sample, regression: high !== null && sample.usedPercent! < high };
    });
    const from = position?.at ?? since ?? items[0]?.observedAt ?? null;
    const to = page.truncated ? items[items.length - 1]!.observedAt : from === null ? null : now;
    const any = store !== null && store.hasSampleBefore(account, null);
    const earlier = from !== null && store !== null && store.hasSampleBefore(account, from);
    const absent = any ? "no_sample_yet" : absentReason(telemetry, account);
    const gaps = gapsIn(items.map((sample) => sample.observedAt), { from, to }, { leading: earlier ? "stale" : absent, between: "stale", trailing: "stale" });
    return { ...page, items, coverage: coverage(from, to, items.length, gaps, absent) };
  });
}

// ---------------------------------------------------------------- per-attempt burn

/**
 * Where a window's `fromPercent` came from:
 *   - `window`: the high-water of its own readings at or before the attempt's start;
 *   - `reset`: 0, because the previous instance of the limit reset inside the attempt, so this
 *     instance began during it. A reset is the provider's statement that usage restarts;
 *   - `superseded_window`: the high-water at the start of the instance this one superseded
 *     (a moved reset), when this one's readings continue from it;
 *   - `first_reading`: its first reading inside the attempt. Usage before that reading is not
 *     seen, so the delta can only be too low (`lowerBound: true`).
 */
export type BurnBaseline = "window" | "reset" | "superseded_window" | "first_reading";

/** One window instance's part of an attempt's burn. */
export interface WindowBurn {
  readonly windowId: string;
  readonly resetsAt: string | null;
  /** The usage at the attempt's start in this window; see {@link BurnBaseline}. */
  readonly fromPercent: number | null;
  readonly baseline: BurnBaseline | null;
  /** The high-water at the attempt's end (for an open attempt, now). */
  readonly toPercent: number | null;
  readonly deltaPercent: number | null;
  /** True when usage before the first reading inside the attempt was not seen, so the delta can only be too low. */
  readonly lowerBound: boolean;
  readonly missing: Missing;
}

export interface LimitBurn {
  readonly limitKey: string;
  /** The sum of `windows[].deltaPercent` that are known; null when none is. */
  readonly burnPercent: number | null;
  /** True when any window in the sum is a lower bound: the burn is at least `burnPercent`. */
  readonly lowerBound: boolean;
  readonly coverage: { readonly known: number; readonly total: number };
  readonly partial: boolean;
  readonly regressionCount: number;
  readonly windows: WindowBurn[];
  readonly missing: Missing;
}

export interface AttemptBurn {
  readonly provider: string | null;
  readonly accountRef: string | null;
  /** The span the burn is measured over. */
  readonly from: string;
  readonly to: string;
  /**
   * `sole_known`: every count this machine recorded says no other attempt it knows of ran on
   * the account during the span. `shared`: another did. Null with a reason when a count is
   * unknown, or when there is no burn. Never a claim that the delta is exclusive.
   */
  readonly attribution: "sole_known" | "shared" | null;
  /** Samples ingestion linked to this attempt (`attemptId`). */
  readonly linkedSampleCount: number | null;
  readonly limits: LimitBurn[];
  readonly missing: Missing;
}

/**
 * `shared` on any evidence of another attempt on the account during the span; `sole_known`
 * only when every count was known and none showed one; otherwise unknown, with the reason
 * the count was missing. An unknown count never reads as "alone".
 */
function attributionOf(
  hub: DatabaseSync,
  attempt: AttemptView,
  accountRef: string,
  from: string,
  to: string,
  transitions: readonly AttemptTransition[],
): { value: "shared" | "sole_known" | null; reason: string | null } {
  let unknown: string | null = transitions.length === 0 ? "input_missing" : null;
  for (const transition of transitions) {
    const count = transition.concurrency?.storedOpenAttemptsOnAccountStartedHere;
    if (typeof count === "number") {
      if (count > 1) return { value: "shared", reason: null };
    } else if (unknown === null) {
      const missing = transition.concurrency?.missing as Record<string, unknown> | undefined;
      const reason = missing?.storedOpenAttemptsOnAccountStartedHere;
      unknown = typeof reason === "string" ? reason : "input_missing";
    }
  }
  const presence = hub.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempt_presence'").get();
  if (presence) {
    const other = hub
      .prepare(
        `SELECT 1 FROM attempt_presence
          WHERE account_ref = ? AND attempt_id <> ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1`,
      )
      .get(accountRef, attempt.id, to, from);
    if (other !== undefined) return { value: "shared", reason: null };
  } else if (unknown === null) {
    unknown = "source_unavailable";
  }
  return unknown === null ? { value: "sole_known", reason: null } : { value: null, reason: unknown };
}

const highOf = (list: readonly WindowSampleView[]): number | null => (list.length === 0 ? null : Math.max(...list.map((sample) => sample.usedPercent!)));

function windowBurn(
  store: BudgetStore,
  window: LimitWindow,
  from: string,
  to: string,
  context: { beganInside: boolean; supersededBaseline: number | null },
): { burn: WindowBurn; regressions: number } {
  const samples = store.samplesInWindow(window.id).filter((sample) => sample.usedPercent !== null);
  const before = samples.filter((sample) => sample.observedAt <= from);
  const inside = samples.filter((sample) => sample.observedAt > from && sample.observedAt <= to);
  const regressions = inside.filter((sample) => sample.regression).length;
  const missing: Missing = {};
  if (inside.length === 0) {
    // Nothing was read while the attempt ran: a reading before it says nothing about what it
    // burned, and reading it as a measured 0 would be the error this contract exists to stop.
    for (const field of ["toPercent", "deltaPercent", "baseline"]) missing[field] = "stale";
    const fromPercent = highOf(before);
    if (fromPercent === null) missing.fromPercent = "stale";
    return {
      burn: { windowId: window.id, resetsAt: window.resetsAt, fromPercent, baseline: null, toPercent: null, deltaPercent: null, lowerBound: false, missing },
      regressions,
    };
  }
  const toPercent = highOf([...before, ...inside])!;
  let fromPercent: number;
  let baseline: BurnBaseline;
  let lowerBound = false;
  if (before.length > 0) {
    fromPercent = highOf(before)!;
    baseline = "window";
  } else if (context.beganInside) {
    fromPercent = 0;
    baseline = "reset";
  } else if (context.supersededBaseline !== null && context.supersededBaseline <= toPercent) {
    fromPercent = context.supersededBaseline;
    baseline = "superseded_window";
  } else {
    fromPercent = inside[0]!.usedPercent!;
    baseline = "first_reading";
    lowerBound = true;
  }
  return {
    burn: { windowId: window.id, resetsAt: window.resetsAt, fromPercent, baseline, toPercent, deltaPercent: Math.max(0, toPercent - fromPercent), lowerBound, missing },
    regressions,
  };
}

/**
 * The burn read from the instances a moved reset superseded, for when the instance that
 * replaced them holds no reading inside the attempt (or does not reach it at all). Their
 * readings during the attempt are real usage of the same limit, so they are used rather
 * than reading the limit as unknown. Reported with the `superseded_window` baseline, or as a
 * `first_reading` lower bound when none of them was read before the attempt. Null when they
 * hold no reading inside the attempt either.
 */
function supersededBurn(store: BudgetStore, superseded: readonly LimitWindow[], from: string, to: string): { burn: WindowBurn; regressions: number } | null {
  if (superseded.length === 0) return null;
  const samples = superseded
    .flatMap((window) => store.samplesInWindow(window.id).map((sample) => ({ sample, window })))
    .filter(({ sample }) => sample.usedPercent !== null)
    .sort((a, b) => (a.sample.observedAt === b.sample.observedAt ? (a.sample.id < b.sample.id ? -1 : 1) : a.sample.observedAt < b.sample.observedAt ? -1 : 1));
  const before = samples.filter(({ sample }) => sample.observedAt <= from).map(({ sample }) => sample);
  const insideRows = samples.filter(({ sample }) => sample.observedAt > from && sample.observedAt <= to);
  if (insideRows.length === 0) return null;
  const inside = insideRows.map(({ sample }) => sample);
  const window = insideRows[insideRows.length - 1]!.window;
  const toPercent = highOf([...before, ...inside])!;
  const lowerBound = before.length === 0;
  const fromPercent = lowerBound ? inside[0]!.usedPercent! : highOf(before)!;
  return {
    burn: {
      windowId: window.id,
      resetsAt: window.resetsAt,
      fromPercent,
      baseline: lowerBound ? "first_reading" : "superseded_window",
      toPercent,
      deltaPercent: Math.max(0, toPercent - fromPercent),
      lowerBound,
      missing: {},
    },
    regressions: inside.filter((sample) => sample.regression).length,
  };
}

/**
 * An attempt's burn: per limit of its account, the readings that bracket the attempt inside
 * each window instance, by the high-water rule, summed across instances when it spans a
 * reset. A window counts only with a reading inside the attempt. Null with a reason when it
 * cannot be joined: no account (`no_provider_binding`), an attempt another device opened
 * (`not_on_this_device`: budget data does not replicate), no readings at all
 * (`no_sample_yet` / `source_unavailable`), or none while it ran (`stale`).
 */
export function attemptBurn(
  home: string,
  attempt: AttemptView,
  context: { openedHere: boolean; transitions: readonly AttemptTransition[]; now?: string },
): AttemptBurn {
  const now = context.now ?? nowIso();
  const from = attempt.startedAt;
  const to = attempt.endedAt ?? attempt.endedAtBound ?? (attempt.state === "ended" ? attempt.lastActivityAt : now);
  const binding = attempt.providerBinding;
  const empty = (reason: string): AttemptBurn => ({
    provider: binding?.provider ?? null,
    accountRef: binding?.accountRef ?? null,
    from,
    to,
    attribution: null,
    linkedSampleCount: null,
    limits: [],
    missing: { limits: reason, attribution: reason, linkedSampleCount: reason },
  });
  if (binding === null) return empty("no_provider_binding");
  if (!context.openedHere) return empty("not_on_this_device");
  const telemetry = telemetryOf(home);
  return withHub(home, (hub) => {
    if (hub === null) return empty(absentReason(telemetry, binding.accountRef));
    const store = new BudgetStore(hub);
    const windows = store
      .listWindows({ accountRef: binding.accountRef }, now)
      .filter((window) => binding.provider === null || window.provider === binding.provider);
    const linkedSampleCount = (hub.prepare("SELECT COUNT(*) AS n FROM budget_samples WHERE attempt_id = ?").get(attempt.id) as { n: number }).n;
    if (windows.length === 0) {
      const reason = absentReason(telemetry, binding.accountRef);
      return { ...empty(reason), linkedSampleCount, missing: { limits: reason, attribution: reason } };
    }

    const byLimit = new Map<string, LimitWindow[]>();
    for (const window of windows) byLimit.set(window.limitKey, [...(byLimit.get(window.limitKey) ?? []), window]);
    const limits: LimitBurn[] = [];
    for (const [limitKey, all] of [...byLimit.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const missing: Missing = {};
      if (all.some((window) => window.resetsAt === null)) {
        // High-water, and with it burn, is undefined for a sliding window.
        missing.burnPercent = "sliding_window";
        limits.push({ limitKey, burnPercent: null, lowerBound: false, coverage: { known: 0, total: 0 }, partial: false, regressionCount: 0, windows: [], missing });
        continue;
      }
      // The instances the span touches. A superseded instance is replaced by the one whose
      // reset moved; its readings serve as that one's baseline rather than as a second sum
      // over the same usage.
      const live = all.filter((window) => window.supersededBy === null);
      const touches = (window: LimitWindow): boolean => {
        const start = window.startsAt ?? window.firstSampleAt;
        return ms(window.resetsAt!) > ms(from) && (start === null || ms(start) <= ms(to));
      };
      const overlapping = live.filter(touches);
      const supersededBy = (id: string): LimitWindow[] => all.filter((other) => other.supersededBy === id && touches(other));
      const parts = overlapping.map((window) => {
        const begins = window.startsAt ?? window.firstSampleAt ?? window.resetsAt!;
        const previousReset = live
          .filter((other) => other.id !== window.id && ms(other.resetsAt!) <= ms(begins) + WINDOW_TOLERANCE_MS)
          .map((other) => other.resetsAt!)
          .sort()
          .pop();
        const beganInside =
          (window.startsAt !== null && window.startsAt > from) ||
          (previousReset !== undefined && ms(previousReset) > ms(from) && ms(previousReset) <= ms(to));
        const superseded = all.filter((other) => other.supersededBy === window.id);
        const supersededBaseline = highOf(
          superseded.flatMap((other) => store.samplesInWindow(other.id).filter((sample) => sample.usedPercent !== null && sample.observedAt <= from)),
        );
        const part = windowBurn(store, window, from, to, { beganInside, supersededBaseline });
        // Nothing read in the replacement while the attempt ran: the instances it superseded
        // may have been, and their readings are the usage.
        if (part.burn.deltaPercent === null) return supersededBurn(store, supersededBy(window.id), from, to) ?? part;
        return part;
      });
      // A moved reset whose replacement does not reach the attempt at all: what the superseded
      // instances read during it is the only measure of the limit.
      const successors = new Set(overlapping.map((window) => window.id));
      const orphaned = new Map<string, LimitWindow[]>();
      for (const window of all) {
        if (window.supersededBy === null || successors.has(window.supersededBy) || !touches(window)) continue;
        orphaned.set(window.supersededBy, [...(orphaned.get(window.supersededBy) ?? []), window]);
      }
      for (const group of orphaned.values()) {
        const part = supersededBurn(store, group, from, to);
        if (part !== null) parts.push(part);
      }
      const known = parts.filter((part) => part.burn.deltaPercent !== null);
      const burnPercent = known.length === 0 ? null : known.reduce((sum, part) => sum + part.burn.deltaPercent!, 0);
      if (burnPercent === null) {
        missing.burnPercent = parts.every((part) => part.burn.missing.deltaPercent === "stale") ? "stale" : "input_missing";
      }
      limits.push({
        limitKey,
        burnPercent,
        lowerBound: known.some((part) => part.burn.lowerBound),
        coverage: { known: known.length, total: parts.length },
        partial: known.length > 0 && known.length < parts.length,
        regressionCount: parts.reduce((sum, part) => sum + part.regressions, 0),
        windows: parts.map((part) => part.burn),
        missing,
      });
    }
    const anyKnown = limits.some((limit) => limit.burnPercent !== null);
    const missing: Missing = {};
    let attribution: AttemptBurn["attribution"] = null;
    if (!anyKnown) missing.attribution = "input_missing";
    else {
      const found = attributionOf(hub, attempt, binding.accountRef, from, to, context.transitions);
      attribution = found.value;
      if (found.reason !== null) missing.attribution = found.reason;
    }
    return { provider: binding.provider, accountRef: binding.accountRef, from, to, attribution, linkedSampleCount, limits, missing };
  });
}
