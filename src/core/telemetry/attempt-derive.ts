/**
 * What an attempt reads as: the read-time orphan rule, and every derived field.
 *
 * Contract: `docs/execution-telemetry.md`, "Orphaned attempts are closed at read time" and
 * the derived-field table under "The attempt record".
 *
 * ## Only replicated rows
 *
 * The rule reads the issue row, the workspace's status vocabulary and the attempt rows —
 * what every device holds after applying the same operations — and never the local
 * conflict table, which exists only on a device whose own write overlapped. A rule that
 * switched on it would give a third device a different answer.
 *
 * ## Two evaluations
 *
 * `read` is what every surface shows: the five clauses, with the contested-case skip. `own`
 * is what a device uses to decide what IT writes — the stored orphan end, and which attempt
 * a claim-clearing mutation ends: all five clauses against its own rows, no skip, because a
 * device with no open conflict of its own holds the settled claim.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../types.js";
import { attemptsOfIssue, transitionsOf, type AttemptRecord, type AttemptTransition } from "./attempt-records.js";

export type EvaluationMode = "read" | "own";

/** What the rule reads about the issue. */
export interface IssueFacts {
  readonly exists: boolean;
  readonly active: boolean;
  readonly checkoutAgent: string | null;
}

export interface Evaluation {
  /** The clause that ends this stored-open attempt, or null when it stays open. Null for a stored end. */
  readonly orphanReason: string | null;
  readonly contested: boolean;
}

/** The issue as the rule reads it, from the replicated row and vocabulary. */
export function issueFacts(db: DatabaseSync, issueId: string): IssueFacts {
  const row = db
    .prepare(
      `SELECT i.checkout_agent AS agent, s.category AS category
         FROM issues i LEFT JOIN workspace_statuses s ON s.id = i.status
        WHERE i.id = ?`,
    )
    .get(issueId) as { agent: string | null; category: string | null } | undefined;
  if (!row) return { exists: false, active: false, checkoutAgent: null };
  return { exists: true, active: row.category === "active", checkoutAgent: row.agent };
}

const newestFirst = (a: AttemptRecord, b: AttemptRecord): number =>
  a.startedAt === b.startedAt ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.startedAt < b.startedAt ? 1 : -1;

/**
 * The rule, over every attempt of ONE issue.
 *
 * Newest first, so clause 5 is well founded: of two stored-open attempts that survive
 * clauses 1 to 4, the newer one stays open.
 */
export function evaluateIssue(
  attempts: readonly AttemptRecord[],
  facts: IssueFacts,
  mode: EvaluationMode,
): Map<string, Evaluation> {
  const out = new Map<string, Evaluation>();
  const open = attempts.filter((attempt) => attempt.state !== "ended").sort(newestFirst);
  /**
   * The contested case, triggered by the replicated shape itself: two or more stored-open
   * attempts with different agents and a claim scope other than `none`. Clauses 3 and 4 are
   * skipped for those, and every one of them reads `contested: true`.
   */
  const contested = new Set<string>();
  if (mode === "read") {
    const scoped = open.filter((attempt) => attempt.claim.scope !== "none");
    if (new Set(scoped.map((attempt) => attempt.agent)).size >= 2) for (const attempt of scoped) contested.add(attempt.id);
  }
  let laterOpen = false;
  for (const attempt of open) {
    const skip = contested.has(attempt.id);
    let reason: string | null = null;
    if (!facts.exists) reason = "issue_removed";
    else if (!facts.active) reason = "left_active";
    else if (!skip && facts.checkoutAgent !== null && facts.checkoutAgent !== attempt.agent) reason = "claim_moved";
    else if (!skip && attempt.claim.scope !== "none" && facts.checkoutAgent === null) reason = "claim_cleared";
    else if (laterOpen) reason = "superseded_by_merge";
    if (reason === null) laterOpen = true;
    out.set(attempt.id, { orphanReason: reason, contested: skip });
  }
  for (const attempt of attempts) if (!out.has(attempt.id)) out.set(attempt.id, { orphanReason: null, contested: false });
  return out;
}

