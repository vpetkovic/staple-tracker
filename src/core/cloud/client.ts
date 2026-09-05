/**
 * The HTTP client for `staple-sync`. **The only outbound call site in the tree.**
 *
 * That is a design constraint, not a description. `docs/sync.md`, "The network
 * rule": *"Today the runtime contains zero outbound network call sites … The
 * invariant is therefore not a reduction to be achieved — it is a floor to be
 * held, and the assertion is literally zero rather than an allowlist."* Keeping
 * every `fetch` in one file is what makes that floor auditable by reading one
 * import graph instead of grepping the repository, and
 * `test/network-silence.test.ts` is what makes it enforced.
 *
 * Nothing in this module is imported by an ordinary command path. `staple ls` on
 * a connected repository in manual mode must be as silent as `staple ls` on a
 * disconnected one, and the cheapest way to guarantee that is for the code that
 * could speak to not be loaded at all.
 *
 * ## The Worker is the API; `docs/sync.md` is the contract
 *
 * Where they disagree the Worker wins, because the Worker is what is deployed.
 * Every such divergence is marked `DIVERGENCE:` below.
 *
 * ## Every request is bounded
 *
 * *"A tracker command never blocks indefinitely on Cloudflare"*. Every call
 * carries an `AbortSignal` with a timeout, and a timeout surfaces as the
 * client-side `offline` condition rather than as a hang or an unhandled
 * rejection.
 *
 * ## The token is in exactly one place
 *
 * `Authorization: Bearer`. Never a query parameter — the Worker's invocation log
 * message is `<Method> <URL>`, so a token in a query string is logged in
 * plaintext at the other end. Never in a thrown message either: the error
 * mapping below builds its text from the server's `code` and `message` and never
 * touches the credential it was given.
 */
import { StapleError } from "../types.js";
import { endpointUrl, type CloudEndpoint } from "./endpoint.js";

/** The wire protocol this build speaks. Matches `PROTOCOL_MAX` in the Worker. */
export const CLIENT_PROTOCOL = 1;

/** Bounded so an unreachable endpoint degrades to `offline` instead of hanging. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface Capabilities {
  protocol: { min: number; max: number };
  maxBatchSize: number;
  maxOpBytes: number;
  maxPullLimit: number;
  defaultPullLimit: number;
  maxSnapshotPageSize: number;
}

export interface ConnectResult {
  protocol: number;
  repositoryId: string;
  deviceId: string;
  epoch: number;
  /** The plaintext credential. Returned once, by the server, and never logged. */
  token: string;
  capabilities: Capabilities;
}

export interface RemoteDevice {
  deviceId: string;
  label: string | null;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
  self: boolean;
}

/**
 * The server's error vocabulary, from `worker/src/errors.ts`.
 *
 * `offline` is in the contract's table but is a CLIENT-side condition — there is
 * no server response that carries it — so it is produced here, by a transport
 * failure, and never parsed from a body.
 */
export type CloudErrorCode =
  | "validation"
  | "auth"
  | "forbidden"
  | "revoked"
  | "not_found"
  | "conflict"
  | "epoch_changed"
  | "cursor_invalid"
  | "payload_too_large"
  | "schema_ahead"
  | "protocol_unsupported"
  | "rate_limited"
  | "unavailable"
  | "offline";

/**
 * DIVERGENCE (client-side, and worth stating plainly).
 *
 * `StapleErrorCode` is a closed union that has no member for "not authenticated",
 * "not a member" or "revoked", and its retry contract marks exactly one code
 * retryable. The sync taxonomy needs fourteen codes and three retryable ones.
 *
 * Extending `StapleErrorCode` would touch `RETRYABLE_ERROR_CODES`, the CLI's
 * `EXIT_CODES` table and the error-contract goldens — a shared surface, mid-wave,
 * with concurrent lanes in the same files. So the server's code is preserved
 * EXACTLY in `detail.cloudCode` alongside `detail.retryable`, and the
 * `StapleError` code carries the nearest existing meaning for exit-code purposes.
 * `--json` consumers get the true code; shells get a sensible exit status.
 *
 * This is a deliberate deferral, not a loss: nothing is discarded, and the
 * follow-up is a single additive change to the union once the wave has merged.
 */
