/**
 * Everything that happens AFTER consent, and nothing that happens before it.
 *
 * The split between this file and `preview.ts` is the acceptance criterion
 * *"Connect performs no remote mutation before showing the target service,
 * repository identity and requesting consent"* expressed as an import graph:
 * `preview.ts` cannot reach `client.ts`, and every function in this file takes
 * an already-built, already-shown, already-agreed-to {@link ConnectPreview} as
 * its first argument. There is no entry point here that can be called without
 * one.
 */
import { connectDevice, fetchCapabilities, purgeRemoteRepository, revokeRemoteDevice, listRemoteDevices, type Capabilities, type RemoteDevice, type RequestOptions } from "./client.js";
import { CONNECTION_SCHEMA_VERSION, deleteConnection, readConnection, writeConnection, type CloudConnection } from "./connection.js";
import { credentialStoreFor, selectCredentialStore, type SelectOptions } from "./credential-store.js";
import { ensureDeviceId } from "./device.js";
import { parseEndpoint } from "./endpoint.js";
import { StapleError } from "../types.js";
import type { ConnectPreview } from "./preview.js";

export interface ConnectOutcome {
  readonly connection: CloudConnection;
  readonly capabilities: Capabilities;
  /** Where the connection record was written. Never contains the token. */
  readonly recordPath: string;
  /** Where the credential went, in words. Never the credential. */
  readonly credentialLocation: string;
}

export interface PerformConnectArgs extends RequestOptions {
  home: string;
  /** The enrollment credential: an existing device token, or the enrollment secret. */
  enrollmentSecret: string;
  credential?: SelectOptions;
}

/**
 * Do the connection. Called only once a human has said yes to `preview`.
 *
 * The order matters and is not arbitrary:
 *
 *   1. mint the device id — local, and needed before the server can be told one
 *   2. `GET /v1/capabilities` — the negotiated protocol, and the first call that
 *      leaves this machine at all
 *   3. `POST /connect` — the mutation, and the only one
 *   4. store the credential
 *   5. write the connection record
 *
 * Capabilities is fetched here, after consent, rather than during the preview,
 * even though it is a read and takes no credential. The contract forbids remote
 * *mutation* before consent, but the network rule counts *attempted calls* —
 * *"A DNS lookup that fails is a violation"* — so a capabilities probe used to
 * decorate the preview would resolve a hostname the human had not yet agreed to
 * contact. Two rules, and this ordering is the one that satisfies the stricter
 * reading of both.
 *
 * Steps 4 and 5 are in that order because the record is what makes the
 * credential findable. A record written before the credential was stored would,
 * if the store then failed, describe a connection whose secret is nowhere — and
 * `status` would report `auth_failed` for a device the server thinks is live.
 * Storing first and recording second means the failure mode is an orphaned
 * server-side device row, which `staple cloud devices` shows and
 * `staple cloud devices revoke` clears.
 */
export async function performConnect(
  preview: ConnectPreview,
  args: PerformConnectArgs,
): Promise<ConnectOutcome> {
  if (args.enrollmentSecret.trim().length === 0) {
    throw new StapleError(
      "validation",
      "An enrollment credential is required. Pass --token with either this repository's " +
        "enrollment secret (for the first machine) or an existing device token from a machine " +
        "that is already connected. Repositories are provisioned out of band; see worker/README.md.",
    );
  }

  const deviceId = ensureDeviceId(args.home);

  const capabilities = await fetchCapabilities(preview.endpoint, args);

  const result = await connectDevice(
    preview.endpoint,
    {
      repositoryId: preview.repositoryId,
      enrollmentSecret: args.enrollmentSecret,
      deviceId,
      label: preview.label,
    },
    args,
  );

  /**
   * Re-select rather than trusting the preview's mechanism. The preview probed
   * the store a moment ago; between then and now a human answered a prompt,
   * which on macOS is exactly long enough for a keychain to lock. Re-selecting
   * means the worst case is a fallback to the `0600` file, not a thrown
   * exception holding a freshly minted credential that is about to be lost.
   */
  const selection = selectCredentialStore(args.home, args.credential ?? {});
  selection.store.write(preview.repositoryId, result.token);

  const connection: CloudConnection = {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    repositoryId: preview.repositoryId,
    endpoint: preview.endpoint.origin,
    deviceId: result.deviceId,
    label: preview.label,
    credentialMechanism: selection.store.mechanism,
    connectedAt: new Date().toISOString(),
    /**
     * FALSE. Both of them, always, on every connection including a re-connect.
     *
     * *"A successful connection leaves sync manual. Manual is the default and
     * stays the default."* This is not read from the previous record on a
     * re-connect either: a re-connect happens because something went wrong with
     * the credential, and inheriting an automatic-sync consent across that event
     * would silently resume background traffic at the exact moment a human was
     * repairing a trust problem.
     */
    auto: false,
    backup: false,
    protocol: result.protocol,
  };

  const recordPath = writeConnection(args.home, connection);

  return {
    connection,
    capabilities,
    recordPath,
    credentialLocation: selection.store.mechanism === "file" ? `a 0600 file in ${args.home}/cloud` : selection.store.mechanism,
  };
}

