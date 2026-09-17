/**
 * One field, one value, whichever spelling wrote it.
 *
 * The journal's callers wrote some fields by field name (`updatedAt`) and some by column
 * (`updated_at`: `updateIssue` journals the changed columns as they are), and the service's
 * fold kept each key it was sent. So an issue's folded state held both spellings of
 * `updated_at`, a device hydrating applied them in key order, and after a vocabulary
 * migration — which journals `updatedAt` — the stale value won on every fresh device while
 * the tail held the new one. Three halves close it: the journal sends one spelling
 * (`oneSpelling`), the fold drops a key's other spelling when it is written, and a device
 * reading a Worker from before that keeps the spelling written last (`latestSpelling`).
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000171";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function stamps(db: DatabaseSync, id: string): unknown {
  return db.prepare("SELECT status, updated_at FROM issues WHERE id = ?").get(id);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

describe("a field written under both spellings", () => {
  it("after an edit and a vocabulary migration, a fresh device holds what the tail holds", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const moved = a.store.createIssue({ title: "Moved by a migration" });
    a.store.updateIssue(moved.id, { status: "in_review" });
    await a.sync();
    const tail = fleet.machine("tail");
    await tail.sync();

    await tick();
    a.store.updateIssue(moved.id, { title: "Edited" });
    await tick();
    a.store.removeStatus("in_review", { migrateTo: "todo" });
    await a.sync();
    await tail.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [tail, fresh]) expect(stamps(machine.db, moved.id), machine.label).toEqual(stamps(a.db, moved.id));
    // Nothing this build journals names a field in two spellings.
    const keys = (a.db.prepare("SELECT payload FROM sync_outbox").all() as Array<{ payload: string }>).flatMap((row) =>
      Object.keys(JSON.parse(row.payload) as object),
    );
    expect(keys.filter((key) => key.includes("_"))).toEqual([]);
  });

  /**
   * An older build journaled a create by field name and each later edit by column, and the
   * Worker before this one kept both keys. A backup it made, and every epoch restored from
   * one, holds both with no history to say which came last — and a device applying them
   * kept the field name's, the value at creation: the estimate went back to 1h, the edited
   * criterion came back, and a finished issue lost its `completed_at`. The column's is the
   * edit, so it wins in the service's fold, the tail fold, the snapshot reader and the
   * applier (`columnSpellingWins`).
   */
  describe("through a backup the Worker before this build made", () => {
    const EDITED = { estimated_seconds: 10800, acceptance_criteria: '["a","c"]', status: "done", completed_at: "2026-08-02T00:00:00.000Z" };
    const edited = (db: DatabaseSync, id: string): unknown =>
      db.prepare("SELECT estimated_seconds, acceptance_criteria, status, completed_at FROM issues WHERE id = ?").get(id);

    async function olderBuildEdits(): Promise<{ server: FakeSyncServer; a: ReturnType<Fleet["machine"]>; id: string; options: { fetchImpl: typeof fetch; sleep: () => Promise<void> } }> {
      const server = new FakeSyncServer({ repositoryId: REPO });
      server.legacyFold = true;
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      await a.sync();
      const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
      const id = randomUUID();
      const old = new OlderBuildDevice(server, REPO, "device-old", schema);
      await old.push([
        {
          entity: "issue",
          entityId: id,
          verb: "create",
          createdAt: "2026-08-01T00:00:00.000Z",
          payload: {
            identifier: "TRA-1", title: "Estimated", normalizedTitle: "estimated", status: "backlog", kind: "task", priority: "medium",
            acceptanceCriteria: ["a", "b"], estimatedSeconds: 3600, completedAt: null,
            createdAt: "2026-08-01T00:00:00.000Z", updatedAt: "2026-08-01T00:00:00.000Z",
          },
        },
        {
          entity: "issue", entityId: id, verb: "update", baseVersion: 1, createdAt: "2026-08-02T00:00:00.000Z",
          payload: { status: "done", status_version: 1, completed_at: "2026-08-02T00:00:00.000Z", estimated_seconds: 10800, updated_at: "2026-08-02T00:00:00.000Z" },
        },
        {
          entity: "issue", entityId: id, verb: "update", baseVersion: 2, createdAt: "2026-08-03T00:00:00.000Z",
          payload: { acceptance_criteria: ["a", "c"], updated_at: "2026-08-03T00:00:00.000Z" },
        },
      ]);
      await a.sync();
      expect(edited(a.db, id)).toEqual(EDITED);
      const options = { fetchImpl: server.fetch, sleep: async () => undefined };
      await setBackupConsent(a.home, REPO, true, options);
      return { server, a, id, options };
    }

    it("a restore by this Worker leaves every device, and a fresh one, with the edits", async () => {
      const { server, a, id, options } = await olderBuildEdits();
      const backup = await createBackup(a.home, REPO, null, options);
      server.legacyFold = false;
      a.use();
      await restoreFromBackup(a.db, a.home, REPO, backup.backupId, options);
      await a.sync();
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      for (const machine of [a, fresh]) expect(edited(machine.db, id), machine.label).toEqual(EDITED);
    });

    it("an epoch the Worker before this build restored keeps the edits there, and through the re-read after this Worker is deployed", async () => {
      const { server, a, id, options } = await olderBuildEdits();
      const backup = await createBackup(a.home, REPO, null, options);
      a.use();
      await restoreFromBackup(a.db, a.home, REPO, backup.backupId, options);
      // Still the Worker before this build: its snapshot of the restored epoch names both.
      await a.sync();
      const early = fleet!.machine("early");
      await early.sync();
      for (const machine of [a, early]) expect(edited(machine.db, id), `${machine.label}, before the deploy`).toEqual(EDITED);

      // This Worker is deployed, and every device owes the applier's re-read.
      server.legacyFold = false;
      for (const machine of [a, early]) machine.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();
      a.use();
      expect((await a.sync()).caughtUp).not.toBeNull();
      early.use();
      await early.sync();
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      for (const machine of [a, early, fresh]) expect(edited(machine.db, id), `${machine.label}, after the deploy`).toEqual(EDITED);
    });
  });

  for (const service of ["this Worker", "the Worker before this build"] as const) {
    it(`written in both by an older build, is the value written last on a fresh device (${service})`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO });
      server.legacyFold = service === "the Worker before this build";
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      await a.sync();
      const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
      const id = randomUUID();
      const old = new OlderBuildDevice(server, REPO, "device-old", schema);
      await old.push([
        {
          entity: "issue",
          entityId: id,
          verb: "create",
          payload: { identifier: "TRA-1", title: "Old", normalizedTitle: "old", status: "backlog", kind: "task", priority: "medium", updatedAt: "2026-08-01T00:00:00.001Z", createdAt: "2026-08-01T00:00:00.000Z" },
        },
        { entity: "issue", entityId: id, verb: "update", payload: { updated_at: "2026-08-02T00:00:00.000Z" }, baseVersion: 1, createdAt: "2026-08-02T00:00:00.000Z" },
        { entity: "issue", entityId: id, verb: "update", payload: { updatedAt: "2026-08-03T00:00:00.000Z" }, baseVersion: 2, createdAt: "2026-08-03T00:00:00.000Z" },
      ]);
      await a.sync();
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const machine of [a, fresh]) {
        expect(machine.db.prepare("SELECT updated_at FROM issues WHERE id = ?").get(id), machine.label).toEqual({
          updated_at: "2026-08-03T00:00:00.000Z",
        });
      }
    });
  }
});
