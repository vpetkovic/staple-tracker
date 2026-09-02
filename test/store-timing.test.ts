import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";

/**
 * STA-90 — interval-based timing.
 *
 * STA-81 answered "how long did this take" by subtracting two timestamps.
 * VP's report killed that shape with three concrete lies, and this suite is
 * organised around them because they are what a regression would restore:
 *
 *   1. **The parent stopwatch.** STA-79 flips an ancestor to `in_progress` when
 *      a child starts. Under two timestamps that stamped `started_at` on the
 *      epic, and the epic then reported growing "actual" time with zero agents
 *      working it — forever, because nothing ever closes an epic automatically.
 *   2. **Blocked time billed as work.** `started_at` is never cleared, so
 *      `in_progress -> blocked -> in_progress` charged the estimate for the
 *      whole span including the week it sat blocked.
 *   3. **"still running" over a corpse.** Anything `in_progress` counted to
 *      `now`, so an agent that died on Friday was several days into its estimate
 *      by Monday.
 *
 * ## How time is faked here, and why it is faked THAT way
 *
 * By rewriting `events.created_at` with direct SQL, exactly as the stale-claim
 * suite backdates a claim and the estimate suite backdates `started_at`.
 * Production code has no clock injection and must not grow any: the moment "how
 * long did this take" becomes something a test can fake through an API, it stops
 * being a measurement of anything.
 *
 * The histories are always BUILT BY REAL CALLS first (`checkoutIssue`,
 * `updateIssue`, `addComment`) and only then backdated. Hand-writing event rows
 * would test this suite's idea of the event log rather than the one the store
 * actually produces — and defect #1 above existed precisely because the two
 * differed.
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

const ago = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString();

/** The kinds of every event on an issue, oldest first — the fixture's own sanity check. */
function eventKinds(issueId: string): string[] {
  return (
    store.db
      .prepare("SELECT kind FROM events WHERE issue_id = ? ORDER BY seq")
      .all(issueId) as Array<{ kind: string }>
  ).map((row) => row.kind);
}

/**
 * Backdate every event on an issue, oldest first, to the given ages in seconds.
 *
 * The length assertion is load-bearing: if a future change adds or removes an
 * event on one of these paths, the fixture fails loudly here instead of silently
 * shifting a history sideways and producing a plausible wrong number.
 */
function backdateEvents(issueId: string, secondsAgo: number[]): void {
  const rows = store.db
    .prepare("SELECT seq FROM events WHERE issue_id = ? ORDER BY seq")
    .all(issueId) as Array<{ seq: number }>;
  expect(rows.length, `event count for ${issueId}: ${eventKinds(issueId).join(" -> ")}`).toBe(
    secondsAgo.length,
  );
  rows.forEach((row, i) => {
    store.db.prepare("UPDATE events SET created_at = ? WHERE seq = ?").run(ago(secondsAgo[i]!), row.seq);
  });
}

/** Backdate the claim itself, so `lastActivityAt`'s floor moves with its history. */
function backdateCheckout(issueId: string, secondsAgo: number): void {
  store.db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(ago(secondsAgo), issueId);
}

function backdateComments(issueId: string, secondsAgo: number): void {
  store.db.prepare("UPDATE comments SET created_at = ? WHERE issue_id = ?").run(ago(secondsAgo), issueId);
}

// ------------------------------------------------- defect 2: parked time is free

