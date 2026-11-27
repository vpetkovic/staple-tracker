/**
 * The desk shell, rendered to a string: the rail on the left (its head, three zones and the
 * foot), the top bar and toolbar on the right, and the workspace list the head opens.
 *
 * No jsdom here, as everywhere in this repo: `react-dom/server` answers which elements exist,
 * in what order, with what accessible names. That is what the claims below are about: the
 * rail's rows come in the order the model says, exactly one row is the place, and every
 * control is a real button with a name.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { AppShell, TopBar } from "@/components/AppShell";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters } from "@/lib/filters";
import { AttentionContext } from "@/lib/attention";
import type { AttentionList, AttentionRow } from "@/lib/types";
import type { Resource } from "@/lib/useStaple";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { HubCloudReport, IssueRow, IssueStatus, Project, ProjectRow } from "@/lib/types";
import { IntegrationsRailRow, NavRail, RAIL_ROW_CLASS } from "./NavRail";
import { SwitcherList, WorkspaceSwitcher } from "./WorkspaceSwitcher";

const noop = () => {};

const project = (over: Partial<Project> = {}): Project => ({
  id: "p-1",
  slug: "docs",
  name: "Docs",
  kind: "unmanaged",
  sourceKind: null,
  source: null,
  createdAt: "2026-09-05T00:00:00.000Z",
  updatedAt: "2026-09-05T00:00:00.000Z",
  ...over,
});

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    planningEnabled: true,
    mode: "workspace",
    workspaces: [{ slug: "staple", prefix: "STA" }],
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

const inSession = (node: ReactElement, over: Partial<StapleSession> = {}, attention: Resource<AttentionList> = NO_ATTENTION) =>
  renderToStaticMarkup(
    <SessionContext.Provider value={session(over)}>
      <AttentionContext value={attention}>{node}</AttentionContext>
    </SessionContext.Provider>,
  );

/** An Inbox read holding one row per workspace named, as `/api/attention` answers on a hub. */
function waiting(...workspaces: string[]) {
  const rows = workspaces.map((workspace, i) => ({ key: `${workspace}/gate/${i}`, workspace }) as unknown as AttentionRow);
  const data: AttentionList = { rows, workspaces: [...new Set(workspaces)], failed: [], now: "2026-11-26T12:00:00.000Z" };
  return { data, error: undefined, loading: false, reload: () => {} };
}

const HUB: Partial<StapleSession> = {
  mode: "hub",
  ws: "",
  workspaces: [
    { slug: "aardvark", prefix: "AAR" },
    { slug: "pinecone", prefix: "XYZ" },
  ],
};

/** The opening tag of the first element carrying `hook`. */
const tag = (markup: string, hook: string) => new RegExp(`<[a-z]+[^>]*${hook}[^>]*>`).exec(markup)?.[0] ?? "";

const shell = (over: Partial<StapleSession> = {}) =>
  inSession(
    <AppShell>
      <div data-the-view />
    </AppShell>,
    over,
  );

const rail = (over: Partial<StapleSession> = {}) => inSession(<NavRail mode="full" />, over);

/** Positions of the given markers, in the order given; every one must be present. */
function positions(markup: string, markers: readonly string[]): number[] {
  return markers.map((marker) => {
    const at = markup.indexOf(marker);
    expect(at, marker).toBeGreaterThan(-1);
    return at;
  });
}

const ascending = (list: readonly number[]) => [...list].every((at, i) => i === 0 || at > list[i - 1]!);

