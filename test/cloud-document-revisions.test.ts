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
    head: db.prepare("SELECT current_revision, updated_at FROM documents WHERE issue_id = ? AND key = ?").get(issueId, key),
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
      expect(settled.head).toMatchObject({ current_revision: 2 });
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

  /**
   * D1-b. The later writer had three revisions in flight. It moved the first one past its own
   * highest, and its history read backwards: its older text was the current document on it
   * alone. Every revision of its own the log had not reached is placed again after the earlier
   * one, in the order it wrote them, by the one rule every device and fold uses.
   */
  for (const fold of ["service", "tail"] as const) {
    it(`places a writer's revisions after an earlier one in the order it wrote them, however many are in flight (${fold} fold)`, async () => {
      const { machines, issue, tail } = await devices(2, { fold });
      const [a, b] = machines as [Machine, Machine];
      a.use();
      a.store.putDocument(issue.id, "spec", "v1", { author: "alice" });
      await a.sync();
      b.use();
      await b.sync();
      a.use();
      a.store.putDocument(issue.id, "spec", "A's edit", { author: "alice", baseRevision: 1 });
      b.use();
      const mine = ["B's first edit", "B's second edit", "B's third edit (latest)"];
      mine.forEach((text, index) => b.store.putDocument(issue.id, "spec", text, { author: "bob", baseRevision: index + 1 }));
      a.use();
      await a.sync();
      b.use();
      await b.sync();
      const settled = (await everywhere(machines, tail, issue.id, "spec")) as {
        revisions: Array<{ revision: number; body: string; change_summary: string | null; created_at: string }>;
        head: { current_revision: number; updated_at: string };
      };
      expect(settled.revisions.map((row) => [row.revision, row.body])).toEqual([
        [1, "v1"],
        [2, "A's edit"],
        [3, "B's first edit"],
        [4, "B's second edit"],
        [5, "B's third edit (latest)"],
      ]);
      expect(settled.revisions.slice(2).map((row) => row.change_summary)).toEqual([
        expect.stringMatching(/^renumbered from r2 to r3/),
        expect.stringMatching(/^renumbered from r3 to r4/),
        expect.stringMatching(/^renumbered from r4 to r5/),
      ]);
      // The head is the latest text, dated by it, on the writer too.
      expect(settled.head).toEqual({ current_revision: 5, updated_at: settled.revisions[4]!.created_at });
      b.use();
      expect(b.store.getDocument(issue.id, "spec")).toMatchObject({ revision: 5, body: "B's third edit (latest)" });
    });
  }

  it("dates the head by its highest revision, whatever arrived last", async () => {
    const { server, machines, issue, tail } = await devices(1);
    const [a] = machines as [Machine];
    a.use();
    a.store.putDocument(issue.id, "plan", "first", { author: "alice" });
    await a.sync();
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const first = a.db.prepare("SELECT body, author, created_at FROM document_revisions WHERE issue_id = ? AND revision = 1").get(issue.id) as { body: string; author: string; created_at: string };
    // A second revision, and then the first sent again — a revision re-sent under its number
    // after a later one landed — from a build that sends what it holds.
    await new OlderBuildDevice(server, REPO, "device-older", schema).push([
      {
        entity: "documentRevision",
        entityId: `${issue.id}/plan/2`,
        verb: "create",
        payload: { issueId: issue.id, key: "plan", revision: 2, body: "second", title: null, changeSummary: null, author: "older", createdAt: "2026-09-11T10:00:00.000Z" },
      },
      {
        entity: "documentRevision",
        entityId: `${issue.id}/plan/1`,
        verb: "create",
        payload: { issueId: issue.id, key: "plan", revision: 1, body: first.body, title: null, changeSummary: null, author: first.author, createdAt: first.created_at },
      },
    ]);
    const settled = (await everywhere(machines, tail, issue.id, "plan")) as { head: unknown };
    expect(settled.head).toEqual({ current_revision: 2, updated_at: "2026-09-11T10:00:00.000Z" });
  });
});

/**
 * D1-c and D1-d: a device re-reading the log after an upgrade takes the log's placement for
 * every revision it holds that it did not write — matched by body and author, never by time —
 * with no copy and no renumber.
 */
