/**
 * One media-query hook for the shell, so every breakpoint decision reads the same way.
 *
 * `useSyncExternalStore` with the SAME reader for the client and the server snapshot: a real
 * server has no `window` and gets `fallback`, while a test that stubs `window.matchMedia`
 * (the way `view-responsive.test.tsx` does) gets the width it asked for from a string
 * render. That is what keeps the desktop and the phone layouts testable without a DOM.
 */
import { useCallback, useSyncExternalStore } from "react";

/**
 * THE ONE PHONE/DESK BREAKPOINT. Below 768px the page is a phone app (top bar, tab bar,
 * sheets); from 768px it is the desk shell (rail, top bar, toolbar). Every component that
 * changes shape between the two reads it from here — `useIsDesk()` in React, `DESK_QUERY` /
 * `PHONE_QUERY` for a raw `matchMedia`, `DESK_MIN_WIDTH` for arithmetic — so the shell, the
 * rows and the dialogs can never switch at different widths. (Tailwind's `md:` / `max-md:`
 * are the same 768px.)
 */
export const DESK_MIN_WIDTH = 768;
export const DESK_QUERY = `(min-width: ${DESK_MIN_WIDTH}px)`;
export const PHONE_QUERY = `(max-width: ${DESK_MIN_WIDTH - 1}px)`;
/** Labels on the toolbar from here. */
export const ROOMY_QUERY = "(min-width: 1280px)";

export function readMedia(query: string, fallback: boolean): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return fallback;
  return window.matchMedia(query).matches;
}

export function useMediaQuery(query: string, fallback: boolean): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener?.("change", onChange);
      return () => list.removeEventListener?.("change", onChange);
    },
    [query],
  );
  const read = () => readMedia(query, fallback);
  return useSyncExternalStore(subscribe, read, read);
}

/** Is this the desk shell (>= 768px)? True where nothing can answer (a string render). */
export function useIsDesk(): boolean {
  return useMediaQuery(DESK_QUERY, true);
}

/** The same decision for a known width. */
export function isDeskWidth(width: number): boolean {
  return width >= DESK_MIN_WIDTH;
}
