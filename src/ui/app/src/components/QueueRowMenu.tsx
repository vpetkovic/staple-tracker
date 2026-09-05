/**
 * THE ROW'S `⋯`, AS A MENU THAT CAN QUEUE.
 *
 * The tree already knows everything the pickup plan says about a row — `TreeView` fetches
 * `GET /api/queue` to build the row cues (see `row-cues.ts`). Until now that knowledge was
 * read-only on this surface: the row could PRINT `#4` and there was no way to put a task
 * into the plan from the list you were reading it in. You had to go to the Queue view, find
 * the task again by typing its identifier, and add it there.
 *
 * This is the write side, hung on the `⋯` slot `TaskRowLine` has reserved since V5.
 *
 * ── THE ITEMS, AND WHY EACH ONE IS OR IS NOT THERE ────────────────────────────────────
 *
 *   OPEN DETAILS — first, and always present. It is what the `⋯` did before this menu
 *   existed, and a control that silently stops doing its old job is worse than one that
 *   never did it.
 *
 *   QUEUE NEXT — `enqueue --at 1`. "Do this before everything else I have planned."
 *   Not a second write path: it is the same `POST /api/queue/enqueue` the Queue view's add
 *   box sends, with the position argument the wire has always accepted.
 *
 *   ADD TO QUEUE — `enqueue` with no position, which appends. "Do this eventually."
 *
 *   REMOVE FROM QUEUE — shown INSTEAD of the two above once the row is in the plan. Not
 *   shown alongside them and greyed: a queued row cannot be queued again (the store answers
 *   a replay with `replayed: true` and no write), so offering it would be offering a no-op.
 *
 * ── WHY REMOVAL IS REFUSED ONCE THE WORK HAS STARTED ──────────────────────────────────
 *
 * A task somebody is actively holding is not a plan any more — it is work in progress, and
 * quietly dropping it out of the order behind the holder's back is how an agent ends up
 * finishing something nobody can find. So the item is DISABLED and it SAYS SO, naming the
 * holder. The primitive requires the sentence (see `dropdown-menu.tsx`): a disabled item
 * with no reason tells a reader the thing is possible and refuses to say what is in the way.
 *
 * It is a REFUSAL TO OFFER, not a permission check. The store is still the authority — a
 * removal that raced a checkout is refused there, and `GuardRefusal` says so. This only
 * stops the UI from advertising an action it can see will fail.
 */
import { ArrowDownToLine, ArrowUpRight, ArrowUpToLine, ListPlus, ListX, SquareArrowUp } from "lucide-react";
import type { ReactNode } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { statusCategory } from "@/lib/settings";
import type { TaskRow } from "@/components/task-list";

/** What the menu may offer for one row, and what it must refuse. */
export interface QueueRowMenuState {
  /** Is this row a PLAN ENTRY — a thing a human queued, which is what "remove" removes. */
  queued: boolean;
  /** Somebody is holding it: removal is refused and this is why. Null when it is free. */
  heldBy: string | null;
}

/**
 * The state of one row against the plan, with no derivation the queue would disagree about.
 *
 * `queuedIds` is the PLAN's identifiers — `entries` — and deliberately not `effective`. A
 * row can be in the effective order because an ancestor was queued, and "remove from queue"
 * on such a row would be a lie: there is no entry of its own to remove, and dequeuing the
 * ancestor is a much larger act than the menu item implies. Those rows get the ADD items
 * instead, which is honest — queueing them explicitly is exactly how docs/queue.md says you
 * pull one child out in front of its siblings.
 *
 * A SET, built once by the caller, rather than a scan per row: this is called for every
 * rendered row of an unvirtualised list on a 1.5s poll.
 *
 * `heldBy` is the row's own `checkoutAgent` plus the `active` category, which is the same
 * pair `store.queue()`'s ladder uses to call a row `claimed`. Reading the row rather than
 * the queue is deliberate: the menu must answer for a row that is not in the plan at all
 * and therefore has no effective row to consult.
 */
export function queueRowMenuState(
  row: Pick<TaskRow, "issue">,
  queuedIds: ReadonlySet<string>,
): QueueRowMenuState {
  const active = statusCategory(row.issue.status) === "active";
  return {
    queued: queuedIds.has(row.issue.identifier),
    heldBy: active ? row.issue.checkoutAgent ?? "someone" : null,
  };
}

export function QueueRowMenu({
  trigger,
  identifier,
  state,
  disabled,
  onOpen,
  onQueueNext,
  onQueueLast,
  onDequeue,
  onMoveToTop,
  onMoveToBottom,
}: {
  /** The ready-made `⋯` button `TaskRowLine` hands us. */
  trigger: ReactNode;
  /** The only thing this component needed off the row — the caller keeps the row. */
  identifier: string;
  state: QueueRowMenuState;
  /** A write is already in flight; the plan's revision is not safe to build on. */
  disabled: boolean;
  onOpen: () => void;
  onQueueNext: () => void;
  onQueueLast: () => void;
  onDequeue: () => void;
  /**
   * REORDERING, offered only where there is an order on screen to reorder — the Queue view.
   * The tree passes neither: it lists work by status or by presentation sort, and a "move to
   * top" there would silently rearrange a plan the reader cannot see.
   */
  onMoveToTop?: () => void;
  onMoveToBottom?: () => void;
}) {
  const held = state.heldBy;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent aria-label={`Actions for ${identifier}`} data-queue-row-menu={identifier}>
        <DropdownMenuItem data-menu-item="open" onSelect={onOpen}>
          <ArrowUpRight aria-hidden />
          Open details
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {state.queued && onMoveToTop ? (
          <DropdownMenuItem data-menu-item="move-top" disabled={disabled} onSelect={onMoveToTop}>
            <ArrowUpToLine aria-hidden />
            Move to top
          </DropdownMenuItem>
        ) : null}
        {state.queued && onMoveToBottom ? (
          <DropdownMenuItem data-menu-item="move-bottom" disabled={disabled} onSelect={onMoveToBottom}>
            <ArrowDownToLine aria-hidden />
            Move to bottom
          </DropdownMenuItem>
        ) : null}
        {state.queued ? (
          <DropdownMenuItem
            data-menu-item="dequeue"
            disabled={disabled || held !== null}
            reason={held ? `In flight — ${held} is working on ${identifier}` : undefined}
            onSelect={onDequeue}
          >
            <ListX aria-hidden />
            Remove from queue
          </DropdownMenuItem>
        ) : (
          <>
            <DropdownMenuItem data-menu-item="queue-next" disabled={disabled} onSelect={onQueueNext}>
              <SquareArrowUp aria-hidden />
              Queue next
            </DropdownMenuItem>
            <DropdownMenuItem data-menu-item="queue-last" disabled={disabled} onSelect={onQueueLast}>
              <ListPlus aria-hidden />
              Add to queue
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
