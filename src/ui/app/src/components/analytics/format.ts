/**
 * How the analytics widgets say a number. One place, so a figure reads the same on a tile, an
 * axis, a tooltip and a table. Pure functions: no locale state, no dates from the clock.
 */

/** 1,284 · 12.9K · 4.2M: whole under 10,000, compact above. */
export function formatCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${trim(value / 1_000_000, 1)}M`;
  if (abs >= 10_000) return `${trim(value / 1_000, 1)}K`;
  return Math.round(value).toLocaleString("en-US");
}

/** One decimal under 10, none above: 1.1, 9.5, 12, 633. */
export function formatNumber(value: number, digits?: number): string {
  const places = digits ?? (Math.abs(value) < 10 ? 1 : 0);
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: places });
}

/** Hours as a person says them: "22 min", "1.1 h", "633 h", "2.5 days" past three days. */
export function formatHours(hours: number): string {
  if (hours < 1 / 60) return "under a minute";
  // 59.5 minutes and up rounds to the hour, so it is said as one: "1 h", never "60 min".
  const minutes = Math.round(hours * 60);
  if (minutes < 60) return `${minutes} min`;
  if (hours < 72) return `${formatNumber(hours)} h`;
  return `${formatNumber(hours / 24)} days`;
}

/** Agent-hours and effort totals never switch to days: "633 h", "1,619 h". */
export function formatEffortHours(hours: number): string {
  return `${hours < 10 ? formatNumber(hours, 1) : Math.round(hours).toLocaleString("en-US")} h`;
}

/** $950 · $26.6K · $1.2M. Whole dollars under 10,000. */
export function formatMoney(value: number, currency = "$"): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}${currency}${trim(abs / 1_000_000, 2)}M`;
  if (abs >= 10_000) return `${sign}${currency}${trim(abs / 1_000, 1)}K`;
  return `${sign}${currency}${Math.round(abs).toLocaleString("en-US")}`;
}

/** 0.73× · 2.4× · 12×. */
export function formatMultiple(value: number): string {
  return `${value < 10 ? trim(value, value < 1 ? 2 : 1) : Math.round(value)}×`;
}

export function formatPercent(ratio: number, digits = 0): string {
  return `${trim(ratio * 100, digits)}%`;
}

function trim(value: number, digits: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Nov 4" from a calendar day (YYYY-MM-DD). The day is already local to the report's time zone. */
export function formatDay(day: string): string {
  const [, month, date] = day.split("-").map(Number);
  return `${MONTHS[(month ?? 1) - 1]} ${date}`;
}

/** "Oct 28 – Nov 26" (the year only when the two ends differ in it). */
export function formatDayRange(from: string, to: string): string {
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return sameYear ? `${formatDay(from)} – ${formatDay(to)}` : `${formatDay(from)}, ${from.slice(0, 4)} – ${formatDay(to)}, ${to.slice(0, 4)}`;
}

/**
 * The change against the period before, as a signed share: +32%, −8%. Null when there is no earlier
 * figure to compare. An earlier figure of zero has no percentage: the answer is 0 when this one is
 * zero too, and otherwise infinite (`DeltaMark` says "from 0").
 */
export function changeRatio(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null) return null;
  if (previous === 0) return value === 0 ? 0 : value > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  return (value - previous) / previous;
}

/**
 * Round axis ticks: 0 and three or four clean steps up to at least `max`. With `whole` the steps
 * are never smaller than 1, for an axis that counts things (a count of 2 reads 0, 1, 2).
 */
export function niceTicks(max: number, target = 4, whole = false): number[] {
  if (!(max > 0)) return [0, 1];
  const rough = max / target;
  const power = 10 ** Math.floor(Math.log10(rough));
  const clean = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= rough) ?? 10 * power;
  const step = whole ? Math.max(1, Math.ceil(clean)) : clean;
  const ticks: number[] = [];
  for (let value = 0; value < max + step * 0.999; value += step) ticks.push(Number(value.toFixed(6)));
  return ticks;
}
