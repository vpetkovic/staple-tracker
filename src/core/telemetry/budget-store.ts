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
import { StapleError } from "../types.js";
import { AUTHORITATIVE_SOURCE_KINDS, budgetDedupKey, type BudgetSourceKind, windowLabel } from "./formats.js";
import { sampleQuality, type BudgetState, type Quality } from "./quality.js";

/** Samples join a window when their resets are this close (Window identity). */
export const WINDOW_TOLERANCE_SECONDS = 120;
/** The shortest reading id prefix `forget` accepts: 8 characters, the first group of a UUID. */
export const MIN_ID_PREFIX = 8;
/** An unchanged reading is stored again, as a heartbeat, once the last one is this old. */
export const HEARTBEAT_SECONDS = 300;
/**
 * How far an authoritative reading may differ from another reading before it contradicts
 * it: below a window's high-water mark (towards `usage_reset`), or below a passive reading
 * (which then does not count). One point absorbs the rounding between sources (the status
 * line reports tenths, the usage endpoint whole or near-whole percents); anything more is
 * not rounding.
 */
export const USAGE_RESET_TOLERANCE_PERCENT = 1;
/**
 * How long the latest authoritative reading (a live poll) keeps holding back a passive
 * reading above it: twice the 5-minute schedule, so one late or failed poll does not lift
 * it, and a stopped poller (live polling off, every poll failing, the agent unloaded) lifts
 * it within ten minutes instead of hiding real usage until the window resets.
 */
export const POLL_FRESH_SECONDS = 600;
/**
 * How far after a read's `now` a poll's `observedAt` may be and still govern: this machine's
 * clock can step back (a sync correction), and a poll stamped in the future would otherwise
 * contradict every status-line reading after it until the window ends.
 */
export const POLL_CLOCK_SKEW_SECONDS = 60;

/**
 * What a read knows about live polling right now, which decides whether a passive reading
 * above the latest poll is held back ({@link BudgetStore}): only while polling is on and the
 * latest poll is fresh at `now`. With none given (the default), polling is taken as off.
 */
export interface PollGovernance {
  readonly livePolling: boolean;
  readonly now: string;
}

/** Whether a sample counts, and if not, why: a later poll that contradicted it, or none yet (held back). */
export interface SampleCounting {
  readonly counted: boolean;
  /** The id of the authoritative reading that contradicted it; null when it counts or is only held back. */
  readonly contradictedBy: string | null;
}

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

/**
 * Why a reading was not stored. `unchanged` is the cadence; `forgotten` is a reading the
 * operator removed (`forget`) coming back on a replay; the others come from the sources.
 */
export type SkipReason = "unchanged" | "forgotten" | "fork_copied" | "not_reported_by_source" | "parse_error";

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


/** One limit of one account: what `forget` summarizes before and after a removal. */
export interface LimitKey {
  readonly provider: string;
  readonly accountRef: string;
  readonly limitKey: string;
}

/** What a removal does to one window instance a removed reading belonged to. */
export interface ForgetWindowChange {
  readonly windowId: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly limitKey: string;
  readonly resetsAt: string | null;
  /** `removed` when no reading is left in it; `kept` otherwise, with the readings left. */
  readonly outcome: "kept" | "removed";
  readonly samplesLeft: number;
  /**
   * For a kept window whose opening reading was removed: the reading whose fields it now
   * carries (`resetsAt`, `windowSeconds`, `startsAt`), the earliest-recorded one left.
   * Null when the opening reading is still there.
   */
  readonly rederivedFrom: string | null;
  /**
   * The windows a removed window had superseded. Each is released and its overlap with
   * the windows still standing is settled again, so `supersededBy` is what it is now:
   * null when it stands again.
   */
  readonly released: ReadonlyArray<{ readonly windowId: string; readonly resetsAt: string | null; readonly supersededBy: string | null }>;
}

export interface ForgetOutcome<V> {
  /** True when the removal was committed; false for a preview, which is rolled back. */
  readonly applied: boolean;
  /** The removed readings, as they were stored. */
  readonly samples: BudgetSample[];
  readonly windows: ForgetWindowChange[];
  /** Each affected limit as `summarize` reads it, before and after the removal. */
  readonly limits: ReadonlyArray<LimitKey & { readonly before: V; readonly after: V }>;
}

