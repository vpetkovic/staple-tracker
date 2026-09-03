/**
 * V5 (STA-97) — the placement rule, and the four ways it could quietly become wrong.
 *
 * The row spec's §1 invariant is the whole reason this file exists:
 *
 *   > Every task in the "In Progress" group is in progress.
 *
 * A status-grouped list that violates that is not grouped, it is decorated — the header
 * lies, the count is useless, and (once V4 hides `done` by default) a live child of a
 * finished parent disappears from the tracker entirely. Every test below is a way that
 * invariant, or the honesty it protects, could be broken by a plausible refactor:
 *
 *   1. Nesting a family under its HEAD's status (the obvious implementation) — §11.3.
 *   2. Dropping a row whose parent is filtered away — the one thing a tracker must never do.
 *   3. An unstable sort. The view refetches every 1.5s; two rows that compare equal and
 *      swap on each poll make the list visibly jitter under the reader's eye.
 *   4. A count that follows what is RENDERED rather than what is in the group, so collapsing
 *      a group makes its own count say zero — deleting the only reason the count exists.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  publishWorkspaceSettings,
  resetWorkspaceSettings,
  SEED_SETTINGS,
} from "@/lib/settings";
import {
  OPEN_STATUS_ORDER,
  RESOLVED_STATUSES,
  type ClaimActivity,
  type IssueRow,
  type IssueStatus,
} from "@/lib/types";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import { guideX, indentPx, MAX_INDENT_DEPTH, type TaskRow } from "@/components/task-list";
import { claim, issue, row } from "@/components/task-list/fixtures";
import {
  activityRank,
  buildGroups,
  buildKindGroups,
  buildList,
  buildParentGroups,
  flattenFlat,
  GROUP_ORDER,
  LIVE_CLAIM_TIER,
  NO_PARENT_GROUP_KEY,
  NO_PARENT_GROUP_LABEL,
  sectionsOf,
  subtreeActivityTiers,
  topLevelAncestors,
  visibleOrder,
  visibleRows,
  type BuildOptions,
} from "./tree-model";

/** Everything expanded — the default for the groups these tests mostly use. */
const openAll = { isExpanded: () => true };
const closedAll = { isExpanded: () => false };

/**
 * O3c (STA-128). The rows that are actually IN a bucket, with the ghost context rows
 * dropped — which is the set the group's count, `visibleOrder` and the keyboard all read.
 *
 * A helper rather than an inline `filter` per assertion, so a test that means "membership"
 * cannot accidentally be written as one that means "everything drawn". The two were the
 * same set before this ticket, which is exactly why they now need different spellings.
 */
const real = (rows: readonly TaskRow[]): TaskRow[] => rows.filter((r) => !r.ghost);
const ghosts = (rows: readonly TaskRow[]): TaskRow[] => rows.filter((r) => r.ghost);

describe("group order", () => {
  it("is the open order followed by the resolved statuses, not a retyped array", () => {
    expect(GROUP_ORDER).toEqual([...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES]);
  });

  it("puts in_progress first and done/cancelled last", () => {
    expect(GROUP_ORDER[0]).toBe("in_progress");
    expect(GROUP_ORDER.slice(-2)).toEqual(["done", "cancelled"]);
  });
});

describe("placement", () => {
  it("places a task in the group of its OWN status, never its parent's", () => {
    const parent = row({ id: "p", identifier: "STA-1", status: "backlog" });
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });

    const groups = buildGroups([parent, child], openAll);
    const byStatus = Object.fromEntries(groups.map((g) => [g.status, g]));

    // MEMBERSHIP, not everything drawn: since O3c the In Progress group also draws a
    // dimmed ghost of the backlog parent, and the invariant is about who is IN the group.
    expect(real(byStatus.in_progress!.rows).map((r) => r.issue.id)).toEqual(["c"]);
    expect(real(byStatus.backlog!.rows).map((r) => r.issue.id)).toEqual(["p"]);
    // The parent is a MEMBER of exactly one group and a GHOST in the other. If those two
    // ever became the same thing, the header would start lying again.
    expect(ghosts(byStatus.in_progress!.rows).map((r) => r.issue.id)).toEqual(["p"]);
    expect(ghosts(byStatus.backlog!.rows)).toEqual([]);
    expect(byStatus.in_progress!.count).toBe(1);
  });

  it("draws a cross-group parent as a GHOST inside the child's group, child nested", () => {
    const parent = row({ id: "p", identifier: "STA-1", title: "The epic", status: "backlog" });
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });

    const groups = buildGroups([parent, child], openAll);
    const inProgress = groups.find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-1", 0, true],
      ["STA-2", 1, false],
    ]);
    // The chip is what the ghost REPLACES. Keeping both would say the same thing twice,
    // once as an indent and once as a token pointing at the row directly above.
    expect(inProgress.rows[1]!.breadcrumb).toBeNull();
    // The ghost brackets its children and says so, but carries nothing of the parent's own
    // liveness — `hiddenParents` could never supply it, so no ghost is allowed to.
    expect(inProgress.rows[0]!.hasChildren).toBe(true);
    expect(inProgress.rows[0]!.isExpanded).toBe(true);
    expect(inProgress.rows[0]!.childCount).toBe(1);
    expect(inProgress.rows[0]!.claim).toBeNull();
  });

  it("draws ONE ghost for several orphaned siblings, not one per row", () => {
    const parent = row({ id: "p", identifier: "STA-1", title: "The epic", status: "backlog" });
    const rows = [
      parent,
      row({ id: "a", identifier: "STA-2", status: "in_progress", parentId: "p" }),
      row({ id: "b", identifier: "STA-3", status: "in_progress", parentId: "p" }),
      row({ id: "c", identifier: "STA-4", status: "in_progress", parentId: "p" }),
    ];

    const inProgress = buildGroups(rows, openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-1", 0],
      ["STA-2", 1],
      ["STA-3", 1],
      ["STA-4", 1],
    ]);
    expect(ghosts(inProgress.rows)).toHaveLength(1);
    // Three rows are in this group. The bracket around them is not a fourth.
    expect(inProgress.count).toBe(3);
  });

  it("renders the WHOLE missing ancestor chain, not only the nearest — O8b (STA-150)", () => {
    /*
     * THE CAP THIS FILE USED TO PIN. O3c drew the nearest missing ancestor and stopped,
     * on the argument that a chain "rebuilds the whole tree inside a status group, which
     * is the one thing grouped mode declines to do". STA-148 overturns the premise: the
     * full hierarchy is always visible and context-only ancestors are marked. A reader
     * shown "part of STA-2" and not "…which is part of STA-1" has been told half of where
     * the row lives, and the half that was dropped is the half with the epic in it.
     */
    const rows = [
      row({ id: "g", identifier: "STA-1", status: "backlog" }),
      row({ id: "p", identifier: "STA-2", status: "todo", parentId: "g" }),
      row({ id: "c", identifier: "STA-3", status: "in_progress", parentId: "p" }),
    ];

    const inProgress = buildGroups(rows, openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-1", 0, true],
      ["STA-2", 1, true],
      ["STA-3", 2, false],
    ]);
    // No ghost wears a chip. Its context is the ghost above it, which says more than a
    // chip could; the top of the chain has nothing left to name.
    expect(inProgress.rows.every((r) => r.breadcrumb === null)).toBe(true);
    // One real row is in this group. The brackets around it are not two more.
    expect(inProgress.count).toBe(1);
    // And a bracket is transparent to `+N`: STA-1 hides one TASK, not one bracket.
    expect(inProgress.rows[0]!.childCount).toBe(1);
    expect(inProgress.rows[0]!.hasChildren).toBe(true);
  });

  it("stops the chain at the first ancestor that is a REAL row in the bucket", () => {
    // The epic is in this group itself, so it is the terminator: a dimmed copy of a row
    // the reader is looking straight at would be the same fact twice.
    const rows = [
      row({ id: "g", identifier: "STA-1", status: "in_progress" }),
      row({ id: "p", identifier: "STA-2", status: "todo", parentId: "g" }),
      row({ id: "c", identifier: "STA-3", status: "in_progress", parentId: "p" }),
    ];

    const inProgress = buildGroups(rows, openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-1", 0, false],
      ["STA-2", 1, true],
      ["STA-3", 2, false],
    ]);
    expect(ghosts(inProgress.rows)).toHaveLength(1);
    // Two real rows; the bracket between them is not a third.
    expect(inProgress.count).toBe(2);
    // The real epic hides one TASK behind its fold, not one bracket.
    expect(inProgress.rows[0]!.childCount).toBe(1);
  });

  it("inserts a chain ONCE, however many siblings and sub-families hang off it", () => {
    // Two sub-epics of one epic, none of the three in this group, four leaves between them.
    // Six ghosts would be one per orphan; three would be one per orphan family per level.
    // The answer is three: the epic once, each sub-epic once.
    const rows = [
      row({ id: "e", identifier: "STA-1", status: "backlog" }),
      row({ id: "a", identifier: "STA-2", status: "backlog", parentId: "e" }),
      row({ id: "b", identifier: "STA-3", status: "backlog", parentId: "e" }),
      row({ id: "a1", identifier: "STA-4", status: "in_progress", parentId: "a" }),
      row({ id: "a2", identifier: "STA-5", status: "in_progress", parentId: "a" }),
      row({ id: "b1", identifier: "STA-6", status: "in_progress", parentId: "b" }),
      row({ id: "b2", identifier: "STA-7", status: "in_progress", parentId: "b" }),
    ];

    const inProgress = buildGroups(rows, openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-1", 0, true],
      ["STA-2", 1, true],
      ["STA-4", 2, false],
      ["STA-5", 2, false],
      ["STA-3", 1, true],
      ["STA-6", 2, false],
      ["STA-7", 2, false],
    ]);
    expect(ghosts(inProgress.rows)).toHaveLength(3);
    expect(inProgress.count).toBe(4);
    // The epic's `+N` counts the four tickets under it, not the two brackets.
    expect(inProgress.rows[0]!.childCount).toBe(4);
  });

  it("stops the chain where the ancestor cannot be NAMED, rather than inventing one", () => {
    // The grandparent is not in the data the page was handed at all. A chain that guessed
    // would point the reader at a ticket they cannot reach, which is worse than silence.
    const rows = [
      row({ id: "p", identifier: "STA-2", status: "todo", parentId: "nowhere" }),
      row({ id: "c", identifier: "STA-3", status: "in_progress", parentId: "p" }),
    ];

    const inProgress = buildGroups(rows, openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-2", 0, true],
      ["STA-3", 1, false],
    ]);
  });

  it("terminates on an ancestor CYCLE and still renders the row", () => {
    // The store should never produce this. If it does, the chain must stop rather than
    // recurse forever — and unlike a cycle among real rows, the orphan still gets a page.
    const rows = [
      row({ id: "a", identifier: "STA-1", status: "backlog", parentId: "b" }),
      row({ id: "b", identifier: "STA-2", status: "backlog", parentId: "a" }),
      row({ id: "c", identifier: "STA-3", status: "in_progress", parentId: "a" }),
    ];

    const inProgress = buildGroups(rows, openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.ghost === true])).toEqual([
      ["STA-2", true],
      ["STA-1", true],
      ["STA-3", false],
    ]);
    expect(inProgress.count).toBe(1);
  });

  it("gives the ghost the PARENT's rollup, so an epic's progress rides with the bracket", () => {
    const rows = [
      row({ id: "p", identifier: "STA-1", status: "backlog" }),
      row({ id: "a", identifier: "STA-2", status: "in_progress", parentId: "p" }),
      row({ id: "b", identifier: "STA-3", status: "done", parentId: "p" }),
    ];

    const inProgress = buildGroups(rows, { ...openAll, rollupSource: rows }).find(
      (g) => g.status === "in_progress",
    )!;

    // 2 descendants, 1 of them done — counted over the UNFILTERED source, so the done
    // child the default filter hides is still in the denominator (O3b's rule, unchanged).
    expect(inProgress.rows[0]!.ghost).toBe(true);
    expect(inProgress.rows[0]!.rollup).toMatchObject({ total: 2, resolved: 1 });
  });

  it("a ghost sorts as the BEST row it brackets, so no real row is moved by it", () => {
    // The epic is `low`; the task it holds is `critical`. Ranked by the epic's own
    // priority the whole block would sink below STA-9 and take the critical row with it —
    // acquiring a context line would have reordered real work.
    const rows = [
      row({ id: "e", identifier: "STA-1", status: "backlog", priority: "low" }),
      row({ id: "c", identifier: "STA-2", status: "todo", parentId: "e", priority: "critical" }),
      row({ id: "o", identifier: "STA-9", status: "todo", priority: "high" }),
    ];

    const todo = buildGroups(rows, openAll).find((g) => g.status === "todo")!;

    expect(todo.rows.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2", "STA-9"]);
    // The critical row is still first among the group's REAL rows, exactly as it was.
    expect(real(todo.rows).map((r) => r.issue.identifier)).toEqual(["STA-2", "STA-9"]);
  });

  it("keeps a real parent's own placement untouched — the ghost is a copy, not a move", () => {
    const rows = [
      row({ id: "p", identifier: "STA-1", status: "backlog" }),
      row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" }),
    ];

    const groups = buildGroups(rows, openAll);
    const backlog = groups.find((g) => g.status === "backlog")!;

    // It is still a full, real, countable row in the group its own status put it in.
    expect(backlog.rows.map((r) => [r.issue.identifier, r.ghost === true])).toEqual([
      ["STA-1", false],
    ]);
    expect(backlog.count).toBe(1);
  });

  it("takes the ghost from V4's hiddenParents when a FILTER removed the parent", () => {
    // The done-epic case: `applyFilters` removed the parent under the hide-resolved
    // default, so it is not in `rows` at all — but it is on the board and worth drawing.
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });
    const parent = issue({ id: "p", identifier: "STA-1", title: "Shipped epic", status: "done" });

    const groups = buildGroups([child], { ...openAll, hiddenParents: new Map([["c", parent]]) });

    expect(groups[0]!.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-1", 0, true],
      ["STA-2", 1, false],
    ]);
    // A filtered-away ghost and a cross-group ghost are the SAME shape. If they diverged,
    // the reader would have to know which kind of absence they were looking at.
    expect(groups[0]!.rows[0]!.claim).toBeNull();
    expect(groups[0]!.count).toBe(1);
  });

  it("turns the ghost off for a container with no indent, and the chip comes back", () => {
    // `TreeGrid` passes `columns.disclosure` — the existing switch meaning "this surface
    // can nest". With it off the placement takes the pre-O3c path, element for element.
    const parent = row({ id: "p", identifier: "STA-1", title: "The epic", status: "backlog" });
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });

    const groups = buildGroups([parent, child], { ...openAll, ghostParents: false });
    const inProgress = groups.find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.identifier, r.depth])).toEqual([["STA-2", 0]]);
    expect(inProgress.rows[0]!.ghost).toBe(false);
    expect(inProgress.rows[0]!.breadcrumb).toEqual({ identifier: "STA-1", title: "The epic" });
  });

  it("nests only when parent and child land in the SAME group", () => {
    const parent = row({ id: "p", identifier: "STA-1", status: "in_progress" });
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });

    const inProgress = buildGroups([parent, child], openAll).find((g) => g.status === "in_progress")!;

    expect(inProgress.rows.map((r) => [r.issue.id, r.depth])).toEqual([
      ["p", 0],
      ["c", 1],
    ]);
    // A nested child is placed by lineage, so it carries no breadcrumb — the elbow says it.
    expect(inProgress.rows[1]?.breadcrumb).toBeNull();
    expect(inProgress.rows[0]?.hasChildren).toBe(true);
    expect(inProgress.rows[0]?.childCount).toBe(1);
  });

  it("keeps a row whose parent is absent from the data entirely — no ghost, no breadcrumb", () => {
    // The parent is in NEITHER map: not in another group, not reported by `hiddenParents`.
    // Dropping the child would hide live work, which is the one thing a tracker must never
    // do — and inventing a ghost with no title to put in it would be worse than silence.
    const orphan = row({ id: "c", identifier: "STA-2", status: "todo", parentId: "gone" });

    const todo = buildGroups([orphan], openAll).find((g) => g.status === "todo")!;

    expect(todo.rows.map((r) => r.issue.id)).toEqual(["c"]);
    expect(todo.rows[0]?.depth).toBe(0);
    expect(todo.rows[0]?.breadcrumb).toBeNull();
    expect(todo.rows[0]?.ghost).toBe(false);
  });
});

