/**
 * A restore rewinds the repository, and every device that follows it rewinds with it.
 *
 * Contract: `docs/sync.md`, "A restore rewinds".
 *
 * A restore puts the repository back to a backup, in a new epoch, and every device
 * re-bootstraps into it (`beginBootstrap`). The snapshot it reads says what the repository
 * holds. What it does not say is everything pushed to the old epoch after the backup — and a
 * device that held such a row kept it, while a device joining afterwards never had it: two
 * devices on one timeline, disagreeing for good. A restore is for undoing what came after the
 * backup, so that is what every device does once the new epoch's snapshot is in hand:
 *
 *   - a row this device holds that the new epoch does not, and that was pushed — this
 *     device's own, acknowledged, or one it applied from the log — is removed, with what
 *     hangs off it. A built-in status or kind is put back as every device's migrations
 *     install it, and the vocabulary's order is the one a device hydrating now holds;
 *   - work this device never sent — its outbox's unacknowledged operations — is kept, with
 *     whatever it names that the new epoch lacks, and sent into the new epoch: its queued
 *     operations as they are, and a `create` of each kept entity the queue has none for, as
 *     a heal sends one (`seed.ts`). A restore never silently discards unsent work.
 *
 * Every device, and a fresh one, then holds the same. Revisions of documents are settled
 * the same way by the read itself (`settleRevisionsAfterRead`, `apply.ts`).
 */
import type { DatabaseSync } from "node:sqlite";
import type { Journal, SyncEntity } from "../journal.js";
import { WORKSPACE_SETTING_META_PREFIX } from "../settings-registry.js";
import { BUILTIN_KIND_SEED, BUILTIN_STATUS_SEED, nowIso } from "../types.js";
import { settingsMoved, type SnapshotRead } from "./apply.js";
import { localInventory } from "./seed.js";
import { clearRewind, readRewind } from "./sync-state.js";

const QUEUE_PLAN_ID = "@plan";
const ORDER_ID = "@order";

export interface RewindReport {
  /** Rows the new epoch does not hold, removed here. */
  readonly removed: number;
  /** Built-in statuses and kinds put back as installed. */
  readonly restoredBuiltins: number;
  /** Entities kept for unsent work and sent into the new epoch as a `create`. */
  readonly republished: number;
}

type Key = `${string} ${string}`;
const keyOf = (entity: string, id: string): Key => `${entity} ${id}`;

/**
 * Rewind to the snapshot just read, when a restore moved the epoch. Runs once the read is
 * complete, inside its transaction, and outside the applier's suppressed scope: what it
 * sends is journaled like any mutation made here. Null when no rewind is owed.
 */
