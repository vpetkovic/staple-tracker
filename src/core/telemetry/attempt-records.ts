/**
 * The execution attempt and its transitions: shapes, rows and wire payloads.
 *
 * Contract: `docs/execution-telemetry.md`, "The attempt record" and "Lifecycle". The
 * stored fields are exactly the contract's; everything derived (`ordinal`,
 * `lastActivityAt`, `activeSeconds`, the read-time orphan end, …) lives in
 * `attempt-derive.ts` and is never written.
 *
 * Field names are the contract's camelCase on every surface and on the wire. The row
 * mapping here is the one place that knows the column names, so the store, the applier
 * and the seed cannot spell a field three ways.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { writeEventRow } from "../event-row.js";
import { sessionRefOf as sessionRefOfHarness, type HarnessName as FormatHarness } from "./formats.js";

/** `harness.name`: a closed set; a newer build's value is preserved verbatim. */
export const HARNESS_NAMES = ["claude_code", "codex", "other"] as const;
export type HarnessName = (typeof HARNESS_NAMES)[number];

/** What an agent may give as the reason for a pause. */
export const PAUSE_REASONS = ["checkpoint_before_reset", "awaiting_reset", "awaiting_input", "operator", "other"] as const;

/** What a REPORT may give as an interruption's reason (`staple attempt interrupt`). */
export const REPORTED_INTERRUPT_REASONS = ["provider_limit", "harness_exit", "operator_stop", "unknown"] as const;

/** Written only by the mutations they name; a report giving one is refused. */
export const INFERRED_INTERRUPT_REASONS = ["claim_stolen", "released_stale"] as const;

export type AttemptState = "running" | "paused" | "ended";
export type AttemptOutcome = "completed" | "yielded" | "failed" | "interrupted";
export type EndDetection = "reported" | "by_other" | "inferred" | "reconstructed";
export type OpenedBy = "checkout" | "steal" | "reclaim" | "status" | "reconstructed";

export type AttemptTransitionKind =
  | "attempt_started"
  | "attempt_milestone"
  | "attempt_paused"
  | "attempt_resumed"
  | "attempt_interrupted"
  | "attempt_session_added"
  | "attempt_ended";

export interface AttemptClaim {
  /** `local`, `lease` or `none`. */
  readonly scope: string;
  readonly fencingToken: number | null;
}

export interface AttemptHarness {
  readonly name: string;
  readonly version: string | null;
  readonly sessionRef: string | null;
  readonly model: string | null;
  readonly provenance: "self_reported";
}

export interface ProviderBinding {
  readonly provider: string | null;
  readonly accountRef: string;
  /** `flag` (passed explicitly) or `machine_binding` (resolved from the staple home's bindings). */
  readonly source: string;
}

export interface EstimateReading {
  readonly estimatedSeconds: number | null;
  /** `own`, `descendants` or `none` — `timing.subtreePlan.source`. */
  readonly source: string;
}

/** The seven fields an end sets, carried as one unit (`cloud/attempt-ends.ts`). */
export interface AttemptEnd {
  readonly state: string;
  readonly outcome: string | null;
  readonly endReason: string | null;
  readonly endDetection: string | null;
  readonly endedBy: string | null;
  readonly endedAt: string | null;
  readonly endedAtSource: string | null;
}

export interface AttemptRecord extends AttemptEnd {
  readonly id: string;
  readonly issueId: string;
  readonly agent: string;
  readonly openedBy: string;
  readonly resumesAttemptId: string | null;
  readonly startedAt: string;
  readonly deviceId: string | null;
  readonly claim: AttemptClaim;
  readonly harness: AttemptHarness | null;
  readonly providerBinding: ProviderBinding | null;
  readonly estimateAtStart: EstimateReading;
  readonly idempotencyKey: string | null;
  /** `recorded` or `reconstructed`. */
  readonly provenance: string;
  readonly missing: Readonly<Record<string, string>>;
}

