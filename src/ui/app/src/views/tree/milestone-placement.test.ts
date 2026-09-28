import { describe, expect, it } from "vitest";
import { row } from "@/components/task-list/fixtures";
import type { IssueRow } from "@/lib/types";
import { placeUnderMilestones } from "./milestone-placement";
import { buildList, flattenFlat } from "./tree-model";

const openAll = { isExpanded: () => true, showResolved: true };

function member(over: Parameters<typeof row>[0], milestoneId: string | null): IssueRow {
  return { ...row(over), milestoneId };
}

const milestone = () => row({ id: "m", identifier: "STA-10", kind: "milestone", title: "Plan" });

describe("placeUnderMilestones", () => {
  it("nests a parentless member epic, and its children, under the milestone", () => {
    const rows = [
      milestone(),
      member({ id: "e", identifier: "STA-11", kind: "epic" }, "m"),
      row({ id: "t", identifier: "STA-12", parentId: "e" }),
    ];

    const flat = flattenFlat(placeUnderMilestones(rows), openAll);

    expect(flat.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-10", 0],
      ["STA-11", 1],
      ["STA-12", 2],
    ]);
    expect(flat[0]!.hasChildren).toBe(true);
  });

  it("keeps a member that has a real parent under that parent", () => {
    const rows = [
      milestone(),
      row({ id: "e", identifier: "STA-11", kind: "epic" }),
      member({ id: "t", identifier: "STA-12", parentId: "e" }, "m"),
    ];

    const placed = placeUnderMilestones(rows);

    expect(placed.find((r) => r.issue.id === "t")!.issue.parentId).toBe("e");
    expect(placed.find((r) => r.issue.id === "e")!.issue.parentId).toBeNull();
  });

  it("leaves rows alone when their milestone is not on the page or is in another workspace", () => {
    const elsewhere = { ...milestone(), workspace: "other" };
    const rows = [elsewhere, member({ id: "e", identifier: "STA-11", kind: "epic" }, "m")];

    expect(placeUnderMilestones(rows).find((r) => r.issue.id === "e")!.issue.parentId).toBeNull();
  });

  it("does not touch the served issue", () => {
    const epic = member({ id: "e", identifier: "STA-11", kind: "epic" }, "m");
    placeUnderMilestones([milestone(), epic]);
    expect(epic.issue.parentId).toBeNull();
  });

  it("drops the milestone cue a nested row would repeat, and keeps any other", () => {
    const cue = (identifier: string) => ({ pickup: null, milestone: { identifier, title: null } });
    const rows: IssueRow[] = [
      milestone(),
      { ...member({ id: "e", identifier: "STA-11", kind: "epic" }, "m"), cues: cue("STA-10") },
      { ...row({ id: "t", identifier: "STA-12", parentId: "e" }), cues: cue("STA-10") },
      { ...row({ id: "x", identifier: "STA-13" }), cues: cue("STA-99") },
    ];

    const cues = placeUnderMilestones(rows).map((r) => r.cues?.milestone?.identifier ?? null);

    expect(cues).toEqual([null, null, null, "STA-99"]);
  });

  it("opens a milestone by default in the flat list, while its backlog epic still folds", () => {
    const rows = [
      milestone(),
      member({ id: "e", identifier: "STA-11", kind: "epic", status: "backlog" }, "m"),
      row({ id: "t", identifier: "STA-12", parentId: "e", status: "backlog" }),
    ];

    const flat = flattenFlat(placeUnderMilestones(rows), { isExpanded: () => undefined });

    expect(flat.map((r) => [r.issue.identifier, r.isExpanded])).toEqual([
      ["STA-10", true],
      ["STA-11", false],
    ]);
  });

  it("draws the milestone as context in every grouping, and never loses a member", () => {
    const rows = placeUnderMilestones([
      milestone(),
      member({ id: "e", identifier: "STA-11", kind: "epic", status: "in_progress" }, "m"),
      row({ id: "t", identifier: "STA-12", parentId: "e", status: "todo" }),
    ]);
    for (const groupBy of ["none", "status", "parent", "kind"] as const) {
      const shape = buildList(rows, groupBy, openAll);
      if (shape.kind === "pickup") throw new Error("not a pickup grouping");
      const lines = shape.kind === "grouped" ? shape.groups.flatMap((group) => group.rows) : shape.rows;
      const real = lines.filter((line) => !line.ghost).map((line) => line.issue.identifier).sort();
      expect(real, groupBy).toEqual(["STA-10", "STA-11", "STA-12"]);
    }
  });

  it("never closes a cycle when the milestone is filed under the epic it contains", () => {
    const rows = [
      row({ id: "m", identifier: "STA-10", kind: "milestone", parentId: "e" }),
      member({ id: "e", identifier: "STA-11", kind: "epic" }, "m"),
    ];

    const flat = flattenFlat(placeUnderMilestones(rows), openAll);

    expect(flat.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-11", 0],
      ["STA-10", 1],
    ]);
  });
});
