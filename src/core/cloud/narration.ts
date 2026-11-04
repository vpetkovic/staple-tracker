/**
 * `originEvents` is what an operation narrates, not a field of the entity it writes
 * (`cloud/reemit.ts`). Every fold drops it — the service's (`worker/src/fold.ts`, and with it
 * `/snapshot`, backups and the creates a restore stages), the tail fold (`tail-fold.ts`) and the
 * test service — and no field-write provenance records it (`journal.ts`). Kept as state, a
 * restore staged it into a create, and a device reading that create re-emitted events the
 * repository had already narrated once.
 *
 * Pure: no database, no Node. The Worker imports it as it stands.
 */

/** The payload key that carries an operation's narration. */
export const NARRATION_KEY = "originEvents";

/** The payload without its narration; the same object when it has none. */
export function withoutNarration<T extends Readonly<Record<string, unknown>>>(payload: T): T {
  if (!(NARRATION_KEY in payload)) return payload;
  const { [NARRATION_KEY]: _narration, ...rest } = payload as Record<string, unknown>;
  return rest as T;
}