/** The attempts of an issue that are effectively open under `mode`, newest first. */
export function effectivelyOpen(db: DatabaseSync, issueId: string, mode: EvaluationMode, facts: IssueFacts = issueFacts(db, issueId)): AttemptRecord[] {
  const attempts = attemptsOfIssue(db, issueId);
  const evaluation = evaluateIssue(attempts, facts, mode);
  return attempts.filter((attempt) => attempt.state !== "ended" && evaluation.get(attempt.id)?.orphanReason === null).sort(newestFirst);
}

/**
 * Effectively open attempts in this workspace database, pulled ones included: the
 * concurrency context's `openAttemptsInWorkspace`. Read-mode, as every surface reads.
 */
export function countEffectivelyOpen(db: DatabaseSync): number {
  const issues = (db.prepare("SELECT DISTINCT issue_id AS id FROM attempts WHERE state <> 'ended'").all() as Array<{ id: string }>).map((row) => row.id);
  let count = 0;
  for (const issueId of issues) count += effectivelyOpen(db, issueId, "read").length;
  return count;
}

/**
 * The newest event or comment by `agent` on the issue, floored at `since`: the query the
 * claim uses (`lastActivityOf` in `store.ts`), with the attempt's agent and `startedAt`.
 */
export function lastActivityOf(db: DatabaseSync, issueId: string, agent: string, since: string): string {
  const row = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(created_at) AS t FROM events   WHERE issue_id = ? AND actor  = ?
         UNION ALL
         SELECT MAX(created_at) AS t FROM comments WHERE issue_id = ? AND author = ? AND deleted_at IS NULL
       )`,
    )
    .get(issueId, agent, issueId, agent) as { t: string | null } | undefined;
  const newest = row?.t ?? null;
  return newest && newest > since ? newest : since;
}

/** The effective (read-time) view of one attempt, with every derived field. */
export interface AttemptView {
  readonly id: string;
  readonly issueId: string;
  readonly identifier: string | null;
  readonly agent: string;
  readonly ordinal: number;
  readonly state: string;
  readonly storedState: string;
  readonly outcome: string | null;
  readonly endReason: string | null;
  readonly endDetection: string | null;
  readonly endedBy: string | null;
  readonly openedBy: string;
  readonly resumesAttemptId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly endedAtSource: string | null;
  /** Only on a derived (orphaned) end: its `lastActivityAt`. */
  readonly endedAtBound?: string;
  readonly deviceId: string | null;
  readonly claim: AttemptRecord["claim"];
  readonly harness: AttemptRecord["harness"];
  readonly providerBinding: AttemptRecord["providerBinding"];
  readonly estimateAtStart: AttemptRecord["estimateAtStart"];
  readonly idempotencyKey: string | null;
  readonly provenance: string;
  readonly lastActivityAt: string;
  readonly activeSeconds: number;
  readonly pausedSeconds: number;
  readonly countedThrough: string | null;
  readonly idleSeconds: number | null;
  readonly contested: boolean;
  readonly chain: string[];
  readonly missing: Record<string, string>;
}

const seconds = (from: string, to: string): number => Math.max(0, Math.floor((Date.parse(to) - Date.parse(from)) / 1000));

/**
 * The paused time inside `[start, end]`, from the transitions: every `attempt_paused` to the
 * next `attempt_resumed`, or to `end` when none followed. Zero when there were none — a
 * measured zero, not a missing value.
 */
export function pausedSecondsOf(transitions: readonly AttemptTransition[], start: string, end: string): number {
  let total = 0;
  let pausedAt: string | null = null;
  for (const transition of transitions) {
    if (transition.kind === "attempt_paused" && pausedAt === null) pausedAt = transition.at;
    else if (transition.kind === "attempt_resumed" && pausedAt !== null) {
      total += seconds(pausedAt < start ? start : pausedAt, transition.at > end ? end : transition.at);
      pausedAt = null;
    }
  }
  if (pausedAt !== null && pausedAt < end) total += seconds(pausedAt < start ? start : pausedAt, end);
  return total;
}

/** The attempts linked to this one by `resumesAttemptId`, oldest first. */
export function chainOf(attempts: readonly AttemptRecord[], id: string): string[] {
  const byId = new Map(attempts.map((attempt) => [attempt.id, attempt]));
  let root = byId.get(id);
  const seen = new Set<string>();
  while (root && root.resumesAttemptId !== null && byId.has(root.resumesAttemptId) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.resumesAttemptId);
  }
  if (!root) return [id];
  const chain: string[] = [];
  const queue = [root];
  const placed = new Set<string>();
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (placed.has(next.id)) continue;
    placed.add(next.id);
    chain.push(next.id);
    for (const attempt of attempts) if (attempt.resumesAttemptId === next.id) queue.push(attempt);
  }
  return chain.sort((a, b) => {
    const left = byId.get(a)!;
    const right = byId.get(b)!;
    return left.startedAt === right.startedAt ? (a < b ? -1 : 1) : left.startedAt < right.startedAt ? -1 : 1;
  });
}

/** Every attempt of an issue as it reads, oldest first. */
export function viewsOfIssue(db: DatabaseSync, issueId: string, now: string = nowIso()): AttemptView[] {
  const attempts = attemptsOfIssue(db, issueId);
  if (attempts.length === 0) return [];
  const evaluation = evaluateIssue(attempts, issueFacts(db, issueId), "read");
  const identifier = (db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as { identifier: string } | undefined)?.identifier ?? null;
  return attempts.map((attempt, index) => viewOf(db, attempt, index + 1, evaluation.get(attempt.id)!, identifier, attempts, now));
}

/** One attempt as it reads, or null when this database holds none by that id. */
export function viewAttempt(db: DatabaseSync, id: string, now: string = nowIso()): AttemptView | null {
  const row = db.prepare("SELECT issue_id FROM attempts WHERE id = ?").get(id) as { issue_id: string } | undefined;
  if (!row) return null;
  return viewsOfIssue(db, row.issue_id, now).find((view) => view.id === id) ?? null;
}

function viewOf(
  db: DatabaseSync,
  attempt: AttemptRecord,
  ordinal: number,
  evaluation: Evaluation,
  identifier: string | null,
  siblings: readonly AttemptRecord[],
  now: string,
): AttemptView {
  const missing: Record<string, string> = { ...attempt.missing };
  const storedOpen = attempt.state !== "ended";
  const orphaned = storedOpen && evaluation.orphanReason !== null;
  const lastActivityAt = storedOpen ? lastActivityOf(db, attempt.issueId, attempt.agent, attempt.startedAt) : (attempt.endedAt ?? attempt.startedAt);
  const clockEnd = storedOpen ? lastActivityAt : (attempt.endedAt ?? attempt.startedAt);
  const transitions = transitionsOf(db, attempt.id);
  const pausedSeconds = pausedSecondsOf(transitions, attempt.startedAt, clockEnd);
  const activeSeconds = Math.max(0, seconds(attempt.startedAt, clockEnd) - pausedSeconds);
  if (orphaned) missing.endedAt = "end_not_observed";
  return {
    id: attempt.id,
    issueId: attempt.issueId,
    identifier,
    agent: attempt.agent,
    ordinal,
    state: orphaned ? "ended" : attempt.state,
    storedState: attempt.state,
    outcome: orphaned ? "orphaned" : attempt.outcome,
    endReason: orphaned ? evaluation.orphanReason : attempt.endReason,
    endDetection: orphaned ? "derived" : attempt.endDetection,
    endedBy: attempt.endedBy,
    openedBy: attempt.openedBy,
    resumesAttemptId: attempt.resumesAttemptId,
    startedAt: attempt.startedAt,
    endedAt: orphaned ? null : attempt.endedAt,
    endedAtSource: orphaned ? null : attempt.endedAtSource,
    ...(orphaned ? { endedAtBound: lastActivityAt } : {}),
    deviceId: attempt.deviceId,
    claim: attempt.claim,
    harness: attempt.harness,
    providerBinding: attempt.providerBinding,
    estimateAtStart: attempt.estimateAtStart,
    idempotencyKey: attempt.idempotencyKey,
    provenance: attempt.provenance,
    lastActivityAt,
    activeSeconds,
    pausedSeconds,
    countedThrough: storedOpen && !orphaned ? lastActivityAt : null,
    idleSeconds: storedOpen && !orphaned ? seconds(lastActivityAt, now) : null,
    contested: evaluation.contested,
    chain: chainOf(siblings, attempt.id),
    missing,
  };
}
