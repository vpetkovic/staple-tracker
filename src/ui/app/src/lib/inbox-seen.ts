/**
 * WHAT IS NEW IN THE INBOX, for this browser: a row whose key this browser has not seen on
 * the Inbox page. The rail marks the Inbox while there is one; the page marks those rows.
 *
 * "Seen" is the row keys themselves (`<workspace>/<kind>/<id>`, stable across reads), not a
 * time: a gate requested yesterday on another device that synced in today was never on this
 * page, and is news, though its `since` is older than the last look. The list a browser
 * first reads is the baseline, not news, so a first visit does not greet the reader with
 * everything that ever waited. Opening the Inbox sees every row on it.
 *
 * A key the list no longer holds is dropped (the row left: the gate was answered, the run
 * dismissed), so if the same row comes back it is news again. Only the workspaces the read
 * covered are judged: one that could not be read keeps its keys, or its rows would all read
 * new the moment it comes back.
 *
 * Kept in localStorage (`staple:inbox-seen:v1`) by lib/inbox-seen-store.ts. Pure and tested
 * (inbox-seen.test.ts). STA-380's notification keys on the same "unseen" set.
 */
import type { AttentionList } from "./types";

export const INBOX_SEEN_KEY = "staple:inbox-seen:v1";

export interface InboxSeen {
  /** False until this browser's first read set the baseline. */
  started: boolean;
  /** Row keys this browser has seen. */
  seen: string[];
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;

export function loadInboxSeen(storage: Storage | null): InboxSeen {
  try {
    const raw = storage?.getItem(INBOX_SEEN_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<InboxSeen>) : null;
    if (parsed && parsed.started === true && Array.isArray(parsed.seen)) {
      return { started: true, seen: parsed.seen.filter((key): key is string => typeof key === "string") };
    }
  } catch {
    // A corrupt value reads as a first visit and is replaced at the next save.
  }
  return { started: false, seen: [] };
}

export function saveInboxSeen(storage: Storage | null, state: InboxSeen): void {
  try {
    storage?.setItem(INBOX_SEEN_KEY, JSON.stringify(state));
  } catch {
    // Private mode or a full quota: the marks still work for this page's life.
  }
}

/** The keys in `list` this browser has not seen; none before the baseline. */
export function unseenKeys(list: Pick<AttentionList, "rows">, state: InboxSeen): string[] {
  if (!state.started) return [];
  const seen = new Set(state.seen);
  return list.rows.map((row) => row.key).filter((key) => !seen.has(key));
}

/** `state` with `keys` seen. The same object when nothing changes. */
export function withInboxSeen(state: InboxSeen, keys: readonly string[]): InboxSeen {
  const seen = new Set(state.seen);
  const added = keys.filter((key) => !seen.has(key));
  return added.length === 0 ? state : { started: state.started, seen: [...state.seen, ...added] };
}

/**
 * After a read: the first one sets the baseline (everything on it seen); every one drops the
 * keys of rows gone from the workspaces it read. The same object when nothing changes.
 */
export function reconciledInboxSeen(state: InboxSeen, list: AttentionList): InboxSeen {
  if (!state.started) return { started: true, seen: list.rows.map((row) => row.key) };
  const failed = new Set(list.failed.map((failure) => failure.workspace));
  const judged = new Set(list.workspaces.filter((workspace) => !failed.has(workspace)));
  const present = new Set(list.rows.map((row) => row.key));
  const seen = state.seen.filter((key) => present.has(key) || !judged.has(key.slice(0, key.indexOf("/"))));
  return seen.length === state.seen.length ? state : { started: true, seen };
}
