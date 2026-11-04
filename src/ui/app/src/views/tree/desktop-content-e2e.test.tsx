/**
 * The desktop task list and views, drawn from what a real server sends.
 *
 * The workspace is the milestones scenario (test/fixtures/milestones-scenario.ts), seeded
 * through the store; every claim and assignee below is written through `POST /api/action`,
 * the route the web UI itself uses, and every row, queue and milestone rendered here is the
 * server's JSON. Nothing about who holds a task, what the queue calls it, or how far a
 * milestone has got is hand-set.
 */
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { IssueRow, MilestoneListRow, MilestoneView, QueueView } from "@/lib/types";
import { SCENARIO, SCENARIO_WS, seedScenarioWorkspace } from "../../../../../../test/fixtures/milestones-scenario.ts";
import { startUiServer } from "../../../../server.ts";
import { initWorkspace } from "../../../../../core/workspace.ts";
import { ApiError } from "@/lib/api";
import { describeRefusal } from "@/lib/refusal";
import type { WorkspaceSettingsEnvelope } from "@/lib/settings";
import { applyRowStatus, plainRowRefusal, rowStatusChoices, type StatusChoice } from "@/components/task-list/row-status";
import { MilestoneDetailPane, MilestoneListPane } from "../milestones/MilestonesView";
import { memberListRows, sortMilestones } from "../milestones/milestones-model";
import { QueueBoard } from "../queue/QueueView";
import { effectivePreview, planRows } from "../queue/queue-model";
import { queueSummary, summarySentence } from "../queue/queue-summary";
import { TreeGrid } from "./TreeGrid";
import { attachRowCues, buildRowCueIndex } from "@/components/task-list/row-cues";

/** Fixed, so due-date words are pinned: October cut is due 2026-10-31. */
const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};
const DESK = 1440;
const OTHER_WS = "otherws";
const PHONE = 390;

