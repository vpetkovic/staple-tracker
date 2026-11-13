/**
 * The task breakdown and Scaffold across devices (design/plan.md, "Task breakdown rows",
 * "Scaffold"). Each row is one field of the idea's `milestone` entity, so two devices editing
 * different rows offline both keep their edit, and one row edited on both is a recorded field
 * conflict, never a silent overwrite. Scaffold names each task by the idea and its row, so two
 * devices scaffolding one idea offline create the same records, which sync merges as one. Both
 * hold with the service folding the log and with a device folding a tail itself.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000c0c0d";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function both(a: Machine, b: Machine, rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const machine of [a, b]) {
      machine.use();
      await machine.sync();
    }
  }
}

const PLAN: PlanPatch = {
  goal: "G",
  breakdown: [
    { key: "1", title: "A", estimate: "1h", dependsOn: [], acceptance: "a" },
    { key: "2", title: "B", estimate: "1h", dependsOn: ["1"], acceptance: "b" },
  ],
  acceptance: ["x"],
};

const rows = (machine: Machine, id: string) => {
  machine.use();
  return machine.store
    .plan()
    .detail(id)
    .plan.breakdown.map((row) => [row.key, row.title, row.estimate]);
};
const open = (machine: Machine) => machine.db.prepare("SELECT entity, field FROM sync_conflicts WHERE resolved_at IS NULL").all() as Array<{ entity: string; field: string }>;

async function twoDevices(fold: "service" | "tail"): Promise<{ a: Machine; b: Machine; id: string }> {
  const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  a.store.plan().enable("vp", { person: { via: "settings" } });
  const id = a.store.plan().capture({ title: "Idea", maturity: "shaped", plan: PLAN }, "vp", PERSON).id;
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  return { a, b, id };
}

function edit(machine: Machine, id: string, key: string, change: Record<string, unknown>, actor: string): void {
  machine.use();
  const plan = machine.store.plan();
  const read = plan.detail(id).plan.breakdown;
  plan.update(id, { plan: { breakdown: read.map((row) => (row.key === key ? { ...row, ...change } : row)) } }, actor);
}

for (const fold of ["service", "tail"] as const) {
  describe(`breakdown rows across devices (${fold} fold)`, () => {
    it("keeps both edits when two devices edit different rows offline, with no conflict", async () => {
      const { a, b, id } = await twoDevices(fold);
      edit(a, id, "1", { title: "A, edited on a" }, "agent-a");
      edit(b, id, "2", { estimate: "5h" }, "agent-b");
      await both(a, b);
      const want = [
        ["1", "A, edited on a", "1h"],
        ["2", "B", "5h"],
      ];
      expect(rows(a, id)).toEqual(want);
      expect(rows(b, id)).toEqual(want);
      expect(open(a)).toEqual([]);
      expect(open(b)).toEqual([]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(rows(fresh, id)).toEqual(want);
    });

    it("keeps a row added on one device and one added on the other", async () => {
      const { a, b, id } = await twoDevices(fold);
      a.use();
      a.store.plan().update(id, { plan: { breakdown: [...a.store.plan().detail(id).plan.breakdown, { key: "3", title: "From a" }] } }, "agent-a");
      b.use();
      b.store.plan().update(id, { plan: { breakdown: [...b.store.plan().detail(id).plan.breakdown, { key: "4", title: "From b" }] } }, "agent-b");
      await both(a, b);
      expect(rows(a, id).map(([key]) => key).sort()).toEqual(["1", "2", "3", "4"]);
      expect(rows(b, id)).toEqual(rows(a, id));
    });

    it("records a conflict when one row is edited on both devices, and resolving it settles every device", async () => {
      const { a, b, id } = await twoDevices(fold);
      edit(a, id, "1", { title: "A by a" }, "agent-a");
      edit(b, id, "1", { title: "A by b" }, "agent-b");
      await both(a, b);
      const recorded = [...open(a), ...open(b)].filter((conflict) => conflict.entity === "milestone" && conflict.field.startsWith("planRow."));
      expect(recorded.length).toBeGreaterThan(0);
      // One device's value stands meanwhile; the other is kept in the record, not lost.
      const holder = open(a).length > 0 ? a : b;
      holder.use();
      const conflict = listConflicts(holder.db).find((entry) => entry.field.startsWith("planRow."))!;
      expect(JSON.stringify(conflict)).toContain("A by a");
      expect(JSON.stringify(conflict)).toContain("A by b");
      resolveConflict(holder.db, { id: conflict.id, choice: "local", actor: "vp" });
      await both(a, b);
      expect(rows(a, id)).toEqual(rows(b, id));
      expect([...open(a), ...open(b)].filter((entry) => entry.field.startsWith("planRow."))).toEqual([]);
    });
  });

  describe(`Scaffold on two devices offline (${fold} fold)`, () => {
    it("creates each task once: the same records on both, merged by sync, and a later scaffold adds nothing twice", async () => {
      const { a, b, id } = await twoDevices(fold);
      a.use();
      const onA = a.store.plan().scaffold(id, a.store.plan().scaffoldPreview(id).fingerprint, "vp", PERSON);
      b.use();
      const onB = b.store.plan().scaffold(id, b.store.plan().scaffoldPreview(id).fingerprint, "agent-b");
      const ids = (machine: Machine, preview: typeof onA) => {
        machine.use();
        return preview.tasks.map((task) => machine.store.getIssue(task.existing!).id);
      };
      expect(ids(a, onA)).toEqual(ids(b, onB));
      await both(a, b);
      const tasks = (machine: Machine) => {
        machine.use();
        return machine.store
          .listIssues({})
          .filter((issue) => issue.parentId === id)
          .map((issue) => [issue.id, issue.identifier, issue.title])
          .sort();
      };
      expect(tasks(a)).toHaveLength(2);
      expect(tasks(b)).toEqual(tasks(a));
      a.use();
      const next = a.store.plan().detail(id).plan.breakdown;
      a.store.plan().update(id, { plan: { breakdown: [...next, { key: "3", title: "C", dependsOn: ["2"], acceptance: "c" }] } }, "vp", PERSON);
      a.store.plan().scaffold(id, a.store.plan().scaffoldPreview(id).fingerprint, "vp", PERSON);
      await both(a, b);
      expect(tasks(a)).toHaveLength(3);
      expect(tasks(b)).toEqual(tasks(a));
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(tasks(fresh)).toEqual(tasks(a));
    });
  });
}