export interface AttemptTransition {
  readonly id: string;
  readonly attemptId: string;
  readonly kind: string;
  readonly at: string;
  readonly actor: string | null;
  readonly detection: string | null;
  readonly reason: string | null;
  readonly detail: Readonly<Record<string, unknown>>;
  readonly concurrency: Readonly<Record<string, unknown>>;
}

// ------------------------------------------------------------------ rows

interface AttemptRow {
  id: string;
  issue_id: string;
  agent: string;
  state: string;
  outcome: string | null;
  end_reason: string | null;
  end_detection: string | null;
  ended_by: string | null;
  opened_by: string;
  resumes_attempt_id: string | null;
  started_at: string;
  ended_at: string | null;
  ended_at_source: string | null;
  device_id: string | null;
  claim_scope: string;
  claim_fencing_token: number | null;
  harness: string | null;
  provider_binding: string | null;
  estimate_at_start: string;
  idempotency_key: string | null;
  provenance: string;
  missing: string;
}

interface TransitionRow {
  id: string;
  attempt_id: string;
  kind: string;
  at: string;
  actor: string | null;
  detection: string | null;
  reason: string | null;
  detail: string;
  concurrency: string;
}

function parsed<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toRecord(row: AttemptRow): AttemptRecord {
  return {
    id: row.id,
    issueId: row.issue_id,
    agent: row.agent,
    state: row.state,
    outcome: row.outcome,
    endReason: row.end_reason,
    endDetection: row.end_detection,
    endedBy: row.ended_by,
    openedBy: row.opened_by,
    resumesAttemptId: row.resumes_attempt_id,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    endedAtSource: row.ended_at_source,
    deviceId: row.device_id,
    claim: { scope: row.claim_scope, fencingToken: row.claim_fencing_token },
    harness: parsed<AttemptHarness | null>(row.harness, null),
    providerBinding: parsed<ProviderBinding | null>(row.provider_binding, null),
    estimateAtStart: parsed<EstimateReading>(row.estimate_at_start, { estimatedSeconds: null, source: "none" }),
    idempotencyKey: row.idempotency_key,
    provenance: row.provenance,
    missing: parsed<Record<string, string>>(row.missing, {}),
  };
}

function toTransition(row: TransitionRow): AttemptTransition {
  return {
    id: row.id,
    attemptId: row.attempt_id,
    kind: row.kind,
    at: row.at,
    actor: row.actor,
    detection: row.detection,
    reason: row.reason,
    detail: parsed<Record<string, unknown>>(row.detail, {}),
    concurrency: parsed<Record<string, unknown>>(row.concurrency, {}),
  };
}

export function readAttempt(db: DatabaseSync, id: string): AttemptRecord | null {
  const row = db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as AttemptRow | undefined;
  return row ? toRecord(row) : null;
}

/** Every attempt on one issue, oldest first (`startedAt`, then `id`). */
export function attemptsOfIssue(db: DatabaseSync, issueId: string): AttemptRecord[] {
  return (db.prepare("SELECT * FROM attempts WHERE issue_id = ? ORDER BY started_at, id").all(issueId) as unknown as AttemptRow[]).map(toRecord);
}

/** Every attempt whose stored state is not `ended`, oldest first. */
export function storedOpenAttempts(db: DatabaseSync): AttemptRecord[] {
  return (db.prepare("SELECT * FROM attempts WHERE state <> 'ended' ORDER BY started_at, id").all() as unknown as AttemptRow[]).map(toRecord);
}

export function attemptByKey(db: DatabaseSync, issueId: string, key: string): AttemptRecord | null {
  const row = db
    .prepare("SELECT * FROM attempts WHERE issue_id = ? AND idempotency_key = ? ORDER BY started_at, id LIMIT 1")
    .get(issueId, key) as AttemptRow | undefined;
  return row ? toRecord(row) : null;
}

export function transitionsOf(db: DatabaseSync, attemptId: string): AttemptTransition[] {
  return (db.prepare("SELECT * FROM attempt_transitions WHERE attempt_id = ? ORDER BY at, id").all(attemptId) as unknown as TransitionRow[]).map(
    toTransition,
  );
}

