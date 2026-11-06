/**
 * Device lifecycle: connect, list, revoke.
 */

import { type Session, bytes, mintToken, sha256 } from "./auth.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { readJson } from "./http.js";
import { capabilities } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";
import { assertMayRevoke, nameKey } from "./members.js";

/** The name the first member of a repository gets. The owner renames it. */
const FIRST_MEMBER_NAME = "owner";

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
 * is an out-of-band operation; see worker/README.md. design/sync.md does not define a
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
    `SELECT repo_id, epoch, enroll_sha256, vocabulary,
            EXISTS (SELECT 1 FROM members m WHERE m.repo_id = repos.repo_id) AS has_members
       FROM repos WHERE repo_id = ?1`,
  )
    .bind(repoId)
    .first<{
      repo_id: string;
      epoch: number;
      enroll_sha256: ArrayBuffer | null;
      vocabulary: string | null;
      has_members: number;
    }>();

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

  /**
   * Members. A hub registry has none, and everything below is skipped for it.
   *
   * A repository that has members admits devices only through an approved join request,
   * so both enrollment paths above are refused for it — the shared secret and a working
   * device token alike. The refusal comes AFTER the credential check, so only a caller
   * that holds a valid credential learns that the repository uses member approval.
   *
   * A repository with no members yet accepts this connect, and it creates the owner.
   */
  const membersApply = repo.vocabulary !== "hub";
  if (membersApply && repo.has_members === 1) {
    throw new SyncError(
      "forbidden",
      "this workspace uses member approval; run `staple cloud join`",
    );
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

  const upsertDevice = env.DB.prepare(
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
    .bind(repoId, deviceId, bytes(tokenDigest), label, now);

  if (!membersApply) {
    await upsertDevice.run();
  } else {
    /**
     * The first accepted connect of a repository with no members creates its owner, in the
     * same batch as the device, and adopts every device that has no member yet: until now
     * everyone here held the one enrollment secret, so they were one party, exactly as the
     * 0008 backfill reads it.
     *
     * The refusal above read `has_members` before this write, so it is not enough on its
     * own: a connect that read "no members" and then stalled while another first connect
     * created the owner would still write here, and for the same device id it would replace
     * the owner device's token. So the device write is conditioned on there being no member
     * IN THE SAME STATEMENT, and a write that matched nothing is the same refusal. Two first
     * connects racing end with one owner, the first one's device, and the other refused.
     */
    const [device] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at, last_seen_at, revoked_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?5, NULL
          WHERE NOT EXISTS (SELECT 1 FROM members WHERE repo_id = ?1)
         ON CONFLICT (repo_id, device_id)
         DO UPDATE SET token_sha256 = excluded.token_sha256,
                       label        = excluded.label,
                       last_seen_at = excluded.last_seen_at,
                       revoked_at   = NULL`,
      ).bind(repoId, deviceId, bytes(tokenDigest), label, now),
      env.DB.prepare(
        `INSERT INTO members (repo_id, member_id, name, name_key, is_owner, created_at, removed_at)
         SELECT ?1, ?2, ?3, ?5, 1, ?4, NULL
          WHERE NOT EXISTS (SELECT 1 FROM members WHERE repo_id = ?1)`,
      ).bind(repoId, crypto.randomUUID(), FIRST_MEMBER_NAME, now, nameKey(FIRST_MEMBER_NAME)),
      env.DB.prepare(
        `UPDATE devices
            SET member_id = (SELECT member_id FROM members WHERE repo_id = ?1 AND is_owner = 1)
          WHERE repo_id = ?1 AND member_id IS NULL`,
      ).bind(repoId),
    ]);
    if ((device?.meta.changes ?? 0) === 0) {
      // Members appeared after the read above: nothing was written, and the minted token
      // is dropped without ever having been stored.
      throw new SyncError("forbidden", "this workspace uses member approval; run `staple cloud join`");
    }
  }

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
  // In a repository with members: the owner any device, a member only their own.
  await assertMayRevoke(env, session, targetDeviceId);

  // The owner's last active device is never revoked, whoever asks. Only the owner can
  // approve a device for the owner, so revoking that one would leave nobody able to act
  // as owner again. The guard is in the statement rather than read before it, so two
  // revokes racing for the owner's last two devices cannot both pass. A hub has no
  // members, so for a hub the guard is vacuously true and the statement is as before.
  const result = await env.DB.prepare(
    `UPDATE devices SET revoked_at = ?3
      WHERE repo_id = ?1 AND device_id = ?2 AND revoked_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM members m
           WHERE m.repo_id = ?1 AND m.member_id = devices.member_id AND m.is_owner = 1
             -- A hub has no owner, whatever an older row says (see push.ts on the hub claim).
             AND (SELECT r.vocabulary FROM repos r WHERE r.repo_id = ?1) IS NOT 'hub'
             AND (SELECT COUNT(*) FROM devices o
                   WHERE o.repo_id = ?1 AND o.member_id = m.member_id AND o.revoked_at IS NULL) <= 1)`,
  )
    .bind(session.repoId, targetDeviceId, Date.now())
    .run();

  if ((result.meta.changes ?? 0) === 0) {
    const exists = await env.DB.prepare(
      `SELECT revoked_at FROM devices WHERE repo_id = ?1 AND device_id = ?2`,
    )
      .bind(session.repoId, targetDeviceId)
      .first<{ revoked_at: number | null }>();
    if (!exists) throw new SyncError("not_found", "no such device in this repository");
    if (exists.revoked_at === null) {
      // Still active, so the guard above is what held it.
      throw new SyncError("conflict", "this is the owner's last device; add another device first");
    }
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
