/**
 * Effort: agent work and orchestration on one issue, from REPLICATED data only
 * (`docs/timing-semantics.md`, "Effort: work and orchestration").
 *
 * `workSeconds` reads the worker-lane attempt rows, their transitions, the replicated issue
 * row and the agent's replicated comments and document revisions. It never reads the local
 * `events` table, so `lastActivityOf` is out: every device computes the same number from the
 * same rows, a freshly hydrated one included, and the number does not move when a stored
 * end arrives.
 *
 * ## The end of each attempt
 *
 *   - a recorded end, reported or by another actor: the stored `endedAt`;
 *   - a recorded end, inferred (`claim_stolen`, `released_stale`): the later of the stored
 *     `endedAt` and the evidence before the successor (a steal) or the release instant (a
 *     stale release), because the stored end is the ending device's local `lastActivityOf`;
 *   - an orphan end, stored or derived: the evidence before the earliest limit — the
 *     successor, the row bound for `left_active` (worker lane), the clauses' earliest bound
 *     (orchestrator lane) — and, for a stored one, at or before its stored `endedAt`;
 *   - effectively open: the evidence before the successor, or all of it.
 *
 * Limits FILTER evidence and never clamp the end to themselves (`evidenceBefore`).
 */
import type { DatabaseSync } from "node:sqlite";
import { isOrphanEnd } from "../cloud/attempt-ends.js";
import { attemptsOfIssue, laneOf, transitionsOf, type AttemptRecord, type AttemptTransition } from "./attempt-records.js";
import {
  earliest,
  evaluateLanes,
  evidenceBefore,
  issueFacts,
  newerOrchestratorAttempt,
  replicatedEvidence,
  rowBoundOf,
  type Evaluation,
  type IssueFacts,
} from "./attempt-derive.js";

/** `sparse`: a gap longer than this between consecutive evidence instants inside working time. */
export const SPARSE_GAP_MS = 30 * 60 * 1000;
/** The capture-gap and clock-skew tolerance: one second. */
const TOLERANCE_MS = 1000;

/** The quality inputs a reading of effort can carry (`docs/timing-semantics.md`, "Quality inputs"). */
export type EffortInput = "sparse" | "capture_gap" | "end_unbounded" | "contested" | "orphan_provisional" | "clock_skew" | "partial";

/** One attempt's contribution. */
export interface AttemptEffort {
  readonly id: string;
  readonly role: "worker" | "orchestrator";
  readonly startedAt: string;
  /** The effective end the contribution runs to. */
  readonly end: string;
  readonly seconds: number;
  readonly provenance: string;
  readonly inputs: readonly EffortInput[];
}

/** One issue's own effort in one lane. */
export interface LaneEffort {
  /** The sum over the lane's attempts, or null when the lane has none. */
  readonly seconds: number | null;
  readonly attempts: readonly AttemptEffort[];
  readonly inputs: readonly EffortInput[];
  readonly reconstructed: boolean;
}

const ms = (iso: string): number => Date.parse(iso);
const secondsBetween = (from: string, to: string): number => Math.max(0, Math.floor((ms(to) - ms(from)) / 1000));

/** The paused intervals of an attempt, each clipped to `[start, end)`, from its transitions. */
export function pausesOf(transitions: readonly AttemptTransition[], start: string, end: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let pausedAt: string | null = null;
  for (const transition of transitions) {
    if (transition.kind === "attempt_paused" && pausedAt === null) pausedAt = transition.at;
    else if (transition.kind === "attempt_resumed" && pausedAt !== null) {
      out.push([pausedAt, transition.at]);
      pausedAt = null;
    }
  }
  if (pausedAt !== null) out.push([pausedAt, end]);
  return out
    .map(([from, to]): [string, string] => [from < start ? start : from, to > end ? end : to])
    .filter(([from, to]) => from < to);
}

/** Seconds of `[start, end)` minus the paused seconds inside it, floored as `attempt.activeSeconds` floors them. */
function contribution(transitions: readonly AttemptTransition[], start: string, end: string): number {
  if (end <= start) return 0;
  const paused = pausesOf(transitions, start, end).reduce((sum, [from, to]) => sum + secondsBetween(from, to), 0);
  return Math.max(0, secondsBetween(start, end) - paused);
}

/**
 * True when two consecutive evidence instants inside working time are more than 30 minutes
 * apart once the paused time between them is taken out. The bounds of the working time count
 * as evidence: a silence up to the end is a gap like any other.
 */
