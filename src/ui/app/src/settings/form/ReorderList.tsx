/**
 * A REORDERABLE LIST — R6c (STA-178). Lifted out of VocabularyList so the reorder
 * path exists once, for any settings list.
 *
 * ── DRAG, PLUS A REAL KEYBOARD PATH ───────────────────────────────────────────────────
 *
 * The drag is `@dnd-kit/core`; `@dnd-kit/sortable` is not installed and no ticket may
 * add a dependency, so each row is its own droppable and the drop target is whichever
 * row the pointer is over — for a single column that is what sortable computes anyway.
 *
 * The keyboard path is a pair of VISIBLE, LABELLED buttons on every row, plus alt+arrow
 * on the row itself; not dnd-kit's keyboard sensor, which is a mode you have to know
 * exists. Both produce the same `onMove(from, to)`, so there is one write path.
 *
 * ── FOCUS RECOVERY ────────────────────────────────────────────────────────────────────
 *
 * Moving a row re-renders the list and, at either end, DISABLES the button that was
 * just pressed — and focus on a disabled button is focus dropped on the body, which
 * for a keyboard user is the list vanishing. So every keyboard move records where
 * focus should land (`reorderFocusTarget`: the same button, or the other one at an
 * end) and the effect after the re-render puts it there. The row keeps its identity
 * across the move (`data-reorder-row` is the id), so the query finds the moved row
 * wherever it went.
 */
import { useCallback, useEffect, useRef, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";

/**
 * THE WIDTH OF THE HANDLE COLUMN, so `renderBelow` can line up with `renderItem`.
 *
 * `p-1` (4px each side) around a `size-3.5` (14px) grip is 22px, and the row's `gap-2` adds
 * 8. Anything rendered BELOW a row means below its CONTENT — a caller drawing a nested list
 * under an entry expects it to hang off that entry, not off the drag handle to its left.
 * Without this the queue's expansion sat 30px left of the row it belonged to, which put every
 * child's elbow 30px left of the parent chevron it is supposed to hang from.
 *
 * It is a constant rather than a class because the two numbers it adds up are in the handle's
 * own className, and a second literal `pl-[30px]` somewhere else is how they drift apart.
 */
const HANDLE_COLUMN_PX = 22 + 8;
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reorderFocusTarget, type ReorderControl } from "./form-model";

export interface ReorderListProps<T> {
  items: readonly T[];
  getId: (item: T) => string;
  /** The accessible name of the row's controls: "Move Todo up". */
  getLabel: (item: T) => string;
  disabled?: boolean;
  onMove: (from: number, to: number) => void;
  /** The row's own content, between the handle and the move buttons. */
  renderItem: (item: T, index: number) => ReactNode;
  /** Below the row's main line: a confirmation panel, an error. */
  renderBelow?: (item: T, index: number) => ReactNode;
  /** Trailing per-row controls, after the move buttons (e.g. Remove). */
  renderActions?: (item: T, index: number) => ReactNode;
  /** Marks a row, e.g. the one a refusal named. */
  rowState?: (item: T) => { invalid?: boolean; dirty?: boolean } | undefined;
}

