/**
 * The milestone goal view and the run-stopped notice against a REAL server payload.
 *
 * No jsdom, as everywhere in this repo: the real HTTP server (`src/ui/server.ts`) serves a
 * real workspace in which a real goal run works a milestone through the real `run continue`,
 * an agent marks its criteria through the real store (met on a done ticket and a document,
 * met on a ticket still open, reworded after it was marked, not met with a follow-up the run
 * files itself, and one nobody marked), and a second run fails twice in a row. The real
 * components are rendered to markup from what came off the wire. Nothing here is a
 * hand-built goal: every verdict, reason, gate and ticket in the assertions is the tracker's.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunStopNoticeList, RunStopNotices } from "@/components/autopilot/RunStopNotices";
import { markStopsSeen, resetStopSeenForTests } from "@/lib/stop-seen-store";
import { buildFilterContext } from "@/lib/filter-dimensions";
import { emptyFilters } from "@/lib/filters";
import { paceText } from "@/lib/goal-text";
import { pendingStopNotices } from "@/lib/run-stops";
import { buildRunsState, RunsContext } from "@/lib/runs";
import { SessionContext, type StapleSession } from "@/lib/session";
import { DEFAULT_SORT } from "@/lib/sort-modes";
import type { IssueDetail, IssueRow, RunEntry } from "@/lib/types";
import { MILESTONE_KIND } from "../../../../core/milestones.ts";
import { initWorkspace, openWorkspace } from "../../../../core/workspace.ts";
import { startUiServer } from "../../../server.ts";
import { MADE_BY_RUN_CAPTION } from "./MilestoneParts";
import { openEvidence } from "./MilestoneGoal";
import { OverviewTab } from "./tabs/OverviewTab";
import { openTabOnArrival, takeArrivalTab, takePendingDocumentKey } from "./tabs/registry";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const noop = () => {};
const AGENT = "opus";

let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let dbPath: string;
const refs: Record<string, string> = {};
/** The milestone's detail while the run works, and once its goal is met. */
let working: IssueDetail;
let met: IssueDetail;
let workingRuns: RunEntry[];
let endRuns: RunEntry[];
let issues: IssueRow[];

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

function session(): StapleSession {
  return {
    mode: "workspace",
    workspaces: [{ slug: "goal", prefix: "GOA" }],
    view: "tree",
    setView: noop,
    milestoneFocus: null,
    focusMilestone: noop,
    projects: { data: [], error: undefined, loading: false, reload: noop },
    focusProject: noop,
    ws: "goal",
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
  };
}

/** Markup with the entities a person would read decoded, so assertions read like the page. */
function render(node: ReactElement, runs: RunEntry[]): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={session()}>
      <RunsContext value={buildRunsState(runs)}>{node}</RunsContext>
    </SessionContext.Provider>,
  )
    .replaceAll("&#x27;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");
}

const overview = (detail: IssueDetail, runs: RunEntry[]) => render(<OverviewTab detail={detail} workspace="goal" onAuthError={noop} refresh={noop} />, runs);

