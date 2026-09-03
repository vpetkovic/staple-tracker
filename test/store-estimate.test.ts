import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { MAX_ESTIMATE_SECONDS, formatDuration } from "../src/core/types.js";

/**
 * STA-81 — the ESTIMATE in the store. (STA-90 took the actual; see below.)
 *
 * The feature is one stored number and a handful of read-time derivations, so
 * what is worth pinning is not "a column exists". It is the four ways this can
 * quietly become dishonest:
 *
 *   1. **A derived number getting written down.** The actual is a reading, not
 *      a fact. If it ever lands in a column, every cached copy of that issue
 *      starts asserting a duration that stopped being true the moment it was
 *      serialized. The tests below assert against the SCHEMA, not just the API,
 *      so a well-meaning "let's cache it" fails here.
 *   2. **Null collapsing into zero.** "No estimate recorded" and "estimated at
 *      nothing" are different claims. Once they render the same, an epic with
 *      no plan reports a 100% overrun instead of admitting it has no plan.
 *   3. **A rollup that does not equal the rows it sums.** The parent view lists
 *      direct children; a total the reader cannot audit against the rows on
 *      screen is a table that lies.
 *   4. **An estimate written where it cannot be compared.** A validation gap
 *      here poisons every rollup the row lands in.
 *
 * WHAT MOVED IN STA-90: the derivation of the actual is no longer "subtract two
 * timestamps", so the block that pinned that mechanism now lives in
 * `test/store-timing.test.ts`, which fakes time by backdating EVENTS. The note
 * further down lists which of its cases were inverted rather than merely moved.
 *
 * Either way the rule holds: production code has no clock injection and must not
 * grow any. The moment "how long did this take" becomes something a test can
 * fake through an API, it stops being a measurement of anything.
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

/**
 * Backdate every event on an issue, oldest first — the fixture STA-90's
 * interval replay actually reads. Mirrors the helper in store-timing.test.ts,
 * including the length assertion that fails loudly when a path grows an event.
 */
function backdateEvents(issueId: string, secondsAgo: number[]): void {
  const rows = store.db
    .prepare("SELECT seq FROM events WHERE issue_id = ? ORDER BY seq")
    .all(issueId) as Array<{ seq: number }>;
  expect(rows.length).toBe(secondsAgo.length);
  rows.forEach((row, i) => {
    store.db.prepare("UPDATE events SET created_at = ? WHERE seq = ?").run(ago(secondsAgo[i]!), row.seq);
  });
}

/**
 * Backdate the two timestamp columns. Since STA-90 these feed only the
 * `approximate` fallback, so a test using this is asserting either about the
 * columns themselves or about the derivation NOT reading them.
 */
function backdate(
  id: string,
  times: { startedSecondsAgo?: number; completedSecondsAgo?: number },
): void {
  if (times.startedSecondsAgo !== undefined) {
    store.db
      .prepare("UPDATE issues SET started_at = ? WHERE id = ?")
      .run(ago(times.startedSecondsAgo), id);
  }
  if (times.completedSecondsAgo !== undefined) {
    store.db
      .prepare("UPDATE issues SET completed_at = ? WHERE id = ?")
      .run(ago(times.completedSecondsAgo), id);
  }
}

/** Put an issue into in_progress the way an agent does — via an atomic claim. */
function start(ref: string, agent = "agent-a") {
  return store.checkoutIssue(ref, agent);
}

// ------------------------------------------------------------------ the column

