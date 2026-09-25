/**
 * Limit windows and budget samples in `hub.db` (docs/execution-telemetry.md, "Limit
 * windows", "Budget samples", "Missingness").
 *
 * One method writes: {@link BudgetStore.record}, called once per reading by the single
 * ingestion method every surface uses (`ingest.ts`). It places the reading in a window
 * instance, decides by the ingestion cadence whether it is a new fact, and stores it as
 * reported. Nothing here clamps, rounds, interpolates or carries a value forward: a
 * stored sample is always a reading.
 *
 * The reads below are pure reads of these two tables. The regression flag and the
 * high-water mark are derived here, at read, and never written back.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db.js";
import { budgetDedupKey, type BudgetSourceKind, windowLabel } from "./formats.js";
import { sampleQuality, type BudgetState, type Quality } from "./quality.js";

/** Samples join a window when their resets are this close (Window identity). */
export const WINDOW_TOLERANCE_SECONDS = 120;
/** An unchanged reading is stored again, as a heartbeat, once the last one is this old. */
export const HEARTBEAT_SECONDS = 300;

export type BudgetUnit = "percent_of_limit" | "tokens" | "usd" | "requests";
export type Confidence = "high" | "medium" | "low";
export type ResetsAtSource = "observed_absolute" | "derived_from_relative";
export type WindowSecondsSource = "observed" | "documented";
export type ObservedAtSource = "provider" | "capture";

/** A missingness map: `{ "<field>": "<reason code>" }`, one entry per null measurable field. */
export type Missing = Record<string, string>;

/** One reading, normalized by a source parser and not yet bound to an account. */
export interface BudgetReading {
  readonly limitKey: string;
  readonly unit: "percent_of_limit";
  /** As reported: fractional values and values above 100 are kept. */
  readonly usedPercent: number;
  readonly resetsAt: string | null;
  readonly resetsAtSource: ResetsAtSource | null;
  readonly windowSeconds: number | null;
  readonly windowSecondsSource: WindowSecondsSource | null;
  readonly planTier: string | null;
  readonly method: "observed";
  readonly confidence: Confidence;
  readonly source: { readonly kind: BudgetSourceKind; readonly harnessVersion: string | null; readonly field: string };
  readonly observedAt: string;
  readonly observedAtSource: ObservedAtSource;
  readonly sessionRef: string | null;
  /** Why the source left a field null: `resetsAt`, `windowSeconds`, `planTier`, `sessionRef`. */
  readonly missing: Missing;
}

/** The link to an attempt, or why there is none (Linking samples to attempts). */
export type AttemptLink = { readonly attemptId: string } | { readonly reason: "no_matching_attempt" | "ambiguous_attempt" };

export interface RecordInput {
  readonly reading: BudgetReading;
  readonly provider: string;
  readonly accountRef: string;
  readonly recordedAt: string;
  readonly attempt: AttemptLink;
}

export interface BudgetSample {
  readonly id: string;
  readonly windowId: string | null;
  readonly provider: string;
  readonly accountRef: string;
  readonly limitKey: string;
  readonly unit: string;
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly exceeded: boolean | null;
  readonly resetsAt: string | null;
  readonly resetsAtSource: string | null;
  readonly windowSeconds: number | null;
  readonly windowSecondsSource: string | null;
  readonly method: string;
  readonly confidence: string;
  readonly source: { readonly kind: string; readonly harnessVersion: string | null; readonly field: string };
  readonly observedAt: string;
  readonly observedAtSource: string;
  readonly recordedAt: string;
  readonly attemptId: string | null;
  readonly sessionRef: string | null;
  readonly heartbeat: boolean;
  readonly dedupKey: string;
  readonly missing: Missing;
}

export type WindowStatus = "current" | "elapsed" | "superseded";

export interface LimitWindow {
  readonly id: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly limitKey: string;
  readonly label: string | null;
  readonly windowSeconds: number | null;
  readonly windowSecondsSource: string | null;
  readonly anchor: string;
  readonly resetsAt: string | null;
  readonly resetsAtSource: string | null;
  readonly startsAt: string | null;
  readonly firstSampleAt: string | null;
  readonly lastSampleAt: string | null;
  readonly planTier: string | null;
  readonly supersededBy: string | null;
  readonly supersededReason: string | null;
  readonly status: WindowStatus;
  readonly missing: Missing;
}