/** One criterion's `<li>`, by position. */
function criterionHtml(html: string, position: number): string {
  const match = new RegExp(`<li data-goal-criterion="${position}"[\\s\\S]*?</li>(?=<li data-goal-criterion=|</ul><div data-detail-card)`).exec(html);
  expect(match, `criterion ${position}`).not.toBeNull();
  return match![0];
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-ui-goal-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const created = initWorkspace({ global: true, slug: "goal" });
  dbPath = created.dbPath;
  created.store.db.close();

  const ws = openWorkspace(dbPath);
  const { store } = ws;
  try {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const view = store
      .milestones()
      .create({ title: "Autopilot runs", acceptanceCriteria: ["Docs written", "Tests pass", "Works on a phone", "Measured", "Announced"], targetDate: "2027-01-31" }, "vp");
    if (view.preview) throw new Error("unreachable");
    const m = view.milestone.identifier;
    const a = store.createIssue({ title: "Write the docs", status: "todo" }).identifier;
    const b = store.createIssue({ title: "Write the tests", status: "todo" }).identifier;
    store.milestones().addMember(m, a, {}, "vp");
    store.milestones().addMember(m, b, {}, "vp");
    store.setEstimate(b, 3 * 3600, "vp");
    Object.assign(refs, { m, a, b });

    // The goal run gates the milestone as it starts, and takes the first member.
    const runs = store.runs();
    refs.goalRun = runs.start({ actor: AGENT, scope: m, gateOwner: "VP" }).id;
    const take = runs.continue({ actor: AGENT });
    if (take.action !== "take" || take.ref !== a) throw new Error(`expected to take ${a}`);
    store.putDocument(a, "plan", "# Plan", { author: AGENT });
    store.updateIssue(a, { status: "done" }, AGENT);

    const marks = store.milestones();
    marks.markCriterion(m, 1, { verdict: "met", evidence: [a, `${a}:plan`] }, AGENT);
    marks.markCriterion(m, 2, { verdict: "met", evidence: [b] }, AGENT);
    marks.markCriterion(m, 3, { verdict: "met", evidence: ["checked at 390px"] }, AGENT);
    marks.update(m, { acceptanceCriteria: ["Docs written", "Tests pass", "Works on a phone and a desk", "Measured", "Announced"] }, "vp");
    const followed = marks.markCriterion(m, 4, { verdict: "unmet", evidence: ["nothing measured"], followUp: { title: "Measure it" } }, AGENT);
    refs.followUp = followed.goal.criteria[3]!.evidence.at(-1)!.ref!;

    // A second run over an epic, whose two tickets both fail.
    const epic = store.createIssue({ title: "Flaky epic" }).identifier;
    store.createIssue({ title: "Flaky one", parent: epic, status: "todo" });
    store.createIssue({ title: "Flaky two", parent: epic, status: "todo" });
    refs.flakyRun = runs.start({ actor: "flaky", scope: epic }).id;
    const first = runs.continue({ actor: "flaky" });
    if (first.action !== "take") throw new Error("expected a take");
    const second = runs.continue({ actor: "flaky", outcome: "failed", reason: "session exited 1" });
    if (second.action !== "take") throw new Error("expected a second take");
    refs.lastFailed = second.ref;
    const streak = runs.continue({ actor: "flaky", outcome: "failed", reason: "session exited 1" });
    if (streak.action !== "stop" || streak.reason !== "failure_streak") throw new Error(`expected failure_streak, got ${JSON.stringify(streak)}`);
  } finally {
    store.db.close();
  }

  ui = startUiServer({ port: 0, hub: false, db: dbPath });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  working = await get<IssueDetail>(`/api/issue?ref=${refs.m}`);
  workingRuns = (await get<{ runs: RunEntry[] }>("/api/runs")).runs;
  issues = await get<IssueRow[]>("/api/issues");

  // Now meet the goal: every member lands, every criterion is marked met on evidence that holds.
  const again = openWorkspace(dbPath);
  try {
    const { store } = again;
    const { m, a, b, followUp } = refs as Record<string, string>;
    store.updateIssue(b!, { status: "done" }, AGENT);
    store.updateIssue(followUp!, { status: "done" }, AGENT);
    const marks = store.milestones();
    marks.markCriterion(m!, 3, { verdict: "met", evidence: [a!] }, AGENT);
    marks.markCriterion(m!, 4, { verdict: "met", evidence: [followUp!] }, AGENT);
    marks.markCriterion(m!, 5, { verdict: "met", evidence: ["posted in the changelog"] }, AGENT);
    const end = store.runs().continue({ actor: AGENT });
    if (end.action !== "stop" || end.reason !== "goal_met") throw new Error(`expected goal_met, got ${JSON.stringify(end)}`);
  } finally {
    again.store.db.close();
  }
  met = await get<IssueDetail>(`/api/issue?ref=${refs.m}`);
  endRuns = (await get<{ runs: RunEntry[] }>("/api/runs")).runs;
  issues = await get<IssueRow[]>("/api/issues");
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the milestone goal view, from the goal check", () => {
  it("shows every criterion with the check's verdict, in order, in place of the static checklist", () => {
    const html = overview(working, workingRuns);
    expect(html).toContain('data-milestone-goal=""');
    expect(html).not.toContain('data-criteria=""');
    const verdicts = [...html.matchAll(/data-goal-criterion="(\d)" data-verdict="(\w+)"/g)].map((match) => [Number(match[1]), match[2]]);
    expect(verdicts).toEqual(working.milestonePlan!.goal.criteria.map((criterion) => [criterion.position, criterion.verdict]));
    expect(verdicts).toEqual([
      [1, "met"],
      [2, "unknown"],
      [3, "unknown"],
      [4, "unmet"],
      [5, "unknown"],
    ]);
    expect(html).toContain("1 of 5 criteria met, 1 not met, 3 unknown.");
    expect(html).toContain(">1/5 met<");
  });

  it("links the evidence: a ticket opens the ticket, a document opens it on that ticket", () => {
    const one = criterionHtml(overview(working, workingRuns), 1);
    expect(one).toContain(`data-evidence="ticket" data-evidence-holds="true"`);
    expect(one).toContain(`title="Open ${refs.a}"`);
    expect(one).toContain(`data-evidence="document"`);
    expect(one).toContain(`${refs.a} · plan`);
    expect(one).toContain(`Open the "plan" document on ${refs.a}`);
    expect(one).toMatch(/Marked met by opus on an autopilot run, /);
  });

  it("says why each unknown one is unknown: evidence not done, reworded, never marked", () => {
    const html = overview(working, workingRuns);
    expect(criterionHtml(html, 2)).toContain(`Marked met, but its evidence does not hold now: ${refs.b} is todo, not done.`);
    expect(criterionHtml(html, 2)).toContain(`data-evidence-holds="false"`);
    expect(criterionHtml(html, 3)).toContain('Reworded after it was marked met, so it needs judging again. It read: "Works on a phone".');
    expect(criterionHtml(html, 5)).toContain("Nobody has judged this yet.");
    expect(criterionHtml(html, 4)).toContain("Not met");
    expect(criterionHtml(html, 4)).toContain("“nothing measured”");
  });

  it("marks the ticket the run created itself in the member list, and no other", () => {
    const html = overview(working, workingRuns);
    const members = /data-milestone-members=""[\s\S]*$/.exec(html)![0];
    const rowOf = (ref: string) => members.split('role="option"').find((row) => row.includes(`data-identifier="${ref}"`)) ?? "";
    expect(issues.find((row) => row.issue.identifier === refs.followUp)?.issue.originKind).toBe("run");
    expect(rowOf(refs.followUp!)).toContain(MADE_BY_RUN_CAPTION);
    expect(rowOf(refs.a!)).not.toContain(MADE_BY_RUN_CAPTION);
    expect(members.split(`data-testid="row-caption" title="${MADE_BY_RUN_CAPTION}"`).length - 1).toBe(1);
  });

  it("shows the pace against the target in words, with the check's numbers", () => {
    const html = overview(working, workingRuns);
    const pace = working.milestonePlan!.goal.pace;
    expect(html).toContain(`data-goal-pace="${pace.verdict}"`);
    expect(pace.verdict).toBe("on_track");
    expect(html).toContain(paceText(pace));
    // At least: the follow-up the run filed has no estimate yet.
    expect(pace.partial).toBe(true);
    expect(paceText(pace)).toMatch(/^At least \d+h of estimated work left, \d+ days to 31 Jan 2027: it fits\. 1 of 3 tasks done\.$/);
  });

  it("shows the gate a goal run asked for, and the run working it", () => {
    const html = overview(working, workingRuns);
    expect(working.gate).toMatchObject({ state: "pending", owner: "VP", requestedBy: `goal-run:${AGENT}` });
    expect(html).toContain('data-goal-gate="pending" data-goal-gate-by="goal-run"');
    expect(html).toContain("Waiting for VP's approval.");
    expect(html).toContain(`Asked for by ${AGENT}'s goal run`);
    expect(html).toContain(`data-goal-run="${refs.goalRun}"`);
    expect(html).toContain(`${AGENT}'s goal run`);
    expect(html).toContain("created 1 of 5 tickets it may");
  });

  it("once the goal is met: every criterion met, the gate still waiting for VP, the run finished", () => {
    const html = overview(met, endRuns);
    expect(html).toContain('data-goal-met="true"');
    expect([...html.matchAll(/data-verdict="(\w+)"/g)].map((match) => match[1])).toEqual(["met", "met", "met", "met", "met"]);
    expect(html).toContain("All 5 criteria are met.");
    expect(html).toContain('data-goal-gate="pending" data-goal-gate-by="goal-run"');
    expect(html).toContain(`Last goal run (${AGENT})`);
    expect(html).toContain(`Goal met: ${refs.m} is waiting for approval`);
  });
});

