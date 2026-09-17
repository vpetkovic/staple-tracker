/**
 * A resolved status leaves `status_version` the same on every device (`docs/sync.md`,
 * "Conflicts are preserved, never resolved silently").
 *
 * `status_version` is derived from `status`: withheld with it while a record is open, and
 * carried with every status write as the token a receiver checks against. A resolution wrote the
 * status alone, so the device that resolved kept the token it held while a fresh device took the
 * last one the log carried — and a device closing its own record by the decision kept its own.
 */
import { afterEach, describe, expect, it } from "vitest";
import { applyConflictOperation, listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d2e0";

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

const open = (machine: Machine) => listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null && conflict.field === "status");

describe("a status two devices changed offline, resolved", () => {
  for (const choice of ["remote", "local"] as const) {
    for (const resolver of ["first", "second"] as const) {
      it(`holds one status_version everywhere (${choice}, resolved by the ${resolver} to push)`, async () => {
        const server = new FakeSyncServer({ repositoryId: REPO });
        fleet = new Fleet(server, REPO);
        const a = fleet.machine("a");
        const issue = a.store.createIssue({ title: "Shared" });
        await a.sync();
        const b = fleet.machine("b");
        const c = fleet.machine("c");
        await sync(b, c);

        // Different numbers of status changes on each side, and a third device with its own.
        a.use();
        a.store.updateIssue(issue.id, { status: "blocked" }, "a");
        a.store.updateIssue(issue.id, { status: "backlog" }, "a");
        b.use();
        b.store.updateIssue(issue.id, { status: "todo" }, "b");
        c.use();
        c.store.updateIssue(issue.id, { status: "todo" }, "c");
        c.store.updateIssue(issue.id, { status: "backlog" }, "c");
        c.store.updateIssue(issue.id, { status: "todo" }, "c");
        c.store.updateIssue(issue.id, { status: "backlog" }, "c");
        c.store.updateIssue(issue.id, { status: "cancelled" }, "c");
        await sync(b, a, c, b, a);
        const deciding = resolver === "first" ? b : a;
        expect(open(deciding).length).toBeGreaterThan(0);
        expect(open(c).length).toBeGreaterThan(0);

        deciding.use();
        // Each record it holds about the status, one at a time: one against each other device.
        for (let record = open(deciding)[0]; record; record = open(deciding)[0]) resolveConflict(deciding.db, { id: record.id, choice, actor: "person" });
        for (let pass = 0; pass < 3; pass += 1) await sync(deciding, a, b, c);
        // Every status record closed by that one decision, each device holds the status and the
        // token a device joining now holds.
        for (const machine of [a, b, c]) expect(open(machine), machine.label).toEqual([]);
        const probe = fleet.machine("probe");
        await sync(probe);
        const token = (machine: Machine) => machine.db.prepare("SELECT status, status_version FROM issues WHERE id = ?").get(issue.id);
        for (const machine of [a, b, c]) expect(token(machine), machine.label).toEqual(token(probe));
        for (const machine of [a, b, c]) {
          machine.use();
          // Whatever else is still asked about, as a person would answer it.
          // One at a time: a decision closes the other records about the same field.
          for (let record = listConflicts(machine.db).find((k) => k.resolvedAt === null); record; record = listConflicts(machine.db).find((k) => k.resolvedAt === null)) {
            resolveConflict(machine.db, { id: record.id, choice: "remote", actor: "person" });
          }
        }
        for (let pass = 0; pass < 3; pass += 1) await sync(a, b, c);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        const want = stateOf(fresh.db);
        expect([a, b, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
      }, 60_000);
    }
  }
});

describe("a decision closing a status record here", () => {
  // Even where the decided status already stands: the token is the decision's, not this device's.
  it("writes the token it carries", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const issue = a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);
    a.use();
    a.store.updateIssue(issue.id, { status: "todo" }, "a");
    b.use();
    b.store.updateIssue(issue.id, { status: "cancelled" }, "b");
    await sync(b, a);
    const [record] = open(a);
    expect(record).toBeDefined();

    const at = new Date().toISOString();
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
      payload: { resolvedAt: at, resolvedBy: "person", value: "todo", entity: "issue", targetId: issue.id, field: "status", statusVersion: 42 },
      deviceId: "device-b",
      actor: "person",
      clientSeq: 1,
      createdAt: at,
      serverTs: 0,
    });
    expect(open(a)).toEqual([]);
    expect(a.db.prepare("SELECT status, status_version FROM issues WHERE id = ?").get(issue.id)).toEqual({ status: "todo", status_version: 42 });
  }, 60_000);
});
