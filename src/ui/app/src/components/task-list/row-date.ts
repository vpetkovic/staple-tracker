/**
 * The right-most column: how old is this — V5 (STA-97) §10.2.
 *
 * Under a day it borrows `formatAgo` from lib/claim.ts rather than growing a second
 * duration formatter. The stale badge two elements to the left already renders durations
 * in that vocabulary, and a row that said "45 minutes ago" beside a badge that said
 * "silent 45m" would look like two systems describing two different things.
 *
 * Past a day it switches to a calendar date, because "3d" and "9d" stop being useful the
 * moment you are trying to remember which week something happened in.
 *
 * The year is dropped only within the CURRENT calendar year, never on a rolling 12-month
 * window. A bare "Oct 9" in September 2026 that actually meant October 2025 reads as six
 * weeks old when it is fourteen months old, and that is exactly the kind of quiet
 * misinformation the whole ticket is against.
 */
import { formatAgo } from "@/lib/claim";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const DAY_SECONDS = 24 * 60 * 60;

/** `12m` · `3h` · `Jun 9` · `Oct 9, 2025`. `now` is injected so the test owns the clock. */
export function formatRowDate(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";

  const ageSeconds = (now.getTime() - then.getTime()) / 1000;
  if (ageSeconds < DAY_SECONDS) return formatAgo(ageSeconds);

  const month = MONTHS[then.getUTCMonth()] ?? "";
  const day = then.getUTCDate();
  const year = then.getUTCFullYear();
  return year === now.getUTCFullYear() ? `${month} ${day}` : `${month} ${day}, ${year}`;
}