describe("the shell", () => {
  it("puts the rail before the content, and the top bar and toolbar before the view", () => {
    const markup = shell();
    expect(
      ascending(
        positions(markup, ['<nav aria-label="Primary"', "data-top-bar", "<h1", "data-toolbar", "<main", "data-the-view"]),
      ),
    ).toBe(true);
  });

  it("draws the rail on a desk always, full by default, sized from the shared tokens", () => {
    const nav = tag(shell(), 'aria-label="Primary"');
    expect(nav).toContain('data-rail-mode="full"');
    expect(nav).toContain("w-rail");
    const narrow = tag(inSession(<NavRail mode="narrow" />), 'aria-label="Primary"');
    expect(narrow).toContain('data-rail-mode="narrow"');
    expect(narrow).toContain("w-rail-narrow");
    // The width eases between the two, and never under reduced motion.
    expect(nav).toContain("transition-[width]");
    expect(nav).toContain("motion-reduce:transition-none");
    expect(/<header[^>]*data-top-bar[^>]*>/.exec(shell())?.[0]).toContain("h-topbar");
    expect(/<div[^>]*data-toolbar[^>]*>/.exec(shell())?.[0]).toContain("h-toolbar");
  });

  it("shows the sync pill for a workspace view, and never on a view about this computer", () => {
    const hub = { connected: 2, total: 3, automatic: 1 };
    const report = { counts: hub, workspaces: [] } as unknown as HubCloudReport;
    const bar = (view: StapleSession["view"]) =>
      inSession(<TopBar railMode="full" onToggleRail={noop} cloud={null} hubCloud={report} />, {
        view,
        mode: "hub",
        ws: "",
        workspaces: [{ slug: "staple", prefix: "STA" }],
      });
    expect(bar("tree")).toContain("2 of 3 syncing");
    expect(bar("budget")).not.toContain("syncing");
  });

  it("keeps the whole filter and view-options cluster in ONE toolbar: which tasks left, how they look right", () => {
    const markup = shell();
    const toolbar = markup.slice(markup.indexOf("data-toolbar"), markup.indexOf("<main"));
    expect(
      ascending(
        positions(toolbar, [
          'aria-label="Add a filter"',
          'data-filter-chips',
          'data-filter-preset=',
          "data-view-options",
          'aria-label="Group tasks"',
          'aria-label="Sort: ',
          'aria-label="Show done and cancelled tasks"',
          'aria-label="Search tasks"',
        ]),
      ),
    ).toBe(true);
    // The quick filters sit INSIDE the toolbar, beside Filter — not on a strip of their own.
    expect(markup.match(/data-filter-chips/g)).toHaveLength(1);
    expect(toolbar).toContain('data-variant="inline"');
  });

  it("draws no toolbar at all on a view with nothing to filter or arrange", () => {
    for (const view of ["queue", "calibration", "budget"] as const) {
      expect(shell({ view })).not.toContain("data-toolbar");
    }
    // Milestones honours Done alone: no 44px row for one button — it sits in the top bar.
    const milestones = shell({ view: "milestones" });
    expect(milestones).not.toContain("data-toolbar");
    const bar = milestones.slice(milestones.indexOf("data-top-bar"), milestones.indexOf("<main"));
    expect(bar).toContain('aria-label="Show finished milestones"');
    expect(bar.indexOf('aria-label="Show finished milestones"')).toBeLessThan(bar.indexOf("data-top-new-task"));
    expect(shell()).not.toMatch(/data-top-bar[\s\S]*?data-filter-done[\s\S]*?data-toolbar/);
  });

  it("lays the content in a card on the desk tint, a gutter all round, dropped below md", () => {
    const markup = shell();
    // `h-dvh`: the frame is the dynamic viewport, so a phone's collapsing toolbar never hides the foot.
    expect(markup).toMatch(/<div class="flex h-dvh bg-sidebar/);
    const frame = /class="([^"]*)"/.exec(tag(markup, "data-content-frame"))?.[1] ?? "";
    for (const cls of ["bg-card", "md:my-gutter", "md:mr-gutter", "md:rounded-xl", "md:border"]) {
      expect(frame).toContain(cls);
    }
    // The rail is always there on a desk, so the card never needs a gutter of its own on the left.
    expect(frame).not.toContain("md:ml-gutter");
    // The rail carries no border of its own; the card's hairline is the only edge.
    expect(markup).not.toMatch(/<nav aria-label="Primary"[^>]*border-r/);
  });
});

