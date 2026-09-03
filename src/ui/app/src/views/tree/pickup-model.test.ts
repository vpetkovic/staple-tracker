/**
 * V5 (STA-111) — pickup placement, and the ways it could quietly become wrong.
 *
 * The thing this ticket is most able to break is not visible in a screenshot: a row that
 * lands in the wrong section still LOOKS fine, and a queue in the wrong order looks exactly
 * like a queue. So every test below is a specific way the design could rot:
 *
 *   1. Someone re-derives readiness client-side and it drifts from the store's.
 *   2. Someone "fixes" the order to sort by priority, throwing away the only thing
 *      /api/inbox was called for.
 *   3. A row matches two sections, or none, and silently disappears.
 *   4. The Done section grows its own show-done control instead of obeying V4's.
 *   5. Grouping starts deciding membership, which is the filter's job.
 */
import { describe, expect, it } from "vitest";
import { claim, issue, row } from "@/components/task-list/fixtures";
import type { InboxIssue, InboxRow, IssueRow } from "@/lib/types";
import {
  buildPickupGroups,
  buildPickupIndex,
  EMPTY_PICKUP_INDEX,
  PICKUP_SECTIONS,
  PICKUP_SECTION_ORDER,
  pickupSectionOf,
} from "./pickup-model";

/** An inbox entry as `/api/inbox` sends it: the issue, spread, plus three extra fields. */
function entry(over: Partial<InboxIssue> = {}): InboxIssue {
  return {
    ...issue(over),
    unresolvedBlockers: [],
    claim: null,
    derivedBlockers: [],
    ...over,
  } as InboxIssue;
}

/**
 * One workspace's payload. `ready` order IS the store's pickup order — never
 * re-sorted. `queued` (STA-143) defaults to empty: every test here predates
 * gates and none of them has an opinion about one.
 */
function inbox(
  ready: InboxIssue[],
  blocked: InboxIssue[] = [],
  queued: InboxIssue[] = [],
): InboxRow[] {
  return [{ workspace: "staple", inbox: { ready, queued, blocked, hasMore: false } }];
}

const ids = (rows: readonly { issue: { id: string } }[]) => rows.map((r) => r.issue.id);
/** Generic, so it hands back the group's real type rather than flattening it to `{id}`. */
const section = <T extends { id: string }>(groups: readonly T[], id: string): T | undefined =>
  groups.find((g) => g.id === id);

/** A row parked behind its own review gate — Q2 (STA-144). */
function parked(id: string, owner = "VP", identifier = "STA-108"): IssueRow {
  return {
    ...row({ id, identifier, status: "awaiting_approval" }),
    gate: {
      state: "pending",
      owner,
      requestedBy: "opus-q1",
      requestedAt: "2026-09-02T10:00:00.000Z",
      resolvedBy: null,
      resolvedAt: null,
    },
  };
}

/** A row standing in someone else's queue — Q2 (STA-144). */
function queued(id: string, over: Partial<IssueRow["issue"]> = {}, owner = "VP"): IssueRow {
  return { ...row({ id, ...over }), queuedBy: { identifier: "STA-108", owner } };
}

describe("the section registry", () => {
  it("orders the sections the way the ticket specifies", () => {
    // `pending_approval` is AFTER `waiting` (STA-144): both are "not now", and the
    // gate is the rarer, more specific one, so it reads as a coda to Waiting rather
    // than as competition for Up next's attention.
    expect(PICKUP_SECTION_ORDER).toEqual([
      "up_next",
      "in_flight",
      "waiting",
      "pending_approval",
      "resolved",
    ]);
  });

  it("gives every section a label and a hint, because a derived section must explain itself", () => {
    expect(PICKUP_SECTIONS.every((s) => s.label.length > 0 && s.hint.length > 0)).toBe(true);
    expect(section(PICKUP_SECTIONS, "up_next")).toBeTruthy();
  });
});

