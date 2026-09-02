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
import { buildGroups, GROUP_ORDER, guideX, indentPx, MAX_INDENT_DEPTH } from "./tree-model";
import { issue, row } from "./fixtures";

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
