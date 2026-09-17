/**
 * RR2. What was set aside is never replayed over a newer write (`quarantine.ts`, `docs/sync.md`
 * "No entity can stop a sync").
 *
 * An older build sends a blocker set, the plan or a milestone's members naming an issue whose
 * create is not in the log yet, and every other device sets it aside. Another device then
 * writes the same set, and afterwards the missing create arrives. Retried then, the set-aside
 * write landed OVER the later one on a device that had it waiting, while the service's fold and
 * a fresh device held the later one: in log order the later write wins, and it did not here.
 * Now a set-aside write is retried only for the fields nothing has written since it was set
 * aside; what a later write replaced is dropped, as the log's order would have dropped it — on
 * the tail and when it was set aside from a snapshot.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { countQuarantined } from "../src/core/cloud/quarantine.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000a7b0";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const issueCreate = (identifier: string, title: string) => ({
  identifier,
  title,
  normalizedTitle: title.toLowerCase(),
  status: "backlog",
  kind: "task",
  priority: "medium",
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
});

describe("a write set aside, and a later write of the same thing", () => {
  for (const variant of ["tail", "snapshot"] as const) {
    for (const what of ["relation", "queue", "milestone"] as const) {
      it(`keeps the later ${what} on every device, set aside from the ${variant}`, async () => {
        const server = new FakeSyncServer({ repositoryId: REPO });
        fleet = new Fleet(server, REPO);
        const a = fleet.machine("a");
        a.store.addKind({ id: "milestone", label: "Milestone" }, "alice");
        const e1 = a.store.createIssue({ title: "E1" });
        const e2 = a.store.createIssue({ title: "E2" });
        a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "alice");
        const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
        await a.sync();
        const b = fleet.machine("b");
        await b.sync();

        // An older build writes the set, naming X, whose create is not in the log.
        const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
        const older = new OlderBuildDevice(server, REPO, "device-older", schema);
        const x = randomUUID();
        const now = new Date().toISOString();
        if (what === "relation") await older.push([{ entity: "relation", entityId: e1.id, verb: "update", payload: { blockedBy: [x], edges: { [x]: { createdBy: "older", createdAt: now } } } }]);
        if (what === "queue") await older.push([{ entity: "queue", entityId: "@plan", verb: "replace", payload: { order: [x], entries: { [x]: { addedBy: "older", addedAt: now, note: null } } } }]);
        if (what === "milestone") await older.push([{ entity: "milestone", entityId: m, verb: "replace", payload: { members: [x], entries: { [x]: { addedBy: "older", addedAt: now, note: null } } } }]);
        // Joined now, it sets the write aside from its snapshot.
        const s = variant === "snapshot" ? fleet.machine("s") : null;
        if (s) await s.sync();

        // A writes the same set after it, and then X's create arrives.
        a.use();
        await a.sync();
        if (what === "relation") a.store.setBlockedBy(e1.id, [e2.id], "alice");
        if (what === "queue") a.store.queue().enqueue(e2.id, {}, "alice");
        if (what === "milestone") a.store.milestones().addMember(m, e2.id, {}, "alice");
        await a.sync();
        await older.push([{ entity: "issue", entityId: x, verb: "create", payload: issueCreate("OLD-9", "X") }]);
        const machines: Machine[] = s ? [a, b, s, a, b, s] : [a, b, a, b];
        for (const machine of machines) {
          machine.use();
          await machine.sync();
        }
        const fresh = fleet.machine("fresh");
        await fresh.sync();

        const want = stateOf(fresh.db);
        const devices = s ? [a, b, s] : [a, b];
        expect(devices.flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
        const names = (machine: Machine, sql: string, ...params: string[]): string[] =>
          (machine.db.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => (row.id === x ? "X" : row.id === e2.id ? "E2" : row.id));
        for (const machine of [...devices, fresh]) {
          if (what === "relation") expect(names(machine, "SELECT blocker_id AS id FROM relations WHERE blocked_id = ?", e1.id), machine.label).toEqual(["E2"]);
          if (what === "queue") expect(names(machine, "SELECT issue_id AS id FROM queue_entries ORDER BY rank"), machine.label).toEqual(["E2"]);
          if (what === "milestone") {
            expect(names(machine, "SELECT issue_id AS id FROM milestone_members WHERE milestone_id = ? ORDER BY rank", m), machine.label).toEqual(["E2"]);
            expect(machine.db.prepare("SELECT target_date FROM milestone_meta WHERE issue_id = ?").get(m), machine.label).toEqual({ target_date: "2026-12-01" });
          }
          expect(countQuarantined(machine.db), machine.label).toBe(0);
        }
      }, 60_000);
    }
  }
});
