/**
 * The found-in relation across devices: a finding's origin (on the issue's origin columns) and
 * the edge a blocker adds to its scope reach a second device and a freshly hydrated one, an
 * idempotent create replayed on either device adds nothing, and two devices filing blockers
 * against the same origin offline both keep their edge.
 *
 * Every device is real (`fixtures/sync-machines.ts`), against the fake service that folds the
 * log as the Worker does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000f1d0";

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

function converged(writer: Machine, ...others: Machine[]): void {
  const want = stateOf(writer.db);
  expect(others.flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
}

const blockers = (machine: Machine, id: string): string[] =>
  (machine.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ? AND type = 'blocks' ORDER BY blocker_id").all(id) as Array<{ blocker_id: string }>).map(
    (row) => row.blocker_id,
  );

describe("a finding across devices", () => {
  it("reaches a second device and a fresh one with its origin and its blocker edge, and a replayed create adds nothing", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const origin = a.store.createIssue({ title: "Origin" });
    const blocker = a.store.createIssueResult({ title: "Blocker finding", foundIn: origin.id, blocks: true, idempotencyKey: "finding-1", createdBy: "eng" }).issue;
    const followUp = a.store.createIssue({ title: "Follow-up finding", foundIn: origin.id });
    await sync(a, b);

    const findings = [
      { identifier: blocker.identifier, title: "Blocker finding", status: "backlog", disposition: "blocker" },
      { identifier: followUp.identifier, title: "Follow-up finding", status: "backlog", disposition: "follow-up" },
    ];
    b.use();
    expect(b.store.context(origin.id).findings).toEqual(findings);
    expect(b.store.context(followUp.id).foundIn).toEqual({ identifier: origin.identifier, title: "Origin", status: "backlog", disposition: "follow-up" });
    expect(blockers(b, origin.id)).toEqual([blocker.id]);

    // The same create, replayed by its key on either device, returns the original and writes nothing.
    for (const machine of [a, b]) {
      machine.use();
      const again = machine.store.createIssueResult({ title: "Blocker finding", foundIn: origin.id, blocks: true, idempotencyKey: "finding-1", createdBy: "eng" });
      expect(again.replayed, machine.label).toBe(true);
      expect(again.issue.id, machine.label).toBe(blocker.id);
    }
    await sync(a, b, a);

    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      machine.use();
      expect(machine.store.context(origin.id).findings, machine.label).toEqual(findings);
      expect(blockers(machine, origin.id), machine.label).toEqual([blocker.id]);
      expect(machine.db.prepare("SELECT COUNT(*) AS n FROM issues WHERE origin_kind = 'finding'").get(), machine.label).toEqual({ n: 2 });
      expect(listConflicts(machine.db), machine.label).toEqual([]);
    }
    converged(a, b, fresh);
  }, 60_000);

  it("two devices filing blockers against the same origin offline both keep their edge everywhere", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const origin = a.store.createIssue({ title: "Origin" });
    const earlier = a.store.createIssue({ title: "Earlier blocker" });
    a.store.setBlockedBy(origin.id, [earlier.id], "vp");
    await sync(a, b);

    a.use();
    const fromA = a.store.createIssue({ title: "Found on A", foundIn: origin.id, blocks: true });
    b.use();
    const fromB = b.store.createIssue({ title: "Found on B", foundIn: origin.id, blocks: true });
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    const want = [earlier.id, fromA.id, fromB.id].sort();
    for (const machine of [a, b, fresh]) {
      machine.use();
      expect(blockers(machine, origin.id), machine.label).toEqual(want);
      expect(machine.store.context(origin.id).findings.map((f) => f.disposition), machine.label).toEqual(["blocker", "blocker"]);
    }
    converged(a, b, fresh);
  }, 60_000);

  it("a set cleared on one device before a blocker filed offline on another: the finding's later create keeps its edge everywhere", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const origin = a.store.createIssue({ title: "Origin" });
    const earlier = a.store.createIssue({ title: "Earlier blocker" });
    a.store.setBlockedBy(origin.id, [earlier.id], "vp");
    await sync(a, b);
    b.use();
    b.store.setBlockedBy(origin.id, [], "vp");
    await sync(b);
    a.use();
    const finding = a.store.createIssue({ title: "Filed offline", foundIn: origin.id, blocks: true });
    // A pulls B's clear (earlier in the log) before its own create comes back.
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) expect(blockers(machine, origin.id), machine.label).toEqual([finding.id]);
    converged(a, b, fresh);
  }, 60_000);

  it("a set cleared after the blocker was filed removes its edge everywhere, a fresh device included", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const origin = a.store.createIssue({ title: "Origin" });
    const finding = a.store.createIssue({ title: "Blocker", foundIn: origin.id, blocks: true });
    await sync(a, b);
    b.use();
    b.store.setBlockedBy(origin.id, [], "vp");
    await sync(b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      machine.use();
      expect(blockers(machine, origin.id), machine.label).toEqual([]);
      // Still found there: the relation outlives the edge, and reads as a follow-up now.
      expect(machine.store.context(finding.id).foundIn?.disposition, machine.label).toBe("follow-up");
    }
    converged(a, b, fresh);
  }, 60_000);
});
