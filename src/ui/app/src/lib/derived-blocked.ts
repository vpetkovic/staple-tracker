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

/**
 * WHO OR WHAT THIS ROW IS WAITING ON — one sentence, whichever of the three sources has
 * it. V5 (STA-111)'s "Waiting" section renders this under every row in it.
 *
 * The three sources are tried in order of how specific they are, and the order is the
 * whole point:
 *
 *   1. The row's OWN `unblockOwner`/`unblockAction`. Somebody typed this about this
 *      ticket. Nothing derived may overwrite it — that is `needsBorrowedDescriptor`'s
 *      existing rule and this only obeys it.
 *   2. A BORROWED descriptor from the blocking children, for a parent whose `blocked`
 *      was derived (STA-98). Reuses `borrowedWaitingLine` rather than re-wording it, so
 *      the tree section and the inbox card cannot drift apart.
 *   3. The bare `unresolvedBlockers` identifiers. No prose exists, but "blocked by
 *      STA-4" is still a fact the reader can act on, and it is the ONLY thing available
 *      for an ordinary dependency edge — which is the most common blocked row there is.
 *
 * `null` means genuinely nothing to say. A caller renders no line at all rather than an
 * empty reason, because "waiting on:" followed by nothing reads as a bug in the tracker.
 */
export function waitingLine(
  issue: BlockedLike,
  evidence: {
    unresolvedBlockers?: readonly string[];
    derivedBlockers?: readonly BlockingChild[];
  } = {},
): string | null {
  if (!needsBorrowedDescriptor(issue)) {
    // Its own words. `blockingDescriptor` is shaped for a child, but the two fields it
    // reads are the same two, so the wording stays identical by construction.
    const own = blockingDescriptor({
      identifier: "",
      title: "",
      unblockOwner: issue.unblockOwner,
      unblockAction: issue.unblockAction,
    });
    // Only when there is something to say: a row that is not blocked at all has neither
    // field and must not be given a "waiting on ?" line.
    if (issue.unblockOwner || issue.unblockAction) return own;
  }

  const borrowed = borrowedWaitingLine(evidence.derivedBlockers ?? []);
  if (borrowed) return borrowed;

  const blockers = evidence.unresolvedBlockers ?? [];
  if (blockers.length > 0) return `blocked by ${blockers.join(", ")}`;

  return null;
}