/** Why a reading was not stored. `unchanged` is the cadence; the others come from the sources. */
export type SkipReason = "unchanged" | "fork_copied" | "not_reported_by_source" | "parse_error";

export type SampleOutcome =
  | { readonly stored: true; readonly sample: BudgetSample & { readonly quality: Quality<BudgetState> } }
  | { readonly stored: false; readonly reason: SkipReason; readonly limitKey: string | null; readonly observedAt: string | null };

/** A sample as a read shows it inside one window: `regression` is derived, never stored. */
export interface WindowSampleView extends BudgetSample {
  readonly regression: boolean;
}

export interface WindowHighWater {
  readonly windowId: string;
  /** The highest `usedPercent` observed in the window so far, or null with a reason. */
  readonly highWaterPercent: number | null;
  /** `max(0, 100 − highWaterPercent)`, the conservative remaining figure. */
  readonly remainingPercent: number | null;
  readonly regressionCount: number;
  readonly sampleCount: number;
  readonly missing: Missing;
}

interface SampleRow {
  id: string;
  window_id: string | null;
  provider: string;
  account_ref: string;
  limit_key: string;
  unit: string;
  used_percent: number | null;
  remaining_percent: number | null;
  exceeded: number | null;
  resets_at: string | null;
  resets_at_source: string | null;
  window_seconds: number | null;
  window_seconds_source: string | null;
  method: string;
  confidence: string;
  source_kind: string;
  source_harness_version: string | null;
  source_field: string;
  observed_at: string;
  observed_at_source: string;
  recorded_at: string;
  attempt_id: string | null;
  session_ref: string | null;
  heartbeat: number;
  dedup_key: string;
  missing: string;
}

interface WindowRow {
  id: string;
  provider: string;
  account_ref: string;
  limit_key: string;
  window_seconds: number | null;
  window_seconds_source: string | null;
  anchor: string;
  resets_at: string | null;
  resets_at_source: string | null;
  starts_at: string | null;
  plan_tier: string | null;
  superseded_by: string | null;
  superseded_reason: string | null;
  missing: string;
  created_at: string;
  first_sample_at: string | null;
  last_sample_at: string | null;
}

const ms = (instant: string): number => Date.parse(instant);

function parseMissing(text: string): Missing {
  try {
    const value = JSON.parse(text) as unknown;
    return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Missing) : {};
  } catch {
    return {};
  }
}

function toSample(row: SampleRow): BudgetSample {
  return {
    id: row.id,
    windowId: row.window_id,
    provider: row.provider,
    accountRef: row.account_ref,
    limitKey: row.limit_key,
    unit: row.unit,
    usedPercent: row.used_percent,
    remainingPercent: row.remaining_percent,
    exceeded: row.exceeded === null ? null : row.exceeded === 1,
    resetsAt: row.resets_at,
    resetsAtSource: row.resets_at_source,
    windowSeconds: row.window_seconds,
    windowSecondsSource: row.window_seconds_source,
    method: row.method,
    confidence: row.confidence,
    source: { kind: row.source_kind, harnessVersion: row.source_harness_version, field: row.source_field },
    observedAt: row.observed_at,
    observedAtSource: row.observed_at_source,
    recordedAt: row.recorded_at,
    attemptId: row.attempt_id,
    sessionRef: row.session_ref,
    heartbeat: row.heartbeat === 1,
    dedupKey: row.dedup_key,
    missing: parseMissing(row.missing),
  };
}

/** `status` is derived at read: superseded when replaced, otherwise by the clock against the reset. */
function windowStatus(row: WindowRow, now: string): WindowStatus {
  if (row.superseded_by !== null) return "superseded";
  if (row.resets_at === null) return "current"; // a sliding window has no reset to pass
  return ms(now) < ms(row.resets_at) ? "current" : "elapsed";
}

function toWindow(row: WindowRow, now: string): LimitWindow {
  return {
    id: row.id,
    provider: row.provider,
    accountRef: row.account_ref,
    limitKey: row.limit_key,
    label: windowLabel(row.window_seconds),
    windowSeconds: row.window_seconds,
    windowSecondsSource: row.window_seconds_source,
    anchor: row.anchor,
    resetsAt: row.resets_at,
    resetsAtSource: row.resets_at_source,
    startsAt: row.starts_at,
    firstSampleAt: row.first_sample_at,
    lastSampleAt: row.last_sample_at,
    planTier: row.plan_tier,
    supersededBy: row.superseded_by,
    supersededReason: row.superseded_reason,
    status: windowStatus(row, now),
    missing: parseMissing(row.missing),
  };
}

