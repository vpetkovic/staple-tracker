/**
 * The `sync_state` singleton: this device's position in a shared log.
 *
 * Contract: `docs/sync.md`, "The local sync tables" and "Ordering, cursors and
 * epochs".
 *
 * ## Cursors are bytes
 *
 * *"A cursor is an opaque string; clients treat it as bytes, never parse one, and
 * never synthesise one."* Nothing in this file decodes a cursor, compares two
 * cursors for ordering, or constructs one. They are stored, replayed and
 * discarded. The only cursor-shaped decision made here is *which* stored string
 * to replay, and that is decided by which column is null.
 *
 * ## Why the bootstrap position is a JSON object in one column
 *
 * A bootstrap has two independent cursors — the snapshot page cursor and the pull
 * cursor for the ordered tail the snapshot pinned — and migration 010 gave
 * `sync_state` one `bootstrap_cursor` column. Rather than add a column mid-wave
 * to a table three other lanes are about to read, both live in that column as
 * `{"snapshot":…,"tail":…}`.
 *
 * That is bookkeeping *about* opaque values, not parsing *of* them. The two
 * strings are moved in and out verbatim; this file could not tell you which
 * repository or epoch either one names, which is exactly the property the opacity
 * rule is protecting.
 *
 * The tail cursor has to be persisted rather than recomputed because the server
 * returns it on every snapshot page: a device killed after the last snapshot page
 * committed but before it recorded where the tail starts has no way to ask for
 * it again without re-taking the snapshot, and re-taking it would pin a *later*
 * cutoff and silently skip the operations in between.
 */
import type { DatabaseSync } from "node:sqlite";
import { tx } from "../db.js";
import { StapleError, nowIso } from "../types.js";
import type { SnapshotEntity } from "./wire.js";

/** Where a bootstrap got to. `snapshot` and `tail` are opaque server strings. */
export interface BootstrapPosition {
  /** The next snapshot page, or null when every page has been applied. */
  readonly snapshot: string | null;
  /** The pull cursor for the tail this snapshot pinned. */
  readonly tail: string;
  /**
   * Entities from pages already committed that could not be applied yet, because
   * something they name is on a later page (`hydrate.ts`). Persisted with the position
   * rather than held in memory: the page that delivered them is committed and the
   * position has moved past it, so a process that died holding them only in memory
   * would resume past entities it never wrote.
   */
  readonly parked?: readonly SnapshotEntity[];
}

export interface SyncState {
  readonly repositoryId: string | null;
  readonly epoch: number;
  /** The incremental pull cursor. Null before the first bootstrap completes. */
  readonly cursor: string | null;
  /** The highest server watermark this device has been told about. */
  readonly headSeq: number;
  readonly clientSeqHighWater: number;
  readonly lastSyncAt: string | null;
  readonly bootstrap: BootstrapPosition | null;
}

interface Row {
  repository_id: string | null;
  epoch: number;
  cursor: string | null;
  head_seq: number;
  client_seq_high_water: number;
  last_sync_at: string | null;
  bootstrap_cursor: string | null;
}

/**
 * Read the row, or null when this workspace has never recorded an identity.
 *
 * Null is a real answer and not an error: migration 010 deliberately seeds
 * nothing, so an unconnected workspace has no row at all. That absence is what
 * makes "has this workspace ever been connected" askable.
 */
export function readSyncState(db: DatabaseSync): SyncState | null {
  const row = db
    .prepare(
      `SELECT repository_id, epoch, cursor, head_seq, client_seq_high_water,
              last_sync_at, bootstrap_cursor
         FROM sync_state WHERE id = 1`,
    )
    .get() as Row | undefined;
  if (!row) return null;

  return {
    repositoryId: row.repository_id,
    epoch: row.epoch,
    cursor: row.cursor,
    headSeq: row.head_seq,
    clientSeqHighWater: row.client_seq_high_water,
    lastSyncAt: row.last_sync_at,
    bootstrap: parseBootstrap(row.bootstrap_cursor),
  };
}

export function requireSyncState(db: DatabaseSync): SyncState {
  const state = readSyncState(db);
  if (!state || !state.repositoryId) {
    throw new StapleError(
      "not_found",
      "This workspace has no recorded repository identity, so there is no log to synchronize " +
        "with. `staple init` records one for a repo-local workspace; a global workspace has none.",
    );
  }
  return state;
}

