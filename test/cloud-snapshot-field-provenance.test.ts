/**
 * STA-263 — a device that bootstrapped from a snapshot defends what it inherited.
 *
 * Contract: `docs/sync.md`, "Conflicts are preserved, never resolved silently".
 *
 * ## What was wrong
 *
 * STA-261 gave detection evidence that survives a relay and a compaction, and it named
 * the hole it did not close. A device that hydrated from a SNAPSHOT holds values it
 * neither authored nor relayed, so `sync_field_writes` was empty for every one of them,
 * so condition (2) — *"the field is named by a write this device holds"* — was false for
 * every field, and the next stale write to an inherited value was accepted in silence.
 *
 * Measured on this exact shape before anything changed: the hydrated device had ZERO
 * rows for the entity, adopted the stale title, and recorded no conflict, while the
 * device that authored the value recorded one. The fleet held an open argument about a
 * value one side had already thrown away.
 *
 * ## Why this could not be closed by recording the snapshot's fields
 *
 * That fix would be WRONG, not merely coarse, and the second group below is the reason.
 * `createIssue` journals ONE `create` carrying the entity's whole field inventory —
 * `priority: input.priority ?? "medium"` among it — so marking every field of the folded
 * state as written at the snapshot's version would make a later `priority` edit contest
 * a `medium` nobody ever chose. **Manufacturing conflicts out of defaults is worse than
 * the silence it replaces.**
 *
 * So the fold had to learn to tell a field somebody SET from a field that merely arrived
 * carrying its default, and the line it draws is the one the client already draws for
 * its own writes: `Journal.flush` records provenance for every verb EXCEPT `create`. A
 * field has provenance iff a non-`create` operation carried it. The consequence is the
 * property worth stating — **a hydrated device holds field-for-field the rows a device
 * present for the whole log holds, and no others** — and it is what makes the first two
 * groups here true at the same time.
 *
 * ## Verifying these tests by breaking the fix
 *
 * Dropping the `verb !== "create"` guard in `worker/src/fold.ts` (record every key of
 * every operation) leaves the first group green and turns the second red, with a
 * conflict raised over a `medium` nobody chose — the trap, reproduced.
 *
 * Dropping the `recordInheritedFieldWrites` call from `runBootstrap` leaves the second
 * group green and turns the first red, with the stale title adopted and zero conflicts —
 * the original defect, reproduced.
 *
 * Neither break disturbs the other group, which is what says the two halves are being
 * held by two independent pieces of the fix rather than by one lucky one.
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
import {
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from "../src/core/cloud/conflicts.js";
import { syncRepository, type SyncReport } from "../src/core/cloud/sync.js";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
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
  readonly home: string;
  readonly server: FakeSyncServer;
  readonly sync: () => Promise<SyncReport>;
}

function device(server: FakeSyncServer, deviceId: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-hydrated-${deviceId}-`));
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
    home,
    server,
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

function fieldsWritten(d: Device, entityId: string): string[] {
  return (
    d.store.db
      .prepare("SELECT field FROM sync_field_writes WHERE entity_id = ? ORDER BY field")
      .all(entityId) as Array<{ field: string }>
  ).map((row) => row.field);
}

function writeOf(
  d: Device,
  entityId: string,
  field: string,
): { base_version: number; op_id: string | null; written_at: string } | undefined {
  return d.store.db
    .prepare(
      "SELECT base_version, op_id, written_at FROM sync_field_writes WHERE entity_id = ? AND field = ?",
    )
    .get(entityId, field) as
    | { base_version: number; op_id: string | null; written_at: string }
    | undefined;
}

/**
 * `a` authors and then edits. `c` bootstrapped BEFORE that edit, so its view is
 * genuinely stale. `b` bootstraps AFTER it, so every value `b` holds arrived folded
 * into a snapshot — `b` has journaled nothing and relayed nothing.
 *
 * The three-device shape is the point. A two-device test cannot separate "inherited
 * from a snapshot" from "relayed from the tail", and the relay case was already closed.
 */
async function hydrated(): Promise<{
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

  const c = device(server, "device-c");
  await c.sync();

  a.store.updateIssue(issue.id, { title: "Title from A" });
  await a.sync();

  const b = device(server, "device-b");
  await b.sync();

  return { server, a, b, c, issueId: issue.id };
}