function Row<T>({
  item,
  index,
  count,
  id,
  label,
  disabled,
  state,
  onMoveBy,
  renderItem,
  renderBelow,
  renderActions,
}: {
  item: T;
  index: number;
  count: number;
  id: string;
  label: string;
  disabled: boolean;
  state: { invalid?: boolean; dirty?: boolean } | undefined;
  onMoveBy: (index: number, control: ReorderControl, id: string) => void;
  renderItem: ReorderListProps<T>["renderItem"];
  renderBelow?: ReorderListProps<T>["renderBelow"];
  renderActions?: ReorderListProps<T>["renderActions"];
}) {
  const draggable = useDraggable({ id, disabled });
  const droppable = useDroppable({ id, disabled });
  return (
    <div
      ref={droppable.setNodeRef}
      role="listitem"
      data-reorder-row={id}
      data-invalid={state?.invalid ? "" : undefined}
      data-dirty={state?.dirty ? "" : undefined}
      // alt+arrow, not bare arrow: bare arrows belong to whatever field has focus, and a
      // list that stole them would make a label field unnavigable.
      onKeyDown={(event) => {
        if (!event.altKey || disabled) return;
        if (event.key === "ArrowUp") {
          event.preventDefault();
          onMoveBy(index, "up", id);
        } else if (event.key === "ArrowDown") {
          event.preventDefault();
          onMoveBy(index, "down", id);
        }
      }}
      className={cn(
        "flex flex-col gap-2 rounded-md border px-2 py-1.5",
        droppable.isOver && !draggable.isDragging ? "border-ring bg-surface-hover" : "border-transparent",
        state?.invalid && "border-[var(--status-task-blocked)]",
        draggable.isDragging && "opacity-50",
      )}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          ref={draggable.setNodeRef}
          {...draggable.listeners}
          {...draggable.attributes}
          aria-label={`Drag ${label} to reorder`}
          title="Drag to reorder"
          className="shrink-0 cursor-grab rounded p-1 text-text-tertiary hover:bg-surface-hover hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-3.5" aria-hidden />
        </button>

        {renderItem(item, index)}

        {/*
          THE KEYBOARD ALTERNATIVE. Two ordinary buttons, always present, never a
          hover-reveal: an affordance that only exists once you have already pointed at
          the row is not an alternative to pointing at the row.
        */}
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon"
            data-reorder-control="up"
            aria-label={`Move ${label} up`}
            disabled={disabled || index === 0}
            onClick={() => onMoveBy(index, "up", id)}
          >
            <ChevronUp className="size-3.5" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            data-reorder-control="down"
            aria-label={`Move ${label} down`}
            disabled={disabled || index === count - 1}
            onClick={() => onMoveBy(index, "down", id)}
          >
            <ChevronDown className="size-3.5" aria-hidden />
          </Button>
          {renderActions?.(item, index)}
        </div>
      </div>
      {renderBelow ? (
        <div style={{ paddingLeft: HANDLE_COLUMN_PX }}>{renderBelow(item, index)}</div>
      ) : null}
    </div>
  );
}

export function ReorderList<T>({
  items,
  getId,
  getLabel,
  disabled = false,
  onMove,
  renderItem,
  renderBelow,
  renderActions,
  rowState,
}: ReorderListProps<T>) {
  const root = useRef<HTMLDivElement>(null);
  /** Where focus goes once the move has re-rendered. Null when the move was a drag. */
  const pendingFocus = useRef<{ id: string; control: ReorderControl } | null>(null);

  const sensors = useSensors(
    // 4px so a click on the handle is still a click; without it every press starts a drag
    // and the button's own focus ring never appears.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const ids = items.map(getId);

  const onDragEnd = useCallback(
    (event: DragEndEvent) => {
      const over = event.over?.id;
      if (!over || over === event.active.id) return;
      const from = ids.indexOf(String(event.active.id));
      const to = ids.indexOf(String(over));
      if (from === -1 || to === -1) return;
      onMove(from, to);
    },
    [ids, onMove],
  );

  const onMoveBy = useCallback(
    (index: number, control: ReorderControl, id: string) => {
      const to = control === "up" ? index - 1 : index + 1;
      if (to < 0 || to >= items.length) return;
      pendingFocus.current = reorderFocusTarget({ id, index: to, count: items.length, control });
      onMove(index, to);
    },
    [items.length, onMove],
  );

  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    root.current
      ?.querySelector<HTMLButtonElement>(
        `[data-reorder-row="${target.id}"] [data-reorder-control="${target.control}"]`,
      )
      ?.focus({ preventScroll: true });
  });

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div ref={root} role="list" data-reorder-list className="space-y-0.5">
        {items.map((item, index) => (
          <Row
            key={ids[index]}
            item={item}
            index={index}
            count={items.length}
            id={ids[index]!}
            label={getLabel(item)}
            disabled={disabled}
            state={rowState?.(item)}
            onMoveBy={onMoveBy}
            renderItem={renderItem}
            renderBelow={renderBelow}
            renderActions={renderActions}
          />
        ))}
      </div>
    </DndContext>
  );
}
