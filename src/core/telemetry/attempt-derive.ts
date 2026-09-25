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
import { nowIso, type ResumeGap } from "../types.js";
import { attemptsOfIssue, isWorkerAttempt, laneOf, transitionsOf, type AttemptRecord, type AttemptTransition } from "./attempt-records.js";

export type EvaluationMode = "read" | "own";

/** What the rule reads about the issue. */
export interface IssueFacts {
  readonly exists: boolean;
  readonly active: boolean;
  readonly checkoutAgent: string | null;
  /**
   * What the orchestrator lane's clauses and the row bound read (`docs/timing-semantics.md`,
   * "The orchestrator lane" and "Work"). Absent on facts a mutator built from a row it read
   * before writing, which only ever feed the worker lane's clauses.
   */
  readonly category?: string | null;
  readonly completedAt?: string | null;
  readonly cancelledAt?: string | null;
}

export interface Evaluation {
  /** The clause that ends this stored-open attempt, or null when it stays open. Null for a stored end. */
  readonly orphanReason: string | null;
  readonly contested: boolean;
  /**
   * The orchestrator lane only: the earliest bound of every clause that holds, which limits
   * the replicated evidence the end is read from (`evidenceBefore`). Null when no clause
   * with a bound holds.
   */
  readonly limit?: string | null;
}

/** The issue as the rule reads it, from the replicated row and vocabulary. */
export function issueFacts(db: DatabaseSync, issueId: string): IssueFacts {
  const row = db
    .prepare(
      `SELECT i.checkout_agent AS agent, s.category AS category, i.completed_at AS completed_at, i.cancelled_at AS cancelled_at
         FROM issues i LEFT JOIN workspace_statuses s ON s.id = i.status
        WHERE i.id = ?`,
    )
    .get(issueId) as { agent: string | null; category: string | null; completed_at: string | null; cancelled_at: string | null } | undefined;
  if (!row) return { exists: false, active: false, checkoutAgent: null, category: null, completedAt: null, cancelledAt: null };
  return {
    exists: true,
    active: row.category === "active",
    checkoutAgent: row.agent,
    category: row.category,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
  };
}

/**
 * The row bound (`docs/timing-semantics.md`, "Work"): `completedAt` of a `done` row,
 * `cancelledAt` of a `cancelled` one, and no bound from any other row — `updatedAt` is not
 * one, because recategorizing a status moves issues without touching it.
 */
export function rowBoundOf(facts: IssueFacts): string | null {
  if (!facts.exists) return null;
  if (facts.category === "done") return facts.completedAt ?? null;
  if (facts.category === "cancelled") return facts.cancelledAt ?? null;
  return null;
}

/** The earliest of some instants, ignoring nulls; null when there are none. */
export function earliest(...instants: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  for (const instant of instants) if (typeof instant === "string" && (best === null || instant < best)) best = instant;
  return best;
}

/**
 * The newer orchestrator attempt by the same agent, anywhere in the workspace, in any
 * state, by `startedAt` then `id`: clause 3 of the orchestrator lane (`superseded_by_newer`)
 * and its bound. Null when this is the agent's newest.
 */
export function newerOrchestratorAttempt(db: DatabaseSync, attempt: AttemptRecord): { id: string; startedAt: string } | null {
  const row = db
    .prepare(
      `SELECT id, started_at FROM attempts
        WHERE role = 'orchestrator' AND agent = ? AND id <> ?
          AND (started_at > ? OR (started_at = ? AND id > ?))
        ORDER BY started_at, id LIMIT 1`,
    )
    .get(attempt.agent, attempt.id, attempt.startedAt, attempt.startedAt, attempt.id) as { id: string; started_at: string } | undefined;
  return row ? { id: row.id, startedAt: row.started_at } : null;
}

/**
 * The orchestrator lane's read-time clauses, from replicated rows only, so every device reads
 * the same answer. A stored-open orchestrator attempt is effectively ended when:
 *
 *   1. its issue no longer exists (`issue_removed`);
 *   2. its issue's category is `done` or `cancelled` (`issue_resolved`), bound `completedAt`
 *      or `cancelledAt`;
 *   3. a newer orchestrator attempt by the same agent exists in the workspace, in any state
 *      (`superseded_by_newer`), bound its `startedAt`.
 *
 * The reason is the FIRST clause that holds, and the limit the EARLIEST bound of every clause
 * that holds. Never contested: an orchestrator holds no claim.
 */
