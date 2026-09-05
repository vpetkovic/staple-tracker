/**
 * staple-sync-dev — the repository-scoped operation log.
 *
 * One versioned prefix, `/v1`. Every repository-scoped route carries the `repoId` in
 * the path so that authorization is decided BEFORE the body is parsed, and every such
 * request carries `Authorization: Bearer <token>`, `Staple-Protocol: <n>` and
 * `Staple-Device: <deviceId>`.
 *
 * The order of the checks in `handle` is the security design, not an accident:
 *
 *   TLS -> protocol -> route -> body size -> authenticate -> repo scope -> rate limit
 *          -> parse -> act
 *
 * Every step is cheaper than the one after it and refuses without touching anything
 * the next step would have touched. In particular the protocol check runs before any
 * statement is prepared, which is what "refused before any write" means: an
 * unsupported client leaves no partial batch and no half-applied page.
 */

import { type Session, authenticate, assertRepoScope } from "./auth.js";
import { connect, listDevices, revokeDevice } from "./devices.js";
import type { Env } from "./env.js";
import { SyncError, json } from "./errors.js";
import { assertBodySize, assertRateLimit, assertTls, negotiateProtocol } from "./http.js";
import { acquireLease, releaseLease, renewLease } from "./leases.js";
import { capabilities, planOf } from "./limits.js";
import { errorKind, log } from "./log.js";
import { pull } from "./pull.js";
import { push } from "./push.js";
import { snapshot } from "./snapshot.js";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const startedAt = Date.now();
    try {
      return await handle(request, env, startedAt);
    } catch (err) {
      if (err instanceof SyncError) {
        log({
          event: "error",
          status: err.status,
          code: err.code,
          method: request.method,
          route: routeShape(request),
          duration_ms: Date.now() - startedAt,
        });
        return err.toResponse();
      }
      // An unexpected throw. Only the error's CLASS NAME is logged — never the error,
      // never its message, never the request. A D1 failure can echo the statement that
      // failed, and while every statement here is parameterised and the credential
      // lookup binds a digest rather than a secret, "it would only leak a hash" is not
      // a reason to emit one.
      log({
        event: "error",
        status: 503,
        code: errorKind(err),
        method: request.method,
        route: routeShape(request),
        duration_ms: Date.now() - startedAt,
      });
      return new SyncError("unavailable", "the sync service could not complete this request")
        .toResponse();
    }
  },
} satisfies ExportedHandler<Env>;

async function handle(request: Request, env: Env, startedAt: number): Promise<Response> {
  assertTls(request, env);
  const protocol = negotiateProtocol(request);

  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((s) => s.length > 0);

  if (segments[0] !== "v1") {
    throw new SyncError("not_found", "unknown route");
  }

  // The one unscoped route. No credential, because a client calls it precisely to
  // learn how to talk to this server — including how big a batch it may send.
  if (segments.length === 2 && segments[1] === "capabilities") {
    if (request.method !== "GET") throw new SyncError("validation", "method not allowed");
    // `capabilities()` already carries `protocol: { min, max }`. Spreading a negotiated
    // protocol NUMBER alongside it would collide on the same key — which is exactly
    // what the compiler caught here, and what a test asserting only the range would
    // not have.
    return json(capabilities(env));
  }

  if (segments[1] !== "repos" || segments.length < 3) {
    throw new SyncError("not_found", "unknown route");
  }
  const repoId = decodeURIComponent(segments[2]!);
  const tail = segments.slice(3);

  // Connect is repository-scoped but pre-credential: the caller does not have a device
  // token yet, by definition. It authenticates against an enrollment credential
  // instead, inside the route.
  if (tail.length === 1 && tail[0] === "connect" && request.method === "POST") {
    assertBodySize(request, planOf(env));
    return connect(request, env, repoId, protocol, startedAt);
  }

  // Everything past here is authenticated, scoped and rate limited, in that order.
  //
  // Body size is checked BEFORE authentication so that an oversized body is refused
  // without spending a database query on it, and from `Content-Length` rather than the
  // parsed body because the free plan's 10 ms of CPU is not enough to parse a
  // multi-megabyte body just to discover it was too big.
  if (hasBody(request)) assertBodySize(request, planOf(env));

  const session = await authenticate(request, env);
  assertRepoScope(session, repoId);
  assertDeviceHeader(request, session);
  await assertRateLimit(env, session.repoId, session.deviceId);

  return route(request, env, session, protocol, tail, startedAt);
}

