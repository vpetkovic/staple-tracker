/**
 * Calendar arithmetic in one named time zone, for the analytics read.
 *
 * Every figure the Analytics page draws per day, per weekday or per hour is a statement about
 * the reader's calendar, not UTC's: a ticket closed at 23:30 in New York belongs to that day,
 * not to the next. So the read takes an IANA zone, and every instant is placed with it here.
 *
 * Only `Intl` is used. A zone's offset is read at the instant in question, so a period that
 * crosses a daylight-saving change still cuts each day at its own local midnight (a 23- or
 * 25-hour day), which is what a person counting "days" means.
 */
import { StapleError } from "../types.js";

/** A calendar day, `YYYY-MM-DD`. */
export type DateKey = string;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The parts of one instant on the zone's wall clock. */
export interface ZonedParts {
  readonly date: DateKey;
  /** 0 = Monday … 6 = Sunday (ISO order, as the heatmap draws it). */
  readonly weekday: number;
  readonly hour: number;
}

const WEEKDAYS: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** A validated zone and the formatter that places instants in it. */
export class Zone {
  private readonly format: Intl.DateTimeFormat;
  private readonly memo = new Map<number, ZonedParts>();

  private constructor(readonly name: string) {
    this.format = new Intl.DateTimeFormat("en-US", {
      timeZone: name,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
  }

  /** Refuses anything `Intl` does not know as a zone, by name, rather than silently reading UTC. */
  static of(name: string | undefined | null): Zone {
    const wanted = (name ?? "").trim() || "UTC";
    try {
      return new Zone(new Intl.DateTimeFormat("en-US", { timeZone: wanted }).resolvedOptions().timeZone);
    } catch {
      throw new StapleError("validation", `tz takes an IANA time zone such as America/New_York or UTC; got "${wanted}".`);
    }
  }

  /** Where `instant` falls on this zone's wall clock. Memoized per whole minute. */
  parts(instant: string | number): ZonedParts {
    const at = typeof instant === "number" ? instant : Date.parse(instant);
    const minute = Math.floor(at / 60_000);
    const held = this.memo.get(minute);
    if (held) return held;
    const fields = this.fields(at);
    const out: ZonedParts = {
      date: `${fields.year}-${fields.month}-${fields.day}`,
      weekday: WEEKDAYS[fields.weekday ?? "Mon"] ?? 0,
      hour: Number(fields.hour),
    };
    if (this.memo.size > 50_000) this.memo.clear();
    this.memo.set(minute, out);
    return out;
  }

  /** The calendar day `instant` falls on here. */
  dateOf(instant: string | number): DateKey {
    return this.parts(instant).date;
  }

  /**
   * The UTC instant (epoch ms) at which `date` begins in this zone: its local midnight.
   *
   * Found by reading the zone's offset near the guess and correcting once more, which settles
   * on the right side of a transition; a midnight that does not exist (a zone that skips it)
   * resolves to the first instant of that day.
   */
  startOf(date: DateKey): number {
    const match = DATE_KEY.exec(date);
    if (!match) throw new StapleError("validation", `Expected a calendar day YYYY-MM-DD; got "${date}".`);
    const utcMidnight = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    let guess = utcMidnight - this.offsetAt(utcMidnight);
    guess = utcMidnight - this.offsetAt(guess);
    // A skipped midnight: step forward to the first instant whose local date is `date`.
    while (this.dateOf(guess) < date) guess += 15 * 60_000;
    while (this.dateOf(guess - 1) === date) guess -= 15 * 60_000;
    return guess;
  }

  /** The zone's offset from UTC at `at`, in ms (positive east of Greenwich). */
  private offsetAt(at: number): number {
    const f = this.fields(at);
    const wall = Date.UTC(Number(f.year), Number(f.month) - 1, Number(f.day), Number(f.hour), Number(f.minute), Number(f.second));
    return wall - Math.floor(at / 1000) * 1000;
  }

  private fields(at: number): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of this.format.formatToParts(new Date(at))) out[part.type] = part.value;
    return out;
  }
}

/** The day after `date`, as a calendar (not 24-hour) step. */
export function nextDate(date: DateKey): DateKey {
  const match = DATE_KEY.exec(date);
  if (!match) throw new StapleError("validation", `Expected a calendar day YYYY-MM-DD; got "${date}".`);
  const next = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1));
  return next.toISOString().slice(0, 10);
}

/** Whole calendar days from `from` to `to`, both included. */
export function daysBetween(from: DateKey, to: DateKey): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

/** Every day from `from` to `to`, both included. */
export function eachDate(from: DateKey, to: DateKey): DateKey[] {
  const out: DateKey[] = [];
  for (let day = from; day <= to; day = nextDate(day)) out.push(day);
  return out;
}

/** True for a well-formed calendar day that exists (`2026-02-30` does not). */
export function isDateKey(value: string): boolean {
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))).toISOString().slice(0, 10) === value;
}
