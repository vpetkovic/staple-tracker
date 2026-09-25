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
import { BudgetStore, toSample, type BudgetSample, type LimitWindow, type Missing, type SampleRow, type WindowSampleView } from "./budget-store.js";
import { isKnownBinding, type TelemetryConfig } from "./config.js";
import { assertAccountRef, normalizeInstant, parseRelativeSeconds } from "./formats.js";
import {
  GAP_SECONDS,
  cutPage,
  decodeKeysetCursor,
  gapsIn,
  pageLimit,
  type KeysetPosition,
  type PageRequest,
  type TelemetryPage,
} from "./read-page.js";

const ms = (instant: string): number => Date.parse(instant);

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
  /** True when the latest sample was recorded longer ago than capture allows (`recordedAt`, the local clock). */
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
    const newest = windows[windows.length - 1] ?? null;
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
    stale: latest === null ? null : ms(now) - ms(latest.recordedAt) > GAP_SECONDS * 1000,
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
 */
export function listBudgetSamples(
  home: string,
  query: { account: string; since?: string; now?: string } & PageRequest,
): TelemetryPage<HistorySample> {
  if (query.account === undefined || query.account.trim() === "") throw new StapleError("validation", "Budget history needs --account: the label of the account to read.");
  const account = assertAccountRef(query.account, "--account");
  const now = query.now ?? nowIso();
  const since = parseSince(query.since, now);
  const limit = pageLimit(query.limit);
  // `since` is fingerprinted as given, so a relative one keeps meaning the same page.
  const scope = { account, since: query.since ?? null };
  const position = query.cursor === undefined ? null : decodeKeysetCursor("budget_samples", scope, query.cursor);
  return withHub(home, (hub) => {
    const rows =
      hub === null
        ? []
        : (hub
            .prepare(
              `SELECT * FROM budget_samples
                WHERE account_ref = ?
                  AND (? IS NULL OR observed_at >= ?)
                  AND (? IS NULL OR observed_at > ? OR (observed_at = ? AND id > ?))
                ORDER BY observed_at, id LIMIT ?`,
            )
            .all(account, since, since, position?.at ?? null, position?.at ?? null, position?.at ?? null, position?.id ?? null, limit + 1) as unknown as SampleRow[]);
    const page = cutPage(rows.map(toSample), limit, "budget_samples", scope, sampleKey);
    const regressionOf = (sample: BudgetSample): boolean => {
      if (hub === null || sample.windowId === null || sample.usedPercent === null) return false;
      const row = hub
        .prepare(
          `SELECT MAX(used_percent) AS high FROM budget_samples
            WHERE window_id = ? AND (observed_at < ? OR (observed_at = ? AND id < ?))`,
        )
        .get(sample.windowId, sample.observedAt, sample.observedAt, sample.id) as { high: number | null };
      return row.high !== null && sample.usedPercent < row.high;
    };
    const items = page.items.map((sample) => ({ ...sample, regression: regressionOf(sample) }));
    const from = position?.at ?? since ?? items[0]?.observedAt ?? null;
    const to = page.truncated ? items[items.length - 1]!.observedAt : now;
    const earlier =
      from !== null && hub !== null && hub.prepare("SELECT 1 FROM budget_samples WHERE account_ref = ? AND observed_at < ? LIMIT 1").get(account, from) !== undefined;
    const telemetry = telemetryOf(home);
    const never = hub === null || hub.prepare("SELECT 1 FROM budget_samples WHERE account_ref = ? LIMIT 1").get(account) === undefined;
    const gaps = gapsIn(
      items.map((sample) => sample.observedAt),
      { from, to },
      { leading: earlier ? "stale" : never ? absentReason(telemetry, account) : "no_sample_yet", between: "stale", trailing: "stale" },
    );
    return { ...page, items, coverage: { from, to, itemCount: items.length, gaps } };
  });
}

// ---------------------------------------------------------------- per-attempt burn

/** One window instance's part of an attempt's burn. */
export interface WindowBurn {
  readonly windowId: string;
  readonly resetsAt: string | null;
  /** The high-water at the attempt's start, or the first reading inside it (`lowerBound`). */
  readonly fromPercent: number | null;
  /** The high-water at the attempt's end (for an open attempt, now). */
  readonly toPercent: number | null;
  readonly deltaPercent: number | null;
  /** True when no reading preceded the attempt in this window, so the delta can only be too low. */
  readonly lowerBound: boolean;
  readonly missing: Missing;
}

