/**
 * Two devices, offline edits, and the same answer either way round.
 *
 * The acceptance criterion is *"Two devices making non-conflicting offline edits
 * converge after syncing in either order"*, and the "either order" half is the
 * part worth testing: a system that converges when A syncs first and diverges
 * when B does has not converged, it has been lucky.
 *
 * So each scenario runs twice against two independent services, with the sync
 * order reversed, and the two runs are compared to each other as well as the two
 * devices being compared within a run. Three equalities, not one.
 *
 * ## What "non-conflicting" means here, precisely
 *
 * *"Detection is field-scoped … Disjoint field sets are not a conflict — two
 * devices setting `priority` and `estimated_seconds` on one issue both apply, and
 * the version bumps twice."* The scenarios below are built on that definition:
 * different fields of one issue, different issues, and different entities.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { syncRepository, type SyncReport } from "../src/core/cloud/sync.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-1111-4222-8333-444455556666";
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

function device(server: FakeSyncServer, deviceId: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-conv-${deviceId}-`));
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
    connectedAt: "2026-09-05T00:00:00.000Z",
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

/**
 * Everything two converged devices must agree about, in a comparable shape.
 *
 * Keyed and ordered by `issues.id` — the UUID — and never by `identifier`.
 * *"`issues.id` is a `randomUUID()` and is the sync identity of an issue …
 * `issues.identifier` is a display allocation."* Comparing on the display
 * allocation would make this test agree with a system that had replicated
 * nothing and minted the same numbers by coincidence.
 */
function shape(store: WorkspaceStore): unknown {
  const issues = store.db
    .prepare(
      `SELECT id, title, description, status, priority, assignee, labels, acceptance_criteria,
              parent_id, estimated_seconds, project_id, created_by
         FROM issues ORDER BY id`,
    )
    .all();
  const comments = store.db
    .prepare("SELECT id, issue_id, author, body FROM comments ORDER BY id")
    .all();
  const relations = store.db
    .prepare("SELECT blocker_id, blocked_id, type FROM relations ORDER BY blocker_id, blocked_id")
    .all();
  const documents = store.db
    .prepare("SELECT issue_id, key, current_revision FROM documents ORDER BY issue_id, key")
    .all();
  const revisions = store.db
    .prepare(
      "SELECT issue_id, key, revision, body FROM document_revisions ORDER BY issue_id, key, revision",
    )
    .all();
  const queue = store.db
    .prepare("SELECT issue_id FROM queue_entries ORDER BY rank")
    .all();
  const statuses = store.db
    .prepare("SELECT id, label, category FROM workspace_statuses ORDER BY sort_order")
    .all();
  return { issues, comments, relations, documents, revisions, queue, statuses };
}

/**
 * Move a hydrated device's provisional identifier counter clear of the other's.
 *
 * `meta.next_issue_number` *"never synchronizes: it is a local provisional
 * allocator"*, and `docs/sync.md` resolves the resulting collisions by making the
 * server the allocator — *"the server assigns the canonical number from the
 * repository's own counter and returns it in the push response"*. The deployed
 * Worker implements no such allocator and its push response carries only
 * `{opId, status, seq}`, so that renumbering does not happen yet.
 *
 * This stands in for it, so the convergence scenarios below test convergence
 * rather than re-testing the identifier gap. The gap itself has its own test at
 * the bottom of this file, where it is asserted rather than papered over.
 */
