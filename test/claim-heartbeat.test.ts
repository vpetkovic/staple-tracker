/**
 * A live attempt keeps its claim from looking abandoned: the heartbeat of the holder's
 * OPEN attempt counts toward the claim's `lastActivityAt`, beside the holder's events,
 * comments and document revisions. Nothing else does: a heartbeat or a read by another
 * actor, or a heartbeat left by an attempt that has ended, never makes a quiet holder look
 * alive. The heartbeat is machine-local: it writes no event, no transition and no operation.
 *
 * Time is moved with a faked `Date` (as `attention.test.ts` does), so what a step writes is
 * genuinely that old; nothing is backdated by hand except where a test says why.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceAttention } from "../src/core/attention.js";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

const HOUR = 3600_000;

/** Run `fn` with the clock set `ms` in the past, so what it writes is that old. */
function earlier<T>(ms: number, fn: () => T): T {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() - ms);
  try {
    return fn();
  } finally {
    vi.useRealTimers();
  }
}

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

let store: WorkspaceStore;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "staple-claim-heartbeat-"));
  process.env.STAPLE_HOME = home;
  store = memStore();
});

afterEach(() => {
  vi.useRealTimers();
  if (store.db.isOpen) store.db.close();
  delete process.env.STAPLE_HOME;
  rmSync(home, { recursive: true, force: true });
});

/** An issue `holder` checked out two hours ago and has written nothing on since. */
function quietClaim(holder = "opus-x"): { id: string; identifier: string; checkoutAt: string } {
  return earlier(2 * HOUR, () => {
    const issue = store.createIssue({ title: "Long silent build", status: "todo" });
    store.checkoutIssue(issue.id, holder);
    return { id: issue.id, identifier: issue.identifier, checkoutAt: store.claimActivity(issue.identifier)!.checkoutAt };
  });
}

