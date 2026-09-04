/**
 * R4e (STA-190) — THE SEAMS BETWEEN R4a, R4b, R4c AND R4d.
 *
 * Four tickets shipped four features onto one list in one sprint: eight sort modes, eleven
 * filter dimensions, two row cues and five grouping axes. Each landed green. What no one of
 * them could test is the PRODUCT of the four, and that is where a list quietly goes wrong —
 * not "sorting is broken" but "sorting is fine until you group by epic", not "the filter is
 * broken" but "the count under the filter counts the ghost".
 *
 * Every test below is over ONE board (`drift-fixture.ts`) and is a pure model call: no
 * rendering, no clock, no storage. The rendered halves of this ticket are in
 * `view-a11y.test.tsx` and `view-responsive.test.tsx`, and they read the same board, so a
 * claim proved here is a claim about the thing on the screen.
 *
 * WHAT IS DELIBERATELY NOT RE-PROVED HERE. `lib/sort-modes.test.ts` already walks every
 * mode's primary key, both directions, the involution, the no-two-rows-tied property and the
 * byte-exact default; `lib/filter-dimensions.test.ts` and `components/filters/
 * filters-render.test.tsx` already walk the eleven dimensions one at a time; `tree-model.
 * test.ts` already pins placement, ghosts and the epic-axis rhythm. Restating any of that
 * would be a second copy that drifts. What is here is only what needs TWO of them at once.
 */
import { describe, expect, it } from "vitest";
import { attachRowCues, buildRowCueIndex } from "@/components/task-list/row-cues";
import type { TaskRow } from "@/components/task-list";
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import {
  activeFilterChips,
  applyFilterDimensions,
  buildFilterContext,
  countActiveFilters,
  explainNoMatches,
  filterDimensionOptions,
  type FilterContext,
} from "@/lib/filter-dimensions";
import { emptyFilters, hiddenParents, type FilterState } from "@/lib/filters";
import {
  DEFAULT_SORT,
  effectiveQueuePosition,
  ownQueuePosition,
  SORT_MODES,
  subtreeQueuePositions,
  type SortPref,
} from "@/lib/sort-modes";
import type { GroupBy } from "@/lib/view-prefs";
import type { IssueRow } from "@/lib/types";
import {
  CUSTOM_KIND,
  driftInbox,
  driftMilestones,
  driftMilestoneTitles,
  driftQueue,
  driftRows,
  EXPECTED_CUES,
  MILESTONE,
  withGate,
} from "./drift-fixture";
import { buildPickupIndex } from "./pickup-model";
import { buildList, sectionsOf, visibleOrder, type BuildOptions, type ListShape } from "./tree-model";

/** The board, with the gate sibling on, which is the shape the live list is handed. */
const BOARD = withGate(driftRows());
const PICKUP = buildPickupIndex(driftInbox());
const CONTEXT: FilterContext = {
  ...buildFilterContext(BOARD),
  milestones: driftMilestones(),
};

/** Every axis the Group control offers, so a sixth cannot be added and left untested. */
const AXES: readonly GroupBy[] = ["none", "status", "pickup", "parent", "kind"];

/**
 * The options every call shares. `isExpanded: () => undefined` is the honest default — no
 * user has clicked anything — so each shape supplies ITS OWN default expansion, which is the
 * behaviour under test rather than one the test imposed.
 */
function opts(over: Partial<BuildOptions> = {}): BuildOptions {
  return { isExpanded: () => undefined, showResolved: false, rollupSource: BOARD, ...over };
}

const shapeOf = (rows: IssueRow[], groupBy: GroupBy, over: Partial<BuildOptions> = {}): ListShape =>
  buildList(rows, groupBy, opts(over), PICKUP);

/** `key -> the identifiers that are MEMBERS of it`, ghosts excluded. Flat mode is one bucket. */
function membership(shape: ListShape): Record<string, string[]> {
  if (shape.kind === "flat") {
    return { __flat__: shape.rows.filter((r) => !r.ghost).map((r) => r.issue.identifier) };
  }
  return Object.fromEntries(
    sectionsOf(shape).map((section) => [
      section.key,
      section.rows.filter((r) => !r.ghost).map((r) => r.issue.identifier),
    ]),
  );
}