/**
 * A damaged bootstrap position reads as "no bootstrap in progress".
 *
 * The alternative — refusing — would strand a workspace on a value nothing can
 * repair by hand, since the contents are opaque and there is nothing sensible for
 * a human to edit them to. Falling back to null costs one re-taken snapshot,
 * which is bounded work with a correct outcome, and `cursor` is left untouched so
 * an already-completed bootstrap is not re-run.
 */
function parseBootstrap(raw: string | null): BootstrapPosition | null {
  if (raw === null || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (typeof record.tail !== "string") return null;
  const snapshot = record.snapshot;
  if (snapshot !== null && typeof snapshot !== "string") return null;
  const parked = record.parked;
  if (parked === undefined) return { snapshot: snapshot ?? null, tail: record.tail };
  if (!Array.isArray(parked) || !parked.every(isParkedEntity)) return null;
  return { snapshot: snapshot ?? null, tail: record.tail, parked: parked as SnapshotEntity[] };
}

function isParkedEntity(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const entity = value as Record<string, unknown>;
  return (
    typeof entity.entity === "string" &&
    typeof entity.entityId === "string" &&
    typeof entity.version === "number" &&
    typeof entity.lastSeq === "number" &&
    typeof entity.verb === "string" &&
    entity.state !== null &&
    typeof entity.state === "object"
  );
}

function encodeBootstrap(position: BootstrapPosition | null): string | null {
  return position === null ? null : JSON.stringify(position);
}

/**
 * Record that a snapshot page has been applied.
 *
 * Called INSIDE the transaction that applied the page, so the position and the
 * rows it describes commit together. A position written in its own transaction
 * would, on a crash between the two, either re-apply a page (harmless, the ledger
 * absorbs it) or skip one (silent divergence) depending on the order — and one of
 * those is unrecoverable, so neither is left to chance.
 */
export function recordSnapshotPage(db: DatabaseSync, position: BootstrapPosition): void {
  db.prepare("UPDATE sync_state SET bootstrap_cursor = ? WHERE id = 1").run(
    encodeBootstrap(position),
  );
}

/**
 * The snapshot half is complete: the tail becomes the ordinary pull cursor.
 *
 * One statement, so a device is never simultaneously "still bootstrapping" and
 * "has an incremental cursor". After this the resume decision is the plain one.
 */
export function completeSnapshot(db: DatabaseSync, tail: string, epoch: number): void {
  db.prepare(
    "UPDATE sync_state SET cursor = ?, epoch = ?, bootstrap_cursor = NULL WHERE id = 1",
  ).run(tail, epoch);
}

/** Advance the incremental cursor. Inside the transaction that applied the page. */
export function advanceCursor(
  db: DatabaseSync,
  cursor: string,
  headSeq: number,
  epoch: number,
): void {
  db.prepare(
    `UPDATE sync_state
        SET cursor = ?, head_seq = MAX(head_seq, ?), epoch = ?
      WHERE id = 1`,
  ).run(cursor, headSeq, epoch);
}

/**
 * Record the server's watermark without moving the cursor.
 *
 * `MAX` rather than assignment: *"The high-water mark only ever increases and is
 * never recomputed."* A push response and a pull response can report different
 * watermarks depending on what landed in between, and the smaller one arriving
 * second must not rewind what this device knows.
 */
export function recordHeadSeq(db: DatabaseSync, headSeq: number, epoch: number): void {
  db.prepare("UPDATE sync_state SET head_seq = MAX(head_seq, ?), epoch = ? WHERE id = 1").run(
    headSeq,
    epoch,
  );
}

export function recordSyncedAt(db: DatabaseSync, at: string = nowIso()): void {
  db.prepare("UPDATE sync_state SET last_sync_at = ? WHERE id = 1").run(at);
}

/**
 * Begin a bootstrap: forget where the incremental pull was.
 *
 * Only reached on `epoch_changed`, or on a workspace that has never synchronized.
 * The outbox is untouched — *"Its pending local work survives; the outbox is
 * never compacted"* — and so is `client_seq_high_water`, which is what stops the
 * re-bootstrap from re-minting operation ids the server already holds.
 *
 * `sync_applied` is cleared because it is a ledger of operation ids from the
 * epoch being left behind, and after an epoch bump those ids can legitimately be
 * re-issued. Keeping them would make a genuinely new operation look already
 * applied. The entity versions and the tombstones stay: a deletion that happened
 * here still happened here, and rewinding versions would make the next local
 * operation claim a `baseVersion` it has already used.
 *
 * ## `sync_field_writes` is cleared for the same reason, and it has to be
 *
 * Every row there is a claim expressed in TWO currencies of the epoch being left
 * behind — a `base_version` on that epoch's counter, and an `op_id` minted in it.
 * A restore makes both worthless, and keeping them is not conservative, it is
 * wrong: measured on a real restore, a re-bootstrapped device held rows at
 * `base_version 2` naming an epoch-1 operation, and used them to contest an
 * ordinary post-restore edit from a device that had hydrated fresh. The fresh
 * device recorded no conflict at all, so the fleet was split over an argument one
 * side was not having, attributed to an operation from a timeline nobody was on.
 *
 * That is exactly the argument three lines above for clearing `sync_applied`, and
 * the reason the versions are KEPT does not reach here: versions are kept because
 * of what this device will go on to EMIT, and a field write is never emitted. It
 * is only ever read, to answer "have I written this field since version X" — and
 * a stale answer to that question is worse than no answer.
 *
 * Not an `epoch` column, which is the other way to fix it. That is a migration for
 * state that is worthless the instant the epoch moves, no reader would ever ask
 * for the old epoch's rows, and it would let a table whose whole design property
 * is *bounded by live entities* start growing with epochs instead.
 *
 * What clearing would lose on its own is provenance for work this device has NOT
 * pushed — the one thing a re-bootstrap explicitly preserves. {@link
 * replayOutboxFieldWrites} puts exactly that back, and nothing else, once the
 * snapshot half has finished.
 */
export function beginBootstrap(db: DatabaseSync, epoch: number): void {
  tx(db, () => {
    db.prepare("DELETE FROM sync_applied").run();
    db.prepare("DELETE FROM sync_field_writes").run();
    db.prepare(
      "UPDATE sync_state SET cursor = NULL, bootstrap_cursor = NULL, epoch = ? WHERE id = 1",
    ).run(epoch);
    // A tail read part-way belongs to the epoch being left.
    clearTailSurvey(db);
    // And the epoch moved because a restore rewound the repository: the bootstrap rewinds
    // this device with it once the new epoch's snapshot is in hand (`rewind.ts`).
    writeRewind(db, { epoch, vocabulary: {} });
  });
}

// ------------------------------------------------------------ the rewind

const REWIND_KEY = "sync_rewind";

/** A vocabulary as a rewinding read found it: each entry's create seq, and its order. */
export interface RewindVocabulary {
  readonly seqs: Readonly<Record<string, number>>;
  readonly order: readonly string[] | null;
}

/**
 * A rewind owed by the bootstrap under way (`rewind.ts`), and what its read has noted so far.
 * In `meta`, which never synchronizes, so a bootstrap stopped part-way still owes it.
 */
export interface OwedRewind {
  readonly epoch: number;
  readonly vocabulary: Partial<Record<"status" | "kind", RewindVocabulary>>;
}

export function readRewind(db: DatabaseSync): OwedRewind | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(REWIND_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const owed = JSON.parse(row.value) as OwedRewind;
    return typeof owed.epoch === "number" && owed.vocabulary !== null && typeof owed.vocabulary === "object" ? owed : null;
  } catch {
    return null;
  }
}

