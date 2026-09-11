/**
 * Fenced server leases — the client half, and the checkout/release integration.
 *
 * Contract: `docs/sync.md`, "Claims: a local checkout is not a global lease".
 * The server half is `worker/src/leases.ts` and it is not re-litigated here: it
 * allocates the monotonic token, it owns the expiry, and it decides every
 * question of legitimacy in one SQL predicate. This module's whole job is to
 * ask it correctly, record what it said, and never pretend to know better.
 *
 * ## Nothing here is on an ordinary command path
 *
 * `staple checkout`, `staple release` and `staple done` do not import this file
 * and their behaviour is byte-identical to the build before it. Global
 * exclusivity is acquired by a separately named verb under `staple cloud`,
 * which is the only place in this tree a request is allowed to originate.
 *
 * That is not fastidiousness. *"Do not make local checkout depend on a lease
 * being reachable — that would put a network call on an everyday verb and break
 * the zero-network contract."* A flag on `checkout` would satisfy the letter of
 * that and break its spirit, because the import would exist and the next person
 * to add a convenience default would not be able to see why they shouldn't.
 *
 * ## Disconnected is a first-class outcome, not a failure
 *
 * A workspace with no connection record claims **locally**, succeeds, and says
 * `scope: "local"` with a sentence that names the limitation. Offline
 * acquisition is allowed because refusing to work without a network would be a
 * worse tracker; it is *labelled*, never silently upgraded on the next sync.
 * The connection record is read before anything else, so a disconnected
 * repository does not so much as resolve an endpoint.
 *
 * ## The compensating release
 *
 * {@link acquireClaim} takes the remote lease first and then runs the local
 * claim, because the local claim is the thing that must not be half-done. If a
 * gate, the queue order or an unresolved blocker refuses the local claim, the
 * lease that was just taken is released before the error is rethrown — a local
 * guard must not strand a remote lease. If that compensating release itself
 * fails, it is reported and the TTL is the backstop: the server's clock is the
 * only one entitled to expire anything, and it will.
 *
 * ## Heartbeats are not journaled
 *
 * Acquire and release journal `lease.create` and `lease.delete`, so another
 * device can project them onto `checkout_agent` and `checkout_at`. A renewal
 * updates the local mirror and nothing else. A beat is liveness, not state
 * anybody else needs, and journalling one every few seconds would turn the
 * operation log into a heartbeat log for no reader's benefit.
 */
import type { DatabaseSync } from "node:sqlite";
import { StapleError, type Issue } from "../types.js";
import type { WorkspaceStore } from "../store.js";
import {
  acquireRemoteLease,
  cloudCodeOf,
  releaseRemoteLease,
  renewRemoteLease,
  type CloudErrorCode,
  type RemoteLease,
  type RequestOptions,
} from "./client.js";
import { readConnection } from "./connection.js";
import {
  claimScopeOf,
  forgetLocalLease,
  leaseScopeNote,
  listLocalLeases,
  readLocalLease,
  recordLocalLease,
  serverInstant,
  LOCAL_SCOPE_NOTE,
  type ClaimScope,
  type LocalLease,
} from "./lease-store.js";
import { openSession, type Session } from "./sync.js";

export interface LeaseOptions extends RequestOptions {
  /** The staple home. Where the connection record and the credential live. */
  readonly home: string;
  /** What to ask for. Omitted means "whatever the service's default is". */
  readonly ttlSeconds?: number;
}

/** The outcome of a claim, with the exclusivity it is entitled to assert. */
export interface ClaimOutcome {
  readonly scope: ClaimScope;
  readonly entityId: string;
  readonly issue: Issue;
  /** Null on a `local` claim. There is no lease to describe. */
  readonly lease: LocalLease | null;
  /** A sentence a surface prints verbatim. Never assembled at the call site. */
  readonly note: string;
}

/** Why a remote release did not happen. Null when it did. */
export type ReleaseReason = "disconnected" | "no-lease" | "superseded" | "revoked" | "offline";

