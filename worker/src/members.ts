/**
 * Members and device-flow pairing.
 *
 * A member is a named person who owns one or more devices. There are no accounts, no
 * roles beyond "owner" and "member", and no OAuth. The owner is the member who connected
 * the repository first. A second person joins by running `staple cloud join`, which
 * creates a join request and shows a short code. A member who is already online compares
 * that code out loud and approves it. The code identifies the request and is NOT a
 * credential.
 *
 * The credential discipline is the one `auth.ts` states, applied to one more secret:
 *
 *   - The joiner generates a 256-bit request secret and keeps it. This Worker stores only
 *     its SHA-256, and finds a request BY that digest when the joiner polls, so no secret
 *     comparison happens here either.
 *   - The device token is minted when the joiner COLLECTS it after approval, inside the
 *     one request that returns it, and only its digest reaches the database. A second
 *     collect gets `collected` and no token.
 *   - `repoId` for every member route comes from the session, never from the path.
 *
 * Members apply only to repositories whose vocabulary is not `hub`. A hub registry has no
 * members, and every hub path behaves exactly as it did before members existed.
 */

import { type Session, bearerToken, bytes, mintToken, sha256 } from "./auth.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { assertJoinRateLimit, readJson } from "./http.js";
import { capabilities } from "./limits.js";
import { log, tokenFingerprint } from "./log.js";

/** How long a join request lives, and how long an approved one stays collectable. */
export const JOIN_REQUEST_TTL_MS = 10 * 60 * 1000;

/** Pending, unexpired requests one repository may hold at once. */
export const MAX_PENDING_JOIN_REQUESTS = 5;

/** Expired requests are deleted this long after they expire, when the next one is made. */
const JOIN_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;

const MAX_NAME_LENGTH = 64;
const MAX_LABEL_LENGTH = 200;
const MAX_DEVICE_ID_LENGTH = 200;

/** Crockford base32: no I, L, O or U, so a code read aloud has one spelling. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;

// ------------------------------------------------------------------ member context

export interface SelfMember {
  memberId: string;
  name: string;
  isOwner: boolean;
}

export interface MemberContext {
  /** True when the repository is not a hub and has at least one member. */
  applies: boolean;
  /** The member the session's device belongs to, or null. Removed members read as null. */
  self: SelfMember | null;
}

/**
 * Whether members apply to the session's repository, and who the session's device is.
 *
 * One query. Read fresh rather than carried on the session, for the same reason the
 * backup routes read the repository row fresh: a power check decides from the value it
 * read in the request that acts on it.
 */
export async function memberContext(env: Env, session: Session): Promise<MemberContext> {
  const row = await env.DB.prepare(
    `SELECT r.vocabulary AS vocabulary,
            EXISTS (SELECT 1 FROM members x WHERE x.repo_id = r.repo_id) AS has_members,
            m.member_id  AS member_id,
            m.name       AS name,
            m.is_owner   AS is_owner,
            m.removed_at AS removed_at
       FROM repos r
       LEFT JOIN devices d ON d.repo_id = r.repo_id AND d.device_id = ?2
       LEFT JOIN members m ON m.repo_id = d.repo_id AND m.member_id = d.member_id
      WHERE r.repo_id = ?1`,
  )
    .bind(session.repoId, session.deviceId)
    .first<{
      vocabulary: string | null;
      has_members: number;
      member_id: string | null;
      name: string | null;
      is_owner: number | null;
      removed_at: number | null;
    }>();

  if (!row) return { applies: false, self: null };
  const applies = row.vocabulary !== "hub" && row.has_members === 1;
  const self =
    applies && row.member_id !== null && row.name !== null && row.removed_at === null
      ? { memberId: row.member_id, name: row.name, isOwner: row.is_owner === 1 }
      : null;
  return { applies, self };
}

/** The member routes need a member. A hub, or a device without one, gets `forbidden`. */
function requireMember(context: MemberContext): SelfMember {
  if (!context.applies || context.self === null) {
    throw new SyncError(
      "forbidden",
      "this device is not a member of a workspace that uses member approval",
      { members: "unavailable" },
    );
  }
  return context.self;
}