describe("groups", () => {
  it("omits empty groups rather than rendering a zero count", () => {
    const groups = buildGroups([row({ status: "todo" })], openAll);
    expect(groups.map((g) => g.status)).toEqual(["todo"]);
  });

  it("hides done and cancelled unless asked, behind one predicate", () => {
    const rows = [
      row({ id: "a", status: "todo" }),
      row({ id: "b", status: "done" }),
      row({ id: "c", status: "cancelled" }),
    ];

    expect(buildGroups(rows, openAll).map((g) => g.status)).toEqual(["todo"]);
    expect(buildGroups(rows, { ...openAll, showResolved: true }).map((g) => g.status)).toEqual([
      "todo",
      "done",
      "cancelled",
    ]);
  });

  it("counts the whole group, including children hidden by a collapsed parent", () => {
    const parent = row({ id: "p", identifier: "STA-1", status: "in_progress" });
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });

    const open = buildGroups([parent, child], openAll)[0]!;
    const shut = buildGroups([parent, child], closedAll)[0]!;

    expect(open.count).toBe(2);
    expect(shut.count).toBe(2); // same count …
    expect(shut.rows.map((r) => r.issue.id)).toEqual(["p"]); // … but one rendered row
    expect(shut.rows[0]?.hasChildren).toBe(true);
    expect(shut.rows[0]?.childCount).toBe(1);
  });
});

describe("sort within a group", () => {
  it("orders by priority, then newest update, then identifier", () => {
    const rows = [
      row({ id: "low", identifier: "STA-4", status: "todo", priority: "low" }),
      row({ id: "crit", identifier: "STA-3", status: "todo", priority: "critical" }),
      row({ id: "hi", identifier: "STA-2", status: "todo", priority: "high" }),
      row({ id: "med", identifier: "STA-1", status: "todo", priority: "medium" }),
    ];
    const group = buildGroups(rows, openAll)[0]!;
    expect(group.rows.map((r) => r.issue.id)).toEqual(["crit", "hi", "med", "low"]);
  });

  it("breaks a priority tie by newest updatedAt", () => {
    const rows = [
      row({ id: "old", identifier: "STA-1", status: "todo", updatedAt: "2026-09-01T00:00:00.000Z" }),
      row({ id: "new", identifier: "STA-2", status: "todo", updatedAt: "2026-09-02T00:00:00.000Z" }),
    ];
    expect(buildGroups(rows, openAll)[0]!.rows.map((r) => r.issue.id)).toEqual(["new", "old"]);
  });

  it("is STABLE across identical rebuilds — the 1.5s poll must not make rows jitter", () => {
    // Same priority, same timestamp: only the identifier tiebreak stands between this list
    // and two rows swapping places under the reader's eye every poll.
    const rows = [
      row({ id: "b", identifier: "STA-10", status: "todo" }),
      row({ id: "a", identifier: "STA-9", status: "todo" }),
      row({ id: "c", identifier: "STA-11", status: "todo" }),
    ];
    const once = buildGroups(rows, openAll)[0]!.rows.map((r) => r.issue.identifier);
    const twice = buildGroups([...rows].reverse(), openAll)[0]!.rows.map((r) => r.issue.identifier);

    expect(once).toEqual(twice);
    expect(once).toEqual(["STA-9", "STA-10", "STA-11"]); // numeric, not lexicographic
  });
});

