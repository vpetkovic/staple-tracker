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
 * Not from here. The visible order is the tree view's own business — it is what is
 * left after the filter, the grouping, the sort and any collapsed groups — and
 * r-rows publishes it on the session as part of R1 (STA-100):
 *
 *     session.visibleOrder: readonly Selection[]
 *
 * post-filter, post-group, flattened, group headers excluded, rows inside a
 * collapsed group excluded. `readNavOrder` below prefers that the moment it exists.
 *
 * Until it does, there is a bridge that reads the order off the DOM. That is
 * uncomfortable and deliberately temporary, but it is not a lie: the rendered
 * treegrid IS the visible order, by definition, and reading it is how this ticket
 * ships something real instead of something dark. What makes it wrong long-term is
 * ownership, not correctness — the detail should not know the shape of markup it
 * does not own. See `orderFromDom` for how it is written to fail safely, and delete
 * it when the contract lands.
 */
import type { IssueRow } from "@/lib/types";

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

/**
 * A session that may or may not publish the visible order yet.
 *
 * Structural and optional on purpose: `lib/session.ts` belongs to r-rows and is
 * being edited in parallel, so this reads what it needs without requiring the
 * session type to have grown the field. When STA-100 lands, `visibleOrder` is simply
 * present and the DOM branch below stops being reached.
 */
export interface NavSource {
  visibleOrder?: readonly NavTarget[];
  issues: { data: IssueRow[] | undefined };
}

/**
 * The visible order: the published contract if there is one, the DOM otherwise.
 */
export function readNavOrder(source: NavSource): readonly NavTarget[] {
  if (source.visibleOrder) return source.visibleOrder;
  return orderFromDom(source.issues.data ?? []);
}

/**
 * TEMPORARY BRIDGE — delete when `session.visibleOrder` exists (STA-100).
 *
 * Reads the rendered treegrid in document order. Three deliberate choices about how
 * it fails, because a bridge that breaks loudly in someone else's ticket is worse
 * than the coupling it is standing in for:
 *
 *  - Selected on `[role='row'][data-identifier]`, NOT on `data-testid`. Roles are a
 *    contract with assistive technology and change rarely; that testid already
 *    changed once this session (`tree-row` -> `task-row`) and would have taken
 *    prev/next silently dark with it. Group headers carry no `data-identifier`, so
 *    they fall out of the query rather than needing to be filtered.
 *
 *  - Rows inside a collapsed group are skipped via `closest("[inert]")`. TreeGrid
 *    marks a collapsed body `inert`, which is exactly the "cannot be reached"
 *    signal; "next" landing on a row the user cannot see is the bug this avoids.
 *
 *  - The workspace is never guessed. The DOM supplies the ORDER; `session.issues`
 *    supplies which workspace each identifier belongs to. An identifier with no
 *    matching row is dropped rather than defaulted, because a wrong workspace is a
 *    silently wrong ticket.
 *
 * Returns empty when there is no treegrid at all — the graph view, most obviously —
 * and empty is a perfectly good answer there: both arrows disable.
 */
function orderFromDom(issues: readonly IssueRow[]): readonly NavTarget[] {
  if (typeof document === "undefined") return [];
  const nodes = document.querySelectorAll("[role='treegrid'] [role='row'][data-identifier]");
  if (nodes.length === 0) return [];

  const workspaceOf = new Map<string, string>();
  for (const row of issues) {
    if (!workspaceOf.has(row.issue.identifier)) workspaceOf.set(row.issue.identifier, row.workspace);
  }

  const order: NavTarget[] = [];
  for (const node of nodes) {
    if (node.closest("[inert]")) continue;
    const ref = node.getAttribute("data-identifier");
    if (!ref) continue;
    const workspace = workspaceOf.get(ref);
    if (!workspace) continue;
    order.push({ workspace, ref });
  }
  return order;
}
