/**
 * The autopilot surfaces against a REAL server payload: the rail's live-run rows, the phone's
 * Autopilot tab, the row badge, the detail's notice and the run history.
 *
 * No jsdom, as everywhere in this repo: the real HTTP server (`src/ui/server.ts`) serves a
 * real workspace whose runs were made by the real store through the real `run continue`
 * (started, taken, stopped by a person over HTTP, failed twice in a row, finished), and the
 * real components are rendered to markup from what came off the wire. Nothing here is a
 * hand-built run: every state, reason and ticket in the assertions is the tracker's own.
 */
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AppShell } from "@/components/AppShell";
import { NavRail } from "@/components/nav/NavRail";
import { TaskRowLine } from "@/components/task-list/TaskRowLine";
import { resolveTaskListConfig } from "@/components/task-list/config";
import { rowPlan } from "@/components/task-list/row-layout";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters } from "@/lib/filters";
import { AutopilotTreeContext, autopilotAncestors, buildRunsState, RunsContext } from "@/lib/runs";
import { placeUnderMilestones } from "@/views/tree/milestone-placement";
import { AttentionContext } from "@/lib/attention";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { IssueRow, RunEntry } from "@/lib/types";
import { AutopilotLayout } from "@/views/autopilot/AutopilotPage";
import { buildGroups, flattenFlat } from "@/views/tree/tree-model";
import { initWorkspace, openWorkspace } from "../../../../../core/workspace.ts";
import { startUiServer } from "../../../../server.ts";
import { AutopilotBadge, AutopilotNotice } from "./AutopilotBadge";
import { RunStopNoticeCard } from "./RunStopNotices";
import { stopNotice } from "@/lib/run-stops";

const noop = () => {};
const NOW = new Date("2026-09-28T12:00:00.000Z");

let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let dbPath: string;
let entries: RunEntry[];
let issues: IssueRow[];
const refs: Record<string, string> = {};
const runIds: Record<string, string> = {};

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

async function reload(): Promise<void> {
  entries = (await get<{ runs: RunEntry[] }>("/api/runs")).runs;
  issues = await get<IssueRow[]>("/api/issues");
}

const entryOf = (name: string): RunEntry => entries.find((entry) => entry.run.id === runIds[name])!;

