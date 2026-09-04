/**
 * R3c (STA-173) — the Milestones view's pure model: plan order beats date, risk is read
 * off the server view, every state has its own glyph and word, members keep their
 * hierarchy, and a keyboard move is a plain reorder.
 */
import { describe, expect, it } from "vitest";
import { issue, row } from "@/components/task-list/fixtures";
import { listRow, member, progress, view } from "./fixtures";
import {
  layoutFor,
  memberListRows,
  milestoneRisk,
  movedOrder,
  nextWorkLabel,
  NOT_QUEUED_LABEL,
  progressLabel,
  riskLabels,
  sortMilestones,
  SPLIT_MIN_WIDTH_PX,
  STATE_PRESENTATION,
} from "./milestones-model";

describe("sortMilestones", () => {
  it("orders by plan position, then target date, then identifier; nulls last", () => {
    const rows = [
      listRow({ milestone: { identifier: "STA-5", planPosition: null, targetDate: null } }),
      listRow({ milestone: { identifier: "STA-4", planPosition: null, targetDate: "2026-12-01" } }),
      listRow({ milestone: { identifier: "STA-3", planPosition: 2, targetDate: "2026-01-01" } }),
      listRow({ milestone: { identifier: "STA-2", planPosition: 1, targetDate: "2026-12-31" } }),
      listRow({ milestone: { identifier: "STA-10", planPosition: null, targetDate: "2026-11-01" } }),
      listRow({ milestone: { identifier: "STA-9", planPosition: null, targetDate: "2026-11-01" } }),
    ];
    expect(sortMilestones(rows).map((r) => r.milestone.identifier)).toEqual([
      "STA-2", // plan #1 beats an earlier date
      "STA-3",
      "STA-9", // unplanned: by date, then numeric identifier
      "STA-10",
      "STA-4",
      "STA-5", // no plan, no date: last
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [listRow({ milestone: { identifier: "STA-2" } }), listRow({ milestone: { identifier: "STA-1" } })];
    sortMilestones(rows);
    expect(rows.map((r) => r.milestone.identifier)).toEqual(["STA-2", "STA-1"]);
  });
});

describe("state presentation", () => {
  it("gives every state a distinct glyph and a distinct word", () => {
    const glyphs = Object.values(STATE_PRESENTATION).map((p) => p.glyph);
    const labels = Object.values(STATE_PRESENTATION).map((p) => p.label);
    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(new Set(labels).size).toBe(labels.length);
    expect(STATE_PRESENTATION.overdue).toEqual({ glyph: "!", label: "Overdue" });
    expect(STATE_PRESENTATION.done.label).toBe("Done");
  });
});

describe("milestoneRisk", () => {
  it("reads overdue from the state and blocked/gated from the progress counts", () => {
    const risky = view({
      milestone: { state: "overdue" },
      progress: progress({ counts: { blocked: 2, gated: 1, done: 1 } }),
    });
    expect(milestoneRisk(risky)).toEqual({ overdue: true, blocked: 2, gated: 1 });
    expect(riskLabels(milestoneRisk(risky))).toEqual(["! overdue", "⊘ 2 blocked", "◇ 1 gated"]);
  });

  it("is silent when there is nothing to warn about", () => {
    const calm = view({ milestone: { state: "planned" }, progress: progress({ counts: { ready: 3 } }) });
    expect(milestoneRisk(calm)).toEqual({ overdue: false, blocked: 0, gated: 0 });
    expect(riskLabels(milestoneRisk(calm))).toEqual([]);
  });
});

describe("labels", () => {
  it("renders progress as done over countable with the percent", () => {
    expect(progressLabel(progress({ counts: { done: 5, ready: 6 } }))).toBe("5/11 done · 45%");
    expect(progressLabel(progress())).toBe("nothing to count yet");
  });

  it("renders the queue's answer, and says 'no eligible work' when the resolver has none", () => {
    expect(nextWorkLabel({ identifier: "STA-67", position: 4 })).toBe("next: STA-67 (#4)");
    expect(nextWorkLabel(null)).toBe(NOT_QUEUED_LABEL);
    expect(NOT_QUEUED_LABEL).toBe("no eligible work");
  });
});

describe("memberListRows", () => {
  const epic = issue({ id: "e1", identifier: "STA-66", kind: "epic", title: "S epic" });
  const child1 = issue({ id: "c1", identifier: "STA-67", parentId: "e1", title: "S1" });
  const child2 = issue({ id: "c2", identifier: "STA-68", parentId: "e1", title: "S2" });
  const grandchild = issue({ id: "g1", identifier: "STA-69", parentId: "c2", title: "S2a" });
  const loose = issue({ id: "l1", identifier: "STA-146", title: "flake" });
  const issues = [epic, child1, child2, grandchild, loose].map((i) => ({ ...row(), issue: i }));

  it("keeps member order and lists an epic member's own children indented, read-only", () => {
    const v = view({
      members: [
        member({ identifier: "STA-146", position: 1 }),
        member({ identifier: "STA-66", kind: "epic", position: 2 }),
      ],
    });
    const rows = memberListRows(v, issues, "staple");
    expect(rows.map((r) => [r.row.issue.identifier, r.role, r.row.depth])).toEqual([
      ["STA-146", "member", 0],
      ["STA-66", "member", 0],
      ["STA-67", "child", 1],
      ["STA-68", "child", 1],
      ["STA-69", "child", 2],
    ]);
    // Indent, never a fold: the shared row gets no chevron to draw.
    expect(rows.every((r) => !r.row.hasChildren)).toBe(true);
    expect(rows[1]!.memberIndex).toBe(1);
    expect(rows[2]!.memberIndex).toBe(-1);
    // Nothing was re-parented: the child still points at the epic.
    expect(rows[2]!.row.issue.parentId).toBe("e1");
  });

  it("indents a member nested under another member and does not draw it twice", () => {
    const v = view({
      members: [
        member({ identifier: "STA-68", position: 1, parent: "STA-66", nestedUnder: null }),
        member({ identifier: "STA-66", kind: "epic", position: 2 }),
        member({ identifier: "STA-67", position: 3, parent: "STA-66", nestedUnder: "STA-66" }),
      ],
    });
    const rows = memberListRows(v, issues, "staple");
    expect(rows.map((r) => [r.row.issue.identifier, r.role, r.row.depth])).toEqual([
      ["STA-68", "member", 0], // pulled forward: its own position, its own child under it
      ["STA-69", "child", 1],
      ["STA-66", "member", 0], // its children are both members, so nothing is drawn under it twice
      ["STA-67", "member", 1], // nests under STA-66, the member it descends from
    ]);
  });

  it("synthesises a row for a member the page's issue list does not carry", () => {
    const v = view({ members: [member({ identifier: "OTHER-1", kind: "bug", status: "in_progress", title: "elsewhere" })] });
    const rows = memberListRows(v, [], "hub-ws");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row.issue).toMatchObject({ identifier: "OTHER-1", kind: "bug", status: "in_progress", title: "elsewhere" });
    expect(rows[0]!.row.workspace).toBe("hub-ws");
  });
});

describe("movedOrder", () => {
  const members = [member({ identifier: "A" }), member({ identifier: "B" }), member({ identifier: "C" })];

  it("moves one identifier and keeps the rest in place", () => {
    expect(movedOrder(members, 0, 1)).toEqual(["B", "A", "C"]);
    expect(movedOrder(members, 2, 0)).toEqual(["C", "A", "B"]);
  });

  it("returns null at the edges and for a no-op, so nothing is written", () => {
    expect(movedOrder(members, 0, -1)).toBeNull();
    expect(movedOrder(members, 2, 3)).toBeNull();
    expect(movedOrder(members, 1, 1)).toBeNull();
  });
});

describe("layoutFor", () => {
  it("stacks below the md breakpoint and splits from it", () => {
    expect(layoutFor(SPLIT_MIN_WIDTH_PX - 1)).toBe("stacked");
    expect(layoutFor(SPLIT_MIN_WIDTH_PX)).toBe("split");
    expect(layoutFor(390)).toBe("stacked");
    expect(layoutFor(1440)).toBe("split");
  });
});
