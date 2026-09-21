/**
 * A comment or document revision written by an older build is dated and attributed the
 * same way on every device, whichever half of a bootstrap delivered it.
 *
 * Builds before comments and revisions carried their own `createdAt` (and revisions their
 * `author`) in the payload left a receiver to take both from the operation. A device
 * reading the ordered tail has the operation; a device hydrating from the snapshot did not
 * — a snapshot is a fold, with no operation behind each entity — so it stamped every such
 * comment and revision with the moment it hydrated, attributed each revision to nobody,
 * and disagreed with every other device about both for good. The fold now carries the time
 * and actor of each entity's create, and a restore writes them back.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000118";
const WRITTEN = "2026-08-01T09:30:00.000Z";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function comment(db: DatabaseSync, id: string): unknown {
  return db.prepare("SELECT author, created_at FROM comments WHERE id = ?").get(id);
}

function revision(db: DatabaseSync, issueId: string): unknown {
  return db.prepare("SELECT author, created_at FROM document_revisions WHERE issue_id = ?").get(issueId);
}

/** A repository holding an older build's comment and revision, and a device on its tail. */
async function withOlderBuildHistory(): Promise<{ server: FakeSyncServer; a: Machine; tail: Machine; issueId: string; commentId: string }> {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  const issue = a.store.createIssue({ title: "Discussed on an older build" });
  await a.sync();
  const tail = fleet.machine("tail");
  await tail.sync();

  const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
  const commentId = randomUUID();
  // Exactly what a build before the fix journaled: no `createdAt`, and no `author` on the revision.
  await new OlderBuildDevice(server, REPO, "device-old", schema).push([
    {
      entity: "comment",
      entityId: commentId,
      verb: "create",
      payload: { issueId: issue.id, author: "old-build-agent", authorType: "agent", body: "Written before the fix." },
      createdAt: WRITTEN,
    },
    {
      entity: "documentRevision",
      entityId: `${issue.id}/plan/1`,
      verb: "create",
      payload: { issueId: issue.id, key: "plan", revision: 1, body: "first draft", title: null },
      createdAt: WRITTEN,
    },
  ]);
  await tail.sync();
  return { server, a, tail, issueId: issue.id, commentId };
}

