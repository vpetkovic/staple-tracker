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
  it("puts the rail before the content, and the content header before the view", () => {
    const markup = shell();
    expect(
      ascending(positions(markup, ['<nav aria-label="Primary"', "<header", "<h1", "<main", "data-the-view"])),
    ).toBe(true);
  });

  it("names the view in the content header, and keeps the whole filter cluster beside it", () => {
    const markup = shell();
    expect(markup).toMatch(/<h1[^>]*>Tasks<\/h1>/);
    expect(
      ascending(
        positions(markup, [
          "<h1",
          'aria-label="Group tasks"',
          'aria-label="Sort: ',
          'aria-label="Add a filter"',
          'aria-label="Show done and cancelled tasks"',
          'aria-label="Search tasks"',
        ]),
      ),
    ).toBe(true);
    expect(shell({ view: "queue" })).toMatch(/<h1[^>]*>Queue<\/h1>/);
  });

  it("offers no 'show navigation' button while the rail is on screen", () => {
    expect(shell()).not.toContain("data-nav-show");
  });

  it("lays the content in an inset card on the sidebar tint, with the inset dropped below md", () => {
    const markup = shell();
    expect(markup).toMatch(/<div class="flex h-full bg-sidebar/);
    const tag = /<div[^>]*data-content-frame[^>]*>/.exec(markup)?.[0] ?? "";
    const frame = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
    for (const cls of ["bg-card", "md:mt-2", "md:mr-2", "md:mb-2", "md:rounded-tl-lg", "md:border"]) {
      expect(frame).toContain(cls);
    }
    // The rail carries no border of its own; the card's hairline is the only edge.
    expect(markup).not.toMatch(/<nav aria-label="Primary"[^>]*border-r/);
  });
});

describe("the rail", () => {
  it("reads top to bottom: switcher, New task, search, the Workspace group, settings, theme", () => {
    const markup = rail();
    expect(
      ascending(
        positions(markup, [
          "data-workspace-switcher",
          "data-nav-new-task",
          'aria-label="Open the command palette"',
          'data-nav-group="workspace"',
          'data-nav-item="view:tree"',
          'data-nav-item="view:queue"',
          'data-nav-item="view:graph"',
          'data-nav-item="view:milestones"',
          'aria-label="Work Workspace Settings"',
          "data-nav-theme",
        ]),
      ),
    ).toBe(true);
  });

  it("sets every row at 28px with a fill-only active state and icons that follow the row", () => {
    expect(RAIL_ROW_CLASS).toContain("h-7");
    expect(RAIL_ROW_CLASS).toContain("rounded-md");
    expect(RAIL_ROW_CLASS).toContain("px-2");
    expect(RAIL_ROW_CLASS).toContain("text-[13px]");
    expect(RAIL_ROW_CLASS).toContain("aria-[current]:bg-surface-selected");
    expect(RAIL_ROW_CLASS).toContain("[&_svg]:size-4");
    expect(RAIL_ROW_CLASS).not.toContain("font-medium");
  });

  it("labels the group in sentence case, muted, with no letter spacing", () => {
    const label = /<button[^>]*data-nav-group-label[^>]*>/.exec(rail())?.[0] ?? "";
    expect(label).toContain("text-[12px]");
    expect(label).toContain("text-muted-foreground");
    expect(label).not.toContain("uppercase");
    expect(label).not.toContain("tracking-");
    expect(rail()).toMatch(/data-nav-group-label[^>]*>Workspace</);
  });

  it("offers Settings and a Dark mode switch as ordinary rows at the foot", () => {
    const markup = rail();
    expect(markup).toMatch(/<button[^>]*aria-label="Work Workspace Settings"[^>]*>[\s\S]*?Settings<\/button>/);
    expect(markup).toMatch(/<button[^>]*role="switch"[^>]*aria-checked="false"[^>]*data-nav-theme[^>]*>[\s\S]*?Dark mode<\/button>/);
  });

  it("draws every group in the model with its label as a disclosure, and every item as a button", () => {
    const markup = rail();
    for (const group of NAV_GROUPS) {
      expect(markup).toContain(`data-nav-group="${group.id}"`);
      expect(markup).toMatch(new RegExp(`aria-expanded="true"[^>]*>${group.label}`));
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

  it("puts a bordered New task button beside a bordered search button on one row, shortcuts in tooltips", () => {
    const markup = rail();
    const newTask = /<button[^>]*data-nav-new-task[^>]*>/.exec(markup)?.[0] ?? "";
    expect(newTask).toContain('data-variant="outline"');
    expect(newTask).toContain("h-7");
    const search = /<button[^>]*data-nav-search[^>]*>/.exec(markup)?.[0] ?? "";
    expect(search).toContain('data-variant="outline"');
    expect(search).toContain('aria-label="Open the command palette"');
    // Nothing is filled, and no shortcut chip sits beside a word: the tooltips carry them.
    expect(markup).not.toContain('data-variant="cta"');
    expect(markup).not.toContain("<kbd");
    expect(markup.indexOf("data-nav-new-task")).toBeLessThan(markup.indexOf("data-nav-search"));
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
    expect(docs).toContain("pl-6");
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
    expect(one).not.toContain(">staple</span></button>");
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
    expect(hub).toContain(">pinecone</span>");
  });
});

describe("the workspace switcher", () => {
  it("names the one workspace outside hub mode, and keeps the prefix off the trigger", () => {
    const markup = rail();
    const trigger = /<button[^>]*data-workspace-switcher[^>]*>[\s\S]*?<\/button>/.exec(markup)?.[0] ?? "";
    expect(trigger).toContain('aria-label="Workspace"');
    expect(trigger).toContain(">staple</span>");
    expect(trigger).not.toContain(">STA<");
  });

  it("says All workspaces in hub mode until one is chosen, then names it", () => {
    const hub: Partial<StapleSession> = {
      mode: "hub",
      workspaces: [
        { slug: "staple", prefix: "STA" },
        { slug: "pinecone", prefix: "PIN" },
      ],
    };
    const all = /<button[^>]*data-workspace-switcher[^>]*>[\s\S]*?<\/button>/.exec(rail({ ...hub, ws: "" }))?.[0];
    expect(all).toContain(">All workspaces</span>");
    expect(all).toContain(">2 workspaces</span>");

    const one = /<button[^>]*data-workspace-switcher[^>]*>[\s\S]*?<\/button>/.exec(
      rail({ ...hub, ws: "pinecone" }),
    )?.[0];
    expect(one).toContain(">pinecone</span>");
    expect(one).not.toContain(">PIN<");
  });
});
