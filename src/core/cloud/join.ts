/**
 * `staple cloud join`: everything that happens AFTER consent, and nothing before it.
 *
 * The split mirrors `preview.ts` / `connect.ts`. Every entry point here takes a
 * {@link JoinPreview} that was already built, shown and agreed to, and `join-preview.ts`
 * cannot reach the client. So "no network call before yes" is a property of the import
 * graph.
 *
 * ## The shape of a join
 *
 *   1. mint the device id (local)
 *   2. `GET /v1/capabilities`, the first call that leaves the machine, refusing a
 *      service that does not do member approval
 *   3. generate a 256-bit request secret, IN MEMORY ONLY, and send its SHA-256 with
 *      `POST /join-requests`. The service answers with a request id and a short code
 *   4. show the code; someone already in the workspace approves it
 *   5. poll `GET /join-requests/{id}` with the secret as the bearer, backing off, until it
 *      is approved, denied or expired, or the person cancels. Cancelling is local: the
 *      request expires on the service by itself, and nothing needs to be told
 *   6. the first read after approval carries the device token, exactly once. Store it,
 *      then write the connection record, the same order and the same consents as
 *      `performConnect`: automatic sync, backup and registry all OFF
 *   7. write the member list, best effort
 *
 * The secret never touches disk. A process that dies while waiting loses it, and the
 * request expires unused on the service. That is the safe failure: a secret written to
 * disk to survive a crash would be a bearer for a device token lying in a file.
 *
 * ## Why start / poll / complete are separate
 *
 * The CLI runs them back to back ({@link performJoin}). The web UI cannot: its local
 * server answers the page with the code and keeps polling between requests. So the
 * {@link JoinTicket} is a plain object the caller holds in memory between steps.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  CLIENT_PROTOCOL,
  cloudCodeOf,
  cloudError,
  createJoinRequest,
  fetchCapabilities,
  readJoinRequest,
  type Capabilities,
  type JoinRequestState,
  type RequestOptions,
} from "./client.js";
import { CONNECTION_SCHEMA_VERSION, writeConnection, type CloudConnection } from "./connection.js";
import { selectCredentialStore, type SelectOptions } from "./credential-store.js";
import { ensureDeviceId } from "./device.js";
import type { CloudEndpoint } from "./endpoint.js";
import type { JoinPreview } from "./join-preview.js";
import { refreshMembersCacheBestEffort } from "./members.js";
import type { MembersCache } from "./members-cache.js";
import { StapleError } from "../types.js";

/** `Retry-After` in milliseconds, when the refusal carried one as delta-seconds. */
function retryAfterMs(error: unknown): number | null {
  const raw = error instanceof StapleError ? error.detail?.retryAfter : undefined;
  const text = typeof raw === "string" || typeof raw === "number" ? String(raw).trim() : "";
  return /^\d+$/.test(text) ? Number(text) * 1000 : null;
}

/** A join in flight. Holds the request secret, so it lives in memory and nowhere else. */
export interface JoinTicket {
  readonly endpoint: CloudEndpoint;
  readonly repositoryId: string;
  readonly label: string;
  /** This machine's device id, minted at {@link startJoin}. */
  readonly deviceId: string;
  readonly requestId: string;
  /** `XXXX-XXXX`, to be read out and compared. Grants nothing on its own. */
  readonly code: string;
  /** Epoch milliseconds. Moves when the service resets it (an approval does). */
  expiresAt: number;
  readonly capabilities: Capabilities;
  /** The bearer for reading this request. Never logged, never written, never returned in JSON. */
  readonly requestSecret: string;
}

export interface StartJoinArgs extends RequestOptions {
  home: string;
}

/**
 * Steps 1–3: mint the device id, check the service, create the request.
 *
 * Called only after a person said yes to the preview.
 */
export async function startJoin(preview: JoinPreview, args: StartJoinArgs): Promise<JoinTicket> {
  const deviceId = ensureDeviceId(args.home);
  const capabilities = await fetchCapabilities(preview.endpoint, args);
  if (capabilities.members !== true) {
    throw cloudError(
      "forbidden",
      `${preview.endpoint.origin} does not support joining by approval yet. Whoever runs that ` +
        "service has to deploy the newer Worker first. Nothing was sent apart from the capabilities check.",
      { members: "unsupported" },
    );
  }
  const requestSecret = randomBytes(32).toString("hex");
  const requestSecretSha256 = createHash("sha256").update(requestSecret, "utf8").digest("hex");
  let created;
  try {
    created = await createJoinRequest(
      preview.endpoint,
      { repositoryId: preview.repositoryId, deviceId, label: preview.label, requestSecretSha256 },
      args,
    );
  } catch (error) {
    throw explainCreateRefusal(error, preview.endpoint.origin);
  }
  return {
    endpoint: preview.endpoint,
    repositoryId: preview.repositoryId,
    label: preview.label,
    deviceId,
    requestId: created.requestId,
    code: created.code,
    expiresAt: created.expiresAt,
    capabilities,
    requestSecret,
  };
}

