/**
 * Device lifecycle: connect, list, revoke.
 */

import { type Session, bytes, mintToken, sha256 } from "./auth.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { readJson } from "./http.js";
import { capabilities } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

/**
 * POST /v1/repos/{repoId}/connect — bind a device and mint a repository-scoped
 * credential.
 *
 * The bearer presented here is an ENROLLMENT credential, and it may be either:
 *
 *   - an existing non-revoked device token for this repository, which is how a second
 *     machine is added by a first; or
 *   - the repository's enrollment secret, which is how the first machine is added.
 *
 * Both are looked up by digest, like every other credential in this service.
 *
 * A repository whose id the server does not know fails closed with `forbidden`. It
 * NEVER auto-creates a repository to make the error go away — an unknown id is far
 * more likely to be a copied manifest than a new repository, and auto-creating would
 * turn that into a silently forked workspace.
 *
 * NOTE FOR THE CLIENT LANE: provisioning a repository and its first enrollment secret
 * is an out-of-band operation; see worker/README.md. docs/sync.md does not define a
 * provisioning route or an account model, so this Worker does not invent one.
 */
export async function connect(
  request: Request,
  env: Env,
  repoId: string,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  const header = request.headers.get("Authorization");
  const raw = header ? /^Bearer[ ]+(.+)$/i.exec(header.trim())?.[1] : undefined;
  if (!raw) {
    throw new SyncError("auth", "missing enrollment credential", {}, { "www-authenticate": "Bearer" });
  }

  const digest = await sha256(raw);
  const repo = await env.DB.prepare(
    `SELECT repo_id, epoch, enroll_sha256 FROM repos WHERE repo_id = ?1`,
  )
    .bind(repoId)
    .first<{ repo_id: string; epoch: number; enroll_sha256: ArrayBuffer | null }>();

  if (!repo) {
    // Deliberately `forbidden`, not `not_found`: whether a given repository id is
    // registered on this server is not something an unauthenticated caller should be
    // able to enumerate.
    throw new SyncError("forbidden", "not a member of this repository");
  }

  const enrolledByExistingDevice = await env.DB.prepare(
    `SELECT device_id FROM devices
      WHERE repo_id = ?1 AND token_sha256 = ?2 AND revoked_at IS NULL`,
  )
    .bind(repoId, bytes(digest))
    .first<{ device_id: string }>();

  const enrolledBySecret =
    repo.enroll_sha256 !== null && equalBytes(repo.enroll_sha256, digest);

  if (!enrolledByExistingDevice && !enrolledBySecret) {
    throw new SyncError("forbidden", "not a member of this repository");
  }

  const body = await readJson(request);
  const deviceId = requireString(body.deviceId, "deviceId");
  const label = body.label === undefined || body.label === null ? null : requireString(body.label, "label");

  // The plaintext exists in exactly this scope and is returned exactly once. Only its
  // digest reaches the database, and it is never logged — see the `token_fp` below,
  // which is derived from the digest and not from the secret.
  const token = mintToken();
  const tokenDigest = await sha256(token);
  const now = Date.now();

  await env.DB.prepare(
    `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at, last_seen_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)
     ON CONFLICT (repo_id, device_id)
     DO UPDATE SET token_sha256 = excluded.token_sha256,
                   label        = excluded.label,
                   last_seen_at = excluded.last_seen_at,
                   -- Re-connecting un-revokes, because re-connect is exactly the
                   -- remedy the revoked error tells the device to perform. It is
                   -- gated on presenting a valid enrollment credential, so this is
                   -- not a way around a revocation.
                   revoked_at   = NULL`,
  )
    .bind(repoId, deviceId, bytes(tokenDigest), label, now)
    .run();

  log({
    event: "connect",
    status: 200,
    repo_id: repoId,
    device_id: deviceId,
    token_fp: tokenFingerprint(tokenDigest),
    protocol,
    epoch: repo.epoch,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    protocol,
    repoId,
    deviceId,
    epoch: repo.epoch,
    token,
    capabilities: capabilities(env),
  });
}

/** GET /v1/repos/{repoId}/devices */
export async function listDevices(env: Env, session: Session, protocol: number): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT device_id, label, created_at, last_seen_at, revoked_at
       FROM devices WHERE repo_id = ?1 ORDER BY created_at`,
  )
    .bind(session.repoId)
    .all<{
      device_id: string;
      label: string | null;
      created_at: number;
      last_seen_at: number | null;
      revoked_at: number | null;
    }>();

  // `token_sha256` is not in the projection and must never be. It is not a usable
  // credential, but it is a verifier for an offline guess, and the device list is the
  // one response a compromised-but-not-yet-revoked device can always read.
  return json({
    protocol,
    devices: rows.results.map((row) => ({
      deviceId: row.device_id,
      label: row.label,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      revokedAt: row.revoked_at,
      self: row.device_id === session.deviceId,
    })),
  });
}

/**
 * DELETE /v1/repos/{repoId}/devices/{deviceId} — revoke.
 *
 * The row is retained with `revoked_at` set rather than deleted, so that the revoked
 * device gets `revoked` ("re-connect required") on its very next request instead of a
 * bare `auth`, which is indistinguishable from a typo. Membership is checked on every
 * request, so this takes effect immediately — D1 is strongly consistent, which is one
 * of the reasons credentials live here and not in an eventually-consistent KV.
 */
export async function revokeDevice(
  env: Env,
  session: Session,
  protocol: number,
  targetDeviceId: string,
): Promise<Response> {
  const result = await env.DB.prepare(
    `UPDATE devices SET revoked_at = ?3
      WHERE repo_id = ?1 AND device_id = ?2 AND revoked_at IS NULL`,
  )
    .bind(session.repoId, targetDeviceId, Date.now())
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const exists = await env.DB.prepare(
      `SELECT device_id FROM devices WHERE repo_id = ?1 AND device_id = ?2`,
    )
      .bind(session.repoId, targetDeviceId)
      .first<{ device_id: string }>();
    if (!exists) throw new SyncError("not_found", "no such device in this repository");
    // Already revoked. Idempotent, and reported as such rather than as an error.
  }

  log({
    event: "device.revoke",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });

  return json({ protocol, deviceId: targetDeviceId, revoked: true });
}

/**
 * Constant-shape comparison of two digests.
 *
 * This is comparing two HASHES, not two secrets — the enrollment secret's plaintext is
 * never in this process — so the timing argument is weak. It is written this way
 * anyway because `crypto.subtle.timingSafeEqual` is right there and the alternative
 * teaches the wrong habit to whoever edits this next.
 */
function equalBytes(stored: ArrayBuffer, presented: ArrayBuffer): boolean {
  const a = new Uint8Array(stored);
  const b = new Uint8Array(presented);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new SyncError("validation", `${field} must be a non-empty string`);
  }
  return value;
}