describe("history an older build wrote, without its own dates", () => {
  it("is dated and attributed the same by a device on the tail and one hydrating from the snapshot", async () => {
    const { tail, issueId, commentId } = await withOlderBuildHistory();
    const fresh = fleet!.machine("fresh");
    await fresh.sync();

    expect(comment(tail.db, commentId)).toEqual({ author: "old-build-agent", created_at: WRITTEN });
    expect(revision(tail.db, issueId)).toEqual({ author: "older-build", created_at: WRITTEN });
    expect(comment(fresh.db, commentId)).toEqual(comment(tail.db, commentId));
    expect(revision(fresh.db, issueId)).toEqual(revision(tail.db, issueId));
  });

  it("is dated and attributed the same on all four devices, the one that wrote it included", async () => {
    const { a, tail, issueId, commentId } = await withOlderBuildHistory();
    // Measured live (56ff1f4): the older build's store dated its own row, then journaled the
    // operation with a second reading of the clock, a millisecond later — and wrote its own
    // name on the revision. That is the writer's row. The create is a genuine device
    // operation, so its envelope time and actor are canonical, and the writer is re-dated
    // to them once, by the catch-up.
    const writer = tail;
    writer.db.prepare("UPDATE comments SET created_at = '2026-08-01T09:29:59.999Z' WHERE id = ?").run(commentId);
    writer.db
      .prepare("UPDATE document_revisions SET created_at = '2026-08-01T09:29:59.999Z', author = 'old-build-agent' WHERE issue_id = ?")
      .run(issueId);
    writer.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    expect((await writer.sync()).caughtUp).not.toBeNull();
    await a.sync();
    const fresh = fleet!.machine("fresh");
    await fresh.sync();
    const late = fleet!.machine("late");
    await late.sync();
    for (const machine of [a, writer, fresh, late]) {
      expect(comment(machine.db, commentId), machine.label).toEqual({ author: "old-build-agent", created_at: WRITTEN });
      expect(revision(machine.db, issueId), machine.label).toEqual({ author: "older-build", created_at: WRITTEN });
    }
  });

  it("dates and attributes a revision the writer holds as the same text by its create, on the re-read", async () => {
    const { a, tail, issueId } = await withOlderBuildHistory();
    // The same revision — its body, and no author to tell it from the log's — dated by the
    // older build's second reading of the clock. The log's placement keeps the row and gives
    // it the create's time and actor (`takeLogFields`, `canonicalCreate`).
    const writer = tail;
    writer.db.prepare("UPDATE document_revisions SET created_at = '2026-08-01T09:29:59.999Z', author = NULL WHERE issue_id = ?").run(issueId);
    writer.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();
    expect((await writer.sync()).caughtUp).not.toBeNull();
    await a.sync();
    const fresh = fleet!.machine("fresh");
    await fresh.sync();
    for (const machine of [a, writer, fresh]) {
      expect(revision(machine.db, issueId), machine.label).toEqual({ author: "older-build", created_at: WRITTEN });
    }
  });

  it("is not re-dated by a re-read from a service that does not send the create's time", async () => {
    const { server, tail, commentId } = await withOlderBuildHistory();
    const own = "2026-08-01T09:29:59.999Z";
    tail.db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(own, commentId);
    tail.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();
    // A Worker from before the fold kept each entity's create: its snapshot says nothing of
    // when, and the moment of the re-read is no better than the time the device holds.
    const olderWorker: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await server.fetch(input, init);
      if (!String(input).includes("/snapshot")) return response;
      const body = (await response.json()) as { entities: Array<Record<string, unknown>> };
      for (const entity of body.entities) {
        delete entity.createdSeq;
        delete entity.createdAt;
      }
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    }) as typeof fetch;

    // It does not re-read from that Worker at all (`servedByCurrentFold` in `sync.ts`).
    expect((await tail.sync({ fetchImpl: olderWorker })).caughtUp).toBeNull();
    expect(comment(tail.db, commentId)).toEqual({ author: "old-build-agent", created_at: own });
  });

  it("keeps its date and author through a backup and a restore", async () => {
    const { server, a, tail, issueId, commentId } = await withOlderBuildHistory();
    await a.sync();
    const options = { fetchImpl: server.fetch, sleep: async () => undefined };
    await setBackupConsent(a.home, REPO, true, options);
    const backup = await createBackup(a.home, REPO, null, options);
    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, options);

    const fresh = fleet!.machine("fresh");
    await fresh.sync();
    expect(comment(fresh.db, commentId)).toEqual(comment(tail.db, commentId));
    expect(revision(fresh.db, issueId)).toEqual(revision(tail.db, issueId));
  });

  /**
   * A backup the Worker before this build made keeps no create time or actor, so restoring
   * it — by that Worker, or by this one — stages every entity as a `create` by
   * `restore:<id>` at the moment it ran. Read as the entity's create, that dated every old
   * comment with the restore instant and attributed every old revision to the restore, on
   * every device that re-read it, the ones that held the true values included.
   */
  for (const restoredBy of ["the Worker before this build", "this Worker"] as const) {
    it(`an old-shaped backup restored by ${restoredBy} re-dates and re-attributes nothing`, async () => {
      const { server, a, tail, issueId, commentId } = await withOlderBuildHistory();
      await a.sync();
      // The tail holds values of its own (as the writer would, a millisecond off): after the
      // restore there is no true time to converge on, so each device keeps what it holds.
      const own = "2026-08-01T09:29:59.999Z";
      tail.db.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(own, commentId);
      tail.db.prepare("UPDATE document_revisions SET created_at = ? WHERE issue_id = ?").run(own, issueId);
      const options = { fetchImpl: server.fetch, sleep: async () => undefined };
      await setBackupConsent(a.home, REPO, true, options);
      server.legacyFold = true;
      const backup = await createBackup(a.home, REPO, null, options);
      server.legacyFold = restoredBy === "the Worker before this build";
      a.use();
      await restoreFromBackup(a.db, a.home, REPO, backup.backupId, options);
      server.legacyFold = false;
      await a.sync();
      await tail.sync();

      expect(comment(a.db, commentId)).toEqual({ author: "old-build-agent", created_at: WRITTEN });
      expect(revision(a.db, issueId)).toEqual({ author: "older-build", created_at: WRITTEN });
      expect(comment(tail.db, commentId)).toEqual({ author: "old-build-agent", created_at: own });
      expect(revision(tail.db, issueId)).toEqual({ author: "older-build", created_at: own });
      // A device hydrating the restored epoch cannot learn what the backup never kept — but
      // it is not told the restore wrote them.
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect((revision(fresh.db, issueId) as { author: string | null }).author ?? "").not.toMatch(/^restore:/);
      expect((comment(fresh.db, commentId) as { created_at: string }).created_at).not.toBe(
        server.ops.find((op) => op.entity === "comment" && op.actor.startsWith("restore:"))?.createdAt,
      );
    });
  }
});
