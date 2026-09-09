/**
 * The hub's own leg to the service: connect, publish, back up, restore, adopt.
 *
 * Contract: `docs/sync.md`, "The hub registry is a set, not a map", and "Three
 * consents" — specifically its fourth subsection, *"The fourth consent: publishing
 * the hub registry"*. Sibling of {@link ./hub-registry.js} (the payload and the
 * adoption rules) and {@link ./hub-registry-ops.js} (the wire translation, pure).
 * This file is the only one of the three that can reach the network.
 *
 * ## This is NOT the fan-out
 *
 * `hub-connect.ts`, `hub-sync.ts` and `hub-scope.ts` are a fan-out: one gesture on
 * one machine that visits each registered workspace and performs the per-repository
 * operation that already existed. Their defining property is that *"every remote call
 * this produces is indistinguishable, at the service, from a human running `staple
 * cloud connect` in each directory by hand"* — the service is never told that these
 * workspaces sit together.
 *
 * This file is the opposite, and it is worth being blunt about the difference because
 * the file names are one word apart. Here the hub itself is a repository, and what it
 * uploads is precisely the fact the fan-out was careful never to express: which
 * workspaces exist on this machine and that they are the same machine's. That is why
 * it is behind a consent of its own, granted by itself, with the disclosure in front
 * of it — see {@link registryDisclosure}.
 *
 * ## Restore is adoption, not a bootstrap
 *
 * A workspace restore ends in `beginBootstrap`: clear the cursor and the applied-op
 * ledger, then hydrate from a snapshot. Nothing here can do that and nothing here
 * should: `hub.db` has no `sync_state`, no `sync_outbox` and no `sync_applied`, and
 * giving it them would be a migration and a journal seam bought for a table with a
 * dozen rows in it.
 *
 * The hub's equivalent of hydrating is `adoptRegistry`, which is a better fit than a
 * bootstrap would be even if the tables existed. A bootstrap OVERWRITES local state
 * from the remote fold; adoption reconciles two machines' knowledge under rules a
 * bootstrap has no way to express — this machine's stamps win, a disagreement is
 * reported rather than resolved, no prefix is ever renumbered, and an opted-out
 * identity is not brought back. A restore that hydrated the hub the way a workspace
 * hydrates would silently overrule all four.
 *
 * So: {@link restoreRegistry} drives the resumable restore route to completion and
 * then reads the restored epoch back and hands it to `adoptRegistry`, **which previews
 * by default**. Nothing writes to `hub.db` unless the caller asks.
 *
 * ## What this file deliberately does not do
 *
 * It does not provision. It cannot: `docs/sync.md` defines no provisioning route and
 * no account model, so the Worker does not have one, and a `repos` row plus its first
 * enrollment secret are created out of band (`worker/README.md`). The product's job is
 * therefore to say so in words a person can act on rather than to fail generically —
 * see {@link HUB_NOT_PROVISIONED} and {@link isNotProvisioned}. An unknown repository
 * id answers `forbidden`, deliberately and correctly, because *"an unknown id is far
 * more likely to be a copied manifest than a new repository"*; the cost of that
 * correctness is that the hub's first connect looks exactly like a permission problem
 * unless something translates it.
 */
import { createHash } from "node:crypto";
import { StapleError } from "../types.js";
import type { Hub } from "../hub.js";
import {
  cloudCodeOf,
  cloudError,
  createRemoteBackup,
  deleteRemoteBackup,
  fetchCapabilities,
  fetchSnapshotPage,
  listRemoteBackups,
  pushOperations,
  setRemoteBackupConsent,
  advanceRemoteRestore,
  type RemoteBackup,
  type RequestOptions,
} from "./client.js";
import { readConnection, setConsent, type CloudConnection } from "./connection.js";
import { performConnect, requireSession, type ConnectOutcome, type PerformConnectArgs } from "./connect.js";
import type { SelectOptions } from "./credential-store.js";
import { parseEndpoint } from "./endpoint.js";
import { nowIso } from "../types.js";
import {
  adoptRegistry,
  exportRegistry,
  type AdoptOptions,
  type AdoptionReport,
  type HubRegistryPayload,
} from "./hub-registry.js";
import {
  REGISTRY_PROTOCOL,
  chunkOperations,
  diffRegistry,
  publishedStateOf,
  registryFromSnapshot,
  type RegistryOperation,
  type SnapshotEntityLike,
  type UnpublishableEntry,
} from "./hub-registry-ops.js";
import { buildConnectPreview, type ConnectPreview } from "./preview.js";

