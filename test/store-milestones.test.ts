import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { MILESTONE_KIND, MILESTONE_KIND_MISSING_MESSAGE } from "../src/core/milestones.js";
import type { MilestoneStore } from "../src/core/milestone-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

/**
 * STA-172 — milestones in the store, the database half of docs/milestones.md.
 *
 * The pure rules (dates, ranks, refusals, the count-once rollup) are pinned in
 * `milestones.test.ts` and are not re-proved here. What is pinned here is what
 * needs a database: that a milestone is an ordinary issue, that membership is a
 * relation and never a re-parent, that order is durable and independent, that
 * the CAS refuses a stale base and leaves the order standing, that progress
 * reads categories, and that deletion cascades through the two tables and
 * touches nothing else. Every test name below is the one docs/milestones.md
 * says pins the paragraph.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let milestones: MilestoneStore;
beforeEach(() => {
  store = memStore();
  store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
  milestones = store.milestones();
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

function newMilestone(title = "October cut"): string {
  return store.createIssue({ title, kind: MILESTONE_KIND }).identifier;
}

function order(milestone: string): string[] {
  return milestones.get(milestone).members.map((m) => m.identifier);
}

function ranks(milestone: string): number[] {
  return milestones.get(milestone).members.map((m) => m.rank);
}

function eventsOf(ref: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  const id = store.getIssue(ref).id;
  return store
    .listEvents(0, 1000)
    .filter((e) => e.issueId === id)
    .map((e) => ({ kind: e.kind, payload: e.payload }));
}

/** Walk a leaf to `done`, the way the guards insist on. */
function land(ref: string, to: "done" | "cancelled" = "done"): void {
  if (to === "done") {
    store.updateIssue(ref, { assignee: "someone" }, "someone");
    store.updateIssue(ref, { status: "in_progress" }, "someone");
  }
  store.updateIssue(ref, { status: to }, "someone");
}