function writeRewind(db: DatabaseSync, owed: OwedRewind): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    REWIND_KEY,
    JSON.stringify(owed),
  );
}

export function clearRewind(db: DatabaseSync): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(REWIND_KEY);
}

/**
 * A status or kind a rewinding read applied: its create's seq, or the order as applied — what
 * a device hydrating the new epoch orders its vocabulary by (`freshOrder`, `rewind.ts`).
 */
export function noteRewindVocabulary(
  db: DatabaseSync,
  entity: "status" | "kind",
  entityId: string,
  createdSeq: number | null | undefined,
  order: unknown,
): void {
  const owed = readRewind(db);
  if (owed === null) return;
  const held = owed.vocabulary[entity] ?? { seqs: {}, order: null };
  const next: RewindVocabulary =
    entityId === "@order"
      ? { seqs: held.seqs, order: Array.isArray(order) ? order.filter((id): id is string => typeof id === "string") : null }
      : typeof createdSeq === "number"
        ? { seqs: { ...held.seqs, [entityId]: createdSeq }, order: held.order }
        : held;
  writeRewind(db, { ...owed, vocabulary: { ...owed.vocabulary, [entity]: next } });
}

// ------------------------------------------------------------ the tail survey

const TAIL_SURVEY_KEY = "sync_tail_survey";

