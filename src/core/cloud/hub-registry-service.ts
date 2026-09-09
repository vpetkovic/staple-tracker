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
  HUB_IDENTITY_REPLACEMENT_NOTICE,
  REGISTRY_DISCLOSURE,
  adoptRegistry,
  describeIdentityReplacement,
  exportRegistry,
  type AdoptOptions,
  type AdoptionReport,
  type HubRegistryPayload,
} from "./hub-registry.js";
import {
  CROSS_LINK_ENTITY,
  REGISTRY_PROTOCOL,
  chunkOperations,
  diffRegistry,
  publishedStateOf,
  registryFromSnapshot,
  type RegistryOperation,
  type RetainedEdge,
  type SnapshotEntityLike,
  type UnpublishableEntry,
} from "./hub-registry-ops.js";
import { buildConnectPreview, type ConnectPreview } from "./preview.js";
import { reconcileRepositoryIds, type RegistryIdentityReconciliation } from "./hub-scope.js";

type Options = RequestOptions & SelectOptions;

/**
 * Re-exported from the leaf, not declared here.
 *
 * The sentence lives in `hub-registry.ts` so that `hub-surface.ts` — reached by a route
 * the settings page POLLS — can render it without importing this module and acquiring
 * `client.ts`, the only `fetch` in the tree. Re-exported so existing callers of this
 * module keep working and there is still exactly one declaration.
 */
