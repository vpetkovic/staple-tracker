/**
 * A repository whose log is too large for the service to fold still reaches every device.
 *
 * The Worker folds at most `MAX_SNAPSHOT_FOLD_OPS` operations for a snapshot (20,000), and
 * refuses past that. Every snapshot then failed: a new device could not join, a joining
 * clone with work of its own could not seed, and a device upgraded to this build failed
 * every sync after its push and pull had landed, because its one-time re-read is a
 * snapshot. The operations are all there, served by the pull route in pages with no fold,
 * so the device folds the ordered tail itself (`src/core/cloud/tail-fold.ts`).
 *
 * The fake folds at most 25 here, as the Worker folds at most 20,000 — the same refusal,
 * the same detail. The live proof past 20,000 on real workerd is in the PR.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { beginBootstrap } from "../src/core/cloud/sync-state.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000175";
const CAP = 25;

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
    settings: db.prepare("SELECT key, value FROM meta WHERE key LIKE 'setting:%' ORDER BY key").all(),
  };
}

/** A repository past the fold cap, with a removed-and-re-added status and a plan with notes. */
async function largeRepository(): Promise<{ server: FakeSyncServer; a: Machine }> {
  const server = new FakeSyncServer({ repositoryId: REPO, maxSnapshotFoldOps: CAP });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  await a.sync();
  const first = a.store.createIssue({ title: "Planned" });
  a.store.queue().enqueue(first.id, { note: "why it is first" }, "alice");
  a.store.addStatus({ id: "r1", category: "review", label: "R1" });
  await a.sync();
  a.store.removeStatus("r1");
  a.store.addStatus({ id: "r1", category: "review", label: "R1 again" });
  for (let n = 0; n < CAP; n += 1) {
    const issue = a.store.createIssue({ title: `Issue ${n}` });
    if (n % 5 === 0) a.store.addComment(issue.id, `comment ${n}`, "agent-a", "agent");
  }
  await a.sync();
  expect(server.ops.length).toBeGreaterThan(CAP);
  return { server, a };
}

describe("a log too large for the service to fold", () => {
  it("a new device joins it from the ordered tail, and holds exactly what the others hold", async () => {
    const { a } = await largeRepository();
    const fresh = fleet!.machine("fresh");
    const report = await fresh.sync();
    expect(report.bootstrap).toEqual(expect.objectContaining({ fromTail: true }));
    expect(everything(fresh.db)).toEqual(everything(a.db));
    // And it carries on from there on the ordered tail.
    a.store.createIssue({ title: "After the join" });
    await a.sync();
    await fresh.sync();
    expect(everything(fresh.db)).toEqual(everything(a.db));
  });

  it("a device that has to bootstrap again — an epoch change — reads the tail too", async () => {
    const { a } = await largeRepository();
    const v = fleet!.machine("v");
    await v.sync();
    beginBootstrap(v.db, 1);
    const report = await v.sync();
    expect(report.bootstrap).not.toBeNull();
    expect(everything(v.db)).toEqual(everything(a.db));
  });

  it("a clone with work of its own seeds into it", async () => {
    const { a } = await largeRepository();
    const c = fleet!.connect("c", fleet!.prepare("c"));
    c.store.createIssue({ title: "C's own, from before joining" });
    const report = await c.sync();
    expect(report.seed?.mode).toBe("join");
    await a.sync();
    expect(everything(c.db)).toEqual(everything(a.db));
  });

  it("an upgraded device re-reads it from the tail, and every sync after succeeds", async () => {
    const { a } = await largeRepository();
    const v = fleet!.machine("v");
    await v.sync();
    // As an applier from before this build left it: notes dropped, and no record of a re-read.
    v.db.prepare("UPDATE queue_entries SET added_by = 'sync', note = NULL").run();
    v.db.prepare("DELETE FROM meta WHERE key = 'sync_applier_version'").run();

    const report = await v.sync();
    expect(report.caughtUp).not.toBeNull();
    expect(everything(v.db)).toEqual(everything(a.db));
    expect((await v.sync()).caughtUp).toBeNull();
  });
});
