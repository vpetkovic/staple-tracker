/**
 * The certified plan across devices. Labor, coverage and the path read estimates, parents,
 * statuses and `blocks` edges, all of which replicate, so two devices holding the same log must
 * report the same comparison. Every device is real (its own home and clone, the real sync
 * engine and applier) against the fake service that folds the log as the Worker does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000201a4";
const H = 3600;

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

describe("a comparison reads the same on every device", () => {
  it("after estimates, a cancellation and edges written on two devices", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);

    a.use();
    const epic = a.store.createIssue({ title: "Epic" });
    const box = a.store.createChild(epic.id, { title: "Box" });
    const x = a.store.createChild(box.id, { title: "x", estimatedSeconds: 2 * H });
    const y = a.store.createChild(epic.id, { title: "y", estimatedSeconds: 3 * H, blockedBy: [x.id] });
    const z = a.store.createChild(epic.id, { title: "z" });
    const other = a.store.createIssue({ title: "Other", estimatedSeconds: 5 * H });
    await sync(a, b);

    // Device B plans the gap, drops y's dependency onto the outside epic, and cancels a new one.
    b.use();
    b.store.setEstimate(z.id, 4 * H, "planner-b");
    b.store.setBlockedBy(z.id, [y.id, other.id], "planner-b");
    const extra = b.store.createChild(epic.id, { title: "extra", estimatedSeconds: 9 * H });
    b.store.updateIssue(extra.id, { status: "cancelled" }, "planner-b");
    await sync(b, a);

    const refs = [epic.identifier, other.identifier, box.identifier];
    const onA = a.store.comparePlans(refs);
    const onB = b.store.comparePlans(refs);
    expect(onB).toEqual(onA);
    const plan = onA.plans[0]!;
    expect(plan.labor.seconds).toBe(9 * H); // 2 + 3 + 4; the cancelled 9h is no labor
    expect(plan.coverage).toMatchObject({ planned: 3, unplanned: 0, cancelled: 1 });
    expect(plan.criticalPath.seconds).toBe(9 * H);
    expect(plan.criticalPath.chain.map((step) => step.ref)).toEqual([x.identifier, y.identifier, z.identifier]);
    expect(plan.criticalPath.crossSubtreeBlockers).toEqual([
      { blocked: z.identifier, blocker: other.identifier, blockerStatus: "backlog", resolved: false },
    ]);
    expect(onA.overlaps).toEqual([{ ref: box.identifier, within: epic.identifier }]);
    // The same numbers on the timing every surface already carries.
    expect(b.store.timing(epic.id).subtreePlan).toEqual(a.store.timing(epic.id).subtreePlan);
  });

  it("a cycle two devices wrote concurrently is broken the same way on both, never looped", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const epic = a.store.createIssue({ title: "Epic" });
    const p = a.store.createChild(epic.id, { title: "p", estimatedSeconds: 1 * H });
    const q = a.store.createChild(epic.id, { title: "q", estimatedSeconds: 2 * H });
    await sync(a, b);

    // Each device's own check passes: neither sees the other's edge yet.
    a.use();
    a.store.setBlockedBy(q.id, [p.id], "planner-a");
    b.use();
    b.store.setBlockedBy(p.id, [q.id], "planner-b");
    await sync(a, b, a);

    const onA = a.store.comparePlans([epic.identifier]).plans[0]!.criticalPath;
    const onB = b.store.comparePlans([epic.identifier]).plans[0]!.criticalPath;
    expect(onB).toEqual(onA);
    expect(onA.cycle).toEqual([p.identifier, q.identifier]);
    expect(onA.partial).toBe(true);
    expect(onA.missing).toEqual(["dependency_cycle"]);
    expect(onA.seconds).toBe(3 * H);
  });
});
