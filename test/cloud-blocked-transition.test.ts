/**
 * When an issue entered its current blocked cycle is the same on every device.
 *
 * `blocked_transition_at` is written by every transition into or out of a blocked status,
 * and it keys the one wake per blocked cycle (`blockersResolvedDedupKey`) and is on every
 * issue `get_task` returns. It was excluded from replication as "local timing state", so
 * a device that learned of the transition by sync held whatever it held before — null, or
 * an earlier cycle's time — and devices disagreed about it on real data. It travels now,
 * with the transition that sets it.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000160";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function blockedAt(db: DatabaseSync, id: string): unknown {
  return db.prepare("SELECT status, blocked_transition_at FROM issues WHERE id = ?").get(id);
}

describe("an issue's blocked cycle", () => {
  it("begins and ends at the same moment on every device, a derived one included", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const parent = a.store.createIssue({ title: "The epic" });
    const child = a.store.createIssue({ title: "Its only child", parent: parent.identifier });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    a.store.updateIssue(child.id, { status: "blocked", unblockOwner: "ops", unblockAction: "grant access" });
    const onA = blockedAt(a.db, child.id) as { blocked_transition_at: string | null };
    expect(onA.blocked_transition_at).not.toBeNull();
    // The epic's only child is blocked, so the epic is too: a derived transition.
    expect((blockedAt(a.db, parent.id) as { status: string }).status).toBe("blocked");
    await a.sync();
    await b.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [b, fresh]) {
      expect(blockedAt(machine.db, child.id), machine.label).toEqual(blockedAt(a.db, child.id));
      expect(blockedAt(machine.db, parent.id), machine.label).toEqual(blockedAt(a.db, parent.id));
    }

    // Moved out of blocked concurrently on two devices: the status is the disagreement, and
    // the cycle's end — null on both — is not. (Two moves INTO blocked at two moments would
    // be a record of their own, both kept, like any field two devices wrote differently.)
    b.store.updateIssue(child.id, { status: "todo" });
    a.store.updateIssue(child.id, { status: "backlog" });
    await b.sync();
    await a.sync();
    expect(listConflicts(a.db).filter((conflict) => conflict.entityId === child.id).map((conflict) => conflict.field)).toEqual(["status"]);
    for (const conflict of listConflicts(a.db).filter((record) => record.resolvedAt === null)) {
      a.use();
      resolveConflict(a.db, { id: conflict.id, choice: "local", actor: "alice" });
    }

    a.store.updateIssue(child.id, { status: "todo" });
    await a.sync();
    await b.sync();
    await fresh.sync();
    expect(blockedAt(a.db, child.id)).toEqual({ status: "todo", blocked_transition_at: null });
    for (const machine of [b, fresh]) {
      expect(blockedAt(machine.db, child.id), machine.label).toEqual(blockedAt(a.db, child.id));
      expect(blockedAt(machine.db, parent.id), machine.label).toEqual(blockedAt(a.db, parent.id));
    }
  });
});