export interface ReleaseOutcome {
  /**
   * The scope of the claim that was given up, as the SERVER confirmed it. A
   * release the server refused was never globally exclusive as far as anybody
   * can now prove, so it reports `local`.
   */
  readonly scope: ClaimScope;
  readonly entityId: string;
  readonly remoteReleased: boolean;
  readonly reason: ReleaseReason | null;
  /**
   * Whether a lease that was supposed to be given back was NOT given back.
   *
   * False when there was never one to give — a disconnected repository, or an
   * entity this device never leased. That distinction is the difference between
   * an alarming headline and an ordinary one, and it is computed here rather
   * than re-derived by each surface from `remoteReleased` plus `reason`, which
   * is exactly the kind of two-field inference that goes wrong on one surface
   * and not the others.
   */
  readonly stranded: boolean;
  /** Null when the local claim was already gone or was not ours to give up. */
  readonly issue: Issue | null;
  readonly note: string;
}

export interface RenewOutcome {
  readonly entityId: string;
  readonly lease: LocalLease;
  readonly note: string;
}

/**
 * Resolve the connection, or say plainly that there isn't one.
 *
 * Returns null rather than throwing, because "not connected" is a legitimate
 * answer to every question this module is asked and only some of them treat it
 * as an error. Reads one file; resolves no endpoint.
 */
function connectionOrNull(home: string, repositoryId: string): { deviceId: string } | null {
  const connection = readConnection(home, repositoryId);
  return connection ? { deviceId: connection.deviceId } : null;
}

function requireSession(home: string, repositoryId: string): Session {
  return openSession(home, repositoryId);
}

/** The mirror row shape for a lease the server just described. */
function mirrorOf(remote: RemoteLease): LocalLease {
  return {
    entityId: remote.entityId,
    fencingToken: remote.fencingToken,
    holder: remote.holder,
    deviceId: remote.deviceId,
    serverExpiresAt: serverInstant(remote.expiresAt),
    acquiredAt: serverInstant(remote.acquiredAt),
    renewedAt: serverInstant(remote.renewedAt),
  };
}

/**
 * Take the lease on one entity. Network, mirror, and nothing else.
 *
 * The entity-level primitive: no issue is claimed and no journal entry is
 * written. {@link acquireClaim} is the composed verb an agent actually runs.
 * This exists separately because the lease is scoped to an entity id, and there
 * are legitimate callers — a takeover drill, a test modelling the other machine
 * — that want exclusivity without the local transition.
 */
export async function acquireLease(
  db: DatabaseSync,
  repositoryId: string,
  entityId: string,
  holder: string,
  options: LeaseOptions,
): Promise<LocalLease> {
  const session = requireSession(options.home, repositoryId);
  const { lease } = await acquireRemoteLease(
    session.endpoint,
    {
      repositoryId: session.repositoryId,
      token: session.token,
      deviceId: session.deviceId,
      entityId,
      holder,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    },
    options,
  );
  const mirror = mirrorOf(lease);
  recordLocalLease(db, mirror);
  return mirror;
}

/**
 * Claim an issue: the server lease first, then the local checkout.
 *
 * On a disconnected workspace the network step is skipped entirely and the
 * result is labelled `local`. On a connected one, a lost race surfaces as the
 * server's own non-retryable `conflict` and **nothing is claimed locally** — a
 * device that lost the lease has no business marking the work in progress.
 */
