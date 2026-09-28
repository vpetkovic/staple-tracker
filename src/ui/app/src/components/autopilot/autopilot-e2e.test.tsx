/**
 * The autopilot surfaces against a REAL server payload: the rail banner, the phone strip, the
 * row badge, the detail's notice and the run history.
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
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { IssueRow, RunEntry } from "@/lib/types";
import { buildGroups, flattenFlat } from "@/views/tree/tree-model";
import { initWorkspace, openWorkspace } from "../../../../../core/workspace.ts";
import { startUiServer } from "../../../../server.ts";
import { AutopilotBadge, AutopilotNotice } from "./AutopilotBadge";
import { RunCard, RunStrip } from "./RunBanner";
import { RunHistoryList } from "./RunHistoryDialog";

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
    projects: { data: [], error: undefined, loading: false, reload: noop },
    focusProject: noop,
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

/** Render inside the page's two contexts, at a viewport width when one is given. */
function render(node: ReactElement, width?: number): string {
  if (width !== undefined) {
    globals.window = {
      matchMedia: (query: string) => {
        const min = /min-width:\s*(\d+)px/.exec(query);
        const max = /max-width:\s*(\d+)px/.exec(query);
        return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false, addEventListener: noop, removeEventListener: noop };
      },
    };
  }
  return renderToStaticMarkup(
    <SessionContext.Provider value={session()}>
      <RunsContext value={buildRunsState(entries)}>{node}</RunsContext>
    </SessionContext.Provider>,
  );
}

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

