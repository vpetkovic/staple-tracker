/**
 * An issue two devices put in two different milestones offline is in the one the log wrote last,
 * on every device and a fresh one (`docs/sync.md`, "A hydrating device applies competing claims in log order").
 *
 * An issue is in one milestone at most. Each device's add is a whole membership of its own
 * milestone, so the log holds both lists naming the issue. A device reading the tail applies them
 * in log order and the later one takes the issue; a device hydrating applied the milestones in the
 * order the snapshot pages them, by id, and the issue went wherever that put it.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d9e0";

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

describe("one issue added to two milestones offline", () => {
  for (const later of ["first", "second"] as const) {
    it(`is in the milestone the log wrote last (${later} made milestone written last)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
      const issue = a.store.createIssue({ title: "I" });
      a.store.milestones().create({ title: "M1", targetDate: "2026-12-01" }, "a");
      a.store.milestones().create({ title: "M2", targetDate: "2027-01-01" }, "a");
      // The two milestones, in the order a fresh device pages them.
      const [m1, m2] = (a.db.prepare("SELECT issue_id FROM milestone_meta ORDER BY issue_id").all() as Array<{ issue_id: string }>).map((row) => row.issue_id);
      await a.sync();
      const b = fleet.machine("b");
      await sync(b);

      a.use();
      a.store.milestones().addMember(m1!, issue.id, {}, "a");
      b.use();
      b.store.milestones().addMember(m2!, issue.id, {}, "b");
      // The milestone that sorts first is written last, or the other way round.
      await sync(...(later === "first" ? [b, a] : [a, b]));
      await sync(a, b);
      const fresh = fleet.machine("fresh");
      await sync(fresh);

      const holder = (machine: Machine) => (machine.db.prepare("SELECT milestone_id FROM milestone_members WHERE issue_id = ?").get(issue.id) as { milestone_id: string }).milestone_id;
      for (const machine of [a, b, fresh]) expect(holder(machine), machine.label).toBe(later === "first" ? m1 : m2);
      const want = stateOf(fresh.db);
      expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    }, 60_000);
  }
});
