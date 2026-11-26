/**
 * ONE Inbox "seen" list per tab (lib/inbox-seen.ts), persisted in localStorage; another tab's
 * change arrives through the `storage` event. The root reconciles it after every read; the
 * Inbox page marks what it shows.
 */
import { useSyncExternalStore } from "react";
import { INBOX_SEEN_KEY, type InboxSeen, loadInboxSeen, reconciledInboxSeen, saveInboxSeen, withInboxSeen } from "./inbox-seen";
import type { AttentionList } from "./types";

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

let state: InboxSeen | null = null;
const listeners = new Set<() => void>();

function current(): InboxSeen {
  state ??= loadInboxSeen(storage());
  return state;
}

function set(next: InboxSeen): void {
  if (next === state) return;
  state = next;
  saveInboxSeen(storage(), next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== INBOX_SEEN_KEY) return;
    state = loadInboxSeen(storage());
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useInboxSeen(): InboxSeen {
  return useSyncExternalStore(subscribe, current, current);
}

export function markInboxSeen(keys: readonly string[]): void {
  set(withInboxSeen(current(), keys));
}

/** After a read of `/api/attention` (every workspace): set the baseline, drop rows gone. */
export function reconcileInboxSeen(list: AttentionList): void {
  set(reconciledInboxSeen(current(), list));
}
