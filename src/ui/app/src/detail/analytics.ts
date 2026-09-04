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
import type { IssueStatus, IssueTiming, SubtreePlan } from "../lib/types";

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

/**
 * The two placeholders, as WORDS the tab sets in the normal interface face —
 * never as a figure. R7b's complaint was these two strings rendered at the size
 * and in the typeface reserved for durations, so "no estimate recorded" read as
 * the biggest number on the page.
 */
export const NO_ESTIMATE = "No estimate";
export const NOT_STARTED = "No work recorded";

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
 *    only open one is a derived flip (any rung) the issue does not get to
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
  /**
   * The child's EFFECTIVE plan — `subtreePlan.estimatedSeconds`: its own estimate
   * when it has one, otherwise its descendants'. This is the number a child is
   * counted as by its parent's headline, so it is what coverage is measured on:
   * an unestimated middle epic over three planned leaves HAS a plan.
   */
  plannedSeconds: number | null;
  /**
   * Where `plannedSeconds` came from, in words, for the tooltip on the child's
   * `est` figure — see `childPlanHint`. Null when there is no plan to explain.
   * A tooltip rather than a line, because R7c's brief is one concise line per
   * child: the provenance is secondary and must not become a permanent third row.
   */
  planHint: string | null;
  /** The child's HEADLINE actual, so a child that is itself a parent shows its aggregate. */
  actualSeconds: number | null;
  /**
   * Computed on `plannedSeconds`, not on the own estimate — so the delta on the
   * row is the same delta the child's own Analytics headline shows, and an
   * inheriting epic can have one at all.
   */
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
    const plannedSeconds = timing?.subtreePlan.estimatedSeconds ?? estimatedSeconds;
    return {
      identifier: child.identifier,
      title: child.title,
      status: child.status,
      estimatedSeconds,
      plannedSeconds,
      // No timing entry means no subtree to speak of: the fallback plan IS the own estimate.
      planHint: timing ? childPlanHint(timing.subtreePlan) : plannedSeconds === null ? null : OWN_PLAN,
      actualSeconds,
      delta: computeDelta(plannedSeconds, actualSeconds),
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
  /**
   * How many children carry a PLAN (own or inherited — see `ChildRow.plannedSeconds`),
   * and how many exist at all. Counted on the effective plan rather than the own
   * estimate because the headline is: under an 11h plan inherited from
   * grandchildren, "6 of 6 children have no estimate" would contradict the
   * figure above it — which is the STA-156 complaint this tab is for.
   */
  plannedCount: number;
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
    plannedCount: rows.filter((row) => row.plannedSeconds !== null).length,
    childCount: rows.length,
    runningCount: rows.filter((row) => row.activity.kind === "running").length,
    idleCount: rows.filter((row) => row.running && row.activity.kind !== "running").length,
    approximate: rows.some((row) => row.approximate),
  };
}

// ---------------------------------------------------------- the subtree plan

/**
 * The sentence under the recursive plan, or null when the figure needs none.
 *
 * Which sentence depends on where the number came from, because the two cases
 * mean opposite things to a reader: an INHERITED plan is a total nobody typed
 * and must say what it was built from, while an OWN plan sitting over planned
 * work must show the bottom-up number beside it rather than let one side win
 * quietly. Coverage is over descendants at every depth — not the direct-child
 * count the totals row reports — because that is the population the sum was
 * actually drawn from.
 */
export function subtreePlanHint(plan: SubtreePlan): string | null {
  const coverage = planCoverage(plan);
  if (plan.source === "descendants") return `inherited from ${coverage}`;
  if (plan.source === "own" && plan.descendantsEstimatedSeconds !== null) {
    return `own estimate; descendants add up to ${formatDuration(plan.descendantsEstimatedSeconds)} (${coverage})`;
  }
  return null;
}

/** The provenance a leaf's plan gets when there is nothing beneath it to compare against. */
const OWN_PLAN = "own estimate";

/**
 * The provenance of a CHILD's `est` figure (R7c, STA-194), for its tooltip.
 *
 * `subtreePlanHint` says nothing over a plain own estimate because the headline
 * beneath it already reads "planned"; on a child row the figure is one of six in
 * a column, some own and some inherited, and every one of them has to say which
 * it is or the reader cannot tell an 11h somebody typed from an 11h that flowed
 * up. Null only when there is no plan at all, which the row already spells out.
 */
export function childPlanHint(plan: SubtreePlan): string | null {
  if (plan.source === "none") return null;
  return subtreePlanHint(plan) ?? OWN_PLAN;
}

/** `3 of 9 descendants` — the population the recursive sum was drawn from. */
function planCoverage(plan: SubtreePlan): string {
  return `${plan.contributingCount} of ${plan.totalCount} descendants`;
}

// ---------------------------------------------------------- the spoken headline

/**
 * The headline as ONE sentence for a screen reader (R7c, STA-194): planned,
 * actual, difference, coverage, source — in that order, every time.
 *
 * The visible headline is three figures in a flex row with a hint under each,
 * which a screen reader walks as "planned, 11h, inherited from 3 of 9 descendants,
 * actual, ..." — the source arrives before the actual, and the coverage is buried
 * in the middle of the source. This sentence is the same facts in the order the
 * ticket names, and it is built from the same `Summary` and `SubtreePlan` the
 * figures are, so it cannot say a different number. The hints that qualify a
 * figure (`still running`, `provisional`) ride beside the figure they qualify.
 */
