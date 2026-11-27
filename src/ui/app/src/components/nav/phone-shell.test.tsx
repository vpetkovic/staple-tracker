/**
 * The shell at a phone's width and at a desk's, and on All workspaces — rendered to a
 * string with the viewport stubbed through `matchMedia` (the technique
 * views/tree/view-responsive.test.tsx uses), so the component under test is the shipped
 * one and only the browser's answer changes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { AppShell } from "@/components/AppShell";
import { MoreSheetBody } from "@/components/nav/ViewTabBar";
import { FilterChipStrip } from "@/components/filters/FilterChips";
import { ProjectForm } from "@/components/projects/ProjectDialog";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters, withDimension } from "@/lib/filters";
import { AttentionContext } from "@/lib/attention";
import { SessionContext, TAB_VIEWS, VIEW_LABELS, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { Project, ProjectRow } from "@/lib/types";

const noop = () => {};
const WORKSPACES = [
  { slug: "aardvark", prefix: "AAR" },
  { slug: "staple", prefix: "STA" },
];

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    planningEnabled: true,
    mode: "hub",
    workspaces: WORKSPACES,
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    run: null,
    openRun: noop,
    openHorizon: noop,
    projects: { data: [], error: undefined, loading: false, reload: noop },
    focusProject: noop,
    showAllTasks: noop,
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

/** The root's Inbox read (App.tsx provides it): nothing waiting. */
const NO_ATTENTION = { data: { rows: [], workspaces: [], failed: [], now: "2026-11-26T12:00:00.000Z" }, error: undefined, loading: false, reload: () => {} };

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
  return renderToStaticMarkup(
    <SessionContext.Provider value={session(over)}>
      <AttentionContext value={NO_ATTENTION}>{node}</AttentionContext>
    </SessionContext.Provider>,
  );
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
  it("is an app: a top bar, the view, and a bottom tab bar — no rail column and no drawer", () => {
    const markup = shell(390);
    expect(markup).toContain('data-shell="phone"');
    const bar = markup.indexOf("data-app-bar");
    const view = markup.indexOf("data-the-view");
    const tabs = markup.indexOf("data-view-tabs");
    expect(bar).toBeGreaterThan(-1);
    expect(bar).toBeLessThan(view);
    expect(view).toBeLessThan(tabs);
    expect(markup).not.toContain('aria-label="Primary"');
    expect(markup).not.toContain("data-nav-overlay");
    expect(markup).not.toContain("data-nav-show");
    expect(markup).not.toContain('aria-label="Menu"');
  });

  it("puts the four top views one tap away and every other view behind More, the current one marked", () => {
    const tasks = shell(360, { view: "tree" });
    for (const view of TAB_VIEWS) {
      expect(tasks).toMatch(new RegExp(`<button type="button" data-view-tab="${view}"[^>]*aria-label="${VIEW_LABELS[view]}"`));
    }
    expect([...tasks.matchAll(/data-view-tab="([a-z]+)"/g)].map((match) => match[1])).toEqual([...TAB_VIEWS, "more"]);
    expect(tasks.match(/data-view-tab="[a-z]+" aria-current="page"/g)).toEqual(['data-view-tab="tree" aria-current="page"']);
    // A view outside the bar: More is the page, and it is the way there.
    const graph = shell(360, { view: "graph" });
    expect(graph.match(/data-view-tab="[a-z]+" aria-current="page"/g)).toEqual(['data-view-tab="more" aria-current="page"']);
  });

  it("leads the top bar with the workspace pill, the full selection on it, drawn at its own size", () => {
    const markup = shell(390);
    const bar = markup.slice(markup.indexOf("data-app-bar"), markup.indexOf("</header>"));
    expect(bar.indexOf('data-workspace-switcher="bar"')).toBeLessThan(bar.indexOf("data-bar-search"));
    expect(bar.indexOf("<button")).toBe(bar.indexOf('<button type="button" aria-label="Workspace: All workspaces.'));
    const trigger = /<button[^>]*data-workspace-switcher="bar"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(trigger).toContain(">All workspaces</span>");
    expect(trigger).toContain('title="All workspaces — switch workspace"');
    // A 32px pill: a long name truncates, and the 44px a thumb needs is an invisible area round it.
    const cls = /<button[^>]*data-workspace-switcher="bar"[^>]*class="([^"]*)"/.exec(markup)?.[1] ?? "";
    expect(cls).toContain("h-8");
    expect(cls).toContain("min-h-0");
    expect(cls).toContain("before:-inset-y-[7px]");
    expect(trigger).toMatch(/data-workspace-name="true" class="[^"]*truncate/);
  });

  it("respects the safe areas and the dynamic viewport", () => {
    const markup = shell(390);
    expect(markup).toContain("h-dvh");
    expect(markup).toMatch(/data-app-bar[^>]*class="[^"]*env\(safe-area-inset-top\)/);
    expect(markup).toMatch(/data-view-tabs[^>]*class="[^"]*env\(safe-area-inset-bottom\)/);
  });

  it("makes search and New task 44px targets with no box drawn round them at rest", () => {
    const markup = shell(390);
    for (const hook of ["data-bar-search", "data-bar-new-task"]) {
      const button = new RegExp(`<button[^>]*${hook}[^>]*>`).exec(markup)?.[0] ?? "";
      expect(button, hook).toContain("size-11");
      expect(button, hook).toContain('data-variant="ghost"');
    }
  });
});