function session(over: Partial<StapleSession> = {}): StapleSession {
  return {
    mode: "workspace",
    workspaces: [{ slug: "auto", prefix: "AUT" }],
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
    issues: { data: issues, error: undefined, loading: false, reload: noop },
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

/** The root's Inbox read (App.tsx provides it): nothing waiting. */
const NO_ATTENTION = { data: { rows: [], workspaces: [], failed: [], now: NOW.toISOString() }, error: undefined, loading: false, reload: noop };
const PAGE = "http://127.0.0.1:4400/?view=tasks";

/** Render inside the page's contexts, at a viewport width when one is given. */
function render(node: ReactElement, width?: number): string {
  if (width !== undefined) {
    globals.window = {
      location: { href: PAGE },
      matchMedia: (query: string) => {
        const min = /min-width:\s*(\d+)px/.exec(query);
        const max = /max-width:\s*(\d+)px/.exec(query);
        return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false, addEventListener: noop, removeEventListener: noop };
      },
    };
  }
  return renderToStaticMarkup(
    <SessionContext.Provider value={session()}>
      <AttentionContext value={NO_ATTENTION}>
        <RunsContext value={buildRunsState(entries)}>{node}</RunsContext>
      </AttentionContext>
    </SessionContext.Provider>,
  );
}

/** The opening tag of a live run's row under Autopilot in the rail, or "" when the rail has none. */
const runRow = (markup: string, id: string) => new RegExp(`<a [^>]*data-nav-run="${id}"[^>]*>`).exec(markup)?.[0] ?? "";

/**
 * One task row through the real model, the desk's or the phone's: built from the whole list
 * (so a parent has its children and its fold), placed under milestones as the Tasks list
 * places them, inside the fold map the list provides.
 */
function renderRow(ref: string, width: number, expanded = true, grouped = false): string {
  const placed = placeUnderMilestones(issues);
  // Every other row open, so the target is on screen; the target folded or not. Its own row,
  // never a ghost copy drawn as context in another status bucket.
  const options = { isExpanded: (issue: { identifier: string }) => (issue.identifier === ref ? expanded : true), showResolved: true };
  const lines = grouped ? buildGroups(placed, options).flatMap((group) => group.rows) : flattenFlat(placed, options);
  const built = lines.find((row) => row.issue.identifier === ref && row.ghost !== true)!;
  expect(built, ref).toBeDefined();
  const plan = rowPlan(width);
  const state = buildRunsState(entries);
  return render(
    <AutopilotTreeContext value={autopilotAncestors(placed, state.claimed)}>
    <TaskRowLine
      row={built}
      config={resolveTaskListConfig("tree", { labelMax: plan.labelMax, plan, desk: width >= 768 })}
      semantics="grid"
      isExpanded={expanded}
      now={NOW}
      onOpen={noop}
      onOpenParent={noop}
      onToggleExpand={noop}
      onToggleSelect={noop}
      onFocus={noop}
      onKeyDown={noop}
      registerRef={noop}
    />
    </AutopilotTreeContext>,
  );
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "x-staple-token": ui.token, "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-autopilot-e2e-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "auto" });
  dbPath = ws.dbPath;
  const { store } = ws;
  const epic = (title: string, children: number) => {
    const parent = store.createIssue({ title });
    const kids = Array.from({ length: children }, (_, i) => store.createIssue({ title: `${title} child ${i + 1}`, parent: parent.identifier, status: "todo" }));
    return { parent: parent.identifier, kids: kids.map((kid) => kid.identifier) };
  };
  const runs = store.runs();

  // A live run: took its first ticket, is working it.
  const live = epic("Live epic", 3);
  refs.liveEpic = live.parent;
  runIds.live = runs.start({ actor: "opus-live", scope: live.parent, maxTickets: 5 }).id;
  const take = runs.continue({ actor: "opus-live" });
  if (take.action !== "take") throw new Error("expected a take");
  refs.working = take.ref;
  refs.untouched = live.kids.find((kid) => kid !== take.ref)!;

  // Two tickets failed in a row: failure_streak.
  const failing = epic("Failing epic", 2);
  runIds.failed = runs.start({ actor: "opus-fail", scope: failing.parent }).id;
  runs.continue({ actor: "opus-fail" });
  runs.continue({ actor: "opus-fail", outcome: "failed", reason: "session exited 1" });
  const streak = runs.continue({ actor: "opus-fail", outcome: "failed", reason: "timed out: 30m" });
  if (streak.action !== "stop" || streak.reason !== "failure_streak") throw new Error(`expected failure_streak, got ${JSON.stringify(streak)}`);

  // Finished: its one ticket went to done and nothing was left.
  const small = epic("Small epic", 1);
  runIds.done = runs.start({ actor: "opus-done", scope: small.parent }).id;
  const only = runs.continue({ actor: "opus-done" });
  if (only.action !== "take") throw new Error("expected a take");
  store.updateIssue(only.ref, { status: "done" }, "opus-done");
  const empty = runs.continue({ actor: "opus-done" });
  if (empty.action !== "stop" || empty.reason !== "scope_empty") throw new Error(`expected scope_empty, got ${JSON.stringify(empty)}`);

  // A run over an epic whose ticket sits two levels down: Outer > Inner > Leaf.
  const outer = store.createIssue({ title: "Outer epic" });
  const inner = store.createIssue({ title: "Inner parent", parent: outer.identifier });
  const leaf = store.createIssue({ title: "Deep leaf", parent: inner.identifier, status: "todo" });
  refs.outer = outer.identifier;
  refs.inner = inner.identifier;
  refs.leaf = leaf.identifier;
  runIds.deep = runs.start({ actor: "opus-deep", scope: outer.identifier }).id;
  const deepTake = runs.continue({ actor: "opus-deep" });
  if (deepTake.action !== "take" || deepTake.ref !== leaf.identifier) throw new Error(`expected ${leaf.identifier}, got ${JSON.stringify(deepTake)}`);

  // A milestone whose parentless member epic a run works: the list nests the member under it.
  store.addKind({ id: "milestone", label: "Milestone" });
  const milestone = store.milestones().create({ title: "The milestone" }, "vp") as { milestone: { id: string; identifier: string } };
  const member = store.createIssue({ title: "Member epic" });
  const memberLeaf = store.createIssue({ title: "Member leaf", parent: member.identifier, status: "todo" });
  store.milestones().addMember(milestone.milestone.id, member.identifier, {}, "vp");
  refs.milestone = milestone.milestone.identifier;
  refs.member = member.identifier;
  refs.memberLeaf = memberLeaf.identifier;
  runIds.member = runs.start({ actor: "opus-member", scope: member.identifier }).id;
  const memberTake = runs.continue({ actor: "opus-member" });
  if (memberTake.action !== "take") throw new Error("expected a take");

  // A run a person stops from the page, over HTTP, below.
  const stopped = epic("Stopped epic", 2);
  runIds.stopped = runs.start({ actor: "opus-stop", scope: stopped.parent }).id;
  runs.continue({ actor: "opus-stop" });
  store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
  const response = await post("/api/run/stop", { id: runIds.stopped, actor: "vp", note: "wrong thing" });
  expect(response.status).toBe(200);
  await reload();
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a live run in the rail", () => {
  it("is a row under Autopilot that says what it is on, with the whole run in its title", () => {
    const markup = render(<NavRail onHide={noop} />, 1440);
    const row = runRow(markup, runIds.live!);
    const line = `Autopilot · ${refs.liveEpic} · 0 done this run · 3 left · working ${refs.working} · stops after 5 tickets (1 taken)`;
    expect(row).toContain(`title="${line}"`);
    expect(row).toContain(`aria-label="Live epic, Working, ${refs.working}"`);
    const body = markup.slice(markup.indexOf(row), markup.indexOf("</a>", markup.indexOf(row)));
    expect(body).toContain('data-run-dot="ok"');
    expect(body).toContain(`>${refs.working}</span>`);
  });

  it("is listed for every live run and no ended one, under Autopilot, which counts them", () => {
    const markup = render(<NavRail onHide={noop} />, 1440);
    const live = buildRunsState(entries).live;
    expect(markup.match(/data-nav-run="/g)).toHaveLength(live.length);
    for (const name of ["failed", "done", "stopped"]) expect(runRow(markup, runIds[name]!)).toBe("");
    expect(markup).toMatch(new RegExp(`data-nav-autopilot-live="true"[^>]*>${live.length} live<`));
    const autopilot = markup.indexOf('data-nav-item="view:autopilot"');
    expect(markup.indexOf(`data-nav-run="${runIds.live}"`)).toBeGreaterThan(autopilot);
    expect(markup.indexOf(`data-nav-run="${runIds.live}"`)).toBeLessThan(markup.indexOf('data-nav-group="views"'));
    // No runs at all: the Autopilot row stays, with nothing beside or under it.
    const bare = renderToStaticMarkup(
      <SessionContext.Provider value={session()}>
        <AttentionContext value={NO_ATTENTION}>
          <NavRail onHide={noop} />
        </AttentionContext>
      </SessionContext.Provider>,
    );
    expect(bare).toContain('data-nav-item="view:autopilot"');
    expect(bare).not.toContain("data-nav-autopilot-live");
    expect(bare).not.toContain("data-nav-run=");
  });

  it("leads to its run: the address of the run on the Autopilot page, from the page it is on", () => {
    const href = /href="([^"]+)"/.exec(runRow(render(<NavRail onHide={noop} />, 1440), runIds.live!))?.[1]?.replaceAll("&amp;", "&") ?? "";
    const url = new URL(href);
    expect(url.searchParams.get("view")).toBe("autopilot");
    expect(url.searchParams.get("run")).toBe(runIds.live);
  });

  it("on a phone dots the Autopilot tab while a run works, and the stop notices sit above the tab bar", () => {
    const phone = render(
      <AppShell>
        <div data-the-view />
      </AppShell>,
      390,
    );
    expect(phone).toMatch(/data-view-tab-live="ok"/);
    expect(phone).toMatch(new RegExp(`data-view-tab="autopilot"[^>]*aria-label="Autopilot, ${buildRunsState(entries).live.length} runs live"`));
    // The run-stopped notices: in the flow above the tab bar on a phone, a corner stack on a desk.
    const notices = phone.indexOf('data-run-stop-notices="strip"');
    expect(notices).toBeGreaterThan(phone.indexOf("data-the-view"));
    expect(notices).toBeLessThan(phone.indexOf("data-view-tabs"));
    const desk = render(
      <AppShell>
        <div data-the-view />
      </AppShell>,
      1440,
    );
    expect(desk).toContain('data-run-stop-notices="corner"');
  });
});