export function rewindToSnapshot(db: DatabaseSync, journal: Journal, read: SnapshotRead): RewindReport | null {
  const owed = readRewind(db);
  if (owed === null) return null;
  const placedQuery = db.prepare("SELECT 1 AS hit FROM sync_applied WHERE op_id = ?");
  const placed = (entity: string, id: string): boolean => placedQuery.get(`${read.prefix}${keyOf(entity, id)}`) !== undefined;
  const versioned = db.prepare("SELECT 1 AS hit FROM sync_entity_versions WHERE entity = ? AND entity_id = ?");
  const journaled = db.prepare("SELECT 1 AS hit FROM sync_outbox WHERE entity = ? AND entity_id = ? LIMIT 1");
  // Known to synchronization: written here and journaled, or applied from a log.
  const known = (entity: string, id: string): boolean => versioned.get(entity, id) !== undefined || journaled.get(entity, id) !== undefined;

  const unsent = db
    .prepare("SELECT entity, entity_id AS id, verb FROM sync_outbox WHERE acknowledged_seq IS NULL ORDER BY client_seq")
    .all() as Array<{ entity: string; id: string; verb: string }>;
  const unsentCreates = new Set(unsent.filter((op) => op.verb === "create").map((op) => keyOf(op.entity, op.id)));

  // Kept: unsent work the new epoch lacks, and whatever it names that the new epoch lacks.
  const kept = new Set<Key>();
  const keep = (entity: string, id: string): void => {
    const key = keyOf(entity, id);
    if (kept.has(key) || placed(entity, id) || !holds(db, entity, id)) return;
    kept.add(key);
    for (const [named, namedId] of referents(db, entity, id)) keep(named, namedId);
  };
  for (const op of unsent) {
    if (op.entity === "documentRevision") keep("issue", op.id.slice(0, op.id.indexOf("/")));
    else keep(op.entity, op.id);
  }

  const builtins: ReadonlyArray<readonly [SyncEntity, string]> = [
    ...BUILTIN_STATUS_SEED.map((status) => ["status", status.id as string] as const),
    ...BUILTIN_KIND_SEED.map((kind) => ["kind", kind.id as string] as const),
  ];
  const builtin = new Set(builtins.map(([entity, id]) => keyOf(entity, id)));

  // Rewound: everything else the new epoch lacks that was ever synchronized.
  let removed = 0;
  for (const [entity, id] of heldEntities(db)) {
    const key = keyOf(entity, id);
    if (builtin.has(key) || kept.has(key) || placed(entity, id) || !known(entity, id)) continue;
    removed += remove(db, entity, id);
  }

  // A built-in the new epoch says nothing about is the one every device's migrations install.
  let restoredBuiltins = 0;
  for (const [entity, id] of builtins) {
    if (placed(entity, id) || kept.has(keyOf(entity, id))) continue;
    if (reinstall(db, entity, id)) restoredBuiltins += 1;
  }

  for (const entity of ["status", "kind"] as const) {
    freshOrder(db, entity, owed.vocabulary[entity] ?? { seqs: {}, order: null }, placed(entity, ORDER_ID), kept);
  }
  settingsMoved(db, true);

  // Sent into the new epoch: each kept entity the queue holds no create of, whole.
  const republish = localInventory(db, nowIso()).filter((local) => {
    const key = keyOf(local.entity, local.entityId);
    return kept.has(key) && !unsentCreates.has(key);
  });
  if (republish.length > 0) {
    journal.run(() => {
      for (const local of republish) {
        journal.record({ entity: local.entity, entityId: local.entityId, verb: "create", payload: local.payload, actor: local.actor });
      }
    });
  }
  clearRewind(db);
  return { removed, restoredBuiltins, republished: republish.length };
}

/** Every entity this device holds a row of, but its document revisions (settled by the read). */
function heldEntities(db: DatabaseSync): Array<readonly [SyncEntity, string]> {
  const ids = (sql: string, ...params: string[]): string[] => (db.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id);
  const out: Array<readonly [SyncEntity, string]> = [];
  for (const key of ids("SELECT key AS id FROM meta WHERE key LIKE ? ORDER BY key", `${WORKSPACE_SETTING_META_PREFIX}%`)) {
    out.push(["setting", key.slice(WORKSPACE_SETTING_META_PREFIX.length)]);
  }
  for (const id of ids("SELECT id FROM workspace_statuses")) out.push(["status", id]);
  for (const id of ids("SELECT id FROM workspace_kinds")) out.push(["kind", id]);
  for (const id of ids("SELECT id FROM projects")) out.push(["project", id]);
  for (const id of ids("SELECT id FROM issues")) out.push(["issue", id]);
  for (const id of ids("SELECT id FROM comments")) out.push(["comment", id]);
  for (const id of ids("SELECT DISTINCT blocked_id AS id FROM relations WHERE type = 'blocks'")) out.push(["relation", id]);
  for (const id of ids("SELECT issue_id AS id FROM milestone_meta UNION SELECT milestone_id AS id FROM milestone_members")) out.push(["milestone", id]);
  if (ids("SELECT issue_id AS id FROM queue_entries LIMIT 1").length > 0) out.push(["queue", QUEUE_PLAN_ID]);
  return out;
}