describe("the top bar", () => {
  const bar = (railMode: "full" | "narrow", over: Partial<StapleSession> = {}) => {
    const markup = inSession(<TopBar railMode={railMode} onToggleRail={noop} cloud={null} hubCloud={null} />, over);
    return markup.slice(markup.indexOf("data-top-bar"), markup.indexOf("data-top-search"));
  };

  it("leads with the rail's toggle, named for what it does and saying whether the rail is open", () => {
    const full = tag(bar("full"), "data-nav-toggle");
    expect(full).toContain('aria-label="Collapse navigation"');
    expect(full).toContain('aria-expanded="true"');
    expect(full).toContain('aria-keyshortcuts="["');
    const narrow = tag(bar("narrow"), "data-nav-toggle");
    expect(narrow).toContain('aria-label="Expand navigation"');
    expect(narrow).toContain('aria-expanded="false"');
    // First in the bar, before the page's name.
    const markup = bar("narrow", HUB);
    expect(markup.indexOf("data-nav-toggle")).toBeLessThan(markup.indexOf("data-scope-name"));
    expect(shell()).not.toContain("data-nav-show");
  });

  it("says only the page while the rail is full, because the rail's head already names the scope", () => {
    for (const over of [{}, HUB, { ...HUB, ws: "pinecone" }]) {
      const markup = bar("full", over);
      expect(markup).toMatch(/<h1[^>]*>Tasks<\/h1>/);
      expect(markup).not.toContain("data-scope-name");
      expect(markup).not.toContain("lucide-chevron-right");
    }
    // The shell on a desk starts full: the same.
    expect(shell(HUB)).not.toContain('data-workspace-switcher="crumb"');
  });

  it("says 'scope › page' while the rail is narrow, the scope being the switcher on a hub", () => {
    const all = bar("narrow", HUB);
    expect(ascending(positions(all, ['data-workspace-switcher="crumb"', "lucide-chevron-right", "<h1"]))).toBe(true);
    expect(tag(all, 'data-workspace-switcher="crumb"')).toContain('aria-label="Workspace: All workspaces. Switch workspace"');
    expect(all).toContain(">All workspaces</span>");
    expect(bar("narrow", { ...HUB, ws: "pinecone" })).toContain(">pinecone</span>");
    // One workspace: its name as words, not a menu of one.
    const single = bar("narrow");
    expect(single).not.toContain('data-workspace-switcher="crumb"');
    expect(single).toMatch(/<span data-scope-name="true"[^>]*>staple<\/span>/);
  });

  it("says 'This computer › Usage' on a view about this computer, at either width", () => {
    for (const mode of ["full", "narrow"] as const) {
      const markup = bar(mode, { ...HUB, view: "budget" });
      expect(markup).toMatch(/data-scope-name[^>]*>[\s\S]*?This computer<\/span>/);
      expect(markup).toContain("lucide-chevron-right");
      expect(markup).toMatch(/<h1[^>]*>Usage<\/h1>/);
      expect(markup).not.toContain('data-workspace-switcher="crumb"');
    }
  });

  it("ends with find-anything and the one primary action, New task", () => {
    const markup = shell(HUB);
    const top = markup.slice(markup.indexOf("data-top-bar"), markup.indexOf("data-toolbar"));
    expect(ascending(positions(top, ["data-nav-toggle", "<h1", "data-top-search", "data-top-new-task"]))).toBe(true);
    expect(tag(top, "data-top-new-task")).toContain('data-variant="default"');
    expect(top).toMatch(/data-top-search[\s\S]*?<kbd[^>]*>(⌘K|Ctrl K)<\/kbd>/);
  });
});

