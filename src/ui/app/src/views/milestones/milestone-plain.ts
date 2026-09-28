/**
 * Milestones in plain words, for the desktop page: due dates as a day and a distance
 * ("Due 15 Oct, in 18 days"), progress as a sentence and as bar segments.
 *
 * Everything here reads the served view (`/api/milestones`) and the queue's verdict
 * (`milestoneRisk`); nothing is re-derived. The raw figures stay on the page under
 * "Show details".
 */
import type { MilestoneNext, MilestoneProgress, MilestoneRemaining, MilestoneState } from "@/lib/types";
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

/**
 * Whole calendar days from `now`'s day to `date`'s day: 0 today, 1 tomorrow, -1 yesterday.
 *
 * On the reader's LOCAL calendar. A target is a calendar date a person picked; "tomorrow" in
 * New York at 21:30 is tomorrow there, whatever day it already is in UTC. The store's own
 * `overdue` is judged on the UTC day and stays out of what the page says: the page judges
 * overdue here too (`shownState`), so the words, the red and the pace agree.
 */
export function daysFrom(date: string, now: Date): number | null {
  const day = calendarDay(date);
  if (!day) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((day.getTime() - today.getTime()) / DAY_MS);
}

/**
 * The milestone's state as the page shows it: overdue by the reader's local calendar day, not
 * by the store's UTC one. A milestone the store already calls overdue that is still due today
 * here reads as active; one the store does not yet call overdue whose day has passed here
 * reads as overdue. Every other state is the store's.
 */
