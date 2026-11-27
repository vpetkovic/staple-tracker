/**
 * A week by the hour: seven rows, twenty-four columns, one hue from "nothing" to the busiest cell.
 *
 * Data contract: `cells[row][column]` are counts; `rows` and `columns` name them (`columns` may
 * leave gaps as "" so only every third hour is ticked). `format` says a cell ("21 tickets").
 * Colour is five steps of one hue with a scale legend; hover or focus on a cell says its row,
 * column and count, and `heatmapTable` gives the same grid as numbers.
 */
import { useState } from "react";
import { cn } from "@/lib/utils";
import type { WidgetTable } from "./Widget";

export function Heatmap({ cells, rows, columns, columnNames, format, ariaLabel, className }: {
  cells: readonly (readonly number[])[];
  rows: readonly string[];
  /** The tick under each column; "" for none. */
  columns: readonly string[];
  /** What each column is called in the readout ("3 am"). */
  columnNames: readonly string[];
  format: (value: number) => string;
  ariaLabel: string;
  className?: string;
}) {
  const [active, setActive] = useState<{ row: number; column: number } | null>(null);
  const max = Math.max(...cells.flat(), 0);
  const step = (value: number) => (value <= 0 || max <= 0 ? 0 : Math.min(5, Math.ceil((value / max) * 5)));
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-chart="heatmap">
      <div role="img" aria-label={ariaLabel} className="grid min-w-0 grid-cols-[2rem_1fr] gap-x-1.5 gap-y-[3px]" onPointerLeave={() => setActive(null)}>
        {cells.map((row, rowIndex) => (
          <div key={rows[rowIndex]} className="contents">
            <span aria-hidden className="self-center text-caption leading-none text-text-tertiary">{rows[rowIndex]}</span>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
              {row.map((value, column) => (
                <span
                  key={column}
                  className={cn("h-4 rounded-[3px] @min-[560px]/widget:h-5", `viz-heat-${step(value)}`, active?.row === rowIndex && active.column === column && "ring-2 ring-foreground ring-offset-1 ring-offset-card")}
                  onPointerEnter={() => setActive({ row: rowIndex, column })}
                  onPointerDown={() => setActive({ row: rowIndex, column })}
                />
              ))}
            </div>
          </div>
        ))}
        <span />
        <div aria-hidden className="grid gap-[3px] text-caption leading-none text-text-tertiary" style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}>
          {columns.map((tick, index) => (
            <span key={index} className="whitespace-nowrap">{tick}</span>
          ))}
        </div>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-label text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" aria-hidden>
          Fewer
          {[0, 1, 2, 3, 4, 5].map((level) => (
            <span key={level} className={cn("size-3 rounded-[3px]", `viz-heat-${level}`)} />
          ))}
          More
        </span>
        <span aria-live="polite" className="tabular-nums">
          {active ? (
            <>
              <span className="font-medium text-foreground">{format(cells[active.row]?.[active.column] ?? 0)}</span> · {rows[active.row]} {columnNames[active.column]}
            </>
          ) : (
            `Busiest hour: ${format(max)}`
          )}
        </span>
      </div>
    </div>
  );
}

export function heatmapTable(cells: readonly (readonly number[])[], rows: readonly string[], columnNames: readonly string[]): WidgetTable {
  return { columns: ["", ...columnNames], rows: cells.map((row, index) => [rows[index] ?? "", ...row]) };
}
