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

/** One workspace's payload. `ready` order IS the store's pickup order — never re-sorted. */
function inbox(ready: InboxIssue[], blocked: InboxIssue[] = []): InboxRow[] {
  return [{ workspace: "staple", inbox: { ready, blocked, hasMore: false } }];
}

const ids = (rows: readonly { issue: { id: string } }[]) => rows.map((r) => r.issue.id);
/** Generic, so it hands back the group's real type rather than flattening it to `{id}`. */
const section = <T extends { id: string }>(groups: readonly T[], id: string): T | undefined =>
  groups.find((g) => g.id === id);

describe("the section registry", () => {
  it("orders the sections the way the ticket specifies", () => {
    expect(PICKUP_SECTION_ORDER).toEqual(["up_next", "in_flight", "waiting", "resolved"]);
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

  it("draws a GHOST of the parent a filter removed, rather than a chip or nothing", () => {
    const parent = issue({ id: "p", identifier: "STA-1", title: "The epic" });
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" })]));

    const groups = buildPickupGroups([child], index, {
      hiddenParents: new Map([["c", parent]]),
    });
    const rows = section(groups, "up_next")!.rows;

    expect(rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-1", 0, true],
      ["STA-2", 1, false],
    ]);
    // The chip is what the ghost replaces — the parent is the row directly above now.
    expect(rows[1]!.breadcrumb).toBeNull();
    // The bracket is not a queue item: one row is ready to pick up, not two.
    expect(section(groups, "up_next")!.count).toBe(1);
  });

  it("draws ONE ghost for several orphaned siblings, at the best one's rank", () => {
    const parent = issue({ id: "p", identifier: "STA-1", title: "The epic" });
    const rows = [
      row({ id: "x", identifier: "STA-9" }),
      row({ id: "a", identifier: "STA-2", parentId: "p" }),
      row({ id: "b", identifier: "STA-3", parentId: "p" }),
    ];
    // The store's order: STA-9 first, then the two orphans.
    const index = buildPickupIndex(
      inbox([entry({ id: "x" }), entry({ id: "a" }), entry({ id: "b" })]),
    );

    const rendered = section(
      buildPickupGroups(rows, index, { hiddenParents: new Map([["a", parent], ["b", parent]]) }),
      "up_next",
    )!.rows;

    // STA-9 keeps rank 0. The ghost appears where its FIRST-RANKED orphan was, and the
    // second orphan is lifted under it rather than every row being moved to make room.
    expect(rendered.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-9", 0],
      ["STA-1", 0],
      ["STA-2", 1],
      ["STA-3", 1],
    ]);
    expect(rendered.filter((r) => r.ghost)).toHaveLength(1);
    expect(rendered[1]!.childCount).toBe(2);
  });

  it("carries NO rollup on a pickup ghost — no row in this view has one", () => {
    const parent = issue({ id: "p", identifier: "STA-1" });
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" })]));

    const rows = section(
      buildPickupGroups([child], index, { hiddenParents: new Map([["c", parent]]) }),
      "up_next",
    )!.rows;

    // A ghost that alone showed a progress count would read as a different KIND of object
    // rather than as the same object dimmed.
    expect(rows.every((r) => r.rollup === null)).toBe(true);
  });

  it("still renders a FLAT queue for a parent that IS in the section", () => {
    // The ghost is only ever for a parent with no rank HERE. A parent that has one keeps
    // it: nesting a real, ranked row moves it off its rank, and a dependency-ordered
    // queue whose items are not in order has stopped being a queue.
    const parent = row({ id: "p", identifier: "STA-1" });
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" }), entry({ id: "p" })]));

    const rendered = section(buildPickupGroups([parent, child], index), "up_next")!.rows;

    // The child ranks first and stays first, at depth 0, wearing its parent's chip.
    expect(ids(rendered)).toEqual(["c", "p"]);
    expect(rendered.every((r) => r.depth === 0 && !r.hasChildren && !r.ghost)).toBe(true);
    expect(rendered[0]!.breadcrumb?.identifier).toBe("STA-1");
  });

  it("draws a ghost for a parent that landed in ANOTHER section", () => {
    // STA-1 is held, so it is In flight; its child is free, so it is Up next. The child's
    // section gets the bracket; the parent's own section is untouched.
    const parent = row({ id: "p", identifier: "STA-1" }, claim({ heldBy: "opus" }));
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "p" }), entry({ id: "c" })]));

    const groups = buildPickupGroups([parent, child], index);

    expect(
      section(groups, "up_next")!.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true]),
    ).toEqual([
      ["STA-1", 0, true],
      ["STA-2", 1, false],
    ]);
    expect(section(groups, "up_next")!.count).toBe(1);
    // The ghost carries none of the parent's own liveness — that belongs to the real row,
    // which is still a full member of In flight.
    expect(section(groups, "up_next")!.rows[0]!.claim).toBeNull();
    expect(section(groups, "in_flight")!.rows.map((r) => [r.issue.identifier, r.ghost === true]))
      .toEqual([["STA-1", false]]);
  });

  it("turns the ghost off for a container with no indent, and the chip comes back", () => {
    const parent = issue({ id: "p", identifier: "STA-1", title: "The epic" });
    const child = row({ id: "c", identifier: "STA-2", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" })]));

    const rows = section(
      buildPickupGroups([child], index, {
        hiddenParents: new Map([["c", parent]]),
        ghostParents: false,
      }),
      "up_next",
    )!.rows;

    expect(rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-2", 0, false],
    ]);
    expect(rows[0]!.breadcrumb).toEqual({ identifier: "STA-1", title: "The epic" });
  });
});
