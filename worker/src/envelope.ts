/**
 * Envelope validation.
 *
 * The server validates the envelope's SHAPE and its SCOPE, and nothing about its
 * meaning. `payload` is stored verbatim, `opId` is treated as opaque text and never
 * parsed, and unknown fields inside a payload are preserved untouched — that is what
 * lets a mixed-version fleet round-trip a workspace without an older build deleting a
 * newer one's data.
 */

import { SyncError } from "./errors.js";
import { MAX_OP_BYTES, PROTOCOL_MAX, PROTOCOL_MIN } from "./limits.js";

/**
 * The vocabulary from docs/sync.md, PER PROTOCOL VERSION.
 *
 * This used to be one set with the comment *"additive within a protocol version"*.
 * That claim came from the contract, and the contract was wrong about entities. It
 * is true of FIELDS — an unknown field is stored verbatim and re-emitted, which is
 * what makes a mixed fleet round-trip — but the applying side of an unknown ENTITY
 * is `src/core/cloud/apply.ts`, whose `default` branch throws:
 *
 *     `Operation names entity "…", which this build does not know. Upgrade staple;
 *      nothing was applied.`
 *
 * and the pull loop defers only `ReferentMissing`. So an older device pulling a log
 * containing an entity added after its release does not ignore it — it fails the
 * page and stops converging. `apply.ts` says as much about `lease` and `conflict`,
 * which it no-ops deliberately *"so that a newer device pushing one cannot stall an
 * older device's whole page"*: the throw is the known-bad outcome, and those two
 * were special-cased out of it one at a time.
 *
 * Widening the vocabulary is therefore a protocol change, not an additive one, and
 * it is declared as one. `registration` and `crossLink` require protocol 2, so a
 * protocol-1 client cannot push them and — see `pull.ts` and `snapshot.ts` — cannot
 * be handed them either. It gets 426 with the supported range, which names the
 * remedy, instead of a 400 about an entity it has never heard of.
 */
const ENTITIES_BY_PROTOCOL: ReadonlyArray<readonly [number, ReadonlySet<string>]> = [
  [
    1,
    new Set([
      "issue",
      "comment",
      "document",
      "documentRevision",
      "relation",
      "project",
      "status",
      "kind",
      "setting",
      "milestone",
      "queue",
      "lease",
      "conflict",
    ]),
  ],
  /**
   * The hub registry (STA-283). The hub is a repository scoped by its own
   * `hub.hubId()`, and these two entities are its whole log — so `backup` is the
   * existing fold and `restore` is the existing snapshot, with no new storage
   * concept anywhere in this service.
   *
   * `registration` is keyed by the workspace's `repositoryId`, the clone-surviving
   * UUID that is the only thing two machines can agree names the same workspace.
   * `crossLink` is keyed by its four names, percent-encoded and joined — injective,
   * so the same edge is the same entity on both machines.
   */
  [2, new Set(["registration", "crossLink"])],
];

/** The registry entities, named once so three files can ask about them. */
export const REGISTRY_ENTITIES: ReadonlySet<string> = new Set(["registration", "crossLink"]);

/**
 * The lowest protocol that admits this entity, or null when no version does.
 *
 * Consulted by `pull.ts`, `snapshot.ts` and `backups.ts` as well as by validation,
 * so there is exactly one table saying which entity belongs to which version. Two
 * tables would drift, and the way they would drift is a route serving an entity the
 * validator would have refused.
 */
export function minProtocolFor(entity: string): number | null {
  for (const [protocol, entities] of ENTITIES_BY_PROTOCOL) {
    if (entities.has(entity)) return protocol;
  }
  return null;
}

/** The highest protocol any of these entities requires. 1 for an empty list. */
export function protocolForEntities(entities: Iterable<{ entity: string }>): number {
  let required = 1;
  for (const row of entities) {
    const min = minProtocolFor(row.entity);
    if (min !== null && min > required) required = min;
  }
  return required;
}

const VERBS = new Set(["create", "update", "delete", "replace", "renumber"]);

/**
 * The only entities a `replace` or a `renumber` may name.
 *
 * Named sets rather than inline comparisons so the explicit registry assertion
 * below cannot be read as duplicating them. See there for why it is not.
 */
const REPLACEABLE = new Set(["queue", "milestone"]);
const RENUMBERABLE = new Set(["issue"]);

