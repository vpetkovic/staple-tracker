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
  /**
   * Who last wrote each of the entity's fields here when it was set aside (`sync_field_writes`,
   * operation ids). A field written since — later in the log, or here — has a newer value than
   * the set-aside one, which is not replayed over it (`supersededFields`).
   */
  readonly writesWhenSetAside?: Readonly<Record<string, string | null>>;
  /**
   * Already waiting when a restore's rewind read the repository here (`markWaitingAcrossRewind`).
   * The rewind keeps and sends everything unsent work names, so what such an entity still names
   * is on no timeline: a divergence, not a wait.
   */
  readonly acrossRewind?: boolean;
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

/**
 * How long an entity may wait on what it names before it is a divergence, not a wait: a week.
 * What an operation names reaches the log ahead of it or soon after — the device that sent it
 * holds it, and sends it at its next sync — so a week covers a device away that long.
 */
export const QUARANTINE_DIVERGENCE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The set-aside entities that will not land on their own: waiting since before the epoch this
 * device has since finished reading — a restore's rewind kept everything unsent work names and
 * sent it, so what is still missing after one is on no timeline — or for longer than
 * {@link QUARANTINE_DIVERGENCE_MS}. Each is a real divergence from the devices that hold what it
 * names, and `staple doctor` fails over it, naming what is missing.
 */
export function divergedQuarantine(db: DatabaseSync, now: number = Date.now()): QuarantinedEntity[] {
  return readQuarantine(db).filter((item) => {
    if (item.acrossRewind === true) return true;
    const since = Date.parse(item.since);
    return !Number.isNaN(since) && now - since > QUARANTINE_DIVERGENCE_MS;
  });
}

