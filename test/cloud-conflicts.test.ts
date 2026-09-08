/**
 * Two devices, the same field, and no winner.
 *
 * Contract: `docs/sync.md`, "Conflicts are preserved, never resolved silently".
 * The assertion that matters most is negative and is made first: after two
 * devices edit one field offline and both sync, NEITHER device's value has been
 * replaced by the other's. Before this lane, both devices ended up holding the
 * value of whichever operation carried the higher server `seq` — a silent
 * last-write-wins with no record that anything had been contested.
 *
 * Everything else here is downstream of that: what the record retains, that a
 * contested field does not wedge the entity it sits on or the repository around
 * it, and that resolution is an explicit choice which emits a new operation
 * rather than rewriting the two that disagreed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { bindJournal, journalFor } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { writeConnection } from "../src/core/cloud/connection.js";
import { credentialStoreFor } from "../src/core/cloud/credential-store.js";
import {
  getConflict,
  listConflicts,
  resolveConflict,
  type ConflictRecord,
} from "../src/core/cloud/conflicts.js";
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
  readonly id: string;
  readonly store: WorkspaceStore;
  readonly sync: () => Promise<SyncReport>;
}

function device(server: FakeSyncServer, deviceId: string): Device {
  const home = mkdtempSync(join(tmpdir(), `staple-conflict-${deviceId}-`));
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

function titleOf(d: Device, issueId: string): string {
  return (
    d.store.db.prepare("SELECT title FROM issues WHERE id = ?").get(issueId) as { title: string }
  ).title;
}

function columnOf(d: Device, issueId: string, column: string): unknown {
  return (
    d.store.db.prepare(`SELECT ${column} AS v FROM issues WHERE id = ?`).get(issueId) as {
      v: unknown;
    }
  ).v;
}

function open(d: Device): ConflictRecord[] {
  return listConflicts(d.store.db);
}

/**
 * A pair of devices sharing one issue, then diverging on one field of it.
 *
 * Both devices have synced the create, both edit `title` offline, and both have
 * pushed and pulled once when this returns — so both hold the other's operation
 * and both have had every chance to apply it.
 */
async function divergedOnTitle(): Promise<{
  server: FakeSyncServer;
  a: Device;
  b: Device;
  issueId: string;
}> {
  const server = new FakeSyncServer({ repositoryId: REPO_ID });
  const a = device(server, "device-a");
  const issue = a.store.createIssue({ title: "The shared base" });
  await a.sync();

  const b = device(server, "device-b");
  await b.sync();

  a.store.updateIssue(issue.id, { title: "Title from A" });
  b.store.updateIssue(issue.id, { title: "Title from B" });

  await a.sync();
  await b.sync();
  await a.sync();

  return { server, a, b, issueId: issue.id };
}

// --------------------------------------------------------------- the bar

