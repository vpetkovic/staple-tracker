/**
 * The status chip.
 *
 * This is the payoff of the token sheet: `.status-chip` is a color-mix recipe
 * (hue toward white in light mode, hue at low alpha in dark), and the hue comes from
 * app.css.
 *
 * ── O7b (STA-141): `data-status-category` IS THE ONE THAT PICKS THE HUE ───────────────
 *
 * The status set is workspace data now, so `data-status` alone cannot pick a colour —
 * there is no rule in app.css for `pairing`, and there never can be. Both attributes are
 * emitted: `data-status` because a handful of surfaces and tests still select on it and it
 * costs nothing, and `data-status-category` because that is what the sheet's later,
 * equal-specificity rule keys on, so the CATEGORY wins whenever the two would disagree.
 *
 * The chip prints the configured LABEL, not the raw id. `In Progress` rather than
 * `in_progress` — and, more to the point, whatever the workspace renamed it to. The label
 * is the thing a human chose; the id is the thing the wire needs.
 */
import { statusCategory, statusLabel } from "@/lib/settings";
import type { StatusId } from "@/lib/types";
import { cn } from "@/lib/utils";

export function StatusBadge({
  status,
  className,
}: {
  status: StatusId;
  className?: string;
}) {
  return (
    <span
      data-status={status}
      data-status-category={statusCategory(status)}
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
      {statusLabel(status)}
    </span>
  );
}

/** A bare dot, for places a full chip would be too loud (tree rows, graph legends). */
export function StatusDot({ status, className }: { status: StatusId; className?: string }) {
  return (
    <span
      data-status={status}
      data-status-category={statusCategory(status)}
      aria-label={statusLabel(status)}
      className={cn("status-fill inline-block size-2 shrink-0 rounded-full", className)}
    />
  );
}
