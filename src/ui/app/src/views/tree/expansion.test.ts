/**
 * O3d (STA-129) — the collapsed-groups store, and the one property three axes now depend on.
 *
 * There was no test file here before this ticket. That was defensible while a group key was
 * one of seven statuses: the type caught everything, and the stored shape and the runtime
 * shape were the same closed set. `GroupKey` is now `string` — it has to be, because
 * group-by-epic keys a group on an ISSUE ID and O7a made status ids per-workspace data — and
 * the compiler stopped being the thing that guarantees these three vocabularies do not
 * collide. So the guarantee moves here.
 *
 * WHAT IS ACTUALLY AT RISK, in the order it would bite:
 *
 *   1. A KEY FROM ONE AXIS ANSWERING FOR ANOTHER. One set holds status keys, pickup section
 *      ids and issue ids without a prefix. If they ever overlap, folding "Backlog" would
 *      fold an epic, and nobody would report it as a bug — they would report the list as
 *      "sometimes wrong".
 *   2. THE STORED SHAPE DRIFTING. It has always been a JSON array of strings, which is why
 *      V5's widening and O3d's widening both needed no migration. A future key that is not
 *      a string breaks every previously-written set silently, because `read` repairs rather
 *      than rejects.
 *   3. STORAGE THAT THROWS. Safari private mode makes `getItem` itself throw, and a tracker
 *      that will not render because it could not read a fold preference is a worse failure
 *      than one that opens expanded.
 */
import { describe, expect, it } from "vitest";
import { issue } from "@/components/task-list/fixtures";
import {
  COLLAPSED_GROUPS_KEY,
  EXPANDED_ROWS_KEY,
  explicitExpansion,
  loadCollapsedGroups,
  loadExpandedRows,
} from "./expansion";
import { GROUP_ORDER, NO_PARENT_GROUP_KEY } from "./tree-model";

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

describe("collapsed groups", () => {
  it("holds keys from all THREE axes in one set, unprefixed", () => {
    /*
     * The load-bearing property. A status fold, a pickup-section fold and an epic fold
     * coexist, and switching axes leaves the other two axes' folds exactly where they were —
     * which is why there is one key in storage rather than one per axis.
     */
    const storage = memoryStorage();
    storage.setItem(
      COLLAPSED_GROUPS_KEY,
      JSON.stringify(["backlog", "up_next", "id-1", NO_PARENT_GROUP_KEY]),
    );

    const collapsed = loadCollapsedGroups(storage);

    expect(collapsed.has("backlog")).toBe(true);
    expect(collapsed.has("up_next")).toBe(true);
    expect(collapsed.has("id-1")).toBe(true);
    expect(collapsed.has(NO_PARENT_GROUP_KEY)).toBe(true);
    expect(collapsed.size).toBe(4);
  });

  it("keeps the catch-all key out of every other vocabulary", () => {
    // Asserted here as well as at the mint site, because THIS is the file where a collision
    // would do its damage. `__no_epic__` is spelled with the underscores precisely so no
    // status id, section id or issue id can ever be it.
    expect(GROUP_ORDER as readonly string[]).not.toContain(NO_PARENT_GROUP_KEY);
    expect(["up_next", "in_flight", "waiting", "resolved"]).not.toContain(NO_PARENT_GROUP_KEY);
    expect(NO_PARENT_GROUP_KEY.startsWith("__")).toBe(true);
  });

  it("loads a set written by a PREVIOUS build unchanged", () => {
    // Two widenings have now passed through this module — V5's `IssueStatus -> GroupKey` and
    // O3d's `GroupKey -> string` — and neither was a migration, because the stored shape was
    // an array of strings before both of them and is one after. This is that claim, made
    // testable: a set written when only statuses existed still loads.
    const storage = memoryStorage();
    storage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["backlog", "done"]));

    expect([...loadCollapsedGroups(storage)]).toEqual(["backlog", "done"]);
  });

  it("repairs junk rather than rejecting it, and never throws", () => {
    // A fold preference must not be able to take the view down. Every one of these is a
    // hand-edited key or a half-written value from a killed tab.
    expect(loadCollapsedGroups(memoryStorage()).size).toBe(0);
    expect(loadCollapsedGroups(undefined).size).toBe(0);

    const junk = memoryStorage();
    junk.setItem(COLLAPSED_GROUPS_KEY, "not json");
    expect(loadCollapsedGroups(junk).size).toBe(0);

    const wrongShape = memoryStorage();
    wrongShape.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify({ backlog: true }));
    expect(loadCollapsedGroups(wrongShape).size).toBe(0);

    // A MIXED array keeps the strings and drops the rest, rather than losing every fold to
    // one bad entry.
    const mixed = memoryStorage();
    mixed.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["id-1", 7, null, "backlog"]));
    expect([...loadCollapsedGroups(mixed)]).toEqual(["id-1", "backlog"]);
  });

  it("survives a storage that throws, because Safari private mode does", () => {
    const throwing = memoryStorage({
      getItem: () => {
        throw new Error("SecurityError");
      },
    });

    expect(() => loadCollapsedGroups(throwing)).not.toThrow();
    expect(loadCollapsedGroups(throwing).size).toBe(0);
  });
});

describe("expanded rows", () => {
  it("is keyed by ISSUE ID and stays a separate key from the group folds", () => {
    /*
     * Deliberately not merged with the set above, and O3d is the ticket where that stops
     * being a stylistic choice: a group key can now BE an issue id. One store would make
     * "the STA-119 group is folded" and "the STA-119 row is folded" the same fact, and they
     * are not — the first hides an epic's whole family, the second hides one row's children.
     */
    const storage = memoryStorage();
    storage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify(["id-1"]));
    storage.setItem(EXPANDED_ROWS_KEY, JSON.stringify({ "id-1": true }));

    expect(loadCollapsedGroups(storage).has("id-1")).toBe(true);
    expect(loadExpandedRows(storage).get("id-1")).toBe(true);
  });

  it("returns the EXPLICIT choice only, leaving the default to the model", () => {
    // R1 (STA-100) moved the default out of this module because it differs by mode, and
    // `undefined` is how that separation is spelled. A `false` here would mean "the user
    // folded this", which is a different fact from "nobody has said".
    const overrides = new Map([["id-1", false]]);

    expect(explicitExpansion(overrides, issue({ identifier: "STA-1" }))).toBe(false);
    expect(explicitExpansion(overrides, issue({ identifier: "STA-2" }))).toBeUndefined();
  });

  it("drops entries whose value is not a boolean", () => {
    const storage = memoryStorage();
    storage.setItem(EXPANDED_ROWS_KEY, JSON.stringify({ "id-1": true, "id-2": "yes" }));

    const rows = loadExpandedRows(storage);
    expect(rows.get("id-1")).toBe(true);
    expect(rows.has("id-2")).toBe(false);
  });
});
