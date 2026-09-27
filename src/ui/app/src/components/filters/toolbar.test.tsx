/**
 * The desk's toolbar at the three desk widths the design is measured at.
 *
 * Rendered to a string with `window.matchMedia` stubbed (the header-controls technique), so
 * the narrow form is the shipped component answering a different width. The claims: one
 * row holds which-tasks on the left and how-they-look on the right, in the same order and
 * with the same accessible names at every width; width only decides whether words are drawn
 * and whether search is an open field.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, withDimension, withShowDone, withText } from "@/lib/filters";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import { Toolbar } from "./Toolbar";

const noop = () => {};

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    mode: "workspace",
    workspaces: [{ slug: "staple", prefix: "STA" }],
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    projects: { data: [], error: undefined, loading: false, reload: noop },
    focusProject: noop,
    ws: "",
    setWs: noop,
    issues: { data: [], error: undefined, loading: false, reload: noop },
    filters: emptyFilters(),
    setFilters: noop,
    filterContext: buildFilterContext([]),
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
    pin: noop,
    close: noop,
    version: 1,
    refresh: noop,
    ...over,
  };
}

function atWidth(width: number, over: Partial<StapleSession> = {}): string {
  const globals = globalThis as { window?: unknown };
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : false };
    },
  };
  return renderToStaticMarkup(
    <SessionContext.Provider value={session(over)}>
      <Toolbar />
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const ORDER = [
  'aria-label="Add a filter"',
  "data-filter-chips",
  'data-filter-preset="in-progress"',
  "data-view-options",
  'aria-label="Group tasks"',
  'aria-label="Sort: Activity · Most active first"',
  'aria-label="Show done and cancelled tasks"',
  'aria-label="Search tasks"',
];
const ascending = (markup: string) => {
  const at = ORDER.map((marker) => markup.indexOf(marker));
  return at.every((pos, i) => pos > -1 && (i === 0 || pos > at[i - 1]!));
};

describe("the desk toolbar", () => {
  it("holds which-tasks then how-they-look, in one order, at 1920, 1440 and 1024", () => {
    for (const width of [1920, 1440, 1024]) expect(ascending(atWidth(width)), String(width)).toBe(true);
  });

  it("draws the words and an open search field from 1280px", () => {
    for (const width of [1920, 1440]) {
      const wide = atWidth(width);
      expect(wide).toContain(">Filter<");
      expect(wide).toContain(">Group<");
      expect(wide).toContain("Sort: Activity");
      expect(wide).toContain(">Done hidden<");
      expect(wide).toContain('placeholder="Search this list"');
      expect(wide).not.toContain('data-compact=""');
    }
  });

  it("keeps the Filter word but draws icons for the view options below 1280px, search folded", () => {
    const narrow = atWidth(1024);
    // Filter is the anchor of the which-tasks half and keeps its word at every desk width.
    expect(narrow).toContain(">Filter<");
    expect(narrow).not.toContain(">Group<");
    expect(narrow).not.toContain(">Done hidden<");
    expect(narrow).toContain("data-filter-search-open");
    expect(narrow).not.toContain("data-filter-search=");
    // Group, Sort, Done and the folded search: four icon buttons.
    expect(narrow.match(/data-compact=""/g)).toHaveLength(4);
  });

  it("never hides a query behind the folded search", () => {
    const held = atWidth(1024, { filters: withText(emptyFilters(), "sync") });
    expect(held).toContain('value="sync"');
    expect(held).toContain("data-filter-search-clear");
    expect(held).not.toContain("data-filter-search-open");
  });

  it("carries the count of filters that are on beside Filter, and lights it", () => {
    const on = atWidth(1440, { filters: withDimension(emptyFilters(), "assignee", ["vp"]) });
    expect(on).toMatch(/data-filter-count[^>]*>1</);
    expect(atWidth(1440)).not.toContain("data-filter-count");
  });

  it("says which way round Done is, in words, and names the button for what a click does", () => {
    const shown = atWidth(1440, { filters: withShowDone(emptyFilters(), true) });
    expect(shown).toContain(">Showing done<");
    expect(shown).toContain('aria-label="Hide done and cancelled tasks"');
    expect(shown).toContain('aria-pressed="true"');
  });

  it("is one line: the quick filters scroll in their own lane rather than wrapping", () => {
    const lane = /<div[^>]*data-filter-chips[^>]*>/.exec(atWidth(1024))?.[0] ?? "";
    expect(lane).toContain("overflow-x-auto");
    expect(lane).toContain("flex-1");
    expect(lane).not.toContain("flex-wrap");
    expect(lane).not.toContain("border-b");
  });

  it("renders nothing on a view with no controls, and only Done on Milestones", () => {
    for (const view of ["queue", "calibration", "budget"] as const) expect(atWidth(1440, { view })).toBe("");
    const milestones = atWidth(1440, { view: "milestones" });
    expect(milestones).toContain('aria-label="Show finished milestones"');
    expect(milestones).not.toContain("data-filter-chips");
    expect(milestones).not.toContain('aria-label="Group tasks"');
  });
});