describe("the estimate is stored, and only the estimate is stored", () => {
  it("round-trips through create", () => {
    const issue = store.createIssue({ title: "Estimated", estimatedSeconds: 5400 });
    expect(issue.estimatedSeconds).toBe(5400);
    expect(store.getIssue(issue.id).estimatedSeconds).toBe(5400);
  });

  it("defaults to null, not zero, when nobody said anything", () => {
    // The distinction the whole feature rests on. A default of 0 would make
    // every legacy and un-planned task claim a plan it never had.
    expect(store.createIssue({ title: "Unestimated" }).estimatedSeconds).toBeNull();
  });

  it("is patchable, and an absent key leaves it alone", () => {
    const issue = store.createIssue({ title: "Patch me", estimatedSeconds: 3600 });
    const renamed = store.updateIssue(issue.id, { title: "Renamed" }, "agent-a");
    expect(renamed.estimatedSeconds).toBe(3600);
  });

  it("is cleared by an explicit null, and by nothing else", () => {
    const issue = store.createIssue({ title: "Clear me", estimatedSeconds: 3600 });
    expect(store.updateIssue(issue.id, { estimatedSeconds: null }, "a").estimatedSeconds).toBeNull();
  });

  it("stores NO derived column — the derivations have nowhere to be cached", () => {
    /**
     * A schema-level assertion, deliberately. Every other test here goes through
     * the API, where a cached-and-refreshed value would look identical to a
     * derived one. This is the test that fails if someone adds
     * `elapsed_seconds` "for performance": the point is not that caching is slow,
     * it is that a cache of a clock reading is wrong between refreshes and there
     * is no write path that could refresh it (nothing writes to an issue while
     * it merely continues to be in_progress).
     */
    const columns = (
      store.db.prepare("PRAGMA table_info(issues)").all() as unknown as Array<{ name: string }>
    ).map((c) => c.name);
    expect(columns).toContain("estimated_seconds");
    expect(columns).not.toContain("elapsed_seconds");
    expect(columns).not.toContain("children_estimated_seconds");
    expect(columns).not.toContain("children_elapsed_seconds");
  });
});

describe("what an estimate is allowed to be", () => {
  it("refuses zero, and says how to clear instead", () => {
    // Accepting 0 as "clear" would make an unset shell variable or a missing
    // JSON field indistinguishable from a deliberate erase.
    expect(() => store.createIssue({ title: "Zero", estimatedSeconds: 0 })).toThrowError(
      /positive whole number/,
    );
    const issue = store.createIssue({ title: "Ok", estimatedSeconds: 60 });
    expect(() => store.updateIssue(issue.id, { estimatedSeconds: 0 }, "a")).toThrowError(
      /positive whole number/,
    );
    expect(store.getIssue(issue.id).estimatedSeconds).toBe(60);
  });

  it("refuses negatives and fractions", () => {
    expect(() => store.createIssue({ title: "Neg", estimatedSeconds: -1 })).toThrowError(/positive/);
    expect(() => store.createIssue({ title: "Frac", estimatedSeconds: 1.5 })).toThrowError(/whole/);
  });

  it("refuses a value past the one-year ceiling, calling it a mistyped unit", () => {
    // The realistic failure: `2h` typed as `2` in a field that means hours, or
    // milliseconds pasted into a seconds field. One such row makes every rollup
    // it lands in meaningless, so it is refused rather than summed.
    expect(() =>
      store.createIssue({ title: "Huge", estimatedSeconds: MAX_ESTIMATE_SECONDS + 1 }),
    ).toThrowError(/mistyped unit/);
    expect(
      store.createIssue({ title: "At the ceiling", estimatedSeconds: MAX_ESTIMATE_SECONDS })
        .estimatedSeconds,
    ).toBe(MAX_ESTIMATE_SECONDS);
  });

  it("refuses BEFORE consuming an issue number", () => {
    // Validation runs outside the transaction, like priority and status. A bad
    // estimate must not burn an identifier or leave a half-built row behind.
    store.createIssue({ title: "First" });
    expect(() => store.createIssue({ title: "Doomed", estimatedSeconds: -5 })).toThrow();
    expect(store.createIssue({ title: "Second" }).identifier).toBe("TST-2");
  });
});

// ------------------------------------------------------------------ derivation

/**
 * WHERE THE DERIVATION TESTS WENT — STA-90.
 *
 * This file used to own a `describe("elapsed is derived from the timestamps,
 * per status")` block of nine cases. STA-90 replaced the derivation itself: the
 * actual is now a sum of `in_progress` intervals replayed from the event log,
 * not a subtraction of `started_at` from `completed_at`/`now`. Those nine cases
 * pinned a mechanism that no longer exists, so they moved — and four of them
 * moved by being INVERTED, which is worth recording:
 *
 *  - "MOVES between reads while the work is live" is now
 *    "does not grow between two reads while the holder stays silent". That
 *    inversion IS the ticket: the old property was defect #3 in VP's report.
 *  - "keeps counting through in_review" became "buckets review time separately
 *    from active time". Review is a queue, not execution.
 *  - "stops counting when work is parked back in todo or pushed to blocked"
 *    used to assert NULL — the store admitting it could not tell work from
 *    waiting. It now asserts the exact worked total, because it can.
 *  - "counts up from started_at while in_progress" is gone outright: backdating
 *    `started_at` no longer moves the answer, and a test that still passed
 *    would mean the column had crept back into the derivation.
 *
 * `test/store-timing.test.ts` owns all of it now, with backdated EVENTS instead
 * of backdated timestamps. What stays here is what this file is actually about:
 * the ESTIMATE, and the handful of timing invariants that outlived the rewrite.
 */
