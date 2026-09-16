/**
 * A restore rewinds the repository, and every device with it (`docs/sync.md`, "A restore
 * rewinds"; `src/core/cloud/rewind.ts`).
 *
 * A device that held rows pushed after the backup kept them through the re-bootstrap, while
 * a device joining afterwards never had them — the same repository, two answers, for good.
 * Now what was pushed to the old epoch after the backup is gone from every device, and what a
 * device never sent is kept and reaches every device, with whatever it names.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { countOpenConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "./fixtures/older-build.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000018c";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const titles = (machine: Machine): string[] =>
  (machine.db.prepare("SELECT title FROM issues ORDER BY title").all() as Array<{ title: string }>).map((row) => row.title);

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

/**
 * Shared history, a backup, work pushed after it by A, unsent work on A and on B, and a
 * restore made on A. Every device and a fresh one are then synchronized to rest.
 */
async function restoredFleet(options: { fold?: "service" | "tail" } = {}) {
  const server = new FakeSyncServer({ repositoryId: REPO });
  fleet = new Fleet(server, REPO);
  const a = fleet.machine("a");
  const before = a.store.createIssue({ title: "Before" });
  a.store.putDocument(before.id, "spec", "the spec as backed up", { author: "alice" });
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  a.use();
  await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
  const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });

  // Pushed after the backup: everything a restore to it is for undoing.
  const gone = a.store.createIssue({ title: "Gone" });
  a.store.addComment(gone.id, "a comment on an issue made after the backup", "alice");
  a.store.putDocument(gone.id, "notes", "notes on it", { author: "alice" });
  a.store.addComment(before.id, "a comment made after the backup", "alice");
  a.store.putDocument(before.id, "spec", "the spec after the backup", { author: "alice", baseRevision: 1 });
  a.store.addStatus({ id: "qa", category: "review", label: "QA" }, "alice");
  const statuses = a.store.getStatuses().map((status) => status.id);
  a.store.reorderStatuses([...statuses].reverse(), "alice");
  a.store.renameKind("bug", "Defect", "alice");
  a.store.removeKind("spike", { migrateTo: "task" }, "alice");
  a.store.addKind({ id: "milestone", label: "Milestone" }, "alice");
  a.store.milestones().create({ title: "A milestone made after the backup", targetDate: "2026-12-01" }, "alice");
  a.store.projects().create({ name: "Web" }, "alice");
  a.store.setSetting("queue.policy", "strict", "alice");
  const blocker = a.store.createIssue({ title: "Blocker" });
  a.store.setBlockedBy(before.id, [blocker.id], "alice");
  a.store.queue().enqueue(before.id, { note: "queued after the backup" }, "alice");
  const keptByA = a.store.createIssue({ title: "Kept by a" });
  const keptByB = a.store.createIssue({ title: "Kept by b" });
  await a.sync();
  await sync(b);

  // Never sent: B's, offline, and A's, queued when it restores.
  b.use();
  b.store.createIssue({ title: "b's unsent" });
  b.store.addComment(keptByB.id, "b's unsent comment on an issue pushed after the backup", "bob");
  b.store.updateIssue(before.id, { title: "Before, retitled by b" }, "bob");
  b.store.putDocument(before.id, "spec", "b's unsent revision", { author: "bob", baseRevision: 2 });
  a.use();
  a.store.createIssue({ title: "a's unsent" });
  a.store.addComment(keptByA.id, "a's unsent comment on an issue pushed after the backup", "alice");

  await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
  // The new epoch read from the ordered tail, folded here, as a large repository is.
  if (options.fold === "tail") server.limitFold(1);
  a.use();
  const rewound = await a.sync();
  expect(rewound.bootstrap?.fromTail ?? false).toBe(options.fold === "tail");
  await sync(b, a, b);
  const fresh = fleet.machine("fresh");
  await fresh.sync();
  return { a, b, fresh, before, gone };
}

