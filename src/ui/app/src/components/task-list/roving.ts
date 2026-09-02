/**
 * "The list is exactly ONE tab stop" — R4 (STA-102), extracted from TreeGrid.
 *
 * Roving `tabIndex`: exactly one element in the list is tabbable, and the arrow keys move
 * which one. Every list in this app owes a user that contract, and there is nothing about
 * it that is specific to a tree — so it lives here, taking a flat array of keys, and both
 * the treegrid (whose keys interleave group headers with rows) and the flat list use it.
 *
 * Two behaviours that look like details and are not:
 *
 *   THE FOCUSED KEY CAN VANISH UNDER YOU. A row resolves away, a group empties, a filter
 *   changes. Falling back to the first key rather than to `null` is what keeps the list
 *   reachable by Tab at all — a list with no tabbable element is a list a keyboard user
 *   cannot enter.
 *
 *   FOCUS MOVES ONLY WHEN ASKED. `go()` sets a flag that the effect consumes; a re-render
 *   that merely changes which key is active must NOT steal focus from wherever the user
 *   actually is. Calling `.focus()` unconditionally in the effect is the standard way this
 *   hook goes wrong, and it presents as the page yanking focus back every 1.5s on the poll.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface RovingFocus {
  /** The key that currently holds `tabIndex=0`. Null only when the list is empty. */
  activeKey: string | null;
  /** Move the tab stop AND move real DOM focus there. */
  go: (key: string) => void;
  /** Move the tab stop without touching focus — for `onFocus`, which has already moved it. */
  set: (key: string) => void;
  /** `ref` callback factory: `<div ref={register(key)} />`. */
  register: (key: string) => (element: HTMLElement | null) => void;
}

export function useRovingFocus(keys: readonly string[]): RovingFocus {
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const moveFocus = useRef(false);

  const activeKey = focusKey && keys.includes(focusKey) ? focusKey : (keys[0] ?? null);

  useEffect(() => {
    if (!moveFocus.current || !activeKey) return;
    moveFocus.current = false;
    elements.current.get(activeKey)?.focus();
  }, [activeKey]);

  const go = useCallback((key: string) => {
    moveFocus.current = true;
    setFocusKey(key);
  }, []);

  const register = useCallback(
    (key: string) => (element: HTMLElement | null) => {
      if (element) elements.current.set(key, element);
      else elements.current.delete(key);
    },
    [],
  );

  return { activeKey, go, set: setFocusKey, register };
}

/** Clamp an index into a list — the move every arrow key makes. */
export function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}
