/**
 * A database whose state an older build applied is re-read once, and converges.
 *
 * Measured live (`staple` 56ff1f4, upgraded to this build): the older applier had written
 * every plan entry's author as "sync" and no note, and had kept a built-in status every other
 * device deleted. Nothing re-sends an operation a device has already applied, so after the
 * upgrade those stayed wrong for good. Now the first sync by a newer applier re-reads the
 * snapshot, once, on the timeline the device is already on (`APPLIER_VERSION` in
 * `src/core/cloud/sync.ts`).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000014b";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function plan(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT issue_id, added_by, note FROM queue_entries ORDER BY rank").all();
}

function statusIds(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM workspace_statuses ORDER BY sort_order, id").all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

describe("a database an older build applied", () => {
  it("is re-read once on its first sync by this build, and holds what the log says", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const first = a.store.createIssue({ title: "First" });
    a.store.queue().enqueue(first.id, { note: "Why it is first" }, "alice");
    a.store.removeStatus("awaiting_approval");
    await a.sync();
    const v = fleet.machine("v");
    await v.sync();
    expect(plan(v.db)).toEqual(plan(a.db));

    // What an applier from before this build wrote for the same operations: the entry's
    // author and note dropped, the built-in deletion skipped — and no record that a newer
    // applier has looked at it.
    v.db.prepare("UPDATE queue_entries SET added_by = 'sync', note = NULL").run();
    v.db
      .prepare(
        "INSERT INTO workspace_statuses (id, label, category, sort_order, is_builtin) VALUES ('awaiting_approval', 'Awaiting Approval', 'gated', 50, 1)",
      )
      .run();
    v.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    const report = await v.sync();
    expect(report.caughtUp).not.toBeNull();
    expect(plan(v.db)).toEqual(plan(a.db));
    expect(statusIds(v.db)).toEqual(statusIds(a.db));

    // Once: the next sync re-reads nothing.
    expect((await v.sync()).caughtUp).toBeNull();
  });

  /**
   * The re-read applies the fold, and the fold holds the last write of every value — the
   * other side of any disagreement still open here. Applied unscreened, it replaced the
   * value this device holds while the record kept asking which to keep; and a plan's
   * record held its order alone, so resolving it "local" put the entries back without the
   * note this device had written, on every device.
   */
  it("leaves a value a conflict here is still about as it was, and a local resolution keeps the note", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const shared = a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    const fromA = a.store.createIssue({ title: "A's" });
    a.store.queue().enqueue(fromA.id, { note: "A's reason" }, "alice");
    a.store.updateIssue(shared.id, { title: "Shared, as A put it" });
    const fromB = b.store.createIssue({ title: "B's" });
    b.store.queue().enqueue(fromB.id, { note: "B's reason" }, "bob");
    b.store.updateIssue(shared.id, { title: "Shared, as B put it" });
    await a.sync();
    await b.sync();
    await a.sync();
    const open = listConflicts(a.db).filter((conflict) => conflict.resolvedAt === null);
    expect(open.map((conflict) => conflict.field).sort()).toEqual(["order", "title"]);
    const planOnA = plan(a.db);
    expect(planOnA).toEqual([{ issue_id: fromA.id, added_by: "alice", note: "A's reason" }]);

    a.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();
    expect((await a.sync()).caughtUp).not.toBeNull();
    // Still what this device holds, and still asked about.
    expect(plan(a.db)).toEqual(planOnA);
    expect(a.db.prepare("SELECT title FROM issues WHERE id = ?").get(shared.id)).toEqual({ title: "Shared, as A put it" });
    expect(listConflicts(a.db).filter((conflict) => conflict.resolvedAt === null)).toHaveLength(2);

    a.use();
    for (const conflict of open) resolveConflict(a.db, { id: conflict.id, choice: "local", actor: "alice" });
    await a.sync();
    await b.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [a, b, fresh]) {
      expect(plan(machine.db), machine.label).toEqual(planOnA);
      expect(machine.db.prepare("SELECT title FROM issues WHERE id = ?").get(shared.id), machine.label).toEqual({
        title: "Shared, as A put it",
      });
      expect(listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null), machine.label).toEqual([]);
    }
  });

  /**
   * The client ships within minutes of a merge; the Worker whenever it is deployed. The
   * Worker from before this build folds a delete as final, so a status removed and added
   * back is deleted in its snapshot — and a re-read of that snapshot deleted a live status on
   * every upgraded device, then recorded the catch-up as done, so the new Worker never got
   * to repair it. The catch-up now waits for a snapshot that carries the new fold, and a
   * device that hydrated from the old one owes it too.
   */
  it("waits for the Worker that folds creates, and then repairs what the older one served", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    server.legacyFold = true;
    fleet = new Fleet(server, REPO);
    const o = fleet.machine("o");
    const rep = o.store.createIssue({ title: "Ends in r1" });
    o.store.addStatus({ id: "r1", category: "review", label: "R1" });
    await o.sync();
    o.store.removeStatus("r1");
    o.store.addStatus({ id: "r1", category: "review", label: "R1 again" });
    o.store.updateIssue(rep.id, { status: "r1" });
    await o.sync();
    // As an older applier left it: no record that a newer one has looked.
    o.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    const status = (machine: { db: DatabaseSync }): unknown =>
      machine.db.prepare("SELECT s.label, i.status FROM issues i LEFT JOIN workspace_statuses s ON s.id = i.status WHERE i.id = ?").get(rep.id);
    const version = (machine: { db: DatabaseSync }): unknown =>
      machine.db.prepare("SELECT value FROM meta WHERE key = 'sync_applier_version'").get();

    // Upgraded while the older Worker serves: nothing is re-read, nothing is lost.
    expect((await o.sync()).caughtUp).toBeNull();
    expect(status(o)).toEqual({ label: "R1 again", status: "r1" });
    expect(version(o)).toBeUndefined();
    // A device that hydrates in that window gets what the older fold says, and owes a re-read.
    const d2 = fleet.machine("d2");
    await d2.sync();
    expect(version(d2)).toBeUndefined();

    // The new Worker is deployed on the same log. Both repair, once.
    server.legacyFold = false;
    expect((await o.sync()).caughtUp).not.toBeNull();
    expect((await d2.sync()).caughtUp).not.toBeNull();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [o, d2, fresh]) {
      expect(status(machine), machine.label).toEqual({ label: "R1 again", status: "r1" });
      expect(version(machine), machine.label).toEqual({ value: "2" });
    }
    expect((await o.sync()).caughtUp).toBeNull();
    expect((await d2.sync()).caughtUp).toBeNull();
  });

  it("is not re-read when this build hydrated it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "First" });
    await a.sync();
    const v = fleet.machine("v");
    expect((await v.sync()).caughtUp).toBeNull();
    expect((await v.sync()).caughtUp).toBeNull();
  });
});
