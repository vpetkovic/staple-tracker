/**
 * `staple cloud backup` and `staple cloud restore` — the client half.
 *
 * Contract: `docs/sync.md`, "Backup, disconnect and purge are three different
 * things", and the "Three consents" table.
 *
 * ## Backup is a third consent, and this module is where that is enforced
 *
 * Connecting stores a credential. `auto on` agrees to use it without being asked.
 * Backup agrees to something else again: that a copy of this repository's
 * contents may be made and kept, as a point-in-time export, separately from
 * anything convergence needs. None of the three implies another, and the one
 * that matters here is that **neither of the other two can turn this one on**.
 *
 * That is enforced structurally rather than by review. `connection.backup` has
 * exactly one writer in the whole tree — {@link setBackupConsent} below, reached
 * only from `staple cloud backup enable|disable` — and every other entry point in
 * this file begins by calling {@link requireBackupConsent}. `connect` writes
 * `backup: false` on a fresh record and `setConsent` patches `auto` and `backup`
 * independently, so there is no code path on which agreeing to one produces the
 * other.
 *
 * ## Backup does not touch convergence, and that is a property of what is absent
 *
 * Nothing in this module reads or writes `sync_state`, `sync_outbox`,
 * `sync_applied` or any cursor — with exactly one exception, and it is the
 * restore, which announces itself by moving the epoch. Creating, listing and
 * deleting a backup open no workspace database at all. They cannot change
 * convergence state because they have nothing to change it with.
 *
 * ## Restore, and the thing that would quietly destroy a repository
 *
 * The server materialises the backup into a new epoch and then moves onto it;
 * `worker/src/backups.ts` explains why that ordering is the only safe one. What
 * this side owes is the local consequence: this device is now on an epoch whose
 * log it has never read, so it must re-bootstrap.
 *
 * {@link beginBootstrap} is what does that, and what it deliberately does NOT do
 * is the whole point. It clears `sync_applied` and the cursor, and it leaves
 * `sync_state.client_seq_high_water` and every pending `sync_outbox` row exactly
 * where they were.
 *
 * Resetting that counter is the documented route to silent data loss.
 * Operation ids are `sha256(repoId, epoch, deviceId, clientSeq)` and the dedupe
 * index is `(repo_id, epoch, op_id)`. A device that rewound its counter after a
 * restore would re-mint ids it had already used in this epoch; the server would
 * answer `duplicate` and hand back the seq of the ORIGINAL operation; the client
 * would read that as an acknowledgement and mark genuinely new work as sent. The
 * work would be gone, with no error anywhere. So this module calls
 * `beginBootstrap` and never touches the counter itself, and
 * `test/cloud-backup-restore.test.ts` pins that.
 */
import type { DatabaseSync } from "node:sqlite";
import { StapleError, errorEnvelope, type ErrorEnvelope } from "../types.js";
import { WORKSPACE_SCHEMA_VERSION } from "../schema.js";
import {
  type RemoteBackup,
  type RequestOptions,
  advanceRemoteRestore,
  cloudError,
  createRemoteBackup,
  deleteRemoteBackup,
  listRemoteBackups,
  setRemoteBackupConsent,
} from "./client.js";
import { requireSession } from "./connect.js";
import { type CloudConnection, readConnection, setConsent } from "./connection.js";
import type { SelectOptions } from "./credential-store.js";
import { parseEndpoint } from "./endpoint.js";
import { beginBootstrap, readSyncState } from "./sync-state.js";

export type { RemoteBackup };

type Options = RequestOptions & SelectOptions;

/**
 * The third consent, checked before anything else in every backup entry point.
 *
 * `forbidden` rather than `validation`: the repository is connected, the
 * credential is fine and the command is well-formed. What is missing is a
 * decision a human has not made, and the message names the command that makes
 * it rather than describing the state.
 */
export function requireBackupConsent(connection: CloudConnection): void {
  if (connection.backup !== true) {
    throw cloudError(
      "forbidden",
      "Backup is off for this repository on this machine. It is a separate consent from " +
        "connecting and from automatic sync — neither of those turns it on. Enable it with " +
        "`staple cloud backup enable`.",
    );
  }
}