/** One read of the request. Moves the ticket's expiry when the service moved it. */
export async function pollJoin(ticket: JoinTicket, options: RequestOptions = {}): Promise<JoinRequestState> {
  const state = await readJoinRequest(
    ticket.endpoint,
    { repositoryId: ticket.repositoryId, requestId: ticket.requestId, requestSecret: ticket.requestSecret },
    options,
  );
  if (state.expiresAt !== null) ticket.expiresAt = state.expiresAt;
  return state;
}

export interface JoinedOutcome {
  readonly status: "joined";
  readonly connection: CloudConnection;
  readonly member: { memberId: string; name: string } | null;
  readonly recordPath: string;
  /** Where the credential went, in words. Never the credential. */
  readonly credentialLocation: string;
  /** The member list written after joining, or null when it could not be fetched. */
  readonly members: MembersCache | null;
}

export interface CancelledOutcome {
  readonly status: "cancelled";
  readonly code: string;
  /** When the abandoned request expires on the service by itself. Epoch milliseconds. */
  readonly expiresAt: number;
}

export type JoinOutcome = JoinedOutcome | CancelledOutcome;

export interface CompleteJoinArgs extends RequestOptions {
  home: string;
  credential?: SelectOptions;
}

/**
 * Steps 6–7: store the credential, write the connection record, write the member list.
 *
 * `state` must be the approved read that carried the token. That read was the only one
 * that ever will, so the token is stored before anything else can fail.
 */
export async function completeJoin(
  ticket: JoinTicket,
  state: JoinRequestState,
  args: CompleteJoinArgs,
): Promise<JoinedOutcome> {
  if (state.status !== "approved" || state.token === undefined) {
    throw new StapleError("validation", "completeJoin needs the approved read that carried the credential.");
  }
  // Re-selected, as in `performConnect`: a keychain can lock while a person was approving.
  const selection = selectCredentialStore(args.home, args.credential ?? {});
  selection.store.write(ticket.repositoryId, state.token);

  const deviceId = state.deviceId ?? ticket.deviceId;
  const connection: CloudConnection = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    repositoryId: ticket.repositoryId,
    endpoint: ticket.endpoint.origin,
    deviceId,
    label: ticket.label,
    credentialMechanism: selection.store.mechanism,
    connectedAt: new Date().toISOString(),
    // All three consents OFF, for exactly the reasons `performConnect` gives: joining
    // stores a credential, and agreeing to use it in the background is a separate decision.
    auto: false,
    backup: false,
    registry: false,
    protocol: state.protocol ?? Math.min(CLIENT_PROTOCOL, ticket.capabilities.protocol.max),
  };
  const recordPath = writeConnection(args.home, connection);

  const members = await refreshMembersCacheBestEffort(
    args.home,
    { endpoint: ticket.endpoint, repositoryId: ticket.repositoryId, token: state.token, deviceId },
    args,
  );

  return {
    status: "joined",
    connection,
    member: state.member ?? null,
    recordPath,
    credentialLocation:
      selection.store.mechanism === "file" ? `a 0600 file in ${args.home}/cloud` : selection.store.mechanism,
    members,
  };
}

/** The first wait, the factor it grows by, and the longest single wait. */
export const JOIN_POLL_INITIAL_MS = 2_000;
export const JOIN_POLL_FACTOR = 1.5;
export const JOIN_POLL_MAX_MS = 10_000;
/** How long past the service's expiry this side keeps asking before calling it expired. */
const EXPIRY_GRACE_MS = 30_000;

export interface WaitForJoinArgs extends RequestOptions {
  /** Ctrl-C. Cancels locally; the service is not told and needs no telling. */
  signal?: AbortSignal;
  /** The clock expiry is measured against. Injected in tests. */
  now?: () => number;
  /** Told before each wait, so a surface can say what it is waiting for. */
  onWait?: (state: JoinRequestState | null, nextPollMs: number) => void;
}

/**
 * Step 5: poll until the request is decided, backing off from two seconds to ten.
 *
 * Resolves with the approved read that carries the token, or `null` when cancelled.
 * Throws `forbidden` (detail `joinStatus: "denied"`) when denied and `not_found`
 * (`joinStatus: "expired"`) when expired. Transient failures (`offline`, `unavailable`,
 * `rate_limited`) are waited out, because a dropped connection while someone is reaching
 * for the approve button should not throw the request away. Any other failure stops it.
 */
