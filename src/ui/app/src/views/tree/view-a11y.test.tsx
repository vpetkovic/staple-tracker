/**
 * R4e (STA-190) — WHAT A SCREEN READER HEARS ABOUT THE LIST'S STATE.
 *
 * R4 made the list's state a set of CHOICES: an order, a set of filters, a fold, and a cue
 * per row saying where the work sits in the plan. Every one of those is announced by a glyph
 * and a colour to a sighted reader, and each therefore has a second implementation for
 * everybody else — an `aria-label`, an `sr-only` sentence, an `aria-expanded`. Those second
 * implementations are exactly the kind that break silently, because nothing on the screen
 * changes when they do.
 *
 * Rendered to a string with `react-dom/server`, like every component test in this repo:
 * there is no jsdom here, and every claim below is about which elements exist and what their
 * accessible names say, which is precisely what a string can answer.
 *
 * THE BOARD IS `drift-fixture.ts` — the same one `view-combinations.test.ts` proves the model
 * over. So "STA-7 is queued at #5" is proved there as a fact about the model and here as a
 * sentence a screen reader reads out, and the two cannot drift apart.
 *
 * ── WHAT IS DELIBERATELY NOT RE-PROVED ────────────────────────────────────────────────
 *
 * `sort-by-menu.test.tsx` already pins the trigger sentence and the two radiogroups;
 * `filters-render.test.tsx` already pins that every dimension is in the menu;
 * `row-render.test.tsx` and `row-cues.test.ts` already pin one cue's markup and the
 * vocabulary as strings. What is here is the part none of them can be: the whole state of
 * one page, announced, with the four surfaces in the same render.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { attachRowCues, buildRowCueIndex } from "@/components/task-list/row-cues";
import { PickupCue } from "@/components/task-list/RowCues";
import {
  MILESTONE_CUE_GLYPH,
  ROW_CUE_PRESENTATION,
  milestoneCueSentence,
  rowCueSentence,
} from "@/components/task-list/row-cues";
import { FilterBar } from "@/components/filters/FilterBar";
import { FilterChipStrip } from "@/components/filters/FilterChips";
import { FilterEmptyState } from "@/components/filters/FilterEmptyState";
import { SortByMenu, SortByOptions, sortTriggerLabel } from "@/components/view-options/SortByMenu";
import { buildFilterContext, type FilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, type FilterState } from "@/lib/filters";
import { DEFAULT_SORT, SORT_MODES, type SortPref } from "@/lib/sort-modes";
import { SessionContext, type StapleSession } from "@/lib/session";
import { ROW_CUE_STATES, type IssueRow, type RowCueState } from "@/lib/types";
import {
  driftMilestones,
  driftMilestoneTitles,
  driftQueue,
  driftRows,
  EXPECTED_CUES,
  MILESTONE,
  withGate,
} from "./drift-fixture";
import { TreeGrid } from "./TreeGrid";

const BOARD = withGate(driftRows());
const CUED = attachRowCues(BOARD, buildRowCueIndex(driftQueue(), driftMilestoneTitles()));
const CONTEXT: FilterContext = { ...buildFilterContext(BOARD), milestones: driftMilestones() };

const html = (node: ReactElement) => renderToStaticMarkup(node);
const noop = () => {};

/**
 * A session with the fields these three components read and nothing else.
 *
 * `FilterBar` and `NoMatchesState` read the session rather than taking props, so the only
 * way to ask what they PUT IN THE DOM is to supply one. Everything not read is a throwing
 * stub in spirit and a no-op in practice — the point of the object is that a test cannot
 * accidentally depend on a field the component does not use.
 */
function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    mode: "workspace",
    workspaces: [],
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    ws: "staple",
    setWs: noop,
    issues: { data: BOARD, error: undefined, loading: false, reload: noop },
    filters: emptyFilters(),
    setFilters: noop,
    filterContext: CONTEXT,
    assignee: "",
    setAssignee: noop,
    groupBy: "none",
    setGroupBy: noop,
    sort: DEFAULT_SORT,
    setSort: noop,
    visibleOrder: [],
    publishVisibleOrder: noop,
    selection: null,
    open: noop,
    close: noop,
    version: 1,
    refresh: noop,
    ...over,
  };
}

const inSession = (node: ReactElement, over: Partial<StapleSession> = {}) =>
  renderToStaticMarkup(
    <SessionContext.Provider value={session(over)}>{node}</SessionContext.Provider>,
  );

