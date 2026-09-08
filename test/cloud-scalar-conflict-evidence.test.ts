/**
 * STA-261 — a stale scalar write is refused after a relay and after a compaction.
 *
 * Contract: `docs/sync.md`, "Conflicts are preserved, never resolved silently".
 *
 * ## What was actually wrong
 *
 * Detection is field-scoped: *"an incoming operation conflicts when its
 * `baseVersion` is behind the local entity version AND its payload field set
 * intersects the fields changed by the local operations in between."* The second
 * condition was read off `sync_outbox`, and the outbox cannot answer it. It is a
 * queue of what this device has to SEND; the question is what this device HOLDS.
 * Those differ in both directions, and both are ordinary:
 *
 *   1. **A relayed value was never in the outbox.** A device that APPLIED
 *      another device's `title` journals nothing — that is what stops two
 *      devices synchronizing forever — so it holds a title somebody chose with
 *      no row anywhere naming it, and hands it to the next stale write to arrive.
 *   2. **The outbox is emptied.** `compact()` prunes acknowledged rows as
 *      routine, documented, safe housekeeping, and the moment it runs the device
 *      that AUTHORED the value can no longer defend it.
 *
 * Both were measured before anything was changed, on this exact shape. In each,
 * the losing device silently adopted the stale value and recorded NOTHING, while
 * the other device recorded a conflict — so the fleet ended up holding an open
 * argument about a value one side had already discarded.
 *
 * ## Why STA-260's fix could not simply be repeated
 *
 * STA-260 hit the same two failures on ordered collections and closed them by
 * dropping the field condition. That is sound there and only there: a collection
 * replicates as ONE pseudo-field carrying the whole list, so it has no disjoint
 * field sets to protect. A scalar entity has them, and *"Disjoint field sets are
 * not a conflict"* is a stated guarantee — dropping the condition would make one
 * device's `priority` edit contest another's `estimate`. The answer could not be
 * to ask less, so it is to record more: `sync_field_writes` (migration 011) holds
 * the newest write of each field of each entity, written by the apply path as
 * well as by the journal, and bounded by live entities rather than by history so
 * that nothing time-based ever prunes it.
 *
 * The third group below matters as much as the first two. A fix that caught
 * stale writes by making everything a conflict would be worse than the bug.
 *
 * ## Verifying the tests by breaking the fix
 *
 * Deleting the `recordFieldWrites` call from `screenForConflicts` — leaving the
 * journal's own — turns "a value this device only relayed" red with the stale
 * title adopted and zero conflicts, which is defect 1 exactly. Adding
 * `AND created_at < ?` to the `sync_field_writes` delete in `Journal.compact` so
 * that provenance is pruned on the horizon like everything else turns "after the
 * author's outbox row is compacted" red the same way, which is defect 2. And
 * contesting on the version alone — dropping the `localWrites.get(...)` guard in
 * `contest` the way an ordered collection legitimately does — leaves the two
 * defect tests green and turns every test in "disjoint field sets" red, which is
 * the trade this design exists to refuse.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal, journalFor } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import {
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from "../src/core/cloud/conflicts.js";
import { syncRepository, type SyncReport } from "../src/core/cloud/sync.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-7777-4888-8999-aaaabbbbcccc";
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
  readonly id: string;
  readonly store: WorkspaceStore;
  readonly sync: () => Promise<SyncReport>;
}

function device(server: FakeSyncServer, deviceId: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-scalar-${deviceId}-`));
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
    id: deviceId,
    store,
    sync: () =>
      syncRepository(store.db, REPO_ID, {
        home,
        fetchImpl: server.fetch,
        sleep: async () => undefined,
      }),
  };
}

/** Read from the table so no resolver can flatter it. */
function columnOf(d: Device, issueId: string, column: string): unknown {
  return (
    d.store.db.prepare(`SELECT ${column} AS v FROM issues WHERE id = ?`).get(issueId) as {
      v: unknown;
    }
  ).v;
}

