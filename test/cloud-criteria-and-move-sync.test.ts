/**
 * A criteria edit and a move across devices: the criteria, the marks that follow them, the moved
 * subtree's depth, the block-parent-until-done edge and both parents' derived statuses reach a
 * second device and a freshly hydrated one, and an operation delivered again changes nothing.
 *
 * Every device is real (`fixtures/sync-machines.ts`), against the fake service that folds the
 * log as the Worker does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import { hydrate } from "../src/core/cloud/hydrate.js";
import type { SnapshotEntity } from "../src/core/cloud/wire.js";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000f512";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

function converged(writer: Machine, ...others: Machine[]): void {
  const want = stateOf(writer.db);
  expect(others.flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
}

const row = (machine: Machine, id: string) =>
  machine.db.prepare("SELECT parent_id, depth, status, acceptance_criteria FROM issues WHERE id = ?").get(id) as {
    parent_id: string | null;
    depth: number;
    status: string;
    acceptance_criteria: string | null;
  };
const blockers = (machine: Machine, id: string): string[] =>
  (machine.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ? AND type = 'blocks' ORDER BY blocker_id").all(id) as Array<{ blocker_id: string }>).map(
    (edge) => edge.blocker_id,
  );
const marks = (machine: Machine, id: string) =>
  machine.db.prepare("SELECT position, criterion, verdict FROM milestone_criterion_marks WHERE milestone_id = ? ORDER BY position").all(id);

describe("a criteria edit and a move across devices", () => {
  it("two devices moving tickets under each other offline converge on one loop-free tree, and the break is recorded", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "X", kind: "epic" });
    const y = a.store.createIssue({ title: "Y", kind: "epic" });
    const under = a.store.createIssue({ title: "Under Y", parent: y.id });
    await sync(a, b);

    a.use();
    a.store.updateIssue(x.id, { parent: y.id }, "alice");
    b.use();
    b.store.updateIssue(y.id, { parent: x.id }, "bob");
    // A's move reaches the log first; B's lands after it, so B's is the later write and the one undone.
    await sync(a, b);
    // B applied A's move over its own, unsent one: its own is the later write, so it broke the loop itself.
    expect([row(b, x.id).parent_id, row(b, y.id).parent_id], b.label).toEqual([y.id, null]);
    // A device that joins while the log still holds the loop (no device has written the break yet)
    // breaks it the same way from the snapshot.
    const early = fleet.machine("early");
    await sync(early);
    expect(early.db.prepare("SELECT COUNT(*) AS n FROM issues").get(), early.label).toEqual({ n: 3 });
    expect([row(early, x.id).parent_id, row(early, y.id).parent_id], early.label).toEqual([y.id, null]);
    await sync(a, b, a, b, early);
    const fresh = fleet.machine("fresh");
    await sync(fresh, a, b, early);

    for (const machine of [a, b, early, fresh]) {
      machine.use();
      expect([row(machine, x.id).parent_id, row(machine, y.id).parent_id], machine.label).toEqual([y.id, null]);
      expect([row(machine, y.id).depth, row(machine, x.id).depth, row(machine, under.id).depth], machine.label).toEqual([0, 1, 1]);
      expect(machine.db.prepare("SELECT COUNT(*) AS n FROM issues").get(), machine.label).toEqual({ n: 3 });
      expect(listConflicts(machine.db), machine.label).toEqual([]);
    }
    for (const machine of [a, b]) {
      const broke = machine.db.prepare("SELECT actor, payload FROM events WHERE kind = 'parent_loop_broken' AND issue_id = ?").all(y.id) as Array<{ payload: string }>;
      expect(broke, machine.label).toHaveLength(1);
      expect(JSON.parse(broke[0]!.payload), machine.label).toMatchObject({
        identifier: y.identifier,
        loop: expect.arrayContaining([x.identifier, y.identifier]),
        detachedFrom: x.identifier,
        moves: expect.arrayContaining([expect.objectContaining({ identifier: y.identifier, parent: x.identifier })]),
      });
    }
    converged(a, b, early, fresh);
  }, 60_000);

  it("a device hydrating a fold that still holds a parent loop breaks it by the same rule", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const issue = (id: string, identifier: string, parentId: string, createdSeq: number, movedAt: number): SnapshotEntity => ({
      entity: "issue",
      entityId: id,
      version: 2,
      deletedAt: null,
      lastSeq: movedAt,
      verb: "create",
      state: { identifier, title: identifier, status: "backlog", kind: "task", priority: "medium", parentId, labels: [], createdAt: "2026-11-25T00:00:00.000Z", updatedAt: "2026-11-25T00:00:00.000Z" },
      fieldWrites: { parentId: { baseVersion: 1, opId: `move-${identifier}`, at: "2026-11-25T00:00:00.000Z", seq: movedAt } },
      createdSeq,
      createdAt: "2026-11-25T00:00:00.000Z",
    });
    const x = "00000000-0000-4000-8000-00000000000a";
    const y = "00000000-0000-4000-8000-00000000000b";
    const leaf = { ...issue("00000000-0000-4000-8000-00000000000c", "TST-3", y, 3, 3) };
    db.exec("BEGIN");
    const outcome = hydrate(db, bindJournal(db, "device-z"), [issue(x, "TST-1", y, 1, 5), issue(y, "TST-2", x, 2, 6), leaf], [], 6, "2026-11-25T00:00:00.000Z", true);
    db.exec("COMMIT");
    expect(outcome.parked).toEqual([]);
    const tree = db.prepare("SELECT identifier, parent_id, depth FROM issues ORDER BY identifier").all();
    // TST-2's move is the later write (seq 6): it goes to the top level, and the tree under it follows.
    expect(tree).toEqual([
      { identifier: "TST-1", parent_id: y, depth: 1 },
      { identifier: "TST-2", parent_id: null, depth: 0 },
      { identifier: "TST-3", parent_id: y, depth: 1 },
    ]);
    const broke = db.prepare("SELECT issue_id, payload FROM events WHERE kind = 'parent_loop_broken'").all() as Array<{ issue_id: string; payload: string }>;
    expect(broke).toHaveLength(1);
    expect(broke[0]!.issue_id).toBe(y);
    expect(JSON.parse(broke[0]!.payload)).toMatchObject({ identifier: "TST-2", detachedFrom: "TST-1" });
    db.close();
  });

  it("a move keeps a blocker another device gave the new parent meanwhile, everywhere", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const old = a.store.createIssue({ title: "Old epic", kind: "epic" });
    const next = a.store.createIssue({ title: "New epic", kind: "epic" });
    const other = a.store.createIssue({ title: "Other work" });
    const child = a.store.createIssue({ title: "Blocks its parent", parent: old.id, blockParentUntilDone: true });
    await sync(a, b);

    b.use();
    b.store.setBlockedBy(next.id, [other.id], "bob");
    await sync(b);
    a.use();
    a.store.updateIssue(child.id, { parent: next.id }, "alice");
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect([blockers(machine, old.id), blockers(machine, next.id)], machine.label).toEqual([[], [child.id, other.id].sort()]);
    }
    converged(a, b, fresh);
  }, 60_000);

  it("reach a second device and a fresh one, and a redelivered operation changes nothing", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);

    a.use();
    a.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const created = a.store.milestones().create({ title: "October", acceptanceCriteria: ["A", "B", "C"] }, "vp");
    if (created.preview) throw new Error("unreachable");
    const m = created.milestone;
    a.store.milestones().markCriterion(m.identifier, 3, { verdict: "met", evidence: ["shipped"] }, "judge");
    const old = a.store.createIssue({ title: "Old epic", kind: "epic" });
    const program = a.store.createIssue({ title: "Program", kind: "epic" });
    const next = a.store.createIssue({ title: "New epic", kind: "epic", parent: program.id });
    const landed = a.store.createIssue({ title: "Landed", parent: old.id });
    const child = a.store.createIssue({ title: "Moving", parent: old.id, blockParentUntilDone: true, acceptanceCriteria: ["one"] });
    const grand = a.store.createIssue({ title: "Grandchild", parent: child.id });
    a.store.updateIssue(landed.id, { status: "done" }, "vp");
    a.store.updateIssue(grand.id, { assignee: "w", status: "in_progress" }, "w");
    await sync(a, b);

    a.use();
    a.store.updateIssue(child.id, { parent: next.id, addCriteria: ["two"] }, "mover");
    a.store.updateIssue(m.id, { removeCriteria: [1] }, "editor");
    await sync(a, b);

    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      machine.use();
      expect(row(machine, child.id), machine.label).toEqual({ parent_id: next.id, depth: 2, status: "in_progress", acceptance_criteria: JSON.stringify(["one", "two"]) });
      expect(row(machine, grand.id).depth, machine.label).toBe(3);
      expect([row(machine, old.id).status, row(machine, next.id).status], machine.label).toEqual(["done", "in_progress"]);
      expect([blockers(machine, old.id), blockers(machine, next.id)], machine.label).toEqual([[], [child.id]]);
      expect(marks(machine, m.id), machine.label).toEqual([{ position: 2, criterion: "C", verdict: "met" }]);
      expect(machine.store.milestones().get(m.identifier).goal.criteria.map((c) => c.verdict), machine.label).toEqual(["unknown", "met"]);
      expect(listConflicts(machine.db), machine.label).toEqual([]);
    }
    converged(a, b, fresh);

    // The move's own operation delivered again, twice, on a device that already holds it.
    b.use();
    for (let replay = 0; replay < 2; replay += 1) {
      b.db.exec("BEGIN");
      applyToDatabase(b.db, {
        entity: "issue",
        entityId: child.id,
        verb: "update",
        payload: { parent_id: next.id, acceptance_criteria: JSON.stringify(["one", "two"]) },
        actor: "mover",
        deviceId: "device-a",
        at: new Date().toISOString(),
        opId: null,
      });
      b.db.exec("COMMIT");
    }
    await sync(a, b, a, fresh);
    converged(a, b, fresh);
  }, 60_000);
});
