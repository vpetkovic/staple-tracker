/**
 * The rail's first zone (Inbox, Autopilot, Queue), the phone's five tabs and the More sheet's
 * views, rendered to markup from given reads: the parts are presentational, so what a test
 * hands them is all they show.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ViewName } from "@/lib/session";
import type { RunEntry } from "@/lib/types";
import { RailTopRows } from "./NavRail";
import { MoreSheetRows, ViewTabs } from "./ViewTabBar";

const noop = () => {};

function run(id: string, over: { state?: "active" | "paused"; ticket?: string; workspace?: string } = {}): RunEntry {
  const tickets = over.ticket
    ? [{ seq: 1, issueId: `i-${id}`, identifier: over.ticket, takenAt: "2026-11-26T12:00:00.000Z", outcome: null, reason: null, attemptId: null, recordedAt: null }]
    : [];
  return {
    workspace: over.workspace ?? "staple",
    title: `Run ${id}`,
    issues: [],
    run: {
      id,
      actor: "opus",
      state: over.state ?? "active",
      scope: { kind: "queue" },
      budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null },
      goal: null,
      tickets,
      counts: { tickets: tickets.length, taken: tickets.length, done: 0, failed: 0, open: tickets.length },
      stop: null,
    },
    decision: { stop: false },
    facts: null,
    driver: null,
    goal: null,
    instructionsChanged: [],
  } as unknown as RunEntry;
}

const rows = (over: Partial<Parameters<typeof RailTopRows>[0]> = {}) =>
  renderToStaticMarkup(
    <RailTopRows
      view="tree"
      run={null}
      badge={{ waiting: 0, unseen: 0 }}
      live={[]}
      showWorkspace={false}
      hrefFor={(id) => `/?view=autopilot&run=${id}`}
      onSelect={noop}
      onOpenRun={noop}
      {...over}
    />,
  );

/** The opening tag of the element carrying `hook`. */
const tag = (markup: string, hook: string) => new RegExp(`<[a-z]+[^>]*${hook}[^>]*>`).exec(markup)?.[0] ?? "";

