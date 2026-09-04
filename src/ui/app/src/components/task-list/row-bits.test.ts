/**
 * V5 (STA-97) — the three pure helpers on the row, and the property each one has to keep.
 *
 * None of these is complicated. Each has exactly one way of failing that a reader would
 * never notice until it had been wrong for weeks:
 *
 *   - `labelHue` returning a different hue on a different machine or after a reload. The
 *     colour is a scanning aid: "the green one" has to mean the same label tomorrow. There
 *     is no label table to hang a colour off, so stability is a property of the FUNCTION.
 *   - `initials` producing three characters, or one, and quietly breaking an 18px circle.
 *   - `formatRowDate` printing a bare "Oct 9" for something from last year, which reads as
 *     six weeks old when it is fourteen months old.
 */
import { describe, expect, it } from "vitest";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import type { ClaimActivity, IssueStatus } from "@/lib/types";
import { LABEL_HUE_COUNT, labelHue, splitLabels } from "./label-hue";
import { initials } from "./avatar";
import { claim, row } from "./fixtures";
import { parentRollups, rollupSegmentOf } from "./model";
import { formatRowDate } from "./row-date";

describe("labelHue", () => {
  it("gives curated labels the colour people already expect", () => {
    expect(labelHue("bug")).toBe(1); // red
    expect(labelHue("regression")).toBe(1);
    expect(labelHue("security")).toBe(1);
    expect(labelHue("performance")).toBe(3); // green
    expect(labelHue("perf")).toBe(3);
    expect(labelHue("design")).toBe(6); // violet
    expect(labelHue("docs")).toBe(8); // slate
    expect(labelHue("feature")).toBe(5); // blue
  });

  it("is stable, case-insensitive and whitespace-insensitive", () => {
    expect(labelHue("Bug")).toBe(labelHue("bug"));
    expect(labelHue("  ux-polish  ")).toBe(labelHue("ux-polish"));
    // The whole point: a pure function of the string means every machine and every reload
    // agree without a registry, a migration, or a server round trip.
    expect(labelHue("ux-polish")).toBe(labelHue("ux-polish"));
  });

  it("always lands inside the eight-hue palette", () => {
    const samples = ["a", "zzz", "wave-2", "STA", "", "🙂", "a".repeat(200)];
    for (const s of samples) {
      const hue = labelHue(s);
      expect(hue).toBeGreaterThanOrEqual(1);
      expect(hue).toBeLessThanOrEqual(LABEL_HUE_COUNT);
      expect(Number.isInteger(hue)).toBe(true);
    }
  });

  it("spreads uncurated labels over more than one hue", () => {
    const hues = new Set(
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta"].map(labelHue),
    );
    expect(hues.size).toBeGreaterThan(2);
  });
});

describe("splitLabels", () => {
  it("keeps source order — the author's ordering is information", () => {
    expect(splitLabels(["zeta", "alpha"], 2)).toEqual({ shown: ["zeta", "alpha"], hidden: [] });
  });

  it("caps at max and puts the remainder in the overflow", () => {
    expect(splitLabels(["a", "b", "c", "d"], 2)).toEqual({ shown: ["a", "b"], hidden: ["c", "d"] });
  });

  it("hides everything when max is zero, so the caller can render bare dots instead", () => {
    expect(splitLabels(["a", "b"], 0)).toEqual({ shown: [], hidden: ["a", "b"] });
  });
});

describe("initials", () => {
  it("renders the spec's four worked examples", () => {
    expect(initials("opus-x")).toBe("OX");
    expect(initials("v5-designer")).toBe("VD");
    expect(initials("VP")).toBe("VP");
    expect(initials("claude")).toBe("CL");
  });

  it("never overflows the circle — hard cap of two characters", () => {
    // A single-character name legitimately yields one initial; what must never happen is
    // three, which is what an unbounded "first letter of every token" would produce for
    // `some-long-agent-name` and what would burst an 18px circle.
    for (const name of ["a", "a-b-c-d", "  spaced  out  ", "x_y", "3", "ünicode"]) {
      const out = initials(name);
      expect(out.length).toBeGreaterThanOrEqual(1);
      expect(out.length).toBeLessThanOrEqual(2);
      expect(out).toBe(out.toUpperCase());
    }
    expect(initials("a-b-c-d")).toBe("AB");
  });

  it("falls back rather than rendering an empty circle", () => {
    expect(initials("")).toBe("??");
    expect(initials("   ")).toBe("??");
  });
});