export async function acquireClaim(
  store: WorkspaceStore,
  repositoryId: string,
  ref: string,
  holder: string,
  options: LeaseOptions,
): Promise<ClaimOutcome> {
  const issue = store.getIssue(ref);
  const entityId = issue.id;
  const connection = connectionOrNull(options.home, repositoryId);

  if (connection === null) {
    /**
     * The disconnected path, and the invariant that is easiest to break. No
     * endpoint is parsed, no credential is read, no request is attempted — the
     * connection record was absent and that was the end of it. The claim is the
     * same local claim `staple checkout` makes, and it is labelled as such.
     */
    const claimed = store.checkoutIssue(ref, holder);
    return {
      scope: "local",
      entityId,
      issue: claimed,
      lease: null,
      note: LOCAL_SCOPE_NOTE,
    };
  }

  const session = requireSession(options.home, repositoryId);
  const { lease } = await acquireRemoteLease(
    session.endpoint,
    {
      repositoryId: session.repositoryId,
      token: session.token,
      deviceId: session.deviceId,
      entityId,
      holder,
      ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
    },
    options,
  );
  const mirror = mirrorOf(lease);
  recordLocalLease(store.db, mirror);

  try {
    /**
     * One transaction, two operations. The claim and the lease land together or
     * not at all — `checkoutIssue` opens the scope and `record` joins it, which
     * is what re-entrancy in the journal seam is for.
     */
    const claimed = store.journaled(() => {
      const result = store.checkoutIssue(ref, holder);
      store.journal.record({
        entity: "lease",
        entityId,
        verb: "create",
        payload: {
          fencingToken: mirror.fencingToken,
          holder: mirror.holder,
          deviceId: mirror.deviceId,
          serverExpiresAt: mirror.serverExpiresAt,
          acquiredAt: mirror.acquiredAt,
        },
        actor: holder,
      });
      return result;
    });

    return {
      scope: "lease",
      entityId,
      issue: claimed,
      lease: mirror,
      note: leaseScopeNote(mirror),
    };
  } catch (error) {
    /**
     * The compensating release. The local claim was refused — a gate, the plan,
     * an unresolved blocker — and the lease taken a moment ago is now held for
     * work that is not going to start. Give it back before rethrowing, and if
     * giving it back fails, leave it: the server's TTL will expire it, and there
     * is nothing this device can usefully do about a service it cannot reach.
     */
    forgetLocalLease(store.db, entityId);
    await releaseRemoteLease(
      session.endpoint,
      {
        repositoryId: session.repositoryId,
        token: session.token,
        deviceId: session.deviceId,
        entityId,
        fencingToken: mirror.fencingToken,
      },
      options,
    ).catch(() => undefined);
    throw error;
  }
}

/**
 * One heartbeat: renew, presenting the fencing token this device was given.
 *
 * A `conflict` means the lease was expired, stolen or superseded, and the mirror
 * row is forgotten before the error is rethrown — a device that keeps a row the
 * server has disowned will present that token again, and be refused again.
 * It is not retried, because retrying a lease we demonstrably do not hold is a
 * spin, which is exactly why the taxonomy marks the code non-retryable.
 */
/**
 * The issue a lease operation by `ref` is about — refused when `ref` was renumbered here
 * and this device's lease is on the issue that moved off it, not on the one it names now.
 * By the old number, a renewal or a release would otherwise be aimed at the new holder.
 */
function leasedIssue(store: WorkspaceStore, ref: string): ReturnType<WorkspaceStore["getIssue"]> {
  const issue = store.getIssue(ref);
  const moved = store.movedOff(ref);
  if (moved !== null && readLocalLease(store.db, moved.issueId) !== null && readLocalLease(store.db, issue.id) === null) {
    throw new StapleError(
      "conflict",
      `${moved.identifier} was renumbered here at ${moved.at}: the issue this device holds the lease on is now ` +
        `${moved.nowIdentifier}, and ${moved.identifier} names another issue. Nothing was sent. Use ${moved.nowIdentifier}.`,
      { renumbered: { from: moved.identifier, to: moved.nowIdentifier, at: moved.at, issueId: moved.issueId } },
    );
  }
  return issue;
}

export async function renewClaim(
  store: WorkspaceStore,
  repositoryId: string,
  ref: string,
  options: LeaseOptions,
): Promise<RenewOutcome> {
  const issue = leasedIssue(store, ref);
  return renewLease(store.db, repositoryId, issue.id, options, issue.identifier);
}