/** Thrown inside the transaction to roll a preview back and carry its outcome out. */
class PreviewRollback<V> extends Error {
  constructor(readonly outcome: ForgetOutcome<V>) {
    super("preview");
  }
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
  constructor(
    readonly db: DatabaseSync,
    private readonly governance: PollGovernance = { livePolling: false, now: new Date().toISOString() },
  ) {}

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

    let joined = reading.resetsAt === null ? null : this.matchingWindow(provider, accountRef, reading.limitKey, reading.resetsAt);
    // A reading taken before a window was closed for a usage reset belongs to the window it
    // was taken in, not to the one that replaced it: a rollout scanned late, or a status line
    // observed before the reset poll, never lands in (and never raises) the corrected window.
    joined = joined === null ? null : this.windowAt(joined, reading.observedAt);
    // Two authoritative readings in a row below the window's counted high-water mark close
    // it (docs/execution-telemetry.md, "Window identity"): see {@link isUsageReset}.
    const corrected = joined !== null && this.isUsageReset(joined.id, reading) ? joined : null;
    if (corrected !== null) joined = null;
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
    // A reading the operator removed stays removed when the same input is read again. A
    // new observation of the same value has a new `observedAt`, so a new key.
    if (this.db.prepare("SELECT 1 FROM budget_forgotten WHERE dedup_key = ?").get(dedupKey) !== undefined) {
      return skipped("forgotten");
    }

    const windowId = needsWindow ? this.openWindow(input) : (joined?.id ?? null);
    if (corrected !== null && windowId !== null) {
      this.db.prepare("UPDATE limit_windows SET superseded_by = ?, superseded_reason = 'usage_reset' WHERE id = ?").run(windowId, corrected.id);
    }
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
   * Whether an authoritative reading shows the window's usage was reset in place, and the
   * window must be closed (`usage_reset`): this reading AND the previous authoritative
   * reading of the window are both more than {@link USAGE_RESET_TOLERANCE_PERCENT} below the
   * window's counted high-water mark up to this reading's instant. Two in a row, so one
   * outlier answer (a transient 0, two backends a couple of points apart) never closes a
   * window; a reset that moves the reset instant is the `reset_moved` rule's.
   */
  private isUsageReset(windowId: string, reading: BudgetReading): boolean {
    if (!AUTHORITATIVE_SOURCE_KINDS.has(reading.source.kind)) return false;
    // As of this reading, with polling on (a poll is arriving) and this reading counted among
    // the polls, so the decision sees what the window will be once it is stored.
    const incoming = { id: "\u0000incoming", observedAt: reading.observedAt, usedPercent: reading.usedPercent, source: reading.source } as unknown as BudgetSample;
    const before = this.countedSamples(windowId, reading.observedAt, { livePolling: true, now: reading.observedAt }, incoming).filter(
      (sample) => sample.observedAt < reading.observedAt,
    );
    const known = before.flatMap((sample) => (sample.usedPercent === null ? [] : [sample.usedPercent]));
    if (known.length === 0) return false;
    const floor = Math.max(...known) - USAGE_RESET_TOLERANCE_PERCENT;
    if (!(reading.usedPercent < floor)) return false;
    const previous = this.listSamples({ windowId })
      .filter((sample) => AUTHORITATIVE_SOURCE_KINDS.has(sample.source.kind) && sample.observedAt < reading.observedAt && sample.usedPercent !== null)
      .at(-1);
    return previous !== undefined && previous.usedPercent! < floor;
  }

  /**
   * The window a reading taken at `observedAt` belongs to: `window`, or, when `window`
   * replaced a window closed for a usage reset after that instant, the closed one (and so
   * on back through consecutive resets).
   */
  private windowAt(window: WindowRow, observedAt: string): WindowRow {
    let current = window;
    for (let depth = 0; depth < 64; depth += 1) {
      if (current.first_sample_at === null || observedAt >= current.first_sample_at) return current;
      const earlier = this.db.prepare(`${WINDOW_SELECT} WHERE w.superseded_by = ? AND w.superseded_reason = 'usage_reset'`).get(current.id) as unknown as
        | WindowRow
        | undefined;
      if (earlier === undefined) return current;
      current = earlier;
    }
    return current;
  }

