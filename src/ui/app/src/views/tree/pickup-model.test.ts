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

  it("NESTS a child under a parent that is in the same section — O8a (STA-149)", () => {
    /*
     * THE REGRESSION THIS FILE USED TO PIN. It asserted `["c", "p"]`, both at depth 0, the
     * child wearing a chip that pointed at a row one line below it — VP's screenshot, where
     * STA-25 and STA-40 sat side by side in Up next. The old reasoning was that nesting
     * moves a row off its rank; STA-148 answers that grouping is a presentation layer and
     * the same pair must read the same way on every axis. The child moves to its parent.
     */
    const parent = row({ id: "p", identifier: "STA-25" });
    const child = row({ id: "c", identifier: "STA-40", parentId: "p" });
    // The child ranks FIRST in the store's order and the parent second, which is the case
    // that makes the trade visible: the family is placed at the PARENT's rank.
    const index = buildPickupIndex(inbox([entry({ id: "c" }), entry({ id: "p" })]));

    const group = section(buildPickupGroups([parent, child], index), "up_next")!;

    expect(group.rows.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-25", 0],
      ["STA-40", 1],
    ]);
    // The elbow says whose child it is; the chip was standing in for an elbow it did not
    // have, and two ways of saying one thing is how they start disagreeing.
    expect(group.rows[1]!.breadcrumb).toBeNull();
    expect(group.rows[0]!.hasChildren).toBe(true);
    expect(group.rows[0]!.childCount).toBe(1);
    expect(group.rows[0]!.isExpanded).toBe(true);
    // Neither row is a ghost — both are real, ranked members of this section.
    expect(group.rows.some((r) => r.ghost)).toBe(false);
    // And the count still means "tasks in this section", nesting or no nesting.
    expect(group.count).toBe(2);
  });

  it("keeps the STORE's order among siblings, not the identifier's", () => {
    // STA-27/28 under STA-26. If the nesting ever starts sorting, this is what catches it:
    // the store ranks STA-28 ahead of STA-27 and the queue must say so.
    const parent = row({ id: "p", identifier: "STA-26" });
    const second = row({ id: "b", identifier: "STA-27", parentId: "p" });
    const first = row({ id: "a", identifier: "STA-28", parentId: "p" });
    const index = buildPickupIndex(
      inbox([entry({ id: "p" }), entry({ id: "a" }), entry({ id: "b" })]),
    );

    const rendered = section(
      buildPickupGroups([parent, second, first], index),
      "up_next",
    )!.rows;

    expect(rendered.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-26", 0],
      ["STA-28", 1],
      ["STA-27", 1],
    ]);
    // The elbow belongs to the last sibling and to nothing else.
    expect(rendered.map((r) => r.isLast)).toEqual([true, false, true]);
    expect(rendered.map((r) => r.guides)).toEqual([[], [true], [false]]);
  });

  it("nests inside the WAITING section too — STA-83 under STA-80", () => {
    // Both blocked, so both are in the same bucket by a different route than Up next's.
    const parent = row({ id: "p", identifier: "STA-80", status: "blocked" });
    const child = row({ id: "c", identifier: "STA-83", parentId: "p", status: "blocked" });
    const index = buildPickupIndex(
      inbox(
        [],
        [
          entry({ id: "p", status: "blocked", unblockOwner: "VP", unblockAction: "decide" }),
          entry({ id: "c", status: "blocked", unresolvedBlockers: ["STA-80"] }),
        ],
      ),
    );

    const group = section(buildPickupGroups([parent, child], index), "waiting")!;

    expect(group.rows.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-80", 0],
      ["STA-83", 1],
    ]);
    // The caption is a property of the ROW and survives the row acquiring a depth.
    expect(group.waitingOn.get("p")).toBe("waiting on VP: decide");
  });

  it("nests inside IN FLIGHT too — STA-120 under STA-119", () => {
    const parent = row({ id: "p", identifier: "STA-119" }, claim({ heldBy: "opus" }));
    const child = row({ id: "c", identifier: "STA-120", parentId: "p", status: "in_progress" });
    const index = buildPickupIndex(inbox([entry({ id: "p" }), entry({ id: "c" })]));

    const group = section(buildPickupGroups([parent, child], index), "in_flight")!;

    expect(group.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-119", 0, false],
      ["STA-120", 1, false],
    ]);
    // The real parent keeps its own liveness — it is not a ghost of itself.
    expect(group.rows[0]!.claim).not.toBeNull();
    expect(group.count).toBe(2);
  });

  it("nests to WHATEVER depth the family has, not one level", () => {
    const epic = row({ id: "e", identifier: "STA-1" });
    const mid = row({ id: "m", identifier: "STA-2", parentId: "e" });
    const leaf = row({ id: "l", identifier: "STA-3", parentId: "m" });
    const index = buildPickupIndex(
      inbox([entry({ id: "e" }), entry({ id: "m" }), entry({ id: "l" })]),
    );

    const rendered = section(buildPickupGroups([epic, mid, leaf], index), "up_next")!.rows;

    expect(rendered.map((r) => r.depth)).toEqual([0, 1, 2]);
    // One entry per ancestor level, each saying "does that ancestor have a sibling below
    // it". An only child is always last, so this chain draws no continuation lines at all.
    expect(rendered[2]!.guides).toEqual([false, false]);
    expect(rendered.map((r) => r.guides.length)).toEqual([0, 1, 2]);
  });

  it("still ghosts a parent that is in ANOTHER section, beside a family that is whole", () => {
    // The two rules coexist: nesting for the parent that is here, a ghost for the one that
    // is not. Getting one of them wrong is how the section would start drawing two trees.
    const here = row({ id: "p", identifier: "STA-25" });
    const mine = row({ id: "c", identifier: "STA-40", parentId: "p" });
    const held = row({ id: "h", identifier: "STA-80" }, claim({ heldBy: "opus" }));
    const orphan = row({ id: "o", identifier: "STA-83", parentId: "h" });
    const index = buildPickupIndex(
      inbox([
        entry({ id: "p" }),
        entry({ id: "c" }),
        entry({ id: "h" }),
        entry({ id: "o" }),
      ]),
    );

    const group = section(
      buildPickupGroups([here, mine, held, orphan], index),
      "up_next",
    )!;

    expect(group.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-25", 0, false],
      ["STA-40", 1, false],
      ["STA-80", 0, true],
      ["STA-83", 1, false],
    ]);
    // Three real rows are in Up next; the ghost is a bracket, not a fourth thing to pick up.
    expect(group.count).toBe(3);
  });

  it("folds a real parent when the user has folded it, and the count does not follow", () => {
    // The chevron nesting created has to do something, or it is the inert chevron STA-148
    // raises against ghosts, reproduced on a real row.
    const parent = row({ id: "p", identifier: "STA-25" });
    const child = row({ id: "c", identifier: "STA-40", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "p" }), entry({ id: "c" })]));

    const group = section(
      buildPickupGroups([parent, child], index, { isExpanded: (i) => i.id !== "p" }),
      "up_next",
    )!;

    expect(ids(group.rows)).toEqual(["p"]);
    expect(group.rows[0]!.isExpanded).toBe(false);
    expect(group.rows[0]!.childCount).toBe(1);
    // A count that followed what is rendered would say one task is up next. Two are.
    expect(group.count).toBe(2);
  });

  it("defaults to EXPANDED where the user has not chosen — the queue hides nothing", () => {
    const parent = row({ id: "p", identifier: "STA-25", status: "backlog" });
    const child = row({ id: "c", identifier: "STA-40", parentId: "p", status: "backlog" });
    const index = buildPickupIndex(inbox([entry({ id: "p" }), entry({ id: "c" })]));

    // `undefined` is "the user has not said", and the tree's status default would fold a
    // backlog parent here. Pickup's sections already do the folding; a second one would
    // hide ranked work nobody asked to hide.
    const rendered = section(
      buildPickupGroups([parent, child], index, { isExpanded: () => undefined }),
      "up_next",
    )!.rows;

    expect(ids(rendered)).toEqual(["p", "c"]);
  });

  it("draws the WHOLE missing ancestor chain, not only the nearest — O8b (STA-150)", () => {
    /*
     * The live case, and the reason this matters more in pickup mode than in the tree: a
     * section is a far coarser cut than a status group, so an epic and its sub-epic land in
     * different sections routinely. Waiting drew "STA-148" over three of its children while
     * STA-148's own parent STA-119 sat in In flight, unmentioned — "part of O8", where the
     * reader needed "part of O8, which is part of O".
     */
    const epic = row({ id: "e", identifier: "STA-119" }, claim({ heldBy: "opus" }));
    const sub = row({ id: "s", identifier: "STA-148", parentId: "e" }, claim({ heldBy: "opus" }));
    const child = row({ id: "c", identifier: "STA-150", parentId: "s", status: "blocked" });
    const index = buildPickupIndex(
      inbox(
        [entry({ id: "e" }), entry({ id: "s" })],
        [entry({ id: "c", status: "blocked", unresolvedBlockers: ["STA-149"] })],
      ),
    );

    const groups = buildPickupGroups([epic, sub, child], index);

    expect(
      section(groups, "waiting")!.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true]),
    ).toEqual([
      ["STA-119", 0, true],
      ["STA-148", 1, true],
      ["STA-150", 2, false],
    ]);
    // One task is waiting. The two brackets above it are not two more.
    expect(section(groups, "waiting")!.count).toBe(1);
    // Neither ghost carries the parent's own liveness — both real rows are full members of
    // In flight, and that is the single place their claims are written down.
    expect(section(groups, "waiting")!.rows.every((r) => r.claim === null)).toBe(true);
    expect(ids(section(groups, "in_flight")!.rows)).toEqual(["e", "s"]);
  });

  it("terminates a chain on a real row in the section, and shares it between families", () => {
    // STA-119 is here for real, so it is the terminator. Two sub-epics are not, so each
    // gets one ghost under it — not one per orphan, and not a second copy of STA-119.
    const epic = row({ id: "e", identifier: "STA-119" });
    const subA = row({ id: "a", identifier: "STA-148", parentId: "e" }, claim({ heldBy: "x" }));
    const subB = row({ id: "b", identifier: "STA-142", parentId: "e" }, claim({ heldBy: "x" }));
    const a1 = row({ id: "a1", identifier: "STA-150", parentId: "a" });
    const a2 = row({ id: "a2", identifier: "STA-151", parentId: "a" });
    const b1 = row({ id: "b1", identifier: "STA-154", parentId: "b" });
    const index = buildPickupIndex(
      inbox([
        entry({ id: "e" }),
        entry({ id: "a" }),
        entry({ id: "b" }),
        entry({ id: "a1" }),
        entry({ id: "a2" }),
        entry({ id: "b1" }),
      ]),
    );

    const group = section(
      buildPickupGroups([epic, subA, subB, a1, a2, b1], index),
      "up_next",
    )!;

    expect(group.rows.map((r) => [r.issue.identifier, r.depth, r.ghost === true])).toEqual([
      ["STA-119", 0, false],
      ["STA-148", 1, true],
      ["STA-150", 2, false],
      ["STA-151", 2, false],
      ["STA-142", 1, true],
      ["STA-154", 2, false],
    ]);
    expect(group.rows.filter((r) => r.ghost)).toHaveLength(2);
    expect(group.count).toBe(4);
    // `+N` on the real epic counts the three tickets the brackets hold, not the two
    // brackets — folding STA-119 takes three pieces of work off the page, not two rows.
    expect(group.rows[0]!.childCount).toBe(3);
  });

  it("does NOT nest in a container with no indent — the flat, chipped queue survives", () => {
    // `ghostParents` is `columns.disclosure` at the call site: the panel and popup presets
    // draw neither padding nor connectors, so a nested child would look exactly like a root
    // AND would have given up the chip that was standing in for the indent.
    const parent = row({ id: "p", identifier: "STA-25" });
    const child = row({ id: "c", identifier: "STA-40", parentId: "p" });
    const index = buildPickupIndex(inbox([entry({ id: "c" }), entry({ id: "p" })]));

    const rendered = section(
      buildPickupGroups([parent, child], index, { ghostParents: false }),
      "up_next",
    )!.rows;

    expect(rendered.map((r) => [r.issue.identifier, r.depth])).toEqual([
      ["STA-40", 0],
      ["STA-25", 0],
    ]);
    expect(rendered[0]!.breadcrumb?.identifier).toBe("STA-25");
    expect(rendered.every((r) => !r.hasChildren && !r.ghost)).toBe(true);
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
