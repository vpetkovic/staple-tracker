/**
 * Execution attempts on one device: how they open, end, pause, resume and resume each other,
 * and what they read as (`docs/execution-telemetry.md`, "Execution attempts").
 *
 * Every attempt here is the side effect of a real store mutation; nothing writes an attempt
 * row by hand. Times are moved only where a rule reads a duration (last activity, paused
 * intervals), and then by moving the rows the mutation wrote, together.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { attemptsOfIssue, transitionsOf } from "../src/core/telemetry/attempt-records.js";
import { viewsOfIssue } from "../src/core/telemetry/attempt-derive.js";
import { StapleError } from "../src/core/types.js";

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
const previousHome = process.env.STAPLE_HOME;
beforeEach(() => {
  // A home of its own with no device and no bindings: an unconnected machine.
  process.env.STAPLE_HOME = mkdtempSync(join(tmpdir(), "staple-attempts-home-"));
  store = memStore();
});
afterEach(() => {
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

const ago = (seconds: number): string => new Date(Date.now() - seconds * 1000).toISOString();
const attempts = (issueId: string) => attemptsOfIssue(store.db, issueId);
const views = (issueId: string) => viewsOfIssue(store.db, issueId);
const kinds = (attemptId: string) => transitionsOf(store.db, attemptId).map((t) => t.kind);

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

/** Everything an issue's holder wrote, moved back: its events, comments and attempt rows. */
function rewindActivity(issueId: string, agent: string, secondsAgo: number): void {
  store.db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ? AND actor = ?").run(ago(secondsAgo), issueId, agent);
  store.db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ? AND checkout_agent = ?").run(ago(secondsAgo), issueId, agent);
  store.db.prepare("UPDATE attempts SET started_at = ? WHERE issue_id = ? AND agent = ?").run(ago(secondsAgo), issueId, agent);
}

