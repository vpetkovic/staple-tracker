/**
 * The return on spend as a range, because the value of the work is counted two ways: a low end
 * (measured agent time, conservative) and a high end (planned effort). The bar runs from 0, the
 * band spans the two, each end carries its own figure and name, and a dashed line marks
 * break-even (1×): left of it the work cost more than it was worth.
 *
 * Data contract: `low` and `high` as `{ value, label }` multiples (either may be null when it
 * cannot be computed; one end then draws alone), and the `breakEven` multiple (1 by default).
 * It computes nothing: the caller owns the maths.
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
  const max = Math.max(last.value, breakEven) * 1.18;
  const at = (value: number) => `${Math.min(Math.max((value / max) * 100, 0), 100)}%`;
  const description = `${ends.map((end) => `${formatMultiple(end.value)} by ${end.label}`).join(", ")}. Break-even is ${formatMultiple(breakEven)}.`;
  return (
    <div className={cn("min-w-0", className)} data-chart="return-range">
      <div role="img" aria-label={description} className={cn("relative", compact ? "h-6 pt-1.5" : "h-7 pt-2")}>
        <div className="absolute inset-x-0 h-3 rounded-full border border-[var(--viz-track-edge)] bg-[var(--viz-track)]" />
        {ends.length === 2 ? (
          <div className="absolute h-3 rounded-full bg-[var(--viz-likely)]" style={{ left: at(first.value), width: `calc(${at(last.value)} - ${at(first.value)})`, minWidth: 6 }} />
        ) : null}
        {ends.map((end) => (
          <div key={end.label} className="absolute size-3 -translate-x-1/2 rounded-full bg-[var(--viz-marker)] ring-2 ring-[var(--card)]" style={{ left: at(end.value) }} />
        ))}
        <div className="absolute top-0 bottom-0 w-0 -translate-x-1/2 border-l-2 border-dashed border-[var(--viz-marker)] shadow-[0_0_0_2px_var(--card)]" style={{ left: at(breakEven) }} />
      </div>
      {compact ? null : (
        <ul aria-hidden className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground">
          {ends.map((end) => (
            <li key={end.label} className="inline-flex items-center gap-1.5">
              <span className="size-2.5 shrink-0 rounded-full bg-[var(--viz-marker)]" />
              <span className="font-medium text-foreground tabular-nums">{formatMultiple(end.value)}</span>
              {end.label}
            </li>
          ))}
          <li className="inline-flex items-center gap-1.5">
            <span className="h-3 w-0 shrink-0 border-l-2 border-dashed border-[var(--viz-marker)]" />
            Break-even ({formatMultiple(breakEven)})
          </li>
        </ul>
      )}
    </div>
  );
}