/**
 * {@link renewClaim} without the issue lookup, for entity-level callers.
 *
 * `label` is what a human should be shown when there is nothing to renew — an
 * identifier if the caller has one, and the entity id if it does not. A refusal
 * that names a raw UUID is a refusal nobody can act on.
 */
export async function renewLease(
  db: DatabaseSync,
  repositoryId: string,
  entityId: string,
  options: LeaseOptions,
  label?: string,
): Promise<RenewOutcome> {
  const named = label ?? entityId;
  if (connectionOrNull(options.home, repositoryId) === null) {
    throw new StapleError(
      "not_found",
      `This repository is not connected on this machine, so ${named} is not held under a server ` +
        `lease and there is nothing to renew. A local claim does not expire and needs no ` +
        `heartbeat. Nothing was sent.`,
    );
  }
  const held = readLocalLease(db, entityId);
  if (!held) {
    throw new StapleError(
      "not_found",
      `This device holds no lease on ${named}, so there is no fencing token to present. ` +
        `Acquire one with \`staple cloud lease acquire\`; nothing was sent.`,
    );
  }

  const session = requireSession(options.home, repositoryId);
  try {
    const { lease } = await renewRemoteLease(
      session.endpoint,
      {
        repositoryId: session.repositoryId,
        token: session.token,
        deviceId: session.deviceId,
        entityId,
        fencingToken: held.fencingToken,
        ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
      },
      options,
    );
    const mirror = mirrorOf(lease);
    recordLocalLease(db, mirror);
    return { entityId, lease: mirror, note: leaseScopeNote(mirror) };
  } catch (error) {
    if (cloudCodeOf(error) === "conflict") forgetLocalLease(db, entityId);
    throw error;
  }
}

/** How a failed remote release maps onto the reason a surface prints. */
function reasonFor(code: CloudErrorCode | null): ReleaseReason {
  if (code === "revoked" || code === "auth" || code === "forbidden") return "revoked";
  if (code === "offline" || code === "unavailable" || code === "rate_limited") return "offline";
  return "superseded";
}

/**
 * Give the claim back: the remote lease first, then the local checkout.
 *
 * **The local release always happens.** An unreachable service, a revoked
 * device or a stolen lease are all reasons the remote half failed, and none of
 * them is a reason to hold a human's own database hostage. What the command must
 * not do is *report success*: the outcome carries `remoteReleased: false` and
 * the reason, in the same spirit as `cloud purge` refusing to claim a deletion
 * it could not perform.
 *
 * On the other side of that: a device whose lease was expired, stolen or revoked
 * **cannot** release the remote task. The server refuses it, this function
 * reports the refusal, and the winner keeps the lease. That is the guarantee,
 * and it lives in the Worker's predicate rather than in anything here.
 */
