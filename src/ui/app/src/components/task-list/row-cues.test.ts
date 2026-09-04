/**
 * R4c (STA-188) — the join, as pure functions.
 *
 * Everything here is arithmetic over a `QueueView` and a list of rows. No DOM, no fetch, no
 * clock: the rendered half is in `row-render.test.tsx`, and keeping the two apart is what
 * lets the derivation be argued about at the level it is actually wrong at.
 *
 * The five properties worth a test, in the order they would break quietly:
 *
 *   1. `pickable` is ONE row — the resolver's first eligible — and everything eligible after
 *      it inside the plan is `queued`. Get this wrong and every row says "pickable", which
 *      looks fine and tells you nothing.
 *   2. A container takes the PLAN number and a leaf takes the EFFECTIVE one. They are
 *      different numbers and the queue contract keeps them apart.
 *   3. The five hard states come from the resolver's `eligibility`, not from a second
 *      derivation in the browser.
 *   4. Milestone membership is `milestonePath` — never `parentId` — and a container only
 *      inherits it when every effective row underneath agrees.
 *   5. An empty index is SILENCE, and returns the caller's own array.
 */
import { describe, expect, it } from "vitest";
import type {
  EffectiveQueueRow,
  IssueRow,
  QueueEntry,
  QueueView,
  RowCueState,
} from "@/lib/types";
import { row } from "./fixtures";
import {
  attachRowCues,
  buildRowCueIndex,
  EMPTY_ROW_CUE_INDEX,
  milestoneCueSentence,
  ROW_CUE_PRESENTATION,
  rowCueSentence,
  rowCueShort,
} from "./row-cues";

function effective(over: Partial<EffectiveQueueRow> & { identifier: string }): EffectiveQueueRow {
  return {
    issueId: `id-${over.identifier.split("-")[1]}`,
    title: "a task",
    kind: "task",
    status: "todo",
    position: 1,
    planPosition: 1,
    via: null,
    unqueued: false,
    eligibility: "eligible",
    reason: null,
    detail: null,
    dueAt: null,
    milestonePath: [],
    epicPath: [],
    parent: null,
    ...over,
  };
}

function entry(over: Partial<QueueEntry> & { identifier: string }): QueueEntry {
  return {
    issueId: `id-${over.identifier.split("-")[1]}`,
    title: "an epic",
    kind: "epic",
    status: "todo",
    planPosition: 1,
    rank: 1000,
    parent: null,
    resolved: false,
    addedBy: "VP",
    addedAt: "2026-09-01T00:00:00.000Z",
    note: null,
    ...over,
  };
}

function view(over: Partial<QueueView> = {}): QueueView {
  return { revision: 1, entries: [], effective: [], ...over };
}

/** The state of one identifier, as the index sees it. */
function stateOf(queue: QueueView, identifier: string, over: Partial<IssueRow["issue"]> = {}) {
  const index = buildRowCueIndex(queue);
  return index.cuesFor(row({ identifier, ...over }))?.pickup ?? null;
}

describe("pickable is the resolver's answer, not a predicate", () => {
  const queue = view({
    entries: [entry({ identifier: "STA-1", planPosition: 1 })],
    effective: [
      effective({ identifier: "STA-1", position: 1, planPosition: 1 }),
      effective({ identifier: "STA-2", position: 2, planPosition: 2 }),
      effective({ identifier: "STA-3", position: 3, planPosition: 3 }),
    ],
  });

  it("names exactly one row pickable — the first eligible one", () => {
    expect(stateOf(queue, "STA-1")?.state).toBe("pickable");
    expect(stateOf(queue, "STA-2")?.state).toBe("queued");
    expect(stateOf(queue, "STA-3")?.state).toBe("queued");
  });

  it("moves the word when the head of the queue is not takeable", () => {
    const held = view({
      effective: [
        effective({ identifier: "STA-1", position: 1, eligibility: "claimed", reason: "STA-1 is held by opus-x." }),
        effective({ identifier: "STA-2", position: 2 }),
      ],
    });

    expect(stateOf(held, "STA-1")?.state).toBe("in_flight");
    expect(stateOf(held, "STA-2")?.state).toBe("pickable");
  });

  it("gives a queued actionable row its EFFECTIVE position, not the plan's", () => {
    // Plan row 2 expanded to three leaves: the second leaf is effective #5, plan #2. The
    // number an agent acts on is 5.
    const expanded = view({
      entries: [entry({ identifier: "STA-9", planPosition: 2 })],
      effective: [
        effective({ identifier: "STA-1", position: 4, planPosition: 2, via: "STA-9", epicPath: ["STA-9"] }),
        effective({ identifier: "STA-2", position: 5, planPosition: 2, via: "STA-9", epicPath: ["STA-9"] }),
      ],
    });
    const cue = stateOf(expanded, "STA-2")!;

    expect(cue.state).toBe("queued");
    expect(cue.position).toBe(5);
    expect(cue.scope).toBe("effective");
    expect(rowCueShort(cue)).toBe("#5");
  });
});

