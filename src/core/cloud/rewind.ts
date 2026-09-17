/**
 * What a device holds, reconciled to the current epoch's fold: a restore rewinds the
 * repository, and every device that follows it rewinds with it.
 *
 * Contract: `docs/sync.md`, "A restore rewinds".
 *
 * A restore puts the repository back to a backup, in a new epoch, and every device
 * re-bootstraps into it (`beginBootstrap`). The snapshot it reads says what the repository
 * holds. What it does not say is everything pushed to the old epoch after the backup — and a
 * device that held such a row kept it, while a device joining afterwards never had it: two
 * devices on one timeline, disagreeing for good. So, with the new epoch's snapshot in hand
 * and BEFORE it is applied ({@link reconcileBeforeRead}):
 *
 *   - a row this device holds that the epoch does not, and that was pushed — this device's
 *     own, acknowledged, or one it applied from the log — is removed, with what hangs off it.
 *     Removed first, so no value it holds — a number, a slug, a retry key — is in the way of
 *     the epoch's own. An issue removed leaves its number a former holder that a write by that
 *     number is refused over (`identifier-moves.ts`). A built-in the epoch says nothing about
 *     is put back as every device's migrations install it;
 *   - what is kept: work this device never sent (its outbox's unacknowledged operations), and
 *     what the epoch's own entities name but do not hold — an edit of an issue whose create
 *     the epoch lacks, a comment on an issue it lacks, made by a device that did not rewind —
 *     with whatever each names that the epoch lacks. Sent into the epoch after the read
 *     ({@link reconcileAfterRead}): the queued operations as they are, and a `create` of each
 *     kept entity the queue has none for, as a heal sends one (`seed.ts`). Built-ins are never
 *     sent: every device installs them.
 *
 * After the read, an issue left on a stand-in whose number the rewind freed takes it back,
 * and the vocabulary is in the order a device hydrating the epoch holds it. Every device, and
 * a fresh one, then holds the same. The same reconcile runs on a device whose epoch moved
 * under a build that did not reconcile: it notices after the upgrade, by the epoch it last
 * reconciled against (`sync_reconciled_epoch`).
 */
import type { DatabaseSync } from "node:sqlite";
import type { Journal, SyncEntity } from "../journal.js";
import { moveIdentifier, recordRemovedHolder } from "../identifier-moves.js";
import { WORKSPACE_SETTING_META_PREFIX } from "../settings-registry.js";
import { BUILTIN_KIND_SEED, BUILTIN_STATUS_SEED, nowIso } from "../types.js";
import { settingsMoved } from "./apply.js";
import { forgetRemovedIssueLease } from "./lease-store.js";
import { localInventory } from "./seed.js";
import { recordReconciledEpoch, withheldEntities } from "./sync-state.js";
import type { SnapshotEntity } from "./wire.js";

const QUEUE_PLAN_ID = "@plan";
const ORDER_ID = "@order";

export interface ReconcileReport {
  /** Rows the epoch does not hold, removed here. */
  readonly removed: number;
  /** Built-in statuses and kinds put back as installed. */
  readonly restoredBuiltins: number;
  /** Entities kept and sent into the epoch as a `create`. */
  readonly republished: number;
  /** Issues given back a number the rewind freed. */
  readonly givenBack: number;
}

type Key = `${string} ${string}`;
const keyOf = (entity: string, id: string): Key => `${entity} ${id}`;

const BUILTINS: ReadonlyArray<readonly [SyncEntity, string]> = [
  ...BUILTIN_STATUS_SEED.map((status) => ["status", status.id as string] as const),
  ...BUILTIN_KIND_SEED.map((kind) => ["kind", kind.id as string] as const),
];
const BUILTIN_KEYS = new Set(BUILTINS.map(([entity, id]) => keyOf(entity, id)));

/** What the read before it decided, for the half after it. */
export interface ReconcilePlan {
  readonly kept: ReadonlySet<Key>;
  readonly removed: number;
  readonly restoredBuiltins: number;
  readonly entities: readonly SnapshotEntity[];
}

/**
 * Before the epoch's snapshot is applied: remove what the epoch does not hold and nothing
 * keeps, and put back the built-ins it says nothing about. Inside the read's transaction.
 */
