/**
 * An attempt that ended after the backup is open again once the restore rewinds it
 * (`design/sync.md`, "A restore rewinds").
 *
 * The epoch holds the attempt, so the rewind keeps its row and lets the snapshot say what it
 * holds. The snapshot says `running` or `paused`, and the apply rule every reader shares
 * refuses a state that is not an end over an end this device holds (`attempt-ends.ts`: a
 * stale pause must not reopen an attempt a steal ended). That rule is right for the log and
 * wrong for a restore: the end is one the epoch no longer holds. So every device that had
 * pulled the end kept the attempt ended, and a device joining afterwards read it open.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000a7e1";

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

const attemptState = (machine: Machine, id: string): unknown =>
  machine.db.prepare("SELECT state, outcome, end_reason, ended_at FROM attempts WHERE id = ?").get(id);

describe("a restore to a backup taken while an attempt was open", () => {
  for (const at of ["before the pause", "after the pause"] as const) {
    for (const unsent of [false, true]) {
      it(`reopens an attempt ended after the backup (backup ${at}${unsent ? ", the end still unsent on b" : ""})`, async () => {
        const server = new FakeSyncServer({ repositoryId: REPO });
        fleet = new Fleet(server, REPO);
        const a = fleet.machine("a");
        await a.sync();
        const b = fleet.machine("b");
        await sync(b);

        a.use();
        const issue = a.store.createIssue({ title: "Attempted" });
        a.store.checkoutIssue(issue.id, "agent-a", undefined, {
          attempt: { harness: "claude_code", harnessSession: "session-1", model: "claude-test", account: "personal-max" },
        });
        const attempt = (a.db.prepare("SELECT id FROM attempts WHERE issue_id = ?").get(issue.id) as { id: string }).id;
        await sync(a, b);

        a.use();
        await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
        if (at === "after the pause") {
          a.store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "checkpoint_before_reset" });
          await sync(a, b);
          a.use();
        }
        const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
        const atBackup = attemptState(a, attempt);
        expect((atBackup as { state: string }).state).not.toBe("ended");

        if (unsent) {
          // b ends it itself and has not sent the end when the restore lands: b's work is kept.
          b.use();
          b.store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "provider_limit" });
        } else {
          if (at === "before the pause") a.store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "checkpoint_before_reset" });
          a.store.recordAttemptEvent(issue.id, "resume", "agent-a");
          a.store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "provider_limit" });
          await sync(a, b);
          expect((attemptState(b, attempt) as { state: string }).state).toBe("ended");
        }

        a.use();
        await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
        await sync(a);
        if (unsent) {
          // b rewinds and its push after the read fails: its own end is still b's, not only once
          // the push lands.
          b.use();
          let read = false;
          const offline: typeof fetch = async (input, init) => {
            if (String(input).includes("/snapshot")) read = true;
            if (read && (init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) throw new TypeError("fetch failed");
            return server.fetch(input, init);
          };
          await b.sync({ fetchImpl: offline, attempts: 1 } as never).catch(() => undefined);
          expect((attemptState(b, attempt) as { end_reason: string | null }).end_reason).toBe("provider_limit");
        }
        await sync(b, a, b);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        const want = stateOf(fresh.db);
        expect([...differences("a", want, stateOf(a.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
        if (unsent) {
          expect((attemptState(fresh, attempt) as { state: string; end_reason: string }).state).toBe("ended");
          expect((attemptState(fresh, attempt) as { end_reason: string }).end_reason).toBe("provider_limit");
        } else {
          expect(attemptState(a, attempt)).toEqual(atBackup);
        }
      });
    }
  }
});

describe("a restore while an attempt's end is half sent", () => {
  it("keeps the end when its transition is still to be sent, though the end itself was acknowledged", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO, maxBatchSize: 1 });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    await a.sync();
    const b = fleet.machine("b");
    await sync(b);

    a.use();
    const issue = a.store.createIssue({ title: "Attempted" });
    a.store.checkoutIssue(issue.id, "agent-a", undefined, {
      attempt: { harness: "claude_code", harnessSession: "session-1", model: "claude-test", account: "personal-max" },
    });
    const attempt = (a.db.prepare("SELECT id FROM attempts WHERE issue_id = ?").get(issue.id) as { id: string }).id;
    await sync(a, b);
    a.use();
    await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
    const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });

    // b ends the attempt; its push lands the `attempt` operation and fails before the transition.
    b.use();
    b.store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "provider_limit" });
    const pending = b.db.prepare("SELECT entity FROM sync_outbox WHERE acknowledged_seq IS NULL ORDER BY client_seq").all() as Array<{ entity: string }>;
    expect(pending.map((op) => op.entity)).toContain("attemptTransition");
    let posted = 0;
    const partial: typeof fetch = async (input, init) => {
      if ((init?.method ?? "GET") === "POST" && String(input).endsWith("/ops")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { ops?: Array<{ entity: string }> };
        if (body.ops?.some((op) => op.entity === "attemptTransition") || posted > 0) {
          posted += 1;
          throw new TypeError("fetch failed");
        }
      }
      return server.fetch(input, init);
    };
    await b.sync({ fetchImpl: partial, attempts: 1 } as never).catch(() => undefined);
    const unacked = b.db.prepare("SELECT entity FROM sync_outbox WHERE acknowledged_seq IS NULL").all() as Array<{ entity: string }>;
    expect(unacked.map((op) => op.entity)).toContain("attemptTransition");
    expect(unacked.map((op) => op.entity)).not.toContain("attempt");

    a.use();
    await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
    await sync(a, b, a, b);
    const fresh = fleet.machine("fresh");
    await sync(fresh);

    // One end, told once: the attempt ended, with the transition that ended it.
    const endedWith = (machine: Machine): unknown => ({
      attempt: attemptState(machine, attempt),
      interrupted: (machine.db.prepare("SELECT COUNT(*) AS n FROM attempt_transitions WHERE attempt_id = ? AND kind = 'attempt_interrupted'").get(attempt) as { n: number }).n,
    });
    expect((attemptState(b, attempt) as { state: string }).state).toBe("ended");
    expect(endedWith(fresh)).toEqual(endedWith(b));
    expect((endedWith(fresh) as { interrupted: number }).interrupted).toBe(1);
    const want = stateOf(fresh.db);
    expect([...differences("a", want, stateOf(a.db)), ...differences("b", want, stateOf(b.db))]).toEqual([]);
  });
});