export interface Envelope {
  opId: string;
  repoId: string;
  protocol: number;
  schema: number;
  entity: string;
  entityId: string;
  verb: string;
  baseVersion: number | null;
  payload: unknown;
  deviceId: string;
  actor: string;
  clientSeq: number;
  createdAt: string;
}

/**
 * Validate one envelope against the authenticated session.
 *
 * `index` is only used to say WHICH operation was bad. The message never echoes a
 * field value back, because a rejected envelope is attacker-controlled input and a
 * reflected value is one `console.log` away from being stored.
 */
export function validateEnvelope(
  raw: unknown,
  index: number,
  session: { repoId: string; deviceId: string },
  protocol: number,
): Envelope {
  const at = `ops[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new SyncError("validation", `${at} is not an object`, { index });
  }
  const op = raw as Record<string, unknown>;

  const opId = str(op.opId, `${at}.opId`, index);
  // Opaque, but bounded: it is a database key, and an unbounded one is a denial of
  // service against the index rather than a correctness problem.
  if (opId.length === 0 || opId.length > 128) {
    throw new SyncError("validation", `${at}.opId has an implausible length`, { index });
  }

  /**
   * Cross-repository rejection, at the envelope level.
   *
   * The repoId that reaches the database comes from the session and never from here,
   * so a mismatched body value cannot cause a cross-repository write. It is rejected
   * anyway, and as `forbidden` rather than `validation`, because a client that
   * believes it is pushing to a different repository than its credential names has a
   * bug that silently succeeding would hide.
   */
  const repoId = str(op.repoId, `${at}.repoId`, index);
  if (repoId !== session.repoId) {
    throw new SyncError("forbidden", `${at}.repoId does not match the credential's repository`, {
      index,
    });
  }

  // Same argument for deviceId: the credential names the device, so an envelope
  // claiming another device is either a bug or an attempt to forge attribution.
  const deviceId = str(op.deviceId, `${at}.deviceId`, index);
  if (deviceId !== session.deviceId) {
    throw new SyncError("forbidden", `${at}.deviceId does not match the credential's device`, {
      index,
    });
  }

  const opProtocol = int(op.protocol, `${at}.protocol`, index);
  if (opProtocol !== protocol) {
    throw new SyncError("validation", `${at}.protocol disagrees with the request header`, {
      index,
    });
  }

  const entity = str(op.entity, `${at}.entity`, index);
  const entityProtocol = minProtocolFor(entity);
  if (entityProtocol === null) {
    throw new SyncError("validation", `${at}.entity is not a known entity`, { index });
  }
  /**
   * A known entity from a LATER protocol than this request negotiated.
   *
   * `protocol_unsupported` (426) rather than `validation` (400), and carrying the
   * version that would admit it. The two answers are read differently by a human:
   * 400 says "you sent nonsense", which invites a look at the emitter, while 426
   * says "raise your protocol", which is the actual remedy. It is also the code the
   * contract already reserves for exactly this — *"a client outside that range is
   * refused with `protocol_unsupported`, carrying the supported range, before any
   * write"* — and this refusal happens in the same place, before any statement is
   * prepared.
   */
  if (entityProtocol > protocol) {
    throw new SyncError(
      "protocol_unsupported",
      `${at}.entity requires a newer protocol than this request negotiated`,
      { index, min: PROTOCOL_MIN, max: PROTOCOL_MAX, requiredProtocol: entityProtocol },
    );
  }

  const verb = str(op.verb, `${at}.verb`, index);
  if (!VERBS.has(verb)) {
    throw new SyncError("validation", `${at}.verb is not a known verb`, { index });
  }
  // Ordered collections replicate whole and nothing else does. There is no per-row
  // queue or membership operation on the wire, by design: rank is never transported,
  // so the UNIQUE rank constraints are structurally unreachable.
  if (verb === "replace" && !REPLACEABLE.has(entity)) {
    throw new SyncError("validation", `${at}.verb 'replace' is only for ordered collections`, {
      index,
    });
  }
  if (verb === "renumber" && !RENUMBERABLE.has(entity)) {
    throw new SyncError("validation", `${at}.verb 'renumber' is only for issues`, { index });
  }
  /**
   * The same two refusals again, stated about the registry entities directly.
   *
   * This is deliberately redundant with the two checks above and is NOT dead code.
   * Those checks refuse `registration` and `crossLink` today only because neither
   * name happens to be in `REPLACEABLE` or `RENUMBERABLE` — an accident of what
   * those sets currently contain, not a statement about the registry. The day
   * somebody adds a third ordered collection they will add it to `REPLACEABLE`, and
   * nothing about that edit would prompt a thought about the registry.
   *
   * A registry entity is neither an ordered collection nor an issue. A `replace`
   * would claim authority over keys it did not carry for an entity whose whole
   * meaning is its keys, and `renumber` is about identifiers the hub does not own —
   * `hub-registry.ts` is emphatic that no prefix is ever renumbered, because a
   * prefix is stamped into commit messages and handoffs no migration can reach. So
   * both are refused by name, and `worker/test/registry.test.ts` asserts the refusal
   * against these entities specifically rather than against the allowlists.
   */
  if (REGISTRY_ENTITIES.has(entity) && (verb === "replace" || verb === "renumber")) {
    throw new SyncError(
      "validation",
      `${at}.verb '${verb}' is never valid for a registry entity`,
      { index },
    );
  }
  /**
   * `delete` is refused for a registry entity too, and this one is a correctness fence
   * rather than a tidiness rule.
   *
   * A tombstone is FINAL in the fold — every later operation on a deleted entity is
   * discarded — and that is right for an `issue`, whose id is minted once, because
   * resurrecting one is meaningless. A registry entity's id is **derived from its
   * content**: a `crossLink`'s key is its four names, and a `registration`'s is the
   * workspace's `repositoryId`. So removing an edge and adding it back produces the same
   * entity id, lands on the tombstone, and is silently dropped while the push reports
   * success — and a restore carries the tombstone into the new epoch, because
   * `materializedVerb` reproduces a bare `delete`. The epoch bump is not an escape.
   *
   * So retraction is a FIELD (`present: false` on a cross-link) and this vocabulary has
   * no delete at all. Refused here rather than merely not emitted, because the client is
   * not the only thing that can push and "we do not send that" is not an invariant.
   *
   * The restore path is unaffected and deliberately so: `backups.ts` stages materialised
   * operations straight into D1 without going through this validator, which is what lets
   * a backup taken before this rule still be restored faithfully, tombstones included.
   */
  if (REGISTRY_ENTITIES.has(entity) && verb === "delete") {
    throw new SyncError(
      "validation",
      `${at}.verb 'delete' is never valid for a registry entity — a retraction is a field, ` +
        "because a tombstone on a content-derived key can never be undone",
      { index },
    );
  }

  // `baseVersion` is null for `create` and an integer otherwise. The server records it
  // and does not act on it: conflict detection is field-scoped against a LOCAL entity
  // version, and the only party that knows its own local version is the applying
  // device.
  let baseVersion: number | null = null;
  if (op.baseVersion !== null && op.baseVersion !== undefined) {
    baseVersion = int(op.baseVersion, `${at}.baseVersion`, index);
  } else if (verb !== "create") {
    throw new SyncError("validation", `${at}.baseVersion is required for '${verb}'`, { index });
  }

  if (op.payload === null || typeof op.payload !== "object") {
    throw new SyncError("validation", `${at}.payload must be an object or an array`, { index });
  }
  // Per-operation cap, measured on the serialized payload. The whole-body cap already
  // ran on Content-Length; this one is what makes "one enormous operation inside a
  // legal-sized batch" a stable `payload_too_large` rather than a stored 2 MB row.
  const payloadBytes = new TextEncoder().encode(JSON.stringify(op.payload)).length;
  if (payloadBytes > MAX_OP_BYTES) {
    throw new SyncError("payload_too_large", `${at}.payload exceeds the documented cap`, {
      index,
      maxBytes: MAX_OP_BYTES,
      bytes: payloadBytes,
    });
  }

  return {
    opId,
    repoId,
    protocol: opProtocol,
    schema: int(op.schema, `${at}.schema`, index),
    entity,
    entityId: str(op.entityId, `${at}.entityId`, index),
    verb,
    baseVersion,
    payload: op.payload,
    deviceId,
    actor: str(op.actor, `${at}.actor`, index),
    clientSeq: int(op.clientSeq, `${at}.clientSeq`, index),
    createdAt: str(op.createdAt, `${at}.createdAt`, index),
  };
}

function str(value: unknown, field: string, index: number): string {
  if (typeof value !== "string") {
    throw new SyncError("validation", `${field} must be a string`, { index });
  }
  return value;
}

function int(value: unknown, field: string, index: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SyncError("validation", `${field} must be an integer`, { index });
  }
  return value;
}