/** `key -> the count the header PRINTS`. Not `rows.length`: see `StatusGroup.count`. */
function counts(shape: ListShape): Record<string, number> {
  if (shape.kind === "flat") return { __flat__: shape.rows.filter((r) => !r.ghost).length };
  // The key is `status` on a grouped shape and `id` on a pickup one; `sectionsOf` already
  // knows which, so the count is zipped onto its keys rather than re-deriving them.
  const sections = sectionsOf(shape);
  const totals = shape.kind === "grouped" ? shape.groups : shape.groups;
  return Object.fromEntries(sections.map((section, index) => [section.key, totals[index]!.count]));
}

const identifiers = (rows: readonly TaskRow[]) => rows.map((r) => r.issue.identifier);

/** Every row that is drawn anywhere in the shape, in page order, ghosts included. */
function drawn(shape: ListShape): TaskRow[] {
  if (shape.kind === "flat") return shape.rows;
  return sectionsOf(shape).flatMap((section) => section.rows);
}

describe("the board is what the fixture says it is", () => {
  /*
   * A fixture this many tests depend on has to state itself, or a later edit to it turns
   * every assertion below into a claim about something else without failing anything.
   */
  it("carries the nine rows, the two epics, the custom kind, the gate and the stale claim", () => {
    expect(BOARD.map((r) => r.issue.identifier)).toEqual([
      "STA-1",
      "STA-2",
      "STA-3",
      "STA-4",
      "STA-5",
      "STA-6",
      "STA-7",
      "STA-8",
      "STA-9",
    ]);
    expect(BOARD.filter((r) => r.issue.kind === "epic").map((r) => r.issue.identifier)).toEqual([
      "STA-1",
      "STA-5",
    ]);
    expect(BOARD.find((r) => r.issue.identifier === "STA-7")!.issue.kind).toBe(CUSTOM_KIND);
    expect(BOARD.find((r) => r.issue.identifier === "STA-3")!.gate?.state).toBe("pending");
    expect(BOARD.find((r) => r.issue.identifier === "STA-2")!.claim!.idleSeconds).toBeLessThan(
      STALE_CLAIM_SECONDS,
    );
    expect(
      BOARD.find((r) => r.issue.identifier === "STA-4")!.claim!.idleSeconds,
    ).toBeGreaterThanOrEqual(STALE_CLAIM_SECONDS);
  });

  it("opens one epic and folds the other, with nobody having clicked anything", () => {
    // The "collapsed and expanded children" the ticket asks for, produced by the SHAPE's own
    // default rather than by a seeded storage entry — which is the state a first-time reader
    // actually meets.
    const flat = shapeOf(BOARD, "none");
    const rows = flat.kind === "flat" ? flat.rows : [];
    const epicOrder = rows.find((r) => r.issue.identifier === "STA-1")!;
    const epicCold = rows.find((r) => r.issue.identifier === "STA-5")!;

    expect(epicOrder.isExpanded).toBe(true);
    expect(epicCold.isExpanded).toBe(false);
    // The folded one still declares what it is hiding, both ways.
    expect(epicCold.childCount).toBe(2);
    expect(epicCold.rollup).not.toBeNull();
  });
});

/**
 * ══ SORT × GROUP ═══════════════════════════════════════════════════════════════════════
 *
 * The claim is precise, and it is the only one that survives all five axes: a sort is a
 * statement about ORDER and about nothing else. Which section a row is in, how many rows a
 * header counts and which parent a row hangs under are all decided before any comparator
 * runs, and a mode that reached any of them would be a mode that hides work.
 *
 * `tree-model.test.ts` makes this claim for the status axis over three flat rows. Here it is
 * over a nested board with ghosts, a custom kind, a gate and a resolved row, on all five.
 */