describe("the run-stopped notice, from /api/runs", () => {
  const all = { since: "2000-01-01T00:00:00.000Z", seen: [] };

  it("while one run fails twice and the other works, names the failure and the ticket to look at", () => {
    const notices = pendingStopNotices(workingRuns, all);
    expect(notices.map((notice) => notice.runId)).toEqual([refs.flakyRun]);
    expect(notices[0]).toMatchObject({ reason: `${refs.lastFailed} failed twice in a row`, tone: "risk", attention: { ref: refs.lastFailed, action: "open" } });
  });

  it("when the goal run ends goal_met, a notice names the milestone awaiting approval, once", () => {
    const notices = pendingStopNotices(endRuns, all);
    expect(notices.map((notice) => notice.runId)).toEqual([refs.goalRun, refs.flakyRun]);
    expect(notices[0]).toMatchObject({
      title: `Autopilot finished · ${refs.m}`,
      reason: `Goal met: ${refs.m} is waiting for approval`,
      attention: { ref: refs.m, action: "review" },
    });
    // Seen stays seen across reads.
    expect(pendingStopNotices(endRuns, { ...all, seen: [`goal/${refs.goalRun}`] }).map((notice) => notice.runId)).toEqual([refs.flakyRun]);
  });

  it("renders the newest notice, compact, with its reason, its link, a dismiss and N more", () => {
    const notices = pendingStopNotices(endRuns, all);
    const list = (props: { placement: "corner" | "strip" | "drawer"; initiallyExpanded?: boolean }) =>
      render(<RunStopNoticeList notices={notices} {...props} onOpenRef={noop} onDetails={noop} onDismiss={noop} onDismissAll={noop} />, endRuns);
    const html = list({ placement: "strip" });
    expect(html).toContain('aria-live="polite"');
    // One card, the newest; the other waits behind "1 more".
    expect(html.match(/data-run-stop-notice=/g)).toHaveLength(1);
    expect(html).toContain(`data-run-stop-notice="${refs.goalRun}"`);
    expect(html).toContain(`>Autopilot · ${refs.m}<`);
    expect(html).toContain(`>Review ${refs.m}<`);
    expect(html).toContain('data-run-stop-more="1"');
    expect(html).toContain(`Dismiss: Autopilot finished · ${refs.m}: Goal met: ${refs.m} is waiting for approval`);
    expect(html).not.toContain("Dismiss all");
    // The reason wraps rather than being cut short.
    expect(html).toContain('<span class="wrap-anywhere">Goal met:');
    // Expanded: both, and the way back and the dismiss-all.
    const open = list({ placement: "corner", initiallyExpanded: true });
    expect(open.match(/data-run-stop-notice=/g)).toHaveLength(2);
    expect(open).toContain(`>Open ${refs.lastFailed}<`);
    expect(open).toContain("Show fewer");
    expect(open).toContain("Dismiss all");
    expect(open).not.toContain("data-run-stop-more");
  });

  it("with nothing to say, keeps the live region and draws no box, so a phone shows no empty bar", () => {
    for (const placement of ["strip", "drawer", "corner"] as const) {
      const empty = render(<RunStopNoticeList notices={[]} placement={placement} onOpenRef={noop} onDetails={noop} onDismiss={noop} onDismissAll={noop} />, endRuns);
      const region = /<section[^>]*>([\s\S]*?)<\/section>/.exec(empty)!;
      expect(region[0], placement).toContain('aria-live="polite"');
      expect(region[0], placement).not.toMatch(/border|px-|py-|hidden/);
      expect(region[1], placement).toBe("");
    }
  });
});