/** The window columns plus the derived bounds of what was actually observed. */
const WINDOW_SELECT = `SELECT w.*,
  (SELECT MIN(s.observed_at) FROM budget_samples s WHERE s.window_id = w.id) AS first_sample_at,
  (SELECT MAX(s.observed_at) FROM budget_samples s WHERE s.window_id = w.id) AS last_sample_at
FROM limit_windows w`;

/** Normalization is arithmetic on the reported value and nothing else (Units). */
export function normalizePercent(usedPercent: number): { remainingPercent: number; exceeded: boolean } {
  return { remainingPercent: Math.max(0, 100 - usedPercent), exceeded: usedPercent >= 100 };
}

export class BudgetStore {
  constructor(readonly db: DatabaseSync) {}

  /**
   * Store one reading, or say why not. In one transaction: find the window instance the
   * reading belongs to, compare it with the latest stored reading of the same window and
   * harness session, and only then mint a window (and supersede an overlapping one) and
   * write the sample.
   */
  record(input: RecordInput): SampleOutcome {
    return tx(this.db, () => this.recordInTransaction(input));
  }

  private recordInTransaction(input: RecordInput): SampleOutcome {
    const { reading, provider, accountRef } = input;
    const skipped = (reason: SkipReason): SampleOutcome => ({ stored: false, reason, limitKey: reading.limitKey, observedAt: reading.observedAt });

    const joined = reading.resetsAt === null ? null : this.matchingWindow(provider, accountRef, reading.limitKey, reading.resetsAt);
    const needsWindow = reading.resetsAt !== null && joined === null;

    let heartbeat = false;
    if (!needsWindow) {
      const neighbour = this.neighbour({
        windowId: joined?.id ?? null,
        provider,
        accountRef,
        limitKey: reading.limitKey,
        sessionRef: reading.sessionRef,
        observedAt: reading.observedAt,
      });
      if (neighbour !== null) {
        const sameValue = neighbour.used_percent === reading.usedPercent;
        const sameReset =
          neighbour.resets_at === reading.resetsAt ||
          (neighbour.resets_at !== null &&
            reading.resetsAt !== null &&
            Math.abs(ms(neighbour.resets_at) - ms(reading.resetsAt)) <= WINDOW_TOLERANCE_SECONDS * 1000);
        const stale = ms(reading.observedAt) - ms(neighbour.observed_at) > HEARTBEAT_SECONDS * 1000;
        if (sameValue && sameReset) {
          if (!stale) return skipped("unchanged");
          heartbeat = true;
        }
      }
    }

    const dedupKey = budgetDedupKey({
      sourceKind: reading.source.kind,
      accountRef,
      limitKey: reading.limitKey,
      sessionRef: reading.sessionRef,
      resetsAt: reading.resetsAt,
      usedPercent: reading.usedPercent,
      observedAt: reading.observedAt,
    });
    // Replaying the same input stores nothing twice. Checked before a window is minted,
    // so a replay cannot mint one either.
    if (this.db.prepare("SELECT 1 FROM budget_samples WHERE dedup_key = ?").get(dedupKey) !== undefined) {
      return skipped("unchanged");
    }

    const windowId = needsWindow ? this.openWindow(input) : (joined?.id ?? null);
    const missing: Missing = { ...reading.missing };
    if (windowId === null) missing.windowId = "reset_not_reported";
    if (reading.resetsAt === null && missing.resetsAt === undefined) missing.resetsAt = "reset_not_reported";
    if (reading.windowSeconds === null && missing.windowSeconds === undefined) missing.windowSeconds = "not_reported_by_source";
    if (reading.sessionRef === null && missing.sessionRef === undefined) missing.sessionRef = "not_reported_by_source";
    if ("reason" in input.attempt) missing.attemptId = input.attempt.reason;
    // `planTier` is a window field; a sample carries none, so it has no entry here.
    delete missing.planTier;

    const { remainingPercent, exceeded } = normalizePercent(reading.usedPercent);
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO budget_samples (
          id, window_id, provider, account_ref, limit_key, unit, used_percent, remaining_percent, exceeded,
          resets_at, resets_at_source, window_seconds, window_seconds_source, method, confidence,
          source_kind, source_harness_version, source_field, observed_at, observed_at_source, recorded_at,
          attempt_id, session_ref, heartbeat, dedup_key, missing
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        windowId,
        provider,
        accountRef,
        reading.limitKey,
        reading.unit,
        reading.usedPercent,
        remainingPercent,
        exceeded ? 1 : 0,
        reading.resetsAt,
        reading.resetsAtSource,
        reading.windowSeconds,
        reading.windowSecondsSource,
        reading.method,
        reading.confidence,
        reading.source.kind,
        reading.source.harnessVersion,
        reading.source.field,
        reading.observedAt,
        reading.observedAtSource,
        input.recordedAt,
        "attemptId" in input.attempt ? input.attempt.attemptId : null,
        reading.sessionRef,
        heartbeat ? 1 : 0,
        dedupKey,
        JSON.stringify(missing),
      );
    const sample = this.getSample(id)!;
    return { stored: true, sample: { ...sample, quality: sampleQuality(sample) } };
  }

