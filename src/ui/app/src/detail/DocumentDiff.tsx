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
    <span className="inline-block w-8 shrink-0 pr-2 text-right text-muted-foreground/60 select-none">
      {children}
    </span>
  );
}

function SkipMarker({ row, onExpand }: { row: SkipRow; onExpand: () => void }) {
  return (
    <button
      type="button"
      onClick={onExpand}
      className="w-full border-y bg-muted/40 px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-muted"
    >
      ⋯ {row.count} unchanged {row.count === 1 ? "line" : "lines"} — show
    </button>
  );
}

function UnifiedView({ rows, onExpand }: { rows: Array<UnifiedRow | SkipRow>; onExpand: () => void }) {
  return (
    <div className="overflow-x-auto font-mono text-[11px] leading-[1.6]">
      {rows.map((row, i) =>
        isSkip(row) ? (
          <SkipMarker key={`s${i}`} row={row} onExpand={onExpand} />
        ) : (
          <div
            key={i}
            className={cn(
              "flex whitespace-pre px-2",
              row.kind === "add" && ADD_BG,
              row.kind === "remove" && DEL_BG,
            )}
          >
            <Gutter>{row.oldNo ?? ""}</Gutter>
            <Gutter>{row.newNo ?? ""}</Gutter>
            <span className="w-3 shrink-0 select-none text-muted-foreground">
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
    <div className="font-mono text-[11px] leading-[1.6]">
      {rows.map((row, i) =>
        isSkip(row) ? (
          <SkipMarker key={`s${i}`} row={row} onExpand={onExpand} />
        ) : (
          <div key={i} className="grid grid-cols-2 divide-x">
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
      <div className="rounded-md border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
        {fromLabel} and {toLabel} are identical.
      </div>
    );
  }

  const unified = expanded ? diff.unified : collapse(diff.unified);
  const split = expanded ? diff.split : collapse(diff.split);

  return (
    <div className="rounded-md border">
      <div className="flex flex-wrap items-center gap-2 border-b px-2 py-1.5 text-[11px]">
        <span className="font-mono text-muted-foreground">
          {fromLabel} → {toLabel}
        </span>
        <span className="font-mono text-[var(--status-task-done)]">+{diff.stats.added}</span>
        <span className="font-mono text-[var(--status-task-blocked)]">−{diff.stats.removed}</span>
        <div className="ml-auto flex gap-1">
          {expanded ? (
            <Button size="sm" variant="ghost" className="h-6 px-2" onClick={() => setExpanded(false)}>
              collapse
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={layout === "unified" ? "secondary" : "ghost"}
            className="h-6 px-2"
            onClick={() => setLayout("unified")}
          >
            unified
          </Button>
          <Button
            size="sm"
            variant={layout === "split" ? "secondary" : "ghost"}
            className="h-6 px-2"
            onClick={() => setLayout("split")}
          >
            split
          </Button>
        </div>
      </div>
      <div className="max-h-[26rem] overflow-y-auto py-1">
        {layout === "unified" ? (
          <UnifiedView rows={unified} onExpand={expand} />
        ) : (
          <SplitView rows={split} onExpand={expand} />
        )}
      </div>
    </div>
  );
}
