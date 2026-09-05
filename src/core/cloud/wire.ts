/**
 * The wire shapes, and the one transformation an envelope undergoes on its way
 * out.
 *
 * Contract: `docs/sync.md`, "Routes and limits" and "The operation envelope".
 * The authority for the shapes is `worker/src/` — *"Where they disagree the
 * Worker wins, because the Worker is what is deployed"* — and every place the two
 * disagree is marked `DIVERGENCE:`.
 *
 * ## There is no client-side screen, on purpose
 *
 * An earlier draft of this file filtered the batch against a mirror of
 * `worker/src/envelope.ts` so that one unsendable operation could not fail the
 * whole push. That was the wrong instinct and it is recorded here so it is not
 * reinvented: it converts a loud, fixable emitter bug into silent
 * non-synchronization. The repository looks connected, the push reports success,
 * and some operations quietly never arrive.
 *
 * A batch the server refuses is a bug in what the seam journaled, and it belongs
 * in a stack trace with an error code on it. The three operations that used to
 * need quarantining were emitting `replace` for entities that are not ordered
 * collections; that was fixed at the emitter in `src/core/store.ts`, which is
 * where it belonged.
 */
import type { OperationEnvelope } from "../journal.js";

// ------------------------------------------------------------------- shapes

/** One operation's outcome in a push response. `duplicate` is a success. */
export interface PushResult {
  readonly opId: string;
  readonly status: "applied" | "duplicate";
  /**
   * The server's sequence number. For a `duplicate` this is the seq of the
   * ORIGINAL application, not a new one — which is what lets a client that lost
   * an acknowledgement reconcile from this response without re-deriving
   * anything.
   */
  readonly seq: number;
}

export interface PushResponse {
  readonly protocol: number;
  readonly epoch: number;
  readonly serverHighWatermark: number;
  readonly results: readonly PushResult[];
}

/** An operation as it comes back off the wire. The server adds `seq` and `epoch`. */
export interface RemoteOperation {
  readonly opId: string;
  readonly seq: number;
  readonly epoch: number;
  readonly protocol: number;
  readonly schema: number;
  readonly entity: string;
  readonly entityId: string;
  readonly verb: string;
  readonly baseVersion: number | null;
  readonly payload: Record<string, unknown>;
  readonly deviceId: string;
  readonly actor: string | null;
  readonly clientSeq: number;
  readonly createdAt: string;
  readonly serverTs: number;
}

export interface PullPage {
  readonly protocol: number;
  readonly epoch: number;
  readonly serverHighWatermark: number;
  readonly ops: readonly RemoteOperation[];
  /** Opaque. Stored and replayed, never parsed. */
  readonly nextCursor: string;
  readonly hasMore: boolean;
}

/** One entity's folded state at the snapshot cutoff. */
export interface SnapshotEntity {
  readonly entity: string;
  readonly entityId: string;
  /** Operations folded into this entity. Becomes the local entity version. */
  readonly version: number;
  /** Server timestamp of the tombstone, or null. A tombstone is data. */
  readonly deletedAt: number | null;
  readonly lastSeq: number;
  readonly state: Record<string, unknown>;
}

export interface SnapshotPage {
  readonly protocol: number;
  readonly epoch: number;
  readonly cutoffSeq: number;
  /** The PULL cursor for the tail this snapshot pinned. Opaque. */
  readonly tailCursor: string;
  readonly entities: readonly SnapshotEntity[];
  /** The next SNAPSHOT page, or null when this was the last. Opaque. */
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

// ------------------------------------------------------------------ outbound

/**
 * The envelope as the server wants it.
 *
 * DIVERGENCE: `worker/src/envelope.ts` requires `actor` to be a **string**, and
 * `sync_outbox.actor` is nullable — several mutations legitimately have no actor,
 * a system-initiated ancestor status recompute among them. Null is sent as the
 * empty string rather than omitted, because omitting it is a `validation`
 * rejection of the whole batch, and the empty string reads back as "no actor" on
 * the applying side. The durable fix is to make the seam resolve an actor for
 * every mutation, which touches four emitters and is filed separately.
 *
 * Nothing else is transformed. `payload` goes out exactly as the seam recorded
 * it, including fields this build has no column for, because *"Unknown fields are
 * preserved, never dropped."*
 */
export function toWireEnvelope(op: OperationEnvelope): Record<string, unknown> {
  return {
    opId: op.opId,
    repoId: op.repoId,
    protocol: op.protocol,
    schema: op.schema,
    entity: op.entity,
    entityId: op.entityId,
    verb: op.verb,
    baseVersion: op.verb === "create" ? null : op.baseVersion,
    payload: op.payload,
    deviceId: op.deviceId,
    actor: op.actor ?? "",
    clientSeq: op.clientSeq,
    createdAt: op.createdAt,
  };
}