type Options = RequestOptions & SelectOptions;

/**
 * The sentence that has to appear wherever this consent is granted.
 *
 * Copied VERBATIM from `hub-registry.ts`'s header and from `docs/sync.md`, not
 * paraphrased. A disclosure that is reworded per surface is a disclosure whose
 * strongest wording is whichever surface a person did not read, and this one is the
 * whole price of the invariant the registry gave up.
 */
export const REGISTRY_DISCLOSURE =
  "a machine that publishes its registry tells the service the names, prefixes and " +
  "identities of every workspace on it, and that they sit together.";

/** The consent, as a human is asked for it. Full sentences, because it is a question. */
export function registryDisclosure(endpoint: string): string {
  const lines: string[] = [];
  lines.push("Publish this machine's workspace registry");
  lines.push("");
  lines.push(`  service        ${endpoint}`);
  lines.push("");
  lines.push("What this uploads, and it is not what the other consents cover:");
  lines.push(`  ${REGISTRY_DISCLOSURE.charAt(0).toUpperCase()}${REGISTRY_DISCLOSURE.slice(1)}`);
  lines.push("");
  lines.push("What it does not upload:");
  lines.push("  - No filesystem paths. Where each workspace sits on this machine stays on this");
  lines.push("    machine, and is worked out again on the machine that restores.");
  lines.push("  - No tasks. Your issues, comments and documents live in each workspace and are");
  lines.push("    backed up separately, per workspace, under that workspace's own consent.");
  lines.push("  - Not the list of workspaces you have removed here. That stays local, which is");
  lines.push("    what makes `staple hub unregister` a local act.");
  lines.push("");
  lines.push("Connecting, automatic sync and backup do not imply this, and this implies none of");
  lines.push("them. Turning it off later stops this machine publishing; it does not delete what");
  lines.push("has already been published.");
  return lines.join("\n");
}

/**
 * What a hub can and cannot be told about its own provisioning.
 *
 * Named as a constant so the CLI, the HTTP surface and the UI cannot each invent
 * their own wording for the one state a person genuinely has to act on.
 */
export const HUB_NOT_PROVISIONED =
  "This machine's hub is not provisioned on that service, so there is nothing to publish to " +
  "yet. Staple cannot create it: the sync service has no provisioning route and no account " +
  "model — a repository row and its first enrollment secret are created out of band by whoever " +
  "runs the service (see worker/README.md, \"Provisioning a repository\"). Ask them to add this " +
  "hub id, then connect again. Nothing was sent and nothing was changed.";

/**
 * Is this failure "the service has never heard of this hub" rather than "you are not
 * allowed"?
 *
 * The two are the same wire answer and always will be. `worker/src/devices.ts`
 * answers `forbidden` for an unknown `repoId` **deliberately** — *"whether a given
 * repository id is registered on this server is not something an unauthenticated
 * caller should be able to enumerate"* — so there is no server-side signal to read
 * and asking for one would be asking the service to become an oracle.
 *
 * What makes the guess safe to make HERE is that it is not a guess about
 * authorization. A hub id is minted locally by `hub.hubId()` and never typed by a
 * human, so the "you fat-fingered the id" reading does not exist for it, and a hub is
 * never a repository somebody else provisioned and forgot to add this machine to.
 * `forbidden` on a hub's first connect is therefore overwhelmingly "not provisioned",
 * and the message says both possibilities rather than only the likely one.
 */
export function isNotProvisioned(error: unknown): boolean {
  return cloudCodeOf(error) === "forbidden";
}

/** The hub's connection key. The hub's identity IS its repository id on the service. */
export function hubRepositoryId(hub: Hub): string {
  return hub.hubId();
}