function reserveNumbers(store: WorkspaceStore, from: number): void {
  store.db
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('next_issue_number', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(String(from));
}

/**
 * The same state, expressed without any locally-minted identity.
 *
 * Two separate runs mint different UUIDs for the same logical issue, so
 * {@link shape} can only compare devices WITHIN a run. Comparing across runs
 * needs a projection keyed on something both runs agree about, and the only
 * honest candidate is the content — titles, bodies, and the relationships
 * between them.
 *
 * That is a weaker comparison than {@link shape} and it is used only for the
 * cross-order equality, where it is exactly the right strength: the question
 * there is "did the order of syncing change the outcome", not "are these the
 * same rows".
 */
function portable(store: WorkspaceStore): unknown {
  const titleOf = (id: string | null): string | null => {
    if (id === null) return null;
    const row = store.db.prepare("SELECT title FROM issues WHERE id = ?").get(id) as
      | { title: string }
      | undefined;
    return row?.title ?? null;
  };

  const issues = (
    store.db
      .prepare(
        `SELECT title, description, status, priority, assignee, labels, acceptance_criteria,
                parent_id, estimated_seconds, created_by
           FROM issues ORDER BY title`,
      )
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row, parent_id: titleOf(row.parent_id as string | null) }));

  const comments = (
    store.db
      .prepare("SELECT issue_id, author, body FROM comments ORDER BY body")
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row, issue_id: titleOf(row.issue_id as string) }));

  const relations = (
    store.db
      .prepare("SELECT blocker_id, blocked_id, type FROM relations")
      .all() as Array<Record<string, unknown>>
  )
    .map((row) => ({
      blocker: titleOf(row.blocker_id as string),
      blocked: titleOf(row.blocked_id as string),
      type: row.type,
    }))
    .sort((x, y) => `${x.blocker}${x.blocked}`.localeCompare(`${y.blocker}${y.blocked}`));

  const revisions = (
    store.db
      .prepare("SELECT issue_id, key, revision, body FROM document_revisions ORDER BY key, revision")
      .all() as Array<Record<string, unknown>>
  ).map((row) => ({ ...row, issue_id: titleOf(row.issue_id as string) }));

  const queue = (
    store.db.prepare("SELECT issue_id FROM queue_entries ORDER BY rank").all() as Array<{
      issue_id: string;
    }>
  ).map((row) => titleOf(row.issue_id));

  const statuses = store.db
    .prepare("SELECT id, label, category FROM workspace_statuses ORDER BY sort_order")
    .all();
  const kinds = store.db
    .prepare("SELECT id, label FROM workspace_kinds ORDER BY sort_order")
    .all();

  return { issues, comments, relations, revisions, queue, statuses, kinds };
}

interface Run {
  a: WorkspaceStore;
  b: WorkspaceStore;
}

/**
 * Set up two devices sharing one base, let each edit offline, then sync in the
 * given order until quiet.
 *
 * The trailing extra syncs are not padding: a device only learns about the
 * other's work on a sync that happens AFTER that work was pushed, so reaching a
 * common state always takes one more round than the naive count.
 */
async function scenario(
  order: "a-first" | "b-first",
  base: (store: WorkspaceStore) => void,
  offlineA: (store: WorkspaceStore) => void,
  offlineB: (store: WorkspaceStore) => void,
): Promise<Run> {
  const server = new FakeSyncServer({ repositoryId: REPO_ID });
  const a = device(server, "device-a");

  base(a.store);
  await a.sync();

  const b = device(server, "device-b");
  await b.sync();
  reserveNumbers(b.store, 5000);

  // Both offline, neither aware of the other.
  offlineA(a.store);
  offlineB(b.store);

  const first = order === "a-first" ? a : b;
  const second = order === "a-first" ? b : a;

  await first.sync();
  await second.sync();
  await first.sync();
  await second.sync();

  return { a: a.store, b: b.store };
}

