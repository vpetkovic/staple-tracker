/**
 * One status column — owned by U6 along with the rest of views/board/.
 *
 * The drop target is this component's root. It is already the only element that knows
 * both a status and a list of issues, which is exactly what a drop handler needs.
 *
 * While a card is in the air the column shows an *affordance*, not a verdict. A column
 * whose guard is visibly going to fire (in_progress with no assignee) is dimmed and
 * labelled — and still accepts the drop, because the store's refusal message is the
 * thing worth having and you only get it by asking. See guards.ts.
 */
import { useDroppable } from "@dnd-kit/core";
import { useSession } from "@/lib/session";
import type { ClaimActivity, Issue, IssueStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { DraggableIssueCard } from "./DraggableIssueCard";
import { columnAffordance, type ColumnAffordance } from "./guards";
import type { Refusal } from "./refusal";

export interface BoardCard {
  workspace: string;
  issue: Issue;
  /** Holder liveness off /api/issues, null when unheld — drives the stale badge (C3). */
  claim: ClaimActivity | null;
}

export function BoardColumn({
  status,
  cards,
  limit,
  dragging,
  pendingId,
  refusalId,
  refusal,
  onDismissRefusal,
}: {
  status: IssueStatus;
  cards: BoardCard[];
  /** Resolved columns are capped — a year of done work is not a column, it is a log. */
  limit?: number;
  /** The card currently being dragged, anywhere on the board. */
  dragging?: BoardCard | null;
  /** Issue id whose status change is in flight. */
  pendingId?: string | null;
  /** Issue id the store last refused. */
  refusalId?: string | null;
  refusal?: Refusal | null;
  onDismissRefusal?: () => void;
}) {
  const session = useSession();
  const shown = limit === undefined ? cards : cards.slice(0, limit);
  const hidden = cards.length - shown.length;

  const affordance: ColumnAffordance | null = dragging
    ? columnAffordance(dragging.issue, status)
    : null;

  const { setNodeRef, isOver } = useDroppable({
    id: `column:${status}`,
    data: { status },
    disabled: affordance ? !affordance.droppable : false,
  });

  return (
    <section
      ref={setNodeRef}
      data-status={status}
      data-board-column={status}
      data-affordance={affordance?.tone}
      data-over={isOver ? "true" : undefined}
      // Fixed width, not min-width: a column has to be a stable target for a drop and a
      // stable unit for horizontal scrolling, and a long title must wrap inside it
      // rather than widen it into its neighbour.
      className={cn(
        "flex w-[15rem] shrink-0 flex-col gap-2 rounded-md border border-transparent p-1 transition-colors",
        // Dimmed, not disabled. Let go here anyway and the store will say why.
        affordance?.tone === "unlikely" && "opacity-45",
        affordance?.tone === "self" && "opacity-60",
        affordance?.tone === "caution" && "border-dashed border-[var(--status-task-blocked)]/50",
        isOver && affordance?.droppable && "border-ring bg-accent/40 opacity-100",
      )}
      aria-label={`${status} (${cards.length})`}
    >
      <h3 className="flex items-center gap-1.5 px-1 text-[11px] font-semibold tracking-[var(--tracking-eyebrow)] uppercase text-[var(--sc)]">
        {status}
        <span className="font-normal text-muted-foreground">{cards.length}</span>
        {affordance?.reason && affordance.tone !== "self" ? (
          <span
            data-affordance-reason
            className="ml-auto truncate text-[10px] font-normal normal-case tracking-normal text-muted-foreground"
            title={affordance.reason}
          >
            {affordance.reason}
          </span>
        ) : null}
      </h3>
      <div className="flex min-h-[2rem] flex-col gap-1.5">
        {shown.map(({ workspace, issue, claim }) => (
          <DraggableIssueCard
            key={issue.id}
            card={{ workspace, issue, claim }}
            showWorkspace={session.mode === "hub"}
            selected={session.selection?.ref === issue.identifier}
            pending={pendingId === issue.id}
            refusal={refusalId === issue.id ? (refusal ?? null) : null}
            onDismissRefusal={onDismissRefusal ?? (() => undefined)}
            onOpen={session.open}
          />
        ))}
        {hidden > 0 ? <div className="px-1 text-[11px] text-muted-foreground">… {hidden} more</div> : null}
      </div>
    </section>
  );
}
