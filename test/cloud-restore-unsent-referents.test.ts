/**
 * RR1. A restore keeps what an unsent EDIT names (`docs/sync.md`, "A restore rewinds").
 *
 * The rewind kept an entity with unsent work, and walked what it names — but only when the new
 * epoch lacked the entity itself. An unsent edit of an issue the backup holds names what it
 * names all the same: a status, a kind, a project, a blocker, a queued issue or a milestone
 * member made after the backup. Those were removed while the edit was still sent, so the issue
 * pointed at a status, kind or project that existed nowhere, and a blocker set, the plan or a
 * milestone's members disagreed with a fresh device for good (the entry set aside as waiting).
 * Now every unsent operation's referents are kept when the epoch lacks them, transitively, and
 * sent as creates ahead of the edit.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { countOpenConflicts } from "../src/core/cloud/conflicts.js";
import { countQuarantined } from "../src/core/cloud/quarantine.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000a7a9";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

const has = (machine: Machine, sql: string, ...params: string[]): boolean => machine.db.prepare(sql).get(...params) !== undefined;

describe("a restore with an unsent edit naming what was made after the backup", () => {
  for (const what of ["status", "kind", "project", "relation", "queue", "milestone"] as const) {
    it(`keeps the ${what} it names, on every device and a fresh one`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.addKind({ id: "milestone", label: "Milestone" }, "alice");
      const e1 = a.store.createIssue({ title: "E1" });
      a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "alice");
      const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
      a.store.milestones().addMember(m, e1.id, {}, "alice");
      a.store.queue().enqueue(e1.id, {}, "alice");
      const e3 = a.store.createIssue({ title: "E3" });
      a.store.setBlockedBy(e1.id, [e3.id], "alice");
      await a.sync();
      const b = fleet.machine("b");
      await sync(b);

      a.use();
      await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
      const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
      // After the backup, pushed: a status, a kind, a project and an issue.
      a.store.addStatus({ id: "qa", category: "review", label: "QA" }, "alice");
      a.store.addKind({ id: "spike2", label: "Spike2" }, "alice");
      const project = a.store.projects().create({ name: "P1" }, "alice");
      const n1 = a.store.createIssue({ title: "N1" });
      await a.sync();
      await sync(b);

      // B, offline: one unsent edit of E1 — which the backup holds — naming one of them.
      b.use();
      if (what === "status") b.store.updateIssue(e1.id, { status: "qa" }, "bob");
      if (what === "kind") b.store.updateIssue(e1.id, { kind: "spike2" }, "bob");
      if (what === "project") b.store.projects().assign(e1.id, project.slug, "bob");
      if (what === "relation") b.store.setBlockedBy(e1.id, [e3.id, n1.id], "bob");
      if (what === "queue") b.store.queue().enqueue(n1.id, {}, "bob");
      if (what === "milestone") b.store.milestones().addMember(m, n1.id, {}, "bob");

      a.use();
      await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
      await sync(a, b, a, b, a);
      const fresh = fleet.machine("fresh");
      await sync(fresh);

      const want = stateOf(fresh.db);
      expect([a, b].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
      for (const machine of [a, b, fresh]) {
        const row = machine.db.prepare("SELECT status, kind, project_id FROM issues WHERE id = ?").get(e1.id) as { status: string; kind: string; project_id: string | null };
        // Nothing E1 names is missing anywhere.
        expect(has(machine, "SELECT 1 FROM workspace_statuses WHERE id = ?", row.status), `${machine.label}: E1's status ${row.status}`).toBe(true);
        expect(has(machine, "SELECT 1 FROM workspace_kinds WHERE id = ?", row.kind), `${machine.label}: E1's kind ${row.kind}`).toBe(true);
        if (row.project_id !== null) expect(has(machine, "SELECT 1 FROM projects WHERE id = ?", row.project_id), `${machine.label}: E1's project`).toBe(true);
        // And the edit landed.
        if (what === "status") expect(row.status, machine.label).toBe("qa");
        if (what === "kind") expect(row.kind, machine.label).toBe("spike2");
        if (what === "project") expect(row.project_id, machine.label).toBe(project.id);
        if (what === "relation") expect(has(machine, "SELECT 1 FROM relations WHERE blocked_id = ? AND blocker_id = ?", e1.id, n1.id), machine.label).toBe(true);
        if (what === "queue") expect(has(machine, "SELECT 1 FROM queue_entries WHERE issue_id = ?", n1.id), machine.label).toBe(true);
        if (what === "milestone") expect(has(machine, "SELECT 1 FROM milestone_members WHERE milestone_id = ? AND issue_id = ?", m, n1.id), machine.label).toBe(true);
        if (["relation", "queue", "milestone"].includes(what)) expect(has(machine, "SELECT 1 FROM issues WHERE id = ?", n1.id), `${machine.label}: N1`).toBe(true);
        expect(countQuarantined(machine.db), machine.label).toBe(0);
        expect(countOpenConflicts(machine.db), machine.label).toBe(0);
      }
    }, 60_000);
  }
});
