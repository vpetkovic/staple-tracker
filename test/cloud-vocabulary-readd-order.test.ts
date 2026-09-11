/**
 * A status removed and added again with no position goes to the same place on every device.
 *
 * This build journals an order when it places a status anywhere but the end (`@order`);
 * a build from before only journals the create. So after `statuses add zz --after todo` here
 * and `statuses rm zz`, `statuses add zz` on an older build, a device reading the log put
 * the new `zz` at the end, where it puts an entry it has never seen — and a device hydrating
 * from the service's fold applied the order written before the removal, and put it after
 * `todo`. Permanently: nothing ever sent a new order. Now a create after a delete forgets
 * the entry's place in any earlier order, in the service's fold, in this device's tail fold
 * and in a device hydrating from a snapshot that did not (`forgetPlace`, `withoutStalePlaces`).
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { foldOperations } from "../src/core/cloud/tail-fold.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000188";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const order = (db: DatabaseSync): string[] =>
  (db.prepare("SELECT id FROM workspace_statuses ORDER BY sort_order, id").all() as Array<{ id: string }>).map((row) => row.id);

describe("a status removed and added again by an older build", () => {
  for (const hydration of ["the service's fold", "this device's tail fold", "a snapshot that kept the old place"] as const) {
    it(`is in the same place on the log's readers and on a device hydrating from ${hydration}`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(hydration === "this device's tail fold" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const nd = fleet.machine("nd");
      await nd.sync();
      const tail = fleet.machine("tail");
      await tail.sync();

      nd.use();
      nd.store.addStatus({ id: "zz", category: "review", label: "ZZ", after: "todo" }, "vp");
      await nd.sync();
      await tail.sync();
      expect(order(tail.db)).toEqual(order(nd.db));

      const schema = Number((nd.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
      const version = (nd.db.prepare("SELECT version FROM sync_entity_versions WHERE entity = 'status' AND entity_id = 'zz'").get() as { version: number }).version;
      await new OlderBuildDevice(server, REPO, "device-older", schema).push([
        { entity: "status", entityId: "zz", verb: "delete" as never, baseVersion: version, payload: {} },
        { entity: "status", entityId: "zz", verb: "create", payload: { label: "ZZ", category: "review" } },
      ]);
      nd.use();
      await nd.sync();
      tail.use();
      await tail.sync();
      expect(order(nd.db).at(-1)).toBe("zz");
      expect(order(tail.db)).toEqual(order(nd.db));

      const fresh = fleet.machine("fresh");
      if (hydration === "a snapshot that kept the old place") {
        // A Worker from before this build, whose fold kept `zz` where the order put it.
        const olderWorker: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const response = await server.fetch(input, init);
          if (!String(input).includes("/snapshot")) return response;
          const body = (await response.json()) as { entities: Array<{ entity: string; entityId: string; state: Record<string, unknown> }> };
          for (const entity of body.entities) {
            if (entity.entity === "status" && entity.entityId === "@order" && Array.isArray(entity.state.order)) {
              const listed = (entity.state.order as string[]).filter((id) => id !== "zz");
              listed.splice(listed.indexOf("todo") + 1, 0, "zz");
              entity.state.order = listed;
            }
          }
          return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
        }) as typeof fetch;
        await fresh.sync({ fetchImpl: olderWorker });
      } else {
        await fresh.sync();
      }
      expect(order(fresh.db)).toEqual(order(nd.db));
    });
  }

  it("is left out of the order the service's fold and the tail fold hold, so neither hands out its old place", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const nd = fleet.machine("nd");
    await nd.sync();
    nd.store.addStatus({ id: "zz", category: "review", label: "ZZ", after: "todo" }, "vp");
    await nd.sync();
    const schema = Number((nd.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    await new OlderBuildDevice(server, REPO, "device-older", schema).push([
      { entity: "status", entityId: "zz", verb: "delete" as never, baseVersion: 1, payload: {} },
      { entity: "status", entityId: "zz", verb: "create", payload: { label: "ZZ", category: "review" } },
    ]);
    const orderIn = (entities: Array<{ entity: string; entityId: string; state: Record<string, unknown> }>): unknown =>
      entities.find((entity) => entity.entity === "status" && entity.entityId === "@order")?.state.order;
    // The service's fold.
    const token = `token-${nd.deviceId}`;
    const snapshot = (await (
      await server.fetch(`https://sync.test.example/v1/repos/${REPO}/snapshot`, {
        headers: { authorization: `Bearer ${token}`, "staple-protocol": "2" },
      })
    ).json()) as { entities: Array<{ entity: string; entityId: string; state: Record<string, unknown> }> };
    expect(orderIn(snapshot.entities)).toEqual(expect.arrayContaining(["todo"]));
    expect(orderIn(snapshot.entities)).not.toContain("zz");
    // This device's tail fold, over the same log.
    const folded = foldOperations(server.ops.map((op) => ({ ...op, actor: op.actor ?? "" })) as never);
    expect(orderIn(folded as never)).toEqual(expect.arrayContaining(["todo"]));
    expect(orderIn(folded as never)).not.toContain("zz");
  });
});