describe("two devices with non-conflicting offline edits converge", () => {
  const base = (store: WorkspaceStore): void => {
    store.createIssue({ title: "Shared", description: "the original", createdBy: "agent-base" });
  };
  const offlineA = (store: WorkspaceStore): void => {
    const shared = store.listIssues({ includeResolved: true })[0]!;
    store.updateIssue(shared.identifier, { priority: "high" });
    store.createIssue({ title: "Only on A", createdBy: "agent-a" });
  };
  const offlineB = (store: WorkspaceStore): void => {
    const shared = store.listIssues({ includeResolved: true })[0]!;
    // A DIFFERENT field of the same issue. Disjoint field sets are not a conflict.
    store.updateIssue(shared.identifier, { estimatedSeconds: 3600 });
    store.addComment(shared.identifier, "a note from B", "agent-b", "agent");
    store.createIssue({ title: "Only on B", createdBy: "agent-b" });
  };

  it("reaches the same state whichever device syncs first", async () => {
    const forwards = await scenario("a-first", base, offlineA, offlineB);
    const backwards = await scenario("b-first", base, offlineA, offlineB);

    // Within each run, the two devices agree ROW FOR ROW, UUIDs included —
    // which is the strong claim, and the one that says the entity identity
    // itself replicated rather than two similar-looking databases arising.
    expect(shape(forwards.a)).toEqual(shape(forwards.b));
    expect(shape(backwards.a)).toEqual(shape(backwards.b));
    // And the two runs agree on content, which is the "either order" half. It
    // cannot be a row-for-row comparison: each run mints its own UUIDs.
    expect(portable(forwards.a)).toEqual(portable(backwards.a));
  });

  it("keeps both edits to the shared issue, because they touched different fields", async () => {
    const run = await scenario("a-first", base, offlineA, offlineB);
    const shared = run.b.db
      .prepare("SELECT priority, estimated_seconds, description FROM issues WHERE title = 'Shared'")
      .get() as { priority: string; estimated_seconds: number; description: string };

    expect(shared.priority).toBe("high"); // A's edit
    expect(shared.estimated_seconds).toBe(3600); // B's edit
    expect(shared.description).toBe("the original"); // neither touched it
  });

  it("records no conflict at all, because there was none", async () => {
    const run = await scenario("b-first", base, offlineA, offlineB);
    for (const store of [run.a, run.b]) {
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM sync_conflicts").get(),
        "a disjoint edit must not be recorded as a conflict",
      ).toEqual({ n: 0 });
    }
  });

  it("leaves neither device with anything queued", async () => {
    const run = await scenario("a-first", base, offlineA, offlineB);
    for (const store of [run.a, run.b]) {
      expect(
        store.db
          .prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE acknowledged_seq IS NULL")
          .get(),
      ).toEqual({ n: 0 });
    }
  });
});

describe("convergence across the entities that are not issues", () => {
  it("converges comments, blockers, documents and the plan", async () => {
    const run = await scenario(
      "a-first",
      (store) => {
        store.createIssue({ title: "One" });
        store.createIssue({ title: "Two" });
      },
      (store) => {
        const [one, two] = store.listIssues({ includeResolved: true });
        store.setBlockedBy(one!.identifier, [two!.identifier], "agent-a");
        store.putDocument(one!.identifier, "plan", "the plan body", { author: "agent-a" });
      },
      (store) => {
        const [one, two] = store.listIssues({ includeResolved: true });
        store.addComment(two!.identifier, "B's comment", "agent-b", "agent");
        store.queue().enqueue(two!.identifier, {}, "agent-b");
      },
    );

    expect(shape(run.a)).toEqual(shape(run.b));

    const relations = run.a.db.prepare("SELECT COUNT(*) AS n FROM relations").get();
    expect(relations, "A's blocker edge reached B and came back unchanged").toEqual({ n: 1 });
    expect(run.b.db.prepare("SELECT body FROM document_revisions").get()).toEqual({
      body: "the plan body",
    });
    expect(run.a.db.prepare("SELECT COUNT(*) AS n FROM queue_entries").get()).toEqual({ n: 1 });
  });

  it("converges a vocabulary change, which travels as an update on one entity", async () => {
    const run = await scenario(
      "b-first",
      (store) => {
        store.createIssue({ title: "Anything" });
      },
      (store) => {
        store.addStatus({ id: "parked", label: "Parked", category: "blocked" }, "agent-a");
      },
      (store) => {
        store.addKind({ id: "research", label: "Research" }, "agent-b");
      },
    );

    expect(shape(run.a)).toEqual(shape(run.b));
    for (const store of [run.a, run.b]) {
      expect(
        store.db.prepare("SELECT label FROM workspace_statuses WHERE id = 'parked'").get(),
      ).toEqual({ label: "Parked" });
      expect(
        store.db.prepare("SELECT label FROM workspace_kinds WHERE id = 'research'").get(),
      ).toEqual({ label: "Research" });
    }
  });
});

