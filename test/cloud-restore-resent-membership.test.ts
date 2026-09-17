/**
 * A membership sent again into the epoch a restore made lands on a device that rewound its rows
 * (`docs/sync.md`, "A restore rewinds").
 *
 * A device's member add reached the log, its answer did not, and a restore rewound it: the device
 * sends it again into the new epoch, under its old base version. A device that had applied it
 * before the restore rewound the milestone to no members, and still counted that operation in its
 * version — so the one sent again read as behind, and an ordered collection is contested by the
 * version alone when nothing here says who wrote it. Against a list nobody here wrote, it recorded
 * a conflict and withheld the list, which a fresh device holds.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d6e0";

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

describe("a member add sent again after a restore", () => {
  for (const what of ["milestone", "queue"] as const) {
    it(`lands on a device that had applied it and rewound (${what})`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      await a.sync();
      a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
      const x = a.store.createIssue({ title: "X" });
      a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "a");
      const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
      await a.sync();
      const b = fleet.machine("b");
      const c = fleet.machine("c");
      await sync(b, c);
      a.use();
      await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
      const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });

      // b's add lands, its answer does not; c applies it.
      b.use();
      if (what === "milestone") b.store.milestones().addMember(m, x.id, {}, "b");
      else b.store.queue().enqueue(x.id, {}, "b");
      const answerLost: typeof fetch = async (input, init) => {
        const response = await server.fetch(input, init);
        if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
        return response;
      };
      await b.sync({ fetchImpl: answerLost, attempts: 1 } as never).catch(() => undefined);
      await sync(c);

      a.use();
      await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
      // c rewinds first, then b sends its add again, then c reads it.
      await sync(a, c, b, c, a, b);
      const fresh = fleet.machine("fresh");
      await sync(fresh);

      const want = stateOf(fresh.db);
      expect([a, b, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
      for (const machine of [a, b, c, fresh]) expect(open(machine), machine.label).toEqual([]);
    }, 60_000);
  }
});

describe("a member add a restore rewound", () => {
  // Its operation stays in the outbox, acknowledged. Replayed as this device's provenance after
  // the read, it went on claiming a membership the device no longer held, and contested a
  // membership written into the new epoch by a device that had never seen it.
  it("claims nothing against a membership written after the restore", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
    const [x, y] = ["X", "Y"].map((title) => a.store.createIssue({ title }));
    a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "a");
    const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    a.store.milestones().addMember(m, x!.id, {}, "a");
    await a.sync();

    // b never saw a's add: restored, rewound, and b adds Y into the new epoch.
    b.use();
    await setBackupConsent(b.home, REPO, true, { fetchImpl: server.fetch });
    await restoreFromBackup(b.db, b.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(b, a);
    expect(a.db.prepare("SELECT count(*) AS n FROM milestone_members").get()).toEqual({ n: 0 });
    b.use();
    b.store.milestones().addMember(m, y!.id, {}, "b");
    await sync(b, a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    const want = stateOf(fresh.db);
    expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    for (const machine of [a, b, fresh]) expect(open(machine), machine.label).toEqual([]);
  }, 60_000);
});