describe("the rail", () => {
  it("reads top to bottom: the head, then now, then the workspace's records, then this computer at the foot", () => {
    const markup = rail(HUB);
    expect(
      ascending(
        positions(markup, [
          'data-workspace-switcher="head"',
          'data-nav-group="top"',
          'data-nav-item="view:attention"',
          'data-nav-item="view:autopilot"',
          'data-nav-item="view:queue"',
          'data-nav-group="views"',
          'data-nav-item="view:tree"',
          'data-nav-item="view:graph"',
          'data-nav-item="view:milestones"',
          'data-nav-item="view:plan"',
          'data-nav-item="view:calibration"',
          'data-nav-group="machine"',
          'data-nav-item="view:budget"',
          "data-nav-integrations",
          "data-nav-settings",
          "data-nav-theme",
        ]),
      ),
    ).toBe(true);
    // The global verbs live in the top bar: the rail is only where you are.
    expect(markup).not.toContain("data-nav-new-task");
    expect(markup).not.toContain("data-nav-search");
  });

  it("sets the zones apart by space alone: no labels, nothing to fold, no workspace list", () => {
    const markup = rail(HUB);
    expect(markup).not.toContain("aria-expanded=\"true\"><span");
    expect(markup).not.toContain("data-nav-group-label");
    expect(markup).not.toContain(">Views<");
    expect(markup).not.toContain("data-nav-workspace");
    expect(markup).not.toContain("data-nav-brand");
    // The records zone stands 12px below now; the foot sits above one hairline.
    expect(tag(markup, 'data-nav-group="views"')).toContain("mt-3");
    expect(markup).toMatch(/<div class="[^"]*border-t border-sidebar-border\/70[^"]*"><ul role="list" data-nav-group="machine"/);
  });

  it("lists Plan only while planning is on", () => {
    expect(rail()).toContain('data-nav-item="view:plan"');
    expect(rail({ planningEnabled: false })).not.toContain('data-nav-item="view:plan"');
    expect(inSession(<NavRail mode="narrow" />, { planningEnabled: false })).not.toContain('data-nav-item="view:plan"');
  });

  it("sets every row at 32px on the type scale, filled only when it is the place", () => {
    expect(RAIL_ROW_CLASS).toContain("h-8");
    expect(RAIL_ROW_CLASS).toContain("rounded-lg");
    expect(RAIL_ROW_CLASS).toContain("text-body");
    // Active: medium weight and the foreground icon; the fill only when no child is the place.
    expect(RAIL_ROW_CLASS).toContain("[&[aria-current]:not([data-child-current])]:bg-surface-selected");
    expect(RAIL_ROW_CLASS).toContain("aria-[current]:font-medium");
    expect(RAIL_ROW_CLASS).toContain("aria-[current]:[&_svg]:text-foreground");
    expect(RAIL_ROW_CLASS).toContain("[&_svg]:size-4");
    // The one focus ring, drawn inside the row so the rail's edge cannot clip it.
    expect(RAIL_ROW_CLASS).toContain("focus-ring-inset");
  });

  it("offers Settings as a row and the theme as a switch at the foot", () => {
    const markup = rail();
    expect(markup).toMatch(/<button[^>]*aria-label="Settings"[^>]*>[\s\S]*?Settings<\/button>/);
    // On a desk the theme is an icon switch beside Settings, named for what it does.
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Dark mode"[^>]*data-nav-theme/);
  });

  it("draws every item in the model as a button, wearing its label", () => {
    const markup = rail();
    for (const id of ["top", "views", "machine"]) expect(markup).toContain(`data-nav-group="${id}"`);
    for (const label of ["Inbox", "Autopilot", "Queue", "Tasks", "Graph", "Milestones", "Plan", "Estimates", "Usage"]) {
      expect(markup).toContain(`>${label}</span>`);
    }
    expect(markup).toMatch(/<button type="button" data-nav-item="view:budget"/);
  });

  it("marks exactly the active view with aria-current, and moves it with the view", () => {
    const tree = rail({ view: "tree" });
    expect(tree.match(/aria-current="page"/g)).toHaveLength(1);
    expect(tree).toMatch(/data-nav-item="view:tree" aria-current="page"/);

    const graph = rail({ view: "graph" });
    expect(graph.match(/aria-current="page"/g)).toHaveLength(1);
    expect(graph).toMatch(/data-nav-item="view:graph" aria-current="page"/);
  });

  it("puts nothing in the tab order out of sequence", () => {
    expect(rail()).not.toContain("tabindex");
    expect(inSession(<NavRail mode="narrow" />)).not.toContain("tabindex");
  });
});

