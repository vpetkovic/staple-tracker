/**
 * The one-shot milestone repair on a synchronized workspace (`docs/milestones.md`).
 *
 * The repair re-derives every milestone from the members this device holds. On a device that
 * reached the head of the log long ago and has not pulled since, those members are stale: run
 * at its first write, the repair derived from them and pushed a status every other device
 * already knew to be old — a regression on a fresh device, and a conflict on the device that
 * wrote the real move. So a synchronized workspace runs the repair after a pull has reached
 * the head, in the sync that pulled it, and never at a write.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { performDisconnect } from "../src/core/cloud/connect.js";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { beginBootstrap } from "../src/core/cloud/sync-state.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENDPOINT } from "./fixtures/sync-machines.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d3e1";
const STAMP = "milestone_status_rederived";

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

/** The database as the build before the repair left it: no stamp. */
const upgrade = (machine: Machine): void => void machine.db.prepare("DELETE FROM meta WHERE key = ?").run(STAMP);
const status = (machine: Machine, id: string): string =>
  (machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(id) as { status: string }).status;
const statusChanges = (machine: Machine, id: string): number =>
  (machine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE issue_id = ? AND kind = 'status_changed'").get(id) as { n: number }).n;

/** A milestone M holding T, T in progress, M left at `backlog` as an older build left it. */
async function staleFleet(): Promise<{ a: Machine; b: Machine; m: string; t: string }> {
  fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
  const a = fleet.machine("a");
  await a.sync();
  a.use();
  a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
  const t = a.store.createIssue({ title: "T" }).id;
  const view = a.store.milestones().create({ title: "M" }, "a") as { milestone: { identifier: string } };
  const m = a.store.getIssue(view.milestone.identifier).id;
  a.store.milestones().addMember(m, t, {}, "a");
  a.store.updateIssue(t, { assignee: "a" }, "a");
  a.store.updateIssue(t, { status: "in_progress" }, "a");
  a.store.updateIssue(m, { status: "backlog" }, "a");
  await a.sync();
  // b joins on the build before the repair: nothing re-derives M on its way in.
  const b = fleet.machine("b");
  b.db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(STAMP);
  await sync(b);
  expect([status(a, m), status(b, m)]).toEqual(["backlog", "backlog"]);
  return { a, b, m, t };
}

describe("the milestone repair on a synchronized workspace", () => {
  it("does not push a regression from a device whose last pull is old", async () => {
    const { a, b, m, t } = await staleFleet();
    upgrade(a);
    a.use();
    a.store.updateIssue(t, { status: "done" }, "a");
    expect(status(a, m)).toBe("done");
    await sync(a);

    // b reached the head before a's move, and is upgraded without pulling.
    upgrade(b);
    b.use();
    b.store.addComment(t, "written before b pulls", "b");
    await sync(b, a, b);
    const fresh = fleet!.machine("fresh");
    await sync(fresh);

    expect([status(a, m), status(b, m), status(fresh, m)]).toEqual(["done", "done", "done"]);
    expect(listConflicts(a.db)).toEqual([]);
    expect(listConflicts(b.db)).toEqual([]);
    const want = stateOf(fresh.db);
    expect([...differences("a", want, stateOf(a.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
  });

  it("repairs in the sync that reached the head, and a second device finds nothing left to move", async () => {
    const { a, b, m } = await staleFleet();
    const before = [statusChanges(a, m), statusChanges(b, m)];
    upgrade(a);
    upgrade(b);
    // A write repairs nothing on a synchronized workspace.
    a.use();
    a.store.addComment(m, "a write", "a");
    expect(status(a, m)).toBe("backlog");
    await sync(a);
    expect(status(a, m)).toBe("in_progress");
    expect(a.db.prepare("SELECT value FROM meta WHERE key = ?").get(STAMP)).toBeDefined();

    // b pulls a's repair before its own runs: one move on every timeline, not two.
    await sync(b, a);
    expect(status(b, m)).toBe("in_progress");
    expect([statusChanges(a, m) - before[0]!, statusChanges(b, m) - before[1]!]).toEqual([1, 1]);
  });

  it("does not repair at a write once disconnected: a workspace that has synchronized repairs only in a sync", async () => {
    const { b, m } = await staleFleet();
    upgrade(b);
    b.use();
    expect(performDisconnect(b.home, REPO)).toMatchObject({ wasConnected: true, recordRemoved: true });
    b.store.addComment(m, "after disconnecting", "b");
    // The known limitation: a workspace disconnected for good keeps what the old build left.
    expect(status(b, m)).toBe("backlog");
    expect(b.db.prepare("SELECT value FROM meta WHERE key = ?").get(STAMP)).toBeUndefined();
  });

  /** After a, the device that moved T, and b, the one that did not pull it: one answer, no record. */
  async function expectConverged(a: Machine, b: Machine, m: string): Promise<void> {
    await sync(b, a, b);
    const fresh = fleet!.machine("fresh");
    await sync(fresh);
    expect([status(a, m), status(b, m), status(fresh, m)]).toEqual(["done", "done", "done"]);
    expect(listConflicts(a.db)).toEqual([]);
    expect(listConflicts(b.db)).toEqual([]);
    const want = stateOf(a.db);
    expect([...differences("fresh", want, stateOf(fresh.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
  }

  it("does not repair at a write on a connected device whose home the write cannot see", async () => {
    const { a, b, m, t } = await staleFleet();
    upgrade(a);
    a.use();
    a.store.updateIssue(t, { status: "done" }, "a");
    await sync(a);
    upgrade(b);
    // b is still connected, under a home this process is not pointed at.
    process.env.STAPLE_HOME = mkdtempSync(join(tmpdir(), "staple-other-home-"));
    b.store.addComment(t, "written under another home", "b");
    expect(status(b, m)).toBe("backlog");
    await expectConverged(a, b, m);
  });

  it("does not repair at a write while disconnected, and repairs from the head once reconnected", async () => {
    const { a, b, m, t } = await staleFleet();
    upgrade(b);
    b.use();
    performDisconnect(b.home, REPO);
    b.store.addComment(t, "written while disconnected", "b");
    expect(status(b, m)).toBe("backlog");
    upgrade(a);
    a.use();
    a.store.updateIssue(t, { status: "done" }, "a");
    await sync(a);

    // b reconnects, as `staple cloud connect` leaves it.
    credentialStoreFor(b.home, "file").write(REPO, `token-${b.deviceId}`);
    writeConnection(b.home, {
      schemaVersion: 1,
      repositoryId: REPO,
      endpoint: ENDPOINT,
      deviceId: b.deviceId,
      label: b.label,
      credentialMechanism: "file",
      connectedAt: "2026-09-10T00:00:00.000Z",
      auto: false,
      backup: false,
      protocol: 1,
    });
    await expectConverged(a, b, m);
  });

  it("repairs after a reconcile, from the members the reconcile leaves", async () => {
    const { a, b, m, t } = await staleFleet();
    const server = fleet!.server;
    a.use();
    a.store.updateIssue(t, { status: "in_review" }, "a");
    a.store.updateIssue(m, { status: "backlog" }, "a");
    await sync(a, b);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });

    // After the backup, work starts on a child of M the backup never saw.
    a.use();
    const child = a.store.createIssue({ title: "after the backup", parent: m }).id;
    a.store.updateIssue(child, { assignee: "a" }, "a");
    a.store.updateIssue(child, { status: "in_progress" }, "a");
    await sync(a, b);

    // The restore; b follows it on a build that did not rewind, and keeps the child.
    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a);
    const reconciled = (b.db.prepare("SELECT value FROM meta WHERE key = 'sync_reconciled_epoch'").get() as { value: string } | undefined)?.value ?? null;
    const setReconciled = (value: string | null): void => {
      if (value === null) b.db.prepare("DELETE FROM meta WHERE key = 'sync_reconciled_epoch'").run();
      else b.db.prepare("INSERT INTO meta (key, value) VALUES ('sync_reconciled_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(value);
    };
    beginBootstrap(b.db, server.epoch);
    b.db.prepare("DELETE FROM meta WHERE key = 'sync_rewind'").run();
    setReconciled(String(server.epoch));
    await sync(b);
    setReconciled(reconciled);
    expect(b.db.prepare("SELECT 1 AS hit FROM issues WHERE id = ?").get(child)).toBeDefined();
    expect(status(b, m)).toBe("backlog");

    // b upgrades: its sync reconciles away the child, then repairs from T alone.
    upgrade(b);
    await sync(b, a, b);
    const fresh = fleet!.machine("fresh");
    await sync(fresh);
    expect([status(a, m), status(b, m), status(fresh, m)]).toEqual(["in_review", "in_review", "in_review"]);
    const want = stateOf(fresh.db);
    expect([...differences("a", want, stateOf(a.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
  });
});
