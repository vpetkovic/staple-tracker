import { describe, expect, it } from "vitest";
import { LEGACY_THEME_KEY, THEME_KEY, createThemeStore, decodeThemeChoice, resolveDark } from "./theme";

function fakeEnv(stored: Record<string, string>, systemDark: boolean) {
  const values = new Map<string, string>(Object.entries(stored));
  const writes: string[] = [];
  const handlers = new Set<() => void>();
  const media = {
    matches: systemDark,
    addEventListener: (_type: string, handler: () => void) => void handlers.add(handler),
  };
  const classes = new Set<string>();
  return {
    env: {
      storage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => {
          writes.push(value);
          values.set(key, value);
        },
        removeItem: (key: string) => void values.delete(key),
      },
      media: media as unknown as MediaQueryList,
      root: { toggle: (name: string, on?: boolean) => (on ? classes.add(name) : classes.delete(name), Boolean(on)) },
    },
    values,
    writes,
    classes,
    systemChanges: (dark: boolean) => {
      media.matches = dark;
      for (const handler of handlers) handler();
    },
  };
}

describe("the theme", () => {
  it("reads only a real pick from storage", () => {
    expect(decodeThemeChoice("dark")).toBe("dark");
    expect(decodeThemeChoice("light")).toBe("light");
    expect(decodeThemeChoice(null)).toBeNull();
    expect(decodeThemeChoice("blue")).toBeNull();
  });

  it("is the person's pick when there is one, the system's otherwise", () => {
    expect(resolveDark(null, true)).toBe(true);
    expect(resolveDark(null, false)).toBe(false);
    expect(resolveDark("light", true)).toBe(false);
    expect(resolveDark("dark", false)).toBe(true);
  });

  it("stores nothing until a person picks, and follows the system meanwhile with nobody subscribed", () => {
    // No theme control on screen (the rail hidden, a phone): the page still follows.
    const page = fakeEnv({}, true);
    const store = createThemeStore(page.env);
    expect(store.isDark()).toBe(true);
    page.systemChanges(false);
    expect(store.isDark()).toBe(false);
    expect(page.classes.has("dark")).toBe(false);
    expect(page.writes).toEqual([]);
  });

  it("tells a control that subscribes later what the page shows", () => {
    const page = fakeEnv({}, false);
    const store = createThemeStore(page.env);
    page.systemChanges(true);
    let heard = 0;
    store.subscribe(() => (heard += 1));
    expect(store.isDark()).toBe(true);
    page.systemChanges(false);
    expect(heard).toBe(1);
  });

  it("keeps a pick over later system changes and stores exactly that pick", () => {
    const page = fakeEnv({}, false);
    const store = createThemeStore(page.env);
    store.choose(true);
    expect(page.writes).toEqual(["dark"]);
    expect(page.values.get(THEME_KEY)).toBe("dark");
    expect(page.classes.has("dark")).toBe(true);
    page.systemChanges(true);
    page.systemChanges(false);
    expect(store.isDark()).toBe(true);
  });

  it("never reads the old key as a pick, and removes it", () => {
    // Builds before v2 wrote the first visit's system answer there on every page load.
    const page = fakeEnv({ [LEGACY_THEME_KEY]: "dark" }, false);
    const store = createThemeStore(page.env);
    expect(store.isDark()).toBe(false);
    expect(page.values.has(LEGACY_THEME_KEY)).toBe(false);
    page.systemChanges(true);
    expect(store.isDark()).toBe(true);
  });

  it("sets the page's class itself when it starts, whatever the boot script guessed", () => {
    const page = fakeEnv({ [THEME_KEY]: "blue" }, true);
    expect(createThemeStore(page.env).isDark()).toBe(true);
    expect(page.classes.has("dark")).toBe(true);
  });

  it("starts from a stored pick whatever the system says", () => {
    const store = createThemeStore(fakeEnv({ [THEME_KEY]: "light" }, true).env);
    expect(store.isDark()).toBe(false);
  });
});