  /**
   * Which samples of a window COUNT, by `observedAt` (up to `upTo` when given). While a
   * window holds authoritative readings (live polling), the provider's own figure governs
   * (docs/execution-telemetry.md, "Window identity"):
   *
   *   - A passive reading (status line, rollout, typed) a later poll CONFIRMS (reads no more
   *     than {@link USAGE_RESET_TOLERANCE_PERCENT} below it) counts.
   *   - One later polls all CONTRADICT does not count: an older cache re-rendered after a
   *     reset, a rollout line the provider has since overruled. A reading from before the
   *     window's first poll needs two contradicting polls, as closing a window does, so one
   *     outlier first answer cannot hide what the status line had been saying.
   *   - One taken after the latest poll and above it is HELD BACK while live polling is on
   *     and that poll is fresh ({@link POLL_FRESH_SECONDS}); the next poll confirms or
   *     contradicts it. Otherwise (polling off, failing, stopped) it counts, as before.
   *
   * Every sample stays exactly as stored; a window with no authoritative reading counts
   * every sample.
   */
  counting(
    windowId: string,
    upTo?: string,
    governance: PollGovernance = this.governance,
    incoming?: BudgetSample,
    listed: readonly BudgetSample[] = this.listSamples({ windowId }),
  ): Map<string, SampleCounting> {
    const stored = listed.filter((sample) => upTo === undefined || sample.observedAt <= upTo);
    const all = incoming === undefined ? stored : [...stored, incoming];
    // A poll stamped after `now` (beyond a small skew) comes from a clock that has since
    // stepped back: it governs nothing, or it would contradict every later reading for good.
    const horizon = Date.parse(governance.now) + POLL_CLOCK_SKEW_SECONDS * 1000;
    const polls = all
      .filter((sample) => AUTHORITATIVE_SOURCE_KINDS.has(sample.source.kind) && sample.usedPercent !== null && Date.parse(sample.observedAt) <= horizon)
      .sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
    const verdicts = new Map<string, SampleCounting>();
    const counts: SampleCounting = { counted: true, contradictedBy: null };
    const latest = polls[polls.length - 1];
    const first = polls[0];
    if (latest === undefined || first === undefined) {
      for (const sample of all) verdicts.set(sample.id, counts);
      return verdicts;
    }
    // One pass: the highest poll from each index on, and a cursor to the first poll after
    // each sample (samples come in `observedAt` order), so the rule is linear in the window.
    const suffixMax = new Array<number>(polls.length);
    for (let i = polls.length - 1; i >= 0; i -= 1) suffixMax[i] = Math.max(polls[i]!.usedPercent!, i + 1 < polls.length ? suffixMax[i + 1]! : Number.NEGATIVE_INFINITY);
    const fresh = governance.livePolling && Date.parse(governance.now) - Date.parse(latest.observedAt) <= POLL_FRESH_SECONDS * 1000;
    const ordered = [...all].sort((a, b) => (a.observedAt < b.observedAt ? -1 : a.observedAt > b.observedAt ? 1 : 0));
    let cursor = 0;
    for (const sample of ordered) {
      while (cursor < polls.length && polls[cursor]!.observedAt <= sample.observedAt) cursor += 1;
      if (AUTHORITATIVE_SOURCE_KINDS.has(sample.source.kind) || sample.usedPercent === null) {
        verdicts.set(sample.id, counts);
        continue;
      }
      const later = polls.length - cursor;
      if (later === 0) {
        const above = sample.usedPercent > latest.usedPercent! + USAGE_RESET_TOLERANCE_PERCENT;
        verdicts.set(sample.id, above && fresh ? { counted: false, contradictedBy: null } : counts);
        continue;
      }
      if (suffixMax[cursor]! >= sample.usedPercent - USAGE_RESET_TOLERANCE_PERCENT) {
        verdicts.set(sample.id, counts);
        continue;
      }
      const needed = sample.observedAt < first.observedAt ? 2 : 1;
      verdicts.set(sample.id, later >= needed ? { counted: false, contradictedBy: polls[cursor + needed - 1]!.id } : counts);
    }
    return verdicts;
  }