/** The tree, with the queue joined on — the ungrouped shape is where the cues live. */
function tree(over: { rows?: IssueRow[]; groupBy?: "none" | "status" | "parent" } = {}): string {
  const rows = over.rows ?? CUED;
  return renderToStaticMarkup(
    <TreeGrid
      rows={rows}
      allRows={rows}
      mode="workspace"
      groupBy={over.groupBy ?? "none"}
      currentRef={null}
      showResolved={false}
      onOpen={noop}
      onCloseDrawer={noop}
      onVisibleOrder={noop}
    />,
  );
}

/** One row's markup, from its opening tag to the start of the next row. */
function rowOf(markup: string, identifier: string): string {
  const at = markup.indexOf(`data-testid="task-row" data-identifier="${identifier}"`);
  expect(at, `no row for ${identifier}`).toBeGreaterThan(-1);
  const next = markup.indexOf('data-testid="task-row"', at + 20);
  return markup.slice(at, next === -1 ? undefined : next);
}

describe("the sort control names the mode AND the direction", () => {
  it("puts the whole sentence in the closed trigger, for all sixteen states", () => {
    /*
     * The direction is HALF the state. An arrow glyph is the usual answer and it cannot say
     * "Most active first", which is the only reading of a composite rank a person can act
     * on. Walked exhaustively because the failure is one mode with a missing word, which no
     * single-case test would catch.
     */
    for (const mode of SORT_MODES) {
      for (const direction of ["asc", "desc"] as const) {
        const pref: SortPref = { mode: mode.id, direction };
        const markup = html(<SortByMenu sort={pref} onChange={noop} />);
        expect(markup, `${mode.id}/${direction}`).toContain(sortTriggerLabel(pref));
        expect(markup, `${mode.id}/${direction}`).toContain(mode.directions[direction]);
        expect(markup).toContain('aria-label="Sort tasks"');
      }
    }
  });

  it("announces exactly one checked mode and one checked direction, in named groups", () => {
    const markup = html(<SortByOptions sort={{ mode: "queue", direction: "desc" }} onMode={noop} onDirection={noop} />);

    expect(markup).toContain('role="radiogroup" aria-label="Sort tasks by"');
    expect(markup).toContain('role="radiogroup" aria-label="Sort direction"');
    expect(markup.match(/aria-checked="true"/g)).toHaveLength(2);
    expect(markup).toMatch(/aria-checked="true"[^>]*data-sort-option="queue"/);
    expect(markup).toMatch(/aria-checked="true"[^>]*data-sort-option="desc"/);
    // The checked direction is announced in the MODE's own words, never "descending".
    expect(markup).toContain("Back of the queue first");
  });

  it("says the tie-break chain in words, so no registry step id is ever read out", () => {
    for (const mode of SORT_MODES) {
      const markup = html(<SortByOptions sort={{ mode: mode.id, direction: "asc" }} onMode={noop} onDirection={noop} />);
      expect(markup, mode.id).not.toContain("updatedRecent");
      expect(markup, mode.id).not.toContain("queuedFirst");
      expect(markup, mode.id).toContain("Ties break by");
    }
  });
});

describe("the active filter state is announced, not only drawn", () => {
  const filters = (over: Partial<FilterState> = {}): FilterState => ({ ...emptyFilters(), ...over });

  it("names the dimension and the value on every chip and on every remove button", () => {
    const state = filters({ dims: { milestone: [MILESTONE.identifier], pickup: ["gated"] } });
    const markup = html(
      <FilterChipStrip rows={BOARD} state={state} context={CONTEXT} onChange={noop} />,
    );

    // "Milestone: Release 1.0", not "Release 1.0" — a label, an assignee and a milestone can
    // all be called the same thing, and the strip is ambiguous exactly when it matters.
    expect(markup).toContain("Milestone");
    expect(markup).toContain(MILESTONE.title);
    expect(markup).toContain('aria-label="Remove filter Milestone Release 1.0"');
    expect(markup).toContain('aria-label="Edit Milestone filter"');
    expect(markup).toContain('aria-label="Remove filter Pickup state Gated"');
    expect(markup).toContain('aria-label="Edit Pickup state filter"');
  });

  it("says how many filters are narrowing the view, and that done is hidden", () => {
    /*
     * The empty state is where a tracker gets accused of losing work. The count and the
     * hidden-done clause are the two facts that turn "it is empty" into "it is empty
     * BECAUSE", and both are text rather than a badge.
     */
    const state = filters({ dims: { milestone: [MILESTONE.identifier], pickup: ["queued"] } });
    const markup = inSession(
      <FilterEmptyState rows={BOARD} state={state} context={CONTEXT} />,
      { filters: state },
    );

    expect(markup).toContain("no tasks match these filters");
    expect(markup).toContain("2 filters are narrowing this view");
    expect(markup).toContain("done tasks are hidden");
    // And the sentence that names WHICH chip to take off, with the number it would restore.
    expect(markup).toContain('data-filter-explanation="narrowed"');
    expect(markup).toContain("Pickup state (2)");
  });

  it("marks an impossible combination as impossible rather than merely empty", () => {
    const state = filters({ dims: { status: ["done"], pickup: ["pickable"] }, showDone: true });
    const markup = inSession(
      <FilterEmptyState rows={BOARD} state={state} context={CONTEXT} />,
      { filters: state },
    );

    expect(markup).toContain('data-filter-explanation="impossible"');
    expect(markup).toContain("cannot both be true");
    // Done is showing, so the clause about hidden done work is correctly absent.
    expect(markup).not.toContain("done tasks are hidden");
  });
});

