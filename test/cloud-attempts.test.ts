/**
 * Execution attempts across devices (`docs/execution-telemetry.md`, "Orphaned attempts are
 * closed at read time", "A stored orphan end never overwrites a real end" and "Where it lives
 * and what synchronizes").
 *
 * Every device here is a real one: its own home, its own clone, the real sync engine, the real
 * journal and applier, against the fake service that folds the log as the Worker does. A
 * third, fresh device hydrates from that fold at the end of every case, and every device must
 * hold the same attempt rows, column for column (`synchronized-state.ts`). Nothing writes an
 * attempt row by hand; the only thing a test injects is a transport fault, to bound a push.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { hydrate } from "../src/core/cloud/hydrate.js";
import { foldOperations } from "../src/core/cloud/tail-fold.js";
import type { RemoteOperation } from "../src/core/cloud/wire.js";
import { attemptsOfIssue, transitionsOf } from "../src/core/telemetry/attempt-records.js";
import { viewsOfIssue } from "../src/core/telemetry/attempt-derive.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { openWorkspace } from "../src/core/open.js";
import { join } from "node:path";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000a7e01";

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

/**
 * A sync whose connection drops after `posts` pushes have landed: the push batches before it
 * are acknowledged, the rest stay in the outbox. With the service's batch size at 1, that is
 * a steal's `issue.update` reaching the log without the `attempt.update` its scope journaled.
 */
async function syncCutAfterPushes(machine: Machine, server: FakeSyncServer, posts: number): Promise<void> {
  let sent = 0;
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    if (method === "POST" && String(input).endsWith("/ops")) {
      if (sent >= posts) {
        return new Response(JSON.stringify({ code: "unavailable", message: "connection dropped", retryable: true }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      sent += 1;
    }
    return server.fetch(input as never, init as never);
  };
  machine.use();
  await expect(machine.sync({ fetchImpl: fetchImpl as never, attempts: 1 })).rejects.toThrow();
}

const views = (machine: Machine, issueId: string) => viewsOfIssue(machine.db, issueId);
const attempts = (machine: Machine, issueId: string) => attemptsOfIssue(machine.db, issueId);
const outboxAttemptOps = (db: DatabaseSync): number =>
  (db.prepare("SELECT COUNT(*) AS n FROM sync_outbox WHERE entity IN ('attempt', 'attemptTransition') AND acknowledged_seq IS NULL").get() as { n: number }).n;

function converged(writer: Machine, ...others: Machine[]): void {
  const want = stateOf(writer.db);
  expect(others.flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
}

describe("an applied operation runs no attempt side effect", () => {
  it("a pulled checkout arrives as the writer's attempt, with its own ids and times, and journals nothing", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    await sync(a, b);
    a.use();
    const issue = a.store.createIssue({ title: "Claimed on A", estimatedSeconds: 1800 });
    a.store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { harness: "codex", model: "gpt-x" } });
    await sync(a, b);

    // Exactly the attempt A opened: B inferred nothing from the applied claim.
    expect(attempts(b, issue.id)).toEqual(attempts(a, issue.id));
    expect(attempts(b, issue.id)).toMatchObject([{ agent: "agent-a", deviceId: "device-a", openedBy: "checkout" }]);
    expect(outboxAttemptOps(b.db)).toBe(0);
    // The transition's event, re-emitted under its transition-derived key, dated by the writer.
    const [started] = transitionsOf(b.db, attempts(b, issue.id)[0]!.id);
    const event = b.db.prepare("SELECT actor, dedup_key, created_at FROM events WHERE kind = 'attempt_started'").get() as Record<string, string>;
    const original = a.db.prepare("SELECT dedup_key FROM events WHERE kind = 'attempt_started'").get() as Record<string, string>;
    expect(event).toEqual({ actor: "agent-a", dedup_key: original.dedup_key, created_at: started!.at });

    // A pause on A replicates; nothing paused reads a measured zero, a pause and resume more.
    a.use();
    expect(views(a, issue.id)[0]!.pausedSeconds).toBe(0);
    a.store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "awaiting_reset" });
    a.store.recordAttemptEvent(issue.id, "resume", "agent-a");
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [b, fresh]) {
      expect(transitionsOf(machine.db, attempts(machine, issue.id)[0]!.id).map((t) => t.kind), machine.label).toEqual([
        "attempt_started",
        "attempt_paused",
        "attempt_resumed",
      ]);
      expect(views(machine, issue.id)[0]!.pausedSeconds, machine.label).toBe(views(a, issue.id)[0]!.pausedSeconds);
    }
    expect(outboxAttemptOps(fresh.db)).toBe(0);
    converged(a, b, fresh);
  }, 60_000);
});