describe("the autopilot badge", () => {
  it("marks the row a live run holds, on a desk and on a phone, and no other", () => {
    const desk = renderRow(refs.working!, 1440);
    expect(desk).toContain(`data-autopilot-badge="${runIds.live}"`);
    expect(desk).toContain(">Autopilot<");
    expect(desk).toContain(`opus-live&#x27;s run over ${refs.liveEpic} is working on this`);
    const phone = renderRow(refs.working!, 390);
    expect(phone).toContain(`data-autopilot-badge="${runIds.live}"`);
    // The glyph alone on a phone row; the words stay for a screen reader.
    expect(phone).not.toContain(">Autopilot<");
    expect(phone).toContain('class="sr-only">Autopilot: opus-live');
    expect(renderRow(refs.untouched!, 1440)).not.toContain("data-autopilot-badge");
  });

  it("leaves a stopped run's ticket unmarked: an ended run holds nothing", () => {
    const stopped = entryOf("stopped");
    const ticket = stopped.run.tickets[0]!;
    expect(render(<AutopilotBadge workspace="auto" issueId={ticket.issueId} />)).toBe("");
  });

  it("the detail says which run and links to it", () => {
    const working = issues.find((row) => row.issue.identifier === refs.working)!;
    const markup = render(<AutopilotNotice workspace="auto" issueId={working.issue.id} />);
    expect(markup).toContain(`data-autopilot-notice="${runIds.live}"`);
    expect(markup).toContain("See the run");
  });
});