describe("containers take the plan number", () => {
  const queue = view({
    entries: [entry({ identifier: "STA-9", planPosition: 2 })],
    effective: [
      effective({ identifier: "STA-1", position: 1, planPosition: 1 }),
      effective({ identifier: "STA-2", position: 2, planPosition: 2, via: "STA-9", epicPath: ["STA-9"] }),
    ],
  });

  it("reads a queued container's own plan row — never an invented effective position", () => {
    const cue = stateOf(queue, "STA-9", { kind: "epic" })!;

    expect(cue.state).toBe("queued");
    expect(cue.position).toBe(2);
    expect(cue.scope).toBe("plan");
    // The word is spelled out, because a container's number and a leaf's are different
    // numbers and a bare `#2` beside a leaf's `#5` would be unreadable.
    expect(rowCueShort(cue)).toBe("plan #2");
  });

  it("recovers an INTERMEDIATE container from the rows it was expanded into", () => {
    // Queue a milestone; the epic inside it is in neither `entries` nor `effective`, and
    // without the upward pass it would read "unqueued" directly above children reading #1.
    const nested = view({
      entries: [entry({ identifier: "STA-50", planPosition: 1, kind: "milestone" })],
      effective: [
        effective({
          identifier: "STA-2",
          position: 1,
          planPosition: 1,
          via: "STA-50",
          epicPath: ["STA-20"],
          milestonePath: ["STA-50"],
        }),
      ],
    });
    const cue = stateOf(nested, "STA-20", { kind: "epic" })!;

    expect(cue.state).toBe("queued");
    expect(cue.position).toBe(1);
    expect(cue.scope).toBe("plan");
  });

  it("takes the EARLIEST plan row a container's work sits at", () => {
    const spread = view({
      effective: [
        effective({ identifier: "STA-1", position: 1, planPosition: 7, epicPath: ["STA-9"] }),
        effective({ identifier: "STA-2", position: 2, planPosition: 3, epicPath: ["STA-9"] }),
      ],
    });

    expect(stateOf(spread, "STA-9", { kind: "epic" })?.position).toBe(3);
  });

  it("says unqueued for a container no plan row reaches", () => {
    expect(stateOf(queue, "STA-77", { kind: "epic" })?.state).toBe("unqueued");
  });
});