export function evaluateOrchestrator(db: DatabaseSync, attempt: AttemptRecord, facts: IssueFacts): Evaluation {
  if (attempt.state === "ended") return { orphanReason: null, contested: false, limit: null };
  const removed = !facts.exists;
  const resolved = facts.exists && (facts.category === "done" || facts.category === "cancelled");
  const newer = newerOrchestratorAttempt(db, attempt);
  const reason = removed ? "issue_removed" : resolved ? "issue_resolved" : newer !== null ? "superseded_by_newer" : null;
  if (reason === null) return { orphanReason: null, contested: false, limit: null };
  const limit = earliest(resolved ? rowBoundOf(facts) : null, newer?.startedAt ?? null);
  return { orphanReason: reason, contested: false, limit };
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
  /**
   * The WORKER lane only (`docs/timing-semantics.md`, "The orchestrator lane"): the contested
   * set, clauses 3 to 5 and `laterOpen` never see an orchestrator attempt, so an open
   * orchestrator attempt cannot orphan an older worker attempt as `superseded_by_merge`. An
   * orchestrator attempt passed in is left out of the map; `evaluateLanes` evaluates it.
   */
  const open = attempts.filter((attempt) => attempt.state !== "ended" && isWorkerAttempt(attempt)).sort(newestFirst);
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
  for (const attempt of attempts) if (!out.has(attempt.id) && isWorkerAttempt(attempt)) out.set(attempt.id, { orphanReason: null, contested: false });
  return out;
}

/** Both lanes of one issue, each with its own clauses: worker attempts by `evaluateIssue`, orchestrator ones by `evaluateOrchestrator`. */
export function evaluateLanes(db: DatabaseSync, attempts: readonly AttemptRecord[], facts: IssueFacts, mode: EvaluationMode): Map<string, Evaluation> {
  const out = evaluateIssue(attempts, facts, mode);
  for (const attempt of attempts) if (!isWorkerAttempt(attempt)) out.set(attempt.id, evaluateOrchestrator(db, attempt, facts));
  return out;
}

/** The WORKER attempts of an issue that are effectively open under `mode`, newest first. */
export function effectivelyOpen(db: DatabaseSync, issueId: string, mode: EvaluationMode, facts: IssueFacts = issueFacts(db, issueId)): AttemptRecord[] {
  const attempts = attemptsOfIssue(db, issueId).filter(isWorkerAttempt);
  const evaluation = evaluateIssue(attempts, facts, mode);
  return attempts.filter((attempt) => attempt.state !== "ended" && evaluation.get(attempt.id)?.orphanReason === null).sort(newestFirst);
}

/** The ORCHESTRATOR attempts of an issue that are effectively open, newest first. Replicated rows only, so no mode. */
export function effectivelyOpenOrchestrators(db: DatabaseSync, issueId: string, facts: IssueFacts = issueFacts(db, issueId)): AttemptRecord[] {
  return attemptsOfIssue(db, issueId)
    .filter((attempt) => !isWorkerAttempt(attempt) && attempt.state !== "ended" && evaluateOrchestrator(db, attempt, facts).orphanReason === null)
    .sort(newestFirst);
}

/**
 * Effectively open attempts in this workspace database, pulled ones included: the
 * concurrency context's `openAttemptsInWorkspace`, both lanes (both spend provider budget),
 * with the split by `role` beside it. Read-mode, as every surface reads.
 */
export function countEffectivelyOpenByRole(db: DatabaseSync): { all: number; worker: number; orchestrator: number } {
  const issues = (db.prepare("SELECT DISTINCT issue_id AS id FROM attempts WHERE state <> 'ended'").all() as Array<{ id: string }>).map((row) => row.id);
  let worker = 0;
  let orchestrator = 0;
  for (const issueId of issues) {
    const facts = issueFacts(db, issueId);
    worker += effectivelyOpen(db, issueId, "read", facts).length;
    orchestrator += effectivelyOpenOrchestrators(db, issueId, facts).length;
  }
  return { all: worker + orchestrator, worker, orchestrator };
}