/** Whether this device holds a row of an entity. */
function holds(db: DatabaseSync, entity: string, id: string): boolean {
  const hit = (sql: string, ...params: string[]): boolean => db.prepare(sql).get(...params) !== undefined;
  switch (entity) {
    case "setting":
      return hit("SELECT 1 FROM meta WHERE key = ?", `${WORKSPACE_SETTING_META_PREFIX}${id}`);
    case "status":
      return id === ORDER_ID || hit("SELECT 1 FROM workspace_statuses WHERE id = ?", id);
    case "kind":
      return id === ORDER_ID || hit("SELECT 1 FROM workspace_kinds WHERE id = ?", id);
    case "project":
      return hit("SELECT 1 FROM projects WHERE id = ?", id);
    case "issue":
      return hit("SELECT 1 FROM issues WHERE id = ?", id);
    case "comment":
      return hit("SELECT 1 FROM comments WHERE id = ?", id);
    case "relation":
      return hit("SELECT 1 FROM relations WHERE blocked_id = ? AND type = 'blocks'", id);
    case "milestone":
      return hit("SELECT 1 FROM milestone_meta WHERE issue_id = ? UNION SELECT 1 FROM milestone_members WHERE milestone_id = ?", id, id);
    case "queue":
      return hit("SELECT 1 FROM queue_entries LIMIT 1");
    default:
      return false;
  }
}

/** What an entity names, which must exist wherever it does. */
function referents(db: DatabaseSync, entity: string, id: string): Array<readonly [string, string]> {
  const column = (sql: string, ...params: string[]): string[] =>
    (db.prepare(sql).all(...params) as Array<{ id: string | null }>).map((row) => row.id).filter((value): value is string => typeof value === "string");
  switch (entity) {
    case "issue": {
      const row = db.prepare("SELECT parent_id, project_id, status, kind FROM issues WHERE id = ?").get(id) as
        | { parent_id: string | null; project_id: string | null; status: string; kind: string | null }
        | undefined;
      if (!row) return [];
      const out: Array<readonly [string, string]> = [["status", row.status]];
      if (row.parent_id) out.push(["issue", row.parent_id]);
      if (row.project_id) out.push(["project", row.project_id]);
      if (row.kind) out.push(["kind", row.kind]);
      return out;
    }
    case "comment":
      return column("SELECT issue_id AS id FROM comments WHERE id = ?", id).map((issue) => ["issue", issue] as const);
    case "relation":
      return [["issue", id], ...column("SELECT blocker_id AS id FROM relations WHERE blocked_id = ? AND type = 'blocks'", id).map((issue) => ["issue", issue] as const)];
    case "milestone":
      return [["issue", id], ...column("SELECT issue_id AS id FROM milestone_members WHERE milestone_id = ?", id).map((issue) => ["issue", issue] as const)];
    case "queue":
      return column("SELECT issue_id AS id FROM queue_entries").map((issue) => ["issue", issue] as const);
    default:
      return [];
  }
}

