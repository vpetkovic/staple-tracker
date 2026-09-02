/**
 * When a claim stops looking alive, and what the page says about it — C3 (STA-49).
 *
 * WHY THIS IS A MODULE AND NOT THREE INLINE TERNARIES. A ticket held by an agent that
 * died four hours ago renders identically to one somebody is actively typing into. The
 * only thing separating them is a number — `claim.idleSeconds`, computed server-side by
 * C1 — and the one judgement this app makes about that number is "past the threshold or
 * not". Keeping the judgement and the wording in one pure file means the card, the detail
 * header, and the two takeover buttons cannot disagree about which claims are stale.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO:
 *
 *  1. It does not tick. `idleSeconds` is a server reading, frozen at response time; the
 *     app's existing fingerprint poll (useStaple.ts, 1.5s) refreshes it. A client-side
 *     per-second counter would look more alive while being strictly less true — it would
 *     keep counting up against a server that has already been taken over, and it would
 *     keep counting during a paused tab. A number that is up to a poll old and honest
 *     beats a number that is smooth and made up.
 *
 *  2. It does not act. Nothing here releases, steals, or schedules. Crossing the
 *     threshold changes what is DRAWN and which buttons EXIST; a claim only ever changes
 *     hands because a human clicked. That is C1's anti-requirement carried into the UI.
 *
 *  3. It does not decide the outcome. The threshold below is what the UI *shows* a badge
 *     at and what it *sends* as `stealIfIdleSeconds` / `ifIdleSeconds`. The store still
 *     re-evaluates against its own clock and can refuse — and when it does, its sentence
 *     is what the user reads. This file never predicts a refusal.
 */
import type { ClaimActivity } from "./types";

/**
 * How long a holder has to go silent before the page says so: 30 minutes.
 *
 * A constant, not a setting. The number wants to be long enough that an agent thinking,
 * running a test suite, or waiting on a review is never accused of being dead, and short
 * enough that a process killed at lunch is visibly dead by the time someone looks. Thirty
 * minutes clears the first comfortably: staple's own writes (a comment, a status change,
 * a document revision) all refresh `lastActivityAt`, so a working agent touches its
 * ticket far more often than every half hour.
 *
 * It is also the value the UI hands the store as the takeover threshold, so what the
 * badge claims and what the button asks for are the same number by construction rather
 * than by two people remembering to keep them equal.
 */
export const STALE_CLAIM_SECONDS = 30 * 60;

/**
 * Floored, single-unit age: 45s / 3m / 2h / 5d.
 *
 * A hand-kept mirror of `formatAgo` in src/core/types.ts, for the same reason
 * lib/types.ts mirrors the wire vocabulary: core is Node-only and importing it would drag
 * node: builtins into the browser bundle. The rule against divergence is real, though —
 * this renders the same durations that appear inside the store's refusal sentences, and a
 * badge reading "silent 45m" beside a refusal reading "active 2700s ago" would look like
 * two different systems talking about two different claims.
 */
export function formatAgo(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0s"; // never "NaNd" to a human
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Is this claim past the point where silence is worth flagging?
 *
 * `null` is not stale — it is *nobody holding it*, which is a different and entirely
 * unremarkable state. The comparison is `>=` so that a threshold expressed in seconds
 * means what it says: at exactly 30 minutes of silence the badge is on, and that is also
 * the instant the store would accept the steal the button is about to ask for.
 */
export function isStaleClaim(
  claim: ClaimActivity | null | undefined,
  thresholdSeconds: number = STALE_CLAIM_SECONDS,
): boolean {
  if (!claim) return false;
  return claim.idleSeconds >= thresholdSeconds;
}

/**
 * The compact badge line, for a card: `held by opus-x · 2h · silent 45m`.
 *
 * Both durations are there on purpose and they are not redundant. "held 2h" is how long
 * the ticket has been off the board; "silent 45m" is the evidence that nobody is coming
 * back for it. A ticket held two hours and silent thirty seconds is a healthy long task;
 * one held two hours and silent all two hours is a corpse. Printing only one number would
 * make those read the same.
 */
export function staleClaimSummary(claim: ClaimActivity): string {
  return `held by ${claim.heldBy} · ${formatAgo(claim.heldSeconds)} · silent ${formatAgo(claim.idleSeconds)}`;
}

/**
 * The fuller detail-panel line: the compact summary plus the timestamp it was derived
 * from. The panel has the room, and `lastActivityAt` is the auditable fact underneath
 * "silent 45m" — the one thing a human can go check against the event log when deciding
 * whether to take someone's work away from them.
 */
export function staleClaimDetail(claim: ClaimActivity): string {
  return `${staleClaimSummary(claim)} · last activity ${claim.lastActivityAt.slice(0, 19)}Z`;
}