describe("identity", () => {
  it("a milestone is an ordinary issue with an ordinary history", () => {
    const m = newMilestone();
    const issue = store.getIssue(m);
    expect(issue.kind).toBe(MILESTONE_KIND);
    expect(milestones.get(m).milestone).toMatchObject({ identifier: m, title: "October cut", kind: MILESTONE_KIND });
    store.addComment(m, "planning note", "vp");
    expect(store.listComments(m)).toHaveLength(1);
    expect(eventsOf(m).map((e) => e.kind)).toContain("issue_created");
    // No metadata row until something is written: a dateless, memberless
    // milestone is just an issue, and it still lists.
    expect(milestones.list().map((row) => row.milestone.identifier)).toEqual([m]);
    expect(milestones.get(m)).toMatchObject({ revision: 0, members: [], next: null });
    expect(milestones.get(m).milestone).toMatchObject({ targetDate: null, startDate: null, state: "planned", planPosition: null });
  });

  it("refuses every operation when the milestone kind is not configured", () => {
    const bare = memStore();
    const t = bare.createIssue({ title: "task" }).identifier;
    const service = bare.milestones();
    for (const op of [
      () => service.list(),
      () => service.get(t),
      () => service.create({ title: "x" }, "vp"),
      () => service.update(t, { targetDate: "2026-10-31" }, "vp"),
      () => service.addMember(t, t, {}, "vp"),
      () => service.removeMember(t, t, {}, "vp"),
      () => service.moveMember(t, { at: 1 }, "vp"),
      () => service.reorderMembers(t, [t], {}, "vp"),
    ]) {
      expect(refused(op, "validation").message).toBe(MILESTONE_KIND_MISSING_MESSAGE);
    }
  });

  it("refuses a non-milestone by naming its kind and an unknown identifier as not_found", () => {
    const epic = store.createIssue({ title: "S", kind: "epic" }).identifier;
    expect(refused(() => milestones.get(epic), "validation").message).toBe(`${epic} is an epic, not a milestone.`);
    expect(refused(() => milestones.update(epic, { targetDate: "2026-10-31" }, "vp"), "validation").detail).toEqual({
      identifier: epic,
      kind: "epic",
    });
    refused(() => milestones.get("TST-999"), "not_found");
    refused(() => milestones.addMember(newMilestone(), "TST-999", {}, "vp"), "not_found");
  });

  it("refuses to re-kind a milestone that still has members", () => {
    const m = newMilestone();
    const t = store.createIssue({ title: "t" }).identifier;
    milestones.addMember(m, t, {}, "vp");
    const error = refused(() => store.updateIssue(m, { kind: "task" }, "vp"), "validation");
    expect(error.message).toContain("1 member");
    expect(error.detail).toEqual({ identifier: m, members: 1, dated: false });
    expect(store.getIssue(m).kind).toBe(MILESTONE_KIND);

    // Dates alone are enough to refuse; clearing both and removing the member frees it.
    milestones.removeMember(m, t, {}, "vp");
    milestones.update(m, { targetDate: "2026-10-31" }, "vp");
    expect(refused(() => store.updateIssue(m, { kind: "task" }, "vp"), "validation").detail).toMatchObject({ dated: true });
    milestones.update(m, { targetDate: null }, "vp");
    expect(store.updateIssue(m, { kind: "task" }, "vp").kind).toBe("task");
    // ...and any issue may become a milestone; its row appears on first write.
    expect(store.updateIssue(m, { kind: MILESTONE_KIND }, "vp").kind).toBe(MILESTONE_KIND);
  });

  /**
   * The bulk half of the guard above: `kinds rm milestone --migrate-to task` would
   * re-kind every milestone in one statement, so it is refused by the same rule and
   * names every milestone that still owns something.
   */
  it("refuses to remove the milestone kind while milestones exist", () => {
    const m = newMilestone();
    const t = store.createIssue({ title: "t" }).identifier;
    milestones.addMember(m, t, {}, "vp");
    const error = refused(() => store.removeKind(MILESTONE_KIND, { migrateTo: "task" }, "vp"), "validation");
    expect(error.message).toBe(`Cannot remove the milestone kind while ${m} still has members or dates.`);
    expect(error.detail).toEqual({ milestones: [m] });

    // Dates alone are enough, and the refusal names every milestone that owns anything.
    const dated = newMilestone("November cut");
    milestones.update(dated, { targetDate: "2026-11-30" }, "vp");
    expect(refused(() => store.removeKind(MILESTONE_KIND, { migrateTo: "task" }, "vp"), "validation").detail).toEqual({
      milestones: [m, dated],
    });

    // Cleared of members and dates they are ordinary issues again, so the kind goes
    // and they migrate like any other row would.
    milestones.removeMember(m, t, {}, "vp");
    milestones.update(dated, { targetDate: null }, "vp");
    expect(store.removeKind(MILESTONE_KIND, { migrateTo: "task" }, "vp")).toEqual({ migrated: 2 });
    expect(store.getKinds().map((k) => k.id)).not.toContain(MILESTONE_KIND);
    expect(store.getIssue(m).kind).toBe("task");
  });

  it("a member landing does not move the milestone's status", () => {
    const m = newMilestone();
    const t = store.createIssue({ title: "t" }).identifier;
    milestones.addMember(m, t, {}, "vp");
    land(t);
    expect(store.getIssue(m).status).toBe("backlog");
    expect(milestones.get(m).progress).toMatchObject({ total: 1, countable: 1, percent: 100, complete: true });
    expect(milestones.get(m).milestone.state).toBe("active");
  });
});

