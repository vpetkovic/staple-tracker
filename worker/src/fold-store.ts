/**
 * The fold, kept in D1 and advanced in bounded steps: the checkpoint every snapshot, backup
 * and restore reads.
 *
 * ## Why the fold is no longer computed on read
 *
 * It used to be. Every snapshot page, every backup and every restore's undo folded the
 * whole log of the epoch inside one request, and refused past 20,000 operations. Measured on
 * workerd (`wrangler dev --local`) with that cap lifted, a request at 20,000 operations took
 * 21–31 ms of isolate time against the free plan's 10 ms and 42 of its 50 queries per
 * invocation, and read all 20,000 rows for EVERY page of a snapshot; at 100,000 it took
 * 117–121 ms, 202 queries and 44 MB of rows handed to the isolate. The backup row copied the
 * fold too, against D1's 2 MB. The cap turned that into a refusal, which meant a repository
 * past it could not be backed up, and could not be restored because a restore backs up
 * first. worker/README.md, "The fold checkpoint", has the measurements before and after.
 *
 * ## What is stored
 *
 * `fold_versions` holds one row per entity per STEP that changed it: the entity as the fold
 * holds it at the end of that step, keyed by `(epoch, ord, seq)` where `seq` is the last
 * operation in the step that changed it. `fold_marks` holds the seq every step ended at,
 * with the fold's counts there. So:
 *
 *   **at a mark M, every entity is its newest version with `seq <= M`.**
 *
 * Every step folds a contiguous run of operations after the newest mark onto the fold at
 * that mark, and writes its versions and its own mark in ONE D1 batch, which is a
 * transaction. A mark therefore never exists without every version it depends on.
 *
 * Two of the fold's rules read other entities (`foldRow` in `fold.ts`): a `documentRevision`
 * create reads every revision of its document, and a `status` or `kind` created again
 * rewrites that vocabulary's `@order`. So a step loads those as well as the entities it
 * names, and writes a version of an `@order` it changed even though no operation named it
 * — which is why a version's key `seq` and the entity's `lastSeq` are separate columns.
 *
 * A snapshot or backup at a cutoff C that is not itself a mark reads the newest mark S at
 * or below C and folds the operations in `(S, C]` on top, the same way a step does. Steps
 * are at most {@link FOLD_STEP_OPS} operations long, so once the checkpoint has passed C
 * that tail is bounded too, and ANY cutoff — including one pinned in a snapshot cursor days
 * ago, or in a cursor an older Worker handed out — is served exactly.
 *
 * ## Why rows are versions, never updated in place
 *
 * A version row is a fact: *this entity as the fold of the log up to this seq holds it*.
 * It is a function of the log alone, so two steps that compute the same row compute the
 * same bytes, and `INSERT OR IGNORE` is all the concurrency control needed. Two requests
 * advancing at once, a push landing mid-step, a step that dies before its batch — none of
 * them can leave a torn state, because nothing is ever overwritten and a mark is only
 * written beside the versions it vouches for. Updating in place would have made a snapshot
 * pinned at an older cutoff unservable the moment anything moved past it.
 *
 * The cost is storage: a row per entity per step that changed it, which grows no faster
 * than the log (a step writes at most one row per operation it folds, plus an `@order` per
 * vocabulary it revived an entry of — and usually far fewer: ten edits of one issue in a
 * step are one row).
 *
 * ## Epochs
 *
 * Every row carries its epoch and every read filters on it, so a checkpoint is never read
 * across a restore: a new epoch starts with no marks and folds from its own first operation.
 * An old epoch's rows stay, as its operations do, and are what a restore of that epoch's
 * backups reads.
 *
 * ## A restore's order
 *
 * A restore stages a backup's entities in `restoreOrder` (`backups.ts`): by `claimSeq`
 * (`fold.ts`), then by key. Every version stores its entity's claim as `stage_order`, and
 * {@link restorePage} walks `fold_versions_stage` from the last entity staged, keeping only
 * the versions that are newest at the backup's cutoff. That walk needs the cutoff to be a mark,
 * because an entity's claim can change in a tail folded on top of one. So a backup's cutoff is
 * always made a mark ({@link pinMark}).
 *
 * ## Order
 *
 * A snapshot pages by `entityKey` in JavaScript string order (UTF-16 code units), and a
 * cursor names the last key it served. SQLite compares TEXT by UTF-8 bytes, which orders a
 * character in U+E000..U+FFFF after one above U+FFFF where JavaScript orders it before. So
 * the key is stored as {@link foldOrder}, an encoding whose byte order IS JavaScript's order,
 * and a cursor from any Worker resumes at exactly the entity it stopped after.
 */

