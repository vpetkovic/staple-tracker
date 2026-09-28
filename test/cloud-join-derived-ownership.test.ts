/**
 * A status derivation wrote stays derivation's on every device, however the device came to
 * hold it (`docs/semantics.md`, "A parent's status is derived from its children"; migration 017).
 *
 * Ownership was read from the event log, and events never replicate: a device re-emits the
 * events an operation narrates, and a join seed or a snapshot narrates nothing. So a device
 * that received a parent through a join seed, or hydrated from a snapshot, held no events for
 * it and read every derived epic and milestone as set by hand. When their work landed there,
 * they stayed `in_progress` on every device and never closed. Ownership is now a column that
 * travels with the row.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000c01e";

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

const status = (machine: Machine, id: string): string =>
  (machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(id) as { status: string }).status;

describe("a derived status travels as derivation's", () => {
  // `join`: j works before it ever connects, and joins with a seed. `hydrate`: j is connected
  // first, and a device that joins later hydrates from the snapshot.
  for (const route of ["join", "hydrate"] as const) {
    for (const landsOn of ["j", "a", "later"] as const) {
      it(`closes an epic and a milestone when their work lands on ${landsOn} (${route})`, async () => {
        fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
        const a = fleet.machine("a");
        a.use();
        a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
        a.store.createIssue({ title: "already in the repository" });
        await sync(a);

        const j = fleet.machine("j");
        if (route === "hydrate") await sync(j);
        j.use();
        if (route === "join") j.store.addKind({ id: "milestone", label: "Milestone" }, "j");
        const epic = j.store.createIssue({ title: "E", kind: "epic" }).id;
        const child = j.store.createIssue({ title: "C", parent: epic }).id;
        const t = j.store.createIssue({ title: "T" }).id;
        const view = j.store.milestones().create({ title: "M" }, "j") as { milestone: { identifier: string } };
        const m = j.store.getIssue(view.milestone.identifier).id;
        j.store.milestones().addMember(m, t, {}, "j");
        for (const id of [child, t]) {
          j.store.updateIssue(id, { assignee: "j" }, "j");
          j.store.updateIssue(id, { status: "in_progress" }, "j");
        }
        expect([status(j, epic), status(j, m)]).toEqual(["in_progress", "in_progress"]);
        await sync(j, a, j);
        const later = fleet.machine("later");
        await sync(later);

        const worker = { j, a, later }[landsOn];
        worker.use();
        for (const id of [child, t]) worker.store.updateIssue(id, { status: "done" }, worker.label);
        await sync(worker, a, j, later, a, j, later);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        for (const machine of [a, j, later, fresh]) {
          expect([machine.label, status(machine, epic), status(machine, m)]).toEqual([machine.label, "done", "done"]);
          expect(listConflicts(machine.db), machine.label).toEqual([]);
        }
        const want = stateOf(fresh.db);
        expect([a, j, later].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
      });
    }
  }
});

describe("an upgraded device sends the ownership it backfilled", () => {
  it("lets a device that hydrates afterwards close what the log never said was derived", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await sync(a);
    a.use();
    const epic = a.store.createIssue({ title: "E", kind: "epic" }).id;
    const child = a.store.createIssue({ title: "C", parent: epic }).id;
    a.store.updateIssue(child, { assignee: "a" }, "a");
    a.store.updateIssue(child, { status: "in_progress" }, "a");
    await sync(a);
    // The log as a build before 017 wrote it: no operation carries `derivedStatus`. a is that
    // device after the upgrade, its column backfilled from its own events and the send owed.
    for (const op of server.ops) delete (op.payload as Record<string, unknown>).derivedStatus;
    expect(a.db.prepare("SELECT derived_status FROM issues WHERE id = ?").get(epic)).toEqual({ derived_status: "in_progress" });
    a.db.prepare("INSERT INTO meta (key, value) VALUES ('derived_status_publish_owed', '1')").run();

    await sync(a);
    expect(a.db.prepare("SELECT 1 AS hit FROM meta WHERE key = 'derived_status_publish_owed'").get()).toBeUndefined();
    const later = fleet.machine("later");
    await sync(later);
    later.use();
    later.store.updateIssue(child, { status: "done" }, "later");
    await sync(later, a);
    expect([status(later, epic), status(a, epic)]).toEqual(["done", "done"]);
  });
});

describe("a derived move and a person's move of one parent, made apart", () => {
  it("record one conflict, about the status, and whichever side wins decides ownership with it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await sync(a);
    a.use();
    const epic = a.store.createIssue({ title: "E", kind: "epic" }).id;
    const child = a.store.createIssue({ title: "C", parent: epic }).id;
    await sync(a);
    const b = fleet.machine("b");
    await sync(b);

    // a's child starts, so derivation moves E; b parks E in review by hand, not having pulled it.
    a.use();
    a.store.updateIssue(child, { assignee: "a" }, "a");
    a.store.updateIssue(child, { status: "in_progress" }, "a");
    b.use();
    b.store.updateIssue(epic, { status: "in_review" }, "b");
    await sync(a, b, a);

    const records = [...listConflicts(a.db), ...listConflicts(b.db)].filter((record) => record.entityId === epic);
    expect(records.map((record) => record.field)).toEqual(records.map(() => "status"));
    for (const machine of [a, b]) {
      const row = machine.db.prepare("SELECT status, derived_status FROM issues WHERE id = ?").get(epic) as { status: string; derived_status: string | null };
      // Never a stale claim: the column is null or names the status the row holds.
      expect(row.derived_status === null || row.derived_status === row.status, `${machine.label} ${JSON.stringify(row)}`).toBe(true);
    }
  });
});