describe("the index borrows the store's answer rather than deriving one", () => {
  it("takes readiness from the bucket the row is in, NOT from its status", () => {
    // The trap: `todo` looks ready and is not — it has an unresolved dependency. Any
    // client-side rule that reads `status` gets this backwards, which is the entire
    // reason readiness is the store's to decide.
    const readyLooksIdle = entry({ id: "a", identifier: "STA-1", status: "backlog" });
    const blockedLooksReady = entry({
      id: "b",
      identifier: "STA-2",
      status: "todo",
      unresolvedBlockers: ["STA-9"],
    });

    const index = buildPickupIndex(inbox([readyLooksIdle], [blockedLooksReady]));

    expect(index.isReady("a")).toBe(true);
    expect(index.isBlocked("a")).toBe(false);
    expect(index.isReady("b")).toBe(false);
    expect(index.isBlocked("b")).toBe(true);
  });

  it("ranks in payload order, ready before blocked, so the queue is the store's", () => {
    const index = buildPickupIndex(
      inbox(
        [entry({ id: "r1" }), entry({ id: "r2" })],
        [entry({ id: "b1", status: "blocked" })],
      ),
    );

    expect(index.rank("r1")).toBeLessThan(index.rank("r2"));
    expect(index.rank("r2")).toBeLessThan(index.rank("b1"));
    expect(index.size).toBe(3);
  });

  it("ranks an unknown row last rather than first", () => {
    const index = buildPickupIndex(inbox([entry({ id: "r1" })]));
    expect(index.rank("nobody")).toBe(Number.POSITIVE_INFINITY);
    expect(index.rank("r1")).toBeLessThan(index.rank("nobody"));
  });

  it("names who a blocked row waits on, borrowing a child's words when it has none", () => {
    const own = entry({
      id: "own",
      status: "blocked",
      unblockOwner: "VP",
      unblockAction: "decide the schema",
    });
    const derived = entry({
      id: "derived",
      status: "blocked",
      derivedBlockers: [
        { identifier: "STA-80", title: "child", unblockOwner: "VP", unblockAction: "sign off" },
      ],
    });
    const dependency = entry({ id: "dep", status: "todo", unresolvedBlockers: ["STA-4", "STA-5"] });

    const index = buildPickupIndex(inbox([], [own, derived, dependency]));

    expect(index.waitingOn("own")).toBe("waiting on VP: decide the schema");
    expect(index.waitingOn("derived")).toBe("waiting on VP: sign off");
    // O6 (STA-138): a bare dependency edge no longer produces a caption. The row's
    // warning-triangle badge is that fact now, and it links; the sentence did not.
    expect(index.waitingOn("dep")).toBeNull();
  });
});

