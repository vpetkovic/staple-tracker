/**
 * R4a (STA-186) — the sort registry, and the six ways it could quietly become wrong.
 *
 *   1. A CHAIN THAT DOES NOT TERMINATE. Two rows that compare equal are free to swap on the
 *      1.5s fingerprint poll, which reads as the list twitching under the pointer. Every mode
 *      must be TOTAL over distinct rows, and the only thing guaranteeing that is the numeric
 *      identifier at the end of every chain.
 *   2. A LEXICAL IDENTIFIER. `STA-9` after `STA-10` still renders, so nothing fails; the list
 *      is just in an order that stops making sense at ten tickets and stays wrong forever.
 *   3. A DIRECTION THAT FLIPS THE TIE-BREAKS TOO. The obvious implementation — negate the
 *      whole comparator — makes "descending, then ascending again" something other than the
 *      identity, and moves rows that tie for no reason the reader can name.
 *   4. UNQUEUED ROWS SORTING FIRST under `queue` descending, because a null was treated as a
 *      large position rather than as the absence of one.
 *   5. THE DEFAULT DRIFTING. `activity` ascending IS the app's pre-R4a `compareRows`. A
 *      change to it is a change to every list in the product, so the legacy chain is written
 *      out below and the registry is asserted against it directly.
 *   6. SORTING REACHING THE QUEUE. `docs/queue.md`: presentation sort is not the queue. The
 *      last block sorts a fixture through every mode and every direction and asserts the
 *      queue, eligibility and dependency fields on every row are byte-identical afterwards.
 */
import { describe, expect, it } from "vitest";
import { claim, row } from "@/components/task-list/fixtures";
import {
  buildSortContext,
  compareBySort,
  compareIdentifiers,
  DEFAULT_SORT,
  effectiveQueuePosition,
  effectiveUpdatedAt,
  isSortDirection,
  isSortModeId,
  ownQueuePosition,
  SORT_MODES,
  sortChain,
  sortLabel,
  sortMode,
  sortRows,
  subtreeQueuePositions,
  subtreeUpdatedAt,
  withSortMode,
  type SortContext,
  type SortDirection,
  type SortModeId,
} from "./sort-modes";
import {
  OPEN_STATUS_ORDER,
  RESOLVED_STATUSES,
  type IssueRow,
  type IssueStatus,
  type StatusId,
} from "./types";

/**
 * The built-in status order, spelled from `lib/types.ts` rather than imported from the tree.
 * The registry takes the configured order as an ARGUMENT precisely so it need not know where
 * one comes from, and a `lib/` test reaching into `views/` to borrow a constant would be the
 * dependency edge this module is shaped to avoid.
 */
const ORDER: readonly StatusId[] = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES];

/** A context over the rows themselves, which is what every call site builds. */
function ctxFor(rows: readonly IssueRow[], activityTier?: (row: IssueRow) => number): SortContext {
  return buildSortContext(rows, { statusOrder: ORDER, activityTier });
}

function order(rows: readonly IssueRow[], mode: SortModeId, direction: SortDirection): string[] {
  return sortRows(rows, { mode, direction }, ctxFor(rows)).map((r) => r.issue.identifier);
}

/** Every mode, both directions — the loop several tests below walk. */
const EVERY: { mode: SortModeId; direction: SortDirection }[] = SORT_MODES.flatMap((mode) =>
  (["asc", "desc"] as const).map((direction) => ({ mode: mode.id, direction })),
);

