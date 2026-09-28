/**
 * The Estimates page's "Include older history" switch is a remembered preference, on by
 * default. The layout is not the point here; what a later edit can quietly break is the
 * default, the round trip through storage, a refusing storage, and the page going back to
 * component state that resets on every visit.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  chooseIncludeOlderHistory,
  INCLUDE_OLDER_HISTORY_BY_DEFAULT,
  INCLUDE_OLDER_HISTORY_KEY,
  loadIncludeOlderHistory,
  saveIncludeOlderHistory,
} from "./older-history";

function fakeStorage(seed: Record<string, string> = {}, fail = false): Storage {
  const data = new Map(Object.entries(seed));
  const guard = () => {
    if (fail) throw new DOMException("The operation is insecure.", "SecurityError");
  };
  return {
    get length() {
      guard();
      return data.size;
    },
    clear: () => (guard(), data.clear()),
    getItem: (key) => (guard(), data.get(key) ?? null),
    key: (index) => (guard(), [...data.keys()][index] ?? null),
    removeItem: (key) => (guard(), void data.delete(key)),
    setItem: (key, value) => (guard(), void data.set(key, String(value))),
  };
}

describe("the older-history preference", () => {
  it("is on when nothing is stored, with no storage, or when storage refuses", () => {
    expect(INCLUDE_OLDER_HISTORY_BY_DEFAULT).toBe(true);
    expect(loadIncludeOlderHistory(fakeStorage())).toBe(true);
    expect(loadIncludeOlderHistory(undefined)).toBe(true);
    expect(loadIncludeOlderHistory(fakeStorage({}, true))).toBe(true);
    expect(loadIncludeOlderHistory(fakeStorage({ [INCLUDE_OLDER_HISTORY_KEY]: "maybe" }))).toBe(true);
  });

  it("remembers the reader's choice both ways", () => {
    const storage = fakeStorage();
    saveIncludeOlderHistory(storage, false);
    expect(storage.getItem(INCLUDE_OLDER_HISTORY_KEY)).toBe("off");
    expect(loadIncludeOlderHistory(storage)).toBe(false);
    saveIncludeOlderHistory(storage, true);
    expect(loadIncludeOlderHistory(storage)).toBe(true);
  });

  it("never throws from a refusing or absent storage", () => {
    expect(() => saveIncludeOlderHistory(fakeStorage({}, true), false)).not.toThrow();
    expect(() => saveIncludeOlderHistory(undefined, false)).not.toThrow();
  });

  it("is stored when the reader flips the switch, and the flip shows what was stored", () => {
    const storage = fakeStorage();
    expect(chooseIncludeOlderHistory(storage, false)).toBe(false);
    expect(storage.getItem(INCLUDE_OLDER_HISTORY_KEY)).toBe("off");
    expect(loadIncludeOlderHistory(storage)).toBe(false);
    expect(chooseIncludeOlderHistory(storage, true)).toBe(true);
    expect(storage.getItem(INCLUDE_OLDER_HISTORY_KEY)).toBe("on");
    expect(chooseIncludeOlderHistory(fakeStorage({}, true), false)).toBe(false);
  });

  it("is saved by the page's switch: the hook's setter stores through the flip", () => {
    const hook = readFileSync(new URL("./older-history.ts", import.meta.url), "utf8");
    expect(hook).toMatch(/useState\(\(\) => loadIncludeOlderHistory\(browserStorage\(\)\)\)/);
    expect(hook).toMatch(/const set = useCallback\(\(next: boolean\) => setInclude\(chooseIncludeOlderHistory\(browserStorage\(\), next\)\), \[\]\);/);
  });

  it("is what the Estimates page reads, not state local to one visit", () => {
    const source = readFileSync(new URL("./CalibrationView.tsx", import.meta.url), "utf8");
    expect(source).toMatch(/\[includeReconstructed, setIncludeReconstructed\] = useIncludeOlderHistory\(\)/);
    expect(source).not.toMatch(/useState\([^)]*(?:RECONSTRUCTED|false)/);
    expect(source).toMatch(/onToggleReconstructed=\{setIncludeReconstructed\}/);
  });
});
