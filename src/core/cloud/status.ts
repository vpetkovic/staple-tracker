/**
 * What state is this repository's cloud connection in?
 *
 * Contract: `docs/sync.md`, "Three consents" — what a surface may do at each
 * stage, and the acceptance criterion that human and JSON status must
 * distinguish disconnected, manual, automatic, offline, revoked and
 * authentication-failed.
 *
 * ## The default is LOCAL, and that is the whole point of this file
 *
 * `staple cloud status` reads three files and returns. It resolves no hostname,
 * opens no socket and calls no `fetch`. *"Before connect — render 'not
 * connected' and a static hint naming `staple cloud connect`. Static text. No
 * probe, no reachability check."*
 *
 * A status command that pings is the single most likely way this invariant dies,
 * because pinging is such an obviously helpful thing for a status command to do.
 * So the reachability states are not something {@link localCloudStatus} can ever
 * return: three of the six states are unreachable from it by construction, and
 * only {@link refreshCloudStatus} — which exists because `--refresh` was typed —
 * can produce them.
 *
 * ## Why the probe is `GET /devices` and not a health endpoint
 *
 * The three states a refresh has to tell apart are "the network is down",
 * "this device was revoked" and "this credential is not valid". Only an
 * authenticated route distinguishes them: `/v1/capabilities` takes no credential
 * and answers 200 for a revoked device just as happily as for a live one.
 * `GET /devices` is authenticated, is a read, mutates nothing, and returns
 * something worth having anyway.
 */
import { connectionIsPrivate, readConnection } from "./connection.js";
import type { CredentialMechanism } from "./credential-store.js";
import { credentialStoreFor, fileCredentialIsPrivate } from "./credential-store.js";
import { cloudCodeOf, listRemoteDevices, type RemoteDevice, type RequestOptions } from "./client.js";
import { parseEndpoint } from "./endpoint.js";

export type CloudState =
  /** No connection record on this machine. Nothing to sync, nothing stored. */
  | "disconnected"
  /** Connected. Only `staple cloud sync` moves anything. The default, always. */
  | "manual"
  /** Connected, and this DEVICE has separately consented to automatic sync. */
  | "automatic"
  /** Connected, but the endpoint could not be reached. Local work continues. */
  | "offline"
  /** The server says this device was revoked. Re-connect is the remedy. */
  | "revoked"
  /** The credential was rejected, or there is no credential to present. */
  | "auth_failed";

export interface CloudStatus {
  readonly state: CloudState;
  readonly repositoryId: string;
  /** Null when disconnected — there is no endpoint until there is a connection. */
  readonly endpoint: string | null;
  readonly deviceId: string | null;
  readonly label: string | null;
  readonly credentialMechanism: CredentialMechanism | null;
  /** Whether a credential is actually retrievable, not merely recorded. */
  readonly credentialPresent: boolean;
  /** Per-device consent flags. Both false on a fresh connection. */
  readonly auto: boolean;
  readonly backup: boolean;
  readonly connectedAt: string | null;
  /** true when this status reflects a live probe rather than local files alone. */
  readonly checked: boolean;
  /**
   * Things a human should know that are not the state: a credential file that
   * has been widened, a recorded mechanism that no longer answers. Empty is the
   * normal case, and an empty array is not a reason to print a heading.
   */
  readonly warnings: readonly string[];
  /** Populated only by a refresh that succeeded. */
  readonly devices: readonly RemoteDevice[] | null;
}

function disconnected(repositoryId: string): CloudStatus {
  return {
    state: "disconnected",
    repositoryId,
    endpoint: null,
    deviceId: null,
    label: null,
    credentialMechanism: null,
    credentialPresent: false,
    auto: false,
    backup: false,
    connectedAt: null,
    checked: false,
    warnings: [],
    devices: null,
  };
}

export interface LocalStatusOptions {
  platform?: NodeJS.Platform;
  /** Injected in tests so no real keychain is consulted. */
  credentialStore?: { read(repositoryId: string): string | null; mechanism: CredentialMechanism };
}

/**
 * The state from local files alone. **Makes no network call, ever.**
 *
 * Can only ever return `disconnected`, `manual`, `automatic` or `auth_failed` —
 * and `auth_failed` only in the one case that is locally decidable: a connection
 * record exists but the credential it points at is gone, which happens when a
 * keychain item is deleted out from under staple or a `0600` file is removed by
 * hand. That is genuinely "there is no credential to present", and it needs no
 * server to establish.
 */