describe("dates", () => {
  it("round-trips, clears with null, and refuses a bad day or a start after the target", () => {
    const m = newMilestone();
    let view = milestones.update(m, { targetDate: "2026-10-31", startDate: "2026-10-01" }, "vp");
    expect(view.milestone).toMatchObject({ targetDate: "2026-10-31", startDate: "2026-10-01" });
    expect(eventsOf(m).at(-1)).toEqual({
      kind: "milestone_updated",
      payload: { targetDate: "2026-10-31", startDate: "2026-10-01", previous: { targetDate: null, startDate: null } },
    });
    view = milestones.update(m, { startDate: null }, "vp");
    expect(view.milestone).toMatchObject({ targetDate: "2026-10-31", startDate: null });
    expect(refused(() => milestones.update(m, { targetDate: "2026-02-30" }, "vp"), "validation").message).toContain("YYYY-MM-DD");
    expect(refused(() => milestones.update(m, { startDate: "2026-11-01" }, "vp"), "validation").message).toContain("after target");
    expect(refused(() => milestones.update(m, {}, "vp"), "validation").message).toContain("targetDate or startDate");
    // A refused write leaves the dates as they were.
    expect(milestones.get(m).milestone).toMatchObject({ targetDate: "2026-10-31", startDate: null });
  });

  it("derives state from the calendar and the members, never from a column", () => {
    const m = newMilestone();
    expect(milestones.get(m).milestone.state).toBe("planned");
    milestones.update(m, { targetDate: "2000-01-01" }, "vp");
    expect(milestones.get(m).milestone.state).toBe("overdue");
    milestones.update(m, { targetDate: null, startDate: "2000-01-01" }, "vp");
    expect(milestones.get(m).milestone.state).toBe("active");
    store.updateIssue(m, { status: "cancelled" }, "vp");
    expect(milestones.get(m).milestone.state).toBe("cancelled");
  });
});

