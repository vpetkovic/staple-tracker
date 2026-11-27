/**
 * How wide the desk's rail is drawn: `full` (rows with their names and marks) or `narrow`
 * (icons only). `[` and cmd-\ / Ctrl-\ switch between them (`railKeyAction`), as does the
 * top bar's toggle, which stays mounted in both modes.
 *
 * Two size classes, each with its own remembered choice, because the content needs the
 * width on a small desk and does not on a large one:
 *
 *   compact  768 to 1023px, starts `narrow`
 *   wide     1024px and up, starts `full`
 *
 * Stored under `staple:rail:v2` as `{ "wide": RailMode, "compact": RailMode }`, a class
 * absent until someone chooses in it. With no v2 value, `wide` reads the old
 * `staple:rail:v1`, where `collapsed` (the rail hidden) becomes `narrow`; v1 is read, never
 * written. Every caller of `useRailMode` shares one state, so the top bar's toggle and the
 * rail it draws cannot disagree.
 */
import { useCallback, useSyncExternalStore } from "react";
import { useMediaQuery } from "@/lib/use-media";
import { RAIL_STORAGE_KEY, decodeRailCollapsed } from "./nav-model";

export type RailMode = "full" | "narrow";
export type RailSizeClass = "compact" | "wide";
export type RailModes = Partial<Record<RailSizeClass, RailMode>>;

export const RAIL_MODE_STORAGE_KEY = "staple:rail:v2";
/** From here the desk is `wide`; below it, down to the phone breakpoint, `compact`. */
export const RAIL_WIDE_MIN_WIDTH = 1024;
export const RAIL_WIDE_QUERY = `(min-width: ${RAIL_WIDE_MIN_WIDTH}px)`;
export const RAIL_MODE_DEFAULTS: Readonly<Record<RailSizeClass, RailMode>> = { compact: "narrow", wide: "full" };

const isMode = (value: unknown): value is RailMode => value === "full" || value === "narrow";

/**
 * The remembered choices from what storage holds. An unreadable v2 value is no choice at
 * all (the defaults), never a reason to fall back to v1: v1 is only the answer for a browser
 * that has never stored v2.
 */
export function decodeRailModes(v2: string | null, v1: string | null): RailModes {
  if (v2 === null) return v1 === null ? {} : { wide: decodeRailCollapsed(v1) ? "narrow" : "full" };
  try {
    const parsed: unknown = JSON.parse(v2);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const { wide, compact } = parsed as Record<string, unknown>;
    return { ...(isMode(wide) ? { wide } : {}), ...(isMode(compact) ? { compact } : {}) };
  } catch {
    return {};
  }
}

export function railModeFor(modes: RailModes, sizeClass: RailSizeClass): RailMode {
  return modes[sizeClass] ?? RAIL_MODE_DEFAULTS[sizeClass];
}

/** The choices after a toggle in one size class; the other class keeps its own. */
export function toggledRailModes(modes: RailModes, sizeClass: RailSizeClass): RailModes {
  return { ...modes, [sizeClass]: railModeFor(modes, sizeClass) === "full" ? "narrow" : "full" };
}

export interface RailModeStore {
  modes: () => RailModes;
  toggle: (sizeClass: RailSizeClass) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createRailModeStore(storage: Pick<Storage, "getItem" | "setItem"> | undefined): RailModeStore {
  const read = (fallback: RailModes): RailModes => {
    try {
      return decodeRailModes(storage?.getItem(RAIL_MODE_STORAGE_KEY) ?? null, storage?.getItem(RAIL_STORAGE_KEY) ?? null);
    } catch {
      return fallback;
    }
  };
  let modes: RailModes = read({});
  const listeners = new Set<() => void>();
  return {
    modes: () => modes,
    toggle: (sizeClass) => {
      // Another tab may have chosen in the other size class since this page read storage: start
      // from what storage holds now, with this class as this page shows it, and flip this class.
      modes = toggledRailModes({ ...read(modes), [sizeClass]: railModeFor(modes, sizeClass) }, sizeClass);
      try {
        storage?.setItem(RAIL_MODE_STORAGE_KEY, JSON.stringify(modes));
      } catch {
        /* private mode: the choice lasts for this page load */
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let pageStore: RailModeStore | null = null;

function railModeStore(): RailModeStore {
  pageStore ??= createRailModeStore(typeof localStorage === "undefined" ? undefined : localStorage);
  return pageStore;
}

/** The rail's mode in the current size class, and the way to switch it. */
export function useRailMode(): { mode: RailMode; toggle: () => void } {
  const sizeClass: RailSizeClass = useMediaQuery(RAIL_WIDE_QUERY, true) ? "wide" : "compact";
  const store = railModeStore();
  const mode = useSyncExternalStore(
    store.subscribe,
    () => railModeFor(store.modes(), sizeClass),
    () => RAIL_MODE_DEFAULTS[sizeClass],
  );
  const toggle = useCallback(() => store.toggle(sizeClass), [store, sizeClass]);
  return { mode, toggle };
}
