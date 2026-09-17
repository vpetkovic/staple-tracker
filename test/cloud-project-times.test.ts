/**
 * A project is dated the same on every device.
 *
 * Its create carried no times, so every other device dated it by the operation — about a
 * millisecond off the device that made it, in one run of four (measured). The create and
 * every update carry the project's own `createdAt` and `updatedAt` now.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000173";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function times(db: DatabaseSync, id: string): unknown {
  return db.prepare("SELECT name, created_at, updated_at FROM projects WHERE id = ?").get(id);
}

describe("a project's times", () => {
  it("are its own on every device, through a create and an update", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const tail = fleet.machine("tail");
    await tail.sync();
    const project = a.store.projects().create({ name: "Web" }, "someone");
    // The operation carries the row's own times — which is what every receiver writes.
    const sent = JSON.parse((a.db.prepare("SELECT payload FROM sync_outbox WHERE entity = 'project'").get() as { payload: string }).payload);
    const held = a.db.prepare("SELECT created_at, updated_at FROM projects WHERE id = ?").get(project.id) as { created_at: string; updated_at: string };
    expect({ createdAt: sent.createdAt, updatedAt: sent.updatedAt }).toEqual({ createdAt: held.created_at, updatedAt: held.updated_at });
    await a.sync();
    await tail.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [tail, fresh]) expect(times(machine.db, project.id), machine.label).toEqual(times(a.db, project.id));

    a.store.projects().update(project.id, { name: "Web app" }, "someone");
    const updated = JSON.parse(
      (a.db.prepare("SELECT payload FROM sync_outbox WHERE entity = 'project' AND verb = 'update'").get() as { payload: string }).payload,
    );
    expect(updated.updatedAt).toBe((a.db.prepare("SELECT updated_at FROM projects WHERE id = ?").get(project.id) as { updated_at: string }).updated_at);
    await a.sync();
    await tail.sync();
    await fresh.sync();
    for (const machine of [tail, fresh]) expect(times(machine.db, project.id), machine.label).toEqual(times(a.db, project.id));
  });
});