/**
 * Take on an existing registry identity on a machine that is joining one.
 *
 * The step that makes "restorable after a machine is lost" true at all, and the one
 * that is easy to leave out because every test written on ONE machine passes without
 * it. A replacement machine's `hub.hubId()` mints a fresh UUID; scoped to that, it
 * reads an empty repository and reports, truthfully and uselessly, that there is
 * nothing to restore.
 *
 * So the id travels out of band, exactly as the enrollment secret does and for the
 * same reason — the service has no account model to look it up in — and it is
 * ADOPTED here rather than minted. In practice a person keeps the two together:
 * the hub id is not a secret and the enrollment secret is, but neither is derivable
 * and losing either costs the same recovery.
 *
 * ## The one decision this function makes that `Hub.adoptHubId` cannot
 *
 * `Hub.adoptHubId` refuses to replace a different stored id, because doing so silently
 * orphans whatever was published under the old one. That refusal is right when the old
 * id has been USED and wrong when it has not: `hubId()` mints lazily, so a machine can
 * hold an id that has never left it and names nothing anywhere.
 *
 * The evidence for "used" is a connection record under the old id — the same file whose
 * absence `connection.ts` defines as "never connected", and the only local artifact that
 * implies anything was ever sent. Present, and the refusal stands and names it. Absent,
 * and the old id is discarded without ceremony, because there is nothing to orphan.
 *
 * ## The gap in that evidence, and why it is documented rather than closed
 *
 * `connect → publish → disconnect → adopt` passes this check, and the old registry is
 * then orphaned on the service: intact, still there, and no longer reachable from this
 * machine unless somebody re-adopts the old id. `performDisconnect` deletes the
 * connection record and clears the auto-sync state — its contract is to *"leave nothing
 * behind"* — so after it runs there is no local artifact that distinguishes "this id was
 * never used" from "this id was used and then disconnected", and there deliberately
 * never will be one.
 *
 * Closing it would mean keeping a hub-local list of identities this machine has
 * published under. That is hub-local sync state, which is the migration this whole leg
 * was built to avoid, bought to improve the wording of one confirmation dialog. Not
 * worth it.
 *
 * So the honest handling is at the surface, and it is a requirement rather than a
 * suggestion: **whenever `previousHubId` is non-null, say unconditionally that anything
 * published under it stays on the service and this machine will stop pointing at it.**
 * Do not branch on whether it was used — that is the unknowable part. Say also that
 * re-adopting the old id brings it back, because the operation IS reversible, which is
 * what keeps this a confirmation rather than a refusal.
 */
export function adoptRegistryIdentity(
  home: string,
  hub: Hub,
  hubId: string,
): { adopted: boolean; previousHubId: string | null } {
  const trimmed = hubId.trim();
  const previous = hub.storedHubId();
  if (previous === trimmed) return { adopted: false, previousHubId: previous };

  if (previous !== null && readConnection(home, previous) !== null) {
    throw new StapleError(
      "conflict",
      `This machine's hub is already connected to a service under the identity ${previous}. ` +
        `Adopting ${trimmed} would leave that registry published with nothing pointing at it. ` +
        "Disconnect it first if that is what you want. Nothing was changed.",
    );
  }

  // Forced past `Hub.adoptHubId`'s refusal only where the evidence above says the old
  // id was never used. The refusal itself is not weakened; the decision is made where
  // the evidence lives.
  hub.adoptHubId(trimmed, { force: true });
  return { adopted: true, previousHubId: previous };
}

// ------------------------------------------------------------------- connect

/**
 * The preview for connecting the HUB, built by the same local-only function a
 * workspace uses.
 *
 * Reusing `buildConnectPreview` is deliberate rather than lazy: the property that
 * matters about a preview is that computing one cannot reach the network, and that
 * property is a fact about `preview.ts`'s import graph. A hub-specific preview built
 * anywhere else would have to re-earn it, and `test/network-silence.test.ts` would
 * not be watching the new file.
 */
export function buildHubRegistryPreview(args: {
  home: string;
  hub: Hub;
  endpoint: string;
  label?: string;
  credential?: SelectOptions;
}): ConnectPreview {
  return buildConnectPreview({
    home: args.home,
    repositoryId: hubRepositoryId(args.hub),
    endpoint: args.endpoint,
    ...(args.label === undefined ? {} : { label: args.label }),
    ...(args.credential === undefined ? {} : { credential: args.credential }),
  });
}

/**
 * Connect the hub as a repository, translating the one failure that is not a bug.
 *
 * Everything else about connecting is `performConnect`'s, unchanged: the device id,
 * the capabilities probe, the credential store, the record. The record lands under
 * the hub id in the same `cloud/` directory as every workspace's, which is what makes
 * `requireSession` work for it without knowing it is a hub.
 */
export async function connectHubRegistry(
  preview: ConnectPreview,
  args: PerformConnectArgs,
): Promise<ConnectOutcome> {
  try {
    return await performConnect(preview, args);
  } catch (error) {
    if (isNotProvisioned(error)) {
      throw cloudError("forbidden", HUB_NOT_PROVISIONED, {
        endpoint: preview.endpoint.origin,
        hubId: preview.repositoryId,
      });
    }
    throw error;
  }
}

