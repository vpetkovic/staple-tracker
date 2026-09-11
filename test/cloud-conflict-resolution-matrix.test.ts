/**
 * Every conflictable field, resolved either way, converges on every device.
 *
 * Two resolutions did not: a setting resolved "local" wrote its stored envelope back as the
 * value, so every device held `{"v":1,"value":"{\"v\":1,\"value\":\"strict\"}"}`; and a
 * milestone's target date resolved on A was written under the column's spelling, which the
 * milestone applier does not read, so A kept one date and B the other. Each kind here: A and
 * B edit it concurrently, both see the conflict, A resolves it as `local` or `remote`, and
 * A, B and a device that hydrates afterwards must hold the chosen value.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict, type ResolutionChoice } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000174";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

interface Kind {
  readonly name: string;
  /** The conflict record's entity and field. */
  readonly entity: string;
  readonly field: string;
  readonly setup: (a: Machine) => Record<string, string>;
  readonly edit: (machine: Machine, ids: Record<string, string>, which: "a" | "b") => void;
  readonly read: (db: DatabaseSync, ids: Record<string, string>) => unknown;
}

const ids = (db: DatabaseSync, sql: string, ...params: string[]): string[] =>
  (db.prepare(sql).all(...params) as Array<{ id: string }>).map((row) => row.id);

const KINDS: readonly Kind[] = [
  {
    name: "issue title",
    entity: "issue",
    field: "title",
    setup: (a) => ({ issue: a.store.createIssue({ title: "Before" }).id }),
    edit: (m, x, which) => void m.store.updateIssue(x.issue!, { title: `Title from ${which}` }),
    read: (db, x) => db.prepare("SELECT title FROM issues WHERE id = ?").get(x.issue!),
  },
  {
    name: "the plan",
    entity: "queue",
    field: "order",
    setup: (a) => {
      const one = a.store.createIssue({ title: "One" }).id;
      const two = a.store.createIssue({ title: "Two" }).id;
      a.store.queue().enqueue(one, { note: "first" }, "alice");
      a.store.queue().enqueue(two, { note: "second" }, "alice");
      return { one, two };
    },
    edit: (m, x, which) => {
      const third = m.store.createIssue({ title: `Queued on ${which}` }).id;
      m.store.queue().enqueue(third, { note: `from ${which}` }, which);
    },
    read: (db) => db.prepare("SELECT i.title, q.note, q.added_by FROM queue_entries q JOIN issues i ON i.id = q.issue_id ORDER BY q.rank").all(),
  },
  {
    name: "milestone members",
    entity: "milestone",
    field: "members",
    setup: (a) => {
      a.store.addKind({ id: "milestone", label: "Milestone" });
      const view = a.store.milestones().create({ title: "M1" }, "alice") as { milestone: { identifier: string } };
      const milestone = a.store.getIssue(view.milestone.identifier).id;
      const one = a.store.createIssue({ title: "Member one" }).id;
      a.store.milestones().addMember(milestone, one, {}, "alice");
      return { milestone };
    },
    edit: (m, x, which) => {
      const member = m.store.createIssue({ title: `Member from ${which}` }).id;
      m.store.milestones().addMember(x.milestone!, member, {}, which);
    },
    read: (db, x) =>
      ids(db, "SELECT i.title AS id FROM milestone_members mm JOIN issues i ON i.id = mm.issue_id WHERE mm.milestone_id = ? ORDER BY mm.rank", x.milestone!),
  },
  {
    name: "milestone target date",
    entity: "milestone",
    field: "target_date",
    setup: (a) => {
      a.store.addKind({ id: "milestone", label: "Milestone" });
      const view = a.store.milestones().create({ title: "M2", targetDate: "2026-11-01" }, "alice") as { milestone: { identifier: string } };
      return { milestone: a.store.getIssue(view.milestone.identifier).id };
    },
    edit: (m, x, which) => void m.store.milestones().update(x.milestone!, { targetDate: which === "a" ? "2026-10-01" : "2026-12-01" }, which),
    read: (db, x) => db.prepare("SELECT target_date FROM milestone_meta WHERE issue_id = ?").get(x.milestone!),
  },
  {
    name: "status label",
    entity: "status",
    field: "label",
    setup: (a) => (a.store.addStatus({ id: "qa", category: "review", label: "QA" }), {}),
    edit: (m, _x, which) => void m.store.renameStatus("qa", `QA by ${which}`),
    read: (db) => db.prepare("SELECT label FROM workspace_statuses WHERE id = 'qa'").get(),
  },
  {
    name: "status order",
    entity: "status",
    field: "order",
    setup: () => ({}),
    edit: (m, _x, which) => {
      const order = ids(m.db, "SELECT id FROM workspace_statuses ORDER BY sort_order, id");
      m.store.reorderStatuses(which === "a" ? [...order].reverse() : [...order.slice(1), order[0]!]);
    },
    read: (db) => ids(db, "SELECT id FROM workspace_statuses ORDER BY sort_order, id"),
  },
  {
    name: "kind label",
    entity: "kind",
    field: "label",
    setup: (a) => (a.store.addKind({ id: "research" }), {}),
    edit: (m, _x, which) => void m.store.renameKind("research", `Research by ${which}`),
    read: (db) => db.prepare("SELECT label FROM workspace_kinds WHERE id = 'research'").get(),
  },
  {
    name: "setting",
    entity: "setting",
    field: "value",
    setup: () => ({}),
    edit: (m, _x, which) => void m.store.setSetting("queue.policy", which === "a" ? "strict" : "advisory"),
    read: (db) => db.prepare("SELECT value FROM meta WHERE key = 'setting:queue.policy'").get(),
  },
  {
    name: "project name",
    entity: "project",
    field: "name",
    setup: (a) => ({ project: a.store.projects().create({ name: "Web" }, "alice").id }),
    edit: (m, x, which) => void m.store.projects().update(x.project!, { name: `Web by ${which}` }, which),
    read: (db, x) => db.prepare("SELECT name FROM projects WHERE id = ?").get(x.project!),
  },
];

