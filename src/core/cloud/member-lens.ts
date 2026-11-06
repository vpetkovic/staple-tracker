/**
 * What the rest of the client asks of a shared workspace's member list.
 *
 * A read-only view over `members-cache.ts`, which stays the only place the member list
 * is read from. Nothing here makes a network call: the cache is refreshed by whatever
 * already talks to the service (`cloud sync`, `cloud members`, an approval), and read by
 * `ls --mine`, the pickup rule, the member chip and the assignee picker.
 *
 * No cache means "not a shared workspace on this machine", and every caller keeps its
 * single-person behaviour, byte for byte. The one exception is an explicit `--mine`,
 * which is refused rather than silently answered as if it meant everything.
 */
import { StapleError } from "../types.js";
import { type CachedMember, type MembersCache, memberByName, memberOfDevice, selfMember } from "./members-cache.js";

/** A member as an event or a queue row names one. */
export interface MemberRef {
  readonly memberId: string;
  readonly name: string;
  /** Removed members still name their history; a surface shows them muted. */
  readonly removed: boolean;
}

export function memberRef(member: CachedMember): MemberRef {
  return { memberId: member.memberId, name: member.name, removed: member.removed };
}

export class MemberLens {
  constructor(readonly cache: MembersCache) {}

  /** The member this machine belongs to, or null when it is not in the list. */
  get self(): CachedMember | null {
    return selfMember(this.cache);
  }

  /**
   * The member an assignee names when that member is somebody else, or null.
   *
   * Case-insensitive, like every member-name match. An assignee that is this machine's
   * member, no member at all (an agent's handle, free text), or empty is null: all of
   * those are work this person may take.
   */
  otherMember(assignee: string | null | undefined): CachedMember | null {
    if (assignee === null || assignee === undefined || assignee.trim() === "") return null;
    const member = memberByName(this.cache, assignee);
    if (member === null) return null;
    return member.memberId === this.cache.self.memberId ? null : member;
  }

  /**
   * The member who made a change, from the device the change came from. `null` origin is
   * a change made on this machine. Null when the device is in no member's list.
   */
  memberOf(originDevice: string | null): MemberRef | null {
    const member = memberOfDevice(this.cache, originDevice);
    return member === null ? null : memberRef(member);
  }
}

/**
 * The lens a `--mine` (or MCP `mine`) needs, or a refusal that says how to get one.
 *
 * Refused rather than answered: without a member list there is no "mine" to tell apart
 * from "everyone's", and silently returning everything would read as an answer.
 */
export function requireMineLens(lens: MemberLens | null, flag = "--mine"): MemberLens {
  if (lens === null) {
    throw new StapleError(
      "validation",
      `${flag} needs this workspace's member list, and there is none on this machine. ` +
        "It is a shared workspace's: run `staple cloud join` (or `staple cloud connect` for the " +
        "first device), then `staple cloud sync`.",
    );
  }
  if (lens.self === null) {
    throw new StapleError(
      "validation",
      `${flag}: this machine is not in the workspace's member list. Run \`staple cloud members\` ` +
        "to refresh it.",
    );
  }
  return lens;
}

/**
 * Split issues into the ones that are "mine" (not assigned to another member) and the
 * count hidden per other member, in first-seen order.
 */
export function splitMine<T extends { assignee: string | null }>(
  lens: MemberLens,
  issues: readonly T[],
): { mine: T[]; hidden: Array<{ name: string; count: number }> } {
  const mine: T[] = [];
  const hidden = new Map<string, { name: string; count: number }>();
  for (const issue of issues) {
    const other = lens.otherMember(issue.assignee);
    if (other === null) {
      mine.push(issue);
      continue;
    }
    const entry = hidden.get(other.memberId) ?? { name: other.name, count: 0 };
    entry.count += 1;
    hidden.set(other.memberId, entry);
  }
  return { mine, hidden: [...hidden.values()] };
}

/**
 * Add `member` to each event whose origin device belongs to a member. With no lens (no
 * cache), the events are returned untouched, so their JSON is exactly what it was.
 * `originDevices[i]` is the `events.origin_device` of `events[i]`.
 */
export function withEventMembers<T extends object>(
  lens: MemberLens | null,
  events: T[],
  originDevices: ReadonlyArray<string | null>,
): Array<T & { member?: MemberRef }> {
  if (lens === null) return events;
  return events.map((event, index) => {
    const member = lens.memberOf(originDevices[index] ?? null);
    return member === null ? event : { ...event, member };
  });
}