describe("two offline checkouts of one issue", () => {
  it("read as one contested open attempt on every device, and settle once the claim conflict is resolved", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Contested" });
    await sync(a, b);

    // Offline on both: each claims it under its own agent.
    a.use();
    a.store.checkoutIssue(issue.id, "agent-a");
    b.use();
    b.store.checkoutIssue(issue.id, "agent-b");
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    // Each writer keeps its own claim (the contested field is withheld), and every device
    // still reads the same: the newer attempt open, the older superseded, both contested.
    expect(a.store.getIssue(issue.id).checkoutAgent).toBe("agent-a");
    expect(b.store.getIssue(issue.id).checkoutAgent).toBe("agent-b");
    const [older, newer] = attempts(a, issue.id);
    for (const machine of [a, b, fresh]) {
      expect(
        views(machine, issue.id).map((view) => [view.agent, view.state, view.outcome, view.endReason, view.contested]),
        machine.label,
      ).toEqual([
        [older!.agent, "ended", "orphaned", "superseded_by_merge", true],
        [newer!.agent, "running", null, null, true],
      ]);
    }
    // Neither writer writes an end while its own claim conflict is open.
    a.use();
    a.store.addComment(issue.id, "a mutating command on A", "vp");
    b.use();
    b.store.addComment(issue.id, "a mutating command on B", "vp");
    await sync(a, b, a);
    expect(attempts(a, issue.id).map((attempt) => attempt.state)).toEqual(["running", "running"]);
    expect(attempts(b, issue.id).map((attempt) => attempt.state)).toEqual(["running", "running"]);

    // A human resolves the claim for agent-b, on A. A's attempt is now A's own orphan
    // (clause 3), and A writes its end; the contested case is over everywhere.
    a.use();
    for (const conflict of listConflicts(a.db).filter((record) => record.entity === "issue" && record.entityId === issue.id)) {
      resolveConflict(a.db, { id: conflict.id, choice: conflict.remoteValue === "agent-b" || conflict.field === "checkout_at" ? "remote" : "local", actor: "vp" });
    }
    expect(a.store.getIssue(issue.id).checkoutAgent).toBe("agent-b");
    await sync(a, b, a, fresh);
    const aAttempt = attempts(a, issue.id).find((attempt) => attempt.agent === "agent-a")!;
    for (const machine of [a, b, fresh]) {
      const byAgent = Object.fromEntries(
        views(machine, issue.id).map((view) => [view.agent, [view.state, view.outcome, view.endReason, view.endDetection, view.contested]]),
      );
      expect(byAgent, machine.label).toEqual({
        "agent-a": ["ended", "interrupted", "claim_moved", "inferred", false],
        "agent-b": ["running", null, null, null, false],
      });
      expect(attempts(machine, issue.id).find((attempt) => attempt.id === aAttempt.id)!.state, machine.label).toBe("ended");
    }
    converged(a, b, fresh);
  }, 90_000);

  it("under ONE identity is not contested: the newest survives by clause 5 on every device", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Same identity" });
    await sync(a, b);
    a.use();
    a.store.checkoutIssue(issue.id, "claude");
    b.use();
    b.store.checkoutIssue(issue.id, "claude");
    await sync(a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect(views(machine, issue.id).map((view) => [view.state, view.endReason, view.contested]), machine.label).toEqual([
        ["ended", "superseded_by_merge", false],
        ["running", null, false],
      ]);
    }
  }, 60_000);
});

