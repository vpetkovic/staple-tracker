/**
 * The Estimates page's "Include older history" switch, remembered.
 *
 * It is a working preference, like the detail's drawer/page mode (detail/drawer.ts): someone
 * who reads the older history once wants it every time, so the page opens on what they chose
 * last, across navigation and reloads. With nothing stored it is ON: the older history is
 * drawn in its own section, never pooled with the measured one, so showing it costs nothing
 * in precision and hiding it hides most of the finished work on a young workspace.
 *
 * Both functions survive a storage that refuses (private mode, site data blocked), for the
 * reason drawer.ts gives: the exception comes from the access itself, and inline it would
 * land in a `useState` initialiser or a change handler and take the page down with it.
 */
import { useCallback, useState } from "react";

export const INCLUDE_OLDER_HISTORY_KEY = "staple:estimates-include-older-history";

/** The switch's state when nothing is stored, or the stored value is unreadable. */
export const INCLUDE_OLDER_HISTORY_BY_DEFAULT = true;

type Reader = Pick<Storage, "getItem">;
type Writer = Pick<Storage, "setItem">;

export function loadIncludeOlderHistory(storage: Reader | undefined): boolean {
  if (!storage) return INCLUDE_OLDER_HISTORY_BY_DEFAULT;
  try {
    const stored = storage.getItem(INCLUDE_OLDER_HISTORY_KEY);
    if (stored === "on") return true;
    if (stored === "off") return false;
    return INCLUDE_OLDER_HISTORY_BY_DEFAULT;
  } catch {
    return INCLUDE_OLDER_HISTORY_BY_DEFAULT;
  }
}

/** Best-effort: losing the preference is not worth an exception. */
export function saveIncludeOlderHistory(storage: Writer | undefined, include: boolean): void {
  if (!storage) return;
  try {
    storage.setItem(INCLUDE_OLDER_HISTORY_KEY, include ? "on" : "off");
  } catch {
    /* private mode: the choice lasts for this page load */
  }
}

/**
 * The reader flipping the switch: store the choice, then answer the state to show. The hook's
 * setter is this and nothing else, so what is shown and what is remembered cannot disagree.
 */
export function chooseIncludeOlderHistory(storage: Writer | undefined, next: boolean): boolean {
  saveIncludeOlderHistory(storage, next);
  return next;
}

const browserStorage = (): Storage | undefined => (typeof localStorage === "undefined" ? undefined : localStorage);

/**
 * The one setting every place showing the switch reads: the stored choice on mount, and a
 * setter that stores what it sets.
 */
export function useIncludeOlderHistory(): [boolean, (next: boolean) => void] {
  const [include, setInclude] = useState(() => loadIncludeOlderHistory(browserStorage()));
  const set = useCallback((next: boolean) => setInclude(chooseIncludeOlderHistory(browserStorage(), next)), []);
  return [include, set];
}
