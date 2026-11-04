/**
 * ONE "seen" list per tab, shared by every place a run-stopped notice shows (the shell's and
 * the detail drawer's) and by Stop, which marks the run it stopped as seen: a person does
 * not need to be told about their own press. Persisted in localStorage (lib/run-stops.ts);
 * another tab's change arrives through the `storage` event.
 */
import { useSyncExternalStore } from "react";
import { loadStopSeen, prunedSeen, saveStopSeen, STOP_SEEN_KEY, type StopSeen, withBaseline, withSeen } from "./run-stops";
import type { RunEntry } from "./types";

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);

let state: StopSeen | null = null;
const listeners = new Set<() => void>();

function current(): StopSeen {
  state ??= loadStopSeen(storage());
  return state;
}

function set(next: StopSeen): void {
  if (next === state) return;
  state = next;
  saveStopSeen(storage(), next);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== STOP_SEEN_KEY) return;
    state = loadStopSeen(storage());
    listener();
  };
  if (typeof window !== "undefined") window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    if (typeof window !== "undefined") window.removeEventListener("storage", onStorage);
  };
}

export function useStopSeen(): StopSeen {
  return useSyncExternalStore(subscribe, current, current);
}

export function markStopsSeen(keys: readonly string[]): void {
  if (keys.length > 0) set(withSeen(current(), keys));
}

/** After a read of `/api/runs`: start the count on the server's clock, and drop dead keys. */
export function reconcileStopSeen(entries: readonly Pick<RunEntry, "workspace" | "run">[], serverNow: string | null): void {
  set(prunedSeen(withBaseline(current(), serverNow), entries));
}

/** Tests only: forget the tab's copy so the next read comes from storage again. */
export function resetStopSeenForTests(): void {
  state = null;
}
