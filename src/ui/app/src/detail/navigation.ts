/**
 * PREV/NEXT — moving the open detail through the list behind it (R6 / STA-106).
 *
 * The feature is two chevrons in the chrome bar and one question asked over and
 * over: given the list the user can currently SEE, and the issue they are looking
 * at, what is on either side of it? This module answers that and nothing else. It
 * imports no React and touches no session, which is the point — every way this can
 * be wrong (off-by-one, wrapping at the ends, matching the wrong workspace in hub
 * mode) is silent in the UI and loud in a unit test.
 *
 * ─── WHERE "THE LIST THE USER CAN SEE" COMES FROM ─────────────────────────────
 *
 * Not from here. The visible order is the tree view's own business — what is left
 * after the filter, the grouping, the sort, and every kind of fold — and it arrives
 * on the session as `session.visibleOrder` (STA-100): post-filter, post-group,
 * flattened, screen order, group headers excluded, rows inside a collapsed group or
 * under a collapsed parent excluded, `[]` when the active view has no list.
 *
 * This module used to carry a bridge that read that order off the rendered DOM,
 * because the contract did not exist yet and the alternative was shipping the
 * feature dark. It is gone, and it is worth saying what replacing it actually
 * bought, because "we deleted a shim" undersells it: the DOM bridge could not
 * verify its own ordering — the evidence compared a walk against the same DOM the
 * bridge had read, which proves the wiring and nothing about the order. The
 * published array comes from the SAME `visibleOrder()` derivation the grid's own
 * keyboard sequence uses, so the arrows and the arrow keys cannot drift into an
 * off-by-one that only appears once a group is collapsed. That is a real check
 * where there was previously an assumption.
 *
 * It also removed a render-phase DOM read from the mount. The order is plain data
 * now, held behind a value-equality guard, so this is an ordinary derivation.
 */

/** An issue, addressed the way `session.open()` addresses one. */
export interface NavTarget {
  workspace: string;
  ref: string;
}

export interface NavState {
  /** The entry before the current one, or null at the top / when not in the list. */
  prev: NavTarget | null;
  /** The entry after the current one, or null at the bottom / when not in the list. */
  next: NavTarget | null;
  /** Position of the current issue in the visible list; -1 when it is not in it. */
  index: number;
  /** How long the visible list is. `index + 1` of `total` is the human reading. */
  total: number;
}

/**
 * Identity for a target: the PAIR, never the ref alone.
 *
 * Hub mode federates several workspaces into one list, and two of them can each own
 * an issue whose identifier looks like the other's. Matching on `ref` would navigate
 * into the wrong workspace's ticket while the identifier in the chrome bar looked
 * exactly right — a bug with no visible symptom until someone edits the wrong issue.
 *
 * Two nulls are NOT the same target. The only question this is ever asked is "is
 * this list entry the issue that is currently open", and when nothing is open the
 * answer is no for every entry.
 */
export function sameTarget(a: NavTarget | null, b: NavTarget | null): boolean {
  if (!a || !b) return false;
  return a.workspace === b.workspace && a.ref === b.ref;
}

/**
 * What is on either side of `current` in `order`.
 *
 * NO WRAPPING. Wrapping is the natural thing to write and the wrong thing to ship:
 * "next" on the last row landing on the first is indistinguishable, for the frame
 * that matters, from having gone somewhere sensible. The ticket asks for disabled
 * states at the ends because the end of the list is information.
 *
 * NOT IN THE LIST MEANS NO NEIGHBOURS. You can reach an issue the visible list does
 * not contain — click a blocker chip, or an ancestor breadcrumb, for something the
 * current filter excludes. The tempting reading of "not found" is "start from the
 * top", which makes the down arrow jump to an unrelated ticket. That is worse than
 * a disabled button, because it looks like it worked.
 */
export function neighbours(order: readonly NavTarget[], current: NavTarget | null): NavState {
  const total = order.length;
  const index = current ? order.findIndex((entry) => sameTarget(entry, current)) : -1;
  if (index < 0) return { prev: null, next: null, index: -1, total };
  // `?? null` rather than a non-null assertion: `noUncheckedIndexedAccess` is on, and
  // the bounds check above is a fact about this function that the compiler is right
  // not to take on trust.
  return {
    prev: index > 0 ? (order[index - 1] ?? null) : null,
    next: index < total - 1 ? (order[index + 1] ?? null) : null,
    index,
    total,
  };
}