describe("the head", () => {
  const head = (over: Partial<StapleSession> = {}) => inSession(<WorkspaceSwitcher variant="head" />, over);
  const tile = (markup: string) => /<span[^>]*data-scope-tile[^>]*>([\s\S]*?)<\/span>/.exec(markup)?.[1] ?? "";

  it("is the workspace switcher on a hub: a button that opens the list, its chevrons on the right", () => {
    const markup = head(HUB);
    const button = tag(markup, 'data-workspace-switcher="head"');
    expect(button).toMatch(/^<button /);
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('aria-label="Workspace: All workspaces. Switch workspace"');
    expect(button).toContain('title="All workspaces"');
    expect(markup).toContain("lucide-chevrons-up-down");
    // The rail's head is the switcher.
    expect(rail(HUB)).toContain('<button type="button" aria-label="Workspace: All workspaces. Switch workspace"');
  });

  it("is the workspace's name as words with one workspace: nothing to open, no chevrons", () => {
    const markup = head();
    expect(tag(markup, 'data-workspace-switcher="head"')).toMatch(/^<div /);
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("lucide-chevrons-up-down");
    expect(markup).toContain(">staple</span>");
  });

  it("wears the app's mark for All workspaces and the workspace's letter, from its prefix, for one", () => {
    expect(tile(head(HUB))).toBe("◐");
    expect(tile(head({ ...HUB, ws: "pinecone" }))).toBe("X");
    expect(head({ ...HUB, ws: "pinecone" })).toContain(">pinecone</span>");
  });

  it("steps the name back to the secondary tone on a view about this computer", () => {
    const name = (markup: string) => tag(markup, "data-workspace-name");
    expect(name(head(HUB))).toContain("font-semibold text-foreground");
    expect(name(head({ ...HUB, view: "budget" }))).toContain("font-normal text-text-secondary");
  });

  it("is the scope's tile alone on the narrow rail, still the switcher", () => {
    const markup = inSession(<WorkspaceSwitcher variant="head" compact />, HUB);
    expect(tag(markup, 'data-workspace-switcher="head"')).toMatch(/^<button /);
    expect(markup).not.toContain("data-workspace-name");
    expect(markup).not.toContain("lucide-chevrons-up-down");
    // Its name is the button's own, not only a tooltip's.
    expect(tag(markup, 'data-workspace-switcher="head"')).toContain('aria-label="Workspace: All workspaces. Switch workspace"');
  });
});