const titleOf = (d: Device, issueId: string): unknown => columnOf(d, issueId, "title");
const open = (d: Device): ConflictRecord[] => listConflicts(d.store.db);
const count = (d: Device, table: string): number =>
  (d.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

interface FieldWrite {
  field: string;
  base_version: number;
  op_id: string | null;
  device_id: string | null;
}

function fieldWrites(d: Device, entityId?: string): FieldWrite[] {
  const sql =
    "SELECT field, base_version, op_id, device_id FROM sync_field_writes" +
    (entityId === undefined ? "" : " WHERE entity_id = ?") +
    " ORDER BY field";
  const stmt = d.store.db.prepare(sql);
  return (entityId === undefined ? stmt.all() : stmt.all(entityId)) as unknown as FieldWrite[];
}

/**
 * Three devices sharing one issue. `a` authors, `b` relays, `c` has been offline
 * since before `a`'s edit and therefore has a genuinely stale view.
 */
async function relayed(): Promise<{
  server: FakeSyncServer;
  a: Device;
  b: Device;
  c: Device;
  issueId: string;
}> {
  const server = new FakeSyncServer({ repositoryId: REPO_ID });
  const a = device(server, "device-a");
  const issue = a.store.createIssue({ title: "The shared base" });
  await a.sync();

  const b = device(server, "device-b");
  const c = device(server, "device-c");
  await b.sync();
  await c.sync();

  return { server, a, b, c, issueId: issue.id };
}

// --------------------------------------------------- a value this device relayed

describe("a device defends a field it relayed as hard as one it authored", () => {
  /**
   * The reported defect, in its smallest form. B never typed a title; it applied
   * A's. That is not a weaker claim on the value — it is the same value, and the
   * device holding it is the one being asked to give it up.
   */
  it("contests a stale scalar write against a value it only relayed", async () => {
    const { a, b, c, issueId } = await relayed();

    a.store.updateIssue(issueId, { title: "Title from A" });
    await a.sync();
    await b.sync();
    expect(titleOf(b, issueId)).toBe("Title from A");
    // B journaled nothing for it, and never will. This is what the outbox knew.
    expect(count(b, "sync_outbox")).toBe(0);

    c.store.updateIssue(issueId, { title: "Title from C" });
    await c.sync();
    await b.sync();

    // B did not hand over a value a human chose, and did not do it in silence.
    expect(titleOf(b, issueId)).toBe("Title from A");
    const contested = open(b);
    expect(contested).toHaveLength(1);
    expect([contested[0]!.entity, contested[0]!.field]).toEqual(["issue", "title"]);
    expect(contested[0]!.localValue).toBe("Title from A");
    expect(contested[0]!.remoteValue).toBe("Title from C");
  });

  /**
   * And the relay can name the operation it is defending, which is what lets one
   * decision close one record on every machine. A conflict id is a function of
   * the two operation ids; before there was any provenance, a device defending a
   * value it had not authored produced an id no other device computed.
   */
  it("computes the same conflict id on the author and on the relay", async () => {
    const { a, b, c, issueId } = await relayed();

    a.store.updateIssue(issueId, { title: "Title from A" });
    await a.sync();
    await b.sync();

    c.store.updateIssue(issueId, { title: "Title from C" });
    await c.sync();
    await b.sync();
    await a.sync();

    expect(open(a)).toHaveLength(1);
    expect(open(b)).toHaveLength(1);
    expect(open(b)[0]!.id).toBe(open(a)[0]!.id);
    // The relay attributes the incumbent to the operation that produced it —
    // A's — not to itself, because that is whose write the value is.
    expect(open(b)[0]!.localOpId).toBe(open(a)[0]!.localOpId);
    expect(open(b)[0]!.localOpId).not.toBeNull();
  });

  it("settles everywhere on one decision, and converges on the chosen value", async () => {
    const { a, b, c, issueId } = await relayed();

    a.store.updateIssue(issueId, { title: "Title from A" });
    await a.sync();
    await b.sync();
    c.store.updateIssue(issueId, { title: "Title from C" });
    await c.sync();
    await b.sync();
    await a.sync();

    resolveConflict(b.store.db, { id: open(b)[0]!.id, choice: "local", actor: "vp" });
    await b.sync();
    for (const d of [a, c, b]) await d.sync();
    await b.sync();

    for (const d of [a, b, c]) {
      expect(titleOf(d, issueId)).toBe("Title from A");
      expect(open(d)).toHaveLength(0);
    }
  });
});

// ------------------------------------------------ a value housekeeping erased

describe("routine compaction does not disarm detection", () => {
  /**
   * `compact()` is documented as *"routine and safe"* and prunes acknowledged
   * outbox rows. Before this lane it was safe only in the sense that nothing
   * crashed: it silently removed the evidence the author needed to defend its own
   * edit, and two devices plus one compaction were enough to lose a value.
   */
  it("contests a stale scalar write after the author's own outbox row is pruned", async () => {
    const { a, b, issueId } = await relayed();

    a.store.updateIssue(issueId, { title: "Title from A" });
    b.store.updateIssue(issueId, { title: "Title from B" });

    await a.sync();
    journalFor(a.store.db).compact("2999-01-01T00:00:00.000Z");
    expect(count(a, "sync_outbox")).toBe(0);
    // The evidence outlived the queue. That is the whole fix in one assertion.
    expect(count(a, "sync_field_writes")).toBeGreaterThan(0);

    await b.sync();
    await a.sync();

    expect(titleOf(a, issueId)).toBe("Title from A");
    expect(open(a)).toHaveLength(1);
    expect(open(a)[0]!.field).toBe("title");
    expect(open(a)[0]!.localValue).toBe("Title from A");
    expect(open(a)[0]!.remoteValue).toBe("Title from B");
    // Still nameable, so both devices reach the same id for the same argument.
    expect(open(a)[0]!.id).toBe(open(b)[0]!.id);
  });

  /**
   * Compaction is entitled to prune provenance for an entity that no longer
   * exists, and for no other. An `update` for a tombstoned entity is a no-op
   * regardless of arrival order, so those rows can never be the evidence for any
   * conflict; a live entity's rows are exactly the evidence that must not expire.
   */
  it("prunes provenance for tombstoned entities only", async () => {
    const { a, b, issueId } = await relayed();
    const doomed = a.store.projects().create({ name: "Doomed" }, "vp");
    a.store.projects().update(doomed.slug, { name: "Doomed, renamed" }, "vp");
    a.store.updateIssue(issueId, { priority: "high" });
    await a.sync();
    await b.sync();
    expect(fieldWrites(b, doomed.id).length).toBeGreaterThan(0);

    a.store.projects().remove(doomed.slug, "vp");
    await a.sync();
    await b.sync();
    expect(count(b, "sync_tombstones")).toBe(1);

    const result = journalFor(b.store.db).compact("2999-01-01T00:00:00.000Z");

    expect(result.fieldWritesPruned).toBeGreaterThan(0);
    expect(fieldWrites(b, doomed.id)).toHaveLength(0);
    // And the live issue's evidence is untouched, which is the half that matters.
    expect(fieldWrites(b, issueId).map((row) => row.field)).toContain("priority");
  });
});

// ------------------------------------------- the guarantee the fix must not cost

describe("disjoint field sets are still not a conflict", () => {
  it("lets two devices set different fields of one issue, as before", async () => {
    const { a, b, issueId } = await relayed();

    a.store.updateIssue(issueId, { priority: "high" });
    b.store.updateIssue(issueId, { assignee: "someone" });

    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(open(d)).toHaveLength(0);
      expect(columnOf(d, issueId, "priority")).toBe("high");
      expect(columnOf(d, issueId, "assignee")).toBe("someone");
    }
  });

  /**
   * The shape that would break first if provenance were coarser than a field —
   * if, say, the version comparison alone were allowed to contest a scalar the
   * way it legitimately contests a whole-list pseudo-field. B holds a `priority`
   * it relayed and now has provenance for; C's `assignee` is stale by the version
   * comparison and must still land untouched.
   */
  it("does not let a relayed field contest a disjoint one", async () => {
    const { a, b, c, issueId } = await relayed();

    a.store.updateIssue(issueId, { priority: "high" });
    await a.sync();
    await b.sync();
    expect(fieldWrites(b, issueId).map((row) => row.field)).toContain("priority");

    c.store.updateIssue(issueId, { assignee: "someone" });
    await c.sync();
    await b.sync();
    await a.sync();
    await c.sync();

    for (const d of [a, b, c]) {
      expect(open(d)).toHaveLength(0);
      expect(columnOf(d, issueId, "priority")).toBe("high");
      expect(columnOf(d, issueId, "assignee")).toBe("someone");
    }
  });

  it("does not let a compacted field contest a disjoint one", async () => {
    const { a, b, issueId } = await relayed();

    a.store.updateIssue(issueId, { priority: "high" });
    b.store.updateIssue(issueId, { assignee: "someone" });
    await a.sync();
    journalFor(a.store.db).compact("2999-01-01T00:00:00.000Z");
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(open(d)).toHaveLength(0);
      expect(columnOf(d, issueId, "priority")).toBe("high");
      expect(columnOf(d, issueId, "assignee")).toBe("someone");
    }
  });

  it("does not contest a field two devices happened to set identically", async () => {
    const { a, b, issueId } = await relayed();

    a.store.updateIssue(issueId, { title: "Agreed" });
    b.store.updateIssue(issueId, { title: "Agreed" });
    await a.sync();
    await b.sync();
    await a.sync();

    expect(open(a)).toHaveLength(0);
    expect(open(b)).toHaveLength(0);
  });
});