describe("placement — one row, exactly one section", () => {
  it("puts a ready, unheld, unstarted row in Up next", () => {
    const r = row({ id: "a", status: "todo" });
    const index = buildPickupIndex(inbox([entry({ id: "a", status: "todo" })]));
    expect(pickupSectionOf(r, index)).toBe("up_next");
  });

  it("puts a HELD row in In flight even though the store calls it ready", () => {
    // This is the rung the ticket's own section list forces. The store's `ready` bucket
    // contains in-progress work — correctly, for an agent resuming its own task — but
    // "what do I grab next" is not "what is open".
    const r = row({ id: "a", status: "todo" }, claim());
    const index = buildPickupIndex(inbox([entry({ id: "a", status: "todo" })]));
    expect(pickupSectionOf(r, index)).toBe("in_flight");
  });

  it("puts an unheld in_progress or in_review row in In flight too", () => {
    // A ticket moved by hand without a checkout is still not free to take.
    for (const status of ["in_progress", "in_review"] as const) {
      const r = row({ id: "a", status });
      const index = buildPickupIndex(inbox([entry({ id: "a", status })]));
      expect(pickupSectionOf(r, index)).toBe("in_flight");
    }
  });

  it("puts a blocked row in Waiting EVEN WHEN it is held", () => {
    // Waiting beats In flight: a blocked ticket cannot move whoever is holding it, and
    // "who it waits on" is the actionable fact. The claim badge still renders on the row.
    const r = row({ id: "a", status: "blocked" }, claim());
    const index = buildPickupIndex(inbox([], [entry({ id: "a", status: "blocked" })]));
    expect(pickupSectionOf(r, index)).toBe("waiting");
  });

  /**
   * Q2 (STA-144). The gate rung sits ABOVE Waiting, mirroring `store.inbox()`, which
   * decides `queuedBy || awaiting_approval` before it looks at `blocked` — "a queued
   * issue with unresolved blockers is still gated, and naming the gate is the more
   * actionable of the two facts".
   */
  describe("gates", () => {
    it("puts the parked parent in Pending approval", () => {
      const index = buildPickupIndex(inbox([], [], [entry({ id: "a", status: "awaiting_approval" })]));
      expect(pickupSectionOf(parked("a"), index)).toBe("pending_approval");
    });

    it("puts a queued child in Pending approval instead of Up next", () => {
      // The point of the whole ticket: a backlog child of a freshly gated epic must
      // stop advertising itself as the next thing to grab.
      const index = buildPickupIndex(inbox([], [], [entry({ id: "a", status: "backlog" })]));
      expect(pickupSectionOf(queued("a", { status: "backlog" }), index)).toBe("pending_approval");
    });

    it("beats In flight — a queued row cannot move whoever is holding it", () => {
      // Same argument Waiting already wins on, and the one STA-142 exists to make:
      // STA-108 sat in_progress for 56 minutes while it was really waiting on VP.
      const held: IssueRow = { ...queued("a", { status: "in_progress" }), claim: claim() };
      expect(pickupSectionOf(held, EMPTY_PICKUP_INDEX)).toBe("pending_approval");
    });

    it("beats Waiting, exactly as the store's own bucketing does", () => {
      const alsoBlocked = queued("a", { status: "blocked" });
      const index = buildPickupIndex(inbox([], [entry({ id: "a", status: "blocked" })]));
      expect(pickupSectionOf(alsoBlocked, index)).toBe("pending_approval");
    });

    it("releases a child the moment the server stops sending queuedBy", () => {
      // "Approve selected" clears the release flag server-side; the row simply arrives
      // without the field on the next poll and returns to the ordinary rungs.
      const index = buildPickupIndex(inbox([entry({ id: "a", status: "todo" })]));
      expect(pickupSectionOf(row({ id: "a", status: "todo" }), index)).toBe("up_next");
    });

    it("does NOT park a row whose gate has been approved", () => {
      const approved: IssueRow = {
        ...parked("a"),
        issue: { ...parked("a").issue, status: "todo" },
        gate: { ...parked("a").gate!, state: "approved", resolvedBy: "VP" },
      };
      const index = buildPickupIndex(inbox([entry({ id: "a", status: "todo" })]));
      expect(pickupSectionOf(approved, index)).toBe("up_next");
    });

    it("keeps the section out of the way entirely when no gate is open", () => {
      const groups = buildPickupGroups([row({ id: "a", status: "todo" })], EMPTY_PICKUP_INDEX);
      expect(section(groups, "pending_approval")).toBeUndefined();
    });

    it("emits Pending approval after Waiting, with the gate and its queue in it", () => {
      const rows: IssueRow[] = [
        row({ id: "free", status: "todo" }),
        row({ id: "stuck", status: "blocked" }),
        parked("epic"),
        queued("kid", { status: "backlog" }),
      ];
      const index = buildPickupIndex(
        inbox(
          [entry({ id: "free", status: "todo" })],
          [entry({ id: "stuck", status: "blocked" })],
          [entry({ id: "epic", status: "awaiting_approval" }), entry({ id: "kid", status: "backlog" })],
        ),
      );

      const groups = buildPickupGroups(rows, index);
      // No In flight section: nothing is held, and empty sections do not render.
      expect(groups.map((g) => g.id)).toEqual(["up_next", "waiting", "pending_approval"]);
      const gated = section(groups, "pending_approval")!;
      expect(ids(gated.rows)).toEqual(["epic", "kid"]);
      expect(gated.count).toBe(2);
    });

    it("puts the gate at the TOP of the queue it is holding, whatever rank it has", () => {
      /**
       * The real database does this: `store.inbox()` returns the queued bucket in plain
       * list order, so a parent created before its children still lands after most of
       * them, and the section reads as eighteen rows saying "awaiting VP on STA-119"
       * with STA-119 last. Q1's CLI already prints gate holders first within the QUEUED
       * section; this keeps the tree agreeing with it.
       *
       * The inbox below hands the epic LAST on purpose — if the partition is dropped,
       * rank alone puts it last and this test fails.
       */
      const rows: IssueRow[] = [queued("k1", { status: "backlog" }), parked("epic"), queued("k2")];
      const index = buildPickupIndex(
        inbox(
          [],
          [],
          [
            entry({ id: "k1", status: "backlog" }),
            entry({ id: "k2" }),
            entry({ id: "epic", status: "awaiting_approval" }),
          ],
        ),
      );

      const gated = section(buildPickupGroups(rows, index), "pending_approval")!;
      expect(ids(gated.rows)).toEqual(["epic", "k1", "k2"]);
    });

    it("leaves the store's order intact WITHIN each half of that partition", () => {
      // The exception is a two-way split, not a re-sort. `k2` ranks ahead of `k1` in the
      // inbox and must still come first among the queued work.
      const rows: IssueRow[] = [queued("k1", { status: "backlog" }), queued("k2"), parked("epic")];
      const index = buildPickupIndex(
        inbox(
          [],
          [],
          [
            entry({ id: "epic", status: "awaiting_approval" }),
            entry({ id: "k2" }),
            entry({ id: "k1", status: "backlog" }),
          ],
        ),
      );

      const gated = section(buildPickupGroups(rows, index), "pending_approval")!;
      expect(ids(gated.rows)).toEqual(["epic", "k2", "k1"]);
    });

    it("does not reorder any OTHER section by status", () => {
      // The partition is scoped to `pending_approval`. Waiting must still be pure rank,
      // or this would be a global re-sort wearing a local disguise.
      const rows: IssueRow[] = [row({ id: "w1", status: "blocked" }), row({ id: "w2", status: "blocked" })];
      const index = buildPickupIndex(
        inbox([], [entry({ id: "w2", status: "blocked" }), entry({ id: "w1", status: "blocked" })]),
      );
      const waiting = section(buildPickupGroups(rows, index), "waiting")!;
      expect(ids(waiting.rows)).toEqual(["w2", "w1"]);
    });
  });

  it("puts done and cancelled in the resolved section, whatever the inbox says", () => {
    // Resolved rows are never in the inbox payload at all, so this must be decided first
    // or every one of them would fall through to the fallback.
    for (const status of ["done", "cancelled"] as const) {
      expect(pickupSectionOf(row({ id: "a", status }), EMPTY_PICKUP_INDEX)).toBe("resolved");
    }
  });

  it("never drops a row the inbox has not heard of — the race fallback", () => {
    // A ticket created between the issues fetch and the inbox fetch is in one and not the
    // other. Dropping it is the one thing a tracker must never do.
    expect(pickupSectionOf(row({ id: "ghost", status: "todo" }), EMPTY_PICKUP_INDEX)).toBe("up_next");
    // ...but a visibly blocked row must not be advertised as pickable.
    expect(pickupSectionOf(row({ id: "ghost", status: "blocked" }), EMPTY_PICKUP_INDEX)).toBe(
      "waiting",
    );
  });

  it("assigns every open row to exactly one section, with no leftovers", () => {
    const rows: IssueRow[] = [
      row({ id: "a", status: "todo" }),
      row({ id: "b", status: "in_progress" }),
      row({ id: "c", status: "blocked" }),
      row({ id: "d", status: "done" }),
      row({ id: "e", status: "backlog" }),
    ];
    const index = buildPickupIndex(
      inbox(
        [entry({ id: "a" }), entry({ id: "b", status: "in_progress" }), entry({ id: "e" })],
        [entry({ id: "c", status: "blocked" })],
      ),
    );

    const groups = buildPickupGroups(rows, index, { showResolved: true });
    const placed = groups.flatMap((g) => ids(g.rows));

    expect(placed.sort()).toEqual(["a", "b", "c", "d", "e"]);
    expect(new Set(placed).size).toBe(placed.length); // no row in two sections
  });
});

