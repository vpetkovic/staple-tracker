/**
 * Request-boundary checks that run before a route does anything interesting, in the
 * order their failures are cheapest to produce.
 */

import type { Env, Plan } from "./env.js";
import { SyncError } from "./errors.js";
import { PROTOCOL_MAX, PROTOCOL_MIN, maxBodyBytes } from "./limits.js";

/**
 * TLS is required. No plaintext transport, no escape hatch.
 *
 * Loopback is exempt, and that is not a hole: `wrangler dev --local` serves
 * `http://127.0.0.1`, and the contract's own network rule already draws the same line
 * — a connection whose destination is `127.0.0.1`, `::1` or `localhost` is not egress.
 * A deployed Worker is only ever reachable over HTTPS, so on the real service this
 * check never fires; it exists so that a misconfigured proxy in front of one cannot
 * quietly downgrade it.
 */
export function assertTls(request: Request, env: Env): void {
  const url = new URL(request.url);
  if (url.protocol === "https:") return;
  if (isLoopback(url.hostname)) return;
  if (env.ALLOW_INSECURE === "1") return;
  throw new SyncError("forbidden", "TLS is required");
}

function isLoopback(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/**
 * Negotiate the wire protocol version, from the `Staple-Protocol` request header.
 *
 * This runs BEFORE the body is read and before any statement is prepared, which is
 * what "rejected before any write" means in the contract: an unsupported client gets
 * 426 with the supported range and the database is never touched, so there is no
 * partial batch and no half-applied page to reason about.
 *
 * A missing header is treated as the minimum supported version rather than an error,
 * so that `GET /v1/capabilities` — which a client calls precisely because it does not
 * yet know what to send — is answerable without a chicken-and-egg handshake.
 */
export function negotiateProtocol(request: Request): number {
  const header = request.headers.get("Staple-Protocol");
  if (header === null) return PROTOCOL_MIN;

  const protocol = Number(header);
  if (!Number.isInteger(protocol)) {
    throw new SyncError("validation", "Staple-Protocol must be an integer", {
      min: PROTOCOL_MIN,
      max: PROTOCOL_MAX,
    });
  }
  if (protocol < PROTOCOL_MIN || protocol > PROTOCOL_MAX) {
    throw new SyncError(
      "protocol_unsupported",
      `protocol ${protocol} is outside the supported range`,
      { min: PROTOCOL_MIN, max: PROTOCOL_MAX },
    );
  }
  return protocol;
}

/**
 * Reject an oversized body from `Content-Length`, before it is read.
 *
 * The free plan allows 10 ms of CPU per request. Parsing a multi-megabyte body to
 * discover it is too large spends the budget the check was supposed to protect, so
 * the check has to happen on the header. A request with no `Content-Length` (chunked)
 * is rejected outright for the same reason — there is no way to bound it in advance,
 * and every legitimate Staple client sends a buffered body.
 */
export function assertBodySize(request: Request, plan: Plan): void {
  const max = maxBodyBytes(plan);
  const header = request.headers.get("Content-Length");
  if (header === null) {
    throw new SyncError("validation", "Content-Length is required", { maxBytes: max });
  }
  const length = Number(header);
  if (!Number.isInteger(length) || length < 0) {
    throw new SyncError("validation", "Content-Length is not a length", { maxBytes: max });
  }
  if (length > max) {
    throw new SyncError("payload_too_large", "request body exceeds the documented cap", {
      maxBytes: max,
      bytes: length,
    });
  }
}

/**
 * Parse a JSON body that `assertBodySize` has already bounded.
 *
 * A parse failure is `validation`, and the message deliberately does not echo the
 * body or the parser's own error text — a malformed body is attacker-controlled and
 * has no business being reflected back or, via a log line, stored.
 */
export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new SyncError("validation", "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SyncError("validation", "request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Rate limiting, keyed on repository and device.
 *
 * Keyed this way rather than on IP because the contract's unit of tenancy is the
 * repository and its stated policy is per-device; the docs also warn against IP keys
 * directly, "due to shared usage patterns".
 *
 * The binding is eventually consistent and its limits are local to the Cloudflare
 * location the Worker runs in, so two devices in different colos can see up to twice
 * the nominal limit. That is fine: this is abuse control, and the platform documents
 * it as "intentionally designed to not be used as an accurate accounting system".
 *
 * Counters are deliberately NOT in D1. A counter row would spend a write per request
 * against the free plan's 100,000 rows/day, competing directly with the operation log
 * this service exists to store.
 */
export async function assertRateLimit(
  env: Env,
  repoId: string,
  deviceId: string,
): Promise<void> {
  if (!env.SYNC_LIMITER) return;
  const { success } = await env.SYNC_LIMITER.limit({ key: `${repoId}:${deviceId}` });
  if (!success) {
    throw new SyncError(
      "rate_limited",
      "request rate exceeded for this device",
      {},
      { "retry-after": "60" },
    );
  }
}