describe("intervals, not spans", () => {
  it("sums two in_progress cycles and charges nothing for the block between them", () => {
    const issue = store.createIssue({ title: "Interrupted", estimatedSeconds: 3600 });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "blocked" }, "agent-a");
    store.updateIssue(issue.id, { status: "in_progress", assignee: "agent-a" }, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    // created 4000s ago; worked 3600->3000, blocked 3000->1200, worked 1200->600.
    backdateEvents(issue.id, [4000, 3600, 3000, 1200, 600]);

    const timing = store.timing(issue.id);
    // 600 + 600. The old two-timestamp answer was 3000 — five times the truth.
    expect(timing.activeSeconds).toBe(1200);
    expect(timing.ownActiveSeconds).toBe(1200);
    expect(timing.approximate).toBe(false);
  });

  it("charges nothing for a spell parked back in todo", () => {
    const issue = store.createIssue({ title: "Parked" });
    store.checkoutIssue(issue.id, "agent-a");
    store.releaseIssue(issue.id, "agent-a");
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [9000, 8000, 7900, 1000, 400]);

    // 100 in the first claim + 600 in the second. Not 7600.
    expect(store.timing(issue.id).activeSeconds).toBe(700);
  });

  it("counts an issue BORN in_progress from its creation event", () => {
    // Rare but reachable, and the one interval with no opening transition of its
    // own: `issue_created` carries the status, so the replay has to seed from it.
    const issue = store.createIssue({
      title: "Born running",
      status: "in_progress",
      assignee: "agent-a",
    });
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [2000, 500]);

    expect(store.timing(issue.id).activeSeconds).toBe(1500);
  });

  it("reports 0, not null, for an interval that opened and closed inside a second", () => {
    // Zero is a measurement ("it ran, briefly"); null is an absence ("it never
    // ran"). Collapsing them would make an instant task indistinguishable from an
    // untouched one on every surface.
    const issue = store.createIssue({ title: "Instant" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [100, 50, 50]);

    expect(store.timing(issue.id).activeSeconds).toBe(0);
  });

  it("is null for an issue that never entered in_progress at all", () => {
    const issue = store.createIssue({ title: "Untouched" });
    expect(store.timing(issue.id).activeSeconds).toBeNull();
    expect(store.timing(issue.id).ownActiveSeconds).toBeNull();
  });
});

// ------------------------------------------- defect 3: the clock stops with the agent

