/**
 * Timing across devices (`docs/timing-semantics.md`, "Multi-device"): `workSeconds` and
 * `orchestrationSeconds` read the same on every device, a freshly hydrated one included, and
 * do not move when a stored end arrives; status-moving and edge events are re-emitted on apply,
 * dated at the origin, so `wall` is the same on a device that read the tail.
 *
 * Every device is real: its own home, its own clone, the real sync engine, journal and applier,
 * against the fake service that folds the log as the Worker does; a fresh device hydrates from
 * that fold. The write clock is faked (`Date` only) so every instant is chosen by the case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listConflicts } from "../src/core/cloud/conflicts.js";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import { beforeApply, reemitEvents } from "../src/core/cloud/reemit.js";
import { journalFor } from "../src/core/journal.js";
import { attemptsOfIssue } from "../src/core/telemetry/attempt-records.js";
import { viewsOfIssue } from "../src/core/telemetry/attempt-derive.js";
import type { IssueTiming } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000713e0";
const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const at = (minutes: number): void => void vi.setSystemTime(T0 + minutes * 60_000);
const min = (n: number): number => n * 60;

let fleet: Fleet | null = null;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
});
afterEach(() => {
  vi.useRealTimers();
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}
const timingOn = (machine: Machine, id: string, asOf: number): IssueTiming => machine.store.timingFor([id], iso(asOf)).get(id)!;
/** The effort fields every device must agree on. */
const effort = (t: IssueTiming) => ({
  workSeconds: t.workSeconds,
  ownWorkSeconds: t.ownWorkSeconds,
  orchestrationSeconds: t.orchestrationSeconds,
  quality: t.quality.work,
  missing: { workSeconds: t.missing.workSeconds, orchestrationSeconds: t.missing.orchestrationSeconds },
});
const statusEvents = (machine: Machine, id: string) =>
  machine.db
    .prepare(
      `SELECT kind, actor, created_at FROM events WHERE issue_id = ?
        AND kind IN ('issue_created', 'status_changed', 'checkout', 'claim_stolen', 'release', 'claim_released_stale', 'blockers_changed')
        ORDER BY created_at, seq`,
    )
    .all(id);
