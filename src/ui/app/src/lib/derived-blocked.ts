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
 * There used to be a third source and O6 (STA-138) removed it: the bare
 * `unresolvedBlockers` identifiers, rendered as `blocked by STA-4, STA-5`.
 *
 * ── WHY THAT ONE WENT ─────────────────────────────────────────────────────────────────
 *
 * It was the most common caption on the board by a distance — 33 of 36 in Group by Pickup
 * order — and one of them read `blocked by STA-67, STA-68, STA-69, STA-70, STA-71, STA-72,
 * STA-73, STA-74, STA-75, STA-76, STA-77`. It shares the title's `minmax(0, 1fr)` track, so
 * at any real width it ellipsized to `blocked by STA-67, STA-6…`, at which point it said
 * strictly less than the number 11 would have.
 *
 * The row now renders a warning-triangle badge carrying that count, whose tooltip names the
 * identifiers and whose click opens the Dependencies dialog with their titles and statuses.
 * Keeping the sentence too would be the same fact twice, and the copy taking the space would
 * be the worse one.
 *
 * The two that REMAIN are the two a badge cannot carry: somebody's actual words about why
 * this is stuck. That is the whole distinction — prose stays, enumeration became a glyph.
 *
 * `null` means genuinely nothing to say. A caller renders no line at all rather than an
 * empty reason, because "waiting on:" followed by nothing reads as a bug in the tracker.
 *
 * `unresolvedBlockers` is still ACCEPTED and deliberately ignored: every caller already
 * passes it, the field is the badge's input on the same row, and removing the parameter
 * would make three call sites read as though the fact had stopped existing.
 */
export function waitingLine(
  issue: BlockedLike,
  evidence: {
    /** Accepted, unused since O6 — the badge renders these. See the note above. */
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

  // No third fallback. An ordinary dependency edge is the badge's to report — O6 (STA-138).
  return null;
}