function isSparse(instants: readonly string[], start: string, end: string, pauses: ReadonlyArray<[string, string]>): boolean {
  const points = [start, ...instants.filter((at) => at > start && at < end), end].sort();
  for (let i = 1; i < points.length; i += 1) {
    const from = ms(points[i - 1]!);
    const to = ms(points[i]!);
    let gap = to - from;
    for (const [pausedFrom, pausedTo] of pauses) {
      const overlap = Math.min(to, ms(pausedTo)) - Math.max(from, ms(pausedFrom));
      if (overlap > 0) gap -= overlap;
    }
    if (gap > SPARSE_GAP_MS) return true;
  }
  return false;
}

/** The next attempt of the same lane after `attempt` by `startedAt` then `id`: its successor limit. */
function successorOf(lane: readonly AttemptRecord[], attempt: AttemptRecord): string | null {
  const index = lane.findIndex((candidate) => candidate.id === attempt.id);
  return index >= 0 && index + 1 < lane.length ? lane[index + 1]!.startedAt : null;
}

/** The effective end of one attempt, and what reading it that way costs. */
export function effectiveEnd(
  attempt: AttemptRecord,
  transitions: readonly AttemptTransition[],
  evidence: readonly string[],
  evaluation: Evaluation | undefined,
  facts: IssueFacts,
  next: string | null,
): { end: string; inputs: EffortInput[] } {
  const inputs: EffortInput[] = [];
  const orchestrator = laneOf(attempt) === "orchestrator";
  const stored = attempt as unknown as Record<string, unknown>;
  if (attempt.state === "ended") {
    const endedAt = attempt.endedAt ?? attempt.startedAt;
    if (isOrphanEnd(stored)) {
      // A stored orphan end: the evidence before the limits, and at or before the stored end.
      let limit: string | null = next;
      if (!orchestrator && attempt.endReason === "left_active") {
        const bound = rowBoundOf(facts);
        if (bound === null && facts.exists) inputs.push("end_unbounded");
        limit = earliest(limit, bound);
      }
      if (orchestrator && attempt.endReason === "issue_resolved") limit = earliest(limit, rowBoundOf(facts));
      return { end: evidenceBefore(evidence, attempt.startedAt, limit, endedAt), inputs };
    }
    if (attempt.endDetection === "inferred" && (attempt.endReason === "claim_stolen" || attempt.endReason === "released_stale")) {
      const limit =
        attempt.endReason === "claim_stolen"
          ? next
          : ([...transitions].reverse().find((transition) => transition.kind === "attempt_interrupted")?.at ?? next);
      const derived = evidenceBefore(evidence, attempt.startedAt, limit);
      return { end: derived > endedAt ? derived : endedAt, inputs };
    }
    return { end: endedAt, inputs };
  }
  if (evaluation?.orphanReason) {
    // A derived orphan end: provisional until the opening device writes the stored one.
    inputs.push("orphan_provisional");
    let limit: string | null;
    if (orchestrator) limit = earliest(next, evaluation.limit ?? null);
    else {
      limit = next;
      if (evaluation.orphanReason === "left_active") {
        const bound = rowBoundOf(facts);
        if (bound === null) inputs.push("end_unbounded");
        limit = earliest(limit, bound);
      }
    }
    return { end: evidenceBefore(evidence, attempt.startedAt, limit), inputs };
  }
  return { end: evidenceBefore(evidence, attempt.startedAt, next), inputs };
}

/**
 * One issue's own effort, both lanes, from replicated data. `workers` is `ownWorkSeconds`'
 * measurement; `orchestrators` the issue's own orchestration (children not included).
 */
