/**
 * The narrow rail, rendered to a string: icons only, each a named button, the Inbox count and
 * the live dot on the icons, no sub-rows.
 *
 * This browser has seen one Inbox row ("seen/1"): the seen-list is read once per module from
 * localStorage, so it is stubbed before anything renders, and the Inbox badge can be drawn
 * both quiet (every waiting row seen) and fresh (one new row) from the real store.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", {
  getItem: (key: string) => (key === "staple:inbox-seen:v1" ? JSON.stringify({ started: true, seen: ["seen/1"] }) : null),
  setItem: () => {},
  removeItem: () => {},
});

const { buildFilterContext } = await import("@/lib/filter-dimensions");
const { emptyFilters } = await import("@/lib/filters");
const { AttentionContext } = await import("@/lib/attention");
const { buildRunsState, RunsContext } = await import("@/lib/runs");
const { SessionContext } = await import("@/lib/session");
const { DEFAULT_SORT } = await import("@/lib/sort-modes");
const { NavRail } = await import("./NavRail");
import type { StapleSession, ViewName } from "@/lib/session";
import type { AttentionRow, ProjectRow, RunEntry } from "@/lib/types";

const noop = () => {};

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    planningEnabled: true,
    mode: "hub",
    workspaces: [{ slug: "staple", prefix: "STA" }],
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    run: null,
    openRun: noop,
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
  } as StapleSession;
}

function liveRun(id: string, state: "active" | "paused" = "active"): RunEntry {
  return {
    workspace: "staple",
    title: `Run ${id}`,
    issues: [],
    run: { id, actor: "opus", state, scope: { kind: "queue" }, tickets: [], counts: { tickets: 0, taken: 0, done: 0, failed: 0, open: 0 }, stop: null },
    decision: { stop: false },
  } as unknown as RunEntry;
}

function inbox(keys: readonly string[]) {
  const rows = keys.map((key) => ({ key, workspace: "staple" }) as unknown as AttentionRow);
  return { data: { rows, workspaces: ["staple"], failed: [], now: "2026-11-26T12:00:00.000Z" }, error: undefined, loading: false, reload: noop };
}

function narrow(over: Partial<StapleSession> = {}, keys: readonly string[] = [], runs: RunEntry[] = []) {
  return renderToStaticMarkup(
    <SessionContext.Provider value={session(over)}>
      <AttentionContext value={inbox(keys)}>
        <RunsContext value={buildRunsState(runs)}>
          <NavRail mode="narrow" />
        </RunsContext>
      </AttentionContext>
    </SessionContext.Provider>,
  );
}

/** The opening tag of the first element carrying `hook`. */
const tag = (markup: string, hook: string) => new RegExp(`<[a-z]+[^>]*${hook}[^>]*>`).exec(markup)?.[0] ?? "";
const button = (markup: string, item: string) => tag(markup, `data-nav-item="view:${item}"`);

describe("the narrow rail", () => {
  it("draws every row as a named 36px icon button, in the full rail's order, with no words beside them", () => {
    const markup = narrow();
    const order = [...markup.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual([
      "Workspace: All workspaces. Switch workspace",
      "Inbox",
      "Autopilot",
      "Queue",
      "Tasks",
      "Graph",
      "Milestones",
      "Plan",
      "Estimates",
      "Usage",
      "Integrations",
      "Settings",
      "Dark mode",
    ]);
    expect(button(markup, "tree")).toContain("size-9");
    expect(markup).not.toContain(">Tasks</span>");
  });

  it("marks the page with aria-current and fills it, one row only", () => {
    for (const view of ["tree", "graph", "budget", "autopilot"] as ViewName[]) {
      const markup = narrow({ view });
      expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
      expect(button(markup, view)).toContain('aria-current="page"');
    }
  });

  it("badges the Inbox with what waits, quiet while it has all been seen, 99+ past 99", () => {
    expect(narrow()).not.toContain("data-nav-inbox-count");
    const seen = narrow({}, ["seen/1"]);
    const badge = tag(seen, "data-nav-inbox-count");
    expect(seen).toMatch(/data-nav-inbox-count="true"[^>]*>1</);
    expect(badge).toContain("from-surface-selected");
    expect(badge).not.toContain("--badge-fresh");
    expect(button(seen, "attention")).toContain('aria-label="Inbox, 1 waiting"');
    const many = narrow({}, Array.from({ length: 120 }, (_, i) => (i === 0 ? "seen/1" : `seen/1-${i}`)));
    expect(many).toMatch(/data-nav-inbox-count="true"[^>]*>99\+</);
  });

  it("puts the badge in the accent while something waiting is new to this browser, and says so", () => {
    const fresh = narrow({}, ["seen/1", "new/1"]);
    expect(tag(fresh, "data-nav-inbox-count")).toContain("bg-[var(--badge-fresh)]");
    expect(button(fresh, "attention")).toContain('aria-label="Inbox, 2 waiting, 1 new"');
  });

  it("dots Autopilot only while a run is live, in the runs' tone, and lists no runs under it", () => {
    // Nothing live: no dot at all on the icon, not merely no hook.
    const idle = /<button[^>]*data-nav-item="view:autopilot"[\s\S]*?<\/button>/.exec(narrow())?.[0] ?? "";
    expect(idle).not.toContain("data-nav-autopilot-live");
    expect(idle).not.toContain("rounded-full");
    const working = narrow({}, [], [liveRun("a"), liveRun("b", "paused")]);
    expect(tag(working, "data-nav-autopilot-live")).toContain("var(--plain-ok-fg)");
    expect(button(working, "autopilot")).toContain('aria-label="Autopilot, 2 live"');
    expect(tag(narrow({}, [], [liveRun("b", "paused")]), "data-nav-autopilot-live")).toContain("var(--plain-tight-fg)");
    expect(working).not.toContain("data-nav-run=");
  });

  it("draws no sub-rows and no row actions: no projects, no New project", () => {
    const rows: ProjectRow[] = [{ workspace: "staple", project: { id: "p-1", slug: "docs", name: "Docs" } as ProjectRow["project"] }];
    const markup = narrow({ projects: { data: rows, error: undefined, loading: false, reload: noop } });
    expect(markup).not.toContain("data-nav-projects");
    expect(markup).not.toContain("data-nav-action");
  });

  it("keeps each button 36px under a finger, its 44px an invisible hit area, never a bigger box", () => {
    const tasks = button(narrow(), "tree");
    expect(tasks).not.toContain("pointer-coarse:size-11");
    expect(tasks).toContain("pointer-coarse:min-h-0");
    expect(tasks).toContain("pointer-coarse:before:-inset-1");
  });
});
