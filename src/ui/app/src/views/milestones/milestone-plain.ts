/**
 * Milestones in plain words, for the desktop page: due dates as a day and a distance
 * ("Due 15 Oct, in 18 days"), progress as a sentence and as bar segments.
 *
 * Everything here reads the served view (`/api/milestones`) and the queue's verdict
 * (`milestoneRisk`); nothing is re-derived. The raw figures stay on the page under
 * "Show details".
 */
import type { GoalPace, MilestoneNext, MilestoneProgress, MilestoneState } from "@/lib/types";
import type { ProgressSegment } from "@/views/ProgressStrip";
import { PROGRESS_COLOR } from "@/views/progress-palette";
import type { MilestoneRisk } from "./milestones-model";

const DAY_MS = 86_400_000;

/** A `YYYY-MM-DD` (or ISO) date as a local calendar day, or null when it cannot be read. */
function calendarDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

/** Whole calendar days from `now`'s day to `date`'s day: 0 today, 1 tomorrow, -1 yesterday. */
export function daysFrom(date: string, now: Date): number | null {
  const day = calendarDay(date);
  if (!day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((day.getTime() - today.getTime()) / DAY_MS);
}

/** "15 Oct", with the year only when it is not this year: "3 Jan 2027". */
export function shortDay(date: string, now: Date): string {
  const day = calendarDay(date);
  if (!day) return date;
  const options: Intl.DateTimeFormatOptions =
    day.getFullYear() === now.getFullYear()
      ? { day: "numeric", month: "short" }
      : { day: "numeric", month: "short", year: "numeric" };
  return day.toLocaleDateString("en-GB", options);
}

function dayCount(n: number): string {
  return n === 1 ? "1 day" : `${n} days`;
}

/**
 * The due date in words. A finished or cancelled milestone says when it was due and no
 * more: "7 days late" about work that is done is noise.
 */
export function plainDue(target: string | null, state: MilestoneState, now: Date): string {
  if (!target) return "No due date";
  const days = daysFrom(target, now);
  const day = shortDay(target, now);
  if (days === null) return `Due ${target}`;
  if (state === "done" || state === "cancelled") return `Was due ${day}`;
  if (days < 0) return `Was due ${day}, ${dayCount(-days)} ago`;
  if (days === 0) return "Due today";
  if (days === 1) return "Due tomorrow";
  return `Due ${day}, in ${dayCount(days)}`;
}

/**
 * WHEN THE MILESTONE WOULD LAND, from the work still estimated in it — shown only while no
 * target date is set, and never stored.
 *
 * The remaining work is the goal check's own figure, `goal.pace.remainingSeconds`: the store
 * sums the estimates of the open work under the milestone, and says whether some of it has
 * none (`partial`, `unplannedRefs`). This only turns it into a day. The pace check reads that
 * figure against the target "even worked around the clock" (lib/goal-text.ts), and staple has
 * no calendar of working hours, so the projection is the same reading: now plus the work
 * left. The page labels it an estimate.
 */
export interface ProjectedDue {
  /** The projected moment; the page shows its calendar day. */
  at: Date;
  /** The estimated work left, in seconds. */
  seconds: number;
  /** Open work with no estimate, which the figure leaves out. */
  unplanned: number;
}

export function projectedDue(pace: Pick<GoalPace, "remainingSeconds" | "partial" | "unplannedRefs"> | null | undefined, now: Date): ProjectedDue | null {
  if (!pace || pace.remainingSeconds === null || pace.remainingSeconds <= 0) return null;
  return {
    at: new Date(now.getTime() + pace.remainingSeconds * 1000),
    seconds: pace.remainingSeconds,
    unplanned: pace.partial ? pace.unplannedRefs.length : 0,
  };
}

/** A Date as its local calendar day, `YYYY-MM-DD`. */
export function localIso(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The due date in words, wherever a milestone shows one. A target the person set wins; with
 * none, the projection, marked as one ("Due ~3 Oct (estimated)"); a finished milestone with no
 * target says when it finished; with nothing to go on, "No due date".
 */
export function dueText(
  milestone: { targetDate: string | null; state: MilestoneState },
  projection: ProjectedDue | null,
  now: Date,
  completedAt: string | null = null,
): string {
  if (milestone.targetDate) return plainDue(milestone.targetDate, milestone.state, now);
  if (milestone.state === "done" || milestone.state === "cancelled") {
    const word = milestone.state === "done" ? "Finished" : "Cancelled";
    return completedAt ? `${word} ${shortDay(localIso(new Date(completedAt)), now)}` : word;
  }
  if (projection) return `Due ~${shortDay(localIso(projection.at), now)} (estimated)`;
  return "No due date";
}

/** Why the projection says what it says, for its tooltip. */
export function projectionNote(projection: ProjectedDue): string {
  const hours = Math.round(projection.seconds / 360) / 10;
  const n = projection.unplanned;
  const partial = n > 0 ? ` ${n} open ${n === 1 ? "task has no estimate and is" : "tasks have no estimate and are"} not included.` : "";
  return `Estimated from ${hours}h of work left, counted from now. Set a date to override it.${partial}`;
}

/**
 * The bar's segments over the COUNTABLE leaves, one per status bucket, in the words and the
 * colours the task rows' status glyphs use: finished, in review, in progress, blocked, to do,
 * not started. Every countable leaf is in exactly one, so the legend sums to the headline's
 * denominator; cancelled leaves are in none (see `cancelledSentence`).
 *
 * "Blocked" is the status (blocked or waiting for approval) plus the QUEUE'S verdict on work
 * that has not started: a task that waits on another is still `todo` or `backlog` by status,
 * and `milestoneRisk` says how many of those the resolver holds back. Work already in review
 * or in progress keeps its own bucket even when it still waits on something — it is drawn
 * once, where it is, and the sentence beside the bar names the wait (`riskSentence`).
 * Without a queue reading only the statuses count.
 */
export interface ProgressBuckets {
  done: number;
  review: number;
  active: number;
  blocked: number;
  ready: number;
  notStarted: number;
}

export function progressBuckets(progress: MilestoneProgress, risk: MilestoneRisk | null): ProgressBuckets {
  const { counts } = progress;
  const waitingReady = Math.min(counts.ready, risk?.waitingIn?.ready ?? 0);
  const waitingUnstarted = Math.min(counts.unstarted, risk?.waitingIn?.unstarted ?? 0);
  return {
    done: counts.done,
    review: counts.review,
    active: counts.active,
    blocked: counts.blocked + counts.gated + waitingReady + waitingUnstarted,
    ready: counts.ready - waitingReady,
    notStarted: counts.unstarted - waitingUnstarted,
  };
}

export function progressSegments(progress: MilestoneProgress, risk: MilestoneRisk | null = null): ProgressSegment[] {
  const b = progressBuckets(progress, risk);
  return [
    { key: "done", count: b.done, word: "finished", color: PROGRESS_COLOR.done },
    { key: "review", count: b.review, word: "in review", color: PROGRESS_COLOR.review },
    { key: "active", count: b.active, word: "in progress", color: PROGRESS_COLOR.active },
    { key: "blocked", count: b.blocked, word: "blocked", color: PROGRESS_COLOR.waiting },
    { key: "ready", count: b.ready, word: "to do", color: PROGRESS_COLOR.ready },
    { key: "open", count: b.notStarted, word: "not started", color: PROGRESS_COLOR.notStarted },
  ];
}

/** "3 of 4 tasks finished (75%)." — or the honest sentence when nothing is countable. */
export function progressSentence(progress: MilestoneProgress): string {
  if (progress.countable === 0) return "No tasks to count yet.";
  const noun = progress.countable === 1 ? "task" : "tasks";
  if (progress.complete) return `All ${progress.countable} ${noun} are finished.`;
  return `${progress.counts.done} of ${progress.countable} ${noun} finished (${progress.percent ?? 0}%).`;
}

/**
 * Why the headline's denominator is smaller than the list: cancelled tasks are neither
 * finished nor work left, so they are left out of the count, and this says so.
 */
export function cancelledSentence(progress: MilestoneProgress): string | null {
  const n = progress.counts.cancelled;
  if (n === 0) return null;
  return n === 1 ? "1 cancelled task is not counted." : `${n} cancelled tasks are not counted.`;
}

/**
 * What is in the way, in the bar's own numbers: "2 are blocked." for the blocked bucket, then
 * the work that has started but still waits on another task, by where it is — "7 in review
 * still wait on other tasks." Null when nothing waits.
 */
export function riskSentence(progress: MilestoneProgress, risk: MilestoneRisk | null): string | null {
  const sentences: string[] = [];
  const blocked = progressBuckets(progress, risk).blocked;
  if (blocked > 0) sentences.push(`${blocked} ${blocked === 1 ? "is" : "are"} blocked.`);
  const review = risk?.waitingIn?.review ?? 0;
  const active = risk?.waitingIn?.active ?? 0;
  const started = [active > 0 ? `${active} in progress` : null, review > 0 ? `${review} in review` : null].filter(Boolean);
  if (started.length > 0) {
    const one = review + active === 1;
    sentences.push(`${started.join(" and ")} still ${one ? "waits on another task" : "wait on other tasks"}.`);
  }
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/** The card's sentence under the headline: what waits, what the count leaves out, what is next. */
export function progressDetailSentence(
  view: { progress: MilestoneProgress; next: MilestoneNext | null },
  risk: MilestoneRisk | null,
): string {
  return [riskSentence(view.progress, risk), cancelledSentence(view.progress), nextSentence(view.next)]
    .filter(Boolean)
    .join(" ");
}

/** What an agent would take next from this milestone. */
export function nextSentence(next: MilestoneNext | null): string {
  return next
    ? `Next up: ${next.identifier}, number ${next.position} in the pickup order.`
    : "Nothing here can be picked up right now.";
}