  private countedSamples(windowId: string, upTo?: string, governance: PollGovernance = this.governance, incoming?: BudgetSample): BudgetSample[] {
    const listed = this.listSamples({ windowId });
    const verdicts = this.counting(windowId, upTo, governance, incoming, listed);
    return listed.filter((sample) => (upTo === undefined || sample.observedAt <= upTo) && verdicts.get(sample.id)?.counted !== false);
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


  /** Whether the account holds any sample observed before `instant` (any at all when null). */
  hasSampleBefore(accountRef: string, instant: string | null): boolean {
    return (
      this.db.prepare("SELECT 1 FROM budget_samples WHERE account_ref = ? AND (? IS NULL OR observed_at < ?) LIMIT 1").get(accountRef, instant, instant) !==
      undefined
    );
  }

  /**
   * A window's samples that count ({@link countedSamples}) by `observedAt`, each marked
   * `regression: true` when it reads below the highest earlier reading in the same window
   * (Regressions within a window). Derived here and never stored: every sample stays
   * exactly as reported, and one that does not count is still listed by `listSamples`.
   */
  samplesInWindow(windowId: string): WindowSampleView[] {
    let highWater = Number.NEGATIVE_INFINITY;
    return this.countedSamples(windowId).map((sample) => {
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
  windowHighWater(windowId: string, counted?: readonly WindowSampleView[]): WindowHighWater | null {
    const window = this.db.prepare("SELECT resets_at FROM limit_windows WHERE id = ?").get(windowId) as
      | { resets_at: string | null }
      | undefined;
    if (window === undefined) return null;
    const samples = counted ?? this.samplesInWindow(windowId);
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

  // ------------------------------------------------------------------- removing readings

  /**
   * The stored readings `refs` name. Each ref is a full id, or a prefix of exactly one id.
   * All or nothing: an unknown ref is `not_found` and an ambiguous prefix is refused, both
   * before anything is removed.
   */
  resolveSamples(refs: readonly string[]): BudgetSample[] {
    const wanted = [...new Set(refs.map((ref) => ref.trim().toLowerCase()))];
    if (wanted.length === 0 || wanted.some((ref) => ref === "")) {
      throw new StapleError("validation", "Name at least one reading id (staple budget history --json shows them).");
    }
    const short = wanted.filter((ref) => ref.length < MIN_ID_PREFIX);
    if (short.length > 0) {
      throw new StapleError(
        "validation",
        `A reading id prefix needs at least ${MIN_ID_PREFIX} characters; ${short.map((ref) => `"${ref}"`).join(", ")} is shorter. Give more of the id (staple budget history --json shows them). Nothing was removed.`,
        { reason: "id_too_short", ids: short },
      );
    }
    const unknown: string[] = [];
    const ambiguous: Array<{ ref: string; matches: string[] }> = [];
    const found = new Map<string, SampleRow>();
    for (const ref of wanted) {
      // Ids are UUIDs, so anything else cannot name one; it is simply not found. This also
      // keeps LIKE's wildcards (`%`, `_`) out of the prefix match.
      const rows = /^[0-9a-f-]+$/.test(ref)
        ? (this.db.prepare("SELECT * FROM budget_samples WHERE id = ? OR id LIKE ? ORDER BY id LIMIT 6").all(ref, `${ref}%`) as unknown as SampleRow[])
        : [];
      const exact = rows.find((row) => row.id === ref);
      if (exact !== undefined) found.set(exact.id, exact);
      else if (rows.length === 1) found.set(rows[0]!.id, rows[0]!);
      else if (rows.length === 0) unknown.push(ref);
      else ambiguous.push({ ref, matches: rows.slice(0, 5).map((row) => row.id) });
    }
    if (unknown.length > 0) {
      throw new StapleError("not_found", `No budget reading with id ${unknown.map((ref) => `"${ref}"`).join(", ")} on this machine. Nothing was removed.`, {
        reason: "not_found",
        ids: unknown,
      });
    }
    if (ambiguous.length > 0) {
      throw new StapleError(
        "validation",
        `${ambiguous.map((a) => `"${a.ref}" matches ${a.matches.length > 4 ? "more than 4" : a.matches.length} readings (${a.matches.slice(0, 4).join(", ")})`).join("; ")}. Give more of the id. Nothing was removed.`,
        { reason: "ambiguous_id", ambiguous },
      );
    }
    return [...found.values()].sort((a, b) => (a.observed_at === b.observed_at ? a.id.localeCompare(b.id) : a.observed_at < b.observed_at ? -1 : 1)).map(toSample);
  }

  /**
   * Remove readings (`staple budget forget`, `forget_budget_samples`, `POST
   * /api/budget/forget`: one method). In one transaction:
   *
   *   1. the readings are deleted, and their dedup keys kept in `budget_forgotten`, so the
   *      same input read again stores nothing (`record` skips it as `forgotten`);
   *   2. a window left with no reading is removed. A window instance exists because a
   *      reading opened it, so one with none left was never observed. A window kept
   *      whose opening reading was removed takes its fields from the earliest-recorded
   *      reading left ({@link rederiveWindow});
   *   3. the windows a removed window had superseded are released, and each one's overlap
   *      with the windows still standing is settled again by the rule a new window meets
   *      in `openWindow`. A window a false reading displaced stands again.
   *
   * Nothing derived is written: status, high-water and regressions are read-time, so
   * they follow. With `apply: false` the same transaction runs and is rolled back, so the
   * preview is exactly what applying would do. `summarize` reads each affected limit
   * before and after, inside the transaction.
   */
  forget<V>(refs: readonly string[], options: { apply: boolean; at: string; summarize: (store: BudgetStore, limit: LimitKey) => V }): ForgetOutcome<V> {
    try {
      return tx(this.db, () => {
        const outcome = this.forgetInTransaction(refs, options);
        if (!options.apply) throw new PreviewRollback(outcome);
        return outcome;
      });
    } catch (error) {
      if (error instanceof PreviewRollback) return error.outcome as ForgetOutcome<V>;
      throw error;
    }
  }

  private forgetInTransaction<V>(refs: readonly string[], options: { apply: boolean; at: string; summarize: (store: BudgetStore, limit: LimitKey) => V }): ForgetOutcome<V> {
    const samples = this.resolveSamples(refs);
    const limitKeys = new Map<string, LimitKey>();
    for (const sample of samples) {
      limitKeys.set(`${sample.provider}\u0000${sample.accountRef}\u0000${sample.limitKey}`, { provider: sample.provider, accountRef: sample.accountRef, limitKey: sample.limitKey });
    }
    const limits = [...limitKeys.values()];
    const before = limits.map((limit) => options.summarize(this, limit));

    // The reading that opened each window: the first stored in it (insertion order).
    const openerOf = (windowId: string): SampleRow | undefined =>
      this.db.prepare("SELECT * FROM budget_samples WHERE window_id = ? ORDER BY rowid LIMIT 1").get(windowId) as unknown as SampleRow | undefined;
    const openers = new Map<string, string>();
    for (const windowId of new Set(samples.map((sample) => sample.windowId).filter((id): id is string => id !== null))) {
      const opener = openerOf(windowId);
      if (opener !== undefined) openers.set(windowId, opener.id);
    }
    const removedIds = new Set(samples.map((sample) => sample.id));

    const remove = this.db.prepare("DELETE FROM budget_samples WHERE id = ?");
    const tombstone = this.db.prepare("INSERT OR IGNORE INTO budget_forgotten (dedup_key, sample_id, forgotten_at) VALUES (?, ?, ?)");
    for (const sample of samples) {
      remove.run(sample.id);
      tombstone.run(sample.dedupKey, sample.id, options.at);
    }

    const windowIds = [...new Set(samples.map((sample) => sample.windowId).filter((id): id is string => id !== null))];
    const windows: ForgetWindowChange[] = [];
    for (const windowId of windowIds) {
      const row = this.db.prepare(`${WINDOW_SELECT} WHERE w.id = ?`).get(windowId) as unknown as WindowRow | undefined;
      if (row === undefined) continue;
      const left = (this.db.prepare("SELECT COUNT(*) AS n FROM budget_samples WHERE window_id = ?").get(windowId) as { n: number }).n;
      const base = { windowId, provider: row.provider, accountRef: row.account_ref, limitKey: row.limit_key, resetsAt: row.resets_at };
      if (left > 0) {
        const opener = openers.get(windowId);
        const rederivedFrom = opener !== undefined && removedIds.has(opener) ? this.rederiveWindow(windowId, openerOf(windowId)!) : null;
        const resetsAt = rederivedFrom === null ? row.resets_at : (this.db.prepare("SELECT resets_at FROM limit_windows WHERE id = ?").get(windowId) as { resets_at: string | null }).resets_at;
        windows.push({ ...base, resetsAt, outcome: "kept", samplesLeft: left, rederivedFrom, released: [] });
        continue;
      }
      const freed = this.db.prepare("SELECT id FROM limit_windows WHERE superseded_by = ?").all(windowId) as Array<{ id: string }>;
      this.db.prepare("UPDATE limit_windows SET superseded_by = NULL, superseded_reason = NULL WHERE superseded_by = ?").run(windowId);
      this.db.prepare("DELETE FROM limit_windows WHERE id = ?").run(windowId);
      windows.push({ ...base, outcome: "removed", samplesLeft: 0, rederivedFrom: null, released: freed.map((f) => ({ windowId: f.id, resetsAt: null, supersededBy: null })) });
    }
    // Settled after every removal, so a window is never settled against one about to go.
    const released = windows.flatMap((change) => change.released.map((r) => r.windowId));
    const firstSeen = (id: string): number => {
      const row = this.db.prepare(`${WINDOW_SELECT} WHERE w.id = ?`).get(id) as unknown as WindowRow | undefined;
      return row?.first_sample_at == null ? Number.POSITIVE_INFINITY : ms(row.first_sample_at);
    };
    for (const id of [...released].sort((a, b) => firstSeen(a) - firstSeen(b) || a.localeCompare(b))) this.settleOverlaps(id);
    const settled = windows.map((change) => ({
      ...change,
      released: change.released.map((r) => {
        const row = this.db.prepare("SELECT resets_at, superseded_by FROM limit_windows WHERE id = ?").get(r.windowId) as { resets_at: string | null; superseded_by: string | null };
        return { windowId: r.windowId, resetsAt: row.resets_at, supersededBy: row.superseded_by };
      }),
    }));

    const after = limits.map((limit) => options.summarize(this, limit));
    return {
      applied: options.apply,
      samples,
      windows: settled,
      limits: limits.map((limit, i) => ({ ...limit, before: before[i]!, after: after[i]! })),
    };
  }

  /**
   * Give a kept window the fields its new opening reading would have given it, as
   * {@link openWindow} sets them, when the reading that opened it was removed. A sample
   * carries no plan tier, so the window's is cleared with reason `opening_reading_removed`
   * rather than kept from a reading that is gone. Returns the new opener's id.
   */
  private rederiveWindow(windowId: string, opener: SampleRow): string {
    const observed = opener.window_seconds_source === "observed" && opener.window_seconds !== null && opener.resets_at !== null;
    const startsAt = observed ? new Date(ms(opener.resets_at!) - opener.window_seconds! * 1000).toISOString() : null;
    const missing: Missing = { planTier: "opening_reading_removed" };
    if (opener.window_seconds === null) missing.windowSeconds = parseMissing(opener.missing).windowSeconds ?? "not_reported_by_source";
    if (startsAt === null) missing.startsAt = "not_reported_by_source";
    this.db
      .prepare(
        `UPDATE limit_windows SET resets_at = ?, resets_at_source = ?, window_seconds = ?, window_seconds_source = ?,
           starts_at = ?, plan_tier = NULL, missing = ? WHERE id = ?`,
      )
      .run(opener.resets_at, opener.resets_at_source, opener.window_seconds, opener.window_seconds_source, startsAt, JSON.stringify(missing), windowId);
    return opener.id;
  }

  /**
   * Settle a released window against the windows of its limit still standing, by the
   * rule {@link openWindow} applies when a window is minted: of two instances that
   * overlap, the one first observed earlier is superseded by the other (`reset_moved`).
   * An instance that had elapsed when the other was first seen, or that ended before the
   * other began, does not overlap it.
   */
  private settleOverlaps(windowId: string): void {
    const self = this.db.prepare(`${WINDOW_SELECT} WHERE w.id = ?`).get(windowId) as unknown as WindowRow | undefined;
    if (self === undefined || self.superseded_by !== null || self.resets_at === null || self.first_sample_at === null) return;
    const tolerance = WINDOW_TOLERANCE_SECONDS * 1000;
    const others = this.db
      .prepare(
        `${WINDOW_SELECT} WHERE w.provider = ? AND w.account_ref = ? AND w.limit_key = ? AND w.id <> ?
           AND w.superseded_by IS NULL AND w.resets_at IS NOT NULL`,
      )
      .all(self.provider, self.account_ref, self.limit_key, self.id) as unknown as WindowRow[];
    for (const other of others) {
      if (other.first_sample_at === null) continue;
      const selfFirst = ms(self.first_sample_at);
      const otherFirst = ms(other.first_sample_at);
      const [later, earlier] = selfFirst > otherFirst || (selfFirst === otherFirst && self.id > other.id) ? [self, other] : [other, self];
      const laterSeen = ms(later.first_sample_at!);
      if (laterSeen >= ms(earlier.resets_at!)) continue; // elapsed when the later one was first seen
      const begin = earlier.starts_at ?? earlier.first_sample_at;
      if (begin !== null && ms(later.resets_at!) <= ms(begin) + tolerance) continue; // ended before the earlier began
      this.db.prepare("UPDATE limit_windows SET superseded_by = ?, superseded_reason = 'reset_moved' WHERE id = ?").run(later.id, earlier.id);
      if (earlier.id === self.id) return;
    }
  }

}