function requireConnection(home: string, repositoryId: string): CloudConnection {
  const connection = readConnection(home, repositoryId);
  if (!connection) {
    throw new StapleError(
      "not_found",
      "This repository is not connected on this machine. Run `staple cloud connect` first.",
    );
  }
  return connection;
}

// ---------------------------------------------------------------- the consent

export interface ConsentOutcome {
  readonly enabled: boolean;
  /** Whether the server agreed. False only on the disable path; see below. */
  readonly serverAcknowledged: boolean;
  readonly warning: string | null;
  /**
   * The code of the failure the warning reports, or null when there is none.
   *
   * The failure is not thrown — withdrawing a consent finishes offline, and the local
   * half has already happened — but its code is not discarded either: the command exits
   * with it (`exitCodeFor`), so an unreachable service is `offline`, exit 21, and a
   * transient one `unavailable`, exit 20, the same as any other command meeting them.
   */
  readonly warningCode: ErrorEnvelope["code"] | null;
}

/**
 * `staple cloud backup enable|disable` — the ONLY writer of `connection.backup`.
 *
 * ## Enabling asks the server first
 *
 * The consent has two halves — `sync.backup` here and a flag on the repository
 * row there — and both are required. The server is asked first so that a local
 * flag is never recorded for a service that did not agree: a device whose config
 * said yes while the server said no would report backup as "on" and then fail
 * every backup command, which is a worse answer than never having turned it on.
 *
 * ## Disabling writes locally first, and will finish offline
 *
 * Withdrawing a consent must not require the network. `staple cloud auto off`
 * works offline and so does this: the local flag is cleared first, which is what
 * actually stops this device, and the server flag is then cleared on a best
 * effort. A failure there is REPORTED rather than swallowed and rather than
 * fatal — the honest statement is "this device will not back up any more, and
 * the service still has the flag set", and pretending otherwise in either
 * direction would be a lie about a consent.
 *
 * Neither direction deletes an existing backup. Withdrawing permission to make
 * new ones is a different decision from destroying the ones already made, and a
 * command that conflated them would delete a human's last copy of their data as
 * a side effect of turning a flag off.
 */
export async function setBackupConsent(
  home: string,
  repositoryId: string,
  enabled: boolean,
  options: Options = {},
): Promise<ConsentOutcome> {
  const { connection, token } = requireSession(home, repositoryId, options);
  const call = {
    repositoryId,
    token,
    deviceId: connection.deviceId,
    enabled,
  };

  if (enabled) {
    await setRemoteBackupConsent(parseEndpoint(connection.endpoint), call, options);
    setConsent(home, repositoryId, { backup: true });
    return { enabled: true, serverAcknowledged: true, warning: null, warningCode: null };
  }

  setConsent(home, repositoryId, { backup: false });
  try {
    await setRemoteBackupConsent(parseEndpoint(connection.endpoint), call, options);
    return { enabled: false, serverAcknowledged: true, warning: null, warningCode: null };
  } catch (error) {
    return {
      enabled: false,
      serverAcknowledged: false,
      warning:
        `Backup is now off on this machine and this device will not create another. The ` +
        `service could not be told, so its own flag may still be set: ` +
        `${error instanceof Error ? error.message : String(error)}`,
      warningCode: errorEnvelope(error).code,
    };
  }
}

// ----------------------------------------------------------------- the backups

/** `staple cloud backup create`. Opens no workspace database and moves no cursor. */
export async function createBackup(
  home: string,
  repositoryId: string,
  label: string | null,
  options: Options = {},
): Promise<RemoteBackup> {
  const connection = requireConnection(home, repositoryId);
  requireBackupConsent(connection);
  const { token } = requireSession(home, repositoryId, options);
  const result = await createRemoteBackup(
    parseEndpoint(connection.endpoint),
    { repositoryId, token, deviceId: connection.deviceId, label },
    options,
  );
  return result.backup;
}