let home: string;
let ui: { server: Server; token: string; close(): void };
let origin: string;
let issues: IssueRow[];
let queue: QueueView;
let milestones: MilestoneListRow[];
let october: MilestoneView;

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${origin}${path}`, { headers: { "x-staple-token": ui.token } });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
}

async function act(ref: string, actor: string, payload: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "x-staple-token": ui.token, "content-type": "application/json" },
    body: JSON.stringify({ ws: SCENARIO_WS, ref, actor, ...payload }),
  });
  expect(response.status, `${payload.type} ${ref}: ${await response.clone().text()}`).toBe(200);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-desk-e2e-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  seedScenarioWorkspace(home);
  // A second workspace with a status the scenario's does not have, and one task in it:
  // the row's own vocabulary and the row's own workspace are what the status change must use.
  const other = initWorkspace({ global: true, slug: OTHER_WS });
  try {
    other.store.addStatus({ id: "awaiting_qa", label: "Awaiting QA", category: "review" }, "fixture");
    other.store.createIssue({ title: "Other workspace task", createdBy: "fixture" });
  } finally {
    other.store.db.close();
  }
  ui = startUiServer({ port: 0, hub: true });
  await once(ui.server, "listening");
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;

  // An agent assigned to its own work and working on it: one person, two roles.
  await act(SCENARIO.q1, "opus-a", { type: "assignee", assignee: "opus-a" });
  await act(SCENARIO.q1, "opus-a", { type: "checkout" });
  // A person assigned, a different agent working: two people. The assignee is written after
  // the checkout, because a checkout assigns the task to whoever takes it.
  await act(SCENARIO.q3, "opus-b", { type: "checkout" });
  await act(SCENARIO.q3, "vp", { type: "assignee", assignee: "vp" });
  // Assigned, nobody working yet.
  await act(SCENARIO.q2, "vp", { type: "assignee", assignee: "vp" });

  issues = await get<IssueRow[]>(`/api/issues?ws=${SCENARIO_WS}`);
  queue = await get<QueueView>(`/api/queue?ws=${SCENARIO_WS}&all=1`);
  milestones = await get<MilestoneListRow[]>(`/api/milestones?ws=${SCENARIO_WS}&all=1`);
  october = await get<MilestoneView>(`/api/milestone?ws=${SCENARIO_WS}&ref=${SCENARIO.october}`);
}, 60_000);

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

/** Render with the viewport answering `min-width` queries as `width` would. */
function atWidth<T>(width: number, render: () => T): T {
  const globals = globalThis as { window?: unknown };
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : false };
    },
  };
  try {
    return render();
  } finally {
    delete globals.window;
  }
}

function list(width: number, statusMenu = true): string {
  return atWidth(width, () =>
    renderToStaticMarkup(
      <TreeGrid
        rows={issues}
        allRows={issues}
        mode="workspace"
        groupBy="none"
        currentRef={null}
        showResolved
        onOpen={noop}
        rowStatusMenu={statusMenu ? (_row, trigger) => trigger : undefined}
        onCloseDrawer={noop}
        onVisibleOrder={noop}
      />,
    ),
  );
}

/** One row's markup, by identifier (never a ghost). */
function row(markup: string, identifier: string): string {
  const start = markup.indexOf(`data-testid="task-row" data-identifier="${identifier}"`);
  expect(start, identifier).toBeGreaterThan(-1);
  const next = markup.indexOf('data-testid="task-row"', start + 10);
  return markup.slice(start, next === -1 ? undefined : next);
}

const count = (text: string, needle: string | RegExp) =>
  typeof needle === "string" ? text.split(needle).length - 1 : (text.match(needle) ?? []).length;

describe("who is on a task, drawn once", () => {
  it("the payload really carries the claims and assignees the rows are about", () => {
    const byId = new Map(issues.map((r) => [r.issue.identifier, r]));
    expect(byId.get(SCENARIO.q1)!.issue.assignee).toBe("opus-a");
    expect(byId.get(SCENARIO.q1)!.issue.checkoutAgent).toBe("opus-a");
    expect(byId.get(SCENARIO.q3)!.issue.assignee).toBe("vp");
    expect(byId.get(SCENARIO.q3)!.issue.checkoutAgent).toBe("opus-b");
    expect(byId.get(SCENARIO.q2)!.issue.assignee).toBe("vp");
    expect(byId.get(SCENARIO.q2)!.issue.checkoutAgent).toBeNull();
  });

  it("draws an agent assigned to its own work once, with one plain word", () => {
    const markup = row(list(DESK), SCENARIO.q1);
    expect(markup).toContain('data-testid="who-cue"');
    // One avatar in the whole cue cluster, not a pill avatar and an assignee avatar.
    const cluster = markup.slice(markup.indexOf("data-cue-cluster"));
    expect(count(cluster, 'class="staple-avatar')).toBe(1);
    expect(cluster).toMatch(/data-state="(working|held)"/);
    // No "Working…": a word that looks cut short is the defect this cue replaces.
    expect(markup).not.toContain("Working…");
    expect(markup).not.toContain("staple-working-pill");
  });

  it("draws two different people as two avatars", () => {
    const cluster = row(list(DESK), SCENARIO.q3);
    const avatars = [...cluster.matchAll(/class="staple-avatar[^"]*"[^>]*>([A-Z?]{2})</g)].map((m) => m[1]);
    expect(avatars).toEqual(["VP", "OB"]);
  });

  it("draws an assignee with nobody working as an avatar and no word", () => {
    const markup = row(list(DESK), SCENARIO.q2);
    expect(markup).toContain('data-state="assigned"');
    expect(markup).not.toContain("staple-who-word");
  });

  it("keeps the phone row exactly as it shipped: the compact claim avatar, no desktop cue", () => {
    const markup = row(list(PHONE), SCENARIO.q1);
    expect(markup).toContain('data-layout="compact"');
    expect(markup).not.toContain("data-desk");
    expect(markup).not.toContain("who-cue");
    expect(markup).not.toContain("row-quick-actions");
    expect(markup).toMatch(/data-testid="(working|held)-pill"/);
  });
});

describe("the desktop row's anatomy", () => {
  const markup = () => row(list(DESK), SCENARIO.q2);

  it("puts every right-hand cue in one cluster", () => {
    const m = markup();
    expect(count(m, "data-cue-cluster")).toBe(1);
    // The blocker cue (MSC-4 waits on MSC-3) sits inside it, not beside it.
    const cluster = m.slice(m.indexOf("data-cue-cluster"));
    expect(cluster).toContain("staple-dep-badge");
  });

  it("holds the date and the quick actions in one trailing box", () => {
    const m = markup();
    const trail = m.slice(m.indexOf('class="staple-row-trail"'));
    expect(trail).toContain("staple-row-date");
    expect(trail).toContain('data-testid="row-quick-actions"');
    expect(trail).toContain('data-quick="status"');
    expect(trail).toContain('data-quick="open"');
  });

  it("offers no status action where the container cannot write", () => {
    expect(row(list(DESK, false), SCENARIO.q2)).not.toContain('data-quick="status"');
  });

  it("starts every title at one left edge: a kind slot on every row, empty for a plain task", () => {
    const epic = row(list(DESK), SCENARIO.queueEpic);
    const task = row(list(DESK), SCENARIO.q2);
    expect(epic).toMatch(/data-kind-slot="">\s*<span[^>]*staple-kind-glyph/);
    expect(task).toContain('data-kind-slot=""></span>');
  });

  it("keeps the hierarchy guides", () => {
    expect(row(list(DESK), SCENARIO.q2)).toContain("staple-guide-elbow");
  });
});

const DESK_CSS = readFileSync(
  fileURLToPath(new URL("../../components/task-list/desktop-row.css", import.meta.url)),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the rule whose WHOLE selector list is `selector` (not a rule it is one part of). */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|})\\s*${escaped} \\{([^}]*)\\}`).exec(DESK_CSS);
  expect(match, selector).not.toBeNull();
  return match![1]!.trim();
}