  /**
   * The window instance a reading joins: same provider, account and limit, with a reset
   * within the tolerance. A current (unsuperseded) instance is preferred, then the
   * nearest reset, so a jittering provider keeps joining one window.
   */
  private matchingWindow(provider: string, accountRef: string, limitKey: string, resetsAt: string): WindowRow | null {
    const tolerance = WINDOW_TOLERANCE_SECONDS * 1000;
    const low = new Date(ms(resetsAt) - tolerance).toISOString();
    const high = new Date(ms(resetsAt) + tolerance).toISOString();
    const rows = this.db
      .prepare(
        `${WINDOW_SELECT} WHERE w.provider = ? AND w.account_ref = ? AND w.limit_key = ? AND w.resets_at BETWEEN ? AND ?`,
      )
      .all(provider, accountRef, limitKey, low, high) as unknown as WindowRow[];
    if (rows.length === 0) return null;
    rows.sort(
      (a, b) =>
        Number(a.superseded_by !== null) - Number(b.superseded_by !== null) ||
        Math.abs(ms(a.resets_at!) - ms(resetsAt)) - Math.abs(ms(b.resets_at!) - ms(resetsAt)) ||
        a.id.localeCompare(b.id),
    );
    return rows[0]!;
  }

  /**
   * The stored reading a new one is compared with: same window (or, for a reading with
   * no reset, same limit and no window) and same harness session, and the greatest
   * `observedAt` that is not after the new reading's. "Latest" is by `observedAt`, not
   * by recording order, so a backfill ingested out of order meets its real neighbour.
   */
  private neighbour(key: {
    windowId: string | null;
    provider: string;
    accountRef: string;
    limitKey: string;
    sessionRef: string | null;
    observedAt: string;
  }): SampleRow | null {
    const row =
      key.windowId !== null
        ? this.db
            .prepare(
              `SELECT * FROM budget_samples WHERE window_id = ? AND session_ref IS ? AND observed_at <= ?
               ORDER BY observed_at DESC, recorded_at DESC, id DESC LIMIT 1`,
            )
            .get(key.windowId, key.sessionRef, key.observedAt)
        : this.db
            .prepare(
              `SELECT * FROM budget_samples WHERE window_id IS NULL AND provider = ? AND account_ref = ? AND limit_key = ?
                 AND session_ref IS ? AND observed_at <= ?
               ORDER BY observed_at DESC, recorded_at DESC, id DESC LIMIT 1`,
            )
            .get(key.provider, key.accountRef, key.limitKey, key.sessionRef, key.observedAt);
    return (row as unknown as SampleRow | undefined) ?? null;
  }

