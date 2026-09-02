/**
 * G2 — the arrangement that survives a reload, and the ways it must fail quietly.
 *
 * Persistence here is a nicety wrapped around a feature, and the tests are shaped by
 * that: the interesting cases are not "it round-trips" but the four ways storage can
 * betray you — disabled, full, empty, or containing something a previous version (or a
 * curious human in devtools) left behind. Every one of them must cost the user their
 * saved layout and NOTHING ELSE. A graph view that throws because localStorage is off in
 * a private window would be a spectacular way to lose the whole page.
 *
 * The scope key gets its own block because it is the part that is silently wrong rather
 * than loudly broken: one key for everything would have hub mode and single-workspace
 * mode fighting over the same coordinates, and the symptom is "my layout randomly
 * changes" reported weeks later.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root. The module
 * under test imports `UiMode` type-only, and a type-only import is erased before it can
 * be resolved.
 */
import { describe, expect, it } from "vitest";
import { clearPositions, loadPositions, positionsKey, savePositions } from "./graph-positions";

/** A Storage good enough for these tests; `throws` turns it into a hostile one. */
class FakeStorage implements Storage {
  private map = new Map<string, string>();
  constructor(private throws = false) {}
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    if (this.throws) throw new Error("storage is disabled");
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    if (this.throws) throw new Error("storage is disabled");
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    if (this.throws) throw new Error("quota exceeded");
    this.map.set(key, value);
  }
  /** Peek without going through the guard, for asserting on what was written. */
  raw(key: string): string | null {
    return this.map.get(key) ?? null;
  }
}

describe("positionsKey", () => {
  it("separates hub mode from single-workspace mode", () => {
    // The two modes draw different node SETS under the same identifiers. Sharing a key
    // makes a layout tidied in one arrive as nonsense in the other.
    expect(positionsKey("hub", "")).not.toBe(positionsKey("workspace", ""));
  });

  it("separates one workspace filter from another", () => {
    expect(positionsKey("hub", "staple")).not.toBe(positionsKey("hub", "other"));
  });

  it("separates a single workspace from the all-workspaces view", () => {
    expect(positionsKey("hub", "staple")).not.toBe(positionsKey("hub", ""));
  });

  it("names the all-workspaces scope rather than leaving the segment empty", () => {
    expect(positionsKey("hub", "")).toBe("staple:graph-positions:v1:hub:*");
  });

  it("is versioned, so a future shape change can be ignored instead of migrated", () => {
    expect(positionsKey("hub", "staple")).toContain(":v1:");
  });
});

describe("round trip", () => {
  it("saves and loads an arrangement", () => {
    const storage = new FakeStorage();
    const key = positionsKey("workspace", "");
    savePositions(storage, key, { "STA-1": { x: 10, y: 20 }, "STA-2": { x: 30, y: 40 } });
    expect(loadPositions(storage, key)).toEqual({ "STA-1": { x: 10, y: 20 }, "STA-2": { x: 30, y: 40 } });
  });

  it("rounds to whole pixels", () => {
    // A drag produces sub-pixel floats. Thirteen decimals per coordinate is a lot of
    // quota for a difference no one can see.
    const storage = new FakeStorage();
    const key = positionsKey("workspace", "");
    savePositions(storage, key, { "STA-1": { x: 10.499_999_9, y: -3.7 } });
    expect(loadPositions(storage, key)).toEqual({ "STA-1": { x: 10, y: -4 } });
    expect(storage.raw(key)).not.toContain(".");
  });

  it("keeps scopes independent", () => {
    const storage = new FakeStorage();
    savePositions(storage, positionsKey("hub", ""), { "STA-1": { x: 1, y: 1 } });
    savePositions(storage, positionsKey("hub", "staple"), { "STA-1": { x: 900, y: 900 } });
    expect(loadPositions(storage, positionsKey("hub", ""))).toEqual({ "STA-1": { x: 1, y: 1 } });
  });
});

describe("clearPositions is auto-arrange's other half", () => {
  it("removes the saved arrangement so it cannot reappear on reload", () => {
    // Re-running dagre without clearing would look identical for one render and then
    // undo itself on the next load — the worst of both behaviours.
    const storage = new FakeStorage();
    const key = positionsKey("workspace", "");
    savePositions(storage, key, { "STA-1": { x: 10, y: 20 } });
    clearPositions(storage, key);
    expect(loadPositions(storage, key)).toBeNull();
  });

  it("leaves other scopes alone", () => {
    const storage = new FakeStorage();
    savePositions(storage, positionsKey("hub", "a"), { "STA-1": { x: 1, y: 1 } });
    savePositions(storage, positionsKey("hub", "b"), { "STA-1": { x: 2, y: 2 } });
    clearPositions(storage, positionsKey("hub", "a"));
    expect(loadPositions(storage, positionsKey("hub", "b"))).toEqual({ "STA-1": { x: 2, y: 2 } });
  });
});

describe("nothing here throws", () => {
  const key = positionsKey("workspace", "");

  it("treats a missing key as no saved arrangement", () => {
    expect(loadPositions(new FakeStorage(), key)).toBeNull();
  });

  it("survives storage being disabled outright", () => {
    // Private browsing. The graph must still render, canonically.
    const hostile = new FakeStorage(true);
    expect(loadPositions(hostile, key)).toBeNull();
    expect(() => savePositions(hostile, key, { A: { x: 1, y: 1 } })).not.toThrow();
    expect(() => clearPositions(hostile, key)).not.toThrow();
  });

  it("survives a full quota on write", () => {
    const hostile = new FakeStorage(true);
    expect(() => savePositions(hostile, key, { A: { x: 1, y: 1 } })).not.toThrow();
  });

  it("survives junk that is not JSON", () => {
    const storage = new FakeStorage();
    storage.setItem(key, "{not json");
    expect(loadPositions(storage, key)).toBeNull();
  });

  it("survives JSON of the wrong shape", () => {
    const storage = new FakeStorage();
    storage.setItem(key, JSON.stringify(["A", "B"]));
    expect(loadPositions(storage, key)).toBeNull();
  });

  it("drops only the corrupt entries, keeping the rest of the arrangement", () => {
    // One bad node should not cost you the other forty.
    const storage = new FakeStorage();
    storage.setItem(
      key,
      JSON.stringify({
        good: { x: 1, y: 2 },
        missingY: { x: 1 },
        stringly: { x: "1", y: "2" },
        nan: { x: Number.NaN, y: 0 },
        nully: null,
      }),
    );
    expect(loadPositions(storage, key)).toEqual({ good: { x: 1, y: 2 } });
  });

  it("rejects a non-finite coordinate rather than putting a node at NaN", () => {
    // JSON.stringify turns Infinity into null, so this is the hand-edited case — and a
    // NaN position in React Flow is an invisible node, not an error.
    const storage = new FakeStorage();
    storage.setItem(key, JSON.stringify({ A: { x: 1, y: 2 } }).replace("1", "1e999"));
    expect(loadPositions(storage, key)).toBeNull();
  });
});