/**
 * `b` is forced through a re-bootstrap by a real restore, carrying epoch-1
 * provenance and an epoch-1 counter into a timeline that restarted.
 *
 * Two edits before the backup, so `b` arrives at the restore with a counter of 3 and
 * rows at `base_version 2` — high enough to outrank everything the new epoch holds,
 * which is what made the stale rows harmful rather than merely useless.
 */
async function restored(): Promise<{ a: Device; b: Device; issueId: string }> {
  const server = new FakeSyncServer({ repositoryId: REPO_ID });
  const a = device(server, "device-a");
  const b = device(server, "device-b");

  const issue = a.store.createIssue({ title: "shared" });
  await a.sync();
  await b.sync();

  a.store.updateIssue(issue.id, { title: "A one" });
  await a.sync();
  await b.sync();
  a.store.updateIssue(issue.id, { title: "A two" });
  await a.sync();
  await b.sync();

  await setBackupConsent(a.home, REPO_ID, true, { fetchImpl: server.fetch });
  const backup = await createBackup(a.home, REPO_ID, null, { fetchImpl: server.fetch });
  await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, {
    fetchImpl: server.fetch,
  });

  // B's next sync is the re-bootstrap: its cursor points into a superseded epoch.
  const report = await b.sync();
  expect(report.bootstrap, "the restore must have forced one").not.toBeNull();

  return { a, b, issueId: issue.id };
}

/**
 * `b` carries an UNPUSHED edit across a restore, and `stale` hydrates onto the
 * restored timeline before that edit gets out — so `stale`'s view of the field is
 * genuinely behind `b`'s, and `b` is the device being asked to give up a value it
 * authored and has not yet been able to send.
 */
async function queuedAcrossRestore(): Promise<{
  b: Device;
  stale: Device;
  issueId: string;
}> {
  const server = new FakeSyncServer({ repositoryId: REPO_ID });
  const a = device(server, "device-a");
  const b = device(server, "device-b");

  const issue = a.store.createIssue({ title: "shared" });
  await a.sync();
  await b.sync();

  await setBackupConsent(a.home, REPO_ID, true, { fetchImpl: server.fetch });
  const backup = await createBackup(a.home, REPO_ID, null, { fetchImpl: server.fetch });

  b.store.updateIssue(issue.id, { title: "queued on B" });
  await restoreFromBackup(a.store.db, a.home, REPO_ID, backup.backupId, {
    fetchImpl: server.fetch,
  });

  const stale = device(server, "device-stale");
  await stale.sync();

  // B's re-bootstrap, which clears the field record and then replays the outbox.
  await b.sync();

  return { b, stale, issueId: issue.id };
}

// ------------------------------------------- a value this device inherited whole

