/**
 * Who put an entry in the plan or a milestone, when, and the note they left, replicate.
 *
 * `docs/sync.md` has always said *"`added_by`, `added_at` and `note` ride along"* with the
 * ordered collections. They did not: the plan travelled as a list of ids, so a note never
 * left the device it was written on, and every device that applied the list wrote the
 * applying operation's actor and time over EVERY entry — so a reorder on one machine
 * erased every other machine's record of who queued what.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000000c3";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function plan(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT issue_id, added_by, added_at, note FROM queue_entries ORDER BY rank").all();
}

function members(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT milestone_id, issue_id, added_by, added_at, note FROM milestone_members ORDER BY milestone_id, rank")
    .all();
}

describe("notes and authorship on the plan and on milestone members", () => {
  it("reach a device on the ordered tail and a device that hydrates from the snapshot, unchanged", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const tail = fleet.machine("tail");
    await tail.sync();

    const first = a.store.createIssue({ title: "Do this first" });
    const second = a.store.createIssue({ title: "Then this" });
    const member = a.store.createIssue({ title: "Part of the release" });
    a.store.addKind({ id: "milestone" });
    const release = a.store.createIssue({ title: "Release 1", kind: "milestone" });
    a.store.queue().enqueue(first.id, { note: "Blocks the demo on Friday" }, "alice");
    a.store.queue().enqueue(second.id, {}, "bob");
    a.store.milestones().addMember(release.id, member.id, { note: "Scoped in at planning" }, "carol");
    await a.sync();
    await tail.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();

    expect(plan(a.db)).toEqual([
      expect.objectContaining({ issue_id: first.id, added_by: "alice", note: "Blocks the demo on Friday" }),
      expect.objectContaining({ issue_id: second.id, added_by: "bob", note: null }),
    ]);
    for (const other of [tail, fresh]) {
      expect(plan(other.db)).toEqual(plan(a.db));
      expect(members(other.db)).toEqual(members(a.db));
    }
    expect(members(a.db)).toEqual([
      expect.objectContaining({ issue_id: member.id, added_by: "carol", note: "Scoped in at planning" }),
    ]);
  });

  it("survive a reorder made on another device", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    const first = a.store.createIssue({ title: "One" });
    const second = a.store.createIssue({ title: "Two" });
    a.store.queue().enqueue(first.id, { note: "Why this is first" }, "alice");
    a.store.queue().enqueue(second.id, { note: "Why this is second" }, "alice");
    await a.sync();
    await b.sync();
    const before = plan(a.db);

    b.store.queue().reorder([second.id, first.id], {}, "bob");
    await b.sync();
    await a.sync();

    // The order is bob's. Who queued each entry, when, and why, is still alice's.
    expect(plan(a.db)).toEqual([before[1], before[0]]);
    expect(plan(b.db)).toEqual(plan(a.db));
  });

  it("survive two concurrent reorders and the resolution that settles them, which carries only the order", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const ids = ["One", "Two", "Three"].map((title) => a.store.createIssue({ title }).id);
    ids.forEach((id, n) => a.store.queue().enqueue(id, { note: `note ${n + 1}` }, "alice"));
    await a.sync();
    await b.sync();
    const notes = (db: DatabaseSync) =>
      db.prepare("SELECT issue_id, note, added_by FROM queue_entries ORDER BY issue_id").all();
    const before = notes(a.db);

    a.store.queue().reorder([ids[2]!, ids[0]!, ids[1]!], {}, "alice");
    b.store.queue().reorder([ids[1]!, ids[2]!, ids[0]!], {}, "bob");
    await a.sync();
    await b.sync();
    await a.sync();

    const { listConflicts, resolveConflict } = await import("../src/core/cloud/conflicts.js");
    const open = listConflicts(b.db).filter((conflict) => conflict.entity === "queue" && conflict.resolvedAt === null);
    expect(open).toHaveLength(1);
    resolveConflict(b.db, { id: open[0]!.id, choice: "local", actor: "bob" });
    await b.sync();
    await a.sync();

    for (const machine of [a, b]) expect(notes(machine.db)).toEqual(before);
    expect(plan(a.db)).toEqual(plan(b.db));
  });

  it("travel with a joining device's own entries when they are appended to the repository's plan", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const shared = a.store.createIssue({ title: "Already planned" });
    a.store.queue().enqueue(shared.id, { note: "The repository's own note" }, "alice");
    await a.sync();

    // A clone that worked before connecting, and queued something of its own.
    const prepared = fleet.prepare("c");
    const c: Machine = fleet.connect("c", prepared);
    const own = c.store.createIssue({ title: "Mine, from before joining" });
    c.store.queue().enqueue(own.id, { note: "Queued before I connected" }, "dave");
    await c.sync();
    await a.sync();

    for (const machine of [a, c]) {
      expect(machine.db.prepare("SELECT note, added_by FROM queue_entries ORDER BY rank").all()).toEqual([
        { note: "The repository's own note", added_by: "alice" },
        { note: "Queued before I connected", added_by: "dave" },
      ]);
    }
    expect(plan(c.db)).toEqual(plan(a.db));
  });
});
