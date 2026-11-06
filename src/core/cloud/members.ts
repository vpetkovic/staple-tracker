/**
 * Members of a shared workspace, and the people decisions made about them: who may join,
 * what they are called, and who is removed.
 *
 * Every function here is a person's action, called by `staple cloud requests|approve|deny|
 * members` and by the web UI's Members panel. None of them is an MCP tool and none ever
 * will be (`src/mcp.ts`, `cloud_status`). An approval admits a person into a workspace
 * whose contents are plaintext on the service, and a model answering yes on someone's
 * behalf is not that someone deciding.
 *
 * The service is the authority on every rule: who may admit a new person, who may rename
 * whom, who may remove. This side states the rule in the error it shows, so a refusal says
 * what to do instead of only "forbidden".
 *
 * ## The cache
 *
 * Whatever here has just talked to the service refreshes `members-cache.ts`, which is the
 * only place the rest of the client reads members from. A successful sync does too
 * ({@link refreshMembersCacheBestEffort}, called from `sync.ts`), and disconnect deletes it.
 */
import { requireSession } from "./connect.js";
import { lockAutoSyncForSharedWorkspace, noteRemoval, readConnection } from "./connection.js";
import {
  approveJoinRequest,
  cloudCodeOf,
  cloudError,
  denyJoinRequest,
  fetchRemoteMembers,
  listJoinRequests,
  removeRemoteMember,
  renameRemoteMember,
  type ApproveTarget,
  type PendingJoinRequest,
  type RemoteMembers,
  type RequestOptions,
} from "./client.js";
import type { SelectOptions } from "./credential-store.js";
import { parseEndpoint, type CloudEndpoint } from "./endpoint.js";
import { normalizeJoinCode } from "./join-preview.js";
import { MEMBERS_CACHE_VERSION, isSharedWorkspace, writeMembersCache, type CachedMember, type MembersCache } from "./members-cache.js";
import { StapleError } from "../types.js";
import { reassignMember } from "../member-assignees.js";
import type { WorkspaceStore } from "../store.js";

export type MemberOptions = RequestOptions & SelectOptions;

/** The endpoint and credentials one member-auth call needs. The token is never logged. */
export interface MemberSession {
  readonly endpoint: CloudEndpoint;
  readonly repositoryId: string;
  readonly token: string;
  readonly deviceId: string;
}

function sessionFor(home: string, repositoryId: string, options: SelectOptions): MemberSession {
  const { connection, token } = requireSession(home, repositoryId, options);
  return { endpoint: parseEndpoint(connection.endpoint), repositoryId, token, deviceId: connection.deviceId };
}

/** The service's member list as the cache stores it. */
export function membersCacheFrom(repositoryId: string, remote: RemoteMembers, now: Date = new Date()): MembersCache {
  return {
    version: MEMBERS_CACHE_VERSION,
    repositoryId,
    fetchedAt: now.toISOString(),
    self: remote.self,
    members: remote.members,
  };
}

/**
 * Fetch the member list and write it to the cache. Throws on any failure: a caller that
 * wants the list (`staple cloud members`) has to be told it did not get one.
 */
export async function refreshMembersCacheWith(
  home: string,
  session: MemberSession,
  options: RequestOptions = {},
): Promise<MembersCache> {
  let remote: RemoteMembers;
  try {
    remote = await fetchRemoteMembers(
      session.endpoint,
      { repositoryId: session.repositoryId, token: session.token, deviceId: session.deviceId },
      options,
    );
  } catch (error) {
    throw noteRemoval(home, session.repositoryId, error);
  }
  const cache = membersCacheFrom(session.repositoryId, remote);
  /**
   * Written only while the connection that asked still exists, checked at the moment of the
   * write. A disconnect (or a re-connect as another device) while the list was on its way
   * back deleted the cache on purpose; writing it now would bring a shared workspace back to
   * life on a machine that has left it.
   */
  if (connectionStillAsks(home, session)) {
    writeMembersCache(home, cache);
    /**
     * The moment this machine learns the workspace is shared (2+ current members), automatic
     * sync goes on here and the reason is recorded, on every device, the owner's included.
     * It is not this person's toggle any more: `setConsent` refuses `auto off` while it lasts.
     */
    if (isSharedWorkspace(cache)) lockAutoSyncForSharedWorkspace(home, session.repositoryId);
  }
  return cache;
}

function connectionStillAsks(home: string, session: MemberSession): boolean {
  try {
    const connection = readConnection(home, session.repositoryId);
    return connection !== null && connection.repositoryId === session.repositoryId && connection.deviceId === session.deviceId;
  } catch {
    return false;
  }
}

/** {@link refreshMembersCacheWith}, from this machine's connection for the repository. */
export function refreshMembersCache(home: string, repositoryId: string, options: MemberOptions = {}): Promise<MembersCache> {
  return refreshMembersCacheWith(home, sessionFor(home, repositoryId, options), options);
}

/**
 * The same, but never fails the caller. Used after a sync and after a join, where the list
 * is a convenience and the operation that just succeeded is the point. Returns null when
 * the list could not be fetched or written.
 */
