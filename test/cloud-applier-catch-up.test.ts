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
