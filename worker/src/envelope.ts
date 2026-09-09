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
import { MAX_OP_BYTES } from "./limits.js";

/** The vocabulary from docs/sync.md. Additive within a protocol version. */
const ENTITIES = new Set([
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
]);

const VERBS = new Set(["create", "update", "delete", "replace", "renumber"]);

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
  if (!ENTITIES.has(entity)) {
    throw new SyncError("validation", `${at}.entity is not a known entity`, { index });
  }

  const verb = str(op.verb, `${at}.verb`, index);
  if (!VERBS.has(verb)) {
    throw new SyncError("validation", `${at}.verb is not a known verb`, { index });
  }
  // Ordered collections replicate whole and nothing else does. There is no per-row
  // queue or membership operation on the wire, by design: rank is never transported,
  // so the UNIQUE rank constraints are structurally unreachable.
  if (verb === "replace" && entity !== "queue" && entity !== "milestone") {
    throw new SyncError("validation", `${at}.verb 'replace' is only for ordered collections`, {
      index,
    });
  }
  if (verb === "renumber" && entity !== "issue") {
    throw new SyncError("validation", `${at}.verb 'renumber' is only for issues`, { index });
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