describe("a contested field is preserved, never silently decided", () => {
  it("leaves each device holding its own value — neither is overwritten", async () => {
    const { a, b, issueId } = await divergedOnTitle();

    expect(titleOf(a, issueId)).toBe("Title from A");
    expect(titleOf(b, issueId)).toBe("Title from B");
  });

  it("records the conflict on both devices with both values in full", async () => {
    const { a, b, issueId } = await divergedOnTitle();

    for (const d of [a, b]) {
      const conflicts = open(d);
      expect(conflicts).toHaveLength(1);
      const conflict = conflicts[0]!;
      expect(conflict.entity).toBe("issue");
      expect(conflict.entityId).toBe(issueId);
      expect(conflict.field).toBe("title");
      expect(conflict.resolvedAt).toBeNull();

      // Both values, whichever side of the wire this device is on.
      expect([conflict.localValue, conflict.remoteValue].sort()).toEqual([
        "Title from A",
        "Title from B",
      ]);
    }
  });

  /**
   * The base value is recovered from the last local operation to write the field
   * BEFORE the version the incoming operation claims as its base — the two
   * histories are identical up to that point, so that write is the common
   * ancestor.
   *
   * It is therefore only available to a device that still holds that operation.
   * A device that bootstrapped from a snapshot never journaled the create, and
   * outbox compaction prunes what has been acknowledged, so the honest answer on
   * such a device is "unknown" rather than a guess. Both halves are asserted,
   * because the gap is bounded and load-bearing: filling it with the local value
   * would read as "they agreed, then one of them changed it", which is a claim
   * about history nobody is in a position to make.
   */
  it("recovers the value both sides diverged from where the history is still local", async () => {
    const { a, b } = await divergedOnTitle();
    expect(open(a)[0]!.baseValue).toBe("The shared base");
    expect(open(b)[0]!.baseValue).toBeUndefined();
  });

  it("retains both devices and both operation ids", async () => {
    const { a, b } = await divergedOnTitle();

    const onA = open(a)[0]!;
    expect(onA.localDeviceId).toBe("device-a");
    expect(onA.remoteDeviceId).toBe("device-b");
    expect(onA.localOpId).toBeTruthy();
    expect(onA.remoteOpId).toBeTruthy();
    expect(onA.localOpId).not.toBe(onA.remoteOpId);
    expect(onA.localAt).toBeTruthy();
    expect(onA.remoteAt).toBeTruthy();

    const onB = open(b)[0]!;
    expect(onB.localDeviceId).toBe("device-b");
    expect(onB.remoteDeviceId).toBe("device-a");
    // The same two operations, from the other end.
    expect([onB.localOpId, onB.remoteOpId].sort()).toEqual([onA.localOpId, onA.remoteOpId].sort());
  });

  it("gives the conflict the same id on both devices, so a resolution can name it", async () => {
    const { a, b } = await divergedOnTitle();
    expect(open(a)[0]!.id).toBe(open(b)[0]!.id);
  });

  it("is idempotent: re-delivering the same operations records nothing new", async () => {
    const { a, b } = await divergedOnTitle();
    await a.sync();
    await b.sync();
    await a.sync();
    expect(open(a)).toHaveLength(1);
    expect(open(b)).toHaveLength(1);
  });
});

// ------------------------------------------- one field does not wedge anything

describe("unrelated work keeps flowing past an open conflict", () => {
  it("applies the uncontested fields of the very operation that conflicted", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const issue = a.store.createIssue({ title: "The shared base" });
    await a.sync();
    const b = device(server, "device-b");
    await b.sync();

    // B's single operation carries a contested field and an uncontested one.
    a.store.updateIssue(issue.id, { title: "Title from A" });
    b.store.updateIssue(issue.id, { title: "Title from B", priority: "high" });

    await a.sync();
    await b.sync();
    await a.sync();

    // The contested half is withheld and recorded; the rest of the same
    // operation lands, because an operation is not all-or-nothing per field.
    expect(titleOf(a, issue.id)).toBe("Title from A");
    expect(columnOf(a, issue.id, "priority")).toBe("high");
    expect(open(a).map((c) => c.field)).toEqual(["title"]);
  });

  it("does not stop other issues, or other entities, from replicating", async () => {
    const { server, a, b, issueId } = await divergedOnTitle();
    expect(open(a)).toHaveLength(1);

    const other = a.store.createIssue({ title: "Nothing to do with it" });
    a.store.addComment(other.id, "still talking", "someone");
    await a.sync();
    await b.sync();

    expect(
      b.store.db.prepare("SELECT title FROM issues WHERE id = ?").get(other.id),
    ).toEqual({ title: "Nothing to do with it" });
    expect(
      (b.store.db.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n,
    ).toBe(1);

    // And the conflict is still exactly where it was: open, and not multiplied.
    expect(open(b)).toHaveLength(1);
    expect(titleOf(b, issueId)).toBe("Title from B");
  });

  it("still reports the entity as syncable — a conflict is data, not an error", async () => {
    const { a } = await divergedOnTitle();
    const report = await a.sync();
    expect(report.conflicts).toBe(1);
  });
});

