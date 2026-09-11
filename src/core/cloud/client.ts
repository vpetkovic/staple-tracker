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
import { cloudError, isCloudErrorCode } from "./errors.js";

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
 * The error taxonomy — `worker/src/errors.ts` plus the client-side `offline` — lives in
 * `errors.ts`, where code that refuses before a request can reach it without loading
 * this file. A failure from here carries the service's own code as its `StapleError`
 * code (STA-251); there is no nearer-meaning mapping in between.
 */
export { cloudCodeOf, cloudError, isCloudErrorCode, type CloudErrorCode } from "./errors.js";

/**
 * The service refused to write one vocabulary into a repository that holds the other
 * (STA-290, `worker/src/vocabulary.ts`).
 *
 * A hub's repository holds only its registry and a workspace's holds only its data. The
 * Worker records which in `repos.vocabulary`, claimed by the first write, and answers
 * the other vocabulary with `conflict` carrying `repositoryVocabulary` and
 * `requestVocabulary` — `"mixed"` for a restore of a backup captured before the rule
 * existed, which holds both.
 *
 * `conflict` on the wire, deliberately: every released client maps an UNKNOWN code to
 * `unavailable`, which is retryable, so a new code would have made this permanent
 * refusal a retry loop on every installed build. The detail keys are what tell it apart
 * from a lease race, and this is the one place that reads them.
 */
export function vocabularyRefusalMessage(
  origin: string,
  repositoryVocabulary: unknown,
  requestVocabulary: unknown,
): string {
  if (requestVocabulary === "mixed") {
    return (
      `That backup on ${origin} holds both hub registry entries and workspace data. It was ` +
      "captured while this repository was contaminated, before the service kept the two " +
      "apart, and restoring it would write the contamination back, so the service refused. " +
      "Nothing was changed. Restore a backup taken before the contamination or after the " +
      "cleanup (worker/README.md, \"If a registry operation lands in a WORKSPACE's log\")."
    );
  }
  const holdsWorkspace =
    repositoryVocabulary === "workspace" ||
    (repositoryVocabulary !== "hub" && requestVocabulary === "hub");
  if (holdsWorkspace) {
    return (
      `That repository on ${origin} holds a workspace's data, not a hub registry, so the hub ` +
      "registry cannot be written into it. The hub registry needs its own repository: whoever " +
      "runs the service provisions one for this hub's id (worker/README.md, \"Provisioning a " +
      "HUB\"). Nothing was written, and the workspace's data is untouched."
    );
  }
  return (
    `That repository on ${origin} holds a hub's workspace registry, not a workspace's data, ` +
    "so workspace data cannot be written into it. A workspace needs its own repository: " +
    "whoever runs the service provisions one (worker/README.md, \"Provisioning a " +
    "repository\"). Nothing was written, and the hub registry is untouched."
  );
}

function isVocabularyDetail(value: unknown): boolean {
  return value === "hub" || value === "workspace" || value === "mixed";
}

/**
 * Was this failure the service refusing the other vocabulary, rather than a lease race?
 *
 * Both are `conflict`, the true code. What tells them apart is `requestVocabulary`, which
 * only the vocabulary refusal carries — a lease race names `holder` instead, and a local
 * checkout conflict names neither.
 */
export function isVocabularyRefusal(error: unknown): boolean {
  return (
    error instanceof StapleError &&
    error.code === "conflict" &&
    isVocabularyDetail(error.detail?.requestVocabulary)
  );
}

