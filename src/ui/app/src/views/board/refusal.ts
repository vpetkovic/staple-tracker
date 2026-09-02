/**
 * What the store said when it refused — owned by U6 (views/board/).
 *
 * staple has no transition table. `updateIssue` runs guards at the moment of the write
 * and the *reason* only exists as the sentence in the error it throws:
 *
 *   "in_progress requires an assignee"
 *   "Cannot start: unresolved blockers STA-7, STA-9"
 *   "Checkout refused: status is \"done\" (held by kim), expected one of todo, backlog…"
 *   "Status version mismatch: expected 3, current 5. Re-read the issue first."
 *
 * A board that snaps the card back and says nothing throws all of that away. This module
 * is the one place a refusal is turned into something renderable, and its single rule is
 * that `message` is passed through UNCHANGED. No mapping table, no friendlier copy, no
 * "needs an assignee" where the store said "in_progress requires an assignee" — if the
 * board ever shows a sentence the store did not say, the board is lying about a guard.
 *
 * It duck-types instead of using `instanceof ApiError` on purpose: the shape (message,
 * code, detail, retryable) is the wire envelope every staple surface speaks, so reading
 * the shape keeps this a pure function that can be tested without lib/api or a DOM.
 */

/** A refusal, ready to render. Every field comes off the wire; nothing is invented. */
export interface Refusal {
  /** The store's sentence, verbatim. This is the whole point of the module. */
  message: string;
  /** `validation`, `conflict`, `not_found`, … — shown as provenance, not as the reason. */
  code: string;
  /** `detail.blockers` when the store sent it, so blockers can render as chips. */
  blockers: string[];
  /** The store's own opinion on whether trying again could work. */
  retryable: boolean;
  /** False when nothing carried a message and we had to say so ourselves. */
  fromServer: boolean;
}

function readString(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/** Pull `detail.blockers` out of the envelope. Anything not a list of strings is dropped. */
function readBlockers(source: Record<string, unknown>): string[] {
  const detail = source["detail"];
  if (typeof detail !== "object" || detail === null) return [];
  const blockers = (detail as Record<string, unknown>)["blockers"];
  if (!Array.isArray(blockers)) return [];
  return blockers.filter((b): b is string => typeof b === "string" && b !== "");
}

/**
 * Turn whatever `POST /api/action` rejected with into a Refusal.
 *
 * Accepts `unknown` because a catch block gets `unknown`, and a fetch that never reached
 * the server throws something with no envelope at all. That case is the only one where
 * this function supplies its own words, and it says plainly that the store was not
 * reached rather than guessing at a guard.
 */
export function describeRefusal(error: unknown): Refusal {
  if (typeof error !== "object" || error === null) {
    return {
      message: typeof error === "string" && error !== "" ? error : "the change was refused",
      code: "unknown",
      blockers: [],
      retryable: false,
      fromServer: false,
    };
  }

  const source = error as Record<string, unknown>;
  // ApiError builds `message` from envelope.message ?? envelope.error, so `message`
  // alone is enough — but read `error` too, in case a raw envelope object is handed in.
  const message = readString(source, "message") ?? readString(source, "error");
  const retryable = source["retryable"];

  return {
    message: message ?? "the change was refused, and the server did not say why",
    code: readString(source, "code") ?? "unknown",
    blockers: readBlockers(source),
    retryable: typeof retryable === "boolean" ? retryable : false,
    fromServer: message !== undefined,
  };
}
