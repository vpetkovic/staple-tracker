/**
 * Is the content header in its compact form — words dropped, controls as icon buttons with
 * tooltips, the search field folded into an icon? True below 768px, the same breakpoint the
 * rail uses to become a sheet, so the two halves of the shell change register together.
 *
 * Both snapshots read the same thing. A real server has no `window` and answers wide; a
 * test that stubs `window.matchMedia` the way `view-responsive.test.tsx` does gets the width
 * it asked for from a static render, because `renderToStaticMarkup` takes the server
 * snapshot — and a server snapshot that ignored the stub would make the compact header
 * untestable.
 */
import { useSyncExternalStore } from "react";

const WIDE_QUERY = "(min-width: 768px)";

function readCompact(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return !window.matchMedia(WIDE_QUERY).matches;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

export function useCompactHeader(): boolean {
  return useSyncExternalStore(subscribe, readCompact, readCompact);
}