describe("the More sheet", () => {
  const project = (over: Partial<Project>): Project =>
    ({ kind: "unmanaged", sourceKind: null, source: null, createdAt: "2026-09-05T00:00:00.000Z", updatedAt: "2026-09-05T00:00:00.000Z", ...over }) as Project;
  const rows: ProjectRow[] = [
    { workspace: "aardvark", project: project({ id: "p-docs", slug: "docs", name: "Docs" }) },
    { workspace: "staple", project: project({ id: "p-site", slug: "site", name: "Site" }) },
  ];
  const sheet = (over: Partial<StapleSession> = {}) => at(390, <MoreSheetBody onChoose={noop} onClose={noop} onCloseThen={noop} />, over);
  const section = (markup: string, id: string) => new RegExp(`<section[^>]*data-more-section="${id}"[\\s\\S]*?</section>`).exec(markup)?.[0] ?? "";

  it("is the rest of the rail, in its order: the other views, then Projects, then This computer", () => {
    const markup = sheet();
    const at = (hook: string) => markup.indexOf(hook);
    expect(at('data-more-view="graph"')).toBeLessThan(at('data-more-section="projects"'));
    expect(at('data-more-view="calibration"')).toBeLessThan(at('data-more-section="projects"'));
    expect(at('data-more-section="projects"')).toBeLessThan(at('data-more-section="machine"'));
    expect(section(markup, "projects")).toContain(">Projects</h3>");
    expect(section(markup, "machine")).toContain(">This computer</h3>");
  });

  it("lists the scope's projects, each with its open count and its settings, then New project", () => {
    const markup = section(sheet({ projects: { data: rows, error: undefined, loading: false, reload: noop }, ws: "staple" }), "projects");
    expect(markup).toContain('data-more-project="p-site"');
    expect(markup).not.toContain('data-more-project="p-docs"');
    expect(markup).toMatch(/data-more-project="p-site"[\s\S]*?aria-label="0 open"/);
    expect(markup).toContain('aria-label="Project settings: Site"');
    expect(markup.indexOf('data-more-project="p-site"')).toBeLessThan(markup.indexOf("data-more-new-project"));
    // Rows are 48px; the gear beside a row is 44px with nothing drawn round it at rest.
    expect(/<button[^>]*data-more-project="p-site"[^>]*class="([^"]*)"/.exec(markup)?.[1]).toContain("h-12");
    expect(/<button[^>]*data-more-project-settings[^>]*class="([^"]*)"/.exec(markup)?.[1]).not.toMatch(/(^| )(bg-|border)/);
  });

  it("captions each project with its workspace when they span several, and marks the one Tasks shows", () => {
    const all = sheet({ projects: { data: rows, error: undefined, loading: false, reload: noop }, ws: "" });
    expect(section(all, "projects")).toMatch(/data-more-project="p-docs"[\s\S]*?>aardvark<\/span>/);
    const one = sheet({ projects: { data: rows, error: undefined, loading: false, reload: noop }, ws: "staple" });
    expect(section(one, "projects")).not.toContain(">staple</span>");
    const narrowed = sheet({
      projects: { data: rows, error: undefined, loading: false, reload: noop },
      filters: { ...emptyFilters(), dims: { project: ["p-site"] } },
    });
    expect(narrowed).toMatch(/data-more-project="p-site" aria-current="true"/);
    expect(narrowed).not.toMatch(/data-more-project="p-docs" aria-current/);
    // Each row's title has the name and, when captioned, the workspace.
    expect(all).toMatch(/data-more-project="p-docs"[^>]*title="Docs · aardvark"/);
  });

  it("offers only New project under Projects while the scope has none", () => {
    const markup = section(sheet(), "projects");
    expect(markup).not.toContain("data-more-project=");
    expect(markup).toContain("data-more-new-project");
  });

  it("ends with This computer: Usage, Integrations, Settings and Dark mode as a switch", () => {
    const markup = section(sheet({ view: "budget" }), "machine");
    const order = ['data-more-view="budget"', "data-more-integrations", "data-more-settings", "data-more-theme"].map((hook) => markup.indexOf(hook));
    expect(order.every((position, i) => position > -1 && (i === 0 || position > order[i - 1]!))).toBe(true);
    expect(markup).toMatch(/data-more-view="budget" aria-current="page"/);
    // Under forced colours the current row is outlined in Highlight: its fill would be replaced.
    expect(/<button[^>]*data-more-view="budget"[^>]*>/.exec(markup)?.[0].replaceAll("&amp;", "&")).toContain(
      "forced-colors:[&[aria-current]:not([data-child-current])]:outline-[Highlight]",
    );
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*data-more-theme/);
    expect(markup).toContain(">Dark mode</span>");
  });

  it("closes itself, gives the More tab the focus, and only then opens a dialog", () => {
    /*
     * A dialog stacked on the open sheet would make Escape ambiguous, and one opened while the
     * sheet was still there would hand the focus back, on closing, to a row that is gone. The
     * click handlers cannot run without a DOM, so what is pinned is the source: every call in
     * the sheet that opens a dialog is handed to the sheet's close-then, which runs it once the
     * sheet has gone and the More tab has the focus (useFocusOnClose's `then`).
     */
    const text = readFileSync(fileURLToPath(new URL("./ViewTabBar.tsx", import.meta.url)), "utf8").replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
    const opens = text.match(/(openProjectDialog|openSettings)\(/g) ?? [];
    // A project's settings, New project, Integrations and Settings.
    expect(opens.length).toBe(4);
    expect((text.match(/onCloseThen\(\(\) => (openProjectDialog|openSettings)\(/g) ?? []).length).toBe(opens.length);
    expect(text).toContain('useFocusOnClose(moreOpen, () => document.querySelector<HTMLElement>(\'[data-view-tab="more"]\'), true, afterClose)');
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
  // The scope is the rail's head on a desk: the switcher itself, above the views.
  const head = (markup: string) => /<button[^>]*data-workspace-switcher="head"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";

  it("the rail's head says All workspaces, and the top bar does not say it again", () => {
    const markup = shell(1440);
    expect(head(markup)).toContain(">All workspaces</span>");
    expect(head(markup)).not.toContain(">aardvark<");
    expect(markup).not.toContain("data-scope-name");
  });

  it("the head names the workspace once one is chosen", () => {
    expect(head(shell(1440, { ws: "staple" }))).toContain(">staple</span>");
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
