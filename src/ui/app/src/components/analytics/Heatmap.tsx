/**
 * A week by the hour: seven rows, twenty-four columns, one hue from "nothing" to the busiest cell.
 *
 * Data contract: `cells[row][column]` are counts; `rows` and `columns` name them (`columns` may
 * leave gaps as "" so only every third hour is ticked). `format` says a cell ("21 tickets").
 * Colour is five steps of one hue with a scale legend; hover or focus on a cell says its row,
 * column and count, and `heatmapTable` gives the same grid as numbers.
 *
 * Keyboard and screen reader: the grid is one tab stop. The arrow keys move the active cell, Home
 * and End go to the ends of its row, Escape clears it. The readout line under the grid is a
 * polite live region, so the cell is said once as it changes.
 */
import { useId, useState } from "react";
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
  const [active, setActive] = useState<HeatCell | null>(null);
  const hintId = useId();
  const max = Math.max(...cells.flat(), 0);
  const step = (value: number) => (value <= 0 || max <= 0 ? 0 : Math.min(5, Math.ceil((value / max) * 5)));
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-chart="heatmap">
      <div
        role="img"
        aria-label={ariaLabel}
        aria-describedby={hintId}
        tabIndex={0}
        className="focus-ring-inset grid min-w-0 grid-cols-[2rem_1fr] gap-x-1.5 gap-y-[3px] rounded-sm"
        // A finger lifted from a tapped cell also "leaves" the grid; only a mouse or pen
        // leaving clears it. A tap elsewhere clears it through blur.
        onPointerLeave={(event) => {
          if (event.pointerType !== "touch") setActive(null);
        }}
        onBlur={() => setActive(null)}
        onKeyDown={(event) => {
          const next = stepCell(active, event.key, cells.length, cells[0]?.length ?? 0);
          if (next === undefined) return;
          event.preventDefault();
          setActive(next);
        }}
      >
        {cells.map((row, rowIndex) => (
          <div key={rows[rowIndex]} className="contents">
            <span aria-hidden className="self-center text-caption leading-none text-text-tertiary">{rows[rowIndex]}</span>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}>
              {row.map((value, column) => {
                const on = active?.row === rowIndex && active.column === column;
                return (
                  <span
                    key={column}
                    data-mark
                    data-active={on ? "" : undefined}
                    className={cn("h-4 rounded-[3px] @min-[560px]/widget:h-5", `viz-heat-${step(value)}`, on && "ring-2 ring-foreground ring-offset-1 ring-offset-card")}
                    onPointerEnter={() => setActive({ row: rowIndex, column })}
                    onPointerDown={() => setActive({ row: rowIndex, column })}
                  />
                );
              })}
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
      <p id={hintId} className="sr-only">Use the arrow keys to read each hour.</p>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-label text-muted-foreground">
        <span className="inline-flex items-center gap-1.5" aria-hidden>
          Fewer
          {[0, 1, 2, 3, 4, 5].map((level) => (
            <span key={level} data-mark className={cn("size-3 rounded-[3px]", `viz-heat-${level}`)} />
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

export interface HeatCell {
  row: number;
  column: number;
}

/**
 * Where a key moves the active cell of a `rows` × `columns` grid: the cell to show, `null` to
 * clear, `undefined` when the key is not the grid's. The first key from nothing lands on the top
 * left cell (End: the end of the top row). Moves stop at the edges.
 */
export function stepCell(active: HeatCell | null, key: string, rows: number, columns: number): HeatCell | null | undefined {
  if (key === "Escape") return active === null ? undefined : null;
  if (rows === 0 || columns === 0) return undefined;
  const { row, column } = active ?? { row: 0, column: 0 };
  const at = (r: number, c: number) => ({ row: Math.min(rows - 1, Math.max(0, r)), column: Math.min(columns - 1, Math.max(0, c)) });
  if (key === "Home") return at(row, 0);
  if (key === "End") return at(row, columns - 1);
  if (!active) return key.startsWith("Arrow") ? at(0, 0) : undefined;
  if (key === "ArrowRight") return at(row, column + 1);
  if (key === "ArrowLeft") return at(row, column - 1);
  if (key === "ArrowDown") return at(row + 1, column);
  if (key === "ArrowUp") return at(row - 1, column);
  return undefined;
}

export function heatmapTable(cells: readonly (readonly number[])[], rows: readonly string[], columnNames: readonly string[]): WidgetTable {
  return { columns: ["", ...columnNames], rows: cells.map((row, index) => [rows[index] ?? "", ...row]) };
}
