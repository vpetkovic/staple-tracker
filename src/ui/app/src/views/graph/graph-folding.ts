/**
 * Folding, as decisions rather than as callbacks — O4d (STA-136).
 *
 * Two questions live here, and both were previously either inline in GraphView or not
 * asked at all:
 *
 *   WHICH EPIC JUST FOLDED, AND WHICH WAY — the input to the viewport fit.
 *   WHERE DOES A SELECTION MADE OUTSIDE THE GRAPH LAND — and, by the shape of the answer,
 *     what it is not allowed to do.
 *
 * Nothing here imports React, React Flow, or the canvas model. `foldOf` works on two sets
 * of epic ids, `selectionTarget` works on two maps; both are the kind of thing a test can
 * state a rule about without rendering anything.
 */

/** A single epic's fold, as a gesture rather than as a state. */
export interface Fold {
  /** The epic's ticket id — NOT its canvas id. `clusterId` is the caller's business. */
  epic: string;
  /** True when the epic OPENED; false when it closed. */
  opened: boolean;
}

/**
 * The fold between two collapse sets, or `null` when there was not exactly one.
 *
 * DERIVED FROM THE SETS RATHER THAN PASSED FROM THE CALL SITE, and that is what makes one
 * rule cover four affordances: the picker's chevron, the picker's Left/Right keys, the
 * container header's `⌄` and the cluster's `⊕`. O4c left three one-way callbacks precisely
 * so the direction would be known at each call site — but "known at four call sites" is
 * four places to forget, and the sets already say it.
 *
 * `null` for zero changes (a poll, a filter move, a re-render) is the case that keeps the
 * viewport still. `null` for MORE than one is the deliberate half: Expand all and Collapse
 * all are gestures about the whole board, and a viewport that flew to whichever epic
 * happened to sort first would be picking one at random and calling it an answer. The
 * board-wide gesture that is allowed to move everything is auto-arrange, and it does not
 * come through here.
 */
export function foldOf(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>,
): Fold | null {
  const folds: Fold[] = [];
  // In `previous` and not in `next`: it was collapsed and now is not, i.e. it OPENED.
  for (const epic of previous) if (!next.has(epic)) folds.push({ epic, opened: true });
  for (const epic of next) if (!previous.has(epic)) folds.push({ epic, opened: false });
  return folds.length === 1 ? (folds[0] ?? null) : null;
}

/** How long the viewport takes to travel. Long enough to read as motion, short enough not to wait. */
export const FOLD_FIT_MS = 300;

/**
 * Room around the epic the viewport lands on. Wider than the first-paint padding (0.15)
 * because this fit is a close-up of ONE box, and a box that filled the frame edge to edge
 * would read as having been cropped rather than framed.
 */
export const FOLD_FIT_PADDING = 0.2;

/** The cap the canvas already uses on its first fit; a fold does not get to exceed it. */
export const FOLD_FIT_MAX_ZOOM = 1;

/**
 * How far a fold's fit may zoom IN. **A FOLD NEVER MAGNIFIES.**
 *
 * Opening an epic asks "show me what is inside", so the fit is allowed to close in — as
 * far as `FOLD_FIT_MAX_ZOOM`, the same cap the canvas uses on its first paint, so the
 * closest a fold can take you is a zoom you have already seen this graph at.
 *
 * Closing an epic asks for LESS. The card it leaves behind is 208x62, and fitting to that
 * on its own terms would rocket the viewport to maximum zoom on a single node — the exact
 * opposite of the gesture. So a close keeps whatever zoom you were reading at and spends
 * the animation on the pan, which is the part that still has something to say: it puts the
 * epic you just folded where you can see it landed.
 *
 * `current` rather than "do not fit at all" because the epic may have been off-screen; the
 * viewport still has to travel, it just travels flat.
 */
export function foldFitZoom(opened: boolean, current: number): number {
  return opened ? FOLD_FIT_MAX_ZOOM : current;
}

/**
 * Where a selection made OUTSIDE the graph lands on the canvas — a tree row, the command
 * palette, prev/next in the detail panel.
 *
 * ── THIS SIGNATURE IS THE ACCEPTANCE CRITERION ───────────────────────────────────────
 *
 * "Selecting a task outside the graph never changes collapse state or the epic filter."
 * The way that is guaranteed here is not a check and not a test — it is that the collapse
 * set and the epic filter are not among the arguments and a fold is not among the results.
 * A selection goes in; an id to LIGHT comes out. No implementation of this function can
 * fold anything, and no caller can mistake its return value for permission to.
 *
 * The mapping itself is O4c's two halves of one question, in the order that answers it:
 *
 *   `absorbed` — the ticket is inside a COLLAPSED epic, so the thing on screen standing for
 *     it is that epic's cluster. Without this, opening a ticket inside a collapsed epic
 *     would trace nothing and the dimming would be total, which reads as a fault rather
 *     than as "it is in there".
 *   `headers` — the selection IS an epic that is currently EXPANDED, so its own ticket is
 *     gone from the canvas and its box is what stands for it.
 *   otherwise the ticket is drawn as itself.
 *
 * The two maps agree by construction: a container and a cluster share an id, so an epic
 * resolves to the same string whichever state it is in — which is also why the order of
 * the two lookups cannot matter for an epic and only matters for a member.
 */
export function selectionTarget(
  selected: string | null,
  absorbed: ReadonlyMap<string, string>,
  headers: ReadonlyMap<string, string>,
): string | null {
  if (selected === null) return null;
  return absorbed.get(selected) ?? headers.get(selected) ?? selected;
}
