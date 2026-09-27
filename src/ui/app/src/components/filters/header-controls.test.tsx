/**
 * The content header's control row at a wide width and a narrow one.
 *
 * Rendered to a string, with `window.matchMedia` stubbed the way `view-responsive.test.tsx`
 * stubs it, so the compact form is the shipped component answering a different width and
 * not a prop nobody sets in production. Two claims: the ORDER and the ACCESSIBLE NAMES are
 * the same at both widths, and what changes is only whether the words are drawn.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, withText, type FilterState } from "@/lib/filters";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import { FilterBar } from "./FilterBar";
import { HEADER_BUTTON_CLASS } from "./HeaderButton";

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

/** Render the row as if the viewport were `width` px — the same stub view-responsive uses. */
function atWidth(width: number, over: Partial<StapleSession> = {}): string {
  const globals = globalThis as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : false };
    },
  };
  try {
    return renderToStaticMarkup(
      <SessionContext.Provider value={session(over)}>
        <FilterBar />
      </SessionContext.Provider>,
    );
  } finally {
    if (previous === undefined) delete globals.window;
    else globals.window = previous;
  }
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const NAMES = [
  'aria-label="Group tasks"',
  'aria-label="Sort: Activity · Most active first"',
  'aria-label="Add a filter"',
  'aria-label="Show done and cancelled tasks"',
  'aria-label="Search tasks"',
];

const positions = (markup: string) => NAMES.map((name) => markup.indexOf(name));
const ascending = (list: number[]) => list.every((at, i) => at > -1 && (i === 0 || at > list[i - 1]!));

describe("the header row", () => {
  it("orders the controls Group, Sort, Filter, Done, Search at both widths", () => {
    expect(ascending(positions(atWidth(1440)))).toBe(true);
    expect(ascending(positions(atWidth(420)))).toBe(true);
  });

  it("draws the words wide and only the icons narrow, with the same names", () => {
    const wide = atWidth(1440);
    expect(wide).toContain(">Group<");
    expect(wide).toContain("Sort: Activity");
    expect(wide).toContain(">Filter<");
    expect(wide).toContain(">Done<");
    expect(wide).toContain('data-sort-arrow="asc"');
    expect(wide).not.toContain('data-compact=""');

    const narrow = atWidth(420);
    expect(narrow).not.toContain(">Group<");
    expect(narrow).not.toContain(">Filter<");
    expect(narrow).not.toContain(">Done<");
    expect(narrow).not.toContain("Sort: Activity<");
    // Four icon buttons plus the folded search: every one compact.
    expect(narrow.match(/data-compact=""/g)).toHaveLength(5);
  });

  it("wears one recipe on every control: 28px, 13px, a 16px icon, 6px gap", () => {
    for (const cls of ["h-7", "text-[13px]", "gap-1.5", "[&_svg:not([class*='size-'])]:size-4"]) {
      expect(HEADER_BUTTON_CLASS).toContain(cls);
    }
    const wide = atWidth(1440);
    expect(wide.match(/class="[^"]*\bh-7\b[^"]*"/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  });

  it("folds the search into an icon when narrow, and keeps the field while it holds text", () => {
    const folded = atWidth(420);
    expect(folded).toContain("data-filter-search-open");
    expect(folded).not.toContain("data-filter-search=");
    const typing = atWidth(420, { filters: withText(emptyFilters(), "docs") as FilterState });
    expect(typing).toContain('data-filter-search="true"');
    expect(typing).toContain('aria-label="Close search"');
    expect(typing).not.toContain("data-filter-search-open");
    // Wide, the field is always there and never folded.
    const wide = atWidth(1440);
    expect(wide).toContain('data-filter-search="true"');
    expect(wide).not.toContain("data-filter-search-open");
    expect(wide).not.toContain('aria-label="Close search"');
  });

  it("keeps the filter count badge in both forms", () => {
    const state: FilterState = { ...emptyFilters(), dims: { status: ["todo", "blocked"] } };
    expect(atWidth(1440, { filters: state })).toMatch(/data-filter-count[^>]*>2</);
    expect(atWidth(420, { filters: state })).toMatch(/data-filter-count[^>]*>2</);
  });

  it("puts nothing in the tab order out of sequence", () => {
    expect(atWidth(420)).not.toContain("tabindex");
  });
});

describe("each view shows only the controls it honours", () => {
  it("Graph: filter, Done and search — no Group or Sort, which a graph cannot do", () => {
    const graph = atWidth(1440, { view: "graph" });
    expect(graph).not.toContain('aria-label="Group tasks"');
    expect(graph).not.toContain("Sort:");
    expect(graph).toContain('aria-label="Add a filter"');
    expect(graph).toContain('aria-label="Show done and cancelled tasks"');
    expect(graph).toContain('aria-label="Search tasks"');
  });

  it("Milestones: Done alone, named for what it shows there", () => {
    const milestones = atWidth(1440, { view: "milestones" });
    expect(milestones).toContain('aria-label="Show finished milestones"');
    for (const absent of ['aria-label="Group tasks"', "Sort:", 'aria-label="Add a filter"', 'aria-label="Search tasks"']) {
      expect(milestones).not.toContain(absent);
    }
  });

  it("Queue: nothing — a filter there would change nothing", () => {
    const queue = atWidth(1440, { view: "queue" });
    expect(queue).not.toContain("<button");
    expect(queue).not.toContain("<input");
  });
});

describe("a phone searches on its own row", () => {
  it("while a query is held, the field takes the whole header row and the other controls step aside", () => {
    const typing = atWidth(390, { filters: withText(emptyFilters(), "login") as FilterState });
    expect(typing).toContain("data-search-mode");
    expect(typing).toMatch(/data-search-mode[^>]*class="[^"]*\babsolute\b[^"]*\binset-0\b/);
    const field = typing.slice(typing.lastIndexOf("<", typing.indexOf('data-filter-search="true"')), typing.indexOf(">", typing.indexOf('data-filter-search="true"')));
    expect(field).toMatch(/class="[^"]*\bw-full\b/);
    expect(typing).not.toContain('aria-label="Group tasks"');
    expect(typing).not.toContain('aria-label="Add a filter"');
    // A desk keeps its one row: the field sits at the end of it.
    expect(atWidth(1440, { filters: withText(emptyFilters(), "login") as FilterState })).not.toContain("data-search-mode");
  });
});
