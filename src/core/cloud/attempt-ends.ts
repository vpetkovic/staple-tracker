/**
 * "A stored orphan end never overwrites a real end": one rule, for every reader of the log.
 *
 * Contract: `docs/execution-telemetry.md`, "A stored orphan end never overwrites a real end".
 *
 * A remote steal or release journals its `issue.update` and its `attempt.update` from one
 * scope, but push batches and pull pages are bounded, so the two can arrive apart, and the
 * attempt's opening device can write its stored orphan end in the gap. Conflict screening
 * cannot settle that pair: it runs only on a device whose own write overlapped, while a third
 * device, a fresh one and the service's fold apply both operations in log order. So the choice
 * is an APPLY rule that every reader calls — the client applier (`apply.ts`) and its screen
 * (`conflicts.ts`), the snapshot hydration (`hydrate.ts`), the service's fold
 * (`worker/src/fold.ts`, and with it `/snapshot` and backups), the tail fold (`tail-fold.ts`)
 * and the test service:
 *
 *   - an orphan end never overwrites a real end the entity already holds;
 *   - a real end always overwrites an orphan end;
 *   - otherwise the ordinary rules apply.
 *
 * The end fields are compared as one unit, which is why every `attempt` operation that sets
 * one carries all seven. A reader that drops an incoming orphan end records none of its keys
 * in its field-write provenance, or a device hydrated from that fold would inherit provenance
 * for a write it never took.
 *
 * Pure: no database, no Node. The Worker imports it as it stands.
 */

/** The seven end fields, compared and carried as one unit. */
export const ATTEMPT_END_FIELDS = [
  "state",
  "outcome",
  "endReason",
  "endDetection",
  "endedBy",
  "endedAt",
  "endedAtSource",
] as const;

/** The reasons only a stored orphan end is written with (`attempts.ts`, `orphanReason`). */
export const ORPHAN_END_REASONS: ReadonlySet<string> = new Set([
  "claim_moved",
  "claim_cleared",
  "left_active",
  "superseded_by_merge",
  "issue_removed",
]);

/** The same field under either spelling, as a fold may hold an older payload's column name. */
function read(fields: Readonly<Record<string, unknown>>, name: string): unknown {
  if (name in fields) return fields[name];
  const column = name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return fields[column];
}

/** An operation payload sets end fields when it names any of the seven. */
export function carriesAttemptEnd(payload: Readonly<Record<string, unknown>>): boolean {
  return ATTEMPT_END_FIELDS.some((field) => read(payload, field) !== undefined);
}

/** A stored orphan end: ended, inferred, with one of the orphan reasons. */
export function isOrphanEnd(fields: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (fields === null || fields === undefined) return false;
  const reason = read(fields, "endReason");
  return (
    read(fields, "state") === "ended" &&
    read(fields, "endDetection") === "inferred" &&
    typeof reason === "string" &&
    ORPHAN_END_REASONS.has(reason)
  );
}

/** Any other stored end. */
export function isRealEnd(fields: Readonly<Record<string, unknown>> | null | undefined): boolean {
  if (fields === null || fields === undefined) return false;
  return read(fields, "state") === "ended" && !isOrphanEnd(fields);
}

/**
 * True when an incoming payload's end fields are exactly one orphan end and one real end
 * against what is held. Conflict screening skips the end fields for that pair: the apply
 * rule settles it, in either direction, and records no conflict.
 */
export function orphanAgainstReal(
  held: Readonly<Record<string, unknown>> | null | undefined,
  incoming: Readonly<Record<string, unknown>>,
): boolean {
  if (!carriesAttemptEnd(incoming)) return false;
  return (isOrphanEnd(incoming) && isRealEnd(held)) || (isRealEnd(incoming) && isOrphanEnd(held));
}

/**
 * The payload an `attempt` operation may apply over `held`: itself, or itself without the
 * seven end fields when it is an orphan end arriving over a real end. Returns the same
 * object when nothing is dropped, so a caller can tell by identity.
 */
export function settleAttemptEnd<T extends Readonly<Record<string, unknown>>>(
  held: Readonly<Record<string, unknown>> | null | undefined,
  incoming: T,
): T {
  if (!carriesAttemptEnd(incoming) || !isOrphanEnd(incoming) || !isRealEnd(held)) return incoming;
  const kept: Record<string, unknown> = {};
  const dropped = new Set<string>(ATTEMPT_END_FIELDS.flatMap((field) => [field, field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)]));
  for (const [key, value] of Object.entries(incoming)) if (!dropped.has(key)) kept[key] = value;
  return kept as T;
}