describe("the open interval stops at the last sign of work, never at now", () => {
  it("freezes at the holder's last activity when the agent goes silent", () => {
    const issue = store.createIssue({ title: "Abandoned" });
    store.checkoutIssue(issue.id, "agent-a");
    store.addComment(issue.id, "working on it", "agent-a");
    // Claimed 4h ago, last spoke 2h ago, nothing since.
    backdateEvents(issue.id, [14_500, 14_400, 7200]);
    backdateCheckout(issue.id, 14_400);
    backdateComments(issue.id, 7200);

    const timing = store.timing(issue.id);
    // Two hours of evidence, not four hours of wall clock.
    expect(timing.activeSeconds).toBe(7200);
    // And it is the SAME instant C1 shows in the stale-claim badge, by
    // construction: one derivation, so "this claim is dead" and "this clock has
    // stopped" can never become two different judgements about one silence.
    expect(timing.countedThrough).toBe(store.claimActivity(issue.id)!.lastActivityAt);
  });

  it("does not grow between two reads while the holder stays silent", () => {
    // THE regression pin for VP's screenshot. Under STA-81 this number was
    // `now - startedAt` and grew every time anyone looked at it.
    const issue = store.createIssue({ title: "Frozen" });
    store.checkoutIssue(issue.id, "agent-a");
    store.addComment(issue.id, "note", "agent-a");
    backdateEvents(issue.id, [8000, 7000, 3000]);
    backdateCheckout(issue.id, 7000);
    backdateComments(issue.id, 3000);

    const first = store.timing(issue.id).activeSeconds;
    const second = store.timing(issue.id).activeSeconds;
    expect(first).toBe(4000);
    expect(second).toBe(first);
  });

  it("resumes the moment the holder writes again", () => {
    // The other half of the promise: frozen is not stuck. A live agent's clock
    // tracks it to within its own comment cadence.
    const issue = store.createIssue({ title: "Back from the dead" });
    store.checkoutIssue(issue.id, "agent-a");
    backdateEvents(issue.id, [8000, 7000]);
    backdateCheckout(issue.id, 7000);
    expect(store.timing(issue.id).activeSeconds).toBe(0);

    store.addComment(issue.id, "still here", "agent-a");
    expect(store.timing(issue.id).activeSeconds).toBeGreaterThanOrEqual(6999);
  });

  it("ignores another agent's activity when deciding where the clock stopped", () => {
    // Same rule as C1 liveness: somebody else commenting on your ticket does not
    // make you look alive, and it must not extend your interval either.
    const issue = store.createIssue({ title: "Someone else's noise" });
    store.checkoutIssue(issue.id, "agent-a");
    backdateEvents(issue.id, [8000, 7000]);
    backdateCheckout(issue.id, 7000);
    store.addComment(issue.id, "any update?", "agent-b");

    expect(store.timing(issue.id).activeSeconds).toBe(0);
  });

  it("clamps to the newest event on the issue when in_progress was set with no checkout", () => {
    // Reachable by hand: `staple status X in_progress --assignee vp` moves the
    // status without ever taking a claim, so there is no holder to ask. The
    // newest event is weaker evidence — any actor's — but it is the only evidence
    // there is, and it still beats `now`.
    const issue = store.createIssue({ title: "Unclaimed", assignee: "vp" });
    store.updateIssue(issue.id, { status: "in_progress", assignee: "vp" }, "vp");
    store.addComment(issue.id, "a note", "someone");
    backdateEvents(issue.id, [9000, 8000, 5000]);

    const timing = store.timing(issue.id);
    expect(store.claimActivity(issue.id)).toBeNull();
    expect(timing.activeSeconds).toBe(3000);
    expect(timing.countedThrough).not.toBeNull();
  });

  it("never lets the clamp pull an interval's end before its own start", () => {
    // Defensive: two writes with a clock that ran backwards must not produce a
    // negative duration, and `secondsBetween` flooring at 0 is not enough on its
    // own — the end instant itself has to be floored at the start.
    const issue = store.createIssue({ title: "Skewed" });
    store.checkoutIssue(issue.id, "agent-a");
    backdateEvents(issue.id, [100, 50]);
    backdateCheckout(issue.id, 5000); // checkout_at older than the checkout event

    expect(store.timing(issue.id).activeSeconds).toBe(0);
  });

  it("leaves countedThrough null once the interval is closed", () => {
    const issue = store.createIssue({ title: "Finished" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [3000, 2000, 1000]);

    expect(store.timing(issue.id).countedThrough).toBeNull();
  });
});

// ------------------------------------------------ defect 1: no parent stopwatch

describe("a derived flip is a report about children, not work on the parent", () => {
  it("excludes the interval STA-79 opened on the epic", () => {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 7200 });
    const child = store.createChild(epic.id, { title: "Child" });
    store.checkoutIssue(child.id, "agent-a");
    store.updateIssue(child.id, { status: "done" }, "agent-a");
    backdateEvents(child.id, [5000, 4000, 3000]);
    // The epic's own history: created, flipped by the child's checkout, then
    // told its children were done. Only the middle one is a transition.
    expect(eventKinds(epic.id)).toEqual([
      "issue_created",
      "status_changed",
      "children_complete",
    ]);
    backdateEvents(epic.id, [5000, 4000, 3000]);

    const timing = store.timing(epic.id);
    expect(store.getIssue(epic.id).status).toBe("in_progress");
    // The epic looks busy — correctly, its child was worked — but it has no
    // stopwatch of its own, and nothing is accumulating on it.
    expect(timing.ownActiveSeconds).toBeNull();
    expect(timing.countedThrough).toBeNull();
    // Its headline is its children's work, and its own estimate still has
    // something to be compared against.
    expect(timing.activeSeconds).toBe(1000);
    expect(timing.childrenActiveSeconds).toBe(1000);
    expect(timing.estimatedSeconds).toBe(7200);
  });

  it("stops the epic's number growing once the child stops", () => {
    // The exact screenshot: a child claimed and then abandoned. The epic must
    // report a frozen aggregate, not a ticking one.
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.checkoutIssue(child.id, "agent-a");
    store.addComment(child.id, "started", "agent-a");
    backdateEvents(child.id, [10_000, 9000, 6000]);
    backdateCheckout(child.id, 9000);
    backdateComments(child.id, 6000);
    backdateEvents(epic.id, [10_000, 9000]);

    const first = store.timing(epic.id).activeSeconds;
    expect(first).toBe(3000);
    expect(store.timing(epic.id).activeSeconds).toBe(first);
    expect(store.timing(epic.id).countedThrough).toBeNull();
  });

  it("still counts an interval a human opened on the epic by hand", () => {
    // The exclusion is about DERIVED flips specifically, not about parents. An
    // epic somebody genuinely worked reports that work in `ownActiveSeconds` —
    // it just does not become the headline, which stays the aggregation.
    const epic = store.createIssue({ title: "Epic", assignee: "vp" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.updateIssue(epic.id, { status: "in_progress", assignee: "vp" }, "vp");
    store.updateIssue(epic.id, { status: "in_review" }, "vp");
    backdateEvents(epic.id, [8000, 5000, 2000]);
    expect(eventKinds(child.id)).toEqual(["issue_created"]);

    const timing = store.timing(epic.id);
    expect(timing.ownActiveSeconds).toBe(3000);
    // Headline is the aggregate, which is null because no child ran.
    expect(timing.activeSeconds).toBeNull();
  });

  it("reopens a countable interval when a human restarts an epic the flip had opened", () => {
    // The derived flag belongs to the INTERVAL, not to the issue: once a manual
    // transition closes the derived one, the next opening is ordinary work.
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.checkoutIssue(child.id, "agent-a"); // derived flip on the epic
    store.updateIssue(epic.id, { status: "blocked" }, "vp");
    store.updateIssue(epic.id, { status: "in_progress", assignee: "vp" }, "vp");
    store.addComment(epic.id, "picking this up myself", "vp");
    backdateEvents(epic.id, [9000, 8000, 6000, 4000, 1000]);
    backdateEvents(child.id, [9000, 8000]);
    backdateCheckout(child.id, 8000);

    // The derived 8000->6000 window is free; the manual one from 4000 is
    // counted, clamped to the newest evidence at 1000.
    expect(store.timing(epic.id).ownActiveSeconds).toBe(3000);
  });
});

// ---------------------------------------- STA-98: the other derived rungs

describe("STA-98 rungs are reports too — a derived epic still has no stopwatch", () => {
  it("a derived-BLOCKED epic accrues no own-time", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.updateIssue(
      child.id,
      { status: "blocked", unblockOwner: "VP", unblockAction: "decide the schema" },
      "agent-a",
    );

    expect(store.getIssue(epic.id).status).toBe("blocked");
    expect(eventKinds(epic.id)).toEqual(["issue_created", "status_changed"]);
    backdateEvents(epic.id, [5000, 4000]);
    backdateEvents(child.id, [5000, 4000]);

    const timing = store.timing(epic.id);
    // `blocked` opens no interval at all, so this holds by construction — pinned
    // anyway, because "by construction" is exactly what a refactor breaks.
    expect(timing.ownActiveSeconds).toBeNull();
    expect(timing.countedThrough).toBeNull();
    expect(timing.approximate).toBe(false);
  });

  it("an epic derived through blocked -> workable -> in_progress accrues nothing across the whole dance", () => {
    // The full un-derive cycle: three derived transitions on the epic, none of
    // them the epic's own work.
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.updateIssue(child.id, { status: "blocked", unblockOwner: "VP" }, "agent-a");
    expect(store.getIssue(epic.id).status).toBe("blocked");
    store.updateIssue(child.id, { status: "todo" }, "agent-a");
    expect(store.getIssue(epic.id).status).toBe("backlog");
    store.checkoutIssue(child.id, "agent-a");
    expect(store.getIssue(epic.id).status).toBe("in_progress");

    expect(eventKinds(epic.id)).toEqual([
      "issue_created",
      "status_changed",
      "status_changed",
      "status_changed",
    ]);
    backdateEvents(epic.id, [8000, 7000, 6000, 5000]);
    backdateCheckout(child.id, 5000);

    const timing = store.timing(epic.id);
    // The open in_progress interval was opened by a derived flip, so it is
    // tracked (the next transition must close the right thing) and counted at
    // zero. This is the regression the marker generalization exists to prevent:
    // matching one literal marker would have started billing this epic again.
    expect(timing.ownActiveSeconds).toBeNull();
    expect(timing.countedThrough).toBeNull();
  });

  it("a derived IN_REVIEW epic bills no review time either", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.updateIssue(child.id, { status: "in_review" }, "agent-a");

    expect(store.getIssue(epic.id).status).toBe("in_review");
    backdateEvents(epic.id, [5000, 4000]);
    backdateEvents(child.id, [5000, 4000]);

    // Same lie, different bucket: an epic is not IN review because a child is.
    expect(store.timing(epic.id).reviewSeconds).toBeNull();
  });

  it("but a review a human opened on the epic by hand is still counted", () => {
    // The control for the test above — the exclusion is about DERIVED
    // intervals, never about parents.
    const epic = store.createIssue({ title: "Epic" });
    store.updateIssue(epic.id, { status: "in_review" }, "vp");
    store.updateIssue(epic.id, { status: "done" }, "vp");
    backdateEvents(epic.id, [8000, 5000, 2000]);

    expect(store.timing(epic.id).reviewSeconds).toBe(3000);
  });

  it("tests the MARKER's presence, never one marker's value", () => {
    // Structural, because the failure mode is silent: a new derivation rung
    // whose marker is not in an equality check simply starts billing epics, and
    // no assertion anywhere goes red. Derived from the source for the same
    // reason contract-http derives its route list from the server.
    // STA-140 de-static'd the replay (it reads the workspace's configured
    // vocabulary now), so the slice is bounded by the next private method rather
    // than the next static one. Same assertion, same window.
    const source = readFileSync(new URL("../src/core/store.ts", import.meta.url), "utf8");
    const start = source.indexOf("private reconstructIntervals");
    const replay = source.slice(start, source.indexOf("  private ", start + 10));
    expect(replay).toMatch(/typeof event\.payload\.derived === "string"/);
    for (const marker of ["child_started", "child_in_review", "children_workable", "children_blocked"]) {
      expect(replay, marker).not.toContain(`"${marker}"`);
    }
  });
});

