/**
 * What a device sees of the service's fold checkpoint (`worker/src/fold-store.ts`).
 *
 * The Worker keeps its fold of the log in D1 and moves it on a request's budget at a time —
 * 500 operations on the free plan. Straight after it is deployed onto a large log, before
 * devices have synced it along, the fold is behind the head, and three things follow that a
 * device can observe:
 *
 *   - a new device's first snapshot page is answered "still folding" until the fold is within a
 *     step of the head, and the client asks again while each answer shows progress;
 *   - `backup create` is answered "still folding" (`unavailable`, `foldedSeq`) until the fold
 *     reaches the head, and the client asks again while each answer shows progress;
 *   - so is the first turn of a restore, which changes nothing until the fold is ready.
 *
 * The fake folds 4 operations a request here, as the Worker folds 500.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { SNAPSHOT_FOLD_PATIENCE, cloudCodeOf, fetchSnapshotPage } from "../src/core/cloud/client.js";
import { parseEndpoint } from "../src/core/cloud/endpoint.js";
import { setConsent } from "../src/core/cloud/connection.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { ENDPOINT, Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000666";
const BUDGET = 4;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function everything(db: DatabaseSync): unknown {
  return {
    issues: db.prepare("SELECT id, identifier, title, status, updated_at FROM issues ORDER BY id").all(),
    comments: db.prepare("SELECT id, body, author, created_at FROM comments ORDER BY id").all(),
    plan: db.prepare("SELECT issue_id, added_by, note FROM queue_entries ORDER BY rank").all(),
    statuses: db.prepare("SELECT id, label FROM workspace_statuses ORDER BY sort_order, id").all(),
  };
}

/**
 * A repository of a few dozen operations — issues, comments, a plan with notes, a status
 * removed and added again — whose fold the service has not started: the Worker just deployed.
 */
async function unfolded(budget = BUDGET): Promise<{ server: FakeSyncServer; a: Machine }> {
  const server = new FakeSyncServer({ repositoryId: REPO, foldBudget: budget, foldStep: BUDGET });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  await a.sync();
  const first = a.store.createIssue({ title: "Planned" });
  a.store.queue().enqueue(first.id, { note: "why it is first" }, "alice");
  a.store.addStatus({ id: "r1", category: "review", label: "R1" });
  await a.sync();
  a.store.removeStatus("r1");
  a.store.addStatus({ id: "r1", category: "review", label: "R1 again" });
  for (let n = 0; n < 30; n += 1) {
    const issue = a.store.createIssue({ title: `Issue ${n}` });
    if (n % 5 === 0) a.store.addComment(issue.id, `comment ${n}`, "agent-a", "agent");
  }
  await a.sync();
  server.foldedTo.clear();
  return { server, a };
}

async function allowBackup(machine: Machine, server: FakeSyncServer): Promise<void> {
  setConsent(machine.home, REPO, { backup: true });
  await setBackupConsent(machine.home, REPO, true, { fetchImpl: server.fetch });
}

