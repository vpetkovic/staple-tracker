/**
 * The one card every view renders. Inbox, board, and the detail panel's children list
 * all use this, so a change to how an issue reads happens once.
 *
 * WAVE 2 (U6): drag-and-drop wraps this, it does not fork it. Pass through whatever
 * dnd props you need via `...rest` on the button element rather than copying the body.
 */
import type { ReactNode } from "react";
import type { ClaimActivity, Issue } from "@/lib/types";
import { isStaleClaim } from "@/lib/claim";
import { cn } from "@/lib/utils";
import { PriorityLabel } from "./PriorityLabel";
import { StaleClaimBadge } from "./StaleClaimBadge";
import { StatusBadge } from "./StatusBadge";

export interface IssueCardProps {
  workspace: string;
  issue: Pick<Issue, "identifier" | "title" | "status" | "priority" | "assignee" | "checkoutAgent">;
  /**
   * Holder liveness for this issue, when the endpoint that produced the card carried it
   * (C3). Optional because not every list does: /api/issue returns `claim` for the issue
   * in focus but not for its children, so the detail panel's child cards pass nothing and
   * simply show no badge — an absent claim renders exactly like a fresh one, which is the
   * honest outcome when the page has no liveness reading to show.
   */
  claim?: ClaimActivity | null;
  /** Rendered under the title in the blocked-reason slot — kept generic on purpose. */
  note?: ReactNode;
  selected?: boolean;
  /** Shown only in hub mode, where the same identifier space spans several files. */
  showWorkspace?: boolean;
  showStatus?: boolean;
  onOpen: (workspace: string, ref: string) => void;
  className?: string;
}

export function IssueCard({
  workspace,
  issue,
  claim,
  note,
  selected = false,
  showWorkspace = false,
  showStatus = false,
  onOpen,
  className,
}: IssueCardProps) {
  const stale = isStaleClaim(claim);
  return (
    <button
      type="button"
      data-status={issue.status}
      data-issue={issue.identifier}
      aria-current={selected ? "true" : undefined}
      onClick={() => onOpen(workspace, issue.identifier)}
      className={cn(
        "staple-accent-edge block w-full rounded-md border bg-card px-2.5 py-2 text-left",
        "transition-colors hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        selected && "border-ring ring-1 ring-ring",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
        {showWorkspace ? <span className="font-mono">{workspace} ·</span> : null}
        <span className="font-mono">{issue.identifier}</span>
        <span aria-hidden>·</span>
        <PriorityLabel priority={issue.priority} />
        {showStatus ? <StatusBadge status={issue.status} className="ml-auto" /> : null}
      </div>
      {/* Identifiers and paths in a title have no spaces to break on, so wrap-anywhere
          is what keeps a board column from being widened by one long word. */}
      <div className="mt-0.5 text-[13px] leading-snug font-medium wrap-anywhere text-card-foreground">
        {issue.title}
      </div>
      {issue.assignee || issue.checkoutAgent ? (
        <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
          {issue.assignee ? <span>@{issue.assignee}</span> : null}
          {/* The badge REPLACES the plain "held by X" rather than sitting next to it:
              it already names the holder, and printing the name twice on a card this
              dense is how a signal turns into noise. */}
          {stale && claim ? (
            <StaleClaimBadge claim={claim} />
          ) : issue.checkoutAgent ? (
            <span>held by {issue.checkoutAgent}</span>
          ) : null}
        </div>
      ) : null}
      {note ? <div className="mt-0.5 text-[11px] text-[var(--status-task-blocked)]">{note}</div> : null}
    </button>
  );
}