describe("the hard states are the resolver's eligibility, verbatim", () => {
  const cases: [EffectiveQueueRow["eligibility"], RowCueState | null][] = [
    ["gated", "gated"],
    ["blocked", "waiting"],
    ["claimed", "in_flight"],
    ["resolved", null],
  ];

  for (const [eligibility, expected] of cases) {
    it(`maps ${eligibility} to ${expected ?? "no cue"}`, () => {
      const queue = view({
        effective: [effective({ identifier: "STA-1", eligibility, reason: "because." })],
      });

      expect(stateOf(queue, "STA-1")?.state ?? null).toBe(expected);
    });
  }

  it("carries the resolver's sentence through to the cue", () => {
    const queue = view({
      effective: [
        effective({
          identifier: "STA-1",
          eligibility: "gated",
          reason: "STA-1 is queued behind STA-9, awaiting approval by VP.",
        }),
      ],
    });
    const cue = stateOf(queue, "STA-1")!;

    expect(cue.reason).toBe("STA-1 is queued behind STA-9, awaiting approval by VP.");
    // The word leads, then what it means, then the resolver's own reason.
    expect(rowCueSentence(cue)).toBe(
      `Gated — ${ROW_CUE_PRESENTATION.gated.hint} STA-1 is queued behind STA-9, awaiting approval by VP.`,
    );
  });

  it("gives a resolved row no cue at all, whatever the queue says", () => {
    const queue = view({ effective: [effective({ identifier: "STA-1" })] });

    expect(stateOf(queue, "STA-1", { status: "done" })).toBeNull();
  });

  it("tells the unqueued band apart from the plan", () => {
    const queue = view({
      effective: [
        effective({ identifier: "STA-1", position: 1, planPosition: 1 }),
        effective({ identifier: "STA-2", position: 2, planPosition: null, unqueued: true }),
      ],
    });
    const later = stateOf(queue, "STA-2")!;

    expect(later.state).toBe("unqueued");
    // No number: an unqueued row's position is an artefact of presentation sort, and
    // printing it would read as a place in a plan it is not in.
    expect(later.position).toBeNull();
    expect(rowCueShort(later)).toBe("");
  });
});

describe("milestone membership", () => {
  const titles = new Map([["STA-50", "Q4 launch"]]);
  const queue = view({
    effective: [
      effective({ identifier: "STA-1", position: 1, epicPath: ["STA-20"], milestonePath: ["STA-50"] }),
      effective({ identifier: "STA-2", position: 2, epicPath: ["STA-20"], milestonePath: ["STA-50"] }),
      effective({ identifier: "STA-3", position: 3, epicPath: ["STA-30"], milestonePath: [] }),
    ],
  });
  const index = buildRowCueIndex(queue, titles);

  it("marks a member and names the milestone from the list App already fetched", () => {
    expect(index.cuesFor(row({ identifier: "STA-1" }))?.milestone).toEqual({
      identifier: "STA-50",
      title: "Q4 launch",
    });
  });

  it("leaves a row under no milestone unmarked", () => {
    expect(index.cuesFor(row({ identifier: "STA-3" }))?.milestone ?? null).toBeNull();
  });

  it("lifts the marker onto a container when every row underneath agrees", () => {
    expect(index.cuesFor(row({ identifier: "STA-20", kind: "epic" }))?.milestone?.identifier).toBe(
      "STA-50",
    );
  });

  it("says nothing about a container whose descendants disagree", () => {
    const mixed = buildRowCueIndex(
      view({
        effective: [
          effective({ identifier: "STA-1", epicPath: ["STA-20"], milestonePath: ["STA-50"] }),
          effective({ identifier: "STA-2", epicPath: ["STA-20"], milestonePath: ["STA-51"] }),
        ],
      }),
      titles,
    );

    expect(mixed.cuesFor(row({ identifier: "STA-20", kind: "epic" }))?.milestone ?? null).toBeNull();
  });

  it("never marks a milestone with itself", () => {
    expect(index.cuesFor(row({ identifier: "STA-50" }))?.milestone ?? null).toBeNull();
  });

  it("still marks the row when the page has not listed the milestone — no name, no lie", () => {
    const unnamed = buildRowCueIndex(queue);

    expect(unnamed.cuesFor(row({ identifier: "STA-1" }))?.milestone).toEqual({
      identifier: "STA-50",
      title: null,
    });
    expect(milestoneCueSentence("STA-50", null)).toBe(
      "Planned under milestone STA-50 — open the milestone plan",
    );
  });
});

