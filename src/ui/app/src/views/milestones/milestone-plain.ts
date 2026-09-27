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

/** The state as one plain word for the pill. */
export const STATE_WORDS: Readonly<Record<MilestoneState, string>> = {
  planned: "Not started",
  active: "In progress",
  overdue: "Overdue",
  done: "Done",
  cancelled: "Cancelled",
};

/** Segments over the COUNTABLE leaves, in bar order. */
export function progressSegments(progress: MilestoneProgress): ProgressSegment[] {
  const { counts } = progress;
  return [
    { key: "done", count: counts.done, word: "finished", color: "var(--status-task-done)" },
    {
      key: "active",
      count: counts.active + counts.review,
      word: "in progress",
      color: "var(--status-task-in_progress)",
    },
    {
      key: "waiting",
      count: counts.blocked + counts.gated,
      word: "waiting",
      color: "var(--status-task-todo)",
    },
    {
      key: "open",
      count: counts.ready + counts.unstarted,
      word: "not started",
      color: "color-mix(in oklab, var(--foreground) 22%, transparent)",
    },
  ];
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
