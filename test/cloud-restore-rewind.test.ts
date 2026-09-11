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
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
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
