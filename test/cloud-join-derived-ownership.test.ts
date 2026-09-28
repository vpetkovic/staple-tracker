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
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
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

const owner = (machine: Machine, id: string): unknown =>
  machine.db.prepare("SELECT status, derived_status FROM issues WHERE id = ?").get(id);

/** The column's invariant on every row of every device: null, or the status the row holds. */
function expectInvariant(...machines: Machine[]): void {
  for (const machine of machines) {
    const broken = machine.db.prepare("SELECT identifier, status, derived_status FROM issues WHERE derived_status IS NOT NULL AND derived_status IS NOT status").all();
    expect(broken, `${machine.label} holds a derived_status that is not its status`).toEqual([]);
  }
}

/** An epic with one child, which lands, so derivation closes the epic. */
function closedEpic(machine: Machine): { epic: string; child: string } {
  machine.use();
  const epic = machine.store.createIssue({ title: "E", kind: "epic" }).id;
  const child = machine.store.createIssue({ title: "C", parent: epic }).id;
  machine.store.updateIssue(child, { assignee: machine.label }, machine.label);
  machine.store.updateIssue(child, { status: "in_progress" }, machine.label);
  machine.store.updateIssue(child, { status: "done" }, machine.label);
  expect(owner(machine, epic)).toEqual({ status: "done", derived_status: "done" });
  return { epic, child };
}

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
        expectInvariant(a, j, later, fresh);
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
    expectInvariant(a, later);
  });
});

describe("a derived move and a person's move of one parent, made apart", () => {
  for (const [side, chosen] of [["the derived", "in_progress"], ["the person's", "in_review"]] as const) {
    for (const resolver of ["a", "b"] as const) {
      it(`record one conflict about the status; resolved on ${resolver} to ${side} side, ownership goes with it everywhere`, async () => {
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

        const machine = { a, b }[resolver];
        const records = listConflicts(machine.db).filter((record) => record.entityId === epic);
        expect(records.map((record) => record.field)).toEqual(["status"]);
        expectInvariant(a, b);
        const record = records[0]!;
        machine.use();
        resolveConflict(machine.db, { id: record.id, choice: record.localValue === chosen ? "local" : "remote", actor: resolver });
        await sync(machine, a, b, a, b);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        const want = { status: chosen, derived_status: chosen === "in_progress" ? "in_progress" : null };
        for (const device of [a, b, fresh]) expect([device.label, owner(device, epic)]).toEqual([device.label, want]);
        expect([...listConflicts(a.db), ...listConflicts(b.db)].filter((open) => open.entityId === epic)).toEqual([]);
        expectInvariant(a, b, fresh);
      });
    }
  }
});

describe("a backfill send that arrives after a person moved the parent", () => {
  it("is dropped where it no longer fits, with no conflict, and every device converges", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await sync(a);
    const { epic, child } = closedEpic(a);
    await sync(a);
    const b = fleet.machine("b");
    await sync(b);

    // a owes the send, and its push fails after the send is journaled.
    a.db.prepare("INSERT INTO meta (key, value) VALUES ('derived_status_publish_owed', '1')").run();
    server.failNext = { route: "POST /v1/repos/:id/ops", times: 100, status: 503, code: "unavailable" };
    a.use();
    await a.sync().catch(() => undefined);
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL").get()).toEqual({ n: 1 });
    server.failNext = null;
    // b reopens E by hand, and only then does a's send arrive.
    b.use();
    b.store.updateIssue(epic, { status: "todo" }, "b");
    await sync(b, a, b);
    expectInvariant(a, b);
    // A bookkeeping send is nobody's move: dropped where it no longer fits, no record for a person.
    expect([owner(a, epic), owner(b, epic)]).toEqual([
      { status: "todo", derived_status: null },
      { status: "todo", derived_status: null },
    ]);
    expect([...listConflicts(a.db), ...listConflicts(b.db)]).toEqual([]);

    // On b, a second child: finished, E closes; reopened, E reopens — on every device.
    b.use();
    const second = b.store.createIssue({ title: "C2", parent: epic }).id;
    b.store.updateIssue(second, { assignee: "b" }, "b");
    b.store.updateIssue(second, { status: "in_progress" }, "b");
    b.store.updateIssue(second, { status: "done" }, "b");
    await sync(b, a, b);
    b.use();
    b.store.updateIssue(second, { status: "todo" }, "b");
    await sync(b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const device of [a, b, fresh]) expect([device.label, status(device, epic)]).not.toEqual([device.label, "done"]);
    expect(status(b, child)).toBe("done");
    expect([...listConflicts(a.db), ...listConflicts(b.db)]).toEqual([]);
    const want = stateOf(fresh.db);
    expect([a, b].flatMap((device) => differences(device.label, want, stateOf(device.db)))).toEqual([]);
    expectInvariant(a, b, fresh);
  });
});

describe("a derived move written by a build before 017", () => {
  it("still belongs to derivation where it is applied, so the parent reopens", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await sync(a);
    const b = fleet.machine("b");
    await sync(b);
    const { epic, child } = closedEpic(a);
    await sync(a);
    // As that build sent it: `status` and `derived`, no `derivedStatus`.
    for (const op of server.ops) delete (op.payload as Record<string, unknown>).derivedStatus;
    await sync(b);
    expect(owner(b, epic)).toEqual({ status: "done", derived_status: "done" });

    b.use();
    b.store.updateIssue(child, { status: "todo" }, "b");
    expect(status(b, epic)).toBe("backlog");
    expectInvariant(a, b);
  });
});

describe("one status record decided twice, offline, to opposite sides", () => {
  it("lands where the later decision says, with its ownership, on every device", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await sync(a);
    a.use();
    const epic = a.store.createIssue({ title: "E", kind: "epic" }).id;
    const child = a.store.createIssue({ title: "C", parent: epic }).id;
    await sync(a);
    const b = fleet.machine("b");
    await sync(b);
    a.use();
    a.store.updateIssue(child, { assignee: "a" }, "a");
    a.store.updateIssue(child, { status: "in_progress" }, "a");
    b.use();
    b.store.updateIssue(epic, { status: "in_review" }, "b");
    await sync(a, b, a);

    // a keeps b's hand move; b keeps a's derived one. b's decision reaches the log last.
    const decide = (machine: Machine, value: string): void => {
      machine.use();
      const record = listConflicts(machine.db).find((open) => open.entityId === epic)!;
      resolveConflict(machine.db, { id: record.id, choice: record.localValue === value ? "local" : "remote", actor: machine.label });
    };
    decide(a, "in_review");
    decide(b, "in_progress");
    await sync(a, b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    for (const device of [a, b, fresh]) {
      expect([device.label, owner(device, epic)]).toEqual([device.label, { status: "in_progress", derived_status: "in_progress" }]);
    }
    expectInvariant(a, b, fresh);
  });
});