/** `staple cloud backup ls`. Metadata only — the folded contents never travel. */
export async function listBackups(
  home: string,
  repositoryId: string,
  options: Options = {},
): Promise<RemoteBackup[]> {
  const connection = requireConnection(home, repositoryId);
  requireBackupConsent(connection);
  const { token } = requireSession(home, repositoryId, options);
  const result = await listRemoteBackups(
    parseEndpoint(connection.endpoint),
    { repositoryId, token, deviceId: connection.deviceId },
    options,
  );
  return result.backups;
}

/** `staple cloud backup rm <backupId>`. Retention, one row at a time. */
export async function deleteBackup(
  home: string,
  repositoryId: string,
  backupId: string,
  options: Options = {},
): Promise<void> {
  const connection = requireConnection(home, repositoryId);
  requireBackupConsent(connection);
  const { token } = requireSession(home, repositoryId, options);
  await deleteRemoteBackup(
    parseEndpoint(connection.endpoint),
    { repositoryId, token, deviceId: connection.deviceId, backupId },
    options,
  );
}

// ----------------------------------------------------------------- the restore

export interface RestoreReport {
  readonly backupId: string;
  readonly restoreId: string;
  readonly fromEpoch: number;
  readonly toEpoch: number;
  readonly entityCount: number;
  /** The undo. An ordinary backup, restorable by this same command. */
  readonly preRestoreBackupId: string | null;
  /** Turns of the resumable route it took. Reported so chunking is visible. */
  readonly turns: number;
}

/**
 * The compatibility check the server explicitly does not make.
 *
 * `ops.schema_version` and `backups.schema_version` are stored and never
 * interpreted server-side — the server has no migrations and cannot have an
 * opinion about a workspace schema. The device is the only party that knows what
 * it can apply, so the refusal belongs here, and it happens BEFORE the restore
 * begins rather than after a device has hydrated data it cannot read.
 *
 * The comparison is one-directional on purpose. A backup written by an OLDER
 * schema is fine: migrations run forward and the hydrating device will bring it
 * up. A backup written by a NEWER one is refused, because applying it would mean
 * this build inventing the meaning of fields it has never heard of.
 */
export function assertRestoreCompatible(backup: RemoteBackup): void {
  if (backup.schemaVersion > WORKSPACE_SCHEMA_VERSION) {
    throw cloudError(
      "schema_ahead",
      `That backup was written by a newer Staple: it carries workspace schema ` +
        `${backup.schemaVersion} and this build understands ${WORKSPACE_SCHEMA_VERSION}. ` +
        `Upgrade before restoring it. Nothing was changed.`,
      { backupSchema: backup.schemaVersion, localSchema: WORKSPACE_SCHEMA_VERSION },
    );
  }
}

/**
 * `staple cloud restore <backupId>` — drive the resumable route, then
 * re-bootstrap this device.
 *
 * The loop is the protocol: the server decides which phase runs from durable
 * state, and the client's only job is to keep calling until `done` and to stop
 * if it stops making progress. `guard` bounds it so that a server which somehow
 * answered "not done" forever produces a refusal rather than an infinite loop
 * against a paid API.
 *
 * The local half runs only after the epoch has actually moved. `beginBootstrap`
 * clears this device's cursor and its `sync_applied` ledger so the next
 * `staple cloud sync` hydrates the restored timeline from a snapshot — and
 * preserves `client_seq_high_water` and the pending outbox, which is what stops
 * the re-bootstrap from re-minting operation ids the server already holds. See
 * the module comment; that is the failure this whole mechanism exists to avoid.
 */