export function shownState(milestone: { state: MilestoneState; targetDate: string | null }, now: Date): MilestoneState {
  const { state, targetDate } = milestone;
  if (state === "done" || state === "cancelled") return state;
  const days = targetDate ? daysFrom(targetDate, now) : null;
  if (days !== null && days < 0) return "overdue";
  return state === "overdue" ? "active" : state;
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
 * The work left is the view's `remaining.forecastSeconds`: the SUM, over the milestone's open
 * tasks (not done, not cancelled), of each one's remaining work exactly as `staple forecast`
 * adds its units into the labor — the estimate scaled by its class's calibrated ratio (the
 * Estimates view's "a forecast scales an estimate by"), the expected remainder once work has
 * started, and nothing for work waiting in review. It is a sum, not the critical path
 * (`goal.pace.remainingSeconds`): work left whatever order it is done in. staple has no
 * calendar of working hours and no date forecast, so the day is now plus that much work, and
 * the page labels it an estimate. Open tasks the forecast cannot weigh add nothing, so then the
 * day is a lower bound and the label says "no earlier than".
 */
export interface ProjectedDue {
  /** The projected moment; the page shows its calendar day. */
  at: Date;
  /** The work left as `staple forecast` weighs it, in seconds, and the open tasks' own estimates. */
  seconds: number;
  estimateSeconds: number | null;
  /** Open tasks the forecast cannot weigh (no estimate, nothing to compare with): the day is a lower bound. */
  unknown: number;
}

export function projectedDue(remaining: MilestoneRemaining | null | undefined, now: Date): ProjectedDue | null {
  if (!remaining || remaining.forecastSeconds === null) return null;
  return {
    at: new Date(now.getTime() + remaining.forecastSeconds * 1000),
    seconds: remaining.forecastSeconds,
    estimateSeconds: remaining.estimateSeconds,
    unknown: remaining.unknown,
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
  milestone: { targetDate: string | null; state: MilestoneState; closedAt?: string | null },
  projection: ProjectedDue | null,
  now: Date,
): string {
  if (milestone.targetDate) return plainDue(milestone.targetDate, milestone.state, now);
  if (milestone.state === "done" || milestone.state === "cancelled") {
    // "Closed", not "Cancelled": the status pill beside it already says cancelled.
    const word = milestone.state === "done" ? "Finished" : "Closed";
    return milestone.closedAt ? `${word} ${shortDay(localIso(new Date(milestone.closedAt)), now)}` : word;
  }
  if (projection) {
    const day = shortDay(localIso(projection.at), now);
    return projection.unknown > 0 ? `Due no earlier than ~${day} (estimated)` : `Due ~${day} (estimated)`;
  }
  return "No due date";
}

/** Why the projection says what it says, for its tooltip. */
export function projectionNote(projection: ProjectedDue): string {
  const hours = (seconds: number) => `${Math.round(seconds / 360) / 10}h`;
  const n = projection.unknown;
  const partial = n > 0 ? ` ${n} open ${n === 1 ? "task" : "tasks"} cannot be weighed (no estimate, or nothing like it finished yet) and ${n === 1 ? "is" : "are"} not included, so it can only be later.` : "";
  const estimated = projection.estimateSeconds === null ? "" : ` (${hours(projection.estimateSeconds)} estimated, scaled by how long estimates have really taken; work in review counts as done)`;
  return `${hours(projection.seconds)} of work left${estimated}, counted from now, as staple forecast reads it. Set a date to override it.${partial}`;
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
 * The waits, filed so they add up to the bar. `blocked` is the bar's blocked bucket and splits
 * exactly into `onTasks` (not started, held for an unfinished blocker) and `onPerson` (the
 * rest: parked by hand, waiting for approval, or queued behind an approval gate). Started work
 * that still waits is in its own bucket on the bar, and is counted apart: still held for a
 * blocker, or queued behind an approval gate.
 */
export interface WaitBreakdown {
  blocked: number;
  onTasks: number;
  onPerson: number;
  startedOnTasks: { active: number; review: number };
  startedOnGate: { active: number; review: number };
}

export function waitBreakdown(progress: MilestoneProgress, risk: MilestoneRisk | null): WaitBreakdown {
  const blocked = progressBuckets(progress, risk).blocked;
  const onTasks = Math.min(blocked, risk?.waiting?.onTasksNotStarted ?? 0);
  const started = (from: Partial<Record<"active" | "review", number>> | undefined) => ({ active: from?.active ?? 0, review: from?.review ?? 0 });
  return {
    blocked,
    onTasks,
    onPerson: blocked - onTasks,
    startedOnTasks: started(risk?.waiting?.startedOnTasks),
    startedOnGate: started(risk?.waiting?.startedOnGate),
  };
}

/** "2 in progress and 7 in review", or null when both are 0. */
function whereStarted(counts: { active: number; review: number }): string | null {
  const parts = [counts.active > 0 ? `${counts.active} in progress` : null, counts.review > 0 ? `${counts.review} in review` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" and ") : null;
}

/**
 * What is in the way, in the bar's own numbers (`waitBreakdown`). The blocked bucket first,
 * with what it waits on — "3 are blocked: 2 wait on other tasks, 1 on a person." — then the
 * work that has started but still waits, by where it is: "7 in review still wait on other
 * tasks." / "5 in review wait for an approval." Null when nothing waits.
 */
export function riskSentence(progress: MilestoneProgress, risk: MilestoneRisk | null): string | null {
  const sentences: string[] = [];
  const w = waitBreakdown(progress, risk);
  if (w.blocked > 0) {
    const verb = w.blocked === 1 ? "is" : "are";
    if (risk && !risk.waiting) {
      // A reading that does not say what each row waits on: the number alone, no guess.
      sentences.push(`${w.blocked} ${verb} blocked.`);
    } else if (w.onTasks > 0 && w.onPerson > 0) {
      sentences.push(`${w.blocked} ${verb} blocked: ${w.onTasks} ${w.onTasks === 1 ? "waits" : "wait"} on other tasks, ${w.onPerson} on a person.`);
    } else if (w.onTasks > 0) {
      sentences.push(`${w.blocked} ${verb} blocked, waiting on other tasks.`);
    } else {
      sentences.push(`${w.blocked} ${verb} blocked, waiting on a person.`);
    }
  }
  const onTasks = whereStarted(w.startedOnTasks);
  if (onTasks) {
    const one = w.startedOnTasks.active + w.startedOnTasks.review === 1;
    sentences.push(`${onTasks} still ${one ? "waits on another task" : "wait on other tasks"}.`);
  }
  const onGate = whereStarted(w.startedOnGate);
  if (onGate) {
    const one = w.startedOnGate.active + w.startedOnGate.review === 1;
    sentences.push(`${onGate} ${one ? "waits" : "wait"} for an approval.`);
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