export async function releaseClaim(
  store: WorkspaceStore,
  repositoryId: string,
  ref: string,
  options: LeaseOptions,
): Promise<ReleaseOutcome> {
  const issue = leasedIssue(store, ref);
  const entityId = issue.id;
  const connection = connectionOrNull(options.home, repositoryId);
  const held = readLocalLease(store.db, entityId);

  let remoteReleased = false;
  let reason: ReleaseReason | null = null;
  let fencingToken: number | null = null;

  if (connection === null) {
    reason = "disconnected";
  } else if (!held || held.deviceId !== connection.deviceId) {
    reason = "no-lease";
  } else {
    fencingToken = held.fencingToken;
    const session = requireSession(options.home, repositoryId);
    try {
      await releaseRemoteLease(
        session.endpoint,
        {
          repositoryId: session.repositoryId,
          token: session.token,
          deviceId: session.deviceId,
          entityId,
          fencingToken: held.fencingToken,
        },
        options,
      );
      remoteReleased = true;
      forgetLocalLease(store.db, entityId);
    } catch (error) {
      reason = reasonFor(cloudCodeOf(error));
      /**
       * A `superseded` refusal is the server saying this token is not the
       * current one, so the mirror row is a lie and goes. A `revoked` or
       * `offline` refusal says nothing about who holds the lease — only that
       * this device could not ask — so the row stays.
       */
      if (reason === "superseded") forgetLocalLease(store.db, entityId);
    }
  }

  /**
   * The local half. Refusals here are ordinary — the issue may already be back
   * in `ready`, or held by whoever took it over — and they do not turn a release
   * into an error, because the remote half is the part this verb exists for.
   */
  let released: Issue | null = null;
  try {
    released = store.releaseIssue(ref);
    if (remoteReleased) {
      store.journaled(() => {
        store.journal.record({
          entity: "lease",
          entityId,
          verb: "delete",
          payload: { fencingToken, holder: held?.holder ?? null },
          actor: held?.holder ?? null,
        });
      });
    }
  } catch {
    released = null;
  }

  return {
    scope: remoteReleased ? "lease" : "local",
    entityId,
    remoteReleased,
    reason,
    stranded: !remoteReleased && reason !== "disconnected" && reason !== "no-lease",
    issue: released,
    note: releaseNote(remoteReleased, reason),
  };
}

function releaseNote(remoteReleased: boolean, reason: ReleaseReason | null): string {
  if (remoteReleased) {
    return "Lease released. This entity is free for any device to claim.";
  }
  switch (reason) {
    case "disconnected":
      return (
        "The local claim was released. This repository is not connected on this machine, so " +
        "there was no server lease to release and none was claimed."
      );
    case "no-lease":
      return (
        "The local claim was released. This device held no server lease on it, so nothing was " +
        "released remotely and no global exclusivity was ever asserted."
      );
    case "revoked":
      return (
        "The local claim was released, but the server lease was NOT released: this device's " +
        "credential was refused. Re-connect with `staple cloud connect`. The lease stands until " +
        "the service expires it."
      );
    case "offline":
      return (
        "The local claim was released, but the server lease was NOT released: the service could " +
        "not be reached. Run `staple cloud lease release` again when it can."
      );
    default:
      return (
        "The local claim was released, but the server lease was NOT released: this device no " +
        "longer holds it. It expired or was taken over, and another device may be working on it."
      );
  }
}

/**
 * What this device is entitled to say about a claim, without asking anybody.
 *
 * Local files only. Used by `cloud lease status` and by any surface that wants
 * to render the scope; it is the reason a disconnected workspace can be honest
 * about its own limits without a request.
 */
export function claimScope(
  db: DatabaseSync,
  home: string,
  repositoryId: string,
  entityId: string,
): ClaimScope {
  const connection = connectionOrNull(home, repositoryId);
  return claimScopeOf(db, connection?.deviceId ?? null, entityId);
}

export interface LeaseSummary {
  readonly connected: boolean;
  readonly deviceId: string | null;
  readonly leases: readonly (LocalLease & { readonly scope: ClaimScope })[];
  readonly note: string;
}

/**
 * Every lease this device knows about, with the scope each one earns.
 *
 * A mirror row whose `deviceId` is not this machine's is another device's lease,
 * learned by pulling its `lease.create`. It is shown — knowing who holds the
 * work is the point — and it is scoped `local`, because this device's claim on
 * that entity is not globally exclusive whatever the row says.
 */
export function summarizeLeases(
  db: DatabaseSync,
  home: string,
  repositoryId: string,
): LeaseSummary {
  const connection = connectionOrNull(home, repositoryId);
  const deviceId = connection?.deviceId ?? null;
  const leases = listLocalLeases(db).map((lease) => ({
    ...lease,
    scope: claimScopeOf(db, deviceId, lease.entityId),
  }));
  return {
    connected: connection !== null,
    deviceId,
    leases,
    note: connection === null ? LOCAL_SCOPE_NOTE : "Expiry is the service's, not this machine's.",
  };
}