// ------------------------------------------------------------------ in_review

describe("in_review is measured, and kept out of the actual", () => {
  it("buckets review time separately from active time", () => {
    const issue = store.createIssue({ title: "Reviewed" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "in_review" }, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [5000, 4000, 3000, 1000]);

    const timing = store.timing(issue.id);
    // Built in 1000s; then sat 2000s waiting for a human. The first number is
    // what the estimate was a plan for.
    expect(timing.activeSeconds).toBe(1000);
    expect(timing.reviewSeconds).toBe(2000);
  });

  it("keeps counting active time when review sends the work back", () => {
    const issue = store.createIssue({ title: "Rejected" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "in_review" }, "agent-a");
    store.updateIssue(issue.id, { status: "in_progress", assignee: "agent-a" }, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [9000, 8000, 7000, 5000, 4500]);

    const timing = store.timing(issue.id);
    expect(timing.activeSeconds).toBe(1000 + 500);
    expect(timing.reviewSeconds).toBe(2000);
  });

  it("is null, not zero, when the issue was never reviewed", () => {
    const issue = store.createIssue({ title: "Straight through" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [3000, 2000, 1000]);

    expect(store.timing(issue.id).reviewSeconds).toBeNull();
  });

  it("clamps an open review interval too, rather than counting to now", () => {
    const issue = store.createIssue({ title: "Waiting on a human" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "in_review" }, "agent-a");
    backdateEvents(issue.id, [9000, 8000, 5000]);

    // Newest event is the transition into review itself, so the queue reads 0
    // until something else happens on the ticket. Honest: there is no evidence
    // of anything since.
    expect(store.timing(issue.id).reviewSeconds).toBe(0);
    // And review never leaks into the ACTIVE clock, open or not.
    expect(store.timing(issue.id).countedThrough).toBeNull();
  });
});

// ------------------------------------------------------------------ cancelled

describe("cancelled work is measured but not comparable", () => {
  it("reports what it ran and declines to call it an actual", () => {
    const issue = store.createIssue({ title: "Abandoned", estimatedSeconds: 3600 });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "cancelled" }, "agent-a");
    backdateEvents(issue.id, [3000, 2000, 1000]);

    const timing = store.timing(issue.id);
    expect(timing.ownActiveSeconds).toBe(1000);
    expect(timing.activeSeconds).toBeNull();
  });

  it("drops out of its parent's total without a rule saying so", () => {
    const epic = store.createIssue({ title: "Epic" });
    const kept = store.createChild(epic.id, { title: "Kept" });
    const dropped = store.createChild(epic.id, { title: "Dropped" });
    store.checkoutIssue(kept.id, "agent-a");
    store.updateIssue(kept.id, { status: "done" }, "agent-a");
    backdateEvents(kept.id, [5000, 4000, 3400]);
    store.checkoutIssue(dropped.id, "agent-a");
    store.updateIssue(dropped.id, { status: "cancelled" }, "agent-a");
    backdateEvents(dropped.id, [5000, 4000, 1000]);

    // The rollup sums the HEADLINE, which is already null for the cancelled
    // child — so charging the epic's estimate for work that produced nothing
    // takes no second rule to prevent.
    expect(store.timing(epic.id).childrenActiveSeconds).toBe(600);
  });
});