import { entityKey } from "./cursor.js";
import type { Env } from "./env.js";
import { SyncError } from "./errors.js";
import { type FoldOpRow, type FoldedEntity, VOCABULARY_ORDER_ID, claimSeq, foldRow } from "./fold.js";
import { FOLD_STEP_BYTES, FOLD_STEP_OPS, FOLD_WRITE_BYTES, PAGE_BYTES, TAIL_BYTES } from "./limits.js";

const encoder = new TextEncoder();

/** The bytes a string is stored as: what `length(CAST(x AS BLOB))` measures in SQLite. */
export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** A step's end: every operation at or below `seq` is in the versions. */
export interface Mark {
  seq: number;
  /** Operations at or below `seq`. What a backup records as `opCount`. */
  opCount: number;
  /** The highest `schema_version` among them. Stored, never interpreted. */
  schemaVersion: number;
  /** How many entities of each kind the fold holds here, tombstones included. */
  kinds: Record<string, number>;
}

const NOTHING_FOLDED: Mark = { seq: 0, opCount: 0, schemaVersion: 0, kinds: {} };

/** The entities the fold holds at a mark: one per key, tombstones included. */
export function entityCount(mark: Mark): number {
  return Object.values(mark.kinds).reduce((sum, count) => sum + count, 0);
}

/**
 * `entityKey(entity, entityId)` encoded so that SQLite's byte order is JavaScript's string
 * order. Printable ASCII stays itself, so almost every key is readable as it is; a code unit
 * below U+0020 becomes `\x01` and four hex digits, and one at U+007F or above becomes `\x7F`
 * and four hex digits. The three classes sort in code-unit order by their first byte, the
 * hex is fixed-width, and no encoding of one unit is a prefix of another's — so comparing
 * two encodings compares the keys, unit by unit, exactly as `<` does, and a key starts with
 * a prefix exactly when its encoding starts with the prefix's.
 */
export function foldOrder(key: string): string {
  let out = "";
  for (let index = 0; index < key.length; index += 1) {
    const unit = key.charCodeAt(index);
    if (unit >= 0x20 && unit < 0x7f) out += key[index];
    else out += (unit < 0x20 ? "\u0001" : "\u007f") + unit.toString(16).padStart(4, "0");
  }
  return out;
}

/** The newest mark: how far the fold of this epoch has got. */
export async function foldProgress(env: Env, repoId: string, epoch: number): Promise<Mark> {
  return markAtOrBelow(env, repoId, epoch, Number.MAX_SAFE_INTEGER);
}

async function markAtOrBelow(env: Env, repoId: string, epoch: number, seq: number): Promise<Mark> {
  const row = await env.DB.prepare(
    `SELECT seq, op_count, schema_version, kinds FROM fold_marks
      WHERE repo_id = ?1 AND epoch = ?2 AND seq <= ?3
      ORDER BY seq DESC LIMIT 1`,
  )
    .bind(repoId, epoch, seq)
    .first<{ seq: number; op_count: number; schema_version: number; kinds: string }>();
  if (!row) return NOTHING_FOLDED;
  return {
    seq: row.seq,
    opCount: row.op_count,
    schemaVersion: row.schema_version,
    kinds: JSON.parse(row.kinds) as Record<string, number>,
  };
}

interface VersionRow {
  ord: string;
  seq: number;
  entity: string;
  entity_id: string;
  version: number;
  deleted_at: number | null;
  last_seq: number;
  superseded: number;
  state: string;
  field_writes: string;
  created_seq: number | null;
  created_at: string | null;
  created_by: string | null;
}

const VERSION_COLUMNS = `v.ord, v.seq, v.entity, v.entity_id, v.version, v.deleted_at, v.last_seq,
       v.superseded, v.state, v.field_writes, v.created_seq, v.created_at, v.created_by`;