describe("a document's revisions on a device an older build applied", () => {
  /**
   * D1-c, in the deploy order the docs require. On c7a49d6 with the Worker from before this
   * build, ca and cb both write `notes` r2 and sync; that fold merged the two into one row with
   * the later body, and cc joined from it. Then the new Worker, every device upgraded, and a
   * fresh cf. cc held the merged row and, on its re-read, moved the log's earlier text up as
   * though it were the newer: `2=B 3=A` against everyone's `2=A 3=B`, for good.
   */
  it("re-reads a merged revision from the fold before this build into the log's order", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    server.legacyFold = true;
    fleet = new Fleet(server, REPO);
    const ca = fleet.machine("ca");
    const issue = ca.store.createIssue({ title: "Documented" });
    ca.store.putDocument(issue.id, "notes", "body 0", { author: "ca" });
    await ca.sync();
    const cb = fleet.machine("cb");
    await cb.sync();
    // Both r2s, as c7a49d6 sends them: a create each, and nothing after.
    const schema = Number((ca.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const older = new OlderBuildDevice(server, REPO, "device-c7a49d6", schema);
    const r2 = (body: string, author: string, createdAt: string) => ({
      entity: "documentRevision",
      entityId: `${issue.id}/notes/2`,
      verb: "create" as const,
      payload: { issueId: issue.id, key: "notes", revision: 2, body, title: null, changeSummary: null, author, createdAt },
    });
    await older.push([r2("body A", "ca", "2026-09-11T10:00:00.000Z")]);
    await older.push([r2("body B", "cb", "2026-09-11T10:00:05.000Z")]);
    // cc joins from the merged row: r2 is "body B", and "body A" is nowhere in that snapshot.
    const cc = fleet.machine("cc");
    await cc.sync();
    expect(doc(cc.db, issue.id, "notes")).toMatchObject({ revisions: [{ revision: 1 }, { revision: 2, body: "body B" }] });
    // What c7a49d6's applier held on the writers: the first r2 to arrive, and no applier generation.
    for (const [machine, kept] of [[ca, "body A"], [cb, "body B"]] as const) {
      machine.use();
      await machine.sync();
      machine.db.prepare("DELETE FROM document_revisions WHERE issue_id = ? AND revision > 1").run(issue.id);
      machine.db
        .prepare("INSERT INTO document_revisions (issue_id, key, revision, body, author, change_summary, created_at) VALUES (?, 'notes', 2, ?, ?, NULL, ?)")
        .run(issue.id, kept, kept === "body A" ? "ca" : "cb", kept === "body A" ? "2026-09-11T10:00:00.000Z" : "2026-09-11T10:00:05.000Z");
      machine.db.prepare("UPDATE documents SET current_revision = 2 WHERE issue_id = ?").run(issue.id);
      machine.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();
    }
    for (const machine of [ca, cb, cc]) machine.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    // The new Worker; every device upgraded; a fresh device.
    server.legacyFold = false;
    for (const machine of [ca, cb, cc]) {
      machine.use();
      await machine.sync();
    }
    const cf = fleet.machine("cf");
    await cf.sync();
    const expected = doc(cf.db, issue.id, "notes") as { revisions: Array<{ revision: number; body: string; change_summary: string | null }>; head: unknown };
    expect(expected.revisions.map((row) => [row.revision, row.body])).toEqual([
      [1, "body 0"],
      [2, "body A"],
      [3, "body B"],
    ]);
    expect(expected.revisions[2]!.change_summary).toMatch(/^renumbered from r2 to r3/);
    expect(expected.head).toEqual({ current_revision: 3, updated_at: "2026-09-11T10:00:05.000Z" });
    for (const machine of [ca, cb, cc]) expect(doc(machine.db, issue.id, "notes"), machine.label).toEqual(expected);
    cc.use();
    expect(cc.store.getDocument(issue.id, "notes")).toMatchObject({ revision: 3, body: "body B" });
  });

  /**
   * D1-d. 56ff1f4 dated a revision it applied by its operation — a millisecond off the time
   * the revision carries. Compared by time, every revision such a device held read as another,
   * and its re-read renumbered the log's copy of each: `1, 2, 3=body 0, 4=body A`, head r4,
   * against everyone's head r2.
   */
  it("takes revisions an older build dated by their operations as the log's, with no copies", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const yn = fleet.machine("yn");
    const issue = yn.store.createIssue({ title: "Documented" });
    yn.store.putDocument(issue.id, "notes", "body 0", { author: "yn" });
    yn.store.putDocument(issue.id, "notes", "body A", { author: "yn", baseRevision: 1 });
    await yn.sync();
    const ya = fleet.machine("ya");
    await ya.sync();
    // What 56ff1f4 held after pulling them: each dated by its operation, a millisecond off.
    const later = (iso: string): string => new Date(Date.parse(iso) + 1).toISOString();
    for (const row of ya.db.prepare("SELECT revision, created_at FROM document_revisions WHERE issue_id = ?").all(issue.id) as Array<{ revision: number; created_at: string }>) {
      ya.db.prepare("UPDATE document_revisions SET created_at = ? WHERE issue_id = ? AND revision = ?").run(later(row.created_at), issue.id, row.revision);
    }
    const head = ya.db.prepare("SELECT updated_at FROM documents WHERE issue_id = ?").get(issue.id) as { updated_at: string };
    ya.db.prepare("UPDATE documents SET updated_at = ? WHERE issue_id = ?").run(later(head.updated_at), issue.id);
    ya.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    expect((await ya.sync()).caughtUp).not.toBeNull();
    // And r2 sent again as such a build holds it — dated a millisecond off — is r2, on every
    // device reading it in the tail and in the fold alike.
    const schema = Number((yn.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const r2 = yn.db.prepare("SELECT body, author, created_at FROM document_revisions WHERE issue_id = ? AND revision = 2").get(issue.id) as { body: string; author: string; created_at: string };
    await new OlderBuildDevice(fleet.server, REPO, "device-56ff1f4", schema).push([
      {
        entity: "documentRevision",
        entityId: `${issue.id}/notes/2`,
        verb: "create",
        payload: { issueId: issue.id, key: "notes", revision: 2, body: r2.body, title: null, changeSummary: null, author: r2.author, createdAt: later(r2.created_at) },
      },
    ]);
    for (const machine of [yn, ya]) {
      machine.use();
      await machine.sync();
    }
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const expected = doc(yn.db, issue.id, "notes") as { revisions: unknown[]; head: unknown };
    expect(expected.revisions).toHaveLength(2);
    expect(expected.head).toMatchObject({ current_revision: 2 });
    expect(doc(ya.db, issue.id, "notes")).toEqual(expected);
    expect(doc(fresh.db, issue.id, "notes")).toEqual(expected);
  });
});
