/**
 * STA-260 — a stale ordered-collection `replace` is refused, on every device.
 *
 * Contract: `docs/sync.md`, "Ordered collections replicate whole, not row by row"
 * and "Conflicts are preserved, never resolved silently".
 *
 * ## What was actually wrong
 *
 * The CAS token was never missing from the wire. Every envelope carries
 * `baseVersion`, taken from `sync_entity_versions`, and the contract says in as
 * many words that this is the number a `replace` is checked against. What was
 * missing was the CHECK: `screenForConflicts` would only contest a field that a
 * surviving local `sync_outbox` row also named, and for an ordered collection
 * that extra condition is both unnecessary and destructive.
 *
 * Unnecessary, because a collection that replicates as one whole-list
 * pseudo-field has no disjoint field sets to protect — the condition exists to
 * keep *"Disjoint field sets are not a conflict"* true, and there is only one
 * field here.
 *
 * Destructive, in two ways that both end with a human's plan gone and nothing
 * anywhere recording that there had been two:
 *
 *   1. **The incumbent order need not be locally authored.** A device that
 *      APPLIED the order it is holding journaled nothing, so it has no outbox
 *      row to defend that order with, and adopted the next stale `replace` to
 *      arrive.
 *   2. **The outbox is transient.** `compact()` prunes acknowledged rows as
 *      routine housekeeping. The moment it did, even the device that AUTHORED
 *      the order stopped being able to defend it — two devices and one
 *      compaction were enough. Detection that expires is not detection.
 *
 * So the tests below are deliberately not the pretty case. The pretty case — two
 * devices, both with their own operations still sitting in their outboxes —
 * already passed before this lane, and is covered in `cloud-conflicts.test.ts`.
 * These are the three shapes that did not, plus the assertion that the whole
 * fleet still converges on one decision afterwards.
 *
 * ## Verifying the tests by breaking the fix
 *
 * Restoring the outbox requirement — dropping the `wholeField` block in
 * `screenForConflicts` so a collection is contestable only when a local outbox
 * row names it — turns "a compacted outbox" and "a relayed order" red, with the
 * losing order gone and zero conflicts, which is exactly the reported defect.
 * Removing `settleOpenFor` instead leaves "the fleet settles on one plan" red
 * with an open conflict stranded on the device that could not name its own side.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeConnection } from "../src/core/cloud/connection.js";
import {
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from "../src/core/cloud/conflicts.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import { syncRepository, type SyncReport } from "../src/core/cloud/sync.js";
import { openDb } from "../src/core/db.js";
import { bindJournal, journalFor } from "../src/core/journal.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";

const REPO_ID = "0e77fa01-3333-4444-8555-666677778888";
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
  const home = mkdtempSync(join(tmpdir(), `staple-ordrev-${deviceId}-`));
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

/** The plan, read from the table so no resolver can flatter it. */
function plan(d: Device): string[] {
  return (
    d.store.db.prepare("SELECT issue_id FROM queue_entries ORDER BY rank").all() as Array<{
      issue_id: string;
    }>
  ).map((row) => row.issue_id);
}

function members(d: Device, milestoneId: string): string[] {
  return (
    d.store.db
      .prepare("SELECT issue_id FROM milestone_members WHERE milestone_id = ? ORDER BY rank")
      .all(milestoneId) as Array<{ issue_id: string }>
  ).map((row) => row.issue_id);
}

function open(d: Device): ConflictRecord[] {
  return listConflicts(d.store.db);
}

interface Fixture {
  server: FakeSyncServer;
  ids: { one: string; two: string; three: string };
  refs: { one: string; two: string; three: string };
}

/** Three issues, created on `origin` and pushed. Nothing is queued yet. */
async function seeded(origin: Device, server: FakeSyncServer): Promise<Fixture> {
  const one = origin.store.createIssue({ title: "One" });
  const two = origin.store.createIssue({ title: "Two" });
  const three = origin.store.createIssue({ title: "Three" });
  await origin.sync();
  return {
    server,
    ids: { one: one.id, two: two.id, three: three.id },
    refs: { one: one.identifier, two: two.identifier, three: three.identifier },
  };
}