// ------------------------------------------------------------------- consent

export interface RegistryConsentOutcome {
  readonly enabled: boolean;
  readonly connection: CloudConnection;
}

/**
 * Grant or withdraw the publish consent. **The only writer of `connection.registry`.**
 *
 * ## No server round trip, unlike backup
 *
 * `setBackupConsent` asks the server first, because that consent has two halves and
 * the server owns one of them (`repos.backup_enabled`). This one has one half. There
 * is no wire spelling for "this machine may describe itself", no route that takes
 * one, and inventing a flag would mean the service storing a permission it has no way
 * to enforce — every operation this consent gates is an ordinary push that the
 * credential already authorizes.
 *
 * Which means the consent is enforced entirely on this side, and the enforcement is
 * that every egress path in this file begins with {@link requireRegistryConsent}.
 *
 * ## Refusing on an unconnected hub rather than springing a record into existence
 *
 * Inherited from `setConsent` and load-bearing, not incidental: the zero-network
 * invariant is *"before a repository is connected, no cloud setting, credential or
 * request may exist at all"*, and `at all` is not satisfied by a file that records a
 * consent for a connection that does not exist.
 */
export function setRegistryConsent(
  home: string,
  hubId: string,
  enabled: boolean,
): RegistryConsentOutcome {
  const connection = setConsent(home, hubId, { registry: enabled });
  return { enabled, connection };
}

/**
 * The gate. Every function below that egresses calls this first.
 *
 * Phrased as a missing DECISION rather than as a missing state, the way
 * `requireBackupConsent` is: the credential is fine and the command is well-formed,
 * and what is absent is something a human has not said yes to.
 */
export function requireRegistryConsent(connection: CloudConnection): void {
  if (connection.registry !== true) {
    throw cloudError(
      "forbidden",
      "Publishing this machine's workspace registry is off. It is a separate consent from " +
        "connecting, from automatic sync and from backup — none of those turns it on, because " +
        `none of them discloses what it does: ${REGISTRY_DISCLOSURE} Enable it with ` +
        "`staple hub registry publish --enable`.",
    );
  }
}

function requireHubConnection(home: string, hubId: string): CloudConnection {
  const connection = readConnection(home, hubId);
  if (!connection) {
    throw new StapleError(
      "not_found",
      "This machine's hub is not connected to a sync service. Run `staple hub registry connect` " +
        "first — it is a separate connection from any workspace's, under the hub's own identity.",
    );
  }
  return connection;
}

// ------------------------------------------------------------------- reading

/**
 * Every page of `GET /snapshot`, as folded entities.
 *
 * Paged because the route is paged, and the cursor is replayed opaquely. The `guard`
 * bounds the loop for the same reason the restore loop is bounded: a server that
 * answered `hasMore` for ever must produce a refusal rather than an unbounded spend
 * against a paid API.
 */
async function readSnapshotEntities(
  home: string,
  hubId: string,
  options: Options,
): Promise<{ entities: SnapshotEntityLike[]; epoch: number; pages: number }> {
  const connection = requireHubConnection(home, hubId);
  const { token } = requireSession(home, hubId, options);
  const endpoint = parseEndpoint(connection.endpoint);
  const call = { repositoryId: hubId, token, deviceId: connection.deviceId };

  const entities: SnapshotEntityLike[] = [];
  let cursor: string | null = null;
  let epoch = 0;
  let pages = 0;
  for (let guard = 0; guard < 200; guard += 1) {
    pages += 1;
    const page = (await fetchSnapshotPage(
      endpoint,
      { ...call, cursor, limit: 200 },
      { ...options, protocol: REGISTRY_PROTOCOL },
    )) as {
      epoch: number;
      entities: SnapshotEntityLike[];
      nextCursor: string | null;
      hasMore: boolean;
    };
    epoch = page.epoch;
    entities.push(...page.entities);
    if (!page.hasMore || page.nextCursor === null) return { entities, epoch, pages };
    cursor = page.nextCursor;
  }
  throw cloudError(
    "unavailable",
    "The service kept reporting more registry pages than this machine is willing to read. " +
      "Nothing was changed.",
  );
}

/**
 * The registry the service currently holds.
 *
 * A READ, and therefore not behind the publish consent: reading back what is already
 * there discloses nothing that publishing it did not already disclose, and a restore
 * onto a fresh machine has to be able to do it before that machine has agreed to
 * publish anything of its own. Connecting is enough.
 */
