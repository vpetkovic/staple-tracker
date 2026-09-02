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
        // `rounded-md`, not `rounded-full`. A pill is a Jira-era shape; Geist
        // and Linear both use a small rounded rectangle for a status badge, and it
        // matters more than it sounds: a pill in a row of rounded-rectangle
        // controls is the one object that does not belong to the corner language.
        "status-chip inline-flex shrink-0 items-center rounded-md border px-1.5 py-px",
        // Medium, not semibold, and tracking at the label step rather than a
        // hand-rolled 0.04em. Mono caps at 10px are already dense enough to read
        // as emphatic; bolding them on top is what turns a badge into a shout.
        "font-mono text-[10px] font-medium tracking-[var(--tracking-label)] whitespace-nowrap",
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