/**
 * How far this device has read the ordered tail to fold it itself (`tail-fold.ts`), when a
 * read was stopped part-way: the repository and epoch it is of, the cursor to go on from,
 * and what the pages so far folded to.
 *
 * A log too large for the service to fold is read whole, page by page, and on a large one
 * that takes longer than an automatic sync's budget and more requests than the service's
 * rate limit allows a minute. Kept, a stopped read is resumed by the next sync from the page
 * it stopped at; before, every run started again from the first page and none finished.
 *
 * In `meta`, which never synchronizes, rather than in a table: a table would be a migration,
 * and a migration moves the schema every operation carries. Valid for as long as its epoch
 * is — the log only grows within one — and dropped when the epoch moves
 * ({@link beginBootstrap}) or the read it describes is applied.
 */
export interface TailSurveyProgress {
  readonly repositoryId: string;
  readonly epoch: number;
  readonly cursor: string | null;
  readonly pages: number;
  readonly operations: number;
  readonly cutoffSeq: number;
  readonly folded: readonly unknown[];
}

export function readTailSurvey(db: DatabaseSync, repositoryId: string): TailSurveyProgress | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(TAIL_SURVEY_KEY) as { value: string } | undefined;
  if (!row) return null;
  try {
    const saved = JSON.parse(row.value) as TailSurveyProgress;
    if (saved.repositoryId !== repositoryId || !Array.isArray(saved.folded) || typeof saved.epoch !== "number") return null;
    return saved;
  } catch {
    return null;
  }
}

export function writeTailSurvey(db: DatabaseSync, progress: TailSurveyProgress): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(TAIL_SURVEY_KEY, JSON.stringify(progress));
}

export function clearTailSurvey(db: DatabaseSync): void {
  db.prepare("DELETE FROM meta WHERE key = ?").run(TAIL_SURVEY_KEY);
}

/**
 * Where this device's reading of the log stands, as one comparable value: its cursor, its
 * bootstrap position and how much of the tail it has folded. A run of automatic sync that
 * moved it made progress, whether or not it finished (`auto-sync.ts`).
 */
export function syncProgressMark(db: DatabaseSync): string {
  try {
    const state = db.prepare("SELECT cursor, bootstrap_cursor FROM sync_state WHERE id = 1").get() as
      | { cursor: string | null; bootstrap_cursor: string | null }
      | undefined;
    const survey = db.prepare("SELECT json_extract(value, '$.operations') AS operations FROM meta WHERE key = ?").get(TAIL_SURVEY_KEY) as
      | { operations: number | null }
      | undefined;
    return JSON.stringify([state?.cursor ?? null, state?.bootstrap_cursor ?? null, survey?.operations ?? null]);
  } catch {
    return "";
  }
}

/**
 * Mark one pushed operation accepted.
 *
 * `seq` is the server's, and for a `duplicate` it is the seq of the ORIGINAL
 * application rather than a new one — which is the entire reason the push
 * response distinguishes the two. A client that lost an acknowledgement
 * reconciles from exactly this call and re-derives nothing.
 */
export function acknowledgeOperation(db: DatabaseSync, opId: string, seq: number): void {
  db.prepare("UPDATE sync_outbox SET acknowledged_seq = ? WHERE op_id = ?").run(seq, opId);
}

/** How many operations are waiting to be pushed. Read by `status` and `sync`. */
export function pendingCount(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL")
    .get() as { n: number };
  return row.n;
}
