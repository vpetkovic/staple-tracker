/**
 * A board card you can pick up — owned by U6 (views/board/).
 *
 * IssueCard is shared by the inbox, the board and the detail panel, so this wraps it
 * rather than forking it: the drag handle is the wrapper, and the card underneath stays
 * the same button that opens the detail panel.
 *
 * DRAG VS CLICK. The pointer sensor only activates after 6px of movement, so a plain
 * click never becomes a drag and still reaches the card's own onClick. That number is
 * the whole reason a board card can be both a link and a draggable object.
 *
 * KEYBOARD. There is deliberately no KeyboardSensor here. dnd-kit's keyboard drag needs
 * the draggable itself to be a tab stop, which would put a second tabbable wrapper
 * around every card and turn a 30-card board into 60 tab stops. The keyboard path to a
 * status change is the cmd-K palette (U7/STA-19), which is a better one anyway.
 */
import { useDraggable } from "@dnd-kit/core";
import { IssueCard } from "@/components/IssueCard";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { BoardCard } from "./BoardColumn";
import { GuardRefusal } from "./GuardRefusal";
import type { Refusal } from "./refusal";

export function DraggableIssueCard({
  card,
  showWorkspace,
  selected,
  pending,
  refusal,
  onDismissRefusal,
  onOpen,
}: {
  card: BoardCard;
  showWorkspace: boolean;
  selected: boolean;
  /** A status change for this card is in flight. */
  pending: boolean;
  /** Set once the store has refused this card's last drop. */
  refusal: Refusal | null;
  onDismissRefusal: () => void;
  onOpen: (workspace: string, ref: string) => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: card.issue.id,
    data: { card },
  });

  const body = (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      // The wrapper is the drag handle, not a control: the card inside it is the
      // interactive element, and two nested roles would confuse a screen reader.
      role={undefined}
      tabIndex={undefined}
      className={cn(
        "touch-none",
        // The DragOverlay renders the real preview, so the original just gets out of
        // the way rather than disappearing (its column must keep its height).
        isDragging && "opacity-30",
        pending && "animate-pulse",
      )}
    >
      <IssueCard
        workspace={card.workspace}
        issue={card.issue}
        claim={card.claim}
        showWorkspace={showWorkspace}
        selected={selected}
        onOpen={onOpen}
        className={cn(refusal && "border-[var(--status-task-blocked)]")}
      />
    </div>
  );

  if (!refusal) return body;

  return (
    // Anchored, portalled, and clipped by nothing: the board scrolls horizontally, and
    // a panel positioned inside a column would be cut off by that scroll container.
    <Popover open onOpenChange={(open) => (open ? undefined : onDismissRefusal())}>
      <PopoverAnchor asChild>{body}</PopoverAnchor>
      <PopoverContent
        side="right"
        align="start"
        className="w-[20rem] border-[var(--status-task-blocked)]/50 p-3"
        // Keep focus on the board. The refusal is information, not a dialog to escape.
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <GuardRefusal refusal={refusal} onDismiss={onDismissRefusal} />
      </PopoverContent>
    </Popover>
  );
}