describe("every sort mode, on every group axis", () => {
  const BASELINE = Object.fromEntries(
    AXES.map((axis) => [axis, shapeOf(BOARD, axis, { sort: DEFAULT_SORT })]),
  ) as Record<GroupBy, ListShape>;

  for (const axis of AXES) {
    describe(`group by ${axis}`, () => {
      const base = BASELINE[axis];

      it("keeps section membership and counts identical under all sixteen preferences", () => {
        const expectedMembers = membership(base);
        const expectedCounts = counts(base);

        for (const mode of SORT_MODES) {
          for (const direction of ["asc", "desc"] as const) {
            const sort: SortPref = { mode: mode.id, direction };
            const shape = shapeOf(BOARD, axis, { sort });
            const label = `${axis}/${mode.id}/${direction}`;

            // The SET of sections, and the SET of rows in each — order is what sorting is
            // allowed to change, so it is compared sorted.
            const actual = membership(shape);
            expect(Object.keys(actual).sort(), label).toEqual(Object.keys(expectedMembers).sort());
            for (const [key, members] of Object.entries(expectedMembers)) {
              expect([...actual[key]!].sort(), `${label} · ${key}`).toEqual([...members].sort());
            }
            expect(counts(shape), label).toEqual(expectedCounts);
          }
        }
      });

      it("keeps every child under its own parent, at its own depth", () => {
        /*
         * Sorting orders SIBLINGS. The failure this catches is a comparator applied to the
         * flattened output instead of to each sibling list — which produces a plausible
         * looking page where a child sits above its parent at depth 1, bracketed by nothing.
         */
        for (const mode of SORT_MODES) {
          const shape = shapeOf(BOARD, axis, { sort: { mode: mode.id, direction: "desc" } });
          for (const row of drawn(shape)) {
            if (row.depth === 0) continue;
            const parentId = row.issue.parentId;
            expect(parentId, `${axis}/${mode.id} · ${row.issue.identifier}`).not.toBeNull();
            const above = drawn(shape).slice(0, drawn(shape).indexOf(row));
            const parent = [...above].reverse().find((r) => r.issue.id === parentId);
            expect(parent, `${axis}/${mode.id} · ${row.issue.identifier} has no parent above it`)
              .toBeDefined();
            expect(parent!.depth, `${axis}/${mode.id} · ${row.issue.identifier}`).toBe(row.depth - 1);
          }
        }
      });

      it("publishes the same navigable rows whatever the order", () => {
        // `visibleOrder` is what the detail drawer's prev/next arrows page through. A sort
        // that added or dropped an entry would make the arrows land on a row the keyboard
        // says is not there.
        const expected = visibleOrder(base, () => false)
          .map((s) => s.ref)
          .sort();
        for (const mode of SORT_MODES) {
          const shape = shapeOf(BOARD, axis, { sort: { mode: mode.id, direction: "asc" } });
          expect(
            visibleOrder(shape, () => false)
              .map((s) => s.ref)
              .sort(),
            `${axis}/${mode.id}`,
          ).toEqual(expected);
        }
      });
    });
  }

  it("does change the ORDER — otherwise the four blocks above prove nothing", () => {
    /*
     * The counterweight. Every assertion above is an invariance claim, and invariance
     * claims are trivially satisfied by a sort that does nothing at all. This is the one
     * that would fail if `BuildOptions.sort` stopped being read.
     */
    const titled = shapeOf(BOARD, "none", { sort: { mode: "title", direction: "asc" } });
    const reversed = shapeOf(BOARD, "none", { sort: { mode: "title", direction: "desc" } });
    const forward = identifiers(titled.kind === "flat" ? titled.rows : []);
    const backward = identifiers(reversed.kind === "flat" ? reversed.rows : []);

    expect(forward).not.toEqual(backward);
    // Top-level rows, alphabetically: "Backlog epic", "Ordering and cues", "Write the…".
    expect(forward.filter((id) => ["STA-1", "STA-5", "STA-8"].includes(id))).toEqual([
      "STA-5",
      "STA-1",
      "STA-8",
    ]);
    // And on the epic axis the SECTIONS reorder too, by the same comparator.
    const byTitle = shapeOf(BOARD, "parent", { sort: { mode: "title", direction: "asc" } });
    expect(sectionsOf(byTitle).map((s) => s.key)).toEqual(["epic-cold", "epic-order", "__no_epic__"]);
  });

  /**
   * R4f (STA-246), the first of the three defects R4e recorded.
   *
   * `BuildOptions.sort` says: "It applies inside every shape, not only the flat one … a sort
   * that silently stopped applying one menu entry away would be the kind of inconsistency the
   * Group control's own notes keep arguing against." It stopped one menu entry away:
   * `buildList` forwarded four options to `buildPickupGroups` and not `sort`.
   *
   * THE PRODUCT CALL, now made and pinned here. The store's rank is what this axis hands the
   * registry as its ACTIVITY TIER, so:
   *
   *   - the default mode still renders the store's dependency-ordered sequence, unchanged;
   *   - `activity · desc` renders the back of that sequence first, a reading it never had;
   *   - every other mode is a key the reader named, and the sections order by it.
   */
  it("applies the chosen sort inside the pickup axis too, and its default IS the store's order", () => {
    const section = (over: Partial<BuildOptions>) => {
      const shape = buildList(BOARD, "pickup", opts({ isExpanded: () => true, ...over }), PICKUP);
      return identifiers(sectionsOf(shape).find((s) => s.key === "up_next")!.rows);
    };

    /*
     * THE DEFAULT IS THE RANK. `driftInbox`'s ready bucket is the loner, the research task,
     * then the two in-progress rows — the store's order, which no client-side tier would
     * reproduce — and asking for `activity` explicitly gives back exactly what asking for
     * nothing does. That is what makes "the sort now reaches this axis" cost the queue nothing.
     */
    const unsorted = section({});
    expect(unsorted).toEqual(section({ sort: DEFAULT_SORT }));
    expect(unsorted.filter((id) => ["STA-7", "STA-8"].includes(id))).toEqual(["STA-8", "STA-7"]);

    /*
     * A KEY THE READER NAMED, and the direction with it. Alphabetically the cold epic leads
     * and the loner is last; descending, siblings swap at EVERY depth while a parent still
     * precedes its own children — which is the same thing sorting means in the flat view, and
     * is why the axis had to take the comparator rather than a reversal of its own.
     */
    expect(section({ sort: { mode: "title", direction: "asc" } })).toEqual([
      "STA-5",
      "STA-6",
      "STA-7",
      "STA-8",
    ]);
    expect(section({ sort: { mode: "title", direction: "desc" } })).toEqual([
      "STA-8",
      "STA-5",
      "STA-7",
      "STA-6",
    ]);

    // AND ON THE DEFAULT MODE, direction now reads the queue backwards: the store's first
    // ready row goes last, which is a reading this axis simply did not have before.
    expect(
      section({ sort: { mode: "activity", direction: "desc" } }).filter((id) =>
        ["STA-7", "STA-8"].includes(id),
      ),
    ).toEqual(["STA-7", "STA-8"]);
  });
});

