/**
 * The page's view of a shared workspace's members: who this machine is, whose ticket is
 * whose, and the colour a member's chip wears.
 *
 * Everything here reads this machine's copy of the member list (`GET /api/members-cache`),
 * which the CLI and Settings → Members refresh. Nothing here asks the sync service. With no
 * list the page is exactly the single-person page it always was: no toggle, no chips, and
 * the assignee is the read-only value it has always been.
 */
import { useCallback, useEffect, useState } from "react";
import { getMembersCache } from "./api";
import type { UiMembersCache } from "./types";
import { useResource } from "./useStaple";

export type CachedMember = UiMembersCache["members"][number];

/** The member this machine belongs to, or null. */
export function selfMember(cache: UiMembersCache): CachedMember | null {
  return cache.members.find((m) => m.memberId === cache.self.memberId) ?? null;
}

/** The member with this name, case-insensitively, as the CLI and the server match it. */
export function memberNamed(cache: UiMembersCache, name: string): CachedMember | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return null;
  return cache.members.find((m) => m.name.toLowerCase() === wanted) ?? null;
}

/**
 * The OTHER member an assignee names, or null: unassigned, this machine's member, and an
 * agent's free-text handle are all work this person may take. The same rule `ls --mine`
 * and `queue next` apply on this machine.
 */
export function otherMemberOf(cache: UiMembersCache, assignee: string | null): CachedMember | null {
  if (!assignee) return null;
  const member = memberNamed(cache, assignee);
  return member === null || member.memberId === cache.self.memberId ? null : member;
}

/** Split rows into "mine" and how many each other member's rows Mine hid. */
export function partitionMine<T extends { issue: { assignee: string | null } }>(
  cache: UiMembersCache,
  rows: readonly T[],
): { mine: T[]; hidden: Array<{ memberId: string; name: string; count: number }> } {
  const mine: T[] = [];
  const hidden = new Map<string, { memberId: string; name: string; count: number }>();
  for (const row of rows) {
    const other = otherMemberOf(cache, row.issue.assignee);
    if (other === null) {
      mine.push(row);
      continue;
    }
    const entry = hidden.get(other.memberId) ?? { memberId: other.memberId, name: other.name, count: 0 };
    entry.count += 1;
    hidden.set(other.memberId, entry);
  }
  return { mine, hidden: [...hidden.values()] };
}

/**
 * The picker's order: this machine's member first, then the other current members by
 * name. Removed members cannot be given new work, so they are not offered.
 */
export function assignableMembers(cache: UiMembersCache): Array<CachedMember & { self: boolean }> {
  const self = selfMember(cache);
  const others = cache.members
    .filter((m) => !m.removed && m.memberId !== cache.self.memberId)
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...(self && !self.removed ? [{ ...self, self: true }] : []), ...others.map((m) => ({ ...m, self: false }))];
}

/** How many chart tokens a chip may wear. `--chart-5` is too close to the page to carry text. */
export const MEMBER_HUES = 4;

/**
 * A stable chip colour per member: a hash of the member id into `--chart-1..4`. Stable
 * across machines and renames, because the id is the server's and never changes.
 */
export function memberHue(memberId: string): number {
  let hash = 0;
  for (let i = 0; i < memberId.length; i += 1) hash = (hash * 31 + memberId.charCodeAt(i)) | 0;
  return (Math.abs(hash) % MEMBER_HUES) + 1;
}

/** Two initials for a chip: the first letters of the first two words, or the first two letters. */
export function memberInitials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0]![0]! + words[1]![0]!).toUpperCase();
  return (words[0] ?? "?").slice(0, 2).toUpperCase();
}

/**
 * The member list for one workspace, refetched on the page's poll. Null while loading, in
 * All workspaces (each workspace has its own members), and when there is none.
 */
export function useMembersCache(ws: string | undefined, version: number, onAuthError: (error: Error) => void): UiMembersCache | null {
  const resource = useResource<UiMembersCache | null>(
    () => (ws === undefined ? Promise.resolve(null) : getMembersCache({ ws: ws || undefined })),
    [ws, version],
    onAuthError as never,
  );
  return resource.data ?? null;
}

const MINE_KEY = "staple:members:mine:v1";

function readMine(ws: string): boolean | null {
  try {
    const stored = JSON.parse(localStorage.getItem(MINE_KEY) ?? "{}") as Record<string, boolean>;
    return typeof stored[ws] === "boolean" ? stored[ws]! : null;
  } catch {
    return null;
  }
}

function writeMine(ws: string, mine: boolean): void {
  try {
    const stored = JSON.parse(localStorage.getItem(MINE_KEY) ?? "{}") as Record<string, boolean>;
    stored[ws] = mine;
    localStorage.setItem(MINE_KEY, JSON.stringify(stored));
  } catch {
    // A page without storage still works; the choice just does not survive a reload.
  }
}

/**
 * The Mine/All choice, per workspace and remembered on this browser. Mine by default:
 * in a shared workspace the reader's own and unclaimed work is what they came for.
 */
export function useMineToggle(ws: string): [boolean, (mine: boolean) => void] {
  const [mine, setMineState] = useState<boolean>(() => readMine(ws) ?? true);
  useEffect(() => {
    setMineState(readMine(ws) ?? true);
  }, [ws]);
  const setMine = useCallback(
    (next: boolean) => {
      setMineState(next);
      writeMine(ws, next);
    },
    [ws],
  );
  return [mine, setMine];
}
