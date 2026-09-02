/**
 * Transition guards, client side — owned by U6 (board drag-and-drop).
 *
 * The authority on whether a transition is legal is the store, and it stays that way.
 * This module exists so a drag can be refused *before* the drop, with a reason the user
 * can read, rather than after a round trip. Anything it allows must still survive
 * POST /api/action; anything the server refuses comes back as an ApiError whose message
 * wins over anything said here.
 *
 * Keep the default permissive. A guard that guesses wrong in the restrictive direction
 * is worse than a server error, because it makes legal work look impossible.
 *
 * That last paragraph is why there are two functions and not one:
 *
 *   canTransition()      HARD. False means the drop is not offered at all. Reserved for
 *                        the one case the client cannot be wrong about — the column the
 *                        card is already in, which is a no-op and not a transition.
 *   columnAffordance()   ADVISORY. Dims a column while dragging when a guard is visibly
 *                        going to fire, but the column stays droppable. Drop it anyway
 *                        and the store answers with the real sentence, which is exactly
 *                        the behaviour STA-18 is about.
 *
 * Note what is deliberately NOT guessed here: unresolved blockers. GET /api/issues
 * returns a plain `Issue`, which has no blocker set — `unresolvedBlockers` only exists
 * on `InboxIssue`, from a different endpoint. Inventing a blocker model on the board
 * would mean dimming columns on data the board does not have. Blockers stay a
 * server-side refusal, and `detail.blockers` comes back with the message.
 */
import type { Issue, IssueStatus } from "@/lib/types";

export interface GuardVerdict {
  /** False means: do not offer the drop at all. */
  allowed: boolean;
  /** Why it was refused, or — when allowed — what the user should know before dropping. */
  reason?: string;
}

export function canTransition(issue: Issue, to: IssueStatus): GuardVerdict {
  if (issue.status === to) return { allowed: false, reason: `already ${to}` };
  return { allowed: true };
}

/**
 * Non-blocking warnings for a legal transition. The board should surface these on the
 * drag preview rather than refusing the drop.
 */
export function transitionWarnings(issue: Issue, to: IssueStatus): string[] {
  const warnings: string[] = [];
  // An issue someone else has checked out is theirs until they release it. Moving it
  // out from under them is how two agents end up doing the same task twice.
  if (issue.checkoutAgent) warnings.push(`held by ${issue.checkoutAgent}`);
  if (to === "done" && issue.status === "blocked") warnings.push("still marked blocked");
  return warnings;
}

/**
 * How a column should look while this card is in the air.
 *
 *   "self"     the card's own column — nothing to do, no drop offered
 *   "unlikely" a guard the client can see will fire; dim it, but still let go of the
 *              card there, because the store's sentence is more useful than a column
 *              that refuses to be a target
 *   "caution"  legal, but there is something the user should know first
 *   "ok"       nothing to say
 */
export type AffordanceTone = "ok" | "caution" | "unlikely" | "self";

export interface ColumnAffordance {
  tone: AffordanceTone;
  /** One short phrase for the column label. Absent for "ok". */
  reason?: string;
  /** False only for "self". Everything else stays droppable on purpose. */
  droppable: boolean;
}

export function columnAffordance(issue: Issue, to: IssueStatus): ColumnAffordance {
  const verdict = canTransition(issue, to);
  if (!verdict.allowed) return { tone: "self", reason: verdict.reason, droppable: false };

  // The one guard the board can read off the card it is holding. `updateIssue` throws
  // "in_progress requires an assignee" for exactly this, and checkoutIssue would set an
  // assignee itself — but a status drop is not a checkout, so the guard applies.
  if (to === "in_progress" && !issue.assignee) {
    return { tone: "unlikely", reason: "no assignee", droppable: true };
  }

  const warnings = transitionWarnings(issue, to);
  if (warnings.length > 0) return { tone: "caution", reason: warnings.join(" · "), droppable: true };

  return { tone: "ok", droppable: true };
}