export function reconcileBeforeRead(db: DatabaseSync, entities: readonly SnapshotEntity[]): ReconcilePlan {
  const inEpoch = new Set<Key>(entities.map((entity) => keyOf(entity.entity, entity.entityId)));
  const placed = (entity: string, id: string): boolean => inEpoch.has(keyOf(entity, id));
  const versioned = db.prepare("SELECT 1 AS hit FROM sync_entity_versions WHERE entity = ? AND entity_id = ?");
  const journaled = db.prepare("SELECT 1 AS hit FROM sync_outbox WHERE entity = ? AND entity_id = ? LIMIT 1");
  // Known to synchronization: written here and journaled, or applied from a log.
  const known = (entity: string, id: string): boolean => versioned.get(entity, id) !== undefined || journaled.get(entity, id) !== undefined;

  const kept = new Set<Key>();
  const keep = (entity: string, id: string): void => {
    const key = keyOf(entity, id);
    if (kept.has(key) || BUILTIN_KEYS.has(key) || !holds(db, entity, id)) return;
    // Held by the epoch already — unless the epoch holds it only in part (below).
    if (placed(entity, id) && !needed.has(key)) return;
    kept.add(key);
    for (const [named, namedId] of referents(db, entity, id)) keep(named, namedId);
  };
  // What the epoch's own entities name and do not hold: an edit with no create, and what a
  // comment, a child, a blocker set, a milestone or the plan names that is not there.
  const needed = foldNeeds(entities);
  for (const key of needed) {
    const space = key.indexOf(" ");
    keep(key.slice(0, space), key.slice(space + 1));
  }
  // Work this device never sent — and everything each operation names, create or edit alike.
  // An unsent edit of an entity the epoch holds names what it names all the same: a status,
  // kind or project on an issue, a blocker, a queued issue, a milestone member made after the
  // backup. Kept only through the entity, those were removed while the edit was still sent.
  const unsent = db
    .prepare("SELECT entity, entity_id AS id, payload FROM sync_outbox WHERE acknowledged_seq IS NULL ORDER BY client_seq")
    .all() as Array<{ entity: string; id: string; payload: string }>;
  for (const op of unsent) {
    if (op.entity === "documentRevision") keep("issue", op.id.slice(0, op.id.indexOf("/")));
    else keep(op.entity, op.id);
    for (const [named, namedId] of operationReferents(op.entity, op.id, parsedPayload(op.payload))) keep(named, namedId);
  }

  // Never pushable, and so never on any timeline: this device's own (`recordWithheld`).
  const withheld = withheldEntities(db);
  let removed = 0;
  for (const [entity, id] of heldEntities(db)) {
    const key = keyOf(entity, id);
    if (BUILTIN_KEYS.has(key) || kept.has(key) || placed(entity, id) || withheld.has(key) || !known(entity, id)) continue;
    removed += remove(db, entity, id);
    // A record about it has nothing left to decide: closed, and kept, as every record is.
    db.prepare("UPDATE sync_conflicts SET resolved_at = ?, resolved_by = 'staple', resolution = ? WHERE entity = ? AND entity_id = ? AND resolved_at IS NULL").run(
      nowIso(),
      JSON.stringify("rewound by a restore"),
      entity,
      id,
    );
  }

  /**
   * A milestone the epoch holds with no `members` key has had no membership written to the log:
   * one made on a connected device goes out as its dates alone, and a restore stages what the
   * fold held. A fresh device reading it holds no members, so neither does this one — unless its
   * own unsent membership, the whole list it holds, is still to be sent. The plan and a blocker
   * set have no such shape: each reaches the log only as its whole list.
   */
  const unsentMembership = new Set(unsent.filter((op) => op.entity === "milestone" && Array.isArray(parsedPayload(op.payload).members)).map((op) => op.id));
  for (const entity of entities) {
    if (entity.entity !== "milestone" || entity.deletedAt !== null || entity.verb === "delete" || Array.isArray(entity.state.members)) continue;
    if (unsentMembership.has(entity.entityId) || withheld.has(keyOf("milestone", entity.entityId))) continue;
    if (Number(db.prepare("DELETE FROM milestone_members WHERE milestone_id = ?").run(entity.entityId).changes) === 0) continue;
    // An open editor's check notices, as it does for a membership applied (`applyMilestone`).
    db.prepare("UPDATE milestone_meta SET members_revision = members_revision + 1 WHERE issue_id = ?").run(entity.entityId);
  }

  let restoredBuiltins = 0;
  for (const [entity, id] of BUILTINS) {
    if (placed(entity, id)) continue;
    if (reinstall(db, entity, id)) restoredBuiltins += 1;
  }
  return { kept, removed, restoredBuiltins, entities };
}

/**
 * After the snapshot is applied: numbers the rewind freed go back to the issues waiting on
 * them, the vocabulary takes a fresh device's order, and what was kept is sent into the
 * epoch. Inside the read's transaction, outside the applier's suppressed scope: what it
 * sends is journaled like any mutation made here.
 */
