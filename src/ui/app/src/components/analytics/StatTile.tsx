/**
 * One headline number, said so a person can use it: the label, the figure, what it means in a
 * sentence, how it moved against the period before, and its shape over time.
 *
 * Data contract (all the tile knows):
 *   label      what is measured, sentence case
 *   value      the figure, already formatted ("633 h", "97%"); `unit` trails it, smaller
 *   sentence   the figure in human terms ("about 1.5 full-time engineers for 11 weeks")
 *   delta      the change against a named period; the tile decides tone from `goodWhen`
 *   trend      values in time order for the sparkline (the last one is the current bucket)
 *   note       a caveat that limits the figure (shown with the dashed partial mark)
 *   onOpen     makes the whole tile a button (the Return tile opens the Return lens)
 *
 * States: `loading` draws the tile's own skeleton; `value: null` is "nothing to measure yet"
 * and says so in words instead of showing 0. The delta is toned good or risk by `goodWhen`, not at
 * all for `neutral`; a change under half a percent says "No change".
 */
import { ArrowDownRight, ArrowRight, ArrowUpRight, CircleDashed } from "lucide-react";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatPercent } from "./format";

export interface StatDelta {
  /** Signed share against the base: 0.32 is +32%. Null when there is no base to compare with. */
  ratio: number | null;
  /** "vs the 30 days before". */
  against: string;
  /** Which direction is good news. `neutral` draws no tone. */
  goodWhen?: "up" | "down" | "neutral";
}

export function StatTile({
  label,
  value,
  unit,
  sentence,
  delta,
  trend,
  note,
  emptyText = "Nothing to measure yet",
  loading = false,
  onOpen,
  openLabel,
  className,
  children,
}: {
  label: string;
  value: ReactNode | null;
  unit?: string;
  sentence?: ReactNode;
  delta?: StatDelta;
  trend?: readonly number[];
  note?: ReactNode;
  emptyText?: string;
  loading?: boolean;
  onOpen?: () => void;
  openLabel?: string;
  className?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <span className="text-label font-medium text-muted-foreground">{label}</span>
        {onOpen ? <ArrowRight aria-hidden className="mt-0.5 size-3.5 shrink-0 text-text-tertiary motion-safe:transition-transform motion-safe:group-hover/tile:translate-x-0.5" /> : null}
      </div>
      {loading ? (
        <div role="status" className="space-y-2 pt-1">
          <span className="sr-only">Loading {label}</span>
          <Skeleton className="h-7 w-20 rounded-md motion-reduce:animate-none" />
          <Skeleton className="h-3 w-4/5 rounded-full motion-reduce:animate-none" />
          <Skeleton className="h-3 w-3/5 rounded-full motion-reduce:animate-none" />
        </div>
      ) : value === null ? (
        <p className="pt-1 text-body text-muted-foreground italic">{emptyText}</p>
      ) : (
        <>
          <div className="flex items-end justify-between gap-3">
            <p className="text-[26px] leading-[30px] font-semibold tracking-tight" data-figure>
              {value}
              {unit ? <span className="ml-1 text-reading font-medium text-muted-foreground">{unit}</span> : null}
            </p>
            {trend && trend.length > 1 ? <Sparkline values={trend} className="mb-1 h-7 w-20 shrink-0" /> : null}
          </div>
          {sentence ? <p className="text-body text-pretty text-text-secondary">{sentence}</p> : null}
          {children}
          {delta || note ? (
            <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1">
              {delta ? <DeltaMark delta={delta} /> : null}
              {note ? (
                <span className="inline-flex items-center gap-1 text-label text-muted-foreground">
                  <CircleDashed aria-hidden className="size-3 shrink-0" />
                  {note}
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </>
  );
  const frame = cn("flex min-w-0 flex-col gap-1.5 rounded-xl border bg-card p-4 text-left text-card-foreground", className);
  if (onOpen) {
    return (
      <button type="button" onClick={onOpen} aria-label={openLabel ?? label} data-slot="stat-tile" className={cn(frame, "group/tile focus-ring cursor-pointer transition-colors hover:border-border-strong hover:bg-surface-hover")}>
        {body}
      </button>
    );
  }
  return (
    <section aria-label={label} data-slot="stat-tile" className={frame}>
      {body}
    </section>
  );
}

/** "+32% vs the 30 days before": an arrow and a signed figure, toned by whether that is good. */
export function DeltaMark({ delta }: { delta: StatDelta }) {
  if (delta.ratio === null) return <span className="text-label text-text-tertiary">No earlier period to compare</span>;
  const flat = Math.abs(delta.ratio) < 0.005;
  const up = delta.ratio > 0;
  const good = delta.goodWhen === "neutral" || delta.goodWhen === undefined || flat ? null : (delta.goodWhen === "up") === up;
  const Icon = flat ? ArrowRight : up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-label text-muted-foreground" data-delta={flat ? "flat" : up ? "up" : "down"}>
      <span className={cn("inline-flex items-center gap-0.5 font-medium", good === true && "text-[var(--plain-ok-fg)]", good === false && "text-[var(--plain-risk-fg)]", good === null && "text-foreground")}>
        <Icon aria-hidden className="size-3.5" />
        {flat ? "No change" : `${up ? "+" : "−"}${formatPercent(Math.min(Math.abs(delta.ratio), 9.99))}`}
      </span>
      {delta.against}
    </span>
  );
}

/** Twelve-ish points as thin columns: the shape of the period, the last bucket in the accent. */
export function Sparkline({ values, className }: { values: readonly number[]; className?: string }) {
  const max = Math.max(...values, 0);
  return (
    <span aria-hidden className={cn("flex items-end gap-px", className)} data-sparkline>
      {values.map((value, index) => (
        <span
          key={index}
          data-mark
          className="min-w-0 flex-1 rounded-t-[1.5px]"
          style={{
            height: max > 0 ? `${Math.max((value / max) * 100, value > 0 ? 8 : 3)}%` : "3%",
            background: index === values.length - 1 ? "var(--viz-accent)" : "var(--viz-muted-mark)",
          }}
        />
      ))}
    </span>
  );
}
