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
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { openWorkspace } from "../src/core/open.js";
import { join } from "node:path";
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

  it("a status a conflict withheld narrates nothing: the replay still lands on the row this device kept", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    // Both connected before the issue exists, so B reads its whole history in the tail.
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Moved on both" });
    await sync(a, b);
    expect(timingOn(b, x.id, 5).approximate).toBe(false);
    at(10);
    b.use();
    b.store.updateIssue(x.id, { status: "blocked" }, "vp");
    at(20);
    a.use();
    a.store.updateIssue(x.id, { status: "in_review" }, "vp");
    await sync(b, a, b);
    // B keeps its own status (the field is contested), and A's later move is not in B's history.
    expect(b.store.getIssue(x.id).status).toBe("blocked");
    expect(listConflicts(b.db).some((record) => record.entity === "issue" && record.field === "status")).toBe(true);
    expect(timingOn(b, x.id, 30).approximate).toBe(false);
  }, 60_000);

  it("the same move made on two devices converges on the earlier instant, whichever order it arrives in", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Closed twice" });
    a.store.checkoutIssue(x.id, "agent-a");
    await sync(a, b);
    // Both close it offline: B first by the clock, A later. Equal values are not a conflict.
    at(10);
    b.use();
    b.store.updateIssue(x.id, { status: "done" }, "vp");
    at(20);
    a.use();
    a.store.updateIssue(x.id, { status: "done" }, "agent-a");
    await sync(a, b, a);
    // A applied B's earlier close after its own later one: the replay reads by time, so both end the span at 10.
    expect(timingOn(a, x.id, 30).wall).toMatchObject({ endAt: iso(10) });
    expect(timingOn(a, x.id, 30).wall).toEqual(timingOn(b, x.id, 30).wall);
  }, 60_000);

  it("where attempts overlap, work beats paused and paused beats silent", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Two offline checkouts" });
    await sync(a, b);
    // Offline on each: agent-a claims at 0, pauses at 5 and writes at 30; agent-b claims at 10 and writes at 20.
    a.use();
    a.store.checkoutIssue(x.id, "agent-a");
    at(5);
    a.store.recordAttemptEvent(x.id, "pause", "agent-a", { reason: "awaiting_input" });
    at(10);
    b.use();
    b.store.checkoutIssue(x.id, "agent-b");
    at(20);
    b.store.addComment(x.id, "b working", "agent-b");
    at(30);
    a.use();
    a.store.addComment(x.id, "a, still paused", "agent-a");
    await sync(a, b, a);
    // On A: agent-a's attempt is superseded (clause 5), ending at its last activity, 30; agent-b's is open.
    const views = viewsOfIssue(a.db, x.id, iso(40));
    expect(views.map((view) => [view.agent, view.state, view.contested])).toEqual([
      ["agent-a", "ended", true],
      ["agent-b", "running", true],
    ]);
    const t = timingOn(a, x.id, 40);
    // 0-5 work (a); 5-10 paused (a); 10-20 work (b) over a's pause; 20-30 a's pause over b's silence; 30-40 b's silence.
    expect(t.wall!.buckets).toMatchObject({ work: min(15), paused: min(15), silent: min(10) });
    expect(t.quality.work.inputs).toContain("contested");
  }, 60_000);
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

