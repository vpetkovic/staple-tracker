/**
 * LIGHT OR DARK — one answer for the whole page.
 *
 * The page follows the system (`prefers-color-scheme`) until a person picks a theme, and
 * from then on keeps their pick. Only that pick is stored (`staple:theme:v2`); opening the
 * page stores nothing, or the system's answer on the first visit would be kept for good.
 *
 * The old key, `staple:theme`, cannot tell a pick from that first-visit answer (the switch
 * used to write it on every page load), so it is never read as a pick: the store removes it
 * when it starts, and such a browser follows the system until its person picks again.
 *
 * The boot script in index.html applies the same rule before the first paint. `startTheme`
 * (main.tsx, before the app renders) then owns the `dark` class for the page's life: it
 * corrects the boot script's guess and follows a system change while nothing is picked,
 * whether or not any theme control is on screen. Every control shares that state through
 * `useTheme`.
 */
import { useSyncExternalStore } from "react";

export const THEME_KEY = "staple:theme:v2";
/** Written on every page load by builds before v2: never a pick. */
export const LEGACY_THEME_KEY = "staple:theme";
export const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

export type ThemeChoice = "dark" | "light";

/** The stored pick, or null when the person has not picked one (or the value is unreadable). */
export function decodeThemeChoice(raw: string | null): ThemeChoice | null {
  return raw === "dark" || raw === "light" ? raw : null;
}

/** Is the page dark: the person's pick when there is one, the system's otherwise. */
export function resolveDark(choice: ThemeChoice | null, systemDark: boolean): boolean {
  return choice === null ? systemDark : choice === "dark";
}

interface ThemeEnvironment {
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | undefined;
  /** The system preference, or undefined where nothing can answer. */
  media: Pick<MediaQueryList, "matches" | "addEventListener"> | undefined;
  /** Where the `dark` class goes. */
  root: Pick<DOMTokenList, "toggle"> | undefined;
}

export interface ThemeStore {
  isDark: () => boolean;
  /** A person's pick: applied and stored. */
  choose: (dark: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * The page's theme from the moment it is made: it sets the `dark` class, removes the legacy
 * key, and follows the system for as long as the page lives, with or without subscribers.
 */
export function createThemeStore(env: ThemeEnvironment): ThemeStore {
  let choice: ThemeChoice | null = null;
  try {
    choice = decodeThemeChoice(env.storage?.getItem(THEME_KEY) ?? null);
    env.storage?.removeItem(LEGACY_THEME_KEY);
  } catch {
    /* storage refused: no pick */
  }
  const isDark = () => resolveDark(choice, env.media?.matches ?? false);
  const listeners = new Set<() => void>();
  const apply = () => {
    env.root?.toggle("dark", isDark());
    for (const listener of listeners) listener();
  };
  env.root?.toggle("dark", isDark());
  env.media?.addEventListener("change", () => {
    if (choice === null) apply();
  });
  return {
    isDark,
    choose: (next) => {
      choice = next ? "dark" : "light";
      try {
        env.storage?.setItem(THEME_KEY, choice);
      } catch {
        /* private mode: the pick lasts for this page load */
      }
      apply();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

let pageStore: ThemeStore | null = null;

/** The page's one theme store, made on first use. `main.tsx` makes it before the first render. */
export function startTheme(): ThemeStore {
  // Only a real page has a theme to keep: a string render (a test stubbing `window`) has no
  // document, and gets a store that reads nothing and listens to nothing.
  const page = typeof document !== "undefined" && typeof window.matchMedia === "function";
  pageStore ??= createThemeStore({
    storage: page ? localStorage : undefined,
    media: page ? window.matchMedia(SYSTEM_DARK_QUERY) : undefined,
    root: page ? document.documentElement.classList : undefined,
  });
  return pageStore;
}

/** The page's theme and the way to pick one. Every caller shares the same state. */
export function useTheme(): [dark: boolean, choose: (dark: boolean) => void] {
  const store = startTheme();
  const dark = useSyncExternalStore(store.subscribe, store.isDark, () => false);
  return [dark, store.choose];
}
