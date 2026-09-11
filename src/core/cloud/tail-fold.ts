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
import { holdsLiveOrigin } from "../types.js";
import { columnSpellingWins } from "./apply.js";
import type { RemoteOperation, SnapshotEntity, SnapshotFieldWrite } from "./wire.js";

export interface Entry {
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

/**
 * The fold, one page at a time — so a device reading a long log can stop and go on later.
 *
 * Pages of the ordered tail arrive in seq order, and folding each onto what the earlier ones
 * left is the same as folding them all at once. What has been folded so far is plain data
 * (`saved`), so a sync the budget or the service's rate limit stopped part-way keeps it
 * (`sync.ts`, the tail survey), and the next resumes from the page it stopped at instead
 * of from the start of the log.
 */
export class TailFold {
  private readonly entries: Map<string, Entry>;

  constructor(saved: readonly Entry[] = []) {
    this.entries = new Map(saved.map((entry) => [`${entry.entity} ${entry.entityId}`, entry]));
  }

  /** Fold operations that come after everything folded so far. */
  add(ops: readonly RemoteOperation[]): void {
    for (const op of [...ops].sort((a, b) => a.seq - b.seq)) {
      const key = `${op.entity} ${op.entityId}`;
      let entry = this.entries.get(key);
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
        this.entries.set(key, entry);
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
      // A payload in both spellings keeps the column's (`columnSpellingWins`, `apply.ts`).
      const carried = columnSpellingWins(payload);
      for (const field of Object.keys(carried)) {
        const other = otherSpelling(field);
        if (other !== field) {
          delete entry.state[other];
          delete entry.fieldWrites[other];
        }
      }
      const statusBefore = entry.state.status;
      Object.assign(entry.state, carried);
      entry.superseded = op.verb === "replace";
      if (op.verb !== "create") {
        const write = { baseVersion: entry.version - 1, opId: op.opId, at: op.createdAt, seq: op.seq };
        for (const field of Object.keys(carried)) entry.fieldWrites[field] = write;
        // A reopen, as the service's fold records it (`reopensOrigin`, `worker/src/fold.ts`).
        if (op.entity === "issue" && !holdsLiveOrigin(statusBefore) && holdsLiveOrigin(carried.status) && typeof statusBefore === "string") {
          entry.fieldWrites.reopens = write;
        }
      }
    }
  }

  /** What has been folded so far, as plain data. */
  saved(): Entry[] {
    return [...this.entries.values()];
  }

  /** The entities a snapshot at the highest seq folded holds. */
  entities(): SnapshotEntity[] {
    return [...this.entries.values()]
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
}

/** Fold operations, in any order, into the entities a snapshot at their highest seq holds. */
export function foldOperations(ops: readonly RemoteOperation[]): SnapshotEntity[] {
  const fold = new TailFold();
  fold.add(ops);
  return fold.entities();
}

/** Whether a request was refused because the log is too large for the service to fold. */
export function refusedAsTooLargeToFold(error: unknown): boolean {
  const detail = (error as { detail?: Record<string, unknown> } | null)?.detail;
  return typeof detail?.maxSnapshotFoldOps === "number";
}