export async function waitForJoin(ticket: JoinTicket, args: WaitForJoinArgs = {}): Promise<JoinRequestState | null> {
  const now = args.now ?? Date.now;
  const sleep = args.sleep ?? abortableSleep(args.signal);
  let delay = JOIN_POLL_INITIAL_MS;
  let last: JoinRequestState | null = null;

  for (;;) {
    if (args.signal?.aborted) return null;
    if (now() > ticket.expiresAt + EXPIRY_GRACE_MS) throw expired(ticket);

    args.onWait?.(last, delay);
    await sleep(delay);
    if (args.signal?.aborted) return null;

    let state: JoinRequestState;
    try {
      state = await pollJoin(ticket, args);
    } catch (error) {
      const code = cloudCodeOf(error);
      if (code === "offline" || code === "unavailable" || code === "rate_limited") {
        const asked = retryAfterMs(error) ?? 0;
        delay = Math.min(Math.max(nextDelay(delay), asked), 60_000);
        continue;
      }
      throw error;
    }
    last = state;

    switch (state.status) {
      case "approved":
        if (state.token !== undefined) return state;
        throw alreadyCollected(ticket);
      case "collected":
        throw alreadyCollected(ticket);
      case "denied":
        throw cloudError(
          "forbidden",
          `Join request ${ticket.code} was denied. Nothing was stored on this machine. If that was a ` +
            "mistake, run `staple cloud join` again and compare the new code with them.",
          { joinStatus: "denied", code: ticket.code },
        );
      case "expired":
        throw expired(ticket);
      case "pending":
        delay = nextDelay(delay);
        break;
    }
  }
}

export interface PerformJoinArgs extends WaitForJoinArgs {
  home: string;
  credential?: SelectOptions;
  /** Called once the service has issued the code, so the caller can show it. */
  onCode?: (ticket: JoinTicket) => void;
}

/** The whole join, start to finish, for a caller that can wait: the CLI. */
export async function performJoin(preview: JoinPreview, args: PerformJoinArgs): Promise<JoinOutcome> {
  const ticket = await startJoin(preview, args);
  args.onCode?.(ticket);
  const approved = await waitForJoin(ticket, args);
  if (approved === null) return { status: "cancelled", code: ticket.code, expiresAt: ticket.expiresAt };
  return completeJoin(ticket, approved, args);
}

function nextDelay(delay: number): number {
  return Math.min(Math.round(delay * JOIN_POLL_FACTOR), JOIN_POLL_MAX_MS);
}

function expired(ticket: JoinTicket): StapleError {
  return cloudError(
    "not_found",
    `Join request ${ticket.code} expired before anyone approved it (requests live ten minutes). ` +
      "Nothing was stored on this machine. Run `staple cloud join` again for a new code.",
    { joinStatus: "expired", code: ticket.code },
  );
}

function alreadyCollected(ticket: JoinTicket): StapleError {
  return cloudError(
    "conflict",
    `Join request ${ticket.code} was approved, but its credential was already handed out and this ` +
      "process never received it. The service hands it out once. Ask the approver to revoke device " +
      `${ticket.deviceId} (\`staple cloud devices revoke ${ticket.deviceId}\`), then run ` +
      "`staple cloud join` again.",
    { joinStatus: "collected", code: ticket.code, deviceId: ticket.deviceId },
  );
}

/**
 * The service refused to create the request, as a sentence about joining rather than about
 * an HTTP route.
 */
function explainCreateRefusal(error: unknown, origin: string): unknown {
  if (!(error instanceof StapleError)) return error;
  const code = cloudCodeOf(error);
  if (code === "forbidden") {
    return cloudError(
      "forbidden",
      `${origin} does not accept join requests for this repository (${error.message}). Either it is ` +
        "not provisioned there, nobody has connected it yet (the first device connects with " +
        "`staple cloud connect` and becomes the owner), or the endpoint is the wrong one.",
      { ...error.detail, serverMessage: error.message },
    );
  }
  if (code === "rate_limited" && error.detail?.pendingCap !== undefined) {
    return cloudError(
      "rate_limited",
      `This repository already has ${String(error.detail.pendingCap)} pending join requests. Ask a ` +
        "member to approve or deny them (`staple cloud requests`), or wait for them to expire.",
      { ...error.detail, serverMessage: error.message },
    );
  }
  return error;
}

function abortableSleep(signal: AbortSignal | undefined): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve();
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    });
}
