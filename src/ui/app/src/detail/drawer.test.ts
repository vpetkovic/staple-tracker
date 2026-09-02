/**
 * V3 — the three decisions the overlay makes that a screenshot cannot pin.
 *
 * Everything else about this drawer is CSS and Radix. What is genuinely this app's
 * to get wrong is (a) whether "expanded" survives, and survives the right things,
 * (b) whether a browser that refuses localStorage takes the panel down with it, and
 * (c) — added by R3 (STA-104) — whether "expanded" still means EDGE TO EDGE.
 *
 * (c) is not a coverage exercise. The expanded geometry has now been chosen twice
 * and reverted once: V3 shipped an inset, capped, rounded card and defended it in a
 * comment, and VP rejected it as a 98% modal. A class string is exactly the kind of
 * thing a later refactor "tidies" back toward a max-width, and the only other thing
 * that would catch it is a human looking at a screenshot. So the decision is pinned
 * where it costs nothing to keep.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so
 * the app's `@` alias (src/ui/app/vite.config.ts) does not exist at test time.
 */
import { describe, expect, it } from "vitest";
import {
  DETAIL_MODE_KEY,
  loadMode,
  otherMode,
  panelClass,
  saveMode,
  type DetailMode,
} from "./drawer";

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

/**
 * R3 (STA-104). The panel's geometry, pinned as a decision rather than measured as
 * a value — the measurement lives in the evidence run, which puts a real panel in a
 * real viewport and compares rects. What a unit test can do that a screenshot cannot
 * is fail LOUDLY, in CI, the day somebody reintroduces an inset.
 */
describe("panelClass", () => {
  /**
   * The ticket in one assertion. `inset-0` and nothing that pulls the panel back off
   * an edge: no `max-w-*` (the 86rem cap VP rejected), no numbered `inset-*`, no
   * radius, no border. Each is listed separately so a failure names which one came
   * back rather than just "the string changed".
   */
  it("expands edge to edge — no inset, no cap, no radius, no border", () => {
    const full = panelClass("full");
    expect(full).toContain("inset-0");
    expect(full).not.toMatch(/\bmax-w-/);
    expect(full).not.toMatch(/\binset-[1-9]/);
    expect(full).not.toMatch(/\b(sm|md|lg|xl):inset-/);
    expect(full).not.toMatch(/\brounded/);
    expect(full).not.toMatch(/\bborder\b/);
  });

  /**
   * The other half of R3, and the half that is easy to lose while chasing the first:
   * the DRAWER was not the complaint and must come through untouched. 46rem, flush
   * right, full height, one hairline on the edge it meets the list at.
   */
  it("leaves the drawer exactly as V3 shipped it", () => {
    expect(panelClass("drawer")).toBe("inset-y-0 right-0 w-[min(46rem,94vw)] border-l");
  });

  /** Neither mode may inherit the other's geometry through a shared base string. */
  it("gives the two modes disjoint geometry", () => {
    expect(panelClass("drawer")).not.toBe(panelClass("full"));
    expect(panelClass("drawer")).not.toContain("inset-0");
  });
});