// ------------------------------------------------------------- the known gap

describe("offline identifier collisions are recorded, not silently resolved", () => {
  /**
   * This asserts a GAP, deliberately.
   *
   * `docs/sync.md` makes the server the identifier allocator, so this collision
   * is supposed to be impossible. The deployed Worker implements no allocator, so
   * it happens. The applier's answer is the contract's general rule rather than
   * an invented one: *"No path applies last-write-wins"* — the contested value is
   * recorded on both sides, the entity is applied under a provisional identifier
   * so no issue is lost, and the decision goes to the conflict lane.
   *
   * When the server-side allocator lands, this test should start failing with
   * zero conflicts, and that failure is the signal to delete it.
   */
  it("hydration leaves the local allocator clear of the rows it just applied", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    a.store.createIssue({ title: "TST-1 on A" });
    a.store.createIssue({ title: "TST-2 on A" });
    await a.sync();

    const b = device(server, "device-b");
    await b.sync();

    /**
     * Without the allocator advance in the applier this is not a sync problem,
     * it is an immediate local one: B's counter is still at 1, `staple new`
     * mints `TST-1`, and the insert dies on `UNIQUE constraint failed:
     * issues.identifier` before anything reaches the network.
     */
    const fresh = b.store.createIssue({ title: "First local issue on B" });
    expect(fresh.identifier).toBe("TST-3");
  });

  it("keeps both issues and records the contested identifier", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    a.store.createIssue({ title: "The shared base" });
    await a.sync();

    const b = device(server, "device-b");
    await b.sync();

    // Both devices now sit at TST-1 and both allocators are at 2. Both go
    // offline and both create — the case no local rule can prevent, and the one
    // the contract's server-side allocator was supposed to.
    const onA = a.store.createIssue({ title: "Created offline on A" });
    const onB = b.store.createIssue({ title: "Created offline on B" });
    expect(onA.identifier).toBe("TST-2");
    expect(onB.identifier).toBe("TST-2");

    await a.sync();
    await b.sync();
    await a.sync();

    for (const store of [a.store, b.store]) {
      // Nothing was lost: three issues, keyed on the UUIDs that are the real
      // identity. A last-write-wins on `identifier` would have dropped one.
      expect((store.db.prepare("SELECT COUNT(*) AS n FROM issues").get() as { n: number }).n).toBe(3);

      const conflicts = store.db
        .prepare("SELECT entity, field, local_value, remote_value FROM sync_conflicts")
        .all() as Array<{
        entity: string;
        field: string;
        local_value: string;
        remote_value: string;
      }>;
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.entity).toBe("issue");
      expect(conflicts[0]!.field).toBe("identifier");
      // Both sides on the record: the value that was wanted, and the one used.
      expect(conflicts[0]!.local_value).toBe("TST-2");
      expect(conflicts[0]!.remote_value).not.toBe("TST-2");
    }

    /**
     * And the honest part: the two devices do NOT agree about which issue is
     * `TST-2`. They agree about every issue's identity, title and fields — the
     * things that carry meaning — and they disagree about one display
     * allocation, which is recorded as a conflict for a human to settle rather
     * than silently decided by whichever device synced last.
     */
    const identifierOf = (store: WorkspaceStore, id: string): string =>
      (store.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(id) as {
        identifier: string;
      }).identifier;
    expect(identifierOf(a.store, onA.id)).toBe("TST-2");
    expect(identifierOf(b.store, onA.id)).not.toBe("TST-2");
  });
});
