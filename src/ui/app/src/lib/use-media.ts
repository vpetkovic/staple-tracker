/**
 * One media-query hook for the shell, so every breakpoint decision reads the same way.
 *
 * `useSyncExternalStore` with the SAME reader for the client and the server snapshot: a real
 * server has no `window` and gets `fallback`, while a test that stubs `window.matchMedia`
 * (the way `view-responsive.test.tsx` does) gets the width it asked for from a string
 * render. That is what keeps the desktop and the phone layouts testable without a DOM.
 */
import { useCallback, useSyncExternalStore } from "react";

/** The shell's breakpoints. Phone below `desk`; labels on the toolbar from `roomy`. */
export const DESK_QUERY = "(min-width: 768px)";
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