describe("disjoint fields are not a conflict", () => {
  it("lets two devices set different fields of one issue without contesting either", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const issue = a.store.createIssue({ title: "The shared base" });
    await a.sync();
    const b = device(server, "device-b");
    await b.sync();

    a.store.updateIssue(issue.id, { priority: "high" });
    b.store.updateIssue(issue.id, { assignee: "someone" });

    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(open(d)).toHaveLength(0);
      expect(columnOf(d, issue.id, "priority")).toBe("high");
      expect(columnOf(d, issue.id, "assignee")).toBe("someone");
    }
  });

  it("does not contest a field two devices happened to set identically", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const issue = a.store.createIssue({ title: "The shared base" });
    await a.sync();
    const b = device(server, "device-b");
    await b.sync();

    a.store.updateIssue(issue.id, { priority: "high" });
    b.store.updateIssue(issue.id, { priority: "high" });

    await a.sync();
    await b.sync();
    await a.sync();

    expect(open(a)).toHaveLength(0);
    expect(open(b)).toHaveLength(0);
  });
});

// ------------------------------------------------------------ resolution

describe("resolution is an explicit choice that emits a new operation", () => {
  it("refuses to guess: there is no automatic winner to wait for", async () => {
    const { a, b, issueId } = await divergedOnTitle();
    // Sync as many times as you like; nothing resolves on its own.
    await a.sync();
    await b.sync();
    await a.sync();
    await b.sync();
    expect(open(a)).toHaveLength(1);
    expect(titleOf(a, issueId)).toBe("Title from A");
    expect(titleOf(b, issueId)).toBe("Title from B");
  });

  it("emits a NEW operation and rewrites neither of the two that disagreed", async () => {
    const { a, issueId } = await divergedOnTitle();
    const conflict = open(a)[0]!;

    const before = a.store.db
      .prepare("SELECT op_id, payload FROM sync_outbox ORDER BY client_seq")
      .all() as Array<{ op_id: string; payload: string }>;

    resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });

    const after = a.store.db
      .prepare("SELECT op_id, entity, verb, base_version, payload FROM sync_outbox ORDER BY client_seq")
      .all() as Array<{
      op_id: string;
      entity: string;
      verb: string;
      base_version: number | null;
      payload: string;
    }>;

    // Nothing that existed before was altered — history is appended to, never edited.
    for (const row of before) {
      expect(after.find((r) => r.op_id === row.op_id)!.payload).toBe(row.payload);
    }

    const fresh = after.filter((row) => !before.some((old) => old.op_id === row.op_id));
    const domain = fresh.find((row) => row.entity === "issue")!;
    expect(domain.verb).toBe("update");
    expect(JSON.parse(domain.payload).title).toBe("Title from B");
    // Post-conflict by construction: the seam's own bump, above every version
    // either side of the conflict ever claimed.
    expect(domain.base_version).toBeGreaterThan(0);

    // The decision itself replicates, so other devices close the same record.
    expect(fresh.some((row) => row.entity === "conflict")).toBe(true);

    expect(titleOf(a, issueId)).toBe("Title from B");
  });

  it("keeps the record after resolving — who chose, what they chose, and what the other option was", async () => {
    const { a } = await divergedOnTitle();
    const conflict = open(a)[0]!;
    resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });

    expect(open(a)).toHaveLength(0);
    const resolved = getConflict(a.store.db, conflict.id)!;
    expect(resolved.resolvedAt).toBeTruthy();
    expect(resolved.resolvedBy).toBe("vp");
    expect(resolved.resolvedValue).toBe("Title from B");
    expect(resolved.resolvedChoice).toBe("remote");
    // Both original values are still on the record.
    expect(resolved.localValue).toBe("Title from A");
    expect(resolved.remoteValue).toBe("Title from B");
  });

  it("survives compaction, because an audit record is not spent state", async () => {
    const { a } = await divergedOnTitle();
    const conflict = open(a)[0]!;
    resolveConflict(a.store.db, { id: conflict.id, choice: "local", actor: "vp" });
    await a.sync();

    journalFor(a.store.db).compact();

    const resolved = getConflict(a.store.db, conflict.id)!;
    expect(resolved.resolvedBy).toBe("vp");
    expect(resolved.localValue).toBe("Title from A");
    expect(resolved.remoteValue).toBe("Title from B");
  });

  it("accepts a third value the human wrote themselves", async () => {
    const { a, issueId } = await divergedOnTitle();
    const conflict = open(a)[0]!;
    resolveConflict(a.store.db, {
      id: conflict.id,
      choice: "custom",
      value: "A title they both agree on",
      actor: "vp",
    });
    expect(titleOf(a, issueId)).toBe("A title they both agree on");
    expect(getConflict(a.store.db, conflict.id)!.resolvedValue).toBe("A title they both agree on");
  });

  it("refuses a custom resolution with no value rather than inventing one", async () => {
    const { a } = await divergedOnTitle();
    const conflict = open(a)[0]!;
    expect(() => resolveConflict(a.store.db, { id: conflict.id, choice: "custom" })).toThrow(
      /value/i,
    );
  });

  it("refuses an unknown conflict", async () => {
    const { a } = await divergedOnTitle();
    expect(() => resolveConflict(a.store.db, { id: "nope", choice: "local" })).toThrow(/nope/);
  });
});

