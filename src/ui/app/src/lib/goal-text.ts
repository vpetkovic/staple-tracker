/**
 * A milestone's goal in plain words: each criterion's verdict and why an unknown one is
 * unknown, who marked it and when, the pace against the target date, and the gate that
 * keeps the milestone from closing unreviewed.
 *
 * Everything comes off the served goal check (`milestonePlan.goal` on `/api/issue`, the
 * object `staple milestone show --json` prints under `goal`; core/milestone-goal.ts). This
 * module PHRASES what the check answered and decides nothing: the tracker weighs every mark
 * at every read, and a criterion reads met here only when the check said met.
 *
 * Pure and tested (goal-text.test.ts); the real payloads are pinned end to end in
 * detail/milestone-goal-e2e.test.tsx.
 */
import { shortDay } from "@/views/milestones/milestone-plain";
import { formatEffort } from "./forecast-text";
import { clockText, type RunTone } from "./run-text";
import type { CriterionVerdict, EvidenceItem, GoalCounts, GoalCriterion, GoalPace, IssueGate, PaceVerdict } from "./types";

/** The verdict in a word, never colour alone. */
export const CRITERION_WORDS: Readonly<Record<CriterionVerdict, string>> = {
  met: "Met",
  unmet: "Not met",
  unknown: "Unknown",
};

export const CRITERION_TONE: Readonly<Record<CriterionVerdict, RunTone>> = {
  met: "ok",
  unmet: "risk",
  unknown: "unknown",
};

/**
 * Why a criterion reads unknown: nobody marked it; it was reworded after it was marked (the
 * mark judged other words); it was marked met but its evidence does not hold now (a cited
 * ticket not done, a cited document gone); or an agent marked it unknown.
 */
export type UnknownCause = "unmarked" | "reworded" | "evidence" | "judged";

/** The prefix core's `why` starts with for a reworded criterion (`judgeCriterion`). */
const REWORDED = "the criterion was reworded";

export function unknownCause(criterion: Pick<GoalCriterion, "verdict" | "marked" | "why" | "evidence">): UnknownCause | null {
  if (criterion.verdict !== "unknown") return null;
  if (criterion.marked === null) return "unmarked";
  // Reworded is checked first, as core checks it first: a reworded mark is unknown whatever
  // its evidence says.
  if (criterion.why?.startsWith(REWORDED)) return "reworded";
  if (criterion.marked === "met" && criterion.evidence.some((item) => !item.holds)) return "evidence";
  return "judged";
}

/** Why one piece of evidence does not hold, in words; null when it holds. */
export function evidenceProblemText(item: EvidenceItem, statusWord: (status: string) => string = (status) => status): string | null {
  if (item.holds) return null;
  if (item.status === null) return `${item.ref ?? item.value} is not in this workspace`;
  if (item.kind === "document") return `${item.ref} has no "${item.document}" document`;
  return `${item.ref} is ${statusWord(item.status).toLowerCase()}, not done`;
}

/** Why an unknown criterion is unknown, as a sentence; null when the verdict stands. */
export function unknownText(criterion: GoalCriterion, statusWord?: (status: string) => string): string | null {
  switch (unknownCause(criterion)) {
    case null:
      return null;
    case "unmarked":
      return "Nobody has judged this yet.";
    case "reworded": {
      const was = /\(it read "([\s\S]*)"\)$/.exec(criterion.why ?? "")?.[1];
      const marked = CRITERION_WORDS[criterion.marked!].toLowerCase();
      return `Reworded after it was marked ${marked}, so it needs judging again.${was ? ` It read: "${was}".` : ""}`;
    }
    case "evidence": {
      const problems = criterion.evidence.map((item) => evidenceProblemText(item, statusWord)).filter((text): text is string => text !== null);
      return `Marked met, but its evidence does not hold now: ${problems.join("; ")}.`;
    }
    case "judged":
      return "Judged unknown: the evidence so far does not settle it.";
  }
}

/** "Marked met by opus, 11:02" — who judged it and when; null when nobody has. */
export function markedByText(criterion: Pick<GoalCriterion, "marked" | "markedBy" | "markedAt" | "runId">, now: Date = new Date()): string | null {
  if (criterion.marked === null) return null;
  const who = criterion.markedBy ?? "someone";
  const run = criterion.runId ? " on an autopilot run" : "";
  const when = criterion.markedAt ? `, ${clockText(criterion.markedAt, now)}` : "";
  return `Marked ${CRITERION_WORDS[criterion.marked].toLowerCase()} by ${who}${run}${when}`;
}

