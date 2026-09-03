/**
 * R1 (STA-100) — the grouping preference, and the two things about it that are easy to get
 * wrong in a way nobody notices until a user loses their layout.
 */
import { describe, expect, it } from "vitest";
import {
  decodeViewPrefs,
  DEFAULT_GROUP_BY,
  encodeViewPrefs,
  GROUP_BY_OPTIONS,
  groupByLabel,
  loadViewPrefs,
  saveViewPrefs,
  VIEW_PREFS_STORAGE_KEY,
} from "./view-prefs";

/** The smallest thing that behaves like `localStorage`, including the ways it fails. */
function memoryStorage(over: Partial<Storage> = {}): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    ...over,
  } as Storage;
}

describe("the default", () => {
  it("is FLAT — this is the whole ticket", () => {
    expect(DEFAULT_GROUP_BY).toBe("none");
    expect(decodeViewPrefs(null).groupBy).toBe("none");
    expect(loadViewPrefs(memoryStorage()).groupBy).toBe("none");
  });

  it("offers every dimension in the registry, flat first", () => {
    // O3d (STA-129) APPENDED `parent`; O1c (STA-130) appended `kind` after it. The order is
    // asserted rather than the membership because registry order IS menu order, and an
    // entry inserted rather than appended moves every entry below it under the pointer of
    // somebody who has used this control for a year.
    expect(GROUP_BY_OPTIONS.map((o) => o.id)).toEqual([
      "none",
      "status",
      "pickup",
      "parent",
      "kind",
    ]);
    // Each one explains itself. A menu of bare nouns makes the user click to find out.
    expect(GROUP_BY_OPTIONS.every((o) => o.label.length > 0 && o.hint.length > 0)).toBe(true);
  });

  it("offers Epic beside Status and Pickup order, with no duplicate ids", () => {
    const ids = GROUP_BY_OPTIONS.map((o) => o.id);
    expect(ids).toContain("parent");
    expect(new Set(ids).size).toBe(ids.length);
    // The label is the acceptance criterion's word, and the id is deliberately not it —
    // the id names the DATA (`parentId`), the label names the common case.
    expect(GROUP_BY_OPTIONS.find((o) => o.id === "parent")?.label).toBe("Epic");
  });

  it("offers Kind, where the id and the label agree", () => {
    // O1c (STA-130). The contrast with `parent` directly above is the point: that axis
    // reads `parentId` and had a common case to name itself after, so its id and label
    // differ on purpose. This one reads `issue.kind` and says "Kind" — there was no lie
    // available and none was invented.
    const ids = GROUP_BY_OPTIONS.map((o) => o.id);
    expect(ids).toContain("kind");
    expect(new Set(ids).size).toBe(ids.length);
    expect(GROUP_BY_OPTIONS.find((o) => o.id === "kind")?.label).toBe("Kind");
  });
});

describe("persistence", () => {
  it("round-trips through its OWN key, not the filter envelope", () => {
    const storage = memoryStorage();
    saveViewPrefs(storage, { groupBy: "status" });

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"status"');
    // The filter envelope must be untouched — the two are separate concerns and the day
    // saved filter sets ship, switching sets must not re-arrange the list.
    expect(storage.getItem("staple:filters:v1")).toBeNull();
    expect(loadViewPrefs(storage).groupBy).toBe("status");
  });

  it("stamps a version inside, so a small change can migrate in place", () => {
    expect(JSON.parse(encodeViewPrefs({ groupBy: "status" }))).toEqual({
      version: 1,
      groupBy: "status",
    });
  });

  it("round-trips the pickup dimension, so the selector survives a reload", () => {
    // V5 (STA-111). This passes because the REGISTRY grew — the validator derives from
    // `GROUP_BY_OPTIONS` — and not because a third string was added to a hand-written
    // whitelist somewhere. That is the property worth pinning down.
    const storage = memoryStorage();
    saveViewPrefs(storage, { groupBy: "pickup" });

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"pickup"');
    expect(loadViewPrefs(storage).groupBy).toBe("pickup");
    expect(decodeViewPrefs('{"groupBy":"pickup"}').groupBy).toBe("pickup");
  });

  it("round-trips the epic dimension, for the same reason pickup round-trips", () => {
    // O3d (STA-129). Nothing in the persistence path was edited for this — the validator
    // derives from `GROUP_BY_OPTIONS`, so a registry entry IS the feature. That is what
    // this asserts; the value of the assertion is that it would fail the day somebody
    // "simplifies" `isGroupBy` into a hand-written list.
    const storage = memoryStorage();
    saveViewPrefs(storage, { groupBy: "parent" });

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"parent"');
    expect(loadViewPrefs(storage).groupBy).toBe("parent");
    expect(decodeViewPrefs('{"groupBy":"parent"}').groupBy).toBe("parent");
  });

  it("round-trips the kind dimension, for the same reason the other two round-trip", () => {
    // O1c (STA-130). The THIRD axis to arrive with no edit to the persistence path, which
    // is what turns O3d's claim about the registry from an observation into a property.
    // `decodeViewPrefs` validates against `GROUP_BY_OPTIONS`; the entry IS the feature.
    const storage = memoryStorage();
    saveViewPrefs(storage, { groupBy: "kind" });

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"kind"');
    expect(loadViewPrefs(storage).groupBy).toBe("kind");
    expect(decodeViewPrefs('{"groupBy":"kind"}').groupBy).toBe("kind");
  });

  it("keeps each dimension's stored value distinct from the others", () => {
    // Four axes now share one key. A save of one must not read back as another — the sort
    // of thing that cannot happen today and would be silent if it ever did.
    const storage = memoryStorage();
    for (const groupBy of ["none", "status", "pickup", "parent", "kind"] as const) {
      saveViewPrefs(storage, { groupBy });
      expect(loadViewPrefs(storage).groupBy).toBe(groupBy);
    }
  });

  it("falls back to flat for corruption, junk and unknown dimensions", () => {
    expect(decodeViewPrefs("not json").groupBy).toBe("none");
    expect(decodeViewPrefs("[1,2,3]").groupBy).toBe("none");
    expect(decodeViewPrefs('{"groupBy":true}').groupBy).toBe("none");
    // An unknown grouping is NOT kept the way an unknown filter dimension is: a filter from
    // a newer build round-trips harmlessly, but a grouping this build cannot render would
    // have to be handed to a `buildGroups` that has never heard of it.
    expect(decodeViewPrefs('{"groupBy":"assignee"}').groupBy).toBe("none");
  });

  it("survives a storage that throws, because Safari private mode does", () => {
    const throwing = memoryStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    });

    expect(loadViewPrefs(throwing).groupBy).toBe("none");
    expect(() => saveViewPrefs(throwing, { groupBy: "status" })).not.toThrow();
  });
});

describe("the trigger label", () => {
  it("names the active dimension", () => {
    expect(groupByLabel("none")).toBe("No grouping");
    expect(groupByLabel("status")).toBe("Status");
    // The trigger renders "Group: " + this, so the exact string is an acceptance criterion.
    expect(groupByLabel("pickup")).toBe("Pickup order");
    // O3d (STA-129). "Group: Epic", not "Group: Parent".
    expect(groupByLabel("parent")).toBe("Epic");
    // O1c (STA-130).
    expect(groupByLabel("kind")).toBe("Kind");
  });
});