export interface DisconnectOutcome {
  readonly wasConnected: boolean;
  readonly credentialRemoved: boolean;
  readonly recordRemoved: boolean;
}

/**
 * `staple cloud disconnect` — local, and only local.
 *
 * *"Disconnect is local. It removes this device's credential, stops all later
 * cloud traffic, and preserves the entire local database including pending
 * outbox operations. Remote state is untouched, other devices are unaffected."*
 *
 * So: **no network call**. Not even a courtesy "please forget me" to the server.
 * Telling the server would make disconnect fail when the server is unreachable,
 * and a person who has decided to stop talking to a service must not need that
 * service's permission to stop. Revoking the device server-side is a different,
 * separately named operation, and `staple cloud devices revoke` is where it
 * lives.
 *
 * Nothing here touches the workspace database. `sync_outbox` keeps its pending
 * operations, `sync_state` keeps its cursor, and a later re-connect resumes from
 * them or re-bootstraps.
 */
export function performDisconnect(
  home: string,
  repositoryId: string,
  options: SelectOptions = {},
): DisconnectOutcome {
  const connection = readConnection(home, repositoryId);
  if (!connection) {
    return { wasConnected: false, credentialRemoved: false, recordRemoved: false };
  }

  let credentialRemoved = false;
  try {
    credentialStoreFor(home, connection.credentialMechanism, options).delete(repositoryId);
    credentialRemoved = true;
  } catch {
    /**
     * A keychain that will not answer must not prevent the disconnect. The
     * record goes anyway, so no later command can find an endpoint to talk to —
     * which is what "stops all later cloud traffic" actually requires. The
     * caller is told the credential may still be in the keychain, so a human can
     * remove it, and revoking the device is the belt-and-braces remedy.
     */
    credentialRemoved = false;
  }

  const recordRemoved = deleteConnection(home, repositoryId);
  return { wasConnected: true, credentialRemoved, recordRemoved };
}

/** The state a device-scoped remote call needs, gathered and checked in one place. */
interface RemoteSession {
  connection: CloudConnection;
  token: string;
}

function requireSession(home: string, repositoryId: string, options: SelectOptions = {}): RemoteSession {
  const connection = readConnection(home, repositoryId);
  if (!connection) {
    throw new StapleError(
      "not_found",
      "This repository is not connected on this machine. Run `staple cloud connect` first.",
    );
  }
  const token = credentialStoreFor(home, connection.credentialMechanism, options).read(repositoryId);
  if (token === null) {
    throw new StapleError(
      "validation",
      `The connection record names a ${connection.credentialMechanism} credential that is not ` +
        `there. Re-connect with \`staple cloud connect\` to mint a new one.`,
    );
  }
  return { connection, token };
}

/** `staple cloud devices` — the server's list, which is the authority. */
export async function fetchDevices(
  home: string,
  repositoryId: string,
  options: RequestOptions & SelectOptions = {},
): Promise<RemoteDevice[]> {
  const { connection, token } = requireSession(home, repositoryId, options);
  return listRemoteDevices(
    parseEndpoint(connection.endpoint),
    { repositoryId, token, deviceId: connection.deviceId },
    options,
  );
}

export interface RevokeOutcome {
  readonly deviceId: string;
  readonly revoked: boolean;
  /** true when the device revoked was this one — which ends this device's access. */
  readonly self: boolean;
}