export function localCloudStatus(
  home: string,
  repositoryId: string,
  options: LocalStatusOptions = {},
): CloudStatus {
  const connection = readConnection(home, repositoryId);
  if (!connection) return disconnected(repositoryId);

  const warnings: string[] = [];
  const store =
    options.credentialStore ??
    credentialStoreFor(home, connection.credentialMechanism, { platform: options.platform });

  let credential: string | null = null;
  try {
    credential = store.read(repositoryId);
  } catch (error) {
    warnings.push(
      `The ${connection.credentialMechanism} credential store did not answer ` +
        `(${error instanceof Error ? error.message : "unknown error"}). The credential may still ` +
        `be there; this machine could not ask.`,
    );
  }

  if (connection.credentialMechanism === "file") {
    if (fileCredentialIsPrivate(home, repositoryId, options.platform) === false) {
      warnings.push(
        "The credential file is readable by users other than you. Run " +
          "`chmod 600` on it, and treat the credential as disclosed: revoke this device with " +
          "`staple cloud devices revoke` and re-connect.",
      );
    }
  }
  if (connectionIsPrivate(home, repositoryId, options.platform) === false) {
    warnings.push("The connection record is readable by other users on this machine.");
  }

  const state: CloudState = credential === null ? "auth_failed" : connection.auto ? "automatic" : "manual";

  return {
    state,
    repositoryId,
    endpoint: connection.endpoint,
    deviceId: connection.deviceId,
    label: connection.label,
    credentialMechanism: connection.credentialMechanism,
    credentialPresent: credential !== null,
    auto: connection.auto,
    backup: connection.backup,
    connectedAt: connection.connectedAt,
    checked: false,
    warnings,
    devices: null,
  };
}

/**
 * The state after one authenticated round trip. **Only `--refresh` gets here.**
 *
 * Every failure is mapped to a state rather than thrown, because "the network is
 * down" is a status, not an error — a `staple cloud status --refresh` on a train
 * should print `offline` and exit 0, not fail. A failure that is not one of the
 * three known conditions keeps the local state and adds a warning, so an
 * unrecognised server response cannot silently be read as "everything is fine".
 */
export async function refreshCloudStatus(
  home: string,
  repositoryId: string,
  options: LocalStatusOptions & RequestOptions = {},
): Promise<CloudStatus> {
  const local = localCloudStatus(home, repositoryId, options);
  if (local.state === "disconnected") return local;
  if (!local.credentialPresent || local.endpoint === null || local.deviceId === null) {
    // Nothing to present, so there is nothing to ask. Refusing to make the call
    // is not an optimization: sending an empty bearer would be a real request to
    // a real endpoint on behalf of a credential we know is missing.
    return { ...local, state: "auth_failed", checked: true };
  }

  const store =
    options.credentialStore ??
    credentialStoreFor(home, local.credentialMechanism!, { platform: options.platform });
  const token = store.read(repositoryId);
  if (token === null) return { ...local, state: "auth_failed", checked: true };

  try {
    const devices = await listRemoteDevices(
      parseEndpoint(local.endpoint),
      { repositoryId, token, deviceId: local.deviceId },
      options,
    );
    return { ...local, checked: true, devices };
  } catch (error) {
    const code = cloudCodeOf(error);
    if (code === "offline" || code === "unavailable" || code === "rate_limited") {
      return { ...local, state: "offline", checked: true };
    }
    if (code === "revoked") return { ...local, state: "revoked", checked: true };
    if (code === "auth" || code === "forbidden") {
      return { ...local, state: "auth_failed", checked: true };
    }
    return {
      ...local,
      checked: true,
      warnings: [
        ...local.warnings,
        `The endpoint answered with an unexpected error (${code ?? "unknown"}); the state below ` +
          `is what this machine believes locally and was not confirmed.`,
      ],
    };
  }
}

/** One line a human reads, for each state. The JSON carries the same `state` string. */
export function describeState(status: CloudStatus): string {
  switch (status.state) {
    case "disconnected":
      return "not connected — no credential, no endpoint and no cloud state on this machine";
    case "manual":
      return "connected, manual — nothing synchronizes until you run `staple cloud sync`";
    case "automatic":
      return "connected, automatic — this device syncs on its own bounded triggers";
    case "offline":
      return "connected, but the endpoint could not be reached — local work is unaffected";
    case "revoked":
      return "this device was revoked — re-connect with `staple cloud connect` to get a new credential";
    case "auth_failed":
      return "the credential was rejected or is missing — re-connect with `staple cloud connect`";
  }
}