describe("a conflict resolved on one device", () => {
  for (const kind of KINDS) {
    for (const choice of ["local", "remote"] as const satisfies readonly ResolutionChoice[]) {
      it(`converges everywhere: ${kind.name}, resolved ${choice}`, async () => {
        fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
        const a = fleet.machine("a");
        a.use();
        const x = kind.setup(a);
        await a.sync();
        const b = fleet.machine("b");
        await b.sync();

        a.use();
        kind.edit(a, x, "a");
        b.use();
        kind.edit(b, x, "b");
        await a.sync();
        await b.sync();
        await a.sync();
        const onA = kind.read(a.db, x);
        const onB = kind.read(b.db, x);
        const open = listConflicts(a.db).filter((c) => c.resolvedAt === null && c.entity === kind.entity && c.field === kind.field);
        expect(open.length, kind.name).toBeGreaterThan(0);

        a.use();
        for (const conflict of open) resolveConflict(a.db, { id: conflict.id, choice, actor: "alice" });
        const chosen = kind.read(a.db, x);
        expect(chosen).toEqual(choice === "local" ? onA : onB);
        await a.sync();
        await b.sync();
        await a.sync();
        const fresh = fleet.machine("fresh");
        await fresh.sync();
        for (const machine of [a, b, fresh]) expect(kind.read(machine.db, x), `${kind.name} on ${machine.label}`).toEqual(chosen);
        for (const machine of [a, b]) {
          expect(
            listConflicts(machine.db).filter((c) => c.resolvedAt === null && c.entity === kind.entity),
            `${kind.name} open on ${machine.label}`,
          ).toEqual([]);
        }
      });
    }
  }
});

describe("a setting two devices set to the same value", () => {
  it("is not a conflict: the record compares the value, not the envelope it is stored in", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    a.store.setSetting("queue.policy", "strict");
    b.store.setSetting("queue.policy", "strict");
    await a.sync();
    await b.sync();
    await a.sync();
    for (const machine of [a, b]) {
      expect(listConflicts(machine.db).filter((c) => c.entity === "setting"), machine.label).toEqual([]);
    }
  });
});