export interface RequestOptions {
  timeoutMs?: number;
  /** Injected in tests. Defaults to the global `fetch`; there is no other one. */
  fetchImpl?: typeof fetch;
  /**
   * The wire protocol to declare, when it is not {@link CLIENT_PROTOCOL}.
   *
   * Exists for exactly one caller: the hub registry leg, whose two entity kinds
   * require protocol 2 (`hub-registry-ops.ts`, `REGISTRY_PROTOCOL`).
   *
   * **`CLIENT_PROTOCOL` deliberately did NOT move to 2 with it.** A client that
   * declared 2 on every request would be refused outright — 426, before any write —
   * by any Worker that has not yet been redeployed, turning a hub feature into a
   * total sync outage on every repository on the machine. So the floor stays where
   * every deployed Worker can meet it, and only the traffic that genuinely needs the
   * newer vocabulary asks for it. A per-call override is the smallest way to say
   * that; a module-level mutable default would make it a property of the process
   * rather than of the request.
   */
  protocol?: number;
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

  const headers: Record<string, string> = {
    "Staple-Protocol": String(call.protocol ?? CLIENT_PROTOCOL),
  };
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
    // A code this build does not know is transient, which is the rule every released
    // client follows (`worker/README.md`). `offline` counts as unknown here: it is the
    // client's own condition, produced by the catch above, and no response carries it.
    const code =
      isCloudErrorCode(body.code) && body.code !== "offline" ? body.code : "unavailable";
    const message = typeof body.message === "string" ? body.message : `HTTP ${response.status}`;
    const detail: Record<string, unknown> = { status: response.status, endpoint: call.endpoint.origin };
    // The code-specific extras the taxonomy names: the supported protocol range
    // on `protocol_unsupported`, the current epoch on `epoch_changed`.
    //
    // `currentEpoch` is in that list because it is the name the DEPLOYED Worker
    // uses — every `SyncError("epoch_changed", …)` in `worker/src/` carries
    // `currentEpoch`, and none carries `epoch`. Copying only `epoch` meant the
    // recovery path never learned the real number from the service and fell back
    // to `local + 1`, which is right only when exactly one restore happened.
    // *"Where they disagree the Worker wins."* Both names are read so a service
    // that uses either is understood.
    //
    // `entityId`, `holder`, `expiresAt` and `currentFencingToken` are the lease
    // routes' extras. The loser of a race is told WHO won and until when, which
    // is the difference between "pick another task" and "pick another task, and
    // here is who to chase if you think that is wrong". Dropping them would have
    // left a non-retryable conflict with nothing actionable in it.
    // `requiredProtocol` and `entity` are the registry widening's extras (STA-283).
    // A `protocol_unsupported` that carries only `{min, max}` tells a human their
    // client is out of range; carrying the version an operation needed and the entity
    // that needed it tells them WHICH feature the upgrade is for, which is the
    // difference between "upgrade something" and "the hub registry needs protocol 2".
    for (const key of [
      "min",
      "max",
      "requiredProtocol",
      "entity",
      "epoch",
      "currentEpoch",
      "maxBytes",
      "bytes",
      "entityId",
      "holder",
      "expiresAt",
      "currentFencingToken",
      // STA-290's refusal: which vocabulary the repository holds and which was offered.
      "repositoryVocabulary",
      "requestVocabulary",
    ]) {
      if (body[key] !== undefined) detail[key] = body[key];
    }
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter !== null) detail.retryAfter = retryAfter;
    // The vocabulary refusal gets a sentence a person can act on, naming the remedy on
    // this side — an operator provisions a separate repository — instead of the
    // service's terse one. The service's own text stays in the detail for `--json`.
    if (code === "conflict" && isVocabularyDetail(body.requestVocabulary)) {
      throw cloudError(
        "conflict",
        vocabularyRefusalMessage(
          call.endpoint.origin,
          body.repositoryVocabulary,
          body.requestVocabulary,
        ),
        { ...detail, serverMessage: message },
      );
    }
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

/** What every repository-scoped sync call needs. The token is never logged. */
export interface RepoCall {
  repositoryId: string;
  token: string;
  deviceId: string;
}