describe("membership is a relation, not a hierarchy", () => {
  it("adding a member leaves its parent, depth, blockers and status untouched", () => {
    const programme = store.createIssue({ title: "R", kind: "epic" }).identifier;
    const epic = store.createChild(programme, { title: "S", kind: "epic" }).identifier;
    const blocker = store.createIssue({ title: "blocker" }).identifier;
    const task = store.createChild(epic, { title: "S2", blockedBy: [blocker] }).identifier;
    const before = { epic: store.getIssue(epic), task: store.getIssue(task) };

    const m = newMilestone();
    milestones.addMember(m, epic, {}, "vp");
    milestones.addMember(m, task, {}, "vp");

    for (const [ref, was] of [
      [epic, before.epic],
      [task, before.task],
    ] as const) {
      const now = store.getIssue(ref);
      expect(now.parentId).toBe(was.parentId);
      expect(now.depth).toBe(was.depth);
      expect(now.status).toBe(was.status);
      expect(now.statusVersion).toBe(was.statusVersion);
    }
    expect(store.blockersOf(store.getIssue(task).id).map((b) => b.identifier)).toEqual([blocker]);
    expect(store.tree(programme)[0]!.children).toHaveLength(1);
    const view = milestones.get(m);
    expect(view.members.map((r) => [r.identifier, r.parent, r.nestedUnder])).toEqual([
      [epic, programme, null],
      [task, epic, epic],
    ]);
    expect(eventsOf(m).map((e) => e.kind)).toEqual(["issue_created", "milestone_member_added", "milestone_member_added"]);
    expect(eventsOf(m)[1]!.payload).toEqual({ identifier: epic, rank: 1024, position: 1, revision: 1 });
    expect(eventsOf(task).at(-1)).toEqual({ kind: "milestone_joined", payload: { milestone: m, revision: 2 } });
  });

  it("refuses a second direct milestone, a milestone as a member, and a self-member", () => {
    const m1 = newMilestone("M1");
    const m2 = newMilestone("M2");
    const t = store.createIssue({ title: "t" }).identifier;
    milestones.addMember(m1, t, {}, "vp");
    const second = refused(() => milestones.addMember(m2, t, {}, "vp"), "validation");
    expect(second.message).toContain(`already in ${m1}`);
    expect(second.detail).toEqual({ identifier: t, milestone: m1 });
    refused(() => milestones.addMember(m1, m2, {}, "vp"), "validation");
    refused(() => milestones.addMember(m1, m1, {}, "vp"), "validation");
    expect(order(m1)).toEqual([t]);
    expect(order(m2)).toEqual([]);
  });

  it("add of a present member is a no-op replay", () => {
    const m = newMilestone();
    const t = store.createIssue({ title: "t" }).identifier;
    const first = milestones.addMember(m, t, {}, "vp");
    expect(first.replayed).toBe(false);
    const again = milestones.addMember(m, t, {}, "vp");
    expect(again.replayed).toBe(true);
    expect(again.revision).toBe(first.revision);
    expect(eventsOf(m).filter((e) => e.kind === "milestone_member_added")).toHaveLength(1);
  });

  it("add with a position of a present member is a move", () => {
    const m = newMilestone();
    const [a, b, c] = ["a", "b", "c"].map((t) => store.createIssue({ title: t }).identifier) as [string, string, string];
    for (const t of [a, b, c]) milestones.addMember(m, t, {}, "vp");
    const moved = milestones.addMember(m, c, { before: a }, "vp");
    expect(moved.replayed).toBe(false);
    expect(order(m)).toEqual([c, a, b]);
    expect(moved.revision).toBe(4);
    expect(eventsOf(m).at(-1)).toEqual({
      kind: "milestone_member_moved",
      payload: { identifier: c, fromPosition: 3, toPosition: 1, rank: 512, revision: 4 },
    });
  });

  it("an epic and its child may both be members, and the child is marked nestedUnder", () => {
    const epic = store.createIssue({ title: "S", kind: "epic" }).identifier;
    const child = store.createChild(epic, { title: "S2" }).identifier;
    const grandchild = store.createChild(child, { title: "S2a" }).identifier;
    const m = newMilestone();
    milestones.addMember(m, child, {}, "vp");
    milestones.addMember(m, epic, {}, "vp");
    milestones.addMember(m, grandchild, {}, "vp");
    expect(milestones.get(m).members.map((r) => [r.identifier, r.nestedUnder])).toEqual([
      [child, epic],
      [epic, null],
      [grandchild, child],
    ]);
    expect(milestones.milestoneOf(grandchild)).toBe(m);
  });

  it("refuses a foreign identifier and names its workspace", () => {
    const m = newMilestone();
    const error = refused(() => milestones.addMember(m, "OTH-1", {}, "vp"), "validation");
    expect(error.message).toContain("OTH-1 belongs to workspace prefix OTH, not test (TST)");
    expect(error.detail).toEqual({ identifier: "OTH-1", prefix: "OTH", workspace: "test" });
    refused(() => milestones.get("OTH-1"), "validation");
  });

  it("create-from-epic previews one membership and no hierarchy change, and writes nothing", () => {
    const programme = store.createIssue({ title: "R", kind: "epic" }).identifier;
    const epic = store.createChild(programme, { title: "S: opt-in cloud continuity", kind: "epic" }).identifier;
    store.createChild(epic, { title: "S1" });
    const issuesBefore = store.listIssues({ includeResolved: true }).length;
    const eventsBefore = store.listEvents(0, 1000).length;

    const preview = milestones.create({ fromEpic: epic, targetDate: "2026-10-31", preview: true }, "vp");
    expect(preview).toEqual({
      preview: true,
      milestone: { title: "S: opt-in cloud continuity", targetDate: "2026-10-31", startDate: null },
      members: [{ identifier: epic, position: 1 }],
      hierarchyChanges: [],
    });
    expect(store.listIssues({ includeResolved: true })).toHaveLength(issuesBefore);
    expect(store.listEvents(0, 1000)).toHaveLength(eventsBefore);
    expect(milestones.list()).toEqual([]);

    const created = milestones.create({ title: "October cut", fromEpic: epic, targetDate: "2026-10-31" }, "vp");
    expect(created.preview).toBe(false);
    if (created.preview) throw new Error("expected a commit");
    expect(created.hierarchyChanges).toEqual([]);
    expect(created.milestone).toMatchObject({ title: "October cut", kind: MILESTONE_KIND, targetDate: "2026-10-31" });
    expect(created.members.map((r) => ({ identifier: r.identifier, position: r.position }))).toEqual(preview.members);
    // The epic is still where it was, and its child was not copied in.
    expect(store.getIssue(epic).parentId).toBe(store.getIssue(programme).id);
    expect(created.members).toHaveLength(1);
    expect(created.progress).toMatchObject({ total: 1, countable: 1, percent: 0 });
    // A preview and a commit agree on a refusal too: the epic is now taken.
    refused(() => milestones.create({ fromEpic: epic, preview: true }, "vp"), "validation");
    refused(() => milestones.create({ fromEpic: epic }, "vp"), "validation");
    refused(() => milestones.create({}, "vp"), "validation");
  });
});

