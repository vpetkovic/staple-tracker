/**
 * A decision stamps the entity it decides with the decision's time on every device (`docs/sync.md`,
 * "Conflicts are preserved, never resolved silently").
 *
 * The resolving write carried `updatedAt`; the decision that closes the record on every other
 * device did not, and a device that already held the decided value — a renumber is applied while
 * a record about the number is open — skipped it. That device kept its own `updated_at` where a
 * fresh device held the decision's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyConflictOperation, listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000d5e0";

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

const open = (machine: Machine) => listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null);

describe("a decision about an issue's title", () => {
  it("carries the time the resolving write stamps", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const issue = a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);
    a.use();
    a.store.updateIssue(issue.id, { title: "A's" }, "a");
    b.use();
    b.store.updateIssue(issue.id, { title: "B's" }, "b");
    await sync(b, a);
    a.use();
    resolveConflict(a.db, { id: open(a)[0]!.id, choice: "remote", actor: "person" });
    await a.sync();

    const write = server.ops.find((op: any) => op.entity === "issue" && op.entityId === issue.id && op.payload.title === "B's" && op.deviceId !== b.deviceId) as any;
    const decision = server.ops.find((op: any) => op.entity === "conflict") as any;
    expect(typeof write?.payload.updatedAt).toBe("string");
    expect(decision?.payload.updatedAt).toBe(write.payload.updatedAt);
  }, 60_000);

  it("stamps a device that already holds the decided value", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const issue = a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);
    a.use();
    a.store.updateIssue(issue.id, { title: "A's" }, "a");
    b.use();
    b.store.updateIssue(issue.id, { title: "B's" }, "b");
    await sync(b, a);
    const [record] = open(a);
    expect(record).toBeDefined();

    const at = "2030-01-01T00:00:00.000Z";
    applyConflictOperation(a.db, {
      opId: "decision-1",
      seq: 99,
      epoch: 1,
      protocol: 2,
      schema: 1,
      entity: "conflict",
      entityId: record!.id,
      verb: "update",
      baseVersion: null,
      payload: { resolvedAt: at, resolvedBy: "person", value: "A's", entity: "issue", targetId: issue.id, field: "title", updatedAt: at },
      deviceId: "device-b",
      actor: "person",
      clientSeq: 1,
      createdAt: at,
      serverTs: 0,
    });
    expect(open(a)).toEqual([]);
    expect(a.db.prepare("SELECT title, updated_at FROM issues WHERE id = ?").get(issue.id)).toEqual({ title: "A's", updated_at: at });
  }, 60_000);
});
