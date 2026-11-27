/**
 * The page's period and workspace, as the query every Analytics read takes.
 *
 * The page thinks in presets (the last 30 days) and the server in days (`from`, `to`), so this is
 * the one place a preset becomes dates. Days are the reader's own calendar days: `today` is the
 * browser's local date, and the server is told the browser's time zone.
 */
import type { AnalyticsQuery } from "@/lib/analytics-api";

export type PeriodPreset = "7d" | "30d" | "90d" | "ytd" | "all" | "custom";
/** What the page asks for: a preset, or `custom` with both days. */
export interface PeriodAsk {
  preset: PeriodPreset;
  from?: string;
  to?: string;
}

const pad = (value: number) => String(value).padStart(2, "0");
const dayKey = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
/** A calendar day `days` before `day`. */
export function daysBefore(day: string, days: number): string {
  const [year, month, date] = day.split("-").map(Number);
  return dayKey(new Date(year ?? 1970, (month ?? 1) - 1, (date ?? 1) - days));
}
export const todayKey = (now: Date = new Date()): string => dayKey(now);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Two calendar days that make a range: both written as days, the first not after the second. */
export const isRange = (from: string | undefined, to: string | undefined): boolean => from !== undefined && to !== undefined && DAY.test(from) && DAY.test(to) && from <= to;

/**
 * The query for a period and a workspace ("" is every workspace on this computer). "All time"
 * sends no `from`, so the server starts at the first activity.
 */
export function toQuery(period: PeriodAsk, workspace: string, today: string = todayKey()): AnalyticsQuery {
  const scope = workspace || "hub";
  if (period.preset === "custom" && period.from && period.to) return { scope, from: period.from, to: period.to };
  if (period.preset === "7d") return { scope, from: daysBefore(today, 6), to: today };
  if (period.preset === "90d") return { scope, from: daysBefore(today, 89), to: today };
  if (period.preset === "ytd") return { scope, from: `${today.slice(0, 4)}-01-01`, to: today };
  if (period.preset === "all") return { scope, to: today };
  return { scope, from: daysBefore(today, 29), to: today };
}