describe("a folded parent", () => {
  it("shows the badge while folded over a ticket being worked, naming it; expanded it shows nothing", () => {
    for (const width of [1440, 390]) {
      const folded = renderRow(refs.inner!, width, false);
      expect(folded, `${width}`).toContain(`data-autopilot-badge="${runIds.deep}"`);
      expect(folded).toContain('data-autopilot-kind="inside"');
      expect(folded).toContain(`Autopilot working ${refs.leaf} inside`);
      expect(renderRow(refs.inner!, width, true), `${width}`).not.toContain("data-autopilot-badge");
    }
    // Grouped by status too: the folded parent in its bucket.
    expect(renderRow(refs.inner!, 1440, false, true)).toContain('data-autopilot-kind="inside"');
    expect(renderRow(refs.inner!, 1440, true, true)).not.toContain("data-autopilot-badge");
    // The ticket itself wears its own badge whatever its parents do.
    expect(renderRow(refs.leaf!, 1440)).toContain('data-autopilot-kind="ticket"');
  });

  it("marks the run's scope row folded or not: that container is what is on autopilot", () => {
    for (const expanded of [true, false]) {
      const scope = renderRow(refs.outer!, 1440, expanded);
      expect(scope).toContain(`data-autopilot-badge="${runIds.deep}"`);
      expect(scope).toContain('data-autopilot-kind="scope"');
      expect(scope).toContain("opus-deep&#x27;s run is working through this");
    }
  });

  it("lights a folded milestone the list nests the run's work under", () => {
    const folded = renderRow(refs.milestone!, 1440, false);
    expect(folded).toContain(`data-autopilot-badge="${runIds.member}"`);
    expect(folded).toContain(`Autopilot working ${refs.memberLeaf} inside`);
    expect(renderRow(refs.milestone!, 1440, true)).not.toContain("data-autopilot-badge");
  });

  it("the Tasks list provides the fold map over the rows it nests, milestone placement included", () => {
    // TreeView needs a DOM to render whole, so its wiring is pinned at the source: the map is
    // built from `all` (the placed, unfiltered list) and wraps the grid that draws the rows.
    const source = readFileSync(fileURLToPath(new URL("../../views/TreeView.tsx", import.meta.url)), "utf8");
    expect(source).toMatch(/autopilotAncestors\(all, claimed\)/);
    expect(source).toMatch(/placeForAxis\(attachRowCues\(session\.issues\.data \?\? \[\], cueIndex\), groupBy\)/);
    const wrapped = /<AutopilotTreeContext value=\{autopilotTree\}>[\s\S]*?<\/AutopilotTreeContext>/.exec(source)?.[0] ?? "";
    expect(wrapped).toContain("<TreeGrid");
  });

  it("an ended run lights nothing", () => {
    const stopped = entryOf("stopped");
    const parentOf = issues.find((row) => row.issue.id === stopped.run.tickets[0]!.issueId)!.issue.parentId;
    const parent = issues.find((row) => row.issue.id === parentOf)!;
    expect(renderRow(parent.issue.identifier, 1440, false)).not.toContain("data-autopilot-badge");
  });
});

