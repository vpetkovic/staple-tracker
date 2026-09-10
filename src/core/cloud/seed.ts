/**
 * The seed: a workspace's existing state reaches the service when it first synchronizes.
 *
 * Contract: `docs/sync.md`, "A workspace's history reaches the service when it first
 * synchronizes".
 *
 * ## The gap this closes
 *
 * The journal records what CHANGED after it was armed, and it is armed only once the
 * machine has a device id, which only `connect` mints. Everything a workspace held
 * before that — which, for a real workspace, is all of it — had no operation behind
 * it, so nothing ever sent it. Measured against a local workerd before this module:
 * a first sync reported *"Pushed nothing"*, a second device hydrated an empty
 * repository, and the first edit to a pre-connect issue reached that device as an
 * operation on an entity it had never received.
 *
 * ## The shape of the fix
 *
 * `syncRepository` reads the whole snapshot once (the survey), and {@link seedRepository}
 * then does everything in ONE transaction: yield the local names the repository
 * already uses, record which local values the repository's replace, apply the
 * repository's state, journal a `create` for every local entity the repository does
 * not hold, and write the record that the seed happened. The push that follows is the
 * ordinary outbox push. So the decision is made once, with everything the repository
 * holds in hand, and it is atomic: a database has either seeded or it has not.
 *
 * ## Why not at connect, and why not lazily
 *
 * At connect: deciding needs the repository's state, and connecting is not consent to
 * synchronize — manual stays manual. Lazily, entity by entity: the first thing to go
 * would be whichever row somebody touched, ahead of the rows it names, and "which rows
 * has this device sent" would have to be derived from a journal that was never armed.
 * The first sync is the one moment that has the consent, the repository's state and
 * the whole local state together.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db.js";
import { newId } from "../ids.js";
import { replayOutboxFieldWrites, type Journal, type SeedIntent, type SyncEntity } from "../journal.js";
import { WORKSPACE_SETTING_META_PREFIX } from "../settings-registry.js";
import { BUILTIN_KIND_SEED, BUILTIN_STATUS_SEED, StapleError, nowIso } from "../types.js";
import { COMMENT_COLUMNS, ISSUE_COLUMNS, PROJECT_COLUMNS, applyToDatabase, payloadFromRow } from "./apply.js";
import { VOCABULARY_ORDER_ID, hydrate } from "./hydrate.js";
import { completeSnapshot } from "./sync-state.js";
import type { SnapshotEntity } from "./wire.js";

/** The plan's singleton entity id. Mirrors `queue-store.ts`. */
const QUEUE_PLAN_ID = "@plan";

/** The device-local `meta` row that records the seed happened. See {@link readSeedMarker}. */
export const SEED_MARKER_KEY = "sync_seed";

/**
 * `join` — this database has never synchronized with any repository.
 * `heal` — it synchronized under a build that did not seed, and never did.
 */
export type SeedMode = "join" | "heal";

/** What the service held when this device looked: one full read of `GET /snapshot`. */
export interface RepositorySurvey {
  readonly epoch: number;
  readonly cutoffSeq: number;
  readonly tailCursor: string;
  readonly entities: readonly SnapshotEntity[];
  readonly pages: number;
}

export interface SeedItem {
  readonly entity: string;
  readonly entityId: string;
  /** How a human refers to it: an identifier, a slug, a setting key. */
  readonly label: string;
}

/** A display key a local entity gave up because the repository already used it. */
export interface SeedRename extends SeedItem {
  readonly field: "identifier" | "slug";
  readonly from: string;
  readonly to: string;
}

/** A dedup token a local entity gave up because a repository entity already held it. */
export interface SeedCleared extends SeedItem {
  readonly field: "idempotencyKey" | "originId";
  readonly value: string;
  /** The repository entity that holds it. */
  readonly heldBy: string;
}

/** A value this device held before joining that the repository's value replaced. */
export interface SeedReplaced extends SeedItem {
  readonly field: string;
  readonly local: unknown;
  readonly repository: unknown;
}

/** Something that could not be uploaded, and why. */
export interface SeedSkipped extends SeedItem {
  readonly reason: string;
}

export interface SeedReport {
  readonly repositoryId: string;
  readonly mode: SeedMode;
  /** Live entities the repository already held when this device looked. */
  readonly repositoryEntities: number;
  /** Entities uploaded as `create`s because the repository did not hold them. */
  readonly uploaded: number;
  readonly uploadedByEntity: Readonly<Record<string, number>>;
  /** Repository collections that gained this device's items: the plan, a milestone, a blocker set, an order. */
  readonly merged: readonly SeedItem[];
  readonly renamed: readonly SeedRename[];
  readonly cleared: readonly SeedCleared[];
  readonly replaced: readonly SeedReplaced[];
  readonly skipped: readonly SeedSkipped[];
  readonly at: string;
}

// -------------------------------------------------------------------- marker

/**
 * The record that this database has seeded a repository, or null.
 *
 * A `meta` row rather than a column, and the reason is the envelope, not tidiness. A
 * column is a workspace migration, and the migration number is what every operation
 * carries as `schema`: a receiver refuses a page stamped above its own schema with
 * `schema_ahead`. One bookkeeping column would make every device on an older build
 * refuse every operation this build emits. `meta` keys outside `slug`, `prefix` and
 * `setting:*` are default-deny for replication, so this row never leaves the machine,
 * exactly like `next_issue_number` and `queue_revision` beside it.
 *
 * Keyed by repository id inside the value: `staple cloud fork-id` mints a new id, and
 * the new repository has received nothing, so a fork owes a seed of its own.
 */
export function readSeedMarker(db: DatabaseSync): SeedReport | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SEED_MARKER_KEY) as
    | { value: string }
    | undefined;
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as SeedReport;
    return typeof parsed?.repositoryId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** True until this database has seeded `repositoryId`. */
export function seedOwed(db: DatabaseSync, repositoryId: string): boolean {
  return readSeedMarker(db)?.repositoryId !== repositoryId;
}

function writeSeedMarker(db: DatabaseSync, report: SeedReport): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(SEED_MARKER_KEY, JSON.stringify(report));
}

// ------------------------------------------------------------------- wording

const NOUNS: Record<string, [string, string]> = {
  issue: ["issue", "issues"],
  comment: ["comment", "comments"],
  documentRevision: ["document revision", "document revisions"],
  relation: ["blocker set", "blocker sets"],
  project: ["project", "projects"],
  status: ["status", "statuses"],
  kind: ["kind", "kinds"],
  setting: ["setting", "settings"],
  milestone: ["milestone", "milestones"],
  queue: ["plan", "plans"],
};