export function reconcileAfterRead(db: DatabaseSync, journal: Journal, plan: ReconcilePlan, epoch: number): ReconcileReport {
  const givenBack = giveBackFreedNumbers(db);
  for (const entity of ["status", "kind"] as const) freshOrder(db, entity, plan.entities, plan.kept);
  settingsMoved(db, true);

  const unsentCreates = new Set(
    (db.prepare("SELECT entity, entity_id AS id FROM sync_outbox WHERE acknowledged_seq IS NULL AND verb = 'create'").all() as Array<{ entity: string; id: string }>).map(
      (op) => keyOf(op.entity, op.id),
    ),
  );
  const republish = localInventory(db, nowIso()).filter((local) => {
    const key = keyOf(local.entity, local.entityId);
    return plan.kept.has(key) && !unsentCreates.has(key) && !BUILTIN_KEYS.has(key);
  });
  if (republish.length > 0) {
    journal.run(() => {
      for (const local of republish) {
        journal.record({ entity: local.entity, entityId: local.entityId, verb: "create", payload: local.payload, actor: local.actor });
      }
    });
  }
  sendReferentsFirst(db, journal);
  recordReconciledEpoch(db, epoch);
  return { removed: plan.removed, restoredBuiltins: plan.restoredBuiltins, republished: republish.length, givenBack };
}

/**
 * The pending operations, put in an order every receiver can apply as it goes: each after the
 * `create` of whatever it names, when that create is pending too.
 *
 * A kept entity's `create` is journaled here, after the queued work that kept it — an
 * unsent comment on an issue pushed after the backup is queued before the issue's create
 * sent again. Sent in allocation order, the comment reached the log first, and every device
 * reading the tail met a comment on an issue it did not have: set aside until the issue
 * arrived on this build (`quarantine.ts`), and a sync that fails over it for good on a build
 * before it. Otherwise the allocation order stands. A cycle — two creates naming each other —
 * keeps it too, for what it cannot order.
 */
function sendReferentsFirst(db: DatabaseSync, journal: Journal): void {
  const pending = db
    .prepare("SELECT op_id AS opId, entity, entity_id AS entityId, verb, payload FROM sync_outbox WHERE acknowledged_seq IS NULL ORDER BY client_seq")
    .all() as Array<{ opId: string; entity: string; entityId: string; verb: string; payload: string }>;
  const creates = new Map<Key, number>();
  pending.forEach((op, index) => {
    const key = keyOf(op.entity, op.entityId);
    if (op.verb === "create" && !creates.has(key)) creates.set(key, index);
  });
  // For each operation, the pending creates it has to follow.
  const after = pending.map((op, index) => {
    const payload = parsedPayload(op.payload);
    const own = op.verb === "create" ? [] : [[op.entity, op.entityId] as const];
    return [...own, ...operationReferents(op.entity, op.entityId, payload)]
      .map(([entity, id]) => creates.get(keyOf(entity, id)))
      .filter((at): at is number => at !== undefined && at !== index);
  });
  if (after.every((deps, index) => deps.every((at) => at < index))) return;

  const placed = new Set<number>();
  const order: number[] = [];
  while (order.length < pending.length) {
    // The earliest operation whose referents are all placed; in a cycle, the earliest left.
    let next = -1;
    for (let index = 0; index < pending.length; index += 1) {
      if (placed.has(index)) continue;
      if (next === -1) next = index;
      if (after[index]!.every((at) => placed.has(at))) {
        next = index;
        break;
      }
    }
    placed.add(next);
    order.push(next);
  }
  journal.reorderPending(order.map((index) => pending[index]!.opId));
}

