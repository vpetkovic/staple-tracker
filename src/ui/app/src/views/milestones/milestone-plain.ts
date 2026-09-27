/**
 * Milestones in plain words, for the desktop page: due dates as a day and a distance
 * ("Due 15 Oct, in 18 days"), progress as a sentence and as bar segments.
 *
 * Everything here reads the served view (`/api/milestones`) and the queue's verdict
 * (`milestoneRisk`); nothing is re-derived. The raw figures stay on the page under
 * "Show details".
 */
import type { MilestoneNext, MilestoneProgress, MilestoneState } from "@/lib/types";
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
 * How far the milestone has got, in one plain word, from its PROGRESS — not from its dates.
 * The date is a separate fact ("Was due 20 Sept, 7 days ago"), so an overdue milestone that
 * is half done reads "In progress" and, beside it, late.
 */
export type ProgressState = "not_started" | "in_progress" | "blocked" | "done" | "cancelled";

export const PROGRESS_WORDS: Readonly<Record<ProgressState, string>> = {
  not_started: "Not started",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
  cancelled: "Cancelled",
};

/**
 * The four bar segments over the COUNTABLE leaves: finished, in progress, waiting, not started.
 *
 * "Waiting" is the QUEUE'S verdict (blocked or waiting for approval, `milestoneRisk`) when the
 * queue has answered, so the bar and the sentence beside it count the same tasks — a task that
 * waits on another is still `backlog` by status. Without a queue reading it falls back to the
 * blocked and gated statuses.
 */
export function progressBuckets(progress: MilestoneProgress, risk: MilestoneRisk | null) {
  const { counts, countable } = progress;
  const done = counts.done;
  const active = counts.active + counts.review;
  const remaining = Math.max(0, countable - done - active);
  const waitingRaw = risk ? risk.blocked + risk.gated : counts.blocked + counts.gated;
  const waiting = Math.min(remaining, waitingRaw);
  return { done, active, waiting, notStarted: remaining - waiting };
}

export function progressSegments(progress: MilestoneProgress, risk: MilestoneRisk | null = null): ProgressSegment[] {
  const b = progressBuckets(progress, risk);
  return [
    { key: "done", count: b.done, word: "finished", color: PROGRESS_COLOR.done },
    { key: "active", count: b.active, word: "in progress", color: PROGRESS_COLOR.active },
    { key: "waiting", count: b.waiting, word: "waiting", color: PROGRESS_COLOR.waiting },
    { key: "open", count: b.notStarted, word: "not started", color: PROGRESS_COLOR.notStarted },
  ];
}

export function progressState(state: MilestoneState, progress: MilestoneProgress, risk: MilestoneRisk | null = null): ProgressState {
  if (state === "cancelled") return "cancelled";
  if (progress.complete || state === "done") return "done";
  const b = progressBuckets(progress, risk);
  if (b.active === 0 && b.notStarted === 0 && b.waiting > 0) return "blocked";
  if (b.active > 0 || b.done > 0) return "in_progress";
  return "not_started";
}

/** "3 of 4 tasks finished (75%)." — or the honest sentence when nothing is countable. */
export function progressSentence(progress: MilestoneProgress): string {
  if (progress.countable === 0) return "No tasks to count yet.";
  const noun = progress.countable === 1 ? "task" : "tasks";
  if (progress.complete) return `All ${progress.countable} ${noun} are finished.`;
  return `${progress.counts.done} of ${progress.countable} ${noun} finished (${progress.percent ?? 0}%).`;
}

/** What is in the way, from the queue's verdict: "1 is blocked and 2 wait for approval." */
export function riskSentence(risk: MilestoneRisk): string | null {
  const parts: string[] = [];
  if (risk.blocked > 0) parts.push(`${risk.blocked} ${risk.blocked === 1 ? "is" : "are"} blocked`);
  if (risk.gated > 0) parts.push(`${risk.gated} ${risk.gated === 1 ? "waits" : "wait"} for approval`);
  if (parts.length === 0) return null;
  const text = parts.join(" and ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}

/** What an agent would take next from this milestone. */
export function nextSentence(next: MilestoneNext | null): string {
  return next
    ? `Next up: ${next.identifier}, number ${next.position} in the pickup order.`
    : "Nothing here can be picked up right now.";
}