describe("how an attempt opens", () => {
  it("a checkout opens one running attempt, with a start transition, an event and its context", () => {
    const issue = store.createIssue({ title: "Work", estimatedSeconds: 3600 });
    store.checkoutIssue(issue.id, "agent-a");
    const [attempt] = attempts(issue.id);
    expect(attempt).toMatchObject({
      agent: "agent-a",
      state: "running",
      outcome: null,
      openedBy: "checkout",
      resumesAttemptId: null,
      claim: { scope: "local", fencingToken: null },
      deviceId: null,
      harness: null,
      providerBinding: null,
      estimateAtStart: { estimatedSeconds: 3600, source: "own" },
      provenance: "recorded",
      missing: { harness: "not_supplied", providerBinding: "not_supplied" },
    });
    const [started] = transitionsOf(store.db, attempt!.id);
    expect(started).toMatchObject({ kind: "attempt_started", actor: "agent-a", detail: { openedBy: "checkout", resumesAttemptId: null } });
    expect(started!.concurrency).toEqual({
      observedAt: started!.at,
      scope: "device",
      openAttemptsInWorkspace: 1,
      storedOpenAttemptsStartedHere: null,
      storedOpenAttemptsOnAccountStartedHere: null,
      workspaceSyncedThrough: null,
      missing: {
        storedOpenAttemptsStartedHere: "source_unavailable",
        storedOpenAttemptsOnAccountStartedHere: "no_provider_binding",
        workspaceSyncedThrough: "not_connected",
      },
    });
    const event = store.db.prepare("SELECT kind, actor, dedup_key, created_at FROM events WHERE kind = 'attempt_started'").get() as {
      kind: string;
      actor: string;
      dedup_key: string;
      created_at: string;
    };
    expect(event.actor).toBe("agent-a");
    expect(event.created_at).toBe(started!.at);
    expect(event.dedup_key).toMatch(new RegExp(`^attempt_transition:${attempt!.id}:1:[0-9a-f]{32}$`));
  });

  it("reads the estimate the plan had at the start, and keeps it when the estimate moves", () => {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    store.createChild(epic.id, { title: "One", estimatedSeconds: 600 });
    store.createChild(epic.id, { title: "Two", estimatedSeconds: 1200 });
    store.checkoutIssue(epic.id, "agent-a");
    store.updateIssue(epic.id, { estimatedSeconds: 7200 }, "agent-a");
    expect(attempts(epic.id)[0]!.estimateAtStart).toEqual({ estimatedSeconds: 1800, source: "descendants" });
    // And the change says what it was and what it became.
    expect(store.db.prepare("SELECT payload FROM events WHERE kind = 'estimate_changed'").get()).toEqual({
      payload: JSON.stringify({ identifier: epic.identifier, from: null, to: 7200 }),
    });
  });

  it("a status write into the active category opens an attempt with no claim, whose agent is the actor", () => {
    const issue = store.createIssue({ title: "Started by status", assignee: "alice" });
    store.updateIssue(issue.id, { status: "in_progress" }, "alice");
    expect(attempts(issue.id)).toMatchObject([{ agent: "alice", openedBy: "status", claim: { scope: "none", fencingToken: null }, state: "running" }]);
    // Its end is the status write that takes it out again.
    store.updateIssue(issue.id, { status: "in_review" }, "alice");
    expect(attempts(issue.id)[0]).toMatchObject({ state: "ended", outcome: "completed", endReason: "review", endDetection: "reported", endedBy: "alice" });
  });

  it("an issue created straight into an active status is a status write too", () => {
    const issue = store.createIssue({ title: "Born running", status: "in_progress", assignee: "bob", createdBy: "bob" });
    expect(attempts(issue.id)).toMatchObject([{ agent: "bob", openedBy: "status", claim: { scope: "none" } }]);
  });

  it("a derived flip never opens an attempt: a parent in progress only because a child is has none", () => {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.checkoutIssue(child.id, "agent-a");
    expect(store.getIssue(epic.id).status).toBe("in_progress");
    expect(attempts(epic.id)).toEqual([]);
    expect(attempts(child.id)).toHaveLength(1);
  });

  it("a checked-out epic has an attempt like any other, which a gate ends as yielded", () => {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    store.createChild(epic.id, { title: "Child" });
    store.checkoutIssue(epic.id, "agent-a");
    expect(attempts(epic.id)).toMatchObject([{ agent: "agent-a", openedBy: "checkout", state: "running" }]);
    store.gateIssue(epic.id, { owner: "VP" }, "agent-a");
    expect(attempts(epic.id)[0]).toMatchObject({ state: "ended", outcome: "yielded", endReason: "gated", endDetection: "reported", endedBy: "agent-a" });
  });

  it("a replayed attempt key returns the open attempt and opens nothing; reused after it ended, it opens a new one", () => {
    const issue = store.createIssue({ title: "Retried" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { idempotencyKey: "k-1" } });
    const first = store.attempts().result()!;
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { idempotencyKey: "k-1", harness: "codex", harnessSession: "other" } });
    expect(store.attempts().result()!.id).toBe(first.id);
    expect(attempts(issue.id)).toHaveLength(1);
    expect(kinds(first.id)).toEqual(["attempt_started"]);
    // Ended, the key does not bring it back: the new tenure gets an attempt of its own.
    store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "harness_exit" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { idempotencyKey: "k-1" } });
    const second = store.attempts().result()!;
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ state: "running", openedBy: "reclaim", resumesAttemptId: first.id, idempotencyKey: "k-1" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { idempotencyKey: "k-1" } });
    expect(store.attempts().result()!.id).toBe(second.id);
    expect(attempts(issue.id)).toHaveLength(2);
  });

  it("records the harness it was told about, hashed, and the account from a flag or this machine's binding", () => {
    const home = process.env.STAPLE_HOME!;
    const claudeDir = mkdtempSync(join(tmpdir(), "claude-config-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        schemaVersion: 1,
        telemetry: { bindings: [{ source: "claude_code_statusline", configDir: claudeDir, provider: "anthropic", accountRef: "personal-max" }] },
      }),
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = claudeDir;
    try {
      const bound = store.createIssue({ title: "Bound" });
      store.checkoutIssue(bound.id, "agent-a", undefined, { attempt: { harness: "claude_code", harnessSession: "sess-1", model: "claude-x" } });
      expect(attempts(bound.id)[0]).toMatchObject({
        harness: { name: "claude_code", version: null, model: "claude-x", provenance: "self_reported" },
        providerBinding: { provider: "anthropic", accountRef: "personal-max", source: "machine_binding" },
        missing: { "harness.version": "not_supplied" },
      });
      // sha256("claude_code:sess-1"), first 16 hex: joinable with a budget sample from the same session.
      expect(attempts(bound.id)[0]!.harness!.sessionRef).toBe("d1f5544a4de4a39a");

      const flagged = store.createIssue({ title: "Flagged" });
      store.checkoutIssue(flagged.id, "agent-b", undefined, { attempt: { harness: "codex", account: "codex-plus" } });
      expect(attempts(flagged.id)[0]!.providerBinding).toEqual({ provider: "openai", accountRef: "codex-plus", source: "flag" });

      const unbound = store.createIssue({ title: "Unbound" });
      store.checkoutIssue(unbound.id, "agent-c", undefined, { attempt: { harness: "codex" } });
      expect(attempts(unbound.id)[0]!.providerBinding).toBeNull();
      expect(attempts(unbound.id)[0]!.missing.providerBinding).toBe("no_binding_configured");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  it("refuses what an agent cannot report: a session with no harness, a bad account, a failed checkout", () => {
    const issue = store.createIssue({ title: "Refused" });
    expect(refusal(() => store.checkoutIssue(issue.id, "a", undefined, { attempt: { harnessSession: "s" } })).code).toBe("validation");
    expect(refusal(() => store.checkoutIssue(issue.id, "a", undefined, { attempt: { harness: "gemini" } })).code).toBe("validation");
    expect(refusal(() => store.checkoutIssue(issue.id, "a", undefined, { attempt: { account: "Personal Max" } })).code).toBe("validation");
    expect(refusal(() => store.checkoutIssue(issue.id, "a", undefined, { attempt: { outcome: "failed", reason: "x" } })).code).toBe("validation");
    expect(attempts(issue.id)).toEqual([]);
  });
});

describe("a re-claim by the holder", () => {
  it("with the same session, or none, is idempotent: nothing opens and nothing is journaled", () => {
    const issue = store.createIssue({ title: "Held" });
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { harness: "claude_code", harnessSession: "s1" } });
    const events = (store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
    store.checkoutIssue(issue.id, "agent-a");
    store.checkoutIssue(issue.id, "agent-a", undefined, { attempt: { harness: "claude_code", harnessSession: "s1" } });
    expect(attempts(issue.id)).toHaveLength(1);
    expect((store.db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBe(events);
  });

  it("from a different harness session records the session and infers no interruption", () => {
    const issue = store.createIssue({ title: "Two sessions" });
    store.checkoutIssue(issue.id, "claude", undefined, { attempt: { harness: "claude_code", harnessSession: "s1" } });
    store.checkoutIssue(issue.id, "claude", undefined, { attempt: { harness: "claude_code", harnessSession: "s2" } });
    const [attempt] = attempts(issue.id);
    expect(attempts(issue.id)).toHaveLength(1);
    expect(attempt!.state).toBe("running");
    expect(kinds(attempt!.id)).toEqual(["attempt_started", "attempt_session_added"]);
    const added = transitionsOf(store.db, attempt!.id)[1]!.detail.sessionRef;
    expect(added).toMatch(/^[0-9a-f]{16}$/);
    expect(added).not.toBe(attempt!.harness!.sessionRef);
  });

  it("after a reported interruption opens a new attempt that resumes the interrupted one", () => {
    const issue = store.createIssue({ title: "Hit the limit" });
    store.checkoutIssue(issue.id, "agent-a");
    store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason: "provider_limit" });
    // The claim is held with no open attempt: legal.
    expect(store.getIssue(issue.id).checkoutAgent).toBe("agent-a");
    store.checkoutIssue(issue.id, "agent-a");
    const [first, second] = attempts(issue.id);
    expect(first).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "provider_limit", endDetection: "reported", endedBy: "agent-a" });
    expect(second).toMatchObject({ state: "running", openedBy: "reclaim", resumesAttemptId: first!.id });
    expect(views(issue.id).map((view) => view.chain)).toEqual([
      [first!.id, second!.id],
      [first!.id, second!.id],
    ]);
  });
});