// ---------------------------------------------- what the evidence costs to keep

describe("the evidence is bounded, and the apply owns it", () => {
  /**
   * One row per field however long the history is. This is not an optimization —
   * it is why the table never needs a horizon, and a table that never needs a
   * horizon is one housekeeping cannot disarm. A log of every write would have
   * grown until something had to prune it, and pruning it is the bug.
   */
  it("keeps one row per field no matter how many times the field is written", async () => {
    const { a, issueId } = await relayed();

    for (const title of ["one", "two", "three", "four", "five"]) {
      a.store.updateIssue(issueId, { title });
      await a.sync();
    }

    const rows = fieldWrites(a, issueId).filter((row) => row.field === "title");
    expect(rows).toHaveLength(1);
    // And it is the NEWEST write that survives, which is what detection asks for.
    expect(rows[0]!.base_version).toBe(
      journalFor(a.store.db).entityVersion("issue", issueId) - 1,
    );
  });

  /**
   * Provenance is written in the same transaction as the domain write it
   * describes, on both paths — the journal's flush runs inside the mutation's
   * transaction, and the apply path's write runs inside `Journal.applyRemote`.
   *
   * A row that survived a rolled-back apply would be worse than no row at all: it
   * would make the next stale value look contested against a value this device
   * does not hold, and it would do it from a table nothing ever prunes. So a page
   * that fails anywhere must take the provenance with it.
   *
   * The failure here is the one the applier documents: an operation naming a
   * referent the page never delivered. B's comment reaches A without the issue it
   * belongs to, so the whole page rolls back — including B's perfectly good
   * `assignee` write that had already been applied and recorded.
   */
  it("rolls provenance back with the page that failed", async () => {
    const { server, a, b, issueId } = await relayed();

    b.store.updateIssue(issueId, { assignee: "someone" });
    const orphanIssue = b.store.createIssue({ title: "Never delivered" });
    b.store.addComment(orphanIssue.id, "a comment on an issue A will never see", "vp");
    await b.sync();

    // The issue create is lost in transit; its comment is not.
    const before = server.ops.length;
    const lost = server.ops.findIndex(
      (op) => op.entity === "issue" && op.entityId === orphanIssue.id && op.verb === "create",
    );
    expect(lost).toBeGreaterThanOrEqual(0);
    server.ops.splice(lost, 1);
    expect(server.ops.length).toBeLessThan(before);

    await expect(a.sync()).rejects.toThrow(/never delivered/);

    // Nothing from that page landed: not the domain write, and not its evidence.
    expect(columnOf(a, issueId, "assignee")).toBeNull();
    expect(fieldWrites(a, issueId).map((row) => row.field)).not.toContain("assignee");
    expect(count(a, "issues")).toBe(1);
  });
});