describe("formatRowDate", () => {
  const now = new Date("2026-09-02T12:00:00.000Z");

  it("uses the same duration vocabulary as the stale badge under a day", () => {
    expect(formatRowDate("2026-09-02T11:48:00.000Z", now)).toBe("12m");
    expect(formatRowDate("2026-09-02T09:00:00.000Z", now)).toBe("3h");
  });

  it("drops the year for an older date in the same calendar year", () => {
    expect(formatRowDate("2026-06-09T09:00:00.000Z", now)).toBe("Jun 9");
  });

  it("keeps the year once the calendar year differs — 'Oct 9' must not mean 14 months ago", () => {
    expect(formatRowDate("2025-10-09T09:00:00.000Z", now)).toBe("Oct 9, 2025");
  });
});

/**
 * ── THE PARENT ROLLUP — O3b (STA-127) ────────────────────────────────────────────────
 *
 * `parentRollups` is the arithmetic behind a folded epic's "3/5" and its four-segment bar,
 * and it is pure, so this is where it is pinned. Six ways it could quietly become wrong:
 *
 *   1. Counting DIRECT children instead of every descendant, so an epic whose work lives one
 *      level further down reads as empty.
 *   2. Counting a CANCELLED child — either as done, which claims credit for abandoned work,
 *      or as an unreachable denominator, so a finished epic renders permanently short of full.
 *   3. The segments not summing to `total`. The bar is drawn from the segments alone, so a
 *      remainder is a bar that cannot fill or one that overflows its own track.
 *   4. Animating for a STALE descendant claim: a pulse at 60fps over an agent that died four
 *      hours ago, which is worse than no pulse at all.
 *   5. A non-deterministic holder pick. The view rebuilds every 1.5s off the fingerprint
 *      poll; two live children swapping initials on each rebuild reads as the row twitching.
 *   6. Falling off the table for a status O7a let a workspace configure.
 */
describe("rollupSegmentOf", () => {
  it("folds the seven built-ins into the bar's four segments", () => {
    expect(rollupSegmentOf("done")).toBe("done");
    expect(rollupSegmentOf("in_progress")).toBe("in_progress");
    // In review is work in flight, not a fifth segment. Four buckets on a 36px bar is a
    // reading; seven is a texture.
    expect(rollupSegmentOf("in_review")).toBe("in_progress");
    expect(rollupSegmentOf("blocked")).toBe("blocked");
    expect(rollupSegmentOf("todo")).toBe("open");
    expect(rollupSegmentOf("backlog")).toBe("open");
  });

  it("excludes cancelled entirely rather than calling it done", () => {
    expect(rollupSegmentOf("cancelled")).toBeNull();
  });

  it("prefers a configured CATEGORY over the built-in id, so O7 cannot break the bar", () => {
    // O7a made statuses data. A workspace `qa` status in the `review` category has to land
    // in `in_progress` even though no id table has ever heard of it.
    const configured: Record<string, string> = {
      qa: "review",
      parked: "gated",
      shipped: "done",
      scrapped: "cancelled",
    };
    const categoryOf = (status: IssueStatus) => configured[status] ?? null;

    expect(rollupSegmentOf("qa" as IssueStatus, categoryOf)).toBe("in_progress");
    expect(rollupSegmentOf("parked" as IssueStatus, categoryOf)).toBe("blocked");
    expect(rollupSegmentOf("shipped" as IssueStatus, categoryOf)).toBe("done");
    expect(rollupSegmentOf("scrapped" as IssueStatus, categoryOf)).toBeNull();
    // And it overrides the built-ins too — a workspace that recategorised `blocked` as
    // `active` gets `in_progress`, not the id table's answer.
    expect(rollupSegmentOf("blocked", () => "active")).toBe("in_progress");
  });

  it("puts an unrecognised status in `open` — never silently out of the denominator", () => {
    // A count that quietly shrinks is worse than a coarse bucket: the reader has no way to
    // tell "5 items, one uncategorised" from "4 items".
    expect(rollupSegmentOf("qa" as IssueStatus)).toBe("open");
    expect(rollupSegmentOf("todo", () => "unheard_of")).toBe("open");
  });
});