const issueOpsQueued = (machine: Machine): number =>
  (machine.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE entity IN ('issue', 'relation') AND acknowledged_seq IS NULL").get() as { n: number }).n;

function converged(writer: Machine, ...others: Machine[]): void {
  const want = stateOf(writer.db);
  expect(others.flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
}

describe("events are re-emitted on apply, dated at the origin", () => {
  it("a device that read the tail replays the writer's history: the same timing and the same wall; a hydrated one the same work", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    at(0);
    a.use();
    const x = a.store.createIssue({ title: "Worked on A", estimatedSeconds: 3600 });
    a.store.checkoutIssue(x.id, "agent-a");
    at(10);
    a.store.addComment(x.id, "progress", "agent-a");
    at(20);
    a.store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "checkpoint_before_reset" });
    at(30);
    a.store.recordAttemptEvent(x.id, "resume", "agent-a");
    at(40);
    a.store.addComment(x.id, "more", "agent-a");
    at(50);
    await sync(a);
    at(55);
    await sync(b);

    // B wrote the writer's events, at the writer's instants, and journaled nothing for them.
    expect(statusEvents(b, x.id)).toEqual(statusEvents(a, x.id));
    expect(statusEvents(b, x.id)).toEqual([
      { kind: "issue_created", actor: null, created_at: iso(0) },
      { kind: "checkout", actor: "agent-a", created_at: iso(0) },
    ]);
    const deviceOfCheckout = JSON.parse((b.db.prepare("SELECT payload FROM events WHERE issue_id = ? AND kind = 'checkout'").get(x.id) as { payload: string }).payload);
    expect(deviceOfCheckout.deviceId).toBe("device-a");
    expect(issueOpsQueued(b)).toBe(0);

    const onA = timingOn(a, x.id, 60);
    const onB = timingOn(b, x.id, 60);
    expect(onA.approximate).toBe(false);
    expect(onB).toEqual(onA);
    expect(onA.workSeconds).toBe(min(30));
    expect(onA.wall!.buckets).toMatchObject({ work: min(30), paused: min(10), silent: min(20) });

    // A device that hydrated from the fold has no history to replay: work reads the same, wall says why it cannot.
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const onFresh = timingOn(fresh, x.id, 60);
    expect(effort(onFresh)).toEqual(effort(onA));
    expect(onFresh).toMatchObject({ approximate: true, wall: null, missing: { wall: "replay_unavailable" } });

    // The work finishes on A. Every device agrees on the work; B on the wall too.
    at(70);
    a.use();
    a.store.updateIssue(x.id, { status: "done" }, "agent-a");
    at(75);
    await sync(a, b, fresh);
    const doneA = timingOn(a, x.id, 80);
    expect(timingOn(b, x.id, 80)).toEqual(doneA);
    expect(effort(timingOn(fresh, x.id, 80))).toEqual(effort(doneA));
    expect(doneA).toMatchObject({ workSeconds: min(60), estimateRatio: 1, wall: { endAt: iso(70), buckets: { work: min(60), paused: min(10) } } });

    // Delivered again, nothing is written twice.
    const count = (b.db.prepare("SELECT COUNT(*) AS n FROM events WHERE issue_id = ?").get(x.id) as { n: number }).n;
    await sync(b);
    expect((b.db.prepare("SELECT COUNT(*) AS n FROM events WHERE issue_id = ?").get(x.id) as { n: number }).n).toBe(count);
    converged(a, b, fresh);
  }, 60_000);

  it("a blocker set and a child that blocks its parent reach every device, with their events at the origin's instants", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Dependent" });
    const y = a.store.createIssue({ title: "Dependency" });
    const parent = a.store.createIssue({ title: "Parent" });
    at(5);
    a.store.setBlockedBy(x.id, [y.id], "vp");
    at(6);
    const child = a.store.createIssue({ title: "Child", parent: parent.id, blockParentUntilDone: true });
    at(10);
    await sync(a, b);
    const edges = (machine: Machine) => machine.db.prepare("SELECT blocker_id, blocked_id, created_at FROM relations ORDER BY blocker_id").all();
    // The child-to-parent edge used to stay on the device that made it.
    expect(edges(b)).toEqual(edges(a));
    expect(edges(b)).toContainEqual({ blocker_id: child.id, blocked_id: parent.id, created_at: iso(6) });
    for (const machine of [a, b]) {
      expect(statusEvents(machine, x.id).filter((event) => (event as { kind: string }).kind === "blockers_changed"), machine.label).toEqual([
        { kind: "blockers_changed", actor: "vp", created_at: iso(5) },
      ]);
      expect(statusEvents(machine, parent.id).filter((event) => (event as { kind: string }).kind === "blockers_changed"), machine.label).toEqual([
        { kind: "blockers_changed", actor: null, created_at: iso(6) },
      ]);
    }
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    converged(a, b, fresh);
  }, 60_000);

  it("a pulled delete that takes a blocker's edges narrates the dependents' new sets, dated at the delete", () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.use();
    const x = a.store.createIssue({ title: "Dependent" });
    const y = a.store.createIssue({ title: "Deleted elsewhere" });
    const z = a.store.createIssue({ title: "Kept" });
    a.store.setBlockedBy(x.id, [y.id, z.id], "vp");
    const op = {
      opId: "op-delete-y",
      seq: 99,
      epoch: 1,
      protocol: 3,
      schema: 14,
      entity: "issue",
      entityId: y.id,
      verb: "delete",
      baseVersion: 1,
      payload: {},
      deviceId: "device-elsewhere",
      actor: "vp",
      clientSeq: 1,
      createdAt: iso(30),
      serverTs: 0,
    };
    journalFor(a.db).applyRemote({ opId: op.opId, seq: op.seq }, () => {
      const before = beforeApply(a.db, op);
      applyToDatabase(a.db, { entity: op.entity, entityId: op.entityId, verb: op.verb, payload: op.payload, actor: op.actor, deviceId: op.deviceId, at: op.createdAt, opId: op.opId, seq: op.seq });
      reemitEvents(a.db, op, before, a.deviceId);
    });
    const last = a.db.prepare("SELECT payload, created_at FROM events WHERE issue_id = ? AND kind = 'blockers_changed' ORDER BY seq DESC LIMIT 1").get(x.id) as {
      payload: string;
      created_at: string;
    };
    expect(last.created_at).toBe(iso(30));
    expect(JSON.parse(last.payload)).toMatchObject({ blockedByIds: [z.id], removedBlockerIds: [y.id] });
  });
});

