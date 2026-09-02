/**
 * Rendering a parent whose `blocked` was DERIVED from its children (STA-98).
 *
 * The store never gives such a parent an `unblockOwner`/`unblockAction` of its
 * own: the fact belongs to the blocking child, and a copy on the parent would go
 * stale the instant the child moved. So every surface that renders a "waiting
 * on" line borrows the child's descriptor at render time, through here — one
 * place, so the inbox card and the detail panel can never word it differently.
 */
import type { BlockingChild, Issue } from "./types";

type BlockedLike = Pick<Issue, "status" | "unblockOwner" | "unblockAction">;

/**
 * Does this row need to borrow a descriptor?
 *
 * Read entirely off the row: `blocked`, with NEITHER half of a descriptor of its
 * own. No event lookup on a render path, and it cannot lie in the direction that
 * matters — a row with its own descriptor always shows its own, so a manual
 * block is never overwritten by its children's story.
 */
export function needsBorrowedDescriptor(issue: BlockedLike): boolean {
  return issue.status === "blocked" && !issue.unblockOwner && !issue.unblockAction;
}

/** One child's descriptor, in the tracker's own words. */
export function blockingDescriptor(child: BlockingChild): string {
  const owner = child.unblockOwner ?? "?";
  return child.unblockAction ? `waiting on ${owner}: ${child.unblockAction}` : `waiting on ${owner}`;
}

/**
 * The compact one-line form, for a card. Null when there is nothing to borrow,
 * so a caller falls back to whatever it said before rather than printing an
 * empty reason.
 */
export function borrowedWaitingLine(children: readonly BlockingChild[]): string | null {
  if (children.length === 0) return null;
  return children.map(blockingDescriptor).join(" · ");
}
