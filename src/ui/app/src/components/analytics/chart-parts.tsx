/**
 * The small pieces every chart widget shares: the series type, the legend, the tooltip box.
 * No data and no layout opinions beyond their own box.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** One thing a chart tells apart by colour. `color` is a CSS colour, normally a `--viz-series-*` token. */
export interface ChartSeries {
  id: string;
  label: string;
  color: string;
}

/** The fixed categorical slots, in order. A caller gives an entity ONE slot and keeps it. */
export const SERIES_SLOTS = 6;
export function seriesColor(slot: number): string {
  return slot >= 1 && slot <= SERIES_SLOTS ? `var(--viz-series-${slot})` : "var(--viz-series-other)";
}

/** Names the marks. Always drawn for two or more series; a single series is named by the title. */
export function ChartLegend({ series, shape = "rect", className }: { series: readonly ChartSeries[]; shape?: "rect" | "line"; className?: string }) {
  if (series.length < 2) return null;
  return (
    <ul className={cn("flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground", className)} data-chart-legend>
      {series.map((item) => (
        <li key={item.id} className="inline-flex min-w-0 items-center gap-1.5">
          <span aria-hidden data-mark className={cn("shrink-0", shape === "rect" ? "size-2.5 rounded-[3px]" : "h-0.5 w-3 rounded-full")} style={{ background: item.color }} />
          <span className="truncate">{item.label}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The hover and focus readout: a title, then value-first rows. Positioned by the chart. It is
 * hidden from assistive technology: the chart says the same readout once through its own live
 * region, so a screen reader does not hear it twice.
 */
export function ChartTooltip({ title, rows, total, className, style }: {
  title: ReactNode;
  rows: readonly { key: string; label: string; value: string; color?: string }[];
  total?: { label: string; value: string };
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <div
      aria-hidden
      className={cn("pointer-events-none absolute z-10 min-w-36 rounded-md border bg-popover px-2.5 py-2 text-label text-popover-foreground shadow-md", className)}
      style={style}
      data-chart-tooltip
    >
      <p className="mb-1 whitespace-nowrap text-text-tertiary">{title}</p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2 whitespace-nowrap">
            {row.color ? <span aria-hidden data-mark className="h-0.5 w-2.5 shrink-0 rounded-full" style={{ background: row.color }} /> : null}
            <span className="font-semibold tabular-nums">{row.value}</span>
            <span className="text-muted-foreground">{row.label}</span>
          </li>
        ))}
      </ul>
      {total ? (
        <p className="mt-1 flex gap-2 border-t pt-1 whitespace-nowrap">
          <span className="font-semibold tabular-nums">{total.value}</span>
          <span className="text-muted-foreground">{total.label}</span>
        </p>
      ) : null}
    </div>
  );
}

/** Where a tooltip sits over a slot `index` of `count`: centred, but hugging the edge near either end. */
export function tooltipAnchor(index: number, count: number): React.CSSProperties {
  const center = ((index + 0.5) / count) * 100;
  if (center < 25) return { left: `${center}%`, transform: "translateX(-12px)" };
  if (center > 75) return { right: `${100 - center}%`, transform: "translateX(12px)" };
  return { left: `${center}%`, transform: "translateX(-50%)" };
}