// -------------------------------------------------------------------- rollups

describe("rollups", () => {
  it("sums each direct child's headline, so an epic-of-epics is not zero", () => {
    const top = store.createIssue({ title: "Top" });
    const mid = store.createChild(top.id, { title: "Mid" });
    const leaf = store.createChild(mid.id, { title: "Leaf" });
    store.checkoutIssue(leaf.id, "agent-a");
    store.updateIssue(leaf.id, { status: "done" }, "agent-a");
    backdateEvents(leaf.id, [900, 800, 200]);

    // Nobody worked `mid` or `top` — both were only ever flipped by the child —
    // so under "sum the children's OWN time" both would report nothing at all.
    expect(store.timing(mid.id).ownActiveSeconds).toBeNull();
    expect(store.timing(mid.id).activeSeconds).toBe(600);
    expect(store.timing(top.id).activeSeconds).toBe(600);
  });

  it("keeps estimates strictly depth-1 while actuals cascade", () => {
    // The asymmetry is deliberate: a parent's estimate is a plan for its whole
    // subtree, so folding it in with its children's would double-count the plan.
    // A parent has no own actual, so there is nothing to double-count there.
    const top = store.createIssue({ title: "Top" });
    const mid = store.createChild(top.id, { title: "Mid", estimatedSeconds: 3600 });
    store.createChild(mid.id, { title: "Leaf", estimatedSeconds: 1800 });

    expect(store.timing(top.id).childrenEstimatedSeconds).toBe(3600);
    expect(store.timing(mid.id).childrenEstimatedSeconds).toBe(1800);
  });

  it("stays null when no child contributed, rather than collapsing to 0", () => {
    const epic = store.createIssue({ title: "Epic" });
    store.createChild(epic.id, { title: "Not started" });

    const timing = store.timing(epic.id);
    expect(timing.childCount).toBe(1);
    expect(timing.childrenActiveSeconds).toBeNull();
    expect(timing.childrenEstimatedSeconds).toBeNull();
    expect(timing.activeSeconds).toBeNull();
  });

  it("agrees with detailTiming's per-child map", () => {
    const epic = store.createIssue({ title: "Epic" });
    const a = store.createChild(epic.id, { title: "A" });
    const b = store.createChild(epic.id, { title: "B" });
    for (const [child, offsets] of [
      [a, [5000, 4000, 3000]],
      [b, [5000, 4000, 2500]],
    ] as const) {
      store.checkoutIssue(child.id, "agent-a");
      store.updateIssue(child.id, { status: "done" }, "agent-a");
      backdateEvents(child.id, [...offsets]);
    }

    const { timing, childrenTiming } = store.detailTiming(epic.id);
    const rows = Object.values(childrenTiming).map((child) => child.activeSeconds);
    expect(rows).toEqual([1000, 1500]);
    // The table adds up — the whole justification for a depth-1 rollup.
    expect(timing.childrenActiveSeconds).toBe(2500);
    expect(timing.activeSeconds).toBe(2500);
  });
});