/**
 * Restore and purge are the owner's, in a repository with members. Elsewhere — a hub, or
 * a repository that has no members yet — nothing changes.
 *
 * Skipped without a statement for a session whose repository is known to be a hub, so a
 * hub's restore and purge cost exactly what they did before.
 */
export async function assertOwnerForRecovery(env: Env, session: Session, action: string): Promise<void> {
  if (session.vocabulary === "hub") return;
  const context = await memberContext(env, session);
  if (!context.applies) return;
  if (!context.self?.isOwner) {
    throw new SyncError("forbidden", `only the workspace owner can ${action} it`);
  }
}

/**
 * Revoking a device, in a repository with members: the owner may revoke any device, and
 * a member only their own. A target that does not exist falls through to the revoke's
 * own `not_found`.
 */
export async function assertMayRevoke(env: Env, session: Session, targetDeviceId: string): Promise<void> {
  if (session.vocabulary === "hub") return;
  const context = await memberContext(env, session);
  if (!context.applies) return;
  const self = requireMember(context);
  if (self.isOwner) return;

  const target = await env.DB.prepare(
    `SELECT member_id FROM devices WHERE repo_id = ?1 AND device_id = ?2`,
  )
    .bind(session.repoId, targetDeviceId)
    .first<{ member_id: string | null }>();
  if (target && target.member_id !== self.memberId) {
    throw new SyncError("forbidden", "a member can only revoke their own devices");
  }
}

/**
 * The message a removed member's devices get, from `authenticate`.
 *
 * Only owners remove members and ownership does not move in v1, so "removed by" is the
 * owner. Called only on the revoked branch, so the hot path pays nothing for it.
 */
export async function removedMemberRefusal(
  env: Env,
  repoId: string,
  memberId: string,
): Promise<SyncError | null> {
  const row = await env.DB.prepare(
    `SELECT m.removed_at AS removed_at,
            (SELECT o.name FROM members o WHERE o.repo_id = m.repo_id AND o.is_owner = 1) AS owner_name
       FROM members m
      WHERE m.repo_id = ?1 AND m.member_id = ?2`,
  )
    .bind(repoId, memberId)
    .first<{ removed_at: number | null; owner_name: string | null }>();
  if (!row || row.removed_at === null) return null;
  const removedBy = row.owner_name ?? "the owner";
  return new SyncError("revoked", `removed from this workspace by ${removedBy}`, { removedBy });
}

// ------------------------------------------------------------------ pre-credential

/**
 * POST /v1/repos/{repoId}/join-requests — pre-credential, like `/connect`.
 *
 * Rate limited per client IP, because the caller has no device yet to key on. The cap
 * of pending requests is enforced in the INSERT itself, so two requests racing for the
 * last slot cannot both get it.
 *
 * Refused alike for an unknown repository, a hub, and a repository with no members yet,
 * so an unauthenticated caller learns nothing about which of the three it hit. A new
 * repository's first device connects with the enrollment secret instead, and becomes
 * the owner.
 */