describe("the Autopilot page", () => {
  const page = (selectedRunId: string | null, runs: readonly RunEntry[] = entries) =>
    render(
      <AutopilotLayout entries={runs} selectedRunId={selectedRunId} onSelectRun={noop} onOpenTicket={noop} showWorkspace={false} loading={false} error={null} now={NOW} wide />,
    );
  /** One run's pane: the markup from its detail on. */
  const run = (name: string) => {
    const markup = page(runIds[name]!);
    return markup.slice(markup.indexOf(`data-run-detail="${runIds[name]}"`));
  };

  it("lists live runs first, then every ended one, and says how each ended in plain words", () => {
    const list = page(null);
    const liveAt = list.indexOf(`data-run-item="${runIds.live}"`);
    expect(liveAt).toBeGreaterThan(list.indexOf("Running now"));
    expect(liveAt).toBeLessThan(list.indexOf("Earlier"));
    for (const name of ["stopped", "failed", "done"]) expect(list.indexOf(`data-run-item="${runIds[name]}"`)).toBeGreaterThan(list.indexOf("Earlier"));

    expect(run("stopped")).toContain('data-run-stop-reason="stopped_by_human"');
    // The person is named once, in the reason itself.
    expect(run("stopped")).toContain("Stopped by vp");
    expect(run("stopped").match(/Stopped by vp/g)).toHaveLength(1);
    expect(run("stopped")).toContain("wrong thing");
    expect(run("failed")).toContain('data-run-stop-reason="failure_streak"');
    // The retried ticket failed twice: named once.
    expect(run("failed").replace(/<[^>]+>/g, "")).toMatch(/[A-Z]+-\d+ failed twice in a row/);
    expect(run("failed")).toContain("A stop rule ended it.");
    expect(run("failed")).toContain("The agent session ended with an error (exit 1).");
    expect(run("failed")).toContain("The agent session ran out of time.");
    expect(run("done")).toContain('data-run-stop-reason="scope_empty"');
    expect(run("done")).toContain("Finished: nothing left to do");
    expect(run("done")).toContain("It finished on its own.");
    expect(run("done")).toContain('data-outcome="done"');
    // Live runs carry Stop and Pause; ended ones carry neither.
    expect(run("live")).toContain("data-run-stop=");
    expect(run("live")).toContain('data-run-pause="pause"');
    expect(run("done")).not.toContain("data-run-stop=");
  });

  it("names every ticket a run took by its current status and title, not its bare id", () => {
    const done = entryOf("done");
    const take = done.run.tickets[0]!;
    const issue = done.issues.find((candidate) => candidate.issueId === take.issueId)!;
    const row = run("done");
    expect(row).toContain(`data-run-ticket="${take.identifier}"`);
    expect(row).toContain(issue.title);
    expect(row).toContain(`${issue.identifier}: ${issue.title}`);
  });

  it("says so when there are none", () => {
    expect(page(null, [])).toContain("data-run-history-empty");
  });
});

