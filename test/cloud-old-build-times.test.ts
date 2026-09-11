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

  it("is dated the same on the device that wrote it, once that device runs this build", async () => {
    const { a, tail, issueId, commentId } = await withOlderBuildHistory();
    // Measured live (56ff1f4): the older build's store dated its own row, then journaled the
    // operation with a second reading of the clock, a millisecond later. Every other device
    // holds the operation's time; the device that wrote it held its own. This is its row, and
    // an applier from before this build, which never looked again.
    tail.db.prepare("UPDATE comments SET created_at = '2026-08-01T09:29:59.999Z' WHERE id = ?").run(commentId);
    tail.db.prepare("UPDATE document_revisions SET created_at = '2026-08-01T09:29:59.999Z' WHERE issue_id = ?").run(issueId);
    tail.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    expect((await tail.sync()).caughtUp).not.toBeNull();
    await a.sync();
    expect(comment(tail.db, commentId)).toEqual({ author: "old-build-agent", created_at: WRITTEN });
    expect(revision(tail.db, issueId)).toEqual(revision(a.db, issueId));
    expect(revision(a.db, issueId)).toEqual({ author: "older-build", created_at: WRITTEN });
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

    expect((await tail.sync({ fetchImpl: olderWorker })).caughtUp).not.toBeNull();
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
});