describe("projects under Tasks", () => {
  const rows: ProjectRow[] = [
    { workspace: "staple", project: project({ id: "p-docs", slug: "docs", name: "Docs" }) },
    { workspace: "staple", project: project({ id: "p-site", slug: "site", name: "Site" }) },
  ];
  const withProjects = { projects: { data: rows, error: undefined, loading: false, reload: noop } };

  it("gives the Tasks row a New project action, reachable by keyboard, and no other row", () => {
    const markup = rail();
    const tasks = /<div class="group\/row relative">[\s\S]*?<\/div>/.exec(
      markup.slice(markup.indexOf('data-nav-item="view:tree"') - 200),
    )?.[0];
    expect(tasks).toContain('aria-label="New project"');
    expect(tasks).toContain('data-nav-action="new-project"');
    expect(markup.match(/data-nav-action=/g)).toHaveLength(1);
    // Hidden until hover, never out of the tab order.
    expect(markup).not.toContain("tabindex");
  });

  it("lists each project as a sub-row with its own settings gear, in served order, before Graph", () => {
    const markup = rail(withProjects);
    expect(
      ascending(
        positions(markup, [
          'data-nav-item="view:tree"',
          "data-nav-projects",
          'data-nav-project="p-docs"',
          'aria-label="Project settings: Docs"',
          'data-nav-project="p-site"',
          'aria-label="Project settings: Site"',
          'data-nav-item="view:graph"',
        ]),
      ),
    ).toBe(true);
    expect(markup).toContain('data-nav-project-settings="p-docs"');
  });

  it("hangs the projects on a spine under Tasks, each with a folder and its open-task count", () => {
    const issue = (identifier: string, projectId: string | null, status: IssueStatus = "todo"): IssueRow =>
      ({
        workspace: "staple",
        claim: null,
        issue: { id: identifier, identifier, title: identifier, status, projectId, kind: "task" },
      }) as unknown as IssueRow;
    const markup = rail({
      ...withProjects,
      issues: {
        data: [issue("A", "p-docs"), issue("B", "p-docs"), issue("C", "p-docs", "done"), issue("D", null)],
        error: undefined,
        loading: false,
        reload: noop,
      },
    });
    // The spine drops from the parent icon's centre: the list is indented and ruled on its left.
    expect(tag(markup, "data-nav-projects")).toMatch(/class="[^"]*ml-4[^"]*border-l[^"]*"/);
    const docs = /<button[^>]*data-nav-project="p-docs"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(docs).toContain("h-7");
    expect(docs).toContain("lucide-folder-kanban");
    // Two open, one done: the count is open work only, in the marks' register.
    expect(docs).toMatch(/data-nav-project-count[^>]*aria-label="2 open"[^>]*class="[^"]*tabular-nums[^"]*"[^>]*>2</);
    const site = /<button[^>]*data-nav-project="p-site"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(site).toMatch(/data-nav-project-count[^>]*>0</);
  });

  it("draws nothing under Tasks while there are no projects", () => {
    expect(rail()).not.toContain("data-nav-projects");
  });

  it("gives the one highlight to the project Tasks is narrowed to, Tasks keeping only its tone", () => {
    const filtered = { ...emptyFilters(), dims: { project: ["p-site"] } };
    const on = rail({ ...withProjects, filters: filtered });
    expect(on).toMatch(/data-nav-project="p-site" aria-current="true"/);
    expect(on).not.toMatch(/data-nav-project="p-docs" aria-current/);
    // The page is still Tasks, drawn without the fill.
    const tasks = tag(on, 'data-nav-item="view:tree"');
    expect(tasks).toContain('aria-current="page"');
    expect(tasks).toContain('data-child-current=""');
    expect(on.match(/aria-current="page"/g)).toHaveLength(1);
    // Unfiltered, narrowed to two, or on another view: no child is the place.
    const twoFilter = { ...emptyFilters(), dims: { project: ["p-site", "p-docs"] } };
    for (const markup of [rail(withProjects), rail({ ...withProjects, filters: twoFilter }), rail({ ...withProjects, filters: filtered, view: "graph" })]) {
      expect(markup).not.toContain('data-child-current=""');
      expect(markup).not.toContain('aria-current="true"');
    }
  });

  it("shows only the chosen workspace's projects when one is chosen, and every workspace's on all", () => {
    const many: ProjectRow[] = [
      ...rows,
      { workspace: "pinecone", project: project({ id: "p-pine", slug: "pine", name: "Pine" }) },
    ];
    const hub: Partial<StapleSession> = {
      mode: "hub",
      workspaces: [
        { slug: "staple", prefix: "STA" },
        { slug: "pinecone", prefix: "PIN" },
      ],
      projects: { data: many, error: undefined, loading: false, reload: noop },
    };
    const one = rail({ ...hub, ws: "pinecone" });
    expect(one).toContain('data-nav-project="p-pine"');
    expect(one).not.toContain('data-nav-project="p-docs"');
    const all = rail({ ...hub, ws: "" });
    expect(all).toContain('data-nav-project="p-pine"');
    expect(all).toContain('data-nav-project="p-docs"');
  });

  it("captions a project with its workspace only when the rows span several", () => {
    const one = rail(withProjects);
    const projectsOf = (markup: string) => markup.slice(markup.indexOf("data-nav-projects"), markup.indexOf('data-nav-item="view:graph"'));
    expect(projectsOf(one)).not.toContain(">staple</span>");
    const many: ProjectRow[] = [
      ...rows,
      { workspace: "pinecone", project: project({ id: "p-docs-2", slug: "docs", name: "Docs" }) },
    ];
    const hub = rail({
      mode: "hub",
      workspaces: [
        { slug: "staple", prefix: "STA" },
        { slug: "pinecone", prefix: "PIN" },
      ],
      projects: { data: many, error: undefined, loading: false, reload: noop },
    });
    expect(hub).toMatch(/data-nav-project="p-docs"[^>]*title="Docs · staple"/);
    expect(hub).toMatch(/data-nav-project="p-docs-2"[^>]*title="Docs · pinecone"/);
    expect(projectsOf(hub)).toContain(">pinecone</span>");
  });
});