function counted(n: number, entity: string): string {
  const [one, many] = NOUNS[entity] ?? [entity, `${entity}s`];
  return `${n} ${n === 1 ? one : many}`;
}

function breakdown(byEntity: Readonly<Record<string, number>>): string {
  return Object.keys(NOUNS)
    .filter((entity) => (byEntity[entity] ?? 0) > 0)
    .map((entity) => counted(byEntity[entity]!, entity))
    .join(", ");
}

/**
 * The seed in words: one sentence for the report line, and one line per thing a human
 * has to know about — a number that changed, a token given up, a value replaced,
 * something that could not go. Shared by `staple cloud sync` and `sync --all` so the two
 * cannot describe the same seed differently.
 */
export function describeSeed(seed: SeedReport): { summary: string; details: string[] } {
  const items = `${seed.uploaded} ${seed.uploaded === 1 ? "item" : "items"}`;
  const parts = breakdown(seed.uploadedByEntity);
  const listed = parts ? ` (${parts})` : "";
  let summary: string;
  if (seed.mode === "heal") {
    summary =
      seed.uploaded === 0
        ? "Checked this workspace against the repository once: nothing it holds was missing from it."
        : `Uploaded ${items} this workspace held from before it connected${listed}. An earlier ` +
          `version of staple synchronized it without ever sending them.`;
  } else if (seed.repositoryEntities === 0) {
    summary =
      seed.uploaded === 0
        ? "This workspace and the repository were both empty, so there was nothing to upload."
        : `Uploaded ${seed.uploaded} existing ${seed.uploaded === 1 ? "item" : "items"}${listed}. ` +
          `The repository was empty, so this workspace's history is now the repository's.`;
  } else {
    summary =
      `This repository already had data (${seed.repositoryEntities} ` +
      `${seed.repositoryEntities === 1 ? "item" : "items"}); bootstrapped from it, and ` +
      (seed.uploaded === 0 ? "this workspace had no items of its own to add." : `${items} of this workspace's were added${listed}.`);
  }

  const details: string[] = [];
  for (const rename of seed.renamed) {
    details.push(
      rename.field === "identifier"
        ? `renumbered ${rename.from} -> ${rename.to}: the repository already had a ${rename.from}`
        : `renamed project ${rename.from} -> ${rename.to}: the repository already had a project called ${rename.from}`,
    );
  }
  for (const item of seed.cleared) {
    details.push(
      item.field === "idempotencyKey"
        ? `${item.label} gave up its retry key "${item.value}": a repository item already uses it`
        : `${item.label} was detached from ${item.value}: a repository issue already tracks it`,
    );
  }
  for (const item of seed.merged) details.push(`appended this workspace's items to ${item.label}`);
  if (seed.replaced.length > 0) {
    details.push(
      `${seed.replaced.length} ${seed.replaced.length === 1 ? "value" : "values"} this workspace held ` +
        `before joining ${seed.replaced.length === 1 ? "was" : "were"} replaced by the repository's:`,
    );
    for (const item of seed.replaced) {
      details.push(`  ${item.label} ${item.field}: had ${JSON.stringify(item.local)}, now ${JSON.stringify(item.repository)}`);
    }
  }
  for (const item of seed.skipped) details.push(`not uploaded: ${item.label} — ${item.reason}`);
  return { summary, details };
}

/**
 * What a workspace holds that a seed would consider, counted locally. Read by
 * `staple cloud connect`, which says before anything is uploaded that the first sync
 * will upload it — connecting is the consent, and a consent is only informed if it
 * says what it is for.
 */
export function workspaceHoldings(db: DatabaseSync): { total: number; summary: string } {
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const byEntity: Record<string, number> = {
    issue: count("SELECT COUNT(*) AS n FROM issues"),
    comment: count("SELECT COUNT(*) AS n FROM comments"),
    documentRevision: count("SELECT COUNT(*) AS n FROM document_revisions"),
    relation: count("SELECT COUNT(DISTINCT blocked_id) AS n FROM relations WHERE type = 'blocks'"),
    project: count("SELECT COUNT(*) AS n FROM projects"),
    milestone: count("SELECT COUNT(*) AS n FROM milestone_meta"),
    queue: count("SELECT CASE WHEN EXISTS (SELECT 1 FROM queue_entries) THEN 1 ELSE 0 END AS n"),
  };
  const total = Object.values(byEntity).reduce((sum, n) => sum + n, 0);
  return { total, summary: breakdown(byEntity) };
}

// -------------------------------------------------------------------- survey

function keyOf(entity: string, entityId: string): string {
  return `${entity} ${entityId}`;
}

/**
 * Whether the service's state for an entity is enough to recreate it.
 *
 * Only a `create` carries an entity's identifying fields, so a state without them is
 * an entity the log holds updates for and no create — which an earlier build produced
 * by pushing edits to rows it had never uploaded. A device hydrating that state fails
 * on it (`insertIssue` refuses an issue with no identifier), so for the seed such an
 * entity counts as NOT held, and its create is sent.
 */
function isComplete(entity: SnapshotEntity): boolean {
  if (entity.deletedAt !== null) return true;
  const state = entity.state;
  switch (entity.entity) {
    case "issue":
      return typeof state.identifier === "string";
    case "comment":
      return typeof (state.issueId ?? state.issue_id) === "string";
    case "project":
      return typeof state.slug === "string";
    case "status":
      return (
        entity.entityId === VOCABULARY_ORDER_ID ||
        (typeof state.label === "string" && typeof state.category === "string")
      );
    case "documentRevision":
      return typeof state.issueId === "string";
    default:
      return true;
  }
}

class SurveyIndex {
  readonly byKey = new Map<string, SnapshotEntity>();
  readonly live: number;

  constructor(readonly survey: RepositorySurvey) {
    let live = 0;
    for (const entity of survey.entities) {
      this.byKey.set(keyOf(entity.entity, entity.entityId), entity);
      if (entity.deletedAt === null) live += 1;
    }
    this.live = live;
  }

  get(entity: string, entityId: string): SnapshotEntity | undefined {
    return this.byKey.get(keyOf(entity, entityId));
  }

  /** The service holds this entity completely — or has deleted it. */
  holds(entity: string, entityId: string): boolean {
    const found = this.get(entity, entityId);
    return found !== undefined && isComplete(found);
  }

  /** The service holds a state for it that cannot recreate it. */
  holdsIncomplete(entity: string, entityId: string): boolean {
    const found = this.get(entity, entityId);
    return found !== undefined && !isComplete(found);
  }