describe("every row cue word reaches a screen reader", () => {
  it("gives all six states a word and a sentence, with the glyph hidden", () => {
    /*
     * THE VOCABULARY, EXHAUSTIVELY. The glyph is the sighted half and it is `aria-hidden`;
     * the WORD is the other half, and it leads the sentence on `title` and on the `sr-only`
     * span so a pointer and a screen reader get the same sentence rather than two different
     * abridgements of it.
     */
    for (const state of ROW_CUE_STATES) {
      const cue = { state: state as RowCueState, position: 3, scope: "effective" as const, reason: null };
      const markup = html(<PickupCue cue={cue} />);
      const { glyph, label, hint } = ROW_CUE_PRESENTATION[state];

      expect(markup, state).toContain(`<span class="sr-only">${rowCueSentence(cue)}</span>`);
      expect(markup, state).toContain(label);
      expect(markup, state).toContain(hint.replaceAll("'", "&#x27;"));
      // The glyph and the short form are decoration; neither is ever the only carrier.
      expect(markup, state).toContain(`<span aria-hidden="true">${glyph}</span>`);
      expect(markup, state).toContain(`data-pickup-cue="${state}"`);
    }
  });

  it("puts those sentences on the actual rows of the actual board", () => {
    const markup = tree();

    for (const [identifier, expected] of Object.entries(EXPECTED_CUES)) {
      // The cold epic's children are folded by default; the epics and the loner are not.
      if (!markup.includes(`data-identifier="${identifier}"`)) continue;
      const row = rowOf(markup, identifier);
      const { label, hint } = ROW_CUE_PRESENTATION[expected.state as RowCueState];
      expect(row, identifier).toContain(`data-pickup-cue="${expected.state}"`);
      expect(row, identifier).toContain(`${label} — ${hint.replaceAll("'", "&#x27;")}`);
      if (expected.position !== null) {
        expect(row, identifier).toContain(`data-cue-position="${expected.position}"`);
        const scope = expected.scope === "plan" ? "Plan position" : "Queue position";
        expect(row, identifier).toContain(`${scope} ${expected.position}.`);
      }
    }
  });

  it("carries the resolver's own reason into the sentence, so `gated` says by whom", () => {
    const row = rowOf(tree(), "STA-3");
    expect(row).toContain("awaiting VP on STA-3");
  });

  it("names the milestone on the marker, and gives the marker a real accessible name", () => {
    const row = rowOf(tree(), "STA-2");
    const sentence = milestoneCueSentence(MILESTONE.identifier, MILESTONE.title);

    expect(row).toContain(`aria-label="${sentence}"`);
    expect(row).toContain(`title="${sentence}"`);
    // The diamond itself says nothing out loud — it is the button's name that does.
    expect(row).toContain(`<span aria-hidden="true">${MILESTONE_CUE_GLYPH}</span>`);
    expect(row).toContain('data-milestone="M-1"');
  });

  it("says nothing at all about a row the queue has no opinion on", () => {
    // Silence is a state. A page with no queue must not stamp `·` on every row to say
    // nothing — `attachRowCues` hands back the caller's own array and no cue is drawn.
    const markup = tree({ rows: BOARD });
    expect(markup).not.toContain("data-pickup-cue");
    expect(markup).not.toContain("staple-row-milestone");
  });
});

