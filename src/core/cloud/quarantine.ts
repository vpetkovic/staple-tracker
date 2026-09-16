/**
 * What names something this device does not hold waits here, and the rest applies.
 *
 * Contract: `docs/sync.md`, "No entity can stop a sync".
 *
 * A snapshot page or a page of the ordered tail used to fail whole when one entity named
 * something that never arrived — a comment on an issue the repository does not hold, an
 * edit of an issue whose create is nowhere — and the next sync met the same page and failed
 * the same way, for ever, on every device that read it and on every device that joined. One
 * device's write could stop the whole repository. Now such an entity is set aside, in `meta`
 * (which never synchronizes; a table would be a migration, and a migration moves the schema
 * every operation carries), everything else applies, the position moves on, and each
 * set-aside entity is tried again whenever more of the log has landed:
 *
 *   - a snapshot entity applies once what it names is here and it is not — a create after
 *     the snapshot, being later in the log, already carries what this device should hold,
 *     and the snapshot's older state is dropped;
 *   - an operation applies in its order once what it names is here: a create when its
 *     entity is not; an edit when its entity was brought here by a create set aside before
 *     it. An edit of an entity a later create made is dropped: that create is the whole
 *     entity as its author held it, after the edit.
 *
 * `staple cloud status` and `staple doctor` say how many are waiting, and on what.
 */
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../types.js";
import { ReferentMissing } from "./apply.js";
import type { RemoteOperation, SnapshotEntity } from "./wire.js";

const KEY = "sync_quarantine";

export interface QuarantinedEntity {
  readonly entity: string;
  readonly entityId: string;
  /** What it names that this device does not hold. */
  readonly what: string;
  readonly since: string;
  /**
   * Whether this device held the entity itself when it was set aside. One it did not — an edit
   * whose create was missing — is dropped once a later create brings it (that create carries
   * the whole entity); one it did waited on something else it names, and applies when that
   * arrives.
   */
  readonly heldWhenSetAside?: boolean;
  /** Set aside from the ordered tail. */
  readonly operation?: RemoteOperation;
  /** Set aside from a snapshot, with the read it was part of. */
  readonly snapshot?: { readonly entity: SnapshotEntity; readonly cutoffSeq: number; readonly ledger: string; readonly sameTimeline: boolean };
}

export function readQuarantine(db: DatabaseSync): QuarantinedEntity[] {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return [];
  try {
    const parsed = JSON.parse(row.value) as unknown;
    return Array.isArray(parsed) ? (parsed as QuarantinedEntity[]) : [];
  } catch {
    return [];
  }
}

function writeQuarantine(db: DatabaseSync, items: readonly QuarantinedEntity[]): void {
  if (items.length === 0) {
    db.prepare("DELETE FROM meta WHERE key = ?").run(KEY);
    return;
  }
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(KEY, JSON.stringify(items));
}

/** How many entities are waiting. Zero when none are, or the table cannot be read. */
export function countQuarantined(db: DatabaseSync): number {
  try {
    return readQuarantine(db).length;
  } catch {
    return 0;
  }
}

/** Set an operation of the ordered tail aside. */
export function quarantineOperation(db: DatabaseSync, op: RemoteOperation, missing: ReferentMissing): void {
  const items = readQuarantine(db).filter((item) => item.operation?.opId !== op.opId);
  items.push({ entity: op.entity, entityId: op.entityId, what: missing.what, since: nowIso(), heldWhenSetAside: entityHeld(db, op.entity, op.entityId), operation: op });
  writeQuarantine(db, items);
}

/** Set a snapshot entity aside. */
export function quarantineSnapshotEntity(
  db: DatabaseSync,
  entity: SnapshotEntity,
  missing: ReferentMissing,
  read: { cutoffSeq: number; ledger: string; sameTimeline: boolean },
): void {
  const items = readQuarantine(db).filter((item) => !(item.snapshot && item.entity === entity.entity && item.entityId === entity.entityId));
  items.push({ entity: entity.entity, entityId: entity.entityId, what: missing.what, since: nowIso(), heldWhenSetAside: entityHeld(db, entity.entity, entity.entityId), snapshot: { entity, ...read } });
  writeQuarantine(db, items);
}