describe("a device defends a field it inherited from a snapshot", () => {
  /**
   * The reported defect, in its smallest form. B never typed a title and never even
   * applied an operation carrying one — it was handed the folded result. That is not a
   * weaker claim on the value: it is the same value, and B is the device being asked to
   * give it up.
   */
  it("contests a stale scalar write against a value it inherited", async () => {
    const { b, c, issueId } = await hydrated();

    expect(titleOf(b, issueId)).toBe("Title from A");
    // B journaled nothing and never will. This is what the outbox knew, and what
    // `sync_applied` knew: neither can name a single field of this issue.
    expect(count(b, "sync_outbox")).toBe(0);

    c.store.updateIssue(issueId, { title: "Title from C" });
    await c.sync();
    await b.sync();

    expect(titleOf(b, issueId)).toBe("Title from A");
    const contested = open(b);
    expect(contested).toHaveLength(1);
    expect([contested[0]!.entity, contested[0]!.field]).toEqual(["issue", "title"]);
    expect(contested[0]!.localValue).toBe("Title from A");
    expect(contested[0]!.remoteValue).toBe("Title from C");
  });

  /**
   * The inherited row is indistinguishable from the one a device present for the whole
   * log holds — same version, same operation, same timestamp. That is the property the
   * fix is built around, and it is stronger than "B raises a conflict": it is why B
   * raises the SAME conflict.
   */
  it("inherits the version and the attribution, not merely the value", async () => {
    const { a, b, issueId } = await hydrated();

    const inherited = writeOf(b, issueId, "title");
    const authored = writeOf(a, issueId, "title");
    expect(inherited).toBeDefined();
    expect(inherited!.op_id).toBe(authored!.op_id);
    expect(inherited!.base_version).toBe(authored!.base_version);
    expect(inherited!.written_at).toBe(authored!.written_at);
  });

  /**
   * And so one decision closes one record on every machine. A conflict id is a function
   * of the two operation ids; a device defending a value it cannot name computes an id
   * no other device computes, and the fleet settles by the {@link settleOpenFor}
   * fallback instead of by agreement.
   */
  it("computes the same conflict id on the author and on the device that bootstrapped", async () => {
    const { a, b, c, issueId } = await hydrated();

    c.store.updateIssue(issueId, { title: "Title from C" });
    await c.sync();
    await b.sync();
    await a.sync();

    expect(open(a)).toHaveLength(1);
    expect(open(b)).toHaveLength(1);
    expect(open(b)[0]!.id).toBe(open(a)[0]!.id);
    // B attributes the incumbent to A's operation, because that is whose write it is.
    expect(open(b)[0]!.localOpId).toBe(open(a)[0]!.localOpId);
    expect(open(b)[0]!.localOpId).not.toBeNull();
  });

  it("settles everywhere on one decision, and converges on the chosen value", async () => {
    const { a, b, c, issueId } = await hydrated();

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

  /**
   * An ordered collection reaches a hydrated device the same way, and now reaches it
   * WITH an attribution. `contest` has a floor that contests a whole-plan pseudo-field
   * on the version comparison alone; before this lane that floor was the only thing
   * standing between a bootstrapped device and a silently overwritten plan, and it
   * could not name what it was defending. The ordinary field record does both.
   */
  it("names the operation behind an inherited plan rather than falling back to the floor", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const first = a.store.createIssue({ title: "First" });
    const second = a.store.createIssue({ title: "Second" });
    a.store.queue().mutate("add", { ref: first.identifier });
    await a.sync();

    const c = device(server, "device-c");
    await c.sync();

    a.store.queue().mutate("add", { ref: second.identifier });
    await a.sync();

    const b = device(server, "device-b");
    await b.sync();

    // The whole plan lives under one entity id and replicates as one pseudo-field.
    expect(fieldsWritten(b, "@plan")).toEqual(["order"]);
    expect(writeOf(b, "@plan", "order")!.op_id).toBe(writeOf(a, "@plan", "order")!.op_id);
  });
});

// -------------------------------------- the guarantee that made this its own ticket

describe("an untouched default is not a decision", () => {
  /**
   * The trap, and the reason recording the snapshot's fields would have been wrong
   * rather than merely incomplete. Nobody ever chose `medium`; it is what `createIssue`
   * writes when the caller says nothing. A device that treated it as a decision would
   * report a conflict over a value with no second opinion behind it.
   */
  /**
   * The behaviour, asserted with nothing checked beforehand so that a regression fails
   * HERE — on the conflict that should not exist — rather than on a structural
   * precondition that would fail first and hide what it costs.
   */
  it("does not contest a field that only ever held its create-time default", async () => {
    const { b, c, issueId } = await hydrated();
    expect(columnOf(b, issueId, "priority")).toBe("medium");

    c.store.updateIssue(issueId, { priority: "high" });
    await c.sync();
    await b.sync();

    // A conflict here would be an argument with nobody: a human asked to choose between
    // `high` and a `medium` that was never a decision.
    expect(open(b)).toHaveLength(0);
    expect(columnOf(b, issueId, "priority")).toBe("high");
  });

  /** And the structural reason for it, so a regression says WHY and not merely that. */
  it("records no provenance for a field only the create carried", async () => {
    const { b, issueId } = await hydrated();
    // Not "priority at the snapshot's version". Nothing at all.
    expect(fieldsWritten(b, issueId)).not.toContain("priority");
    // What IS here is the edit somebody actually made, and its companions.
    expect(fieldsWritten(b, issueId)).toContain("title");
  });

  /**
   * And every device in the fleet agrees about which fields were set, which is the real
   * standard — a rule that made two devices answer the same question about the same
   * field differently would be a new bug wearing the fix's clothes.
   *
   * Note that A goes through the fold too: `syncRepository` pushes before it pulls, and
   * a device whose cursor is null bootstraps, so A's very first sync hands A's own
   * create straight back through `/snapshot`. The create exclusion is therefore not one
   * rule for authors and another for newcomers. It is the only rule, everywhere.
   */
  it("agrees with every other device about which fields were set", async () => {
    const { a, b, c, issueId } = await hydrated();
    expect(fieldsWritten(b, issueId)).toEqual(fieldsWritten(a, issueId));
    // C bootstrapped before the edit, so it holds strictly less — and none of the
    // create's fields either.
    expect(fieldsWritten(c, issueId)).toEqual([]);
  });

  /**
   * Even a value the caller typed at create time gets no provenance, and that is
   * deliberate rather than an oversight in the rule. The alternative is a fold that
   * inspects payload values against a table of defaults, which would have to be kept in
   * step with `createIssue` forever and would still be guessing. Matching what the
   * author's own database records is a rule that cannot drift.
   */
  it("treats a value chosen at create time the way the author's own database does", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const issue = a.store.createIssue({ title: "Deliberate", priority: "critical" });
    await a.sync();

    const c = device(server, "device-c");
    await c.sync();

    a.store.updateIssue(issue.id, { title: "Renamed" });
    await a.sync();

    const b = device(server, "device-b");
    await b.sync();

    expect(columnOf(b, issue.id, "priority")).toBe("critical");
    expect(fieldsWritten(b, issue.id)).toEqual(fieldsWritten(a, issue.id));
    expect(fieldsWritten(b, issue.id)).not.toContain("priority");

    c.store.updateIssue(issue.id, { priority: "low" });
    await c.sync();
    await b.sync();
    await a.sync();

    // Neither device contests it, and they do not contest it for the same reason.
    expect(open(a)).toHaveLength(0);
    expect(open(b)).toHaveLength(0);
  });

  /**
   * The bound, asserted rather than asserted about. Provenance is one row per field a
   * non-create operation carried — a strict subset of the fields the state holds — so
   * it grows with live entities × fields and with no term in history. Ten more edits to
   * the same two fields add no rows at all.
   */
  it("adds no row per operation, only per field somebody wrote", async () => {
    const { a, b, issueId } = await hydrated();

    for (let n = 0; n < 10; n += 1) {
      a.store.updateIssue(issueId, { title: `Title ${n}`, assignee: `agent-${n}` });
    }
    await a.sync();
    await b.sync();

    const fields = fieldsWritten(b, issueId);
    expect(new Set(fields).size).toBe(fields.length);
    // title, assignee, and the bookkeeping/derived companions those two edits carry.
    // The number is small and FIXED; what matters is that eleven edits did not make it
    // eleven times bigger.
    expect(fields.length).toBeLessThanOrEqual(6);
  });
});