describe("what the estimate is compared against", () => {
  it("is null before work starts, whatever the estimate says", () => {
    const issue = store.createIssue({ title: "Not started", estimatedSeconds: 3600 });
    const timing = store.timing(issue.id);
    expect(timing.estimatedSeconds).toBe(3600);
    expect(timing.activeSeconds).toBeNull();
  });

  it("is null for a cancelled issue that demonstrably ran", () => {
    // An abandoned attempt is not an "actual" a plan can be weighed against, and
    // summing it into an epic would charge the estimate for work that produced
    // nothing. STA-90 kept the judgement and added the measurement beside it:
    // `ownActiveSeconds` still reports what ran, for anyone who asks directly.
    const issue = store.createIssue({ title: "Abandoned" });
    start(issue.id);
    store.updateIssue(issue.id, { status: "cancelled" }, "agent-a");
    backdate(issue.id, { startedSecondsAgo: 7200 });
    expect(store.getIssue(issue.id).startedAt).not.toBeNull();
    expect(store.timing(issue.id).activeSeconds).toBeNull();
    expect(store.timing(issue.id).ownActiveSeconds).not.toBeNull();
  });

  it("is null for a done issue that was never started", () => {
    // backlog -> done directly: there is a completion but no work window, so
    // there is no actual. Reporting "now - null" or 0 would both be inventions.
    const issue = store.createIssue({ title: "Closed unworked", assignee: "a" });
    store.updateIssue(issue.id, { status: "done" }, "agent-a");
    expect(store.getIssue(issue.id).startedAt).toBeNull();
    expect(store.timing(issue.id).activeSeconds).toBeNull();
  });

  it("ignores started_at entirely — the column is no longer the derivation", () => {
    /**
     * The pin that replaces "counts up from started_at while in_progress", and
     * says the same thing from the other side. Backdating the column by three
     * hours must not move the answer by a second: if it does, someone has
     * quietly reintroduced the two-timestamp span, and every blocked window in
     * the database is being billed again.
     */
    const issue = store.createIssue({ title: "Running" });
    start(issue.id);
    const before = store.timing(issue.id).activeSeconds;
    backdate(issue.id, { startedSecondsAgo: 11_400 });
    expect(store.timing(issue.id).activeSeconds).toBe(before);
    expect(store.timing(issue.id).approximate).toBe(false);
  });
});

// --------------------------------------------------------------------- rollups

