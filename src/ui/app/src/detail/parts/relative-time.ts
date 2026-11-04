/**
 * Dates as a person says them: "Just now", "12 min ago", "Yesterday", "Sep 12".
 *
 * The detail used to print `2026-09-27 11:18` in mono everywhere. That is exact and it
 * is the last thing a reader wants to parse first. The relative form is the reading; the
 * exact time is still one hover away (the `title` RelativeTime puts on its `<time>`), and
 * the machine value is on the element as `dateTime`.
 *
 * Pure: the clock and the zone are parameters, so a test owns both.
 */

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export interface RelativeTimeOptions {
  /** The instant "now" is measured from. Defaults to the real clock. */
  now?: Date;
  /** An IANA zone for the calendar words (Yesterday, weekday, date). Defaults to the viewer's. */
  timeZone?: string;
  /**
   * The reading sits mid-sentence ("started just now", "asked yesterday"): the relative
   * words lose their capital. Weekday and month names keep theirs.
   */
  inSentence?: boolean;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The calendar day of `at` in `timeZone`, as a sortable `YYYY-MM-DD`. */
function dayKey(at: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Whole calendar days between two instants in one zone: 1 means "yesterday". */
function calendarDaysBetween(earlier: Date, later: Date, timeZone: string | undefined): number {
  const a = Date.parse(`${dayKey(earlier, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${dayKey(later, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / (DAY * 1000));
}

function year(at: Date, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric" }).format(at);
}

/**
 * `Just now` · `5 min ago` · `3 hr ago` · `Yesterday` · `Tuesday` · `Sep 12` · `Sep 12, 2025`,
 * and the same shape forwards (`in 5 min`, `Tomorrow`) for a date in the future.
 * Null for a missing or unreadable value, so a caller can decide what "nothing" looks like.
 */
export function formatRelative(iso: string | null | undefined, options: RelativeTimeOptions = {}): string | null {
  const text = formatRelativeWords(iso, options);
  if (text && options.inSentence && ["Just now", "Yesterday", "Tomorrow"].includes(text)) return text.toLowerCase();
  return text;
}

function formatRelativeWords(iso: string | null | undefined, options: RelativeTimeOptions): string | null {
  const at = parse(iso);
  if (!at) return null;
  const now = options.now ?? new Date();
  const { timeZone } = options;
  const seconds = (now.getTime() - at.getTime()) / 1000;
  const future = seconds < 0;
  const age = Math.abs(seconds);

  // A date a few minutes in the future is clock skew between machines, not a plan: "just now".
  if (age < 45 || (future && age < 5 * MINUTE)) return "Just now";
  if (age < HOUR) {
    const minutes = Math.max(1, Math.floor(age / MINUTE));
    return future ? `in ${minutes} min` : `${minutes} min ago`;
  }

  const days = future ? calendarDaysBetween(now, at, timeZone) : calendarDaysBetween(at, now, timeZone);
  if (days === 0) {
    const hours = Math.floor(age / HOUR);
    return future ? `in ${hours} hr` : `${hours} hr ago`;
  }
  if (days === 1) return future ? "Tomorrow" : "Yesterday";
  if (days < 7 && !future) return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "long" }).format(at);

  const monthDay = new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at);
  return year(at, timeZone) === year(now, timeZone) ? monthDay : `${monthDay}, ${year(at, timeZone)}`;
}

/** The exact time, with its zone, for the tooltip: `Sun, Sep 27, 2026, 11:18 AM EDT`. Null when unreadable. */
export function formatExact(iso: string | null | undefined, options: Pick<RelativeTimeOptions, "timeZone"> = {}): string | null {
  const at = parse(iso);
  if (!at) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

/**
 * A raw timestamp for "More details": the same local time and zone the tooltips show,
 * without the weekday, so a column of them reads evenly: `Sep 2, 2026, 12:14 AM EDT`.
 */
export function formatStamp(iso: string | null | undefined, options: Pick<RelativeTimeOptions, "timeZone"> = {}): string | null {
  const at = parse(iso);
  if (!at) return null;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: options.timeZone,
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(at);
}

/**
 * A duration in words, for "silent for 8 min" and "started 2 hr ago" style sentences:
 * `less than a minute` · `8 min` · `3 hr` · `2 days`.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 60) return "less than a minute";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)} min`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)} hr`;
  const days = Math.floor(seconds / DAY);
  return days === 1 ? "1 day" : `${days} days`;
}
