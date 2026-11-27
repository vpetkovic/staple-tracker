/**
 * Idea blockers across devices (design/plan.md, "Sub-ideas and blockers"). Each edge is one
 * field of the blocked record's `milestone` entity with a constant value, so two devices adding
 * different edges offline keep both, two adding the same edge agree with no conflict, and one
 * adding while the other removes is a recorded conflict, never a silent overwrite. What holds a
 * sub-idea back and the flag on its scaffolded tickets are derived on the read, so a device that
 * receives the change by sync, or hydrates long after, reads the same and no conflict is raised
 * over them. Both hold with the service folding the log and with a device folding a tail itself.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspace } from "../src/core/workspace.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const REPO = "5eed0000-0000-4000-8000-0000000b10c4";
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

const open = (machine: Machine) => machine.db.prepare("SELECT entity, field FROM sync_conflicts WHERE resolved_at IS NULL").all() as Array<{ entity: string; field: string }>;
const blockedBy = (machine: Machine, id: string) => {
  machine.use();
  return [...machine.store.plan().ideaView(id).blockedBy].sort();
};
const heldBy = (machine: Machine, id: string) => {
  machine.use();
  return machine.store.plan().ideaView(id).heldBy;
};

async function twoDevices(fold: "service" | "tail") {
  const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  const plan = a.store.plan();
  plan.enable("vp", { person: { via: "settings" } });
  const audit = plan.capture({ title: "Audit log", maturity: "exploring" }, "vp", PERSON).id;
  const search = plan.capture({ title: "Search", maturity: "exploring" }, "vp", PERSON).id;
  const target = plan.capture({ title: "Export", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  return { a, b, audit, search, target };
}

for (const fold of ["service", "tail"] as const) {
  describe(`idea blockers across devices (${fold} fold)`, () => {
    it("keeps both edges when two devices add different blockers offline, with no conflict, and a fresh device reads the same", async () => {
      const { a, b, audit, search, target } = await twoDevices(fold);
      a.use();
      a.store.plan().block(target, audit, "agent-a");
      b.use();
      b.store.plan().block(target, search, "agent-b");
      await both(a, b);
      const want = [audit, search].sort();
      expect(blockedBy(a, target)).toEqual(want);
      expect(blockedBy(b, target)).toEqual(want);
      expect(open(a)).toEqual([]);
      expect(open(b)).toEqual([]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(blockedBy(fresh, target)).toEqual(want);
      // The hold is derived the same everywhere.
      expect(heldBy(fresh, target)).toEqual(heldBy(a, target));
      expect(heldBy(b, target)?.blockers.map((entry) => entry.id).sort()).toEqual(want);
    });

    it("agrees with no conflict when both devices add the same blocker offline", async () => {
      const { a, b, audit, target } = await twoDevices(fold);
      a.use();
      a.store.plan().block(target, audit, "agent-a");
      b.use();
      b.store.plan().block(target, audit, "agent-b");
      await both(a, b);
      expect(blockedBy(a, target)).toEqual([audit]);
      expect(blockedBy(b, target)).toEqual([audit]);
      expect([...open(a), ...open(b)]).toEqual([]);
    });

    it("an edge removed on one device while the other keeps it converges on the removal", async () => {
      const { a, b, audit, search, target } = await twoDevices(fold);
      a.use();
      a.store.plan().block(target, audit, "agent-a");
      a.store.plan().block(target, search, "agent-a");
      await both(a, b);
      expect(blockedBy(b, target)).toEqual([audit, search].sort());
      b.use();
      b.store.plan().unblock(target, audit, "agent-b");
      await both(a, b);
      expect(blockedBy(a, target)).toEqual([search]);
      expect(blockedBy(b, target)).toEqual([search]);
      expect([...open(a), ...open(b)]).toEqual([]);
    });

    it("one device adding an edge while the other removes it offline is a recorded conflict, not a silent overwrite", async () => {
      const { a, b, audit, target } = await twoDevices(fold);
      a.use();
      a.store.plan().block(target, audit, "agent-a");
      await both(a, b);
      a.use();
      a.store.plan().unblock(target, audit, "agent-a");
      a.store.plan().block(target, audit, "agent-a");
      b.use();
      b.store.plan().unblock(target, audit, "agent-b");
      await both(a, b);
      const recorded = [...open(a), ...open(b)].filter((conflict) => conflict.entity === "milestone" && conflict.field.startsWith("planBlocker."));
      expect(recorded.length).toBeGreaterThan(0);
    });

    it("a parent going back to exploring on one device flags the scaffolded ticket on the other, with no conflict over the flag", async () => {
      const { a, b } = await twoDevices(fold);
      a.use();
      const plan = a.store.plan();
      const parent = plan.capture({ title: "SSO", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      const child = plan.capture({ title: "Passkeys", maturity: "shaped", parent, plan: READY_PLAN }, "vp", PERSON).id;
      const made = plan.scaffold(child, plan.scaffoldPreview(child).fingerprint, "agent-a");
      const task = made.tasks[0]!.existing!;
      await both(a, b);
      b.use();
      expect(b.store.context(task).scaffoldedFrom?.parentUnsettled).toBeNull();
      a.use();
      a.store.plan().update(parent, { maturity: "exploring" }, "vp", PERSON);
      await both(a, b);
      for (const machine of [a, b]) {
        machine.use();
        expect(machine.store.context(task).scaffoldedFrom?.parentUnsettled).toMatchObject({ ideaId: parent, title: "SSO", maturity: "exploring" });
        expect(machine.store.plan().ideaView(child).heldBy?.parents).toEqual([{ id: parent, title: "SSO", maturity: "exploring" }]);
      }
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(fresh.store.context(task).scaffoldedFrom?.parentUnsettled).toMatchObject({ ideaId: parent, maturity: "exploring" });
      expect([...open(a), ...open(b), ...open(fresh)]).toEqual([]);
    });
  });
}

describe("idea blockers a device held before it first synced", () => {
  it("are seeded with the rest of its plan, so a fresh device reads the same edges and the same hold", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const prepared = fleet.prepare("a");
    const local = openWorkspace(join(prepared.dir, ".staple", "staple.db"));
    const plan = local.store.plan();
    plan.enable("vp", { person: { via: "settings" } });
    const audit = plan.capture({ title: "Audit log", maturity: "exploring" }, "vp", PERSON).id;
    const target = plan.capture({ title: "Export", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    plan.block(target, audit, "agent");
    local.store.db.close();
    const a = fleet.connect("a", prepared);
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    expect(blockedBy(fresh, target)).toEqual([audit]);
    expect(heldBy(fresh, target)).toEqual({ parents: [], blockers: [{ id: audit, title: "Audit log", state: "exploring" }] });
    expect(open(fresh)).toEqual([]);
  });
});