// ------------------------------------------------------------- the wire shape

describe("what an ordered-collection replace puts on the wire", () => {
  it("carries the order in the payload and the CAS token in the envelope", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const { ids, refs } = await seeded(a, server);
    for (const ref of [refs.one, refs.two, refs.three]) a.store.queue().mutate("add", { ref });

    const journal = journalFor(a.store.db);
    const pending = journal.pending().filter((op) => op.entity === "queue");
    const last = pending[pending.length - 1]!;

    expect(last.verb).toBe("replace");
    expect(last.payload.order).toEqual([ids.one, ids.two, ids.three]);
    /**
     * The base revision, where the contract says it is: the entity's version
     * from `sync_entity_versions`, on the envelope. It is NOT duplicated into
     * the payload — a second copy of one number is a second thing that can be
     * wrong, and a payload key would additionally be screened as a contestable
     * field of the collection, which it is not.
     */
    expect(last.baseVersion).toBe(journal.entityVersion("queue", last.entityId) - 1);
    expect(last.payload.baseRevision).toBeUndefined();
    /** No rank crosses the wire. That is what makes UNIQUE (rank) unreachable. */
    expect(JSON.stringify(last.payload)).not.toContain("rank");
  });

  it("names the milestone by the envelope's entityId, not by a payload field", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    a.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const { ids } = await seeded(a, server);
    const milestone = a.store.createIssue({ title: "M", kind: MILESTONE_KIND });
    for (const id of [ids.one, ids.two]) a.store.milestones().addMember(milestone.id, id, {}, "vp");

    const pending = journalFor(a.store.db)
      .pending()
      .filter((op) => op.entity === "milestone" && Array.isArray(op.payload.members));
    const last = pending[pending.length - 1]!;

    expect(last.entityId).toBe(milestone.id);
    expect(last.payload.members).toEqual([ids.one, ids.two]);
    expect(last.payload.milestoneId).toBeUndefined();
    expect(last.payload.baseRevision).toBeUndefined();
  });
});

// ------------------------------------------- the scenario a human actually hits