/**
 * ══ FILTER COMBINATIONS ════════════════════════════════════════════════════════════════
 *
 * One dimension at a time is `lib/filter-dimensions.test.ts`'s job and it does it. What that
 * file cannot ask is whether the HIERARCHY and the NUMBERS survive two or three at once —
 * and the numbers are the half nobody notices is wrong, because a count is plausible in a
 * way a missing row is not.
 */
describe("filter combinations keep the hierarchy and the counts", () => {
  const filters = (over: Partial<FilterState> = {}): FilterState => ({ ...emptyFilters(), ...over });

  /** The whole `TreeView` pipeline for one filter state, on one axis. */
  function view(state: FilterState, axis: GroupBy = "status") {
    const visible = applyFilterDimensions(BOARD, state, CONTEXT);
    const shape = buildList(
      visible,
      axis,
      opts({ hiddenParents: hiddenParents(visible, BOARD) }),
      PICKUP,
    );
    return { visible, shape };
  }

  it("draws BOTH filtered-away parents as ghosts, each bracketing its own child", () => {
    /*
     * The milestone contains one child of each epic and neither epic. Two epics vanish, two
     * children survive, and the two survivors belong to DIFFERENT parents — so a ghost rule
     * that handles "the missing parent" rather than "each missing parent" fails here and
     * passes every existing single-parent test.
     */
    const { visible, shape } = view(filters({ dims: { milestone: [MILESTONE.identifier] } }));
    expect(visible.map((r) => r.issue.identifier)).toEqual(["STA-2", "STA-7"]);

    const rows = drawn(shape);
    const ghosts = rows.filter((r) => r.ghost).map((r) => r.issue.identifier);
    expect(ghosts.sort()).toEqual(["STA-1", "STA-5"]);
    for (const child of ["STA-2", "STA-7"]) {
      const row = rows.find((r) => r.issue.identifier === child)!;
      expect(row.depth, child).toBe(1);
      // The chip is what the ghost REPLACES — saying it twice would be two answers to one
      // question, one as an indent and one as a token pointing at the row above.
      expect(row.breadcrumb, child).toBeNull();
    }
  });

  it("never counts a ghost — the header says how many rows the filter LET THROUGH", () => {
    const { shape } = view(filters({ dims: { milestone: [MILESTONE.identifier] } }));
    const total = Object.values(counts(shape)).reduce((a, b) => a + b, 0);
    expect(total).toBe(2);
    // Two ghosts are drawn and neither is in the total above.
    expect(drawn(shape).filter((r) => r.ghost)).toHaveLength(2);
  });

  it("holds the same ghost rule on every axis that has an indent to nest into", () => {
    for (const axis of ["status", "parent", "kind", "pickup"] as const) {
      const { shape } = view(filters({ dims: { milestone: [MILESTONE.identifier] } }), axis);
      const rows = drawn(shape);
      expect(
        rows.filter((r) => r.ghost).map((r) => r.issue.identifier).sort(),
        axis,
      ).toEqual(["STA-1", "STA-5"]);
      expect(
        rows.filter((r) => !r.ghost).map((r) => r.issue.identifier).sort(),
        axis,
      ).toEqual(["STA-2", "STA-7"]);
    }
  });

  it("composes THREE dimensions and still lands on the rows all three agree about", () => {
    // Epic ∩ kind ∩ status. Each is satisfiable alone; the conjunction is one row.
    const state = filters({
      dims: { epic: ["STA-5"], kind: [CUSTOM_KIND], status: ["todo"] },
    });
    const { visible, shape } = view(state);

    expect(visible.map((r) => r.issue.identifier)).toEqual(["STA-7"]);
    expect(countActiveFilters(state)).toBe(3);
    expect(activeFilterChips(state, CONTEXT)).toHaveLength(3);
    // Its epic is gone, so the epic comes back as a bracket and the row keeps its depth.
    expect(drawn(shape).map((r) => [r.issue.identifier, r.ghost === true])).toEqual([
      ["STA-5", true],
      ["STA-7", false],
    ]);
  });

  it("agrees with the number the MENU printed beside every option, on every dimension", () => {
    /*
     * The menu's count is what a reader chooses on: "Epic: Backlog epic (3)" is a promise
     * about what clicking it produces. It is computed by the dimension's own `options`,
     * while the page is produced by `applyFilterDimensions` — two code paths, one number,
     * and nothing but a test standing between them.
     */
    for (const id of ["status", "kind", "priority", "assignee", "pickup", "milestone", "epic"]) {
      for (const option of filterDimensionOptions(id, BOARD, CONTEXT)) {
        const selected = filters({ dims: { [id]: [option.value] }, showDone: true });
        const rows = applyFilterDimensions(BOARD, selected, CONTEXT);
        expect(rows.length, `${id}=${option.value}`).toBe(option.count);
      }
    }
  });

  it("explains an empty page with the number that dimension would actually restore", () => {
    /*
     * `queued` is unreachable from the browser's fallback by design (it is a claim about the
     * plan's order, which a page of rows cannot make), so this combination is empty. The
     * sentence has to name the dimension worth removing AND be right about the count, or it
     * sends the reader to remove the wrong chip.
     */
    const state = filters({ dims: { milestone: [MILESTONE.identifier], pickup: ["queued"] } });
    expect(applyFilterDimensions(BOARD, state, CONTEXT)).toHaveLength(0);

    const explanation = explainNoMatches(BOARD, state, CONTEXT);
    expect(explanation.impossible).toBe(false);
    expect(explanation.dimensions).toEqual(["pickup"]);
    expect(explanation.sentence).toContain("Pickup state (2)");
    // And "(2)" is the truth: dropping the pickup chip leaves the milestone's two members.
    expect(
      applyFilterDimensions(BOARD, filters({ dims: { milestone: [MILESTONE.identifier] } }), CONTEXT),
    ).toHaveLength(2);
  });

  it("calls an impossible pair impossible rather than merely empty", () => {
    const state = filters({ dims: { status: ["done"], pickup: ["pickable"] }, showDone: true });
    const explanation = explainNoMatches(BOARD, state, CONTEXT);

    expect(explanation.impossible).toBe(true);
    expect(explanation.sentence).toContain("cannot both be true");
    // The board HAS a done row and HAS pickable rows; it is the conjunction that cannot
    // exist, which is exactly the distinction the sentence is making.
    expect(BOARD.some((r) => r.issue.status === "done")).toBe(true);
  });
});

