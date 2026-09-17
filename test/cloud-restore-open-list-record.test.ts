/**
 * A record about a list, open across a restore that removed an issue one side of it names, can
 * still be resolved either way (`docs/sync.md`, "A restore rewinds").
 *
 * The rewind removes an issue pushed after the backup, and closes the records about it. A record
 * about the plan or a milestone's members is about the list, not the issue, so it stayed open with
 * the removed issue in one side — and resolving to that side failed for ever, on an issue that no
 * device holds any more ("referent not present yet"). Now the rewind takes what it removed out of
 * both sides of such a record, as it takes it out of the list itself; a record whose two sides
 * then agree has nothing left to ask, and closes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d3e0";

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

describe("a list record open across a restore that removed an issue it names", () => {
  for (const what of ["queue", "milestone"] as const) {
    for (const choice of ["remote", "local", "both made later"] as const) {
      it(`resolves, and every device agrees (${what}, ${choice})`, async () => {
        const server = new FakeSyncServer({ repositoryId: REPO });
        fleet = new Fleet(server, REPO);
        const a = fleet.machine("a");
        a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
        const [x, y] = ["X", "Y"].map((title) => a.store.createIssue({ title }));
        a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "a");
        const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
        const add = (machine: Machine, issue: string): void => {
          machine.use();
          if (what === "queue") machine.store.queue().enqueue(issue, {}, machine.label);
          else machine.store.milestones().addMember(m, issue, {}, machine.label);
        };
        add(a, x!.id);
        await a.sync();
        const b = fleet.machine("b");
        await sync(b);
        b.use();
        await setBackupConsent(b.home, REPO, true, { fetchImpl: server.fetch });
        const backup = await createBackup(b.home, REPO, null, { fetchImpl: server.fetch });

        // After the backup: b adds an issue it makes; a adds one the backup holds, or one it makes.
        b.use();
        const later = b.store.createIssue({ title: "Later" });
        add(b, later.id);
        a.use();
        add(a, choice === "both made later" ? a.store.createIssue({ title: "Later on a" }).id : y!.id);
        await sync(b, a);
        expect(open(a).map((record) => record.field)).toEqual([what === "queue" ? "order" : "members"]);

        b.use();
        await restoreFromBackup(b.db, b.home, REPO, backup.backupId, { fetchImpl: server.fetch });
        await sync(b, a);
        // Both sides named only what the rewind removed: nothing is left to ask.
        if (choice === "both made later") expect(open(a)).toEqual([]);
        for (let record = open(a)[0]; record; record = open(a)[0]) {
          resolveConflict(a.db, { id: record.id, choice: choice === "local" ? "local" : "remote", actor: "person" });
        }
        await sync(a, b, a, b);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        const want = stateOf(fresh.db);
        expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
        for (const machine of [a, b, fresh]) expect(open(machine), machine.label).toEqual([]);
      }, 60_000);
    }
  }
});
