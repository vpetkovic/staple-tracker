/**
 * THE INBOX'S ROWS, read once for the whole page (`/api/attention`, every workspace on a hub)
 * and held at the root (App.tsx), like the runs in lib/runs.ts: the rail's count and the
 * Inbox page read the same answer, so they cannot disagree.
 *
 * The read is always every workspace, whichever one the page is on: the rail counts what
 * waits everywhere, and a page narrowed to one workspace still says how much waits elsewhere.
 * The page's own rows are that read narrowed (`scopeAttention`), never a second request. It
 * is cheap: 19ms over five workspaces against 73ms for the issue list on the same hub.
 *
 * Refetched on the fingerprint poll, as every read is.
 */
import { createContext, useContext, useMemo } from "react";
import { unseenKeys } from "./inbox-seen";
import { useInboxSeen } from "./inbox-seen-store";
import type { AttentionList } from "./types";
import type { Resource } from "./useStaple";

export interface ScopedAttention {
  /** The rows in the page's scope: every workspace's, or the one workspace's. */
  list: AttentionList;
  /** Rows waiting in workspaces the page is not showing; 0 on All workspaces. */
  elsewhere: number;
}

/** `list` narrowed to workspace `ws` ("" = every workspace), and what that leaves out. */
export function scopeAttention(list: AttentionList, ws: string): ScopedAttention {
  if (ws === "") return { list, elsewhere: 0 };
  const rows = list.rows.filter((row) => row.workspace === ws);
  return {
    list: {
      rows,
      workspaces: list.workspaces.filter((workspace) => workspace === ws),
      failed: list.failed.filter((failure) => failure.workspace === ws),
      now: list.now,
    },
    elsewhere: list.rows.length - rows.length,
  };
}

/** The root's one read: every workspace's rows. */
export const AttentionContext = createContext<Resource<AttentionList> | null>(null);

export function useAttentionRead(): Resource<AttentionList> {
  const read = useContext(AttentionContext);
  if (!read) throw new Error("useAttentionRead() outside <App/>");
  return read;
}

export interface InboxBadge {
  /** Rows waiting on a person, in every workspace. */
  waiting: number;
  /** Of those, the ones this browser has not seen on the Inbox (lib/inbox-seen.ts). */
  unseen: number;
}

/** The rail's and the tab bar's Inbox mark: what waits everywhere, and what is new. */
export function useInboxBadge(): InboxBadge {
  const { data } = useAttentionRead();
  const seen = useInboxSeen();
  return useMemo(() => ({ waiting: data?.rows.length ?? 0, unseen: data ? unseenKeys(data, seen).length : 0 }), [data, seen]);
}