describe("workSeconds converges, and does not move when an end arrives", () => {
  it("a remote steal plus a late comment: the stored end is the steal's, the evidence the attempt's, and the successor limits it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Contended" });
    a.store.checkoutIssue(x.id, "agent-a");
    at(10);
    a.store.addComment(x.id, "early", "agent-a");
    await sync(a, b);
    // A writes more, and syncs it; B has not pulled it when it steals.
    at(25);
    a.use();
    a.store.addComment(x.id, "still here", "agent-a");
    await sync(a);
    at(30);
    b.use();
    b.store.checkoutIssue(x.id, "agent-b", undefined, { stealIfIdleSeconds: 60 });
    // The steal is dated at B's own last evidence of agent-a: 10.
    expect(attemptsOfIssue(b.db, x.id)[0]).toMatchObject({ endReason: "claim_stolen", endDetection: "inferred", endedAt: iso(10) });
    // A has not learned of the steal: its read counts agent-a to its last evidence.
    const beforeEnd = timingOn(a, x.id, 40).ownWorkSeconds;
    at(35);
    a.use();
    a.store.addComment(x.id, "after the steal", "agent-a");
    at(36);
    await sync(b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    // agent-a: to its evidence before the steal (25), not the stored 10, and not the comment at 35.
    const first = (machine: Machine) => viewsOfIssue(machine.db, x.id)[0]!;
    expect(first(a)).toMatchObject({ agent: "agent-a", endReason: "claim_stolen", endedAt: iso(10) });
    const onA = timingOn(a, x.id, 40);
    for (const machine of [b, fresh]) expect(effort(timingOn(machine, x.id, 40)), machine.label).toEqual(effort(onA));
    // agent-a 25 minutes, agent-b 0 so far (no evidence after its start).
    expect(onA.ownWorkSeconds).toBe(min(25));
    expect(beforeEnd).toBe(min(25));
    converged(a, b, fresh);
  }, 60_000);

  it("a derived orphan end on a device that read the tail reads the same before and after the opener writes it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    a.store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const x = a.store.createIssue({ title: "Recategorized elsewhere", estimatedSeconds: 3600 });
    a.store.checkoutIssue(x.id, "agent-a");
    a.store.updateIssue(x.id, { status: "doing" }, "agent-a");
    at(10);
    a.store.addComment(x.id, "work", "agent-a");
    await sync(a, b);
    // B moves the status out of active: agent-a's attempt is orphaned on every device that reads it.
    at(20);
    b.use();
    b.store.recategorizeStatus("doing", "review", "vp");
    at(25);
    a.use();
    a.store.addComment(x.id, "a late word, before A learns", "agent-a");
    await sync(a, b);
    const derived = effort(timingOn(b, x.id, 40));
    expect(viewsOfIssue(b.db, x.id)[0]).toMatchObject({ state: "ended", outcome: "orphaned", endReason: "left_active" });
    expect(derived.quality.inputs).toEqual(expect.arrayContaining(["orphan_provisional", "end_unbounded"]));
    expect(derived.ownWorkSeconds).toBe(min(25));

    // A pulls the recategorization and, on its next mutating command, writes the stored end.
    at(30);
    await sync(a);
    a.use();
    a.store.addComment(a.store.createIssue({ title: "Unrelated" }).id, "anything", "vp");
    expect(attemptsOfIssue(a.db, x.id)[0]).toMatchObject({ state: "ended", endReason: "left_active", endDetection: "inferred", endedAt: iso(25) });
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const stored = effort(timingOn(b, x.id, 40));
    expect(stored.ownWorkSeconds).toBe(derived.ownWorkSeconds);
    expect(stored.quality.inputs).not.toContain("orphan_provisional");
    for (const machine of [a, fresh]) expect(effort(timingOn(machine, x.id, 40)), machine.label).toEqual(stored);
    converged(a, b, fresh);
  }, 60_000);
});

