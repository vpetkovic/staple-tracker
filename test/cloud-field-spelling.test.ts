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
        { entity: "issue", entityId: id, verb: "update", payload: { updated_at: "2026-08-02T00:00:00.000Z" }, baseVersion: 1 },
        { entity: "issue", entityId: id, verb: "update", payload: { updatedAt: "2026-08-03T00:00:00.000Z" }, baseVersion: 2 },
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