describe("how an attempt ends", () => {
  it("a steal interrupts the holder's attempt at its last activity, and the new one resumes it", () => {
    const issue = store.createIssue({ title: "Dead holder" });
    store.checkoutIssue(issue.id, "agent-a");
    store.addComment(issue.id, "working", "agent-a");
    rewindActivity(issue.id, "agent-a", 7200);
    store.db.prepare("UPDATE comments SET created_at = ? WHERE issue_id = ?").run(ago(3600), issue.id);
    store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 1800 });
    const [dead, rescue] = attempts(issue.id);
    const stolen = JSON.parse((store.db.prepare("SELECT payload FROM events WHERE kind = 'claim_stolen'").get() as { payload: string }).payload);
    expect(dead).toMatchObject({
      state: "ended",
      outcome: "interrupted",
      endReason: "claim_stolen",
      endDetection: "inferred",
      endedBy: "agent-b",
      endedAt: stolen.previousLastActivityAt,
      endedAtSource: "last_activity",
    });
    expect(rescue).toMatchObject({ agent: "agent-b", openedBy: "steal", resumesAttemptId: dead!.id, state: "running" });
    expect(kinds(dead!.id)).toEqual(["attempt_started", "attempt_interrupted"]);
  });

  it("release yields, reported by the holder or by somebody else; a stale release interrupts and is resumed", () => {
    const one = store.createIssue({ title: "Released" });
    store.checkoutIssue(one.id, "agent-a");
    store.releaseIssue(one.id, "agent-a");
    expect(attempts(one.id)[0]).toMatchObject({ outcome: "yielded", endReason: "released", endDetection: "reported", endedBy: "agent-a", endedAtSource: "mutation" });

    const two = store.createIssue({ title: "Released by a script" });
    store.checkoutIssue(two.id, "agent-a");
    store.releaseIssue(two.id);
    expect(attempts(two.id)[0]).toMatchObject({ outcome: "yielded", endReason: "released", endDetection: "by_other", endedBy: null });

    const three = store.createIssue({ title: "Released stale" });
    store.checkoutIssue(three.id, "agent-a");
    rewindActivity(three.id, "agent-a", 7200);
    store.releaseIssue(three.id, "agent-b", { ifIdleSeconds: 1800 });
    const [stale] = attempts(three.id);
    expect(stale).toMatchObject({ outcome: "interrupted", endReason: "released_stale", endDetection: "inferred", endedBy: "agent-b", endedAtSource: "last_activity" });
    expect(stale!.endedAt! < ago(3600)).toBe(true);
    // The resume rule: a fresh checkout by anybody names the interrupted attempt.
    store.checkoutIssue(three.id, "agent-c");
    expect(attempts(three.id)[1]).toMatchObject({ agent: "agent-c", openedBy: "checkout", resumesAttemptId: stale!.id });
  });

  it("leaving active ends it by the category entered", () => {
    const cases: Array<[string, string, string]> = [
      ["in_review", "completed", "review"],
      ["done", "completed", "done"],
      ["blocked", "yielded", "blocked"],
      ["cancelled", "yielded", "cancelled"],
      ["todo", "yielded", "returned"],
      ["backlog", "yielded", "returned"],
    ];
    for (const [status, outcome, endReason] of cases) {
      const issue = store.createIssue({ title: `To ${status}` });
      store.checkoutIssue(issue.id, "agent-a");
      store.updateIssue(issue.id, { status }, "reviewer");
      expect(attempts(issue.id)[0], status).toMatchObject({ outcome, endReason, endDetection: "by_other", endedBy: "reviewer" });
      expect(kinds(attempts(issue.id)[0]!.id), status).toEqual(["attempt_started", "attempt_ended"]);
    }
  });

  it("work picked up after review, a block or a failure is a new attempt with no link", () => {
    const issue = store.createIssue({ title: "Round trip" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "in_review" }, "agent-a");
    store.updateIssue(issue.id, { status: "todo" }, "reviewer");
    store.checkoutIssue(issue.id, "agent-a");
    expect(attempts(issue.id).map((attempt) => attempt.resumesAttemptId)).toEqual([null, null]);
  });

  it("failed is only the agent's, and only on the write that clears the claim", () => {
    const issue = store.createIssue({ title: "Too hard" });
    store.checkoutIssue(issue.id, "agent-a");
    expect(refusal(() => store.updateIssue(issue.id, { title: "renamed" }, "agent-a", { outcome: "failed", reason: "no" })).code).toBe("validation");
    expect(refusal(() => store.releaseIssue(issue.id, "agent-a", { attempt: { outcome: "failed" } })).code).toBe("validation");
    expect(refusal(() => store.releaseIssue(issue.id, "agent-a", { attempt: { outcome: "completed", reason: "x" } })).code).toBe("validation");
    expect(attempts(issue.id)[0]!.state).toBe("running");
    store.releaseIssue(issue.id, "agent-a", { attempt: { outcome: "failed", reason: "cannot reproduce" } });
    expect(attempts(issue.id)[0]).toMatchObject({ outcome: "failed", endReason: "cannot reproduce", endDetection: "reported" });
    // And a failed attempt is never resumed.
    store.checkoutIssue(issue.id, "agent-b");
    expect(attempts(issue.id)[1]!.resumesAttemptId).toBeNull();
  });
});