describe("the links' landing", () => {
  it("a document link opens that ticket on its Documents tab with the document pinned, and nothing else", () => {
    const opened: string[] = [];
    const doc = { kind: "document" as const, ref: "GOA-2", document: "plan" };
    openEvidence(doc, "GOA-1", (ref) => opened.push(ref));
    expect(opened).toEqual(["GOA-2"]);
    expect(takeArrivalTab("GOA-2")).toBe("documents");
    expect(takePendingDocumentKey("GOA-2")).toBe("plan");
    // Consumed: a later visit to the ticket opens on its default tab.
    expect(takeArrivalTab("GOA-2")).toBeNull();
    expect(takePendingDocumentKey("GOA-2")).toBeNull();
    // A request the next panel is not for is dropped, key and all: it never lands later.
    openTabOnArrival("GOA-2", "documents", "plan");
    expect(takeArrivalTab("GOA-9")).toBeNull();
    expect(takeArrivalTab("GOA-2")).toBeNull();
    expect(takePendingDocumentKey("GOA-2")).toBeNull();
  });

  it("the milestone's own document switches the open panel's tab in place, and queues no arrival", () => {
    const events: string[] = [];
    const globals = globalThis as { window?: unknown };
    const before = globals.window;
    globals.window = { dispatchEvent: (event: CustomEvent<string>) => void events.push(event.detail) };
    try {
      const opened: string[] = [];
      openEvidence({ kind: "document", ref: "GOA-1", document: "self" }, "GOA-1", (ref) => opened.push(ref));
      expect(opened).toEqual([]);
      expect(events).toEqual(["documents"]);
      // No arrival waits for GOA-1's next visit, and the pin is for GOA-1 only.
      expect(takeArrivalTab("GOA-1")).toBeNull();
      expect(takePendingDocumentKey("GOA-3")).toBeNull();
      openEvidence({ kind: "document", ref: "GOA-1", document: "self" }, "GOA-1", () => {});
      expect(takePendingDocumentKey("GOA-1")).toBe("self");
    } finally {
      globals.window = before;
    }
  });

  it("while a task is open, the shell's notices step aside and the modal detail shows them in its own flow", () => {
    const globals = globalThis as { localStorage?: unknown };
    const before = globals.localStorage;
    const stored = JSON.stringify({ since: "2000-01-01T00:00:00.000Z", seen: [] });
    globals.localStorage = { getItem: () => stored, setItem: noop };
    resetStopSeenForTests();
    try {
      const withDetail = (node: ReactElement) =>
        renderToStaticMarkup(
          <SessionContext.Provider value={{ ...session(), selection: { workspace: "goal", ref: refs.m! } as StapleSession["selection"] }}>
            <RunsContext value={buildRunsState(endRuns)}>{node}</RunsContext>
          </SessionContext.Provider>,
        );
      // The shell's: the live region only, nothing in it.
      for (const placement of ["corner", "strip"] as const) {
        const shell = withDetail(<RunStopNotices placement={placement} />);
        expect(shell, placement).toContain(`data-run-stop-notices="${placement}"`);
        expect(shell, placement).not.toContain("data-run-stop-notice=");
      }
      // The drawer's: the newest notice, in flow (no fixed positioning).
      const drawer = withDetail(<RunStopNotices placement="drawer" />);
      expect(drawer).toContain(`data-run-stop-notice="${refs.goalRun}"`);
      expect(drawer).not.toContain("fixed");
      // With no task open, the shell's shows it.
      expect(render(<RunStopNotices placement="strip" />, endRuns)).toContain(`data-run-stop-notice="${refs.goalRun}"`);
    } finally {
      globals.localStorage = before;
      resetStopSeenForTests();
    }
    // Mounted inside the dialog's content, so it is in the focus trap; pinned in the source.
    const mount = readFileSync(fileURLToPath(new URL("./IssueDetailMount.tsx", import.meta.url)), "utf8");
    const content = mount.slice(mount.indexOf("<DialogPrimitive.Content"), mount.indexOf("</DialogPrimitive.Content>"));
    expect(content).toContain('<RunStopNotices placement="drawer" />');
    // A press on a notice is not a press outside a dialog.
    const source = readFileSync(fileURLToPath(new URL("../components/autopilot/RunStopNotices.tsx", import.meta.url)), "utf8");
    expect(source).toContain("onPointerDown={(event) => event.stopPropagation()}");
  });
});