describe("nothing moves when the actions appear", () => {
  it("keeps the actions invisible and out of the pointer's way until the row is hovered, focused, open or selected", () => {
    expect(rule(".staple-row-quick")).toMatch(/opacity:\s*0;/);
    expect(rule(".staple-row-quick")).toMatch(/pointer-events:\s*none/);
  });

  it("lays the actions over the end of the cue cluster, on the row's opaque ground, instead of beside it", () => {
    expect(rule(".staple-row-quick")).toMatch(/position:\s*absolute/);
    expect(rule(".staple-row-quick")).toMatch(/right:\s*0/);
    expect(rule(".staple-row-quick")).toMatch(/background:\s*var\(--card\)/);
    expect(rule(".staple-row[data-desk] .staple-row-meta")).toMatch(/position:\s*relative/);
    // No box of their own on every row: the trailing slot is only as wide as the date.
    expect(rule(".staple-row-trail")).toMatch(/min-width:\s*var\(--desk-trail-w\)/);
  });

  it("reveals them with opacity alone — no display, width or margin change", () => {
    const reveal = DESK_CSS.slice(DESK_CSS.indexOf(".staple-row[data-desk]:is(:hover"));
    const body = reveal.slice(reveal.indexOf("{") + 1, reveal.indexOf("}"));
    expect(body).toMatch(/opacity:\s*1/);
    expect(body).not.toMatch(/display|width|margin|padding|position/);
  });
});

describe("hover, keyboard focus, selected and open are four different looks", () => {
  it("gives each state its own declarations", () => {
    const hover = rule(".staple-row[data-desk]:hover,\n.staple-row[data-desk]:focus-visible");
    const focus = rule(".staple-row[data-desk]:focus-visible");
    const selected = rule('.staple-row[data-desk][aria-selected="true"]');
    const open = rule('.staple-row[data-desk][aria-current="true"]');
    const looks = [hover, focus, selected, open];
    expect(new Set(looks).size).toBe(4);
    expect(focus).toMatch(/outline:\s*2px solid var\(--ring\)/);
    expect(selected).toMatch(/color-mix\(in oklab, var\(--ring\)/);
    expect(open).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--ring\)/);
  });
});