/**
 * Try every set-aside entity again, in the order they were set aside; keep what still cannot
 * land. Runs inside the caller's transaction. Returns how many applied or were dropped.
 *
 * The two appliers are passed in — `applySnapshotEntity` (`hydrate.ts`) and the pull's own
 * (`sync.ts`), which screens for conflicts as for any operation — and each throws
 * {@link ReferentMissing} for what still cannot land.
 */
export function retryQuarantine(
  db: DatabaseSync,
  apply: {
    snapshot: (entity: SnapshotEntity, cutoffSeq: number, ledger: string, sameTimeline: boolean) => void;
    operation: (op: RemoteOperation) => void;
  },
): number {
  const items = readQuarantine(db);
  if (items.length === 0) return 0;
  const holds = (entity: string, entityId: string): boolean => entityHeld(db, entity, entityId);
  const brought = new Set<string>();
  const waiting: QuarantinedEntity[] = [];
  let settled = 0;
  for (const item of items) {
    const key = `${item.entity} ${item.entityId}`;
    try {
      if (item.snapshot) {
        // A later create brought it: the tail is newer than the snapshot.
        if (!item.heldWhenSetAside && holds(item.entity, item.entityId)) {
          settled += 1;
          continue;
        }
        apply.snapshot(item.snapshot.entity, item.snapshot.cutoffSeq, item.snapshot.ledger, item.snapshot.sameTimeline);
        brought.add(key);
        settled += 1;
        continue;
      }
      const op = item.operation!;
      if (op.verb !== "create" && op.verb !== "delete" && !item.heldWhenSetAside && holds(item.entity, item.entityId) && !brought.has(key)) {
        // An edit of an entity a later create made: that create already carries it.
        settled += 1;
        continue;
      }
      apply.operation(op);
      if (op.verb === "create") brought.add(key);
      settled += 1;
    } catch (error) {
      if (!(error instanceof ReferentMissing)) throw error;
      waiting.push({ ...item, what: error.what });
    }
  }
  writeQuarantine(db, waiting);
  return settled;
}

/** Whether this device holds a row of an entity, for the entities that can name another. */
function entityHeld(db: DatabaseSync, entity: string, entityId: string): boolean {
  const hit = (sql: string, ...params: string[]): boolean => db.prepare(sql).get(...params) !== undefined;
  switch (entity) {
    case "issue":
      return hit("SELECT 1 FROM issues WHERE id = ?", entityId);
    case "comment":
      return hit("SELECT 1 FROM comments WHERE id = ?", entityId);
    case "project":
      return hit("SELECT 1 FROM projects WHERE id = ?", entityId);
    case "status":
      return hit("SELECT 1 FROM workspace_statuses WHERE id = ?", entityId);
    case "kind":
      return hit("SELECT 1 FROM workspace_kinds WHERE id = ?", entityId);
    case "relation":
      return hit("SELECT 1 FROM relations WHERE blocked_id = ? AND type = 'blocks'", entityId);
    case "milestone":
      return hit("SELECT 1 FROM milestone_meta WHERE issue_id = ? UNION SELECT 1 FROM milestone_members WHERE milestone_id = ?", entityId, entityId);
    case "documentRevision": {
      const slash = entityId.lastIndexOf("/");
      const document = entityId.slice(0, slash);
      const split = document.indexOf("/");
      return hit("SELECT 1 FROM document_revisions WHERE issue_id = ? AND key = ? AND revision = ?", document.slice(0, split), document.slice(split + 1), entityId.slice(slash + 1));
    }
    default:
      return false;
  }
}