/** A queued operation's payload; one this build cannot read names nothing. */
function parsedPayload(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** What an operation names that a receiver must already hold to apply it (`apply.ts`). */
function operationReferents(entity: string, entityId: string, payload: Record<string, unknown>): Array<readonly [string, string]> {
  const out: Array<readonly [string, string]> = [];
  const issue = (id: unknown): void => {
    if (typeof id === "string" && id !== "") out.push(["issue", id]);
  };
  const issues = (ids: unknown): void => {
    if (Array.isArray(ids)) for (const id of ids) issue(id);
  };
  switch (entity) {
    case "issue":
      issue(payload.parentId);
      if (typeof payload.projectId === "string") out.push(["project", payload.projectId]);
      if (typeof payload.status === "string") out.push(["status", payload.status]);
      if (typeof payload.kind === "string") out.push(["kind", payload.kind]);
      break;
    case "comment":
    case "documentRevision":
      issue(payload.issueId);
      break;
    case "document":
      issue(entityId.slice(0, entityId.indexOf("/")));
      break;
    case "relation":
      issue(entityId);
      issues(payload.blockedBy);
      break;
    case "milestone":
      issue(entityId);
      issues(payload.members);
      break;
    case "queue":
      issues(payload.order);
      break;
    case "lease":
      issue(entityId);
      break;
    default:
      break;
  }
  return out;
}

/**
 * Keys of what the epoch's entities name and do not hold whole: an issue, comment or project
 * the log holds edits of and no create, and what a live entity names that the epoch lacks.
 */
function foldNeeds(entities: readonly SnapshotEntity[]): Set<Key> {
  const whole = new Set<Key>();
  const live = entities.filter((entity) => entity.deletedAt === null && entity.verb !== "delete");
  for (const entity of live) {
    const needsCreate = entity.entity === "issue" || entity.entity === "comment" || entity.entity === "project";
    if (!(needsCreate && entity.createdSeq === null)) whole.add(keyOf(entity.entity, entity.entityId));
  }
  const needed = new Set<Key>();
  const need = (entity: string, id: unknown): void => {
    if (typeof id !== "string" || id === "") return;
    const key = keyOf(entity, id);
    if (!whole.has(key) && !BUILTIN_KEYS.has(key)) needed.add(key);
  };
  const field = (state: Record<string, unknown>, camel: string, snake: string): unknown => state[camel] ?? state[snake];
  for (const entity of live) {
    const state = entity.state;
    switch (entity.entity) {
      case "issue":
        if (entity.createdSeq === null) need("issue", entity.entityId);
        need("issue", field(state, "parentId", "parent_id"));
        need("project", field(state, "projectId", "project_id"));
        need("status", state.status);
        need("kind", state.kind);
        break;
      case "comment":
        if (entity.createdSeq === null) need("comment", entity.entityId);
        need("issue", field(state, "issueId", "issue_id"));
        break;
      case "project":
        if (entity.createdSeq === null) need("project", entity.entityId);
        break;
      case "documentRevision":
        need("issue", state.issueId);
        break;
      case "relation":
        need("issue", entity.entityId);
        if (Array.isArray(state.blockedBy)) for (const id of state.blockedBy) need("issue", id);
        break;
      case "milestone":
        need("issue", entity.entityId);
        if (Array.isArray(state.members)) for (const id of state.members) need("issue", id);
        break;
      case "queue":
        if (Array.isArray(state.order)) for (const id of state.order) need("issue", id);
        break;
      default:
        break;
    }
  }
  return needed;
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
  const gone = (changes: number | bigint): number => (Number(changes) > 0 ? 1 : 0);
  switch (entity) {
    case "setting":
      return gone(db.prepare("DELETE FROM meta WHERE key = ?").run(`${WORKSPACE_SETTING_META_PREFIX}${id}`).changes);
    case "status":
      return gone(db.prepare("DELETE FROM workspace_statuses WHERE id = ?").run(id).changes);
    case "kind":
      return gone(db.prepare("DELETE FROM workspace_kinds WHERE id = ?").run(id).changes);
    case "project":
      db.prepare("UPDATE issues SET project_id = NULL WHERE project_id = ?").run(id);
      return gone(db.prepare("DELETE FROM projects WHERE id = ?").run(id).changes);
    case "issue": {
      const row = db.prepare("SELECT identifier, title, checkout_agent FROM issues WHERE id = ?").get(id) as
        | { identifier: string; title: string; checkout_agent: string | null }
        | undefined;
      if (!row) return 0;
      /**
       * Its number stays a former holder, removed by the restore: a caller that learned it may
       * still mean this issue, and a write by that number now lands on whichever issue holds it
       * next (`WorkspaceStore.requireTarget`). Held while it was checked out or leased here.
       */
      recordRemovedHolder(db, row.identifier, {
        issueId: id,
        at: nowIso(),
        title: row.title,
        checkedOutBy: row.checkout_agent,
      });
      // Its checkout goes with the row; this device's lease on it goes too, released on the
      // service by the sync that follows (`releaseOwedLeases`, `sync.ts`).
      forgetRemovedIssueLease(db, id);
      // Its documents have no foreign key to it; everything else hanging off it cascades.
      db.prepare("DELETE FROM document_revisions WHERE issue_id = ?").run(id);
      db.prepare("DELETE FROM documents WHERE issue_id = ?").run(id);
      return gone(db.prepare("DELETE FROM issues WHERE id = ?").run(id).changes);
    }
    case "comment":
      return gone(db.prepare("DELETE FROM comments WHERE id = ?").run(id).changes);
    case "relation":
      return gone(db.prepare("DELETE FROM relations WHERE blocked_id = ? AND type = 'blocks'").run(id).changes);
    case "milestone": {
      const members = db.prepare("DELETE FROM milestone_members WHERE milestone_id = ?").run(id).changes;
      const meta = db.prepare("DELETE FROM milestone_meta WHERE issue_id = ?").run(id).changes;
      return gone(Number(members) + Number(meta));
    }
    case "queue":
      return gone(db.prepare("DELETE FROM queue_entries").run().changes);
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
 * An issue on a stand-in (`TRA-2+1`), its record open, whose number nothing holds any more:
 * the rewind removed what held it. It takes the number back and the record closes — what a
 * fresh device, which never saw the holder, gives it.
 */
function giveBackFreedNumbers(db: DatabaseSync): number {
  const open = db
    .prepare("SELECT id, entity_id, remote_value FROM sync_conflicts WHERE entity = 'issue' AND field = 'identifier' AND resolved_at IS NULL")
    .all() as Array<{ id: string; entity_id: string; remote_value: string | null }>;
  let given = 0;
  for (const record of open) {
    let wanted: unknown;
    try {
      wanted = record.remote_value === null ? null : JSON.parse(record.remote_value);
    } catch {
      continue;
    }
    if (typeof wanted !== "string") continue;
    const row = db.prepare("SELECT identifier FROM issues WHERE id = ?").get(record.entity_id) as { identifier: string } | undefined;
    if (!row || !row.identifier.startsWith(`${wanted}+`)) continue;
    if (db.prepare("SELECT 1 AS hit FROM issues WHERE identifier = ?").get(wanted)) continue;
    moveIdentifier(db, record.entity_id, wanted);
    db.prepare("UPDATE sync_conflicts SET resolved_at = ?, resolved_by = 'staple', resolution = ? WHERE id = ?").run(nowIso(), JSON.stringify(wanted), record.id);
    given += 1;
  }
  return given;
}

/**
 * A vocabulary in the order a device hydrating the epoch holds it (`applyVocabulary`): the
 * built-ins the log holds no create of, as installed; then every entry whose create the log
 * holds, in log order — a create puts its entry last, a built-in's too — then the epoch's
 * order over them when it has one (the entries it names first, in its order, the rest after,
 * leaving out an entry created after it was written); and last what was kept for unsent work,
 * which reaches every other device after the snapshot.
 */
function freshOrder(db: DatabaseSync, entity: "status" | "kind", entities: readonly SnapshotEntity[], kept: ReadonlySet<Key>): void {
  const table = entity === "status" ? "workspace_statuses" : "workspace_kinds";
  const installed = new Map<string, number>((entity === "status" ? BUILTIN_STATUS_SEED : BUILTIN_KIND_SEED).map((row, position) => [row.id as string, position]));
  const created = new Map<string, number>();
  let order: { list: string[]; written: number } | null = null;
  for (const snapshot of entities) {
    if (snapshot.entity !== entity || snapshot.deletedAt !== null) continue;
    if (snapshot.entityId === ORDER_ID) {
      const written = snapshot.fieldWrites?.order?.seq ?? snapshot.createdSeq;
      if (Array.isArray(snapshot.state.order) && typeof written === "number") {
        order = { list: snapshot.state.order.filter((id): id is string => typeof id === "string"), written };
      }
    } else if (typeof snapshot.createdSeq === "number" && typeof snapshot.createdAt === "string") {
      // A genuine create (what a restore staged is not one): it put its entry last.
      created.set(snapshot.entityId, snapshot.createdSeq);
    }
  }
  const rows = (db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, id`).all() as Array<{ id: string }>).map((row) => row.id);
  const unsent = rows.filter((id) => kept.has(keyOf(entity, id)) && !installed.has(id));
  const rank = (id: string): [number, number] =>
    created.has(id) ? [1, created.get(id)!] : installed.has(id) ? [0, installed.get(id)!] : [1, Number.POSITIVE_INFINITY];
  let base = rows
    .filter((id) => !unsent.includes(id))
    .map((id, position) => ({ id, position, rank: rank(id) }))
    .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.position - b.position)
    .map((row) => row.id);
  if (order !== null) {
    const written = order.written;
    const listed = order.list.filter((id) => base.includes(id) && !((created.get(id) ?? -1) > written));
    base = [...listed, ...base.filter((id) => !listed.includes(id))];
  }
  const write = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
  [...base, ...unsent].forEach((id, index) => write.run(-(index + 1), id));
  [...base, ...unsent].forEach((id, index) => write.run((index + 1) * 1000, id));
}