export function readTransition(db: DatabaseSync, id: string): AttemptTransition | null {
  const row = db.prepare("SELECT * FROM attempt_transitions WHERE id = ?").get(id) as TransitionRow | undefined;
  return row ? toTransition(row) : null;
}

const json = (value: unknown): string | null => (value === null || value === undefined ? null : JSON.stringify(value));

export function insertAttempt(db: DatabaseSync, record: AttemptRecord): void {
  db.prepare(
    `INSERT INTO attempts (id, issue_id, agent, state, outcome, end_reason, end_detection, ended_by, opened_by,
       resumes_attempt_id, started_at, ended_at, ended_at_source, device_id, claim_scope, claim_fencing_token,
       harness, provider_binding, estimate_at_start, idempotency_key, provenance, missing)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    record.id,
    record.issueId,
    record.agent,
    record.state,
    record.outcome,
    record.endReason,
    record.endDetection,
    record.endedBy,
    record.openedBy,
    record.resumesAttemptId,
    record.startedAt,
    record.endedAt,
    record.endedAtSource,
    record.deviceId,
    record.claim.scope,
    record.claim.fencingToken,
    json(record.harness),
    json(record.providerBinding),
    JSON.stringify(record.estimateAtStart),
    record.idempotencyKey,
    record.provenance,
    JSON.stringify(record.missing ?? {}),
  );
}

export function writeEnd(db: DatabaseSync, id: string, end: AttemptEnd): void {
  db.prepare(
    `UPDATE attempts SET state = ?, outcome = ?, end_reason = ?, end_detection = ?, ended_by = ?, ended_at = ?,
       ended_at_source = ? WHERE id = ?`,
  ).run(end.state, end.outcome, end.endReason, end.endDetection, end.endedBy, end.endedAt, end.endedAtSource, id);
}

export function insertTransition(db: DatabaseSync, transition: AttemptTransition): boolean {
  const result = db
    .prepare(
      `INSERT INTO attempt_transitions (id, attempt_id, kind, at, actor, detection, reason, detail, concurrency)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .run(
      transition.id,
      transition.attemptId,
      transition.kind,
      transition.at,
      transition.actor,
      transition.detection,
      transition.reason,
      JSON.stringify(transition.detail ?? {}),
      JSON.stringify(transition.concurrency ?? {}),
    );
  return Number(result.changes) > 0;
}

// ------------------------------------------------------------------ wire

/** The end fields of a record, as the unit every end-setting operation carries. */
export function endOf(record: AttemptEnd): AttemptEnd {
  return {
    state: record.state,
    outcome: record.outcome,
    endReason: record.endReason,
    endDetection: record.endDetection,
    endedBy: record.endedBy,
    endedAt: record.endedAt,
    endedAtSource: record.endedAtSource,
  };
}

/** An `attempt.create` payload: every stored field. */
export function attemptPayload(record: AttemptRecord): Record<string, unknown> {
  return {
    issueId: record.issueId,
    agent: record.agent,
    ...endOf(record),
    openedBy: record.openedBy,
    resumesAttemptId: record.resumesAttemptId,
    startedAt: record.startedAt,
    deviceId: record.deviceId,
    claim: record.claim,
    harness: record.harness,
    providerBinding: record.providerBinding,
    estimateAtStart: record.estimateAtStart,
    idempotencyKey: record.idempotencyKey,
    provenance: record.provenance,
    missing: record.missing,
  };
}

/** An `attemptTransition.create` payload: every field. Immutable once written. */
export function transitionPayload(transition: AttemptTransition): Record<string, unknown> {
  return {
    attemptId: transition.attemptId,
    kind: transition.kind,
    at: transition.at,
    actor: transition.actor,
    detection: transition.detection,
    reason: transition.reason,
    detail: transition.detail,
    concurrency: transition.concurrency,
  };
}

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const obj = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A record from an `attempt.create` payload (or a folded state), for the applier. */
export function recordFromPayload(id: string, payload: Record<string, unknown>): AttemptRecord | null {
  const issueId = str(payload.issueId);
  const agent = str(payload.agent);
  const startedAt = str(payload.startedAt);
  if (issueId === null || agent === null || startedAt === null) return null;
  const claim = obj(payload.claim);
  const fencing = claim?.fencingToken;
  return {
    id,
    issueId,
    agent,
    state: str(payload.state) ?? "running",
    outcome: str(payload.outcome),
    endReason: str(payload.endReason),
    endDetection: str(payload.endDetection),
    endedBy: str(payload.endedBy),
    endedAt: str(payload.endedAt),
    endedAtSource: str(payload.endedAtSource),
    openedBy: str(payload.openedBy) ?? "checkout",
    resumesAttemptId: str(payload.resumesAttemptId),
    startedAt,
    deviceId: str(payload.deviceId),
    claim: { scope: str(claim?.scope) ?? "local", fencingToken: typeof fencing === "number" ? fencing : null },
    harness: (obj(payload.harness) as AttemptHarness | null) ?? null,
    providerBinding: (obj(payload.providerBinding) as ProviderBinding | null) ?? null,
    estimateAtStart: (obj(payload.estimateAtStart) as EstimateReading | null) ?? { estimatedSeconds: null, source: "none" },
    idempotencyKey: str(payload.idempotencyKey),
    provenance: str(payload.provenance) ?? "recorded",
    missing: (obj(payload.missing) as Record<string, string> | null) ?? {},
  };
}

/** A transition from an `attemptTransition.create` payload, for the applier. */
export function transitionFromPayload(id: string, payload: Record<string, unknown>): AttemptTransition | null {
  const attemptId = str(payload.attemptId);
  const kind = str(payload.kind);
  const at = str(payload.at);
  if (attemptId === null || kind === null || at === null) return null;
  return {
    id,
    attemptId,
    kind,
    at,
    actor: str(payload.actor),
    detection: str(payload.detection),
    reason: str(payload.reason),
    detail: obj(payload.detail) ?? {},
    concurrency: obj(payload.concurrency) ?? {},
  };
}

/** The end fields an `attempt.update` payload names, merged over what is held. */
export function endFromPayload(held: AttemptEnd, payload: Record<string, unknown>): AttemptEnd {
  const pick = (name: keyof AttemptEnd): string | null => (name in payload ? str(payload[name]) : held[name]);
  return {
    state: (("state" in payload ? str(payload.state) : held.state) ?? held.state) as string,
    outcome: pick("outcome"),
    endReason: pick("endReason"),
    endDetection: pick("endDetection"),
    endedBy: pick("endedBy"),
    endedAt: pick("endedAt"),
    endedAtSource: pick("endedAtSource"),
  };
}

// ------------------------------------------------------------------ keys

/**
 * The local event key of one transition: `attempt_transition:<attemptId>:1:<32 hex>`, the
 * `ids.ts` level-triggered shape. The count is always the literal 1 — exactly one id is
 * hashed — and the digest is of the transition id, so re-applying a pulled transition
 * re-derives the same key and cannot duplicate the timeline.
 */
export function transitionEventKey(attemptId: string, transitionId: string): string {
  const digest = createHash("sha256").update(transitionId, "utf8").digest("hex").slice(0, 32);
  return `attempt_transition:${attemptId}:1:${digest}`;
}

/** `sessionRef` (Privacy): the one derivation, shared with budget samples so the two join. */
export function sessionRefOf(harness: string, sessionId: string): string {
  return sessionRefOfHarness(harness as FormatHarness, sessionId);
}

/**
 * The local event of one transition, under its transition-derived key. Dated at the
 * transition's own `at`: an applied transition is another device's, and dating it by the
 * apply would make that agent look active here, now.
 */
export function emitTransitionEvent(db: DatabaseSync, transition: AttemptTransition, issueId: string | null): void {
  const identifier =
    issueId === null ? null : ((db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? null);
  writeEventRow(db, {
    kind: transition.kind,
    issueId,
    actor: transition.actor,
    payload: {
      identifier,
      attemptId: transition.attemptId,
      transitionId: transition.id,
      detection: transition.detection,
      reason: transition.reason,
      ...transition.detail,
    },
    dedupKey: transitionEventKey(transition.attemptId, transition.id),
    createdAt: transition.at,
  });
}
