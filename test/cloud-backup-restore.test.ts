/**
 * `staple cloud backup` and `staple cloud restore` — the client half.
 *
 * Contract: `docs/sync.md`, "Backup, disconnect and purge are three different
 * things", and the "Three consents" table.
 *
 * Two assertions here carry the lane, and everything else is scaffolding for
 * them:
 *
 *   1. **A device that bootstraps after a restore sees the restored content.**
 *      A restore that only bumped the epoch would satisfy every other test in
 *      this file — the epoch moves, the old rows are kept, the audit is written,
 *      the fleet re-bootstraps — and would hand every device an EMPTY repository.
 *      So the assertion is written against a genuinely fresh device going through
 *      the ordinary `syncRepository` bootstrap, not against anything the restore
 *      itself returns.
 *
 *   2. **A restore does not rewind `client_seq_high_water`.** Operation ids are
 *      `sha256(repoId, epoch, deviceId, clientSeq)`. A device that reset that
 *      counter would re-mint ids it has already used, the server would answer
 *      `duplicate` with the ORIGINAL seq, and the client would file genuinely new
 *      work as acknowledged. Silent data loss, in the one path the epoch
 *      mechanism exists to make safe.
 *
 * The service is `test/fixtures/fake-sync-server.ts`, handed in as a `fetchImpl`,
 * so nothing here touches a socket.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { WORKSPACE_SCHEMA_VERSION, migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import {
  createBackup,
  deleteBackup,
  listBackups,
  requireBackupConsent,
  restoreDisclosure,
  restoreFromBackup,
  setBackupConsent,
} from "../src/core/cloud/backup.js";
import { cloudCodeOf } from "../src/core/cloud/client.js";
import { readConnection, setConsent, writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { readSyncState } from "../src/core/cloud/sync-state.js";
import { syncRepository } from "../src/core/cloud/sync.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
const ENDPOINT = "https://sync.test.example";

let homes: string[] = [];
let stores: WorkspaceStore[] = [];
let server: FakeSyncServer;

interface Device {
  store: WorkspaceStore;
  home: string;
  deviceId: string;
  sync: () => ReturnType<typeof syncRepository>;
}

/** A connected workspace on its own machine. Backup is OFF, as a connect leaves it. */
function device(deviceId: string, token: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-backup-home-${deviceId}-`));
  homes.push(home);

  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, deviceId);
  const store = new WorkspaceStore(db, "test", "TST");
  stores.push(store);

  credentialStoreFor(home, "file").write(REPO_ID, token);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-05T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, token);

  return {
    store,
    home,
    deviceId,
    sync: () =>
      syncRepository(store.db, REPO_ID, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
      }),
  };
}

/** Turn backup on the way `staple cloud backup enable` does. */
async function enable(dev: Device): Promise<void> {
  await setBackupConsent(dev.home, REPO_ID, true, { fetchImpl: server.fetch });
}

const opts = () => ({ fetchImpl: server.fetch });

function titles(store: WorkspaceStore): string[] {
  return (store.db.prepare("SELECT title FROM issues ORDER BY title").all() as { title: string }[]).map(
    (row) => row.title,
  );
}

beforeEach(() => {
  server = new FakeSyncServer({ repositoryId: REPO_ID });
  homes = [];
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

// ------------------------------------------------------- the third consent

describe("backup is a third consent and nothing else turns it on", () => {
  it("is off on a fresh connection", () => {
    const a = device("device-a", "token-a");
    expect(readConnection(a.home, REPO_ID)!.backup).toBe(false);
  });

  it("is still off after enabling automatic sync, and after turning it off again", () => {
    const a = device("device-a", "token-a");

    setConsent(a.home, REPO_ID, { auto: true });
    expect(readConnection(a.home, REPO_ID)!.backup).toBe(false);

    setConsent(a.home, REPO_ID, { auto: false });
    expect(readConnection(a.home, REPO_ID)!.backup).toBe(false);
  });

  it("is not turned off by anything the automatic-sync consent does", async () => {
    const a = device("device-a", "token-a");
    await enable(a);

    setConsent(a.home, REPO_ID, { auto: true });
    expect(readConnection(a.home, REPO_ID)!.backup).toBe(true);
    setConsent(a.home, REPO_ID, { auto: false });
    expect(readConnection(a.home, REPO_ID)!.backup).toBe(true);
  });

  it("is not granted by synchronizing, however much work goes through", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "ordinary work" });
    await a.sync();

    expect(readConnection(a.home, REPO_ID)!.backup).toBe(false);
    expect(server.backupEnabled).toBe(false);
  });

  it("refuses every backup command while it is off, WITHOUT making a request", async () => {
    const a = device("device-a", "token-a");
    const before = server.calls.length;

    for (const attempt of [
      () => listBackups(a.home, REPO_ID, opts()),
      () => createBackup(a.home, REPO_ID, null, opts()),
      () => deleteBackup(a.home, REPO_ID, "backup-1", opts()),
      () => restoreFromBackup(a.store.db, a.home, REPO_ID, "backup-1", opts()),
    ]) {
      await expect(attempt()).rejects.toThrow(StapleError);
      await attempt().catch((error: unknown) => {
        expect(cloudCodeOf(error)).toBe("forbidden");
      });
    }

    // The refusal is local and complete: a device without the consent does not
    // even ask the service whether it might.
    expect(server.calls.length).toBe(before);
  });

  it("requires the server's half too, so a config file alone is not consent", async () => {
    const a = device("device-a", "token-a");
    // Forge the local flag without the server ever having agreed.
    setConsent(a.home, REPO_ID, { backup: true });
    expect(server.backupEnabled).toBe(false);

    await expect(createBackup(a.home, REPO_ID, null, opts())).rejects.toThrow(/backup is not enabled/i);
  });

  it("keeps the backups when the consent is withdrawn", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "worth keeping" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    await setBackupConsent(a.home, REPO_ID, false, opts());
    expect(readConnection(a.home, REPO_ID)!.backup).toBe(false);
    expect(server.backups.map((b) => b.backupId)).toContain(backup.backupId);
  });

  it("is a per-device decision: enabling on one machine does not enable another", async () => {
    const a = device("device-a", "token-a");
    const b = device("device-b", "token-b");
    await enable(a);

    expect(readConnection(a.home, REPO_ID)!.backup).toBe(true);
    expect(readConnection(b.home, REPO_ID)!.backup).toBe(false);
    // B still refuses locally, even though the server-side half is now set.
    await expect(createBackup(b.home, REPO_ID, null, opts())).rejects.toThrow(/separate consent/i);
  });
});

// -------------------------------------------------- backup vs convergence

describe("creating, retaining and deleting a backup changes no convergence state", () => {
  it("moves no cursor, no epoch, no watermark and no allocator", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "one" });
    a.store.createIssue({ title: "two" });
    await a.sync();
    await enable(a);

    const before = readSyncState(a.store.db);
    const serverBefore = { epoch: server.epoch, lastSeq: server.lastSeq, ops: server.ops.length };

    const backup = await createBackup(a.home, REPO_ID, "labelled", opts());
    await listBackups(a.home, REPO_ID, opts());
    await deleteBackup(a.home, REPO_ID, backup.backupId, opts());

    expect(readSyncState(a.store.db)).toEqual(before);
    expect({ epoch: server.epoch, lastSeq: server.lastSeq, ops: server.ops.length }).toEqual(
      serverBefore,
    );
  });

  it("leaves the outbox and its high-water mark exactly where they were", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "synced" });
    await a.sync();
    await enable(a);
    // Unsynchronized work, sitting in the outbox across the backup.
    a.store.createIssue({ title: "pending" });

    const outboxBefore = a.store.db.prepare("SELECT op_id, client_seq FROM sync_outbox").all();
    const waterBefore = readSyncState(a.store.db)!.clientSeqHighWater;

    await createBackup(a.home, REPO_ID, null, opts());

    expect(a.store.db.prepare("SELECT op_id, client_seq FROM sync_outbox").all()).toEqual(
      outboxBefore,
    );
    expect(readSyncState(a.store.db)!.clientSeqHighWater).toBe(waterBefore);
  });

  it("reports what it folded, and lists a pre-restore backup as such", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "one" });
    await a.sync();
    await enable(a);

    const backup = await createBackup(a.home, REPO_ID, null, opts());
    expect(backup.entityCount).toBeGreaterThan(0);
    expect(backup.kind).toBe("manual");

    await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());
    const listed = await listBackups(a.home, REPO_ID, opts());
    expect(listed.some((candidate) => candidate.kind === "pre-restore")).toBe(true);
  });
});

// ------------------------------------------------------------- THE RULING

describe("a restore materialises the restored state into the new epoch", () => {
  /**
   * The assertion the whole lane turns on. A bump-only restore passes everything
   * else and fails exactly this, because the snapshot route folds the CURRENT
   * epoch and a freshly bumped epoch has nothing in it.
   */
  it("a fresh device bootstrapping after a restore sees the restored content, not an empty repository", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "kept by the backup" });
    a.store.createIssue({ title: "also kept" });
    await a.sync();
    await enable(a);

    const backup = await createBackup(a.home, REPO_ID, null, opts());
    const report = await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());
    expect(report.toEpoch).toBe(report.fromEpoch + 1);

    // A genuinely fresh machine: same repository id, empty database, no cursor.
    const fresh = device("device-fresh", "token-fresh");
    expect(titles(fresh.store)).toEqual([]);

    await fresh.sync();

    expect(titles(fresh.store)).toEqual(["also kept", "kept by the backup"]);
  });

  it("restores the state as of the backup, discarding what was synchronized after it", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "before the backup" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    a.store.createIssue({ title: "after the backup" });
    await a.sync();

    await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());

    const fresh = device("device-fresh", "token-fresh");
    await fresh.sync();
    expect(titles(fresh.store)).toEqual(["before the backup"]);
  });

  it("forces every OTHER device through a bounded re-bootstrap onto the restored timeline", async () => {
    const a = device("device-a", "token-a");
    const b = device("device-b", "token-b");
    a.store.createIssue({ title: "shared" });
    await a.sync();
    await b.sync();
    expect(titles(b.store)).toEqual(["shared"]);

    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());
    a.store.createIssue({ title: "will be discarded" });
    await a.sync();
    await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());

    // B is still on the old epoch. Its next sync must re-bootstrap rather than
    // silently continuing from a cursor into a timeline nobody is on.
    const report = await b.sync();
    expect(report.bootstrap).not.toBeNull();
    expect(readSyncState(b.store.db)!.epoch).toBe(2);
  });

  it("the pre-restore backup is a real undo: restoring it brings the discarded work back", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "original" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    a.store.createIssue({ title: "would be lost" });
    await a.sync();

    const report = await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());
    expect(report.preRestoreBackupId).toBeTruthy();

    const afterRestore = device("device-check-1", "token-check-1");
    await afterRestore.sync();
    expect(titles(afterRestore.store)).toEqual(["original"]);

    // Undo the restore by restoring its own pre-restore backup.
    await restoreFromBackup(a.store.db, a.home, REPO_ID, report.preRestoreBackupId!, opts());

    const afterUndo = device("device-check-2", "token-check-2");
    await afterUndo.sync();
    expect(titles(afterUndo.store)).toEqual(["original", "would be lost"]);
  });

  it("takes more than one turn when the backup is larger than one batch", async () => {
    const a = device("device-a", "token-a");
    for (let n = 0; n < 30; n += 1) a.store.createIssue({ title: `issue ${String(n).padStart(2, "0")}` });
    await a.sync();
    await enable(a);

    const backup = await createBackup(a.home, REPO_ID, null, opts());
    const report = await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());

    // begin, then at least two stages, then commit.
    expect(report.turns).toBeGreaterThanOrEqual(4);

    const fresh = device("device-fresh", "token-fresh");
    await fresh.sync();
    expect(titles(fresh.store)).toHaveLength(30);
  });
});

// --------------------------------------------------------------- the trap

describe("a restore never rewinds the operation-id allocator", () => {
  /**
   * The trap, run end to end. `beginBootstrap` clears the cursor and the applied
   * ledger and leaves `client_seq_high_water` and the outbox alone. If a restore
   * ever reset that counter, the next genuinely new mutation would re-mint an id
   * the server already holds, be absorbed as a `duplicate`, and be acknowledged.
   */
  it("preserves client_seq_high_water and the pending outbox across a restore", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "synced before the restore" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    // Work that has NOT been acknowledged, sitting in the outbox across the restore.
    a.store.createIssue({ title: "queued across the restore" });
    const waterBefore = readSyncState(a.store.db)!.clientSeqHighWater;
    const pendingBefore = a.store.db
      .prepare("SELECT op_id, client_seq FROM sync_outbox WHERE acknowledged_seq IS NULL")
      .all() as { op_id: string; client_seq: number }[];
    expect(waterBefore).toBeGreaterThan(0);
    expect(pendingBefore.length).toBeGreaterThan(0);

    await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());

    const after = readSyncState(a.store.db)!;
    expect(after.clientSeqHighWater).toBe(waterBefore);
    expect(
      a.store.db
        .prepare("SELECT op_id, client_seq FROM sync_outbox WHERE acknowledged_seq IS NULL")
        .all(),
    ).toEqual(pendingBefore);

    // And the re-bootstrap really did happen: the cursor is gone, the epoch moved.
    expect(after.cursor).toBeNull();
    expect(after.epoch).toBe(2);
  });

  it("the work queued across a restore reaches the restored timeline exactly once", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "before" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    a.store.createIssue({ title: "queued across the restore" });
    await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts());
    await a.sync();

    const fresh = device("device-fresh", "token-fresh");
    await fresh.sync();
    // Exactly once, and it did not vanish into a `duplicate`.
    expect(titles(fresh.store).filter((t) => t === "queued across the restore")).toHaveLength(1);
  });
});

// ------------------------------------------------- refusals and disclosure

describe("restore refuses before it changes anything", () => {
  it("refuses a backup written by a newer schema, without beginning a restore", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "one" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    // Forge a backup from a future build.
    server.backups.find((b) => b.backupId === backup.backupId)!.schemaVersion =
      WORKSPACE_SCHEMA_VERSION + 1;

    await expect(
      restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, opts()),
    ).rejects.toThrow(/newer Staple/i);

    expect(server.epoch).toBe(1);
    expect(server.restores).toHaveLength(0);
  });

  it("refuses an unknown backup id and leaves the epoch alone", async () => {
    const a = device("device-a", "token-a");
    await a.sync();
    await enable(a);

    await expect(
      restoreFromBackup(a.store.db, a.home, REPO_ID, "backup-nope", opts()),
    ).rejects.toThrow(/No backup backup-nope/);
    expect(server.epoch).toBe(1);
  });

  it("discloses what will be discarded before anything is confirmed", async () => {
    const a = device("device-a", "token-a");
    a.store.createIssue({ title: "one" });
    await a.sync();
    await enable(a);
    const backup = await createBackup(a.home, REPO_ID, null, opts());

    const text = restoreDisclosure(ENDPOINT, REPO_ID, backup, 1);

    expect(text).toContain("pre-restore backup FIRST");
    expect(text).toContain("DISCARDS anything synchronized after the backup was taken");
    expect(text).toContain("bounded re-bootstrap");
    expect(text).toContain("never merges database files");
    expect(text).toContain(backup.backupId);
    expect(text).toContain(REPO_ID);
  });

  it("names the consent that is missing rather than describing the state", () => {
    expect(() =>
      requireBackupConsent({
        schemaVersion: 1,
        repositoryId: REPO_ID,
        endpoint: ENDPOINT,
        deviceId: "device-a",
        label: null,
        credentialMechanism: "file",
        connectedAt: "2026-09-05T00:00:00.000Z",
        auto: true,
        backup: false,
        protocol: 1,
      }),
    ).toThrow(/staple cloud backup enable/);
  });
});
