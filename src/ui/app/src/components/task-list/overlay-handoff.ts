/**
 * Open one overlay FROM another — "Open details" in a row menu — without leaving a dead
 * Back step behind.
 *
 * Each overlay holds one history entry (lib/back-to-close.ts). Closing the menu from the UI
 * takes its entry back out with `history.back()`, which is asynchronous. If the detail opens
 * in the same render, its `pushState` lands before that traversal runs, the browser drops the
 * pending back, and the menu's entry is stranded under the detail: after closing the detail
 * the reader presses Back once for nothing.
 *
 * So the second overlay waits for the first one's entry to be gone: the `popstate` that
 * `history.back()` raises, or a short timeout when there was no entry to take out.
 */
export const HANDOFF_FALLBACK_MS = 250;

export function afterOverlayCloses(run: () => void, target: Pick<Window, "addEventListener" | "removeEventListener"> = window): void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const go = () => {
    if (done) return;
    done = true;
    target.removeEventListener("popstate", go);
    if (timer !== null) clearTimeout(timer);
    run();
  };
  target.addEventListener("popstate", go);
  timer = setTimeout(go, HANDOFF_FALLBACK_MS);
}