describe("the queue in plain words", () => {
  it("counts the plan from the resolver's own verdicts", () => {
    const summary = queueSummary(queue.effective);
    const inPlan = queue.effective.filter((r) => !r.unqueued);
    // MSC-3 is claimed (opus-a took it above), MSC-4 waits on MSC-3, MSC-5 is claimed by
    // opus-b, November's gated epic holds MSC-7 and MSC-8 behind approval.
    expect(summary.planned).toBe(inPlan.length);
    expect(summary.counts.active).toBe(inPlan.filter((r) => r.eligibility === "claimed").length);
    expect(summary.counts.active).toBeGreaterThanOrEqual(2);
    expect(summary.counts.waiting).toBe(
      inPlan.filter((r) => ["blocked", "gated", "unavailable"].includes(r.eligibility)).length,
    );
    expect(summary.counts.waiting).toBeGreaterThanOrEqual(3);
    expect(summary.notPlanned).toBe(queue.effective.filter((r) => r.unqueued).length);
  });

  it("says it on the desktop page as a sentence and a bar, and keeps the revision under Show details", () => {
    const html = renderToStaticMarkup(
      <QueueBoard
        view={queue}
        rows={planRows(queue, issues, SCENARIO_WS)}
        preview={effectivePreview(queue)}
        known={new Map()}
        workspace={SCENARIO_WS}
        now={NOW}
        busy={false}
        failure={null}
        candidates={[]}
        collapsed={new Set()}
        unqueuedOpen={false}
        onOpen={noop}
        onToggleCollapsed={noop}
        onToggleUnqueued={noop}
        onMove={noop}
        onMoveToEdge={noop}
        onAdd={noop}
        onPrune={noop}
        onReload={noop}
        onRetry={noop}
        onDismissFailure={noop}
        desk
      />,
    );
    expect(html).toContain(summarySentence(queueSummary(queue.effective)));
    expect(html).toContain('data-testid="queue-progress"');
    expect(html).toContain('data-segment="active"');
    expect(html).toContain('data-segment="waiting"');
    // One palette: waiting is the blocked red, ready the to-do amber, as on the rows' glyphs.
    expect(html).toMatch(/data-segment="waiting" style="flex-grow:\d+;background:var\(--status-task-blocked\)"/);
    expect(html).toMatch(/data-legend="ready"[^>]*><span class="staple-progress-dot" style="background:var\(--status-task-todo\)"/);
    expect(html).toMatch(/<details[^>]*data-technical-details[\s\S]*data-queue-revision="\d+"/);
    expect(html).not.toContain("entries · revision");
  });
});

describe("milestones in plain words", () => {
  it("states the due date as a day and a distance, from the store's target", () => {
    const html = renderToStaticMarkup(
      <MilestoneDetailPane
        view={october}
        effective={queue.effective}
        members={memberListRows(october, issues, SCENARIO_WS)}
        now={NOW}
        busy={false}
        failure={null}
        fullScreen={false}
        onToggleFullScreen={noop}
        onOpen={noop}
        onMove={noop}
        onRemove={noop}
        onAdd={noop}
        onReload={noop}
        onDismissFailure={noop}
        desk
      />,
    );
    expect(october.milestone.targetDate).toBe("2026-10-31");
    expect(html).toContain("Due 31 Oct, in 57 days");
    // The store's numbers: five leaves, one cancelled, one done.
    expect(html).toContain(`${october.progress.counts.done} of ${october.progress.countable} tasks finished (${october.progress.percent}%).`);
    expect(html).toContain('data-testid="milestone-progress"');
    // The raw figures stay, behind the disclosure.
    expect(html).toMatch(/<details[^>]*data-technical-details[\s\S]*data-milestone-rollups/);
  });

  it("gives each card a progress bar and the queue's blocked count in words", () => {
    const html = renderToStaticMarkup(
      <MilestoneListPane rows={sortMilestones(milestones)} effective={queue.effective} selectedRef={null} onSelect={noop} desk />,
    );
    expect(count(html, "data-milestone-row=")).toBe(milestones.length);
    expect(count(html, 'class="staple-progress"')).toBe(milestones.length);
    expect(html).toMatch(/\d+ (is|are) blocked[.,:]/);
  });
});

