/**
 * WHO I AM: the name of the person using this browser, for attributing their writes.
 *
 * Kept apart from the working name (`staple:actor`, the last Start work name, which may be an
 * agent's). The detail keeps its own `staple:me` and NEVER writes the My tasks filter's
 * `staple:me:v1`: that one is chosen from the assignees the filter offers, and a free-text
 * name written there would skip the filter's "Which of these is you?" and filter to nobody.
 *
 * WHICH NAME TO USE WHEN BOTH ARE SET: the one set most recently. The detail cannot see when
 * the filter wrote its name, but it can see that it CHANGED: every time the detail remembers a
 * name it also notes the filter's value at that moment (`staple:me:seen`). Later, if the
 * filter's value differs from what was noted, the filter was set after the detail and wins;
 * if it is the same, the detail's own name is the newer one. No clocks involved.
 *
 * The rule every detail write follows: send `personActor()` as the actor. It is the person's
 * name when set, and undefined otherwise, so the server's default ("ui") applies.
 */
import { loadMe } from "@/components/filters/presets";

export const PERSON_KEY = "staple:me";
/** The filter's value as the detail last saw it, when it remembered its own name. */
export const SEEN_FILTER_KEY = "staple:me:seen";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function get(store: Store | undefined, key: string): string | null {
  try {
    return store?.getItem(key) || null;
  } catch {
    return null;
  }
}

/** The person's name, or null when they have not given one: the more recently set of the two. */
export function readPersonName(store: Store | undefined = storage()): string | null {
  const own = get(store, PERSON_KEY);
  const filter = loadMe(store);
  if (!own) return filter;
  if (!filter) return own;
  // The filter changed since the detail last remembered a name: it is the newer one.
  return filter !== get(store, SEEN_FILTER_KEY) ? filter : own;
}

/** Remember the person's name for the detail. The My tasks filter's own name is left alone. */
export function rememberPersonName(name: string, store: Store | undefined = storage()): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    store?.setItem(PERSON_KEY, trimmed);
    const filter = loadMe(store);
    if (filter) store?.setItem(SEEN_FILTER_KEY, filter);
    else store?.removeItem(SEEN_FILTER_KEY);
  } catch {
    /* private mode: the name lasts for this page load */
  }
}

/** The actor to send with a write: the person's name when set, otherwise nothing (the server says "ui"). */
export function personActor(store: Store | undefined = storage()): string | undefined {
  return readPersonName(store) ?? undefined;
}
