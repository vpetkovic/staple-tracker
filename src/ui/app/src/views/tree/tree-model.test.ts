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
import { describe, expect, it } from "vitest";
import { OPEN_STATUS_ORDER, RESOLVED_STATUSES } from "@/lib/types";
import { guideX, indentPx, MAX_INDENT_DEPTH } from "@/components/task-list";
import { issue, row } from "@/components/task-list/fixtures";
import { buildGroups, buildList, flattenFlat, GROUP_ORDER, visibleOrder, visibleRows } from "./tree-model";

/** Everything expanded — the default for the groups these tests mostly use. */
const openAll = { isExpanded: () => true };
const closedAll = { isExpanded: () => false };

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

    expect(byStatus.in_progress?.rows.map((r) => r.issue.id)).toEqual(["c"]);
    expect(byStatus.backlog?.rows.map((r) => r.issue.id)).toEqual(["p"]);
  });

  it("renders a cross-group child at depth 0 with a parent breadcrumb, not nested", () => {
    const parent = row({ id: "p", identifier: "STA-1", title: "The epic", status: "backlog" });
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });

    const groups = buildGroups([parent, child], openAll);
    const inProgress = groups.find((g) => g.status === "in_progress")!;

    expect(inProgress.rows[0]?.depth).toBe(0);
    expect(inProgress.rows[0]?.breadcrumb).toEqual({ identifier: "STA-1", title: "The epic" });
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

  it("takes a breadcrumb from V4's hiddenParents when the parent was FILTERED away", () => {
    // The done-epic case: `applyFilters` removed the parent under the hide-resolved
    // default, so it is not in `rows` at all — but it is on the board and worth naming.
    const child = row({ id: "c", identifier: "STA-2", status: "in_progress", parentId: "p" });
    const parent = issue({ id: "p", identifier: "STA-1", title: "Shipped epic", status: "done" });

    const groups = buildGroups([child], { ...openAll, hiddenParents: new Map([["c", parent]]) });

    expect(groups[0]!.rows[0]?.breadcrumb).toEqual({ identifier: "STA-1", title: "Shipped epic" });
  });

  it("keeps a row whose parent is absent from the data entirely, with no breadcrumb", () => {
    // The parent was filtered out upstream (assignee filter, or resolved-away). Dropping
    // the child would hide live work, which is the one thing a tracker must never do.
    const orphan = row({ id: "c", identifier: "STA-2", status: "todo", parentId: "gone" });

    const todo = buildGroups([orphan], openAll).find((g) => g.status === "todo")!;

    expect(todo.rows.map((r) => r.issue.id)).toEqual(["c"]);
    expect(todo.rows[0]?.depth).toBe(0);
    expect(todo.rows[0]?.breadcrumb).toBeNull();
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

    // Grouped: two groups, the child at depth 0 wearing a breadcrumb instead of an indent.
    const grouped = buildGroups(rows, openAllFlat);
    expect(grouped).toHaveLength(2);
    expect(grouped.flatMap((g) => g.rows).every((r) => r.depth === 0)).toBe(true);

    // Flat: one list, the child indented under its parent and needing no breadcrumb,
    // because the parent it would point at is the row directly above it.
    const flat = flattenFlat(rows, openAllFlat);
    expect(flat.map((r) => r.issue.identifier)).toEqual(["STA-1", "STA-2"]);
    expect(flat[1]!.depth).toBe(1);
    expect(flat[1]!.breadcrumb).toBeNull();
    expect(flat[0]!.hasChildren).toBe(true);
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
    expect(grouped.kind === "grouped" && grouped.groups.flatMap((g) => g.rows).map((r) => r.depth)).toEqual([0, 0]);
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
    // The live child is not hidden here; it is a ROOT of its own group with a breadcrumb,
    // which is exactly why the grouped default was correct and the flat one could not be.
    const groups = buildGroups(backlogEpicWithLiveChild(), untouched);
    const backlog = groups.find((g) => g.status === "backlog")!;
    const progress = groups.find((g) => g.status === "in_progress")!;

    expect(backlog.rows[0]!.isExpanded).toBe(false);
    expect(backlog.rows.map((r) => r.issue.identifier)).toEqual(["STA-1"]);
    expect(progress.rows.map((r) => r.issue.identifier)).toEqual(["STA-2"]);
    expect(progress.rows[0]!.breadcrumb?.identifier).toBe("STA-1");
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
