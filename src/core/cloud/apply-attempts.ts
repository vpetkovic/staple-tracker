/**
 * Applying `attempt` and `attemptTransition` operations (protocol 3).
 *
 * Contract: `docs/execution-telemetry.md`, "Where it lives and what synchronizes".
 *
 * An applied attempt operation runs NONE of the attempt side effects: nothing here opens,
 * ends or infers anything. It writes the originating device's own record — its ids, its
 * timestamps — and nothing derived from the issue change it may have travelled with. The
 * one decision taken here is the apply rule every reader of the log shares: a stored orphan
 * end never overwrites a real end, and a real end always overwrites an orphan end
 * (`attempt-ends.ts`).
 *
 * An applied transition re-emits its local event under its transition-derived key, dated at
 * the transition's own `at`, so `events --follow` sees another device's attempts and a
 * re-delivered transition cannot duplicate the timeline.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  endFromPayload,
  endOf,
  insertAttempt,
  insertTransition,
  emitTransitionEvent,
  readAttempt,
  readTransition,
  recordFromPayload,
  transitionFromPayload,
  writeEnd,
} from "../telemetry/attempt-records.js";
import { StapleError } from "../types.js";
import { carriesAttemptEnd, settleAttemptEnd } from "./attempt-ends.js";
import { ReferentMissing, type ApplyInput } from "./apply.js";

/**
 * The payload an `attempt` operation may apply here: without its end fields when it is an
 * orphan end arriving over a real end this device holds. Read by the screen too, so a
 * dropped orphan end records no field-write provenance (`conflicts.ts`).
 */
export function settleIncomingAttempt(db: DatabaseSync, entityId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const held = readAttempt(db, entityId);
  return held === null ? payload : settleAttemptEnd(endOf(held) as unknown as Record<string, unknown>, payload);
}

export function applyAttempt(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb !== "create" && input.verb !== "update") return false;
  const held = readAttempt(db, input.entityId);
  if (held === null) {
    if (input.verb !== "create") {
      throw new ReferentMissing(`the create of attempt ${input.entityId}, which no operation so far has carried`);
    }
    const record = recordFromPayload(input.entityId, input.payload);
    if (record === null) {
      throw new StapleError("validation", `An attempt create for ${input.entityId} is missing its issueId, agent or startedAt.`);
    }
    insertAttempt(db, record);
    return true;
  }
  // Everything but the end is immutable once written: a create over a held attempt (this
  // device's own coming back, a snapshot re-read) and an update both touch only the end.
  const payload = settleAttemptEnd(endOf(held) as unknown as Record<string, unknown>, input.payload);
  if (!carriesAttemptEnd(payload)) return false;
  writeEnd(db, held.id, endFromPayload(held, payload));
  return true;
}

export function applyAttemptTransition(db: DatabaseSync, input: ApplyInput): boolean {
  if (input.verb !== "create") return false;
  if (readTransition(db, input.entityId) !== null) return false;
  const transition = transitionFromPayload(input.entityId, input.payload);
  if (transition === null) {
    throw new StapleError("validation", `An attempt transition create for ${input.entityId} is missing its attemptId, kind or at.`);
  }
  const attempt = readAttempt(db, transition.attemptId);
  if (attempt === null) {
    throw new ReferentMissing(`attempt ${transition.attemptId}, which transition ${input.entityId} belongs to`);
  }
  insertTransition(db, transition);
  emitTransitionEvent(db, transition, attempt.issueId);
  return true;
}