describe("order inside a section is the store's, not a re-sort", () => {
  it("follows the inbox sequence and IGNORES priority", () => {
    // The trap: priority is what tree-model.ts sorts by, so the tempting "consistency"
    // fix is to sort here too — which throws away dependency ordering, the only thing
    // /api/inbox was called for.
    const rows = [
      row({ id: "low", identifier: "STA-3", priority: "low" }),
      row({ id: "crit", identifier: "STA-1", priority: "critical" }),
    ];
    // The store says the low-priority one is next.
    const index = buildPickupIndex(inbox([entry({ id: "low" }), entry({ id: "crit" })]));

    const groups = buildPickupGroups(rows, index);
    expect(ids(section(groups, "up_next")!.rows)).toEqual(["low", "crit"]);
  });

  it("breaks ties between UNRANKED rows by identifier, so the 1.5s poll cannot make it twitch", () => {
    // Two rows the inbox never mentioned both rank Infinity. Subtracting those gives NaN —
    // a comparator that is not self-consistent and lets the list reorder on every rebuild.
    const rows = [row({ id: "b", identifier: "STA-10" }), row({ id: "a", identifier: "STA-9" })];
    const groups = buildPickupGroups(rows, EMPTY_PICKUP_INDEX);
    // Numeric-aware: STA-9 precedes STA-10.
    expect(ids(section(groups, "up_next")!.rows)).toEqual(["a", "b"]);
  });

  it("sorts a RANKED row ahead of an unranked one", () => {
    const rows = [row({ id: "ghost", identifier: "STA-1" }), row({ id: "known", identifier: "STA-9" })];
    const index = buildPickupIndex(inbox([entry({ id: "known" })]));
    const groups = buildPickupGroups(rows, index);
    // Identifier order would put STA-1 first; the store's ranking must win.
    expect(ids(section(groups, "up_next")!.rows)).toEqual(["known", "ghost"]);
  });
});