describe("the tree's own structure is announced", () => {
  it("levels every row by its depth and expands only what has children", () => {
    const markup = tree();
    const epic = rowOf(markup, "STA-1");
    const child = rowOf(markup, "STA-2");
    const leaf = rowOf(markup, "STA-8");

    expect(epic).toContain('aria-level="1"');
    expect(epic).toContain('aria-expanded="true"');
    expect(child).toContain('aria-level="2"');
    // A leaf has nothing to disclose, so it carries no `aria-expanded` at all — announcing
    // "collapsed" about a row with no children is worse than announcing nothing.
    expect(leaf).toContain('aria-level="1"');
    expect(leaf).not.toContain("aria-expanded");
    // The folded epic says it is folded.
    expect(rowOf(markup, "STA-5")).toContain('aria-expanded="false"');
  });

  it("keeps the levels correct under a grouping axis, where depth is depth IN THE GROUP", () => {
    const markup = tree({ groupBy: "status" });
    // The gated child heads its own status group — it is depth 0 there, under a ghost of
    // the epic it belongs to, and the ghost is the row that says so.
    expect(rowOf(markup, "STA-3")).toContain('aria-level="2"');
    const ghost = markup.slice(markup.indexOf('data-status="awaiting_approval"'));
    expect(ghost).toContain("parent shown for context");
  });

  it("names every group header with its label and its count", () => {
    const markup = tree({ groupBy: "status" });

    expect(markup).toContain('aria-label="In Progress, 3 tasks"');
    expect(markup).toContain('aria-label="Backlog, 2 tasks"');
    // The header is a real expandable control, and the count is on the NAME rather than
    // only in a badge beside it.
    expect(markup).toMatch(/data-testid="group-header"[^>]*aria-expanded="true"/);
  });

  it("gives the epic axis no header to announce — the epic's own row is the head", () => {
    const markup = tree({ groupBy: "parent" });
    expect(markup).not.toContain('data-testid="group-header" data-status="epic-order"');
    expect(markup).toContain('data-group-key="epic-order"');
    expect(rowOf(markup, "STA-1")).toContain('aria-expanded="true"');
  });
});

describe("tab order", () => {
  /**
   * WHAT "TAB ORDER" MEANS IN A STATIC RENDER, stated plainly: with no `tabindex` on any
   * control, tab order IS DOM order, which a string can answer exactly. So the claim below
   * is the conjunction of two checkable things — the controls appear in the intended
   * sequence, and not one of them overrides the sequence with a `tabindex`.
   *
   * The one place a `tabindex` is CORRECT is the grid, which uses a roving one: exactly one
   * row is a tab stop and the arrow keys move it, which is what stops a hundred-row list
   * from being a hundred tabs deep.
   */
  it("puts the whole control cluster in reading order: Group, Sort, Search, Filter, Done", () => {
    const markup = inSession(<FilterBar />);
    const positions = [
      markup.indexOf('aria-label="Group tasks"'),
      markup.indexOf('aria-label="Sort tasks"'),
      markup.indexOf('aria-label="Search tasks"'),
      markup.indexOf('aria-label="Add a filter"'),
      markup.indexOf('aria-label="Show done and cancelled tasks"'),
    ];
    expect(positions.every((at) => at > -1)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    // Nothing in the cluster jumps the queue.
    expect(markup).not.toContain("tabindex");
  });

  it("makes every option in both menus a real button, so Tab and Enter need no key handler", () => {
    const markup = html(<SortByOptions sort={DEFAULT_SORT} onMode={noop} onDirection={noop} />);
    expect(markup.match(/<button type="button" role="radio"/g)).toHaveLength(SORT_MODES.length + 2);
    expect(markup).not.toContain("tabindex");
  });

  it("gives the chip strip two stops per chip — edit, then remove — plus Clear all", () => {
    const state: FilterState = {
      ...emptyFilters(),
      dims: { milestone: [MILESTONE.identifier] },
    };
    const markup = html(
      <FilterChipStrip rows={BOARD} state={state} context={CONTEXT} onChange={noop} />,
    );
    const edit = markup.indexOf('aria-label="Edit Milestone filter"');
    const remove = markup.indexOf('aria-label="Remove filter Milestone Release 1.0"');
    const clear = markup.indexOf("data-filter-clear");

    expect(edit).toBeGreaterThan(-1);
    expect(edit).toBeLessThan(remove);
    expect(remove).toBeLessThan(clear);
    expect(markup).not.toContain("tabindex");
  });

  it("gives the whole grid ONE tab stop, and moves it with the arrow keys", () => {
    const markup = tree();
    expect(markup.match(/tabindex="0"/g)).toHaveLength(1);
    // Every other row is reachable and is not a stop — that is what makes it roving rather
    // than a list of rows that cannot be focused at all.
    expect((markup.match(/tabindex="-1"/g) ?? []).length).toBeGreaterThan(1);
  });
});