describe("connector guides", () => {
  it("terminates the last child and continues the rail past a middle one", () => {
    const rows = [
      row({ id: "p", identifier: "STA-1", status: "todo" }),
      row({ id: "c1", identifier: "STA-2", status: "todo", parentId: "p" }),
      row({ id: "c2", identifier: "STA-3", status: "todo", parentId: "p" }),
    ];
    const [head, first, last] = buildGroups(rows, openAll)[0]!.rows;

    expect(head?.depth).toBe(0);
    expect(head?.guides).toEqual([]);
    // guides[i] answers "does a rail continue below this row at level i".
    expect(first?.isLast).toBe(false);
    expect(first?.guides).toEqual([true]);
    expect(last?.isLast).toBe(true);
    expect(last?.guides).toEqual([false]);
  });

  it("draws an ancestor rail for a grandchild whose parent still has siblings", () => {
    const rows = [
      row({ id: "p", identifier: "STA-1", status: "todo" }),
      row({ id: "c1", identifier: "STA-2", status: "todo", parentId: "p" }),
      row({ id: "g1", identifier: "STA-3", status: "todo", parentId: "c1" }),
      row({ id: "c2", identifier: "STA-4", status: "todo", parentId: "p" }),
    ];
    const rendered = buildGroups(rows, openAll)[0]!.rows;
    const grandchild = rendered.find((r) => r.issue.id === "g1")!;

    expect(grandchild.depth).toBe(2);
    // level 0 rail continues (c2 is still to come); level 1 terminates (g1 is an only child)
    expect(grandchild.guides).toEqual([true, false]);
  });
});

describe("indent", () => {
  it("steps 20px per level and stops growing past the cap", () => {
    expect(indentPx(0)).toBe(0);
    expect(indentPx(1)).toBe(20);
    expect(indentPx(MAX_INDENT_DEPTH)).toBe(MAX_INDENT_DEPTH * 20);
    expect(indentPx(MAX_INDENT_DEPTH + 5)).toBe(MAX_INDENT_DEPTH * 20);
  });

  it("hangs the connector in the indent gutter, LEFT of the child's own glyphs", () => {
    // The property that matters is an ordering, not a number: the elbow must start left of
    // where the child's content begins, or it runs backwards and there is no elbow at all.
    // This is the check that would have caught the spec's own identifier-column origin.
    const childContentStartsAt = (level: number) =>
      8 + indentPx(level + 1) + 24 + 8 + 16 + 8; // padding + indent + select + gap + disclosure + gap

    for (const level of [0, 1, 2, 5]) {
      expect(guideX(level)).toBeLessThan(childContentStartsAt(level));
    }
    // …and one level's rail must sit exactly one indent step left of the next.
    expect(guideX(1) - guideX(0)).toBe(20);
  });
});


/**
 * R4 (STA-102) extracted the flatten pass out of `buildGroups` so the ungrouped view
 * (R1 / STA-100) is literally the same code with the bucketing step skipped. These pin the
 * two properties that make that claim true rather than merely plausible.
 */
describe("flattenFlat — one bucket, no status axis", () => {
  const openAllFlat = { isExpanded: () => true, showResolved: true };

  it("nests a parent and child that grouped mode would have split across two groups", () => {
    const rows = [
      row({ id: "p", identifier: "STA-1", status: "backlog" }),
      row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" }),
    ];

    // Grouped: two groups, and the parent is a MEMBER of one and a ghost bracket in the
    // other — so each group still contains exactly one real row (O3c).
    const grouped = buildGroups(rows, openAllFlat);
    expect(grouped).toHaveLength(2);
    expect(grouped.map((g) => g.count)).toEqual([1, 1]);
    expect(grouped.map((g) => real(g.rows).map((r) => r.issue.identifier))).toEqual([
      ["STA-2"],
      ["STA-1"],
    ]);

    // Flat: one list, the child indented under its parent and needing no breadcrumb,
    // because the parent it would point at is the row directly above it.
    const flat = flattenFlat(rows, openAllFlat);
    expect(flat.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2"]);
    expect(flat[1]!.depth).toBe(1);
    expect(flat[1]!.breadcrumb).toBeNull();
    expect(flat[0]!.hasChildren).toBe(true);
  });

  it("NEVER emits a ghost, so the ungrouped view is what it was before O3c", () => {
    // The one case flat mode can still orphan: a filter took the parent off the page
    // entirely. Grouped mode draws it back as a ghost; flat mode must not, because
    // redrawing a filtered row is undoing the filter in the view whose whole reading is
    // "what does this project look like right now".
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });
    const parent = issue({ id: "p", identifier: "STA-1", title: "Shipped epic", status: "done" });
    const options = { isExpanded: () => true, hiddenParents: new Map([["c", parent]]) };

    const flat = flattenFlat([child], options);

    expect(flat.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-2", 0, false],
    ]);
    expect(flat[0]!.breadcrumb).toEqual({ identifier: "STA-1", title: "Shipped epic" });

    // And it stays off even if a caller asks for ghosts: `flattenFlat` passes a hard
    // `false`, so the option cannot reach it by accident from a shared options object.
    expect(
      flattenFlat([child], { ...options, ghostParents: true }).every((r) => !r.ghost),
    ).toBe(true);
  });

  it("still honours the resolved gate, so the two modes hide the same rows", () => {
    const rows = [
      row({ id: "a", identifier: "STA-1", status: "todo" }),
      row({ id: "b", identifier: "STA-2", status: "done" }),
    ];

    expect(flattenFlat(rows, { isExpanded: () => true }).map((r) => r.issue.id)).toEqual(["a"]);
    expect(
      flattenFlat(rows, { isExpanded: () => true, showResolved: true }).map((r) => r.issue.id),
    ).toEqual(["a", "b"]);
  });
});


/**
 * R1 (STA-100) — `session.visibleOrder`, the contract R6 (STA-106) pages through with the
 * detail view's prev/next arrows.
 *
 * The reason this is tested at the model layer rather than only in the browser: the arrows
 * and the list's own keyboard sequence must never disagree about what is visible, and the way
 * they would come to disagree is by being computed twice. They are not — both go through
 * `visibleRows` — and these pin the three properties that make that worth relying on.
 */
describe("the visible ordered list", () => {
  const opts = { isExpanded: () => true, showResolved: true };
  const none = () => false;

  const family = () => [
    row({ id: "p", identifier: "STA-1", status: "in_progress" }),
    row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" }),
    row({ id: "t", identifier: "STA-3", status: "todo" }),
    row({ id: "b", identifier: "STA-4", status: "backlog" }),
  ];

  it("is screen order, headers excluded, in both modes", () => {
    const flat = buildList(family(), "none", opts);
    const grouped = buildList(family(), "status", opts);

    // Flat: one list, priority/recency order, the child nested under its parent.
    expect(visibleOrder(flat, none).map((s) => s.ref)).toEqual(["STA-1", "STA-2", "STA-3", "STA-4"]);
    // Grouped: in_progress, then todo, then backlog — GROUP_ORDER, with no header entries.
    expect(visibleOrder(grouped, none).map((s) => s.ref)).toEqual([
      "STA-1",
      "STA-2",
      "STA-3",
      "STA-4",
    ]);
    // And it carries the workspace, because `open()` needs both halves.
    expect(visibleOrder(flat, none)[0]).toEqual({ workspace: "staple", ref: "STA-1" });
  });

  it("EXCLUDES the rows of a collapsed group", () => {
    // The bug this prevents: the rows are still in the DOM so the fold can animate, and
    // `next` landing on a row nobody can see is exactly what the arrows exist to avoid.
    const grouped = buildList(family(), "status", opts);
    const order = visibleOrder(grouped, (status) => status === "in_progress");

    expect(order.map((s) => s.ref)).toEqual(["STA-3", "STA-4"]);
  });

  it("EXCLUDES rows hidden under a collapsed parent", () => {
    const collapsed = buildList(family(), "none", { isExpanded: () => false, showResolved: true });
    expect(visibleOrder(collapsed, none).map((s) => s.ref)).toEqual(["STA-1", "STA-3", "STA-4"]);
  });

  it("is exactly the rows the keyboard can reach — one derivation, not two", () => {
    const grouped = buildList(family(), "status", opts);
    const collapse = (status: string) => status === "backlog";

    const rows = visibleRows(grouped, collapse as never);
    const order = visibleOrder(grouped, collapse as never);

    expect(order).toHaveLength(rows.length);
    expect(order.map((s) => s.ref)).toEqual(rows.map((r) => r.issue.identifier));
  });

  it("is empty when the filtered page is empty", () => {
    expect(visibleOrder(buildList([], "none", opts), none)).toEqual([]);
    expect(visibleOrder(buildList([], "status", opts), none)).toEqual([]);
  });

  /**
   * O3c (STA-128). The three ghost exclusions, and the reason each one is not optional.
   */
  const split = () => [
    row({ id: "p", identifier: "STA-1", status: "backlog" }),
    row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" }),
  ];

  it("EXCLUDES ghost context rows, so prev/next never lands on one", () => {
    const grouped = buildList(split(), "status", opts);

    // The In Progress group draws STA-1 as a ghost above STA-2…
    const drawn = grouped.kind === "grouped" ? grouped.groups[0]!.rows : [];
    expect(drawn.map((r) => [r.issue.identifier, r.ghost === true])).toEqual([
      ["STA-1", true],
      ["STA-2", false],
    ]);

    // …and the arrows walk STA-2 then STA-1-the-real-row, ONCE each. Without the
    // exclusion STA-1 would appear twice in one traversal, and the second visit would
    // open a ticket the reader had already paged past.
    expect(visibleOrder(grouped, none).map((s) => s.ref)).toEqual(["STA-2", "STA-1"]);
  });

  it("keeps `visibleRows` and `visibleOrder` in step across the ghost exclusion too", () => {
    const grouped = buildList(split(), "status", opts);

    const rows = visibleRows(grouped, none);
    const order = visibleOrder(grouped, none);

    expect(rows.some((r) => r.ghost)).toBe(false);
    expect(order).toHaveLength(rows.length);
    expect(order.map((s) => s.ref)).toEqual(rows.map((r) => r.issue.identifier));
  });

  it("excludes ghosts under PICKUP grouping as well as status", () => {
    // Same rule, other axis. A reader who learned it on one menu entry must not find a
    // different answer on the next.
    const pickupShape = buildList(split(), "pickup", opts);
    const drawn = pickupShape.kind === "pickup" ? pickupShape.groups.flatMap((g) => g.rows) : [];

    expect(drawn.some((r) => r.ghost)).toBe(true);
    expect(visibleOrder(pickupShape, none).map((s) => s.ref).sort()).toEqual(["STA-1", "STA-2"]);
  });
});

