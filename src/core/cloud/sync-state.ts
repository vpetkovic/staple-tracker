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

/** Where a bootstrap got to. Both fields are opaque server strings. */
export interface BootstrapPosition {
  /** The next snapshot page, or null when every page has been applied. */
  readonly snapshot: string | null;
  /** The pull cursor for the tail this snapshot pinned. */
  readonly tail: string;
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
  return { snapshot: snapshot ?? null, tail: record.tail };
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
 */
export function beginBootstrap(db: DatabaseSync, epoch: number): void {
  tx(db, () => {
    db.prepare("DELETE FROM sync_applied").run();
    db.prepare(
      "UPDATE sync_state SET cursor = NULL, bootstrap_cursor = NULL, epoch = ? WHERE id = 1",
    ).run(epoch);
  });
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
