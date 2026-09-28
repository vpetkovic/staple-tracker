/**
 * R3c (STA-173) — the Milestones view's pure model: plan order beats date, risk is read
 * off the server view, every state has its own glyph and word, members keep their
 * hierarchy, and a keyboard move is a plain reorder.
 */
import { describe, expect, it } from "vitest";
import { issue, row } from "@/components/task-list/fixtures";
import { effective } from "@/views/queue/fixtures";
import { listRow, member, progress, view } from "./fixtures";
import {
  hiddenMemberCount,
  layoutFor,
  memberListRows,
  visibleMilestones,
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
  /** October's rows plus one of somebody else's, which must never be counted here. */
  const queueRows = [
    effective({ identifier: "STA-1", milestonePath: ["STA-190"], eligibility: "blocked" }),
    effective({ identifier: "STA-2", milestonePath: ["STA-190"], eligibility: "blocked" }),
    effective({ identifier: "STA-3", milestonePath: ["STA-190"], eligibility: "gated" }),
    effective({ identifier: "STA-4", milestonePath: ["STA-190"], eligibility: "eligible" }),
    effective({ identifier: "STA-5", milestonePath: ["STA-190"], eligibility: "claimed" }),
    effective({ identifier: "STA-6", milestonePath: ["STA-190"], eligibility: "resolved" }),
    effective({ identifier: "STA-7", milestonePath: ["STA-191"], eligibility: "blocked" }),
    effective({ identifier: "STA-8", milestonePath: [], eligibility: "gated" }),
  ];

  it("files each waiting row under its own status category, so work in review is not drawn as blocked", () => {
    const rows = [
      effective({ identifier: "STA-1", milestonePath: ["STA-190"], eligibility: "blocked", status: "in_review" }),
      effective({ identifier: "STA-2", milestonePath: ["STA-190"], eligibility: "blocked", status: "in_review" }),
      effective({ identifier: "STA-3", milestonePath: ["STA-190"], eligibility: "gated", status: "todo" }),
      effective({ identifier: "STA-4", milestonePath: ["STA-190"], eligibility: "eligible", status: "todo" }),
    ];
    expect(milestoneRisk(view(), rows).waitingIn).toEqual({ review: 2, ready: 1 });
  });

  it("reads overdue from the state and blocked/gated from the queue's eligibility", () => {
    const risky = view({ milestone: { identifier: "STA-190", state: "overdue" } });
    // Every fixture row is `backlog`, so all three waiting rows sit in the not-started category.
    expect(milestoneRisk(risky, queueRows)).toMatchObject({ overdue: true, blocked: 2, gated: 1, waitingIn: { unstarted: 3 } });
    // Two wait on other tasks (blocked, not started); the gated one waits on a person's approval.
    expect(milestoneRisk(risky, queueRows).waiting).toEqual({ onTasksNotStarted: 2, onTasksStarted: {}, onPerson: 1 });
    expect(riskLabels(milestoneRisk(risky, queueRows))).toEqual(["! overdue", "⊘ 2 blocked", "◇ 1 gated"]);
  });

  /**
   * The counts staple actually keeps for blocked and gated are STATUS-category counts, and
   * staple moves no status for either — a blocker lives in the blocker table, a gate queues
   * descendants through `queuedBy`. So `progress.counts` must not be what risk reads, and
   * these two milestones with identical progress and opposite queues prove it is not.
   */
  it("ignores the status-category counts, which are zero for genuinely blocked work", () => {
    const counted = progress({ counts: { blocked: 9, gated: 9, ready: 3 } });
    const fromQueue = view({ milestone: { identifier: "STA-190", state: "active" }, progress: counted });
    expect(milestoneRisk(fromQueue, queueRows)).toMatchObject({ overdue: false, blocked: 2, gated: 1 });
    expect(milestoneRisk(fromQueue, [])).toMatchObject({ overdue: false, blocked: 0, gated: 0, waitingIn: {} });
  });

  it("is silent when there is nothing to warn about", () => {
    const calm = view({ milestone: { identifier: "STA-190", state: "planned" } });
    expect(milestoneRisk(calm, [effective({ identifier: "STA-4", milestonePath: ["STA-190"] })])).toMatchObject({
      overdue: false,
      blocked: 0,
      gated: 0,
      waitingIn: {},
    });
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

  it("keeps member order and lists an epic member's own children under it, read-only", () => {
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
    // The Tasks list's tree shape: a chevron on the epic and on the child that has one, the
    // guides the connector lines hang from, and the epic's rollup over its descendants.
    expect(rows.map((r) => [r.row.issue.identifier, r.row.hasChildren, r.row.guides, r.row.isLast])).toEqual([
      ["STA-146", false, [], false],
      ["STA-66", true, [], true],
      ["STA-67", false, [true], false],
      ["STA-68", true, [false], true],
      ["STA-69", false, [false, false], true],
    ]);
    // Leaves only, as every rollup counts: STA-67 and STA-69 (STA-68 is STA-69's parent).
    expect(rows[1]!.row.rollup).toMatchObject({ total: 2 });
    expect(rows[0]!.row.rollup).toBeNull();
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

  it("folds an epic's children away when the reader collapses it, as the Tasks list's chevron does", () => {
    const v = view({ members: [member({ identifier: "STA-66", kind: "epic" })] });
    const rows = memberListRows(v, issues, "staple", { collapsed: new Set(["STA-66"]) });
    expect(rows.map((r) => [r.row.issue.identifier, r.row.isExpanded, r.row.childCount])).toEqual([["STA-66", false, 2]]);
  });

  it("hides done and cancelled rows when the done gate says so, and lets their children take their place", () => {
    const done = { ...child2, status: "cancelled" as const };
    const withDone = [epic, child1, done, grandchild, loose].map((i) => ({ ...row(), issue: i }));
    const v = view({ members: [member({ identifier: "STA-66", kind: "epic" })] });
    const visible = (r: { issue: { status: string } }) => r.issue.status !== "cancelled" && r.issue.status !== "done";
    // Shown: all four, the cancelled one among them — what the list drew before the gate.
    expect(memberListRows(v, withDone, "staple").map((r) => r.row.issue.identifier)).toEqual(["STA-66", "STA-67", "STA-68", "STA-69"]);
    // Hidden: the cancelled child goes; its own open child moves up into its place.
    const hidden = memberListRows(v, withDone, "staple", { visible });
    expect(hidden.map((r) => [r.row.issue.identifier, r.row.depth])).toEqual([
      ["STA-66", 0],
      ["STA-67", 1],
      ["STA-69", 1],
    ]);
  });

  it("gives a row lifted out of a hidden parent that parent's chip, and the hidden member's controls", () => {
    const doneEpic = { ...epic, status: "done" as const };
    const rows = [doneEpic, child1, { ...child2, status: "done" as const }, grandchild].map((i) => ({ ...row(), issue: i }));
    const v = view({ members: [member({ identifier: "STA-66", kind: "epic" })] });
    const visible = (r: { issue: { status: string } }) => r.issue.status !== "done" && r.issue.status !== "cancelled";
    const out = memberListRows(v, rows, "staple", { visible });
    // STA-66 (done) and STA-68 (done) hidden: their open work takes their place.
    expect(out.map((r) => [r.row.issue.identifier, r.row.breadcrumb?.identifier ?? null])).toEqual([
      ["STA-67", "STA-66"],
      ["STA-69", "STA-68"],
    ]);
    // The first row lifted out of the hidden MEMBER carries its move and remove; the next does not.
    expect(out[0]!.standsFor).toMatchObject({ member: { identifier: "STA-66" }, memberIndex: 0 });
    expect(out[1]!.standsFor).toBeNull();
    expect(hiddenMemberCount(v, rows, "staple", visible)).toBe(2);
    expect(hiddenMemberCount(v, rows, "staple", () => true)).toBe(0);
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
    // A tablet stacks too: beside the navigation rail a split would leave the detail ~280px.
    expect(layoutFor(768)).toBe("stacked");
    expect(layoutFor(1024)).toBe("split");
    expect(layoutFor(1440)).toBe("split");
  });
});

describe("visibleMilestones", () => {
  const open = listRow({ milestone: { identifier: "STA-1", state: "active" } });
  const done = listRow({ milestone: { identifier: "STA-2", state: "done" } });
  it("keeps the milestone the page is pointed at listed, finished or not", () => {
    expect(visibleMilestones([open, done], false).rows.map((r) => r.milestone.identifier)).toEqual(["STA-1"]);
    expect(visibleMilestones([open, done], false, [null, "STA-2"])).toMatchObject({ rows: [open, done], hiddenFinished: 0 });
  });
});