describe("parentRollups", () => {
  /** `issue()` derives `id-N` from the identifier, so a parent is addressable by hand. */
  const kid = (
    identifier: string,
    parentId: string | null,
    status: IssueStatus,
    activity: ClaimActivity | null = null,
  ) => row({ identifier, parentId, status }, activity);

  const epic = (identifier: string, status: IssueStatus = "in_progress") =>
    row({ identifier, status });

  it("counts every DESCENDANT, not only direct children", () => {
    const rows = [
      epic("STA-1"),
      kid("STA-2", "id-1", "in_progress"),
      kid("STA-3", "id-2", "done"), // grandchild of STA-1
      kid("STA-4", "id-3", "done"), // great-grandchild
    ];
    const rollups = parentRollups(rows);

    // An epic's progress is the progress of everything under it. A task is not less
    // finished for being one level further down.
    expect(rollups.get("id-1")).toMatchObject({ total: 3, resolved: 2 });
    // And the intermediate parents are rolled up on the SAME pass, not on a second walk.
    expect(rollups.get("id-2")).toMatchObject({ total: 2, resolved: 2 });
    expect(rollups.get("id-3")).toMatchObject({ total: 1, resolved: 1 });
  });

  it("gives a leaf no entry at all, which is not the same as a zeroed one", () => {
    const rollups = parentRollups([epic("STA-1"), kid("STA-2", "id-1", "todo")]);

    expect(rollups.has("id-1")).toBe(true);
    // The row renders NOTHING for a leaf. A present-but-empty rollup would draw a bar
    // claiming an epic has no children.
    expect(rollups.has("id-2")).toBe(false);
  });

  it("segments sum to total, so the bar is drawable with no remainder", () => {
    const roll = parentRollups([
      epic("STA-1"),
      kid("STA-2", "id-1", "done"),
      kid("STA-3", "id-1", "in_progress"),
      kid("STA-4", "id-1", "in_review"),
      kid("STA-5", "id-1", "blocked"),
      kid("STA-6", "id-1", "todo"),
      kid("STA-7", "id-1", "backlog"),
    ]).get("id-1")!;

    expect(roll.segments).toEqual({ done: 1, in_progress: 2, blocked: 1, open: 2 });
    expect(Object.values(roll.segments).reduce((a, b) => a + b, 0)).toBe(roll.total);
    expect(roll.total).toBe(6);
    expect(roll.resolved).toBe(roll.segments.done);
  });

  it("drops a cancelled child from BOTH the numerator and the denominator", () => {
    const roll = parentRollups([
      epic("STA-1"),
      kid("STA-2", "id-1", "done"),
      kid("STA-3", "id-1", "cancelled"),
      kid("STA-4", "id-1", "todo"),
    ]).get("id-1")!;

    // Not 2/3 — that is credit for abandoned work. Not 1/3 either: that is a denominator
    // the epic can never reach, so a finished epic would render permanently short of full.
    expect(roll).toMatchObject({ resolved: 1, total: 2 });
    expect(Object.values(roll.segments).reduce((a, b) => a + b, 0)).toBe(2);
  });

  it("names a LIVE descendant claim, and the child it belongs to", () => {
    const rows = [
      epic("STA-1"),
      kid("STA-2", "id-1", "in_progress", claim({ heldBy: "opus-x", idleSeconds: 30 })),
    ];

    // The identifier rides along because the accessible name has to say WHICH child is
    // live; "opus-x is working" on a parent row is indistinguishable from its own claim.
    expect(parentRollups(rows).get("id-1")!.live).toEqual({
      heldBy: "opus-x",
      identifier: "STA-2",
    });
  });

  it("reports NOTHING for a stale descendant claim — not a static variant, nothing", () => {
    const stale = [
      epic("STA-1"),
      kid("STA-2", "id-1", "in_progress", claim({ idleSeconds: STALE_CLAIM_SECONDS })),
    ];
    const fresh = [
      epic("STA-1"),
      kid("STA-2", "id-1", "in_progress", claim({ idleSeconds: STALE_CLAIM_SECONDS - 1 })),
    ];

    // The one threshold, `lib/claim.ts`'s, shared with the working pill and the takeover
    // buttons. A second one spelled here would let the two disagree about one claim — and
    // the boundary is asserted from BOTH sides so it stays the store's and not a guess.
    expect(parentRollups(stale).get("id-1")!.live).toBeNull();
    expect(parentRollups(fresh).get("id-1")!.live?.identifier).toBe("STA-2");
  });

  it("picks the most recently active live child, deterministically", () => {
    const rows = [
      epic("STA-1"),
      kid("STA-2", "id-1", "in_progress", claim({ heldBy: "opus-a", idleSeconds: 600 })),
      kid("STA-3", "id-1", "in_progress", claim({ heldBy: "opus-b", idleSeconds: 12 })),
      kid("STA-4", "id-1", "in_progress", claim({ heldBy: "opus-c", idleSeconds: 900 })),
    ];

    expect(parentRollups(rows).get("id-1")!.live?.heldBy).toBe("opus-b");
    // If input order could change the answer, the initials would swap on every 1.5s poll.
    expect(parentRollups([...rows].reverse()).get("id-1")!.live?.heldBy).toBe("opus-b");
  });

  it("breaks an exact tie on the identifier, numerically", () => {
    const tied = (identifier: string, heldBy: string) =>
      kid(identifier, "id-1", "in_progress", claim({ heldBy, idleSeconds: 42 }));
    const rows = [epic("STA-1"), tied("STA-10", "opus-ten"), tied("STA-9", "opus-nine")];

    // STA-9 before STA-10 — the same numeric-aware comparison the sort uses, not the
    // lexicographic one, which would answer STA-10 and disagree with the list order.
    expect(parentRollups(rows).get("id-1")!.live?.heldBy).toBe("opus-nine");
    expect(parentRollups([...rows].reverse()).get("id-1")!.live?.heldBy).toBe("opus-nine");
  });

  it("still reports a live claim on a child whose status is not counted", () => {
    const roll = parentRollups([
      epic("STA-1"),
      kid("STA-2", "id-1", "cancelled", claim({ heldBy: "opus-x", idleSeconds: 5 })),
    ]).get("id-1")!;

    // Excluded from the arithmetic, still worth the dot: an agent inside a cancelled ticket
    // is exactly the handoff risk this indicator exists to surface.
    expect(roll.total).toBe(0);
    expect(roll.live?.heldBy).toBe("opus-x");
  });

  it("terminates on a parent cycle the store should never have produced", () => {
    const rows = [kid("STA-1", "id-2", "todo"), kid("STA-2", "id-1", "todo")];
    const rollups = parentRollups(rows);

    // The claim is TERMINATION and a BOUNDED count, not a meaningful one: in a cycle every
    // row is its own ancestor, so both rows land under both ids and each reads 2 of 2. A
    // hang, by contrast, renders nothing at all — strictly worse than two odd rows.
    expect(rollups.get("id-1")!.total).toBe(2);
    expect(rollups.get("id-2")!.total).toBe(2);
    expect(rollups.get("id-1")!.resolved).toBe(0);
  });

  it("counts what it is GIVEN — which is why the caller hands it the unfiltered list", () => {
    const all = [
      epic("STA-1"),
      kid("STA-2", "id-1", "done"),
      kid("STA-3", "id-1", "done"),
      kid("STA-4", "id-1", "done"),
      kid("STA-5", "id-1", "todo"),
      kid("STA-6", "id-1", "in_progress"),
    ];
    const onScreen = all.filter((r) => r.issue.status !== "done");

    // The whole reason `BuildOptions.rollupSource` exists. Computed over what survives the
    // default filter, the same epic reads 0/2 — not a partial answer, the wrong one.
    expect(parentRollups(all).get("id-1")).toMatchObject({ resolved: 3, total: 5 });
    expect(parentRollups(onScreen).get("id-1")).toMatchObject({ resolved: 0, total: 2 });
  });
});

