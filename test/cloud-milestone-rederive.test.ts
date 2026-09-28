/**
 * The one-shot milestone repair on a synchronized workspace (`docs/milestones.md`).
 *
 * The repair re-derives every milestone from the members this device holds. On a device that
 * reached the head of the log long ago and has not pulled since, those members are stale: run
 * at its first write, the repair derived from them and pushed a status every other device
 * already knew to be old — a regression on a fresh device, and a conflict on the device that
 * wrote the real move. So a synchronized workspace runs the repair after a pull has reached
 * the head, in the sync that pulled it, and never at a write.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d3e1";
const STAMP = "milestone_status_rederived";

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

/** The database as the build before the repair left it: no stamp. */
const upgrade = (machine: Machine): void => void machine.db.prepare("DELETE FROM meta WHERE key = ?").run(STAMP);
const status = (machine: Machine, id: string): string =>
  (machine.db.prepare("SELECT status FROM issues WHERE id = ?").get(id) as { status: string }).status;
const statusChanges = (machine: Machine, id: string): number =>
  (machine.db.prepare("SELECT COUNT(*) AS n FROM events WHERE issue_id = ? AND kind = 'status_changed'").get(id) as { n: number }).n;

/** A milestone M holding T, T in progress, M left at `backlog` as an older build left it. */
async function staleFleet(): Promise<{ a: Machine; b: Machine; m: string; t: string }> {
  fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
  const a = fleet.machine("a");
  await a.sync();
  a.use();
  a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
  const t = a.store.createIssue({ title: "T" }).id;
  const view = a.store.milestones().create({ title: "M" }, "a") as { milestone: { identifier: string } };
  const m = a.store.getIssue(view.milestone.identifier).id;
  a.store.milestones().addMember(m, t, {}, "a");
  a.store.updateIssue(t, { assignee: "a" }, "a");
  a.store.updateIssue(t, { status: "in_progress" }, "a");
  a.store.updateIssue(m, { status: "backlog" }, "a");
  await a.sync();
  // b joins on the build before the repair: nothing re-derives M on its way in.
  const b = fleet.machine("b");
  b.db.prepare("INSERT INTO meta (key, value) VALUES (?, '1') ON CONFLICT(key) DO NOTHING").run(STAMP);
  await sync(b);
  expect([status(a, m), status(b, m)]).toEqual(["backlog", "backlog"]);
  return { a, b, m, t };
}

describe("the milestone repair on a synchronized workspace", () => {
  it("does not push a regression from a device whose last pull is old", async () => {
    const { a, b, m, t } = await staleFleet();
    upgrade(a);
    a.use();
    a.store.updateIssue(t, { status: "done" }, "a");
    expect(status(a, m)).toBe("done");
    await sync(a);

    // b reached the head before a's move, and is upgraded without pulling.
    upgrade(b);
    b.use();
    b.store.addComment(t, "written before b pulls", "b");
    await sync(b, a, b);
    const fresh = fleet!.machine("fresh");
    await sync(fresh);

    expect([status(a, m), status(b, m), status(fresh, m)]).toEqual(["done", "done", "done"]);
    expect(listConflicts(a.db)).toEqual([]);
    expect(listConflicts(b.db)).toEqual([]);
    const want = stateOf(fresh.db);
    expect([...differences("a", want, stateOf(a.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
  });

  it("repairs in the sync that reached the head, and a second device finds nothing left to move", async () => {
    const { a, b, m } = await staleFleet();
    const before = [statusChanges(a, m), statusChanges(b, m)];
    upgrade(a);
    upgrade(b);
    // A write repairs nothing on a synchronized workspace.
    a.use();
    a.store.addComment(m, "a write", "a");
    expect(status(a, m)).toBe("backlog");
    await sync(a);
    expect(status(a, m)).toBe("in_progress");
    expect(a.db.prepare("SELECT value FROM meta WHERE key = ?").get(STAMP)).toBeDefined();

    // b pulls a's repair before its own runs: one move on every timeline, not two.
    await sync(b, a);
    expect(status(b, m)).toBe("in_progress");
    expect([statusChanges(a, m) - before[0]!, statusChanges(b, m) - before[1]!]).toEqual([1, 1]);
  });
});