export async function createJoinRequest(
  request: Request,
  env: Env,
  repoId: string,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  await assertJoinRateLimit(request, env);

  const body = await readJson(request);
  const deviceId = requireBoundedString(body.deviceId, "deviceId", MAX_DEVICE_ID_LENGTH);
  const label =
    body.label === undefined || body.label === null
      ? null
      : requireBoundedString(body.label, "label", MAX_LABEL_LENGTH);
  const secretDigest = requireSha256Hex(body.requestSecretSha256);

  const repo = await env.DB.prepare(
    `SELECT vocabulary, EXISTS (SELECT 1 FROM members m WHERE m.repo_id = r.repo_id) AS has_members
       FROM repos r WHERE r.repo_id = ?1`,
  )
    .bind(repoId)
    .first<{ vocabulary: string | null; has_members: number }>();
  if (!repo || repo.vocabulary === "hub" || repo.has_members !== 1) {
    throw new SyncError("forbidden", "this repository does not accept join requests");
  }

  const now = Date.now();
  const requestId = crypto.randomUUID();
  const code = mintCode();
  const expiresAt = now + JOIN_REQUEST_TTL_MS;

  const [, inserted] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM join_requests WHERE repo_id = ?1 AND expires_at < ?2`).bind(
      repoId,
      now - JOIN_REQUEST_RETENTION_MS,
    ),
    env.DB.prepare(
      `INSERT INTO join_requests
              (repo_id, request_id, code, request_secret_sha256, device_id, label,
               created_at, expires_at, status, member_id, approved_by_device)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', NULL, NULL
        WHERE (SELECT COUNT(*) FROM join_requests
                WHERE repo_id = ?1 AND status = 'pending' AND expires_at > ?7) < ?9`,
    ).bind(repoId, requestId, code, secretDigest, deviceId, label, now, expiresAt, MAX_PENDING_JOIN_REQUESTS),
  ]);

  if ((inserted?.meta.changes ?? 0) === 0) {
    const oldest = await env.DB.prepare(
      `SELECT MIN(expires_at) AS at FROM join_requests
        WHERE repo_id = ?1 AND status = 'pending' AND expires_at > ?2`,
    )
      .bind(repoId, now)
      .first<{ at: number | null }>();
    const retryAfter = Math.max(1, Math.ceil(((oldest?.at ?? now + 60_000) - now) / 1000));
    throw new SyncError(
      "rate_limited",
      `this workspace already has ${MAX_PENDING_JOIN_REQUESTS} pending join requests. ` +
        "Ask a member to approve or deny one, or wait for one to expire.",
      { pendingCap: MAX_PENDING_JOIN_REQUESTS },
      { "retry-after": String(retryAfter) },
    );
  }

  log({ event: "join.create", status: 200, repo_id: repoId, protocol, duration_ms: Date.now() - startedAt });
  return json({ requestId, code: displayCode(code), expiresAt });
}

/**
 * GET /v1/repos/{repoId}/join-requests/{requestId} — the joiner's poll, and its collect.
 *
 * The bearer is the request secret. The row is found BY its digest together with the
 * request id, so a wrong secret and an unknown request are the same `auth` answer.
 *
 * On the first read after approval this mints the device token, inserts the device with
 * its member, and marks the request `collected`, in one batch. The device upsert runs
 * first and only from an `approved` request, and the status flip runs only when that
 * device row now holds this token's digest. A second collect therefore finds the request
 * `collected`, writes nothing, and returns no token.
 */
export async function collectJoinRequest(
  request: Request,
  env: Env,
  repoId: string,
  requestId: string,
  protocol: number,
  startedAt: number,
): Promise<Response> {
  await assertJoinRateLimit(request, env);

  const raw = bearerToken(request);
  if (!raw) {
    throw new SyncError("auth", "missing request credential", {}, { "www-authenticate": "Bearer" });
  }
  const digest = await sha256(raw);

  const row = await env.DB.prepare(
    `SELECT jr.status     AS status,
            jr.expires_at AS expires_at,
            jr.device_id  AS device_id,
            jr.member_id  AS member_id,
            m.name        AS member_name,
            r.epoch       AS epoch
       FROM join_requests jr
       JOIN repos r ON r.repo_id = jr.repo_id
       LEFT JOIN members m ON m.repo_id = jr.repo_id AND m.member_id = jr.member_id
      WHERE jr.repo_id = ?1 AND jr.request_id = ?2 AND jr.request_secret_sha256 = ?3`,
  )
    .bind(repoId, requestId, bytes(digest))
    .first<{
      status: string;
      expires_at: number;
      device_id: string;
      member_id: string | null;
      member_name: string | null;
      epoch: number;
    }>();
  if (!row) {
    throw new SyncError("auth", "invalid request credential", {}, { "www-authenticate": "Bearer" });
  }

  const now = Date.now();
  const expiresAt = row.expires_at;
  if (row.status === "collected" || row.status === "denied") {
    return json({ status: row.status, expiresAt });
  }
  if (expiresAt <= now) return json({ status: "expired", expiresAt });
  if (row.status !== "approved" || row.member_id === null || row.member_name === null) {
    return json({ status: "pending", expiresAt });
  }

  // The plaintext exists in exactly this scope and is returned exactly once.
  const token = mintToken();
  const tokenDigest = await sha256(token);

  const [, collected] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at, last_seen_at, revoked_at, member_id)
       SELECT jr.repo_id, jr.device_id, ?3, jr.label, ?4, ?4, NULL, jr.member_id
         FROM join_requests jr
         JOIN members m ON m.repo_id = jr.repo_id AND m.member_id = jr.member_id AND m.removed_at IS NULL
        WHERE jr.repo_id = ?1 AND jr.request_id = ?2 AND jr.status = 'approved' AND jr.expires_at > ?4
       ON CONFLICT (repo_id, device_id)
       DO UPDATE SET token_sha256 = excluded.token_sha256,
                     label        = excluded.label,
                     last_seen_at = excluded.last_seen_at,
                     revoked_at   = NULL,
                     member_id    = excluded.member_id
               -- Only a revoked device id is taken over. An active one is somebody's
               -- working credential, and approval was refused for it already; this is
               -- the race-free half of that check.
               WHERE devices.revoked_at IS NOT NULL`,
    ).bind(repoId, requestId, bytes(tokenDigest), now),
    env.DB.prepare(
      `UPDATE join_requests SET status = 'collected'
        WHERE repo_id = ?1 AND request_id = ?2 AND status = 'approved'
          AND EXISTS (SELECT 1 FROM devices
                       WHERE repo_id = ?1 AND device_id = ?3 AND token_sha256 = ?4)`,
    ).bind(repoId, requestId, row.device_id, bytes(tokenDigest)),
  ]);

  if ((collected?.meta.changes ?? 0) !== 1) {
    const after = await env.DB.prepare(
      `SELECT status FROM join_requests WHERE repo_id = ?1 AND request_id = ?2`,
    )
      .bind(repoId, requestId)
      .first<{ status: string }>();
    if (after?.status === "collected") return json({ status: "collected", expiresAt });
    throw new SyncError(
      "conflict",
      "this join request could not be completed: the device is already active in this " +
        "workspace, or the member it was approved for was removed. Ask for a new approval.",
    );
  }

  log({
    event: "join.collect",
    status: 200,
    repo_id: repoId,
    device_id: row.device_id,
    token_fp: tokenFingerprint(tokenDigest),
    protocol,
    epoch: row.epoch,
    duration_ms: Date.now() - startedAt,
  });

  return json({
    status: "approved",
    token,
    deviceId: row.device_id,
    member: { memberId: row.member_id, name: row.member_name },
    // Beyond the contract's four keys, and additive: what `/connect` returns, so the
    // joiner can write its connection record without a second round trip.
    repoId,
    epoch: row.epoch,
    protocol,
    capabilities: capabilities(env),
  });
}

