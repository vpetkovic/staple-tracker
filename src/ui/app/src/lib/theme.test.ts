import { describe, expect, it } from "vitest";
import { THEME_KEY, createThemeStore, decodeThemeChoice, resolveDark } from "./theme";

function fakeEnv(stored: string | null, systemDark: boolean) {
  const values = new Map<string, string>(stored === null ? [] : [[THEME_KEY, stored]]);
  const writes: string[] = [];
  const handlers = new Set<() => void>();
  const media = {
    matches: systemDark,
    addEventListener: (_type: string, handler: () => void) => void handlers.add(handler),
    removeEventListener: (_type: string, handler: () => void) => void handlers.delete(handler),
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
      },
      media: media as unknown as MediaQueryList,
      root: { toggle: (name: string, on?: boolean) => (on ? classes.add(name) : classes.delete(name), Boolean(on)) },
    },
    writes,
    classes,
    systemChanges: (dark: boolean) => {
      media.matches = dark;
      for (const handler of handlers) handler();
    },
    listening: () => handlers.size,
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

  it("stores nothing until a person picks, and follows the system meanwhile", () => {
    const page = fakeEnv(null, true);
    const store = createThemeStore(page.env);
    const stop = store.subscribe(() => {});
    expect(store.isDark()).toBe(true);
    page.systemChanges(false);
    expect(store.isDark()).toBe(false);
    expect(page.classes.has("dark")).toBe(false);
    expect(page.writes).toEqual([]);
    stop();
    expect(page.listening()).toBe(0);
  });

  it("keeps a pick over later system changes and stores exactly that pick", () => {
    const page = fakeEnv(null, false);
    const store = createThemeStore(page.env);
    store.subscribe(() => {});
    store.choose(true);
    expect(page.writes).toEqual(["dark"]);
    expect(page.classes.has("dark")).toBe(true);
    page.systemChanges(true);
    page.systemChanges(false);
    expect(store.isDark()).toBe(true);
  });

  it("starts from a stored pick whatever the system says", () => {
    const store = createThemeStore(fakeEnv("light", true).env);
    expect(store.isDark()).toBe(false);
  });
});