/**
 * ══ MILESTONE × QUEUE ══════════════════════════════════════════════════════════════════
 *
 * STA-7 is the row both features point at: a member of `M-1` and position 5 of the effective
 * queue, under an epic that is in neither. Everything the reader is told about it comes from
 * three different places — the milestones payload, the queue payload and the tree — and this
 * is where they have to agree.
 */
describe("a queued milestone member, cued and sorted", () => {
  const CUED = attachRowCues(BOARD, buildRowCueIndex(driftQueue(), driftMilestoneTitles()));
  const cueOf = (identifier: string) => CUED.find((r) => r.issue.identifier === identifier)!.cues;

  /** R4f (STA-246). The two directions of the mode under test, named once. */
  const QUEUE_ASC: SortPref = { mode: "queue", direction: "asc" };
  const QUEUE_DESC: SortPref = { mode: "queue", direction: "desc" };

  /** The flat page, expanded, in one order — the cold epic's children have to be on it. */
  const queueOrder = (rows: IssueRow[], sort: SortPref): string[] => {
    const shape = buildList(rows, "none", opts({ isExpanded: () => true, sort }));
    return identifiers(shape.kind === "flat" ? shape.rows : []);
  };

  it("gives every row on the board the state the queue actually published", () => {
    for (const [identifier, expected] of Object.entries(EXPECTED_CUES)) {
      const cue = cueOf(identifier)?.pickup;
      expect(cue, identifier).not.toBeNull();
      expect(
        { state: cue!.state, position: cue!.position, scope: cue!.scope },
        identifier,
      ).toEqual(expected);
    }
    // The resolved row is the one that gets no cue at all: finished work is not waiting.
    expect(cueOf("STA-9")?.pickup ?? null).toBeNull();
  });

  it("marks the two members and names the milestone, and marks nothing else", () => {
    expect(cueOf("STA-2")!.milestone).toEqual({ identifier: "M-1", title: MILESTONE.title });
    expect(cueOf("STA-7")!.milestone).toEqual({ identifier: "M-1", title: MILESTONE.title });
    for (const other of ["STA-3", "STA-4", "STA-6", "STA-8"]) {
      expect(cueOf(other)?.milestone ?? null, other).toBeNull();
    }
    // The epic above STA-7 holds one member and one non-member, so it inherits NOTHING —
    // silence is the honest answer when the rows underneath disagree.
    expect(cueOf("STA-5")?.milestone ?? null).toBeNull();
  });

  it("carries the cue through every grouping axis, unchanged", () => {
    /*
     * The join runs once, over the unfiltered list, BEFORE grouping. So a cue is a property
     * of the row and not of the bucket it landed in, and the one thing the flatten pass owes
     * it is not to drop it — which is the failure this catches, on all five axes at once.
     */
    for (const axis of AXES) {
      // Expanded on purpose: the cold epic folds by default on three of the five axes, and
      // the question here is whether a cue SURVIVES the flatten, not whether the row is on
      // the page. The folded case is the last block in this file.
      const shape = buildList(CUED, axis, opts({ isExpanded: () => true }), PICKUP);
      const row = drawn(shape).find((r) => r.issue.identifier === "STA-7" && !r.ghost)!;
      expect(row.cues?.pickup?.position, axis).toBe(5);
      expect(row.cues?.milestone?.identifier, axis).toBe("M-1");
    }
  });

  it("gives a GHOST no cue — a bracket around rows is not a row an agent could take", () => {
    const visible = applyFilterDimensions(
      CUED,
      { ...emptyFilters(), dims: { milestone: [MILESTONE.identifier] } },
      CONTEXT,
    );
    const shape = buildList(
      visible,
      "status",
      opts({ hiddenParents: hiddenParents(visible, CUED) }),
      PICKUP,
    );
    for (const ghost of drawn(shape).filter((r) => r.ghost)) {
      expect(ghost.cues, ghost.issue.identifier).toBeNull();
    }
    // The real row keeps its own, so the filter cost the page nothing it was telling.
    expect(drawn(shape).find((r) => r.issue.identifier === "STA-7" && !r.ghost)!.cues?.pickup
      ?.position).toBe(5);
  });

  it("sorts by the very numbers it prints, on today's payload", () => {
    /*
     * R4f (STA-246). The cue's number and the `queue` sort's number are the SAME number said
     * twice — `attachRowCues` stamps `queuePosition` off the cue it just built — so this
     * reads `CUED` itself rather than a fixture that pretends `/api/issues` grew a field.
     * Nothing about the payload changed; the join did.
     */
    const shape = buildList(
      CUED,
      "none",
      // Expanded, so the cold epic's two children are on the page to be compared.
      opts({ isExpanded: () => true, sort: { mode: "queue", direction: "asc" } }),
      PICKUP,
    );
    const rows = shape.kind === "flat" ? shape.rows : [];

    /*
     * ONLY THE ROWS THAT PRINT A NUMBER HAVE ONE TO SORT BY. The three hard states — gated,
     * waiting and in flight — carry `position: null` deliberately (`RowPickupCue`), so the
     * order epic's three children have nothing to order by and fall through to the tie-break
     * chain. That is the correct reading: the queue's own answer for them is "not now"
     * rather than a place in the sequence.
     */
    for (const held of ["STA-2", "STA-3", "STA-4"]) {
      expect(cueOf(held)!.pickup!.position, held).toBeNull();
    }
    // Inside the cold epic the queued member precedes the unqueued sibling, which is
    // the ticket's own case: one cue says "#5", the other says "unqueued", and the order
    // agrees with both.
    expect(identifiers(rows).filter((id) => ["STA-6", "STA-7"].includes(id))).toEqual([
      "STA-7",
      "STA-6",
    ]);
    expect(cueOf("STA-7")!.pickup!.state).toBe("queued");
    expect(cueOf("STA-6")!.pickup!.state).toBe("unqueued");
  });

  /**
   * R4f (STA-246), the second of the three defects R4e recorded — the mode was INERT.
   *
   * `row-cues.ts` joined `GET /api/queue` in the browser because `/api/issues` does not send
   * `queuePosition`; `lib/sort-modes.ts` read only that unsent field. So every row looked
   * unqueued, the partition kept them all in the trailing band, and the order fell through to
   * the tie-break chain with the trigger still reading "Sort: Queue position".
   *
   * ONE SOURCE, not two that agree today: the join stamps the field off the cue it just
   * built. The proof is a difference — the same board, the same options, joined and not.
   */
  it("orders by the queue on today's payload, and orders by nothing without the join", () => {
    /*
     * UNJOINED, the mode cannot see the queue at all, so its own tie-break chain decides and
     * the answer is the `activity` order — which is precisely the silence being fixed: the
     * list is in an order, it is just not the one the trigger names.
     */
    const blind = queueOrder(BOARD, QUEUE_ASC);
    const joined = queueOrder(CUED, QUEUE_ASC);
    expect(blind).not.toEqual(joined);

    // JOINED, the top of the list is the front of the plan: the row the resolver would hand
    // out next (#4), then the epic holding #5, then the rows the queue has no number for.
    expect(joined.filter((id) => ["STA-1", "STA-5", "STA-8"].includes(id))).toEqual([
      "STA-8",
      "STA-5",
      "STA-1",
    ]);
    // And direction reaches it: "back of the queue first" is a different list, not the same
    // one, which is what an inert mode would have produced in both directions.
    expect(queueOrder(CUED, QUEUE_DESC)).not.toEqual(joined);
  });

  /**
   * R4f (STA-246), the third defect — ONE SCALE, and it is the effective one.
   *
   * `rowCueShort` prints `plan #2` rather than a bare `#2` because "a container's number and
   * a leaf's number are different numbers, and a reader who cannot tell which one they are
   * looking at cannot use either". `ownQueuePosition` was `queuePosition ?? planPosition`,
   * which did exactly what that sentence forbids, and plan indices are always the smaller
   * numbers — so containers rode to the top of every queue sort, systematically.
   *
   * The scale now: a row sorts by the EFFECTIVE position its own cue prints, a container by
   * the earliest effective position among the rows it holds, and a row the queue has no
   * number for sorts last in both directions.
   */
  it("ranks a container by the earliest EFFECTIVE position beneath it, never by its plan index", () => {
    const cold = CUED.find((r) => r.issue.identifier === "STA-5")!;
    const loner = CUED.find((r) => r.issue.identifier === "STA-8")!;

    // What the two rows PRINT: two different rulers, and the epic's is the smaller number.
    expect(cold.cues!.pickup).toMatchObject({ scope: "plan", position: 3 });
    expect(loner.cues!.pickup).toMatchObject({ scope: "effective", position: 4 });

    // What they SORT by: the plan index is not read at all, and the epic takes the earliest
    // effective position beneath it — STA-7's #5, one place BEHIND the loner it used to
    // outrank on the strength of a number from another sequence.
    expect(ownQueuePosition(cold)).toBeNull();
    expect(ownQueuePosition(loner)).toBe(4);
    const subtree = subtreeQueuePositions(CUED);
    expect(effectiveQueuePosition(cold, subtree)).toBe(5);

    const order = queueOrder(CUED, QUEUE_ASC);
    expect(order.indexOf("STA-8")).toBeLessThan(order.indexOf("STA-5"));

    /*
     * The order epic holds three rows the queue has no number for — claimed, gated, claimed —
     * so nothing beneath it is takeable and it joins the trailing band, PLAN #1 and all. That
     * is the honest reading of one scale: a plan position is not a place in the sequence.
     */
    expect(effectiveQueuePosition(CUED.find((r) => r.issue.identifier === "STA-1")!, subtree))
      .toBeNull();
  });
});