export async function refreshMembersCacheBestEffort(
  home: string,
  session: MemberSession,
  options: RequestOptions = {},
): Promise<MembersCache | null> {
  try {
    return await refreshMembersCacheWith(home, session, options);
  } catch {
    return null;
  }
}

/**
 * The one-line nudge after a connect makes this device the owner of a workspace whose
 * owner is still called `owner` — the name the migration backfills and the first connect
 * gets. Null in every other case. Pure: it reads the list it is given.
 */
export function ownerRenameHint(cache: MembersCache | null): string | null {
  if (!cache) return null;
  const self = cache.members.find((member) => member.memberId === cache.self.memberId);
  if (!self?.isOwner || self.name !== "owner") return null;
  return `You are this workspace's owner, listed as "owner". Rename with: staple cloud members rename owner <your name>`;
}

/**
 * After a connect: fetch the member list once, when the service has members, and write it.
 * Best effort; null when the service has no members or the list could not be fetched.
 * Connecting was consented to, and this read is part of the same act.
 */
export async function membersAfterConnect(
  home: string,
  repositoryId: string,
  capabilities: { members?: boolean },
  options: MemberOptions = {},
): Promise<MembersCache | null> {
  if (capabilities.members !== true) return null;
  try {
    return await refreshMembersCache(home, repositoryId, options);
  } catch {
    return null;
  }
}