function fromRow(row: VersionRow): FoldedEntity {
  return {
    entity: row.entity,
    entityId: row.entity_id,
    version: row.version,
    deletedAt: row.deleted_at,
    lastSeq: row.last_seq,
    superseded: row.superseded === 1,
    state: JSON.parse(row.state) as Record<string, unknown>,
    fieldWrites: JSON.parse(row.field_writes) as FoldedEntity["fieldWrites"],
    createdSeq: row.created_seq,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

/**
 * Every entity a run of operations can read, as the fold holds it at mark `at`, keyed by
 * `entityKey`: the ones they name, every revision of each document a `documentRevision`
 * create names (by key prefix, which the order encoding preserves), and the `@order` of each
 * vocabulary a `status` or `kind` create names. An entity absent at `at` is absent here.
 */
async function loadFold(
  env: Env,
  repoId: string,
  epoch: number,
  at: number,
  rows: readonly FoldOpRow[],
): Promise<Map<string, FoldedEntity>> {
  const fold = new Map<string, FoldedEntity>();
  if (at === 0 || rows.length === 0) return fold;
  const keys = new Set<string>();
  const documents = new Set<string>();
  for (const row of rows) {
    keys.add(foldOrder(entityKey(row.entity, row.entity_id)));
    if (row.verb !== "create") continue;
    if (row.entity === "status" || row.entity === "kind") keys.add(foldOrder(entityKey(row.entity, VOCABULARY_ORDER_ID)));
    if (row.entity === "documentRevision") {
      documents.add(foldOrder(entityKey(row.entity, row.entity_id.slice(0, row.entity_id.lastIndexOf("/") + 1))));
    }
  }
  /**
   * `CROSS JOIN` fixes the join order, and it is load-bearing: SQLite cannot size a
   * `json_each`, and left to itself it made `fold_versions` the outer loop — every version of
   * the epoch visited once per key asked for. Measured on workerd, that was 7 million rows read
   * by one pull of a 20,000-operation log. With the keys outside, each is one index seek.
   */
  const [named, siblings] = await env.DB.batch<VersionRow>([
    env.DB.prepare(
      `SELECT ${VERSION_COLUMNS}
         FROM json_each(?4) k
         CROSS JOIN fold_versions v
           ON v.repo_id = ?1 AND v.epoch = ?2 AND v.ord = k.value
          AND v.seq = (SELECT MAX(w.seq) FROM fold_versions w
                        WHERE w.repo_id = ?1 AND w.epoch = ?2 AND w.ord = k.value AND w.seq <= ?3)`,
    ).bind(repoId, epoch, at, JSON.stringify([...keys])),
    // `char(128)` sorts after every byte an encoded key can hold, so this is "starts with".
    env.DB.prepare(
      `SELECT ${VERSION_COLUMNS}
         FROM (SELECT w.ord, MAX(w.seq) AS at
                 FROM json_each(?4) p
                 CROSS JOIN fold_versions w
                   ON w.repo_id = ?1 AND w.epoch = ?2 AND w.ord >= p.value AND w.ord < p.value || char(128)
                  AND w.seq <= ?3
                GROUP BY w.ord) m
         CROSS JOIN fold_versions v ON v.repo_id = ?1 AND v.epoch = ?2 AND v.ord = m.ord AND v.seq = m.at`,
    ).bind(repoId, epoch, at, JSON.stringify([...documents])),
  ]);
  for (const row of [...named!.results, ...siblings!.results]) {
    fold.set(entityKey(row.entity, row.entity_id), fromRow(row));
  }
  return fold;
}

/**
 * Fold a run of operations onto the fold at `base`. Answers every entry the run changed,
 * with the seq of the last operation that changed it, the keys of the entities it created,
 * and the counts at the run's end.
 */
async function foldRun(
  env: Env,
  repoId: string,
  epoch: number,
  base: Mark,
  rows: readonly (FoldOpRow & { schema_version: number })[],
  seq: number,
): Promise<{
  fold: Map<string, FoldedEntity>;
  changed: Map<string, number>;
  created: Set<string>;
  mark: Mark;
}> {
  const fold = await loadFold(env, repoId, epoch, base.seq, rows);
  const existed = new Set(fold.keys());
  const changed = new Map<string, number>();
  const kinds = { ...base.kinds };
  let schemaVersion = base.schemaVersion;
  for (const row of rows) {
    if (row.schema_version > schemaVersion) schemaVersion = row.schema_version;
    const entry = foldRow(fold, row, (key) => changed.set(key, row.seq));
    if (entry !== null) changed.set(entityKey(entry.entity, entry.entityId), row.seq);
  }
  const created = new Set<string>();
  for (const key of changed.keys()) {
    if (existed.has(key)) continue;
    created.add(key);
    const entity = fold.get(key)!.entity;
    kinds[entity] = (kinds[entity] ?? 0) + 1;
  }
  const sorted: Record<string, number> = {};
  for (const kind of Object.keys(kinds).sort()) sorted[kind] = kinds[kind]!;
  return {
    fold,
    changed,
    created,
    mark: { seq, opCount: base.opCount + rows.length, schemaVersion, kinds: sorted },
  };
}

/**
 * What a request may still fold, in operations and in payload bytes. Shared by every advance
 * one request makes; `bytes` absent is no byte limit, which only a test asks for.
 */
export interface FoldBudget {
  remaining: number;
  bytes?: number;
}

export interface AdvanceOptions {
  /** Spent as operations are folded; the advance stops when it runs out. */
  budget: FoldBudget;
  /** Operations per step. {@link FOLD_STEP_OPS} unless a test needs another. */
  stepOps?: number;
  /** Payload bytes per step. {@link FOLD_STEP_BYTES} unless a test needs another. */
  stepBytes?: number;
  /** Test seam: runs after a step has read its operations, before it reads what they fold onto. */
  afterRead?: () => Promise<void>;
  /** Test seam: runs after a step has folded its operations, before it writes. */
  beforeWrite?: () => Promise<void>;
}

/**
 * Fold this epoch's operations up to `target`, in steps, until it gets there or the budget
 * runs out, and answer the newest mark.
 *
 * `target` must be a seq the caller read from `repos.last_seq` (or a cutoff at or below
 * one): every operation at or below such a seq is already committed, because a push
 * reserves its seqs and writes its rows in one transaction. A step that reads fewer rows
 * than it asked for therefore ends AT the target, and the mark it writes claims nothing that
 * could still arrive.
 */
export async function advanceFold(
  env: Env,
  repoId: string,
  epoch: number,
  target: number,
  options: AdvanceOptions,
): Promise<Mark> {
  const stepOps = options.stepOps ?? FOLD_STEP_OPS;
  const stepBytes = options.stepBytes ?? FOLD_STEP_BYTES;
  let mark = await foldProgress(env, repoId, epoch);

  while (mark.seq < target && options.budget.remaining > 0 && (options.budget.bytes ?? 1) > 0) {
    const limit = Math.min(stepOps, options.budget.remaining);
    const byteCap = Math.min(stepBytes, options.budget.bytes ?? Number.POSITIVE_INFINITY);
    /**
     * At most `limit` operations, and no more payload than `stepBytes` — the first always,
     * so a single operation larger than the budget still moves the fold on. The rows past
     * the byte budget come back with a NULL payload (`ops.payload` is NOT NULL), which is
     * where the step stops. The inner LIMIT is what bounds the scan: the window runs over
     * at most `limit` rows, never over the rest of the backlog.
     */
    const read = await env.DB.prepare(
      `SELECT seq, op_id, entity, entity_id, verb, actor, created_at, server_ts, schema_version, bytes,
              CASE WHEN spent - bytes < ?5 THEN payload END AS payload
         FROM (SELECT *, SUM(bytes) OVER (ORDER BY seq ROWS UNBOUNDED PRECEDING) AS spent
                 FROM (SELECT seq, op_id, entity, entity_id, verb, actor, created_at, server_ts,
                              schema_version, payload, length(CAST(payload AS BLOB)) AS bytes
                         FROM ops
                        WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
                        ORDER BY seq
                        LIMIT ?6))
        ORDER BY seq`,
    )
      .bind(repoId, epoch, mark.seq, target, byteCap, limit)
      .all<Omit<FoldOpRow, "payload"> & { payload: string | null; schema_version: number; bytes: number }>();

    const cut = read.results.findIndex((row) => row.payload === null);
    const rows = (cut >= 0 ? read.results.slice(0, cut) : read.results) as (FoldOpRow & {
      schema_version: number;
    })[];
    const end = cut >= 0 || read.results.length === limit ? rows[rows.length - 1]!.seq : target;

    await options.afterRead?.();
    const run = await foldRun(env, repoId, epoch, mark, rows, end);

    await options.beforeWrite?.();

    await env.DB.batch([
      ...writeVersions(env, repoId, epoch, run.fold, run.changed),
      env.DB.prepare(
        `INSERT OR IGNORE INTO fold_marks (repo_id, epoch, seq, op_count, schema_version, kinds)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(repoId, epoch, run.mark.seq, run.mark.opCount, run.mark.schemaVersion, JSON.stringify(run.mark.kinds)),
    ]);
    options.budget.remaining -= rows.length;
    if (options.budget.bytes !== undefined) {
      options.budget.bytes -= rows.reduce((sum, row) => sum + (row as { bytes?: number }).bytes!, 0);
    }
    mark = run.mark;
  }
  return mark;
}

/**
 * The versions a step wrote, packed into as few statements as the size of a bound value
 * allows. The state travels as the JSON text `JSON.stringify` made of it, inside a JSON
 * string, so `json_extract` hands SQLite exactly those bytes and a read hands back the same
 * object with the same key order.
 *
 * D1 refuses a bound value past 2,000,000 bytes, and packing is not free: a state's JSON
 * text, escaped again inside the packed array, can be twice its own size — every quote in it
 * is `\\\"` there. So a pack is closed at {@link FOLD_WRITE_BYTES}, and a version too large to
 * share one is written alone with every column bound as it is, which costs nothing but its
 * own bytes.
 */
function writeVersions(
  env: Env,
  repoId: string,
  epoch: number,
  fold: ReadonlyMap<string, FoldedEntity>,
  changed: ReadonlyMap<string, number>,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  let packed: string[] = [];
  let bytes = 0;
  const flush = () => {
    if (packed.length === 0) return;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO fold_versions
           (repo_id, epoch, ord, seq, entity, entity_id, version, deleted_at, last_seq, superseded,
            state, field_writes, created_seq, created_at, created_by, stage_order)
         SELECT ?1, ?2, json_extract(value, '$.o'), json_extract(value, '$.s'),
                json_extract(value, '$.e'), json_extract(value, '$.i'), json_extract(value, '$.v'),
                json_extract(value, '$.d'), json_extract(value, '$.l'), json_extract(value, '$.u'),
                json_extract(value, '$.st'), json_extract(value, '$.fw'), json_extract(value, '$.cs'),
                json_extract(value, '$.ca'), json_extract(value, '$.cb'), json_extract(value, '$.so')
           FROM json_each(?3)`,
      ).bind(repoId, epoch, `[${packed.join(",")}]`),
    );
    packed = [];
    bytes = 0;
  };
  for (const [key, seq] of changed) {
    const entry = fold.get(key)!;
    const item = JSON.stringify({
      o: foldOrder(key),
      s: seq,
      e: entry.entity,
      i: entry.entityId,
      v: entry.version,
      d: entry.deletedAt,
      l: entry.lastSeq,
      u: entry.superseded ? 1 : 0,
      st: JSON.stringify(entry.state),
      fw: JSON.stringify(entry.fieldWrites),
      cs: entry.createdSeq,
      ca: entry.createdAt ?? null,
      cb: entry.createdBy ?? null,
      so: claimSeq(entry) ?? 0,
    });
    // In bytes: a state's text is not escaped past ASCII, so a character can be three of them.
    const size = utf8Bytes(item);
    if (size > FOLD_WRITE_BYTES) {
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO fold_versions
             (repo_id, epoch, ord, seq, entity, entity_id, version, deleted_at, last_seq, superseded,
              state, field_writes, created_seq, created_at, created_by, stage_order)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`,
        ).bind(
          repoId,
          epoch,
          foldOrder(key),
          seq,
          entry.entity,
          entry.entityId,
          entry.version,
          entry.deletedAt,
          entry.lastSeq,
          entry.superseded ? 1 : 0,
          JSON.stringify(entry.state),
          JSON.stringify(entry.fieldWrites),
          entry.createdSeq,
          entry.createdAt ?? null,
          entry.createdBy ?? null,
          claimSeq(entry) ?? 0,
        ),
      );
      continue;
    }
    if (bytes > 0 && bytes + size > FOLD_WRITE_BYTES) flush();
    packed.push(item);
    bytes += size;
  }
  flush();
  return statements;
}

/**
 * Advance the fold towards `cutoff` by this request's budget, and refuse unless it got there:
 * unless no operation at or below the cutoff is left unfolded. What is then left to read at the
 * cutoff is at most the step a concurrent request's advance carried past it, which `pinMark` and
 * `foldedPage` fold on top of the mark below.
 *
 * Refusing short of the cutoff, rather than folding the last step inside the read as well, is
 * what bounds a request to ONE budget of folding: a request that folded a step here and another
 * on top of it measured 12 ms of isolate time on workerd, past the free plan's 10.
 *
 * Every route that must read the fold at a cutoff calls this BEFORE it changes anything, so
 * a refusal leaves nothing behind but the fold's own progress.
 */
export async function reachFold(
  env: Env,
  repoId: string,
  epoch: number,
  cutoff: number,
  options: AdvanceOptions,
): Promise<void> {
  const mark = await advanceFold(env, repoId, epoch, cutoff, options);
  if (mark.seq >= cutoff) return;
  // The budget ran out exactly where the operations did, short of a gap in seq: nothing is left.
  const left = await env.DB.prepare(
    `SELECT seq FROM ops WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4 LIMIT 1`,
  )
    .bind(repoId, epoch, mark.seq, cutoff)
    .first<{ seq: number }>();
  if (left) throw foldBehind(mark.seq, cutoff);
}

/**
 * The fold has not reached a cutoff this request needs, and this request's budget did not
 * get it there.
 *
 * `unavailable` because it is retryable in every released client and nothing was changed.
 * Every request that meets it has already moved the fold on by its budget, so asking again
 * finishes the job: `foldedSeq` is how far the fold has got and `cutoffSeq` how far it has
 * to go, and a caller that sees `foldedSeq` climbing between attempts knows it is being
 * served, not stalled.
 */
export function foldBehind(foldedSeq: number, cutoffSeq: number): SyncError {
  return new SyncError(
    "unavailable",
    `the service is still folding this repository's log: it has reached seq ${foldedSeq} of ` +
      `${cutoffSeq}. Every request moves it on; ask again.`,
    { foldedSeq, cutoffSeq },
    { "retry-after": "1" },
  );
}

/**
 * The fold at `cutoff`, as the newest mark S at or below it plus the operations in
 * `(S, cutoff]` folded on top. The caller must have advanced the fold to the cutoff: past
 * the newest mark the tail is unbounded, and this refuses rather than folding it.
 */
async function foldAt(
  env: Env,
  repoId: string,
  epoch: number,
  cutoff: number,
): Promise<{
  base: Mark;
  fold: Map<string, FoldedEntity>;
  changed: Map<string, number>;
  created: Set<string>;
  mark: Mark;
}> {
  const base = await markAtOrBelow(env, repoId, epoch, cutoff);
  if (base.seq === cutoff) return { base, fold: new Map(), changed: new Map(), created: new Set(), mark: base };
  // Sized first, so a tail past the checkpoint is refused before any of it is read.
  const size = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes
       FROM (SELECT length(CAST(payload AS BLOB)) AS bytes FROM ops
              WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
              LIMIT ?5)`,
  )
    .bind(repoId, epoch, base.seq, cutoff, FOLD_STEP_OPS + 1)
    .first<{ n: number; bytes: number }>();
  if ((size?.n ?? 0) > FOLD_STEP_OPS || (size?.bytes ?? 0) > TAIL_BYTES) throw foldBehind(base.seq, cutoff);
  const read = await env.DB.prepare(
    `SELECT seq, op_id, entity, entity_id, verb, payload, actor, created_at, server_ts, schema_version
       FROM ops
      WHERE repo_id = ?1 AND epoch = ?2 AND seq > ?3 AND seq <= ?4
      ORDER BY seq`,
  )
    .bind(repoId, epoch, base.seq, cutoff)
    .all<FoldOpRow & { schema_version: number }>();
  const run = await foldRun(env, repoId, epoch, base, read.results, cutoff);
  return { base, fold: run.fold, changed: run.changed, created: run.created, mark: run.mark };
}

/**
 * Make `cutoff` a mark, and answer the fold's counts there: what a backup taken at it records.
 *
 * A cutoff is usually a mark already — the step that reached it ended there. It is not when a
 * concurrent request's step carried the checkpoint past it, or when the operator cleared the
 * checkpoint and it was folded back in other steps. Then the tail on top of the mark below is
 * folded, as any read at the cutoff does, and written as a step would write it: a version of
 * every entity it changed, at the seq of the operation that last changed it, and the mark, in
 * one batch. That is sound beside the steps already written past it, because a version is a
 * function of the log up to its seq alone: where a later step wrote a row at the same seq, it
 * wrote these bytes, and `INSERT OR IGNORE` keeps one of two equal rows. And at a mark every
 * entity is its newest version at or below it, which is what this adds.
 *
 * Why a backup's cutoff must be a mark: a restore pages it in stage order ({@link restorePage}),
 * and an entity's stage order can change in the tail, so a page folded on top of a mark could
 * not be cut by an index. The caller must have reached the cutoff (`reachFold`).
 */
export async function pinMark(env: Env, repoId: string, epoch: number, cutoff: number): Promise<Mark> {
  const at = await foldAt(env, repoId, epoch, cutoff);
  if (at.base.seq === cutoff) return at.mark;
  await env.DB.batch([
    ...writeVersions(env, repoId, epoch, at.fold, at.changed),
    env.DB.prepare(
      `INSERT OR IGNORE INTO fold_marks (repo_id, epoch, seq, op_count, schema_version, kinds)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    ).bind(repoId, epoch, at.mark.seq, at.mark.opCount, at.mark.schemaVersion, JSON.stringify(at.mark.kinds)),
  ]);
  return at.mark;
}

/**
 * The fold at the mark `cutoff`, the page of entities a restore stages next: in stage order —
 * `claimSeq`, then key, which is `restoreOrder` in `backups.ts` — after `afterKey`, the entity
 * the last turn staged (or from the start, given null). At most `limit` of them and no more than
 * `maxBytes` of their state, which is what a restore writes — always at least one.
 *
 * Read off `fold_versions_stage`: the versions at or below the cutoff in stage order, each kept
 * only when it is its entity's newest there. A version an entity has since moved past is read
 * and passed over once, by the one turn whose page it falls in, so a whole restore reads each
 * version of the epoch at most once.
 */
export async function restorePage(
  env: Env,
  repoId: string,
  epoch: number,
  cutoff: number,
  afterKey: string | null,
  limit: number,
  maxBytes: number = PAGE_BYTES,
): Promise<FoldedEntity[]> {
  const base = await markAtOrBelow(env, repoId, epoch, cutoff);
  if (base.seq !== cutoff) throw foldBehind(base.seq, cutoff);

  let position: [number, string] = [-1, ""];
  if (afterKey !== null) {
    const ord = foldOrder(afterKey);
    const staged = await env.DB.prepare(
      `SELECT stage_order FROM fold_versions
        WHERE repo_id = ?1 AND epoch = ?2 AND ord = ?3 AND seq <= ?4
        ORDER BY seq DESC LIMIT 1`,
    )
      .bind(repoId, epoch, ord, cutoff)
      .first<{ stage_order: number }>();
    if (!staged) {
      throw new SyncError("conflict", "the restore staged an entity the backup it is restoring does not hold");
    }
    position = [staged.stage_order, ord];
  }

  const listed = (
    await env.DB.prepare(
      `SELECT v.ord, v.seq, length(CAST(v.state AS BLOB)) AS size
         FROM fold_versions v
        WHERE v.repo_id = ?1 AND v.epoch = ?2 AND (v.stage_order, v.ord) > (?3, ?4) AND v.seq <= ?5
          AND NOT EXISTS (SELECT 1 FROM fold_versions w
                           WHERE w.repo_id = ?1 AND w.epoch = ?2 AND w.ord = v.ord AND w.seq > v.seq AND w.seq <= ?5)
        ORDER BY v.stage_order, v.ord
        LIMIT ?6`,
    )
      .bind(repoId, epoch, position[0], position[1], cutoff, limit)
      .all<{ ord: string; seq: number; size: number }>()
  ).results;

  const page: Array<{ ord: string; seq: number }> = [];
  let bytes = 0;
  for (const row of listed) {
    if (page.length > 0 && bytes + row.size > maxBytes) break;
    page.push(row);
    bytes += row.size;
  }
  if (page.length === 0) return [];

  const read = await env.DB.prepare(
    `SELECT ${VERSION_COLUMNS}
       FROM json_each(?3) k
      CROSS JOIN fold_versions v
         ON v.repo_id = ?1 AND v.epoch = ?2
        AND v.ord = json_extract(k.value, '$[0]') AND v.seq = json_extract(k.value, '$[1]')`,
  )
    .bind(repoId, epoch, JSON.stringify(page.map((row) => [row.ord, row.seq])))
    .all<VersionRow>();
  const byOrd = new Map(read.results.map((row) => [row.ord, fromRow(row)]));
  return page.map((row) => byOrd.get(row.ord)!);
}

/** The fold's counts at `cutoff`: what a backup taken there records. */
export async function foldSummary(env: Env, repoId: string, epoch: number, cutoff: number): Promise<Mark> {
  return (await foldAt(env, repoId, epoch, cutoff)).mark;
}

export interface FoldPage {
  /** In snapshot order, after the key asked for. */
  entities: FoldedEntity[];
  hasMore: boolean;
  /** Every entity kind the fold holds at the cutoff — the WHOLE fold, not this page. */
  kinds: string[];
}

/**
 * The fold at `cutoff`, the page of entities whose keys follow `afterKey`: at most `limit` of
 * them, and no more than `maxBytes` of their stored state — always at least one.
 */
export async function foldedPage(
  env: Env,
  repoId: string,
  epoch: number,
  cutoff: number,
  afterKey: string,
  limit: number,
  maxBytes: number = PAGE_BYTES,
): Promise<FoldPage> {
  const at = await foldAt(env, repoId, epoch, cutoff);
  const after = foldOrder(afterKey);

  // The first `limit + 1` entities that existed at S, after the key, and how large each is —
  // measured in SQLite, so an oversized page is cut before it is read. An entity the tail
  // creates can only fall among them or after the last of them, so these and the tail's
  // together hold the first `limit + 1` entities at the cutoff.
  const listed =
    at.base.seq === 0
      ? []
      : (
          await env.DB.prepare(
            `SELECT m.ord, m.at, v.entity, v.entity_id,
                    length(CAST(v.state AS BLOB)) + length(CAST(v.field_writes AS BLOB)) AS size
               FROM (SELECT ord, MAX(seq) AS at FROM fold_versions
                      WHERE repo_id = ?1 AND epoch = ?2 AND ord > ?3 AND seq <= ?4
                      GROUP BY ord ORDER BY ord LIMIT ?5) m
              CROSS JOIN fold_versions v
                 ON v.repo_id = ?1 AND v.epoch = ?2 AND v.ord = m.ord AND v.seq = m.at
              ORDER BY m.ord`,
          )
            .bind(repoId, epoch, after, at.base.seq, limit + 1)
            .all<{ ord: string; at: number; entity: string; entity_id: string; size: number }>()
        ).results;

  // An entity the tail read or changed is as the tail left it; the rest are read below.
  const candidates = new Map<string, { at?: number; size: number; entry?: FoldedEntity }>();
  // In UTF-8 bytes, as SQLite measured the rest, so a page is cut at the same entity whichever
  // side of the checkpoint it came from.
  const sized = (entry: FoldedEntity) => utf8Bytes(JSON.stringify(entry.state)) + utf8Bytes(JSON.stringify(entry.fieldWrites));
  for (const row of listed) {
    const entry = at.fold.get(entityKey(row.entity, row.entity_id));
    candidates.set(row.ord, entry ? { size: sized(entry), entry } : { at: row.at, size: row.size });
  }
  for (const key of at.created) {
    const ord = foldOrder(key);
    const entry = at.fold.get(key)!;
    if (ord > after) candidates.set(ord, { size: sized(entry), entry });
  }
  const ordered = [...candidates.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const page: string[] = [];
  let bytes = 0;
  for (const ord of ordered) {
    if (page.length === limit) break;
    const size = candidates.get(ord)!.size;
    if (page.length > 0 && bytes + size > maxBytes) break;
    page.push(ord);
    bytes += size;
  }

  const unread = page.filter((ord) => candidates.get(ord)!.entry === undefined);
  const read =
    unread.length === 0
      ? []
      : (
          await env.DB.prepare(
            `SELECT ${VERSION_COLUMNS}
               FROM json_each(?3) k
              CROSS JOIN fold_versions v
                 ON v.repo_id = ?1 AND v.epoch = ?2
                AND v.ord = json_extract(k.value, '$[0]') AND v.seq = json_extract(k.value, '$[1]')`,
          )
            .bind(repoId, epoch, JSON.stringify(unread.map((ord) => [ord, candidates.get(ord)!.at])))
            .all<VersionRow>()
        ).results;
  for (const row of read) candidates.get(row.ord)!.entry = fromRow(row);

  return {
    entities: page.map((ord) => candidates.get(ord)!.entry!),
    hasMore: page.length < ordered.length,
    kinds: Object.keys(at.mark.kinds),
  };
}
