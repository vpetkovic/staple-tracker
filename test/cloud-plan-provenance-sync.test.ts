/**
 * Plan provenance across devices (design/plan.md, "Provenance"): it rides in the record's own
 * create, so a second device and a freshly hydrated one read a scaffolded ticket's idea and row,
 * and a sparked idea's ticket, exactly as the device that made them; two devices scaffolding one
 * idea offline write one identical origin and raise no conflict. Both folds.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000b0585";
const PERSON = { person: { via: "plan_view" } } as const;

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

const PLAN: PlanPatch = {
  goal: "G",
  breakdown: [
    { key: "R1", title: "A", estimate: "1h", dependsOn: [], acceptance: "a" },
    { key: "R2", title: "B", estimate: "1h", dependsOn: ["R1"], acceptance: "b" },
  ],
  acceptance: ["x"],
};

/** What a device reads of every provenance this test made. */
function provenance(machine: Machine, refs: { tasks: string[]; ticket: string; sparked: string }) {
  machine.use();
  return {
    tasks: refs.tasks.map((id) => machine.store.context(id).scaffoldedFrom),
    context: refs.tasks.map((id) => machine.store.getDocument(id, "context").body.split("\n")[2]),
    sparked: machine.store.context(refs.ticket).sparked,
    sparkedBy: machine.store.plan().detail(refs.sparked).sparkedBy,
    // Stored, not derived: the origin each record's create carried.
    origins: [...refs.tasks, refs.sparked].map((id) => (machine.db.prepare("SELECT origin_kind FROM issues WHERE id = ?").get(id) as { origin_kind: string }).origin_kind),
  };
}

for (const fold of ["service", "tail"] as const) {
  describe(`provenance across devices (${fold} fold)`, () => {
    it("reads the same on the device that made it, a second device and a hydrated one, and two offline scaffolds raise no conflict", async () => {
      fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) }), REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const idea = a.store.plan().capture({ title: "Idea", maturity: "shaped", plan: PLAN }, "vp", PERSON).id;
      const ticket = a.store.createIssue({ title: "Report screen" }).id;
      await sync(a);
      const b = fleet.machine("b");
      await sync(b);

      // Both scaffold the same idea offline; b also captures an idea sparked by the ticket.
      a.use();
      const made = a.store.plan().scaffold(idea, a.store.plan().scaffoldPreview(idea).fingerprint, "vp", PERSON);
      const tasks = made.tasks.map((task) => a.store.getIssue(task.existing!).id);
      b.use();
      b.store.plan().scaffold(idea, b.store.plan().scaffoldPreview(idea).fingerprint, "agent-b");
      const sparked = b.store.plan().capture({ title: "Found while working", sparkedBy: ticket }, "agent-b").id;
      await sync(a, b, a, b);

      const refs = { tasks, ticket, sparked };
      const want = provenance(a, refs);
      expect(want.tasks.map((from) => from && [from.ideaId, from.rowKey])).toEqual([
        [idea, "R1"],
        [idea, "R2"],
      ]);
      expect(want.context[0]).toMatch(/Scaffolded from idea I-[A-Z]+-\d+, breakdown row R1, as numbered at scaffold/);
      expect(want.sparked.map((entry) => entry.id)).toEqual([sparked]);
      expect(want.sparkedBy?.title).toBe("Report screen");
      expect(want.origins).toEqual(["plan-row", "plan-row", "sparked"]);

      const fresh = fleet.machine("fresh");
      await sync(fresh);
      for (const machine of [b, fresh]) expect(provenance(machine, refs), machine.label).toEqual(want);
      for (const machine of [a, b, fresh]) {
        machine.use();
        expect(listConflicts(machine.db), machine.label).toEqual([]);
      }
      // Every record and document converges. Left out: who made the blocker edge both devices
      // made offline and when, which scaffold records per device as it did before provenance.
      const state = stateOf(a.db);
      const edgeAuthor = /^\w+: relations\[[^\]]+\]\.created_(by|at) /;
      expect([b, fresh].flatMap((machine) => differences(machine.label, state, stateOf(machine.db))).filter((line) => !edgeAuthor.test(line))).toEqual([]);
    }, 60_000);
  });
}
