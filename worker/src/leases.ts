/**
 * Leases — the second and last thing the server is trusted for.
 *
 * A local checkout is not a global lease. Offline, a claim is `scope: "local"` and
 * says nothing about the other machine. Connected, exclusivity comes from here: one
 * winner, a monotonically increasing fencing token, and a server-authoritative expiry.
 *
 * Client clocks have no authority over expiry. Every `expires_at` in this file is
 * computed from `Date.now()` on the server, and a TTL is the only thing a client gets
 * to ask for — bounded, and never trusted as an absolute time.
 *
 * There is no sweeper and no automatic takeover. Expired rows are cleared lazily by
 * the acquire that needs the slot, which keeps the "no background reaper" property the
 * continuity model promises while still letting a genuinely stale lease be taken.
 */

import type { Session } from "./auth.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { readJson } from "./http.js";
import { DEFAULT_LEASE_TTL_SECONDS, MAX_LEASE_TTL_SECONDS } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

interface LeaseRow {
  entity_id: string;
  fencing_token: number;
  holder: string;
  device_id: string;
  acquired_at: number;
  renewed_at: number;
  expires_at: number;
}

/** POST /v1/repos/{repoId}/leases */
export async function acquireLease(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const body = await readJson(request);
  const entityId = requireString(body.entityId, "entityId");
  const holder = requireString(body.holder, "holder");
  const ttl = parseTtl(body.ttlSeconds);

  const now = Date.now();
  const expiresAt = now + ttl * 1000;

  const batch = await env.DB.batch([
    // [0] Allocate the next fencing token. Monotonic per repository and never reused,
    //     including across an epoch bump — which is exactly why the counter lives on
    //     the repo row and not on the lease. It increments even when the acquire below
    //     loses the race; gaps in fencing tokens are as legal as gaps in `seq`.
    env.DB.prepare(
      `UPDATE repos SET last_fencing_token = last_fencing_token + 1 WHERE repo_id = ?1`,
    ).bind(session.repoId),

    // [1] Clear this entity's own lease if it has expired. Bounded to one row, by the
    //     primary key — not a scan, and not a sweep of anybody else's leases.
    env.DB.prepare(
      `DELETE FROM leases WHERE repo_id = ?1 AND entity_id = ?2 AND expires_at <= ?3`,
    ).bind(session.repoId, entityId, now),

    // [2] Take the slot if it is free. `NOT EXISTS` rather than an upsert: an upsert
    //     would silently steal a live lease, and takeover is explicit in this system.
    env.DB.prepare(
      `INSERT INTO leases (repo_id, entity_id, fencing_token, holder, device_id,
                           acquired_at, renewed_at, expires_at)
       SELECT ?1, ?2, r.last_fencing_token, ?3, ?4, ?5, ?5, ?6
         FROM repos r
        WHERE r.repo_id = ?1
          AND NOT EXISTS (SELECT 1 FROM leases l
                           WHERE l.repo_id = ?1 AND l.entity_id = ?2)`,
    ).bind(session.repoId, entityId, holder, session.deviceId, now, expiresAt),
  ]);

  const acquired = (batch[2]?.meta.changes ?? 0) > 0;
  const lease = await readLease(env, session.repoId, entityId);

  if (!acquired) {
    // Two devices raced and this one lost. Not retryable: retrying would be a spin
    // against a lease that is, as far as this device knows, legitimately held.
    log({
      event: "lease.acquire",
      status: 409,
      repo_id: session.repoId,
      device_id: session.deviceId,
      token_fp: tokenFingerprint(session.digest),
      code: "conflict",
      duration_ms: Date.now() - startedAt,
    });
    throw new SyncError("conflict", "lease is held by another device", {
      entityId,
      ...(lease ? { holder: lease.holder, expiresAt: lease.expires_at } : {}),
    });
  }

  log({
    event: "lease.acquire",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    duration_ms: Date.now() - startedAt,
  });

  return json({ protocol, lease: toWire(lease!) });
}

/** POST /v1/repos/{repoId}/leases/{entityId}/renew */
export async function renewLease(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  entityId: string,
): Promise<Response> {
  const body = await readJson(request);
  const fencingToken = requireInt(body.fencingToken, "fencingToken");
  const ttl = parseTtl(body.ttlSeconds);

  const now = Date.now();
  const result = await env.DB.prepare(
    `UPDATE leases
        SET renewed_at = ?4, expires_at = ?5
      WHERE repo_id = ?1 AND entity_id = ?2
        AND fencing_token = ?3
        AND device_id = ?6
        AND expires_at > ?4`,
  )
    .bind(session.repoId, entityId, fencingToken, now, now + ttl * 1000, session.deviceId)
    .run();

  // One predicate covers every way a renewal can be illegitimate: wrong token (stolen
  // or superseded), wrong device (someone else's lease), or already expired. A holder
  // that was expired, stolen or revoked is rejected — a stale token can never write,
  // however convinced its holder is.
  if ((result.meta.changes ?? 0) === 0) {
    const lease = await readLease(env, session.repoId, entityId);
    throw new SyncError("conflict", "lease is not held with that fencing token", {
      entityId,
      ...(lease ? { currentFencingToken: lease.fencing_token } : {}),
    });
  }

  const lease = await readLease(env, session.repoId, entityId);
  return json({ protocol, lease: toWire(lease!) });
}

/** DELETE /v1/repos/{repoId}/leases/{entityId} — release, presenting the token. */
export async function releaseLease(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  entityId: string,
): Promise<Response> {
  const body = await readJson(request);
  const fencingToken = requireInt(body.fencingToken, "fencingToken");

  const result = await env.DB.prepare(
    `DELETE FROM leases
      WHERE repo_id = ?1 AND entity_id = ?2 AND fencing_token = ?3 AND device_id = ?4`,
  )
    .bind(session.repoId, entityId, fencingToken, session.deviceId)
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    throw new SyncError("conflict", "lease is not held with that fencing token", { entityId });
  }
  return json({ protocol, released: true, entityId });
}

async function readLease(env: Env, repoId: string, entityId: string): Promise<LeaseRow | null> {
  return env.DB.prepare(
    `SELECT entity_id, fencing_token, holder, device_id, acquired_at, renewed_at, expires_at
       FROM leases WHERE repo_id = ?1 AND entity_id = ?2`,
  )
    .bind(repoId, entityId)
    .first<LeaseRow>();
}

function toWire(row: LeaseRow): Record<string, unknown> {
  return {
    entityId: row.entity_id,
    fencingToken: row.fencing_token,
    holder: row.holder,
    deviceId: row.device_id,
    acquiredAt: row.acquired_at,
    renewedAt: row.renewed_at,
    // Absolute server time. The client stores it and displays it; it does not get to
    // decide from it, because deciding from it is what a client clock cannot be
    // trusted to do.
    expiresAt: row.expires_at,
  };
}

function parseTtl(raw: unknown): number {
  if (raw === undefined || raw === null) return DEFAULT_LEASE_TTL_SECONDS;
  const ttl = requireInt(raw, "ttlSeconds");
  if (ttl < 1 || ttl > MAX_LEASE_TTL_SECONDS) {
    throw new SyncError("validation", "ttlSeconds is outside the permitted range", {
      maxTtlSeconds: MAX_LEASE_TTL_SECONDS,
    });
  }
  return ttl;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncError("validation", `${field} must be a non-empty string`);
  }
  return value;
}

function requireInt(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new SyncError("validation", `${field} must be an integer`);
  }
  return value;
}