/** `staple cloud requests`: pending join requests, newest last. */
export async function listPendingRequests(
  home: string,
  repositoryId: string,
  options: MemberOptions = {},
): Promise<PendingJoinRequest[]> {
  const session = sessionFor(home, repositoryId, options);
  let requests: PendingJoinRequest[];
  try {
    requests = await listJoinRequests(session.endpoint, session, options);
  } catch (error) {
    throw noteRemoval(home, repositoryId, error);
  }
  return [...requests].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

/** Who an approval admits the joining device as. Exactly one of the two. */
export type ApproveAs = { asNewMember: string } | { toMember: string };

export interface ApproveOutcome {
  readonly requestId: string;
  readonly code: string;
  readonly member: { memberId: string; name: string } | null;
  /** True when the approval created a new member (`--as`), false when it added a device. */
  readonly newMember: boolean;
  /** The refreshed list, or null when it could not be fetched after the approval. */
  readonly members: MembersCache | null;
}

const APPROVE_RULE =
  "Only the workspace owner may admit a new person (`--as <name>`), and `--as` with a removed " +
  "member's name reinstates them. Any member may add a device to themselves (`--to <your own name>`).";

/**
 * `staple cloud approve <code> (--as <name> | --to <member>)`.
 *
 * `--to` takes a member's name (case-insensitive) or id, resolved against a FRESH list
 * rather than the cache, so a member renamed a minute ago on another machine is still found.
 */
export async function approveRequest(
  home: string,
  repositoryId: string,
  rawCode: string,
  as: ApproveAs,
  options: MemberOptions = {},
): Promise<ApproveOutcome> {
  const code = normalizeJoinCode(rawCode);
  const session = sessionFor(home, repositoryId, options);

  let target: ApproveTarget;
  if ("asNewMember" in as) {
    const name = as.asNewMember.trim();
    if (name.length === 0) throw new StapleError("validation", "--as needs the new member's name.");
    target = { newMember: { name } };
  } else {
    const list = await refreshMembersCacheWith(home, session, options);
    const wanted = as.toMember.trim().toLowerCase();
    const removed = list.members.find(
      (member) => member.removed && (member.memberId === as.toMember.trim() || member.name.toLowerCase() === wanted),
    );
    const current = list.members.find((member) => !member.removed && member.name.toLowerCase() === wanted);
    if (removed && !current) {
      /**
       * A device cannot be added to a member who was removed: the service refuses it
       * (`forbidden`). Bringing the person back is the owner's `--as`, which reinstates
       * the removed member under the same id, so their history stays theirs.
       */
      throw new StapleError(
        "validation",
        `${removed.name} was removed from this workspace, so no device can be added to them. ` +
          `To bring them back, the owner approves with: staple cloud approve ${code} --as ${removed.name}` +
          " (this reinstates the same member, and their past work stays attributed to them).",
        { removedMember: removed.memberId },
      );
    }
    target = { memberId: findMember(list.members, as.toMember).memberId };
  }

  let approved: Awaited<ReturnType<typeof approveJoinRequest>>;
  try {
    approved = await approveJoinRequest(session.endpoint, { ...session, code, target }, options);
  } catch (error) {
    throw explainRefusal(error, APPROVE_RULE, code);
  }
  const members = await refreshMembersCacheBestEffort(home, session, options);
  return { requestId: approved.requestId, code, member: approved.member, newMember: "newMember" in target, members };
}

/** `staple cloud deny <code>`. Any member may deny. */
export async function denyRequest(
  home: string,
  repositoryId: string,
  rawCode: string,
  options: MemberOptions = {},
): Promise<{ requestId: string; code: string }> {
  const code = normalizeJoinCode(rawCode);
  const session = sessionFor(home, repositoryId, options);
  try {
    const denied = await denyJoinRequest(session.endpoint, { ...session, code }, options);
    return { requestId: denied.requestId, code };
  } catch (error) {
    throw explainRefusal(noteRemoval(home, repositoryId, error), "Any member may deny a pending request.", code);
  }
}

/** `staple cloud members rename <member> <name>`. Yourself, or anyone when you are the owner. */
export async function renameMember(
  home: string,
  repositoryId: string,
  who: string,
  newName: string,
  options: MemberOptions = {},
  /**
   * This workspace, so the tickets assigned to the old name move with the member
   * (`reassignMember`). Omitted only by a caller with no workspace open, which then leaves
   * them on the old name.
   */
  local?: { store: WorkspaceStore; actor: string | null },
): Promise<{ memberId: string; from: string; to: string; members: MembersCache | null; reassigned: string[] }> {
  const name = newName.trim();
  if (name.length === 0) throw new StapleError("validation", "The new name cannot be empty.");
  const session = sessionFor(home, repositoryId, options);
  const list = await refreshMembersCacheWith(home, session, options);
  const member = findMember(list.members, who);
  try {
    await renameRemoteMember(session.endpoint, { ...session, memberId: member.memberId, name }, options);
  } catch (error) {
    throw explainRefusal(
      error,
      "A member may rename themselves; the owner may rename anyone. Names are unique in a " +
        "workspace, ignoring case.",
    );
  }
  // After the service accepted it, and not before: a refused rename must move no ticket.
  const reassigned = local ? reassignMember(local.store, member.name, name, local.actor) : [];
  const members = await refreshMembersCacheBestEffort(home, session, options);
  return { memberId: member.memberId, from: member.name, to: name, members, reassigned };
}

/**
 * `staple cloud members remove <member> --confirm <name>`. Owner only, and never the owner.
 *
 * The name typed back is checked HERE, before any request, against the fresh list. It is
 * the same ceremony as `purge --confirm <repositoryId>`: the confirmation has to be read
 * off what is about to be removed, so it cannot be muscle memory.
 */
export async function removeMember(
  home: string,
  repositoryId: string,
  who: string,
  confirmName: string | undefined,
  options: MemberOptions = {},
): Promise<{ memberId: string; name: string; devicesRevoked: number; members: MembersCache | null }> {
  const session = sessionFor(home, repositoryId, options);
  const list = await refreshMembersCacheWith(home, session, options);
  const member = findMember(list.members, who);
  if (member.memberId === list.self.memberId) {
    throw new StapleError(
      "validation",
      "You cannot remove yourself. The owner stays the owner in this version; to stop using this " +
        "machine, `staple cloud disconnect`.",
    );
  }
  if (confirmName === undefined || confirmName.trim().toLowerCase() !== member.name.toLowerCase()) {
    throw new StapleError(
      "validation",
      (confirmName === undefined ? "Nothing was removed. " : "Nothing was removed: --confirm did not match. ") +
        `Removing ${member.name} revokes every one of their devices. To proceed, re-run with ` +
        `--confirm ${member.name}`,
      { expected: member.name },
    );
  }
  try {
    await removeRemoteMember(session.endpoint, { ...session, memberId: member.memberId }, options);
  } catch (error) {
    throw explainRefusal(error, "Only the workspace owner may remove a member, and never themselves.");
  }
  const members = await refreshMembersCacheBestEffort(home, session, options);
  return {
    memberId: member.memberId,
    name: member.name,
    devicesRevoked: member.devices.filter((device) => !device.revoked).length,
    members,
  };
}

/** A member by id, or by name ignoring case. Removed members are matched too, by id only. */
export function findMember(members: readonly CachedMember[], who: string): CachedMember {
  const wanted = who.trim();
  const byId = members.find((member) => member.memberId === wanted);
  if (byId) return byId;
  const byName = members.find((member) => !member.removed && member.name.toLowerCase() === wanted.toLowerCase());
  if (byName) return byName;
  const names = members.filter((member) => !member.removed).map((member) => member.name);
  throw new StapleError(
    "not_found",
    `No member named "${wanted}". Members: ${names.length > 0 ? names.join(", ") : "(none)"}.`,
  );
}

/**
 * A service refusal with the rule in front of it.
 *
 * `forbidden` gets the rule, because "forbidden" alone does not say who may. `not_found` on
 * a code means the request is gone or the code was mistyped. Everything else passes through
 * untouched, with its own code, so retry bits and exit codes stay the service's.
 */
function explainRefusal(error: unknown, rule: string, code?: string): unknown {
  if (!(error instanceof StapleError)) return error;
  const cloudCode = cloudCodeOf(error);
  if (cloudCode === "forbidden") {
    return cloudError("forbidden", `${rule} The service refused: ${error.message}`, {
      ...error.detail,
      serverMessage: error.message,
    });
  }
  if (cloudCode === "not_found" && code !== undefined) {
    return cloudError(
      "not_found",
      `No pending request with code ${code}. It may have expired (requests live ten minutes), been ` +
        "denied, or been mistyped. `staple cloud requests` lists the pending ones.",
      { ...error.detail, serverMessage: error.message },
    );
  }
  return error;
}
