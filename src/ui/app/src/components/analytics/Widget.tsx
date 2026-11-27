/**
 * The frame every analytics widget sits in, and the four states it owns: loading, empty,
 * failed and partial. A widget is told its state; it never fetches and never reads the page.
 *
 *   title + one plain sentence      what this is and what it says, in words
 *   the body                        the chart, or its table twin behind the Table switch
 *   coverage                        "Covers 248 of 346 finished tickets": the partial-data caveat,
 *                                   on the widget whose figure it limits, never in a footnote
 *   help                            "What does this mean?" (the method, in two or three sentences)
 *
 * States replace the body and keep the frame, so a page never jumps when data arrives.
 */
import { CircleDashed, Table2, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { HelpToggle } from "@/components/plain/PlainCard";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatPercent } from "./format";

export type WidgetState =
  | { kind: "ready" }
  | { kind: "loading" }
  | { kind: "empty"; title: string; hint?: string }
  | { kind: "error"; message: string; onRetry?: () => void };

/** A share of the whole a figure rests on. `covered === total` draws nothing. */
export interface Coverage {
  covered: number;
  total: number;
  /** What is counted, plural: "finished tickets", "attempts". */
  noun: string;
  /** What the covered ones have: "have an estimate", "logged a model". */
  have: string;
}

export interface WidgetTable {
  columns: readonly string[];
  rows: readonly (readonly (string | number)[])[];
}

export function Widget({
  title,
  sentence,
  state = { kind: "ready" },
  coverage,
  help,
  table,
  actions,
  footer,
  className,
  bodyClassName,
  minBodyHeight = 120,
  children,
}: {
  title: string;
  /** The answer in a sentence. A widget without one is a chart without a point. */
  sentence?: ReactNode;
  state?: WidgetState;
  coverage?: Coverage | null;
  help?: ReactNode;
  /** The chart's table twin. Given one, the header carries a Table switch. */
  table?: WidgetTable;
  actions?: ReactNode;
  footer?: ReactNode;
  className?: string;
  bodyClassName?: string;
  /** Held while loading, empty or failed, so the frame keeps its height. */
  minBodyHeight?: number;
  children?: ReactNode;
}) {
  const [asTable, setAsTable] = useState(false);
  const ready = state.kind === "ready";
  return (
    <section aria-label={title} data-slot="widget" data-state={state.kind} className={cn("@container/widget flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground", className)}>
      <header className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold">{title}</h3>
          {sentence && ready ? <p className="mt-0.5 text-label text-pretty text-muted-foreground">{sentence}</p> : null}
        </div>
        {actions}
        {table && ready ? (
          <button
            type="button"
            aria-pressed={asTable}
            aria-label={asTable ? `Show ${title} as a chart` : `Show ${title} as a table`}
            title={asTable ? "Show chart" : "Show as table"}
            onClick={() => setAsTable((value) => !value)}
            className={cn(
              "focus-ring relative -mt-0.5 -mr-1 inline-flex size-6 min-h-0 shrink-0 items-center justify-center rounded-md text-text-tertiary transition-colors hover:bg-surface-hover hover:text-foreground",
              "before:absolute before:-inset-1 before:content-['']",
              asTable && "bg-surface-hover text-foreground",
            )}
          >
            <Table2 aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </header>
      <div className={cn("min-w-0 flex-1", bodyClassName)} style={ready ? undefined : { minHeight: minBodyHeight }}>
        {state.kind === "loading" ? (
          <div role="status" aria-live="polite" className="flex h-full flex-col justify-end gap-2" style={{ minHeight: minBodyHeight }}>
            <span className="sr-only">Loading {title}</span>
            <Skeleton className="h-3 w-2/5 rounded-full motion-reduce:animate-none" />
            <Skeleton className="w-full flex-1 rounded-md motion-reduce:animate-none" />
          </div>
        ) : state.kind === "empty" ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 py-6 text-center" style={{ minHeight: minBodyHeight }}>
            <p className="text-body font-medium">{state.title}</p>
            {state.hint ? <p className="max-w-[28rem] text-label text-muted-foreground">{state.hint}</p> : null}
          </div>
        ) : state.kind === "error" ? (
          <div role="alert" className="flex h-full flex-col items-center justify-center gap-1.5 px-4 py-6 text-center" style={{ minHeight: minBodyHeight }}>
            <TriangleAlert aria-hidden className="size-4 text-[var(--plain-risk-fg)]" />
            <p className="text-body font-medium">This could not be loaded</p>
            <p className="max-w-[28rem] text-label break-words text-muted-foreground">{state.message}</p>
            {state.onRetry ? (
              <button type="button" onClick={state.onRetry} className="focus-ring relative mt-1 min-h-0 rounded-md border px-2.5 py-1 text-label font-medium before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-surface-hover">
                Try again
              </button>
            ) : null}
          </div>
        ) : asTable && table ? (
          <WidgetTableView table={table} />
        ) : (
          children
        )}
      </div>
      {ready && (coverage || help || footer) ? (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {coverage ? <CoverageNote coverage={coverage} /> : null}
          {footer}
          {help ? <HelpToggle dense>{help}</HelpToggle> : null}
        </div>
      ) : null}
    </section>
  );
}

/** The partial-data caveat: a dashed mark, the share in words, and the share as a figure. */
export function CoverageNote({ coverage, className }: { coverage: Coverage; className?: string }) {
  if (coverage.total <= 0 || coverage.covered >= coverage.total) return null;
  return (
    <p className={cn("inline-flex min-h-6 items-center gap-1.5 text-label text-muted-foreground", className)} data-coverage>
      <CircleDashed aria-hidden className="size-3.5 shrink-0" />
      <span>
        Partial: {coverage.covered.toLocaleString("en-US")} of {coverage.total.toLocaleString("en-US")} {coverage.noun} {coverage.have} ({formatPercent(coverage.covered / coverage.total)})
      </span>
    </p>
  );
}

function WidgetTableView({ table }: { table: WidgetTable }) {
  return (
    <div className="max-h-72 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-label">
        <thead className="sticky top-0 bg-surface-sunken text-left text-text-tertiary">
          <tr>
            {table.columns.map((column, index) => (
              <th key={column} scope="col" className={cn("px-2.5 py-1.5 font-medium whitespace-nowrap", index > 0 && "text-right")}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t">
              {row.map((cell, index) => (
                <td key={index} className={cn("px-2.5 py-1 whitespace-nowrap", index > 0 && "text-right tabular-nums")}>
                  {typeof cell === "number" ? cell.toLocaleString("en-US", { maximumFractionDigits: 1 }) : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