const CODE_MAP: Record<CloudErrorCode, "validation" | "not_found" | "conflict"> = {
  validation: "validation",
  auth: "validation",
  forbidden: "validation",
  revoked: "validation",
  not_found: "not_found",
  conflict: "conflict",
  epoch_changed: "conflict",
  cursor_invalid: "validation",
  payload_too_large: "validation",
  schema_ahead: "validation",
  protocol_unsupported: "validation",
  rate_limited: "conflict",
  unavailable: "conflict",
  offline: "conflict",
};

const RETRYABLE: ReadonlySet<CloudErrorCode> = new Set(["rate_limited", "unavailable", "offline"]);

export function isCloudErrorCode(value: unknown): value is CloudErrorCode {
  return typeof value === "string" && value in CODE_MAP;
}

/** The `cloudCode` a `StapleError` from this module carries, or null when it is not one. */
export function cloudCodeOf(error: unknown): CloudErrorCode | null {
  if (!(error instanceof StapleError)) return null;
  const code = error.detail?.cloudCode;
  return isCloudErrorCode(code) ? code : null;
}

function cloudError(
  code: CloudErrorCode,
  message: string,
  detail: Record<string, unknown> = {},
): StapleError {
  return new StapleError(CODE_MAP[code], message, {
    ...detail,
    cloudCode: code,
    retryable: RETRYABLE.has(code),
  });
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Injected in tests. Defaults to the global `fetch`; there is no other one. */
  fetchImpl?: typeof fetch;
}

interface Call extends RequestOptions {
  endpoint: CloudEndpoint;
  path: string;
  method: string;
  /** The bearer. Present on every call except `capabilities`. */
  token?: string;
  /** Sent as `Staple-Device`, which the Worker checks against the credential. */
  deviceId?: string;
  body?: unknown;
}

/**
 * One request, one place errors are built.
 *
 * A transport failure — DNS, refused connection, TLS, timeout — becomes
 * `offline`, which is retryable and which every surface renders as "no
 * connectivity; local work continues" rather than as a broken repository. That
 * distinction matters: `offline` is not a state a human has to act on, and
 * every other error is.
 */