describe("the registry", () => {
  it("gives every mode a chain that ENDS in the numeric identifier", () => {
    for (const mode of SORT_MODES) {
      const chain = sortChain(mode.id);
      expect(chain[chain.length - 1], mode.id).toBe("identifier");
    }
  });

  it("never repeats the primary in its own tie-break chain", () => {
    for (const mode of SORT_MODES) {
      expect(mode.tieBreak, mode.id).not.toContain(mode.primary);
      expect(new Set(mode.tieBreak).size, mode.id).toBe(mode.tieBreak.length);
    }
  });

  it("names BOTH readings of every mode's direction, and neither is 'ascending'", () => {
    for (const mode of SORT_MODES) {
      expect(mode.directions.asc.length, mode.id).toBeGreaterThan(0);
      expect(mode.directions.desc.length, mode.id).toBeGreaterThan(0);
      expect(mode.directions.asc).not.toBe(mode.directions.desc);
      expect(`${mode.directions.asc}${mode.directions.desc}`.toLowerCase()).not.toMatch(
        /ascending|descending/,
      );
    }
  });

  it("declares a rollup ONLY where the mode takes one — three of eight", () => {
    const withRollup = SORT_MODES.filter((mode) => mode.rollup !== null).map((mode) => mode.id);
    expect(withRollup).toEqual(["activity", "queue", "updated"]);
  });

  it("has unique ids and opens each mode in a direction it names", () => {
    expect(new Set(SORT_MODES.map((m) => m.id)).size).toBe(SORT_MODES.length);
    for (const mode of SORT_MODES) {
      expect(withSortMode(mode.id)).toEqual({ mode: mode.id, direction: mode.defaultDirection });
    }
  });

  it("repairs an unknown id to the default rather than throwing", () => {
    expect(sortMode("nonsense" as SortModeId).id).toBe("activity");
    expect(isSortModeId("activity")).toBe(true);
    expect(isSortModeId("nonsense")).toBe(false);
    expect(isSortDirection("asc")).toBe(true);
    expect(isSortDirection("sideways")).toBe(false);
  });

  it("says the mode AND the reading in one line, for the trigger", () => {
    expect(sortLabel({ mode: "updated", direction: "desc" })).toBe("Updated · Newest first");
    expect(sortLabel(DEFAULT_SORT)).toBe("Activity · Most active first");
  });
});

describe("numeric identifiers", () => {
  it("puts STA-9 before STA-10 before STA-100 — never lexically", () => {
    const rows = [row({ identifier: "STA-100" }), row({ identifier: "STA-10" }), row({ identifier: "STA-9" })];
    expect(order(rows, "identifier", "asc")).toEqual(["STA-9", "STA-10", "STA-100"]);
    expect(order(rows, "identifier", "desc")).toEqual(["STA-100", "STA-10", "STA-9"]);
  });

  it("compares the PREFIX before the number, so two workspaces do not interleave", () => {
    expect(compareIdentifiers("ABC-2", "STA-1")).toBeLessThan(0);
    expect(compareIdentifiers("STA-2", "ABC-1")).toBeGreaterThan(0);
  });

  it("stays total on shapes that carry no number at all", () => {
    expect(compareIdentifiers("draft", "draft")).toBe(0);
    expect(compareIdentifiers("draft", "STA-1")).toBeGreaterThan(0);
    expect(compareIdentifiers("STA-", "STA-1")).toBeLessThan(0);
  });
});