describe("round 1: what an operation narrates, and what it does not", () => {
  it("a seed narrates nothing: a device that read it replays nothing it cannot prove, and the fallback stands", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const b = fleet.machine("b");
    await sync(b);
    // A works before it ever connects: its history reaches the repository by the seed.
    const prepared = fleet.prepare("a");
    process.env.STAPLE_HOME = prepared.home;
    const offline = openWorkspace(join(prepared.dir, ".staple", "staple.db"));
    at(0);
    const x = offline.store.createIssue({ title: "Done before connecting" });
    offline.store.checkoutIssue(x.id, "agent-a");
    at(20);
    offline.store.updateIssue(x.id, { status: "done" }, "agent-a");
    const y = offline.store.createIssue({ title: "Started before connecting" });
    at(25);
    offline.store.checkoutIssue(y.id, "agent-a");
    // Never touched after its create: a pristine birth, which only an operation with no
    // `originEvents` at all would narrate — and the seed's say narrate nothing.
    const z = offline.store.createIssue({ title: "Untouched before connecting" });
    const onAx = offline.store.timingFor([x.id], iso(45)).get(x.id)!;
    const onAy = offline.store.timingFor([y.id], iso(45)).get(y.id)!;
    offline.store.db.close();
    at(30);
    const a = fleet.connect("a", prepared);
    await sync(a);
    at(45);
    await sync(b);
    // B holds no event for either: the seed said what exists, not what happened.
    expect(statusEvents(b, x.id)).toEqual([]);
    expect(statusEvents(b, y.id)).toEqual([]);
    expect(statusEvents(b, z.id)).toEqual([]);
    const bx = timingOn(b, x.id, 45);
    const by = timingOn(b, y.id, 45);
    // The two-timestamp fallback, flagged, as before re-emission: never a birth in the current status.
    expect(bx).toMatchObject({ approximate: true, activeSeconds: min(20), wall: null, missing: { wall: "replay_unavailable" } });
    expect(by).toMatchObject({ approximate: true, wall: null, missing: { wall: "replay_unavailable" } });
    // Effort does not read the log: it is the same as on the device that did the work.
    expect(effort(bx)).toEqual(effort(onAx));
    expect(effort(by).workSeconds).toBe(onAy.workSeconds);
  }, 60_000);

  it("a vocabulary migration narrates nothing on the device that made it, and nothing anywhere else", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    a.store.addStatus({ id: "parked", category: "ready", label: "Parked" }, "vp");
    const x = a.store.createIssue({ title: "Parked", status: "parked" });
    await sync(a, b);
    at(10);
    a.use();
    a.store.removeStatus("parked", { migrateTo: "todo" }, "vp");
    await sync(a, b);
    expect(b.store.getIssue(x.id).status).toBe("todo");
    expect(statusEvents(b, x.id)).toEqual(statusEvents(a, x.id));
    expect(statusEvents(a, x.id).map((event) => (event as { kind: string }).kind)).toEqual(["issue_created"]);
  }, 60_000);

  it("a restore is an edge-writing path: every device narrates the set it rewound to, at the restore's own instant", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Dependent" });
    const w = a.store.createIssue({ title: "Dependency" });
    a.store.checkoutIssue(x.id, "agent-a");
    at(5);
    a.store.releaseIssue(x.id, "agent-a");
    await sync(a, b);
    at(20);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
    at(30);
    a.store.setBlockedBy(x.id, [w.id], "vp");
    await sync(a, b);
    expect(b.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE blocked_id = ?").get(x.id)).toEqual({ n: 1 });
    at(40);
    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    at(45);
    await sync(a);
    at(50);
    await sync(b, a, b);
    for (const machine of [a, b]) {
      expect(machine.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE blocked_id = ?").get(x.id), machine.label).toEqual({ n: 0 });
      const t = timingOn(machine, x.id, 60);
      // Blocked from the edge (30) to the restore (40), then waiting in the queue again: the same on both.
      expect(t.wall!.buckets, machine.label).toMatchObject({ blocked: min(10), queued: min(25 + 20) });
      expect(t.quality.wall, machine.label).toEqual({ state: "exact", inputs: [] });
    }
    expect(timingOn(a, x.id, 60).wall).toEqual(timingOn(b, x.id, 60).wall);
    const rewound = (machine: Machine) =>
      machine.db.prepare("SELECT created_at, payload FROM events WHERE issue_id = ? AND kind = 'blockers_changed' ORDER BY seq DESC LIMIT 1").get(x.id) as {
        created_at: string;
        payload: string;
      };
    expect(rewound(a).created_at).toBe(iso(40));
    expect(rewound(b).created_at).toBe(iso(40));
    expect(JSON.parse(rewound(b).payload)).toMatchObject({ blockedByIds: [], rewoundToEpoch: 2 });
  }, 90_000);

  it("an edge the history names but the device no longer holds makes the partition approximate", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    a.use();
    const x = a.store.createIssue({ title: "Dependent" });
    const w = a.store.createIssue({ title: "Dependency" });
    a.store.checkoutIssue(x.id, "agent-a");
    at(5);
    a.store.releaseIssue(x.id, "agent-a");
    at(10);
    a.store.setBlockedBy(x.id, [w.id], "vp");
    // Gone with no event, as a cascade or an older build's rewind leaves it.
    a.db.prepare("DELETE FROM relations WHERE blocked_id = ?").run(x.id);
    expect(timingOn(a, x.id, 20).quality.wall).toEqual({ state: "approximate", inputs: ["edge_history_incomplete"] });
  });

  /**
   * A shared checkout; A moves it to review at 10 and B closes it at 11, offline; both sync.
   * Then the status record is resolved, one of three ways. Every device holds a canonical
   * `status_changed` for each decision, and reads the span from the first disagreeing write (10)
   * to the decision as the decision, approximate (`conflict_resolved`).
   */
  async function disputedStatus() {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Decided twice" });
    a.store.checkoutIssue(x.id, "agent-a");
    await sync(a, b);
    at(10);
    a.use();
    a.store.updateIssue(x.id, { status: "in_review" }, "agent-a");
    at(11);
    b.use();
    b.store.updateIssue(x.id, { status: "done" }, "vp");
    await sync(a, b, a);
    expect(a.store.getIssue(x.id).status).toBe("in_review");
    expect(b.store.getIssue(x.id).status).toBe("done");
    const recordOn = (machine: Machine) =>
      listConflicts(machine.db).find((conflict) => conflict.entity === "issue" && conflict.field === "status" && conflict.resolvedAt === null)!;
    return { a, b, x, recordOn };
  }
  async function readAlike(a: Machine, b: Machine, id: string, status: string): Promise<IssueTiming> {
    const fresh = fleet!.machine("fresh");
    await sync(fresh);
    const onA = timingOn(a, id, 30);
    for (const machine of [a, b, fresh]) expect(machine.store.getIssue(id).status, machine.label).toBe(status);
    // The elapsed readings, identical. Work is not settled by a status decision: the attempt's
    // two ends are a record of their own, and both devices say so (contested) until it is resolved.
    const elapsed = (t: IssueTiming) => ({ wall: t.wall, quality: t.quality.wall, activeSeconds: t.activeSeconds, reviewSeconds: t.reviewSeconds, approximate: t.approximate });
    expect(elapsed(timingOn(b, id, 30)), "b").toEqual(elapsed(onA));
    for (const machine of [a, b]) expect(timingOn(machine, id, 30).quality.work.inputs, machine.label).toContain("contested");
    expect(timingOn(fresh, id, 30)).toMatchObject({ wall: null, missing: { wall: "replay_unavailable" } });
    expect(onA.approximate).toBe(false);
    expect(onA.quality.wall).toEqual({ state: "approximate", inputs: ["conflict_resolved"] });
    return onA;
  }

  it("a status resolved LOCAL, where the resolving row does not move, reads the same on every device", async () => {
    const { a, b, x, recordOn } = await disputedStatus();
    at(20);
    a.use();
    resolveConflict(a.db, { id: recordOn(a).id, choice: "local", actor: "vp" });
    await sync(a, b);
    const t = await readAlike(a, b, x.id, "in_review");
    // Work to the first disagreeing write, then the decision (review) from there.
    expect(t.wall!.buckets).toMatchObject({ work: min(10), review: min(20) });
  }, 60_000);

  it("a status resolved REMOTE reads the same on every device", async () => {
    const { a, b, x, recordOn } = await disputedStatus();
    at(20);
    a.use();
    resolveConflict(a.db, { id: recordOn(a).id, choice: "remote", actor: "vp" });
    await sync(a, b);
    const t = await readAlike(a, b, x.id, "done");
    expect(t.wall).toMatchObject({ endAt: iso(10), buckets: { work: min(10) } });
    const decided = (machine: Machine) =>
      machine.db.prepare("SELECT created_at FROM events WHERE issue_id = ? AND kind = 'status_changed' AND json_extract(payload, '$.resolvesConflict') IS NOT NULL").all(x.id);
    expect(decided(a)).toEqual([{ created_at: iso(20) }]);
    expect(decided(b)).toEqual([{ created_at: iso(20) }]);
  }, 60_000);

  it("the same record resolved on both devices offline, to the same value, reads the same on every device", async () => {
    const { a, b, x, recordOn } = await disputedStatus();
    at(14);
    b.use();
    resolveConflict(b.db, { id: recordOn(b).id, choice: "remote", actor: "vp" });
    at(20);
    a.use();
    resolveConflict(a.db, { id: recordOn(a).id, choice: "local", actor: "vp" });
    await sync(b, a, b);
    await readAlike(a, b, x.id, "in_review");
    const decided = (machine: Machine) =>
      (machine.db.prepare("SELECT created_at FROM events WHERE issue_id = ? AND json_extract(payload, '$.resolvesConflict') IS NOT NULL ORDER BY created_at").all(x.id) as Array<{ created_at: string }>).map((row) => row.created_at);
    expect(decided(a)).toEqual([iso(14), iso(20)]);
    expect(decided(b)).toEqual(decided(a));
  }, 60_000);

  it("an attempt two devices ended differently is contested until the record is settled", async () => {
    const { a, b, x } = await disputedStatus();
    for (const machine of [a, b]) {
      expect(listConflicts(machine.db).some((record) => record.entity === "attempt" && record.field === "end"), machine.label).toBe(true);
      expect(timingOn(machine, x.id, 30).quality.work, machine.label).toMatchObject({ state: "approximate", inputs: ["contested"] });
    }
  }, 60_000);

  it("events in one millisecond on two devices order the same on both", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const x = a.store.createIssue({ title: "Dependent" });
    const y = a.store.createIssue({ title: "One" });
    const z = a.store.createIssue({ title: "Other" });
    a.store.checkoutIssue(x.id, "agent-a");
    at(5);
    a.store.releaseIssue(x.id, "agent-a");
    await sync(a, b);
    // The same millisecond, offline on each.
    at(10);
    a.use();
    a.store.setBlockedBy(x.id, [y.id], "vp");
    b.use();
    b.store.setBlockedBy(x.id, [z.id], "vp");
    await sync(a, b, a);
    const order = (machine: Machine) =>
      (machine.db.prepare(`SELECT payload FROM events WHERE issue_id = ? AND kind = 'blockers_changed' ORDER BY ${"created_at, COALESCE(origin_device, ''), COALESCE(origin_seq, seq), seq"}`).all(x.id) as Array<{ payload: string }>).map(
        (row) => (JSON.parse(row.payload) as { blockedByIds: string[] }).blockedByIds,
      );
    expect(order(a)).toEqual(order(b));
    expect(timingOn(a, x.id, 20).quality.wall).toEqual(timingOn(b, x.id, 20).quality.wall);
    expect(timingOn(a, x.id, 20).wall).toEqual(timingOn(b, x.id, 20).wall);
  }, 60_000);

  it("two children made offline on two devices to block one parent both keep their edge, on a fresh device too", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const parent = a.store.createIssue({ title: "Parent" });
    const earlier = a.store.createIssue({ title: "An earlier blocker" });
    // A blocker set written to the parent BEFORE the children: a fresh device must not let it drop them.
    a.store.setBlockedBy(parent.id, [earlier.id], "vp");
    await sync(a, b);
    a.use();
    const one = a.store.createIssue({ title: "From A", parent: parent.id, blockParentUntilDone: true });
    b.use();
    const two = b.store.createIssue({ title: "From B", parent: parent.id, blockParentUntilDone: true });
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const blockers = (machine: Machine) =>
      (machine.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ? ORDER BY blocker_id").all(parent.id) as Array<{ blocker_id: string }>).map((row) => row.blocker_id);
    const want = [earlier.id, one.id, two.id].sort();
    for (const machine of [a, b, fresh]) expect(blockers(machine), machine.label).toEqual(want);
    converged(a, b, fresh);
  }, 60_000);

  it("a child made to block its parent before connecting, whose parent's set was cleared since, holds no edge anywhere", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const b = fleet.machine("b");
    await sync(b);
    const prepared = fleet.prepare("a");
    process.env.STAPLE_HOME = prepared.home;
    const offline = openWorkspace(join(prepared.dir, ".staple", "staple.db"));
    const parent = offline.store.createIssue({ title: "Parent" });
    offline.store.createIssue({ title: "Child", parent: parent.id, blockParentUntilDone: true });
    offline.store.setBlockedBy(parent.id, [], "vp");
    offline.store.db.close();
    const a = fleet.connect("a", prepared);
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const count = (machine: Machine) => machine.db.prepare("SELECT COUNT(*) AS n FROM relations WHERE blocked_id = ?").get(parent.id);
    for (const machine of [a, b, fresh]) expect(count(machine), machine.label).toEqual({ n: 0 });
    converged(a, b, fresh);
  }, 60_000);

  it("a set cleared on one device before a child made offline on another: the child's later create keeps its edge everywhere", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const parent = a.store.createIssue({ title: "Parent" });
    const earlier = a.store.createIssue({ title: "Earlier blocker" });
    a.store.setBlockedBy(parent.id, [earlier.id], "vp");
    await sync(a, b);
    at(40);
    b.use();
    b.store.setBlockedBy(parent.id, [], "vp");
    await sync(b);
    at(41);
    a.use();
    const child = a.store.createIssue({ title: "Made offline", parent: parent.id, blockParentUntilDone: true });
    // A pulls B's clear (earlier in the log) before its own create comes back.
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const blockers = (machine: Machine) =>
      (machine.db.prepare("SELECT blocker_id FROM relations WHERE blocked_id = ?").all(parent.id) as Array<{ blocker_id: string }>).map((row) => row.blocker_id);
    for (const machine of [a, b, fresh]) expect(blockers(machine), machine.label).toEqual([child.id]);
    converged(a, b, fresh);
  }, 60_000);

  it("an operation's narration is not the entity's state: no fold keeps it, and no field write records it", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    // Connected and synchronized first, so the journal writes these operations itself.
    await sync(a);
    a.use();
    const x = a.store.createIssue({ title: "Narrated" });
    a.store.checkoutIssue(x.id, "agent-a");
    expect(a.db.prepare("SELECT COUNT(*) AS n FROM sync_field_writes WHERE entity = 'issue' AND entity_id = ?").get(x.id)).not.toEqual({ n: 0 });
    await sync(a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, fresh]) {
      expect(machine.db.prepare("SELECT COUNT(*) AS n FROM sync_field_writes WHERE field = 'originEvents'").get(), machine.label).toEqual({ n: 0 });
    }
    const snapshot = (await (await server.fetch(`https://sync.test.example/v1/repos/${REPO}/snapshot`, { headers: { authorization: "Bearer token-device-a", "staple-protocol": "3" } })).json()) as {
      entities: Array<{ entity: string; state: Record<string, unknown> }>;
    };
    expect(snapshot.entities.filter((entity) => entity.entity === "issue").every((entity) => !("originEvents" in entity.state))).toBe(true);
  }, 60_000);
});

describe("the orchestrator lane's stored ends wait for a service that settles them", () => {
  it("an older Worker that does not list the lane's reasons gets no stored orchestrator end; the attempt reads ended all the same", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO, orphanEndReasons: null }), REPO);
    const a = fleet.machine("a");
    await sync(a);
    a.use();
    const one = a.store.createIssue({ title: "First" });
    const two = a.store.createIssue({ title: "Second" });
    a.store.openOrchestratorAttempt(one.id, "orch", "orchestrator");
    at(10);
    a.store.openOrchestratorAttempt(two.id, "orch", "orchestrator");
    await sync(a);
    a.use();
    a.store.addComment(two.id, "a mutating command", "vp");
    expect(attemptsOfIssue(a.db, one.id)[0]!.state).toBe("running");
    expect(viewsOfIssue(a.db, one.id)[0]).toMatchObject({ state: "ended", endReason: "superseded_by_newer" });
  }, 60_000);
});