// ------------------------------------------------------- the upgrade itself

describe("migration 011 backfills what the outbox can still prove", () => {
  /**
   * The upgrade path, with data in it.
   *
   * Every fixture the migration suite walks forward has an empty outbox, so the
   * backfill would pass those tests while doing nothing at all — and a backfill
   * that silently does nothing means every already-connected device loses the
   * attribution for every value it holds the moment it upgrades. So this builds a
   * real v10 database with real outbox rows and runs ONLY 011 over it.
   */
  function walkedTo(version: number): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    for (const migration of [...WORKSPACE_TARGET.migrations]
      .sort((a, b) => a.version - b.version)
      .filter((m) => m.version <= version)) {
      migration.up(db);
    }
    return db;
  }

  function outbox(
    db: DatabaseSync,
    row: { opId: string; seq: number; base: number | null; payload: Record<string, unknown> },
  ): void {
    db.prepare(
      `INSERT INTO sync_outbox
         (op_id, client_seq, entity, entity_id, verb, base_version, payload, actor, created_at)
       VALUES (?, ?, 'issue', 'issue-1', ?, ?, ?, 'vp', ?)`,
    ).run(
      row.opId,
      row.seq,
      row.base === null ? "create" : "update",
      row.base,
      JSON.stringify(row.payload),
      `2026-09-0${row.seq}T00:00:00.000Z`,
    );
  }

  it("replays the outbox so the newest write of each field survives the upgrade", () => {
    const db = walkedTo(10);
    try {
      outbox(db, { opId: "op-create", seq: 1, base: null, payload: { title: "First" } });
      outbox(db, { opId: "op-title", seq: 2, base: 1, payload: { title: "Second" } });
      outbox(db, { opId: "op-both", seq: 3, base: 2, payload: { title: "Third", priority: "high" } });

      const eleven = WORKSPACE_TARGET.migrations.find((m) => m.version === 11)!;
      eleven.up(db);

      const rows = db
        .prepare("SELECT field, base_version, op_id FROM sync_field_writes ORDER BY field")
        .all() as unknown as Array<{ field: string; base_version: number; op_id: string }>;

      expect(rows).toEqual([
        { field: "priority", base_version: 2, op_id: "op-both" },
        // The NEWEST write of `title` won, not the first one replayed.
        { field: "title", base_version: 2, op_id: "op-both" },
      ]);
      // The create is excluded, exactly as the query it replaces excluded it: it
      // carries no base version and was never one of "the operations in between".
      expect(rows.every((row) => row.op_id !== "op-create")).toBe(true);
    } finally {
      db.close();
    }
  });

  it("upgrades an unconnected workspace to an empty table, observably doing nothing", () => {
    const db = walkedTo(10);
    try {
      WORKSPACE_TARGET.migrations.find((m) => m.version === 11)!.up(db);
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM sync_field_writes").get() as { n: number }).n,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

// --------------------------------------------- the case provenance cannot reach

describe("a device with no provenance at all", () => {
  /**
   * Provenance is not universal and cannot be made so. A database upgraded to 011
   * whose outbox had ALREADY been compacted has nothing to backfill from — the
   * evidence was destroyed before the table existed — and a device that
   * bootstrapped from a snapshot holds values it neither authored nor relayed,
   * because the server's fold ships no per-field provenance with them.
   *
   * For an ordered collection that residual case is still covered, by the branch
   * STA-260 added: the collection is one pseudo-field, so the version comparison
   * alone is proof, and the incumbent is simply left unattributed. This is that
   * branch, exercised deliberately so it cannot rot into dead code — the local
   * side is `null`, both orders are still retained in full, and the record is
   * still settleable through the rule that closes every open record for the same
   * `(entity, entityId, field)` rather than only the id it names.
   *
   * For a scalar there is no equivalent, and pretending otherwise would cost the
   * disjoint-field guarantee: with no record of WHICH field was written, the only
   * available test is the version comparison, and that contests `priority`
   * against `estimate`. Closing it needs the fold to carry per-field versions,
   * which is `worker/src/fold.ts` — named here rather than papered over.
   */
  it("still contests an ordered collection, unattributed, and still settles", async () => {
    const { a, b } = await relayed();
    const one = a.store.createIssue({ title: "One" });
    const two = a.store.createIssue({ title: "Two" });
    await a.sync();
    await b.sync();
    for (const ref of [one.identifier, two.identifier]) a.store.queue().mutate("add", { ref });
    await a.sync();
    await b.sync();

    a.store.queue().mutate("reorder", { order: [two.identifier, one.identifier] });
    b.store.queue().mutate("reorder", { order: [one.identifier, two.identifier] });
    await a.sync();

    /**
     * The pre-011 database, exactly: acknowledged rows pruned by an older build,
     * so the upgrade found nothing to backfill and the table is empty for this
     * entity. Deleted rather than mocked — the point is a real absence.
     */
    journalFor(a.store.db).compact("2999-01-01T00:00:00.000Z");
    a.store.db.prepare("DELETE FROM sync_field_writes").run();

    await b.sync();
    await a.sync();

    const contested = open(a);
    expect(contested).toHaveLength(1);
    expect([contested[0]!.entity, contested[0]!.field]).toEqual(["queue", "order"]);
    expect(contested[0]!.localValue).toEqual([two.id, one.id]);
    expect(contested[0]!.remoteValue).toEqual([one.id, two.id]);
    // Unattributable, honestly: the operation that produced this order is gone.
    expect(contested[0]!.localOpId).toBeNull();

    resolveConflict(a.store.db, { id: contested[0]!.id, choice: "local", actor: "vp" });
    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(open(d)).toHaveLength(0);
      expect(
        (
          d.store.db.prepare("SELECT issue_id FROM queue_entries ORDER BY rank").all() as Array<{
            issue_id: string;
          }>
        ).map((row) => row.issue_id),
      ).toEqual([two.id, one.id]);
    }
  });
});
