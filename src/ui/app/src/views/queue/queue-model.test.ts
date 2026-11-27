/**
 * R2d (STA-169) — the Queue view's model: the join between the plan and the effective
 * order, the move arithmetic every reorder goes through, the retry a conflict offers, and
 * the add box's search. No DOM, no fetch; the markup is `queue-render.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { row } from "@/components/task-list/fixtures";
import { effective, entry, queue, workedExample } from "./fixtures";
import {
  blockersOf,
  effectivePreview,
  movedOrder,
  nextEligible,
  nextWorkLabel,
  NOTHING_PICKABLE_LABEL,
  orderForPosition,
  planRows,
  previewOf,
  retryOrder,
  skippedBefore,
} from "./queue-model";

describe("the plan joined to its expansion", () => {
  const view = workedExample();

  it("keeps plan order and gives each entry the effective rows it accounts for", () => {
    const rows = planRows(view, [], "staple");
    expect(rows.map((r) => r.entry.identifier)).toEqual(["STA-31", "STA-66", "STA-146"]);
    // A leaf carries its OWN effective row and expands to nothing.
    expect(rows[0]!.effective?.position).toBe(1);
    expect(rows[0]!.expansion).toEqual([]);
    // A container has no effective row of its own and carries what it expanded to.
    expect(rows[1]!.effective).toBeNull();
    expect(rows[1]!.expansion.map((r) => r.identifier)).toEqual(["STA-67", "STA-68", "STA-70"]);
    expect(rows[2]!.effective?.position).toBe(5);
  });

  it("uses the page's issue row when it has one and synthesises one when it does not", () => {
    const known = row({ identifier: "STA-146", title: "the real title", status: "in_progress" });
    const rows = planRows(view, [known], "staple");
    expect(rows[2]!.row.issue.title).toBe("the real title");
    expect(rows[2]!.row.issue.status).toBe("in_progress");
    // STA-31 is not in the page's list; everything the row needs is on the entry.
    expect(rows[0]!.row.issue.identifier).toBe("STA-31");
    expect(rows[0]!.row.issue.status).toBe("done");
    expect(rows[0]!.row.workspace).toBe("staple");
    expect(rows[0]!.row.depth).toBe(0);
  });

  it("takes the FIRST occurrence when the resolver emitted an identifier twice", () => {
    const view = queue({
      entries: [entry({ identifier: "STA-67", planPosition: 1 })],
      effective: [
        effective({ identifier: "STA-67", position: 1, planPosition: 1 }),
        effective({ identifier: "STA-67", position: 9, planPosition: null, unqueued: true }),
      ],
    });
    expect(planRows(view, [], "staple")[0]!.effective?.position).toBe(1);
  });
});

describe("what a row is waiting on", () => {
  it("is read off the store's own detail, local and cross-workspace alike", () => {
    expect(
      blockersOf(
        effective({
          identifier: "A",
          eligibility: "blocked",
          // The shape the store writes (`queue-store.ts`): identifiers locally, objects across workspaces.
          detail: {
            blockers: ["STA-35", "STA-67"],
            crossBlockers: [{ identifier: "WOR-9", workspace: "worker", unresolvable: false }],
          },
        }),
      ),
    ).toEqual(["STA-35", "STA-67", "WOR-9"]);
  });

  it("is empty rather than thrown when the payload carries nothing of the kind", () => {
    expect(blockersOf(null)).toEqual([]);
    expect(blockersOf(effective({ identifier: "A" }))).toEqual([]);
    expect(blockersOf(effective({ identifier: "A", detail: { blockers: "nonsense" } }))).toEqual([]);
    expect(blockersOf(effective({ identifier: "A", detail: { crossBlockers: [null, 7, { workspace: "w" }] } }))).toEqual([]);
  });
});

describe("the preview", () => {
  it("splits the plan band from the unqueued band and names the next pickup", () => {
    const view = workedExample();
    const preview = effectivePreview(view);
    expect(preview.unqueued).toEqual([]);
    // STA-31 is resolved and STA-68/STA-70 are blocked, so the first eligible row is STA-67.
    expect(preview.next?.identifier).toBe("STA-67");
    expect(nextWorkLabel(preview.next)).toBe("next: STA-67 (#2)");
  });

  it("caps the unqueued band and counts what it did not show", () => {
    const view = queue({
      effective: Array.from({ length: 7 }, (_, i) =>
        effective({ identifier: `STA-${100 + i}`, position: i + 1, unqueued: true }),
      ),
    });
    const preview = effectivePreview(view, 3);
    expect(preview.unqueued.map((r) => r.identifier)).toEqual(["STA-100", "STA-101", "STA-102"]);
    expect(preview.unqueuedHidden).toBe(4);
  });

  it("is honest when the whole order is waiting on something", () => {
    const view = queue({
      effective: [effective({ identifier: "STA-1", eligibility: "blocked", reason: "blocked by STA-2" })],
    });
    expect(nextEligible(view.effective)).toBeNull();
    expect(nextWorkLabel(null)).toBe(NOTHING_PICKABLE_LABEL);
  });

  it("previewOf never over-counts an under-full list", () => {
    expect(previewOf([1, 2], 5)).toEqual({ shown: [1, 2], hidden: 0 });
  });
});

describe("the move arithmetic every reorder goes through", () => {
  const entries = ["A", "B", "C", "D"].map((id, i) => entry({ identifier: id, planPosition: i + 1 }));

  it("moves one entry and leaves the rest in order", () => {
    expect(movedOrder(entries, 3, 0)).toEqual(["D", "A", "B", "C"]);
    expect(movedOrder(entries, 0, 2)).toEqual(["B", "C", "A", "D"]);
  });

  it("refuses a move that would change nothing, so it never becomes a write", () => {
    expect(movedOrder(entries, 1, 1)).toBeNull();
    expect(movedOrder(entries, 0, -1)).toBeNull();
    expect(movedOrder(entries, 3, 4)).toBeNull();
    expect(movedOrder([], 0, 0)).toBeNull();
  });

  it("reads a typed position as 1-based", () => {
    expect(orderForPosition(entries, 0, 3)).toEqual(["B", "C", "A", "D"]);
    expect(orderForPosition(entries, 2, 1)).toEqual(["C", "A", "B", "D"]);
  });

  it("clamps an out-of-range position instead of arguing with it", () => {
    expect(orderForPosition(entries, 0, 99)).toEqual(["B", "C", "D", "A"]);
    expect(orderForPosition(entries, 3, 0)).toEqual(["D", "A", "B", "C"]);
    expect(orderForPosition(entries, -1, 2)).toBeNull();
    expect(orderForPosition(entries, 0, Number.NaN)).toBeNull();
  });

  it("makes Home and End the same call as a typed 1 or a typed length", () => {
    expect(orderForPosition(entries, 2, 1)).toEqual(movedOrder(entries, 2, 0));
    expect(orderForPosition(entries, 1, entries.length)).toEqual(movedOrder(entries, 1, 3));
  });
});

describe("the retry a conflict offers", () => {
  it("re-applies the intent and keeps what the other writer added", () => {
    const current = ["A", "B", "C", "NEW"].map((id, i) => entry({ identifier: id, planPosition: i + 1 }));
    expect(retryOrder(["C", "A", "B"], current)).toEqual(["C", "A", "B", "NEW"]);
  });

  it("drops what the other writer removed rather than resurrecting it", () => {
    const current = ["A", "C"].map((id, i) => entry({ identifier: id, planPosition: i + 1 }));
    expect(retryOrder(["C", "A", "B"], current)).toEqual(["C", "A"]);
  });

  it("is null when the intent is already the server's order, so a retry is never a no-op write", () => {
    const current = ["A", "B"].map((id, i) => entry({ identifier: id, planPosition: i + 1 }));
    expect(retryOrder(["A", "B"], current)).toBeNull();
    expect(retryOrder(["A", "B", "GONE"], current)).toBeNull();
  });
});

describe("what the next pick stepped over", () => {
  it("is every row ahead of the pick, in effective order, as queue next answers skipped", () => {
    const view = workedExample();
    const next = nextEligible(view.effective);
    // STA-31 is resolved: queue next lists it as skipped too, so the view can say so.
    expect(skippedBefore(view.effective, next).map((r) => [r.identifier, r.eligibility])).toEqual([["STA-31", "resolved"]]);
  });

  it("is the whole order when nothing is pickable, and nothing when the first row is the pick", () => {
    const blocked = effective({ identifier: "STA-1", eligibility: "blocked" });
    const gated = effective({ identifier: "STA-2", eligibility: "gated", position: 2 });
    expect(skippedBefore([blocked, gated], null)).toEqual([blocked, gated]);
    const first = effective({ identifier: "STA-3" });
    expect(skippedBefore([first, blocked], first)).toEqual([]);
  });
});