describe("order: sparse ranks and a per-milestone revision", () => {
  it("member order ignores priority, created_at and tree order", () => {
    const m = newMilestone();
    const low = store.createIssue({ title: "low", priority: "low" }).identifier;
    const epic = store.createIssue({ title: "epic", kind: "epic" }).identifier;
    const child = store.createChild(epic, { title: "child" }).identifier;
    const critical = store.createIssue({ title: "critical", priority: "critical" }).identifier;
    for (const t of [low, child, critical, epic]) milestones.addMember(m, t, {}, "vp");
    expect(order(m)).toEqual([low, child, critical, epic]);
    expect(ranks(m)).toEqual([1024, 2048, 3072, 4096]);
    store.updateIssue(low, { priority: "critical" }, "vp");
    land(child);
    expect(order(m)).toEqual([low, child, critical, epic]);

    milestones.addMember(m, store.createIssue({ title: "first" }).identifier, { at: 1 }, "vp");
    expect(ranks(m)[0]).toBe(512);
    milestones.moveMember(epic, { after: low }, "vp");
    expect(order(m).slice(0, 3)).toEqual(["TST-6", low, epic]);
    expect(ranks(m)[2]).toBe(1536);
  });

  it("renumbers when the gap is exhausted, in one transaction", () => {
    const m = newMilestone();
    const head = store.createIssue({ title: "head" }).identifier;
    milestones.addMember(m, head, {}, "vp");
    // 512, 256, 128, 64, 32, 16, 8, 4, 2, 1 — ten prepends fit; the eleventh exhausts the gap.
    for (let i = 0; i < 11; i += 1) {
      milestones.addMember(m, store.createIssue({ title: `p${i}` }).identifier, { at: 1 }, "vp");
    }
    const all = ranks(m);
    expect(all).toHaveLength(12);
    expect(all[0]).toBe(512);
    expect(all.slice(1)).toEqual(Array.from({ length: 11 }, (_, i) => (i + 1) * 1024));
    expect(new Set(all).size).toBe(12);
    expect(order(m).at(-1)).toBe(head);
    expect(milestones.get(m).revision).toBe(12);
  });

  it("a stale baseRevision is refused and the order stands", () => {
    const m = newMilestone();
    const [a, b] = ["a", "b"].map((t) => store.createIssue({ title: t }).identifier) as [string, string];
    milestones.addMember(m, a, {}, "vp");
    milestones.addMember(m, b, { baseRevision: 1 }, "vp");
    expect(milestones.get(m).revision).toBe(2);
    for (const op of [
      () => milestones.addMember(m, store.createIssue({ title: "c" }).identifier, { baseRevision: 1 }, "vp"),
      () => milestones.removeMember(m, a, { baseRevision: 1 }, "vp"),
      () => milestones.moveMember(b, { before: a, baseRevision: 1 }, "vp"),
      () => milestones.reorderMembers(m, [b, a], { baseRevision: 1 }, "vp"),
    ]) {
      const error = refused(op, "revision_conflict");
      expect(error.detail).toEqual({ currentRevision: 2 });
    }
    expect(order(m)).toEqual([a, b]);
    expect(milestones.get(m).revision).toBe(2);
  });

  it("bulk reorder is atomic and bumps the revision once", () => {
    const m = newMilestone();
    const [a, b, c] = ["a", "b", "c"].map((t) => store.createIssue({ title: t }).identifier) as [string, string, string];
    for (const t of [a, b, c]) milestones.addMember(m, t, {}, "vp");
    const view = milestones.reorderMembers(m, [c, a, b], { baseRevision: 3 }, "vp");
    expect(view.revision).toBe(4);
    expect(order(m)).toEqual([c, a, b]);
    expect(ranks(m)).toEqual([1024, 2048, 3072]);
    expect(eventsOf(m).at(-1)).toEqual({ kind: "milestone_members_reordered", payload: { order: [c, a, b], revision: 4 } });
    // Not a permutation: refused whole, nothing moves.
    expect(refused(() => milestones.reorderMembers(m, [a, b], {}, "vp"), "validation").detail).toEqual({ milestone: m, missing: [c] });
    refused(() => milestones.reorderMembers(m, [a, b, c, store.createIssue({ title: "d" }).identifier], {}, "vp"), "validation");
    refused(() => milestones.reorderMembers(m, [a, a, b], {}, "vp"), "validation");
    expect(order(m)).toEqual([c, a, b]);
    expect(milestones.get(m).revision).toBe(4);
  });

  it("removes a member, refuses a non-member as not_found, and moves between milestones", () => {
    const m1 = newMilestone("M1");
    const m2 = newMilestone("M2");
    const [a, b] = ["a", "b"].map((t) => store.createIssue({ title: t }).identifier) as [string, string];
    milestones.addMember(m1, a, {}, "vp");
    milestones.addMember(m1, b, {}, "vp");
    const removed = milestones.removeMember(m1, a, {}, "vp");
    expect(removed.members.map((r) => r.identifier)).toEqual([b]);
    expect(eventsOf(m1).at(-1)).toEqual({ kind: "milestone_member_removed", payload: { identifier: a, position: 1, revision: 3 } });
    expect(eventsOf(a).at(-1)).toEqual({ kind: "milestone_left", payload: { milestone: m1, revision: 3 } });
    refused(() => milestones.removeMember(m1, a, {}, "vp"), "not_found");
    refused(() => milestones.removeMember(m2, b, {}, "vp"), "not_found");
    refused(() => milestones.moveMember(a, { at: 1 }, "vp"), "not_found");
    refused(() => milestones.moveMember(b, {}, "vp"), "validation");

    const moved = milestones.moveMember(b, { to: m2 }, "vp");
    expect(moved.milestone.identifier).toBe(m2);
    expect(order(m1)).toEqual([]);
    expect(order(m2)).toEqual([b]);
    expect(milestones.get(m1).revision).toBe(4);
    expect(milestones.get(m2).revision).toBe(1);
    expect(eventsOf(m2).at(-1)).toEqual({
      kind: "milestone_member_moved",
      payload: { identifier: b, from: m1, to: m2, fromPosition: 1, toPosition: 1, rank: 1024, revision: 1 },
    });
    expect(milestones.milestoneOf(b)).toBe(m2);
  });
});

