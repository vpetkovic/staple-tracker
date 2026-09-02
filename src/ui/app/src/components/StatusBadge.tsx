/**
 * The status chip.
 *
 * This is the payoff of the token sheet: `.status-chip` is a color-mix recipe
 * (hue toward white in light mode, hue at low alpha in dark), and
 * `data-status` picks the hue via app.css. One hue covers both modes, so there is no
 * light/dark table to keep in sync here.
 */
import type { IssueStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StatusBadge({
  status,
  className,
}: {
  status: IssueStatus;
  className?: string;
}) {
  return (
    <span
      data-status={status}
      className={cn(
        "status-chip inline-flex shrink-0 items-center rounded-full border px-2 py-px",
        "font-mono text-[10px] font-semibold tracking-[0.04em] whitespace-nowrap",
        className,
      )}
    >
      {status}
    </span>
  );
}

/** A bare dot, for places a full chip would be too loud (tree rows, graph legends). */
export function StatusDot({ status, className }: { status: IssueStatus; className?: string }) {
  return (
    <span
      data-status={status}
      aria-label={status}
      className={cn("status-fill inline-block size-2 shrink-0 rounded-full", className)}
    />
  );
}
