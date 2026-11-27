/**
 * While the server is not answering the page's polls, the navigation says so once and dims its
 * marks; while it answers, nothing of this shows. `useConnection` is a page-wide store whose
 * server snapshot is always "live", so a string render cannot reach "reconnecting" through it:
 * the hook is replaced here by one the test sets.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";

let connection: "live" | "reconnecting" = "live";
// A live run's line is a link built from the page's address.
vi.stubGlobal("window", { location: { href: "http://127.0.0.1/?view=tasks" } });
vi.mock("@/lib/useStaple", async (original) => ({
  ...(await original<typeof import("@/lib/useStaple")>()),
  useConnection: () => connection,
}));

const { buildFilterContext } = await import("@/lib/filter-dimensions");
const { emptyFilters } = await import("@/lib/filters");
const { AttentionContext } = await import("@/lib/attention");
const { buildRunsState, RunsContext } = await import("@/lib/runs");
const { SessionContext } = await import("@/lib/session");
const { DEFAULT_SORT } = await import("@/lib/sort-modes");
const { NavRail, RAIL_ROW_CLASS } = await import("./NavRail");
const { ViewTabs } = await import("./ViewTabBar");
const { STALE_MARKS_CLASS } = await import("./nav-shared");
import type { StapleSession } from "@/lib/session";
import type { AttentionRow, ProjectRow, RunEntry } from "@/lib/types";

const noop = () => {};

const session = {
  planningEnabled: true,
  mode: "workspace",
  workspaces: [{ slug: "staple", prefix: "STA" }],
  view: "tree",
  setView: noop,
  milestoneFocus: null,
  focusMilestone: noop,
  run: null,
  openRun: noop,
  projects: {
    data: [{ workspace: "staple", project: { id: "p-1", slug: "docs", name: "Docs" } }] as ProjectRow[],
    error: undefined,
    loading: false,
    reload: noop,
  },
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
} as unknown as StapleSession;

const run = {
  workspace: "staple",
  title: "Run a",
  issues: [],
  run: {
    id: "a",
    actor: "opus",
    state: "active",
    scope: { kind: "queue" },
    budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null },
    goal: null,
    tickets: [],
    counts: { tickets: 0, taken: 0, done: 0, failed: 0, open: 0 },
    stop: null,
  },
  decision: { stop: false },
  facts: null,
  driver: null,
  goal: null,
  instructionsChanged: [],
} as unknown as RunEntry;
const inbox = {
  data: { rows: [{ key: "staple/gate/1", workspace: "staple" } as unknown as AttentionRow], workspaces: ["staple"], failed: [], now: "2026-11-26T12:00:00.000Z" },
  error: undefined,
  loading: false,
  reload: noop,
};

function render(node: ReactElement, state: "live" | "reconnecting"): string {
  connection = state;
  return renderToStaticMarkup(
    <SessionContext.Provider value={session}>
      <AttentionContext value={inbox}>
        <RunsContext value={buildRunsState([run])}>{node}</RunsContext>
      </AttentionContext>
    </SessionContext.Provider>,
  );
}

const tag = (markup: string, hook: string) => new RegExp(`<[a-z]+[^>]*${hook}[^>]*>`).exec(markup)?.[0] ?? "";
/** The hooks of every element marked as a mark, in document order. */
const marks = (markup: string) => [...markup.matchAll(/<[a-z]+[^>]* data-nav-mark="[^"]*"[^>]*>/g)].map((match) => match[0]);

describe("the full rail while reconnecting", () => {
  it("says Reconnecting once, as a polite status above the foot, and nothing while live", () => {
    const live = render(<NavRail mode="full" />, "live");
    expect(live).not.toContain("data-nav-connection");
    expect(live).not.toContain("Reconnecting");
    // The live region is there before anything is said in it.
    expect(live).toContain('role="status" aria-live="polite"');

    const markup = render(<NavRail mode="full" />, "reconnecting");
    const status = /<div role="status" aria-live="polite"[^>]*>[\s\S]*?Reconnecting<\/div><\/div>/.exec(markup)?.[0] ?? "";
    expect(status).toContain('data-nav-connection="reconnecting"');
    expect(markup.match(/Reconnecting/g)).toHaveLength(1);
    // Not a control: no button, no link.
    expect(status).not.toMatch(/<(button|a) /);
    // A row's shape in the label register, the dot in the waiting tone, breathing only with motion.
    expect(tag(status, "data-nav-connection")).toMatch(/class="[^"]*h-7[^"]*text-label text-text-tertiary/);
    expect(status).toMatch(/bg-\[var\(--plain-tight-fg\)\][^"]*motion-safe:animate-\[staple-breathe/);
    expect(status).toMatch(/bg-\[var\(--plain-tight-fg\)\][^"]*forced-color-adjust-none/);
    // In its own slot after the scrolling body, before the foot's hairline: never scrolled out of sight.
    expect(markup.indexOf("data-nav-connection")).toBeGreaterThan(markup.indexOf('data-nav-group="views"'));
    expect(markup.indexOf("data-nav-connection")).toBeLessThan(markup.indexOf('data-nav-group="machine"'));
    expect(markup).toMatch(/<\/ul><\/div><div role="status" aria-live="polite" class="shrink-0 px-3">/);
  });

  it("marks the rail stale, and so dims every mark through the one rule, never a row", () => {
    expect(tag(render(<NavRail mode="full" />, "live"), 'aria-label="Primary"')).not.toContain('data-stale=""');
    const markup = render(<NavRail mode="full" />, "reconnecting");
    const nav = tag(markup, 'aria-label="Primary"');
    expect(nav).toContain('data-stale=""');
    expect(nav).toContain(STALE_MARKS_CLASS.replaceAll("&", "&amp;"));
    // 80%: the dimmed marks keep at least 3:1 against the rail in both themes (nav-shared.tsx).
    expect(STALE_MARKS_CLASS).toBe("[&[data-stale]_[data-nav-mark]]:[filter:opacity(0.8)]");
    // The marks: the Inbox count, "n live", the run's dot and aside, the project's count.
    const all = marks(markup);
    expect(all.some((m) => m.includes("tabular-nums") && !m.includes("data-nav-autopilot-live") && !m.includes("data-nav-project-count"))).toBe(true);
    expect(all.some((m) => m.includes("data-nav-autopilot-live"))).toBe(true);
    expect(all.some((m) => m.includes("data-nav-project-count"))).toBe(true);
    expect(all.filter((m) => /size-3\.5|max-w-\[45%\]/.test(m))).toHaveLength(2);
    // Rows are never marks: they stay clickable and at full strength.
    expect(RAIL_ROW_CLASS).not.toContain("data-nav-mark");
    expect(markup).not.toMatch(/<(button|a) [^>]* data-nav-mark="/);
  });
});

describe("the narrow rail while reconnecting", () => {
  it("shows the dot alone in a 36px slot, named and with no control, and dims its badges and dots", () => {
    expect(render(<NavRail mode="narrow" />, "live")).not.toContain("data-nav-connection");
    const markup = render(<NavRail mode="narrow" />, "reconnecting");
    const slot = tag(markup, "data-nav-connection");
    expect(slot).toMatch(/^<div /);
    expect(slot).toContain('aria-label="Reconnecting"');
    expect(slot).toContain("size-9");
    expect(markup).toMatch(/<\/ul><\/div><div role="status" aria-live="polite" class="shrink-0 flex justify-center">/);
    // The word is the slot's name for a screen reader, never drawn.
    expect(markup.match(/>Reconnecting</g)).toHaveLength(1);
    expect(markup).toContain('<span class="sr-only">Reconnecting</span>');
    expect(tag(markup, 'aria-label="Primary"')).toContain('data-stale=""');
    expect(tag(markup, "data-nav-inbox-count")).toContain('data-nav-mark="true"');
    expect(tag(markup, "data-nav-autopilot-live")).toContain('data-nav-mark="true"');
  });
});

describe("the phone's tab bar while reconnecting", () => {
  const tabs = (stale: boolean) =>
    renderToStaticMarkup(<ViewTabs view="tree" waiting={3} live={1} liveTone="ok" stale={stale} moreOpen={false} onSelect={noop} onMore={noop} />);

  it("dims the Inbox badge and the Autopilot dot, and says nothing else", () => {
    expect(tag(tabs(false), "data-view-tabs")).not.toContain('data-stale=""');
    const markup = tabs(true);
    expect(tag(markup, "data-view-tabs")).toContain('data-stale=""');
    expect(tag(markup, "data-view-tabs")).toContain(STALE_MARKS_CLASS.replaceAll("&", "&amp;"));
    expect(tag(markup, "data-view-tab-badge")).toContain('data-nav-mark="true"');
    expect(tag(markup, "data-view-tab-live")).toContain('data-nav-mark="true"');
    expect(marks(markup)).toHaveLength(2);
    expect(markup).not.toContain("Reconnecting");
  });
});