// ------------------------------------------- the guarantee the fix must not cost

describe("disjoint field sets are still not a conflict after a bootstrap", () => {
  it("lets a stale device set a field the hydrated one never held a claim on", async () => {
    const { a, b, c, issueId } = await hydrated();

    c.store.updateIssue(issueId, { assignee: "someone" });
    await c.sync();
    await b.sync();
    await a.sync();
    await c.sync();

    for (const d of [a, b, c]) {
      expect(open(d)).toHaveLength(0);
      expect(columnOf(d, issueId, "title")).toBe("Title from A");
      expect(columnOf(d, issueId, "assignee")).toBe("someone");
    }
  });

  /**
   * The shape that would break first if inherited provenance were coarser than a field.
   * B's claim on `title` is real; C's `estimate` is stale by the version comparison and
   * must still land untouched beside it.
   */
  it("does not let an inherited field contest a disjoint one in the same operation", async () => {
    const { a, b, c, issueId } = await hydrated();

    c.store.updateIssue(issueId, { title: "Title from C", estimatedSeconds: 3600 });
    await c.sync();
    await b.sync();

    // The contested field is withheld; the disjoint one in the same payload is applied.
    expect(titleOf(b, issueId)).toBe("Title from A");
    expect(columnOf(b, issueId, "estimated_seconds")).toBe(3600);
    expect(open(b).map((record) => record.field)).toEqual(["title"]);
    void a;
  });

  it("does not contest a field the hydrated device and the sender happened to agree on", async () => {
    const { b, c, issueId } = await hydrated();

    c.store.updateIssue(issueId, { title: "Title from A" });
    await c.sync();
    await b.sync();

    expect(titleOf(b, issueId)).toBe("Title from A");
    expect(open(b)).toHaveLength(0);
  });
});

