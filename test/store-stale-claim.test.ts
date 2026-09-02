import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError, formatAgo } from "../src/core/types.js";

/**
 * Stale-claim semantics (C1). The tracker is not an orchestrator: nothing here
 * expires a claim on its own. Every takeover in this file is something a caller
 * asked for by name, with a threshold it chose.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});

/**
 * Simulate an agent that died N seconds ago by backdating its claim AND every
 * event it left behind. Direct SQL on purpose: production code has no clock
 * injection and must not grow any, or "staleness" becomes something tests can
 * fake but a real usage-limit death cannot.
 */
function backdateClaim(target: WorkspaceStore, issueId: string, secondsAgo: number): string {
  const at = new Date(Date.now() - secondsAgo * 1000).toISOString();
  target.db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(at, issueId);
  target.db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(at, issueId);
  return at;
}

function kindsFor(target: WorkspaceStore, issueId: string): string[] {
  return target
    .listEvents(0, 500)
    .filter((e) => e.issueId === issueId)
    .map((e) => e.kind);
}

describe("formatAgo", () => {
  it("floors to a single unit, which is what the guard sentence reads out", () => {
    expect(formatAgo(0)).toBe("0s");
    expect(formatAgo(45)).toBe("45s");
    expect(formatAgo(59.9)).toBe("59s");
    expect(formatAgo(60)).toBe("1m");
    expect(formatAgo(180)).toBe("3m");
    expect(formatAgo(3599)).toBe("59m");
    expect(formatAgo(3600)).toBe("1h");
    expect(formatAgo(7200)).toBe("2h");
    expect(formatAgo(86_400)).toBe("1d");
    expect(formatAgo(432_000)).toBe("5d");
  });
});

