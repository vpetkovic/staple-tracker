/**
 * What got built: one row per feature (an epic), with how much of it is closed, the agent time it
 * took and how long it ran. The widget that answers "so what did all those hours produce?".
 *
 * Data contract: `rows` in the order to draw. Each has its `ref` and `title`, the `workspace` it
 * belongs to (omitted when the page is one workspace), `closed` of `children` tickets, whether it
 * `shipped` in the period, `agentHours` and `spanDays` (null when nothing closed). `onOpen(ref)`
 * makes the title a button. `limit` rows show first; the rest sit behind "Show all".
 * `hideTitles` replaces every title with its reference, for a screen you are about to share.
 * `spanDays` reads "—", "1 day" or "N days".
 */
import { CircleCheck } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatEffortHours } from "./format";

export interface FeatureRow {
  ref: string;
  title: string;
  workspace?: { label: string; color: string };
  closed: number;
  children: number;
  shipped: boolean;
  agentHours: number;
  spanDays: number | null;
}

export function FeatureTable({ rows, limit = 8, onOpen, hideTitles = false, className }: { rows: readonly FeatureRow[]; limit?: number; onOpen?: (ref: string) => void; hideTitles?: boolean; className?: string }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, limit);
  return (
    <div className={cn("@container/features min-w-0", className)} data-chart="features">
      <div aria-hidden className="hidden grid-cols-[minmax(0,1fr)_7.5rem_4rem_4.5rem] gap-x-4 border-b pb-1.5 text-caption font-medium tracking-[var(--tracking-eyebrow)] text-text-tertiary uppercase @min-[560px]/features:grid">
        <span>Feature</span>
        <span>Tickets closed</span>
        <span className="text-right">Agent time</span>
        <span className="text-right">Ran for</span>
      </div>
      <ul>
        {shown.map((row) => {
          const share = row.children > 0 ? row.closed / row.children : 0;
          const title = hideTitles ? row.ref : row.title;
          return (
            <li key={row.ref} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b py-2 last:border-b-0 @min-[560px]/features:grid-cols-[minmax(0,1fr)_7.5rem_4rem_4.5rem]">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-1.5">
                  {row.shipped ? <CircleCheck role="img" aria-label="Shipped in this period" className="size-3.5 shrink-0 text-[var(--plain-ok-fg)]" /> : null}
                  {onOpen ? (
                    <button type="button" onClick={() => onOpen(row.ref)} className="focus-ring relative min-h-0 min-w-0 truncate rounded-sm text-left text-body font-medium before:absolute before:-inset-y-1.5 before:inset-x-0 before:content-[''] hover:underline">
                      {title}
                    </button>
                  ) : (
                    <span className="min-w-0 truncate text-body font-medium">{title}</span>
                  )}
                </div>
                <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-label text-muted-foreground">
                  {row.workspace ? (
                    <>
                      <span aria-hidden data-mark className="size-2 shrink-0 rounded-full" style={{ background: row.workspace.color }} />
                      <span className="truncate">{row.workspace.label}</span>
                      <span aria-hidden>·</span>
                    </>
                  ) : null}
                  {hideTitles ? null : <span className="shrink-0 tabular-nums">{row.ref}</span>}
                  <span className="shrink-0 @min-[560px]/features:hidden">
                    {hideTitles ? "" : "· "}
                    {formatEffortHours(row.agentHours)}
                  </span>
                </p>
              </div>
              <div className="flex w-[7.5rem] items-center gap-2 @max-[560px]/features:w-24">
                <span className="w-11 shrink-0 text-body tabular-nums">
                  {row.closed}
                  <span className="text-muted-foreground"> / {row.children}</span>
                </span>
                <span data-track className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--viz-track)]" role="img" aria-label={`${row.closed} of ${row.children} tickets closed`}>
                  <span data-mark className="block h-full rounded-full bg-[var(--viz-accent)]" style={{ width: `${share * 100}%` }} />
                </span>
              </div>
              <span className="hidden text-right text-body tabular-nums @min-[560px]/features:block">{formatEffortHours(row.agentHours)}</span>
              <span className="hidden text-right text-body text-muted-foreground tabular-nums @min-[560px]/features:block">{row.spanDays === null ? "—" : row.spanDays === 1 ? "1 day" : `${row.spanDays} days`}</span>
            </li>
          );
        })}
      </ul>
      {rows.length > limit ? (
        <button type="button" onClick={() => setAll((value) => !value)} aria-expanded={all} className="focus-ring relative mt-2 min-h-0 rounded-md text-label font-medium text-muted-foreground before:absolute before:-inset-y-2 before:inset-x-0 before:content-[''] hover:text-foreground">
          {all ? "Show fewer" : `Show all ${rows.length} features`}
        </button>
      ) : null}
    </div>
  );
}