export interface LimitBurn {
  readonly limitKey: string;
  /** The sum of `windows[].deltaPercent` that are known; null when none is. */
  readonly burnPercent: number | null;
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
   * `sole_known`: no other attempt this machine knows of ran on the account during the span.
   * `shared`: another did. Never a claim that the delta is exclusive. Null with no burn.
   */
  readonly attribution: "sole_known" | "shared" | null;
  /** Samples ingestion linked to this attempt (`attemptId`). */
  readonly linkedSampleCount: number | null;
  readonly limits: LimitBurn[];
  readonly missing: Missing;
}

/** Whether another attempt this machine started ran on the same account during the span. */
function sharedDuring(hub: DatabaseSync, attempt: AttemptView, accountRef: string, from: string, to: string, transitions: readonly AttemptTransition[]): boolean {
  for (const transition of transitions) {
    const count = transition.concurrency?.storedOpenAttemptsOnAccountStartedHere;
    if (typeof count === "number" && count > 1) return true;
  }
  const presence = hub.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempt_presence'").get();
  if (!presence) return false;
  const other = hub
    .prepare(
      `SELECT 1 FROM attempt_presence
        WHERE account_ref = ? AND attempt_id <> ? AND started_at <= ? AND (ended_at IS NULL OR ended_at > ?) LIMIT 1`,
    )
    .get(accountRef, attempt.id, to, from);
  return other !== undefined;
}

function windowBurn(store: BudgetStore, window: LimitWindow, from: string, to: string): { burn: WindowBurn; regressions: number } {
  const samples = store.samplesInWindow(window.id).filter((sample) => sample.usedPercent !== null);
  const high = (list: readonly WindowSampleView[]): number | null => (list.length === 0 ? null : Math.max(...list.map((sample) => sample.usedPercent!)));
  const before = samples.filter((sample) => sample.observedAt <= from);
  const inside = samples.filter((sample) => sample.observedAt > from && sample.observedAt <= to);
  const upTo = samples.filter((sample) => sample.observedAt <= to);
  const missing: Missing = {};
  let fromPercent = high(before);
  let lowerBound = false;
  if (fromPercent === null && inside.length > 0) {
    fromPercent = inside[0]!.usedPercent;
    lowerBound = true;
  }
  const toPercent = high(upTo);
  if (fromPercent === null) missing.fromPercent = "no_sample_yet";
  if (toPercent === null) missing.toPercent = "no_sample_yet";
  const deltaPercent = fromPercent === null || toPercent === null ? null : Math.max(0, toPercent - fromPercent);
  if (deltaPercent === null) missing.deltaPercent = "input_missing";
  return {
    burn: { windowId: window.id, resetsAt: window.resetsAt, fromPercent, toPercent, deltaPercent, lowerBound, missing },
    regressions: inside.filter((sample) => sample.regression).length,
  };
}

/**
 * An attempt's burn: per limit of its account, the samples that bracket the attempt inside
 * each window instance, by the high-water rule, summed across instances when it spans a
 * reset. Null with a reason when it cannot be joined: no account (`no_provider_binding`), an
 * attempt another device opened (`not_on_this_device`: budget data does not replicate), or no
 * readings at all (`no_sample_yet` / `source_unavailable`).
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
        limits.push({ limitKey, burnPercent: null, coverage: { known: 0, total: 0 }, partial: false, regressionCount: 0, windows: [], missing });
        continue;
      }
      // The instances the span touches. A superseded instance is replaced by the one whose
      // reset moved; counting both would count one usage twice, so it is left out.
      const overlapping = all.filter((window) => {
        const start = window.startsAt ?? window.firstSampleAt;
        return window.supersededBy === null && ms(window.resetsAt!) > ms(from) && (start === null || ms(start) <= ms(to));
      });
      const parts = overlapping.map((window) => windowBurn(store, window, from, to));
      const known = parts.filter((part) => part.burn.deltaPercent !== null);
      const burnPercent = known.length === 0 ? null : known.reduce((sum, part) => sum + part.burn.deltaPercent!, 0);
      if (burnPercent === null) missing.burnPercent = overlapping.length === 0 ? "stale" : "input_missing";
      limits.push({
        limitKey,
        burnPercent,
        coverage: { known: known.length, total: overlapping.length },
        partial: known.length > 0 && known.length < overlapping.length,
        regressionCount: parts.reduce((sum, part) => sum + part.regressions, 0),
        windows: parts.map((part) => part.burn),
        missing,
      });
    }
    const anyKnown = limits.some((limit) => limit.burnPercent !== null);
    const missing: Missing = {};
    if (!anyKnown) missing.attribution = "input_missing";
    return {
      provider: binding.provider,
      accountRef: binding.accountRef,
      from,
      to,
      attribution: anyKnown ? (sharedDuring(hub, attempt, binding.accountRef, from, to, context.transitions) ? "shared" : "sole_known") : null,
      linkedSampleCount,
      limits,
      missing,
    };
  });
}
