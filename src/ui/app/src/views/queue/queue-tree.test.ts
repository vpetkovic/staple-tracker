/**
 * The expansion, as a shape — `queue-tree.ts`.
 *
 * What is pinned here is the thing the redesign exists to produce: that a row expanded out
 * of a container is NESTED under it, at the depth the resolver's own ancestor fields imply,
 * with the guides that draw the rails. No DOM; `queue-render.test.tsx` renders the result.
 */
import { describe, expect, it } from "vitest";
import { row } from "@/components/task-list/fixtures";
import { effective } from "./fixtures";
import { knownRows, queueTreeRows } from "./queue-tree";

const known = knownRows([]);
const opts = { known, workspace: "staple" };

describe("nesting an expansion", () => {
  it("puts a container's direct leaves one level beneath it, in effective order", () => {
    const rows = queueTreeRows(
      [
        effective({ identifier: "STA-67", position: 2, via: "STA-66", epicPath: ["STA-66"] }),
        effective({ identifier: "STA-68", position: 3, via: "STA-66", epicPath: ["STA-66"] }),
      ],
      { ...opts, root: "STA-66" },
    );
    expect(rows.map((r) => r.row.issue.identifier)).toEqual(["STA-67", "STA-68"]);
    /*
     * DEPTH 1, not 0. The container is walked as the root it is and then dropped, because
     * the plan row above already draws it — so its children sit one level in and carry the
     * one guide that IS an elbow. `nesting.ts` guarantees `guides.length === depth`, and a
     * depth-0 row therefore cannot have a connector at all; drawing one there was the
     * divergence this arrangement removes.
     */
    expect(rows.map((r) => r.row.depth)).toEqual([1, 1]);
    expect(rows.every((r) => r.row.guides.length === r.row.depth)).toBe(true);
    expect(rows.every((r) => r.effective !== null)).toBe(true);
  });

  it("marks the LAST sibling, which is what turns its elbow into a terminal", () => {
    const rows = queueTreeRows(
      [
        effective({ identifier: "STA-67", position: 2, via: "STA-66", epicPath: ["STA-66"] }),
        effective({ identifier: "STA-68", position: 3, via: "STA-66", epicPath: ["STA-66"] }),
      ],
      { ...opts, root: "STA-66" },
    );
    expect(rows.map((r) => r.row.isLast)).toEqual([false, true]);
    // `guides[own]` is `!isLast`: a rail continues past the elbow only while siblings follow.
    expect(rows.map((r) => r.row.guides)).toEqual([[true], [false]]);
  });

  /**
   * THE CASE THE OLD FLAT LIST COULD NOT DRAW. Queue a milestone holding an epic and the
   * resolver emits the epic's LEAVES — the epic itself is in nobody's list. Flat, that is a
   * run of tasks with no visible parent.
   */
  it("SYNTHESISES the intermediate container the resolver never emits", () => {
    const rows = queueTreeRows(
      [
        effective({
          identifier: "STA-198",
          position: 1,
          via: "STA-190",
          milestonePath: ["STA-190"],
          epicPath: ["STA-197"],
        }),
        effective({
          identifier: "STA-199",
          position: 2,
          via: "STA-190",
          milestonePath: ["STA-190"],
          epicPath: ["STA-197"],
        }),
      ],
      { ...opts, root: "STA-190" },
    );
    expect(rows.map((r) => r.row.issue.identifier)).toEqual(["STA-197", "STA-198", "STA-199"]);
    expect(rows.map((r) => r.row.depth)).toEqual([1, 2, 2]);
    // The bracket is CONTEXT, not content: no effective row, and dimmed like the tree's ghost.
    expect(rows[0]!.effective).toBeNull();
    expect(rows[0]!.row.ghost).toBe(true);
    expect(rows[0]!.row.hasChildren).toBe(true);
    expect(rows[0]!.row.childCount).toBe(2);
    // …and the real rows are real.
    expect(rows[1]!.effective?.identifier).toBe("STA-198");
    expect(rows[1]!.row.ghost).toBe(false);
  });

  it("reads the milestone above the epics it holds, which is the resolver's own order", () => {
    const rows = queueTreeRows(
      [
        effective({
          identifier: "STA-9",
          position: 1,
          milestonePath: ["M-1"],
          epicPath: ["E-1"],
        }),
      ],
      { ...opts, root: null },
    );
    expect(rows.map((r) => r.row.issue.identifier)).toEqual(["M-1", "E-1", "STA-9"]);
    expect(rows.map((r) => r.row.depth)).toEqual([0, 1, 2]);
  });

  it("folds a synthesised container away without losing the rows' membership", () => {
    const expansion = [
      effective({
        identifier: "STA-198",
        position: 1,
        via: "STA-190",
        milestonePath: ["STA-190"],
        epicPath: ["STA-197"],
      }),
      effective({
        identifier: "STA-199",
        position: 2,
        via: "STA-190",
        milestonePath: ["STA-190"],
        epicPath: ["STA-197"],
      }),
    ];
    const rows = queueTreeRows(expansion, {
      ...opts,
      root: "STA-190",
      collapsed: new Set(["STA-197"]),
    });
    expect(rows.map((r) => r.row.issue.identifier)).toEqual(["STA-197"]);
    expect(rows[0]!.row.isExpanded).toBe(false);
    expect(rows[0]!.row.depth).toBe(1);
    // The fold hides rows from the DISPLAY and changes nothing about what is under there.
    expect(rows[0]!.row.childCount).toBe(2);
  });

  it("prefers the page's real row over a synthesised one, and synthesises only the rest", () => {
    const rows = queueTreeRows(
      [effective({ identifier: "STA-67", title: "wire title", position: 2, via: "STA-66" })],
      {
        known: knownRows([row({ identifier: "STA-67", title: "the page's title", kind: "spike" })]),
        workspace: "staple",
        root: "STA-66",
      },
    );
    // The real row wins: it carries a kind, a priority and a claim the wire never sent.
    expect(rows[0]!.row.issue.title).toBe("the page's title");
    expect(rows[0]!.row.issue.kind).toBe("spike");
  });

  it("draws a row the page has never fetched rather than dropping it", () => {
    const rows = queueTreeRows(
      [effective({ identifier: "WOR-9", title: "another workspace's leaf", position: 1, kind: "bug" })],
      { ...opts, root: null },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row.issue.title).toBe("another workspace's leaf");
    expect(rows[0]!.row.issue.kind).toBe("bug");
  });

  it("nests under `via` even when it is named in no path, which a queued task-parent is", () => {
    const rows = queueTreeRows(
      [effective({ identifier: "STA-2", position: 1, via: "STA-1" })],
      { ...opts, root: null },
    );
    expect(rows.map((r) => r.row.issue.identifier)).toEqual(["STA-1", "STA-2"]);
    expect(rows.map((r) => r.row.depth)).toEqual([0, 1]);
  });

  it("is empty for an empty expansion, rather than a bracket with nothing in it", () => {
    expect(queueTreeRows([], { ...opts, root: "STA-66" })).toEqual([]);
  });

  /**
   * `nesting.ts` owns the walk, and these are its two rules — asserted here because the
   * queue is a new caller of them and a first cut of this file broke both.
   */
  it("obeys the shared guide rule: one guide per ancestor level, none at the top", () => {
    const rows = queueTreeRows(
      [
        effective({ identifier: "STA-1", position: 1, unqueued: true }),
        effective({ identifier: "STA-2", position: 2, unqueued: true }),
      ],
      { ...opts, root: null },
    );
    // Top-level rows hang off nothing, so they draw no connector at all.
    expect(rows.map((r) => r.row.depth)).toEqual([0, 0]);
    expect(rows.map((r) => r.row.guides)).toEqual([[], []]);
  });

  it("counts what a fold hides in TASKS, seeing through the brackets", () => {
    const rows = queueTreeRows(
      [
        effective({ identifier: "STA-a", position: 1, via: "M", milestonePath: ["M"], epicPath: ["E"] }),
        effective({ identifier: "STA-b", position: 2, via: "M", milestonePath: ["M"], epicPath: ["E"] }),
        effective({ identifier: "STA-c", position: 3, via: "M", milestonePath: ["M"], epicPath: ["E"] }),
      ],
      { ...opts, root: "M" },
    );
    // One child — the bracket E — over three tasks. `+N` must say 3, not 1: a bracket is
    // not work, and `+1` standing for three tickets is the lie nesting.ts removed.
    expect(rows[0]!.row.issue.identifier).toBe("E");
    expect(rows[0]!.row.childCount).toBe(3);
  });
});