describe("each mode's primary key", () => {
  it("activity: a live claim outranks everything, then the configured status order", () => {
    const rows = [
      row({ identifier: "STA-1", status: "backlog", priority: "critical" }, claim({ idleSeconds: 5 })),
      row({ identifier: "STA-2", status: "in_progress", priority: "critical" }),
      row({ identifier: "STA-3", status: "todo", priority: "critical" }),
    ];
    const tiers = new Map(rows.map((r) => [r.issue.id, r]));
    const ctx = ctxFor(rows, (r) => {
      const held = tiers.get(r.issue.id)?.claim;
      if (held) return 0;
      return ORDER.indexOf(r.issue.status) + 1;
    });
    const sorted = [...rows].sort(compareBySort({ mode: "activity", direction: "asc" }, ctx));
    expect(sorted.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2", "STA-3"]);
  });

  it("status: the CONFIGURED order, not the alphabet", () => {
    const rows = [
      row({ identifier: "STA-1", status: "todo" }),
      row({ identifier: "STA-2", status: "in_progress" }),
      row({ identifier: "STA-3", status: "backlog" }),
    ];
    expect(order(rows, "status", "asc")).toEqual(["STA-2", "STA-1", "STA-3"]);
    expect(order(rows, "status", "desc")).toEqual(["STA-3", "STA-1", "STA-2"]);
  });

  it("status: an id the workspace order has never heard of ranks LAST but still ranks", () => {
    /*
     * A workspace-defined status (O7a made the set DATA). The cast is the debt `lib/types.ts`
     * documents at the top: `IssueStatus` is still the built-in union while `StatusId` is the
     * real vocabulary, and the registry deliberately speaks the wider one.
     */
    const custom = row({ identifier: "STA-1" });
    const rows = [
      { ...custom, issue: { ...custom.issue, status: "pairing" as unknown as IssueStatus } },
      row({ identifier: "STA-2", status: "todo" }),
    ];
    expect(order(rows, "status", "asc")).toEqual(["STA-2", "STA-1"]);
    // The point of "still ranks": no NaN, so the comparator stays self-consistent.
    const ctx = ctxFor(rows);
    expect(Number.isNaN(ctx.statusRank(rows[0]!))).toBe(false);
  });

  it("priority: critical through low, and back again", () => {
    const rows = [
      row({ identifier: "STA-1", priority: "low" }),
      row({ identifier: "STA-2", priority: "critical" }),
      row({ identifier: "STA-3", priority: "medium" }),
    ];
    expect(order(rows, "priority", "asc")).toEqual(["STA-2", "STA-3", "STA-1"]);
    expect(order(rows, "priority", "desc")).toEqual(["STA-1", "STA-3", "STA-2"]);
  });

  it("updated and created: newest first by default, and they are different clocks", () => {
    const rows = [
      row({ identifier: "STA-1", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" }),
      row({ identifier: "STA-2", createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }),
    ];
    expect(order(rows, "updated", "desc")).toEqual(["STA-1", "STA-2"]);
    expect(order(rows, "updated", "asc")).toEqual(["STA-2", "STA-1"]);
    expect(order(rows, "created", "desc")).toEqual(["STA-2", "STA-1"]);
    expect(sortMode("updated").defaultDirection).toBe("desc");
    expect(sortMode("created").defaultDirection).toBe("desc");
  });

  it("title: alphabetical, case-insensitive, and it does not read the identifier first", () => {
    const rows = [
      row({ identifier: "STA-1", title: "zebra" }),
      row({ identifier: "STA-2", title: "Apple" }),
      row({ identifier: "STA-3", title: "mango" }),
    ];
    expect(order(rows, "title", "asc")).toEqual(["STA-2", "STA-3", "STA-1"]);
    expect(order(rows, "title", "desc")).toEqual(["STA-1", "STA-3", "STA-2"]);
  });

  it("title: identical titles fall through to the numeric identifier, in BOTH directions", () => {
    const rows = [
      row({ identifier: "STA-10", title: "same" }),
      row({ identifier: "STA-2", title: "same" }),
    ];
    expect(order(rows, "title", "asc")).toEqual(["STA-2", "STA-10"]);
    expect(order(rows, "title", "desc")).toEqual(["STA-2", "STA-10"]);
  });
});

describe("queue position — presentation only", () => {
  const queued = (identifier: string, position: number | null, over = {}) => {
    const r = row({ identifier, ...over });
    return { ...r, queuePosition: position } satisfies IssueRow;
  };

  it("orders by position and keeps UNQUEUED rows last in BOTH directions", () => {
    const rows = [queued("STA-1", null), queued("STA-2", 3), queued("STA-3", 1)];
    expect(order(rows, "queue", "asc")).toEqual(["STA-3", "STA-2", "STA-1"]);
    expect(order(rows, "queue", "desc")).toEqual(["STA-2", "STA-3", "STA-1"]);
  });

  it("reads the effective position ahead of the plan position, and absent as null", () => {
    const both = { ...row({ identifier: "STA-1" }), queuePosition: 2, planPosition: 9 };
    const planOnly = { ...row({ identifier: "STA-2" }), planPosition: 5 };
    expect(ownQueuePosition(both)).toBe(2);
    expect(ownQueuePosition(planOnly)).toBe(5);
    expect(ownQueuePosition(row({ identifier: "STA-3" }))).toBeNull();
  });

  it("gives a parent the EARLIEST position beneath it, so an epic follows its queued task", () => {
    const epic = row({ id: "epic", identifier: "STA-1" });
    const child = { ...row({ id: "kid", identifier: "STA-2", parentId: "epic" }), queuePosition: 4 };
    const grandchild = { ...row({ id: "gkid", identifier: "STA-3", parentId: "kid" }), queuePosition: 2 };
    const other = { ...row({ identifier: "STA-4" }), queuePosition: 3 };
    const rows = [epic, child, grandchild, other];

    const subtree = subtreeQueuePositions(rows);
    // A GRANDCHILD reaches the epic, which is the whole point of the upward walk.
    expect(subtree.get("epic")).toBe(2);
    expect(effectiveQueuePosition(epic, subtree)).toBe(2);
    /*
     * The epic, its task and the grandchild all read as position 2 — the epic and the task
     * because the grandchild is beneath them — so the chain settles them by identifier, and
     * the whole family lands AHEAD of the unrelated row at position 3. That is the behaviour
     * the rollup exists for: an unqueued epic holding the queue's next item does not sink
     * below work that comes after it.
     */
    expect(order(rows, "queue", "asc")).toEqual(["STA-1", "STA-2", "STA-3", "STA-4"]);
    expect(effectiveQueuePosition(other, subtree)).toBe(3);
  });

  it("leaves a row with no position anywhere in its subtree unqueued", () => {
    const epic = row({ id: "epic", identifier: "STA-1" });
    const child = row({ id: "kid", identifier: "STA-2", parentId: "epic" });
    expect(effectiveQueuePosition(epic, subtreeQueuePositions([epic, child]))).toBeNull();
  });
});

describe("the updated rollup", () => {
  it("gives a parent the LATEST update in its subtree, and only the `updated` mode takes it", () => {
    const epic = row({ id: "epic", identifier: "STA-1", updatedAt: "2026-01-01T00:00:00.000Z" });
    const child = row({
      id: "kid",
      identifier: "STA-2",
      parentId: "epic",
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
    const other = row({ identifier: "STA-3", updatedAt: "2026-06-01T00:00:00.000Z" });
    const rows = [epic, child, other];

    const subtree = subtreeUpdatedAt(rows);
    expect(effectiveUpdatedAt(epic, subtree)).toBe("2026-09-04T00:00:00.000Z");
    expect(order(rows, "updated", "desc")).toEqual(["STA-1", "STA-2", "STA-3"]);

    /*
     * AND THE TIE-BREAK DOES NOT. `activity`'s third link reads the row's OWN `updatedAt`,
     * which is what makes the default mode reproduce the pre-R4a list; if the rollup leaked
     * into it, the stale epic below would be lifted above the row that really is newer.
     */
    expect(order(rows, "activity", "asc")).toEqual(["STA-2", "STA-3", "STA-1"]);
  });
});

describe("direction", () => {
  it("flips the PRIMARY and leaves every tie-break running forwards", () => {
    // Same priority, different updates: `priority` desc must not also flip the update order.
    const rows = [
      row({ identifier: "STA-1", priority: "high", updatedAt: "2026-09-01T00:00:00.000Z" }),
      row({ identifier: "STA-2", priority: "high", updatedAt: "2026-09-03T00:00:00.000Z" }),
      row({ identifier: "STA-3", priority: "low", updatedAt: "2026-09-02T00:00:00.000Z" }),
    ];
    expect(order(rows, "priority", "asc")).toEqual(["STA-2", "STA-1", "STA-3"]);
    // STA-3 moves to the front; STA-2 still precedes STA-1, because their tie is unchanged.
    expect(order(rows, "priority", "desc")).toEqual(["STA-3", "STA-2", "STA-1"]);
  });

  it("is an involution on every mode: desc then asc is exactly asc", () => {
    const rows = fixture();
    for (const mode of SORT_MODES) {
      const there = order(rows, mode.id, "desc");
      const back = order(sortRows(rows, { mode: mode.id, direction: "desc" }, ctxFor(rows)), mode.id, "asc");
      expect(back, mode.id).toEqual(order(rows, mode.id, "asc"));
      expect(there.length).toBe(rows.length);
    }
  });

  it("leaves no two distinct rows tied, in any mode or direction — the anti-jitter property", () => {
    const rows = fixture();
    for (const pref of EVERY) {
      const compare = compareBySort(pref, ctxFor(rows));
      for (const a of rows) {
        for (const b of rows) {
          if (a === b) expect(compare(a, b)).toBe(0);
          else expect(compare(a, b), `${pref.mode}/${pref.direction}`).not.toBe(0);
        }
      }
    }
  });

  it("is STABLE across identical rebuilds — the 1.5s poll must not reshuffle the list", () => {
    const rows = fixture();
    for (const pref of EVERY) {
      const first = sortRows(rows, pref, ctxFor(rows)).map((r) => r.issue.identifier);
      const second = sortRows(rows, pref, ctxFor(rows)).map((r) => r.issue.identifier);
      // Rebuilt from a DIFFERENT input order, as a real poll's payload would be.
      const third = sortRows([...rows].reverse(), pref, ctxFor(rows)).map((r) => r.issue.identifier);
      expect(second).toEqual(first);
      expect(third, `${pref.mode}/${pref.direction}`).toEqual(first);
    }
  });
});

describe("the default mode is the pre-R4a comparator, step for step", () => {
  /**
   * `compareRows` as it stood in views/tree/tree-model.ts before this ticket, copied here on
   * purpose: a test that imports the thing it is checking against cannot notice the thing
   * changing. Activity tier, priority, newest update, numeric identifier.
   */
  const LEGACY_PRIORITY: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  const legacy = (tierOf: (row: IssueRow) => number) => (a: IssueRow, b: IssueRow) => {
    const byActivity = tierOf(a) - tierOf(b);
    if (byActivity !== 0) return byActivity;
    const byPriority = LEGACY_PRIORITY[a.issue.priority]! - LEGACY_PRIORITY[b.issue.priority]!;
    if (byPriority !== 0) return byPriority;
    if (a.issue.updatedAt !== b.issue.updatedAt) return a.issue.updatedAt < b.issue.updatedAt ? 1 : -1;
    return a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true });
  };

  it("produces the identical order with the tier ON — the flat and epic axes", () => {
    const rows = fixture();
    const tierOf = (r: IssueRow) => (r.claim ? 0 : ORDER.indexOf(r.issue.status) + 1);
    const mine = sortRows(rows, DEFAULT_SORT, ctxFor(rows, tierOf)).map((r) => r.issue.identifier);
    const theirs = [...rows].sort(legacy(tierOf)).map((r) => r.issue.identifier);
    expect(mine).toEqual(theirs);
  });

  it("produces the identical order with the tier OFF — what buildGroups passes", () => {
    const rows = fixture();
    const zero = () => 0;
    const mine = sortRows(rows, DEFAULT_SORT, ctxFor(rows, zero)).map((r) => r.issue.identifier);
    const theirs = [...rows].sort(legacy(zero)).map((r) => r.issue.identifier);
    expect(mine).toEqual(theirs);
  });
});

describe("sorting cannot reach the queue — docs/queue.md", () => {
  /**
   * The criterion is "changing sort never changes queue rank, checkout eligibility or
   * dependency order". Those three live on the row as `queuePosition`/`planPosition`,
   * `claim`/`status`/`gate`, and `deps`, so the check is: sort by everything, then assert
   * every one of those fields on every row is what it was — and that the rows themselves are
   * the SAME OBJECTS, which is the strongest form of "nothing was rewritten".
   */
  const reading = (rows: readonly IssueRow[]) =>
    [...rows]
      .map((r) => ({
        identifier: r.issue.identifier,
        queuePosition: r.queuePosition ?? null,
        planPosition: r.planPosition ?? null,
        status: r.issue.status,
        checkoutAgent: r.issue.checkoutAgent,
        claim: r.claim ? r.claim.heldBy : null,
        blockedBy: r.deps?.blockedBy ?? [],
        blocks: r.deps?.blocks ?? [],
      }))
      .sort((a, b) => compareIdentifiers(a.identifier, b.identifier));

  it("leaves the queue, eligibility and dependency fields byte-identical in every mode", () => {
    const rows = queueFixture();
    const before = reading(rows);
    const beforeJson = JSON.stringify(rows);

    for (const pref of EVERY) {
      const sorted = sortRows(rows, pref, ctxFor(rows));
      expect(reading(sorted), `${pref.mode}/${pref.direction}`).toEqual(before);
      // Same rows, by identity: sorting hands references around and rewrites nothing.
      expect(new Set(sorted).size).toBe(rows.length);
      for (const r of sorted) expect(rows).toContain(r);
    }

    // And the caller's own array is untouched — `sortRows` copies before it sorts.
    expect(JSON.stringify(rows)).toBe(beforeJson);
    expect(rows.map((r) => r.issue.identifier)).toEqual(queueFixture().map((r) => r.issue.identifier));
  });

  it("keeps the queue's own sequence readable after any sort — position 1 is still position 1", () => {
    const rows = queueFixture();
    const queueOrder = (input: readonly IssueRow[]) =>
      input
        .filter((r) => ownQueuePosition(r) !== null)
        .slice()
        .sort((a, b) => ownQueuePosition(a)! - ownQueuePosition(b)!)
        .map((r) => r.issue.identifier);
    const expected = queueOrder(rows);
    for (const pref of EVERY) {
      expect(queueOrder(sortRows(rows, pref, ctxFor(rows))), `${pref.mode}`).toEqual(expected);
    }
  });
});

/** A spread of statuses, priorities, clocks and claims — enough to exercise every chain. */
function fixture(): IssueRow[] {
  return [
    row({ identifier: "STA-10", status: "todo", priority: "high", title: "beta", updatedAt: "2026-09-02T00:00:00.000Z" }),
    row({ identifier: "STA-2", status: "in_progress", priority: "high", title: "alpha", updatedAt: "2026-09-02T00:00:00.000Z" }),
    row({ identifier: "STA-3", status: "backlog", priority: "critical", title: "gamma", updatedAt: "2026-09-01T00:00:00.000Z" }, claim({ idleSeconds: 10 })),
    row({ identifier: "STA-4", status: "blocked", priority: "low", title: "delta", updatedAt: "2026-09-04T00:00:00.000Z" }),
    row({ identifier: "STA-5", status: "done", priority: "medium", title: "epsilon", updatedAt: "2026-08-30T00:00:00.000Z" }),
    row({ identifier: "STA-100", status: "todo", priority: "high", title: "beta", updatedAt: "2026-09-02T00:00:00.000Z" }),
  ];
}

/** The same spread, wearing the queue, gate and dependency fields the criterion names. */
function queueFixture(): IssueRow[] {
  const base = fixture();
  return base.map((r, index) => ({
    ...r,
    queuePosition: index % 2 === 0 ? index + 1 : null,
    planPosition: index === 0 ? 1 : null,
    deps: { blockedBy: index === 1 ? ["STA-3"] : [], blocks: index === 2 ? ["STA-2"] : [] },
  }));
}
