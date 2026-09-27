/**
 * WHO I AM: the name of the person using this browser, for attributing their writes.
 *
 * Kept apart from the working name (`staple:actor`, the last Start work name, which may be an
 * agent's). Stored at `staple:me`, and read with the My tasks filter's `staple:me:v1` as a
 * fallback: the two hold the same thing (the person's own name, as a plain string), so a name
 * given in either place is used in both, and a name given here is written to both.
 *
 * The rule every detail write follows: send `personActor()` as the actor. It is the person's
 * name when set, and undefined otherwise, so the server's default ("ui") applies.
 */
import { loadMe, saveMe } from "@/components/filters/presets";

export const PERSON_KEY = "staple:me";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): Store | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The person's name, or null when they have not given one. */
export function readPersonName(store: Store | undefined = storage()): string | null {
  try {
    return store?.getItem(PERSON_KEY) || loadMe(store) || null;
  } catch {
    return loadMe(store);
  }
}

/** Remember the person's name, here and for the My tasks filter. */
export function rememberPersonName(name: string, store: Store | undefined = storage()): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    store?.setItem(PERSON_KEY, trimmed);
  } catch {
    /* private mode: the name lasts for this page load */
  }
  saveMe(trimmed, store);
}

/** The actor to send with a write: the person's name when set, otherwise nothing (the server says "ui"). */
export function personActor(store: Store | undefined = storage()): string | undefined {
  return readPersonName(store) ?? undefined;
}