/**
 * ── THE ROLLED-UP PLAN — R7c (STA-194) ───────────────────────────────────────────────
 *
 * The list payload carries no `timing`, so `parentRollups` re-derives a folded parent's
 * plan in the browser — with the ONE rule of `SubtreePlan` in core/types.ts: an issue
 * contributes its own estimate if it has one, otherwise its children's contributions, never
 * both. Pinned on the shape that started the epic — STA-156 over an unestimated STA-157
 * over three planned tasks — so the row can never disagree with the Analytics headline.
 */
describe("parentRollups: the plan", () => {
  const planned = (identifier: string, parentId: string | null, estimatedSeconds: number | null) =>
    row({ identifier, parentId, status: "todo", estimatedSeconds });

  /** STA-1 ⊃ STA-2 (neither estimated) ⊃ 4h, 3h, 4h. */
  const nested = () => [
    planned("STA-1", null, null),
    planned("STA-2", "id-1", null),
    planned("STA-3", "id-2", 14_400),
    planned("STA-4", "id-2", 10_800),
    planned("STA-5", "id-2", 14_400),
  ];

  it("carries 11h up through an unestimated middle epic — the STA-156 complaint", () => {
    const rollups = parentRollups(nested());
    expect(rollups.get("id-2")!.plan).toEqual({ estimatedSeconds: 39_600, source: "descendants" });
    expect(rollups.get("id-1")!.plan).toEqual({ estimatedSeconds: 39_600, source: "descendants" });
  });

  it("lets an own estimate shadow everything beneath it, and never adds the two", () => {
    const rows = nested();
    rows[1] = planned("STA-2", "id-1", 21_600);
    const rollups = parentRollups(rows);
    expect(rollups.get("id-2")!.plan).toEqual({ estimatedSeconds: 21_600, source: "own" });
    // Not 39_600 (the grandchildren) and not 61_200 (both): the middle epic's own 6h is
    // its whole term in its parent's sum.
    expect(rollups.get("id-1")!.plan).toEqual({ estimatedSeconds: 21_600, source: "descendants" });
  });

  it("is null, not zero, when nobody estimated anything", () => {
    const rollups = parentRollups([planned("STA-1", null, null), planned("STA-2", "id-1", null)]);
    expect(rollups.get("id-1")!.plan).toEqual({ estimatedSeconds: null, source: "none" });
  });

  it("sums the partial coverage it has — one planned child of three is that child's figure", () => {
    const rollups = parentRollups([
      planned("STA-1", null, null),
      planned("STA-2", "id-1", 3600),
      planned("STA-3", "id-1", null),
      planned("STA-4", "id-1", null),
    ]);
    expect(rollups.get("id-1")!.plan).toEqual({ estimatedSeconds: 3600, source: "descendants" });
  });

  it("makes a parent's plan exactly the sum of its direct children's plans", () => {
    // Own and inherited side by side: STA-2 typed 6h over a 4h leaf, STA-3 inherits 3h
    // from its leaf, STA-4 is a bare leaf. The parent's figure is what its children show.
    const rows = [
      planned("STA-1", null, null),
      planned("STA-2", "id-1", 21_600),
      planned("STA-6", "id-2", 14_400),
      planned("STA-3", "id-1", null),
      planned("STA-7", "id-3", 10_800),
      planned("STA-4", "id-1", null),
    ];
    const rollups = parentRollups(rows);
    const shown = rows
      .filter((r) => r.issue.parentId === "id-1")
      .reduce(
        (sum, r) => sum + (rollups.get(r.issue.id)?.plan.estimatedSeconds ?? r.issue.estimatedSeconds ?? 0),
        0,
      );
    expect(shown).toBe(32_400);
    expect(rollups.get("id-1")!.plan.estimatedSeconds).toBe(shown);
  });
});