  /**
   * Mint the window instance a reading opens, and settle its relation to the windows of
   * the same limit that already exist:
   *
   *   - one that had elapsed when the reading was taken is simply the previous instance;
   *   - one that had not begun by the reading's reset is simply a later instance (a
   *     backfill arriving after newer readings);
   *   - one that overlaps it is a moved reset (a provider-side reset, a changed plan).
   *     Both are kept. The one first observed earlier is marked superseded by the other,
   *     with reason `reset_moved`. Staple does not decide which reading was right.
   */
  private openWindow(input: RecordInput): string {
    const { reading, provider, accountRef } = input;
    const resetsAt = reading.resetsAt!;
    const id = randomUUID();
    const observed = reading.windowSecondsSource === "observed" && reading.windowSeconds !== null;
    const startsAt = observed ? new Date(ms(resetsAt) - reading.windowSeconds! * 1000).toISOString() : null;
    const missing: Missing = {};
    if (reading.windowSeconds === null) missing.windowSeconds = reading.missing.windowSeconds ?? "not_reported_by_source";
    if (startsAt === null) missing.startsAt = "not_reported_by_source";
    if (reading.planTier === null) missing.planTier = reading.missing.planTier ?? "not_reported_by_source";
    this.db
      .prepare(
        `INSERT INTO limit_windows (
          id, provider, account_ref, limit_key, window_seconds, window_seconds_source, anchor,
          resets_at, resets_at_source, starts_at, plan_tier, superseded_by, superseded_reason, missing, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'unknown', ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      )
      .run(
        id,
        provider,
        accountRef,
        reading.limitKey,
        reading.windowSeconds,
        reading.windowSecondsSource,
        resetsAt,
        reading.resetsAtSource,
        startsAt,
        reading.planTier,
        JSON.stringify(missing),
        input.recordedAt,
      );

    const tolerance = WINDOW_TOLERANCE_SECONDS * 1000;
    const observedAt = ms(reading.observedAt);
    const others = this.db
      .prepare(
        `${WINDOW_SELECT} WHERE w.provider = ? AND w.account_ref = ? AND w.limit_key = ? AND w.id <> ?
           AND w.superseded_by IS NULL AND w.resets_at IS NOT NULL`,
      )
      .all(provider, accountRef, reading.limitKey, id) as unknown as WindowRow[];
    let newIsSuperseded = false;
    for (const other of others) {
      if (observedAt >= ms(other.resets_at!)) continue; // elapsed when this reading was taken
      const begin = other.starts_at ?? other.first_sample_at;
      if (begin !== null && ms(resetsAt) <= ms(begin) + tolerance) continue; // ended before the other began
      const otherFirstSeen = other.first_sample_at === null ? Number.NEGATIVE_INFINITY : ms(other.first_sample_at);
      if (observedAt >= otherFirstSeen) {
        this.db
          .prepare("UPDATE limit_windows SET superseded_by = ?, superseded_reason = 'reset_moved' WHERE id = ?")
          .run(id, other.id);
      } else if (!newIsSuperseded) {
        this.db
          .prepare("UPDATE limit_windows SET superseded_by = ?, superseded_reason = 'reset_moved' WHERE id = ?")
          .run(other.id, id);
        newIsSuperseded = true;
      }
    }
    return id;
  }

  // ---------------------------------------------------------------- reads of own rows

  getSample(id: string): BudgetSample | null {
    const row = this.db.prepare("SELECT * FROM budget_samples WHERE id = ?").get(id) as unknown as SampleRow | undefined;
    return row === undefined ? null : toSample(row);
  }

  getWindow(id: string, now: string = new Date().toISOString()): LimitWindow | null {
    const row = this.db.prepare(`${WINDOW_SELECT} WHERE w.id = ?`).get(id) as unknown as WindowRow | undefined;
    return row === undefined ? null : toWindow(row, now);
  }

  /** Every window instance, oldest reset first. Filters narrow by account and limit. */
  listWindows(filter: { accountRef?: string; limitKey?: string } = {}, now: string = new Date().toISOString()): LimitWindow[] {
    const rows = this.db
      .prepare(
        `${WINDOW_SELECT} WHERE (? IS NULL OR w.account_ref = ?) AND (? IS NULL OR w.limit_key = ?)
         ORDER BY w.resets_at, w.created_at, w.id`,
      )
      .all(filter.accountRef ?? null, filter.accountRef ?? null, filter.limitKey ?? null, filter.limitKey ?? null) as unknown as WindowRow[];
    return rows.map((row) => toWindow(row, now));
  }

  /** Every sample, by `observedAt` then id. Filters narrow by account, limit and window. */
  listSamples(filter: { accountRef?: string; limitKey?: string; windowId?: string } = {}): BudgetSample[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM budget_samples WHERE (? IS NULL OR account_ref = ?) AND (? IS NULL OR limit_key = ?)
           AND (? IS NULL OR window_id = ?)
         ORDER BY observed_at, id`,
      )
      .all(
        filter.accountRef ?? null,
        filter.accountRef ?? null,
        filter.limitKey ?? null,
        filter.limitKey ?? null,
        filter.windowId ?? null,
        filter.windowId ?? null,
      ) as unknown as SampleRow[];
    return rows.map(toSample);
  }

