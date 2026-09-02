/**
 * The arithmetic and the phrasing behind the Analytics tab.
 *
 * Pure by design and tested separately (analytics.test.ts), following the
 * convention every other computed thing in this app uses — lib/claim.ts,
 * lib/graph-lineage.ts, detail/agentPayload.ts. There are no component tests in
 * this repo, so logic that lives inside a `.tsx` is logic nothing checks.
 *
 * ## The one rule everything here serves: never invent a number
 *
 * An estimate can be missing. An actual can be missing. Either absence makes a
 * delta impossible, and the honest output is a sentence saying so — not a 0, not
 * a dash that reads like a 0, and never a percentage computed against nothing.
 *
 * This matters more here than in most UI. The entire point of the feature is to
 * answer "what did agentic execution save against the human plan", and a view
 * that silently treats un-estimated work as estimated-at-zero answers it with a
 * number that is not merely imprecise but backwards: unplanned work would report
 * as infinite overrun, and an epic with three unplanned children would look like
 * a catastrophe rather than like an epic nobody estimated.
 */
// RELATIVE, not "@/lib/types": there is no vitest config at the repo root, so the
// app's `@` alias does not exist at test time. These are type-only and would erase
// either way, but the convention (see lib/graph-lineage.ts) is that a pure module
// stays resolvable without the alias — so a later edit that needs a VALUE from here
// cannot quietly make this file untestable.
import { STALE_CLAIM_SECONDS, formatAgo } from "../lib/claim";
import type { IssueStatus, IssueTiming } from "../lib/types";

/**
 * Durations for estimate-vs-actual prose: `45s`, `20m`, `3h10m`, `2d4h`.
 *
 * Mirrors `formatDuration` in src/core/types.ts, which is what `staple show`
 * prints — the two must agree, or the page and the CLI describe the same task
 * with two different numbers. Deliberately NOT `formatAgo` from lib/claim.ts:
 * that floors to a single unit, which is right for "silent for 2h" and wrong
 * here, where `2h` and `2h55m` are the difference between hitting an estimate
 * and blowing it.
 *
 * At most two units, largest first, trailing zero unit dropped (`2h`, not `2h0m`).
 */