async function route(
  request: Request,
  env: Env,
  session: Session,
  protocol: number,
  tail: string[],
  startedAt: number,
): Promise<Response> {
  const method = request.method;

  // /v1/repos/{repoId}/ops
  if (tail.length === 1 && tail[0] === "ops") {
    if (method === "POST") return push(request, env, session, protocol, startedAt);
    if (method === "GET") return pull(request, env, session, protocol, startedAt);
    throw new SyncError("validation", "method not allowed");
  }

  // /v1/repos/{repoId}/snapshot
  if (tail.length === 1 && tail[0] === "snapshot" && method === "GET") {
    return snapshot(request, env, session, protocol, startedAt);
  }

  // /v1/repos/{repoId}/leases
  if (tail.length === 1 && tail[0] === "leases" && method === "POST") {
    return acquireLease(request, env, session, protocol, startedAt);
  }
  // /v1/repos/{repoId}/leases/{entityId}/renew
  if (tail.length === 3 && tail[0] === "leases" && tail[2] === "renew" && method === "POST") {
    return renewLease(request, env, session, protocol, decodeURIComponent(tail[1]!));
  }
  // /v1/repos/{repoId}/leases/{entityId}
  if (tail.length === 2 && tail[0] === "leases" && method === "DELETE") {
    return releaseLease(request, env, session, protocol, decodeURIComponent(tail[1]!));
  }

  // /v1/repos/{repoId}/devices
  if (tail.length === 1 && tail[0] === "devices" && method === "GET") {
    return listDevices(env, session, protocol);
  }
  // /v1/repos/{repoId}/devices/{deviceId}
  if (tail.length === 2 && tail[0] === "devices" && method === "DELETE") {
    return revokeDevice(env, session, protocol, decodeURIComponent(tail[1]!));
  }

  throw new SyncError("not_found", "unknown route");
}

/**
 * `Staple-Device` must agree with the credential.
 *
 * The header is not the authority — the credential is, and every statement binds
 * `session.deviceId` — but a client whose header disagrees with its token has a bug
 * worth surfacing rather than absorbing. Absent is tolerated: the contract requires
 * clients to send it, and a server that hard-failed on a missing one would break a
 * conforming client that merely forgot on a GET.
 */
function assertDeviceHeader(request: Request, session: Session): void {
  const header = request.headers.get("Staple-Device");
  if (header !== null && header !== session.deviceId) {
    throw new SyncError("forbidden", "Staple-Device does not match the credential's device");
  }
}

function hasBody(request: Request): boolean {
  return request.method === "POST" || request.method === "PUT" || request.method === "PATCH";
}

/**
 * The route SHAPE for a log line — never the URL.
 *
 * `repoId` is an opaque uuid and is logged as its own field elsewhere; entity and
 * device ids are replaced with `:id` so that a log line can be grouped by route
 * without carrying identifiers that were never chosen for logging. Query strings are
 * dropped entirely: nothing in this service accepts a credential in a query parameter,
 * and this makes that true of the logs even if someone later adds one.
 */
function routeShape(request: Request): string {
  try {
    const segments = new URL(request.url).pathname.split("/").filter(Boolean);
    return `/${segments.map((s, i) => (i >= 2 && i !== 3 && s.length > 12 ? ":id" : s)).join("/")}`;
  } catch {
    return "/";
  }
}