export async function restoreFromBackup(
  db: DatabaseSync,
  home: string,
  repositoryId: string,
  backupId: string,
  options: Options & { actor?: string | null } = {},
): Promise<RestoreReport> {
  const connection = requireConnection(home, repositoryId);
  requireBackupConsent(connection);
  const { token } = requireSession(home, repositoryId, options);
  const endpoint = parseEndpoint(connection.endpoint);
  const call = { repositoryId, token, deviceId: connection.deviceId, backupId };

  const listed = await listRemoteBackups(endpoint, call, options);
  const backup = listed.backups.find((candidate) => candidate.backupId === backupId);
  if (!backup) {
    throw new StapleError(
      "not_found",
      `No backup ${backupId} on ${connection.endpoint}. ` +
        `\`staple cloud backup ls\` lists the ones that exist.`,
    );
  }
  assertRestoreCompatible(backup);

  let restoreId: string | null = null;
  let turns = 0;
  let staged = -1;
  let preRestoreBackupId: string | null = null;
  let fromEpoch = backup.epoch;
  let toEpoch = backup.epoch + 1;

  /**
   * Bounded, and bounded by PROGRESS rather than only by a turn count. A server
   * that keeps answering "staging" without staging anything is a bug, and the
   * right response to it is to stop and say so rather than to keep paying for
   * requests until something times out.
   */
  for (let guard = 0; guard < 1000; guard += 1) {
    const progress = await advanceRemoteRestore(
      endpoint,
      { ...call, restoreId, actor: options.actor ?? null },
      options,
    );
    turns += 1;
    restoreId = progress.restoreId;
    if (progress.preRestoreBackupId) preRestoreBackupId = progress.preRestoreBackupId;
    if (typeof progress.fromEpoch === "number") fromEpoch = progress.fromEpoch;
    if (typeof progress.toEpoch === "number") toEpoch = progress.toEpoch;

    if (progress.done) {
      // The remote timeline has moved. Only now does this device follow it.
      beginBootstrap(db, toEpoch);
      return {
        backupId,
        restoreId: progress.restoreId,
        fromEpoch,
        toEpoch,
        entityCount: progress.entityCount,
        preRestoreBackupId,
        turns,
      };
    }

    if (turns > 1 && progress.staged <= staged) {
      throw cloudError(
        "unavailable",
        `The restore stopped making progress at ${progress.staged} of ${progress.entityCount} ` +
          `entities. The epoch has NOT moved and nothing on this machine was changed; ` +
          `re-run \`staple cloud restore ${backupId}\` to resume from where it stopped.`,
        { restoreId: progress.restoreId, staged: progress.staged },
      );
    }
    staged = progress.staged;
  }

  throw cloudError(
    "unavailable",
    `The restore did not finish within 1000 requests. The epoch has NOT moved and nothing on ` +
      `this machine was changed; re-run to resume.`,
    { restoreId },
  );
}

/**
 * What a human should read before typing a repository id back.
 *
 * The parallel to `retentionDisclosure` is deliberate: the two irreversible
 * remote operations in this tree both print what they are about to do, in full,
 * before they will accept a confirmation. Every claim here is one the code
 * actually makes good on.
 */
export function restoreDisclosure(
  endpoint: string,
  repositoryId: string,
  backup: RemoteBackup,
  localEpoch: number | null,
): string {
  return [
    "Restore — read this before confirming.",
    "",
    `  service        ${endpoint}`,
    `  repository     ${repositoryId}`,
    `  backup         ${backup.backupId}`,
    `  taken          ${new Date(backup.createdAt).toISOString()} (${backup.kind})`,
    `  contents       ${backup.entityCount} entities, folded from ${backup.opCount} operations`,
    `  from epoch     ${backup.epoch}, at sequence ${backup.cutoffSeq}`,
    localEpoch === null ? "" : `  this device    epoch ${localEpoch}`,
    "",
    "What restoring does:",
    "  - takes a pre-restore backup FIRST, so this is undoable by restoring that one",
    "  - writes the backup's contents into a NEW epoch on the service",
    "  - moves the repository onto that epoch, which forces EVERY device — including",
    "    this one — through a bounded re-bootstrap before it can sync again",
    "  - DISCARDS anything synchronized after the backup was taken. That work survives",
    "    only in the pre-restore backup.",
    "  - never merges database files, and never touches your local database until the",
    "    service has committed",
    "",
    "What it does not do:",
    "  - delete any existing backup",
    "  - change this device's automatic-sync setting or its credential",
  ]
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n");
}

/** This device's epoch, for the disclosure. Null when it has never synchronized. */
export function localEpochOf(db: DatabaseSync): number | null {
  const state = readSyncState(db);
  return state === null || state.epoch === 0 ? null : state.epoch;
}