describe("two devices reorder the same plan offline", () => {
  /**
   * The plain case, and the one the ticket names: both devices reorder, both
   * sync, and NEITHER order may be discarded without a record.
   */
  it("keeps both orders and contests the plan as a whole", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const { ids, refs } = await seeded(a, server);
    const b = device(server, "device-b");
    await b.sync();
    for (const ref of [refs.one, refs.two, refs.three]) a.store.queue().mutate("add", { ref });
    await a.sync();
    await b.sync();

    const aOrder = [ids.three, ids.one, ids.two];
    const bOrder = [ids.two, ids.three, ids.one];
    a.store.queue().mutate("reorder", { order: [refs.three, refs.one, refs.two] });
    b.store.queue().mutate("reorder", { order: [refs.two, refs.three, refs.one] });

    await a.sync();
    await b.sync();
    await a.sync();

    // Neither order was discarded: each device still holds its own, in full.
    expect(plan(a)).toEqual(aOrder);
    expect(plan(b)).toEqual(bOrder);

    // And both orders are on the record, on both devices, as ONE conflict about
    // the plan rather than three about issues.
    for (const d of [a, b]) {
      const conflicts = open(d);
      expect(conflicts).toHaveLength(1);
      expect([conflicts[0]!.entity, conflicts[0]!.field]).toEqual(["queue", "order"]);
      expect([conflicts[0]!.localValue, conflicts[0]!.remoteValue].sort()).toEqual(
        [aOrder, bOrder].sort(),
      );
    }
  });

  /**
   * The same disagreement, after routine housekeeping — and the case that was
   * silently losing a plan between two devices and nothing else.
   *
   * `compact()` prunes acknowledged outbox rows and is documented as *"routine
   * and safe"*. It is only safe if nothing load-bearing reads the outbox, and
   * conflict detection did.
   */
  it("still refuses a stale replace after the incumbent's outbox row is compacted", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const { ids, refs } = await seeded(a, server);
    const b = device(server, "device-b");
    await b.sync();
    for (const ref of [refs.one, refs.two, refs.three]) a.store.queue().mutate("add", { ref });
    await a.sync();
    await b.sync();

    const aOrder = [ids.three, ids.one, ids.two];
    a.store.queue().mutate("reorder", { order: [refs.three, refs.one, refs.two] });
    b.store.queue().mutate("reorder", { order: [refs.two, refs.three, refs.one] });

    await a.sync();
    journalFor(a.store.db).compact("2999-01-01T00:00:00.000Z");
    expect(
      (a.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n,
    ).toBe(0);

    await b.sync();
    await a.sync();

    expect(plan(a)).toEqual(aOrder);
    expect(open(a)).toHaveLength(1);
    expect(open(a)[0]!.field).toBe("order");
    /**
     * Both orders are still retained in full.
     *
     * The local side used to be unattributed here, and this assertion used to
     * read `toBeNull()`. It has been INVERTED by STA-261, and the inversion is
     * the improvement rather than a regression: `sync_field_writes` (migration
     * 011) records the newest write of every field of every entity, is written
     * by the apply path as well as by the journal, and is never pruned on the
     * compaction horizon — so the operation that authored this order is still
     * nameable after its outbox row is gone.
     *
     * That matters for more than tidiness. A conflict id is a function of the
     * two operation ids, so an unattributable side gave this device an id no
     * other device could compute, and only {@link settleOpenFor} kept the fleet
     * from stranding it. With the incumbent named, the two devices compute the
     * SAME id from the same pair, which is what lets one resolution close one
     * record everywhere.
     *
     * The `null` branch is not dead and is not allowed to become dead: a
     * database upgraded to 011 whose outbox had already been compacted has
     * nothing to backfill from, and a bootstrapped device holds values it never
     * authored or relayed. That residual case is asserted, deliberately, in
     * `test/cloud-scalar-conflict-evidence.test.ts`.
     */
    expect(open(a)[0]!.localValue).toEqual(aOrder);
    expect(open(a)[0]!.remoteValue).toEqual([ids.two, ids.three, ids.one]);
    expect(open(a)[0]!.localOpId).not.toBeNull();
  });

  /**
   * A device holding an order it applied rather than authored must defend it
   * just as hard. It has no outbox row and never will have one.
   */
  it("refuses a stale replace against an order this device only relayed", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const { ids, refs } = await seeded(a, server);
    const b = device(server, "device-b");
    const c = device(server, "device-c");
    await b.sync();
    await c.sync();
    for (const ref of [refs.one, refs.two, refs.three]) a.store.queue().mutate("add", { ref });
    await a.sync();
    await b.sync();
    await c.sync();

    // A reorders; B relays it and authors nothing. C has been offline since.
    const aOrder = [ids.three, ids.one, ids.two];
    a.store.queue().mutate("reorder", { order: [refs.three, refs.one, refs.two] });
    await a.sync();
    await b.sync();
    expect(plan(b)).toEqual(aOrder);

    c.store.queue().mutate("reorder", { order: [refs.two, refs.three, refs.one] });
    await c.sync();
    await b.sync();
    await a.sync();

    // B held a plan it did not author, and did not hand it over silently.
    expect(plan(b)).toEqual(aOrder);
    expect(open(b)).toHaveLength(1);
    expect(open(b)[0]!.localValue).toEqual(aOrder);
    expect(open(b)[0]!.remoteValue).toEqual([ids.two, ids.three, ids.one]);
    // And the device that authored it reached the same verdict independently.
    expect(plan(a)).toEqual(aOrder);
    expect(open(a)).toHaveLength(1);
  });
});

