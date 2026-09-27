/**
 * An epic's "3/4 done" on the graph, with a small bar on the desk.
 *
 * On a phone (below the shell's breakpoint, `lib/use-media`) the node draws exactly the text
 * it shipped with and nothing else; the bar is desk-only.
 */
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";

export function EpicProgress({
  resolved,
  total,
  inlineBar = true,
  desk: deskOverride,
}: {
  resolved: number;
  total: number;
  /** The bar beside the count; off where the node draws `EpicProgressEdge` instead. */
  inlineBar?: boolean;
  /** For a caller (or a test) that already knows the width. */
  desk?: boolean;
}) {
  const desk = useIsDesk() && deskOverride !== false;
  const complete = total > 0 && resolved === total;
  const title = `${resolved} of ${total} tickets on this canvas are done`;
  if (!desk || !inlineBar) {
    return (
      <span
        className={cn(
          "ml-auto shrink-0 rounded-sm px-1 font-sans text-[10px] tabular-nums",
          complete ? "text-muted-foreground" : "text-card-foreground",
        )}
        // The count is the reason to collapse; say what it counts out loud for anyone
        // who cannot see the badge.
        title={title}
      >
        {resolved}/{total} done
      </span>
    );
  }
  const percent = total > 0 ? Math.round((resolved / total) * 100) : 0;
  return (
    <span
      className={cn(
        "ml-auto flex shrink-0 items-center gap-1.5 rounded-sm px-1 font-sans text-[10px] tabular-nums",
        complete ? "text-muted-foreground" : "text-card-foreground",
      )}
      title={title}
      data-epic-progress={`${resolved}/${total}`}
    >
      <span aria-hidden data-epic-progress-bar="" className="block h-1 w-7 overflow-hidden rounded-full bg-[var(--surface-hover)]">
        <span className="block h-full rounded-full bg-[var(--status-task-done)]" style={{ width: `${percent}%` }} />
      </span>
      <span>
        {resolved}/{total}
      </span>
    </span>
  );
}

/**
 * The collapsed epic's progress as the node's bottom edge, on the desk only: the node's header
 * is too narrow for a bar beside its identifier, and an edge costs no layout at all.
 *
 * Anchored to React Flow's own node wrapper (which is absolutely positioned), NOT to the node:
 * making the node `relative` would re-anchor its connection handles inside its 1px border and
 * move every edge by a pixel. Inset from the rounded corners so it stays inside the outline.
 */
export function EpicProgressEdge({ resolved, total, desk: deskOverride }: { resolved: number; total: number; desk?: boolean }) {
  const desk = useIsDesk() && deskOverride !== false;
  if (!desk) return null;
  const percent = total > 0 ? Math.round((resolved / total) * 100) : 0;
  return (
    <span
      aria-hidden
      data-epic-progress-bar=""
      className="pointer-events-none absolute inset-x-1.5 bottom-px block h-[3px] overflow-hidden rounded-full bg-[var(--surface-hover)]"
    >
      <span className="block h-full bg-[var(--status-task-done)]" style={{ width: `${percent}%` }} />
    </span>
  );
}