export function issueEffort(db: DatabaseSync, issueId: string): { workers: LaneEffort; orchestrators: LaneEffort; firstWorkerStart: string | null } {
  const attempts = attemptsOfIssue(db, issueId);
  const facts = issueFacts(db, issueId);
  const evaluation = evaluateLanes(db, attempts, facts, "read");
  /**
   * Two devices ended one attempt differently, and nobody has settled it: each holds its own end,
   * so the contribution is this device's reading of an open question (`conflicts.ts`, the
   * attempt's `end`). Contested, as the telemetry contract has it, until the record is resolved.
   */
  const endDisputed = new Set(
    (db
      .prepare("SELECT entity_id AS id FROM sync_conflicts WHERE entity = 'attempt' AND field = 'end' AND resolved_at IS NULL")
      .all() as Array<{ id: string }>).map((row) => row.id),
  );
  const workers = attempts.filter((attempt) => laneOf(attempt) === "worker");
  const orchestrators = attempts.filter((attempt) => laneOf(attempt) === "orchestrator");

  const lane = (members: readonly AttemptRecord[], role: "worker" | "orchestrator"): LaneEffort => {
    if (members.length === 0) return { seconds: null, attempts: [], inputs: [], reconstructed: false };
    const out: AttemptEffort[] = [];
    const laneInputs = new Set<EffortInput>();
    for (const attempt of members) {
      const transitions = transitionsOf(db, attempt.id);
      const evidence = replicatedEvidence(db, attempt, transitions);
      /**
       * The successor limit: the next worker attempt on the issue; for an orchestrator, the
       * agent's next orchestrator attempt anywhere in the workspace (clause 3's bound), so one
       * agent's orchestration never overlaps itself.
       */
      const next = role === "worker" ? successorOf(members, attempt) : (newerOrchestratorAttempt(db, attempt)?.startedAt ?? null);
      const read = evaluation.get(attempt.id);
      const { end, inputs } = effectiveEnd(attempt, transitions, evidence, read, facts, next);
      const attemptInputs = new Set<EffortInput>(inputs);
      if (read?.contested || endDisputed.has(attempt.id)) attemptInputs.add("contested");
      if (ms(end) + TOLERANCE_MS < ms(attempt.startedAt)) attemptInputs.add("clock_skew");
      const bound = rowBoundOf(facts);
      if (bound !== null && ms(bound) + TOLERANCE_MS < ms(attempt.startedAt)) attemptInputs.add("clock_skew");
      const pauses = pausesOf(transitions, attempt.startedAt, end > attempt.startedAt ? end : attempt.startedAt);
      if (isSparse(evidence, attempt.startedAt, end, pauses)) attemptInputs.add("sparse");
      for (const input of attemptInputs) laneInputs.add(input);
      out.push({
        id: attempt.id,
        role,
        startedAt: attempt.startedAt,
        end,
        seconds: contribution(transitions, attempt.startedAt, end),
        provenance: attempt.provenance,
        inputs: [...attemptInputs].sort(),
      });
    }
    return {
      seconds: out.reduce((sum, attempt) => sum + attempt.seconds, 0),
      attempts: out,
      inputs: [...laneInputs].sort(),
      reconstructed: out.some((attempt) => attempt.provenance === "reconstructed"),
    };
  };

  return { workers: lane(workers, "worker"), orchestrators: lane(orchestrators, "orchestrator"), firstWorkerStart: workers[0]?.startedAt ?? null };
}

/** What {@link inferredEndsOf} reads of an attempt view. */
type EndedView = { id: string; role: string; state: string; storedState: string; endDetection: string | null; endReason: string | null };

/**
 * The corrected end of each worker attempt whose end was inferred rather than written by the
 * mutation that ended it, by attempt id: the end {@link effectiveEnd} gives `workSeconds`.
 *
 * - `scope: "inferred"`: a recorded end inferred by a steal or a stale release (`claim_stolen`,
 *   `released_stale`). Its stored `endedAt` is the ending device's own `lastActivityOf`, which
 *   misses evidence that had not reached that device; read alone it puts work the agent did
 *   in `interrupted`. The elapsed partition reads these.
 * - `scope: "all"`: those, and every orphan end, stored or derived. An orphan's `endedAtBound`
 *   and its stored end are dated at the opener's `lastActivityOf`, which counts the activity
 *   of the attempt that resumed it when the same agent resumed: measured from there, the
 *   chain link runs backwards. A chain link (`resumeGapSeconds`, and its clock-skew test)
 *   reads these.
 */
export function inferredEndsOf(views: readonly EndedView[], workers: LaneEffort, scope: "inferred" | "all" = "inferred"): Map<string, string> {
  const effortEnd = new Map(workers.attempts.map((attempt) => [attempt.id, attempt.end]));
  const out = new Map<string, string>();
  for (const view of views) {
    if (view.role !== "worker" || view.state !== "ended") continue;
    const stolenOrReleased = view.storedState === "ended" && view.endDetection === "inferred" && (view.endReason === "claim_stolen" || view.endReason === "released_stale");
    const orphan = view.endDetection === "derived" || (view.storedState === "ended" && view.endDetection === "inferred");
    if (!stolenOrReleased && !(scope === "all" && orphan)) continue;
    const end = effortEnd.get(view.id);
    if (end !== undefined) out.set(view.id, end);
  }
  return out;
}

/** True when the row's `startedAt` is more than one second before the first worker attempt: work before it has no attempt. */
export function hasCaptureGap(rowStartedAt: string | null, firstWorkerStart: string | null): boolean {
  return rowStartedAt !== null && firstWorkerStart !== null && ms(firstWorkerStart) - ms(rowStartedAt) > TOLERANCE_MS;
}