describe("progress", () => {
  it("progress reads categories, not status ids", () => {
    store.addStatus({ id: "shipped", category: "done", after: "done" }, "vp");
    const m = newMilestone();
    const epic = store.createIssue({ title: "E", kind: "epic" }).identifier;
    const t1 = store.createChild(epic, { title: "T1" }).identifier;
    const t2 = store.createChild(epic, { title: "T2" }).identifier;
    const s = store.createIssue({ title: "S" }).identifier;
    milestones.addMember(m, epic, {}, "vp");
    milestones.addMember(m, t2, {}, "vp");
    milestones.addMember(m, s, {}, "vp");
    store.updateIssue(t1, { assignee: "x" }, "x");
    store.updateIssue(t1, { status: "in_progress" }, "x");
    store.updateIssue(t1, { status: "shipped" }, "x");
    land(s);
    const { progress } = milestones.get(m);
    // {E, T1, T2, T2, S}: E is a parent and drops, T2 counts once.
    expect(progress).toEqual({
      total: 3,
      countable: 3,
      percent: 66,
      complete: false,
      counts: { unstarted: 1, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done: 2, cancelled: 0 },
    });
  });

  it("a done member is kept and counted", () => {
    const m = newMilestone();
    const t = store.createIssue({ title: "t" }).identifier;
    milestones.addMember(m, t, {}, "vp");
    land(t);
    const view = milestones.get(m);
    expect(view.members.map((r) => [r.identifier, r.status])).toEqual([[t, "done"]]);
    expect(view.progress).toMatchObject({ total: 1, countable: 1, percent: 100, complete: true });
    // Reopening is a category change on the next read, nothing is re-added.
    store.updateIssue(t, { status: "todo" }, "vp");
    expect(milestones.get(m).progress).toMatchObject({ percent: 0, complete: false });
    expect(milestones.get(m).members).toHaveLength(1);
  });
});

