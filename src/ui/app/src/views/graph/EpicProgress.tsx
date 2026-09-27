/**
 * An epic's "3/4 done" on the graph, with a small bar beside it from 720px up.
 *
 * On a phone the node keeps exactly the text it shipped with; the bar and the shorter
 * count are desktop-only (a `min-[720px]` rule, no script), so the phone canvas is unchanged.
 */
import { cn } from "@/lib/utils";

export function EpicProgress({
  resolved,
  total,
  inlineBar = true,
}: {
  resolved: number;
  total: number;
  /** The bar beside the count; off where the node draws `EpicProgressEdge` instead. */
  inlineBar?: boolean;
}) {
  const complete = total > 0 && resolved === total;
  const percent = total > 0 ? Math.round((resolved / total) * 100) : 0;
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1.5 rounded-sm px-1 font-sans text-[10px] tabular-nums",
        complete ? "text-muted-foreground" : "text-card-foreground",
      )}
      // The count is the reason to collapse; say what it counts out loud for anyone
      // who cannot see the badge.
      title={`${resolved} of ${total} tickets on this canvas are done`}
      data-epic-progress={`${resolved}/${total}`}
    >
      {inlineBar ? (
      <span
        aria-hidden
        data-epic-progress-bar=""
        className="hidden h-1 w-7 overflow-hidden rounded-full bg-[var(--surface-hover)] min-[720px]:block"
      >
        <span className="block h-full rounded-full bg-[var(--status-task-done)]" style={{ width: `${percent}%` }} />
      </span>
      ) : null}
      <span>
        {resolved}/{total}
        <span className={inlineBar ? "min-[720px]:hidden" : undefined}> done</span>
      </span>
    </span>
  );
}

/**
 * The collapsed epic's progress as the node's bottom edge, from 720px up: the node's header is
 * too narrow for a bar beside its identifier, and an edge costs no layout at all.
 *
 * Anchored to React Flow's own node wrapper (which is absolutely positioned), NOT to the node:
 * making the node `relative` would re-anchor its connection handles inside its 1px border and
 * move every edge by a pixel. Inset from the rounded corners so it stays inside the outline.
 */
export function EpicProgressEdge({ resolved, total }: { resolved: number; total: number }) {
  const percent = total > 0 ? Math.round((resolved / total) * 100) : 0;
  return (
    <span
      aria-hidden
      data-epic-progress-bar=""
      className="pointer-events-none absolute inset-x-1.5 bottom-px hidden h-[3px] overflow-hidden rounded-full bg-[var(--surface-hover)] min-[720px]:block"
    >
      <span className="block h-full bg-[var(--status-task-done)]" style={{ width: `${percent}%` }} />
    </span>
  );
}
