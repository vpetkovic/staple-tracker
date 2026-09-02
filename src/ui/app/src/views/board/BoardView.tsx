/**
 * The kanban board — the entry point of the board module (views/board/), owned by U6.
 *
 * Everything the board needs is inside this directory: the view, the column, the guards
 * and the refusal panel. Drag-and-drop lands here without touching a shared file, which
 * is the whole reason it is a directory rather than one more file next to the other
 * views.
 *
 * WHAT THE DRAG IS FOR (STA-18). staple has no transition table — `updateIssue` runs
 * guards at the moment of the write, and the reason a move is illegal exists only as
 * the sentence the store throws. So a drop here is not "validate, then maybe move". It
 * is: move the card optimistically, ask the store, and if the store says no, put the
 * card back and show the store's sentence next to it. The client's own guards (guards.ts)
 * dim columns in advance, but they never suppress a drop and they never supply the
 * reason — a refusal always reads as the store wrote it.
 */
import { DndContext, DragOverlay, PointerSensor, useSensor, useSensors } from "@dnd-kit/core";
import type { DragEndEvent, DragStartEvent } from "@dnd-kit/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { IssueCard } from "@/components/IssueCard";
import { action, AuthError, getIssues } from "@/lib/api";
import { useSession } from "@/lib/session";
import { ISSUE_STATUSES, RESOLVED_STATUSES, type IssueRow, type IssueStatus } from "@/lib/types";
import { useResource } from "@/lib/useStaple";
import { ViewState } from "../ViewChrome";
import { BoardColumn, type BoardCard } from "./BoardColumn";
import { describeRefusal, type Refusal } from "./refusal";

/** Resolved columns show a window, not a history. */
const RESOLVED_COLUMN_LIMIT = 6;

/**
 * A click must not become a drag. Below this, the pointer sensor never activates and the
 * card's own onClick opens the detail panel as it always did.
 */
const DRAG_ACTIVATION_DISTANCE_PX = 6;

/** Long enough to read a blocker list, short enough not to become furniture. */
const REFUSAL_TIMEOUT_MS = 9000;

export function BoardView({ onAuthError }: { onAuthError: (error: AuthError) => void }) {
  const session = useSession();
  const { ws, assignee, version } = session;

  const load = useCallback(() => getIssues({ ws, assignee }), [ws, assignee]);
  const resource = useResource(load, [ws, assignee, version], onAuthError);

  return (
    <ViewState resource={resource} empty="no issues">
      {(rows) => <BoardSurface rows={rows} onAuthError={onAuthError} />}
    </ViewState>
  );
}

interface RefusalState {
  issueId: string;
  refusal: Refusal;
}

function BoardSurface({
  rows,
  onAuthError,
}: {
  rows: IssueRow[];
  onAuthError: (error: AuthError) => void;
}) {
  const session = useSession();
  const [dragging, setDragging] = useState<BoardCard | null>(null);
  /** Where a card has been moved to optimistically, until the server data agrees. */
  const [optimistic, setOptimistic] = useState<Record<string, IssueStatus>>({});
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<RefusalState | null>(null);
  const dismissTimer = useRef<number | undefined>(undefined);

  const dismissRefusal = useCallback(() => {
    window.clearTimeout(dismissTimer.current);
    setRefusal(null);
  }, []);

  useEffect(() => () => window.clearTimeout(dismissTimer.current), []);

  // Retire an optimistic position the moment the fetched data says the same thing. This
  // is what stops a poll from snapping a successful move back for one frame, and it is
  // also what stops a stale override from surviving a change someone else made.
  useEffect(() => {
    setOptimistic((current) => {
      const entries = Object.entries(current);
      if (entries.length === 0) return current;
      const next: Record<string, IssueStatus> = {};
      let changed = false;
      for (const [id, status] of entries) {
        const row = rows.find((r) => r.issue.id === id);
        if (row && row.issue.status === status) changed = true;
        else if (row) next[id] = status;
        else changed = true; // the card left the filtered set; the override is meaningless
      }
      return changed ? next : current;
    });
  }, [rows]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: DRAG_ACTIVATION_DISTANCE_PX },
    }),
  );

  const onDragStart = useCallback(
    (event: DragStartEvent) => {
      dismissRefusal();
      const card = event.active.data.current?.["card"] as BoardCard | undefined;
      setDragging(card ?? null);
    },
    [dismissRefusal],
  );

  const onDragEnd = useCallback(
    async (event: DragEndEvent) => {
      const card = event.active.data.current?.["card"] as BoardCard | undefined;
      setDragging(null);
      const to = event.over?.data.current?.["status"] as IssueStatus | undefined;
      if (!card || !to || to === card.issue.status) return;

      const id = card.issue.id;
      // Move it now. The card is where the user put it while the store thinks.
      setOptimistic((current) => ({ ...current, [id]: to }));
      setPendingId(id);
      try {
        await action({ ws: card.workspace, ref: card.issue.identifier }, { type: "status", status: to });
        session.refresh();
      } catch (error) {
        // A dead token is not a guard. Hand it to the shell rather than rendering it as
        // a reason this transition was illegal.
        if (error instanceof AuthError) {
          onAuthError(error);
          return;
        }
        // Put the card back, then show what the store actually said about it.
        setOptimistic((current) => {
          const next = { ...current };
          delete next[id];
          return next;
        });
        setRefusal({ issueId: id, refusal: describeRefusal(error) });
        window.clearTimeout(dismissTimer.current);
        dismissTimer.current = window.setTimeout(() => setRefusal(null), REFUSAL_TIMEOUT_MS);
      } finally {
        setPendingId((current) => (current === id ? null : current));
      }
    },
    [onAuthError, session],
  );

  const byStatus = new Map<IssueStatus, BoardCard[]>(ISSUE_STATUSES.map((s) => [s, []]));
  for (const row of rows) {
    const status = optimistic[row.issue.id] ?? row.issue.status;
    // `claim` rides straight through from /api/issues. Note it is NOT adjusted for the
    // optimistic status above: a card dragged out of in_progress still carries whatever
    // liveness the server last reported, and the next poll settles both together.
    byStatus.get(status)?.push({ workspace: row.workspace, issue: row.issue, claim: row.claim });
  }

  return (
    <DndContext
      sensors={sensors}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="flex gap-3 overflow-x-auto pb-3">
        {ISSUE_STATUSES.map((status) => (
          <BoardColumn
            key={status}
            status={status}
            cards={byStatus.get(status) ?? []}
            limit={RESOLVED_STATUSES.includes(status) ? RESOLVED_COLUMN_LIMIT : undefined}
            dragging={dragging}
            pendingId={pendingId}
            refusalId={refusal?.issueId ?? null}
            refusal={refusal?.refusal ?? null}
            onDismissRefusal={dismissRefusal}
          />
        ))}
      </div>

      {/* The preview follows the cursor across columns, which a transformed original
          cannot do inside a horizontally scrolling row. */}
      <DragOverlay dropAnimation={null}>
        {dragging ? (
          <div className="w-[14rem] rotate-1 opacity-95 shadow-lg">
            <IssueCard
              workspace={dragging.workspace}
              issue={dragging.issue}
              claim={dragging.claim}
              showWorkspace={session.mode === "hub"}
              onOpen={() => undefined}
            />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