describe("resolution is idempotent and convergent", () => {
  it("resolving the same conflict the same way twice changes nothing the second time", async () => {
    const { a, issueId } = await divergedOnTitle();
    const conflict = open(a)[0]!;

    const first = resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });
    expect(first.changed).toBe(true);
    const pending = (
      a.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }
    ).n;

    const second = resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });
    expect(second.changed).toBe(false);
    expect(
      (a.store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n,
    ).toBe(pending);
    expect(titleOf(a, issueId)).toBe("Title from B");
  });

  it("refuses to silently overturn a resolution with a different one", async () => {
    const { a } = await divergedOnTitle();
    const conflict = open(a)[0]!;
    resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });
    expect(() =>
      resolveConflict(a.store.db, { id: conflict.id, choice: "local", actor: "someone-else" }),
    ).toThrow(/resolved/i);
  });

  it("converges every device on the chosen value and closes the record everywhere", async () => {
    const { a, b, issueId } = await divergedOnTitle();
    const conflict = open(a)[0]!;

    resolveConflict(a.store.db, { id: conflict.id, choice: "local", actor: "vp" });
    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(titleOf(d, issueId)).toBe("Title from A");
      expect(open(d)).toHaveLength(0);
      const record = getConflict(d.store.db, conflict.id)!;
      expect(record.resolvedBy).toBe("vp");
      expect(record.resolvedValue).toBe("Title from A");
    }
  });

  it("converges when the OTHER device's value is the one chosen", async () => {
    const { a, b, issueId } = await divergedOnTitle();
    const conflict = open(a)[0]!;

    resolveConflict(a.store.db, { id: conflict.id, choice: "remote", actor: "vp" });
    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      expect(titleOf(d, issueId)).toBe("Title from B");
      expect(open(d)).toHaveLength(0);
    }
  });

  it("does not fork again when both devices independently make the same call", async () => {
    const { a, b, issueId } = await divergedOnTitle();
    const conflict = open(a)[0]!;
    expect(open(b)[0]!.id).toBe(conflict.id);

    // Both humans pick A's value, each on their own machine, offline.
    resolveConflict(a.store.db, { id: conflict.id, choice: "local", actor: "vp-on-a" });
    resolveConflict(b.store.db, { id: conflict.id, choice: "remote", actor: "vp-on-b" });

    await a.sync();
    await b.sync();
    await a.sync();
    await b.sync();

    for (const d of [a, b]) {
      expect(titleOf(d, issueId)).toBe("Title from A");
      expect(open(d)).toHaveLength(0);
    }
  });
});

// ------------------------------------------------- the one users hit today