describe("rollups sum DIRECT children and nothing else", () => {
  function epicWithChildren() {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 14_400 });
    const a = store.createIssue({ title: "Child A", parent: epic.id, estimatedSeconds: 5400 });
    const b = store.createIssue({ title: "Child B", parent: epic.id, estimatedSeconds: 7200 });
    const c = store.createIssue({ title: "Child C", parent: epic.id }); // no estimate
    return { epic, a, b, c };
  }

  it("adds up the children's estimates", () => {
    const { epic } = epicWithChildren();
    const timing = store.timing(epic.id);
    expect(timing.estimatedSeconds).toBe(14_400); // the epic's OWN estimate, untouched
    expect(timing.childrenEstimatedSeconds).toBe(12_600); // 5400 + 7200
    expect(timing.childCount).toBe(3);
  });

  it("skips children with no estimate rather than counting them as zero", () => {
    // Child C contributes nothing to the sum and does not drag it down. A
    // partially-planned epic reports the plan it has.
    const { epic } = epicWithChildren();
    expect(store.timing(epic.id).childrenEstimatedSeconds).toBe(12_600);
  });

  it("reports null, not zero, when NO child has an estimate", () => {
    const epic = store.createIssue({ title: "Unplanned epic" });
    store.createIssue({ title: "Kid one", parent: epic.id });
    store.createIssue({ title: "Kid two", parent: epic.id });
    const timing = store.timing(epic.id);
    expect(timing.childCount).toBe(2);
    expect(timing.childrenEstimatedSeconds).toBeNull();
    expect(timing.childrenActiveSeconds).toBeNull();
  });

  it("adds up the children's actuals, mixing live and finished work", () => {
    const { epic, a, b } = epicWithChildren();
    start(a.id);
    store.updateIssue(a.id, { status: "done" }, "agent-a");
    backdateEvents(a.id, [7200, 7200, 3600]); // ran 1h and closed
    start(b.id);
    store.addComment(b.id, "in flight", "agent-a");
    backdateEvents(b.id, [11_400, 11_400, 400]); // open, last seen 400s ago
    store.db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(ago(11_400), b.id);
    store.db.prepare("UPDATE comments SET created_at = ? WHERE issue_id = ?").run(ago(400), b.id);

    // The live child contributes its interval up to the last evidence of work —
    // 11400 - 400 — not up to `now`, which is what STA-90 changed.
    expect(store.timing(epic.id).childrenActiveSeconds).toBe(3600 + 11_000);
  });

  it("counts children by status, with every status present", () => {
    const { epic, a } = epicWithChildren();
    start(a.id);
    expect(store.timing(epic.id).childStatusCounts).toEqual({
      backlog: 2,
      todo: 0,
      in_progress: 1,
      in_review: 0,
      awaiting_approval: 0,
      done: 0,
      blocked: 0,
      cancelled: 0,
    });
  });

  it("is all-empty for a leaf", () => {
    const leaf = store.createIssue({ title: "Leaf", estimatedSeconds: 600 });
    expect(store.timing(leaf.id)).toEqual({
      estimatedSeconds: 600,
      ownActiveSeconds: null,
      activeSeconds: null,
      reviewSeconds: null,
      approximate: false,
      countedThrough: null,
      childCount: 0,
      childrenEstimatedSeconds: null,
      childrenActiveSeconds: null,
      childStatusCounts: {
        backlog: 0, todo: 0, in_progress: 0, in_review: 0, awaiting_approval: 0, done: 0, blocked: 0, cancelled: 0,
      },
    });
  });

  it("stops at depth 1 — a grandchild is its own parent's business", () => {
    /**
     * The depth decision, pinned. A subtree sum would report 900 here, which is
     * a number the epic's own child table cannot account for: the table shows
     * one row (the mid-level parent, estimated 600), and the total has to equal
     * what the reader can see. The grandchild's 300 shows up when you drill in.
     */
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.id, estimatedSeconds: 600 });
    store.createIssue({ title: "Grandchild", parent: mid.id, estimatedSeconds: 300 });

    expect(store.timing(root.id).childrenEstimatedSeconds).toBe(600);
    expect(store.timing(root.id).childCount).toBe(1);
    // …and each level rolls up the level directly beneath it.
    expect(store.timing(mid.id).childrenEstimatedSeconds).toBe(300);
  });

  it("lets a grandchild's actual reach the root THROUGH its parent's headline", () => {
    /**
     * PIN INVERTED BY STA-90, deliberately. This case used to assert that the
     * root's total stayed under a minute while its grandchild ran for an hour —
     * which was only "correct" because a parent had a stopwatch of its own to
     * report instead. Take the stopwatch away (a parent's actual is now its
     * children's aggregate) and that reading becomes zero: an epic-of-epics
     * would report NOTHING, however much work happened two levels down.
     *
     * So the rollup sums each direct child's HEADLINE. `mid`'s headline is its
     * own children's total, so the hour reaches the root — and the on-screen
     * table still adds up, because the row for `mid` shows that same hour.
     * Estimates still stop at depth 1; only actuals cascade, and the test above
     * pins that half.
     */
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.id });
    const grand = store.createIssue({ title: "Grandchild", parent: mid.id });
    start(grand.id);
    store.updateIssue(grand.id, { status: "done" }, "agent-a");
    backdateEvents(grand.id, [7200, 7200, 3600]);

    expect(store.timing(mid.id).ownActiveSeconds).toBeNull(); // no stopwatch
    expect(store.timing(mid.id).childrenActiveSeconds).toBe(3600);
    expect(store.timing(root.id).childrenActiveSeconds).toBe(3600);
  });
});