describe("pause, resume, milestone and interrupt", () => {
  it("pausedSeconds is a measured zero when nothing paused, and paused time is not active time", () => {
    const issue = store.createIssue({ title: "Paused" });
    store.checkoutIssue(issue.id, "agent-a");
    const [unpaused] = views(issue.id);
    expect(unpaused!.pausedSeconds).toBe(0);
    expect(unpaused!.missing).not.toHaveProperty("pausedSeconds");

    store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "checkpoint_before_reset" });
    store.recordAttemptEvent(issue.id, "resume", "agent-a");
    store.recordAttemptEvent(issue.id, "milestone", "agent-a", { label: "after the reset" });
    const attempt = attempts(issue.id)[0]!;
    // An hour-long attempt with a 20-minute pause in it.
    store.db.prepare("UPDATE attempts SET started_at = ? WHERE id = ?").run(ago(3600), attempt.id);
    const move = store.db.prepare("UPDATE attempt_transitions SET at = ? WHERE attempt_id = ? AND kind = ?");
    move.run(ago(3600), attempt.id, "attempt_started");
    move.run(ago(2400), attempt.id, "attempt_paused");
    move.run(ago(1200), attempt.id, "attempt_resumed");
    move.run(ago(60), attempt.id, "attempt_milestone");
    store.db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(ago(60), issue.id);
    const [view] = views(issue.id);
    expect(view!.pausedSeconds).toBeGreaterThanOrEqual(1199);
    expect(view!.pausedSeconds).toBeLessThanOrEqual(1201);
    expect(view!.activeSeconds).toBeGreaterThanOrEqual(3540 - 1201);
    expect(view!.activeSeconds).toBeLessThanOrEqual(3540 - 1199);
    expect(kinds(attempt.id)).toEqual(["attempt_started", "attempt_paused", "attempt_resumed", "attempt_milestone"]);
  });

  it("refuses an event the attempt is not in a state for, or a reason the event cannot carry", () => {
    const issue = store.createIssue({ title: "Guarded" });
    expect(refusal(() => store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "operator" })).code).toBe("conflict");
    store.checkoutIssue(issue.id, "agent-a");
    expect(refusal(() => store.recordAttemptEvent(issue.id, "resume", "agent-a")).code).toBe("conflict");
    expect(refusal(() => store.recordAttemptEvent(issue.id, "pause", "agent-a", { reason: "lunch" })).code).toBe("validation");
    expect(refusal(() => store.recordAttemptEvent(issue.id, "milestone", "agent-a", {})).code).toBe("validation");
    expect(refusal(() => store.recordAttemptEvent(issue.id, "milestone", "agent-a", { label: "two\nlines" })).code).toBe("validation");
    for (const reason of ["claim_stolen", "released_stale", "left_active", "claim_moved"]) {
      expect(refusal(() => store.recordAttemptEvent(issue.id, "interrupt", "agent-a", { reason })).code, reason).toBe("validation");
    }
    expect(refusal(() => store.recordAttemptEvent(issue.id, "pause", "agent-b", { reason: "operator" })).code).toBe("conflict");
    // Another actor may report the interruption, and says so.
    store.recordAttemptEvent(issue.id, "interrupt", "operator-vp", { reason: "operator_stop" });
    expect(attempts(issue.id)[0]).toMatchObject({ outcome: "interrupted", endDetection: "by_other", endedBy: "operator-vp" });
  });

  it("a milestone points at the checkpoint it summarizes", () => {
    const issue = store.createIssue({ title: "Checkpointed" });
    store.checkoutIssue(issue.id, "agent-a");
    store.putDocument(issue.id, "worklog", "done so far", { author: "agent-a" });
    const comment = store.addComment(issue.id, "progress note", "agent-a");
    const view = store.recordAttemptEvent(issue.id, "milestone", "agent-a", {
      label: "halfway",
      commentId: comment.id,
      document: { key: "worklog", revision: 1 },
    });
    const milestone = transitionsOf(store.db, view.id).find((t) => t.kind === "attempt_milestone")!;
    expect(milestone.detail).toEqual({ label: "halfway", commentId: comment.id, document: { key: "worklog", revision: 1 } });
    expect(refusal(() => store.recordAttemptEvent(issue.id, "milestone", "agent-a", { label: "x", document: { key: "worklog", revision: 9 } })).code).toBe("validation");
  });
});

