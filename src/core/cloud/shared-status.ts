/**
 * How a shared workspace is described on every surface: the `shared` field of status JSON
 * and the one line the CLI prints. Reads only a members cache it is given, so status code
 * can use it without reaching the workspace or hub modules.
 */
import { currentMembers, isSharedWorkspace, type MembersCache } from "./members-cache.js";

/** What `shared` says in status JSON: the current members, or null when the workspace is not shared here. */
export interface SharedStatus {
  members: Array<{ name: string; memberId: string; self: boolean }>;
  autoSync: "locked-on";
}

export function sharedStatus(cache: MembersCache | null): SharedStatus | null {
  if (!isSharedWorkspace(cache)) return null;
  return {
    members: currentMembers(cache!).map((member) => ({
      name: member.name,
      memberId: member.memberId,
      self: member.memberId === cache!.self.memberId,
    })),
    autoSync: "locked-on",
  };
}

/**
 * The line `cloud status`, `ls` and `inbox` print in a shared workspace:
 * `shared with marko · syncing automatically`. Null when not shared, so a solo workspace
 * prints exactly what it always did.
 */
export function sharedLine(shared: SharedStatus | null, autoOn: boolean): string | null {
  if (shared === null) return null;
  const others = shared.members.filter((member) => !member.self).map((member) => member.name);
  const who = others.length > 0 ? others.join(", ") : "other members";
  return `shared with ${who} · ${autoOn ? "syncing automatically" : "automatic sync turns on at the next sync"}`;
}
