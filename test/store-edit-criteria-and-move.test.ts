import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

/**
 * Editing a ticket after it exists, instead of cancelling and recreating it: its acceptance
 * criteria (replaced, added to, removed from) and its parent (another one, or none). Both through
 * `updateIssueResult`, the store method under MCP `update_task` and the CLI verbs
 * `staple criteria` and `staple move`. Real store, real migrations.
 */

let store: WorkspaceStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
});

function refused(fn: () => unknown, code: string): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function events(kind: string, issueId?: string): Array<{ actor: string | null; payload: Record<string, unknown> }> {
  const rows = store.db
    .prepare(`SELECT actor, payload FROM events WHERE kind = ? ${issueId ? "AND issue_id = ?" : ""} ORDER BY seq`)
    .all(...([kind, ...(issueId ? [issueId] : [])] as never[])) as Array<{ actor: string | null; payload: string }>;
  return rows.map((row) => ({ actor: row.actor, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}

const criteria = (ref: string) => store.getIssue(ref).acceptanceCriteria;
const depth = (ref: string) => store.getIssue(ref).depth;
const status = (ref: string) => store.getIssue(ref).status;
const blockersOf = (id: string) =>
  (store.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ? AND type = 'blocks' ORDER BY blocker_id").all(id) as Array<{ blocker_id: string }>).map(
    (row) => row.blocker_id,
  );

describe("editing a ticket's acceptance criteria", () => {
  it("replaces, adds and removes, and records each change as an event naming who made it", () => {
    const t = store.createIssue({ title: "Scope moved", acceptanceCriteria: ["a", "b", "c"] });

    let result = store.updateIssueResult(t.id, { addCriteria: ["d"] }, "alice");
    expect(result.issue.acceptanceCriteria).toEqual(["a", "b", "c", "d"]);
    expect(result.criteriaChange).toMatchObject({ from: ["a", "b", "c"], to: ["a", "b", "c", "d"], changed: true });

    result = store.updateIssueResult(t.id, { removeCriteria: [3, 1] }, "bob");
    expect(result.issue.acceptanceCriteria).toEqual(["b", "d"]);

    // Removals name the list as it stood; additions land after them, in the same write.
    result = store.updateIssueResult(t.id, { removeCriteria: [2], addCriteria: [" e ", "f"] }, "carol");
    expect(criteria(t.id)).toEqual(["b", "e", "f"]);

    store.updateIssue(t.id, { acceptanceCriteria: ["x", " ", "y "] }, "dave");
    expect(criteria(t.id)).toEqual(["x", "y"]);

    expect(events("criteria_changed", t.id)).toEqual([
      { actor: "alice", payload: expect.objectContaining({ identifier: t.identifier, from: ["a", "b", "c"], to: ["a", "b", "c", "d"] }) },
      { actor: "bob", payload: expect.objectContaining({ from: ["a", "b", "c", "d"], to: ["b", "d"] }) },
      { actor: "carol", payload: expect.objectContaining({ from: ["b", "d"], to: ["b", "e", "f"] }) },
      { actor: "dave", payload: expect.objectContaining({ from: ["b", "e", "f"], to: ["x", "y"] }) },
    ]);
  });

  it("adds criteria to a ticket created without any, and clears them with an empty list", () => {
    const t = store.createIssue({ title: "Bare" });
    expect(store.updateIssueResult(t.id, { addCriteria: ["first"] }, "vp").issue.acceptanceCriteria).toEqual(["first"]);
    expect(store.updateIssueResult(t.id, { acceptanceCriteria: [] }, "vp").issue.acceptanceCriteria ?? []).toEqual([]);
  });

  it("writes nothing for a change that changes nothing", () => {
    const t = store.createIssue({ title: "Same", acceptanceCriteria: ["a"] });
    const before = store.getIssue(t.id).updatedAt;
    const result = store.updateIssueResult(t.id, { acceptanceCriteria: ["a"] }, "vp");
    expect(result.criteriaChange).toMatchObject({ changed: false });
    expect(events("criteria_changed", t.id)).toEqual([]);
    expect(result.issue.acceptanceCriteria).toEqual(["a"]);
    expect(before).toBeTruthy();
  });

  it("refuses a position that is not there, a blank criterion, and a replace mixed with an add or remove", () => {
    const t = store.createIssue({ title: "Guarded", acceptanceCriteria: ["a", "b"] });
    expect(refused(() => store.updateIssue(t.id, { removeCriteria: [3] }, "vp"), "validation").message).toContain("criteria 1 to 2");
    expect(refused(() => store.updateIssue(t.id, { removeCriteria: [0] }, "vp"), "validation").message).toContain("criteria 1 to 2");
    expect(refused(() => store.updateIssue(t.id, { removeCriteria: [1, 1] }, "vp"), "validation").message).toContain("twice");
    expect(refused(() => store.updateIssue(t.id, { addCriteria: ["  "] }, "vp"), "validation").message).toContain("empty");
    expect(refused(() => store.updateIssue(t.id, { acceptanceCriteria: ["z"], addCriteria: ["y"] }, "vp"), "validation").message).toContain("replace");
    expect(criteria(t.id)).toEqual(["a", "b"]);
    expect(events("criteria_changed", t.id)).toEqual([]);
  });

  describe("a criterion that carries a mark", () => {
    let m: string;
    beforeEach(() => {
      store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
      const created = store.milestones().create({ title: "October", acceptanceCriteria: ["A", "B", "C"] }, "vp");
      if (created.preview) throw new Error("unreachable");
      m = created.milestone.identifier;
      store.milestones().markCriterion(m, 2, { verdict: "met", evidence: ["the README"] }, "judge");
      store.milestones().markCriterion(m, 3, { verdict: "unmet" }, "judge");
    });
    const verdicts = () => store.milestones().get(m).goal.criteria.map((c) => [c.text, c.verdict, c.why === null ? null : c.why.split(" ")[0]]);

    it("keeps its mark when another criterion is removed or added before it", () => {
      const result = store.updateIssueResult(m, { removeCriteria: [1] }, "vp");
      expect(verdicts()).toEqual([
        ["B", "met", null],
        ["C", "unmet", null],
      ]);
      expect(result.criteriaChange?.marks).toEqual({
        kept: [
          { criterion: "B", verdict: "met", from: 2, to: 1 },
          { criterion: "C", verdict: "unmet", from: 3, to: 2 },
        ],
        reworded: [],
        cleared: [],
      });
      store.updateIssue(m, { acceptanceCriteria: ["Z", "B", "C"] }, "vp");
      expect(verdicts()).toEqual([
        ["Z", "unknown", "not"],
        ["B", "met", null],
        ["C", "unmet", null],
      ]);
    });

    it("says when a change clears a mark, and when a reworded criterion's mark no longer stands", () => {
      // C reworded in place: the mark stays on record and reads unknown, as a reword always has.
      let result = store.updateIssueResult(m, { acceptanceCriteria: ["A", "B", "C, reworded"] }, "vp");
      expect(result.criteriaChange?.marks).toEqual({
        kept: [{ criterion: "B", verdict: "met", from: 2, to: 2 }],
        reworded: [{ criterion: "C", verdict: "unmet", position: 3, now: "C, reworded" }],
        cleared: [],
      });
      expect(verdicts()[2]).toEqual(["C, reworded", "unknown", "the"]);

      // B removed: its mark goes, and the change says so.
      result = store.updateIssueResult(m, { removeCriteria: [2] }, "eve");
      expect(result.criteriaChange?.marks.cleared).toEqual([
        { criterion: "B", verdict: "met", position: 2 },
        { criterion: "C", verdict: "unmet", position: 3 },
      ]);
      expect(verdicts()).toEqual([
        ["A", "unknown", "not"],
        ["C, reworded", "unknown", "not"],
      ]);
      expect(store.db.prepare("SELECT COUNT(*) AS n FROM milestone_criterion_marks").get()).toEqual({ n: 0 });
      expect(events("criteria_changed").at(-1)).toEqual({
        actor: "eve",
        payload: expect.objectContaining({ marks: expect.objectContaining({ cleared: result.criteriaChange?.marks.cleared }) }),
      });
    });

    it("milestone set --criteria keeps marks the same way", () => {
      store.milestones().update(m, { acceptanceCriteria: ["C", "B"] }, "vp");
      expect(verdicts()).toEqual([
        ["C", "unmet", null],
        ["B", "met", null],
      ]);
    });
  });
});

describe("moving a ticket to another parent", () => {
  it("moves it with its subtree, recomputes depth, and records the move as an event naming who made it", () => {
    const old = store.createIssue({ title: "Old epic", kind: "epic" });
    const next = store.createIssue({ title: "New epic", kind: "epic" });
    const top = store.createIssue({ title: "Top" });
    const next2 = store.createIssue({ title: "Nested epic", parent: top.id, kind: "epic" });
    const child = store.createIssue({ title: "Child", parent: old.id });
    const grand = store.createIssue({ title: "Grandchild", parent: child.id });

    const result = store.updateIssueResult(child.id, { parent: next.identifier }, "alice");
    expect(result.issue.parentId).toBe(next.id);
    expect(result.parentChange).toEqual({ from: old.identifier, to: next.identifier, changed: true });
    expect([depth(child.id), depth(grand.id)]).toEqual([1, 2]);

    store.updateIssue(child.id, { parent: next2.id }, "bob");
    expect([depth(child.id), depth(grand.id)]).toEqual([2, 3]);

    store.updateIssue(child.id, { parent: null }, "carol");
    expect(store.getIssue(child.id).parentId).toBeNull();
    expect([depth(child.id), depth(grand.id)]).toEqual([0, 1]);

    expect(events("parent_changed", child.id)).toEqual([
      { actor: "alice", payload: { identifier: child.identifier, from: old.identifier, to: next.identifier } },
      { actor: "bob", payload: { identifier: child.identifier, from: next.identifier, to: next2.identifier } },
      { actor: "carol", payload: { identifier: child.identifier, from: next2.identifier, to: null } },
    ]);
    // Same parent: nothing moves and nothing is recorded.
    expect(store.updateIssueResult(child.id, { parent: null }, "dave").parentChange).toEqual({ from: null, to: null, changed: false });
    expect(events("parent_changed", child.id)).toHaveLength(3);
  });

  it("refuses a cycle: the ticket itself, or anything beneath it", () => {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    const child = store.createIssue({ title: "Child", parent: epic.id });
    const grand = store.createIssue({ title: "Grandchild", parent: child.id });
    expect(refused(() => store.updateIssue(epic.id, { parent: epic.id }, "vp"), "cycle").message).toContain("its own parent");
    expect(refused(() => store.updateIssue(epic.id, { parent: grand.id }, "vp"), "cycle").message).toContain(`${grand.identifier} sits under ${epic.identifier}`);
    expect(store.getIssue(epic.id).parentId).toBeNull();
  });

  it("refuses a move that would take the subtree past the depth cap", () => {
    let parent = store.createIssue({ title: "Level 0" });
    for (let level = 1; level <= 99; level += 1) parent = store.createIssue({ title: `Level ${level}`, parent: parent.id });
    const deepest = parent;
    const loose = store.createIssue({ title: "Loose" });
    store.createIssue({ title: "Loose child", parent: loose.id });
    expect(refused(() => store.updateIssue(loose.id, { parent: deepest.id }, "vp"), "validation").message).toContain("depth cap");
  });

  it("moves a block-parent-until-done edge with the child", () => {
    const old = store.createIssue({ title: "Old epic", kind: "epic" });
    const next = store.createIssue({ title: "New epic", kind: "epic" });
    const child = store.createIssue({ title: "Blocks its parent", parent: old.id, blockParentUntilDone: true });
    expect(blockersOf(old.id)).toEqual([child.id]);

    store.updateIssue(child.id, { parent: next.id }, "vp");
    expect(blockersOf(old.id)).toEqual([]);
    expect(blockersOf(next.id)).toEqual([child.id]);
    expect(events("blockers_changed", old.id).at(-1)?.payload).toMatchObject({ blockedBy: [] });
    expect(events("blockers_changed", next.id).at(-1)?.payload).toMatchObject({ blockedBy: [child.identifier] });

    store.updateIssue(child.id, { parent: null }, "vp");
    expect(blockersOf(next.id)).toEqual([]);
  });

  it("re-derives both parents: the one it left closes when everything left has landed, the one it joins reopens", () => {
    const old = store.createIssue({ title: "Old epic", kind: "epic" });
    const next = store.createIssue({ title: "New epic", kind: "epic" });
    const landed = store.createIssue({ title: "Landed", parent: old.id });
    const moving = store.createIssue({ title: "Moving", parent: old.id });
    const finished = store.createIssue({ title: "Finished", parent: next.id });
    store.updateIssue(landed.id, { status: "done" }, "vp");
    store.updateIssue(finished.id, { status: "done" }, "vp");
    store.updateIssue(moving.id, { assignee: "w", status: "in_progress" }, "w");
    expect([status(old.id), status(next.id)]).toEqual(["in_progress", "done"]);

    store.updateIssue(moving.id, { parent: next.id }, "vp");
    expect([status(old.id), status(next.id)]).toEqual(["done", "in_progress"]);
    expect(events("children_complete", old.id)).toHaveLength(1);
  });

  it("refuses to move work out of or into the tree of a pending gate", () => {
    const gated = store.createIssue({ title: "Gated epic", kind: "epic" });
    const inside = store.createIssue({ title: "Inside", parent: gated.id });
    const nested = store.createIssue({ title: "Nested", parent: inside.id });
    const free = store.createIssue({ title: "Free" });
    store.gateIssue(gated.id, { owner: "VP" }, "agent");
    expect(refused(() => store.updateIssue(nested.id, { parent: free.id }, "vp"), "conflict").message).toContain(`${gated.identifier} is parked behind a review gate`);
    expect(refused(() => store.updateIssue(free.id, { parent: inside.id }, "vp"), "conflict").message).toContain("approve");
    expect(store.getIssue(nested.id).parentId).toBe(inside.id);
  });

  it("leaves queue entries and milestone membership as they were", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const created = store.milestones().create({ title: "October" }, "vp");
    if (created.preview) throw new Error("unreachable");
    const old = store.createIssue({ title: "Old epic", kind: "epic" });
    const next = store.createIssue({ title: "New epic", kind: "epic" });
    const child = store.createIssue({ title: "Member", parent: old.id });
    store.milestones().addMember(created.milestone.identifier, child.identifier, {}, "vp");
    store.queue().enqueue(child.id, {}, "vp");
    store.updateIssue(child.id, { parent: next.id }, "vp");
    expect(store.milestones().get(created.milestone.identifier).members.map((member) => member.identifier)).toEqual([child.identifier]);
    expect(store.queue().entries({ all: true }).map((entry) => [entry.issueId, entry.parent])).toEqual([[child.id, next.identifier]]);
  });
});