describe("orphaned attempts on one device", () => {
  it("a status recategorized out of active orphans the attempt at read time, and the next mutating command writes the end", () => {
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = store.createIssue({ title: "Recategorized" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    store.recategorizeStatus("doing", "review", "vp");

    // Read: ended, orphaned, derived; the row still says running.
    const [read] = views(issue.id);
    expect(read).toMatchObject({ state: "ended", storedState: "running", outcome: "orphaned", endReason: "left_active", endDetection: "derived", endedAt: null });
    expect(read!.missing.endedAt).toBe("end_not_observed");
    expect(read!.endedAtBound).toBe(read!.lastActivityAt);
    // Reads never write it.
    store.getIssue(issue.id);
    store.listIssues();
    store.context(issue.id);
    expect(attempts(issue.id)[0]!.state).toBe("running");

    // The next mutating command, whatever it is, writes the stored orphan end.
    store.addComment(store.createIssue({ title: "Unrelated" }).id, "anything", "someone");
    expect(attempts(issue.id)[0]).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "left_active", endDetection: "inferred", endedBy: null, endedAtSource: "last_activity" });
    // And nothing revives it now.
    store.recategorizeStatus("doing", "active", "vp");
    expect(views(issue.id)[0]).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "left_active" });
  });

  it("before the end is written, a status recategorized back revives it: the bounded exception", () => {
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = store.createIssue({ title: "Revived" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    // Two recategorizations, each a command: the first one's start sees nothing to end.
    store.recategorizeStatus("doing", "review", "vp");
    expect(views(issue.id)[0]!.outcome).toBe("orphaned");
    store.db.prepare("UPDATE workspace_statuses SET category = 'active' WHERE id = 'doing'").run();
    expect(views(issue.id)[0]).toMatchObject({ state: "running", storedState: "running", outcome: null });
  });

  it("statuses remove --migrate-to moves the rows as a rename, and the attempt reads left_active", () => {
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = store.createIssue({ title: "Migrated" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    store.removeStatus("doing", { migrateTo: "todo" }, "vp");
    expect(store.getIssue(issue.id).status).toBe("todo");
    expect(views(issue.id)[0]).toMatchObject({ state: "ended", outcome: "orphaned", endReason: "left_active" });
    store.addComment(issue.id, "next command", "someone");
    expect(attempts(issue.id)[0]).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "left_active", endDetection: "inferred" });
  });

  it("is not written while this device holds an open conflict on the issue's claim pair (secondary to the same-identity fleet case)", () => {
    const issue = store.createIssue({ title: "Claim in dispute" });
    store.checkoutIssue(issue.id, "agent-a");
    // A hand edit moves the claim (one of the paths the read-time rule exists for) while a
    // record on the claim pair is open here: this device does not hold the settled claim.
    store.db
      .prepare(
        `INSERT INTO sync_conflicts (id, entity, entity_id, field, local_value, remote_value, detected_at)
         VALUES ('c-1', 'issue', ?, 'checkout_agent', '"agent-a"', '"agent-b"', ?)`,
      )
      .run(issue.id, new Date().toISOString());
    store.db.prepare("UPDATE issues SET checkout_agent = 'agent-b' WHERE id = ?").run(issue.id);
    expect(views(issue.id)[0]).toMatchObject({ state: "ended", outcome: "orphaned", endReason: "claim_moved" });
    store.addComment(issue.id, "a mutating command", "someone");
    expect(attempts(issue.id)[0]!.state).toBe("running");
    // Resolved, the claim is settled here, and the next command writes the end.
    store.db.prepare("UPDATE sync_conflicts SET resolved_at = ?, resolved_by = 'vp', resolution = '\"agent-b\"' WHERE id = 'c-1'").run(new Date().toISOString());
    store.addComment(issue.id, "another", "someone");
    expect(attempts(issue.id)[0]).toMatchObject({ state: "ended", outcome: "interrupted", endReason: "claim_moved", endDetection: "inferred" });
  });

  it("an orphaned attempt is resumable, and the resumer names it", () => {
    store.addStatus({ id: "doing", category: "active", label: "Doing" }, "vp");
    const issue = store.createIssue({ title: "Orphan then resume" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "doing" }, "agent-a");
    store.removeStatus("doing", { migrateTo: "todo" }, "vp");
    // The checkout's own command start writes the stored end first; then the resume rule sees it.
    store.checkoutIssue(issue.id, "agent-b");
    const [orphan, next] = attempts(issue.id);
    expect(orphan).toMatchObject({ outcome: "interrupted", endReason: "left_active" });
    expect(next!.resumesAttemptId).toBe(orphan!.id);
  });
});