describe("two devices reorder the same milestone's membership offline", () => {
  it("refuses a stale replaceMembers after the incumbent's outbox row is compacted", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    a.store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const { ids } = await seeded(a, server);
    const milestone = a.store.createIssue({ title: "M", kind: MILESTONE_KIND });
    await a.sync();
    const b = device(server, "device-b");
    await b.sync();
    for (const id of [ids.one, ids.two, ids.three]) {
      a.store.milestones().addMember(milestone.id, id, {}, "vp");
    }
    await a.sync();
    await b.sync();

    const aOrder = [ids.three, ids.one, ids.two];
    a.store.milestones().moveMember(ids.three, { before: ids.one }, "vp");
    b.store.milestones().moveMember(ids.two, { before: ids.one }, "vp");

    await a.sync();
    journalFor(a.store.db).compact("2999-01-01T00:00:00.000Z");
    await b.sync();
    await a.sync();

    expect(members(a, milestone.id)).toEqual(aOrder);
    expect(members(b, milestone.id)).toEqual([ids.two, ids.one, ids.three]);
    for (const d of [a, b]) {
      const conflicts = open(d);
      expect(conflicts).toHaveLength(1);
      expect([conflicts[0]!.entity, conflicts[0]!.field]).toEqual(["milestone", "members"]);
      expect(conflicts[0]!.entityId).toBe(milestone.id);
    }
    /**
     * The ranks stayed dense and legal on both sides. Nothing that crossed the
     * wire could have collided on `UNIQUE (milestone_id, rank)`, because no rank
     * crossed it.
     */
    for (const d of [a, b]) {
      const ranks = (
        d.store.db
          .prepare("SELECT rank FROM milestone_members WHERE milestone_id = ? ORDER BY rank")
          .all(milestone.id) as Array<{ rank: number }>
      ).map((row) => row.rank);
      expect(new Set(ranks).size).toBe(ranks.length);
    }
  });
});

// -------------------------------------------------------- one decision, one plan

describe("a human chooses, and the fleet settles on that plan", () => {
  /**
   * Refusing a stale replace is only half the bar. The other half is that the
   * refusal ends — that someone decides, the decision replicates, and NO device
   * is left reporting an open conflict about a plan that has been settled.
   *
   * This is where the compaction case bites twice: the deciding device's record
   * and the compacted device's record cannot share an id, because a conflict id
   * is a function of the two operation ids and one of them no longer exists.
   */
  it("closes the conflict everywhere and converges on the chosen order", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const { ids, refs } = await seeded(a, server);
    const b = device(server, "device-b");
    await b.sync();
    for (const ref of [refs.one, refs.two, refs.three]) a.store.queue().mutate("add", { ref });
    await a.sync();
    await b.sync();

    a.store.queue().mutate("reorder", { order: [refs.three, refs.one, refs.two] });
    b.store.queue().mutate("reorder", { order: [refs.two, refs.three, refs.one] });
    await a.sync();
    journalFor(a.store.db).compact("2999-01-01T00:00:00.000Z");
    await b.sync();
    await a.sync();

    expect(open(a)).toHaveLength(1);
    expect(open(b)).toHaveLength(1);

    // The human on A prefers what arrived from B.
    const chosen = [ids.two, ids.three, ids.one];
    resolveConflict(a.store.db, { id: open(a)[0]!.id, choice: "remote", actor: "vp" });
    expect(plan(a)).toEqual(chosen);

    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(plan(d)).toEqual(chosen);
      // Nothing is still asking. The records survive, resolved, with both orders.
      expect(open(d)).toHaveLength(0);
      const settled = listConflicts(d.store.db, { includeResolved: true });
      expect(settled.length).toBeGreaterThan(0);
      for (const record of settled) {
        expect(record.resolvedAt).not.toBeNull();
        expect(record.resolvedValue).toEqual(chosen);
      }
    }
  });
});
