/**
 * Where the detail's scroll goes when the reader switches tabs. Pure, so the rule is tested
 * without a browser; DetailTabs only measures and applies it.
 *
 * THE BUG THIS ANSWERS. Radix unmounts the inactive tab, and a tab that fetches its own data
 * (Activity, For agents, Connections) first renders a three-row skeleton. For one frame the
 * scroller's content is shorter than the scroller itself, the browser clamps `scrollTop` to 0,
 * and when the data lands a moment later nothing scrolls it back: the reader who had scrolled
 * down to the tab strip is thrown to the top of the task. A tab that is simply short does the
 * same thing more quietly: it clamps, and the strip slides down the screen.
 *
 * THE RULE, in two halves:
 *
 *  - The tab area always reserves the scroller's height below the strip
 *    (`tabPanelReserve`), so no tab, loading or short, can make the content too short for the
 *    strip to stay where it is. Nothing is clamped, so nothing jumps.
 *  - If the strip was stuck (scrolled to the top of the panel), the new tab starts right under
 *    it: the scroll moves to the point where the strip just sticks, not to wherever the old
 *    tab's scroll happened to be. If the strip was still in view below the top, the scroll is
 *    left exactly where it was (`scrollAfterTabSwitch` returns null).
 */

/** Minimum height of the tab panels, in px: the scroller's height less the strip's own. */
export function tabPanelReserve(scrollerHeight: number, stripHeight: number): number {
  return Math.max(0, Math.round(scrollerHeight - stripHeight));
}

/**
 * The scrollTop to apply after a tab switch, or null to leave the scroll alone.
 *
 * `stickAt` is the scroller's scrollTop at which the strip just sticks: the zero-height
 * sentinel's offset from the top of the scroller's content. `scrollTop` is where the reader
 * was when they chose the tab.
 */
export function scrollAfterTabSwitch(scrollTop: number, stickAt: number): number | null {
  // Half a pixel of slack: a strip resting exactly at the top is stuck.
  return scrollTop >= stickAt - 0.5 ? Math.max(0, stickAt) : null;
}