/** Remove one entity's rows, and what hangs off them. The number of entities removed. */
function remove(db: DatabaseSync, entity: SyncEntity, id: string): number {
  switch (entity) {
    case "setting":
      db.prepare("DELETE FROM meta WHERE key = ?").run(`${WORKSPACE_SETTING_META_PREFIX}${id}`);
      return 1;
    case "status":
      db.prepare("DELETE FROM workspace_statuses WHERE id = ?").run(id);
      return 1;
    case "kind":
      db.prepare("DELETE FROM workspace_kinds WHERE id = ?").run(id);
      return 1;
    case "project":
      db.prepare("UPDATE issues SET project_id = NULL WHERE project_id = ?").run(id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
      return 1;
    case "issue":
      // Its documents have no foreign key to it; everything else hanging off it cascades.
      db.prepare("DELETE FROM document_revisions WHERE issue_id = ?").run(id);
      db.prepare("DELETE FROM documents WHERE issue_id = ?").run(id);
      return db.prepare("DELETE FROM issues WHERE id = ?").run(id).changes > 0 ? 1 : 0;
    case "comment":
      return db.prepare("DELETE FROM comments WHERE id = ?").run(id).changes > 0 ? 1 : 0;
    case "relation":
      db.prepare("DELETE FROM relations WHERE blocked_id = ? AND type = 'blocks'").run(id);
      return 1;
    case "milestone":
      db.prepare("DELETE FROM milestone_members WHERE milestone_id = ?").run(id);
      db.prepare("DELETE FROM milestone_meta WHERE issue_id = ?").run(id);
      return 1;
    case "queue":
      db.prepare("DELETE FROM queue_entries").run();
      return 1;
    default:
      return 0;
  }
}

/** A built-in as migration 004 installs it. True when that changed anything. */
function reinstall(db: DatabaseSync, entity: SyncEntity, id: string): boolean {
  if (entity === "status") {
    const seed = BUILTIN_STATUS_SEED.find((status) => status.id === id)!;
    const row = db.prepare("SELECT label, category, is_builtin FROM workspace_statuses WHERE id = ?").get(id) as
      | { label: string; category: string; is_builtin: number }
      | undefined;
    if (row && row.label === seed.label && row.category === seed.category && row.is_builtin === 1) return false;
    if (row) db.prepare("UPDATE workspace_statuses SET label = ?, category = ?, is_builtin = 1 WHERE id = ?").run(seed.label, seed.category, id);
    else db.prepare("INSERT INTO workspace_statuses (id, label, category, sort_order, is_builtin) VALUES (?, ?, ?, 0, 1)").run(id, seed.label, seed.category);
    return true;
  }
  const seed = BUILTIN_KIND_SEED.find((kind) => kind.id === id)!;
  const row = db.prepare("SELECT label, is_builtin FROM workspace_kinds WHERE id = ?").get(id) as { label: string; is_builtin: number } | undefined;
  if (row && row.label === seed.label && row.is_builtin === 1) return false;
  if (row) db.prepare("UPDATE workspace_kinds SET label = ?, is_builtin = 1 WHERE id = ?").run(seed.label, id);
  else db.prepare("INSERT INTO workspace_kinds (id, label, sort_order, is_builtin) VALUES (?, ?, 0, 1)").run(id, seed.label);
  return true;
}

/**
 * A vocabulary in the order a device hydrating the new epoch now holds it: the built-ins as
 * installed, then the others in the order the log created them — then the snapshot's order,
 * when it has one, over them (the entries it names first, the rest after, as
 * `applyVocabulary` places them) — and last what was kept for unsent work, which reaches
 * every other device after the snapshot.
 */
function freshOrder(
  db: DatabaseSync,
  entity: "status" | "kind",
  noted: { readonly seqs: Readonly<Record<string, number>>; readonly order: readonly string[] | null },
  hasOrder: boolean,
  kept: ReadonlySet<Key>,
): void {
  const table = entity === "status" ? "workspace_statuses" : "workspace_kinds";
  const installed = new Map<string, number>((entity === "status" ? BUILTIN_STATUS_SEED : BUILTIN_KIND_SEED).map((row, position) => [row.id as string, position]));
  const rows = (db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, id`).all() as Array<{ id: string }>).map((row) => row.id);
  const unsent = rows.filter((id) => kept.has(keyOf(entity, id)) && !installed.has(id));
  const rank = (id: string): [number, number] => [installed.get(id) ?? Number.POSITIVE_INFINITY, noted.seqs[id] ?? Number.POSITIVE_INFINITY];
  const base = rows
    .filter((id) => !unsent.includes(id))
    .map((id, position) => ({ id, position, rank: rank(id) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.position - b.position)
    .map((row) => row.id);
  let order = base;
  if (hasOrder && noted.order !== null) {
    const listed = noted.order.filter((id) => base.includes(id));
    order = [...listed, ...base.filter((id) => !listed.includes(id))];
  }
  const write = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  [...order, ...unsent].forEach((id, index) => write.run(-(index + 1), id));
  [...order, ...unsent].forEach((id, index) => write.run((index + 1) * 1000, id));
}