// ------------------------------------------------------------------ member routes

/** GET /v1/repos/{repoId}/join-requests — pending, unexpired requests. */
export async function listJoinRequests(env: Env, session: Session): Promise<Response> {
  requireMember(await memberContext(env, session));
  const rows = await env.DB.prepare(
    `SELECT request_id, code, label, created_at, expires_at FROM join_requests
      WHERE repo_id = ?1 AND status = 'pending' AND expires_at > ?2
      ORDER BY created_at`,
  )
    .bind(session.repoId, Date.now())
    .all<{ request_id: string; code: string; label: string | null; created_at: number; expires_at: number }>();

  // `request_secret_sha256` is not in the projection, and must never be: it is a verifier
  // for the joiner's secret, and every member can read this list.
  return json(
    rows.results.map((r) => ({
      requestId: r.request_id,
      code: displayCode(r.code),
      label: r.label,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    })),
  );
}

/**
 * POST /v1/repos/{repoId}/join-requests/{code}/approve
 *
 * `{newMember: {name}}` admits a new person, and is the owner's alone. `{memberId}` adds
 * a device to an existing member: the owner may name anyone, a member only themselves.
 *
 * The device id the joiner asked for may already exist in this repository. An active one
 * is refused, because approving it would hand somebody's working device id, and with it
 * their history, to the joiner. A revoked one is taken back by the member it belonged to,
 * or by anyone the owner approves it for.
 */