/**
 * R1's other half: `buildList` is the only place `groupBy` becomes a shape, so the default
 * cannot be re-decided at a call site.
 */
describe("buildList", () => {
  const opts = { isExpanded: () => true, showResolved: true };

  it("maps the preference onto exactly two shapes", () => {
    const rows = [row({ id: "a", identifier: "STA-1", status: "todo" })];
    expect(buildList(rows, "none", opts).kind).toBe("flat");
    expect(buildList(rows, "status", opts).kind).toBe("grouped");
  });

  it("puts a parent and child of different statuses TOGETHER when flat and APART when grouped", () => {
    // This is the whole argument for changing the default: grouped mode is honest about
    // status and therefore cannot show a family in one place.
    const rows = [
      row({ id: "p", identifier: "STA-1", status: "backlog" }),
      row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" }),
    ];

    const flat = buildList(rows, "none", opts);
    expect(flat.kind === "flat" && flat.rows.map((r) => r.depth)).toEqual([0, 1]);

    const grouped = buildList(rows, "status", opts);
    expect(grouped.kind === "grouped" && grouped.groups).toHaveLength(2);
    // Each group holds exactly one real row — the family is still SPLIT BY STATUS. O3c
    // draws a dimmed bracket around the child; it does not reunite the family.
    expect(
      grouped.kind === "grouped" &&
        grouped.groups.map((g) => real(g.rows).map((r) => r.issue.identifier)),
    ).toEqual([["STA-2"], ["STA-1"]]);
    expect(grouped.kind === "grouped" && grouped.groups.map((g) => g.count)).toEqual([1, 1]);
  });
});


/**
 * R1 (STA-100) — the default expansion rule, which is NOT the same in both shapes.
 *
 * This is the bug that flat-by-default would otherwise have shipped, and no assertion caught
 * it: it was found by looking at the evidence screenshot and noticing a seeded in-progress
 * task was simply not on the page. Grouped mode folds a row by its OWN status, which is
 * coherent there because a parent and its nested children share a group. Flat mode has no
 * such guarantee — a backlog epic can hold in-progress children, and folding it by its own
 * status hides live work that grouped mode kept on screen as a root of the In Progress group.
 */