// -------------------------------------------------------------- batch + detail

describe("the batched read matches the single read", () => {
  it("answers for every requested id, including unestimated leaves", () => {
    // Unlike claimActivityFor, which omits unheld issues: timing always has
    // something true to say, and a surface rendering a row per issue should not
    // have to synthesise the empty case.
    const a = store.createIssue({ title: "A", estimatedSeconds: 60 });
    const b = store.createIssue({ title: "B" });
    const map = store.timingFor([a.id, b.id]);
    expect([...map.keys()].sort()).toEqual([a.id, b.id].sort());
    expect(map.get(a.id)!.estimatedSeconds).toBe(60);
    expect(map.get(b.id)!.estimatedSeconds).toBeNull();
  });

  it("returns an empty map for an empty request, without querying", () => {
    expect(store.timingFor([]).size).toBe(0);
  });

  it("agrees with timing() issue by issue", () => {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 7200 });
    const child = store.createIssue({ title: "Child", parent: epic.id, estimatedSeconds: 3600 });
    start(child.id);
    store.updateIssue(child.id, { status: "done" }, "agent-a");
    backdateEvents(child.id, [3600, 3600, 1800]);

    const batch = store.timingFor([epic.id, child.id]);
    // Deep equality is safe now that the clamp made the numbers a function of
    // the log rather than of the clock — which is itself worth pinning: under
    // STA-81 these two calls disagreed by construction and this had to compare
    // the moving field loosely.
    expect(batch.get(epic.id)).toEqual(store.timing(epic.id));
    expect(batch.get(child.id)).toEqual(store.timing(child.id));
    expect(batch.get(child.id)!.activeSeconds).toBe(1800);
  });
});

describe("detailTiming — the pair every detail surface attaches", () => {
  it("keys children by IDENTIFIER, so the payload is readable and joinable", () => {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 7200 });
    store.createIssue({ title: "One", parent: epic.id, estimatedSeconds: 1800 });
    store.createIssue({ title: "Two", parent: epic.id });
    const { timing, childrenTiming } = store.detailTiming(epic.id);
    expect(timing.estimatedSeconds).toBe(7200);
    expect(Object.keys(childrenTiming).sort()).toEqual(["TST-2", "TST-3"]);
    expect(childrenTiming["TST-2"]!.estimatedSeconds).toBe(1800);
    expect(childrenTiming["TST-3"]!.estimatedSeconds).toBeNull();
  });

  it("gives a leaf an empty children map, not a missing key", () => {
    const leaf = store.createIssue({ title: "Leaf" });
    expect(store.detailTiming(leaf.id).childrenTiming).toEqual({});
  });

  it("resolves a ref the way every other store method does", () => {
    const issue = store.createIssue({ title: "By identifier", estimatedSeconds: 300 });
    expect(store.detailTiming(issue.identifier).timing.estimatedSeconds).toBe(300);
    expect(store.detailTiming("1").timing.estimatedSeconds).toBe(300);
  });
});

// ------------------------------------------------------------------ formatting

describe("formatDuration keeps the second unit that formatAgo throws away", () => {
  it("renders the shapes the estimate line is made of", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(1200)).toBe("20m");
    expect(formatDuration(90)).toBe("1m30s");
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(11_400)).toBe("3h10m");
    expect(formatDuration(86_400)).toBe("1d");
    expect(formatDuration(100_800)).toBe("1d4h");
  });

  it("drops a trailing zero unit rather than printing 2h0m", () => {
    expect(formatDuration(7200)).toBe("2h");
    expect(formatDuration(60)).toBe("1m");
  });

  it("distinguishes durations formatAgo collapses — the whole reason it exists", () => {
    // 2h and 2h55m are the difference between hitting an estimate and blowing
    // it. formatAgo floors both to "2h", which is right for "silent for" and
    // wrong for "took".
    expect(formatDuration(7200)).not.toBe(formatDuration(10_500));
  });

  it("never renders a negative duration", () => {
    expect(formatDuration(-90)).toBe("0s");
  });
});
