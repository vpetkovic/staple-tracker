/**
 * Phone Back closes what is open on top of the page — a sheet, a drawer, a menu — instead
 * of acting on the page underneath (or leaving the app).
 *
 * Opening an overlay pushes one history entry at the SAME address, tagged with the
 * overlay's id. Back pops it: every mounted overlay hears `popstate`, and the one whose
 * entry is no longer current closes. Overlays stack naturally: Back closes the top one,
 * the one beneath still finds its own entry current and stays open. Closing from the UI
 * (a close button, Escape, a tap outside) takes the entry — and any overlay entry above
 * it — back out, so no dead Back step is left behind.
 *
 * ── ONE QUEUE FOR EVERY HISTORY WRITE ─────────────────────────────────────────────────
 *
 * `history.back()` is asynchronous: the entry is still current until the browser gets to
 * it. A `pushState` issued in that window lands on the wrong side of the traversal — close
 * the drawer and open Settings in one tap, and Settings' entry would be pushed on top of the
 * drawer's and then popped by the drawer's own Back. So every traversal this module starts
 * is counted, and every history write the app makes (`afterHistorySettles`) waits until
 * the traversals it started have arrived. `isOwnTraversal()` lets a `popstate` listener
 * tell those arrivals from the person pressing Back.
 *
 * ── NAVIGATING WITH AN OVERLAY OPEN ───────────────────────────────────────────────────
 *
 * Going to another view or workspace while an overlay is open (a view tab under a menu, a
 * palette command) closes the overlays FIRST — `leaveOverlays` steps back past their
 * entries — and only then pushes the new page, so Back from the new page returns to the
 * old page rather than to a stale overlay entry of it.
 *
 * ── REPLACING KEEPS THE TAG ───────────────────────────────────────────────────────────
 *
 * A filter tweak replaces the current entry. `replaceUrl` keeps `history.state` — the
 * overlay ids on it — so narrowing the list under an open menu does not orphan the menu's
 * entry.
 */
import { useEffect, useRef } from "react";

const KEY = "stapleOverlay";
/** Unique across page loads: a reload keeps `history.state`, and a reused id would never close. */
const SESSION = Math.random().toString(36).slice(2, 8);
let nextId = 0;

/** The overlay ids on a history state, innermost last. */
export function openIds(state: unknown): readonly string[] {
  const ids = (state as Record<string, unknown> | null)?.[KEY];
  return Array.isArray(ids) ? (ids as string[]) : [];
}

/** A fresh overlay id. */
function newId(): string {
  nextId += 1;
  return `${SESSION}:${nextId}`;
}

// ---------------------------------------------------------------- the traversal queue

let pending = 0;
let queue: (() => void)[] = [];
let ownPop = false;
let safety: ReturnType<typeof setTimeout> | undefined;
let installed = false;

function flush(): void {
  // One at a time: a queued write may itself start a traversal, and the rest wait for it.
  while (pending === 0 && queue.length > 0) queue.shift()!();
}

function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;
  // Capture, so the bookkeeping runs before any other `popstate` listener reads it.
  window.addEventListener(
    "popstate",
    () => {
      if (pending === 0) return;
      pending -= 1;
      ownPop = true;
      // Every other listener for this event runs before the timer: the flag describes
      // exactly this event, and the queue runs once the app has reacted to it.
      setTimeout(() => {
        ownPop = false;
        if (pending === 0) {
          clearTimeout(safety);
          flush();
        }
      }, 0);
    },
    true,
  );
}

/** Step `delta` entries through history, counted so writes queued behind it wait. */
function traverse(delta: number): void {
  if (delta === 0 || typeof window === "undefined") return;
  install();
  pending += 1;
  window.history.go(delta);
  // A traversal that never arrives (the browser refused it) must not wedge the queue.
  clearTimeout(safety);
  safety = setTimeout(() => {
    pending = 0;
    ownPop = false;
    flush();
  }, 1000);
}

/** Run `fn` now, or once the traversals this module started have landed. */
export function afterHistorySettles(fn: () => void): void {
  install();
  if (pending === 0) fn();
  else queue.push(fn);
}

/** Is the `popstate` being handled one this module caused (not the person pressing Back)? */
export function isOwnTraversal(): boolean {
  return ownPop;
}

/** Replace the current entry's address, keeping its state — the overlay ids on it. */
export function replaceUrl(href: string): void {
  window.history.replaceState(window.history.state, "", href);
}

/**
 * Push an overlay entry at `href` (the same address unless given) and return its id. For an
 * overlay whose open state lives in the URL (Settings); `useBackToClose` is the usual way in.
 * Call it through `afterHistorySettles`.
 */
export function pushOverlayEntry(href: string = window.location.href): string {
  const id = newId();
  const below = openIds(window.history.state);
  window.history.pushState({ ...(window.history.state ?? {}), [KEY]: [...below, id] }, "", href);
  return id;
}

/** Is this overlay's entry still in the current entry's stack? */
export function overlayEntryIsOpen(id: string): boolean {
  return openIds(window.history.state).includes(id);
}

/**
 * Step back past overlay `id`'s entry and every overlay entry above it: the overlays above
 * hear their own Back and close with it. Nothing to do when the entry is already gone.
 */
export function popOverlay(id: string): void {
  afterHistorySettles(() => {
    const ids = openIds(window.history.state);
    const at = ids.indexOf(id);
    if (at >= 0) traverse(-(ids.length - at));
  });
}

/**
 * Close every overlay by stepping back past all of their entries, then run `then` — the
 * navigation that was waiting for a clean page to push onto.
 */
export function leaveOverlays(then: () => void): void {
  afterHistorySettles(() => {
    const count = openIds(window.history.state).length;
    if (count > 0) traverse(-count);
    afterHistorySettles(then);
  });
}

/**
 * The hook every overlay uses: while `open`, Back closes it. `close` is what the overlay
 * does to close itself; it is called only when the person pressed Back (or another
 * overlay's close stepped past this one).
 */
export function useBackToClose(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;

  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    let id: string | null = null;
    let cancelled = false;
    let closedByBack = false;
    const onPop = () => {
      if (id === null || overlayEntryIsOpen(id)) return;
      closedByBack = true;
      window.removeEventListener("popstate", onPop);
      closeRef.current();
    };
    afterHistorySettles(() => {
      if (cancelled) return;
      id = pushOverlayEntry();
      window.addEventListener("popstate", onPop);
    });
    return () => {
      cancelled = true;
      window.removeEventListener("popstate", onPop);
      // Closed from the UI while our entry is still there: take it (and anything above) out.
      if (id !== null && !closedByBack) popOverlay(id);
    };
  }, [open]);
}