/**
 * `POST /v1/repos/{repoId}/ops` — push a batch.
 *
 * The batch is atomic server-side: it is validated whole before any statement is
 * prepared, and it rolls back whole on any failure. So a rejection here means
 * NOTHING was written, and the identical batch may be retried unchanged — which
 * is the property the deterministic `opId` exists to make useful.
 *
 * `epoch` fences the push, and is sent only when this device actually knows one.
 *
 * The field is optional in the protocol, and that optionality is load-bearing
 * rather than decorative. A device that has never synchronized has no epoch — its
 * `sync_state.epoch` is the migration's default of zero, which is not an epoch,
 * it is the absence of one. Sending zero would fence every first push against a
 * value the server has never used and turn first-device upload into a permanent
 * `epoch_changed`. So `null` means "I do not know yet, do not fence me", and the
 * server's own in-batch epoch guard still makes the write race-free.
 */
export function pushOperations(
  endpoint: CloudEndpoint,
  args: RepoCall & { epoch: number | null; ops: readonly unknown[] },
  options: RequestOptions = {},
): Promise<unknown> {
  const body: Record<string, unknown> = {
    // The same number the header carries. `validateEnvelope` requires every
    // envelope's `protocol` to equal the request header's, so a push that overrode
    // one and not the other would be refused as a disagreement.
    protocol: options.protocol ?? CLIENT_PROTOCOL,
    deviceId: args.deviceId,
    ops: args.ops,
  };
  if (args.epoch !== null) body.epoch = args.epoch;
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/ops`,
    method: "POST",
    token: args.token,
    deviceId: args.deviceId,
    body,
  });
}

/**
 * `GET /v1/repos/{repoId}/ops?cursor=&limit=` — pull one page.
 *
 * The cursor is passed through as bytes. It is `encodeURIComponent`'d because it
 * is going in a query string and nothing else — no inspection, no validation, no
 * assumption about its alphabet. A client that parsed a cursor to check it would
 * be building exactly the coupling the opacity rule exists to prevent.
 */
export function pullOperations(
  endpoint: CloudEndpoint,
  args: RepoCall & { cursor: string | null; limit: number },
  options: RequestOptions = {},
): Promise<unknown> {
  const query = new URLSearchParams();
  if (args.cursor !== null) query.set("cursor", args.cursor);
  query.set("limit", String(args.limit));
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/ops?${query.toString()}`,
    method: "GET",
    token: args.token,
    deviceId: args.deviceId,
  });
}

/**
 * `GET /v1/repos/{repoId}/snapshot?cursor=&limit=` — one page of a bootstrap.
 *
 * Without a cursor the server pins a fresh cutoff at its current watermark and
 * returns the pull cursor for the tail beyond it. With one, it re-folds to the
 * SAME cutoff the cursor carries, which is what makes a multi-page bootstrap a
 * consistent view rather than a series of unrelated ones.
 */
export function fetchSnapshotPage(
  endpoint: CloudEndpoint,
  args: RepoCall & { cursor: string | null; limit: number },
  options: RequestOptions = {},
): Promise<unknown> {
  const query = new URLSearchParams();
  if (args.cursor !== null) query.set("cursor", args.cursor);
  query.set("limit", String(args.limit));
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/snapshot?${query.toString()}`,
    method: "GET",
    token: args.token,
    deviceId: args.deviceId,
  });
}

/**
 * One lease, as the Worker returns it.
 *
 * Every time here is absolute SERVER time in epoch milliseconds. A client asks
 * for a `ttlSeconds` and gets told an `expiresAt`; it never proposes one, and it
 * never derives one. *"Client clocks have no authority over expiry."*
 */
export interface RemoteLease {
  readonly entityId: string;
  readonly fencingToken: number;
  readonly holder: string;
  readonly deviceId: string;
  readonly acquiredAt: number;
  readonly renewedAt: number;
  readonly expiresAt: number;
}

/**
 * `POST /v1/repos/{repoId}/leases` — take the lease on one entity.
 *
 * A `conflict` here is the losing side of a race and is NOT retryable: the
 * server is telling this device that somebody else legitimately holds the lease,
 * and asking again is a spin against a fact. `RETRYABLE_ERROR_CODES` in
 * `core/types.ts` already omits it; this comment exists so nobody adds it.
 *
 * `ttlSeconds` is omitted rather than defaulted client-side when the caller has
 * no opinion, so the service's default is the one that applies. A client that
 * mirrored the default would have to be redeployed to follow a change in it.
 */
export function acquireRemoteLease(
  endpoint: CloudEndpoint,
  args: RepoCall & { entityId: string; holder: string; ttlSeconds?: number },
  options: RequestOptions = {},
): Promise<{ protocol: number; lease: RemoteLease }> {
  const body: Record<string, unknown> = { entityId: args.entityId, holder: args.holder };
  if (args.ttlSeconds !== undefined) body.ttlSeconds = args.ttlSeconds;
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/leases`,
    method: "POST",
    token: args.token,
    deviceId: args.deviceId,
    body,
  });
}

