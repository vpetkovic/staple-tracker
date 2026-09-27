/**
 * The shell, rendered to a string: a rail on the left, a content header on the right,
 * and every control the old two-tier header held still on the page.
 *
 * No jsdom here, as everywhere in this repo — `react-dom/server` answers which elements
 * exist, in what order, with what accessible names. That is exactly what the claims
 * below are about: the rail's rows come in the order the model says, the active view is
 * the one `aria-current` marks, and the New task row is unmistakably a button.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { AppShell } from "@/components/AppShell";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters } from "@/lib/filters";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { IssueRow, IssueStatus, Project, ProjectRow } from "@/lib/types";
import { NAV_GROUPS } from "./nav-model";
import { NavRail, RAIL_ROW_CLASS } from "./NavRail";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";

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

const inSession = (node: ReactElement, over: Partial<StapleSession> = {}) =>
  renderToStaticMarkup(<SessionContext.Provider value={session(over)}>{node}</SessionContext.Provider>);

const shell = (over: Partial<StapleSession> = {}) =>
  inSession(
    <AppShell>
      <div data-the-view />
    </AppShell>,
    over,
  );

const rail = (over: Partial<StapleSession> = {}) => inSession(<NavRail onHide={noop} />, over);

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

  it("reads 'scope › page' in the top bar, then find-anything and the one primary action, New task", () => {
    const markup = shell();
    expect(markup).toMatch(/<h1[^>]*>Tasks<\/h1>/);
    const bar = markup.slice(markup.indexOf("data-top-bar"), markup.indexOf("data-toolbar"));
    expect(
      ascending(positions(bar, ["data-scope-name", "<h1", "data-top-search", "data-top-new-task"])),
    ).toBe(true);
    // The scope is the switcher: a click on it opens the workspace list.
    expect(bar).toMatch(/data-workspace-switcher="crumb"[^>]*data-scope-name/);
    // New task is the chrome's one filled button; find-anything shows its shortcut.
    const newTask = /<button[^>]*data-top-new-task[^>]*>/.exec(bar)?.[0] ?? "";
    expect(newTask).toContain('data-variant="default"');
    expect(bar).toMatch(/data-top-search[\s\S]*?<kbd[^>]*>(⌘K|Ctrl K)<\/kbd>/);
    expect(shell({ view: "queue" })).toMatch(/<h1[^>]*>Queue<\/h1>/);
  });

  it("says This computer — not a workspace — as the scope of a view about this computer", () => {
    const markup = shell({ view: "budget", mode: "hub", ws: "", workspaces: [{ slug: "staple", prefix: "STA" }] });
    expect(markup).toMatch(/data-scope-name[^>]*>[\s\S]*?This computer<\/span>/);
    expect(markup).not.toContain('data-workspace-switcher="crumb"');
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
    // Milestones honours Done alone, so its toolbar holds exactly that.
    const milestones = shell({ view: "milestones" });
    expect(milestones).toContain("data-toolbar");
    expect(milestones).toContain('aria-label="Show finished milestones"');
    expect(milestones).not.toContain('aria-label="Add a filter"');
  });

  it("offers no 'show navigation' button while the rail is on screen", () => {
    expect(shell()).not.toContain("data-nav-show");
  });

  it("lays the content in a card on the desk tint, a gutter all round, dropped below md", () => {
    const markup = shell();
    // `h-dvh`: the frame is the dynamic viewport, so a phone's collapsing toolbar never hides the foot.
    expect(markup).toMatch(/<div class="flex h-dvh bg-sidebar/);
    const tag = /<div[^>]*data-content-frame[^>]*>/.exec(markup)?.[0] ?? "";
    const frame = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
    for (const cls of ["bg-card", "md:my-gutter", "md:mr-gutter", "md:rounded-xl", "md:border"]) {
      expect(frame).toContain(cls);
    }
    // The rail carries no border of its own; the card's hairline is the only edge.
    expect(markup).not.toMatch(/<nav aria-label="Primary"[^>]*border-r/);
  });

  it("sizes the chrome from the shared tokens, not from one-off pixel values", () => {
    const markup = shell();
    expect(/<header[^>]*data-top-bar[^>]*>/.exec(markup)?.[0]).toContain("h-topbar");
    expect(/<div[^>]*data-toolbar[^>]*>/.exec(markup)?.[0]).toContain("h-toolbar");
    expect(/<nav aria-label="Primary"[^>]*>/.exec(markup)?.[0]).toContain("w-rail");
    expect(/<header[^>]*data-top-bar[^>]*>/.exec(markup)?.[0]).toContain("px-page");
  });
});

describe("the rail", () => {
  const hub = {
    mode: "hub" as const,
    ws: "",
    workspaces: [
      { slug: "aardvark", prefix: "AAR" },
      { slug: "staple", prefix: "STA" },
    ],
  };

  it("reads top to bottom: the mark, the workspaces, the views, This computer, settings, theme", () => {
    const markup = rail(hub);
    expect(
      ascending(
        positions(markup, [
          "data-nav-brand",
          'data-nav-group="workspaces"',
          'data-nav-workspace=""',
          'data-nav-workspace="aardvark"',
          'data-nav-workspace="staple"',
          'data-nav-group="views"',
          'data-nav-item="view:tree"',
          'data-nav-item="view:queue"',
          'data-nav-item="view:graph"',
          'data-nav-item="view:milestones"',
          'data-nav-group="machine"',
          'data-nav-item="view:budget"',
          'aria-label="Settings"',
          "data-nav-theme",
        ]),
      ),
    ).toBe(true);
    // The global verbs live in the top bar now: the rail is only where you are.
    expect(markup).not.toContain("data-nav-new-task");
    expect(markup).not.toContain("data-nav-search");
  });

  it("shows the scope and the way to change it without a menu: every workspace, the current one marked", () => {
    const all = rail(hub);
    expect(all.match(/data-nav-workspace=/g)).toHaveLength(3);
    expect(all).toMatch(/data-nav-workspace="" aria-current="true"/);
    expect(all.match(/data-nav-workspace="[^"]*" aria-current/g)).toHaveLength(1);
    const chosen = rail({ ...hub, ws: "staple" });
    expect(chosen).toMatch(/data-nav-workspace="staple" aria-current="true"/);
    expect(chosen).not.toMatch(/data-nav-workspace="" aria-current/);
    // A single-workspace page lists its one workspace under "Workspace".
    expect(rail()).toMatch(/data-nav-workspace="staple" aria-current="true"/);
    expect(rail()).toMatch(/data-nav-group-name="true" class="truncate">Workspace</);
  });

  it("puts the workspaces that do not fit behind More workspaces, with a count", () => {
    const many = rail({
      mode: "hub",
      ws: "",
      workspaces: Array.from({ length: 9 }, (_, i) => ({ slug: `w${i}`, prefix: `W${i}` })),
    });
    expect(many.match(/data-nav-workspace=/g)).toHaveLength(7);
    expect(many).toMatch(/data-workspace-switcher="more"[\s\S]*?More workspaces[\s\S]*?>3<\/span>/);
    expect(rail(hub)).not.toContain('data-workspace-switcher="more"');
  });

  it("sets every row at 32px on the type scale, with an unmistakable active state", () => {
    expect(RAIL_ROW_CLASS).toContain("h-8");
    expect(RAIL_ROW_CLASS).toContain("rounded-lg");
    expect(RAIL_ROW_CLASS).toContain("text-body");
    // Active: a fill, medium weight, the foreground icon — the fill alone was too quiet.
    expect(RAIL_ROW_CLASS).toContain("aria-[current]:bg-surface-selected");
    expect(RAIL_ROW_CLASS).toContain("aria-[current]:font-medium");
    expect(RAIL_ROW_CLASS).toContain("aria-[current]:[&_svg]:text-foreground");
    expect(RAIL_ROW_CLASS).toContain("[&_svg]:size-4");
    // The one focus ring, drawn inside the row so the rail's edge cannot clip it.
    expect(RAIL_ROW_CLASS).toContain("focus-ring-inset");
  });

  it("labels each group in plain sentence case, tertiary, with no letter spacing", () => {
    const markup = rail(hub);
    const label = /<button[^>]*data-nav-group-label[^>]*>/.exec(markup)?.[0] ?? "";
    expect(label).toContain("text-label");
    expect(label).toContain("text-text-tertiary");
    expect(label).not.toContain("uppercase");
    expect(label).not.toContain("tracking-");
    for (const name of ["Workspaces", "Views", "This computer"]) {
      expect(markup).toMatch(new RegExp(`data-nav-group-name="true" class="truncate">${name}<`));
    }
  });

  it("never names the first workspace as the scope on All workspaces", () => {
    const markup = rail(hub);
    expect(markup).toMatch(/data-nav-workspace="" aria-current="true"[^>]*>[\s\S]*?All workspaces<\/span>/);
    expect(markup).not.toMatch(/data-nav-workspace="aardvark" aria-current/);
  });

  it("offers Settings as a row and the theme as a switch at the foot", () => {
    const markup = rail();
    // DELIBERATELY CHANGED from "Work Workspace Settings": Settings is global now.
    expect(markup).toMatch(/<button[^>]*aria-label="Settings"[^>]*>[\s\S]*?Settings<\/button>/);
    expect(markup).not.toContain("Work Workspace Settings");
    // On a desk the theme is an icon switch beside Settings, named for what it does.
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*aria-label="Dark mode"[^>]*data-nav-theme/);
  });

  it("draws every group in the model with its label as a disclosure, and every item as a button", () => {
    const markup = rail();
    for (const group of NAV_GROUPS) {
      expect(markup).toContain(`data-nav-group="${group.id}"`);
      expect(markup).toMatch(new RegExp(`aria-expanded="true"[^>]*><span[^>]*>${group.label}`));
      for (const entry of group.items) {
        expect(markup).toMatch(new RegExp(`<button type="button" data-nav-item="${entry.id}"`));
        expect(markup).toContain(`>${entry.label}</span>`);
      }
    }
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
  });
});

describe("projects under Tasks", () => {
  const rows: ProjectRow[] = [
    { workspace: "staple", project: project({ id: "p-docs", slug: "docs", name: "Docs" }) },
    { workspace: "staple", project: project({ id: "p-site", slug: "site", name: "Site" }) },
  ];

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

  it("lists each project as a sub-row with its own settings gear, in served order", () => {
    const markup = rail({ projects: { data: rows, error: undefined, loading: false, reload: noop } });
    expect(
      ascending(
        positions(markup, [
          'data-nav-item="view:tree"',
          "data-nav-projects",
          'data-nav-project="p-docs"',
          'aria-label="Project settings: Docs"',
          'data-nav-project="p-site"',
          'aria-label="Project settings: Site"',
          'data-nav-item="view:queue"',
        ]),
      ),
    ).toBe(true);
    expect(markup).toContain('data-nav-project-settings="p-docs"');
  });

  it("draws each project with a glyph one step in and its open-task count from the rows on hand", () => {
    const issue = (identifier: string, projectId: string | null, status: IssueStatus = "todo"): IssueRow =>
      ({
        workspace: "staple",
        claim: null,
        issue: {
          id: identifier,
          identifier,
          title: identifier,
          description: null,
          status,
          statusVersion: 0,
          kind: "task",
          priority: "medium",
          parentId: null,
          depth: 0,
          assignee: null,
          createdBy: null,
          labels: [],
          acceptanceCriteria: null,
          blockParentUntilDone: false,
          unblockOwner: null,
          unblockAction: null,
          originKind: "manual",
          originId: null,
          idempotencyKey: null,
          checkoutAgent: null,
          checkoutAt: null,
          blockedTransitionAt: null,
          estimatedSeconds: null,
          projectId,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          createdAt: "2026-09-05T00:00:00.000Z",
          updatedAt: "2026-09-05T00:00:00.000Z",
        },
      });
    const markup = rail({
      projects: { data: rows, error: undefined, loading: false, reload: noop },
      issues: {
        data: [issue("A", "p-docs"), issue("B", "p-docs"), issue("C", "p-docs", "done"), issue("D", null)],
        error: undefined,
        loading: false,
        reload: noop,
      },
    });
    const docs = /<button[^>]*data-nav-project="p-docs"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(docs).toContain("pl-7");
    expect(docs).toContain("lucide-folder-kanban");
    // Two open, one done: the count is open work only.
    expect(docs).toMatch(/data-nav-project-count[^>]*aria-label="2 open"[^>]*>2</);
    const site = /<button[^>]*data-nav-project="p-site"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(site).toMatch(/data-nav-project-count[^>]*>0</);
  });

  it("draws nothing under Tasks while there are no projects", () => {
    expect(rail()).not.toContain("data-nav-projects");
  });

  it("marks the project the list is narrowed to, and only on Tasks", () => {
    const filtered = { ...emptyFilters(), dims: { project: ["p-site"] } };
    const on = rail({ projects: { data: rows, error: undefined, loading: false, reload: noop }, filters: filtered });
    expect(on).toMatch(/data-nav-project="p-site" aria-current="true"/);
    expect(on).not.toMatch(/data-nav-project="p-docs" aria-current/);
    // The view row keeps `page`; the project is a place within it.
    expect(on.match(/aria-current="page"/g)).toHaveLength(1);
    const elsewhere = rail({
      projects: { data: rows, error: undefined, loading: false, reload: noop },
      filters: filtered,
      view: "graph",
    });
    expect(elsewhere).not.toMatch(/data-nav-project="p-site" aria-current/);
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

  it("closes the sheet before it opens the dialog, from the + and from every gear", () => {
    /*
     * A dialog stacked on the open sheet would make Escape ambiguous. The click handlers
     * cannot be exercised without a DOM, so what is pinned is the source: every call
     * that opens the project dialog is immediately preceded by the navigate callback.
     */
    const text = readFileSync(fileURLToPath(new URL("./NavRail.tsx", import.meta.url)), "utf8").replace(
      /\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
      "",
    );
    const opens = text.match(/openProjectDialog\(/g) ?? [];
    expect(opens.length).toBeGreaterThanOrEqual(2);
    expect((text.match(/onNavigate\?\.\(\);\s*openProjectDialog\(/g) ?? []).length).toBe(opens.length);
  });

  it("captions a project with its workspace only when the rows span several", () => {
    const one = rail({ projects: { data: rows, error: undefined, loading: false, reload: noop } });
    const projectsOf = (markup: string) => markup.slice(markup.indexOf("data-nav-projects"), markup.indexOf('data-nav-item="view:queue"'));
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

describe("the workspace switcher", () => {
  const trigger = (markup: string) => /<button[^>]*data-workspace-switcher[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
  // The drawer's trigger (the phone's menu), rendered on its own.
  const drawer = (over: Partial<StapleSession> = {}) => inSession(<WorkspaceSwitcher variant="rail" />, over);

  it("names the one workspace outside hub mode, and keeps the prefix off the trigger", () => {
    const button = trigger(drawer());
    expect(button).toContain('aria-label="Workspace: staple. Workspace"');
    expect(button).toContain(">staple</span>");
    expect(button).not.toContain(">STA<");
  });

  /**
   * DELIBERATELY CHANGED. The count caption beside the name is gone from the trigger — it
   * was what truncated the name to "All wo…" — and the name may wrap to a second line
   * rather than ever being cut short.
   */
  it("says the FULL selection — All workspaces in hub mode until one is chosen, then its name", () => {
    const hub: Partial<StapleSession> = {
      mode: "hub",
      workspaces: [
        { slug: "staple", prefix: "STA" },
        { slug: "pinecone", prefix: "PIN" },
      ],
    };
    const all = trigger(drawer({ ...hub, ws: "" }));
    expect(all).toMatch(/data-workspace-name="true" class="[^"]*line-clamp-2[^"]*">All workspaces<\/span>/);
    expect(all).not.toContain("truncate");
    expect(all).not.toContain("workspaces</span><span");
    expect(all).toContain('aria-label="Workspace: All workspaces. Switch workspace"');

    const one = trigger(drawer({ ...hub, ws: "pinecone" }));
    expect(one).toContain(">pinecone</span>");
    expect(one).not.toContain(">PIN<");
  });

  it("is the top bar's scope on a desk: the full selection, named as the switcher it is", () => {
    const hub: Partial<StapleSession> = {
      mode: "hub",
      workspaces: [
        { slug: "staple", prefix: "STA" },
        { slug: "pinecone", prefix: "PIN" },
      ],
    };
    const crumb = (markup: string) => /<button[^>]*data-workspace-switcher="crumb"[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    const all = crumb(shell({ ...hub, ws: "" }));
    expect(all).toContain('aria-label="Workspace: All workspaces. Switch workspace"');
    expect(all).toContain(">All workspaces</span>");
    const one = crumb(shell({ ...hub, ws: "pinecone" }));
    expect(one).toContain(">pinecone</span>");
    expect(one).not.toContain(">PIN<");
  });
});
