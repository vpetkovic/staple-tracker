/**
 * The local mirror of `sync_leases`. **No network, no clock authority.**
 *
 * Contract: `docs/sync.md`, "Claims: a local checkout is not a global lease".
 *
 * ## What this table is, and what it is emphatically not
 *
 * It is a record of what the server last said. It is not a source of truth about
 * whether this device may act. Nothing in this module — and nothing that reads
 * it — compares `serverExpiresAt` against the local clock to decide something;
 * that comparison is only ever *rendered*, never *obeyed*. The contract is
 * explicit that client timestamps are metadata, and the way that stays true in
 * practice is that the only code allowed to expire a lease is a predicate in the
 * Worker's SQL.
 *
 * A caller who wants to know whether the lease is still theirs asks the server,
 * by presenting the fencing token. That is the whole point of the token.
 *
 * ## Why the mirror is fenced too
 *
 * {@link recordLocalLease} refuses to move a row backwards. Operations arrive in
 * sequence order today, so an older token cannot normally overtake a newer one —
 * but a snapshot bootstrap folds state rather than replaying it, and a retried
 * page replays. The guard costs one comparison and removes the one path by which
 * a superseded token could be reinstated locally and then presented to a server
 * that would rightly refuse it.
 *
 * ## Why no `issues` columns were added
 *
 * *"the token and the server expiry live in the sync tables, not in new `issues`
 * columns"* — so `ls`, `show` and `inbox` keep rendering exactly the fields they
 * already render, and a build with no leases in it is byte-identical on those
 * surfaces to a build with them.
 */
import type { DatabaseSync } from "node:sqlite";

/** How exclusive a claim actually is. Never inferred; always stated. */
export type ClaimScope = "local" | "lease";

/**
 * One row of `sync_leases`.
 *
 * `serverExpiresAt`, `acquiredAt` and `renewedAt` are ISO renderings of absolute
 * times the SERVER computed. They are stored so a human can be shown them and so
 * another device can be told them. They are not inputs to any decision.
 */
export interface LocalLease {
  readonly entityId: string;
  readonly fencingToken: number;
  readonly holder: string;
  readonly deviceId: string | null;
  readonly serverExpiresAt: string;
  readonly acquiredAt: string;
  readonly renewedAt: string | null;
}

interface LeaseRow {
  entity_id: string;
  fencing_token: number;
  holder: string;
  device_id: string | null;
  server_expires_at: string;
  acquired_at: string;
  renewed_at: string | null;
}

function toLease(row: LeaseRow): LocalLease {
  return {
    entityId: row.entity_id,
    fencingToken: row.fencing_token,
    holder: row.holder,
    deviceId: row.device_id,
    serverExpiresAt: row.server_expires_at,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
  };
}

/**
 * Render a server-supplied epoch-milliseconds value as ISO-8601.
 *
 * The conversion is a rendering and nothing more: the number came from the
 * server, and the string is the same instant written differently. This function
 * never consults the local clock, which is what makes it safe to call on a
 * machine whose clock is wrong.
 */
export function serverInstant(ms: number): string {
  return new Date(ms).toISOString();
}

export function readLocalLease(db: DatabaseSync, entityId: string): LocalLease | null {
  const row = db
    .prepare(
      `SELECT entity_id, fencing_token, holder, device_id, server_expires_at, acquired_at, renewed_at
         FROM sync_leases WHERE entity_id = ?`,
    )
    .get(entityId) as LeaseRow | undefined;
  return row ? toLease(row) : null;
}

/** Every lease this device has been told about, oldest acquisition first. */
export function listLocalLeases(db: DatabaseSync): LocalLease[] {
  const rows = db
    .prepare(
      `SELECT entity_id, fencing_token, holder, device_id, server_expires_at, acquired_at, renewed_at
         FROM sync_leases ORDER BY acquired_at, entity_id`,
    )
    .all() as unknown as LeaseRow[];
  return rows.map(toLease);
}

/**
 * Record what the server said, unless this device already knows something newer.
 *
 * Returns false when the write was refused as stale. Refused is not an error: a
 * replayed page carrying an older token is ordinary traffic, and the correct
 * response to it is to keep the newer row and carry on.
 */
export function recordLocalLease(db: DatabaseSync, lease: LocalLease): boolean {
  const existing = readLocalLease(db, lease.entityId);
  if (existing && existing.fencingToken > lease.fencingToken) return false;

  db.prepare(
    `INSERT INTO sync_leases
       (entity_id, fencing_token, holder, device_id, server_expires_at, acquired_at, renewed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_id) DO UPDATE SET
       fencing_token     = excluded.fencing_token,
       holder            = excluded.holder,
       device_id         = excluded.device_id,
       server_expires_at = excluded.server_expires_at,
       acquired_at       = excluded.acquired_at,
       renewed_at        = excluded.renewed_at`,
  ).run(
    lease.entityId,
    lease.fencingToken,
    lease.holder,
    lease.deviceId,
    lease.serverExpiresAt,
    lease.acquiredAt,
    lease.renewedAt,
  );
  return true;
}

/**
 * Forget the mirror row.
 *
 * Called when the server has told us, in so many words, that we do not hold this
 * lease — a released lease, or a `conflict` on renew or release. Keeping a row
 * the server has disowned is how a device ends up presenting a token it was
 * already refused once, and how a human ends up reading "held by you" off a
 * screen that is wrong.
 */
export function forgetLocalLease(db: DatabaseSync, entityId: string): boolean {
  const result = db.prepare("DELETE FROM sync_leases WHERE entity_id = ?").run(entityId);
  return Number(result.changes ?? 0) > 0;
}

/**
 * The scope of the claim on this entity, as this device is entitled to describe
 * it.
 *
 * `lease` requires BOTH a connection on this machine and a mirror row this
 * device is the holder of. Either alone is not global exclusivity: a connection
 * without a lease is a repository that could be exclusive and is not, and a
 * mirror row on a disconnected machine is a memory of one, which is worth less
 * than nothing if it is allowed to read as a fact.
 *
 * *"An agent that reads `local` and behaves as though it read `lease` is the
 * failure this field exists to prevent."* So the default is `local`, and the
 * upgrade to `lease` is something a caller has to earn.
 */
export function claimScopeOf(
  db: DatabaseSync,
  connectedDeviceId: string | null,
  entityId: string,
): ClaimScope {
  if (connectedDeviceId === null) return "local";
  const lease = readLocalLease(db, entityId);
  if (!lease) return "local";
  return lease.deviceId === connectedDeviceId ? "lease" : "local";
}

/** The sentence a surface prints for a `local` claim. Worded once, here. */
export const LOCAL_SCOPE_NOTE =
  "Claimed in this database only. No global exclusivity is claimed, and another " +
  "machine may be holding the same work.";

/** The sentence a surface prints for a `lease` claim. */
export function leaseScopeNote(lease: LocalLease): string {
  return (
    `Held under server lease ${lease.fencingToken}, which the service says expires at ` +
    `${lease.serverExpiresAt}. The service decides that, not this machine.`
  );
}