/** "2 of 3 criteria met, 1 unknown." — or the two sentences a goal can end on. */
export function goalSummary(counts: GoalCounts): string {
  if (counts.total === 0) return "No criteria yet: its goal is that every member lands.";
  if (counts.met === counts.total) return counts.total === 1 ? "Its one criterion is met." : `All ${counts.total} criteria are met.`;
  const rest = [counts.unmet > 0 ? `${counts.unmet} not met` : null, counts.unknown > 0 ? `${counts.unknown} unknown` : null].filter(Boolean);
  return `${counts.met} of ${counts.total} criteria met${rest.length > 0 ? `, ${rest.join(", ")}` : ""}.`;
}

// ---------- pace ----------

export const PACE_WORDS: Readonly<Record<PaceVerdict, string>> = {
  done: "Done",
  no_target: "No target date",
  overdue: "Overdue",
  no_estimate: "No estimate",
  behind: "Behind",
  on_track: "On track",
};

export const PACE_TONE: Readonly<Record<PaceVerdict, RunTone>> = {
  done: "ok",
  on_track: "ok",
  no_target: "unknown",
  no_estimate: "unknown",
  behind: "risk",
  overdue: "risk",
};

const days = (n: number): string => (n === 1 ? "1 day" : `${n} days`);

/**
 * The pace against the target, in plain words, with the numbers: the verdict's reason
 * first, then how much is done. Every figure is the check's own (`goal.pace`).
 */
export function paceText(pace: GoalPace, now: Date = new Date()): string {
  const { leaves } = pace;
  const done = leaves.countable === 0 ? "Nothing to count yet" : `${leaves.done} of ${leaves.countable} ${leaves.countable === 1 ? "task" : "tasks"} done`;
  const left =
    pace.remainingSeconds === null
      ? null
      : `${pace.partial ? "at least " : ""}${formatEffort(pace.remainingSeconds)} of estimated work left`;
  const day = pace.targetDate ? shortDay(pace.targetDate, now) : null;
  const toTarget =
    pace.daysToTarget === null || day === null ? null : pace.daysToTarget === 0 ? `due today (${day})` : `${days(pace.daysToTarget)} to ${day}`;
  const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  switch (pace.verdict) {
    case "done":
      return `All of its work is done (${done.toLowerCase()}).`;
    case "no_target":
      return `${done}${left ? `; ${left}` : ""}. It has no target date to measure against.`;
    case "overdue":
      return `Its target, ${day}, passed ${days(-(pace.daysToTarget ?? 0))} ago. ${done}${left ? `; ${left}` : ""}.`;
    case "no_estimate":
      return `${capital(toTarget ?? "no target")}, but nothing open has an estimate, so there is no telling whether it fits. ${done}.`;
    case "behind":
      return `${capital(left ?? "")}: more than the time left to the end of ${day}, even worked around the clock. ${done}.`;
    case "on_track":
      return `${capital(left ?? "")}, ${toTarget}: it fits. ${done}.`;
  }
}

/** The open members with no estimate, when the figures are lower bounds; null otherwise. */
export function unplannedText(pace: Pick<GoalPace, "partial" | "unplannedRefs">): string | null {
  if (!pace.partial || pace.unplannedRefs.length === 0) return null;
  const refs = pace.unplannedRefs;
  const shown = refs.slice(0, 5).join(", ");
  return `Not estimated yet: ${shown}${refs.length > 5 ? ` and ${refs.length - 5} more` : ""}.`;
}

// ---------- the gate ----------

/** `gate_requested_by` of a gate a goal run opened: `goal-run:<actor>` (core/milestones.ts). */
const GOAL_RUN_PREFIX = "goal-run:";

/** The goal run's actor when a goal run asked for this gate, else null. */
export function goalRunRequester(requestedBy: string | null): string | null {
  return requestedBy?.startsWith(GOAL_RUN_PREFIX) ? requestedBy.slice(GOAL_RUN_PREFIX.length) : null;
}

/**
 * The milestone's gate, in words: whose approval it waits for and who asked for it, a goal
 * run or a person. A goal run's gate holds only the close, and the sentence says so.
 */
export function gateText(gate: Pick<IssueGate, "state" | "owner" | "requestedBy" | "requestedAt" | "resolvedBy">, now: Date = new Date()): { text: string; detail: string | null } {
  const run = goalRunRequester(gate.requestedBy);
  const by = run ? `${run}'s goal run` : (gate.requestedBy ?? "someone");
  const asked = `Asked for by ${by}, ${clockText(gate.requestedAt, now)}.`;
  if (gate.state === "approved") return { text: `Approved by ${gate.resolvedBy ?? gate.owner}.`, detail: asked };
  if (gate.state === "changes_requested") return { text: `${gate.owner} asked for changes.`, detail: asked };
  return {
    text: `Waiting for ${gate.owner}'s approval.`,
    detail: run ? `${asked} It keeps the milestone from closing until ${gate.owner} approves; it holds none of the work.` : asked,
  };
}