describe("the cost of the stored orphan end", () => {
  it("a command in a workspace with no stored-open attempt opens one transaction, not two", () => {
    const issue = store.createIssue({ title: "Quiet" });
    const journal = store.journal;
    const run = journal.run.bind(journal);
    let runs = 0;
    journal.run = (<T>(fn: () => T): T => {
      runs += 1;
      return run(fn);
    }) as typeof journal.run;
    try {
      store.addComment(issue.id, "no attempt anywhere", "someone");
      expect(runs).toBe(1);
      store.checkoutIssue(issue.id, "agent-a");
      runs = 0;
      // With one stored open, the command's start looks for orphan ends in a scope of its own.
      store.addComment(issue.id, "an attempt is open", "agent-a");
      expect(runs).toBe(2);
    } finally {
      journal.run = run as typeof journal.run;
    }
  });
});

describe("history before capture", () => {
  it("rebuilds attempts from the events an older build left, once", () => {
    const issue = store.createIssue({ title: "Old work" });
    const event = store.db.prepare("INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    event.run("checkout", issue.id, "old-a", "{}", "e1", "2026-01-01T00:00:00.000Z");
    event.run("claim_stolen", issue.id, "old-b", JSON.stringify({ previousHolder: "old-a", previousLastActivityAt: "2026-01-01T01:00:00.000Z" }), "e2", "2026-01-01T05:00:00.000Z");
    event.run("status_changed", issue.id, "old-b", JSON.stringify({ from: "in_progress", to: "in_review" }), "e3", "2026-01-01T06:00:00.000Z");
    event.run("checkout", issue.id, "old-c", "{}", "e4", "2026-01-02T00:00:00.000Z");
    // And the claim that last checkout left, which the row still carries.
    store.db
      .prepare("UPDATE issues SET status = 'in_progress', assignee = 'old-c', checkout_agent = 'old-c', checkout_at = '2026-01-02T00:00:00.000Z' WHERE id = ?")
      .run(issue.id);

    expect(store.reconstructAttemptHistory()).toMatchObject({ reconstructed: 3, alreadyPresent: 0 });
    const [a, b, c] = attempts(issue.id);
    expect(a).toMatchObject({
      agent: "old-a",
      provenance: "reconstructed",
      openedBy: "reconstructed",
      outcome: "interrupted",
      endReason: "claim_stolen",
      endDetection: "reconstructed",
      endedAt: "2026-01-01T01:00:00.000Z",
      endedAtSource: "last_activity",
      harness: null,
      providerBinding: null,
      missing: { harness: "before_capture_began", providerBinding: "before_capture_began", estimateAtStart: "before_capture_began" },
    });
    expect(b).toMatchObject({ agent: "old-b", resumesAttemptId: a!.id, outcome: "completed", endReason: "review", endedAt: "2026-01-01T06:00:00.000Z" });
    expect(c).toMatchObject({ agent: "old-c", state: "running", resumesAttemptId: null });
    // No transitions: nothing measured their concurrency, and their events already exist.
    expect(transitionsOf(store.db, a!.id)).toEqual([]);
    expect(store.reconstructAttemptHistory()).toMatchObject({ reconstructed: 0, alreadyPresent: 3 });
  });

  it("ends a tenure another device ended, from the issue's replicated state, never as an interruption", () => {
    const event = store.db.prepare("INSERT INTO events (kind, issue_id, actor, payload, dedup_key, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    // Checked out here; released on another device, whose operation re-emitted no event here.
    const released = store.createIssue({ title: "Released elsewhere" });
    event.run("checkout", released.id, "old-a", "{}", "r1", "2026-01-01T00:00:00.000Z");
    // Checked out here; completed elsewhere.
    const completed = store.createIssue({ title: "Done elsewhere", assignee: "old-a" });
    event.run("checkout", completed.id, "old-a", "{}", "c1", "2026-01-01T00:00:00.000Z");
    store.db.prepare("UPDATE issues SET status = 'done', completed_at = '2026-01-02T00:00:00.000Z' WHERE id = ?").run(completed.id);
    // Checked out here; now held by somebody else.
    const moved = store.createIssue({ title: "Held by another", assignee: "old-b" });
    event.run("checkout", moved.id, "old-a", "{}", "m1", "2026-01-01T00:00:00.000Z");
    store.db
      .prepare("UPDATE issues SET status = 'in_progress', checkout_agent = 'old-b', checkout_at = '2026-01-03T00:00:00.000Z' WHERE id = ?")
      .run(moved.id);
    // Checked out here, and still held here.
    const held = store.createIssue({ title: "Still held", assignee: "old-a" });
    event.run("checkout", held.id, "old-a", "{}", "h1", "2026-01-01T00:00:00.000Z");
    store.db
      .prepare("UPDATE issues SET status = 'in_progress', checkout_agent = 'old-a', checkout_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
      .run(held.id);

    store.reconstructAttemptHistory();
    expect(attempts(released.id)[0]).toMatchObject({ state: "ended", outcome: "yielded", endDetection: "reconstructed" });
    expect(attempts(completed.id)[0]).toMatchObject({ state: "ended", outcome: "completed", endReason: "done", endedAt: "2026-01-02T00:00:00.000Z" });
    expect(attempts(moved.id)[0]).toMatchObject({ state: "ended", outcome: "yielded", endReason: "released", endedAt: "2026-01-03T00:00:00.000Z" });
    expect(attempts(held.id)[0]).toMatchObject({ state: "running" });
    // The next command writes no orphan end over any of them: none is left to the derivation.
    store.addComment(held.id, "a command", "someone");
    for (const issue of [released, completed, moved]) expect(attempts(issue.id)[0]!.outcome, issue.title).not.toBe("interrupted");
  });

  it("never takes a recorded attempt's own opening events for work before capture, however slow the clock reads", () => {
    // A clock that moves a millisecond every time it is read: the ordering a loaded machine
    // produces at random, every time.
    const RealDate = Date;
    let tick = RealDate.parse("2026-09-24T12:00:00.000Z");
    class SteppingDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super((tick += 1));
        else super(...(args as [string]));
      }
      static now(): number {
        return (tick += 1);
      }
    }
    globalThis.Date = SteppingDate as unknown as DateConstructor;
    try {
      const issue = store.createIssue({ title: "Slow clock" });
      store.checkoutIssue(issue.id, "agent-a");
      const started = store.createIssue({ title: "Slow clock, status", assignee: "agent-b" });
      store.updateIssue(started.id, { status: "in_progress" }, "agent-b");
      expect(store.reconstructAttemptHistory().reconstructed).toBe(0);
      const [attempt] = attempts(issue.id);
      expect(attempt!.startedAt).toBe(store.getIssue(issue.id).checkoutAt);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it("reads only the events before an issue's first recorded attempt", () => {
    const issue = store.createIssue({ title: "Recorded" });
    store.checkoutIssue(issue.id, "agent-a");
    expect(store.reconstructAttemptHistory().reconstructed).toBe(0);
    expect(attempts(issue.id)).toHaveLength(1);
  });
});