describe("the run-stopped notice", () => {
  it("shows what the person who stopped it said, and offers no link to the issue already open", () => {
    const entry = entryOf("stopped");
    const notice = stopNotice(entry)!;
    expect(notice.attention).not.toBeNull();
    const card = (openRef: { workspace: string; ref: string } | null) =>
      render(<RunStopNoticeCard notice={notice} openRef={openRef} onOpenRef={noop} onDetails={noop} onDismiss={noop} />);
    const closed = card(null);
    expect(closed).toContain("data-run-stop-note");
    expect(closed).toContain("wrong thing");
    expect(closed).toContain(`data-run-stop-open="${notice.attention!.ref}"`);
    const onIt = card({ workspace: entry.workspace, ref: notice.attention!.ref });
    expect(onIt).not.toContain("data-run-stop-open=");
    expect(onIt).toContain("wrong thing");
    // Another issue open: the link is still offered.
    expect(card({ workspace: entry.workspace, ref: "ZZZ-1" })).toContain(`data-run-stop-open="${notice.attention!.ref}"`);
  });
});

describe("a run started, paused or stopped elsewhere", () => {
  it("shows in the rail within one read, and leaves it when it ends, into the page's earlier runs, ended by the person who stopped it", async () => {
    const database = openWorkspace(dbPath);
    const runs = database.store.runs();
    const epic = database.store.createIssue({ title: "Stop me" });
    database.store.createIssue({ title: "Stop me child", parent: epic.identifier, status: "todo" });
    const id = runs.start({ actor: "opus-press", scope: epic.identifier }).id;
    runs.continue({ actor: "opus-press" });
    database.store.db.close();
    await reload();
    expect(runRow(render(<NavRail onHide={noop} />, 1440), id)).not.toBe("");

    expect((await post("/api/run/pause", { id, actor: "vp" })).status).toBe(200);
    await reload();
    const paused = render(<NavRail onHide={noop} />, 1440);
    expect(runRow(paused, id)).toContain('aria-label="Stop me, Paused"');

    expect((await post("/api/run/stop", { id, actor: "vp" })).status).toBe(200);
    await reload();
    expect(runRow(render(<NavRail onHide={noop} />, 1440), id)).toBe("");
    const markup = render(
      <AutopilotLayout entries={entries} selectedRunId={null} onSelectRun={noop} onOpenTicket={noop} showWorkspace={false} loading={false} error={null} now={NOW} wide={false} />,
    );
    expect(markup.indexOf(`data-run-item="${id}"`)).toBeGreaterThan(markup.indexOf("Earlier"));
    expect(entries.find((entry) => entry.run.id === id)!.run.stop).toMatchObject({ reason: "stopped_by_human", by: "vp" });
  });
});
