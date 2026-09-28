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
 * THE RULE:
 *
 *  - A strip still in view below the top is left alone: the scroll stays exactly where it was
 *    (`scrollAfterTabSwitch` returns null).
 *  - A strip that was stuck stays stuck, with the new tab starting right under it: the scroll
 *    moves to the point where the strip just sticks.
 *  - Either way, so that position survives a new tab that is loading or short, the switch
 *    gives the panels a RESERVE: exactly the min-height that keeps that scroll position
 *    reachable (`reserveFor`) and not a pixel more, so the reader can never scroll past where
 *    they already were into blank space. Only a switch made while scrolled sets one; a task
 *    nobody switched tabs on while scrolled never gets one, so a short task fits its screen
 *    as it always did.
 *  - As the reader scrolls back up, or the screen gets shorter, the reserve shrinks
 *    (`shrinkReserve`): it gives back the blank space under the tab, never more than the
 *    current scroll position needs (so giving it back never jumps the page), and it goes
 *    entirely once the tab's own content covers the scroll position, and at the latest when
 *    the reader is back at the top. A new task starts without one.
 *  - It grows back in one case only: the screen got taller again (a phone keyboard closing, a
 *    window resized back, the page collapsed to the drawer) and the browser pulled the scroll
 *    back to fit. Then the scroll is put back where the reserve was holding it
 *    (`restoreAfterResize`): the point where the strip sticks if it was stuck, else the place
 *    the reader last scrolled to (`anchorAfterScroll`, `anchorTarget`). A scroll the reader
 *    made is never undone: only a scroll sitting at the new maximum, short of that point.
 */

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

/** Where the panels sit in the scroller's content, and what follows them. */
export interface PanelGeometry {
  /** The scroller's visible height. */
  clientHeight: number;
  /** The panels' top, in the scroller's content coordinates. */
  panelsTop: number;
  /** Content below the panels: the layout's bottom padding, or a taller side rail. */
  tail: number;
}

/**
 * The panels' min-height, in px, that makes `scrollTop` a reachable scroll position. The top
 * of the content is reachable whatever its height, so a scroll of 0 needs none.
 */
export function reserveFor(scrollTop: number, geometry: PanelGeometry): number {
  if (scrollTop <= 0) return 0;
  return Math.max(0, Math.round(scrollTop + geometry.clientHeight - geometry.panelsTop - geometry.tail));
}

/**
 * After a scroll or a resize: the reserve never grows, only gives back what the scroll no
 * longer needs, and is released (null) once the tab's own content is at least as tall.
 */
export function shrinkReserve(current: number | null, needed: number, natural: number): number | null {
  if (current === null) return null;
  const next = Math.min(current, needed);
  return next <= natural ? null : next;
}

/** What a held reserve is keeping the scroll at. */
export type ReserveAnchor = { kind: "stuck" } | { kind: "at"; scrollTop: number };

/**
 * After the reader scrolls: a stuck strip stays the anchor while it is still stuck; once they
 * scroll above it, the anchor is where they scrolled to.
 */
export function anchorAfterScroll(anchor: ReserveAnchor, scrollTop: number, stickAt: number): ReserveAnchor {
  if (anchor.kind === "stuck" && scrollTop >= stickAt - 0.5) return anchor;
  return { kind: "at", scrollTop: Math.max(0, scrollTop) };
}

/** The scrollTop the anchor stands for, in the current layout. */
export function anchorTarget(anchor: ReserveAnchor, stickAt: number): number {
  return anchor.kind === "stuck" ? Math.max(0, stickAt) : anchor.scrollTop;
}

/**
 * After the scroller resized: the scroll to put back, or null. Only a scroll the browser
 * clamped is restored: one sitting at the new maximum, short of the anchor's target.
 */
export function restoreAfterResize(scrollTop: number, maxScroll: number, target: number): number | null {
  return scrollTop >= maxScroll - 0.5 && scrollTop < target - 0.5 ? target : null;
}
