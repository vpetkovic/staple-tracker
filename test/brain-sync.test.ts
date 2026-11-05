/**
 * Brain records synchronize over the journal that already exists (the sync claim): written on one device, they reach a second device and a freshly hydrated
 * third one through the `setting` entity, with no new entity, no protocol change and no
 * migration. The Worker half of the same claim is `worker/test/brain-records.test.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { BrainStore } from "../src/brain/store.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { SYNC_PROTOCOL } from "../src/core/journal.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000b4a10";

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

const brain = (m: Machine) => new BrainStore(m.store);

describe("brain records ride the existing sync", () => {
  it("is the protocol and schema this POC started from", () => {
    // The POC's claim is "without a bump": if either moves, it no longer holds as stated.
    expect(SYNC_PROTOCOL).toBe(4);
    expect(WORKSPACE_LATEST_VERSION).toBe(19);
  });

  it("reaches a second device and a fresh one: created before connect (seed), edited, superseded and forgotten", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.use();
    const first = brain(a).remember({ kind: "feedback", body: "The demo build needs DEMO_FLAG=1.", name: "demo-build-flag", scope: "global", source: "agent:a" });
    const second = brain(a).remember({ kind: "project", body: "The demo schema is at version 3.", name: "demo-schema-version", scope: "project:-x", source: "agent:a" });

    const b = fleet.machine("b");
    await sync(a, b);
    expect(brain(b).get(first.id).body).toBe("The demo build needs DEMO_FLAG=1.");
    expect(brain(b).all().map((r) => r.name).sort()).toEqual(["demo-build-flag", "demo-schema-version"]);

    // Every brain write left the device as a `setting` operation, nothing else.
    const entities = server.ops.map((op): [string, string] => [op.entity, op.entityId]);
    expect(entities.filter(([, id]) => id.startsWith("brain.")).every(([entity]) => entity === "setting")).toBe(true);

    b.use();
    const replacement = brain(b).remember({ kind: "project", body: "The demo schema is at version 4.", name: "demo-schema-version-v2", scope: "project:-x", supersedes: second.id, source: "agent:b" });
    brain(b).remember({ id: first.id, kind: "feedback", body: "The demo build needs DEMO_FLAG=1 and a clean cache.", source: "agent:b" });
    await sync(b, a);
    expect(brain(a).get(first.id).body).toBe("The demo build needs DEMO_FLAG=1 and a clean cache.");
    expect(brain(a).get(second.id).supersededBy).toBe(replacement.id);
    expect(brain(a).live().map((r) => r.name).sort()).toEqual(["demo-build-flag", "demo-schema-version-v2"]);

    a.use();
    brain(a).forget(first.id);
    await sync(a, b);
    expect(() => brain(b).get(first.id)).toThrow(/No brain record/);

    const fresh = fleet.machine("fresh");
    await sync(fresh);
    expect(brain(fresh).all().map((r) => [r.name, r.supersededBy !== null]).sort()).toEqual([
      ["demo-schema-version", true],
      ["demo-schema-version-v2", false],
    ]);
    // Not settings: the settings surface does not list them as unknown keys.
    expect(fresh.store.unknownSettingKeys()).toEqual([]);
  }, 60_000);

  it("turns a concurrent edit of one record into one conflict on the whole value", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const record = brain(a).remember({ kind: "user", body: "The user prefers metric units.", scope: "global" });
    await sync(a, b);

    a.use();
    brain(a).remember({ id: record.id, kind: "user", body: "The user prefers metric units and Celsius." });
    b.use();
    brain(b).remember({ id: record.id, kind: "user", body: "The user prefers metric units, always." });
    await sync(a, b, a);

    const conflicts = [...listConflicts(a.db), ...listConflicts(b.db)].filter((c) => c.entityId === `brain.${record.id}`);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts.every((c) => c.entity === "setting" && c.field === "value")).toBe(true);
  }, 60_000);
});