export function summarySentence(
  summary: Summary,
  plan: SubtreePlan,
  hints: { actual?: string | null; difference?: string | null } = {},
): string {
  const qualify = (text: string, hint: string | null | undefined) => (hint ? `${text} (${hint})` : text);
  const coverage = plan.totalCount === 0 ? "no descendants" : `${planCoverage(plan)} planned`;
  const source =
    plan.source === "own" ? OWN_PLAN : plan.source === "descendants" ? "inherited from descendants" : "no plan";
  return [
    `Planned ${formatOptionalDuration(summary.plannedSeconds, NO_ESTIMATE)}.`,
    `Actual ${qualify(formatOptionalDuration(summary.actualSeconds, NOT_STARTED), hints.actual)}.`,
    `Difference ${qualify(summary.delta ? summary.delta.label : "No comparison", hints.difference)}.`,
    `Coverage ${coverage}.`,
    `Source ${source}.`,
  ].join(" ");
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
  // Coverage is over PLANS, not own estimates: a child that inherited its plan
  // from its own children is covered. The no-plan-at-all case is a short
  // statement rather than "nothing to compare against", because the headline
  // may still hold this issue's OWN estimate — explainMissingDelta says the
  // rest when it does not.
  if (totals.plannedCount === 0 && totals.childCount > 0) {
    return `None of the ${totals.childCount} ${totals.childCount === 1 ? "child" : "children"} has a plan.`;
  }
  if (totals.plannedCount < totals.childCount) {
    const missing = totals.childCount - totals.plannedCount;
    notes.push(
      `${missing} of ${totals.childCount} ${missing === 1 ? "child has" : "children have"} no plan, so the plan and the actual cover different work.`,
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

// ------------------------------------------------------------------ the summary

/**
 * The ONE headline: what the plan says, what it has cost, and the gap.
 *
 * The delta's label IS the sentence ("7h40m under (70%)"); the prose headline
 * that used to repeat it under the totals card went with the card, because two
 * statements of one number were the "competing summaries" R7b removes. It stays
 * a duration rather than a productivity multiplier: a multiplier reads as a
 * claim about people, a duration as a measurement, which is all this data can
 * honestly support.
 *
 * Planned is the recursive `subtreePlan.estimatedSeconds`, which for a leaf IS
 * its own estimate (source `own`, or `none`) — so a leaf and a parent share one
 * shape, and the parent leads with the number that survives an epic-of-epics
 * rather than the depth-1 sum that lost STA-157's 11h on the way up to STA-156.
 * Actual is the headline `activeSeconds`, already the children's aggregate for a
 * parent. Neither number is computed here; both came off the server.
 */
export interface Summary {
  plannedSeconds: number | null;
  actualSeconds: number | null;
  delta: Delta | null;
  /** Where the plan came from, when that needs saying — see `subtreePlanHint`. */
  planHint: string | null;
}

export function computeSummary(timing: IssueTiming): Summary {
  const plannedSeconds = timing.subtreePlan.estimatedSeconds;
  const actualSeconds = timing.activeSeconds;
  return {
    plannedSeconds,
    actualSeconds,
    delta: computeDelta(plannedSeconds, actualSeconds),
    planHint: subtreePlanHint(timing.subtreePlan),
  };
}

// ---------------------------------------------------------------- the breakdown

/**
 * One line of the parent-only "own versus children" block.
 *
 * Every figure names its source in words beside it, because the two plans are
 * NOT addends: "This issue" is the top-down estimate somebody typed on the
 * parent, "Children" is the bottom-up sum of what its subtree planned, and the
 * headline takes the first when it exists, otherwise the second. Showing them
 * side by side is how a disagreement between the two becomes visible; labelling
 * their provenance is how a reader is stopped from adding them.
 */
export interface BreakdownRow {
  label: string;
  plannedSeconds: number | null;
  planSource: string;
  actualSeconds: number | null;
  actualSource: string;
}

/** Empty for a leaf: a leaf has one summary and nothing to break it down into. */
export function buildBreakdown(timing: IssueTiming): BreakdownRow[] {
  if (!isAggregated(timing)) return [];
  const plan = timing.subtreePlan;
  const descendants = `${plan.contributingCount} of ${plan.totalCount} descendants`;
  return [
    {
      label: "This issue",
      plannedSeconds: timing.estimatedSeconds,
      planSource:
        timing.estimatedSeconds === null
          ? "no estimate set on this issue"
          : "top-down, set on this issue",
      actualSeconds: timing.ownActiveSeconds,
      actualSource:
        timing.ownActiveSeconds === null
          ? "never worked directly"
          : "worked directly — not in the headline",
    },
    {
      label: "Children",
      plannedSeconds: plan.descendantsEstimatedSeconds,
      planSource:
        plan.descendantsEstimatedSeconds === null
          ? `no estimate among ${plan.totalCount} descendants`
          : `bottom-up, from ${descendants}`,
      actualSeconds: timing.childrenActiveSeconds,
      actualSource: aggregationHint(timing.childCount),
    },
  ];
}