export async function approveJoinRequest(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  rawCode: string,
): Promise<Response> {
  const self = requireMember(await memberContext(env, session));
  const code = normalizeCode(rawCode);
  const body = await readJson(request);

  const hasNew = body.newMember !== undefined && body.newMember !== null;
  const hasExisting = body.memberId !== undefined && body.memberId !== null;
  if (hasNew === hasExisting) {
    throw new SyncError("validation", "approve takes exactly one of `newMember` or `memberId`");
  }

  const pending = await findPending(env, session.repoId, code);

  let memberId: string;
  let name: string;
  let isNew = false;
  if (hasNew) {
    if (!self.isOwner) {
      throw new SyncError("forbidden", "only the workspace owner can admit a new person");
    }
    const newMember = body.newMember;
    if (typeof newMember !== "object" || Array.isArray(newMember)) {
      throw new SyncError("validation", "newMember must be an object with a name");
    }
    name = requireName((newMember as Record<string, unknown>).name);
    await assertNameFree(env, session.repoId, name, null);
    memberId = crypto.randomUUID();
    isNew = true;
  } else {
    memberId = requireBoundedString(body.memberId, "memberId", MAX_DEVICE_ID_LENGTH);
    if (!self.isOwner && memberId !== self.memberId) {
      throw new SyncError("forbidden", "a member can only add a device to themselves");
    }
    const target = await env.DB.prepare(
      `SELECT name, removed_at FROM members WHERE repo_id = ?1 AND member_id = ?2`,
    )
      .bind(session.repoId, memberId)
      .first<{ name: string; removed_at: number | null }>();
    if (!target) throw new SyncError("not_found", "no such member in this workspace");
    if (target.removed_at !== null) {
      throw new SyncError("forbidden", "that member was removed from this workspace");
    }
    name = target.name;
  }

  const existing = await env.DB.prepare(
    `SELECT member_id, revoked_at FROM devices WHERE repo_id = ?1 AND device_id = ?2`,
  )
    .bind(session.repoId, pending.device_id)
    .first<{ member_id: string | null; revoked_at: number | null }>();
  if (existing) {
    if (existing.revoked_at === null) {
      throw new SyncError("conflict", "that device is already connected to this workspace");
    }
    if (existing.member_id !== memberId && !self.isOwner) {
      throw new SyncError(
        "forbidden",
        "that device belonged to another member; only the workspace owner can approve it",
      );
    }
  }

  const now = Date.now();
  const statements: D1PreparedStatement[] = [];
  if (isNew) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO members (repo_id, member_id, name, is_owner, created_at, removed_at)
         SELECT ?1, ?2, ?3, 0, ?4, NULL
          WHERE EXISTS (SELECT 1 FROM join_requests
                         WHERE repo_id = ?1 AND request_id = ?5 AND status = 'pending' AND expires_at > ?4)
            AND NOT EXISTS (SELECT 1 FROM members WHERE repo_id = ?1 AND lower(name) = lower(?3))`,
      ).bind(session.repoId, memberId, name, now, pending.request_id),
    );
  }
  statements.push(
    env.DB.prepare(
      `UPDATE join_requests
          SET status = 'approved', member_id = ?3, approved_by_device = ?4, expires_at = ?5 + ?6
        WHERE repo_id = ?1 AND request_id = ?2 AND status = 'pending' AND expires_at > ?5
          AND EXISTS (SELECT 1 FROM members
                       WHERE repo_id = ?1 AND member_id = ?3 AND removed_at IS NULL)`,
    ).bind(session.repoId, pending.request_id, memberId, session.deviceId, now, JOIN_REQUEST_TTL_MS),
  );
  const results = await env.DB.batch(statements);
  if ((results[results.length - 1]?.meta.changes ?? 0) !== 1) {
    throw new SyncError("conflict", "the request or the member changed while it was being approved; try again");
  }

  log({
    event: "join.approve",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });
  return json({ requestId: pending.request_id, member: { memberId, name } });
}

/** POST /v1/repos/{repoId}/join-requests/{code}/deny — any member. */
export async function denyJoinRequest(
  env: Env,
  session: Session,
  protocol: number,
  rawCode: string,
): Promise<Response> {
  requireMember(await memberContext(env, session));
  const pending = await findPending(env, session.repoId, normalizeCode(rawCode));
  const result = await env.DB.prepare(
    `UPDATE join_requests SET status = 'denied'
      WHERE repo_id = ?1 AND request_id = ?2 AND status = 'pending'`,
  )
    .bind(session.repoId, pending.request_id)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new SyncError("not_found", "no pending join request with that code");
  }
  log({
    event: "join.deny",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });
  return json({ requestId: pending.request_id });
}

/**
 * GET /v1/repos/{repoId}/members — exactly the client's `MembersCache` shape, minus
 * `version`, `repositoryId` and `fetchedAt`, which the client stamps itself.
 */
export async function listMembers(env: Env, session: Session): Promise<Response> {
  const self = requireMember(await memberContext(env, session));
  const [members, devices] = await env.DB.batch([
    env.DB.prepare(
      `SELECT member_id, name, is_owner, removed_at FROM members
        WHERE repo_id = ?1 ORDER BY created_at, member_id`,
    ).bind(session.repoId),
    env.DB.prepare(
      `SELECT device_id, member_id, label, last_seen_at, revoked_at FROM devices
        WHERE repo_id = ?1 AND member_id IS NOT NULL ORDER BY created_at, device_id`,
    ).bind(session.repoId),
  ]);

  type MemberRow = { member_id: string; name: string; is_owner: number; removed_at: number | null };
  type DeviceRow = {
    device_id: string;
    member_id: string;
    label: string | null;
    last_seen_at: number | null;
    revoked_at: number | null;
  };
  const byMember = new Map<string, DeviceRow[]>();
  for (const device of (devices?.results ?? []) as DeviceRow[]) {
    const list = byMember.get(device.member_id) ?? [];
    list.push(device);
    byMember.set(device.member_id, list);
  }

  // `token_sha256` is not in the projection and must never be; see `listDevices`.
  return json({
    self: { memberId: self.memberId, deviceId: session.deviceId },
    members: ((members?.results ?? []) as MemberRow[]).map((m) => ({
      memberId: m.member_id,
      name: m.name,
      isOwner: m.is_owner === 1,
      removed: m.removed_at !== null,
      devices: (byMember.get(m.member_id) ?? []).map((d) => ({
        deviceId: d.device_id,
        label: d.label,
        lastSeenAt: d.last_seen_at,
        revoked: d.revoked_at !== null,
      })),
    })),
  });
}

/** PATCH /v1/repos/{repoId}/members/{memberId} — self, or the owner. */
export async function renameMember(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  memberId: string,
): Promise<Response> {
  const self = requireMember(await memberContext(env, session));
  if (memberId !== self.memberId && !self.isOwner) {
    throw new SyncError("forbidden", "only the workspace owner can rename another member");
  }
  const body = await readJson(request);
  const name = requireName(body.name);

  const target = await env.DB.prepare(
    `SELECT member_id FROM members WHERE repo_id = ?1 AND member_id = ?2`,
  )
    .bind(session.repoId, memberId)
    .first<{ member_id: string }>();
  if (!target) throw new SyncError("not_found", "no such member in this workspace");
  await assertNameFree(env, session.repoId, name, memberId);

  const result = await env.DB.prepare(
    `UPDATE members SET name = ?3
      WHERE repo_id = ?1 AND member_id = ?2
        AND NOT EXISTS (SELECT 1 FROM members
                         WHERE repo_id = ?1 AND member_id <> ?2 AND lower(name) = lower(?3))`,
  )
    .bind(session.repoId, memberId, name)
    .run();
  if ((result.meta.changes ?? 0) !== 1) throw nameTaken();

  log({
    event: "member.rename",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });
  return json({ memberId, name });
}

/**
 * DELETE /v1/repos/{repoId}/members/{memberId} — the owner, and never themselves.
 *
 * Revokes every device of the member and sets `removed_at`, in one batch, and voids any
 * approval of theirs that was not collected yet. The row stays, so the name keeps
 * labelling that member's history. Idempotent.
 */
export async function removeMember(
  env: Env,
  session: Session,
  protocol: number,
  memberId: string,
): Promise<Response> {
  const self = requireMember(await memberContext(env, session));
  if (!self.isOwner) throw new SyncError("forbidden", "only the workspace owner can remove a member");
  if (memberId === self.memberId) {
    throw new SyncError("forbidden", "the workspace owner cannot remove themselves");
  }

  const target = await env.DB.prepare(
    `SELECT member_id FROM members WHERE repo_id = ?1 AND member_id = ?2`,
  )
    .bind(session.repoId, memberId)
    .first<{ member_id: string }>();
  if (!target) throw new SyncError("not_found", "no such member in this workspace");

  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE members SET removed_at = ?3
        WHERE repo_id = ?1 AND member_id = ?2 AND removed_at IS NULL AND is_owner = 0`,
    ).bind(session.repoId, memberId, now),
    env.DB.prepare(
      `UPDATE devices SET revoked_at = ?3
        WHERE repo_id = ?1 AND member_id = ?2 AND revoked_at IS NULL`,
    ).bind(session.repoId, memberId, now),
    env.DB.prepare(
      `UPDATE join_requests SET status = 'denied'
        WHERE repo_id = ?1 AND member_id = ?2 AND status = 'approved'`,
    ).bind(session.repoId, memberId),
  ]);

  log({
    event: "member.remove",
    status: 200,
    repo_id: session.repoId,
    device_id: session.deviceId,
    token_fp: tokenFingerprint(session.digest),
    protocol,
  });
  return json({ memberId, removed: true });
}

