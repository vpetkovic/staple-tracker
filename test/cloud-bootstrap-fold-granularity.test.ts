/**
 * STA-259 — a fold must supersede the keys an operation carried, not the entity.
 *
 * A milestone holds two facts that replicate through two different payload shapes:
 * its dates travel as `update { targetDate, startDate }`, and its membership travels
 * as `replace { members }` because an ordered collection replicates whole. Both are
 * journalled against the SAME entity key, `milestone/<id>`, and the fold is keyed on
 * the entity.
 *
 * So a `replace` that superseded the whole entity threw away the dates, which it had
 * said nothing about. A milestone dated on Monday and re-membered on Tuesday folded to
 * membership alone, and every device that hydrated from that fold — from a snapshot,
 * or from a repository restored from a backup — silently got null dates. Both paths
 * share `worker/src/fold.ts`, so this is the same loss twice rather than a divergence
 * between them.
 *
 * ## Why both orders are tested
 *
 * They failed differently, and the difference is the diagnosis.
 *
 *   dates -> membership: the `replace` evicted the dates. Data gone.
 *   membership -> dates: the later merge landed ON TOP of the fold's private
 *     `{ replaced: … }` wrapper, so the wrapper itself reached the client — the exact
 *     thing `worker/test/snapshot.test.ts` pins as fold-internal — and the membership
 *     was invisible underneath it.
 *
 * One shape, two symptoms: the wrapper. Holding a payload as "the whole state" requires
 * evicting every other key, so the wrapper IS the entity-granularity claim made
 * structural. Neither symptom survives its removal.
 *
 * ## Why this is an end-to-end bootstrap
 *
 * For the same reason `cloud-bootstrap-ordered-collections.test.ts` is one: the unit
 * tests on both sides of this wire passed throughout, because each half was
 * self-consistent about granularity and the loss lived in the space between them. Only
 * a genuinely fresh device, hydrating an empty database from a repository that already
 * holds both facts, can see it.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { type SyncReport, syncRepository } from "../src/core/cloud/sync.js";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-3333-4444-8555-666677778888";
const ENDPOINT = "https://sync.test.example";

let homes: string[] = [];
let stores: WorkspaceStore[] = [];
let server: FakeSyncServer;

interface Device {
  store: WorkspaceStore;
  home: string;
  sync: () => Promise<SyncReport>;
}

/** A connected device on an empty database. Nothing is hydrated until it syncs. */
function device(deviceId: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-fold-${deviceId}-`));
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
    home,
    sync: () =>
      syncRepository(store.db, REPO_ID, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
      }),
  };
}

/** The dates, read from the table so no resolver can flatter them. */
function dates(store: WorkspaceStore, milestoneId: string): unknown {
  return (
    store.db
      .prepare("SELECT target_date, start_date FROM milestone_meta WHERE issue_id = ?")
      .get(milestoneId) ?? null
  );
}

/** One milestone's membership, as rows, in rank order. */
function members(store: WorkspaceStore, milestoneId: string): string[] {
  return (
    store.db
      .prepare("SELECT issue_id FROM milestone_members WHERE milestone_id = ? ORDER BY rank")
      .all(milestoneId) as { issue_id: string }[]
  ).map((row) => row.issue_id);
}

/**
 * An origin device holding a milestone that has BOTH dates and members, pushed.
 *
 * `order` decides which fact was declared first. Both orders must survive, and under
 * the entity-granular fold neither did.
 */
async function origin(order: "dates-then-members" | "members-then-dates"): Promise<{
  device: Device;
  milestoneId: string;
  memberIds: string[];
}> {
  const a = device("origin");
  a.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");

  const one = a.store.createIssue({ title: "one" }).id;
  const two = a.store.createIssue({ title: "two" }).id;
  const milestone = a.store.createIssue({ title: "the milestone", kind: MILESTONE_KIND });

  const setDates = (): void => {
    a.store.milestones().update(milestone.id, { startDate: "2026-10-01", targetDate: "2026-12-24" }, "vp");
  };
  const setMembers = (): void => {
    a.store.milestones().addMember(milestone.id, one, {}, "vp");
    a.store.milestones().addMember(milestone.id, two, {}, "vp");
  };

  if (order === "dates-then-members") {
    setDates();
    setMembers();
  } else {
    setMembers();
    setDates();
  }

  await a.sync();
  return { device: a, milestoneId: milestone.id, memberIds: [one, two] };
}

beforeEach(() => {
  server = new FakeSyncServer({ repositoryId: REPO_ID });
  homes = [];
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.db.close();
  for (const home of homes) rmSync(home, { recursive: true, force: true });
});

describe("a fold supersedes the keys an operation carried, not the whole entity", () => {
  it("hydrates a fresh device with the dates AND the membership, dates declared first", async () => {
    const { milestoneId, memberIds } = await origin("dates-then-members");

    const fresh = device("fresh");
    expect(dates(fresh.store, milestoneId)).toBeNull();

    const report = await fresh.sync();
    expect(report.bootstrap).not.toBeNull();

    // The membership arrived, whole and in order — a `replace` still supersedes the
    // collection it names.
    expect(members(fresh.store, milestoneId)).toEqual(memberIds);
    // And the dates, which that `replace` never said one word about, are still here.
    expect(dates(fresh.store, milestoneId)).toEqual({
      target_date: "2026-12-24",
      start_date: "2026-10-01",
    });
  });

  it("hydrates a fresh device with the dates AND the membership, membership declared first", async () => {
    const { milestoneId, memberIds } = await origin("members-then-dates");

    const fresh = device("fresh");
    await fresh.sync();

    expect(members(fresh.store, milestoneId)).toEqual(memberIds);
    expect(dates(fresh.store, milestoneId)).toEqual({
      target_date: "2026-12-24",
      start_date: "2026-10-01",
    });
  });

  /**
   * The receiving half of the same rule, pinned directly rather than through a
   * bootstrap, because these two are the ways a device DESTROYS a date it was never
   * told anything about — and a silent overwrite is worse than a silent drop, because
   * it takes out a value that was never in question.
   *
   * Driven through `applyToDatabase`, which is the single point both an operation from
   * the ordered tail and an entity folded into a snapshot arrive at.
   */
  it("leaves a date alone when the operation did not mention it", async () => {
    const { device: a, milestoneId, memberIds } = await origin("dates-then-members");
    const db = a.store.db;
    const at = "2026-09-08T12:00:00.000Z";

    // An operation about membership says nothing whatsoever about dates.
    applyToDatabase(db, {
      entity: "milestone",
      entityId: milestoneId,
      verb: "replace",
      payload: { members: [memberIds[1]!, memberIds[0]!] },
      actor: null,
      deviceId: null,
      at,
      opId: null,
    });
    expect(dates(a.store, milestoneId)).toEqual({
      target_date: "2026-12-24",
      start_date: "2026-10-01",
    });

    // And one that names ONE date leaves the other where it was.
    applyToDatabase(db, {
      entity: "milestone",
      entityId: milestoneId,
      verb: "update",
      payload: { targetDate: "2027-01-15" },
      actor: null,
      deviceId: null,
      at,
      opId: null,
    });
    expect(dates(a.store, milestoneId)).toEqual({
      target_date: "2027-01-15",
      start_date: "2026-10-01",
    });

    // Present-and-null is an opinion — "cleared" — and is honoured. That is the
    // distinction the whole rule turns on: absent is silence, null is a decision.
    applyToDatabase(db, {
      entity: "milestone",
      entityId: milestoneId,
      verb: "update",
      payload: { startDate: null },
      actor: null,
      deviceId: null,
      at,
      opId: null,
    });
    expect(dates(a.store, milestoneId)).toEqual({
      target_date: "2027-01-15",
      start_date: null,
    });
  });

  /**
   * The same fold, reached by the other route. `worker/src/backups.ts` folds with
   * `foldLog` and materialises each folded entity as a real operation in the new
   * epoch, so a granularity mistake in the fold is a permanent one here: the restored
   * epoch's LOG says the milestone has no dates, and no later pull can disagree.
   */
  it("keeps both through a backup and a restore, and hands them to a device that hydrates after", async () => {
    const { device: a, milestoneId, memberIds } = await origin("dates-then-members");
    await setBackupConsent(a.home, REPO_ID, true, { fetchImpl: server.fetch });

    const backup = await createBackup(a.home, REPO_ID, null, { fetchImpl: server.fetch });
    await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, {
      fetchImpl: server.fetch,
    });

    // A device that has never heard of this repository, hydrating the restored epoch.
    const after = device("after-restore");
    await after.sync();

    expect(members(after.store, milestoneId)).toEqual(memberIds);
    expect(dates(after.store, milestoneId)).toEqual({
      target_date: "2026-12-24",
      start_date: "2026-10-01",
    });
  });
});
