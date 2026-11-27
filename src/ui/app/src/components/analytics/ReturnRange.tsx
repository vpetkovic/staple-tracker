/**
 * The return on spend as a range, because the value of the work is counted two ways: a low end
 * (measured agent time, conservative) and a high end (planned effort).
 *
 * The scale starts at 0. Everything left of break-even (1×) is tinted as the zone where the work
 * cost more than it returned, and break-even is a labelled tick, so "did it pay for itself" is
 * read from where the band sits. Each end carries its figure above its dot. `compact` draws the
 * bar alone, for a stat tile.
 *
 * Data contract: `low` and `high` as `{ value, label }` multiples (either may be null; one end
 * then draws alone; both null draw nothing) and the `breakEven` multiple (1 by default). Two ends
 * closer than 14% of the scale are printed once, as a range over their midpoint. It computes nothing.
 */
import { cn } from "@/lib/utils";
import { formatMultiple } from "./format";

export interface ReturnEnd {
  value: number;
  label: string;
}

export function ReturnRange({ low, high, breakEven = 1, className, compact = false }: { low: ReturnEnd | null; high: ReturnEnd | null; breakEven?: number; className?: string; compact?: boolean }) {
  const ends = [low, high].filter((end): end is ReturnEnd => end !== null).sort((a, b) => a.value - b.value);
  if (ends.length === 0) return null;
  const first = ends[0] as ReturnEnd;
  const last = ends[ends.length - 1] as ReturnEnd;
  const max = Math.max(last.value, breakEven) * 1.15;
  const at = (value: number) => `${Math.min(Math.max((value / max) * 100, 0), 100)}%`;
  const description = `${ends.map((end) => `${formatMultiple(end.value)} ${end.label}`).join(", ")}. Break-even is ${formatMultiple(breakEven)}.`;
  // Two figures too close to print side by side are printed once, as a range, over the midpoint.
  const close = ends.length === 2 && (last.value - first.value) / max < 0.14;
  const track = (
    <>
      <div className="absolute inset-x-0 h-3 rounded-full border border-[var(--viz-track-edge)] bg-[var(--viz-track)]" />
      <div className="absolute left-0 h-3 rounded-l-full border border-r-0 border-[var(--plain-risk-border)] bg-[var(--plain-risk-bg)]" style={{ width: at(breakEven) }} data-zone="below-break-even" />
      {ends.length === 2 ? <div data-mark className="absolute h-3 rounded-full bg-[var(--viz-likely)]" style={{ left: at(first.value), width: `calc(${at(last.value)} - ${at(first.value)})`, minWidth: 6 }} /> : null}
      {ends.map((end) => (
        <div key={end.label} data-mark className="absolute size-3 -translate-x-1/2 rounded-full bg-[var(--viz-marker)] ring-2 ring-[var(--card)]" style={{ left: at(end.value) }} />
      ))}
      <div className="absolute -top-1 h-5 w-0 -translate-x-1/2 border-l-2 border-[var(--viz-marker)] shadow-[0_0_0_1.5px_var(--card)]" style={{ left: at(breakEven) }} />
    </>
  );
  if (compact) {
    return (
      <div className={cn("min-w-0", className)} data-chart="return-range">
        <div role="img" aria-label={description} className="relative h-5 pt-1">
          <div className="relative h-3">{track}</div>
        </div>
      </div>
    );
  }
  return (
    <div className={cn("min-w-0", className)} data-chart="return-range">
      <div role="img" aria-label={description}>
        <div aria-hidden className="relative h-5 text-label font-semibold tabular-nums">
          {close ? (
            <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at((first.value + last.value) / 2) }}>
              {formatMultiple(first.value)} to {formatMultiple(last.value)}
            </span>
          ) : (
            ends.map((end) => (
              <span key={end.label} className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: at(end.value) }}>
                {formatMultiple(end.value)}
              </span>
            ))
          )}
        </div>
        <div className="relative mt-1 h-3">{track}</div>
        <div aria-hidden className="relative mt-1.5 h-4 text-caption text-text-tertiary">
          {breakEven / max > 0.2 ? <span className="absolute left-0">0×</span> : null}
          {/* Near the left edge the label starts at the tick instead of centring on it, so it never leaves the bar. */}
          <span className={cn("absolute font-medium whitespace-nowrap text-foreground", breakEven / max > 0.2 ? "-translate-x-1/2" : "-translate-x-1")} style={{ left: at(breakEven) }}>
            {formatMultiple(breakEven)} break-even
          </span>
        </div>
      </div>
      <ul aria-hidden className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 shrink-0 rounded-full border border-[var(--plain-risk-border)] bg-[var(--plain-risk-bg)]" />
          Cost more than it returned
        </li>
        {ends.map((end) => (
          <li key={end.label} className="inline-flex items-center gap-1.5">
            <span data-mark className="size-2.5 shrink-0 rounded-full bg-[var(--viz-marker)]" />
            <span className="font-medium text-foreground tabular-nums">{formatMultiple(end.value)}</span>
            {end.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