export async function readPublishedRegistry(
  home: string,
  hubId: string,
  options: Options = {},
): Promise<{ registry: HubRegistryPayload; epoch: number }> {
  const { entities, epoch } = await readSnapshotEntities(home, hubId, options);
  return {
    registry: registryFromSnapshot({ hubId, capturedAt: nowIso(), entities }),
    epoch,
  };
}

// ----------------------------------------------------------------- publishing

export interface PublishReport {
  readonly hubId: string;
  readonly endpoint: string;
  readonly epoch: number;
  /** Operations sent. Zero when the service already held this registry. */
  readonly published: number;
  readonly created: number;
  readonly updated: number;
  /** Cross-link deletes. A registration is never deleted; see `hub-registry-ops.ts`. */
  readonly removed: number;
  /** How many pushes it took. Reported so chunking is visible rather than assumed. */
  readonly batches: number;
  /** Entries with no sync identity. Reported, never invented. */
  readonly unpublishable: readonly UnpublishableEntry[];
  readonly upToDate: boolean;
}

/**
 * Publish the registry: read what the service holds, derive the difference, push it.
 *
 * The op set is derived HERE, at push time, and there is no hub outbox and no hub
 * migration. `hub-registry-ops.ts` records why in full; the short version is that the
 * registry is fully re-derivable from current state, so there is no intent to remember
 * across a crash and therefore nothing for an outbox to be.
 *
 * `opId` is deterministic and derived from the epoch, the entity and the entity id —
 * NOT from a counter. That is what makes a retry safe: a publish interrupted halfway
 * through its chunks can be run again unchanged, and the operations that already
 * landed come back `duplicate`, which the contract defines as a success. A
 * `client_seq`-derived id, which is what a workspace uses, would need the allocator
 * `hub.db` does not have — and re-minting one across a crash is the documented route
 * to silent data loss.
 */
export async function publishRegistry(
  hub: Hub,
  home: string,
  options: Options = {},
): Promise<PublishReport> {
  const hubId = hubRepositoryId(hub);
  const connection = requireHubConnection(home, hubId);
  requireRegistryConsent(connection);
  const { token } = requireSession(home, hubId, options);
  const endpoint = parseEndpoint(connection.endpoint);

  const local = exportRegistry(hub);
  const { entities, epoch } = await readSnapshotEntities(home, hubId, options);
  const diff = diffRegistry(local, publishedStateOf(entities));

  if (diff.operations.length === 0) {
    return {
      hubId,
      endpoint: connection.endpoint,
      epoch,
      published: 0,
      created: 0,
      updated: 0,
      removed: 0,
      batches: 0,
      unpublishable: diff.unpublishable,
      upToDate: true,
    };
  }

  /**
   * Sized from the handshake, never from a constant here. The ceiling is 25 on the
   * free plan and 200 on paid, and a client that hardcoded the paid number would fail
   * permanently on the free one.
   */
  const capabilities = await fetchCapabilities(endpoint, options);
  const chunks = chunkOperations(diff.operations, capabilities.maxBatchSize);

  let clientSeq = 0;
  for (const chunk of chunks) {
    const ops = chunk.map((operation) => {
      clientSeq += 1;
      return toEnvelope(operation, {
        hubId,
        epoch,
        deviceId: connection.deviceId,
        clientSeq,
      });
    });
    await pushOperations(
      endpoint,
      {
        repositoryId: hubId,
        token,
        deviceId: connection.deviceId,
        /**
         * Fenced on the epoch the snapshot reported. A restore that moved the epoch
         * between the read and the push makes this diff a statement about a timeline
         * that no longer exists, and `epoch_changed` is the right answer — publishing
         * into the new one would resurrect rows the restore had just removed.
         */
        epoch,
        ops,
      },
      { ...options, protocol: REGISTRY_PROTOCOL },
    );
  }

  return {
    hubId,
    endpoint: connection.endpoint,
    epoch,
    published: diff.operations.length,
    created: diff.operations.filter((o) => o.verb === "create").length,
    updated: diff.operations.filter((o) => o.verb === "update").length,
    removed: diff.operations.filter((o) => o.verb === "delete").length,
    batches: chunks.length,
    unpublishable: diff.unpublishable,
    upToDate: false,
  };
}

