/**
 * Milestone goal mode, the pure half (docs/runs.md "Goal mode", docs/milestones.md "Goal").
 *
 * A run scoped to a milestone treats the milestone as its goal: the milestone's own
 * acceptance criteria are the definition of done. Whether each criterion is met is judged
 * by the agent driving the run, never inside the tracker (there is no model here), and
 * recorded as a MARK: a verdict with the evidence it rests on. What the tracker does is
 * decide, deterministically, what a mark is still worth at the moment of the check:
 *
 *  - no mark is `unknown`: unknown is the default, never met;
 *  - a mark on different words is `unknown`: the criterion was reworded after it was judged;
 *  - a `met` mark whose evidence no longer holds is `unknown`: a cited ticket that is not
 *    done any more, or a cited document that is gone, no longer shows what it showed;
 *  - otherwise the mark stands.
 *
 * Everything here is a function of its arguments. The store reads the rows and the
 * evidence facts; `milestone-store.ts` and `run-store.ts` act on the answer.
 */
import { daysUntil, isOverdue, parseMilestoneDate, type MilestoneProgress } from "./milestones.js";

export const CRITERION_VERDICTS = ["met", "unmet", "unknown"] as const;
export type CriterionVerdict = (typeof CRITERION_VERDICTS)[number];

/** How many tickets a goal run may create itself (goal checks and follow-ups) unless told otherwise. */
export const GOAL_CHILD_CAP_DEFAULT = 5;

/** The `origin_kind` of a ticket a run created; its `origin_id` is `<run id>/<n>`, n counting from 1. */
export const RUN_ORIGIN_KIND = "run";

/** One stored mark, as `milestone_criterion_marks` holds it. */
export interface CriterionMark {
  position: number;
  /** The criterion's text when it was marked. */
  criterion: string;
  verdict: CriterionVerdict;
  /** As given: an issue reference, `<ref>:<document key>`, or free text. */
  evidence: string[];
  note: string | null;
  markedBy: string;
  runId: string | null;
  markedAt: string;
}

/** What a piece of evidence names, read off its text. */
export type EvidenceKind = "ticket" | "document" | "text";

/** One piece of evidence and whether it still holds at the check. */
export interface EvidenceItem {
  kind: EvidenceKind;
  /** The text as it was given. */
  value: string;
  /** The issue it names, for a ticket or a document. */
  ref: string | null;
  /** The document key, for a document. */
  document: string | null;
  /** The cited ticket's status now, for a ticket. */
  status: string | null;
  /** Text always holds; a ticket holds while it is done; a document while it exists. */
  holds: boolean;
  /** Why it does not hold; null when it does. */
  problem: string | null;
}

/** One criterion as the goal check reads it. */
export interface GoalCriterion {
  /** 1-based, in the milestone's criteria order. */
  position: number;
  text: string;
  /** What the check makes of it now. */
  verdict: CriterionVerdict;
  /** What was marked, when anything was; it differs from `verdict` when the mark no longer stands. */
  marked: CriterionVerdict | null;
  evidence: EvidenceItem[];
  note: string | null;
  markedBy: string | null;
  markedAt: string | null;
  runId: string | null;
  /** Why `verdict` reads `unknown` over a mark, or that nothing was marked; null when the mark stands. */
  why: string | null;
}

export interface GoalCounts {
  met: number;
  unmet: number;
  unknown: number;
  total: number;
}

const TICKET_PATTERN = /^([A-Za-z][A-Za-z0-9]*-\d+)$/;
const DOCUMENT_PATTERN = /^([A-Za-z][A-Za-z0-9]*-\d+):([A-Za-z0-9][A-Za-z0-9_.-]*)$/;

/**
 * What a piece of evidence text names: `ABC-12` a ticket, `ABC-12:plan` a document on it,
 * anything else free text. Whether the ticket is in this workspace is the store's question.
 */
export function parseEvidence(raw: string): { kind: EvidenceKind; value: string; ref: string | null; document: string | null } {
  const value = raw.trim();
  const document = DOCUMENT_PATTERN.exec(value);
  if (document) return { kind: "document", value, ref: document[1]!.toUpperCase(), document: document[2]! };
  const ticket = TICKET_PATTERN.exec(value);
  if (ticket) return { kind: "ticket", value, ref: ticket[1]!.toUpperCase(), document: null };
  return { kind: "text", value, ref: null, document: null };
}

/** What one criterion's mark is worth now. See the module comment for the rules. */
export function judgeCriterion(position: number, text: string, mark: CriterionMark | null, evidence: readonly EvidenceItem[]): GoalCriterion {
  const base = {
    position,
    text,
    marked: mark?.verdict ?? null,
    evidence: [...evidence],
    note: mark?.note ?? null,
    markedBy: mark?.markedBy ?? null,
    markedAt: mark?.markedAt ?? null,
    runId: mark?.runId ?? null,
  };
  if (mark === null) return { ...base, verdict: "unknown", why: "not marked yet" };
  if (mark.criterion !== text) {
    return { ...base, verdict: "unknown", why: `the criterion was reworded after it was marked ${mark.verdict} (it read "${mark.criterion}")` };
  }
  if (mark.verdict === "met") {
    const failing = evidence.filter((item) => !item.holds);
    if (failing.length > 0) {
      return { ...base, verdict: "unknown", why: `marked met, but its evidence no longer holds: ${failing.map((item) => item.problem).join("; ")}` };
    }
  }
  return { ...base, verdict: mark.verdict, why: null };
}