// -------------------------------------------- the epoch the provenance is denominated in

/**
 * A re-bootstrap is the third way a device acquires values it did not author, and
 * the one where the provenance it already holds becomes actively harmful.
 *
 * Every row in `sync_field_writes` is a claim in two currencies of the epoch it was
 * written in — a `base_version` on that epoch's counter, and an `op_id` minted in it.
 * A restore replaces both. `beginBootstrap` deliberately does NOT rewind
 * `sync_entity_versions`, so a device carries a high counter into an epoch whose fold
 * restarts at zero, and its old rows sit above everything the new epoch contains.
 *
 * Measured before the fix, on the shape in the first test here: the re-bootstrapped
 * device held rows at `base_version 2` naming an epoch-1 operation, used them to
 * withhold an ordinary post-restore edit, and recorded a conflict that the device
 * which made the edit knew nothing about — an argument with no second party, whose id
 * no other device computes.
 */
describe("an epoch change is a change of currency, not just of history", () => {
  it("does not contest a post-restore write with a claim from the discarded timeline", async () => {
    const { a, b, issueId } = await restored();

    // The device that hydrated fresh onto the restored timeline makes an ordinary
    // edit. Nothing about it is stale.
    const fresh = device(a.server, "device-fresh");
    await fresh.sync();
    fresh.store.updateIssue(issueId, { title: "written after the restore" });
    await fresh.sync();

    await b.sync();

    // Both devices reach the same answer, which is the point. Before the fix B
    // withheld the value and recorded a conflict while `fresh` recorded none.
    expect(titleOf(b, issueId)).toBe("written after the restore");
    expect(open(b)).toHaveLength(0);
    expect(open(fresh)).toHaveLength(0);
  });

  it("holds exactly what a device that hydrated fresh into the same epoch holds", async () => {
    const { a, b, issueId } = await restored();
    const fresh = device(a.server, "device-fresh");
    await fresh.sync();

    // The re-bootstrapped device and the fresh one are indistinguishable. The
    // counters still differ — `beginBootstrap` keeps versions on purpose — but no
    // claim survives from the epoch that was thrown away.
    expect(fieldsWritten(b, issueId)).toEqual(fieldsWritten(fresh, issueId));
  });

  /**
   * The half that clearing alone would cost, and why the clear is paired with a
   * replay. The outbox is the one thing a re-bootstrap explicitly preserves —
   * *"its pending local work survives"* — so the fields those queued operations name
   * are values this device still holds and must still be able to defend.
   *
   * Without the replay this is the relay defect of STA-261 reached by a third road:
   * the device pushes its own edit, holds it with no record saying so, and hands it
   * to the next stale write in silence.
   */
  it("still defends work it had queued across the restore", async () => {
    const { b, stale, issueId } = await queuedAcrossRestore();

    stale.store.updateIssue(issueId, { title: "written by stale" });
    await stale.sync();
    await b.sync();

    // Nothing checked before the sync, so a regression fails on the silence itself:
    // B pushing its own edit and then handing it straight to a stale write.
    expect(titleOf(b, issueId)).toBe("queued on B");
    expect(open(b).map((record) => record.field)).toEqual(["title"]);
    expect(open(b)[0]!.remoteValue).toBe("written by stale");
  });

  /** And the structural reason, so a regression says WHY and not merely that. */
  it("replays the surviving outbox into the cleared field record", async () => {
    const { b, issueId } = await queuedAcrossRestore();
    expect(fieldsWritten(b, issueId)).toContain("title");
    expect(titleOf(b, issueId)).toBe("queued on B");
  });
});