// ------------------------------------------------------------------- fallback

describe("a history this code cannot read says so", () => {
  it("falls back to the two-timestamp span with an approximate flag", () => {
    const issue = store.createIssue({ title: "Imported" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    // An imported workspace: rows, no event log.
    store.db.prepare("DELETE FROM events WHERE issue_id = ?").run(issue.id);
    store.db
      .prepare("UPDATE issues SET started_at = ?, completed_at = ? WHERE id = ?")
      .run(ago(3600), ago(600), issue.id);

    const timing = store.timing(issue.id);
    expect(timing.approximate).toBe(true);
    expect(timing.activeSeconds).toBe(3000);
    expect(timing.reviewSeconds).toBeNull();
    expect(timing.countedThrough).toBeNull();
  });

  it("refuses to trust a log that does not land on the row's own status", () => {
    // A hand-edited row, or one written by another tool. The replay would report
    // a confident number derived from a history that demonstrably is not this
    // issue's, which is worse than admitting the approximation.
    const issue = store.createIssue({ title: "Edited by hand" });
    store.checkoutIssue(issue.id, "agent-a");
    store.db.prepare("UPDATE issues SET status = 'done', completed_at = ? WHERE id = ?").run(
      ago(600),
      issue.id,
    );
    store.db.prepare("UPDATE issues SET started_at = ? WHERE id = ?").run(ago(3600), issue.id);

    expect(store.timing(issue.id).approximate).toBe(true);
  });

  it("refuses a log that does not begin with the creation", () => {
    const issue = store.createIssue({ title: "Truncated" });
    store.checkoutIssue(issue.id, "agent-a");
    store.db
      .prepare("DELETE FROM events WHERE issue_id = ? AND kind = 'issue_created'")
      .run(issue.id);

    expect(store.timing(issue.id).approximate).toBe(true);
  });

  it("refuses a status_changed whose payload has no readable destination", () => {
    const issue = store.createIssue({ title: "Corrupt payload" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    store.db
      .prepare("UPDATE events SET payload = '{\"identifier\":\"x\"}' WHERE issue_id = ? AND kind = 'status_changed'")
      .run(issue.id);

    expect(store.timing(issue.id).approximate).toBe(true);
  });

  it("is contagious upward: an epic aggregating an approximate child is approximate", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Legacy child" });
    store.checkoutIssue(child.id, "agent-a");
    store.updateIssue(child.id, { status: "done" }, "agent-a");
    store.db.prepare("DELETE FROM events WHERE issue_id = ?").run(child.id);
    store.db
      .prepare("UPDATE issues SET started_at = ?, completed_at = ? WHERE id = ?")
      .run(ago(3600), ago(600), child.id);

    expect(store.timing(epic.id).approximate).toBe(true);
    expect(store.timing(epic.id).childrenActiveSeconds).toBe(3000);
  });
});

// ------------------------------------------------ the event kinds must stay exhaustive

describe("every status-writing path in the store is replayable", () => {
  /**
   * The failure mode this guards is invisible without it: add a status-writing
   * site without teaching `STATUS_MOVING_EVENT_KINDS` about its event, and the
   * replay stops reproducing the row's status. Nothing throws — every affected
   * issue just silently degrades to `approximate` and the numbers get worse.
   *
   * So each transition site gets a case, and the assertion is always the same:
   * after this operation, the log still explains the row.
   */
  it("createIssue, in every status it can be born in", () => {
    for (const status of ["backlog", "todo", "in_review", "blocked"] as const) {
      const issue = store.createIssue({ title: `Born ${status}`, status });
      expect(store.timing(issue.id).approximate, status).toBe(false);
    }
    const started = store.createIssue({
      title: "Born running",
      status: "in_progress",
      assignee: "a",
    });
    expect(store.timing(started.id).approximate).toBe(false);
  });

  it("updateIssue's status patch", () => {
    const issue = store.createIssue({ title: "Patched", assignee: "a" });
    for (const status of ["in_progress", "in_review", "blocked", "done"] as const) {
      store.updateIssue(issue.id, { status, assignee: "a" }, "a");
      expect(store.timing(issue.id).approximate, status).toBe(false);
    }
  });

  it("checkoutIssue's claim", () => {
    const issue = store.createIssue({ title: "Claimed" });
    store.checkoutIssue(issue.id, "agent-a");
    expect(store.timing(issue.id).approximate).toBe(false);
  });

  it("checkoutIssue's steal", () => {
    const issue = store.createIssue({ title: "Stolen" });
    store.checkoutIssue(issue.id, "agent-a");
    backdateCheckout(issue.id, 7200);
    backdateEvents(issue.id, [7300, 7200]);
    store.checkoutIssue(issue.id, "agent-b", undefined, { stealIfIdleSeconds: 60 });

    expect(eventKinds(issue.id)).toEqual(["issue_created", "checkout", "claim_stolen"]);
    const timing = store.timing(issue.id);
    expect(timing.approximate).toBe(false);
    // A takeover changes WHO is working, not WHETHER work is happening: one
    // continuous interval, not two rounded ones.
    expect(timing.countedThrough).toBe(store.claimActivity(issue.id)!.lastActivityAt);
  });

  it("releaseIssue, plain and stale", () => {
    const plain = store.createIssue({ title: "Released" });
    store.checkoutIssue(plain.id, "agent-a");
    store.releaseIssue(plain.id, "agent-a");
    expect(store.timing(plain.id).approximate).toBe(false);

    const stale = store.createIssue({ title: "Released as stale" });
    store.checkoutIssue(stale.id, "agent-a");
    backdateCheckout(stale.id, 7200);
    backdateEvents(stale.id, [7300, 7200]);
    store.releaseIssue(stale.id, "vp", { ifIdleSeconds: 60 });
    expect(eventKinds(stale.id)).toEqual([
      "issue_created",
      "checkout",
      "claim_released_stale",
    ]);
    expect(store.timing(stale.id).approximate).toBe(false);
  });

  it("markAncestorsInProgress' derived flip", () => {
    const epic = store.createIssue({ title: "Epic" });
    const child = store.createChild(epic.id, { title: "Child" });
    store.checkoutIssue(child.id, "agent-a");
    expect(store.timing(epic.id).approximate).toBe(false);
  });

  it("comments and documents do not disturb the replay", () => {
    // They emit events too; the filter must not let a `comment_added` be read as
    // a transition, or every commented ticket would fall back.
    const issue = store.createIssue({ title: "Chatty" });
    store.checkoutIssue(issue.id, "agent-a");
    store.addComment(issue.id, "a note", "agent-a");
    store.addComment(issue.id, "another", "agent-a");
    expect(store.timing(issue.id).approximate).toBe(false);
  });
});

// ------------------------------------------------------- nothing gets written down

describe("still derived, still not a column", () => {
  it("has no active_seconds column to cache into", () => {
    // The schema assertion, mirroring the one STA-81 made about elapsed: a
    // well-meaning "let's just store it" fails here rather than in review.
    const columns = (
      store.db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>
    ).map((column) => column.name);
    expect(columns).not.toContain("active_seconds");
    expect(columns).not.toContain("own_active_seconds");
    expect(columns).not.toContain("review_seconds");
    expect(columns).not.toContain("elapsed_seconds");
  });

  it("re-derives after the history changes underneath it", () => {
    const issue = store.createIssue({ title: "Moving target" });
    store.checkoutIssue(issue.id, "agent-a");
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    backdateEvents(issue.id, [3000, 2000, 1000]);
    expect(store.timing(issue.id).activeSeconds).toBe(1000);

    backdateEvents(issue.id, [3000, 2000, 500]);
    expect(store.timing(issue.id).activeSeconds).toBe(1500);
  });
});
