/**
 * Two devices writing the same revision of a document keep both texts, and agree.
 *
 * A revision's number is its document's next, decided on the device that writes it, so two
 * devices that each write revision N before seeing the other's send two different revision
 * N's. Each device kept the first to arrive (`ON CONFLICT DO NOTHING`) and the service's fold
 * the last: A's text existed only on A, and B and every fresh device had B's. Now the log
 * decides, as it does for identifiers (`claims.ts`): the earlier write keeps N, the later
 * is the document's next free revision — its body, author and time kept, the move in its
 * change summary — on every device, in the fold and the tail fold alike, and the head is
 * the highest revision.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000189";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function doc(db: DatabaseSync, issueId: string, key: string): unknown {
  return {
    revisions: db
      .prepare("SELECT revision, body, author, change_summary, created_at FROM document_revisions WHERE issue_id = ? AND key = ? ORDER BY revision")
      .all(issueId, key),
    head: db.prepare("SELECT current_revision FROM documents WHERE issue_id = ? AND key = ?").get(issueId, key),
  };
}

async function devices(count: number, options: { fold?: "service" | "tail" } = {}) {
  const server = new FakeSyncServer({ repositoryId: REPO, ...(options.fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
  fleet = new Fleet(server, REPO);
  const machines: Machine[] = [];
  for (let n = 0; n < count; n += 1) machines.push(fleet.machine(["a", "b", "c"][n]!));
  machines[0]!.use();
  const issue = machines[0]!.store.createIssue({ title: "Documented" });
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
  const tail = fleet.machine("tail");
  await tail.sync();
  return { server, machines, issue, tail };
}

async function everywhere(machines: readonly Machine[], tail: Machine, issueId: string, key: string): Promise<unknown> {
  for (let round = 0; round < 2; round += 1) {
    for (const machine of [...machines, tail]) {
      machine.use();
      await machine.sync();
    }
  }
  const fresh = fleet!.machine("fresh");
  await fresh.sync();
  const expected = doc(machines[0]!.db, issueId, key);
  for (const machine of [...machines, tail, fresh]) expect(doc(machine.db, issueId, key), machine.label).toEqual(expected);
  return expected;
}

describe("a document revision written on two devices at once", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`keeps both texts, the earlier at its number and the later next, on every device (${fold} fold)`, async () => {
      const { machines, issue, tail } = await devices(2, { fold });
      const [a, b] = machines as [Machine, Machine];
      a.use();
      a.store.putDocument(issue.id, "plan", "A's plan", { author: "alice" });
      b.use();
      b.store.putDocument(issue.id, "plan", "B's plan", { author: "bob" });
      a.use();
      await a.sync();
      const settled = (await everywhere(machines, tail, issue.id, "plan")) as { revisions: Array<{ revision: number; body: string; change_summary: string | null }>; head: unknown };
      expect(settled.revisions.map((row) => [row.revision, row.body])).toEqual([
        [1, "A's plan"],
        [2, "B's plan"],
      ]);
      expect(settled.revisions[1]!.change_summary).toMatch(/^renumbered from r1 to r2/);
      expect(settled.head).toEqual({ current_revision: 2 });
    });
  }

  it("keeps both on top of a shared first revision", async () => {
    const { machines, issue, tail } = await devices(2);
    const [a, b] = machines as [Machine, Machine];
    a.use();
    a.store.putDocument(issue.id, "spec", "shared", { author: "alice" });
    await a.sync();
    b.use();
    await b.sync();
    a.use();
    a.store.putDocument(issue.id, "spec", "A's second", { author: "alice", baseRevision: 1 });
    b.use();
    b.store.putDocument(issue.id, "spec", "B's second", { author: "bob", baseRevision: 1 });
    a.use();
    await a.sync();
    const settled = (await everywhere(machines, tail, issue.id, "spec")) as { revisions: Array<{ revision: number; body: string }> };
    expect(settled.revisions.map((row) => [row.revision, row.body])).toEqual([
      [1, "shared"],
      [2, "A's second"],
      [3, "B's second"],
    ]);
  });

  it("keeps all three when three devices write it", async () => {
    const { machines, issue, tail } = await devices(3);
    for (const [index, machine] of machines.entries()) {
      machine.use();
      machine.store.putDocument(issue.id, "plan", `plan ${index}`, { author: machine.label });
    }
    for (const machine of machines) {
      machine.use();
      await machine.sync();
    }
    const settled = (await everywhere(machines, tail, issue.id, "plan")) as { revisions: Array<{ revision: number; body: string }> };
    expect(settled.revisions.map((row) => row.body).sort()).toEqual(["plan 0", "plan 1", "plan 2"]);
    expect(settled.revisions.map((row) => row.revision)).toEqual([1, 2, 3]);
  });

  it("keeps an older build's text and this build's, whichever reached the log first", async () => {
    const { server, machines, issue, tail } = await devices(1);
    const [a] = machines as [Machine];
    a.use();
    a.store.putDocument(issue.id, "plan", "A's plan", { author: "alice" });
    // A build from before this one writes revision 1 first, and never settles anything.
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    await new OlderBuildDevice(server, REPO, "device-older", schema).push([
      {
        entity: "documentRevision",
        entityId: `${issue.id}/plan/1`,
        verb: "create",
        payload: { issueId: issue.id, key: "plan", revision: 1, body: "the older build's plan", title: null, changeSummary: null, author: "older", createdAt: "2026-09-11T00:00:00.000Z" },
      },
    ]);
    await a.sync();
    const settled = (await everywhere(machines, tail, issue.id, "plan")) as { revisions: Array<{ revision: number; body: string }> };
    expect(settled.revisions.map((row) => [row.revision, row.body])).toEqual([
      [1, "the older build's plan"],
      [2, "A's plan"],
    ]);
  });
});
