/**
 * V3 — the two decisions the overlay makes that are not layout.
 *
 * Everything else about this drawer is CSS and Radix. What is genuinely this app's
 * to get wrong is (a) whether "expanded" survives, and survives the right things,
 * and (b) whether a browser that refuses localStorage takes the panel down with it.
 * Both are pinned here because both are invisible until they are catastrophic.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so
 * the app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import { DETAIL_MODE_KEY, loadMode, otherMode, saveMode, type DetailMode } from "./drawer";

/** A localStorage stand-in. `fail` makes every method throw, as private mode does. */
function fakeStorage(seed?: Record<string, string>, fail = false): Storage {
  const map = new Map(Object.entries(seed ?? {}));
  const boom = (): never => {
    throw new Error("SecurityError: storage is denied");
  };
  return {
    get length() {
      return map.size;
    },
    clear: () => (fail ? boom() : map.clear()),
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (fail ? boom() : (map.get(k) ?? null)),
    setItem: (k: string, v: string) => {
      if (fail) boom();
      map.set(k, v);
    },
    removeItem: (k: string) => {
      if (fail) boom();
      map.delete(k);
    },
  } as Storage;
}

describe("otherMode", () => {
  it("is its own inverse, so the one button can never desync from the state", () => {
    const modes: DetailMode[] = ["drawer", "full"];
    for (const mode of modes) expect(otherMode(otherMode(mode))).toBe(mode);
  });

  it("expands a drawer and collapses a full screen", () => {
    expect(otherMode("drawer")).toBe("full");
    expect(otherMode("full")).toBe("drawer");
  });
});

describe("loadMode", () => {
  it("defaults to the drawer, because the drawer is the ticket's premise", () => {
    expect(loadMode(fakeStorage())).toBe("drawer");
  });

  it("restores a stored preference", () => {
    expect(loadMode(fakeStorage({ [DETAIL_MODE_KEY]: "full" }))).toBe("full");
  });

  /**
   * A stored value this build does not recognise — an older or newer schema, or a
   * human editing devtools — must not put the panel into a mode with no CSS. The
   * drawer is the safe floor and every unknown lands on it.
   */
  it("falls back to the drawer on a value it does not recognise", () => {
    expect(loadMode(fakeStorage({ [DETAIL_MODE_KEY]: "fullscreen" }))).toBe("drawer");
    expect(loadMode(fakeStorage({ [DETAIL_MODE_KEY]: "" }))).toBe("drawer");
  });

  it("survives a storage that throws, rather than taking the panel down with it", () => {
    expect(() => loadMode(fakeStorage({}, true))).not.toThrow();
    expect(loadMode(fakeStorage({}, true))).toBe("drawer");
  });

  it("survives no storage at all", () => {
    expect(loadMode(undefined)).toBe("drawer");
  });
});

describe("saveMode", () => {
  it("round-trips through storage", () => {
    const storage = fakeStorage();
    saveMode(storage, "full");
    expect(loadMode(storage)).toBe("full");
    saveMode(storage, "drawer");
    expect(loadMode(storage)).toBe("drawer");
  });

  /**
   * The preference is a nicety. Losing it is not worth an exception escaping into
   * a click handler, where React would surface it as a crashed panel.
   */
  it("swallows a refusing storage", () => {
    expect(() => saveMode(fakeStorage({}, true), "full")).not.toThrow();
    expect(() => saveMode(undefined, "full")).not.toThrow();
  });
});