describe("the holder's heartbeat", () => {
  it("refreshes the claim's last activity, in the single read and the batch alike", () => {
    const issue = quietClaim();
    expect(store.claimActivity(issue.identifier)!.idleSeconds).toBeGreaterThanOrEqual(7200);

    store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x");

    const single = store.claimActivity(issue.identifier)!;
    expect(single.lastActivityAt > issue.checkoutAt).toBe(true);
    expect(single.idleSeconds).toBeLessThan(5);
    // Held-for still measures from the claim.
    expect(single.heldSeconds).toBeGreaterThanOrEqual(7200);
    expect(store.claimActivityFor([issue.id]).get(issue.id)!.lastActivityAt).toBe(single.lastActivityAt);
  });

  it("is accepted on a paused attempt, which is still open", () => {
    const issue = quietClaim();
    earlier(HOUR, () => store.recordAttemptEvent(issue.identifier, "pause", "opus-x", { reason: "awaiting_reset" }));
    store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x");
    expect(store.claimActivity(issue.identifier)!.idleSeconds).toBeLessThan(5);
  });

  it("only ever moves forward: an older heartbeat arriving late does not wind the claim back", () => {
    const issue = quietClaim();
    store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x");
    const latest = store.claimActivity(issue.identifier)!.lastActivityAt;
    earlier(HOUR, () => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x"));
    expect(store.claimActivity(issue.identifier)!.lastActivityAt).toBe(latest);
  });

  it("writes nothing that travels or shows on the timeline: no event, no transition, no operation", () => {
    const issue = quietClaim();
    const count = (sql: string): number => (store.db.prepare(sql).get() as { n: number }).n;
    const before = {
      events: count("SELECT COUNT(*) AS n FROM events"),
      transitions: count("SELECT COUNT(*) AS n FROM attempt_transitions"),
      outbox: count("SELECT COUNT(*) AS n FROM sync_outbox"),
    };
    store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x");
    store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x");
    expect({
      events: count("SELECT COUNT(*) AS n FROM events"),
      transitions: count("SELECT COUNT(*) AS n FROM attempt_transitions"),
      outbox: count("SELECT COUNT(*) AS n FROM sync_outbox"),
    }).toEqual(before);
    // One row per attempt, upserted, however often it beats.
    expect(count("SELECT COUNT(*) AS n FROM attempt_heartbeats")).toBe(1);
  });

  it("is refused when nothing is open: an attempt opens with a checkout, never with a heartbeat", () => {
    const issue = store.createIssue({ title: "Never claimed", status: "todo" });
    expect(refusal(() => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x")).code).toBe("conflict");
  });
});

describe("silence without a heartbeat", () => {
  it("a holder who writes nothing and sends no heartbeat goes silent", () => {
    const issue = quietClaim();
    const claim = store.claimActivity(issue.identifier)!;
    expect(claim.lastActivityAt).toBe(issue.checkoutAt);
    expect(claim.idleSeconds).toBeGreaterThanOrEqual(7200);
    const silent = workspaceAttention(store).filter((row) => row.kind === "claim_silent").map((row) => row.ref);
    expect(silent).toEqual([issue.identifier]);
  });

  it("a heartbeat from the holder takes the claim off the silent list", () => {
    const issue = quietClaim();
    store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x");
    expect(workspaceAttention(store).filter((row) => row.kind === "claim_silent")).toEqual([]);
  });

  it("a process that stopped beating goes quiet again once its last heartbeat is old", () => {
    const issue = quietClaim();
    earlier(HOUR + 60_000, () => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x"));
    const claim = store.claimActivity(issue.identifier)!;
    expect(claim.idleSeconds).toBeGreaterThanOrEqual(3600);
    expect(claim.idleSeconds).toBeLessThan(7200);
  });
});

describe("another actor", () => {
  it("cannot heartbeat the holder's attempt, and its attempt does not refresh the holder", () => {
    const issue = quietClaim();
    const refused = refusal(() => store.recordAttemptEvent(issue.identifier, "heartbeat", "sonnet-y"));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toContain("only the holder");
    expect(store.claimActivity(issue.identifier)!.lastActivityAt).toBe(issue.checkoutAt);
  });

  it("a heartbeat on another actor's own (orchestrator) attempt on the ticket does not refresh the holder", () => {
    const issue = quietClaim();
    earlier(2 * HOUR - 1000, () => store.openOrchestratorAttempt(issue.identifier, "orch", "orchestrator"));
    store.recordAttemptEvent(issue.identifier, "heartbeat", "orch", { role: "orchestrator" });
    expect(store.claimActivity(issue.identifier)!.lastActivityAt).toBe(issue.checkoutAt);
    expect(store.claimActivityFor([issue.id]).get(issue.id)!.lastActivityAt).toBe(issue.checkoutAt);
  });

  it("reading the ticket does not refresh the holder", () => {
    const issue = quietClaim();
    store.getIssue(issue.identifier);
    store.claimActivity(issue.identifier);
    store.listIssues({});
    expect(store.claimActivity(issue.identifier)!.lastActivityAt).toBe(issue.checkoutAt);
  });
});

describe("an ended attempt", () => {
  it("never refreshes the claim, even with a heartbeat newer than anything else", () => {
    const issue = quietClaim();
    // The holder beat a minute ago; then another actor reported the attempt interrupted. The claim stays.
    earlier(60_000, () => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x"));
    store.recordAttemptEvent(issue.identifier, "interrupt", "sonnet-y", { reason: "harness_exit" });
    const claim = store.claimActivity(issue.identifier)!;
    expect(claim.heldBy).toBe("opus-x");
    expect(claim.lastActivityAt).toBe(issue.checkoutAt);
    expect(store.claimActivityFor([issue.id]).get(issue.id)!.lastActivityAt).toBe(issue.checkoutAt);
    // And it cannot be beaten back to life.
    expect(refusal(() => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x")).code).toBe("conflict");
  });
});

describe("taking a silent claim over", () => {
  it("checkout --steal-if-stale refuses a holder whose heartbeat is inside the threshold", () => {
    const issue = quietClaim();
    earlier(10 * 60_000, () => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x"));
    const refused = refusal(() => store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 3600 }));
    expect(refused.code).toBe("conflict");
    expect(refused.message).toBe("Checkout refused: held by opus-x, active 10m ago. Pick a different task.");
    expect(store.getIssue(issue.identifier).checkoutAgent).toBe("opus-x");
  });

  it("still steals once the last heartbeat is beyond the threshold", () => {
    const issue = quietClaim();
    earlier(90 * 60_000, () => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x"));
    const stolen = store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 3600 });
    expect(stolen.checkoutAgent).toBe("sonnet-y");
    // The new holder starts fresh: the old attempt's heartbeat is not theirs.
    expect(store.claimActivity(issue.identifier)!.heldBy).toBe("sonnet-y");
  });

  it("release --if-stale refuses inside the threshold too", () => {
    const issue = quietClaim();
    earlier(10 * 60_000, () => store.recordAttemptEvent(issue.identifier, "heartbeat", "opus-x"));
    expect(refusal(() => store.releaseIssue(issue.id, "sonnet-y", { ifIdleSeconds: 3600 })).code).toBe("conflict");
  });
});