describe("a device meeting a service that is still folding", () => {
  it("joins at the head once the service has folded to it, waiting while it does", async () => {
    // A fold that reaches the head within a page's patience, so the snapshot is what serves it.
    const { server, a } = await unfolded(12);
    const fresh = fleet!.machine("fresh");
    let refusals = 0;
    const report = await fresh.sync({ onFolding: () => (refusals += 1) });
    // Never a snapshot short of the head: that is where the first page is pinned, as it was.
    expect(report.bootstrap?.cutoffSeq).toBe(server.lastSeq);
    expect(refusals).toBeGreaterThan(2);
    expect(refusals).toBeLessThan(SNAPSHOT_FOLD_PATIENCE.answers);
    expect(report.bootstrap?.fromTail).toBeFalsy();
    expect(everything(fresh.db)).toEqual(everything(a.db));
  });

  it("takes a backup once the fold reaches the head, waiting while it is told the fold is moving", async () => {
    const { server, a } = await unfolded();
    await allowBackup(a, server);
    const seen: number[] = [];
    const waits: number[] = [];
    const backup = await createBackup(a.home, REPO, null, {
      fetchImpl: server.fetch,
      sleep: async (ms) => {
        waits.push(ms);
      },
      onFolding: (folded) => seen.push(folded),
    });
    expect(seen.length).toBeGreaterThan(2);
    expect(seen).toEqual([...seen].sort((x, y) => x - y));
    expect(new Set(seen).size).toBe(seen.length);
    // The service's own Retry-After, once per refusal.
    expect(waits).toEqual(seen.map(() => 1000));
    expect(backup.opCount).toBe(server.ops.filter((op) => op.epoch === 1).length);
  });

  it("restores once the fold is ready, and a device that joins after holds the restored content", async () => {
    const { server, a } = await unfolded();
    await allowBackup(a, server);
    // Nothing folded for the backup, and nothing for the head it will be restored over.
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch, sleep: async () => undefined });
    const before = everything(a.db);
    a.store.createIssue({ title: "Undone by the restore" });
    await a.sync();
    server.foldedTo.clear();

    let refusals = 0;
    const report = await restoreFromBackup(a.store.db, a.home, REPO, backup.backupId, {
      fetchImpl: server.fetch,
      sleep: async () => undefined,
      onFolding: () => {
        refusals += 1;
      },
    });
    expect(refusals).toBeGreaterThan(0);
    expect(report.toEpoch).toBe(2);

    const after = fleet!.machine("after");
    await after.sync();
    expect(everything(after.db)).toEqual(before);
  });

  it("joins and restores across snapshot pages and restore turns the service cut by size", async () => {
    // Pages of 2 KB: most hold one or two entities, far short of the limit asked for.
    const server = new FakeSyncServer({ repositoryId: REPO, pageBytes: 2048 });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    for (let n = 0; n < 12; n += 1) {
      a.store.createIssue({ title: `Long ${n}`, description: `${n} ${"x".repeat(1500)}` });
    }
    await a.sync();

    const fresh = fleet.machine("fresh");
    const report = await fresh.sync();
    expect(report.bootstrap?.pages).toBeGreaterThan(6);
    expect(everything(fresh.db)).toEqual(everything(a.db));

    await allowBackup(a, server);
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    const restored = await restoreFromBackup(a.store.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    expect(restored.turns).toBeGreaterThan(6);
    const after = fleet.machine("after");
    await after.sync();
    expect(everything(after.db)).toEqual(everything(fresh.db));
  });

  it("asks again for a snapshot page pinned at a cutoff the service has not folded to", async () => {
    // A cursor from before the Worker was deployed: pinned at the head, which no checkpoint
    // has reached. The page is folded towards a request at a time, and served once it is there.
    const { server, a } = await unfolded(12);
    const cursor = Buffer.from(JSON.stringify({ v: 1, r: REPO, e: 1, c: server.lastSeq, k: "" }), "utf8").toString("base64url");
    let refusals = 0;
    const page = (await fetchSnapshotPage(
      parseEndpoint(ENDPOINT),
      { repositoryId: REPO, token: `token-${a.deviceId}`, deviceId: a.deviceId, cursor, limit: 500 },
      { fetchImpl: server.fetch, sleep: async () => undefined, onFolding: () => (refusals += 1) },
    )) as { cutoffSeq: number; entities: unknown[] };
    expect(refusals).toBeGreaterThan(2);
    expect(page.cutoffSeq).toBe(server.lastSeq);
  });

  /**
   * A device joining must not wait on the fold of a log it can read itself. Past a page's
   * patience the refusal comes back, and the bootstrap reads the ordered tail and folds it here
   * — the same path a Worker too old to fold a log this large sends it down.
   */
  it("gives a snapshot page up after its patience, and joins from the ordered tail instead", async () => {
    const { server, a } = await unfolded();
    const cursor = Buffer.from(JSON.stringify({ v: 1, r: REPO, e: 1, c: server.lastSeq, k: "" }), "utf8").toString("base64url");
    let refusals = 0;
    const error = await fetchSnapshotPage(
      parseEndpoint(ENDPOINT),
      { repositoryId: REPO, token: `token-${a.deviceId}`, deviceId: a.deviceId, cursor, limit: 500 },
      { fetchImpl: server.fetch, sleep: async () => undefined, onFolding: () => (refusals += 1) },
    ).catch((caught: unknown) => caught);
    expect(cloudCodeOf(error)).toBe("unavailable");
    expect(typeof (error as { detail: Record<string, unknown> }).detail.foldedSeq).toBe("number");
    expect(refusals).toBe(SNAPSHOT_FOLD_PATIENCE.answers);

    // And the device joins anyway, from the tail, with the same content.
    const fresh = fleet!.machine("fresh");
    const report = await fresh.sync({ sleep: async () => undefined });
    expect(report.bootstrap?.fromTail).toBe(true);
    expect(report.bootstrap?.cutoffSeq).toBe(server.lastSeq);
    expect(everything(fresh.db)).toEqual(everything(a.db));
  });

  it("gives up on an answer that did not move the fold on, rather than asking for ever", async () => {
    const { a } = await unfolded();
    const stuck = new FakeSyncServer({ repositoryId: REPO, foldBudget: 0, foldStep: BUDGET });
    // The same log on a service whose fold never moves.
    stuck.ops.push(...fleet!.server.ops);
    stuck.lastSeq = fleet!.server.lastSeq;
    stuck.backupEnabled = true;
    stuck.enroll(a.deviceId, `token-${a.deviceId}`);
    setConsent(a.home, REPO, { backup: true });
    let waits = 0;
    const error = await createBackup(a.home, REPO, null, {
      fetchImpl: stuck.fetch,
      sleep: async () => {
        waits += 1;
        if (waits > 5) throw new Error("asked for ever");
      },
    }).catch((caught: unknown) => caught);
    expect(cloudCodeOf(error)).toBe("unavailable");
    expect((error as { detail: Record<string, unknown> }).detail.foldedSeq).toBe(0);
    expect(waits).toBe(1);
  });
});