/**
 * `POST /v1/repos/{repoId}/leases/{entityId}/renew` — the heartbeat.
 *
 * The fencing token is the whole request. One server-side predicate covers every
 * way a renewal can be illegitimate — wrong token because it was superseded,
 * wrong device because it is somebody else's lease, or already expired — so this
 * client does not pre-check any of them. Pre-checking would mean deciding
 * locally what only the server can know, and getting it wrong in the direction
 * that matters.
 */
export function renewRemoteLease(
  endpoint: CloudEndpoint,
  args: RepoCall & { entityId: string; fencingToken: number; ttlSeconds?: number },
  options: RequestOptions = {},
): Promise<{ protocol: number; lease: RemoteLease }> {
  const body: Record<string, unknown> = { fencingToken: args.fencingToken };
  if (args.ttlSeconds !== undefined) body.ttlSeconds = args.ttlSeconds;
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/leases/${encodeURIComponent(args.entityId)}/renew`,
    method: "POST",
    token: args.token,
    deviceId: args.deviceId,
    body,
  });
}

/**
 * `DELETE /v1/repos/{repoId}/leases/{entityId}` — release, presenting the token.
 *
 * A DELETE with a body, because that is what the deployed Worker reads, and
 * *"where they disagree the Worker wins"*. The body-size cap the service applies
 * to POST/PUT/PATCH does not apply here, but `Content-Length` is still set by
 * `request` for every body, so nothing about this call is special-cased.
 */
export function releaseRemoteLease(
  endpoint: CloudEndpoint,
  args: RepoCall & { entityId: string; fencingToken: number },
  options: RequestOptions = {},
): Promise<{ protocol: number; released: boolean; entityId: string }> {
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/leases/${encodeURIComponent(args.entityId)}`,
    method: "DELETE",
    token: args.token,
    deviceId: args.deviceId,
    body: { fencingToken: args.fencingToken },
  });
}

/**
 * `DELETE /v1/repos/{repoId}` — destroy the repository's remote state.
 *
 * HISTORY, because the comment that used to be here said the opposite and it
 * matters that the change is visible. This route did not exist when the connect
 * lane wrote this function: `worker/README.md` assigned purge to the restore
 * lane, the Worker's router answered `not_found`, and `performPurge` translated
 * that into `unsupported` so that nobody was told their data had been destroyed
 * when it had not.
 *
 * **The route now exists** — `worker/src/backups.ts`, `purgeRepository`. It
 * deletes the operation log, the leases, the backups, the restore audit rows,
 * the repository row and finally the device credentials, in that order.
 *
 * FOLLOW-UP, deliberately not taken here. `performPurge` still maps `not_found`
 * to `unsupported`, and with the route present that mapping has changed meaning:
 * a `not_found` now describes a repository the server genuinely does not have,
 * not a server that cannot purge. Rewording it is the connect lane's decision to
 * make and is left alone rather than quietly changed underneath it.
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

// ------------------------------------------------------------------- backups
//
// Backup is a THIRD consent and none of these calls is reachable until it has
// been given. Not one of them takes a cursor, returns a cursor, or reads one —
// which is the wire-level shape of "creating, retaining or deleting a backup
// does not change convergence state".

export interface RemoteBackup {
  backupId: string;
  epoch: number;
  cutoffSeq: number;
  entityCount: number;
  opCount: number;
  schemaVersion: number;
  protocol: number;
  /** `manual` for one a human took; `pre-restore` for the undo a restore takes. */
  kind: string;
  createdAt: number;
  createdByDevice: string;
}