  version(entity: string, entityId: string): number {
    return this.get(entity, entityId)?.version ?? 0;
  }

  liveOf(entity: string): SnapshotEntity[] {
    return this.survey.entities.filter(
      (candidate) => candidate.entity === entity && candidate.deletedAt === null && isComplete(candidate),
    );
  }
}

// ----------------------------------------------------------------- inventory

interface LocalEntity {
  readonly entity: SyncEntity;
  readonly entityId: string;
  readonly label: string;
  readonly payload: Record<string, unknown>;
  readonly actor: string | null;
  readonly at: string;
  /**
   * Every device already holds this, exactly, by construction: a built-in status or kind
   * still carrying the label and category migration 004 installed it with. Sending it
   * would tell no receiver anything, so it is not sent.
   */
  readonly implied?: boolean;
}

type Row = Record<string, unknown>;

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function latest(values: Array<string | null>, fallback: string): string {
  const present = values.filter((value): value is string => value !== null).sort();
  return present[present.length - 1] ?? fallback;
}

function identifierOf(db: DatabaseSync, issueId: string): string {
  const row = db.prepare("SELECT identifier FROM issues WHERE id = ?").get(issueId) as
    | { identifier: string }
    | undefined;
  return row?.identifier ?? issueId;
}

/** Issues, parents before children, then by creation. */
function issuesInOrder(db: DatabaseSync): Row[] {
  const rows = db.prepare("SELECT * FROM issues ORDER BY created_at, identifier").all() as Row[];
  const byId = new Map(rows.map((row) => [row.id as string, row]));
  const ordered: Row[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const place = (row: Row): void => {
    const id = row.id as string;
    if (placed.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const parent = typeof row.parent_id === "string" ? byId.get(row.parent_id) : undefined;
    if (parent) place(parent);
    visiting.delete(id);
    placed.add(id);
    ordered.push(row);
  };
  for (const row of rows) place(row);
  return ordered;
}

/**
 * Every entity this database holds, as the operation that would recreate it, in an
 * order a receiver can apply: definitions, then issues (parents first), then what
 * names an issue, then the collections that name several.
 *
 * The vocabulary ORDERS are not here: they are not rows, and whether one is sent
 * depends on what the repository already holds, which {@link seedRepository} decides.
 */
function inventory(db: DatabaseSync, now: string, skipped: SeedSkipped[]): LocalEntity[] {
  const out: LocalEntity[] = [];

  const settings = db
    .prepare("SELECT key, value FROM meta WHERE key LIKE ? ORDER BY key")
    .all(`${WORKSPACE_SETTING_META_PREFIX}%`) as Array<{ key: string; value: string }>;
  for (const row of settings) {
    const key = row.key.slice(WORKSPACE_SETTING_META_PREFIX.length);
    let stored: unknown;
    try {
      stored = JSON.parse(row.value);
    } catch {
      stored = undefined;
    }
    if (stored === null || typeof stored !== "object" || !("value" in (stored as object))) {
      skipped.push({
        entity: "setting",
        entityId: key,
        label: key,
        reason: "its stored value is not a setting envelope, so there is no value to send",
      });
      continue;
    }
    out.push({
      entity: "setting",
      entityId: key,
      label: key,
      payload: { value: (stored as { value: unknown }).value },
      actor: null,
      at: now,
    });
  }

  for (const row of db
    .prepare("SELECT id, label, category FROM workspace_statuses ORDER BY sort_order, id")
    .all() as Array<{ id: string; label: string; category: string }>) {
    const builtin = BUILTIN_STATUS.get(row.id);
    out.push({
      entity: "status",
      entityId: row.id,
      label: row.id,
      payload: { id: row.id, label: row.label, category: row.category },
      actor: null,
      at: now,
      implied: builtin !== undefined && builtin.label === row.label && builtin.category === row.category,
    });
  }

  for (const row of db
    .prepare("SELECT id, label FROM workspace_kinds ORDER BY sort_order, id")
    .all() as Array<{ id: string; label: string }>) {
    const builtin = BUILTIN_KIND.get(row.id);
    out.push({
      entity: "kind",
      entityId: row.id,
      label: row.id,
      payload: { id: row.id, label: row.label },
      actor: null,
      at: now,
      implied: builtin !== undefined && builtin.label === row.label,
    });
  }

  for (const row of db.prepare("SELECT * FROM projects ORDER BY created_at, id").all() as Row[]) {
    out.push({
      entity: "project",
      entityId: row.id as string,
      label: String(row.slug),
      payload: payloadFromRow("projects", row),
      actor: null,
      at: str(row.updated_at) ?? now,
    });
  }

  for (const row of issuesInOrder(db)) {
    out.push({
      entity: "issue",
      entityId: row.id as string,
      label: String(row.identifier),
      payload: payloadFromRow("issues", row),
      actor: str(row.created_by),
      at: str(row.updated_at) ?? now,
    });
  }

  const edges = db
    .prepare(
      `SELECT blocked_id, blocker_id, created_by, created_at FROM relations
        WHERE type = 'blocks' ORDER BY blocked_id, id`,
    )
    .all() as Array<{ blocked_id: string; blocker_id: string; created_by: string | null; created_at: string }>;
  const sets = new Map<string, typeof edges>();
  for (const edge of edges) {
    const set = sets.get(edge.blocked_id) ?? [];
    set.push(edge);
    sets.set(edge.blocked_id, set);
  }
  for (const [blockedId, set] of sets) {
    out.push({
      entity: "relation",
      entityId: blockedId,
      label: `blockers of ${identifierOf(db, blockedId)}`,
      payload: { blockedBy: set.map((edge) => edge.blocker_id) },
      actor: set[set.length - 1]!.created_by,
      at: latest(set.map((edge) => edge.created_at), now),
    });
  }

  for (const row of db.prepare("SELECT * FROM comments ORDER BY created_at, rowid").all() as Row[]) {
    out.push({
      entity: "comment",
      entityId: row.id as string,
      label: `comment on ${identifierOf(db, row.issue_id as string)}`,
      payload: payloadFromRow("comments", row),
      actor: str(row.author),
      at: str(row.created_at) ?? now,
    });
  }

  const revisions = db
    .prepare(
      `SELECT r.issue_id, r.key, r.revision, r.body, r.author, r.change_summary, r.created_at,
              d.current_revision, d.title, i.identifier
         FROM document_revisions r
         LEFT JOIN documents d ON d.issue_id = r.issue_id AND d.key = r.key
         LEFT JOIN issues i ON i.id = r.issue_id
        ORDER BY r.issue_id, r.key, r.revision`,
    )
    .all() as Array<{
    issue_id: string;
    key: string;
    revision: number;
    body: string;
    author: string | null;
    change_summary: string | null;
    created_at: string;
    current_revision: number | null;
    title: string | null;
    identifier: string | null;
  }>;
  for (const row of revisions) {
    const entityId = `${row.issue_id}/${row.key}/${row.revision}`;
    const label = `${row.identifier ?? row.issue_id} ${row.key} r${row.revision}`;
    if (row.identifier === null) {
      /**
       * `document_revisions` has no foreign key to `issues`, so a revision can outlive
       * its issue — `docs/sync.md` lists it under Known limits. A receiver cannot place
       * a revision of an issue it will never have, and would defer it for ever.
       */
      skipped.push({
        entity: "documentRevision",
        entityId,
        label,
        reason: "its issue no longer exists in this workspace, so no device could place it",
      });
      continue;
    }
    out.push({
      entity: "documentRevision",
      entityId,
      label,
      payload: {
        issueId: row.issue_id,
        key: row.key,
        revision: row.revision,
        body: row.body,
        title: row.revision === row.current_revision ? row.title : null,
        changeSummary: row.change_summary,
        author: row.author,
        createdAt: row.created_at,
      },
      actor: row.author,
      at: row.created_at,
    });
  }

  const milestoneIds = (
    db
      .prepare(
        `SELECT issue_id AS id FROM milestone_meta
          UNION SELECT milestone_id AS id FROM milestone_members
          ORDER BY id`,
      )
      .all() as Array<{ id: string }>
  ).map((row) => row.id);
  for (const milestoneId of milestoneIds) {
    const meta = db
      .prepare("SELECT target_date, start_date, updated_at FROM milestone_meta WHERE issue_id = ?")
      .get(milestoneId) as { target_date: string | null; start_date: string | null; updated_at: string } | undefined;
    const members = db
      .prepare("SELECT issue_id, added_by, added_at FROM milestone_members WHERE milestone_id = ? ORDER BY rank")
      .all(milestoneId) as Array<{ issue_id: string; added_by: string; added_at: string }>;
    const payload: Record<string, unknown> = { members: members.map((member) => member.issue_id) };
    if (meta) {
      payload.targetDate = meta.target_date;
      payload.startDate = meta.start_date;
    }
    out.push({
      entity: "milestone",
      entityId: milestoneId,
      label: identifierOf(db, milestoneId),
      payload,
      actor: members[members.length - 1]?.added_by ?? null,
      at: latest([meta?.updated_at ?? null, ...members.map((member) => member.added_at)], now),
    });
  }

  const plan = db
    .prepare("SELECT issue_id, added_by, added_at FROM queue_entries ORDER BY rank")
    .all() as Array<{ issue_id: string; added_by: string; added_at: string }>;
  if (plan.length > 0) {
    out.push({
      entity: "queue",
      entityId: QUEUE_PLAN_ID,
      label: "the plan",
      payload: { order: plan.map((entry) => entry.issue_id) },
      actor: plan[plan.length - 1]!.added_by,
      at: latest(plan.map((entry) => entry.added_at), now),
    });
  }

  return out;
}

// -------------------------------------------------------------------- yields

const DONE_STATUSES = new Set(["done", "cancelled"]);

/** The unique display keys and dedup tokens the repository's live entities hold. */
interface Claims {
  readonly identifiers: Map<string, string>;
  readonly issueKeys: Map<string, string>;
  readonly origins: Map<string, string>;
  readonly slugs: Map<string, string>;
  readonly commentKeys: Map<string, string>;
}

function claimsOf(index: SurveyIndex): Claims {
  const claims: Claims = {
    identifiers: new Map(),
    issueKeys: new Map(),
    origins: new Map(),
    slugs: new Map(),
    commentKeys: new Map(),
  };
  for (const issue of index.liveOf("issue")) {
    const s = issue.state;
    const identifier = str(s.identifier);
    if (identifier) claims.identifiers.set(identifier, issue.entityId);
    const key = str(s.idempotencyKey ?? s.idempotency_key);
    if (key) claims.issueKeys.set(key, issue.entityId);
    const originKind = str(s.originKind ?? s.origin_kind);
    const originId = str(s.originId ?? s.origin_id);
    const status = str(s.status);
    if (originKind && originKind !== "manual" && originId && !DONE_STATUSES.has(status ?? "")) {
      claims.origins.set(`${originKind}\n${originId}`, issue.entityId);
    }
  }
  for (const project of index.liveOf("project")) {
    const slug = str(project.state.slug);
    if (slug) claims.slugs.set(slug, project.entityId);
  }
  for (const comment of index.liveOf("comment")) {
    const issueId = str(comment.state.issueId ?? comment.state.issue_id);
    const key = str(comment.state.idempotencyKey ?? comment.state.idempotency_key);
    if (issueId && key) claims.commentKeys.set(`${issueId}\n${key}`, comment.entityId);
  }
  return claims;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Make every unique key of what this device is about to upload disjoint from the
 * repository's, by moving the LOCAL side.
 *
 * The repository's keys are already shared: every connected device knows its issue as
 * `STA-5` and its project as `web`. This device's entities of those names have never
 * been seen by anybody else. So the local side yields — renumbered, re-slugged, or
 * stripped of a dedup token — and never the repository's. Doing it before anything is
 * uploaded or applied is also what keeps every `UNIQUE` index on both sides reachable:
 * a collision left for a receiver to discover is a raw constraint failure that fails
 * its page for ever.
 */
function yieldToRepository(
  db: DatabaseSync,
  index: SurveyIndex,
  willSeed: (entity: string, entityId: string) => boolean,
  mode: SeedMode,
  repositoryId: string,
  now: string,
  report: { renamed: SeedRename[]; cleared: SeedCleared[] },
): void {
  const claims = claimsOf(index);

  const issues = db
    .prepare(
      "SELECT id, identifier, idempotency_key, origin_kind, origin_id, status, created_at FROM issues",
    )
    .all() as Array<{
    id: string;
    identifier: string;
    idempotency_key: string | null;
    origin_kind: string;
    origin_id: string | null;
    status: string;
    created_at: string;
  }>;

  const renumber: typeof issues = [];
  for (const issue of issues) {
    if (!willSeed("issue", issue.id)) continue;
    const holder = claims.identifiers.get(issue.identifier);
    if (holder !== undefined && holder !== issue.id) renumber.push(issue);

    if (issue.idempotency_key !== null) {
      const owner = claims.issueKeys.get(issue.idempotency_key);
      if (owner !== undefined && owner !== issue.id) {
        db.prepare("UPDATE issues SET idempotency_key = NULL WHERE id = ?").run(issue.id);
        report.cleared.push({
          entity: "issue",
          entityId: issue.id,
          label: issue.identifier,
          field: "idempotencyKey",
          value: issue.idempotency_key,
          heldBy: owner,
        });
      }
    }
    if (issue.origin_kind !== "manual" && issue.origin_id !== null && !DONE_STATUSES.has(issue.status)) {
      const owner = claims.origins.get(`${issue.origin_kind}\n${issue.origin_id}`);
      if (owner !== undefined && owner !== issue.id) {
        db.prepare("UPDATE issues SET origin_id = NULL WHERE id = ?").run(issue.id);
        report.cleared.push({
          entity: "issue",
          entityId: issue.id,
          label: issue.identifier,
          field: "originId",
          value: issue.origin_id,
          heldBy: owner,
        });
      }
    }
  }

  if (renumber.length > 0) {
    const prefix = (db.prepare("SELECT value FROM meta WHERE key = 'prefix'").get() as { value: string } | undefined)
      ?.value;
    const pattern = prefix ? new RegExp(`^${escapeRegExp(prefix)}-(\\d+)$`) : /^.+-(\d+)$/;
    const numberOf = (identifier: string): number => {
      const match = pattern.exec(identifier);
      return match ? Number(match[1]) : 0;
    };
    const counter = Number(
      (db.prepare("SELECT value FROM meta WHERE key = 'next_issue_number'").get() as { value: string } | undefined)
        ?.value ?? "1",
    );
    let highest = counter - 1;
    for (const issue of issues) highest = Math.max(highest, numberOf(issue.identifier));
    for (const identifier of claims.identifiers.keys()) highest = Math.max(highest, numberOf(identifier));

    renumber.sort((a, b) => numberOf(a.identifier) - numberOf(b.identifier) || a.created_at.localeCompare(b.created_at));
    const note = db.prepare(
      `INSERT INTO comments (id, issue_id, author, author_type, body, created_at)
       VALUES (?, ?, 'staple', 'system', ?, ?)`,
    );
    for (const issue of renumber) {
      highest += 1;
      const to = prefix ? `${prefix}-${highest}` : `${issue.identifier}-${highest}`;
      db.prepare("UPDATE issues SET identifier = ?, updated_at = ? WHERE id = ?").run(to, now, issue.id);
      /**
       * The old number is already in somebody's commit message, and there is no alias
       * table to resolve it. A comment on the issue is the durable record that does
       * exist: it travels with the issue to every device, `staple show` prints it, and
       * a search for the old identifier finds it.
       */
      note.run(
        newId(),
        issue.id,
        `Renumbered from ${issue.identifier} to ${to} when this workspace joined repository ` +
          `${repositoryId}: the repository already had an issue numbered ${issue.identifier}. ` +
          `A reference to ${issue.identifier} written on this machine before then means this issue.`,
        now,
      );
      report.renamed.push({
        entity: "issue",
        entityId: issue.id,
        label: to,
        field: "identifier",
        from: issue.identifier,
        to,
      });

      /**
       * A heal only: the repository's issue arrived here while this one sat on its
       * number, so the applier gave it a provisional `+N` and opened an identifier
       * conflict. The number is free now; it goes back to the issue every other device
       * already calls by it, and the conflict — which was never a disagreement between
       * two devices, only this machine's unshared number — is closed on the record.
       */
      if (mode === "heal") {
        const holder = claims.identifiers.get(issue.identifier)!;
        db.prepare("UPDATE issues SET identifier = ? WHERE id = ? AND identifier <> ?").run(
          issue.identifier,
          holder,
          issue.identifier,
        );
        db.prepare(
          `UPDATE sync_conflicts SET resolved_at = ?, resolved_by = 'staple', resolution = ?
            WHERE entity = 'issue' AND entity_id = ? AND field = 'identifier' AND resolved_at IS NULL`,
        ).run(now, JSON.stringify(issue.identifier), holder);
      }
    }
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('next_issue_number', ?)
       ON CONFLICT(key) DO UPDATE SET
         value = CASE WHEN CAST(meta.value AS INTEGER) > CAST(excluded.value AS INTEGER)
                      THEN meta.value ELSE excluded.value END`,
    ).run(String(highest + 1));
  }

  const projects = db.prepare("SELECT id, slug FROM projects").all() as Array<{ id: string; slug: string }>;
  const taken = new Set([...projects.map((project) => project.slug), ...claims.slugs.keys()]);
  for (const project of projects) {
    if (!willSeed("project", project.id)) continue;
    const holder = claims.slugs.get(project.slug);
    if (holder === undefined || holder === project.id) continue;
    let n = 2;
    while (taken.has(`${project.slug}-${n}`)) n += 1;
    const to = `${project.slug}-${n}`;
    taken.add(to);
    db.prepare("UPDATE projects SET slug = ?, updated_at = ? WHERE id = ?").run(to, now, project.id);
    report.renamed.push({ entity: "project", entityId: project.id, label: to, field: "slug", from: project.slug, to });
  }

  const keyed = db
    .prepare("SELECT id, issue_id, idempotency_key FROM comments WHERE idempotency_key IS NOT NULL")
    .all() as Array<{ id: string; issue_id: string; idempotency_key: string }>;
  for (const comment of keyed) {
    if (!willSeed("comment", comment.id)) continue;
    const owner = claims.commentKeys.get(`${comment.issue_id}\n${comment.idempotency_key}`);
    if (owner === undefined || owner === comment.id) continue;
    db.prepare("UPDATE comments SET idempotency_key = NULL WHERE id = ?").run(comment.id);
    report.cleared.push({
      entity: "comment",
      entityId: comment.id,
      label: `comment on ${identifierOf(db, comment.issue_id)}`,
      field: "idempotencyKey",
      value: comment.idempotency_key,
      heldBy: owner,
    });
  }
}

// ------------------------------------------------------------------ replaced

function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed !== null && typeof parsed === "object") return JSON.stringify(parsed);
    } catch {
      /* a plain string */
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  return JSON.stringify(value);
}

const NOT_COMPARED = new Set(["updated_at", "normalized_title", "status_version"]);

const BUILTIN_STATUS = new Map(BUILTIN_STATUS_SEED.map((status) => [status.id as string, status]));
const BUILTIN_KIND = new Map(BUILTIN_KIND_SEED.map((kind) => [kind.id as string, kind]));

/**
 * What this device held, before joining, for entities the repository also holds.
 *
 * The repository's state is applied over them — it is the one every other device
 * already has — and each value it replaces is named here so the replacement is on the
 * record rather than silent. A value this device never chose is not a replacement: a
 * built-in status still carrying the label it was installed with says nothing about
 * what anybody wanted, and reporting it would bury the real ones.
 */
function replacedValues(db: DatabaseSync, index: SurveyIndex): SeedReplaced[] {
  const out: SeedReplaced[] = [];
  const compareRow = (
    entity: SnapshotEntity,
    table: string,
    columns: Record<string, { column: string }>,
    label: (row: Row) => string,
  ): void => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entity.entityId) as Row | undefined;
    if (!row) return;
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(entity.state)) {
      const mapped = columns[key];
      if (!mapped || NOT_COMPARED.has(mapped.column) || seen.has(mapped.column)) continue;
      seen.add(mapped.column);
      if (table === "projects" && mapped.column === "source" && value === null && row.source_kind === "local") continue;
      if (canonical(row[mapped.column]) === canonical(value)) continue;
      out.push({ entity: entity.entity, entityId: entity.entityId, label: label(row), field: mapped.column, local: row[mapped.column], repository: value });
    }
  };

  for (const entity of index.survey.entities) {
    if (entity.deletedAt !== null || !isComplete(entity)) continue;
    switch (entity.entity) {
      case "issue":
        compareRow(entity, "issues", ISSUE_COLUMNS, (row) => String(row.identifier));
        break;
      case "comment":
        compareRow(entity, "comments", COMMENT_COLUMNS, (row) => `comment on ${identifierOf(db, String(row.issue_id))}`);
        break;
      case "project":
        compareRow(entity, "projects", PROJECT_COLUMNS, (row) => String(row.slug));
        break;
      case "status":
      case "kind": {
        if (entity.entityId === VOCABULARY_ORDER_ID) break;
        const table = entity.entity === "status" ? "workspace_statuses" : "workspace_kinds";
        const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(entity.entityId) as Row | undefined;
        if (!row) break;
        const builtin = entity.entity === "status" ? BUILTIN_STATUS.get(entity.entityId) : BUILTIN_KIND.get(entity.entityId);
        for (const field of entity.entity === "status" ? ["label", "category"] : ["label"]) {
          if (!(field in entity.state) || canonical(row[field]) === canonical(entity.state[field])) continue;
          if (builtin && canonical((builtin as Record<string, unknown>)[field]) === canonical(row[field])) continue;
          out.push({ entity: entity.entity, entityId: entity.entityId, label: entity.entityId, field, local: row[field], repository: entity.state[field] });
        }
        break;
      }
      case "setting": {
        const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(`${WORKSPACE_SETTING_META_PREFIX}${entity.entityId}`) as
          | { value: string }
          | undefined;
        if (!row) break;
        let local: unknown = row.value;
        try {
          local = (JSON.parse(row.value) as { value?: unknown }).value;
        } catch {
          /* compared as stored */
        }
        if (canonical(local) !== canonical(entity.state.value)) {
          out.push({ entity: "setting", entityId: entity.entityId, label: entity.entityId, field: "value", local, repository: entity.state.value });
        }
        break;
      }
      case "milestone": {
        const meta = db
          .prepare("SELECT target_date, start_date FROM milestone_meta WHERE issue_id = ?")
          .get(entity.entityId) as { target_date: string | null; start_date: string | null } | undefined;
        if (!meta) break;
        for (const [field, column] of [["targetDate", "target_date"], ["startDate", "start_date"]] as const) {
          if (!(field in entity.state)) continue;
          if (canonical(meta[column]) === canonical(entity.state[field])) continue;
          out.push({ entity: "milestone", entityId: entity.entityId, label: identifierOf(db, entity.entityId), field: column, local: meta[column], repository: entity.state[field] });
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

// ------------------------------------------------------------------ the seed

export interface SeedArgs {
  readonly repositoryId: string;
  readonly survey: RepositorySurvey;
  /** `capabilities().maxOpBytes`: the largest payload the service will take. */
  readonly maxOpBytes: number;
}

/**
 * `join` when this database has never synchronized with any repository, else `heal`.
 * Read from `sync_state`, inside the seed's own transaction — see {@link seedRepository}.
 */
export function seedModeOf(db: DatabaseSync): SeedMode {
  const row = db.prepare("SELECT cursor, epoch FROM sync_state WHERE id = 1").get() as
    | { cursor: string | null; epoch: number }
    | undefined;
  return row === undefined || (row.cursor === null && row.epoch === 0) ? "join" : "heal";
}

/** A local collection before the repository's version of it was applied. */
interface Collections {
  readonly plan: string[];
  readonly members: Map<string, string[]>;
  readonly blockers: Map<string, string[]>;
}

function collections(db: DatabaseSync): Collections {
  const plan = (db.prepare("SELECT issue_id FROM queue_entries ORDER BY rank").all() as Array<{ issue_id: string }>).map(
    (row) => row.issue_id,
  );
  const members = new Map<string, string[]>();
  for (const row of db
    .prepare("SELECT milestone_id, issue_id FROM milestone_members ORDER BY milestone_id, rank")
    .all() as Array<{ milestone_id: string; issue_id: string }>) {
    const list = members.get(row.milestone_id) ?? [];
    list.push(row.issue_id);
    members.set(row.milestone_id, list);
  }
  const blockers = new Map<string, string[]>();
  for (const row of db
    .prepare("SELECT blocked_id, blocker_id FROM relations WHERE type = 'blocks' ORDER BY blocked_id, id")
    .all() as Array<{ blocked_id: string; blocker_id: string }>) {
    const list = blockers.get(row.blocked_id) ?? [];
    list.push(row.blocker_id);
    blockers.set(row.blocked_id, list);
  }
  return { plan, members, blockers };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** Every item of `part` is in `whole`, in the same relative order. */
function isSubsequence(part: readonly string[], whole: readonly string[]): boolean {
  let at = 0;
  for (const item of whole) if (at < part.length && part[at] === item) at += 1;
  return at === part.length;
}

/**
 * Seed this database's state into the repository. ONE transaction, and the marker is
 * in it, so the seed happens exactly once per repository per database however the
 * process dies.
 */
export function seedRepository(db: DatabaseSync, journal: Journal, args: SeedArgs): SeedReport | null {
  const { repositoryId, survey } = args;
  return tx(db, () => {
    /**
     * Owed is decided HERE, under the write lock, and not only by the caller before its
     * survey. Two processes can sync one database at once — a manual `staple cloud
     * sync` overlapping an MCP post-write or a UI startup automatic sync — and nothing
     * serializes them but this transaction. Both found the seed owed before their
     * surveys; without this check the second seeded again from a state the first had
     * already replaced, deleting its unsent outbox and every version row and journaling
     * every entity a second time under new ids. Measured: eight creates on the service
     * for four entities, and this device's counters never again agreeing with anyone's.
     *
     * The mode is read here for the same reason: whether this database has synchronized
     * is a fact about now, not about the moment the caller looked.
     */
    if (!seedOwed(db, repositoryId)) return null;
    const mode = seedModeOf(db);
    const now = nowIso();
    const index = new SurveyIndex(survey);
    const renamed: SeedRename[] = [];
    const cleared: SeedCleared[] = [];
    const skipped: SeedSkipped[] = [];
    const merged: SeedItem[] = [];
    let replaced: SeedReplaced[] = [];

    if (mode === "join") {
      /**
       * Everything this database journaled before its first synchronization goes. The
       * seed below re-materialises every entity the repository does not hold from its
       * CURRENT state, which already contains every effect those operations described,
       * and for an entity the repository does hold the repository's state is applied
       * instead. What the pre-join journal cannot do is survive being sent: its
       * operations were allocated before the creates they depend on, and a push sends
       * in allocation order.
       *
       * The versions and the field record go with it for the reason `Journal.seed`
       * sets rather than bumps: they count operations no service has.
       */
      db.prepare("DELETE FROM sync_outbox WHERE acknowledged_seq IS NULL").run();
      db.prepare("DELETE FROM sync_field_writes").run();
      db.prepare("DELETE FROM sync_entity_versions").run();
    }

    const hasVersion = db.prepare("SELECT 1 AS hit FROM sync_entity_versions WHERE entity = ? AND entity_id = ?");
    const hasUnsent = db.prepare(
      "SELECT 1 AS hit FROM sync_outbox WHERE entity = ? AND entity_id = ? AND acknowledged_seq IS NULL LIMIT 1",
    );
    const hasCreate = db.prepare(
      "SELECT 1 AS hit FROM sync_outbox WHERE entity = ? AND entity_id = ? AND verb = 'create' LIMIT 1",
    );
    /**
     * Which local entities are sent.
     *
     * A join sends everything the repository does not hold, because nothing this
     * database holds has ever reached any service.
     *
     * A heal is narrower, because the database HAS been synchronizing, and an entity it
     * holds that the repository does not may be one a restore rolled back — which the
     * restore meant, and which re-uploading would undo. So a heal sends only what is
     * provably this device's and provably missing: an entity nothing ever journaled or
     * applied (no version row), an entity the repository holds only as updates with no
     * create, and an entity with unsent operations and no create anywhere in the outbox.
     */
    const willSeed = (entity: string, entityId: string): boolean => {
      if (index.holds(entity, entityId)) return false;
      if (mode === "join") return true;
      if (index.holdsIncomplete(entity, entityId)) return true;
      if (hasVersion.get(entity, entityId) === undefined) return true;
      return hasUnsent.get(entity, entityId) !== undefined && hasCreate.get(entity, entityId) === undefined;
    };

    yieldToRepository(db, index, willSeed, mode, repositoryId, now, { renamed, cleared });

    let before: Collections | null = null;
    if (mode === "join") {
      replaced = replacedValues(db, index);
      before = collections(db);
      /**
       * The repository's state, applied as a bootstrap: dependencies first, the ledger
       * rows under the same synthetic ids a paged bootstrap would use, and the tail
       * cursor this snapshot pinned becomes the ordinary pull cursor.
       */
      hydrate(db, journal, survey.entities, [], survey.cutoffSeq, now, true);
      completeSnapshot(db, survey.tailCursor, survey.epoch);
      replayOutboxFieldWrites(db);
    }

    const locals = inventory(db, now, skipped).filter(
      (local) => !local.implied && willSeed(local.entity, local.entityId),
    );
    const seededIssues = new Set(locals.filter((local) => local.entity === "issue").map((local) => local.entityId));
    const seededStatuses = locals.filter((local) => local.entity === "status").map((local) => local.entityId);
    const seededKinds = locals.filter((local) => local.entity === "kind").map((local) => local.entityId);

    const intents: SeedIntent[] = [];
    const tail: SeedIntent[] = [];
    const push = (local: LocalEntity): void => {
      intents.push({
        entity: local.entity,
        entityId: local.entityId,
        verb: "create",
        payload: local.payload,
        actor: local.actor,
        at: local.at,
        serviceVersion: index.version(local.entity, local.entityId),
      });
    };

    /**
     * The vocabulary orders. Not rows, so the inventory cannot carry them.
     *
     * A repository that held nothing takes this device's orders whole. A repository
     * that holds an order keeps it, with this device's new entries appended — the same
     * place its applier puts a status it has never seen. A repository with entries but
     * no order has an order nobody ever sent; imposing this device's would reorder
     * definitions it does not own, so its own new entries move to the end here instead,
     * which is where every receiver will put them.
     */
    const vocabularyOrder = (entity: "status" | "kind", seeded: string[]): SeedIntent | null => {
      const table = entity === "status" ? "workspace_statuses" : "workspace_kinds";
      const local = (db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, id`).all() as Array<{ id: string }>).map(
        (row) => row.id,
      );
      if (index.live === 0) {
        /**
         * What a fresh device will hold after applying the creates above: the built-ins
         * where its own migration put them, and every other entry appended in the order
         * the creates arrive, which is this device's order. When that is already this
         * device's order there is nothing to say; otherwise the order travels whole.
         */
        const builtins = (entity === "status" ? BUILTIN_STATUS_SEED : BUILTIN_KIND_SEED).map((row) => row.id as string);
        const expected = [
          ...builtins.filter((id) => local.includes(id)),
          ...local.filter((id) => !builtins.includes(id)),
        ];
        if (sameList(local, expected)) return null;
        return {
          entity,
          entityId: VOCABULARY_ORDER_ID,
          verb: "create",
          payload: { order: local },
          actor: null,
          at: now,
          serviceVersion: 0,
        };
      }
      if (seeded.length === 0) return null;
      const held = index.get(entity, VOCABULARY_ORDER_ID);
      if (held && held.deletedAt === null) {
        const order = [
          ...stringList(held.state.order).filter((id) => local.includes(id)),
          ...local.filter((id) => seeded.includes(id) && !stringList(held.state.order).includes(id)),
        ];
        applyToDatabase(db, { entity, entityId: VOCABULARY_ORDER_ID, verb: "update", payload: { order }, actor: null, deviceId: null, at: now, opId: null });
        merged.push({ entity, entityId: VOCABULARY_ORDER_ID, label: `the ${entity} order` });
        return { entity, entityId: VOCABULARY_ORDER_ID, verb: "update", payload: { order }, actor: null, at: now, serviceVersion: held.version };
      }
      const max = (db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS n FROM ${table}`).get() as { n: number }).n;
      const move = db.prepare(`UPDATE ${table} SET sort_order = ? WHERE id = ?`);
      local
        .filter((id) => seeded.includes(id))
        .forEach((id, position) => move.run(max + (position + 1) * 10, id));
      return null;
    };

    for (const local of locals.filter((candidate) => candidate.entity === "setting")) push(local);
    for (const local of locals.filter((candidate) => candidate.entity === "status")) push(local);
    const statusOrder = vocabularyOrder("status", seededStatuses);
    if (statusOrder) intents.push(statusOrder);
    for (const local of locals.filter((candidate) => candidate.entity === "kind")) push(local);
    const kindOrder = vocabularyOrder("kind", seededKinds);
    if (kindOrder) intents.push(kindOrder);
    for (const local of locals) {
      if (local.entity !== "setting" && local.entity !== "status" && local.entity !== "kind") push(local);
    }

    /**
     * Collections the repository already holds, that this device had put some of its
     * OWN entities into before joining. The repository's version was applied above; the
     * local entities are appended to it rather than dropped, because they are exactly
     * the items this device is adding. Anything else that differed took the
     * repository's version, and is on the record in `replaced`.
     */
    if (before !== null) {
      const mergeInto = (
        entity: "queue" | "milestone" | "relation",
        entityId: string,
        field: "order" | "members" | "blockedBy",
        verb: "replace" | "update",
        local: readonly string[],
        label: string,
      ): void => {
        if (local.length === 0) return;
        const held = index.get(entity, entityId);
        if (!held || held.deletedAt !== null) return;
        const theirs = stringList(held.state[field]);
        const additions = local.filter((id) => seededIssues.has(id) && !theirs.includes(id));
        const result = [...theirs, ...additions];
        /**
         * Replaced only if something of this device's did not survive: an item it had that
         * the result lacks, or two of its items now in the other order. The repository's
         * own items appearing around this device's is not a replacement — that is what
         * joining it means.
         */
        if (!isSubsequence(local, result)) {
          // Every one of these collections is a list of issues; a report names them the
          // way a human does.
          const shown = (ids: readonly string[]) => ids.map((id) => identifierOf(db, id));
          replaced.push({ entity, entityId, label, field, local: shown(local), repository: shown(result) });
        }
        if (additions.length === 0) return;
        applyToDatabase(db, { entity, entityId, verb, payload: { [field]: result }, actor: null, deviceId: null, at: now, opId: null });
        merged.push({ entity, entityId, label });
        tail.push({ entity, entityId, verb, payload: { [field]: result }, actor: null, at: now, serviceVersion: held.version });
      };
      mergeInto("queue", QUEUE_PLAN_ID, "order", "replace", before.plan, "the plan");
      for (const [milestoneId, members] of before.members) {
        mergeInto("milestone", milestoneId, "members", "replace", members, identifierOf(db, milestoneId));
      }
      for (const [blockedId, blockers] of before.blockers) {
        mergeInto("relation", blockedId, "blockedBy", "update", blockers, `blockers of ${identifierOf(db, blockedId)}`);
      }
    }
    intents.push(...tail);

    /**
     * The service refuses a payload above `maxOpBytes`, and refuses it for the whole
     * batch — so one oversized operation in an outbox is a push that fails the same way
     * on every sync, and nothing behind it ever leaves. It is decided here instead.
     *
     * A document revision is immutable and nothing names it, so it is left behind and
     * named. Anything else is a row that other rows depend on, and leaving it behind
     * would strand them; the seed refuses, names it, and writes nothing, and the fix is
     * to shorten it and sync again.
     */
    const sendable: SeedIntent[] = [];
    for (const intent of intents) {
      const bytes = Buffer.byteLength(JSON.stringify(intent.payload), "utf8");
      if (bytes <= args.maxOpBytes) {
        sendable.push(intent);
        continue;
      }
      const label = locals.find((local) => local.entity === intent.entity && local.entityId === intent.entityId)?.label ?? intent.entityId;
      if (intent.entity === "documentRevision") {
        skipped.push({
          entity: intent.entity,
          entityId: intent.entityId,
          label,
          reason: `it is ${bytes} bytes and the service takes at most ${args.maxOpBytes} per operation`,
        });
        continue;
      }
      throw new StapleError(
        "validation",
        `${intent.entity} ${label} is ${bytes} bytes, and the service takes at most ${args.maxOpBytes} ` +
          `per operation. Nothing was uploaded and nothing was changed. Shorten it and run sync again.`,
        { cloudCode: "payload_too_large", retryable: false, entity: intent.entity, entityId: intent.entityId },
      );
    }

    /**
     * A heal never gives an operation already in the outbox a new id. Any unacknowledged
     * row may have LANDED — its acknowledgement lost to a dropped connection, a killed
     * process, or automatic sync's budget aborting the request — and a retry under its
     * own id comes back `duplicate`, while the same operation under a new id is applied
     * a second time, at a later seq, over whatever landed in between. So the caller
     * sends the queue BEFORE the heal (`sync.ts`), and what the seed allocates here
     * simply follows it.
     *
     * That means an edit this device queued before healing can reach the service ahead
     * of the create the heal sends for the entity it names. A receiver that meets it
     * there defers it to the end of the page and, if the create is on a later page,
     * answers the page with one read of the snapshot, which folds the two into a whole
     * entity (`sync.ts`, `recoverFromSnapshot`). Out of order is recoverable; applied
     * twice is not. The same holds for a write another process journals between that
     * push and this transaction: it keeps its id and follows the push like any other.
     */
    journal.seed(sendable);

    const uploadedByEntity: Record<string, number> = {};
    let uploaded = 0;
    for (const intent of sendable) {
      // An order is not an item anybody made; it travels, and is not counted as one.
      if (intent.verb !== "create" || intent.entityId === VOCABULARY_ORDER_ID) continue;
      uploaded += 1;
      uploadedByEntity[intent.entity] = (uploadedByEntity[intent.entity] ?? 0) + 1;
    }

    const report: SeedReport = {
      repositoryId,
      mode,
      repositoryEntities: index.live,
      uploaded,
      uploadedByEntity,
      merged,
      renamed,
      cleared,
      replaced,
      skipped,
      at: now,
    };
    writeSeedMarker(db, report);
    return report;
  });
}
