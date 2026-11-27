/**
 * Columns over an ordered axis: time buckets (stacked by series) or the bins of a distribution.
 *
 * Data contract:
 *   series   who is stacked, bottom to top, each with its colour. One series draws no legend.
 *   points   the slots, in order: `key`, the `label` the tooltip and table say, an optional
 *            `tick` (the axis text; leave undefined to skip that slot's tick) and the value per series.
 *   format   how a value is said (tooltip, table); `axisFormat` for the y ticks.
 *
 * Marks: columns at most 24px wide with a rounded data end and a square foot, a 2px card-coloured
 * gap between stacked segments, hairline gridlines, clean y ticks. Hover or arrow keys move a
 * crosshair slot by slot and one tooltip lists every series there with the total. The table twin
 * comes from `columnChartTable`, so no value lives only in the tooltip.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChartLegend, ChartTooltip, tooltipAnchor, type ChartSeries } from "./chart-parts";
import { formatNumber, niceTicks } from "./format";
import type { WidgetTable } from "./Widget";

export interface ColumnPoint {
  key: string;
  label: string;
  tick?: string;
  values: Readonly<Record<string, number>>;
}

export function ColumnChart({
  series,
  points,
  height = 168,
  format = (value) => formatNumber(value),
  axisFormat = (value) => formatNumber(value, 0),
  totalLabel = "Total",
  ariaLabel,
  legend = true,
  className,
}: {
  series: readonly ChartSeries[];
  points: readonly ColumnPoint[];
  height?: number;
  format?: (value: number) => string;
  axisFormat?: (value: number) => string;
  totalLabel?: string;
  /** The chart in a sentence, for a screen reader: what it shows and its headline. */
  ariaLabel: string;
  legend?: boolean;
  className?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const totals = points.map((point) => series.reduce((sum, item) => sum + (point.values[item.id] ?? 0), 0));
  const ticks = niceTicks(Math.max(...totals, 0));
  const top = ticks[ticks.length - 1] ?? 1;
  const current = active !== null ? points[active] : undefined;
  const tickOrder = new Map(points.flatMap((point, index) => (point.tick ? [index] : [])).map((index, order) => [index, order]));
  const crowded = tickOrder.size > 6;
  const move = (step: number) => setActive((index) => Math.min(points.length - 1, Math.max(0, (index ?? (step > 0 ? -1 : points.length)) + step)));
  return (
    <div className={cn("@container/chart flex min-w-0 flex-col gap-2", className)} data-chart="columns">
      {legend ? <ChartLegend series={series} /> : null}
      <div className="flex min-w-0 gap-2">
        <div aria-hidden className="relative w-7 shrink-0 text-right text-caption text-text-tertiary tabular-nums" style={{ height }}>
          {ticks.map((tick) => (
            <span key={tick} className="absolute right-0 translate-y-1/2 leading-none" style={{ bottom: `${(tick / top) * 100}%` }}>
              {axisFormat(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1">
          <div
            role="img"
            aria-label={ariaLabel}
            tabIndex={0}
            className="focus-ring-inset relative rounded-sm"
            style={{ height }}
            onPointerLeave={() => setActive(null)}
            onBlur={() => setActive(null)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight") { event.preventDefault(); move(1); }
              else if (event.key === "ArrowLeft") { event.preventDefault(); move(-1); }
              else if (event.key === "Escape") setActive(null);
            }}
          >
            {ticks.map((tick) => (
              <span key={tick} aria-hidden className="absolute inset-x-0 h-px" style={{ bottom: `${(tick / top) * 100}%`, background: tick === 0 ? "var(--viz-baseline)" : "var(--viz-grid)" }} />
            ))}
            <div className="absolute inset-0 flex items-end">
              {points.map((point, index) => (
                <div
                  key={point.key}
                  className={cn("relative flex h-full min-w-0 flex-1 items-end justify-center", active === index && "bg-[color-mix(in_oklab,var(--foreground)_5%,transparent)]")}
                  onPointerEnter={() => setActive(index)}
                  onPointerDown={() => setActive(index)}
                  data-slot-index={index}
                >
                  <div className="flex w-[70%] max-w-6 min-w-[3px] flex-col-reverse gap-[2px]" style={{ height: `${((totals[index] ?? 0) / top) * 100}%` }}>
                    {series
                      .filter((item) => (point.values[item.id] ?? 0) > 0)
                      .map((item, order, drawn) => (
                        <span
                          key={item.id}
                          className={cn("min-h-[2px] w-full", order === drawn.length - 1 && "rounded-t-[4px]")}
                          style={{ flexGrow: point.values[item.id], flexBasis: 0, background: item.color }}
                        />
                      ))}
                  </div>
                </div>
              ))}
            </div>
            {current && active !== null ? (
              <ChartTooltip
                title={current.label}
                className="top-1"
                style={tooltipAnchor(active, points.length)}
                rows={(series.length > 1 ? series.filter((item) => (current.values[item.id] ?? 0) > 0) : series).map((item) => ({
                  key: item.id,
                  label: item.label,
                  value: format(current.values[item.id] ?? 0),
                  color: series.length > 1 ? item.color : undefined,
                }))}
                total={series.length > 1 ? { label: totalLabel, value: format(totals[active] ?? 0) } : undefined}
              />
            ) : null}
          </div>
          <div aria-hidden className="relative mt-1.5 h-3.5 text-caption text-text-tertiary">
            {points.map((point, index) =>
              point.tick ? (
                // A crowded axis drops every second tick when the chart is narrow, so labels never collide.
                <span key={point.key} className={cn("absolute -translate-x-1/2 leading-none whitespace-nowrap", crowded && tickOrder.get(index)! % 2 === 1 && "@max-[440px]/chart:hidden")} style={{ left: `${((index + 0.5) / points.length) * 100}%` }}>
                  {point.tick}
                </span>
              ) : null,
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The chart as rows, for the widget's Table switch. */
export function columnChartTable(firstColumn: string, series: readonly ChartSeries[], points: readonly ColumnPoint[], totalLabel = "Total"): WidgetTable {
  const many = series.length > 1;
  return {
    columns: [firstColumn, ...series.map((item) => item.label), ...(many ? [totalLabel] : [])],
    rows: points.map((point) => {
      const values = series.map((item) => point.values[item.id] ?? 0);
      return [point.label, ...values, ...(many ? [values.reduce((sum, value) => sum + value, 0)] : [])];
    }),
  };
}