/** `lib/api`'s `action`, over this test's real server: same body, same error type. */
async function realAct(target: { ws: string; ref: string }, payload: Record<string, unknown>): Promise<unknown> {
  const response = await fetch(`${origin}/api/action`, {
    method: "POST",
    headers: { "x-staple-token": ui.token, "content-type": "application/json" },
    body: JSON.stringify({ ...target, actor: "vp", ...payload }),
  });
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

const vocabulary = async (ws: string): Promise<StatusChoice[]> =>
  (await get<WorkspaceSettingsEnvelope>(`/api/settings?ws=${ws}`)).statuses.map((s) => ({ id: s.id, label: s.label, category: s.category }));

describe("changing a status from the row", () => {
  it("offers the row's own workspace statuses, never the current one again, and no gated status", async () => {
    const mine = rowStatusChoices(await vocabulary(OTHER_WS), "backlog");
    const theirs = rowStatusChoices(await vocabulary(SCENARIO_WS), "backlog");
    expect(mine.map((c) => c.id)).toContain("awaiting_qa");
    expect(theirs.map((c) => c.id)).not.toContain("awaiting_qa");
    expect(mine.find((c) => c.id === "backlog")).toMatchObject({ current: true, disabled: true });
    expect(mine.filter((c) => c.disabled).map((c) => c.id)).toEqual(["backlog"]);
    expect(mine.some((c) => c.category === "gated")).toBe(false);
  });

  it("writes to the row's workspace, whatever the page is scoped to", async () => {
    const otherRows = await get<IssueRow[]>(`/api/issues?ws=${OTHER_WS}`);
    const row = otherRows.find((r) => r.issue.title === "Other workspace task")!;
    await applyRowStatus(row, "awaiting_qa", realAct);
    const after = await get<IssueRow[]>(`/api/issues?ws=${OTHER_WS}`);
    expect(after.find((r) => r.issue.id === row.issue.id)!.issue.status).toBe("awaiting_qa");
  });

  it("turns the store's real refusal into a plain sentence with the fix", async () => {
    const byId = new Map(issues.map((r) => [r.issue.identifier, r]));
    const unassigned = byId.get(SCENARIO.s2)!;
    expect(unassigned.issue.assignee).toBeNull();
    const refusal = await applyRowStatus(unassigned, "in_progress", realAct).then(
      () => null,
      (error: unknown) => describeRefusal(error),
    );
    expect(refusal).not.toBeNull();
    const words = plainRowRefusal(refusal!, { label: "In Progress" });
    expect(words).toEqual({ sentence: "Can't move this to In Progress: it needs someone assigned first.", needsAssignee: true });
    expect(words.sentence).not.toMatch(/refused|validation|retryable|requires/i);
  });

  it("draws the notice directly under its row, and nowhere else", () => {
    const markup = atWidth(DESK, () =>
      renderToStaticMarkup(
        <TreeGrid
          rows={issues}
          allRows={issues}
          mode="workspace"
          groupBy="none"
          currentRef={null}
          showResolved
          onOpen={noop}
          rowNotice={(r) => (r.issue.identifier === SCENARIO.q2 ? <div data-row-notice={r.issue.identifier} /> : null)}
          onCloseDrawer={noop}
          onVisibleOrder={noop}
        />,
      ),
    );
    expect(count(markup, "data-row-notice=")).toBe(1);
    const rowAt = markup.indexOf(`data-identifier="${SCENARIO.q2}"`);
    const noticeAt = markup.indexOf(`data-row-notice="${SCENARIO.q2}"`);
    const nextRow = markup.indexOf('data-testid="task-row"', rowAt + 10);
    expect(noticeAt).toBeGreaterThan(rowAt);
    expect(noticeAt).toBeLessThan(nextRow);
  });
});

describe("the plan and blocker cues in plain words (single-workspace list)", () => {
  const cued = () => {
    const titles = new Map(milestones.map((m) => [m.milestone.identifier, m.milestone.title]));
    const rows = attachRowCues(issues, buildRowCueIndex(queue, titles));
    return atWidth(DESK, () =>
      renderToStaticMarkup(
        <TreeGrid rows={rows} allRows={rows} mode="workspace" groupBy="none" currentRef={null} showResolved onOpen={noop} onCloseDrawer={noop} onVisibleOrder={noop} />,
      ),
    );
  };

  it("shows the plan as Next and Queued pills after the title, never as marks before it", () => {
    const markup = cued();
    expect(markup).toMatch(/data-pickup-pill="(next|queued)"/);
    expect(markup).not.toMatch(/<span aria-hidden="true">(▸|·|#\d+|plan #\d+)<\/span>/);
    // Every cued row still carries the whole sentence for a screen reader.
    const cues = [...markup.matchAll(/data-testid="row-pickup-cue"[\s\S]*?<\/span><\/span>/g)].map((m) => m[0]);
    expect(cues.length).toBeGreaterThan(0);
    for (const cue of cues) expect(cue).toContain('class="sr-only"');
  });

  it("names the milestone a task is planned under in a chip", () => {
    expect(cued()).toContain('class="staple-row-milestone-name">October cut<');
  });

  it("gives the blocked task the strong, worded cue and the blocking task a neutral one", () => {
    const markup = list(DESK);
    // MSC-4 waits on MSC-3.
    expect(row(markup, SCENARIO.q2)).toMatch(/data-kind="blocked-by" data-words=""[\s\S]*?<span>Blocked by 1<\/span>/);
    expect(row(markup, SCENARIO.q1)).toMatch(/data-kind="blocks" data-words=""[\s\S]*?<span>Blocks 1<\/span>/);
    expect(row(markup, SCENARIO.q1)).not.toContain('data-kind="blocked-by"');
  });
});
