/**
 * Phone Back closes what is open on top of the page — a sheet, a drawer, a menu — instead
 * of acting on the page underneath (or leaving the app).
 *
 * Opening an overlay pushes one history entry at the SAME address, tagged with the
 * overlay's id. Back pops it: every mounted overlay hears `popstate`, and the one whose
 * entry is no longer current closes. Overlays stack naturally: Back closes the top one,
 * the one beneath still finds its own entry current and stays open. Closing from the UI
 * (a close button, Escape, a tap outside) consumes the entry with `history.back()`, so no
 * dead Back step is left behind. The address never changes, so the app's own URL listener
 * re-reads the same view and filters and writes nothing.
 */
import { useEffect, useRef } from "react";

const KEY = "stapleOverlay";
let nextId = 0;

/** The overlay ids on the current history entry, innermost last. */
function openIds(state: unknown): readonly number[] {
  const ids = (state as Record<string, unknown> | null)?.[KEY];
  return Array.isArray(ids) ? (ids as number[]) : [];
}

export function useBackToClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const id = ++nextId;
    const below = openIds(window.history.state);
    window.history.pushState({ ...(window.history.state ?? {}), [KEY]: [...below, id] }, "", window.location.href);
    let closedByBack = false;
    const onPop = (event: PopStateEvent) => {
      if (openIds(event.state).includes(id)) return;
      closedByBack = true;
      window.removeEventListener("popstate", onPop);
      closeRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      // Closed from the UI while our entry is still current: take the entry back out.
      if (!closedByBack && openIds(window.history.state).at(-1) === id) window.history.back();
    };
  }, [open]);
}
