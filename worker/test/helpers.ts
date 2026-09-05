/**
 * Test fixtures. Every helper drives the Worker through `SELF.fetch`, i.e. the real
 * `fetch` handler with the real router and the real middleware order — not an
 * internal function. A test that bypassed the router would prove nothing about the
 * checks the router performs.
 */
import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";

export const REPO = "11111111-1111-4111-8111-111111111111";
export const OTHER_REPO = "22222222-2222-4222-8222-222222222222";
export const DEVICE = "device-a";
export const ORIGIN = "https://sync.test";

export async function sha256Hex(input: string): Promise<number[]> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)];
}

/**
 * Provision a repository and a device credential directly in D1.
 *
 * Deliberately not through `POST /connect`: provisioning a repository is an
 * out-of-band operation (see README.md), and a fixture that depended on the connect
 * route would make every test a test of connect.
 */
export async function seedRepo(
  repoId = REPO,
  deviceId = DEVICE,
  token = `stpl_test_${repoId}_${deviceId}`,
): Promise<string> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO repos (repo_id, epoch, last_seq, last_fencing_token, enroll_sha256, created_at)
     VALUES (?1, 1, 0, 0, ?2, ?3)
     ON CONFLICT (repo_id) DO NOTHING`,
  )
    .bind(repoId, await sha256Hex(`enroll_${repoId}`), now)
    .run();

  await env.DB.prepare(
    `INSERT INTO devices (repo_id, device_id, token_sha256, label, created_at, last_seen_at, revoked_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, NULL)
     ON CONFLICT (repo_id, device_id) DO UPDATE SET token_sha256 = excluded.token_sha256`,
  )
    .bind(repoId, deviceId, await sha256Hex(token), "test", now)
    .run();

  return token;
}

export function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const clientSeq = (overrides.clientSeq as number) ?? 1;
  return {
    opId: `op-${clientSeq}`,
    repoId: REPO,
    protocol: 1,
    schema: 10,
    entity: "issue",
    entityId: "issue-1",
    verb: "update",
    baseVersion: 1,
    payload: { status: "in_progress" },
    deviceId: DEVICE,
    actor: "opus-s4",
    clientSeq,
    createdAt: "2026-09-05T12:00:00.000Z",
    ...overrides,
  };
}

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  protocol?: number | null;
  device?: string | null;
  headers?: Record<string, string>;
  repoId?: string;
}

/**
 * One request against the Worker.
 *
 * `Content-Length` is set explicitly for every body, because the Worker refuses a
 * request without one — the free plan's 10 ms CPU budget is not enough to parse a body
 * to discover it was too large, so the size check has to read the header.
 */
export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers.Authorization = `Bearer ${options.token}`;
  if (options.protocol !== null) headers["Staple-Protocol"] = String(options.protocol ?? 1);
  if (options.device !== null) headers["Staple-Device"] = options.device ?? DEVICE;

  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers["Content-Length"] = String(new TextEncoder().encode(body).length);
    headers["Content-Type"] = "application/json";
  }

  // Explicit headers are applied LAST so a test can override a default — which is the
  // only way to exercise a lying Content-Length or a malformed protocol header.
  Object.assign(headers, options.headers);

  return SELF.fetch(`${ORIGIN}${path}`, { method: options.method ?? "GET", headers, body });
}

export async function pushOps(
  ops: Record<string, unknown>[],
  options: CallOptions = {},
): Promise<Response> {
  return call(`/v1/repos/${options.repoId ?? REPO}/ops`, {
    method: "POST",
    body: { protocol: 1, deviceId: options.device ?? DEVICE, ops },
    ...options,
  });
}

export async function jsonOf<T = any>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

/** Assert a typed error, by code and status together. */
export async function expectError(
  response: Response,
  code: string,
  status: number,
): Promise<Record<string, unknown>> {
  const body = await jsonOf<Record<string, unknown>>(response);
  expect({ status: response.status, code: body.code }).toEqual({ status, code });
  return body;
}

/** Move a repository's epoch forward, the way a restore would. Non-truncating. */
export async function bumpEpoch(repoId = REPO): Promise<void> {
  await env.DB.prepare(`UPDATE repos SET epoch = epoch + 1 WHERE repo_id = ?1`).bind(repoId).run();
}
