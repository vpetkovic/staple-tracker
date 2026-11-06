/**
 * How many join requests are waiting, as this page last heard.
 *
 * Written by whatever just asked the service (the toast's poll, Settings → Members) and read
 * by the Settings badge in the rail. A module-level value rather than context: the writer and
 * the reader sit in different trees, and nothing here is worth a provider.
 *
 * It is a count the page HEARD, never one it fetched to show. Reading it makes no request.
 */
import { useSyncExternalStore } from "react";

let pending = 0;
const listeners = new Set<() => void>();

export function setPendingJoinRequests(count: number): void {
  const next = Math.max(0, Math.floor(count));
  if (next === pending) return;
  pending = next;
  for (const listener of listeners) listener();
}

export function pendingJoinRequests(): number {
  return pending;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The count, re-rendering when it changes. Server render reads 0. */
export function usePendingJoinRequests(): number {
  return useSyncExternalStore(subscribe, pendingJoinRequests, () => 0);
}