export { REGISTRY_DISCLOSURE, HUB_IDENTITY_REPLACEMENT_NOTICE, describeIdentityReplacement };

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
  "runs the service (see worker/README.md, \"Provisioning a HUB\"). Ask them to add this " +
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

  /**
   * Refuse an id that already names something else on this machine.
   *
   * A hub id travels out of band, by hand, next to repository ids and enrollment
   * secrets — so pasting a workspace's `repositoryId` into this command is an ordinary
   * slip, and until this check it was a destructive one. Connection records live in ONE
   * namespace: `<credentialDir>/<repositoryId>.json`. Adopting workspace W's id as the
   * hub id makes the next `connectHubRegistry` overwrite W's connection record and
   * `selectCredentialStore(...).write(hubId, …)` overwrite W's token — so W silently
   * stops being able to sync, with its credential gone.
   *
   * It is also the only way, in practice, to get a `registration` operation into a
   * WORKSPACE's log. The Worker has no notion of hub-versus-workspace repository, so it
   * would accept one — and from then on every protocol-1 client of W is refused at
   * `/ops` and `/snapshot` with a non-retryable 426, permanently. `worker/src/envelope.ts`
   * now refuses a batch that mixes the two vocabularies, which closes the accidental
   * version of that; this closes the door it came through.
   *
   * Checked against the REGISTRY and against the connection directory, because the two
   * answer different questions: a workspace may be registered here without ever having
   * been connected, and a connection record may outlive a workspace's registration.
   */
  const heldByWorkspace = hub.findByRepositoryId(trimmed);
  if (heldByWorkspace !== undefined) {
    throw new StapleError(
      "conflict",
      `${trimmed} is the sync identity of the workspace "${heldByWorkspace.slug}" on this ` +
        "machine, not a hub id. Adopting it would point the hub at that workspace's " +
        "repository and overwrite its stored credential. Nothing was changed — check the id " +
        "you were given.",
    );
  }
  if (previous !== trimmed && readConnection(home, trimmed) !== null) {
    throw new StapleError(
      "conflict",
      `${trimmed} already has a cloud connection record on this machine, so it names a ` +
        "repository this machine is already connected to rather than a hub identity to take " +
        "on. Nothing was changed.",
    );
  }

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
  /**
   * The capability pre-flight, BEFORE a device is minted.
   *
   * Without it, connecting an un-redeployed service SUCCEEDS: `performConnect` declares
   * `CLIENT_PROTOCOL`, which is 1, and 1 is inside `{min:1,max:1}`. The failure then
   * surfaces at the first publish as a bare `protocol 2 is outside the supported range`
   * — no `requiredProtocol`, no entity, and it reads like a bug in the client rather
   * than a service that has not been upgraded. The `forbidden` translation below got
   * this treatment and its sibling was missed.
   *
   * `fetchCapabilities` is unauthenticated and this function is already past consent —
   * the caller hands in a preview that was shown — so the call is permitted here for the
   * same reason `performConnect` makes it. Doing it FIRST means a service that cannot
   * carry the registry leaves no device row and no credential behind.
   */
  const capabilities = await fetchCapabilities(preview.endpoint, args);
  if (capabilities.protocol.max < REGISTRY_PROTOCOL) {
    throw cloudError(
      "protocol_unsupported",
      `${preview.endpoint.origin} speaks wire protocol ${capabilities.protocol.min}-` +
        `${capabilities.protocol.max}, and the hub registry needs ${REGISTRY_PROTOCOL}. The ` +
        "service is running a build from before the registry existed; it has to be redeployed " +
        "before this machine's hub can publish to it. Nothing was sent and no credential was " +
        "created. Every workspace connected to that service is unaffected.",
      {
        endpoint: preview.endpoint.origin,
        min: capabilities.protocol.min,
        max: capabilities.protocol.max,
        requiredProtocol: REGISTRY_PROTOCOL,
      },
    );
  }

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
  acknowledgement?: string,
): RegistryConsentOutcome {
  /**
   * ENABLING requires the caller to hand back the disclosure it showed.
   *
   * Every other invariant in this feature was made structural — *"the field does not
   * exist to be forgotten"* — and this one was not: a surface could write the flag with
   * no evidence it had rendered anything. The argument is that evidence. It is not
   * authentication and does not pretend to be; a caller can always look the constant up.
   * What it removes is the possibility of granting this consent while never having had
   * the sentence in hand, which is the way a disclosure actually goes missing — someone
   * adds a toggle, wires it to the setter, and nobody notices the screen was never built.
   *
   * Withdrawing needs no acknowledgement. Making it harder to turn something OFF than to
   * turn it on would be the wrong asymmetry in a revocation path that must work offline.
   */
  if (enabled && acknowledgement !== REGISTRY_DISCLOSURE) {
    throw new StapleError(
      "validation",
      "Enabling this consent requires the caller to pass the disclosure it displayed, " +
        "verbatim, as evidence that it displayed one. Pass `REGISTRY_DISCLOSURE` from " +
        "`hub-registry.ts` — and render it, or `registryDisclosure(endpoint)`, to the person " +
        "being asked. Nothing was changed.",
    );
  }
  /**
   * Checked HERE rather than left to `setConsent`, for the message.
   *
   * `setConsent` is repository-generic and its refusal says *"Run `staple cloud
   * connect` first"* — which is the wrong command for a hub, sends the reader to a
   * workspace's connection, and would have them connect the wrong thing to fix the
   * wrong problem. The refusal a person acts on has to name the command that
   * actually helps, so the hub-scoped check comes first and `setConsent`'s own
   * `not_found` becomes unreachable from this path.
   */
  requireHubRegistryConnection(home, hubId);
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

/**
 * The hub's connection record, or a refusal that names the right command.
 *
 * EXPORTED because the CLI needs to establish the connection BEFORE it prints the
 * publish disclosure. A surface that showed a person a whole consent screen and then
 * failed on "you are not connected" has wasted the one moment it had their attention
 * on a decision it could not act on.
 */
export function requireHubRegistryConnection(home: string, hubId: string): CloudConnection {
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
  const connection = requireHubRegistryConnection(home, hubId);
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
  /** Cross-links retracted — `present: false`. Never a delete; see `hub-registry-ops.ts`. */
  readonly retracted: number;
  /** How many pushes it took. Reported so chunking is visible rather than assumed. */
  readonly batches: number;
  /**
   * Operations the SERVICE said it applied, and ones it deduplicated.
   *
   * Read off the push response rather than assumed from what was sent, because
   * `published` is intent and this is outcome. A `duplicate` is how both of this
   * module's operation-id bugs manifested: the service answers with the original
   * operation's `seq` and a status the contract calls a success, and a report built from
   * the batch length says "1 published" while nothing changed. So the two numbers are
   * carried separately and a non-zero `deduplicated` is worth surfacing — with the
   * snapshot diff excluding everything that already landed, it should always be zero,
   * which is exactly what makes it a useful alarm.
   */
  readonly applied: number;
  readonly deduplicated: number;
  /** Entries with no sync identity. Reported, never invented. */
  readonly unpublishable: readonly UnpublishableEntry[];
  /** Published edges this machine had no basis to retract, and tombstoned ones. */
  readonly retained: readonly RetainedEdge[];
  /**
   * What resolving each row's identity from its manifest changed, and what it could not
   * establish. Reported because an unreadable manifest or a duplicated identity is the
   * reason a workspace is missing from what was published, and a person needs the cause
   * rather than the absence.
   */
  readonly identities: RegistryIdentityReconciliation;
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
 * `opId` is derived from the epoch, the entity, the entity id, the verb, the base
 * version and the payload — NOT from a counter. See {@link operationId} for the two
 * earlier versions of that derivation and why each was wrong; this paragraph used to
 * describe the FIRST of them, contradicting the function a hundred lines below, which is
 * the sort of drift that makes a comment worse than no comment.
 *
 * The retry property is what it buys: a publish interrupted halfway through its chunks
 * can be run again unchanged, because re-reading the snapshot re-derives the same diff
 * and therefore byte-identical ids. A `client_seq`-derived id, which is what a workspace
 * uses, would need the allocator `hub.db` does not have — and re-minting one across a
 * crash is the documented route to silent data loss.
 */
export async function publishRegistry(
  hub: Hub,
  home: string,
  options: Options = {},
): Promise<PublishReport> {
  const hubId = hubRepositoryId(hub);
  const connection = requireHubRegistryConnection(home, hubId);
  requireRegistryConsent(connection);
  const { token } = requireSession(home, hubId, options);
  const endpoint = parseEndpoint(connection.endpoint);

  /**
   * Resolve every row's identity from its manifest BEFORE exporting.
   *
   * `workspaces.repository_id` is the adoption key and had no writer on any user-facing
   * path until STA-283, so on a real machine `exportRegistry` published an empty
   * registry and reported every workspace unpublishable — while naming remedies the
   * person had already performed. `openWorkspace` now records it, and this covers rows
   * whose workspace has not been opened since.
   *
   * Local file reads and local row writes. No workspace database is opened.
   */
  const identities = reconcileRepositoryIds(hub);
  const local = exportRegistry(hub);
  const { entities, epoch } = await readSnapshotEntities(home, hubId, options);
  const diff = diffRegistry(
    local,
    publishedStateOf(entities),
    identities.duplicates,
    hub.listOptOuts().map((o) => o.repositoryId),
  );

  /**
   * **Publishing is scoped to ONE machine, and this is the refusal that makes that true.**
   *
   * Two machines sharing a registry does not work, in two independent ways that are not the
   * accepted "two machines race on a name":
   *
   *   - **Edge retraction cannot be authorised.** Absence of an edge locally is ambiguous
   *     between "removed" and "never had", and no comparison of the two sides can tell them
   *     apart: `.staple/repository.json` is TRACKED, so two clones legitimately share a
   *     `repositoryId` (#92), and slugs are names. Authority needs a record of what this
   *     machine KNEW — an applied adopt, or a per-edge ledger — which is hub-local state,
   *     i.e. the migration this whole leg exists to avoid.
   *   - **`addedAt` could not converge** until it was made create-only. A name race settles
   *     once both machines agree; that one could not, because neither value was wrong.
   *
   * So a publish requires this machine to be CURRENT with the service and refuses
   * otherwise. That is not a partial convergence story dressed up — it is a narrower
   * capability, stated. What it buys beyond honesty: a machine that IS current has had every
   * published edge, so absence really is removal, which is what makes the retraction floor
   * safe at all.
   *
   * The residual is a narrow race rather than the systematic loss it replaces — two machines
   * that are both current can interleave a read and a push. `docs/sync.md` records it, and
   * convergence is a separate ticket.
   */
  const foreignCount = diff.foreign.registrations.length + diff.foreign.crossLinks.length;
  if (foreignCount > 0) {
    const named = [
      ...diff.foreign.registrations.map((r) => `workspace "${r.slug}"`),
      ...diff.foreign.crossLinks.map((c) => `link ${c.label}`),
    ];
    throw cloudError(
      "conflict",
      `The service holds ${foreignCount} entr${foreignCount === 1 ? "y" : "ies"} this machine ` +
        `does not have: ${named.slice(0, 5).join(", ")}` +
        `${named.length > 5 ? `, and ${named.length - 5} more` : ""}. ` +
        "Publishing from here would retract them, so nothing was sent.\n\n" +
        "Publishing a registry is scoped to ONE machine. Either another machine has published " +
        "to this hub id, or this machine is behind — and the remedy is the same either way: " +
        "run `staple hub registry adopt --apply` to take on what the service holds, then " +
        "publish. If you did not expect another machine to be publishing here, two machines " +
        "sharing one registry is not supported yet: it needs an authority record for edge " +
        "removal that the hub does not have. See docs/sync.md.",
      { foreignRegistrations: diff.foreign.registrations.length, foreignCrossLinks: diff.foreign.crossLinks.length },
    );
  }

  if (diff.operations.length === 0) {
    return {
      hubId,
      endpoint: connection.endpoint,
      epoch,
      published: 0,
      created: 0,
      updated: 0,
      retracted: 0,
      batches: 0,
      applied: 0,
      deduplicated: 0,
      unpublishable: diff.unpublishable,
      retained: diff.retained,
      identities,
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
  let applied = 0;
  let deduplicated = 0;
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
    const response = (await pushOperations(
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
    )) as { results?: ReadonlyArray<{ status?: string }> };

    /**
     * The response is READ, not discarded.
     *
     * `published` is what was sent; these are what the service says it did. The
     * distinction is not pedantic — a `duplicate` is precisely how both operation-id
     * bugs in this module presented, and a report that counted the batch length
     * announced success while nothing had changed. Counting the answer means the next
     * such bug is visible in the report rather than only in the service's state.
     */
    for (const result of response.results ?? []) {
      if (result.status === "duplicate") deduplicated += 1;
      else applied += 1;
    }
  }

  return {
    hubId,
    endpoint: connection.endpoint,
    epoch,
    published: diff.operations.length,
    created: diff.operations.filter((o) => o.verb === "create").length,
    updated: diff.operations.filter((o) => o.verb === "update").length,
    retracted: diff.operations.filter(
      (o) => o.entity === CROSS_LINK_ENTITY && (o.payload as { present?: boolean }).present === false,
    ).length,
    applied,
    deduplicated,
    retained: diff.retained,
    batches: chunks.length,
    unpublishable: diff.unpublishable,
    identities,
    upToDate: false,
  };
}

/**
 * The operation id: `hub:<epoch>:<entity>:<32 hex of what the operation SAYS>`.
 *
 * ## Two bugs deep, and the version is what actually fixes it
 *
 * **First version: `hub:<epoch>:<entity>:<entityId>`.** Unique per entity per epoch,
 * which is not unique per OPERATION. The dedupe index is `(repo_id, epoch, op_id)` and a
 * duplicate is answered with the ORIGINAL operation's `seq` and a `duplicate` status the
 * contract defines as success — so a second write to one entity inside an epoch was
 * accepted, acknowledged and never applied.
 *
 * **Second version: hash the content.** That fixed "same entity, different content" and
 * introduced "same content, different POINT IN TIME", which is the same bug displaced.
 * A registry value can legitimately return to a value it held before — a workspace
 * renamed back, an edge retracted and re-added — and the id then repeats, collides with
 * its own earlier appearance, and is dropped. Reproduced as
 * `alpha → beta → alpha → beta`: the fourth operation collided with the second, the
 * service kept `alpha`, and every subsequent publish reported `published: 1` for ever.
 *
 * **This version adds the base VERSION**, which is monotonic in the number of operations
 * folded into the entity, so no two operations on one entity can share an id however
 * often the content cycles. It keeps the retry property intact: a retry re-derives the
 * same diff from the same snapshot, so the same base version, so a byte-identical id.
 *
 * ## The dedupe role of the id is a backstop, not the mechanism
 *
 * Worth saying plainly, because the second version was designed as though it were the
 * mechanism. Idempotency comes from `publishRegistry` re-reading `GET /snapshot` and
 * re-deriving the diff: an operation that already landed is excluded before an id is
 * computed at all. The id only has to be UNIQUE; being reproducible is a bonus that
 * makes a retried batch cheap rather than a correctness requirement.
 *
 * The `epoch` is in the id because a restore moves the epoch and re-mints ids; without
 * it, an id reused across a restore would be absorbed as a duplicate of an operation on
 * a timeline that no longer exists. The verb is hashed so the id distinguishes what an
 * operation MEANS rather than what it happens to carry.
 *
 * Fixed length by construction, which retires a guard the readable version needed: a
 * cross-link entity id is four percent-encoded names and could exceed the Worker's
 * 128-character cap on `opId` by itself.
 */
function operationId(operation: RegistryOperation, epoch: number): string {
  // Keys sorted, so an id cannot change because a payload was built in a different
  // order. Today's payloads are literals with fixed key order; relying on that would
  // be relying on something no test would notice changing.
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(operation.payload as unknown as Record<string, unknown>).sort(([a], [b]) =>
        a < b ? -1 : 1,
      ),
    ),
  );
  const digest = createHash("sha256")
    .update(
      // The base VERSION is the term that makes this unique over time. See the comment.
      `${operation.entityId}\n${operation.verb}\n${operation.baseVersion}\n${canonical}`,
    )
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
    /**
     * Null for `create`, and the folded version the operation moves off otherwise.
     *
     * This used to be a hardcoded 0, which was a lie the server happens not to read —
     * it records `baseVersion` without acting on it, because conflict detection is
     * field-scoped against a LOCAL version and the hub has none. The snapshot reports
     * the real folded version, so there is no reason to send a placeholder, and the
     * honest value is worth something to whoever next reads the raw log.
     */
    baseVersion: operation.verb === "create" ? null : operation.baseVersion,
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
  const connection = requireHubRegistryConnection(home, hubId);
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
        "`staple hub registry backup enable`.",
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
  const connection = requireHubRegistryConnection(home, hubId);
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
  const connection = requireHubRegistryConnection(home, hubId);
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
  const connection = requireHubRegistryConnection(home, hubId);
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
  const connection = requireHubRegistryConnection(home, hubId);
  requireHubBackupConsent(connection);
  const { token } = requireSession(home, hubId, options);
  const endpoint = parseEndpoint(connection.endpoint);
  const call = { repositoryId: hubId, token, deviceId: connection.deviceId, backupId };
  // Same reason as `adoptPublishedRegistry`: the adoption at the end of this keys on the
  // column, so it has to be right before the restore starts.
  reconcileRepositoryIds(hub);

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
  /**
   * Before adopting, not after. Adoption keys on `repository_id` through
   * `hub.findByRepositoryId`, so a machine whose rows have a null column matches nothing
   * and reports every incoming entry `absent` — including the workspaces it is holding a
   * clone of. That made the recovery path report the opposite of the truth.
   */
  reconcileRepositoryIds(hub);
  const { registry } = await readPublishedRegistry(home, hubId, options);
  const adoption = adoptRegistry(hub, registry, {
    ...(options.apply === undefined ? {} : { apply: options.apply }),
    ...(options.locate === undefined ? {} : { locate: options.locate }),
  });
  return { registry, adoption };
}
