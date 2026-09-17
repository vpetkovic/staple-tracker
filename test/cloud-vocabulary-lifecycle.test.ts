/**
 * Settings, statuses and kinds that are removed, brought back, removed while somebody else
 * edits them, or placed somewhere in the order: every device ends the same, whichever half
 * of a bootstrap it read.
 *
 * Three findings meet here:
 *
 *   - **A delete then a re-create of one key was lost.** Statuses, kinds and settings are
 *     keyed by name, so bringing one back reuses its key, and the service's fold treated a
 *     tombstone as final: every device that hydrated from the snapshot kept it deleted,
 *     while every device reading the ordered tail applied the second create.
 *   - **Deleting a built-in status or kind did not propagate.** The applier skipped it, so
 *     it stayed on every device but the one where it was removed.
 *   - **A status or kind added `--after` another** landed at the end on every other device.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000107";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function statuses(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT id, label, category FROM workspace_statuses ORDER BY sort_order, id").all();
}

function kinds(db: DatabaseSync): unknown[] {
  return db.prepare("SELECT id, label FROM workspace_kinds ORDER BY sort_order, id").all();
}

function setting(machine: Machine, key: string): unknown {
  return machine.store.getSetting(key);
}

/** A device on the ordered tail (connected from the start) and one that will hydrate. */
async function devices(): Promise<{ a: Machine; tail: Machine; fresh: () => Promise<Machine> }> {
  fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
  const a = fleet.machine("a");
  await a.sync();
  const tail = fleet.machine("tail");
  await tail.sync();
  return {
    a,
    tail,
    fresh: async () => {
      const machine = fleet!.machine("fresh");
      await machine.sync();
      return machine;
    },
  };
}

describe("a key deleted and then created again", () => {
  it("a setting reset and set again is set on every device, in two mutations or in one", async () => {
    const { a, tail, fresh } = await devices();
    a.store.setSetting("queue.policy", "strict");
    await a.sync();
    a.store.resetSetting("queue.policy");
    await a.sync();
    a.store.setSetting("queue.policy", "strict");
    // And in one mutation: a reset and a set in one batch is the setting, set.
    a.store.setSetting("kinds.default", "bug");
    await a.sync();
    a.store.applySettingOps([
      { op: "reset", key: "kinds.default" },
      { op: "set", key: "kinds.default", value: "bug" },
    ]);
    await a.sync();
    // And reset then set with no sync in between: nothing has come back yet to say the
    // setting was deleted, so it is this device's own record of its reset that makes the
    // set a create.
    a.store.setSetting("kinds.appearance", { bug: { source: "none", value: "", label: "Bug", fallback: "B" } });
    await a.sync();
    a.store.resetSetting("kinds.appearance");
    a.store.setSetting("kinds.appearance", { bug: { source: "none", value: "", label: "Bug", fallback: "X" } });
    await a.sync();
    await tail.sync();
    const late = await fresh();

    for (const machine of [a, tail, late]) {
      expect(setting(machine, "queue.policy"), machine.label).toBe("strict");
      expect(setting(machine, "kinds.default"), machine.label).toBe("bug");
      expect(setting(machine, "kinds.appearance"), machine.label).toEqual({ bug: expect.objectContaining({ fallback: "X" }) });
    }
  });

  it("a status removed and added back exists, with its new label, on every device", async () => {
    const { a, tail, fresh } = await devices();
    a.store.addStatus({ id: "qa", category: "review", label: "QA" });
    await a.sync();
    a.store.removeStatus("qa");
    await a.sync();
    a.store.addStatus({ id: "qa", category: "review", label: "Quality check" });
    // And removed and added back in ONE batch, which used to merge into a delete.
    a.store.addKind({ id: "research" });
    await a.sync();
    a.store.applyKindOps([
      { op: "remove", id: "research" },
      { op: "add", id: "research", label: "Research again" },
    ]);
    await a.sync();
    await tail.sync();
    const late = await fresh();

    for (const machine of [tail, late]) {
      expect(statuses(machine.db), machine.label).toEqual(statuses(a.db));
      expect(kinds(machine.db), machine.label).toEqual(kinds(a.db));
    }
    expect(statuses(a.db)).toContainEqual({ id: "qa", label: "Quality check", category: "review" });
    expect(kinds(a.db)).toContainEqual({ id: "research", label: "Research again" });
  });
});

describe("a deletion somebody else is still editing", () => {
  it("stays deleted on every device, the deleting one included, whichever syncs first", async () => {
    const { a, tail, fresh } = await devices();
    a.store.addStatus({ id: "qa", category: "review", label: "QA" });
    a.store.setSetting("queue.policy", "strict");
    await a.sync();
    await tail.sync();

    // Offline on both: A removes the status and resets the setting; the other device
    // renames the status and sets the setting, not having seen either.
    a.store.removeStatus("qa");
    a.store.resetSetting("queue.policy");
    tail.store.renameStatus("qa", "Quality");
    tail.store.setSetting("queue.policy", "advisory");
    await a.sync();
    await tail.sync();
    await a.sync();
    const late = await fresh();

    for (const machine of [a, tail, late]) {
      expect((statuses(machine.db) as Array<{ id: string }>).map((row) => row.id), machine.label).not.toContain("qa");
      // Reset: the default, and no stored value on any device.
      expect(machine.db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'setting:queue.policy'").get(), machine.label).toEqual({
        n: 0,
      });
    }
  });
});

