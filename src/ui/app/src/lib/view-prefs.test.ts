/**
 * R1 (STA-100) — the grouping preference, and the two things about it that are easy to get
 * wrong in a way nobody notices until a user loses their layout.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_SORT, type SortPref } from "./sort-modes";
import {
  decodeViewPrefs,
  defaultViewPrefs,
  DEFAULT_GROUP_BY,
  encodeViewPrefs,
  GROUP_BY_OPTIONS,
  groupByLabel,
  loadViewPrefs,
  saveViewPrefs,
  sortForScope,
  sortScopeKey,
  VIEW_PREFS_STORAGE_KEY,
  withSortForScope,
  type GroupBy,
  type ViewPrefs,
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

/** The envelope with only a grouping set — what every pre-R4a test in this file meant. */
const grouped = (groupBy: GroupBy): ViewPrefs => ({ groupBy, sort: {} });

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
    // R4a (STA-186) grew the envelope by one field; `grouped()` says the rest of it.
    saveViewPrefs(storage, grouped("status"));

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"status"');
    // The filter envelope must be untouched — the two are separate concerns and the day
    // saved filter sets ship, switching sets must not re-arrange the list.
    expect(storage.getItem("staple:filters:v1")).toBeNull();
    expect(loadViewPrefs(storage).groupBy).toBe("status");
  });

  it("stamps a version inside, so a small change can migrate in place", () => {
    // R4a (STA-186) is exactly such a change: `sort` arrived beside `groupBy` under the SAME
    // key and the number inside went to 2. See the migration test at the end of this file.
    expect(JSON.parse(encodeViewPrefs(grouped("status")))).toEqual({
      version: 2,
      groupBy: "status",
      sort: {},
    });
  });

  it("round-trips the pickup dimension, so the selector survives a reload", () => {
    // V5 (STA-111). This passes because the REGISTRY grew — the validator derives from
    // `GROUP_BY_OPTIONS` — and not because a third string was added to a hand-written
    // whitelist somewhere. That is the property worth pinning down.
    const storage = memoryStorage();
    saveViewPrefs(storage, grouped("pickup"));

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
    saveViewPrefs(storage, grouped("parent"));

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"parent"');
    expect(loadViewPrefs(storage).groupBy).toBe("parent");
    expect(decodeViewPrefs('{"groupBy":"parent"}').groupBy).toBe("parent");
  });

  it("round-trips the kind dimension, for the same reason the other two round-trip", () => {
    // O1c (STA-130). The THIRD axis to arrive with no edit to the persistence path, which
    // is what turns O3d's claim about the registry from an observation into a property.
    // `decodeViewPrefs` validates against `GROUP_BY_OPTIONS`; the entry IS the feature.
    const storage = memoryStorage();
    saveViewPrefs(storage, grouped("kind"));

    expect(storage.getItem(VIEW_PREFS_STORAGE_KEY)).toContain('"groupBy":"kind"');
    expect(loadViewPrefs(storage).groupBy).toBe("kind");
    expect(decodeViewPrefs('{"groupBy":"kind"}').groupBy).toBe("kind");
  });

  it("keeps each dimension's stored value distinct from the others", () => {
    // Four axes now share one key. A save of one must not read back as another — the sort
    // of thing that cannot happen today and would be silent if it ever did.
    const storage = memoryStorage();
    for (const groupBy of ["none", "status", "pickup", "parent", "kind"] as const) {
      saveViewPrefs(storage, grouped(groupBy));
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
    expect(() => saveViewPrefs(throwing, grouped("status"))).not.toThrow();
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

/**
 * R4a (STA-186) — the sort preference, which is stored per WORKSPACE and per VIEW while
 * `groupBy` stays one value for the app. Three things could go wrong quietly:
 *
 *   1. THE MIGRATION. A v1 payload has no `sort`. If that decoded to anything but "every
 *      scope is the default", every existing user would open the tracker to a list in an
 *      order they never chose — and the key would look fine in devtools.
 *   2. SCOPE BLEED. Choosing "Queue position" in one workspace must not re-order the archive
 *      next door, and a milestones view must not inherit the tree's answer.
 *   3. A STORED DEFAULT. Writing the default down makes it indistinguishable from a choice,
 *      so the day the default changes, every scope anybody ever visited is pinned to the old
 *      one by a preference the user never made.
 */
describe("the sort preference", () => {
  const tree = sortScopeKey("staple", "tree");
  const graph = sortScopeKey("staple", "graph");
  const other = sortScopeKey("other", "tree");

  it("MIGRATES a v1 payload: no `sort` means every scope is the default", () => {
    const prefs = decodeViewPrefs('{"version":1,"groupBy":"status"}');
    expect(prefs.groupBy).toBe("status");
    expect(prefs.sort).toEqual({});
    expect(sortForScope(prefs.sort, tree)).toEqual(DEFAULT_SORT);
    expect(defaultViewPrefs().sort).toEqual({});
  });

  it("round-trips one scope through the same key, beside the grouping", () => {
    const storage = memoryStorage();
    const chosen: SortPref = { mode: "queue", direction: "asc" };
    saveViewPrefs(storage, { groupBy: "parent", sort: { [tree]: chosen } });

    const back = loadViewPrefs(storage);
    expect(back.groupBy).toBe("parent");
    expect(sortForScope(back.sort, tree)).toEqual(chosen);
    // ONE key. A second one would be a second thing to migrate and a second thing to clear.
    expect(storage.length).toBe(1);
  });

  it("keeps workspaces and views apart — an unset scope is the DEFAULT, not a neighbour's", () => {
    const sort = withSortForScope({}, tree, { mode: "title", direction: "asc" });
    expect(sortForScope(sort, tree)).toEqual({ mode: "title", direction: "asc" });
    expect(sortForScope(sort, graph)).toEqual(DEFAULT_SORT);
    expect(sortForScope(sort, other)).toEqual(DEFAULT_SORT);
  });

  it("gives hub mode its own scope rather than folding it into a workspace", () => {
    expect(sortScopeKey("", "tree")).not.toBe(sortScopeKey("staple", "tree"));
    expect(sortScopeKey("", "tree")).toBe("*::tree");
  });

  it("REMOVES a scope set back to the default instead of writing it down", () => {
    const chosen = withSortForScope({}, tree, { mode: "created", direction: "asc" });
    expect(Object.keys(chosen)).toEqual([tree]);
    const cleared = withSortForScope(chosen, tree, DEFAULT_SORT);
    expect(cleared).toEqual({});
    expect(sortForScope(cleared, tree)).toEqual(DEFAULT_SORT);
  });

  it("leaves every other scope untouched when one changes", () => {
    const a = withSortForScope({}, tree, { mode: "title", direction: "desc" });
    const b = withSortForScope(a, graph, { mode: "priority", direction: "asc" });
    expect(sortForScope(b, tree)).toEqual({ mode: "title", direction: "desc" });
    // The input map is not mutated — App holds it in state and React compares by identity.
    expect(a[graph]).toBeUndefined();
  });

  it("repairs a corrupt entry per SCOPE, so one bad value does not cost the map", () => {
    const raw = JSON.stringify({
      version: 2,
      groupBy: "none",
      sort: {
        [tree]: { mode: "title", direction: "asc" },
        [graph]: { mode: "nonsense", direction: "asc" },
        [other]: { mode: "title", direction: "sideways" },
        broken: "not an object",
      },
    });
    const prefs = decodeViewPrefs(raw);
    expect(prefs.sort).toEqual({ [tree]: { mode: "title", direction: "asc" } });
    expect(sortForScope(prefs.sort, graph)).toEqual(DEFAULT_SORT);
  });

  it("ignores a `sort` that is not a map at all, rather than throwing", () => {
    expect(decodeViewPrefs('{"version":2,"groupBy":"none","sort":42}').sort).toEqual({});
    expect(decodeViewPrefs('{"version":2,"groupBy":"none","sort":[1,2]}').sort).toEqual({});
  });
});