describe("claim liveness derivation", () => {
  it("reports nothing for an issue nobody holds", () => {
    const issue = store.createIssue({ title: "Unheld", status: "todo" });
    expect(store.claimActivity(issue.identifier)).toBeNull();
  });

  it("falls back to the checkout itself when the holder has done nothing since", () => {
    const issue = store.createIssue({ title: "Quiet", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const at = backdateClaim(store, issue.id, 300);
    const claim = store.claimActivity(issue.identifier)!;
    expect(claim.heldBy).toBe("opus-x");
    expect(claim.checkoutAt).toBe(at);
    expect(claim.lastActivityAt).toBe(at);
    expect(claim.idleSeconds).toBeGreaterThanOrEqual(300);
    expect(claim.heldSeconds).toBeGreaterThanOrEqual(300);
  });

  it("advances last activity when the holder comments", () => {
    const issue = store.createIssue({ title: "Chatty", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const at = backdateClaim(store, issue.id, 3600);
    store.addComment(issue.id, "still here", "opus-x", "agent");
    const claim = store.claimActivity(issue.identifier)!;
    expect(claim.lastActivityAt > at).toBe(true);
    expect(claim.idleSeconds).toBeLessThan(5);
    // Held-for still measures from the claim, not from the last sign of life.
    expect(claim.heldSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("ignores traffic from agents other than the holder", () => {
    const issue = store.createIssue({ title: "Heckled", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const at = backdateClaim(store, issue.id, 3600);
    store.addComment(issue.id, "are you alive?", "sonnet-y", "agent");
    const claim = store.claimActivity(issue.identifier)!;
    expect(claim.lastActivityAt).toBe(at);
    expect(claim.idleSeconds).toBeGreaterThanOrEqual(3600);
  });

  it("batches identically to the per-issue read", () => {
    const held = store.createIssue({ title: "Held", status: "todo" });
    const free = store.createIssue({ title: "Free", status: "todo" });
    store.checkoutIssue(held.id, "opus-x");
    backdateClaim(store, held.id, 120);
    const map = store.claimActivityFor([held.id, free.id]);
    expect(map.has(free.id)).toBe(false);
    const batched = map.get(held.id)!;
    const single = store.claimActivity(held.identifier)!;
    expect(batched.heldBy).toBe(single.heldBy);
    expect(batched.checkoutAt).toBe(single.checkoutAt);
    expect(batched.lastActivityAt).toBe(single.lastActivityAt);
  });

  it("applies the holder-only rule in the batch path too", () => {
    const issue = store.createIssue({ title: "Batched heckle", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const at = backdateClaim(store, issue.id, 7200);
    store.addComment(issue.id, "ping", "someone-else", "agent");
    expect(store.claimActivityFor([issue.id]).get(issue.id)!.lastActivityAt).toBe(at);
  });

  it("returns an empty map for an empty id list without touching the db", () => {
    expect(store.claimActivityFor([]).size).toBe(0);
  });
});

describe("explicit steal (checkout with stealIfIdleSeconds)", () => {
  it("refuses a live holder and names them with their last activity", () => {
    const issue = store.createIssue({ title: "Live work", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 180);
    try {
      store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 3600 });
      throw new Error("expected a conflict");
    } catch (error) {
      expect(error).toBeInstanceOf(StapleError);
      const e = error as StapleError;
      expect(e.code).toBe("conflict");
      expect(e.message).toBe(
        "Checkout refused: held by opus-x, active 3m ago. Pick a different task.",
      );
      expect(e.detail?.heldBy).toBe("opus-x");
      expect(e.detail?.stealIfIdleSeconds).toBe(3600);
      expect(e.detail?.idleSeconds as number).toBeGreaterThanOrEqual(180);
    }
    // Refusal is total: the claim is untouched and nothing was logged.
    expect(store.getIssue(issue.id).checkoutAgent).toBe("opus-x");
    expect(kindsFor(store, issue.id)).not.toContain("claim_stolen");
  });

  it("takes over a dead holder, reassigns, and logs claim_stolen", () => {
    const issue = store.createIssue({ title: "Abandoned", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const at = backdateClaim(store, issue.id, 7200);
    const stolen = store.checkoutIssue(issue.id, "sonnet-y", undefined, {
      stealIfIdleSeconds: 3600,
    });
    expect(stolen.status).toBe("in_progress");
    expect(stolen.checkoutAgent).toBe("sonnet-y");
    expect(stolen.assignee).toBe("sonnet-y");
    expect(stolen.checkoutAt! > at).toBe(true);

    const event = store
      .listEvents(0, 500)
      .find((e) => e.kind === "claim_stolen" && e.issueId === issue.id)!;
    expect(event.actor).toBe("sonnet-y");
    expect(event.payload.previousHolder).toBe("opus-x");
    expect(event.payload.previousLastActivityAt).toBe(at);
    expect(event.payload.stealIfIdleSeconds).toBe(3600);
    expect(event.payload.previousIdleSeconds as number).toBeGreaterThanOrEqual(7200);
  });

  it("emits claim_stolen and NOT a second checkout for the takeover", () => {
    const issue = store.createIssue({ title: "One event", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 7200);
    store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 60 });
    // The only `checkout` is opus-x's original; the takeover added exactly one
    // event, and it is the dedicated kind.
    const kinds = kindsFor(store, issue.id);
    expect(kinds.filter((k) => k === "checkout")).toHaveLength(1);
    expect(kinds.filter((k) => k === "claim_stolen")).toHaveLength(1);
  });

  it("absorbs a repeated steal instead of re-logging it", () => {
    const issue = store.createIssue({ title: "Idempotent steal", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 7200);
    const first = store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 60 });
    const second = store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 60 });
    expect(second.statusVersion).toBe(first.statusVersion);
    expect(kindsFor(store, issue.id).filter((k) => k === "claim_stolen")).toHaveLength(1);
  });

  it("still refuses when blockers are unresolved, however dead the holder is", () => {
    const gate = store.createIssue({ title: "Gate" });
    const issue = store.createIssue({ title: "Gated", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 86_400);
    store.setBlockedBy(issue.id, [gate.id]);
    try {
      store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: 1 });
      throw new Error("expected a conflict");
    } catch (error) {
      const e = error as StapleError;
      expect(e.code).toBe("conflict");
      expect(e.message).toContain("unresolved blockers");
      expect(e.message).toContain(gate.identifier);
    }
    expect(store.getIssue(issue.id).checkoutAgent).toBe("opus-x");
  });

  it("leaves the plain-conflict sentence untouched when no threshold is passed", () => {
    const issue = store.createIssue({ title: "No opt-in", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 86_400);
    try {
      store.checkoutIssue(issue.id, "sonnet-y");
      throw new Error("expected a conflict");
    } catch (error) {
      const e = error as StapleError;
      expect(e.message).toContain('Checkout refused: status is "in_progress" (held by opus-x)');
      expect(e.message).toContain("do not retry");
    }
  });

  it("rejects a negative threshold rather than treating it as steal-anything", () => {
    const issue = store.createIssue({ title: "Bad threshold", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    expect(() =>
      store.checkoutIssue(issue.id, "sonnet-y", undefined, { stealIfIdleSeconds: -1 }),
    ).toThrow(/non-negative/);
  });

  it("does not divert an ordinary claim of an unheld issue", () => {
    const issue = store.createIssue({ title: "Free", status: "todo" });
    const claimed = store.checkoutIssue(issue.id, "sonnet-y", undefined, {
      stealIfIdleSeconds: 60,
    });
    expect(claimed.checkoutAgent).toBe("sonnet-y");
    expect(kindsFor(store, issue.id)).toContain("checkout");
    expect(kindsFor(store, issue.id)).not.toContain("claim_stolen");
  });
});

describe("explicit release-if-stale", () => {
  it("refuses a live holder with the same guard sentence", () => {
    const issue = store.createIssue({ title: "Live", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 120);
    try {
      store.releaseIssue(issue.id, "sonnet-y", { ifIdleSeconds: 3600 });
      throw new Error("expected a conflict");
    } catch (error) {
      const e = error as StapleError;
      expect(e.code).toBe("conflict");
      expect(e.message).toBe(
        "Release refused: held by opus-x, active 2m ago. Pick a different task.",
      );
      expect(e.detail?.ifIdleSeconds).toBe(3600);
    }
    expect(store.getIssue(issue.id).status).toBe("in_progress");
  });

  it("frees a dead holder's claim and logs claim_released_stale", () => {
    const issue = store.createIssue({ title: "Dead", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const at = backdateClaim(store, issue.id, 7200);
    const released = store.releaseIssue(issue.id, "sonnet-y", { ifIdleSeconds: 3600 });
    expect(released.status).toBe("todo");
    expect(released.checkoutAgent).toBeNull();

    const event = store
      .listEvents(0, 500)
      .find((e) => e.kind === "claim_released_stale" && e.issueId === issue.id)!;
    expect(event.actor).toBe("sonnet-y");
    expect(event.payload.previousHolder).toBe("opus-x");
    expect(event.payload.previousLastActivityAt).toBe(at);
    expect(event.payload.ifIdleSeconds).toBe(3600);
    expect(kindsFor(store, issue.id)).not.toContain("release");
  });

  it("lets a third party free a dead claim the ownership check would have blocked", () => {
    const issue = store.createIssue({ title: "Not mine", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    backdateClaim(store, issue.id, 7200);
    // Without the threshold this is refused for ownership...
    expect(() => store.releaseIssue(issue.id, "sonnet-y")).toThrow(/held by opus-x, not sonnet-y/);
    // ...with it, staleness is the gate that matters.
    expect(store.releaseIssue(issue.id, "sonnet-y", { ifIdleSeconds: 60 }).status).toBe("todo");
  });

  it("leaves plain release behaviour and its event untouched", () => {
    const issue = store.createIssue({ title: "Own release", status: "todo" });
    store.checkoutIssue(issue.id, "opus-x");
    const released = store.releaseIssue(issue.id, "opus-x");
    expect(released.status).toBe("todo");
    expect(kindsFor(store, issue.id)).toContain("release");
    expect(kindsFor(store, issue.id)).not.toContain("claim_released_stale");
  });

  it("refuses an unheld issue on the status guard, before the staleness guard", () => {
    const issue = store.createIssue({ title: "Not started", status: "todo" });
    expect(() => store.releaseIssue(issue.id, "sonnet-y", { ifIdleSeconds: 60 })).toThrow(
      /Cannot release: status is "todo"/,
    );
  });
});
