/**
 * An issue put on a stand-in again after a restore is on the record again, and takes its number
 * back when it is freed (`docs/sync.md`, "Identifiers and other unique values").
 *
 * A stand-in's record is one per issue (`identifier:<id>`). A device that had held an issue on a
 * stand-in, and seen the record closed by the settlement, read a restore that rewound the
 * settlement: the issue went back on a stand-in, and the record — closed already — was not opened
 * again. When the number's holder settled elsewhere, nothing asked for the number, and the issue
 * stayed on its stand-in on that device, where a fresh device holds the number.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d8e0";

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

const identifier = (machine: Machine, id: string): string | undefined => (machine.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as { identifier: string } | undefined)?.identifier;

describe("a stand-in a restore brings back", () => {
  it("is on the record again, and takes the number when it is freed", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const [a, b, c] = ["a", "b", "c"].map((label) => fleet!.machine(label)) as [Machine, Machine, Machine];
    await sync(a, b, c);

    // a's TRA-1 lands first, its answer lost; b's TRA-1 lands after it.
    a.use();
    const first = a.store.createIssue({ title: "a's" });
    const answerLost: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
      return response;
    };
    await a.sync({ fetchImpl: answerLost, attempts: 1 } as never).catch(() => undefined);
    b.use();
    const second = b.store.createIssue({ title: "b's" });
    expect(second.identifier).toBe(first.identifier);
    await b.sync({ fetchImpl: answerLost, attempts: 1 } as never).catch(() => undefined);

    // A backup holds both claims and no settlement.
    c.use();
    await c.sync();
    await setBackupConsent(c.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(c.home, REPO, null, { fetchImpl: server.fetch });
    // b settles, and c sees the record about b's issue closed.
    await sync(b, c, b, c);
    expect(identifier(c, second.id)).not.toBe(first.identifier);

    // a, whose claim was first and whose answer was lost, restores the backup.
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    // c reads the epoch first: b's issue waits on a stand-in, on the record again.
    await sync(c);
    expect(identifier(c, second.id)?.startsWith(`${first.identifier}+`)).toBe(true);
    expect(listConflicts(c.db).filter((record) => record.resolvedAt === null && record.entityId === second.id)).toHaveLength(1);
    // a sends its claim again, later in the log now, and settles elsewhere; c gives b's issue the number.
    for (let pass = 0; pass < 3; pass += 1) await sync(a, c, b);
    expect(identifier(c, second.id)).toBe(first.identifier);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    const want = stateOf(fresh.db);
    expect([a, b, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    for (const machine of [a, b, c, fresh]) {
      expect(listConflicts(machine.db).filter((record) => record.resolvedAt === null), machine.label).toEqual([]);
    }
  }, 60_000);
});