/** {@link countEffectivelyOpenByRole}'s total. */
export function countEffectivelyOpen(db: DatabaseSync): number {
  return countEffectivelyOpenByRole(db).all;
}

/**
 * The newest event, comment or document revision by `agent` on the issue, floored at
 * `since`: the query the claim uses (`lastActivityOf` in `store.ts`), with the attempt's
 * agent and `startedAt`. Comments and revisions replicate and their events do not, so a
 * device that read the tail reads the writer's instant.
 */
export function lastActivityOf(db: DatabaseSync, issueId: string, agent: string, since: string): string {
  const row = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(created_at) AS t FROM events   WHERE issue_id = ? AND actor  = ?
         UNION ALL
         SELECT MAX(created_at) AS t FROM comments WHERE issue_id = ? AND author = ?
         UNION ALL
         SELECT MAX(created_at) AS t FROM document_revisions WHERE issue_id = ? AND author = ?
       )`,
    )
    .get(issueId, agent, issueId, agent, issueId, agent) as { t: string | null } | undefined;
  const newest = row?.t ?? null;
  return newest && newest > since ? newest : since;
}

/** The effective (read-time) view of one attempt, with every derived field. */
export interface AttemptView {
  readonly id: string;
  readonly issueId: string;
  readonly identifier: string | null;
  readonly agent: string;
  /** `worker` or `orchestrator`: the lane whose clauses this view was read with. */
  readonly role: string;
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

/**
 * Every chain link among an issue's worker-lane views, by the resuming attempt's start. An
 * attempt resumed more than once (two devices re-claimed it offline) links to the earliest
 * resumer, the one that ended its wait. An attempt nothing has resumed yet has no link.
 */
export function resumeGapsOf(
  views: readonly AttemptView[],
  /** The corrected end of every inferred or orphan end (`inferredEndsOf(…, "all")`). */
  ends: ReadonlyMap<string, string> = new Map(),
): ResumeGap[] {
  const workers = views.filter((view) => view.role === "worker");
  const byId = new Map(workers.map((view) => [view.id, view]));
  const linked = new Set<string>();
  const out: ResumeGap[] = [];
  for (const next of [...workers].sort((a, b) => (a.startedAt === b.startedAt ? (a.id < b.id ? -1 : 1) : a.startedAt < b.startedAt ? -1 : 1))) {
    const previous = next.resumesAttemptId === null ? undefined : byId.get(next.resumesAttemptId);
    if (!previous || linked.has(previous.id)) continue;
    // An orphan's end comes from `ends` (its replicated evidence before the resumer), never its
    // `endedAtBound`: that is the opener's last activity, the resumer's own included.
    const endedAt = ends.get(previous.id) ?? previous.endedAt ?? null;
    if (endedAt === null) continue;
    linked.add(previous.id);
    out.push({
      attemptId: previous.id,
      resumedByAttemptId: next.id,
      endedAt,
      resumedAt: next.startedAt,
      resumeGapSeconds: seconds(endedAt, next.startedAt),
      clockSkew: Date.parse(next.startedAt) + 1000 < Date.parse(endedAt),
    });
  }
  return out;
}

/** Every attempt of an issue as it reads, both lanes, oldest first; each view carries `role`. */
export function viewsOfIssue(db: DatabaseSync, issueId: string, now: string = nowIso()): AttemptView[] {
  const attempts = attemptsOfIssue(db, issueId);
  if (attempts.length === 0) return [];
  const evaluation = evaluateLanes(db, attempts, issueFacts(db, issueId), "read");
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
  const orchestrator = laneOf(attempt) === "orchestrator";
  const transitions = transitionsOf(db, attempt.id);
  /**
   * An orchestrator's activity is on the issues it coordinates, so its last activity is read
   * over the issue and every descendant; its orphan end is read from replicated evidence
   * before the clauses' limit, as every device reads it (`docs/timing-semantics.md`).
   */
  let lastActivityAt: string;
  if (!storedOpen) lastActivityAt = attempt.endedAt ?? attempt.startedAt;
  else if (orchestrator && orphaned) lastActivityAt = evidenceBefore(replicatedEvidence(db, attempt, transitions), attempt.startedAt, evaluation.limit ?? null);
  else if (orchestrator) lastActivityAt = lastActivityOfSubtree(db, attempt.issueId, attempt.agent, attempt.startedAt);
  else lastActivityAt = lastActivityOf(db, attempt.issueId, attempt.agent, attempt.startedAt);
  const clockEnd = lastActivityAt;
  const pausedSeconds = pausedSecondsOf(transitions, attempt.startedAt, clockEnd);
  const activeSeconds = Math.max(0, seconds(attempt.startedAt, clockEnd) - pausedSeconds);
  if (orphaned) missing.endedAt = "end_not_observed";
  return {
    id: attempt.id,
    issueId: attempt.issueId,
    identifier,
    agent: attempt.agent,
    role: laneOf(attempt),
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
    chain: chainOf(siblings.filter((sibling) => laneOf(sibling) === laneOf(attempt)), attempt.id),
    missing,
  };
}

// ------------------------------------------------------------- replicated evidence

/** An issue and every descendant of it, by the replicated `parent_id`. */
export function subtreeIds(db: DatabaseSync, issueId: string): string[] {
  return (
    db
      .prepare(
        `WITH RECURSIVE sub(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT i.id, sub.depth + 1 FROM issues i JOIN sub ON i.parent_id = sub.id WHERE sub.depth < 64
         ) SELECT id FROM sub`,
      )
      .all(issueId) as Array<{ id: string }>
  ).map((row) => row.id);
}

/** `lastActivityOf` over an issue and its descendants: an orchestrator's local last activity. */
export function lastActivityOfSubtree(db: DatabaseSync, issueId: string, agent: string, since: string): string {
  let newest = since;
  for (const id of subtreeIds(db, issueId)) {
    const at = lastActivityOf(db, id, agent, since);
    if (at > newest) newest = at;
  }
  return newest;
}

/** The transition kinds that are evidence of work. Never an ending one: the ledger dates those when the end is written. */
export const EVIDENCE_TRANSITIONS: ReadonlySet<string> = new Set([
  "attempt_started",
  "attempt_paused",
  "attempt_resumed",
  "attempt_milestone",
  "attempt_session_added",
]);

/**
 * Every replicated evidence instant of one attempt, ascending (`docs/timing-semantics.md`,
 * "Work"): its evidence transitions, and the `created_at` of every comment (not deleted)
 * and document revision on the issue by its agent after its `startedAt` — for an
 * orchestrator attempt, on the issue and every descendant. Never the local `events` table.
 * `startedAt` itself is not listed; {@link evidenceBefore} floors at it.
 */
export function replicatedEvidence(db: DatabaseSync, attempt: AttemptRecord, transitions: readonly AttemptTransition[] = transitionsOf(db, attempt.id)): string[] {
  const instants: string[] = transitions.filter((transition) => EVIDENCE_TRANSITIONS.has(transition.kind)).map((transition) => transition.at);
  const issues = laneOf(attempt) === "orchestrator" ? subtreeIds(db, attempt.issueId) : [attempt.issueId];
  const comment = db.prepare("SELECT created_at AS at FROM comments WHERE issue_id = ? AND author = ? AND deleted_at IS NULL AND created_at > ?");
  const revision = db.prepare("SELECT created_at AS at FROM document_revisions WHERE issue_id = ? AND author = ? AND created_at > ?");
  for (const issueId of issues) {
    for (const row of comment.all(issueId, attempt.agent, attempt.startedAt) as Array<{ at: string }>) instants.push(row.at);
    for (const row of revision.all(issueId, attempt.agent, attempt.startedAt) as Array<{ at: string }>) instants.push(row.at);
  }
  return instants.sort();
}

/**
 * `evidenceBefore(A, λ)`: the latest of `startedAt` and every evidence instant STRICTLY
 * before the limit. A limit filters the evidence and never clamps the end to itself; with
 * no limit, every instant counts. `inclusiveUpTo` is the stored orphan end's own filter:
 * evidence after it is ignored, evidence at it counts.
 */
export function evidenceBefore(instants: readonly string[], startedAt: string, limit: string | null, inclusiveUpTo: string | null = null): string {
  let latest = startedAt;
  for (const at of instants) {
    if (limit !== null && at >= limit) continue;
    if (inclusiveUpTo !== null && at > inclusiveUpTo) continue;
    if (at > latest) latest = at;
  }
  return latest;
}
