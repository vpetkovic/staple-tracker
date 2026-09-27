/**
 * When a phone keyboard opens under the comment box, bring the box back into view — and
 * do nothing else. Pure, so the rule is tested without a browser; ActivityTab only measures.
 *
 * The rule has two halves, and both matter:
 *
 *  - Only a box that is actually hidden is moved: out of the visible viewport, or behind
 *    something that sits on top of the scroller (the action bar under it, the sticky tab
 *    strip over it). A box that is fully visible is never touched, so typing — which
 *    nudges the viewport height on some phones — leaves the list exactly where it is.
 *  - Only a box the reader was LOOKING AT is brought back. If they scrolled up to read an
 *    earlier comment while the box kept focus, the box left the view on purpose, and a
 *    resize must not snap the list back down under them.
 */
export interface Band {
  top: number;
  bottom: number;
}

/** True when the box is fully inside the view and nothing listed overlaps it. */
export function isClear(box: Band, view: Band, covers: readonly Band[]): boolean {
  if (box.top < view.top - 0.5 || box.bottom > view.bottom + 0.5) return false;
  return !covers.some((cover) => cover.bottom > cover.top && box.bottom > cover.top + 0.5 && box.top < cover.bottom - 0.5);
}

/** After a resize: move the box only if it was in view before and is hidden now. */
export function shouldBringBack(wasClear: boolean, isClearNow: boolean): boolean {
  return wasClear && !isClearNow;
}
