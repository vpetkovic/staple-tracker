/**
 * The machine-local copy of a shared workspace's member list.
 *
 * The sync service is the authority on who the members are and which devices belong
 * to them (`GET /v1/repos/{repoId}/members`). This file is what the rest of the client
 * reads, so that `ls --mine`, the assignee picker and the member chip on an activity row
 * never make a network call of their own. It is refreshed by whatever already talks to
 * the service (`cloud sync`, `cloud members`, an approval) and read by everything else.
 *
 * ## Where it lives, and why not beside the connection record
 *
 * `listConnections` reads every `*.json` file in the cloud directory as a connection
 * record. A `<repoId>.members.json` sitting next to `<repoId>.json` would be parsed as a
 * connection for the repository `<repoId>.members` and fail. So the cache has its own
 * subdirectory, `<cloud dir>/members/<repoId>.json`.
 *
 * ## Absent means "not a shared workspace here"
 *
 * A workspace that was never connected, or whose device has not fetched the list yet,
 * has no file. Readers treat that as "no members known" and fall back to their
 * single-person behaviour. They never fetch on a read path.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../config/atomic.js";
import { StapleError } from "../types.js";
import { credentialDir } from "./credential-store.js";

export const MEMBERS_CACHE_VERSION = 1;

export interface CachedMemberDevice {
  readonly deviceId: string;
  /** Human label given at join, for example the host name. Null when none was given. */
  readonly label: string | null;
  /** Unix milliseconds, from the service. Null when the device has never made a request. */
  readonly lastSeenAt: number | null;
  readonly revoked: boolean;
}

export interface CachedMember {
  readonly memberId: string;
  /** Unique per repository. This is the string written into `assignee`. */
  readonly name: string;
  readonly isOwner: boolean;
  /** Removed members stay listed so history still shows who did what. */
  readonly removed: boolean;
  readonly devices: readonly CachedMemberDevice[];
}

export interface MembersCache {
  readonly version: typeof MEMBERS_CACHE_VERSION;
  readonly repositoryId: string;
  /** ISO-8601, when this copy was fetched from the service. */
  readonly fetchedAt: string;
  /** Who this machine is. */
  readonly self: { readonly memberId: string; readonly deviceId: string };
  readonly members: readonly CachedMember[];
}

export function membersCachePath(home: string, repositoryId: string): string {
  return join(credentialDir(home), "members", `${repositoryId}.json`);
}

/**
 * Read the cache, or null when there is none.
 *
 * Unlike the connection record, an unreadable cache is not an error worth stopping a
 * command for: it holds nothing that cannot be fetched again, and every reader has a
 * single-person fallback. A file that fails to parse or has the wrong shape reads as
 * absent.
 */
export function readMembersCache(home: string, repositoryId: string): MembersCache | null {
  const path = membersCachePath(home, repositoryId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isMembersCache(parsed, repositoryId) ? parsed : null;
  } catch {
    return null;
  }
}

/** Write the cache. `0600` in a `0700` directory, atomically, like the connection record. */
export function writeMembersCache(home: string, cache: MembersCache): string {
  if (!isMembersCache(cache, cache.repositoryId)) {
    throw new StapleError("validation", "members cache: refusing to write a malformed member list");
  }
  const path = membersCachePath(home, cache.repositoryId);
  writeFileAtomic(path, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 });
  return path;
}

export function deleteMembersCache(home: string, repositoryId: string): boolean {
  const path = membersCachePath(home, repositoryId);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** The member this machine belongs to, or null when it is not in the list. */
export function selfMember(cache: MembersCache): CachedMember | null {
  return cache.members.find((m) => m.memberId === cache.self.memberId) ?? null;
}

/**
 * The member that owns a device.
 *
 * `deviceId` null means "a change made on this machine" (local events carry no origin
 * device), so it resolves to this machine's member.
 */
export function memberOfDevice(cache: MembersCache, deviceId: string | null): CachedMember | null {
  const id = deviceId ?? cache.self.deviceId;
  return cache.members.find((m) => m.devices.some((d) => d.deviceId === id)) ?? null;
}

/** The member with this exact name, case-insensitively, or null. */
export function memberByName(cache: MembersCache, name: string): CachedMember | null {
  const wanted = name.trim().toLowerCase();
  return cache.members.find((m) => m.name.toLowerCase() === wanted) ?? null;
}

function isMembersCache(value: unknown, repositoryId: string): value is MembersCache {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== MEMBERS_CACHE_VERSION || v.repositoryId !== repositoryId) return false;
  if (typeof v.fetchedAt !== "string") return false;
  const self = v.self as Record<string, unknown> | undefined;
  if (!self || typeof self.memberId !== "string" || typeof self.deviceId !== "string") return false;
  if (!Array.isArray(v.members)) return false;
  return v.members.every((m: unknown) => {
    if (typeof m !== "object" || m === null) return false;
    const r = m as Record<string, unknown>;
    return (
      typeof r.memberId === "string" &&
      typeof r.name === "string" &&
      r.name.length > 0 &&
      typeof r.isOwner === "boolean" &&
      typeof r.removed === "boolean" &&
      Array.isArray(r.devices) &&
      r.devices.every((d: unknown) => {
        if (typeof d !== "object" || d === null) return false;
        const dr = d as Record<string, unknown>;
        return (
          typeof dr.deviceId === "string" &&
          (dr.label === null || typeof dr.label === "string") &&
          (dr.lastSeenAt === null || typeof dr.lastSeenAt === "number") &&
          typeof dr.revoked === "boolean"
        );
      })
    );
  });
}
