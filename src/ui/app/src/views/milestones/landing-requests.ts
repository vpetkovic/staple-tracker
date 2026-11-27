/**
 * Asking the Milestones outline to land again on the milestone the address names.
 *
 * The outline lands when its focus (`?focus=`) changes. Pressing "Show in Milestones" for the
 * milestone the address already names changes no focus, so it would do nothing. The press also
 * bumps this counter, and the outline's landing keys on the focus and the counter together, so
 * every press scrolls to the section, unfolds it for the visit and marks it.
 *
 * View state only, in the manner of `detail/tabs/registry.ts`'s arrival requests: nothing goes
 * into the address or the session.
 */
import { useSyncExternalStore } from "react";

let requests = 0;
const listeners = new Set<() => void>();

/** How many landings were asked for in this page's life. */
export function landingRequests(): number {
  return requests;
}

/** Ask for one more landing: call it after pointing the page at the milestone. */
export function requestLanding(): void {
  requests += 1;
  for (const listener of [...listeners]) listener();
}

/** Listen for requests. Returns the unsubscribe. */
export function subscribeLandingRequests(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The request count, re-rendering the caller on each request. */
export function useLandingRequests(): number {
  return useSyncExternalStore(subscribeLandingRequests, landingRequests, landingRequests);
}
