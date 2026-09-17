/**
 * An issue's create sent again after a restore leaves its blocker set as the log holds it
 * (`docs/sync.md`, "A restore rewinds").
 *
 * A create carries the blockers the issue was made with. A device whose create reached the log
 * with its answer lost sends it again, as it is, into the epoch a restore makes. The log's fold
 * keeps the issue and its blocker set apart, and a fresh device applies the set after the issue —
 * but read from the tail, the create came after the set and replaced it on every device.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d7e0";

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

const answerLost = (server: FakeSyncServer): typeof fetch => async (input, init) => {
  const response = await server.fetch(input, init);
  if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
  return response;
};

const edges = (machine: Machine, blocked: string): string[] =>
  (machine.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ? AND type = 'blocks' ORDER BY blocker_id").all(blocked) as Array<{ blocker_id: string }>).map(
    (row) => row.blocker_id,
  );

describe("a create sent again after a restore", () => {
  it("does not replace a blocker set the log holds after it", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);

    // b's create lands, its answer does not.
    b.use();
    const issue = b.store.createIssue({ title: "I" });
    await b.sync({ fetchImpl: answerLost(server), attempts: 1 } as never).catch(() => undefined);
    // a blocks it on J, and backs up.
    a.use();
    await a.sync();
    const j = a.store.createIssue({ title: "J" });
    a.store.setBlockedBy(issue.id, [j.id], "a");
    await a.sync();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });

    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    for (const machine of [a, b, fresh]) expect(edges(machine, issue.id), machine.label).toEqual([j.id]);
    const want = stateOf(fresh.db);
    expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  }, 60_000);

  it("keeps a set the restorer has still to send", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    // Made while connected: each create carries its blockers.
    const [issue, j] = ["I", "J"].map((title) => a.store.createIssue({ title }));
    await a.sync();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    const b = fleet.machine("b");
    await sync(b);

    // a blocks I on J offline, and restores before it is sent.
    a.use();
    a.store.setBlockedBy(issue!.id, [j!.id], "a");
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    // The read, with the push after it lost: the set is a's still, not only once its echo lands.
    let read = false;
    const pushLost: typeof fetch = async (input, init) => {
      if (String(input).includes("/snapshot")) read = true;
      if (read && (init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
      return server.fetch(input, init);
    };
    await a.sync({ fetchImpl: pushLost, attempts: 1 } as never).catch(() => undefined);
    expect(read).toBe(true);
    expect(edges(a, issue!.id)).toEqual([j!.id]);
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    for (const machine of [a, b, fresh]) expect(edges(machine, issue!.id), machine.label).toEqual([j!.id]);
  }, 60_000);

  it("decides the blockers again when the restore rewound the set", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const j = a.store.createIssue({ title: "J" });
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });

    // After the backup: b makes I blocked on J, its answer lost; a clears the set.
    b.use();
    const issue = b.store.createIssue({ title: "I", blockedBy: [j.id] });
    await b.sync({ fetchImpl: answerLost(server), attempts: 1 } as never).catch(() => undefined);
    a.use();
    await a.sync();
    a.store.setBlockedBy(issue.id, [], "a");
    await a.sync();

    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    for (const machine of [a, b, fresh]) expect(edges(machine, issue.id), machine.label).toEqual([j.id]);
    const want = stateOf(fresh.db);
    expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  }, 60_000);
});