async function request<T>(call: Call): Promise<T> {
  const doFetch = call.fetchImpl ?? globalThis.fetch;
  const url = endpointUrl(call.endpoint, call.path);

  const headers: Record<string, string> = { "Staple-Protocol": String(CLIENT_PROTOCOL) };
  if (call.token) headers.Authorization = `Bearer ${call.token}`;
  if (call.deviceId) headers["Staple-Device"] = call.deviceId;

  let payload: string | undefined;
  if (call.body !== undefined) {
    payload = JSON.stringify(call.body);
    headers["Content-Type"] = "application/json";
    /**
     * The Worker refuses a request with no `Content-Length` outright — it caps
     * the body from the header, before parsing, because the free plan's 10 ms of
     * CPU is not enough to parse a body just to discover it was too big. `fetch`
     * sets the header for a string body, but it is set explicitly here so that
     * the requirement is visible at the call site rather than inherited from an
     * implementation detail of whichever fetch is in scope.
     */
    headers["Content-Length"] = String(Buffer.byteLength(payload, "utf8"));
  }

  let response: Response;
  try {
    response = await doFetch(url, {
      method: call.method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(call.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.name : "unknown";
    throw cloudError(
      "offline",
      `Could not reach ${call.endpoint.origin} (${reason}). Local work is unaffected; ` +
        `nothing was sent and nothing was changed.`,
      { endpoint: call.endpoint.origin },
    );
  }

  const text = await response.text();
  let parsed: unknown = undefined;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  if (!response.ok) {
    const body = (parsed ?? {}) as Record<string, unknown>;
    const code = isCloudErrorCode(body.code) ? body.code : "unavailable";
    const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    const detail: Record<string, unknown> = { status: response.status, endpoint: call.endpoint.origin };
    // The code-specific extras the taxonomy names: the supported protocol range
    // on `protocol_unsupported`, the current epoch on `epoch_changed`.
    for (const key of ["min", "max", "epoch", "maxBytes", "bytes"]) {
      if (body[key] !== undefined) detail[key] = body[key];
    }
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) detail.retryAfter = retryAfter;
    throw cloudError(code, message, detail);
  }

  if (parsed === undefined) {
    throw cloudError("unavailable", `${call.endpoint.origin} returned a body that is not JSON`, {
      status: response.status,
    });
  }
  return parsed as T;
}

/**
 * `GET /v1/capabilities` — the one unscoped route, and the only one that takes
 * no credential.
 *
 * Called AFTER consent even though it is a read. `staple cloud connect` shows
 * what it is about to talk to and asks before it talks to it, and the network
 * rule counts attempted calls rather than mutations — a capabilities probe run
 * to decorate the preview would resolve DNS for a host the human had not yet
 * agreed to contact.
 */
export function fetchCapabilities(
  endpoint: CloudEndpoint,
  options: RequestOptions = {},
): Promise<Capabilities> {
  return request<Capabilities>({ ...options, endpoint, path: "/v1/capabilities", method: "GET" });
}

/**
 * `POST /v1/repos/{repoId}/connect` — bind this device and mint its credential.
 *
 * DIVERGENCE from `docs/sync.md`: the contract defines no provisioning route and
 * no account model, so the Worker did not invent one. The bearer presented here
 * is an **enrollment credential** — either an existing non-revoked device token
 * for this repository (how a second machine is added by a first) or the
 * repository's enrollment secret (how the first machine is added). The
 * repository itself is created out of band; see `worker/README.md`. An unknown
 * `repoId` fails closed as `forbidden` and is never auto-created, because an
 * unknown id is far more likely to be a copied manifest than a new repository.
 *
 * The returned `token` is the plaintext credential. It exists in this process,
 * is handed to the credential store, and is never logged, never returned in
 * `--json`, and never put in an error.
 */
export function connectDevice(
  endpoint: CloudEndpoint,
  args: { repositoryId: string; enrollmentSecret: string; deviceId: string; label: string | null },
  options: RequestOptions = {},
): Promise<ConnectResult> {
  return request<ConnectResult>({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/connect`,
    method: "POST",
    token: args.enrollmentSecret,
    body: { deviceId: args.deviceId, label: args.label },
  });
}

/** `GET /v1/repos/{repoId}/devices`. */
export async function listRemoteDevices(
  endpoint: CloudEndpoint,
  args: { repositoryId: string; token: string; deviceId: string },
  options: RequestOptions = {},
): Promise<RemoteDevice[]> {
  const body = await request<{ devices: RemoteDevice[] }>({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/devices`,
    method: "GET",
    token: args.token,
    deviceId: args.deviceId,
  });
  return body.devices;
}

/**
 * `DELETE /v1/repos/{repoId}/devices/{deviceId}` — revoke one device.
 *
 * Takes effect on the revoked device's very NEXT request, because the Worker
 * checks membership on every request rather than at connection time, and D1 is
 * strongly consistent. No other device is disturbed: the statement is scoped to
 * one `(repo_id, device_id)` row.
 */
export function revokeRemoteDevice(
  endpoint: CloudEndpoint,
  args: { repositoryId: string; token: string; deviceId: string; targetDeviceId: string },
  options: RequestOptions = {},
): Promise<{ deviceId: string; revoked: boolean }> {
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/devices/${encodeURIComponent(args.targetDeviceId)}`,
    method: "DELETE",
    token: args.token,
    deviceId: args.deviceId,
  });
}

/**
 * `DELETE /v1/repos/{repoId}` — destroy the repository's remote state.
 *
 * DIVERGENCE, and the significant one in this lane: **the deployed Worker does
 * not implement this route.** `worker/README.md` says so explicitly — purge
 * belongs to the restore lane, "and implementing them without the retention and
 * confirmation semantics that lane owns would be worse than not having them".
 * The Worker's router therefore answers `not_found` for it.
 *
 * The client half is implemented anyway, and the command's gating — a separate
 * name, a typed confirmation, a retention disclosure printed first — is real and
 * tested, because that gating is the part this lane owns. What the command must
 * not do is *report success*: when the route is absent, `staple cloud purge`
 * says the remote state was NOT purged and leaves the local credential in place,
 * so nobody walks away believing their data was deleted when it was not.
 */
export function purgeRemoteRepository(
  endpoint: CloudEndpoint,
  args: { repositoryId: string; token: string; deviceId: string },
  options: RequestOptions = {},
): Promise<{ purged: boolean }> {
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}`,
    method: "DELETE",
    token: args.token,
    deviceId: args.deviceId,
  });
}
