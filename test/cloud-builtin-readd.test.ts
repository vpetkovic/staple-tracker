/**
 * A built-in status or kind removed and added back is not a built-in, on every device.
 *
 * Every device holds the built-ins from its own migrations. Removed and added back, the one
 * added back is the workspace's own (`is_builtin` 0) on the device that did it and on every
 * device that read the removal in the tail — but a device hydrating afterwards met the create
 * over the built-in it already had, and the create never said otherwise: `spike` and
 * `in_review` stayed built-ins there alone. The create says it now (`isBuiltin`), and for a
 * create from a build before this one, the service's fold says it for a create after a delete.
 * The registry in `sync-mutation-convergence.test.ts` holds this build's writer to it.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000018b";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function vocabulary(db: DatabaseSync): unknown {
  return {
    statuses: db.prepare("SELECT id, label, category, is_builtin FROM workspace_statuses ORDER BY id").all(),
    kinds: db.prepare("SELECT id, label, is_builtin FROM workspace_kinds ORDER BY id").all(),
  };
}

function builtin(db: DatabaseSync, table: "workspace_statuses" | "workspace_kinds", id: string): unknown {
  return db.prepare(`SELECT is_builtin FROM ${table} WHERE id = ?`).get(id);
}

async function agree(machines: readonly Machine[]): Promise<void> {
  for (let round = 0; round < 2; round += 1) {
    for (const machine of machines) {
      machine.use();
      await machine.sync();
    }
  }
  const fresh = fleet!.machine("fresh");
  await fresh.sync();
  const expected = vocabulary(machines[0]!.db);
  for (const machine of [...machines, fresh]) expect(vocabulary(machine.db), machine.label).toEqual(expected);
}

describe("a built-in removed and added back", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`is not a built-in anywhere when a build before this one adds it back (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.createIssue({ title: "Something to sync" });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      a.use();
      a.store.removeKind("spike", { migrateTo: "task" }, "alice");
      a.store.removeStatus("in_review", { migrateTo: "todo" }, "alice");
      await a.sync();
      // Added back by a build that sends a create with no word on whether it is a built-in.
      const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
      await new OlderBuildDevice(server, REPO, "device-older", schema).push([
        { entity: "kind", entityId: "spike", verb: "create", payload: { id: "spike", label: "Spike" } },
        { entity: "status", entityId: "in_review", verb: "create", payload: { id: "in_review", label: "In review", category: "review" } },
      ]);
      await agree([a, b]);
      expect(builtin(a.db, "workspace_kinds", "spike")).toEqual({ is_builtin: 0 });
      expect(builtin(a.db, "workspace_statuses", "in_review")).toEqual({ is_builtin: 0 });
    });
  }

  it("is not a built-in anywhere when a workspace did it before it joined", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "Something to sync" });
    await a.sync();
    const j = fleet.machine("j");
    j.store.removeKind("spike", { migrateTo: "task" }, "alice");
    j.store.addKind({ id: "spike", label: "Spike" }, "alice");
    expect(builtin(j.db, "workspace_kinds", "spike")).toEqual({ is_builtin: 0 });
    await j.sync();
    await agree([j, a]);
    expect(builtin(a.db, "workspace_kinds", "spike")).toEqual({ is_builtin: 0 });
  });

  it("says so in its own create, for a service whose fold does not", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    a.store.removeKind("spike", { migrateTo: "task" }, "alice");
    a.store.addKind({ id: "spike", label: "Spike" }, "alice");
    a.store.removeStatus("in_review", { migrateTo: "todo" }, "alice");
    a.store.addStatus({ id: "in_review", category: "review", label: "In review" }, "alice");
    const creates = a.db
      .prepare("SELECT entity, payload FROM sync_outbox WHERE verb = 'create' AND entity IN ('kind', 'status') ORDER BY client_seq")
      .all() as Array<{ entity: string; payload: string }>;
    expect(creates.map((row) => [row.entity, (JSON.parse(row.payload) as { isBuiltin?: unknown }).isBuiltin])).toEqual([
      ["kind", false],
      ["status", false],
    ]);
  });

  it("stays a built-in everywhere when it was only relabelled", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "Something to sync" });
    a.store.renameKind("spike", "Investigation", "alice");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    await agree([a, b]);
    expect(builtin(b.db, "workspace_kinds", "spike")).toEqual({ is_builtin: 1 });
  });
});
