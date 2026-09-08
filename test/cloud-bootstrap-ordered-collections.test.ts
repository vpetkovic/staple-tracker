/**
 * STA-257 — the two collections that replicate whole must survive a bootstrap.
 *
 * `queue_entries` and `milestone_members` do not replicate row by row. Each travels
 * as one `replace` carrying the entire ordered list, because two devices reordering
 * offline produce colliding ranks that no per-row merge can repair without inventing
 * an order neither human asked for.
 *
 * That makes them the only entities whose state a snapshot fold cannot express as a
 * shallow merge, and they were the only two the fold got wrong. The server wrapped a
 * folded `replace` as `{ replaced: payload }` and no client ever unwrapped it, so a
 * hydrating device was handed the plan and the membership in a shape it could not
 * apply and ended up with **neither** — while the bootstrap reported success. The
 * queue handler saw no `payload.order` and returned false without a word; the
 * milestone handler saw no `verb === "replace"`, fell through to the dates branch,
 * and wrote two NULLs over the milestone instead.
 *
 * ## Why this file is an end-to-end bootstrap and not a unit test of the unwrapping
 *
 * The unit tests on both sides of that wire passed throughout. They had to: each
 * half was self-consistent, and the defect lived in the space between them — a
 * server that emitted a shape and a client that had no handler for it. Nothing
 * short of running a real bootstrap across the seam could have caught it, so that
 * is what this file does: a genuinely fresh device, an empty database, hydrating
 * from a repository that already has a plan and a membership.
 *
 * The third test is the regression guard proper. It puts the same collection into a
 * device by BOTH routes — folded into a snapshot, and replayed from the ordered tail
 * — and demands the two devices be indistinguishable afterwards. Two paths producing
 * two shapes is what caused this bug, and that test is what would notice it again.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { syncRepository, type SyncReport } from "../src/core/cloud/sync.js";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { MEMBER_RANK_STEP, MILESTONE_KIND } from "../src/core/milestones.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-2222-4333-8444-555566667777";
const ENDPOINT = "https://sync.test.example";

let homes: string[] = [];
let stores: WorkspaceStore[] = [];

afterEach(() => {
  for (const store of stores) store.db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  stores = [];
  homes = [];
});

interface Device {
  store: WorkspaceStore;
  sync: () => Promise<SyncReport>;
}

/** A connected device on an empty database. Nothing is hydrated until it syncs. */
function device(server: FakeSyncServer, deviceId: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-boot-${deviceId}-`));
  homes.push(home);

  const db = openDb(":memory:");
  migrateWorkspace(db);
  writeStoredRepositoryId(db, REPO_ID);
  bindJournal(db, deviceId);
  const store = new WorkspaceStore(db, "test", "TST");
  stores.push(store);

  credentialStoreFor(home, "file").write(REPO_ID, `token-${deviceId}`);
  writeConnection(home, {
    schemaVersion: 1,
    repositoryId: REPO_ID,
    endpoint: ENDPOINT,
    deviceId,
    label: deviceId,
    credentialMechanism: "file",
    connectedAt: "2026-09-08T00:00:00.000Z",
    auto: false,
    backup: false,
    protocol: 1,
  });
  server.enroll(deviceId, `token-${deviceId}`);

  return {
    store,
    sync: () =>
      syncRepository(store.db, REPO_ID, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
      }),
  };
}

/** The plan, as rows, in rank order. Read from the table so no resolver can flatter it. */
function plan(store: WorkspaceStore): { issue_id: string; rank: number }[] {
  return store.db
    .prepare("SELECT issue_id, rank FROM queue_entries ORDER BY rank")
    .all() as { issue_id: string; rank: number }[];
}

/** One milestone's membership, as rows, in rank order. */
function members(store: WorkspaceStore, milestoneId: string): { issue_id: string; rank: number }[] {
  return store.db
    .prepare("SELECT issue_id, rank FROM milestone_members WHERE milestone_id = ? ORDER BY rank")
    .all(milestoneId) as { issue_id: string; rank: number }[];
}

/**
 * An origin device carrying a plan and a milestone membership, already pushed.
 *
 * Both collections are deliberately built so their ranks are SPARSE: two appends put
 * a row at a multiple of the step, then a third is inserted between them and lands
 * halfway, at 1536. A device that transported ranks rather than recomputing them
 * would arrive at that 1536, and `journalledRanks` is how the tests below can see it.
 *
 * Those ranks are captured BEFORE the origin's own first sync, because that sync
 * bootstraps too — a device with local work but no cursor pushes, then hydrates from
 * the snapshot it just filled — and re-applying its own plan renumbers its local
 * ranks densely. Harmless (the order is unchanged, and rank is local and derived),
 * but it would erase the very sparseness these tests are built on.
 */
async function origin(server: FakeSyncServer): Promise<{
  device: Device;
  ids: Record<string, string>;
  milestoneId: string;
  /** Ranks as the origin held them when the operations were journalled. */
  journalledRanks: { plan: number[]; members: number[] };
}> {
  const a = device(server, "origin");
  const store = a.store;
  store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");

  const ids: Record<string, string> = {};
  for (const name of ["one", "two", "three", "four"]) {
    ids[name] = store.createIssue({ title: name }).id;
  }
  const milestone = store.createIssue({ title: "the milestone", kind: MILESTONE_KIND });

  // Membership first, then the plan: the milestone/queue seam renumbers the plan when
  // an issue joins a milestone, and a sparse rank minted before that would be tidied
  // away again before it could prove anything.
  const milestones = store.milestones();
  milestones.addMember(milestone.id, ids.three!, {}, "vp");
  milestones.addMember(milestone.id, ids.one!, {}, "vp");
  // Between the first two: rank 1536, which is not a multiple of the step.
  milestones.addMember(milestone.id, ids.two!, { after: ids.three! }, "vp");

  const queue = store.queue();
  queue.enqueue(ids.one!, {}, "vp");
  queue.enqueue(ids.two!, {}, "vp");
  queue.enqueue(ids.three!, {}, "vp");
  // Likewise 1536, and last, so nothing renumbers it away.
  queue.enqueue(ids.four!, { after: ids.one! }, "vp");

  const journalledRanks = {
    plan: plan(store).map((row) => row.rank),
    members: members(store, milestone.id).map((row) => row.rank),
  };

  await a.sync();
  return { device: a, ids, milestoneId: milestone.id, journalledRanks };
}

describe("a fresh device hydrates the collections that replicate whole", () => {
  it("receives the queue plan from a snapshot and applies it", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const { ids } = await origin(server);

    const fresh = device(server, "fresh");
    expect(plan(fresh.store)).toEqual([]);

    const report = await fresh.sync();
    expect(report.bootstrap).not.toBeNull();

    // The plan arrived, in the order the human put it in.
    expect(plan(fresh.store).map((row) => row.issue_id)).toEqual([
      ids.one,
      ids.four,
      ids.two,
      ids.three,
    ]);
  });

  it("receives milestone membership from a snapshot and applies it", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const { ids, milestoneId } = await origin(server);

    const fresh = device(server, "fresh");
    expect(members(fresh.store, milestoneId)).toEqual([]);

    await fresh.sync();

    expect(members(fresh.store, milestoneId).map((row) => row.issue_id)).toEqual([
      ids.three,
      ids.two,
      ids.one,
    ]);
  });

  /**
   * The invariant underneath both: *"rank is never transported, it is recomputed
   * densely from list order inside the transaction that applies the list"*, which is
   * what makes the `UNIQUE` rank constraints structurally unreachable.
   *
   * The origin's plan holds a 1536. If a rank had travelled, it would be here.
   */
  it("recomputes rank densely instead of transporting it", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const { ids, milestoneId, journalledRanks } = await origin(server);

    // What the origin held when it wrote those operations: a 1536 in both collections.
    expect(journalledRanks.plan).toEqual([1024, 1536, 2048, 3072]);
    expect(journalledRanks.members).toEqual([1024, 1536, 2048]);

    const fresh = device(server, "fresh");
    await fresh.sync();

    // What arrived: the same ORDER, at ranks this device computed for itself. The 1536
    // is nowhere, because no rank was ever put on the wire to carry it.
    const step = MEMBER_RANK_STEP;
    expect(plan(fresh.store).map((row) => row.rank)).toEqual([step, 2 * step, 3 * step, 4 * step]);
    expect(members(fresh.store, milestoneId).map((row) => row.rank)).toEqual([
      step,
      2 * step,
      3 * step,
    ]);
    expect(plan(fresh.store).map((row) => row.issue_id)).toEqual([
      ids.one,
      ids.four,
      ids.two,
      ids.three,
    ]);
  });

  /**
   * The bug was never that one path was broken in isolation — it was that the two
   * paths out of a fold disagreed about the shape a collection travels in. So this
   * asserts the thing that has to stay true: it does not matter which one carried it.
   *
   * `tail` bootstraps BEFORE the reorder and pulls it as an ordinary `replace` from
   * the ordered tail. `snap` bootstraps AFTER it and receives the same reorder folded
   * into its snapshot. Neither device can tell you which it was.
   */
  it("arrives identically whether it came from the snapshot or from the ordered tail", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const { device: a, ids, milestoneId } = await origin(server);

    const tail = device(server, "tail");
    await tail.sync();

    // A reorder on the origin, pushed. Now the two devices below take different routes.
    a.store.queue().move(ids.three!, { at: 1 }, "vp");
    a.store.milestones().moveMember(ids.one!, { at: 1 }, "vp");
    await a.sync();

    await tail.sync(); // through the ordered tail
    const snap = device(server, "snap");
    await snap.sync(); // folded into a snapshot

    expect(plan(tail.store)).toEqual(plan(snap.store));
    expect(members(tail.store, milestoneId)).toEqual(members(snap.store, milestoneId));

    // And both agree with the device the reorder actually happened on.
    expect(plan(tail.store).map((row) => row.issue_id)).toEqual(
      plan(a.store).map((row) => row.issue_id),
    );
    expect(members(tail.store, milestoneId).map((row) => row.issue_id)).toEqual(
      members(a.store, milestoneId).map((row) => row.issue_id),
    );
  });
});