describe("the rail's top rows", () => {
  it("are an unlabelled list of Inbox, Autopilot and Queue, Queue directly after Autopilot's runs", () => {
    const markup = rows({ live: [run("a")] });
    expect(tag(markup, 'data-nav-group="top"')).toContain('aria-label="Inbox, Autopilot and Queue"');
    expect(markup).not.toContain("aria-expanded");
    const at = (hook: string) => markup.indexOf(hook);
    expect(at('data-nav-item="view:attention"')).toBeLessThan(at('data-nav-item="view:autopilot"'));
    expect(at('data-nav-item="view:autopilot"')).toBeLessThan(at('data-nav-run="a"'));
    expect(at('data-nav-run="a"')).toBeLessThan(at('data-nav-item="view:queue"'));
    // Queue carries no mark of its own.
    expect(/<button[^>]*data-nav-item="view:queue"[\s\S]*?<\/button>/.exec(markup)?.[0]).not.toContain("tabular-nums");
  });

  it("give the Inbox its count and a new dot from the badge, in words for a screen reader", () => {
    const markup = rows({ badge: { waiting: 28, unseen: 2 } });
    expect(markup).toMatch(/data-nav-inbox-count="true">28</);
    expect(markup).toContain("data-nav-inbox-new");
    expect(markup).toContain('<span class="sr-only">, 28 waiting, 2 new</span>');
    const seen = rows({ badge: { waiting: 28, unseen: 0 } });
    expect(seen).not.toContain("data-nav-inbox-new");
    const none = rows({ badge: { waiting: 0, unseen: 0 } });
    expect(none).not.toContain("data-nav-inbox-count");
    expect(none).not.toContain("sr-only");
  });

  it("say how many runs are live and list each, folding a fifth and later into 'n more'", () => {
    expect(rows()).not.toContain("data-nav-autopilot-live");
    expect(rows()).not.toContain("data-nav-run=");
    const two = rows({ live: [run("a", { ticket: "STA-9" }), run("b", { state: "paused" })] });
    // The live mark is the state dot, then "n live": ok while any run works.
    expect(two).toMatch(/data-nav-autopilot-live="true"[^>]*><span[^>]*data-run-dot="ok"[^>]*><\/span>2 live</);
    expect(two.match(/data-nav-run="/g)).toHaveLength(2);
    expect(two).toMatch(/data-nav-run="a"[\s\S]*?>Run a<\/span>[\s\S]*?>STA-9<\/span>/);
    expect(two).toMatch(/data-nav-run="b"[\s\S]*?>Run b<\/span>[\s\S]*?>Paused<\/span>/);
    expect(two).not.toContain("data-nav-run-more");
    // The dot is the state's tone, and only a working run's breathes.
    expect(tag(two.slice(two.indexOf('data-nav-run="a"')), "data-run-dot")).toMatch(/motion-safe:animate-[^"]*" style="background-color:var\(--plain-ok-fg\)"/);
    const paused = tag(two.slice(two.indexOf('data-nav-run="b"')), "data-run-dot");
    expect(paused).toContain("var(--plain-tight-fg)");
    expect(paused).not.toContain("animate");
    // Every run paused or waiting: the mark's dot is tight.
    expect(rows({ live: [run("b", { state: "paused" })] })).toMatch(/data-nav-autopilot-live="true"[^>]*><span[^>]*data-run-dot="tight"/);
    const six = rows({ live: ["a", "b", "c", "d", "e", "f"].map((id) => run(id)) });
    expect(six).toMatch(/data-nav-autopilot-live="true"[^>]*>(<span[^>]*><\/span>)?6 live</);
    expect(six.match(/data-nav-run="/g)).toHaveLength(4);
    expect(six).toMatch(/data-nav-run-more="true"[^>]*>[\s\S]*?>2 more</);
  });

  it("make each run a real link to its own address, titled with the run's line", () => {
    const markup = rows({ live: [run("a")] });
    const link = tag(markup, 'data-nav-run="a"');
    expect(link).toMatch(/^<a /);
    expect(link).toContain('href="/?view=autopilot&amp;run=a"');
    expect(link).toMatch(/title="Autopilot · Queue · [^"]*"/);
  });

  it("name a run's workspace on All workspaces, and only there", () => {
    const one = [run("a", { ticket: "EXE-1", workspace: "exercises-api" })];
    expect(tag(rows({ live: one, showWorkspace: true }), 'data-nav-run="a"')).toContain('aria-label="Run a, Working, EXE-1, exercises-api"');
    expect(tag(rows({ live: one }), 'data-nav-run="a"')).toContain('aria-label="Run a, Working, EXE-1"');
  });

  it("mark the Inbox, Autopilot or Queue as the page", () => {
    const live = [run("a"), run("b")];
    const current = (view: ViewName, at: string | null) =>
      [...rows({ view, run: at, live }).matchAll(/(data-nav-(?:item|run)="[^"]+") aria-current="page"/g)].map((match) => match[1]);
    expect(current("attention", null)).toEqual(['data-nav-item="view:attention"']);
    expect(current("autopilot", null)).toEqual(['data-nav-item="view:autopilot"']);
    expect(current("autopilot", "ended")).toEqual(['data-nav-item="view:autopilot"']);
    expect(current("queue", null)).toEqual(['data-nav-item="view:queue"']);
    expect(current("tree", null)).toEqual([]);
  });

  it("give the one highlight to a live run open on the Autopilot page, Autopilot keeping only its tone", () => {
    const live = [run("a"), run("b")];
    const open = rows({ view: "autopilot", run: "b", live });
    // The run is the place: the only `aria-current="true"`, a filled sub-row.
    expect(tag(open, 'data-nav-run="b"')).toContain('aria-current="true"');
    expect(open.match(/aria-current="true"/g)).toHaveLength(1);
    // The page is still Autopilot, drawn without the fill.
    const autopilot = tag(open, 'data-nav-item="view:autopilot"');
    expect(autopilot).toContain('aria-current="page"');
    expect(autopilot).toContain('data-child-current=""');
    // Otherwise no child is the place and no row carries the marker.
    for (const markup of [rows({ view: "autopilot", run: null, live }), rows({ view: "autopilot", run: "ended", live }), rows({ view: "attention", live })]) {
      expect(markup).not.toContain('data-child-current=""');
      expect(markup).not.toContain('aria-current="true"');
    }
  });
});

const tabs = (over: Partial<Parameters<typeof ViewTabs>[0]> = {}) =>
  renderToStaticMarkup(<ViewTabs view="tree" waiting={0} live={0} liveTone={null} moreOpen={false} onSelect={noop} onMore={noop} {...over} />);

describe("the phone's tab bar", () => {
  it("has five tabs: Inbox, Autopilot, Queue, Tasks, More", () => {
    expect([...tabs().matchAll(/data-view-tab="([^"]+)"/g)].map((match) => match[1])).toEqual(["attention", "autopilot", "queue", "tree", "more"]);
  });

  it("draws the Inbox badge quiet, and in the accent only while something waiting is new", () => {
    const quiet = tag(tabs({ waiting: 28 }), "data-view-tab-badge");
    expect(quiet).toContain("from-surface-selected");
    expect(quiet).not.toContain("--badge-fresh");
    const fresh = tag(tabs({ waiting: 28, fresh: true }), "data-view-tab-badge");
    expect(fresh).toContain("bg-[var(--badge-fresh)]");
    expect(fresh).not.toContain("from-surface-selected");
  });

  it("badges the Inbox with what waits, 99+ past 99, and names it in words", () => {
    expect(tabs()).not.toContain("data-view-tab-badge");
    const some = tabs({ waiting: 28 });
    expect(some).toMatch(/data-view-tab-badge="true"[^>]*>28</);
    expect(tag(some, 'data-view-tab="attention"')).toContain('aria-label="Inbox, 28 waiting"');
    expect(tabs({ waiting: 140 })).toMatch(/data-view-tab-badge="true"[^>]*>99\+</);
  });

  it("dots Autopilot in the tone it is given while a run is live", () => {
    expect(tabs()).not.toContain("data-view-tab-live");
    const ok = tabs({ live: 2, liveTone: "ok" });
    expect(tag(ok, "data-view-tab-live")).toContain("--plain-ok-fg");
    expect(tag(ok, 'data-view-tab="autopilot"')).toContain('aria-label="Autopilot, 2 runs live"');
    expect(tag(tabs({ live: 1, liveTone: "tight" }), "data-view-tab-live")).toContain("--plain-tight-fg");
  });

  it("marks More as the page on a view outside the bar, and says it opens a dialog", () => {
    const graph = tabs({ view: "graph" });
    expect(graph.match(/aria-current="page"/g)).toHaveLength(1);
    const more = tag(graph, 'data-view-tab="more"');
    expect(more).toContain('aria-current="page"');
    expect(more).toContain('aria-haspopup="dialog"');
    expect(more).toContain('aria-expanded="false"');
    expect(tag(tabs({ moreOpen: true }), 'data-view-tab="more"')).toContain('aria-expanded="true"');
    expect(tag(tabs({ view: "queue" }), 'data-view-tab="queue"')).toContain('aria-current="page"');
    expect(tag(tabs({ view: "queue" }), 'data-view-tab="more"')).not.toContain("aria-current");
  });
});

describe("the More sheet's views", () => {
  const sheet = (view: ViewName, planningEnabled: boolean) => renderToStaticMarkup(<MoreSheetRows view={view} planningEnabled={planningEnabled} onChoose={noop} />);

  it("lists the workspace's other views first, with no label, the current one marked", () => {
    const markup = sheet("milestones", true);
    expect([...markup.matchAll(/data-more-view="([^"]+)"/g)].map((match) => match[1])).toEqual(["graph", "milestones", "plan", "calibration"]);
    expect(markup).not.toContain("<h3");
    expect(markup).toMatch(/data-more-view="milestones" aria-current="page"/);
    expect(markup.match(/aria-current/g)).toHaveLength(1);
  });

  it("hides Plan while planning is off", () => {
    expect(sheet("graph", false)).not.toContain('data-more-view="plan"');
  });
});