describe("the workspace list", () => {
  const list = (over: Partial<StapleSession>, attention: Resource<AttentionList> = NO_ATTENTION, phone = false) =>
    inSession(<SwitcherList phone={phone} onChosen={noop} />, over, attention);
  const option = (markup: string, value: string) =>
    new RegExp(`<div[^>]*data-workspace-option="${value}"[^>]*>[\\s\\S]*?</div>`).exec(markup)?.[0] ?? "";

  it("is one line per workspace: the tile, the name, then the check on the current one", () => {
    const markup = list({ ...HUB, ws: "pinecone" });
    const pine = option(markup, "pinecone");
    expect(ascending(positions(pine, ["data-scope-tile", ">X</span>", ">pinecone", "lucide-check"]))).toBe(true);
    expect(tag(pine, 'data-workspace-option="pinecone"')).toContain('aria-current="true"');
    expect(pine).toMatch(/lucide-check[^"]*text-foreground opacity-100/);
    expect(option(markup, "aardvark")).toMatch(/lucide-check[^"]*opacity-0/);
    // All workspaces leads, wearing the app's mark.
    expect(option(markup, "").indexOf("◐")).toBeGreaterThan(-1);
    expect(markup.indexOf('data-workspace-option=""')).toBeLessThan(markup.indexOf('data-workspace-option="aardvark"'));
    // 36px on a desk, 48px on a phone; no second line of caption, no prefix column.
    expect(tag(pine, 'data-workspace-option="pinecone"')).toContain("h-9");
    expect(tag(option(list(HUB, NO_ATTENTION, true), "pinecone"), 'data-workspace-option="pinecone"')).toContain("h-12");
    expect(pine).not.toContain("Task numbers start with");
    expect(pine).not.toContain("font-mono");
  });

  it("keeps the prefix in the row's title, so it is still there to read", () => {
    expect(tag(option(list(HUB), "pinecone"), 'data-workspace-option="pinecone"')).toContain('title="pinecone · task numbers start with XYZ"');
  });

  it("says how much waits on a person in each workspace, the total on All workspaces, nothing at 0", () => {
    const markup = list(HUB, waiting("pinecone", "pinecone", "aardvark"));
    expect(option(markup, "pinecone")).toMatch(/data-workspace-waiting="2"[^>]*aria-label="2 waiting"[^>]*class="[^"]*tabular-nums[^"]*">2</);
    expect(option(markup, "aardvark")).toContain('data-workspace-waiting="1"');
    expect(option(markup, "")).toContain('data-workspace-waiting="3"');
    const none = list(HUB);
    expect(none).not.toContain("data-workspace-waiting");
  });
});

describe("the Integrations row", () => {
  const snapshot = (state: "ready" | "unauthenticated") => ({
    connectionId: "c1", state, message: null, action: null, identity: null, checkedAt: "2026-11-24T12:00:00Z", retryAfterSeconds: null,
  });
  const row = (health: ReturnType<typeof snapshot> | null) =>
    renderToStaticMarkup(<IntegrationsRailRow connections={[{ health }]} onClick={noop} />);

  it("carries an amber dot, named for assistive tech, when a connection needs attention", () => {
    const html = row(snapshot("unauthenticated"));
    expect(html).toContain("data-integrations-attention");
    expect(html).toContain('<span class="sr-only">, needs attention</span>');
  });

  it("has no dot when every connection is ready or not checked yet", () => {
    for (const html of [row(snapshot("ready")), row(null), renderToStaticMarkup(<IntegrationsRailRow connections={[]} onClick={noop} />)]) {
      expect(html).toContain(">Integrations");
      expect(html).not.toContain("data-integrations-attention");
      expect(html).not.toContain("needs attention");
    }
  });
});