  /**
   * One account's samples strictly after a keyset position `(observedAt, id)`, oldest first,
   * at most `limit`. The id breaks ties: one status-line render stores a sample per limit at
   * the same `observedAt`, so a position without it would skip or repeat them.
   */
  samplesAfter(query: { accountRef: string; since: string | null; after: { at: string; id: string } | null; limit: number }): BudgetSample[] {
    const at = query.after?.at ?? null;
    const rows = this.db
      .prepare(
        `SELECT * FROM budget_samples
          WHERE account_ref = ?
            AND (? IS NULL OR observed_at >= ?)
            AND (? IS NULL OR observed_at > ? OR (observed_at = ? AND id > ?))
          ORDER BY observed_at, id LIMIT ?`,
      )
      .all(query.accountRef, query.since, query.since, at, at, at, query.after?.id ?? null, query.limit) as unknown as SampleRow[];
    return rows.map(toSample);
  }

  /** The highest `usedPercent` in a sample's window before it, by `(observedAt, id)`; null when none. */
  highWaterBefore(sample: BudgetSample): number | null {
    if (sample.windowId === null) return null;
    const row = this.db
      .prepare(
        `SELECT MAX(used_percent) AS high FROM budget_samples
          WHERE window_id = ? AND (observed_at < ? OR (observed_at = ? AND id < ?))`,
      )
      .get(sample.windowId, sample.observedAt, sample.observedAt, sample.id) as { high: number | null };
    return row.high;
  }

  /** Whether the account holds any sample observed before `instant` (any at all when null). */
  hasSampleBefore(accountRef: string, instant: string | null): boolean {
    return (
      this.db.prepare("SELECT 1 FROM budget_samples WHERE account_ref = ? AND (? IS NULL OR observed_at < ?) LIMIT 1").get(accountRef, instant, instant) !==
      undefined
    );
  }

  /**
   * A window's samples by `observedAt`, each marked `regression: true` when it reads
   * below the highest earlier reading in the same window (Regressions within a window).
   * Derived here and never stored: every sample stays exactly as reported.
   */
  samplesInWindow(windowId: string): WindowSampleView[] {
    let highWater = Number.NEGATIVE_INFINITY;
    return this.listSamples({ windowId }).map((sample) => {
      const used = sample.usedPercent;
      const regression = used !== null && used < highWater;
      if (used !== null && used > highWater) highWater = used;
      return { ...sample, regression };
    });
  }

  /**
   * The window's high-water mark: the highest `usedPercent` observed so far, the
   * conservative reading for a budget, with the count of readings that fell below it.
   * Undefined for a sliding window (no reset, so no instance to take the maximum over).
   */
  windowHighWater(windowId: string): WindowHighWater | null {
    const window = this.db.prepare("SELECT resets_at FROM limit_windows WHERE id = ?").get(windowId) as
      | { resets_at: string | null }
      | undefined;
    if (window === undefined) return null;
    const samples = this.samplesInWindow(windowId);
    const missing: Missing = {};
    if (window.resets_at === null) {
      missing.highWaterPercent = "sliding_window";
      missing.remainingPercent = "sliding_window";
      return { windowId, highWaterPercent: null, remainingPercent: null, regressionCount: 0, sampleCount: samples.length, missing };
    }
    const known = samples.map((s) => s.usedPercent).filter((v): v is number => v !== null);
    if (known.length === 0) {
      missing.highWaterPercent = "no_sample_yet";
      missing.remainingPercent = "no_sample_yet";
      return { windowId, highWaterPercent: null, remainingPercent: null, regressionCount: 0, sampleCount: samples.length, missing };
    }
    const highWaterPercent = Math.max(...known);
    return {
      windowId,
      highWaterPercent,
      remainingPercent: normalizePercent(highWaterPercent).remainingPercent,
      regressionCount: samples.filter((s) => s.regression).length,
      sampleCount: samples.length,
      missing,
    };
  }
}
