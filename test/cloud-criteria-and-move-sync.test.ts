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
