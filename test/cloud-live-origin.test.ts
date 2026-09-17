/**
 * One definition of a live external origin, shared by the unique index, the settlement of
 * two claims, a reopen and the seed (`holdsLiveOrigin`, `src/core/types.ts`).
 *
 * The settlement and the index read the status id (`done`, `cancelled`) while a reopen was
 * read by category, so an issue in a custom cancelled-category status held its origin by the
 * index, and moving it out counted as a later claim by the other rule: A's issue in
 * `wontfix` and C's later import of the same origin both gave it up, on every device.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ORIGIN_RELEASING_STATUSES } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000182";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const liveHolders = (db: DatabaseSync): Array<{ title: string }> =>
  db
    .prepare(
      `SELECT title FROM issues WHERE origin_kind = 'github' AND origin_id = 'gh-1'
          AND status NOT IN (SELECT value FROM json_each(?)) ORDER BY title`,
    )
    .all(JSON.stringify(ORIGIN_RELEASING_STATUSES)) as Array<{ title: string }>;

describe("a live origin", () => {
  it("is what the unique index says it is", () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const sql = (a.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'issues_live_origin_uq'").get() as { sql: string }).sql;
    const listed = /status NOT IN \(([^)]*)\)/.exec(sql)?.[1]?.split(",").map((value) => value.trim().replace(/'/g, ""));
    expect(listed).toEqual([...ORIGIN_RELEASING_STATUSES]);
  });

  it("stays with one issue on every device when an issue leaves a custom cancelled-category status", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const c = fleet.machine("c");
    await c.sync();

    a.use();
    a.store.addStatus({ id: "wontfix", category: "cancelled", label: "Won't fix" }, "alice");
    const held = a.store.createIssue({ title: "Held", originKind: "github", originId: "gh-1" });
    a.store.updateIssue(held.id, { status: "wontfix" }, "alice");
    await a.sync();

    // C is offline, and imports the same origin.
    c.use();
    c.store.createIssue({ title: "Imported", originKind: "github", originId: "gh-1" });

    a.use();
    a.store.updateIssue(held.id, { status: "todo" }, "alice");

    await c.sync();
    await a.sync();
    await c.sync();
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();

    for (const machine of [a, c, fresh]) {
      expect(liveHolders(machine.db), machine.label).toEqual([{ title: "Held" }]);
    }
  });

  /**
   * An older build's reopen says nothing about being one (`reopens`), so a device hydrating
   * afterwards could not tell it from any other status move: it gave the origin to the
   * issue it applied first, while every device reading the tail had given it to the earlier
   * claim. The service's fold records the reopen (`reopensOrigin`), and hydration settles by
   * where each claim sits in the log.
   */
  for (const folded of ["the service", "this device, from the tail"] as const) {
  it(`goes to the same issue on a fresh device as in the tail when an older build reopens the other (folded by ${folded})`, async () => {
    // A log too large for the service to fold is folded by the device itself (`tail-fold.ts`).
    const server = new FakeSyncServer({ repositoryId: REPO, ...(folded === "the service" ? {} : { maxSnapshotFoldOps: 3 }) });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    const c = fleet.machine("c");
    await c.sync();
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const older = new OlderBuildDevice(server, REPO, "device-older", schema);

    a.use();
    const held = a.store.createIssue({ title: "Held", originKind: "github", originId: "gh-1" });
    a.store.updateIssue(held.id, { status: "done" }, "alice");
    await a.sync();
    c.use();
    await c.sync();
    c.store.createIssue({ title: "Imported", originKind: "github", originId: "gh-1" });
    await c.sync();

    // The older build reopens A's issue, in its own payload shape: the changed columns by
    // column name, and no `reopens`.
    const version = (a.db.prepare("SELECT version FROM sync_entity_versions WHERE entity = 'issue' AND entity_id = ?").get(held.id) as { version: number }).version;
    await older.push([
      {
        entity: "issue",
        entityId: held.id,
        verb: "update",
        baseVersion: version,
        payload: { status: "todo", status_version: 2, updated_at: new Date().toISOString() },
      },
    ]);

    await a.sync();
    await c.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [a, c, fresh]) {
      expect(liveHolders(machine.db), machine.label).toEqual([{ title: "Imported" }]);
    }
  });
  }
});
