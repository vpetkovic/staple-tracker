/**
 * LIGHT OR DARK — one answer for the whole page.
 *
 * The page follows the system (`prefers-color-scheme`) until a person picks a theme, and
 * from then on keeps their pick. Only that pick is stored (`staple:theme`); opening the page
 * stores nothing, or the system's answer on the first visit would be kept for good. The boot
 * script in index.html applies the same rule before the first paint; this module keeps the
 * `dark` class right afterwards, follows a system change while nothing is picked, and lets
 * every theme control share one state through `useTheme`.
 */
import { useSyncExternalStore } from "react";

export const THEME_KEY = "staple:theme";
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
  storage: Pick<Storage, "getItem" | "setItem"> | undefined;
  /** The system preference, or undefined where nothing can answer. */
  media: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener"> | undefined;
  /** Where the `dark` class goes. */
  root: Pick<DOMTokenList, "toggle"> | undefined;
}

export interface ThemeStore {
  isDark: () => boolean;
  /** A person's pick: applied and stored. */
  choose: (dark: boolean) => void;
  subscribe: (listener: () => void) => () => void;
}

export function createThemeStore(env: ThemeEnvironment): ThemeStore {
  const readChoice = (): ThemeChoice | null => {
    try {
      return decodeThemeChoice(env.storage?.getItem(THEME_KEY) ?? null);
    } catch {
      return null;
    }
  };
  let choice = readChoice();
  const isDark = () => resolveDark(choice, env.media?.matches ?? false);
  const listeners = new Set<() => void>();
  const apply = () => {
    env.root?.toggle("dark", isDark());
    for (const listener of listeners) listener();
  };
  // The boot script's first paint was a guess at the same rule; from here this store decides.
  env.root?.toggle("dark", isDark());
  const onSystemChange = () => {
    if (choice === null) apply();
  };
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
      if (listeners.size === 0) env.media?.addEventListener("change", onSystemChange);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) env.media?.removeEventListener("change", onSystemChange);
      };
    },
  };
}

let pageStore: ThemeStore | null = null;

function themeStore(): ThemeStore {
  pageStore ??= createThemeStore({
    storage: typeof localStorage === "undefined" ? undefined : localStorage,
    media: typeof window === "undefined" || typeof window.matchMedia !== "function" ? undefined : window.matchMedia(SYSTEM_DARK_QUERY),
    root: typeof document === "undefined" ? undefined : document.documentElement.classList,
  });
  return pageStore;
}

/** The page's theme and the way to pick one. Every caller shares the same state. */
export function useTheme(): [dark: boolean, choose: (dark: boolean) => void] {
  const store = themeStore();
  const dark = useSyncExternalStore(store.subscribe, store.isDark, () => false);
  return [dark, store.choose];
}
