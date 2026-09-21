/**
 * A revision the log renumbered keeps saying so on the device that wrote it, across a restore it
 * made before hearing back (`docs/sync.md`, "Two revisions written as one number").
 *
 * The device's r1 reached the log after another device's r1, and the log placed it at r2 with a
 * summary saying why; the answer was lost, so the device still held it as its own r1. It restored
 * a backup holding both. Reading the epoch, it set its own aside to r2 for the log's r1 — and, the
 * revision still its own and unreached, kept its own summary there: none. Every other device, and
 * a fresh one, said it was renumbered from r1.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d4e0";

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

describe("a revision renumbered by the log while its writer did not hear back", () => {
  it("says so on the writer after its own restore, as everywhere", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const issue = a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);

    b.use();
    b.store.putDocument(issue.id, "spec", "b's spec", { author: "b" });
    await b.sync();
    a.use();
    a.store.putDocument(issue.id, "spec", "a's spec", { author: "a" });
    // a's r1 lands after b's, and the answer is lost.
    const answerLost: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
      return response;
    };
    await a.sync({ fetchImpl: answerLost, attempts: 1 } as never).catch(() => undefined);

    b.use();
    await sync(b);
    await setBackupConsent(b.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(b.home, REPO, null, { fetchImpl: server.fetch });

    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    const summary = (machine: Machine) =>
      machine.db.prepare("SELECT revision, change_summary FROM document_revisions WHERE body = ?").get("a's spec") as { revision: number; change_summary: string | null };
    expect(summary(fresh).revision).toBe(2);
    expect(summary(fresh).change_summary).toMatch(/^renumbered from r1 to r2/);
    const want = stateOf(fresh.db);
    expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  }, 60_000);

  // Another revision of the writer's in the way: its renumbered one is moved to where the log put
  // it, rather than found there.
  it("says so when the writer moves it there past a later one of its own", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const issue = a.store.createIssue({ title: "Shared" });
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);

    b.use();
    b.store.putDocument(issue.id, "spec", "b's spec", { author: "b" });
    await b.sync();
    a.use();
    a.store.putDocument(issue.id, "spec", "a's spec", { author: "a" });
    const answerLost: typeof fetch = async (input, init) => {
      const response = await server.fetch(input, init);
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
      return response;
    };
    await a.sync({ fetchImpl: answerLost, attempts: 1 } as never).catch(() => undefined);
    a.store.putDocument(issue.id, "spec", "a's second spec", { author: "a" });

    b.use();
    await sync(b);
    await setBackupConsent(b.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(b.home, REPO, null, { fetchImpl: server.fetch });
    await restoreFromBackup(b.db, b.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(b, a, b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    const want = stateOf(fresh.db);
    expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  }, 60_000);
});