describe("a steal split across push batches", () => {
  for (const order of ["orphan end first", "real end first"] as const) {
    it(`settles to the real end on every device and in the fold, recording no conflict (${order} in the log)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, maxBatchSize: 1 });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const b = fleet.machine("b");
      a.use();
      const issue = a.store.createIssue({ title: "Stolen" });
      a.store.checkoutIssue(issue.id, "agent-a");
      await sync(a, b);
      const stolenFrom = attempts(a, issue.id)[0]!;

      // B steals. Its scope journals the claim, the end of A's attempt, and the new attempt;
      // the connection drops after the claim reached the log.
      b.use();
      b.store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 0 });
      await syncCutAfterPushes(b, server, 1);
      const claim = server.ops.filter((op) => op.entity === "issue" && op.entityId === issue.id).at(-1)!;
      expect(claim.payload).toMatchObject({ checkoutAgent: "agent-b" });
      expect(server.ops.some((op) => op.entity === "attempt" && op.entityId === stolenFrom.id && op.verb === "update")).toBe(false);

      // A pulls the moved claim, reaches the head, and writes its stored orphan end.
      if (order === "orphan end first") {
        await sync(a);
        await sync(b);
      } else {
        // A writes it but cannot send it before B's real end lands.
        await syncCutAfterPushes(a, server, 0);
        expect(attempts(a, issue.id)[0]).toMatchObject({ state: "ended", endReason: "claim_moved", endDetection: "inferred" });
        await sync(b, a);
      }
      const ends = server.ops.filter((op) => op.entity === "attempt" && op.entityId === stolenFrom.id && op.verb === "update");
      expect(ends.map((op) => (op.payload as Record<string, unknown>).endReason)).toEqual(order === "orphan end first" ? ["claim_moved", "claim_stolen"] : ["claim_stolen", "claim_moved"]);

      await sync(a, b, a);
      const fresh = fleet.machine("fresh");
      await sync(fresh);
      for (const machine of [a, b, fresh]) {
        expect(attempts(machine, issue.id).find((attempt) => attempt.id === stolenFrom.id), machine.label).toMatchObject({
          state: "ended",
          outcome: "interrupted",
          endReason: "claim_stolen",
          endDetection: "inferred",
          endedBy: "agent-b",
          endedAtSource: "last_activity",
        });
        expect(listConflicts(machine.db, { includeResolved: true }).filter((record) => record.entity === "attempt"), machine.label).toEqual([]);
      }
      // The fresh device's provenance for the end names the real end's operation, never the dropped orphan's.
      const realOp = ends.find((op) => (op.payload as Record<string, unknown>).endReason === "claim_stolen")!;
      const provenance = fresh.db
        .prepare("SELECT DISTINCT op_id FROM sync_field_writes WHERE entity = 'attempt' AND entity_id = ?")
        .all(stolenFrom.id) as Array<{ op_id: string }>;
      expect(provenance.map((row) => row.op_id)).toEqual([realOp.opId]);
      converged(b, a, fresh);
    }, 90_000);
  }

  it("a snapshot read never lays the log's orphan end over a real end this device has not sent yet", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO, maxBatchSize: 1 });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Stolen, end unsent" });
    a.store.checkoutIssue(issue.id, "agent-a");
    await sync(a, b);
    const stolenFrom = attempts(a, issue.id)[0]!;
    b.use();
    b.store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 0 });
    await syncCutAfterPushes(b, server, 1);
    await sync(a);
    // The log holds A's orphan end and not yet B's real end, which is still in B's outbox.
    const orphanOp = server.ops.find((op) => op.entity === "attempt" && op.entityId === stolenFrom.id && op.verb === "update")!;
    expect((orphanOp.payload as Record<string, unknown>).endReason).toBe("claim_moved");

    // B re-reads the log's fold (the applier catch-up and a tail too large to fold both
    // apply a snapshot through `hydrate`): the fold's orphan end lands nowhere on B.
    const folded = foldOperations(server.ops.map((op) => ({ ...op, serverTs: 0 }) as unknown as RemoteOperation));
    const cutoff = Math.max(...server.ops.map((op) => op.seq));
    b.use();
    const ownEnd = attempts(b, issue.id).find((attempt) => attempt.id === stolenFrom.id)!;
    expect(ownEnd.endReason).toBe("claim_stolen");
    b.db.exec("BEGIN");
    hydrate(b.db, b.store.journal, folded, [], cutoff, new Date().toISOString(), true, true, "reread-test");
    b.db.exec("COMMIT");
    expect(attempts(b, issue.id).find((attempt) => attempt.id === stolenFrom.id)).toEqual(ownEnd);
    const inherited = b.db
      .prepare("SELECT COUNT(*) AS n FROM sync_field_writes WHERE entity = 'attempt' AND entity_id = ? AND op_id = ?")
      .get(stolenFrom.id, orphanOp.opId) as { n: number };
    expect(inherited.n).toBe(0);
  }, 60_000);

  it("the tail fold applies the same rule, in either order", () => {
    const op = (seq: number, verb: string, payload: Record<string, unknown>): RemoteOperation =>
      ({ opId: `op-${seq}`, seq, entity: "attempt", entityId: "at-1", verb, payload, actor: "x", deviceId: "d", createdAt: `2026-09-24T00:00:0${seq}.000Z`, baseVersion: verb === "create" ? null : seq - 1 }) as never;
    const create = op(1, "create", { issueId: "i", agent: "a", state: "running", startedAt: "2026-09-24T00:00:00.000Z" });
    const end = (endReason: string): Record<string, unknown> => ({ state: "ended", outcome: "interrupted", endReason, endDetection: "inferred", endedBy: null, endedAt: "2026-09-24T00:00:00.500Z", endedAtSource: "last_activity" });
    for (const [first, second] of [
      [op(2, "update", end("claim_moved")), op(3, "update", end("claim_stolen"))],
      [op(2, "update", end("claim_stolen")), op(3, "update", end("claim_moved"))],
    ] as const) {
      const [folded] = foldOperations([create, first, second]);
      expect(folded!.state.endReason).toBe("claim_stolen");
      const realSeq = first.payload.endReason === "claim_stolen" ? 2 : 3;
      expect(folded!.fieldWrites?.endReason?.seq).toBe(realSeq);
    }
  });
});

describe("a stale pause meets a real end", () => {
  it("never reopens it: every device, the fold and a fresh device hold the steal's end, with no conflict", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Paused, then stolen" });
    a.store.checkoutIssue(issue.id, "agent-a");
    await sync(a, b);
    const held = attempts(a, issue.id)[0]!;
    // A pauses offline; B steals and syncs; then A syncs.
    a.use();
    a.store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "awaiting_reset" });
    b.use();
    b.store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 0 });
    await sync(b, a, b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const ops = server.ops.filter((op) => op.entity === "attempt" && op.entityId === held.id && op.verb === "update");
    expect(ops.map((op) => (op.payload as Record<string, unknown>).state)).toContain("paused");
    for (const machine of [a, b, fresh]) {
      expect(attempts(machine, issue.id).find((attempt) => attempt.id === held.id), machine.label).toMatchObject({
        state: "ended",
        outcome: "interrupted",
        endReason: "claim_stolen",
        endedBy: "agent-b",
      });
      expect(listConflicts(machine.db).filter((record) => record.entity === "attempt"), machine.label).toEqual([]);
    }
    const [folded] = foldOperations(server.ops.filter((op) => op.entityId === held.id).map((op) => ({ ...op, serverTs: 0 }) as unknown as RemoteOperation));
    expect(folded!.state).toMatchObject({ state: "ended", endReason: "claim_stolen" });
    converged(b, a, fresh);
  }, 90_000);
});

describe("two real ends that disagree", () => {
  it("conflict on every writer, and converge once a human resolves it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Two ends" });
    a.store.checkoutIssue(issue.id, "agent-a");
    await sync(a, b);
    const held = attempts(a, issue.id)[0]!;
    // Offline: A reports the interruption itself; B steals and infers one.
    a.use();
    a.store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "provider_limit" });
    b.use();
    b.store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 0 });
    await sync(a, b, a);
    const open = listConflicts(b.db).filter((record) => record.entity === "attempt" && record.entityId === held.id);
    expect(open.map((record) => record.field)).toEqual(["end"]);
    b.use();
    resolveConflict(b.db, { id: open[0]!.id, choice: "remote", actor: "vp" });
    await sync(b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect(attempts(machine, issue.id).find((attempt) => attempt.id === held.id), machine.label).toMatchObject({
        state: "ended",
        endReason: "provider_limit",
        endDetection: "reported",
      });
      expect(listConflicts(machine.db).filter((record) => record.entity === "attempt"), machine.label).toEqual([]);
    }
    converged(a, b, fresh);
  }, 90_000);
});

describe("a status the vocabulary moves out of active", () => {
  it("orphans the attempt on every device, and the opener writes its end after the pull", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    a.store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = a.store.createIssue({ title: "Doing" });
    a.store.checkoutIssue(issue.id, "agent-a");
    a.store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    await sync(a, b);

    // B, which did not open it, removes the status: the rows move as a rename.
    b.use();
    b.store.removeStatus("doing", { migrateTo: "todo" }, "vp");
    expect(views(b, issue.id)[0]).toMatchObject({ state: "ended", storedState: "running", outcome: "orphaned", endReason: "left_active" });
    await sync(b);
    // B never writes another device's orphan end.
    expect(attempts(b, issue.id)[0]!.state).toBe("running");

    // A pulls, reaches the head, and writes the end of its own attempt in the same sync.
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect(views(machine, issue.id)[0], machine.label).toMatchObject({
        state: "ended",
        storedState: "ended",
        outcome: "interrupted",
        endReason: "left_active",
        endDetection: "inferred",
      });
    }
    converged(a, b, fresh);
  }, 60_000);

  it("a recategorized status orphans it the same way", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    a.store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = a.store.createIssue({ title: "Recategorized" });
    a.store.checkoutIssue(issue.id, "agent-a");
    a.store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    await sync(a, b);
    b.use();
    b.store.recategorizeStatus("doing", "review", "vp");
    await sync(b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect(attempts(machine, issue.id)[0], machine.label).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "left_active" });
    }
    // Back into active, nothing revives it: the end is stored.
    b.use();
    b.store.recategorizeStatus("doing", "active", "vp");
    await sync(b, a);
    expect(views(a, issue.id)[0]!.state).toBe("ended");
    converged(a, b);
  }, 60_000);
});

describe("an attempt opened before its workspace connected", () => {
  it("is still its opener's: the stored orphan end is written after connecting, and nothing revives it", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const b = fleet.machine("b");
    await sync(b);
    // A works before it ever connects: no device, so the attempt has none either.
    const prepared = fleet.prepare("a");
    process.env.STAPLE_HOME = prepared.home;
    const before = openWorkspace(join(prepared.dir, ".staple", "staple.db"));
    before.store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = before.store.createIssue({ title: "Before connecting" });
    before.store.checkoutIssue(issue.id, "agent-a");
    before.store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    expect(attemptsOfIssue(before.store.db, issue.id)[0]!.deviceId).toBeNull();
    before.store.db.close();
    const a = fleet.connect("a", prepared);
    await sync(a, b);
    expect(attempts(b, issue.id)[0]!.deviceId).toBeNull();

    // B takes the status out of active: A's attempt is an orphan, and only A writes its end.
    b.use();
    b.store.recategorizeStatus("doing", "review", "vp");
    await sync(b);
    b.use();
    b.store.addComment(issue.id, "a mutating command on B", "vp");
    expect(attempts(b, issue.id)[0]!.state).toBe("running");
    await sync(a);
    a.use();
    a.store.addComment(issue.id, "a mutating command on A", "vp");
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect(attempts(machine, issue.id)[0], machine.label).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "left_active", endDetection: "inferred" });
    }
    // Back into active, it stays ended.
    b.use();
    b.store.recategorizeStatus("doing", "active", "vp");
    await sync(b, a);
    await sync(fresh);
    for (const machine of [a, b, fresh]) expect(viewsOfIssue(machine.db, issue.id)[0]!.state, machine.label).toBe("ended");
    converged(a, b, fresh);
  }, 90_000);
});

describe("the resume rule after a stale release", () => {
  it("is evaluated once, by the opening device, and replicates as stored", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const issue = a.store.createIssue({ title: "Released stale" });
    a.store.checkoutIssue(issue.id, "agent-a");
    await sync(a, b);
    b.use();
    b.store.releaseIssue(issue.id, "agent-b", { ifIdleSeconds: 0 });
    await sync(b, a);
    a.use();
    a.store.checkoutIssue(issue.id, "agent-c");
    await sync(a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    const [dead, next] = attempts(a, issue.id);
    expect(dead).toMatchObject({ outcome: "interrupted", endReason: "released_stale", endDetection: "inferred", endedBy: "agent-b", endedAtSource: "last_activity" });
    expect(next).toMatchObject({ agent: "agent-c", resumesAttemptId: dead!.id });
    for (const machine of [b, fresh]) {
      expect(views(machine, issue.id).map((view) => view.chain), machine.label).toEqual([
        [dead!.id, next!.id],
        [dead!.id, next!.id],
      ]);
    }
    converged(a, b, fresh);
  }, 60_000);
});

describe("an epic checked out", () => {
  it("has its attempt on every device, and a child's claim gives its parent none", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const b = fleet.machine("b");
    a.use();
    const epic = a.store.createIssue({ title: "Epic", kind: "epic" });
    const child = a.store.createChild(epic.id, { title: "Child" });
    const other = a.store.createIssue({ title: "Other epic", kind: "epic" });
    const otherChild = a.store.createChild(other.id, { title: "Other child" });
    a.store.checkoutIssue(epic.id, "agent-epic");
    await sync(a, b);
    b.use();
    b.store.checkoutIssue(otherChild.id, "agent-child");
    await sync(b, a);
    const fresh = fleet.machine("fresh");
    await sync(fresh);
    for (const machine of [a, b, fresh]) {
      expect(attempts(machine, epic.id).map((attempt) => [attempt.agent, attempt.state]), machine.label).toEqual([["agent-epic", "running"]]);
      expect(attempts(machine, child.id), machine.label).toEqual([]);
      expect(machine.store.getIssue(other.id).status, machine.label).toBe("in_progress");
      expect(attempts(machine, other.id), machine.label).toEqual([]);
      expect(attempts(machine, otherChild.id).map((attempt) => attempt.agent), machine.label).toEqual(["agent-child"]);
    }
    converged(a, b, fresh);
  }, 60_000);
});
