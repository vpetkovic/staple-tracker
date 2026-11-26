/**
 * Dragging a plan entry by its number: pointer events, so a mouse, a pen and a finger are one
 * path (the handle sets `touch-action: none`, so a drag on a phone moves the entry instead of
 * scrolling the page). A 2px line shows where it lands; letting go ends in the section's
 * `move(from, to)`, the same write the keyboard and the menu use. Entries move only inside
 * their own section's list.
 *
 * Settings' `ReorderList` stays as it is: its handle and arrow buttons are not this row.
 */
import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** How far the pointer travels before a press on the handle becomes a drag. */
const DRAG_THRESHOLD_PX = 4;

/**
 * The slot (0..n) a pointer at `y` drops into: before the first entry whose row's middle is
 * below the pointer, or after the last. `rows` are the entry rows' tops and heights.
 */
export function dropSlot(y: number, rows: ReadonlyArray<{ top: number; height: number }>): number {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (y < row.top + row.height / 2) return i;
  }
  return rows.length;
}

/** The index an entry taken from `from` lands at when dropped in `slot`. */
export function dropTarget(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}

export interface EntryDrag {
  /** The entry being dragged and the slot its line marks, while a drag is on. */
  from: number | null;
  /** The drop line's offset from the top of the list, in px; null when no drag is on. */
  lineTop: number | null;
  handleProps: (index: number) => {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  };
}

/** The entry blocks of one list, and the row at the top of each. */
function entryRows(list: HTMLElement): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(":scope > [data-queue-entry-block] > [data-queue-entry]")];
}

export function useEntryDrag(
  list: RefObject<HTMLElement | null>,
  { disabled, onMove }: { disabled: boolean; onMove: (from: number, to: number) => void },
): EntryDrag {
  const [state, setState] = useState<{ from: number; lineTop: number | null } | null>(null);
  const press = useRef<{ from: number; y: number; moved: boolean; slot: number; pointer: number } | null>(null);

  const end = useCallback(
    (commit: boolean) => {
      const current = press.current;
      press.current = null;
      setState(null);
      if (!commit || !current || !current.moved) return;
      const to = dropTarget(current.from, current.slot);
      if (to !== current.from) onMove(current.from, to);
    },
    [onMove],
  );

  const handleProps = useCallback(
    (index: number) => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        if (disabled || (event.pointerType === "mouse" && event.button !== 0)) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        press.current = { from: index, y: event.clientY, moved: false, slot: index, pointer: event.pointerId };
      },
      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const current = press.current;
        const root = list.current;
        if (!current || current.pointer !== event.pointerId || !root) return;
        if (!current.moved && Math.abs(event.clientY - current.y) < DRAG_THRESHOLD_PX) return;
        current.moved = true;
        const rows = entryRows(root);
        const rects = rows.map((row) => row.getBoundingClientRect());
        const slot = dropSlot(event.clientY, rects);
        current.slot = slot;
        const listTop = root.getBoundingClientRect().top;
        const blocks = rows.map((row) => row.parentElement!.getBoundingClientRect());
        const edge = slot < blocks.length ? blocks[slot]!.top : (blocks.at(-1)?.bottom ?? listTop);
        setState({ from: current.from, lineTop: edge - listTop });
        // Near the scroller's edges, scroll so a long plan can be crossed in one drag.
        const scroller = root.closest<HTMLElement>("[data-queue-board]");
        if (scroller) {
          const box = scroller.getBoundingClientRect();
          if (event.clientY < box.top + 64) scroller.scrollBy({ top: -18 });
          else if (event.clientY > box.bottom - 40) scroller.scrollBy({ top: 18 });
        }
      },
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        if (press.current?.pointer === event.pointerId) end(true);
      },
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => {
        if (press.current?.pointer === event.pointerId) end(false);
      },
    }),
    [disabled, end, list],
  );

  return { from: state?.from ?? null, lineTop: state?.lineTop ?? null, handleProps };
}