describe("the rail banner", () => {
  it("says the run in one line: scope, n/m done, what it is on, what would stop it", () => {
    const markup = render(<RunCard entry={entryOf("live")} />);
    const line = `Autopilot · ${refs.liveEpic} · 0/3 done · working ${refs.working} · stops after 5 tickets (1 taken)`;
    expect(markup).toContain(`aria-label="${line}"`);
    expect(markup).toContain(`Autopilot · ${refs.liveEpic}`);
    expect(markup).toContain(`0/3 done · working ${refs.working}`);
    expect(markup).toContain("stops after 5 tickets (1 taken)");
    expect(markup).toContain('data-run-state="ok"');
    expect(markup).toContain(">Working<");
    expect(markup).toContain("No driver attached");
    expect(markup).toContain(`data-run-stop="${runIds.live}"`);
  });

  it("sits in the rail's Autopilot section, with the way to the history, only while there are runs", () => {
    const markup = render(<NavRail onHide={noop} />, 1440);
    const section = markup.indexOf('data-nav-group="autopilot"');
    expect(section).toBeGreaterThan(markup.indexOf('data-nav-group="views"'));
    expect(section).toBeLessThan(markup.indexOf('data-nav-group="machine"'));
    // One banner per live run; the ended ones are in the history.
    expect(markup.match(/data-run-banner=/g)).toHaveLength(buildRunsState(entries).live.length);
    expect(markup).toContain("data-nav-run-history");
    const bare = renderToStaticMarkup(
      <SessionContext.Provider value={session()}>
        <NavRail onHide={noop} />
      </SessionContext.Provider>,
    );
    expect(bare).not.toContain('data-nav-group="autopilot"');
  });

  it("on a phone is a strip above the tab bar with a 44px Stop; a desk has none", () => {
    const phone = render(
      <AppShell>
        <div data-the-view />
      </AppShell>,
      390,
    );
    // The strip is the newest live run.
    const newest = buildRunsState(entries).live[0]!;
    const strip = phone.indexOf(`data-run-strip="${newest.run.id}"`);
    expect(strip).toBeGreaterThan(phone.indexOf("data-the-view"));
    expect(strip).toBeLessThan(phone.indexOf("data-view-tabs"));
    const stop = /<button[^>]*data-run-stop="[^"]+"[^>]*>/.exec(phone.slice(strip))?.[0] ?? "";
    // 44px under any pointer, not only a coarse one (`pointer-coarse:h-11` is every Stop's).
    expect(stop).toMatch(/(^|\s|")h-11 min-w-11/);
    const desk = render(
      <AppShell>
        <div data-the-view />
      </AppShell>,
      1440,
    );
    expect(desk).not.toContain("data-run-strip");
    // The run-stopped notices: in the flow above the strip on a phone, a corner stack on a desk.
    const notices = phone.indexOf('data-run-stop-notices="strip"');
    expect(notices).toBeGreaterThan(phone.indexOf("data-the-view"));
    expect(notices).toBeLessThan(strip);
    expect(desk).toContain('data-run-stop-notices="corner"');
    expect(render(<RunStrip />)).toContain(`working ${newest.run.tickets.at(-1)!.identifier}`);
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
    expect(source).toMatch(/return groupBy === "parent" \? cued : placeUnderMilestones\(cued\);/);
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

describe("the run history", () => {
  it("lists live runs first, then every ended one with its stop reason in plain words", () => {
    const markup = render(<RunHistoryList entries={entries} showWorkspace={false} now={NOW} />);
    const liveAt = markup.indexOf(`data-run-history="${runIds.live}"`);
    expect(liveAt).toBeGreaterThan(markup.indexOf(">Running now<"));
    expect(liveAt).toBeLessThan(markup.indexOf(">Earlier<"));

    const item = (name: string) => {
      const start = markup.indexOf(`data-run-history="${runIds[name]}"`);
      const end = markup.indexOf("data-run-history=", start + 20);
      return markup.slice(start, end === -1 ? undefined : end);
    };
    expect(item("stopped")).toContain('data-run-stop-reason="stopped_by_human"');
    expect(item("stopped")).toContain("Stopped by vp.");
    expect(item("stopped")).toContain("wrong thing");
    expect(item("failed")).toContain('data-run-stop-reason="failure_streak"');
    // The retried ticket failed twice: named once.
    expect(item("failed")).toMatch(/[A-Z]+-\d+ failed twice in a row/);
    expect(item("failed")).toContain("A stop rule ended it.");
    expect(item("failed")).toContain("Failed: the agent session ended with an error (exit 1)");
    expect(item("failed")).toContain("Failed: the agent session ran out of time");
    expect(item("done")).toContain('data-run-stop-reason="scope_empty"');
    expect(item("done")).toContain("Finished: nothing left to do");
    expect(item("done")).toContain("It finished on its own.");
    expect(item("done")).toContain('data-outcome="done"');
    // Live runs carry Stop and Pause; ended ones carry neither.
    expect(item("live")).toContain("data-run-stop=");
    expect(item("live")).toContain('data-run-pause="pause"');
    expect(item("done")).not.toContain("data-run-stop=");
  });

  it("says so when there are none", () => {
    expect(render(<RunHistoryList entries={[]} showWorkspace={false} />)).toContain("data-run-history-empty");
  });
});

describe("Stop from the page", () => {
  it("ends the run, and the next read of the page shows it ended by the person who pressed it", async () => {
    const database = openWorkspace(dbPath);
    const runs = database.store.runs();
    const epic = database.store.createIssue({ title: "Stop me" });
    database.store.createIssue({ title: "Stop me child", parent: epic.identifier, status: "todo" });
    const id = runs.start({ actor: "opus-press", scope: epic.identifier }).id;
    runs.continue({ actor: "opus-press" });
    database.store.db.close();
    await reload();
    expect(render(<NavRail onHide={noop} />, 1440)).toContain(`data-run-banner="${id}"`);

    expect((await post("/api/run/stop", { id, actor: "vp" })).status).toBe(200);
    await reload();
    expect(render(<NavRail onHide={noop} />, 1440)).not.toContain(`data-run-banner="${id}"`);
    const markup = render(<RunHistoryList entries={entries} showWorkspace={false} now={NOW} />);
    expect(markup).toContain(`data-run-history="${id}"`);
    expect(entries.find((entry) => entry.run.id === id)!.run.stop).toMatchObject({ reason: "stopped_by_human", by: "vp" });
  });
});
