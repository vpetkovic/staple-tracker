/**
 * Who made each blocking edge, and when, is the same on every device — and the device
 * that seeded the repository keeps its own.
 *
 * A blocker set travels as one operation per blocked issue, and the applier replaced the
 * whole set: every edge deleted and inserted again with the operation's actor and time.
 * So on real data (measured: 19 relations) the seeding device rewrote the time of its own
 * edges when its seed came back to it, and every other device dated all of an issue's
 * edges with one instant that was none of theirs. Each edge's own facts travel now, and
 * an edge that stays keeps them.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000161";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function edges(db: DatabaseSync): unknown[] {
  return db
    .prepare("SELECT blocker_id, blocked_id, created_by, created_at FROM relations WHERE type = 'blocks' ORDER BY blocker_id, blocked_id")
    .all();
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

describe("blocking edges", () => {
  it("keep their author and time on the seeding device, and arrive with them everywhere else", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.connect("a", fleet.prepare("a"));
    // Real-data shape: edges made at different moments, by create and by a later set.
    const first = a.store.createIssue({ title: "First" });
    await tick();
    const second = a.store.createIssue({ title: "Second", blockedBy: [first.identifier] });
    await tick();
    const third = a.store.createIssue({ title: "Third" });
    await tick();
    a.store.setBlockedBy(third.identifier, [first.identifier, second.identifier], "planner");
    await tick();
    a.store.createIssue({ title: "Fourth", blockedBy: [second.identifier, third.identifier] });
    // As real data holds them: every edge of a set made by someone else, at another moment
    // (an import, a migration, edges added one at a time over weeks).
    const rows = a.db.prepare("SELECT id FROM relations ORDER BY id").all() as Array<{ id: number }>;
    rows.forEach((row, index) => {
      a.db
        .prepare("UPDATE relations SET created_by = ?, created_at = ? WHERE id = ?")
        .run(`author-${index}`, `2026-08-0${index + 1}T10:00:00.00${index}Z`, row.id);
    });
    const before = edges(a.db);
    expect(before).toHaveLength(5);

    await a.sync();
    await a.sync();
    expect(edges(a.db)).toEqual(before);

    const tail = fleet.machine("tail");
    await tail.sync();
    // And edges made on a connected device: a set that keeps one edge and adds one.
    const fifth = a.store.createIssue({ title: "Fifth" });
    await tick();
    a.store.setBlockedBy(second.identifier, [first.identifier, fifth.identifier], "planner");
    await a.sync();
    await tail.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [tail, fresh]) {
      expect(edges(machine.db), machine.label).toEqual(edges(a.db));
    }
  });

  it("an older build's set, which says nothing of its edges, leaves the edges a device holds as it holds them", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const first = a.store.createIssue({ title: "First" });
    const second = a.store.createIssue({ title: "Second" });
    const blocked = a.store.createIssue({ title: "Blocked", blockedBy: [first.identifier] });
    await a.sync();
    const kept = edges(a.db);

    // An older build adds a second blocker: its set names both, and no edge's facts.
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    await new OlderBuildDevice(server, REPO, "device-old", schema).push([
      { entity: "relation", entityId: blocked.id, verb: "update", payload: { blockedBy: [first.id, second.id] }, baseVersion: 1 },
    ]);
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const byBlocker = (db: DatabaseSync, id: string): unknown =>
      db.prepare("SELECT created_by, created_at FROM relations WHERE blocker_id = ? AND blocked_id = ?").get(id, blocked.id);
    // The edge A already had keeps its author and time; the new one is the operation's.
    expect(byBlocker(a.db, first.id)).toEqual({
      created_by: (kept as Array<{ created_by: string | null }>)[0]!.created_by,
      created_at: (kept as Array<{ created_at: string }>)[0]!.created_at,
    });
    expect(byBlocker(a.db, second.id)).toEqual(expect.objectContaining({ created_by: "older-build" }));
    expect(byBlocker(fresh.db, first.id)).toEqual(byBlocker(a.db, first.id));
  });
});