export function formatDuration(seconds: number): string {
  // A non-finite input is a bug upstream (a missing field under version skew
  // reached arithmetic), but humans must never read "NaNd" — clamp to 0s.
  if (!Number.isFinite(seconds)) return "0s";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    return rest ? `${Math.floor(s / 60)}m${rest}s` : `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) {
    const rest = Math.floor((s % 3600) / 60);
    return rest ? `${Math.floor(s / 3600)}h${rest}m` : `${Math.floor(s / 3600)}h`;
  }
  const rest = Math.floor((s % 86400) / 3600);
  return rest ? `${Math.floor(s / 86400)}d${rest}h` : `${Math.floor(s / 86400)}d`;
}

/**
 * A duration slot that may legitimately hold nothing.
 *
 * `null` is rendered as a NAMED absence, never as `0s` or `—`. A dash in a
 * numeric column reads as zero to most people, and this column is one where
 * zero is a meaningful (and wrong) value.
 */
export function formatOptionalDuration(seconds: number | null, absent: string): string {
  return seconds === null ? absent : formatDuration(seconds);
}

export const NO_ESTIMATE = "no estimate recorded";
export const NOT_STARTED = "not started";

// ------------------------------------------------------------------- the delta

export type DeltaDirection = "over" | "under" | "on";

export interface Delta {
  /** actual - estimate, in seconds. Positive means it took longer than planned. */
  differenceSeconds: number;
  direction: DeltaDirection;
  /**
   * `differenceSeconds / estimate`, as a fraction. 0.25 means 25% over.
   * Always finite: a zero estimate cannot reach here, because the store refuses
   * to store one.
   */
  ratio: number;
  /** "1h10m over (58%)" / "20m under (17%)" / "on estimate". */
  label: string;
}

/**
 * The delta between a plan and a result, or null when one side is missing.
 *
 * Returning null rather than a zero-filled Delta is the load-bearing choice: a
 * caller cannot accidentally render "0s on estimate" for a task nobody
 * estimated, because there is no object to render. The absence has to be
 * handled, which is how it ends up being described.
 */
export function computeDelta(
  estimatedSeconds: number | null,
  actualSeconds: number | null,
): Delta | null {
  if (estimatedSeconds === null || actualSeconds === null) return null;
  // Defensive, not expected: the store refuses a non-positive estimate, so this
  // only fires on a hand-edited database. Dividing by it would produce Infinity
  // and a "Infinity%" label, which is worse than declining to answer.
  if (estimatedSeconds <= 0) return null;

  const differenceSeconds = actualSeconds - estimatedSeconds;
  const ratio = differenceSeconds / estimatedSeconds;
  const direction: DeltaDirection =
    differenceSeconds > 0 ? "over" : differenceSeconds < 0 ? "under" : "on";
  const label =
    direction === "on"
      ? "on estimate"
      : `${formatDuration(Math.abs(differenceSeconds))} ${direction} (${Math.abs(Math.round(ratio * 100))}%)`;
  return { differenceSeconds, direction, ratio, label };
}

/**
 * Why a delta could not be computed, in words. Called only when computeDelta
 * returned null, so exactly one of these three sentences is always true.
 */
export function explainMissingDelta(
  estimatedSeconds: number | null,
  actualSeconds: number | null,
): string {
  if (estimatedSeconds === null && actualSeconds === null) {
    return "No estimate and no time recorded yet.";
  }
  if (estimatedSeconds === null) {
    return "No estimate recorded, so there is nothing to compare this against.";
  }
  return "Not started yet, so there is no actual to compare against.";
}

// ------------------------------------------------------------- provisional-ness

/**
 * Statuses whose actual can still grow.
 *
 * An under/over verdict on live work is a snapshot, not a result — a task
 * currently at 40% of its estimate has not come in under, it simply has not
 * finished. Saying so is the difference between a useful readout and one that
 * flatters whoever is looking at it mid-task.
 *
 * NOTE the distinction from `activityState` below, which they are easy to
 * confuse. This is about the STATUS: an unfinished task's delta is provisional
 * whether or not anyone is currently typing into it. That is about EVIDENCE:
 * whether the clock is still being fed. A task in_progress whose agent died is
 * provisional (it may yet be resumed) AND idle (nothing is accumulating), and a
 * page that conflates the two ends up saying "still running" about a corpse —
 * which is the complaint STA-90 exists to fix.
 */
const LIVE_STATUSES: readonly IssueStatus[] = ["in_progress", "in_review"];

export function isStillRunning(status: IssueStatus): boolean {
  return LIVE_STATUSES.includes(status);
}

// ------------------------------------------------------------- is it moving?

/**
 * What the clock is doing, from `timing.countedThrough` alone.
 *
 *  - `stopped` — nothing is accumulating. Either no interval is open, or the
 *    only open one is a derived `child_started` flip the issue does not get to
 *    count. This is what an epic returns, and it is why the tab no longer prints
 *    "still running" underneath one.
 *  - `running` — an interval is open and the holder wrote something recently.
 *  - `idle` — an interval is open but the last evidence of work is old. The
 *    number on screen is FROZEN at that instant; it is not going up, and saying
 *    "still running" over it would be the exact lie in VP's screenshot.
 */
export type ActivityState =
  | { kind: "stopped" }
  | { kind: "running"; idleSeconds: number }
  | { kind: "idle"; idleSeconds: number };

/**
 * The threshold, reused rather than reinvented.
 *
 * `STALE_CLAIM_SECONDS` is already the app's single answer to "has this agent
 * gone quiet" — it drives the stale-claim badge and the number the takeover
 * buttons send the store. A second, differently-tuned constant here would let
 * the same ticket read "silent 35m" in its header and "still running" in its
 * analytics tab at the same moment. One judgement about silence, one constant.
 */
export const IDLE_AFTER_SECONDS = STALE_CLAIM_SECONDS;

export function activityState(
  countedThrough: string | null,
  nowMs: number = Date.now(),
  thresholdSeconds: number = IDLE_AFTER_SECONDS,
): ActivityState {
  if (!countedThrough) return { kind: "stopped" };
  const parsed = Date.parse(countedThrough);
  // An unparseable instant is not evidence of anything; refuse to invent a state.
  if (!Number.isFinite(parsed)) return { kind: "stopped" };
  const idleSeconds = Math.max(0, Math.floor((nowMs - parsed) / 1000));
  return idleSeconds >= thresholdSeconds
    ? { kind: "idle", idleSeconds }
    : { kind: "running", idleSeconds };
}

/**
 * The sentence under a leaf's actual, or null when there is nothing to add.
 *
 * The three outcomes are deliberately different SHAPES, not three adjectives:
 * "still running" makes a claim about the present, "idle 2h — clock stopped at
 * last activity" makes a claim about the past and names why the number is not
 * moving, and silence claims nothing at all.
 */
export function activityHint(state: ActivityState): string | null {
  if (state.kind === "stopped") return null;
  if (state.kind === "running") return "still running";
  return `idle ${formatAgo(state.idleSeconds)} — clock stopped at last activity`;
}

/**
 * The hint under a PARENT's actual. Never a running state: a parent's number is
 * an aggregation of its children and has no clock of its own to be running.
 */
export function aggregationHint(childCount: number): string {
  return `aggregated from ${childCount} ${childCount === 1 ? "child" : "children"}`;
}

/**
 * `true` when this issue's headline actual is an aggregate rather than its own
 * time. One predicate, so the label, the hint and the caveat cannot disagree
 * about which card they are looking at.
 */
export function isAggregated(timing: IssueTiming): boolean {
  return timing.childCount > 0;
}

// --------------------------------------------------------------- the child rows

export interface ChildRow {
  identifier: string;
  title: string;
  status: IssueStatus;
  estimatedSeconds: number | null;
  /** The child's HEADLINE actual, so a child that is itself a parent shows its aggregate. */
  actualSeconds: number | null;
  delta: Delta | null;
  /** True while the task is unfinished — the delta is a snapshot, not a verdict. */
  running: boolean;
  /** Whether this child's clock is actually still being fed. See `activityState`. */
  activity: ActivityState;
  /** True when this child's numbers came from the two-timestamp fallback. */
  approximate: boolean;
}

/** The minimum an issue must expose to become a row. */
interface ChildLike {
  identifier: string;
  title: string;
  status: IssueStatus;
  estimatedSeconds: number | null;
}

/**
 * Join the children the detail payload already carries against the timing map,
 * preserving the server's ordering (children come back ordered by created_at).
 *
 * The timing map is keyed by IDENTIFIER, which is what makes this a one-line
 * lookup rather than an index build. A child with no timing entry cannot
 * normally happen — the server derives one per direct child — but it degrades to
 * all-nulls rather than throwing, because a detail panel that white-screens over
 * a missing analytics row is a worse outcome than one that says "not started".
 */
export function buildChildRows(
  children: readonly ChildLike[],
  childrenTiming: Record<string, IssueTiming>,
  nowMs: number = Date.now(),
): ChildRow[] {
  return children.map((child) => {
    const timing = childrenTiming[child.identifier];
    // Prefer the timing echo, fall back to the entity's own stored field.
    const estimatedSeconds = timing?.estimatedSeconds ?? child.estimatedSeconds;
    const actualSeconds = timing?.activeSeconds ?? null;
    return {
      identifier: child.identifier,
      title: child.title,
      status: child.status,
      estimatedSeconds,
      actualSeconds,
      delta: computeDelta(estimatedSeconds, actualSeconds),
      running: isStillRunning(child.status),
      activity: activityState(timing?.countedThrough ?? null, nowMs),
      approximate: timing?.approximate ?? false,
    };
  });
}

// -------------------------------------------------------------------- the totals

export interface Totals {
  estimatedSeconds: number | null;
  actualSeconds: number | null;
  delta: Delta | null;
  /** How many children carry an estimate, and how many exist at all. */
  estimatedCount: number;
  childCount: number;
  /**
   * How many children are ACTUALLY accumulating time right now — a fed clock,
   * not merely an unfinished status. Under the old two-timestamp scheme these
   * were the same thing and the count was honest by accident; now a task whose
   * agent died is unfinished but contributes nothing more to the total, and
   * warning "still growing" about it would be false.
   */
  runningCount: number;
  /** Unfinished children whose clock has frozen — work that stalled, not work in flight. */
  idleCount: number;
  /** True when any child's numbers came from the two-timestamp fallback. */
  approximate: boolean;
}

/**
 * The totals row and the headline figure.
 *
 * The two sums come from the SERVER (`timing.childrenEstimatedSeconds` /
 * `childrenElapsedSeconds`) rather than being re-added here. That is deliberate:
 * one source means the page can never disagree with `staple show`, with
 * `get_task`, or with itself. A client-side sum would be a second implementation
 * of the same arithmetic, and the only way to notice it had drifted would be for
 * someone to add the column up by hand.
 *
 * The per-child counts ARE derived from the rows, because they describe the
 * rows on screen — how much of the plan is missing, and how much of the work is
 * still moving.
 */
export function computeTotals(timing: IssueTiming, rows: readonly ChildRow[]): Totals {
  const estimatedSeconds = timing.childrenEstimatedSeconds;
  const actualSeconds = timing.childrenActiveSeconds;
  return {
    estimatedSeconds,
    actualSeconds,
    delta: computeDelta(estimatedSeconds, actualSeconds),
    estimatedCount: rows.filter((row) => row.estimatedSeconds !== null).length,
    childCount: rows.length,
    runningCount: rows.filter((row) => row.activity.kind === "running").length,
    idleCount: rows.filter((row) => row.running && row.activity.kind !== "running").length,
    approximate: rows.some((row) => row.approximate),
  };
}

/**
 * The caveat under the headline, or null when there is nothing to warn about.
 *
 * Two independent ways a total can mislead, and both must be said out loud:
 *
 *  - **Partial plan.** If only two of five children were estimated, the
 *    estimated total covers two children while the actual total covers all
 *    five, and the comparison is apples to oranges. This is the single most
 *    dangerous number on the tab and the one most likely to be quoted.
 *  - **Work in flight.** Running children keep adding to the actual, so a
 *    favourable total is provisional.
 *  - **Stalled work.** An unfinished child whose clock has frozen is the
 *    opposite warning and needed saying separately: the total is NOT growing,
 *    and the reason is that nobody is working it. Folding it into "still
 *    running" — which is what the old status-only count did — turned a stalled
 *    epic into one that looked busy.
 *  - **Approximation.** A total containing a fallback-derived child is not the
 *    same kind of number as one reconstructed from the log.
 */
export function totalsCaveat(totals: Totals): string | null {
  const notes: string[] = [];
  if (totals.estimatedCount === 0 && totals.childCount > 0) {
    return "No child has an estimate, so there is no plan to compare against.";
  }
  if (totals.estimatedCount < totals.childCount) {
    const missing = totals.childCount - totals.estimatedCount;
    notes.push(
      `${missing} of ${totals.childCount} ${missing === 1 ? "child has" : "children have"} no estimate, so the totals cover different work on each side.`,
    );
  }
  if (totals.runningCount > 0) {
    notes.push(
      `${totals.runningCount} still running, so the actual is still growing.`,
    );
  }
  if (totals.idleCount > 0) {
    notes.push(
      `${totals.idleCount} unfinished but idle, so ${totals.idleCount === 1 ? "its clock has" : "their clocks have"} stopped at the last sign of work.`,
    );
  }
  if (totals.approximate) {
    notes.push("Some children have no usable history, so their time is approximate.");
  }
  return notes.length > 0 ? notes.join(" ") : null;
}

/**
 * The headline sentence: what the plan said, what it cost, and the gap.
 *
 * Framed as saved/extra TIME rather than as a productivity multiplier. A
 * multiplier reads as a claim about people; a duration reads as a measurement,
 * which is all this data can honestly support. Richer framings (dollar figures,
 * comparisons across epics) are STA-83's brainstorm, deliberately not invented
 * here.
 */
export function headline(totals: Totals): string {
  if (!totals.delta) return explainMissingDelta(totals.estimatedSeconds, totals.actualSeconds);
  if (totals.delta.direction === "on") return "Execution matched the plan exactly.";
  const amount = formatDuration(Math.abs(totals.delta.differenceSeconds));
  return totals.delta.direction === "under"
    ? `${amount} less than planned.`
    : `${amount} more than planned.`;
}
