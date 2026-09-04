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
  effectivePositionLabel,
  effectivePreview,
  ELIGIBILITY_PRESENTATION,
  layoutFor,
  movedOrder,
  nextEligible,
  nextWorkLabel,
  NOTHING_PICKABLE_LABEL,
  orderForPosition,
  pickupLabel,
  planRows,
  previewOf,
  reasonLabel,
  retryOrder,
  searchCandidates,
  SPLIT_MIN_WIDTH_PX,
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

describe("the two numbers", () => {
  it("says nothing about pickup when it agrees with the plan", () => {
    expect(pickupLabel(3, 3, 0)).toBeNull();
  });

  it("shows them side by side when they differ", () => {
    expect(pickupLabel(3, 5, 0)).toBe("pickup #5");
  });

  it("counts a container's expansion instead, because a container has no pickup row", () => {
    expect(pickupLabel(2, null, 3)).toBe("expands to 3");
    expect(pickupLabel(2, null, 0)).toBe("no pickup row");
  });

  it("reads an effective row from the other side: pickup first, provenance second", () => {
    expect(effectivePositionLabel(effective({ identifier: "A", position: 2, planPosition: 2 }))).toBe("#2");
    expect(effectivePositionLabel(effective({ identifier: "A", position: 3, planPosition: 2 }))).toBe(
      "#3 · from plan #2",
    );
    expect(effectivePositionLabel(effective({ identifier: "A", position: 9, unqueued: true }))).toBe("#9 · unqueued");
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
    expect(preview.planned.map((r) => r.identifier)).toEqual(["STA-31", "STA-67", "STA-68", "STA-70", "STA-146"]);
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

describe("search and add", () => {
  const issues = [
    row({ identifier: "STA-31", title: "characterize current product contracts" }),
    row({ identifier: "STA-66", title: "opt-in cloud continuity", kind: "epic" }),
    row({ identifier: "STA-146", title: "flaky under full-suite load" }),
    row({ identifier: "STA-190", title: "October cut", kind: "milestone" }),
  ];

  it("matches an identifier or a title, case-insensitively", () => {
    expect(searchCandidates(issues, "sta-146", []).map((r) => r.issue.identifier)).toEqual(["STA-146"]);
    expect(searchCandidates(issues, "FLAKY", []).map((r) => r.issue.identifier)).toEqual(["STA-146"]);
    expect(searchCandidates(issues, "", []).length).toBe(0);
  });

  it("offers epics and milestones, because both are legitimate plan rows", () => {
    expect(searchCandidates(issues, "c", []).map((r) => r.issue.kind)).toContain("epic");
    expect(searchCandidates(issues, "October", []).map((r) => r.issue.kind)).toEqual(["milestone"]);
  });

  it("never offers something already in the plan", () => {
    expect(searchCandidates(issues, "sta", ["STA-31", "STA-66"]).map((r) => r.issue.identifier)).toEqual([
      "STA-146",
      "STA-190",
    ]);
  });

  it("ranks an identifier match above a title match, then by the identifier's counter", () => {
    // "1" is in STA-31, STA-146 and STA-190 as an identifier, and in nothing as a title.
    expect(searchCandidates(issues, "1", []).map((r) => r.issue.identifier)).toEqual(["STA-31", "STA-146", "STA-190"]);
    expect(searchCandidates(issues, "cut", []).map((r) => r.issue.identifier)).toEqual(["STA-190"]);
  });

  it("stops at the limit", () => {
    expect(searchCandidates(issues, "sta", [], 2).length).toBe(2);
  });
});

describe("the layout", () => {
  it("stacks below the split breakpoint and splits at or above it", () => {
    expect(layoutFor(SPLIT_MIN_WIDTH_PX - 1)).toBe("stacked");
    expect(layoutFor(SPLIT_MIN_WIDTH_PX)).toBe("split");
    expect(layoutFor(1440)).toBe("split");
  });
});