/**
 * The operation id: `hub:<epoch>:<entity>:<32 hex of what the operation SAYS>`.
 *
 * ## Content-addressed, and the bug that made that necessary
 *
 * The first version of this was `hub:<epoch>:<entity>:<entityId>` — readable,
 * deterministic, and unique per entity per epoch. Which is not unique per OPERATION,
 * and the difference is silent data loss.
 *
 * The dedupe index is `(repo_id, epoch, op_id)` and a duplicate is answered with the
 * ORIGINAL operation's `seq` and a `duplicate` status the contract defines as a
 * success. So the second write to one entity within an epoch — a workspace renamed on
 * a second machine, exactly the case a shared registry exists to carry — was accepted,
 * acknowledged, and never applied. `test/cloud-hub-registry-wire.test.ts` caught it
 * because it asserted the SERVICE's state afterwards rather than the report the publish
 * returned; a test that trusted the report would have passed.
 *
 * Hashing what the operation says fixes both halves at once:
 *
 *   - a retry of the identical operation produces the identical id, so an interrupted
 *     publish can be re-run unchanged and the operations that already landed come back
 *     `duplicate`, which is the property that lets this work with no outbox at all;
 *   - a genuinely different statement about the same entity produces a different id, so
 *     it lands.
 *
 * The `epoch` is in the id because a restore moves the epoch and re-mints operation ids;
 * without it, an id reused across a restore would be absorbed as a duplicate of an
 * operation belonging to a timeline that no longer exists.
 *
 * The verb is hashed too. Nothing today emits two different verbs with identical
 * payloads for one entity — a `delete` carries `{}` and nothing else does — but the id
 * has to distinguish what the operation MEANS, not what it happens to carry, or the next
 * verb added here becomes a collision.
 *
 * Fixed length by construction, which also retires a guard the readable version needed:
 * a cross-link entity id is four percent-encoded names and could exceed the Worker's
 * 128-character cap on `opId` all by itself. It cannot now.
 */
function operationId(operation: RegistryOperation, epoch: number): string {
  // Keys sorted, so an id cannot change because a payload was built in a different
  // order. Today's payloads are literals with fixed key order; relying on that would
  // be relying on something no test would notice changing.
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(operation.payload as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : 1,
      ),
    ),
  );
  const digest = createHash("sha256")
    .update(`${operation.entityId}\n${operation.verb}\n${canonical}`)
    .digest("hex")
    .slice(0, 32);
  return `hub:${epoch}:${operation.entity}:${digest}`;
}

/**
 * One operation, as the envelope the Worker validates.
 *
 * `actor` is the empty string when there is no agent identity, matching the
 * DIVERGENCE `wire.ts` records: the Worker requires a string, and omitting the field
 * is a `validation` rejection of the batch.
 */
function toEnvelope(
  operation: RegistryOperation,
  context: { hubId: string; epoch: number; deviceId: string; clientSeq: number },
): Record<string, unknown> {
  const opId = operationId(operation, context.epoch);
  return {
    opId,
    repoId: context.hubId,
    protocol: REGISTRY_PROTOCOL,
    /**
     * The hub has no workspace schema, and `ops.schema_version` is stored and never
     * interpreted by the server. Zero is the honest value: this operation was not
     * written under any workspace migration, and claiming one would invite a device
     * to refuse it as `schema_ahead` for a reason that has nothing to do with it.
     */
    schema: 0,
    entity: operation.entity,
    entityId: operation.entityId,
    verb: operation.verb,
    // Null for `create`, and 0 otherwise. The hub keeps no per-entity version — that
    // is `sync_state`'s job and `hub.db` has no `sync_state` — and the server records
    // `baseVersion` without acting on it: conflict detection is field-scoped against
    // a LOCAL version, and the hub has no local version to claim.
    baseVersion: operation.verb === "create" ? null : 0,
    payload: operation.payload,
    deviceId: context.deviceId,
    actor: process.env.STAPLE_AGENT ?? "",
    clientSeq: context.clientSeq,
    createdAt: nowIso(),
  };
}

// ------------------------------------------------------------ backup, restore

/**
 * Enable or disable the hub's BACKUP consent — a different decision from publishing.
 *
 * Publishing puts the registry on the service. Backup asks the service to keep
 * point-in-time folds of it, which is what makes a lost machine recoverable to a
 * moment rather than to whatever the surviving machine last published. Both are
 * required for the acceptance criterion this feature exists for, and they are still
 * two decisions: a person may reasonably want the registry replicated and no
 * historical copies kept.
 *
 * The server owns half of this one, so it is asked first — the same ordering, for the
 * same reason, as `backup.ts`: a local flag recorded for a service that did not agree
 * reports backup as "on" and then fails every backup command.
 */