describe("default expansion depends on the shape", () => {
  /** A backlog epic with an in-progress child — the case that exposes the difference. */
  const backlogEpicWithLiveChild = () => [
    row({ id: "e", identifier: "STA-1", status: "backlog" }),
    row({ id: "k", identifier: "STA-2", status: "in_progress", parentId: "e" }),
    row({ id: "z", identifier: "STA-3", status: "backlog", parentId: "e" }),
  ];

  /** No explicit choice anywhere — `undefined` means "the model decides". */
  const untouched = { isExpanded: () => undefined, showResolved: true };

  it("FLAT: opens a folded parent that is hiding active work", () => {
    const flat = flattenFlat(backlogEpicWithLiveChild(), untouched);

    expect(flat.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2", "STA-3"]);
    expect(flat[0]!.isExpanded).toBe(true);
    expect(flat[1]!.depth).toBe(1);
  });

  it("FLAT: still folds a backlog parent with nothing live under it", () => {
    // The other half of the rule. Without this, "flat" would mean "everything expanded",
    // and a large backlog becomes the wall V5 folded it to avoid.
    const rows = [
      row({ id: "e", identifier: "STA-1", status: "backlog" }),
      row({ id: "z", identifier: "STA-2", status: "backlog", parentId: "e" }),
    ];
    const flat = flattenFlat(rows, untouched);

    expect(flat.map((r) => r.issue.identifier)).toEqual(["STA-1"]);
    expect(flat[0]!.isExpanded).toBe(false);
    expect(flat[0]!.childCount).toBe(1);
  });

  it("FLAT: an explicit collapse still wins over the active-descendant default", () => {
    const flat = flattenFlat(backlogEpicWithLiveChild(), {
      isExpanded: (issue) => (issue.id === "e" ? false : undefined),
      showResolved: true,
    });

    expect(flat.map((r) => r.issue.identifier)).toEqual(["STA-1"]);
    expect(flat[0]!.isExpanded).toBe(false);
  });

  it("GROUPED: unchanged — a row is folded by its own status", () => {
    // The live child is not hidden here; it is in its own group, under a ghost of the
    // epic since O3c, which is exactly why the grouped default was correct and the flat
    // one could not be. The FOLD is still decided by each row's own status.
    const groups = buildGroups(backlogEpicWithLiveChild(), untouched);
    const backlog = groups.find((g) => g.status === "backlog")!;
    const progress = groups.find((g) => g.status === "in_progress")!;

    expect(backlog.rows[0]!.isExpanded).toBe(false);
    expect(backlog.rows.map((r) => r.issue.identifier)).toEqual(["STA-1"]);
    expect(real(progress.rows).map((r) => r.issue.identifier)).toEqual(["STA-2"]);

    /*
     * THE GHOST IS NOT SUBJECT TO THE FOLD, and this is the assertion that pins it.
     * `untouched` makes no explicit choice, so the backlog epic's default is COLLAPSED —
     * and it is collapsed, in the backlog group, where its own children live. Its ghost in
     * the In Progress group is open regardless, because folding it would take a live row
     * out of the group its status put it in.
     */
    expect(progress.rows[0]!.ghost).toBe(true);
    expect(progress.rows[0]!.isExpanded).toBe(true);
    expect(progress.rows[1]!.depth).toBe(1);
  });

  it("walks the WHOLE ancestor chain, not just the immediate parent", () => {
    const rows = [
      row({ id: "a", identifier: "STA-1", status: "backlog" }),
      row({ id: "b", identifier: "STA-2", status: "backlog", parentId: "a" }),
      row({ id: "c", identifier: "STA-3", status: "in_progress", parentId: "b" }),
    ];
    const flat = flattenFlat(rows, untouched);

    expect(flat.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2", "STA-3"]);
    expect(flat.map((r) => r.depth)).toEqual([0, 1, 2]);
  });
});


/**
 * O3a (STA-126) — ACTIVITY-FIRST SORT.
 *
 * The bug this fixes is visible on the tracker's own board: `STA-26`, a high-priority
 * backlog epic nobody has touched, outranks `STA-108`, which is in progress with an agent
 * inside it. Priority is a statement of intent; activity is a statement of fact, and a list
 * that answers "what is happening right now" has to read the fact first.
 *
 * Four ways this could quietly become wrong again:
 *
 *   1. Ranking a STALE claim. A holder that died four hours ago pinned to the top of the
 *      list is worse than no claim at all — it is a lie with a badge on it.
 *   2. Rolling up only ONE level, so an epic whose live work is a grandchild stays idle.
 *   3. Applying the tier inside a status GROUP, which reorders a bucket by something other
 *      than a tie break and breaks the ticket's own "unchanged under grouping" criterion.
 *   4. Hardcoding the tier list, which would make O7's configurable status order a code
 *      change instead of the data change it was designed to be.
 */
describe("activity rank", () => {
  const live = () => claim({ idleSeconds: 30 });
  const dead = () => claim({ idleSeconds: STALE_CLAIM_SECONDS });

  describe("the tiers themselves", () => {
    it("puts a LIVE claim above every status", () => {
      const held = row({ id: "h", status: "backlog" }, live());
      const working = row({ id: "w", status: "in_progress" });

      expect(activityRank(held)).toBe(LIVE_CLAIM_TIER);
      expect(activityRank(held)).toBeLessThan(activityRank(working));
    });

    it("does NOT rank a stale claim — a corpse falls back to its own status", () => {
      // The single liveness judgement is lib/claim.ts's isStaleClaim; this reads it rather
      // than spelling a second threshold that could drift from the badge's.
      const abandoned = row({ id: "h", status: "backlog" }, dead());

      expect(activityRank(abandoned)).not.toBe(LIVE_CLAIM_TIER);
      expect(activityRank(abandoned)).toBe(activityRank(row({ id: "u", status: "backlog" })));
    });

    it("orders in_progress, in_review, blocked, todo, backlog, then the resolved ones", () => {
      const ranks = (
        ["in_progress", "in_review", "blocked", "todo", "backlog", "done", "cancelled"] as const
      ).map((status) => activityRank(row({ status })));

      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      expect(new Set(ranks).size).toBe(ranks.length); // strictly increasing, no ties
    });

    it("defaults to GROUP_ORDER rather than a second hand-typed tier list", () => {
      // The board already learned once that two constants which both know the column order
      // will drift. The tier list IS that order, offset past the claim's tier.
      for (const [index, status] of GROUP_ORDER.entries()) {
        expect(activityRank(row({ status }))).toBe(index + 1);
      }
    });

    it("ranks a status the configured order does not mention LAST, never NaN", () => {
      const order = ["in_progress"] as const;
      const known = activityRank(row({ status: "in_progress" }), undefined, order);
      const unknown = activityRank(row({ status: "backlog" }), undefined, order);

      expect(Number.isFinite(unknown)).toBe(true);
      expect(unknown).toBeGreaterThan(known);
    });
  });

  describe("the parent rollup", () => {
    it("gives a parent its child's tier", () => {
      const rows = [
        row({ id: "p", identifier: "STA-1", status: "backlog" }),
        row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" }),
      ];
      const subtree = subtreeActivityTiers(rows);

      expect(activityRank(rows[0]!, subtree)).toBe(activityRank(rows[1]!));
    });

    it("reaches a GRANDCHILD — the rollup is the whole subtree, not one level", () => {
      const rows = [
        row({ id: "top", identifier: "STA-1", status: "backlog" }),
        row({ id: "mid", identifier: "STA-2", status: "backlog", parentId: "top" }),
        row({ id: "leaf", identifier: "STA-3", status: "backlog", parentId: "mid" }, live()),
      ];
      const subtree = subtreeActivityTiers(rows);

      expect(activityRank(rows[0]!, subtree)).toBe(LIVE_CLAIM_TIER);
      expect(activityRank(rows[1]!, subtree)).toBe(LIVE_CLAIM_TIER);
    });

    it("never lowers a row that has nothing beneath it", () => {
      const rows = [
        row({ id: "lonely", identifier: "STA-1", status: "backlog" }),
        row({ id: "busy", identifier: "STA-2", status: "in_progress" }),
      ];
      const subtree = subtreeActivityTiers(rows);

      expect(subtree.has("lonely")).toBe(false);
      expect(activityRank(rows[0]!, subtree)).toBe(activityRank(row({ status: "backlog" })));
    });

    it("keeps the parent's OWN tier when it beats everything beneath it", () => {
      const rows = [
        row({ id: "p", identifier: "STA-1", status: "in_progress" }),
        row({ id: "c", identifier: "STA-2", status: "backlog", parentId: "p" }),
      ];
      const subtree = subtreeActivityTiers(rows);

      expect(activityRank(rows[0]!, subtree)).toBe(activityRank(row({ status: "in_progress" })));
    });

    it("survives a parent cycle the store should never produce", () => {
      const rows = [
        row({ id: "a", identifier: "STA-1", status: "backlog", parentId: "b" }),
        row({ id: "b", identifier: "STA-2", status: "in_progress", parentId: "a" }),
      ];
      expect(() => subtreeActivityTiers(rows)).not.toThrow();
    });
  });

  describe("the flat list", () => {
    const opts = { isExpanded: () => true, showResolved: true };

    it("sorts an in_progress epic with a live child above a HIGHER-PRIORITY backlog epic", () => {
      // The exact case named in STA-126: today STA-26 (critical, untouched) outranks STA-108.
      const rows = [
        row({ id: "idle", identifier: "STA-26", status: "backlog", priority: "critical" }),
        row({ id: "epic", identifier: "STA-108", status: "in_progress", priority: "low" }),
        row(
          { id: "kid", identifier: "STA-109", status: "todo", priority: "low", parentId: "epic" },
          live(),
        ),
      ];

      expect(flattenFlat(rows, opts).map((r) => r.issue.identifier)).toEqual([
        "STA-108",
        "STA-109",
        "STA-26",
      ]);
    });

    it("lifts a backlog epic whose only live work is a GRANDCHILD", () => {
      const rows = [
        row({ id: "other", identifier: "STA-1", status: "backlog", priority: "critical" }),
        row({ id: "top", identifier: "STA-2", status: "backlog", priority: "low" }),
        row({ id: "mid", identifier: "STA-3", status: "backlog", priority: "low", parentId: "top" }),
        row(
          { id: "leaf", identifier: "STA-4", status: "backlog", priority: "low", parentId: "mid" },
          live(),
        ),
      ];

      expect(flattenFlat(rows, opts).map((r) => r.issue.identifier)).toEqual([
        "STA-2",
        "STA-3",
        "STA-4",
        "STA-1",
      ]);
    });

    it("does NOT lift an epic whose held child went silent", () => {
      const rows = [
        row({ id: "other", identifier: "STA-1", status: "backlog", priority: "critical" }),
        row({ id: "top", identifier: "STA-2", status: "backlog", priority: "low" }),
        row(
          { id: "leaf", identifier: "STA-3", status: "backlog", priority: "low", parentId: "top" },
          dead(),
        ),
      ];

      expect(flattenFlat(rows, opts).map((r) => r.issue.identifier)[0]).toBe("STA-1");
    });

    it("falls back to priority, then newest update, then identifier INSIDE a tier", () => {
      const rows = [
        row({ id: "d", identifier: "STA-4", status: "todo", priority: "low" }),
        row({
          id: "c",
          identifier: "STA-3",
          status: "todo",
          priority: "high",
          updatedAt: "2026-09-01T00:00:00.000Z",
        }),
        row({
          id: "b",
          identifier: "STA-2",
          status: "todo",
          priority: "high",
          updatedAt: "2026-09-02T00:00:00.000Z",
        }),
        row({ id: "a", identifier: "STA-1", status: "todo", priority: "critical" }),
      ];

      expect(flattenFlat(rows, opts).map((r) => r.issue.id)).toEqual(["a", "b", "c", "d"]);
    });

    it("ranks siblings against siblings at every depth, not only the roots", () => {
      const rows = [
        row({ id: "p", identifier: "STA-1", status: "backlog" }),
        row({
          id: "sleepy",
          identifier: "STA-2",
          status: "backlog",
          priority: "critical",
          parentId: "p",
        }),
        row(
          { id: "held", identifier: "STA-3", status: "backlog", priority: "low", parentId: "p" },
          live(),
        ),
      ];

      expect(flattenFlat(rows, opts).map((r) => r.issue.identifier)).toEqual([
        "STA-1",
        "STA-3",
        "STA-2",
      ]);
    });

    it("is DETERMINISTIC across rebuilds — the 1.5s poll must not make rows jitter", () => {
      const build = () => [
        row({ id: "a", identifier: "STA-9", status: "todo" }),
        row({ id: "b", identifier: "STA-10", status: "in_progress" }),
        row({ id: "c", identifier: "STA-11", status: "todo" }, live()),
        row({ id: "d", identifier: "STA-12", status: "todo", parentId: "a" }),
      ];

      const once = flattenFlat(build(), opts).map((r) => r.issue.identifier);
      const twice = flattenFlat(build().reverse(), opts).map((r) => r.issue.identifier);

      expect(once).toEqual(twice);
      expect(once).toEqual(["STA-11", "STA-10", "STA-9", "STA-12"]);
    });

    it("takes the CONFIGURED status order, so O7 reorders the tree with no code change", () => {
      const rows = [
        row({ id: "w", identifier: "STA-1", status: "in_progress" }),
        row({ id: "b", identifier: "STA-2", status: "backlog" }),
      ];
      const reversed = [...GROUP_ORDER].reverse();

      expect(flattenFlat(rows, opts).map((r) => r.issue.id)).toEqual(["w", "b"]);
      expect(flattenFlat(rows, { ...opts, statusOrder: reversed }).map((r) => r.issue.id)).toEqual([
        "b",
        "w",
      ]);
    });
  });

  /**
   * The ticket's own boundary: grouped output is unchanged EXCEPT for tie order inside a
   * group. The tempting shortcut — "every row in a status bucket shares a status, so the
   * tier is inert there anyway" — is false in two ways, and both are pinned here.
   */
  describe("group-by-status is unchanged", () => {
    const opts = { isExpanded: () => true, showResolved: true };

    it("does not let a live claim jump a higher-priority row inside a group", () => {
      const rows = [
        row({ id: "crit", identifier: "STA-1", status: "todo", priority: "critical" }),
        row({ id: "held", identifier: "STA-2", status: "todo", priority: "low" }, live()),
      ];
      const todo = buildGroups(rows, opts).find((g) => g.status === "todo")!;

      expect(todo.rows.map((r) => r.issue.id)).toEqual(["crit", "held"]);
    });

    it("does not let a descendant in ANOTHER group reorder a bucket", () => {
      const rows = [
        row({ id: "crit", identifier: "STA-1", status: "backlog", priority: "critical" }),
        row({ id: "epic", identifier: "STA-2", status: "backlog", priority: "low" }),
        row({ id: "kid", identifier: "STA-3", status: "in_progress", parentId: "epic" }, live()),
      ];
      const backlog = buildGroups(rows, opts).find((g) => g.status === "backlog")!;

      expect(backlog.rows.map((r) => r.issue.id)).toEqual(["crit", "epic"]);
    });
  });
});

/**
 * THE ROLLUP, WHERE THE PLACEMENT PASS PUTS IT — O3b (STA-127).
 *
 * The arithmetic itself belongs to `parentRollups` and is pinned in
 * `components/task-list/row-bits.test.ts`. What is pinned here is the SEAM: that `flatten()`
 * attaches it beside `hasChildren`/`childCount`, that a leaf gets null rather than an empty
 * rollup, and — the reason the whole ticket needed an amendment — that the counts come from
 * the UNFILTERED list while the sort's tiers deliberately do not.
 */
describe("the collapsed-parent rollup", () => {
  const live = () => claim({ idleSeconds: 30 });
  const epic = () => row({ id: "epic", identifier: "STA-1", status: "in_progress" });
  const kid = (
    n: number,
    status: IssueStatus,
    parentId = "epic",
    activity: ClaimActivity | null = null,
  ) => row({ id: `k${n}`, identifier: `STA-${n}`, status, parentId }, activity);

  const FIVE = [
    epic(),
    kid(2, "done"),
    kid(3, "done"),
    kid(4, "done"),
    kid(5, "todo"),
    kid(6, "in_progress"),
  ];

  it("is populated on a parent and null on a leaf", () => {
    const flat = flattenFlat([epic(), kid(2, "todo")], { isExpanded: () => false });

    expect(flat[0]!.rollup).toMatchObject({ total: 1, resolved: 0 });
    // A leaf renders nothing. `null` rather than a zeroed rollup, so the row cannot draw a
    // bar claiming an epic has no children — see the note in `flatRow`.
    expect(flattenFlat([epic(), kid(2, "todo")], { isExpanded: () => true })[1]!.rollup).toBeNull();
  });

  it("counts the UNFILTERED source, so 3 of 5 done survives the done filter", () => {
    // What the view actually does: `rows` is post-`applyFilters`, `rollupSource` is `all`.
    const onScreen = FIVE.filter((r) => r.issue.status !== "done");
    const flat = flattenFlat(onScreen, { isExpanded: () => false, rollupSource: FIVE });

    expect(flat[0]!.rollup).toMatchObject({ resolved: 3, total: 5 });
    // And `childCount` is untouched by the rollup: it still means the DIRECT children the
    // fold removed, which the filter has already cut to two. The two numbers differ on
    // purpose and the row prints both.
    expect(flat[0]!.childCount).toBe(2);
  });

  it("defaults the source to the rows it was given, so every existing caller is unchanged", () => {
    const onScreen = FIVE.filter((r) => r.issue.status !== "done");
    const flat = flattenFlat(onScreen, { isExpanded: () => false });

    // No `rollupSource`: the rollup is over what was passed, which is what a surface with
    // no wider list should get. The seam is opt-in, exactly like O3a's `statusOrder`.
    expect(flat[0]!.rollup).toMatchObject({ resolved: 0, total: 2 });
  });

  it("reaches a grandchild, which `childCount` never does", () => {
    const rows = [epic(), kid(2, "in_progress"), kid(3, "done", "k2"), kid(4, "done", "k3")];
    const flat = flattenFlat(rows, { isExpanded: () => false });

    expect(flat[0]!.childCount).toBe(1);
    expect(flat[0]!.rollup).toMatchObject({ total: 3, resolved: 2 });
  });

  it("carries a LIVE descendant claim and refuses a stale one", () => {
    const withLive = [epic(), kid(2, "in_progress", "epic", live())];
    const withStale = [
      epic(),
      kid(2, "in_progress", "epic", claim({ idleSeconds: STALE_CLAIM_SECONDS })),
    ];

    expect(flattenFlat(withLive, { isExpanded: () => false })[0]!.rollup?.live).toMatchObject({
      identifier: "STA-2",
    });
    expect(flattenFlat(withStale, { isExpanded: () => false })[0]!.rollup?.live).toBeNull();
  });

  it("is populated under group-by-status too, from the same unfiltered source", () => {
    // The parent is alone in its bucket here — its done children are filed in the Done
    // group by §11.3 — and the rollup still knows about them, because it never asked the
    // bucket. That is the difference between a rollup and a count of rendered rows.
    const groups = buildGroups(FIVE, { isExpanded: () => false, showResolved: false });
    const inProgress = groups.find((g) => g.status === "in_progress")!;
    const parent = inProgress.rows.find((r) => r.issue.id === "epic")!;

    expect(parent.rollup).toMatchObject({ resolved: 3, total: 5 });
  });

  it("leaves the sort O3a landed exactly where it was", () => {
    // The rollup is populated on the same pass that ranks the rows, and the two must not
    // have become entangled: `subtreeActivityTiers` still reads the VISIBLE rows while the
    // rollup reads `rollupSource`, and this is the pair that would break if they merged.
    const onScreen = FIVE.filter((r) => r.issue.status !== "done");
    const flat = flattenFlat(onScreen, { isExpanded: () => true, rollupSource: FIVE });

    expect(flat.map((r) => r.issue.id)).toEqual(["epic", "k6", "k5"]);
  });
});

/**
 * O3d (STA-129) — group by epic, and the ways a group-by-ANCESTOR axis quietly loses or
 * duplicates a row.
 *
 * This axis INVERTS the §1 invariant at the top of this file rather than breaking it: under
 * group-by-status a header is a claim about every row's STATUS, and here it is a claim about
 * every row's LINEAGE. So "every task under the STA-1 header descends from STA-1" is the
 * property, and the failure modes are the mirror image of the status axis's:
 *
 *   1. The epic drawn as the header AND as a row inside its own group — one issue twice.
 *   2. A root that heads nothing VANISHING, because it was promoted to the header of an
 *      empty group and empty groups do not render. The one thing a tracker must never do.
 *   3. The ancestor map built from the FILTERED rows, so hiding `done` silently re-buckets a
 *      whole family into "No epic" — the status filter rewriting the grouping axis.
 *   4. O3c's ghost drawing the epic a second time inside the group it already titles.
 */
describe("group by epic", () => {
  /** Everything expanded, and the whole list is also the rollup source. */
  const opts = (rows: IssueRow[], over: Partial<BuildOptions> = {}): BuildOptions => ({
    isExpanded: () => true,
    showResolved: true,
    rollupSource: rows,
    ...over,
  });

  const byEpic = (rows: IssueRow[], over: Partial<BuildOptions> = {}) =>
    buildParentGroups(rows, opts(rows, over));

  it("puts every row under its TOP-LEVEL ancestor, not under its direct parent", () => {
    // A three-deep family. The GRANDCHILD is the assertion: bucketing on `parentId` would
    // have filed it under STA-2, which is a group header nobody asked for and which splits
    // the epic in half.
    const epic = row({ identifier: "STA-1", kind: "epic", title: "Tree ordering" });
    const mid = row({ identifier: "STA-2", parentId: "id-1" });
    const leaf = row({ identifier: "STA-3", parentId: "id-2" });

    const groups = byEpic([epic, mid, leaf]);

    expect(groups.map((g) => g.status)).toEqual(["id-1"]);
    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-2", "STA-3"]);
    // And the lineage is DRAWN, not flattened: the grandchild is still nested under its own
    // parent inside the group.
    expect(groups[0]!.rows.map((r) => r.depth)).toEqual([0, 1]);
  });

  it("promotes the epic to the header and does NOT also render it as a row", () => {
    const epic = row({ identifier: "STA-1", kind: "epic", title: "Tree ordering" });
    const child = row({ identifier: "STA-2", parentId: "id-1" });

    const groups = byEpic([epic, child]);

    expect(groups[0]!.heading).toMatchObject({
      identifier: "STA-1",
      label: "Tree ordering",
      kind: "epic",
    });
    // The whole point. One issue, one place on the page.
    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-2"]);
    expect(groups.flatMap((g) => g.rows).filter((r) => r.issue.identifier === "STA-1")).toEqual([]);
  });

  it("files a root that heads NOTHING under 'No epic' rather than losing it", () => {
    // The failure this pins: promote every root to a header, and a childless root becomes
    // the header of an empty group — which does not render, so the row is simply gone.
    const epic = row({ identifier: "STA-1", kind: "epic" });
    const child = row({ identifier: "STA-2", parentId: "id-1" });
    const loner = row({ identifier: "STA-3" });

    const groups = byEpic([epic, child, loner]);

    expect(groups.map((g) => g.status)).toEqual(["id-1", NO_PARENT_GROUP_KEY]);
    expect(groups[1]!.heading).toMatchObject({
      issue: null,
      label: NO_PARENT_GROUP_LABEL,
      identifier: null,
      kind: null,
      rollup: null,
    });
    expect(groups[1]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-3"]);
  });

  it("keeps 'No epic' LAST even when its rows are the most active on the page", () => {
    // Ranked by its best member the catch-all would lead the page, which inverts the one
    // thing this axis says: work belongs to something.
    const epic = row({ identifier: "STA-1", kind: "epic", status: "backlog" });
    const child = row({ identifier: "STA-2", parentId: "id-1", status: "backlog" });
    const live = row({ identifier: "STA-3", status: "in_progress" }, claim());

    expect(byEpic([epic, child, live]).map((g) => g.status)).toEqual([
      "id-1",
      NO_PARENT_GROUP_KEY,
    ]);
  });

  it("draws one catch-all group and nothing else when nothing has a parent", () => {
    const groups = byEpic([row({ identifier: "STA-1" }), row({ identifier: "STA-2" })]);

    expect(groups.map((g) => g.status)).toEqual([NO_PARENT_GROUP_KEY]);
    expect(groups[0]!.count).toBe(2);
  });

  it("lets a FILTERED-OUT epic still name and head its group", () => {
    /*
     * The acceptance criterion, and the reason the ancestor map is built from `rollupSource`
     * rather than from `rows`. A done epic is hidden by the default filter; built from the
     * visible rows it would stop being anybody's ancestor and its whole family would land in
     * "No epic" — the status filter silently rewriting the grouping axis.
     */
    const epic = row({ identifier: "STA-1", kind: "epic", title: "Shipped epic", status: "done" });
    const child = row({ identifier: "STA-2", parentId: "id-1", status: "todo" });

    const groups = buildParentGroups([child], {
      isExpanded: () => true,
      showResolved: true,
      rollupSource: [epic, child],
    });

    expect(groups.map((g) => g.status)).toEqual(["id-1"]);
    expect(groups[0]!.heading).toMatchObject({ identifier: "STA-1", label: "Shipped epic" });
    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-2"]);
    // And NO ghost of it, and no breadcrumb either: the header names the parent more loudly
    // than a dimmed row would. This is what `headOfGroup` buys.
    expect(ghosts(groups[0]!.rows)).toEqual([]);
    expect(groups[0]!.rows[0]!.breadcrumb).toBeNull();
  });

  it("suppresses the head's ghost even when the filter hid it via hiddenParents", () => {
    // The other route to a ghost. `hiddenParents` is keyed by CHILD id and yields the parent
    // directly, so a suppression that only consulted `presentAnywhere` would still draw one.
    const epic = row({ identifier: "STA-1", kind: "epic", status: "done" });
    const child = row({ identifier: "STA-2", parentId: "id-1", status: "todo" });

    const groups = buildParentGroups([child], {
      isExpanded: () => true,
      showResolved: true,
      rollupSource: [epic, child],
      hiddenParents: new Map([["id-2", epic.issue]]),
    });

    expect(ghosts(groups[0]!.rows)).toEqual([]);
    expect(groups[0]!.rows[0]!.breadcrumb).toBeNull();
  });

  it("orders groups by the EPIC's activity rank, including its best descendant", () => {
    /*
     * O3a's rule, applied to headers. `idle` is `in_progress` and would lead on its own
     * status; `sleepy` is `backlog` and only outranks it because of the live claim on its
     * child. A group order that read the epic's own status would put them the other way
     * round, which is exactly the reading STA-126 exists to replace.
     */
    const sleepy = row({ identifier: "STA-1", kind: "epic", status: "backlog" });
    const held = row({ identifier: "STA-2", parentId: "id-1", status: "todo" }, claim());
    const idle = row({ identifier: "STA-3", kind: "epic", status: "in_progress" });
    const quiet = row({ identifier: "STA-4", parentId: "id-3", status: "backlog" });

    expect(byEpic([idle, quiet, sleepy, held]).map((g) => g.status)).toEqual(["id-1", "id-3"]);
  });

  it("ranks a filtered-away epic by the claim on its OWN row in the unfiltered source", () => {
    // The epic's row is not in `rows` at all, so its claim is only visible in `rollupSource`
    // — and a header ranked off `visible` would have silently dropped to the bottom.
    const held = row({ identifier: "STA-1", kind: "epic", status: "done" }, claim());
    const heldKid = row({ identifier: "STA-2", parentId: "id-1", status: "backlog" });
    const plain = row({ identifier: "STA-3", kind: "epic", status: "in_progress" });
    const plainKid = row({ identifier: "STA-4", parentId: "id-3", status: "backlog" });

    const groups = buildParentGroups([heldKid, plain, plainKid], {
      isExpanded: () => true,
      showResolved: true,
      rollupSource: [held, heldKid, plain, plainKid],
    });

    expect(groups.map((g) => g.status)).toEqual(["id-1", "id-3"]);
  });

  it("breaks a tie between two equally idle epics deterministically", () => {
    // The list rebuilds every 1.5s on the fingerprint poll. Two headers that compare equal
    // and swap on each rebuild read as the page twitching, so the identifier tiebreak is
    // numeric-aware and STA-9 must precede STA-10.
    const nine = row({ identifier: "STA-9", kind: "epic", status: "todo" });
    const nineKid = row({ identifier: "STA-11", parentId: "id-9", status: "todo" });
    const ten = row({ identifier: "STA-10", kind: "epic", status: "todo" });
    const tenKid = row({ identifier: "STA-12", parentId: "id-10", status: "todo" });

    expect(byEpic([ten, tenKid, nine, nineKid]).map((g) => g.status)).toEqual(["id-9", "id-10"]);
    // Same answer from the other input order — a sort, not an accident of insertion.
    expect(byEpic([nine, nineKid, ten, tenKid]).map((g) => g.status)).toEqual(["id-9", "id-10"]);
  });

  it("puts the epic's rollup on the header, counted over the UNFILTERED source", () => {
    // Three of the five descendants are done and hidden by the filter. A rollup read off the
    // bucket would say 0/2, which is not a partial answer but the wrong one.
    const epic = row({ identifier: "STA-1", kind: "epic" });
    const all = [
      epic,
      row({ identifier: "STA-2", parentId: "id-1", status: "done" }),
      row({ identifier: "STA-3", parentId: "id-1", status: "done" }),
      row({ identifier: "STA-4", parentId: "id-1", status: "done" }),
      row({ identifier: "STA-5", parentId: "id-1", status: "todo" }),
      row({ identifier: "STA-6", parentId: "id-1", status: "todo" }),
    ];

    const groups = buildParentGroups(all, {
      isExpanded: () => true,
      showResolved: false,
      rollupSource: all,
    });

    expect(groups[0]!.heading?.rollup).toMatchObject({ resolved: 3, total: 5 });
    // …while the COUNT is what is actually in the bucket, which is a different number and is
    // meant to be. Two numbers, two questions; the header renders the rollup.
    expect(groups[0]!.count).toBe(2);
  });

  it("counts `bucket.length`, so a ghost cannot reach the count", () => {
    /*
     * O3c's rule, restated on this axis. The MID-LEVEL parent is filtered away, so its child
     * gets a ghost of it inside the epic's group — three rows drawn, two rows real. The
     * epic itself never becomes one; that is `headOfGroup`, asserted above.
     */
    const epic = row({ identifier: "STA-1", kind: "epic" });
    const mid = row({ identifier: "STA-2", parentId: "id-1", status: "done" });
    const leaf = row({ identifier: "STA-3", parentId: "id-2", status: "todo" });
    const other = row({ identifier: "STA-4", parentId: "id-1", status: "todo" });

    const groups = buildParentGroups([leaf, other], {
      isExpanded: () => true,
      showResolved: true,
      rollupSource: [epic, mid, leaf, other],
      hiddenParents: new Map([["id-3", mid.issue]]),
    });

    const drawn = groups[0]!.rows;
    expect(ghosts(drawn).map((r) => r.issue.identifier)).toEqual(["STA-2"]);
    // O3c's other rule, still holding here: the ghost sorts as the BEST ROW IT BRACKETS, so
    // the block lands at STA-3's position rather than at the missing parent's, and STA-3
    // precedes STA-4 on the identifier tiebreak exactly as it would have unbracketed.
    expect(real(drawn).map((r) => r.issue.identifier)).toEqual(["STA-3", "STA-4"]);
    expect(groups[0]!.count).toBe(2);
    expect(ghosts(drawn).map((r) => r.issue.identifier)).not.toContain("STA-1");
  });

  it("ranks rows INSIDE a group by activity, unlike the status axis", () => {
    // Status grouping ranks every row 0 because STA-126 promised its output unchanged. This
    // axis carries no such promise, and the live child belongs at the top of its epic
    // however low its priority.
    const epic = row({ identifier: "STA-1", kind: "epic" });
    const urgent = row({ identifier: "STA-2", parentId: "id-1", priority: "critical" });
    const live = row({ identifier: "STA-3", parentId: "id-1", priority: "low" }, claim());

    expect(byEpic([epic, urgent, live])[0]!.rows.map((r) => r.issue.identifier)).toEqual([
      "STA-3",
      "STA-2",
    ]);
  });

  it("uses the FLAT expansion default, so a backlog sub-epic cannot hide live work", () => {
    /*
     * The whole family is in ONE group here, so the status rule — fold a parent whose own
     * status is idle — has nowhere to put the children it folds away. Status grouping can
     * afford that rule only because it files the child in its own group. This is R1's trap,
     * one axis over.
     */
    const epic = row({ identifier: "STA-1", kind: "epic", status: "backlog" });
    const sub = row({ identifier: "STA-2", parentId: "id-1", status: "backlog" });
    const live = row({ identifier: "STA-3", parentId: "id-2", status: "in_progress" });

    // `isExpanded` returns undefined — nobody has clicked anything, so the DEFAULT decides.
    const groups = buildParentGroups([epic, sub, live], {
      isExpanded: () => undefined,
      showResolved: true,
      rollupSource: [epic, sub, live],
    });

    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-2", "STA-3"]);
  });

  it("is reachable through buildList and produces the SAME shape as status grouping", () => {
    // Not a third `kind` in the union: the fold, the keyboard sequence, `visibleOrder` and
    // the animation are the same behaviour on both grouped axes, and a second shape would
    // have made every one of them grow a branch that does the same thing.
    const epic = row({ identifier: "STA-1", kind: "epic" });
    const child = row({ identifier: "STA-2", parentId: "id-1" });
    const rows = [epic, child];

    const shape = buildList(rows, "parent", opts(rows));

    expect(shape.kind).toBe("grouped");
    expect(sectionsOf(shape).map((s) => s.key)).toEqual(["id-1"]);
    // And the navigation contract follows for free — no header and no ghost in it, and a
    // collapsed group contributes nothing.
    expect(visibleOrder(shape, () => false).map((s) => s.ref)).toEqual(["STA-2"]);
    expect(visibleOrder(shape, (key) => key === "id-1")).toEqual([]);
  });

  it("keys the fold on the EPIC's id, which no status or section is spelled as", () => {
    // The three vocabularies share one collapsed-groups set in expansion.ts. This is the
    // property that lets them, asserted where the keys are MINTED rather than where they
    // are stored.
    const epic = row({ identifier: "STA-1", kind: "epic" });
    const child = row({ identifier: "STA-2", parentId: "id-1" });
    const loner = row({ identifier: "STA-3" });

    const keys = byEpic([epic, child, loner]).map((g) => g.status);

    expect(keys).toEqual(["id-1", "__no_epic__"]);
    for (const key of keys) {
      expect(GROUP_ORDER as readonly string[]).not.toContain(key);
      expect(["up_next", "in_flight", "waiting", "resolved"]).not.toContain(key);
    }
  });
});

/**
 * O3d (STA-129) — the ancestor walk the epic axis is built on.
 *
 * Extracted and tested separately because it is the one piece whose failure is SILENT: a
 * walk that stopped one level early would still produce groups, still produce headers, and
 * still look right on a two-deep tree, which is the depth every fixture in this file used
 * before this ticket.
 */
/**
 * GROUP BY KIND — O1c (STA-130).
 *
 * The fourth axis, and the one whose tests are mostly about ORDER, because the bucketing
 * itself is a field read. Three things could plausibly go wrong and each has a test:
 *
 *   1. The order silently becomes alphabetical, or the hand-kept `KIND_RANK` mirror
 *      becomes the primary rather than the fallback — either of which makes this the one
 *      surface that ignores the workspace's configured vocabulary.
 *   2. A row is LOST. A kind the vocabulary has not got, or an empty one from an older
 *      server, must land in a bucket rather than in none. An unbucketed row is not a row
 *      with a wrong header — it is a row that is not on the page.
 *   3. The two knobs get answered like `status` rather than like `parent`, which folds a
 *      backlog parent over live children that have nowhere else to appear.
 */
describe("group by kind", () => {
  afterEach(() => resetWorkspaceSettings());

  const opts = (rows: IssueRow[], over: Partial<BuildOptions> = {}): BuildOptions => ({
    isExpanded: () => true,
    showResolved: true,
    rollupSource: rows,
    ...over,
  });

  const byKind = (rows: IssueRow[], over: Partial<BuildOptions> = {}) =>
    buildKindGroups(rows, opts(rows, over));

  /** The seed vocabulary, reordered and relabelled — what an operator's drag produces. */
  function vocabulary(kinds: readonly [string, string][]) {
    publishWorkspaceSettings({
      ...SEED_SETTINGS,
      kinds: kinds.map(([id, label], sortOrder) => ({ id, label, sortOrder, isBuiltin: true })),
    });
  }

  it("orders the groups epic, task, bug, chore, spike", () => {
    // The acceptance criterion verbatim. Alphabetical would be bug, chore, epic, spike,
    // task — a different answer at every position, which is what lets this test fail.
    const rows = ["spike", "chore", "bug", "task", "epic"].map((kind, i) =>
      row({ identifier: `STA-${i + 1}`, kind }),
    );

    expect(byKind(rows).map((g) => g.status)).toEqual(["epic", "task", "bug", "chore", "spike"]);
  });

  it("draws no header for a kind nobody has filed", () => {
    // `buildGroups`'s rule, kept: a "Spike 0" header is permanent furniture announcing a
    // non-event, and furniture stops being read within a day.
    const groups = byKind([row({ identifier: "STA-1", kind: "bug" })]);

    expect(groups.map((g) => g.status)).toEqual(["bug"]);
  });

  it("names the bucket after the KIND and identifies no issue", () => {
    // O3d's heading shape, with the catch-all's answers to the three issue-shaped fields.
    // A kind bucket is a vocabulary entry, not a ticket: nothing to identify, nothing to
    // roll up, so the header's trailing slot correctly falls back to the plain count.
    const groups = byKind([row({ identifier: "STA-1", kind: "bug" })]);

    expect(groups[0]!.heading).toEqual({
      issue: null,
      label: "Bug",
      identifier: null,
      kind: "bug",
      rollup: null,
    });
  });

  it("follows the workspace's order and labels, not the built-in seed", () => {
    // The O7b substitution, on this axis. The seed says epic-then-bug; this workspace has
    // dragged bug above epic and renamed both, and the headers must say so.
    vocabulary([
      ["bug", "Defect"],
      ["epic", "Initiative"],
    ]);
    const groups = byKind([
      row({ identifier: "STA-1", kind: "epic" }),
      row({ identifier: "STA-2", kind: "bug" }),
    ]);

    expect(groups.map((g) => g.status)).toEqual(["bug", "epic"]);
    expect(groups.map((g) => g.heading?.label)).toEqual(["Defect", "Initiative"]);
  });

  it("puts a kind the vocabulary has not got LAST, rather than dropping its rows", () => {
    // The second between another tab adding a kind and /api/settings catching up. Losing
    // the row would be the worst available failure; `KIND_RANK`'s note says sort it last.
    const groups = byKind([
      row({ identifier: "STA-1", kind: "zeta" }),
      row({ identifier: "STA-2", kind: "task" }),
      row({ identifier: "STA-3", kind: "epic" }),
    ]);

    expect(groups.map((g) => g.status)).toEqual(["epic", "task", "zeta"]);
    expect(groups[2]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-1"]);
    // Unlabelled by the vocabulary, so the accessor title-cases the id. Never `undefined`.
    expect(groups[2]!.heading?.label).toBe("Zeta");
  });

  it("orders several unknown kinds by KIND_RANK and then by id, so the order is TOTAL", () => {
    // `spike` is a built-in that this workspace has removed from its vocabulary, so it is
    // a leftover WITH a rank; the other two have none and fall back to the id. A partial
    // order here is a page that reshuffles under the reader on the 1.5s poll.
    vocabulary([["task", "Task"]]);
    const groups = byKind([
      row({ identifier: "STA-1", kind: "zeta" }),
      row({ identifier: "STA-2", kind: "alpha" }),
      row({ identifier: "STA-3", kind: "spike" }),
      row({ identifier: "STA-4", kind: "task" }),
    ]);

    expect(groups.map((g) => g.status)).toEqual(["task", "spike", "alpha", "zeta"]);
  });

  it("files a row whose kind is EMPTY or ABSENT under the default kind", () => {
    // `issues.kind` is NOT NULL with a default, so neither should be reachable — but an
    // `IssueRow` can be built from a payload an older server sent, and the consequence of
    // getting this wrong is a ticket that is simply not on the page.
    const empty = row({ identifier: "STA-1", kind: "" });
    const absent = row({ identifier: "STA-2" });
    delete (absent.issue as { kind?: string }).kind;

    const groups = byKind([empty, absent]);

    expect(groups.map((g) => g.status)).toEqual(["task"]);
    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2"]);
    expect(groups[0]!.heading?.label).toBe("Task");
  });

  it("counts the REAL rows, with a cross-kind parent drawn as a ghost beside them", () => {
    // The epic heads the Epic group, so its task is an orphan in the Task group and O3c's
    // bracket is drawn around it — which is the feature working, not a defect: without it
    // "every bug on the board" is a flat list with no indication of whose they are.
    const epic = row({ identifier: "STA-1", kind: "epic", title: "The epic" });
    const task = row({ identifier: "STA-2", kind: "task", parentId: "id-1" });

    const groups = byKind([epic, task]);
    const tasks = groups.find((g) => g.status === "task")!;

    expect(tasks.rows.map((r) => [r.issue.identifier, r.ghost === true])).toEqual([
      ["STA-1", true],
      ["STA-2", false],
    ]);
    // `bucket.length`, per O3c: ghosts cannot reach the count by construction.
    expect(tasks.count).toBe(1);
    expect(real(tasks.rows).map((r) => r.issue.identifier)).toEqual(["STA-2"]);
  });

  it("turns the activity tier ON inside a bucket, unlike status grouping", () => {
    // Inside one kind, the row somebody is holding right now belongs at the top. With the
    // tier off these two would sort by identifier and come back in the other order, which
    // is exactly what this asserts is no longer true.
    const quiet = row({ identifier: "STA-1", kind: "task" });
    const held = row({ identifier: "STA-2", kind: "task" }, claim());

    const groups = byKind([quiet, held]);

    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-2", "STA-1"]);
    expect(activityRank(held, subtreeActivityTiers([quiet, held], GROUP_ORDER), GROUP_ORDER)).toBe(
      LIVE_CLAIM_TIER,
    );
  });

  it("uses the FLAT expansion default, so a fold cannot hide live work", () => {
    // The knob that separates this axis from status grouping. Both rows are tasks, so they
    // share a bucket and the child NESTS — folding the backlog parent by its own status
    // would take the in-progress child off the page entirely. R1's trap, one axis over.
    const parent = row({ id: "p", identifier: "STA-1", kind: "task", status: "backlog" });
    const child = row({
      id: "c",
      identifier: "STA-2",
      kind: "task",
      status: "in_progress",
      parentId: "p",
    });

    const groups = buildKindGroups([parent, child], {
      isExpanded: () => undefined,
      showResolved: true,
    });

    expect(groups[0]!.rows[0]!.isExpanded).toBe(true);
    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2"]);
  });

  it("still folds a backlog parent with nothing live under it", () => {
    // The other half of the flat rule. Without it, this axis would mean "expand
    // everything" and a large backlog becomes the wall V5 folded it to avoid.
    const parent = row({ id: "p", identifier: "STA-1", kind: "task", status: "backlog" });
    const child = row({
      id: "c",
      identifier: "STA-2",
      kind: "task",
      status: "backlog",
      parentId: "p",
    });

    const groups = buildKindGroups([parent, child], {
      isExpanded: () => undefined,
      showResolved: true,
    });

    expect(groups[0]!.rows.map((r) => r.issue.identifier)).toEqual(["STA-1"]);
    expect(groups[0]!.rows[0]!.isExpanded).toBe(false);
  });

  it("hides resolved rows unless asked, like every other axis", () => {
    const rows = [
      row({ identifier: "STA-1", kind: "bug", status: "done" }),
      row({ identifier: "STA-2", kind: "task" }),
    ];

    expect(buildKindGroups(rows, { isExpanded: () => true }).map((g) => g.status)).toEqual(["task"]);
    expect(byKind(rows).map((g) => g.status)).toEqual(["task", "bug"]);
  });

  it("produces the SAME grouped shape, so the fold and the keyboard follow for free", () => {
    // O3d's argument for reusing `"grouped"` rather than adding a fourth `ListShape`, now
    // load-bearing for a third axis: `sectionsOf` and `visibleOrder` were not edited.
    const rows = [
      row({ identifier: "STA-1", kind: "epic" }),
      row({ identifier: "STA-2", kind: "bug" }),
    ];
    const shape = buildList(rows, "kind", { isExpanded: () => true, showResolved: true });

    expect(shape.kind).toBe("grouped");
    expect(sectionsOf(shape).map((s) => s.key)).toEqual(["epic", "bug"]);
    expect(visibleOrder(shape, () => false).map((s) => s.ref)).toEqual(["STA-1", "STA-2"]);
    // A collapsed group's rows leave the sequence, exactly as on the other three axes.
    expect(visibleOrder(shape, (key) => key === "epic").map((s) => s.ref)).toEqual(["STA-2"]);
  });
});

describe("topLevelAncestors", () => {
  it("answers the ROOT, not the parent, at every depth", () => {
    const rows = [
      row({ identifier: "STA-1" }),
      row({ identifier: "STA-2", parentId: "id-1" }),
      row({ identifier: "STA-3", parentId: "id-2" }),
      row({ identifier: "STA-4", parentId: "id-3" }),
    ];

    const top = topLevelAncestors(rows);

    expect(top.get("id-4")).toBe("id-1");
    expect(top.get("id-3")).toBe("id-1");
    expect(top.get("id-2")).toBe("id-1");
    // A root has no ancestor. ABSENT, not itself — the caller's placement rule depends on
    // being able to tell "I am a root" from "my root is me".
    expect(top.has("id-1")).toBe(false);
  });

  it("stops at the highest ancestor the input contains", () => {
    // The epic is not in the list, so the mid-level task IS the top-level ancestor of what
    // is here. Which is why `buildParentGroups` passes the UNFILTERED source: hand it a
    // filtered list and this function will honestly answer a different question.
    const rows = [
      row({ identifier: "STA-2", parentId: "id-1" }),
      row({ identifier: "STA-3", parentId: "id-2" }),
    ];

    expect(topLevelAncestors(rows).get("id-3")).toBe("id-2");
  });

  it("terminates on a cycle the store should never produce", () => {
    // `forEachAncestor`'s `seen` guard, inherited. A hang here would take the render down
    // rather than draw a wrong row, which is the worse of the two failures.
    const rows = [
      row({ identifier: "STA-1", parentId: "id-2" }),
      row({ identifier: "STA-2", parentId: "id-1" }),
    ];

    expect(() => topLevelAncestors(rows)).not.toThrow();
  });
});
