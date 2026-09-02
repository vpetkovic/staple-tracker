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
import {
  POSITIONS_VERSION,
  clearPositions,
  loadPositions,
  positionsKey,
  savePositions,
} from "./graph-positions";
// O4d: the fold block at the foot of this file runs the layout and the storage together,
// because the bug it guards against lives in the join between them and in neither half.
import { compoundLayout, mergePositions, relayout } from "./graph-layout";

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
    expect(positionsKey("hub", "")).toBe("staple:graph-positions:v2:hub:*");
  });

  it("is versioned, so a shape change can be ignored instead of migrated", () => {
    expect(positionsKey("hub", "staple")).toContain(`:${POSITIONS_VERSION}:`);
  });
});

/**
 * The version bump — O4c (STA-135).
 *
 * This block exists because the failure it prevents is INVISIBLE. v1 stored one absolute
 * coordinate per node; v2 stores a coordinate that is relative to the epic container a
 * node is drawn inside. Same keys, same `{x, y}`, both perfectly valid — so a v1 record
 * read under v2 would not throw, would not be filtered out by `isXY`, and would simply
 * place every member of every box hundreds of pixels outside the box it belongs to. The
 * key is the only thing standing between a stored arrangement and that reading.
 */
describe("schema version", () => {
  it("is v2, and saying so out loud is the point", () => {
    // A bump is a decision. Making it silently — because the shape changed and nobody
    // remembered the key — is precisely what this pins.
    expect(POSITIONS_VERSION).toBe("v2");
  });

  it("does not read a v1 arrangement", () => {
    const storage = new FakeStorage();
    // Exactly what the previous version wrote: absolute canvas coordinates.
    storage.setItem("staple:graph-positions:v1:workspace:staple", JSON.stringify({ A: { x: 900, y: 40 } }));

    // Discarded rather than misread. The user re-drags a few nodes; nothing lands outside
    // its container.
    expect(loadPositions(storage, positionsKey("workspace", "staple"))).toBeNull();
  });

  it("writes under the new key, leaving the old one untouched", () => {
    const storage = new FakeStorage();
    const old = "staple:graph-positions:v1:workspace:staple";
    storage.setItem(old, JSON.stringify({ A: { x: 900, y: 40 } }));

    savePositions(storage, positionsKey("workspace", "staple"), { A: { x: 12, y: 34 } });

    // Abandoned, not swept: a sweep means enumerating storage inside a module whose whole
    // contract is that nothing here throws, and the reward is a few hundred stale bytes.
    expect(storage.raw(old)).toBe(JSON.stringify({ A: { x: 900, y: 40 } }));
    expect(loadPositions(storage, positionsKey("workspace", "staple"))).toEqual({
      A: { x: 12, y: 34 },
    });
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

/**
 * ── Folding, end to end through storage — O4d (STA-136) ──────────────────────────────
 *
 * `relayout` is tested in isolation next door, and `savePositions` is tested in isolation
 * above. What is NOT covered by either is the seam GraphView actually runs on every fold:
 *
 *     relayout(new shape, edges, {old shape, live positions}) -> mergePositions(_, stored)
 *
 * That `mergePositions` at the end is the step that could quietly undo the whole ticket.
 * It layers the STORED arrangement over whatever `relayout` produced, so if the two ever
 * disagreed about a node nobody touched, the fold would move it — and it would move it
 * only for users who had dragged something at some point, which is the population least
 * likely to file a clear bug report and most likely to be annoyed by it.
 *
 * These run against a real (fake) Storage rather than a stubbed record, because "what was
 * written" and "what comes back" are the two halves that have to agree, and `savePositions`
 * rounds on the way out.
 */
describe("an arrangement survives a fold", () => {
  const key = positionsKey("hub", "");
  const leaf = (id: string, parent: string | null = null) => ({ id, parent, container: false });
  const boxed = (id: string, parent: string | null = null) => ({ id, parent, container: true });

  /** The canvas either side of one epic opening — the same shape GraphView derives. */
  const CLOSED = [leaf("W"), leaf("epic:E"), leaf("Z")];
  const OPEN = [leaf("W"), boxed("epic:E"), leaf("A", "epic:E"), leaf("Z")];
  const edges = [
    { from: "W", to: "epic:E" },
    { from: "epic:E", to: "Z" },
  ];

  it("keeps a DRAGGED node exactly where it was dropped when an epic opens", () => {
    // The whole chain: arrange, drag, persist, fold, re-arrange, merge. `W` must come
    // back at (410, 90) and not at wherever dagre would like it.
    const storage = new FakeStorage();
    const before = compoundLayout(CLOSED, edges);
    const dragged = { ...before.positions, W: { x: 410, y: 90 } };
    savePositions(storage, key, dragged);

    const after = relayout(OPEN, edges, {
      nodes: CLOSED,
      positions: dragged,
      sizes: before.sizes,
    });
    const merged = mergePositions(after.positions, loadPositions(storage, key));

    expect(merged["W"]).toEqual({ x: 410, y: 90 });
  });

  it("keeps an UNDRAGGED node too, which storage cannot do on its own", () => {
    // The case storage has no opinion about: `Z` was never dragged, so there is nothing in
    // localStorage for `mergePositions` to restore. Everything holding it still is
    // `relayout` declining to re-run the level — which is exactly the property that would
    // silently regress if somebody swapped `relayout` back for `compoundLayout`.
    const storage = new FakeStorage();
    const before = compoundLayout(CLOSED, edges);
    savePositions(storage, key, { W: { x: 410, y: 90 } });

    const after = relayout(OPEN, edges, {
      nodes: CLOSED,
      positions: { ...before.positions, W: { x: 410, y: 90 } },
      sizes: before.sizes,
    });
    const merged = mergePositions(after.positions, loadPositions(storage, key));

    expect(merged["Z"]).toEqual(before.positions["Z"]);
    expect(merged["epic:E"]).toEqual(before.positions["epic:E"]);
  });

  it("brings a member's own arrangement back when its epic is opened again", () => {
    // A member's coordinate is dropped from `positions` while its epic is collapsed —
    // it is not on the canvas to have one. Storage is what remembers it, and because the
    // key is versioned to v2 the value it remembers is already container-RELATIVE, so it
    // can be handed straight back without a translation nobody would maintain.
    const storage = new FakeStorage();
    const open = compoundLayout(OPEN, edges);
    savePositions(storage, key, { ...open.positions, A: { x: 30, y: 70 } });

    const collapsed = relayout(CLOSED, edges, {
      nodes: OPEN,
      positions: open.positions,
      sizes: open.sizes,
    });
    expect(collapsed.positions["A"]).toBeUndefined();

    const reopened = relayout(OPEN, edges, {
      nodes: CLOSED,
      positions: collapsed.positions,
      sizes: collapsed.sizes,
    });
    const merged = mergePositions(reopened.positions, loadPositions(storage, key));
    expect(merged["A"]).toEqual({ x: 30, y: 70 });
  });

  it("does not resurrect a node that is no longer drawn", () => {
    // `mergePositions` only honours ids that still exist, and a collapsed epic's members
    // do not. Without that, folding would leave `A` in the record as a node React Flow
    // knows nothing about — harmless until something joins against `positions` by key,
    // which the export does.
    const storage = new FakeStorage();
    const open = compoundLayout(OPEN, edges);
    savePositions(storage, key, open.positions);

    const collapsed = relayout(CLOSED, edges, {
      nodes: OPEN,
      positions: open.positions,
      sizes: open.sizes,
    });
    const merged = mergePositions(collapsed.positions, loadPositions(storage, key));
    expect(Object.keys(merged).sort()).toEqual(["W", "Z", "epic:E"]);
  });

  it("stores the SAME key across the fold — folding is not a schema change", () => {
    // O4c bumped v1 -> v2 because member coordinates became relative. O4d changes when the
    // layout runs, not what is written, so a fold must not cost anybody their arrangement.
    expect(POSITIONS_VERSION).toBe("v2");
    expect(positionsKey("hub", "")).toBe(key);
  });
});