/** `PUT /v1/repos/{repoId}/backup` — the server-side half of the third consent. */
export function setRemoteBackupConsent(
  endpoint: CloudEndpoint,
  args: RepoCall & { enabled: boolean },
  options: RequestOptions = {},
): Promise<{ backupEnabled: boolean }> {
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/backup`,
    method: "PUT",
    token: args.token,
    deviceId: args.deviceId,
    body: { enabled: args.enabled },
  });
}

/** `POST /v1/repos/{repoId}/backups` — take a point-in-time fold. */
export function createRemoteBackup(
  endpoint: CloudEndpoint,
  args: RepoCall & { label: string | null },
  options: RequestOptions = {},
): Promise<{ backup: RemoteBackup }> {
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/backups`,
    method: "POST",
    token: args.token,
    deviceId: args.deviceId,
    body: { label: args.label },
  });
}

/** `GET /v1/repos/{repoId}/backups` — metadata only; never the folded contents. */
export function listRemoteBackups(
  endpoint: CloudEndpoint,
  args: RepoCall,
  options: RequestOptions = {},
): Promise<{ epoch: number; backups: RemoteBackup[] }> {
  return request({
    ...options,
    endpoint,
    path: `/v1/repos/${encodeURIComponent(args.repositoryId)}/backups`,
    method: "GET",
    token: args.token,
    deviceId: args.deviceId,
  });
}

/** `DELETE /v1/repos/{repoId}/backups/{backupId}` — retention, one row at a time. */
export function deleteRemoteBackup(
  endpoint: CloudEndpoint,
  args: RepoCall & { backupId: string },
  options: RequestOptions = {},
): Promise<{ deleted: boolean }> {
  return request({
    ...options,
    endpoint,
    path:
      `/v1/repos/${encodeURIComponent(args.repositoryId)}` +
      `/backups/${encodeURIComponent(args.backupId)}`,
    method: "DELETE",
    token: args.token,
    deviceId: args.deviceId,
  });
}

/** One turn of the resumable restore. */
export interface RestoreProgress {
  restoreId: string;
  status: string;
  done: boolean;
  fromEpoch?: number;
  toEpoch?: number;
  epoch?: number;
  entityCount: number;
  staged: number;
  preRestoreBackupId?: string;
}

/**
 * `POST /v1/repos/{repoId}/backups/{backupId}/restore` — one turn.
 *
 * Resumable by design, and called in a loop until `done`. The first turn omits
 * `restoreId` and the server allocates one; every later turn passes the one it
 * was given back. `confirm` carries the repository id on EVERY turn, so a loop
 * that somehow escaped its command still cannot advance a restore against a
 * repository it was not told the id of.
 *
 * Why a loop rather than one call: staging N entities costs N+1 D1 queries
 * against a free-plan ceiling of 50, so a single-shot restore would work on a
 * demonstration repository and fail permanently on a real one.
 */
export function advanceRemoteRestore(
  endpoint: CloudEndpoint,
  args: RepoCall & { backupId: string; restoreId: string | null; actor: string | null },
  options: RequestOptions = {},
): Promise<RestoreProgress> {
  const body: Record<string, unknown> = { confirm: args.repositoryId };
  if (args.restoreId !== null) body.restoreId = args.restoreId;
  if (args.actor !== null) body.actor = args.actor;
  return request({
    ...options,
    endpoint,
    path:
      `/v1/repos/${encodeURIComponent(args.repositoryId)}` +
      `/backups/${encodeURIComponent(args.backupId)}/restore`,
    method: "POST",
    token: args.token,
    deviceId: args.deviceId,
    body,
  });
}