/**
 * `staple cloud devices revoke <id>`.
 *
 * Takes effect on the target's very next request and disturbs nobody else,
 * because the Worker checks membership per request and the statement is scoped
 * to one `(repo_id, device_id)` row.
 *
 * Revoking THIS device is allowed and is a real thing to want — a stolen laptop
 * is revoked from the laptop you still have, and a machine you are
 * decommissioning is revoked from itself. It is reported rather than refused,
 * and the local credential is deliberately left in place: it is already useless,
 * and deleting it here would conflate revoke with disconnect, which are exactly
 * the two operations this contract insists on keeping apart.
 */
export async function performRevoke(
  home: string,
  repositoryId: string,
  targetDeviceId: string,
  options: RequestOptions & SelectOptions = {},
): Promise<RevokeOutcome> {
  const { connection, token } = requireSession(home, repositoryId, options);
  const result = await revokeRemoteDevice(
    parseEndpoint(connection.endpoint),
    { repositoryId, token, deviceId: connection.deviceId, targetDeviceId },
    options,
  );
  return { deviceId: result.deviceId, revoked: result.revoked, self: targetDeviceId === connection.deviceId };
}

/**
 * What `staple cloud purge` prints BEFORE it will accept a confirmation.
 *
 * *"It requires typed confirmation, prints a retention disclosure first — what
 * is stored, where, for how long, and who can read it — and does not touch the
 * local database."*
 *
 * Every claim here is one this build can actually stand behind, which is why the
 * retention line says what it says: the Worker keeps the operation log until
 * something deletes it, and there is no expiry job. Writing "retained for 30
 * days" because it sounds reassuring would be inventing a policy that no code
 * enforces.
 */
export function retentionDisclosure(endpoint: string, repositoryId: string): string {
  return [
    "Remote purge — read this before confirming.",
    "",
    `  service        ${endpoint}`,
    `  repository     ${repositoryId}`,
    "",
    "What is stored there:",
    "  - the full ordered operation log for this repository: every issue title, description,",
    "    comment body and document revision that has ever been synchronized, in PLAINTEXT",
    "  - the device list for this repository, with each device's label and its credential HASH",
    "    (the credentials themselves are not stored, only SHA-256 digests of them)",
    "  - leases: which device holds which claim, and until when",
    "",
    "How long:",
    "  - indefinitely. There is no expiry and no retention window; the log is kept until",
    "    something deletes it, which is what this command is for.",
    "",
    "Who can read it:",
    "  - whoever holds the Cloudflare account that operates that endpoint. There is no",
    "    end-to-end encryption in this release.",
    "",
    "What purging does:",
    "  - deletes the remote operation log, materialized state and backups for this repository",
    "  - does NOT touch your local database. Nothing on this machine is deleted.",
    "  - every other device's next request fails `not_found`. They keep their local state.",
    "  - this is not reversible.",
  ].join("\n");
}

export interface PurgeOutcome {
  readonly purged: boolean;
  /** Set when the endpoint has no purge route, so nothing was destroyed. */
  readonly unsupported: boolean;
}

/**
 * `staple cloud purge` — the remote half, once the disclosure has been printed
 * and the typed confirmation matched.
 *
 * DIVERGENCE, and it is the material one in this lane: **the deployed Worker
 * does not implement `DELETE /v1/repos/{repoId}`.** `worker/README.md` says
 * purge belongs to the restore lane, so the router answers `not_found`.
 *
 * That is reported as `unsupported`, not as success and not as a generic error.
 * The local credential is deliberately NOT removed on that path: a human who
 * asked to destroy remote state and had it silently not happen must not also
 * lose the credential that is the only way to try again or to check.
 */
export async function performPurge(
  home: string,
  repositoryId: string,
  options: RequestOptions & SelectOptions = {},
): Promise<PurgeOutcome> {
  const { connection, token } = requireSession(home, repositoryId, options);
  try {
    const result = await purgeRemoteRepository(
      parseEndpoint(connection.endpoint),
      { repositoryId, token, deviceId: connection.deviceId },
      options,
    );
    return { purged: result.purged !== false, unsupported: false };
  } catch (error) {
    if (error instanceof StapleError && error.code === "not_found") {
      return { purged: false, unsupported: true };
    }
    throw error;
  }
}
