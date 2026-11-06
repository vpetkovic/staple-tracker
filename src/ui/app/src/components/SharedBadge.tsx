/**
 * "⇄ Shared · 2 members" beside the workspace name, with the members' chips and a live sync
 * dot, so it is clear at a glance that what you are looking at is shared, with whom, and
 * that it is keeping up. Drawn only for a shared workspace (more than one current member on
 * this machine's member list); otherwise nothing at all.
 *
 * Pressing it opens Settings → Members for the workspace.
 */
import { ArrowLeftRight } from "lucide-react";
import { MemberChip } from "@/detail/parts/MemberChip";
import { openSettings } from "@/lib/shell-events";
import {
  sharedBadgeText,
  sharedChips,
  sharedRow,
  syncDot,
  syncDotLabel,
  useSharedWorkspaces,
  type SyncDot,
} from "@/lib/shared-workspaces";
import type { CloudSharedWorkspace, CloudSurfaceReport } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The chips sit side by side with a hair of space, each ringed in the badge's background.
 * They used to overlap by a few pixels, and a two-letter disc lost its second letter under
 * its neighbour ("VP" read "VI"); a ring alone cannot fix that, because the neighbour is
 * drawn on top of it.
 */
export const CHIP_ROW_CLASS = "flex items-center gap-0.5";
export const CHIP_RING_CLASS = "[&>span]:ring-1 [&>span]:ring-[var(--surface-raised)]";

const DOT_CLASS: Record<SyncDot, string> = {
  syncing: "bg-[var(--status-task-done)]",
  attention: "bg-[var(--status-task-in-review,#d4a72c)]",
  stopped: "bg-[var(--status-task-blocked)]",
  idle: "bg-[var(--status-task-backlog)]",
};

export function SharedBadgeView({
  row,
  report,
  compact = false,
  onOpen,
}: {
  row: CloudSharedWorkspace | null;
  report: Pick<CloudSurfaceReport, "state" | "mode"> | null;
  compact?: boolean;
  onOpen?: () => void;
}) {
  if (row === null) return null;
  const dot = syncDot(report);
  const { shown, more } = sharedChips(row, compact ? 2 : 3);
  const others = row.members.filter((member) => !member.self).map((member) => member.name);
  return (
    <button
      type="button"
      data-shared-badge={row.members.length}
      data-sync-dot={dot}
      onClick={onOpen}
      title={`Shared with ${others.join(", ") || "nobody else"} · ${syncDotLabel(dot)}`}
      aria-label={`${sharedBadgeText(row)}. ${syncDotLabel(dot)}. Open members.`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface-raised px-2 py-0.5 text-caption text-text-secondary transition-colors hover:border-border-strong focus-ring",
        compact ? "h-7" : "h-6",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT_CLASS[dot], dot === "syncing" && "animate-pulse")} />
      <ArrowLeftRight aria-hidden className="size-3.5 shrink-0" />
      {compact ? <span>{row.members.length}</span> : <span className="whitespace-nowrap">{sharedBadgeText(row)}</span>}
      <span aria-hidden data-shared-chips className={CHIP_ROW_CLASS}>
        {shown.map((member) => (
          <MemberChip key={member.memberId} member={member} you={member.self} className={CHIP_RING_CLASS} />
        ))}
        {more > 0 ? <span className="pl-2 text-caption tabular-nums">+{more}</span> : null}
      </span>
    </button>
  );
}

/** The badge for one workspace, read from the shared-workspace store. Nothing when not shared. */
export function SharedBadge({
  slug,
  report,
  compact = false,
}: {
  slug: string;
  report: Pick<CloudSurfaceReport, "state" | "mode"> | null;
  compact?: boolean;
}) {
  const rows = useSharedWorkspaces();
  if (slug === "") return null;
  return (
    <SharedBadgeView
      row={sharedRow(rows, slug)}
      report={report}
      compact={compact}
      onOpen={() => openSettings({ section: "members", workspace: slug })}
    />
  );
}