/** A rewinding read is under way (`sync.ts`, `readReconciled`): what waits now waits across it. */
export function markWaitingAcrossRewind(db: DatabaseSync): void {
  const items = readQuarantine(db);
  if (items.length > 0) writeQuarantine(db, items.map((item) => ({ ...item, acrossRewind: true })));
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
  items.push({ entity: op.entity, entityId: op.entityId, what: missing.what, since: nowIso(), heldWhenSetAside: entityHeld(db, op.entity, op.entityId), writesWhenSetAside: fieldWritesOf(db, op.entity, op.entityId), operation: op });
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
  items.push({ entity: entity.entity, entityId: entity.entityId, what: missing.what, since: nowIso(), heldWhenSetAside: entityHeld(db, entity.entity, entity.entityId), writesWhenSetAside: fieldWritesOf(db, entity.entity, entity.entityId), snapshot: { entity, ...read } });
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
    // What was written since it was set aside is newer than it, and stays.
    const superseded = supersededFields(db, item);
    try {
      if (item.snapshot) {
        // A later create brought it: the tail is newer than the snapshot.
        if (!item.heldWhenSetAside && holds(item.entity, item.entityId) && CREATED.has(item.entity)) {
          settled += 1;
          continue;
        }
        const state = withoutFields(item.snapshot.entity.state, superseded, heldUpdatedAt(db, item.entity, item.entityId));
        if (state === null) {
          settled += 1;
          continue;
        }
        const fieldWrites = item.snapshot.entity.fieldWrites
          ? Object.fromEntries(Object.entries(item.snapshot.entity.fieldWrites).filter(([field]) => !superseded.has(field)))
          : undefined;
        apply.snapshot({ ...item.snapshot.entity, state, ...(fieldWrites ? { fieldWrites } : {}) } as SnapshotEntity, item.snapshot.cutoffSeq, item.snapshot.ledger, item.snapshot.sameTimeline);
        brought.add(key);
        settled += 1;
        continue;
      }
      const op = item.operation!;
      if (op.verb !== "create" && op.verb !== "delete" && !item.heldWhenSetAside && holds(item.entity, item.entityId) && !brought.has(key) && CREATED.has(item.entity)) {
        // An edit of an entity a later create made: that create already carries it.
        settled += 1;
        continue;
      }
      if (op.verb !== "create" && op.verb !== "delete") {
        const payload = withoutFields(op.payload, superseded, heldUpdatedAt(db, op.entity, op.entityId));
        // Every field it writes was written again later: the log's order drops it.
        if (payload !== null) apply.operation({ ...op, payload });
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

/** The entities a `create` brings whole; the collections — a blocker set, the plan, a milestone — have none. */
const CREATED: ReadonlySet<string> = new Set(["issue", "comment", "project", "status", "kind", "documentRevision"]);

/**
 * An operation applied out of its place in the log — after operations later than it, because
 * what it named arrived after them (a page's deferred retry, `sync.ts`) — without the fields
 * one of those later operations already wrote here. Null when nothing it writes is left. A
 * create or a delete is returned as it is.
 */
export function withoutLaterWrites(db: DatabaseSync, op: RemoteOperation): RemoteOperation | null {
  if (op.verb === "create" || op.verb === "delete") return op;
  const superseded = supersededFields(db, { entity: op.entity, entityId: op.entityId, what: "", since: "", operation: op });
  const payload = withoutFields(op.payload, superseded, heldUpdatedAt(db, op.entity, op.entityId));
  return payload === null ? null : { ...op, payload };
}

/** A collection's list travels with its per-entry facts: superseded together. */
const COMPANIONS: Readonly<Record<string, readonly string[]>> = {
  blockedBy: ["edges"],
  order: ["entries"],
  members: ["entries"],
};

function fieldWritesOf(db: DatabaseSync, entity: string, entityId: string): Record<string, string | null> {
  const rows = db.prepare("SELECT field, op_id FROM sync_field_writes WHERE entity = ? AND entity_id = ?").all(entity, entityId) as Array<{ field: string; op_id: string | null }>;
  return Object.fromEntries(rows.map((row) => [row.field, row.op_id]));
}

/**
 * Where an operation that wrote a field here sits in the log: its seq when it was applied from
 * the log or acknowledged, after everything when this device has not sent it yet, and null when
 * this device cannot say (a snapshot's inherited write, or a ledger row compacted away).
 */
function positionOf(db: DatabaseSync, opId: string | null): number | null {
  if (opId === null) return null;
  const applied = db.prepare("SELECT seq FROM sync_applied WHERE op_id = ?").get(opId) as { seq: number } | undefined;
  if (applied) return applied.seq;
  const own = db.prepare("SELECT acknowledged_seq FROM sync_outbox WHERE op_id = ?").get(opId) as { acknowledged_seq: number | null } | undefined;
  if (own) return own.acknowledged_seq ?? Number.POSITIVE_INFINITY;
  return null;
}

/**
 * The fields a later write holds here: written by an operation after the set-aside one in the
 * log — the snapshot's cutoff, for one set aside from a snapshot — or by this device after it.
 * The log's order, which the set-aside write would have lost to had it applied in its place.
 * Where this device cannot place the write, a write made since it was set aside counts. With
 * each field, what travels with it.
 */
function supersededFields(db: DatabaseSync, item: QuarantinedEntity): Set<string> {
  const out = new Set<string>();
  const at = item.operation ? item.operation.seq : item.snapshot ? item.snapshot.cutoffSeq : null;
  for (const [field, opId] of Object.entries(fieldWritesOf(db, item.entity, item.entityId))) {
    if (item.operation && opId === item.operation.opId) continue;
    const position = positionOf(db, opId);
    const later =
      position !== null && at !== null
        ? position > at
        : item.writesWhenSetAside !== undefined && item.writesWhenSetAside[field] !== opId;
    if (!later) continue;
    out.add(field);
    for (const companion of COMPANIONS[field] ?? []) out.add(companion);
  }
  return out;
}

/**
 * A payload or state without the superseded fields; null when nothing it writes is left. When
 * any field was written later, so was the entity's last-change time: what is left carries the
 * later of its own and the one held here (`heldAt`), never an older one over it.
 */
function withoutFields(record: Readonly<Record<string, unknown>>, superseded: ReadonlySet<string>, heldAt: string | null = null): Record<string, unknown> | null {
  if (superseded.size === 0) return { ...record };
  const kept = Object.entries(record).filter(([field]) => !superseded.has(field) && field !== "updatedAt" && field !== "updated_at");
  if (kept.length === 0) return null;
  const own = typeof record.updatedAt === "string" ? record.updatedAt : typeof record.updated_at === "string" ? record.updated_at : null;
  const latest = [own, heldAt].filter((at): at is string => at !== null).sort().pop() ?? null;
  return { ...Object.fromEntries(kept), ...(latest !== null ? { updatedAt: latest } : {}) };
}

/** The entity's last-change time as this device holds it, for the entities that keep one. */
function heldUpdatedAt(db: DatabaseSync, entity: string, entityId: string): string | null {
  const read = (sql: string): string | null => (db.prepare(sql).get(entityId) as { at: string | null } | undefined)?.at ?? null;
  switch (entity) {
    case "issue":
      return read("SELECT updated_at AS at FROM issues WHERE id = ?");
    case "milestone":
      return read("SELECT updated_at AS at FROM milestone_meta WHERE issue_id = ?");
    case "project":
      return read("SELECT updated_at AS at FROM projects WHERE id = ?");
    default:
      return null;
  }
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