describe("a restore", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`removes what was pushed after the backup from every device (${fold} fold)`, async () => {
      const { a, b, fresh, before } = await restoredFleet({ fold });
      for (const machine of [a, b, fresh]) {
        expect(titles(machine), machine.label).toEqual(["Before, retitled by b", "Kept by a", "Kept by b", "a's unsent", "b's unsent"]);
        const db = machine.db;
        expect(db.prepare("SELECT id FROM workspace_statuses WHERE id = 'qa'").get(), machine.label).toBeUndefined();
        expect(db.prepare("SELECT label, is_builtin FROM workspace_kinds WHERE id IN ('bug', 'spike') ORDER BY id").all(), machine.label).toEqual([
          { label: "Bug", is_builtin: 1 },
          { label: "Spike", is_builtin: 1 },
        ]);
        expect(db.prepare("SELECT count(*) AS n FROM projects").get(), machine.label).toEqual({ n: 0 });
        expect(db.prepare("SELECT key FROM meta WHERE key = 'setting:queue.policy'").get(), machine.label).toBeUndefined();
        expect(db.prepare("SELECT count(*) AS n FROM relations").get(), machine.label).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM queue_entries").get(), machine.label).toEqual({ n: 0 });
        expect(db.prepare("SELECT count(*) AS n FROM milestone_meta").get(), machine.label).toEqual({ n: 0 });
        expect(
          (db.prepare("SELECT revision, body FROM document_revisions WHERE issue_id = ? ORDER BY revision").all(before.id) as Array<{ revision: number; body: string }>).map((row) => [row.revision, row.body]),
          machine.label,
        ).toEqual([
          [1, "the spec as backed up"],
          [3, "b's unsent revision"],
        ]);
      }
    });
  }

  it("keeps what a device never sent, with what it names, and every device receives it", async () => {
    const { a, b, fresh } = await restoredFleet();
    const comments = (machine: Machine): string[] =>
      (machine.db.prepare("SELECT body FROM comments WHERE author_type <> 'system' ORDER BY body").all() as Array<{ body: string }>).map((row) => row.body);
    for (const machine of [a, b, fresh]) {
      expect(comments(machine), machine.label).toEqual([
        "a's unsent comment on an issue pushed after the backup",
        "b's unsent comment on an issue pushed after the backup",
      ]);
    }
    // And nothing waits to be sent.
    for (const machine of [a, b]) expect((await machine.sync()).pending, machine.label).toBe(0);
  });

  for (const fold of ["service", "tail"] as const) {
    it(`leaves every device holding what a fresh one does (${fold} fold)`, async () => {
      const { a, b, fresh } = await restoredFleet({ fold });
      const want = stateOf(fresh.db);
      expect([...differences("a", want, stateOf(a.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
    });
  }
});

/**
 * RS1-x. The new epoch's values land on a device only after what it rewinds is gone
 * (`reconcileBeforeRead`): a device that held a post-backup issue under a number, a project
 * under a slug or an issue under a retry key gave the epoch's own entity a stand-in, or no
 * key, and nothing gave it back once the holder was removed.
 */
describe("the values a rewound row held", () => {
  it("go to the entity the new epoch holds under them, on every device", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const [a, b, c] = ["a", "b", "c"].map((label) => fleet!.machine(label)) as [Machine, Machine, Machine];
    await sync(a, b, c);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    // After the backup: A's issue, project and retried create; C holds them.
    const pushed = a.store.createIssue({ title: "A's, after the backup", idempotencyKey: "retry-1" });
    a.store.projects().create({ name: "Web" }, "alice");
    await sync(a, c);
    // B, offline, claims the same number, slug and key.
    b.use();
    const unsent = b.store.createIssue({ title: "B's, unsent", idempotencyKey: "retry-1" });
    b.store.projects().create({ name: "Web" }, "bob");
    expect(unsent.identifier).toBe(pushed.identifier);

    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, c, a, b, c);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const want = stateOf(fresh.db);
    expect([a, b, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    for (const machine of [a, b, c, fresh]) {
      expect(machine.db.prepare("SELECT identifier, idempotency_key FROM issues WHERE id = ?").get(unsent.id), machine.label).toEqual({ identifier: pushed.identifier, idempotency_key: "retry-1" });
      expect(machine.db.prepare("SELECT slug FROM projects").all(), machine.label).toEqual([{ slug: "web" }]);
      expect(countOpenConflicts(machine.db), machine.label).toBe(0);
    }
  });

  /**
   * The safety net: an issue this device held on a stand-in, its record open, whose number a
   * rewound issue held — kept here because of unsent work. It takes the number back.
   */
  it("gives a freed number back to an issue kept on a stand-in", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const [a, c] = ["a", "c"].map((label) => fleet!.machine(label)) as [Machine, Machine];
    await sync(a, c);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    const holder = a.store.createIssue({ title: "A's, after the backup" });
    await a.sync();
    // A build that never settles claims the same number after it.
    const schema = Number((a.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
    const waitingId = "00000000-0000-4000-8000-0000000000aa";
    await new OlderBuildDevice(server, REPO, "device-older", schema).push([
      {
        entity: "issue",
        entityId: waitingId,
        verb: "create",
        payload: { identifier: holder.identifier, title: "An older build's", normalizedTitle: "an older build's", status: "backlog", kind: "task", priority: "medium", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      },
    ]);
    await sync(c);
    c.use();
    expect((c.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(waitingId) as { identifier: string }).identifier).toBe(`${holder.identifier}+1`);
    // C comments on it: unsent work that keeps it through the rewind.
    c.store.addComment(waitingId, "C's unsent note", "carol");

    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(c, a, c, a);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [a, c, fresh]) {
      expect((machine.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(waitingId) as { identifier: string }).identifier, machine.label).toBe(holder.identifier);
      expect(countOpenConflicts(machine.db), machine.label).toBe(0);
    }
    const want = stateOf(fresh.db);
    expect([a, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  });
});

/**
 * RS1-y. The rewind sent built-ins again as creates when unsent work named them, and a device
 * joining afterwards put them last while every other device kept them in place. Built-ins are
 * never sent; every device installs them.
 */
describe("a restore with unsent work on a workspace with its own kind order", () => {
  it("leaves the order as it was backed up, on every device and a fresh one", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const [a, b, c] = ["a", "b", "c"].map((label) => fleet!.machine(label)) as [Machine, Machine, Machine];
    a.use();
    a.store.addKind({ id: "research", label: "Research" }, "alice");
    const kinds = a.store.getKinds().map((kind) => kind.id);
    a.store.reorderKinds([...kinds].reverse(), "alice");
    const order = a.store.getKinds().map((kind) => kind.id);
    await sync(a, b, c);
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    b.use();
    b.store.createIssue({ title: "B's, unsent", kind: "task" });
    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, c, a, b, c);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const ordered = (machine: Machine): string[] => (machine.db.prepare("SELECT id FROM workspace_kinds ORDER BY sort_order, id").all() as Array<{ id: string }>).map((row) => row.id);
    for (const machine of [a, b, c, fresh]) expect(ordered(machine), machine.label).toEqual(order);
    expect(server.ops.some((op) => (op.entity === "status" || op.entity === "kind") && op.verb === "create" && op.deviceId === "device-b")).toBe(false);
    const want = stateOf(fresh.db);
    expect([a, b, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
  });
});

