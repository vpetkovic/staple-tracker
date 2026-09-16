/**
 * RW1. A device that followed a restore on a build that did not rewind.
 *
 * c7a49d6 re-bootstraps into a new epoch by hydrating it on top of everything it holds, so
 * the rows the restore rewound stay on it — and when it edits one, its operations name
 * entities the new epoch does not hold. Every other device's sync, and every join, then
 * failed on the page or the snapshot that carried them, for good. Now:
 *
 *   (a) once it upgrades, it reconciles to the fold: by the epoch it last reconciled against,
 *       this build sees that its epoch moved under a build that did not (`rewind.ts`);
 *   (b) what its new-epoch work names that the epoch lacks — the issue it edited, the issue it
 *       commented on — is kept and sent, and every device converges with those rows present;
 *   (c) until it does, the entities that name what is missing are set aside on every other
 *       device and the rest applies (`quarantine.ts`); a fresh device joins.
 *
 * The older build is its database's shape: the same operations c7a49d6 sends, and a
 * re-bootstrap that clears the ledger and moves the epoch and nothing else. The device ran this
 * build before and after — so the applier's one-time catch-up is not owed, and only the epoch
 * it last reconciled against, left behind by the older build, says a reconcile is.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { countQuarantined } from "../src/core/cloud/quarantine.js";
import { beginBootstrap } from "../src/core/cloud/sync-state.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000018e";

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

const titles = (machine: Machine): string[] =>
  (machine.db.prepare("SELECT title FROM issues ORDER BY title").all() as Array<{ title: string }>).map((row) => row.title);

describe("a device that followed a restore on a build that did not rewind", () => {
  it("wedges no other device, and once upgraded brings back what its new work names", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const [ra, rb, ro] = ["ra", "rb", "ro"].map((label) => fleet!.machine(label)) as [Machine, Machine, Machine];
    ra.use();
    ra.store.createIssue({ title: "Backed up" });
    await sync(ra, rb, ro);
    ra.use();
    await setBackupConsent(ra.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(ra.home, REPO, null, { fetchImpl: server.fetch });

    // After the backup: ra adds an issue, a comment and a status; rb and ro add one each.
    ra.use();
    const arr4 = ra.store.createIssue({ title: "ARR-4, ra's" });
    ra.store.addComment(arr4.id, "ra's comment after the backup", "ra");
    ra.store.addStatus({ id: "s2", category: "review", label: "S2" }, "ra");
    rb.use();
    const arr5 = rb.store.createIssue({ title: "ARR-5, rb's" });
    ro.use();
    const arr6 = ro.store.createIssue({ title: "ARR-6, ro's" });
    await sync(ra, rb, ro, ra);

    // The restore. ra and rb follow it with this build.
    ra.use();
    await restoreFromBackup(ra.db, ra.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(ra, rb);
    expect(titles(ra)).toEqual(["Backed up"]);

    // ro follows it on c7a49d6: a re-bootstrap that keeps everything, and records nothing of
    // this build's — the epoch it last reconciled against stays the old one.
    const reconciled = (ro.db.prepare("SELECT value FROM meta WHERE key = 'sync_reconciled_epoch'").get() as { value: string } | undefined)?.value ?? null;
    const setReconciled = (value: string | null): void => {
      if (value === null) ro.db.prepare("DELETE FROM meta WHERE key = 'sync_reconciled_epoch'").run();
      else ro.db.prepare("INSERT INTO meta (key, value) VALUES ('sync_reconciled_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(value);
    };
    const olderBuild = async (): Promise<void> => {
      setReconciled(String(server.epoch));
      ro.use();
      const report = await ro.sync();
      expect(report.pending).toBe(0);
      setReconciled(reconciled);
    };
    beginBootstrap(ro.db, server.epoch);
    ro.db.prepare("DELETE FROM meta WHERE key = 'sync_rewind'").run();
    await olderBuild();
    expect(titles(ro)).toEqual(["ARR-4, ra's", "ARR-5, rb's", "ARR-6, ro's", "Backed up"]);

    // And edits two of the rows the restore rewound, in the new epoch. Both are sent.
    ro.use();
    ro.store.updateIssue(arr6.id, { status: "todo" }, "ro");
    ro.store.addComment(arr5.id, "ro's comment in the new epoch", "ro");
    // Still c7a49d6: its sync sends and pulls, and reconciles nothing.
    await olderBuild();
    expect(ro.db.prepare("SELECT value FROM meta WHERE key = 'sync_applier_version'").get()).toEqual({ value: "4" });

    // No other device's sync fails over them, and a device joins.
    await sync(ra, rb);
    const early = fleet.machine("early");
    await early.sync();
    for (const machine of [ra, rb, early]) expect(countQuarantined(machine.db), machine.label).toBeGreaterThan(0);

    // ro upgrades: its first sync reconciles it to the fold and sends what its work names.
    await sync(ro, ra, rb, early, ro, ra, rb, early);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const want = stateOf(fresh.db);
    expect([ra, rb, ro, early].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    for (const machine of [ra, rb, ro, early, fresh]) {
      expect(titles(machine), machine.label).toEqual(["ARR-5, rb's", "ARR-6, ro's", "Backed up"]);
      expect(countQuarantined(machine.db), machine.label).toBe(0);
      expect(machine.db.prepare("SELECT id FROM workspace_statuses WHERE id = 's2'").get(), machine.label).toBeUndefined();
      expect(machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(arr6.id), machine.label).toEqual({ status: "todo" });
      expect((machine.db.prepare("SELECT body FROM comments ORDER BY body").all() as Array<{ body: string }>).map((row) => row.body), machine.label).toEqual(["ro's comment in the new epoch"]);
    }
  });
});