describe("a built-in removed", () => {
  it("is removed on every device, and the issues it held move with it", async () => {
    const { a, tail, fresh } = await devices();
    const waiting = a.store.createIssue({ title: "Was in review" });
    a.store.updateIssue(waiting.id, { status: "in_review" });
    a.store.removeKind("spike");
    await a.sync();
    await tail.sync();

    a.store.removeStatus("in_review", { migrateTo: "todo" });
    await a.sync();
    await tail.sync();
    const late = await fresh();

    for (const machine of [a, tail, late]) {
      const ids = (statuses(machine.db) as Array<{ id: string }>).map((row) => row.id);
      expect(ids, machine.label).not.toContain("in_review");
      expect((kinds(machine.db) as Array<{ id: string }>).map((row) => row.id), machine.label).not.toContain("spike");
      // The issue it held moved on every device, not only the one that removed the status.
      expect(machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(waiting.id), machine.label).toEqual({
        status: "todo",
      });
    }
  });
});

describe("a built-in removed before connecting", () => {
  it("is removed on every device when this workspace seeds an empty repository", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const prepared = fleet.prepare("a");
    const a = fleet.connect("a", prepared);
    // Removed while nothing journaled — the history the seed reads.
    a.db.prepare("DELETE FROM workspace_kinds WHERE id = 'spike'").run();
    a.store.removeStatus("awaiting_approval");
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    expect((statuses(fresh.db) as Array<{ id: string }>).map((row) => row.id)).not.toContain("awaiting_approval");
    expect((kinds(fresh.db) as Array<{ id: string }>).map((row) => row.id)).not.toContain("spike");
    expect(statuses(fresh.db)).toEqual(statuses(a.db));
  });

  it("comes back on a workspace joining a repository that has it, and the sync says so", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.store.createIssue({ title: "The repository's" });
    await a.sync();
    const c = fleet.connect("c", fleet.prepare("c"));
    c.store.removeStatus("awaiting_approval");
    const report = await c.sync();
    expect(statuses(c.db)).toEqual(statuses(a.db));
    // And the store on the same database sees it, not the vocabulary from before the seed.
    expect(c.store.getStatuses().map((status) => status.id)).toContain("awaiting_approval");
    expect(report.seed?.replaced).toContainEqual(
      expect.objectContaining({ label: "status awaiting_approval", field: "present", local: false, repository: true }),
    );
  });
});

describe("a repository an empty device joined first", () => {
  /**
   * The empty device's join sends one operation: the repository's prefix, declared
   * (`repository-prefix.ts`). That is not data. Counted as data, the next device — the one
   * with the real work — took the "the repository holds entries but no order" branch: its
   * own kind order moved to the end and its pre-connect removal of a built-in was undone,
   * on its own machine, and every device converged on that.
   */
  it("takes the next device's vocabulary whole: its order, and the built-ins it removed", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const laptop = fleet.machine("laptop");
    const joined = await laptop.sync();
    expect(joined.seed?.uploaded).toBe(0);

    const workstation = fleet.connect("workstation", fleet.prepare("workstation"));
    const first = workstation.store.createIssue({ title: "Real work" });
    workstation.store.createIssue({ title: "More real work", kind: "bug" });
    workstation.store.queue().enqueue(first.id, { note: "First, and why" }, "alice");
    workstation.store.addKind({ id: "milestone" });
    const ids = (kinds(workstation.db) as Array<{ id: string }>).map((row) => row.id);
    workstation.store.applyKindOps([{ op: "reorder", ids: ["milestone", ...ids.filter((id) => id !== "milestone")] }]);
    workstation.store.removeStatus("in_review");
    const kindOrder = kinds(workstation.db);
    const statusOrder = statuses(workstation.db);
    expect((kindOrder as Array<{ id: string }>)[0]!.id).toBe("milestone");

    const report = await workstation.sync();
    expect(report.seed?.replaced).toEqual([]);
    await laptop.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    for (const machine of [workstation, laptop, fresh]) {
      expect(kinds(machine.db), machine.label).toEqual(kindOrder);
      expect(statuses(machine.db), machine.label).toEqual(statusOrder);
    }
  });
});

describe("a status or kind added after another", () => {
  it("sits in the same place on every device", async () => {
    const { a, tail, fresh } = await devices();
    a.store.addStatus({ id: "qa", category: "review", label: "QA", after: "in_progress" });
    a.store.addKind({ id: "research", after: "epic" });
    // Added at the end: no order travels, and none is needed.
    a.store.addStatus({ id: "shipped", category: "done", label: "Shipped" });
    await a.sync();
    await tail.sync();
    const late = await fresh();

    for (const machine of [tail, late]) {
      expect(statuses(machine.db), machine.label).toEqual(statuses(a.db));
      expect(kinds(machine.db), machine.label).toEqual(kinds(a.db));
    }
    const ids = (statuses(a.db) as Array<{ id: string }>).map((row) => row.id);
    expect(ids.indexOf("qa")).toBe(ids.indexOf("in_progress") + 1);
  });
});
