/**
 * A status or kind removed on one device while another moves an issue into it.
 *
 * Locally, removing a status or kind that an issue holds is refused unless the removal
 * names where those issues go (`--migrate-to`), so no issue ever holds a status or kind its
 * workspace does not define. Across devices the removal and the move were each legal where
 * they were made, and the issue ended on a status that existed on no device.
 *
 * The rule (`docs/sync.md`, "A removal and a move into it"): the removal names where its
 * issues go, and that is where an issue moved into it goes too — on every device, in
 * either log order, and on a device that hydrates afterwards.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000162";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function issue(db: DatabaseSync, id: string): unknown {
  return db.prepare("SELECT status, kind FROM issues WHERE id = ?").get(id);
}

/** Issues holding a status or kind this database does not define. */
function undefinedReferences(db: DatabaseSync): unknown[] {
  return db
    .prepare(
      `SELECT id, status, kind FROM issues
        WHERE status NOT IN (SELECT id FROM workspace_statuses) OR kind NOT IN (SELECT id FROM workspace_kinds)`,
    )
    .all();
}

describe("a removal and a move into what it removes", () => {
  for (const order of ["removal first", "move first"] as const) {
    it(`ends with the issue where the removal said, on every device (${order})`, async () => {
      fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
      const a = fleet.machine("a");
      const moved = a.store.createIssue({ title: "Moved into it on B" });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      // A removes a built-in status and a built-in kind nothing holds on A, naming a target;
      // B, not having seen either, moves an issue into both.
      a.store.removeStatus("in_review", { migrateTo: "todo" });
      a.store.removeKind("spike", { migrateTo: "chore" });
      b.store.updateIssue(moved.id, { status: "in_review", kind: "spike" });

      const [first, second] = order === "removal first" ? [a, b] : [b, a];
      await first.sync();
      await second.sync();
      await first.sync();
      const fresh = fleet.machine("fresh");
      await fresh.sync();

      for (const machine of [a, b, fresh]) {
        expect(issue(machine.db, moved.id), machine.label).toEqual({ status: "todo", kind: "chore" });
        expect(undefinedReferences(machine.db), machine.label).toEqual([]);
      }
      expect((await a.sync()).pending).toBe(0);
      expect((await b.sync()).pending).toBe(0);
    });
  }

  it("with no target named — nothing held it where it was removed — goes to the first of the same category", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.addStatus({ id: "qa", category: "review", label: "QA" });
    const moved = a.store.createIssue({ title: "Moved into it on B" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    a.store.removeStatus("qa");
    b.store.updateIssue(moved.id, { status: "qa" });
    await b.sync();
    await a.sync();
    await b.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [a, b, fresh]) {
      expect(issue(machine.db, moved.id), machine.label).toEqual({ status: "in_review", kind: "task" });
      expect(undefinedReferences(machine.db), machine.label).toEqual([]);
    }
  });
});