// ------------------------------------------------------------------ helpers

/** 8 Crockford base32 characters from the CSPRNG: 5 bytes, exactly 40 bits. */
export function mintCode(): string {
  const raw = crypto.getRandomValues(new Uint8Array(5));
  let bits = 0n;
  for (const byte of raw) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let i = 7; i >= 0; i -= 1) code += CROCKFORD[Number((bits >> BigInt(i * 5)) & 31n)];
  return code;
}

/**
 * Accept a code as a person typed or read it: any case, with or without the dash or
 * spaces, and the Crockford look-alikes (O for 0, I and L for 1).
 */
export function normalizeCode(input: string): string {
  const code = input
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (!CODE_PATTERN.test(code)) {
    throw new SyncError("validation", "a join code is 8 characters, shown as XXXX-XXXX");
  }
  return code;
}

export function displayCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

async function findPending(
  env: Env,
  repoId: string,
  code: string,
): Promise<{ request_id: string; device_id: string }> {
  const rows = await env.DB.prepare(
    `SELECT request_id, device_id FROM join_requests
      WHERE repo_id = ?1 AND code = ?2 AND status = 'pending' AND expires_at > ?3
      LIMIT 2`,
  )
    .bind(repoId, code, Date.now())
    .all<{ request_id: string; device_id: string }>();
  if (rows.results.length === 0) {
    throw new SyncError("not_found", "no pending join request with that code");
  }
  if (rows.results.length > 1) {
    // Forty bits makes this a curiosity, and it is still refused rather than guessed.
    throw new SyncError("conflict", "that code matches more than one pending request; ask the joiner to retry");
  }
  return rows.results[0]!;
}

