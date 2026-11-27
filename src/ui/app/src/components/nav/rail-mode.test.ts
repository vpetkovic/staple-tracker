import { describe, expect, it } from "vitest";
import { RAIL_STORAGE_KEY } from "./nav-model";
import {
  RAIL_MODE_STORAGE_KEY,
  createRailModeStore,
  decodeRailModes,
  railModeFor,
  toggledRailModes,
} from "./rail-mode";

function fakeStorage(values: Record<string, string>) {
  const map = new Map(Object.entries(values));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("the rail's mode", () => {
  it("starts narrow on a compact desk and full on a wide one", () => {
    expect(railModeFor({}, "compact")).toBe("narrow");
    expect(railModeFor({}, "wide")).toBe("full");
  });

  it("carries a rail hidden under v1 into the wide class as narrow", () => {
    expect(decodeRailModes(null, "collapsed")).toEqual({ wide: "narrow" });
    expect(decodeRailModes(null, "open")).toEqual({ wide: "full" });
    expect(decodeRailModes(null, null)).toEqual({});
  });

  it("reads v2 alone once it exists, and treats an unreadable v2 as no choice", () => {
    expect(decodeRailModes('{"compact":"full"}', "collapsed")).toEqual({ compact: "full" });
    expect(decodeRailModes('{"wide":"sideways","compact":"narrow"}', null)).toEqual({ compact: "narrow" });
    expect(decodeRailModes("not json", "collapsed")).toEqual({});
    expect(decodeRailModes("[1]", null)).toEqual({});
  });

  it("toggles one size class and leaves the other's choice alone", () => {
    expect(toggledRailModes({}, "compact")).toEqual({ compact: "full" });
    expect(toggledRailModes({ compact: "full" }, "wide")).toEqual({ compact: "full", wide: "narrow" });
    expect(toggledRailModes({ wide: "narrow" }, "wide")).toEqual({ wide: "full" });
  });

  it("is one state for every caller, stored under v2, with v1 left as it was", () => {
    const storage = fakeStorage({ [RAIL_STORAGE_KEY]: "collapsed" });
    const store = createRailModeStore(storage);
    let heard = 0;
    store.subscribe(() => (heard += 1));
    store.subscribe(() => (heard += 1));
    expect(railModeFor(store.modes(), "wide")).toBe("narrow");
    store.toggle("wide");
    expect(heard).toBe(2);
    expect(railModeFor(store.modes(), "wide")).toBe("full");
    expect(JSON.parse(storage.map.get(RAIL_MODE_STORAGE_KEY)!)).toEqual({ wide: "full" });
    expect(storage.map.get(RAIL_STORAGE_KEY)).toBe("collapsed");
    // A reload reads the choice back.
    expect(railModeFor(createRailModeStore(storage).modes(), "wide")).toBe("full");
  });

  it("keeps another tab's choice in the other size class when this one toggles", () => {
    const storage = fakeStorage({});
    const compactTab = createRailModeStore(storage);
    const wideTab = createRailModeStore(storage);
    compactTab.toggle("compact");
    wideTab.toggle("wide");
    expect(JSON.parse(storage.map.get(RAIL_MODE_STORAGE_KEY)!)).toEqual({ compact: "full", wide: "narrow" });
    // Each tab flips what it shows, not what the other tab last wrote for its own class.
    compactTab.toggle("compact");
    expect(JSON.parse(storage.map.get(RAIL_MODE_STORAGE_KEY)!)).toEqual({ compact: "narrow", wide: "narrow" });
    expect(railModeFor(createRailModeStore(storage).modes(), "wide")).toBe("narrow");
  });

  it("flips what this tab shows, even when another tab in the same size class chose since", () => {
    const storage = fakeStorage({});
    const first = createRailModeStore(storage);
    const second = createRailModeStore(storage);
    first.toggle("compact");
    // The second tab still shows narrow: its toggle widens it, whatever the first one wrote.
    expect(railModeFor(second.modes(), "compact")).toBe("narrow");
    second.toggle("compact");
    expect(railModeFor(second.modes(), "compact")).toBe("full");
    expect(JSON.parse(storage.map.get(RAIL_MODE_STORAGE_KEY)!)).toEqual({ compact: "full" });
  });

  it("works without storage, for the page's life", () => {
    const store = createRailModeStore(undefined);
    store.toggle("compact");
    expect(railModeFor(store.modes(), "compact")).toBe("full");
  });
});
