/**
 * ONE committed artifact pinning the operation-payload rule, read by BOTH suites (STA-262).
 *
 * NO IMPORTS, for the same reason as `registry-fixture.ts`: it is the one kind of file
 * both tsconfigs can compile.
 *
 * ## The rule
 *
 * **Every operation's `payload` is a JSON object, for every verb on every entity.** Not
 * an array, not a scalar, not null.
 *
 * That is not a guess about emitters, it is what the whole client is typed as and what
 * every emitter sends. `OperationEnvelope.payload`, `JournalIntent.payload` and
 * `SeedIntent.payload` (`src/core/journal.ts`) are all `Record<string, unknown>`, and the
 * hub registry's three payload types (`src/core/cloud/hub-registry-ops.ts`) are objects
 * with a `format` key. The lists on the wire are always the VALUE of a key: the plan is
 * `queue.replace` with `{ order: [...] }`, a milestone's membership is `milestone.replace`
 * with `{ members: [...] }`, a blocker set is `relation.update` with `{ blockedBy: [...] }`,
 * and a status or kind order is `status.update` / `kind.update` with `{ order: [...] }`.
 *
 * An array payload is refused because the fold (`worker/src/fold.ts`) merges a payload's
 * KEYS, and an array has none: it would be accepted, stored, given a sequence number and
 * folded into nothing, so it would vanish from every snapshot and every backup.
 *
 * `test/cloud-emitter-payloads.test.ts` drives the real emitters through the real client
 * into `test/fixtures/fake-sync-server.ts`, and records one payload per entity and verb
 * into {@link EMITTED_PAYLOADS} below; `worker/test/push.test.ts` pushes every one of those
 * through the real Worker.
 */

/** The refusal for operation `index`, exactly as the Worker and the fake send it. */
export function payloadRefusal(index: number): { status: number; body: Record<string, unknown> } {
  return {
    status: 400,
    body: {
      code: "validation",
      message:
        `ops[${index}].payload must be a JSON object. An operation carries the fields it ` +
        "sets as keys, and an array or a scalar has none.",
      retryable: false,
      index,
    },
  };
}
