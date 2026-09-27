/**
 * Presentation for a revision diff. All of the thinking is in ./diff.ts — this file
 * only decides what a changed line looks like.
 *
 * Colour comes from the theme token sheet, never a hex: additions borrow
 * --status-task-done (the "this landed" green), deletions --status-task-blocked (the
 * "this is gone" red), both at the 12%/22% mix the sheet uses for status chips so they
 * read the same in light and dark.
 */
import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  collapse,
  isSkip,
  type DocumentDiff as Diff,
  type SkipRow,
  type SplitRow,
  type UnifiedRow,
} from "./diff";

const ADD_BG = "bg-[color-mix(in_oklab,var(--status-task-done)_14%,transparent)]";
const DEL_BG = "bg-[color-mix(in_oklab,var(--status-task-blocked)_14%,transparent)]";

function Gutter({ children }: { children: ReactNode }) {
  return (
    <span className="inline-block w-7 shrink-0 pr-2 text-right text-text-tertiary/70 select-none max-sm:hidden">
      {children}
    </span>
  );
}

function SkipMarker({ row, onExpand }: { row: SkipRow; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="focus-ring-inset my-1 w-full bg-surface-sunken px-3 py-1.5 text-left font-sans text-label text-text-secondary transition-colors duration-150 hover:text-foreground max-sm:py-2.5"
    >
      Show {row.count} unchanged {row.count === 1 ? "line" : "lines"}
    </button>
  );
}

function UnifiedView({ rows, onExpand }: { rows: Array<UnifiedRow | SkipRow>; onExpand: () => void }) {
  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      {rows.map((row, i) =>
        isSkip(row) ? (
          <SkipMarker key={`s${i}`} row={row} onExpand={onExpand} />
        ) : (
          <div
            key={i}
            className={cn(
              // Wrapped, not scrolled: on a phone a sideways-scrolling diff is one you cannot read.
              "flex px-2 whitespace-pre-wrap wrap-anywhere",
              row.kind === "add" && ADD_BG,
              row.kind === "remove" && DEL_BG,
            )}
          >
            <Gutter>{row.oldNo ?? ""}</Gutter>
            <Gutter>{row.newNo ?? ""}</Gutter>
            <span className="w-3 shrink-0 select-none text-text-tertiary">
              {row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}
            </span>
            <span className="min-w-0">{row.text === "" ? " " : row.text}</span>
          </div>
        ),
      )}
    </div>
  );
}

/**
 * Two columns, wrapped rather than scrolled.
 *
 * `whitespace-pre` here would let a long line run out of its 50% column and paint over
 * the other side — the detail panel is narrow enough that this happens on ordinary
 * prose, not just on pathological input. Wrapping keeps each side inside its column;
 * the two cells share a grid row, so the row grows to the taller of the pair and the
 * before/after of one line stays visually paired.
 */
function SplitView({ rows, onExpand }: { rows: Array<SplitRow | SkipRow>; onExpand: () => void }) {
  return (
    <div className="font-mono text-[12px] leading-[1.6]">
      {rows.map((row, i) =>
        isSkip(row) ? (
          <SkipMarker key={`s${i}`} row={row} onExpand={onExpand} />
        ) : (
          <div key={i} className="grid grid-cols-2 divide-x divide-border">
            <div
              className={cn(
                "flex min-w-0 overflow-hidden px-2 whitespace-pre-wrap wrap-anywhere",
                row.changed && row.left && DEL_BG,
              )}
            >
              <Gutter>{row.left?.no ?? ""}</Gutter>
              <span className="min-w-0 flex-1">{row.left ? (row.left.text === "" ? " " : row.left.text) : " "}</span>
            </div>
            <div
              className={cn(
                "flex min-w-0 overflow-hidden px-2 whitespace-pre-wrap wrap-anywhere",
                row.changed && row.right && ADD_BG,
              )}
            >
              <Gutter>{row.right?.no ?? ""}</Gutter>
              <span className="min-w-0 flex-1">
                {row.right ? (row.right.text === "" ? " " : row.right.text) : " "}
              </span>
            </div>
          </div>
        ),
      )}
    </div>
  );
}

export function DocumentDiff({
  diff,
  fromLabel,
  toLabel,
}: {
  diff: Diff;
  fromLabel: string;
  toLabel: string;
}) {
  const [layout, setLayout] = useState<"unified" | "split">("unified");
  const [expanded, setExpanded] = useState(false);
  const expand = () => setExpanded(true);

  if (diff.identical) {
    return (
      <div className="rounded-xl border border-border bg-surface-sunken px-3.5 py-2.5 text-body text-text-secondary">
        {fromLabel} and {toLabel} are the same.
      </div>
    );
  }

  const unified = expanded ? diff.unified : collapse(diff.unified);
  const split = expanded ? diff.split : collapse(diff.split);
  const toggle = (value: "unified" | "split", label: string) => (
    <button
      type="button"
      aria-pressed={layout === value}
      onClick={() => setLayout(value)}
      className={"text-label " + cn(
        "focus-ring h-7 rounded-md px-2.5 transition-colors duration-150 max-sm:h-9",
        layout === value ? "bg-surface-raised text-foreground shadow-[0_0_0_1px_var(--border)]" : "text-text-secondary hover:text-foreground",
      )}
    >
      {label}
    </button>
  );

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-raised">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-3.5 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="text-body font-medium text-foreground">
            {fromLabel} → {toLabel}
          </div>
          <div className="text-label">
            <span className="text-[var(--status-task-done)]">
              {diff.stats.added} {diff.stats.added === 1 ? "line" : "lines"} added
            </span>
            <span className="text-text-tertiary"> · </span>
            <span className="text-[var(--status-task-blocked)]">{diff.stats.removed} removed</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          {expanded ? (
            <Button size="sm" variant="ghost" className="h-7 px-2.5 text-[12px] max-sm:h-9" onClick={() => setExpanded(false)}>
              Hide unchanged
            </Button>
          ) : null}
          {/* Side by side needs width a phone does not have, so the phone keeps one column. */}
          <div role="group" aria-label="Diff layout" className="inline-flex rounded-lg bg-surface-sunken p-0.5 max-sm:hidden">
            {toggle("unified", "One column")}
            {toggle("split", "Side by side")}
          </div>
        </div>
      </div>
      <div className="max-h-[32rem] overflow-y-auto py-1">
        {layout === "unified" ? (
          <UnifiedView rows={unified} onExpand={expand} />
        ) : (
          <>
            <div className="max-sm:hidden">
              <SplitView rows={split} onExpand={expand} />
            </div>
            <div className="sm:hidden">
              <UnifiedView rows={unified} onExpand={expand} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