describe("silence, and the identity of the array", () => {
  it("draws nothing at all when there is no queue", () => {
    expect(buildRowCueIndex(null).size).toBe(0);
    expect(buildRowCueIndex(view()).size).toBe(0);
    expect(EMPTY_ROW_CUE_INDEX.cuesFor(row())).toBeNull();
  });

  it("hands back the caller's own array when there is nothing to join", () => {
    const rows = [row({ identifier: "STA-1" })];

    // Identity, not equality: a copy per poll would re-run every downstream memo in the
    // grouped views, which is exactly what "the grouped views pay nothing" has to mean.
    expect(attachRowCues(rows, EMPTY_ROW_CUE_INDEX)).toBe(rows);
  });

  it("attaches cues without touching anything else on the row", () => {
    const queue = view({ effective: [effective({ identifier: "STA-1" })] });
    const rows = [row({ identifier: "STA-1" })];
    const joined = attachRowCues(rows, buildRowCueIndex(queue));

    expect(joined[0]!.cues?.pickup?.state).toBe("pickable");
    expect(joined[0]!.issue).toBe(rows[0]!.issue);
    /*
     * `pickupState` and `pickupReason` stay reserved and untouched — see lib/types.ts, and
     * `filter-dimensions.ts` on why `queued` must stay unreachable from the browser until
     * the resolver itself sends the word.
     */
    expect(joined[0]!.pickupState).toBeUndefined();
    expect(joined[0]!.pickupReason).toBeUndefined();
  });

  /**
   * R4f (STA-246). THE SORT'S NUMBER IS THE CUE'S NUMBER, taken off the same join.
   *
   * `lib/sort-modes.ts` ranks by `IssueRow.queuePosition` and `/api/issues` does not send it,
   * so before this stamping the list could print `#5` on a row and order by nothing at all.
   */
  it("stamps the EFFECTIVE position it printed, and never the plan one", () => {
    const queue = view({
      entries: [entry({ identifier: "STA-1" })],
      effective: [
        effective({ identifier: "STA-2", position: 1, via: "STA-1", eligibility: "claimed" }),
        effective({ identifier: "STA-3", position: 2, via: "STA-1" }),
      ],
    });
    const rows = [row({ identifier: "STA-1" }), row({ identifier: "STA-2" }), row({ identifier: "STA-3" })];
    const joined = attachRowCues(rows, buildRowCueIndex(queue));
    const at = (identifier: string) => joined.find((r) => r.issue.identifier === identifier)!;

    // The leaf: the number beside its identifier is the number it sorts by.
    expect(at("STA-3").cues?.pickup?.position).toBe(2);
    expect(at("STA-3").queuePosition).toBe(2);

    /*
     * The container prints `plan #1` — a place in the PLAN, not in the sequence an agent
     * receives — so it stamps nothing. A sort that read it would be comparing two rulers,
     * which is what `plan #` is spelled out to prevent; the container's answer comes from
     * `subtreeQueuePositions` instead, on the effective scale, from the rows beneath it.
     */
    expect(at("STA-1").cues?.pickup?.scope).toBe("plan");
    expect(at("STA-1").queuePosition).toBeNull();
    expect(at("STA-1").planPosition).toBeUndefined();

    // And a row the queue has no number for — held, gated, waiting — has none to sort by.
    expect(at("STA-2").cues?.pickup?.state).toBe("in_flight");
    expect(at("STA-2").queuePosition).toBeNull();
  });
});

describe("the vocabulary", () => {
  it("gives every state its own glyph AND its own word", () => {
    const glyphs = Object.values(ROW_CUE_PRESENTATION).map((p) => p.glyph);
    const labels = Object.values(ROW_CUE_PRESENTATION).map((p) => p.label);

    expect(new Set(glyphs).size).toBe(glyphs.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("prints the word `next` for the one row that is", () => {
    expect(
      rowCueShort({ state: "pickable", position: 1, scope: "effective", reason: null }),
    ).toBe("next");
  });

  it("names the number it is printing", () => {
    expect(rowCueSentence({ state: "queued", position: 5, scope: "effective", reason: null })).toContain(
      "Queue position 5.",
    );
    expect(rowCueSentence({ state: "queued", position: 2, scope: "plan", reason: null })).toContain(
      "Plan position 2.",
    );
  });
});
