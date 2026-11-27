/**
 * The Milestones page's own controls. On a desk, a toolbar row under the top bar with Plan's
 * toolbar metrics: quiet counts on the left, Collapse all / Expand all and "+ Milestone" on the
 * right. On a phone there is no toolbar row: the fold control sits beside the page name in the
 * shell's header (`usePhoneHeaderSlot`, as Plan's lens tabs do), and "+ Milestone" is a
 * full-width row at the end of the outline.
 */
import { ChevronsDownUp, ChevronsUpDown, Plus } from "lucide-react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { MILESTONE_KIND } from "@/detail/plain-actions";
import { openCreateIssue } from "@/lib/shell-events";
import { cn } from "@/lib/utils";

/** Collapse all while any open section is unfolded, else Expand all; disabled with no open milestone. */
export interface FoldAll {
  action: "collapse" | "expand";
  disabled: boolean;
  onClick: () => void;
}

const FOLD_WORDS = { collapse: "Collapse all", expand: "Expand all" } as const;

export function createMilestone(): void {
  openCreateIssue({ kind: MILESTONE_KIND });
}

export function MilestonesToolbar({ open, finished, foldAll, slot }: { open: number; finished: number; foldAll: FoldAll; slot: HTMLElement | null }) {
  const Icon = foldAll.action === "collapse" ? ChevronsDownUp : ChevronsUpDown;
  if (slot) {
    return createPortal(
      <Button
        variant="ghost"
        size="icon"
        className="size-8 min-h-0 text-text-secondary"
        aria-label={FOLD_WORDS[foldAll.action]}
        title={FOLD_WORDS[foldAll.action]}
        disabled={foldAll.disabled}
        onClick={foldAll.onClick}
        data-milestones-fold-all={foldAll.action}
      >
        <Icon aria-hidden />
      </Button>,
      slot,
    );
  }
  return (
    <div className="flex shrink-0 items-center gap-2 border-b px-gutter py-2" data-milestones-toolbar="">
      <span className="min-w-0 truncate text-label text-text-tertiary tabular-nums" data-milestones-counts="">
        {open} open · {finished} finished
      </span>
      <span aria-hidden className="ms-auto" />
      <Button variant="outline" size="sm" className="h-8 min-h-0" disabled={foldAll.disabled} onClick={foldAll.onClick} data-milestones-fold-all={foldAll.action}>
        <Icon aria-hidden />
        {FOLD_WORDS[foldAll.action]}
      </Button>
      {/* Under 760px of the page it is the full-width row at the end of the outline instead. */}
      <Button size="sm" className="h-8 min-h-0 @max-[760px]/ms:hidden" onClick={createMilestone} data-milestones-create="">
        <Plus aria-hidden />
        Milestone
      </Button>
    </div>
  );
}

/** "+ Milestone" as a full-width row at the end of the outline, under 760px of the page. */
export function AddMilestoneRow({ className }: { className?: string }) {
  return (
    <div className={cn("hidden px-3 pt-4 @max-[760px]/ms:block", className)}>
      <Button variant="outline" size="sm" className="h-8 min-h-0 w-full justify-center" onClick={createMilestone} data-add-milestone-row="">
        <Plus aria-hidden />
        Add a milestone
      </Button>
    </div>
  );
}
