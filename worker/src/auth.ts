/**
 * Credentials.
 *
 * Three properties this module exists to guarantee:
 *
 *   1. The server stores only a SHA-256 of a token, never the token. A database
 *      disclosure does not yield working credentials.
 *   2. A credential is looked up BY its digest, never fetched by device id and then
 *      compared. No secret comparison happens anywhere in the request path, so there
 *      is no timing-safe comparison to get wrong. SHA-256 preimage resistance is the
 *      whole guarantee.
 *   3. `repoId` is bound into every subsequent statement FROM THE SESSION, never from
 *      the request path or body. Cross-repository access is structurally impossible
 *      rather than merely checked — though it is also checked, in `assertRepoScope`.
 */

import type { Env } from "./env.js";
import { SyncError } from "./errors.js";

export interface Session {
  repoId: string;
  deviceId: string;
  /** The repository's current epoch, read in the same query as the credential. */
  epoch: number;
  /** The repository's high-water mark at authentication time. Advisory only. */
  lastSeq: number;
  /** SHA-256 of the presented token, for `tokenFingerprint` in logs. Never the token. */
  digest: ArrayBuffer;
}

export async function sha256(input: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
}

/**
 * Pull the bearer out of `Authorization`.
 *
 * The token is accepted ONLY from this header. Never from the URL, never from a query
 * parameter: the Workers invocation log's message is `<Method> <URL>`, so a token in a
 * query string is logged in plaintext in every invocation log and in any Logpush
 * destination downstream. There is no query-parameter fallback in this Worker, not
 * even a deprecated one.
 */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (!header) return null;
  // Case-insensitive scheme, exactly one space, non-empty credential.
  const match = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/**
 * Authenticate a request against the device credential table.
 *
 * One query. It joins `repos` so that the epoch and the high-water mark arrive with
 * the credential rather than costing a second round trip — which is what keeps a push
 * at the N+4 statements the wire contract advertises.
 *
 * Revoked devices are looked up WITHOUT filtering on `revoked_at`, then branched on,
 * so that a revoked device gets `revoked` (403, "re-connect required") rather than a
 * bare `auth` (401) that is indistinguishable from a typo. Membership is checked here,
 * on every request — not at connection time — which is what makes a revocation take
 * effect on the device's very next request.
 */
export async function authenticate(request: Request, env: Env): Promise<Session> {
  const raw = bearerToken(request);
  if (!raw) {
    throw new SyncError("auth", "missing bearer credential", {}, { "www-authenticate": "Bearer" });
  }

  const digest = await sha256(raw);
  const row = await env.DB.prepare(
    `SELECT d.repo_id     AS repo_id,
            d.device_id   AS device_id,
            d.revoked_at  AS revoked_at,
            r.epoch       AS epoch,
            r.last_seq    AS last_seq
       FROM devices d
       JOIN repos   r ON r.repo_id = d.repo_id
      WHERE d.token_sha256 = ?1`,
  )
    .bind(bytes(digest))
    .first<{
      repo_id: string;
      device_id: string;
      revoked_at: number | null;
      epoch: number;
      last_seq: number;
    }>();

  if (!row) {
    throw new SyncError("auth", "invalid credential", {}, { "www-authenticate": "Bearer" });
  }
  if (row.revoked_at !== null) {
    throw new SyncError("revoked", "this device was revoked; re-connect required");
  }

  return {
    repoId: row.repo_id,
    deviceId: row.device_id,
    epoch: row.epoch,
    lastSeq: row.last_seq,
    digest,
  };
}

/**
 * Reject a path-supplied repository id that disagrees with the credential's scope.
 *
 * Possession of a token IS membership, so compromise is bounded to one repository.
 * This check is defence in depth rather than the mechanism — every statement binds
 * `session.repoId` — but it turns a cross-repository attempt into a clean `forbidden`
 * at the boundary instead of an empty result set three layers down.
 */
export function assertRepoScope(session: Session, pathRepoId: string): void {
  if (session.repoId !== pathRepoId) {
    throw new SyncError("forbidden", "credential is not scoped to this repository");
  }
}

/**
 * Mint a device credential.
 *
 * 32 bytes from the CSPRNG, base64url, prefixed `stpl_` so that secret scanners —
 * GitHub's, and any the operator runs — can recognise it on sight. The plaintext is
 * returned to exactly one caller, once, and never stored: only `sha256(token)` reaches
 * the database.
 */
export function mintToken(): string {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return `stpl_${base64url(raw)}`;
}

export function base64url(input: Uint8Array): string {
  let binary = "";
  for (const byte of input) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * D1 binds a BLOB from a plain number array. An ArrayBuffer or a Uint8Array does not
 * round-trip reliably across every D1 code path, and a silently mis-bound digest would
 * mean "no credential matches, ever" — which fails closed, but fails closed for every
 * device at once.
 */
export function bytes(buffer: ArrayBuffer): number[] {
  return [...new Uint8Array(buffer)];
}