describe("lifecycle", () => {
  it("deleting a milestone frees its members and changes nothing about them", () => {
    const m = newMilestone();
    const epic = store.createIssue({ title: "E", kind: "epic" }).identifier;
    const child = store.createChild(epic, { title: "C" }).identifier;
    milestones.update(m, { targetDate: "2026-10-31" }, "vp");
    milestones.addMember(m, epic, {}, "vp");
    milestones.addMember(m, child, {}, "vp");
    const before = { epic: store.getIssue(epic), child: store.getIssue(child) };
    // The store has no deleteIssue; the cascade is the schema's, so raw SQL on this scratch db.
    store.db.prepare("DELETE FROM issues WHERE id = ?").run(store.getIssue(m).id);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM milestone_meta").get()).toEqual({ n: 0 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM milestone_members").get()).toEqual({ n: 0 });
    expect(store.getIssue(epic)).toEqual(before.epic);
    expect(store.getIssue(child)).toEqual(before.child);
    expect(milestones.milestoneOf(child)).toBeNull();
  });

  it("deleting a member leaves the other ranks alone", () => {
    const m = newMilestone();
    const [a, b, c] = ["a", "b", "c"].map((t) => store.createIssue({ title: t }).identifier) as [string, string, string];
    for (const t of [a, b, c]) milestones.addMember(m, t, {}, "vp");
    store.db.prepare("DELETE FROM issues WHERE id = ?").run(store.getIssue(b).id);
    expect(order(m)).toEqual([a, c]);
    expect(ranks(m)).toEqual([1024, 3072]);
    expect(milestones.get(m).progress.total).toBe(2);
  });

  it("a membership survives rename, status change and re-parent", () => {
    const m = newMilestone();
    const e1 = store.createIssue({ title: "E1", kind: "epic" }).identifier;
    const e2 = store.createIssue({ title: "E2", kind: "epic" }).identifier;
    const t = store.createChild(e1, { title: "T" }).identifier;
    milestones.addMember(m, e1, {}, "vp");
    milestones.addMember(m, t, {}, "vp");
    store.updateIssue(t, { title: "T renamed" }, "vp");
    land(t);
    // No re-parent API in the store; the point is that the row keys on `issues.id`.
    store.db.prepare("UPDATE issues SET parent_id = ? WHERE id = ?").run(store.getIssue(e2).id, store.getIssue(t).id);
    const view = milestones.get(m);
    // E1 derived `done` from its only child landing — a parent's status is its
    // children's report, and membership does not change that.
    expect(view.members.map((r) => [r.identifier, r.title, r.status, r.parent, r.nestedUnder])).toEqual([
      [e1, "E1", "done", null, null],
      [t, "T renamed", "done", e2, null],
    ]);
    expect(milestones.milestoneOf(t)).toBe(m);
  });

  it("cancelling a milestone leaves its members open", () => {
    const m = newMilestone();
    const t = store.createIssue({ title: "t" }).identifier;
    milestones.addMember(m, t, {}, "vp");
    store.updateIssue(m, { status: "cancelled" }, "vp");
    expect(store.getIssue(t).status).toBe("backlog");
    expect(milestones.get(m).milestone.state).toBe("cancelled");
    expect(milestones.get(m).members).toHaveLength(1);
    expect(milestones.list().map((r) => r.milestone.identifier)).toEqual([]);
    expect(milestones.list({ all: true }).map((r) => r.milestone.identifier)).toEqual([m]);
  });

  it("lists by target date then identifier, with dateless milestones last", () => {
    const late = newMilestone("late");
    const none = newMilestone("none");
    const early = newMilestone("early");
    milestones.update(late, { targetDate: "2026-12-31" }, "vp");
    milestones.update(early, { targetDate: "2026-10-31" }, "vp");
    const rows = milestones.list();
    expect(rows.map((r) => r.milestone.identifier)).toEqual([early, late, none]);
    expect(rows[0]).toMatchObject({ memberCount: 0, revision: 0, next: null });
    expect(rows[0]).not.toHaveProperty("members");
  });
});
