/**
 * The snapshot, folded here from the ordered tail, for a log too large for the service
 * to fold.
 *
 * The Worker refuses to fold more than `MAX_SNAPSHOT_FOLD_OPS` operations in one pass
 * (`worker/src/limits.ts`, 20,000): a request's CPU and time are bounded, and a truncated
 * fold would be a snapshot that silently omits entities. Past that, every snapshot is
 * refused `unavailable`, which stopped two things for good on a large repository: a new
 * device could not join (a bootstrap is a snapshot), and a device upgraded to this build
 * failed every sync, after its push and pull had landed, because its one-time re-read
 * (`APPLIER_VERSION`) is a snapshot too.
 *
 * But the operations are all there, and the pull route serves them in pages from the
 * start of the epoch with no fold at all. So when the service refuses a snapshot as too
 * large, the device reads the whole ordered tail and folds it itself, by the same rules
 * as the Worker (`worker/src/fold.ts`): every verb merges the keys it carried, a delete is
 * a tombstone that a later create lifts, a key's other spelling is dropped when it is
 * written, provenance is kept for every verb but a create, and a create a restore staged
 * gives no time or actor. The result is exactly what the Worker would have served, and it
 * is applied by exactly the path a snapshot is (`hydrate.ts`), so everything downstream —
 * claims in log order, the conflict screen on a re-read, the tail after the cutoff — is
 * unchanged. The cutoff is the last operation read; the tail resumes after it.
 */
import type { RemoteOperation, SnapshotEntity, SnapshotFieldWrite } from "./wire.js";

interface Entry {
  entity: string;
  entityId: string;
  version: number;
  deletedAt: number | null;
  lastSeq: number;
  superseded: boolean;
  state: Record<string, unknown>;
  fieldWrites: Record<string, SnapshotFieldWrite>;
  createdSeq: number | null;
  createdAt: string | null;
  createdBy: string | null;
}

function otherSpelling(key: string): string {
  if (key.includes("_")) return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
  if (/[A-Z]/.test(key)) return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  return key;
}

/** Fold operations, in any order, into the entities a snapshot at their highest seq holds. */
export function foldOperations(ops: readonly RemoteOperation[]): SnapshotEntity[] {
  const entities = new Map<string, Entry>();
  for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
    const key = `${op.entity} ${op.entityId}`;
    let entry = entities.get(key);
    if (!entry) {
      entry = {
        entity: op.entity,
        entityId: op.entityId,
        version: 0,
        deletedAt: null,
        lastSeq: op.seq,
        superseded: false,
        state: {},
        fieldWrites: {},
        createdSeq: null,
        createdAt: null,
        createdBy: null,
      };
      entities.set(key, entry);
    }
    entry.version += 1;
    entry.lastSeq = op.seq;
    if (op.verb === "delete") {
      entry.deletedAt = typeof op.serverTs === "number" ? op.serverTs : Date.parse(op.createdAt);
      continue;
    }
    if (op.verb === "create") {
      if (entry.deletedAt !== null) {
        entry.deletedAt = null;
        entry.state = {};
        entry.fieldWrites = {};
        entry.superseded = false;
      }
      entry.createdSeq = op.seq;
      const restored = typeof op.actor === "string" && op.actor.startsWith("restore:");
      entry.createdAt = restored ? null : op.createdAt;
      entry.createdBy = restored ? null : op.actor;
    }
    if (entry.deletedAt !== null) continue;
    const payload = op.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) continue;
    for (const field of Object.keys(payload)) {
      const other = otherSpelling(field);
      if (other !== field) {
        delete entry.state[other];
        delete entry.fieldWrites[other];
      }
    }
    Object.assign(entry.state, payload);
    entry.superseded = op.verb === "replace";
    if (op.verb !== "create") {
      for (const field of Object.keys(payload)) {
        entry.fieldWrites[field] = { baseVersion: entry.version - 1, opId: op.opId, at: op.createdAt, seq: op.seq };
      }
    }
  }
  return [...entities.values()]
    .sort((a, b) => (`${a.entity} ${a.entityId}` < `${b.entity} ${b.entityId}` ? -1 : 1))
    .map((entry) => ({
      entity: entry.entity,
      entityId: entry.entityId,
      version: entry.version,
      deletedAt: entry.deletedAt,
      lastSeq: entry.lastSeq,
      verb: entry.deletedAt !== null ? "delete" : entry.superseded ? "replace" : "create",
      state: entry.state,
      fieldWrites: entry.fieldWrites,
      createdSeq: entry.createdSeq,
      createdAt: entry.createdAt,
      createdBy: entry.createdBy,
    }));
}

/** Whether a request was refused because the log is too large for the service to fold. */
export function refusedAsTooLargeToFold(error: unknown): boolean {
  const detail = (error as { detail?: Record<string, unknown> } | null)?.detail;
  return typeof detail?.maxSnapshotFoldOps === "number";
}