/**
 * Names are unique per repository case-insensitively, with a Unicode-aware fold: the
 * client matches names with `toLowerCase()`, and SQLite's `lower` folds ASCII only.
 * The unique index on `lower(name)` is the race-free floor under this check.
 */
async function assertNameFree(env: Env, repoId: string, name: string, exceptMemberId: string | null): Promise<void> {
  const rows = await env.DB.prepare(`SELECT member_id, name FROM members WHERE repo_id = ?1`)
    .bind(repoId)
    .all<{ member_id: string; name: string }>();
  const wanted = name.toLowerCase();
  if (rows.results.some((r) => r.member_id !== exceptMemberId && r.name.toLowerCase() === wanted)) {
    throw nameTaken();
  }
}

function nameTaken(): SyncError {
  return new SyncError("conflict", "a member with that name already exists in this workspace");
}

function requireName(value: unknown): string {
  if (typeof value !== "string") throw new SyncError("validation", "name must be a string");
  const name = value.trim();
  // C0 and C1 controls only; letters in any script are welcome.
  if (name.length === 0 || name.length > MAX_NAME_LENGTH || /[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    throw new SyncError(
      "validation",
      `name must be 1 to ${MAX_NAME_LENGTH} characters, with no control characters`,
    );
  }
  return name;
}

function requireBoundedString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new SyncError("validation", `${field} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireSha256Hex(value: unknown): number[] {
  if (typeof value !== "string" || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new SyncError("validation", "requestSecretSha256 must be 64 hex characters");
  }
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(Number.parseInt(value.slice(i, i + 2), 16));
  return out;
}