describe("a stop this page made", () => {
  it("is marked seen by Stop itself, after the stop succeeds, so it raises no notice", () => {
    const source = readFileSync(fileURLToPath(new URL("../components/autopilot/RunParts.tsx", import.meta.url)), "utf8");
    const stop = source.slice(source.indexOf("const stop = async"), source.indexOf("} catch (error)", source.indexOf("const stop = async")));
    expect(stop.indexOf("await stopRun(")).toBeGreaterThan(-1);
    expect(stop.indexOf("markStopsSeen([stopKey(entry)])")).toBeGreaterThan(stop.indexOf("await stopRun("));
  });

  it("a key marked seen in the tab's store hides that run's notice everywhere in the tab", () => {
    const globals = globalThis as { localStorage?: unknown };
    const before = globals.localStorage;
    const map = new Map<string, string>([["staple:run-stops:v1", JSON.stringify({ since: "2000-01-01T00:00:00.000Z", seen: [] })]]);
    globals.localStorage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
    resetStopSeenForTests();
    try {
      expect(render(<RunStopNotices placement="strip" />, endRuns)).toContain(`data-run-stop-notice="${refs.goalRun}"`);
      markStopsSeen([`goal/${refs.goalRun}`]);
      const after = render(<RunStopNotices placement="strip" />, endRuns);
      expect(after).not.toContain(`data-run-stop-notice="${refs.goalRun}"`);
      expect(after).toContain(`data-run-stop-notice="${refs.flakyRun}"`);
      expect(JSON.parse(map.get("staple:run-stops:v1")!).seen).toEqual([`goal/${refs.goalRun}`]);
    } finally {
      globals.localStorage = before;
      resetStopSeenForTests();
    }
  });
});
