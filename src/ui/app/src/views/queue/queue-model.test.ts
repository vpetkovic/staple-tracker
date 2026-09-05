/**
 * R2d (STA-169) — the Queue view's model: the join between the plan and the effective
 * order, the two position labels, the move arithmetic every reorder goes through, the
 * retry a conflict offers, and the add box's search. No DOM, no fetch; the markup is
 * `queue-render.test.tsx`.
 */
import { describe, expect, it } from "vitest";
import { row } from "@/components/task-list/fixtures";
import { effective, entry, queue, workedExample } from "./fixtures";
import {
  blockersOf,
  effectivePreview,
  ELIGIBILITY_PRESENTATION,
  movedOrder,
  nextEligible,
  nextWorkLabel,
  NOTHING_PICKABLE_LABEL,
  orderForPosition,
  planRows,
  previewOf,
  reasonLabel,
  retryOrder,
  rowOrdinal,
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

/**
 * ONE SCALE, replacing `pickupLabel` and `effectivePositionLabel`.
 *
 * Those two printed up to three numbers per row across two scales — `expands to 8`,
 * `pickup #10`, `#12 · from plan #4` — which is what made the old list unreadable. They are
 * gone rather than deprecated: a dead exported label that still spells the old vocabulary is
 * how the next surface reintroduces it.
 */
describe("the one number a row prints", () => {
  it("is the row's place in the order an agent is handed", () => {
    expect(rowOrdinal(effective({ identifier: "A", position: 2, planPosition: 2 }))).toBe(2);
    expect(rowOrdinal(effective({ identifier: "A", position: 3, planPosition: 2 }))).toBe(3);
  });

  it("is nothing for a container, which is never handed to anybody", () => {
    expect(rowOrdinal(null)).toBeNull();
  });

  it("is nothing in the unqueued band, whose section already says what those rows are", () => {
    expect(rowOrdinal(effective({ identifier: "A", position: 9, unqueued: true }))).toBeNull();
  });

  it("is nothing for finished work, which will never take its turn", () => {
    expect(
      rowOrdinal(effective({ identifier: "A", position: 4, planPosition: 1, eligibility: "resolved" })),
    ).toBeNull();
  });

  /*
   * A CONTAINER HAS NO ORDINAL AND NEEDS NO LABEL. An earlier cut gave it `step N`, which
   * put the plan scale and the effective scale in the same gutter column — the list then
   * read `step 1 / 10 / step 4 / 14`, which looks like a hole where there is none. The
   * gutter now holds ONE scale per indent level: a plan entry prints `entry.planPosition`
   * bare, a nested descendant prints its pickup number marked `#N`.
   */
  it("leaves a container's gutter to the plan position the entry already carries", () => {
    expect(rowOrdinal(effective({ identifier: "A", position: 1, planPosition: 1 }))).toBe(1);
  });
});

describe("what a row is waiting on", () => {
  it("is read off the store's own detail, local and cross-workspace alike", () => {
    expect(
      blockersOf(
        effective({
          identifier: "A",
          eligibility: "blocked",
          detail: { blockers: ["STA-35", "STA-67"], crossBlockers: ["WOR-9"] },
        }),
      ),
    ).toEqual(["STA-35", "STA-67", "WOR-9"]);
  });

  it("is empty rather than thrown when the payload carries nothing of the kind", () => {
    expect(blockersOf(null)).toEqual([]);
    expect(blockersOf(effective({ identifier: "A" }))).toEqual([]);
    expect(blockersOf(effective({ identifier: "A", detail: { blockers: "nonsense" } }))).toEqual([]);
  });
});

describe("why a row cannot be picked up", () => {
  it("is the store's own sentence, and nothing at all when the row is eligible", () => {
    expect(reasonLabel(effective({ identifier: "A" }))).toBeNull();
    expect(
      reasonLabel(effective({ identifier: "A", eligibility: "blocked", reason: "blocked by STA-35, STA-67" })),
    ).toBe("blocked by STA-35, STA-67");
    expect(reasonLabel(effective({ identifier: "A", eligibility: "claimed", reason: "held by codex-1" }))).toBe(
      "held by codex-1",
    );
  });

  it("falls back to the eligibility rather than to a blank", () => {
    expect(reasonLabel(effective({ identifier: "A", eligibility: "gated", reason: null }))).toBe("Gated");
  });

  it("has a distinct glyph AND word per eligibility, so colour is never the only signal", () => {
    const shown = Object.values(ELIGIBILITY_PRESENTATION);
    expect(new Set(shown.map((p) => p.glyph)).size).toBe(shown.length);
    expect(new Set(shown.map((p) => p.label)).size).toBe(shown.length);
    expect(ELIGIBILITY_PRESENTATION.blocked).toEqual({ glyph: "⊘", label: "Blocked" });
    expect(ELIGIBILITY_PRESENTATION.gated).toEqual({ glyph: "◇", label: "Gated" });
    expect(ELIGIBILITY_PRESENTATION.claimed).toEqual({ glyph: "◐", label: "Claimed" });
    expect(ELIGIBILITY_PRESENTATION.resolved).toEqual({ glyph: "✓", label: "Resolved" });
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