export async function setHubBackupConsent(
  home: string,
  hubId: string,
  enabled: boolean,
  options: Options = {},
): Promise<{ enabled: boolean; serverAcknowledged: boolean; warning: string | null }> {
  const connection = requireHubConnection(home, hubId);
  const { token } = requireSession(home, hubId, options);
  const endpoint = parseEndpoint(connection.endpoint);
  const call = { repositoryId: hubId, token, deviceId: connection.deviceId, enabled };

  if (enabled) {
    await setRemoteBackupConsent(endpoint, call, { ...options, protocol: REGISTRY_PROTOCOL });
    setConsent(home, hubId, { backup: true });
    return { enabled: true, serverAcknowledged: true, warning: null };
  }

  // Withdrawing must not require the network. Local first, then best effort.
  setConsent(home, hubId, { backup: false });
  try {
    await setRemoteBackupConsent(endpoint, call, { ...options, protocol: REGISTRY_PROTOCOL });
    return { enabled: false, serverAcknowledged: true, warning: null };
  } catch (error) {
    return {
      enabled: false,
      serverAcknowledged: false,
      warning:
        "Hub backup is now off on this machine and it will not create another. The service " +
        "could not be told, so its own flag may still be set: " +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function requireHubBackupConsent(connection: CloudConnection): void {
  if (connection.backup !== true) {
    throw cloudError(
      "forbidden",
      "Backup is off for this machine's hub. Publishing the registry and keeping point-in-time " +
        "copies of it are separate decisions; enable the second with " +
        "`staple hub registry backup --enable`.",
    );
  }
}

/** `POST /backups` on the hub. A fold of the registry, stored beside it. */
export async function createHubBackup(
  home: string,
  hubId: string,
  label: string | null,
  options: Options = {},
): Promise<RemoteBackup> {
  const connection = requireHubConnection(home, hubId);
  requireHubBackupConsent(connection);
  const { token } = requireSession(home, hubId, options);
  const result = await createRemoteBackup(
    parseEndpoint(connection.endpoint),
    { repositoryId: hubId, token, deviceId: connection.deviceId, label },
    { ...options, protocol: REGISTRY_PROTOCOL },
  );
  return result.backup;
}

/** `GET /backups` on the hub. Metadata only; the folded registry never travels here. */
export async function listHubBackups(
  home: string,
  hubId: string,
  options: Options = {},
): Promise<RemoteBackup[]> {
  const connection = requireHubConnection(home, hubId);
  requireHubBackupConsent(connection);
  const { token } = requireSession(home, hubId, options);
  const result = await listRemoteBackups(
    parseEndpoint(connection.endpoint),
    { repositoryId: hubId, token, deviceId: connection.deviceId },
    { ...options, protocol: REGISTRY_PROTOCOL },
  );
  return result.backups;
}

/** `DELETE /backups/{id}` on the hub. Retention, one row at a time. */
export async function deleteHubBackup(
  home: string,
  hubId: string,
  backupId: string,
  options: Options = {},
): Promise<void> {
  const connection = requireHubConnection(home, hubId);
  requireHubBackupConsent(connection);
  const { token } = requireSession(home, hubId, options);
  await deleteRemoteBackup(
    parseEndpoint(connection.endpoint),
    { repositoryId: hubId, token, deviceId: connection.deviceId, backupId },
    { ...options, protocol: REGISTRY_PROTOCOL },
  );
}

export interface HubRestoreReport {
  readonly hubId: string;
  readonly backupId: string;
  readonly fromEpoch: number | null;
  readonly toEpoch: number | null;
  readonly entityCount: number;
  /** The undo. An ordinary hub backup, restorable by this same call. */
  readonly preRestoreBackupId: string | null;
  /** Turns of the resumable route. Reported so chunking is visible. */
  readonly turns: number;
  /** The registry the restored epoch holds. */
  readonly registry: HubRegistryPayload;
  /** What this machine did with it. **A preview unless `apply` was set.** */
  readonly adoption: AdoptionReport;
}

/**
 * Restore the hub from a backup, then ADOPT what came back.
 *
 * Two halves, and the second is why this is not just a wrapper round the restore
 * route. The route ends with the service holding the backed-up registry on a fresh
 * epoch; that is worth nothing on its own, because the machine that lost its hub has
 * an empty `hub.db` and no way to learn what was in it. So the restored epoch is read
 * back and handed to `adoptRegistry`, whose rules are the ones that make this safe on
 * a machine that is NOT empty:
 *
 *   - this machine's stamps win, and a disagreement is REPORTED rather than resolved;
 *   - no prefix is ever renumbered, because a prefix is stamped into every identifier
 *     that workspace has ever emitted, including in commit messages and handoffs no
 *     migration can reach;
 *   - a prefix or slug collision parks as a stated conflict;
 *   - an opted-out `repositoryId` is skipped, which is what keeps
 *     `staple hub unregister` local;
 *   - nothing local is ever deleted.
 *
 * **Previews by default**, because `adoptRegistry` does. `apply` has to be asked for,
 * and the report a preview returns is the same shape as the one an apply returns —
 * which is what lets a surface show a person what would happen in the words it will
 * use afterwards.
 */
export async function restoreRegistry(
  hub: Hub,
  home: string,
  backupId: string,
  options: Options & { apply?: boolean; actor?: string | null; locate?: AdoptOptions["locate"] } = {},
): Promise<HubRestoreReport> {
  const hubId = hubRepositoryId(hub);
  const connection = requireHubConnection(home, hubId);
  requireHubBackupConsent(connection);
  const { token } = requireSession(home, hubId, options);
  const endpoint = parseEndpoint(connection.endpoint);
  const call = { repositoryId: hubId, token, deviceId: connection.deviceId, backupId };

  let restoreId: string | null = null;
  let turns = 0;
  let fromEpoch: number | null = null;
  let toEpoch: number | null = null;
  let entityCount = 0;
  let preRestoreBackupId: string | null = null;

  /**
   * The loop IS the protocol: the server decides which phase runs from durable state
   * and the client keeps calling until `done`. Bounded so a server that answered "not
   * done" for ever produces a refusal rather than an unbounded spend, and bounded by
   * PROGRESS as well as by turns — a server that answers `done: false` without staging
   * anything new is not going to start.
   */
  let lastStaged = -1;
  for (let guard = 0; guard < 200; guard += 1) {
    turns += 1;
    const progress = await advanceRemoteRestore(
      endpoint,
      { ...call, restoreId, actor: options.actor ?? null },
      { ...options, protocol: REGISTRY_PROTOCOL },
    );
    restoreId = progress.restoreId;
    entityCount = progress.entityCount;
    if (progress.fromEpoch !== undefined) fromEpoch = progress.fromEpoch;
    if (progress.toEpoch !== undefined) toEpoch = progress.toEpoch;
    if (progress.preRestoreBackupId !== undefined) {
      preRestoreBackupId = progress.preRestoreBackupId;
    }
    if (progress.done) break;
    if (progress.staged <= lastStaged) {
      throw cloudError(
        "unavailable",
        "The restore stopped making progress: the service reported the same number of staged " +
          "entities twice without finishing. The hub on this machine is unchanged, and the " +
          `pre-restore copy is ${preRestoreBackupId ?? "not yet recorded"}.`,
      );
    }
    lastStaged = progress.staged;
  }
  if (restoreId === null) {
    throw cloudError("unavailable", "The service did not start a restore. Nothing was changed.");
  }

  const { registry } = await readPublishedRegistry(home, hubId, options);
  const adoption = adoptRegistry(hub, registry, {
    ...(options.apply === undefined ? {} : { apply: options.apply }),
    ...(options.locate === undefined ? {} : { locate: options.locate }),
  });

  return {
    hubId,
    backupId,
    fromEpoch,
    toEpoch,
    entityCount,
    preRestoreBackupId,
    turns,
    registry,
    adoption,
  };
}

/**
 * Adopt what the service currently holds, without a restore.
 *
 * The everyday path, and the one a second machine uses: it has never lost anything,
 * it simply wants the set the first machine published. A restore is for the case where
 * the SERVICE's current state is also wrong — because the machine that was lost had
 * published damage before it went, or because a replacement published an empty
 * registry over the top.
 *
 * Previews by default, like everything else that touches adoption.
 */
export async function adoptPublishedRegistry(
  hub: Hub,
  home: string,
  options: Options & { apply?: boolean; locate?: AdoptOptions["locate"] } = {},
): Promise<{ registry: HubRegistryPayload; adoption: AdoptionReport }> {
  const hubId = hubRepositoryId(hub);
  const { registry } = await readPublishedRegistry(home, hubId, options);
  const adoption = adoptRegistry(hub, registry, {
    ...(options.apply === undefined ? {} : { apply: options.apply }),
    ...(options.locate === undefined ? {} : { locate: options.locate }),
  });
  return { registry, adoption };
}
