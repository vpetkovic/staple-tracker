/**
 * Criterion marks replicate (docs/sync.md, "What synchronizes"; docs/milestones.md "Goal"):
 * a mark is the milestone field `criterion<n>`, so it travels in the operations and the
 * snapshot the service already carries, with no new entity and no protocol change.
 *
 *   - A mark made on one device is the same mark, verdict and evidence, on a tail device and
 *     on a fresh one, and the goal check reads it there.
 *   - Two devices judging DIFFERENT criteria at once both land, with no conflict.
 *   - Two devices judging the SAME criterion at once are a preserved field conflict, and the
 *     decision converges every device (pinned with the other field conflicts in
 *     `sync-mutation-convergence.test.ts`).
 *   - A restore to a backup taken before a mark removes the mark everywhere.
 *   - Marks made before a workspace ever connected are seeded with the milestone.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkspace } from "../src/core/workspace.js";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-000000000329";
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function world(): Promise<{ a: Machine; b: Machine; milestone: string }> {
  fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
  const a = fleet.machine("a");
  a.use();
  a.store.addKind({ id: "milestone", label: "Milestone" });
  const created = a.store.milestones().create({ title: "October", acceptanceCriteria: ["Docs written", "Tests pass"] }, "alice");
  if (created.preview) throw new Error("unreachable");
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  return { a, b, milestone: created.milestone.id };
}

async function settle(a: Machine, b: Machine): Promise<void> {
  await a.sync();
  await b.sync();
  await a.sync();
}

describe("criterion marks replicate", () => {
  it("a mark made on one device is the same mark on a tail device and a fresh one", async () => {
    const { a, b, milestone } = await world();
    a.use();
    a.store.milestones().markCriterion(milestone, 1, { verdict: "met", evidence: ["the README section"], note: "read it" }, "alice");
    await settle(a, b);
    const fresh = fleet!.machine("fresh");
    await fresh.sync();
    for (const device of [b, fresh]) {
      device.use();
      expect(device.store.milestones().get(milestone).goal.criteria[0]).toMatchObject({ verdict: "met", markedBy: "alice", note: "read it", evidence: [expect.objectContaining({ value: "the README section" })] });
    }
    const writer = stateOf(a.db);
    expect([...differences("tail", writer, stateOf(b.db)), ...differences("fresh", writer, stateOf(fresh.db))]).toEqual([]);
  });

  it("two devices judging different criteria at once both land, with no conflict", async () => {
    const { a, b, milestone } = await world();
    await tick();
    a.use();
    a.store.milestones().markCriterion(milestone, 1, { verdict: "met", evidence: ["docs"] }, "alice");
    await tick();
    b.use();
    b.store.milestones().markCriterion(milestone, 2, { verdict: "unmet", evidence: ["no tests"] }, "bob");
    await settle(a, b);
    expect(listConflicts(a.db).filter((conflict) => conflict.entity === "milestone")).toEqual([]);
    for (const device of [a, b]) {
      device.use();
      expect(device.store.milestones().get(milestone).goal.criteria.map((criterion) => criterion.verdict)).toEqual(["met", "unmet"]);
    }
    expect(differences("tail", stateOf(a.db), stateOf(b.db))).toEqual([]);
  });

  it("two devices judging the same criterion at once keep a conflict instead of a silent winner", async () => {
    const { a, b, milestone } = await world();
    await tick();
    a.use();
    a.store.milestones().markCriterion(milestone, 1, { verdict: "met", evidence: ["a saw it"] }, "alice");
    await tick();
    b.use();
    b.store.milestones().markCriterion(milestone, 1, { verdict: "unmet", evidence: ["b did not"] }, "bob");
    await settle(a, b);
    const open = listConflicts(a.db).filter((conflict) => conflict.entity === "milestone" && conflict.resolvedAt === null);
    expect(open.map((conflict) => conflict.field)).toEqual(["criterion1"]);
    // Neither side was overwritten: each device keeps its own verdict until somebody decides.
    a.use();
    expect(a.store.milestones().get(milestone).goal.criteria[0]!.marked).toBe("met");
  });

  it("a restore to a backup taken before a mark removes the mark on every device", async () => {
    const { a, b, milestone } = await world();
    a.use();
    // Dated and judged before the backup, so the epoch holds the milestone and one mark: the
    // restore has to drop the later mark from an entity it keeps, not only remove the entity.
    a.store.milestones().update(milestone, { targetDate: "2026-11-01" }, "alice");
    a.store.milestones().markCriterion(milestone, 1, { verdict: "met", evidence: ["docs"] }, "alice");
    await settle(a, b);
    await setBackupConsent(a.home, REPO, true, { fetchImpl: fleet!.server.fetch });
    const backupId = (await createBackup(a.home, REPO, null, { fetchImpl: fleet!.server.fetch })).backupId;
    await tick();
    a.store.milestones().markCriterion(milestone, 2, { verdict: "met", evidence: ["tests"] }, "alice");
    await settle(a, b);
    b.use();
    expect(b.store.milestones().get(milestone).goal.counts.met).toBe(2);
    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backupId, { fetchImpl: fleet!.server.fetch });
    for (const machine of [a, b, a, b]) {
      machine.use();
      await machine.sync();
    }
    for (const device of [a, b]) {
      device.use();
      expect(device.store.milestones().get(milestone).goal.criteria.map((criterion) => criterion.verdict)).toEqual(["met", "unknown"]);
    }
    const fresh = fleet!.machine("fresh");
    await fresh.sync();
    expect([...differences("a", stateOf(fresh.db), stateOf(a.db)), ...differences("b", stateOf(fresh.db), stateOf(b.db))]).toEqual([]);
  });

  it("marks made before the workspace connected are seeded with the milestone", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const prepared = fleet.prepare("a");
    process.env.STAPLE_HOME = prepared.home;
    const before = openWorkspace(join(prepared.dir, ".staple", "staple.db"));
    before.store.addKind({ id: "milestone", label: "Milestone" }, "vp");
    const created = before.store.milestones().create({ title: "Offline", acceptanceCriteria: ["Judged offline"] }, "alice");
    if (created.preview) throw new Error("unreachable");
    before.store.milestones().markCriterion(created.milestone.id, 1, { verdict: "met", evidence: ["seen"] }, "alice");
    before.store.db.close();
    const a = fleet.connect("a", prepared);
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    b.use();
    expect(b.store.milestones().get(created.milestone.id).goal.criteria[0]).toMatchObject({ verdict: "met", markedBy: "alice" });
    expect(differences("b", stateOf(a.db), stateOf(b.db))).toEqual([]);
  });

  it("a mark or a new member on an undated milestone says nothing about its dates, so a concurrent date edit stands", async () => {
    const { a, b, milestone } = await world();
    const member = a.store.createIssue({ title: "Member" }).id;
    await settle(a, b);
    await tick();
    b.use();
    b.store.milestones().update(milestone, { targetDate: "2026-12-01" }, "bob");
    await tick();
    a.use();
    a.store.milestones().markCriterion(milestone, 1, { verdict: "met", evidence: ["docs"] }, "alice");
    a.store.milestones().addMember(milestone, member, {}, "alice");
    await settle(a, b);
    expect(listConflicts(a.db).filter((conflict) => conflict.entity === "milestone")).toEqual([]);
    expect(listConflicts(b.db).filter((conflict) => conflict.entity === "milestone")).toEqual([]);
    for (const device of [a, b]) {
      device.use();
      expect(device.store.milestones().get(milestone).milestone.targetDate).toBe("2026-12-01");
    }
    expect(differences("tail", stateOf(a.db), stateOf(b.db))).toEqual([]);
  });

  it("a goal run on another device recognises the first device's run gate by what replicated with it", async () => {
    const { a, b, milestone } = await world();
    const member = a.store.createIssue({ title: "Member" }).id;
    a.store.milestones().addMember(milestone, member, {}, "alice");
    a.store.runs().start({ actor: "bot-a", scope: milestone });
    await settle(a, b);
    b.use();
    expect(b.store.gate(milestone)).toMatchObject({ state: "pending", requestedBy: "goal-run:bot-a" });
    const run = b.store.runs().start({ actor: "bot-b", scope: milestone });
    expect(b.store.runs().continue({ actor: "bot-b", run: run.id })).toMatchObject({ action: "take", goal: { gate: { byGoalRun: true, ownedByRun: false } } });
  });
});
