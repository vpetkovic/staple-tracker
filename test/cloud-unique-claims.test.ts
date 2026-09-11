/**
 * Two connected devices creating the same unique value offline do not wedge anybody.
 *
 * A project slug, an issue's retry key, a live external origin, a comment's retry key:
 * each is `UNIQUE` in every workspace database. Two devices that each created a project
 * called `web` offline both pushed a create for it, and the second create failed the
 * receiver's `UNIQUE` index — which fails the whole page, rolls it back, and leaves the
 * cursor where it was, so that device stopped at that page on every sync for good. The
 * seed prevented it for a device joining with pre-existing data; nothing prevented it for
 * two devices that were already connected.
 *
 * The rule is the identifier's (`src/core/cloud/claims.ts`): the earlier claim in the log
 * keeps the value, and the later one's own device settles it for everybody.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000000e5";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function row(db: DatabaseSync, sql: string, id: string): Record<string, unknown> {
  return db.prepare(sql).get(id) as Record<string, unknown>;
}

interface Made {
  project: string;
  keyed: string;
  imported: string;
  comment: string;
}

/** Everything one device makes offline that collides with the other's. */
function makeDuplicates(machine: Machine, shared: string): Made {
  const project = machine.store.projects().create({ name: "Web" }, "someone").id;
  const keyed = machine.store.createIssue({ title: `Retried on ${machine.label}`, idempotencyKey: "retry-7" }).id;
  const imported = machine.store.createIssue({
    title: `Imported on ${machine.label}`,
    originKind: "github",
    originId: "acme/web#12",
  }).id;
  const comment = machine.store.addComment(shared, `Retried comment from ${machine.label}`, "agent", "agent", {
    idempotencyKey: "comment-retry-3",
  }).id;
  return { project, keyed, imported, comment };
}

describe("unique values two devices claimed offline", () => {
  for (const order of ["a first", "b first"] as const) {
    it(`are settled by log order, with no page wedged, on every device (${order})`, async () => {
      fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
      const a = fleet.machine("a");
      const shared = a.store.createIssue({ title: "Shared" }).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      const fromA = makeDuplicates(a, shared);
      const fromB = makeDuplicates(b, shared);
      const [first, second] = order === "a first" ? [a, b] : [b, a];
      const [earlier, later] = order === "a first" ? [fromA, fromB] : [fromB, fromA];

      // Neither sync throws: before this, the second device's pull failed on a UNIQUE
      // index here, and so did every sync after it.
      await first.sync();
      await second.sync();
      await first.sync();
      const fresh = fleet.machine("fresh");
      await fresh.sync();

      for (const machine of [a, b, fresh]) {
        const label = machine.label;
        expect(row(machine.db, "SELECT slug FROM projects WHERE id = ?", earlier.project), label).toEqual({ slug: "web" });
        expect(row(machine.db, "SELECT slug FROM projects WHERE id = ?", later.project), label).toEqual({ slug: "web-2" });
        expect(row(machine.db, "SELECT idempotency_key AS k FROM issues WHERE id = ?", earlier.keyed), label).toEqual({ k: "retry-7" });
        expect(row(machine.db, "SELECT idempotency_key AS k FROM issues WHERE id = ?", later.keyed), label).toEqual({ k: null });
        expect(row(machine.db, "SELECT origin_id AS o FROM issues WHERE id = ?", earlier.imported), label).toEqual({ o: "acme/web#12" });
        expect(row(machine.db, "SELECT origin_id AS o FROM issues WHERE id = ?", later.imported), label).toEqual({ o: null });
        expect(row(machine.db, "SELECT idempotency_key AS k FROM comments WHERE id = ?", earlier.comment), label).toEqual({ k: "comment-retry-3" });
        expect(row(machine.db, "SELECT idempotency_key AS k FROM comments WHERE id = ?", later.comment), label).toEqual({ k: null });
        expect(listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null), label).toEqual([]);
      }
      expect((await first.sync()).pending).toBe(0);
      expect((await second.sync()).pending).toBe(0);
    });
  }

  it("reopening an imported issue whose origin another device has since imported again settles the same way", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const old = a.store.createIssue({ title: "Imported once", originKind: "github", originId: "acme/web#40" }).id;
    a.store.updateIssue(old, { status: "done" });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    // B imports the same external issue again; A reopens the old one. Both are live now.
    const again = b.store.createIssue({ title: "Imported again", originKind: "github", originId: "acme/web#40" }).id;
    await b.sync();
    a.store.updateIssue(old, { status: "todo" });
    await a.sync();
    await b.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();

    // B's import landed first, so it keeps the origin; the reopened issue gave it up.
    for (const machine of [a, b, fresh]) {
      expect(row(machine.db, "SELECT origin_id AS o FROM issues WHERE id = ?", again), machine.label).toEqual({ o: "acme/web#40" });
      expect(row(machine.db, "SELECT origin_id AS o, status FROM issues WHERE id = ?", old), machine.label).toEqual({
        o: null,
        status: "todo",
      });
    }
  });
});
