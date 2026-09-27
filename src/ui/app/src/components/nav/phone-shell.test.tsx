/**
 * The shell at a phone's width and at a desk's, and on All workspaces — rendered to a
 * string with the viewport stubbed through `matchMedia` (the technique
 * views/tree/view-responsive.test.tsx uses), so the component under test is the shipped
 * one and only the browser's answer changes.
 */
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { AppShell } from "@/components/AppShell";
import { FilterChipStrip } from "@/components/filters/FilterChips";
import { ProjectForm } from "@/components/projects/ProjectDialog";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, withDimension } from "@/lib/filters";
import { SessionContext, VIEWS, VIEW_LABELS, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";

const noop = () => {};
const WORKSPACES = [
  { slug: "aardvark", prefix: "AAR" },
  { slug: "staple", prefix: "STA" },
];

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    mode: "hub",
    workspaces: WORKSPACES,
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

const globals = globalThis as { window?: unknown };
const previousWindow = globals.window;
afterEach(() => {
  globals.window = previousWindow;
});

function at(width: number, node: ReactElement, over: Partial<StapleSession> = {}): string {
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false };
    },
  };
  return renderToStaticMarkup(<SessionContext.Provider value={session(over)}>{node}</SessionContext.Provider>);
}
const shell = (width: number, over: Partial<StapleSession> = {}) =>
  at(
    width,
    <AppShell>
      <div data-the-view />
    </AppShell>,
    over,
  );

describe("on a phone", () => {
  it("is an app: a top bar, the view, and a bottom tab bar — no rail column", () => {
    const markup = shell(390);
    expect(markup).toContain('data-shell="phone"');
    const bar = markup.indexOf("data-app-bar");
    const view = markup.indexOf("data-the-view");
    const tabs = markup.indexOf("data-view-tabs");
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(view);
    expect(view).toBeLessThan(tabs);
    expect(markup).not.toContain('aria-label="Primary"');
  });

  it("puts every view one tap away in the tab bar, the current one marked", () => {
    const markup = shell(360, { view: "graph" });
    for (const view of VIEWS) {
      expect(markup).toMatch(new RegExp(`<button type="button" data-view-tab="${view}"[^>]*aria-label="${VIEW_LABELS[view]}"`));
    }
    expect(markup.match(/data-view-tab="[a-z]+" aria-current="page"/g)).toEqual(['data-view-tab="graph" aria-current="page"']);
  });

  it("reaches the switcher in one tap from the top bar, with the full selection on it", () => {
    const markup = shell(390);
    const trigger = /<button[^>]*data-workspace-switcher="bar"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(trigger).toContain(">All workspaces</span>");
    expect(trigger).toContain("min-h-11");
  });

  it("respects the safe areas and the dynamic viewport", () => {
    const markup = shell(390);
    expect(markup).toContain("h-dvh");
    expect(markup).toMatch(/data-app-bar[^>]*class="[^"]*env\(safe-area-inset-top\)/);
    expect(markup).toMatch(/data-view-tabs[^>]*class="[^"]*env\(safe-area-inset-bottom\)/);
  });

  it("makes the top bar's controls 44px targets", () => {
    const markup = shell(390);
    for (const hook of ["data-nav-show", "data-bar-search", "data-bar-new-task"]) {
      const button = new RegExp(`<button[^>]*${hook}[^>]*>`).exec(markup)?.[0] ?? "";
      expect(button, hook).toContain("size-11");
    }
  });
});

describe("on a desk", () => {
  it("keeps the rail and adds no tab bar or top bar", () => {
    const markup = shell(1440);
    expect(markup).toContain('aria-label="Primary"');
    expect(markup).not.toContain("data-view-tabs");
    expect(markup).not.toContain("data-app-bar");
  });
});

describe("All workspaces never presents the first workspace as current", () => {
  it("the header says All workspaces beside the view's name", () => {
    const markup = shell(1440);
    expect(markup).toMatch(/<span data-scope-name="true"[^>]*>All workspaces<\/span>/);
    expect(markup).not.toMatch(/data-scope-name="true"[^>]*>aardvark</);
  });

  it("the header names the workspace once one is chosen", () => {
    expect(shell(1440, { ws: "staple" })).toMatch(/<span data-scope-name="true"[^>]*>staple<\/span>/);
  });

  it("a new project from All workspaces asks which workspace, with none preselected", () => {
    const markup = at(1440, <ProjectForm mode={{ mode: "create", workspace: "" }} onDone={noop} onCancel={noop} />);
    expect(markup).toContain("data-project-workspace");
    expect(markup).toContain("Choose a workspace");
    expect(markup).not.toMatch(/data-project-workspace[\s\S]{0,400}>aardvark</);
  });
});

describe("quick filters", () => {
  const strip = (filters = emptyFilters()) =>
    renderToStaticMarkup(
      <FilterChipStrip rows={[]} state={filters} context={buildFilterContext([])} onChange={noop} />,
    );

  it("sit in the shell under the header on every issue view, and not on the reports", () => {
    expect(shell(1440)).toContain("data-filter-chips");
    expect(shell(1440, { view: "calibration" })).not.toContain("data-filter-chips");
    expect(shell(1440, { view: "budget" })).not.toContain("data-filter-chips");
  });

  it("are toggle buttons whose pressed state is the filter", () => {
    const off = strip();
    expect(off).toMatch(/data-filter-preset="blocked" aria-pressed="false"/);
    const on = strip(withDimension(emptyFilters(), "priority", ["critical", "high"]));
    expect(on).toMatch(/data-filter-preset="high-priority" aria-pressed="true"/);
    // The preset is the chip: no second "Urgent priority" chip beside it.
    expect(on).not.toContain('data-filter-chip="priority"');
    expect(on).toContain("data-filter-clear");
  });

  it("put what is on first — lit presets, other filters, Clear all — so a phone never hides an active filter off-screen", () => {
    const state = withDimension(withDimension(emptyFilters(), "kind", ["bug"]), "label", ["ui"]);
    const markup = strip(state);
    const at = (marker: string) => markup.indexOf(marker);
    expect(at('data-filter-preset="bugs"')).toBeLessThan(at('data-filter-chip="label"'));
    expect(at('data-filter-chip="label"')).toBeLessThan(at("data-filter-clear"));
    expect(at("data-filter-clear")).toBeLessThan(at('data-filter-preset="mine"'));
    expect(at("data-filter-clear")).toBeLessThan(at('data-filter-preset="in-progress"'));
  });

  it("scroll sideways on a phone and never wrap into a second row there", () => {
    const tag = /<div[^>]*data-filter-chips[^>]*>/.exec(strip())?.[0] ?? "";
    expect(tag).toContain("max-md:overflow-x-auto");
    expect(tag).toContain("md:flex-wrap");
    expect(tag).not.toMatch(/(?<!md:)flex-wrap/);
  });
});