describe("the sections themselves", () => {
  it("renders in registry order and omits the empty ones", () => {
    const rows = [row({ id: "a", status: "todo" }), row({ id: "c", status: "blocked" })];
    const index = buildPickupIndex(inbox([entry({ id: "a" })], [entry({ id: "c", status: "blocked" })]));

    const groups = buildPickupGroups(rows, index);

    // No "In flight 0" header. A permanent count of nothing is furniture.
    expect(groups.map((g) => g.id)).toEqual(["up_next", "waiting"]);
  });

  it("counts what is IN the section, not what is rendered", () => {
    const rows = [row({ id: "a" }), row({ id: "b" })];
    const index = buildPickupIndex(inbox([entry({ id: "a" }), entry({ id: "b" })]));
    expect(section(buildPickupGroups(rows, index), "up_next")!.count).toBe(2);
  });

  it("attaches the waiting line to Waiting rows and to nothing else", () => {
    const rows = [row({ id: "a", status: "todo" }), row({ id: "c", status: "blocked" })];
    const index = buildPickupIndex(
      inbox(
        [entry({ id: "a" })],
        [
          entry({
            id: "c",
            status: "blocked",
            unblockOwner: "VP",
            unblockAction: "sign the contract",
            unresolvedBlockers: ["STA-4"],
          }),
        ],
      ),
    );

    const groups = buildPickupGroups(rows, index);

    // PROSE, not identifiers — since O6 the identifiers ride on the badge instead.
    expect(section(groups, "waiting")!.waitingOn.get("c")).toBe("waiting on VP: sign the contract");
    expect(section(groups, "up_next")!.waitingOn.size).toBe(0);
  });

  it("gives a purely dependency-blocked row NO caption at all — O6 (STA-138)", () => {
    /**
     * The measured shape of the real board: 33 of 36 Waiting captions were the
     * `blocked by STA-…` sentence, one of them eleven identifiers long. All of them are now
     * badges, so the Waiting section is captioned only where a human actually wrote a reason.
     */
    const rows = [row({ id: "c", status: "blocked" })];
    const index = buildPickupIndex(
      inbox([], [entry({ id: "c", status: "blocked", unresolvedBlockers: ["STA-4", "STA-5"] })]),
    );

    const waiting = section(buildPickupGroups(rows, index), "waiting")!;
    // The row is still IN Waiting — placement is unchanged, only the wording is gone.
    expect(waiting.rows).toHaveLength(1);
    expect(waiting.waitingOn.size).toBe(0);
  });
});