/**
 * ══ COLLAPSED EPICS ════════════════════════════════════════════════════════════════════
 *
 * A folded epic is the one row on the page that is hiding something, and it is the row where
 * three features overlap: the rollup says what is under it, the cue says where it sits in
 * the plan, and the fold says both have to survive without the children.
 */
describe("a collapsed epic keeps its rollup and its cue", () => {
  const CUED = attachRowCues(BOARD, buildRowCueIndex(driftQueue(), driftMilestoneTitles()));
  const folded = (axis: GroupBy) =>
    buildList(CUED, axis, opts({ isExpanded: () => false }), PICKUP);

  it("counts DESCENDANTS in the unfiltered list, not the rows the fold removed", () => {
    const shape = folded("none");
    const epic = drawn(shape).find((r) => r.issue.identifier === "STA-1")!;

    expect(epic.isExpanded).toBe(false);
    // Four descendants — three open and one done — and the done one is counted even though
    // the default filter has taken it off the page. A rollup over the visible rows would
    // say 0/3, which is not a partial answer, it is the wrong one.
    expect(epic.rollup).toMatchObject({ resolved: 1, total: 4 });
    // `+N` is a different number on purpose: DIRECT children that survived into this bucket.
    expect(epic.childCount).toBe(3);
  });

  it("keeps the plan cue on the fold, on every axis", () => {
    for (const axis of AXES) {
      const epic = drawn(folded(axis)).find((r) => r.issue.identifier === "STA-1" && !r.ghost)!;
      expect(epic.isExpanded, axis).toBe(false);
      expect(epic.cues?.pickup, axis).toMatchObject({ state: "queued", position: 1, scope: "plan" });
    }
  });

  it("keeps the rollup on the four axes that draw one, and on the fifth by design draws none", () => {
    for (const axis of ["none", "status", "parent", "kind"] as const) {
      const epic = drawn(folded(axis)).find((r) => r.issue.identifier === "STA-1" && !r.ghost)!;
      expect(epic.rollup?.total, axis).toBe(4);
      expect(epic.rollup?.resolved, axis).toBe(1);
    }
    /*
     * Pickup mode carries "no rollup on anything" — pickup-model.ts says so in as many
     * words, and it is a decision rather than an omission: the section already answers
     * "what is ready", and a progress bar on a queue row answers a question the queue is
     * not being asked. Asserted so that the exception stays deliberate.
     */
    const inPickup = drawn(folded("pickup")).find((r) => r.issue.identifier === "STA-1")!;
    expect(inPickup.rollup).toBeNull();
    // It still declares what it is hiding, so the fold is not silent there either.
    expect(inPickup.childCount).toBeGreaterThan(0);
  });

  it("takes the folded children out of the navigable order and leaves the counts alone", () => {
    const open = buildList(CUED, "status", opts({ isExpanded: () => true }), PICKUP);
    const shut = folded("status");

    expect(visibleOrder(open, () => false).length).toBeGreaterThan(
      visibleOrder(shut, () => false).length,
    );
    // The header's count is not `rows.length` — folding a group must not make it say zero.
    expect(counts(shut)).toEqual(counts(open));
  });

  it("gives the cold epic the position it inherits from the one queued row beneath it", () => {
    // STA-5 has no plan row of its own. Its number is the smallest plan position among the
    // effective rows that name it, which is STA-7's — so a container never reads "unqueued"
    // directly above a child reading "#5".
    const epic = drawn(folded("none")).find((r) => r.issue.identifier === "STA-5")!;
    expect(epic.cues?.pickup).toMatchObject({ state: "queued", position: 3, scope: "plan" });
  });
});