export function goalCounts(criteria: readonly GoalCriterion[]): GoalCounts {
  const count = (verdict: CriterionVerdict) => criteria.filter((criterion) => criterion.verdict === verdict).length;
  return { met: count("met"), unmet: count("unmet"), unknown: count("unknown"), total: criteria.length };
}

/** Every criterion met. A milestone with no criteria has nothing left to show: its goal is its members. */
export function isGoalMet(counts: GoalCounts): boolean {
  return counts.met === counts.total;
}

// ---------- pace against the target date ----------

export const PACE_VERDICTS = ["done", "no_target", "overdue", "no_estimate", "behind", "on_track"] as const;
export type PaceVerdict = (typeof PACE_VERDICTS)[number];

/** One top-level member's certified plan, as `compare` reads it (`plan-rollup.ts`). */
export interface MemberPlan {
  ref: string;
  /** The member landed or was cancelled: nothing of it remains. */
  resolved: boolean;
  /** `labor.seconds`: the member's whole plan. Null when nothing under it is planned. */
  laborSeconds: number | null;
  /** `remainingPath.seconds`: its longest chain of work not yet done. Null when unplanned. */
  remainingSeconds: number | null;
  /** Its plan has unplanned units, a broken cycle, or none at all. */
  partial: boolean;
  unplannedRefs: readonly string[];
}

/** Where the milestone stands against its target date: done work, remaining estimate, days left. */
export interface GoalPace {
  targetDate: string | null;
  /** Whole UTC calendar days to the target: 0 on the day, negative after. Null without a target. */
  daysToTarget: number | null;
  /** Leaves done, of the countable ones (the milestone's progress). */
  leaves: { done: number; countable: number; percent: number | null };
  /** The members' plans added up: every member worked one after another. */
  laborSeconds: number | null;
  /** The members' remaining paths added up; 0 when every member landed. Null when nothing open is planned. */
  remainingSeconds: number | null;
  /** Some open member is unplanned or partly planned: the estimates are lower bounds. */
  partial: boolean;
  unplannedRefs: string[];
  verdict: PaceVerdict;
  message: string;
}

const HOUR = 3600;

function hours(seconds: number): string {
  return `${Math.round((seconds / HOUR) * 10) / 10}h`;
}

/**
 * Done vs remaining estimate vs days to the target. The verdict, first match wins:
 * `done` (every countable leaf landed), `no_target`, `overdue` (past the target day),
 * `no_estimate` (nothing open is planned), `behind` (the remaining estimate is more than
 * the time left to the end of the target day, even worked around the clock: a certain
 * miss, not a forecast), else `on_track` (the remaining estimate fits in the time left; it
 * says nothing about whether anyone will work it).
 */
export function goalPace(input: {
  targetDate: string | null;
  now: string;
  progress: MilestoneProgress;
  plans: readonly MemberPlan[];
}): GoalPace {
  const { targetDate, now, progress } = input;
  const open = input.plans.filter((plan) => !plan.resolved);
  const sum = (values: Array<number | null>): number | null =>
    values.some((value) => value !== null) ? values.reduce<number>((total, value) => total + (value ?? 0), 0) : null;
  const laborSeconds = sum(input.plans.map((plan) => plan.laborSeconds));
  const remainingSeconds = open.length === 0 ? 0 : sum(open.map((plan) => plan.remainingSeconds));
  const partial = open.some((plan) => plan.partial || plan.remainingSeconds === null);
  const unplannedRefs = [...new Set(open.flatMap((plan) => plan.unplannedRefs))];

  const target = targetDate === null ? null : parseMilestoneDate(targetDate);
  const daysToTarget = target === null ? null : daysUntil(target, now);
  const secondsToTarget =
    target === null ? null : Math.max(0, Math.floor((Date.parse(`${target}T23:59:59.999Z`) - Date.parse(now)) / 1000));
  const leaves = { done: progress.counts.done, countable: progress.countable, percent: progress.percent };

  let verdict: PaceVerdict;
  let message: string;
  const doneText = `${leaves.done}/${leaves.countable} leaves done`;
  if (progress.complete) {
    verdict = "done";
    message = `${doneText}.`;
  } else if (target === null) {
    verdict = "no_target";
    message = `${doneText}; no target date.`;
  } else if (isOverdue(target, now)) {
    verdict = "overdue";
    message = `${doneText}; the target ${target} passed ${-daysToTarget!} day(s) ago.`;
  } else if (remainingSeconds === null) {
    verdict = "no_estimate";
    message = `${doneText}; nothing open is estimated, ${daysToTarget} day(s) to ${target}.`;
  } else if (remainingSeconds > secondsToTarget!) {
    verdict = "behind";
    message = `${doneText}; ${hours(remainingSeconds)}${partial ? "+" : ""} of estimated work remains, more than the time left to the end of ${target}.`;
  } else {
    verdict = "on_track";
    message = `${doneText}; ${hours(remainingSeconds)}${partial ? "+" : ""} of estimated work remains, ${daysToTarget} day(s) to ${target}.`;
  }
  // Every field is a function of the UTC day, not the second, so two reads a moment apart agree.
  return { targetDate: target, daysToTarget, leaves, laborSeconds, remainingSeconds, partial, unplannedRefs, verdict, message };
}