describe("the orchestrator lane across devices", () => {
  it("an issue resolved on another device ends the orchestrator attempt on every device, and the stored end changes nothing", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const leaf = a.store.createIssue({ title: "Under review" });
    a.store.openOrchestratorAttempt(leaf.id, "reviewer", "orchestrator");
    at(10);
    a.store.addComment(leaf.id, "reviewed", "reviewer");
    await sync(a, b);
    at(20);
    b.use();
    b.store.updateIssue(leaf.id, { status: "done" }, "vp");
    at(25);
    await sync(b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    // Read from replicated rows alone, before the opener has written anything.
    for (const machine of [b, fresh]) {
      expect(viewsOfIssue(machine.db, leaf.id)[0], machine.label).toMatchObject({ role: "orchestrator", state: "ended", outcome: "orphaned", endReason: "issue_resolved" });
      expect(timingOn(machine, leaf.id, 30).orchestrationSeconds, machine.label).toBe(min(10));
    }
    // The opener pulls, writes the stored end once its pull reached the head, and every device
    // reads the same number.
    await sync(a, b, fresh);
    for (const machine of [a, b, fresh]) {
      expect(attemptsOfIssue(machine.db, leaf.id)[0], machine.label).toMatchObject({ state: "ended", endReason: "issue_resolved", endDetection: "inferred", endedAt: iso(10) });
      expect(timingOn(machine, leaf.id, 30).orchestrationSeconds, machine.label).toBe(min(10));
    }
    converged(a, b, fresh);
  }, 60_000);

  for (const order of ["real end first", "stored orphan end first"] as const) {
    it(`a real coordination_ended wins over a stored superseded_by_newer on every device (${order})`, async () => {
      fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
      const a = fleet.machine("a");
      const b = fleet.machine("b");
      await sync(a, b);
      a.use();
      const one = a.store.createIssue({ title: "First" });
      const two = a.store.createIssue({ title: "Second" });
      a.store.openOrchestratorAttempt(one.id, "orch", "orchestrator");
      await sync(a, b);
      // Offline on A: the same identity opens a newer one, and A writes the older one's stored end.
      at(10);
      a.use();
      a.store.openOrchestratorAttempt(two.id, "orch", "orchestrator");
      at(12);
      a.store.addComment(two.id, "a mutating command", "vp");
      const older = attemptsOfIssue(a.db, one.id)[0]!;
      expect(older).toMatchObject({ state: "ended", endReason: "superseded_by_newer", endDetection: "inferred" });
      // Offline on B, knowing nothing newer: the same identity ends it for real.
      at(11);
      b.use();
      b.store.endOrchestratorAttempt(one.id, "orch", "orchestrator");
      if (order === "real end first") await sync(b, a, b);
      else await sync(a, b, a);
      const fresh = fleet.machine("fresh");
      await sync(fresh);
      for (const machine of [a, b, fresh]) {
        expect(attemptsOfIssue(machine.db, one.id)[0], machine.label).toMatchObject({ state: "ended", outcome: "yielded", endReason: "coordination_ended", endDetection: "reported" });
        expect(listConflicts(machine.db).filter((record) => record.entity === "attempt"), machine.label).toEqual([]);
      }
      converged(a, b, fresh);
    }, 60_000);
  }
});
