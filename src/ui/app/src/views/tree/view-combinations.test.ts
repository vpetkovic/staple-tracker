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
import { DEFAULT_SORT, SORT_MODES, type SortPref } from "@/lib/sort-modes";
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
  withQueueFields,
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
   * DEFECT (reported, not fixed — this ticket touches no `src/**` production code).
   *
   * `BuildOptions.sort` in tree-model.ts says: "It applies inside every shape, not only the
   * flat one … a sort that silently stopped applying one menu entry away would be the kind
   * of inconsistency the Group control's own notes keep arguing against."
   *
   * It stops applying one menu entry away. `buildList`'s `"pickup"` case forwards
   * `showResolved`, `hiddenParents`, `ghostParents` and `isExpanded` to `buildPickupGroups`
   * and NOT `sort`, and `PickupBuildOptions` has no `sort` field to receive it, so the
   * pickup axis always orders by the inbox rank. Choosing "Sort: Title · A to Z" and then
   * grouping by Pickup order silently reverts to the store's order with the trigger still
   * reading "Title".
   *
   * Either behaviour is defensible — the pickup axis IS an order, and overriding it with a
   * title sort is arguably wrong — but the code and its own documentation disagree, and one
   * of the two has to move. Left as a todo because deciding which is a product call and the
   * fix is a `src/**` edit.
   */
  it.todo(
    "applies the chosen sort inside the pickup axis too — buildList drops `sort` for `buildPickupGroups`, contradicting BuildOptions.sort's own note",
  );
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

  it("sorts by the very numbers it prints, once the row carries them", () => {
    /*
     * The cue's number and the `queue` sort's number are the SAME number said twice, and the
     * only way to check that is to hand the sort the positions the queue published. See
     * `withQueueFields` — and see the todo below for why the live app cannot do this yet.
     */
    const served = withQueueFields(CUED);
    const shape = buildList(
      served,
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
    /*
     * ACROSS SCOPES it does not, and this is the assertion recording that — see the second
     * todo below. The cold epic carries PLAN #3 and the loner carries EFFECTIVE #4, the sort
     * compares the two numbers directly, and the epic wins even though the only queued work
     * beneath it is effective #5 — one place behind the row it was sorted above.
     */
    expect(identifiers(rows).filter((id) => ["STA-1", "STA-5", "STA-8"].includes(id))).toEqual([
      "STA-1",
      "STA-5",
      "STA-8",
    ]);
    expect(cueOf("STA-7")!.pickup!.state).toBe("queued");
    expect(cueOf("STA-6")!.pickup!.state).toBe("unqueued");
  });

  /**
   * DEFECT (reported, not fixed — no `src/**` edit in this ticket).
   *
   * On TODAY'S payload the "Queue position" sort mode is inert while the cues beside it are
   * fully populated, so the list can print "#5" on a row and then refuse to order by it.
   *
   * The two halves read different sources. `row-cues.ts` joins `GET /api/queue` in the
   * browser precisely because `/api/issues` does not send `queuePosition`/`planPosition`
   * yet; `lib/sort-modes.ts`'s `ownQueuePosition` reads only those two unsent fields. So
   * `queue` sort sees every row as unqueued, the partition step keeps them all in the
   * trailing band, and the order falls through to the tie-break chain — with the trigger
   * still reading "Sort: Queue position · Front of the queue first".
   *
   * The test above proves the two agree the moment the fields are served. The fix is one of
   * two `src/**` edits — serve the fields from `/api/issues`, or let the sort read the same
   * `RowCueIndex` the cues read — and both belong to a ticket that owns production code.
   */
  it.todo(
    "orders by the queue on today's payload — `queue` sort reads the unserved queuePosition/planPosition while the cue beside it reads GET /api/queue, so sorting by it does nothing",
  );

  /**
   * DEFECT (latent, reported, not fixed — reachable the day the fields above are served).
   *
   * `rowCueShort` prints `plan #2` rather than a bare `#2` because "a container's number and
   * a leaf's number are different numbers, and a reader who cannot tell which one they are
   * looking at cannot use either". The `queue` SORT does exactly what that sentence forbids:
   * `ownQueuePosition` is `queuePosition ?? planPosition`, so a container's PLAN index and a
   * leaf's EFFECTIVE index land in one comparison as if they were the same sequence.
   *
   * The assertion above is the demonstration: the cold epic (plan #3, holding effective #5)
   * sorts ABOVE the loner (effective #4). Plan indices are always the smaller numbers, so
   * the bias is systematic — containers ride to the top of a queue sort.
   */
  it.todo(
    "keeps plan positions and effective positions in separate scales when sorting — ownQueuePosition compares a container's plan index against a leaf's effective index",
  );
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