describe("done and cancelled obey V4's control and nothing else", () => {
  const rows = [row({ id: "a", status: "todo" }), row({ id: "d", status: "done" })];
  const index = buildPickupIndex(inbox([entry({ id: "a" })]));

  it("hides them by default", () => {
    const groups = buildPickupGroups(rows, index);
    expect(groups.map((g) => g.id)).toEqual(["up_next"]);
  });

  it("reveals them in a TRAILING section when the filter lets them through", () => {
    const groups = buildPickupGroups(rows, index, { showResolved: true });
    expect(groups.map((g) => g.id)).toEqual(["up_next", "resolved"]);
    // Trailing, always — finished work never sits above work you could start.
    expect(groups[groups.length - 1]!.id).toBe("resolved");
  });
});

describe("grouping arranges; it never decides membership", () => {
  it("places only the rows it was handed, however much the inbox knows about", () => {
    // The filter has already removed STA-2. Pickup mode must not resurrect it just
    // because the inbox still lists it as ready — that would make grouping a filter.
    const filtered = [row({ id: "a", identifier: "STA-1" })];
    const index = buildPickupIndex(inbox([entry({ id: "a" }), entry({ id: "b", identifier: "STA-2" })]));

    const groups = buildPickupGroups(filtered, index);
    expect(ids(section(groups, "up_next")!.rows)).toEqual(["a"]);
  });

  it("gives a row whose parent a filter removed a breadcrumb rather than dropping it", () => {
    const parent = issue({ id: "p", identifier: "STA-1", title: "The epic" });
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" })]));

    const groups = buildPickupGroups([child], index, {
      hiddenParents: new Map([["c", parent]]),
    });

    expect(section(groups, "up_next")!.rows[0]!.breadcrumb).toEqual({
      identifier: "STA-1",
      title: "The epic",
    });
  });

  it("renders as a FLAT queue — no nesting, because nesting moves a row off its rank", () => {
    const parent = row({ id: "p", identifier: "STA-1" });
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" }), entry({ id: "p" })]));

    const rendered = section(buildPickupGroups([parent, child], index), "up_next")!.rows;

    // The child ranks first and stays first, at depth 0, wearing its parent's chip.
    expect(ids(rendered)).toEqual(["c", "p"]);
    expect(rendered.every((r) => r.depth === 0 && !r.hasChildren)).toBe(true);
    expect(rendered[0]!.breadcrumb?.identifier).toBe("STA-1");
  });
});