describe("offline identifier collisions", () => {
  /**
   * `docs/sync.md` makes the server the identifier allocator, so this is meant
   * to be impossible; the deployed Worker has no allocator (STA-254), so it is
   * the conflict a user actually meets. The applier already records it. What is
   * asserted here is that it arrives in the same shape as every other conflict
   * and can be settled through the same one surface.
   */
  async function collided(): Promise<{ a: Device; b: Device; onA: string; onB: string }> {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    a.store.createIssue({ title: "The shared base" });
    await a.sync();
    const b = device(server, "device-b");
    await b.sync();

    const onA = a.store.createIssue({ title: "Created offline on A" });
    const onB = b.store.createIssue({ title: "Created offline on B" });
    expect(onA.identifier).toBe("TST-2");
    expect(onB.identifier).toBe("TST-2");

    await a.sync();
    await b.sync();
    await a.sync();
    return { a, b, onA: onA.id, onB: onB.id };
  }

  it("names the local side as what this database holds, and the remote as what arrived", async () => {
    const { a, onB } = await collided();
    const conflict = open(a)[0]!;
    expect(conflict.field).toBe("identifier");
    expect(conflict.entityId).toBe(onB);
    // B's issue is the one that landed here under a provisional number.
    expect(conflict.localValue).toBe(columnOf(a, onB, "identifier"));
    expect(conflict.remoteValue).toBe("TST-2");
    expect(conflict.remoteDeviceId).toBe("device-b");
  });

  it("frees the contested number when the arriving issue is given it", async () => {
    const { a, onA, onB } = await collided();
    const conflict = open(a)[0]!;
    expect(columnOf(a, onA, "identifier")).toBe("TST-2");

    const outcome = resolveConflict(a.store.db, {
      id: conflict.id,
      choice: "remote",
      actor: "vp",
    });

    expect(columnOf(a, onB, "identifier")).toBe("TST-2");
    // The incumbent yielded it, and said so, rather than the write failing on a
    // UNIQUE index nobody can act on.
    expect(columnOf(a, onA, "identifier")).not.toBe("TST-2");
    expect(outcome.renumbered).toEqual([
      { issueId: onA, from: "TST-2", to: columnOf(a, onA, "identifier") },
    ]);
  });

  it("settles the display allocation on both devices once someone decides", async () => {
    const { a, b, onA, onB } = await collided();
    const conflict = open(a)[0]!;
    resolveConflict(a.store.db, { id: conflict.id, choice: "local", actor: "vp" });

    await a.sync();
    await b.sync();
    await a.sync();

    // Both devices agree about which issue owns which number, and no issue was
    // lost to get there.
    for (const d of [a, b]) {
      expect(
        (d.store.db.prepare("SELECT COUNT(*) AS n FROM issues").get() as { n: number }).n,
      ).toBe(3);
      expect(columnOf(d, onB, "identifier")).toBe(columnOf(a, onB, "identifier"));
      expect(columnOf(d, onA, "identifier")).toBe(columnOf(a, onA, "identifier"));
    }
  });
});

// ------------------------------------------------------- ordered collections

describe("ordered collections conflict whole, never row by row", () => {
  it("keeps both plans and contests the order itself", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO_ID });
    const a = device(server, "device-a");
    const one = a.store.createIssue({ title: "One" });
    const two = a.store.createIssue({ title: "Two" });
    const three = a.store.createIssue({ title: "Three" });
    await a.sync();
    /**
     * B is hydrated BEFORE the plan exists, and receives it as an ordinary
     * `replace` off the tail. A plan that already existed at bootstrap would not
     * arrive at all — the snapshot fold wraps a `replace` as
     * `{ replaced: payload }` and no applier unwraps it, on this side or in
     * `worker/src/snapshot.ts`. That is a pre-existing transport gap, reported
     * separately, and pinning it here would only disguise it as a conflict test.
     */
    const b = device(server, "device-b");
    await b.sync();

    for (const ref of [one.identifier, two.identifier, three.identifier]) {
      a.store.queue().mutate("add", { ref });
    }
    await a.sync();
    await b.sync();

    a.store.queue().mutate("reorder", { order: [three.identifier, one.identifier, two.identifier] });
    b.store.queue().mutate("reorder", { order: [two.identifier, three.identifier, one.identifier] });

    await a.sync();
    await b.sync();
    await a.sync();

    for (const d of [a, b]) {
      const conflicts = open(d);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]!.entity).toBe("queue");
      // One conflict for the whole plan, and the UNIQUE rank constraint never
      // came near it.
      expect(Array.isArray(conflicts[0]!.localValue)).toBe(true);
      expect(Array.isArray(conflicts[0]!.remoteValue)).toBe(true);
    }

    // Each device still holds its own plan, in full and in order.
    expect(
      a.store.db.prepare("SELECT issue_id FROM queue_entries ORDER BY rank").all(),
    ).toEqual([{ issue_id: three.id }, { issue_id: one.id }, { issue_id: two.id }]);
    expect(
      b.store.db.prepare("SELECT issue_id FROM queue_entries ORDER BY rank").all(),
    ).toEqual([{ issue_id: two.id }, { issue_id: three.id }, { issue_id: one.id }]);
  });
});
