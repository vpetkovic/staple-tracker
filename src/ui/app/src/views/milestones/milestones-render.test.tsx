/**
 * The Milestones outline as markup: what a section's header says from the list row alone, what
 * its body draws for the goal and the work, how a failed write is shown, which controls a
 * finished milestone keeps, the outline's sections, shelf and states, and the control sizes.
 * Rendered with `react-dom/server`, no DOM, the way `components/task-list/row-render.test.tsx`
 * does; the live presses are `test/ui-milestones-page.test.ts`'s.
 */
import { DropdownMenu as Menu } from "radix-ui";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { issue, row } from "@/components/task-list/fixtures";
import { detail, issue as detailIssue } from "@/detail/detail-fixture";
import { useIssueActions } from "@/detail/IssueActions";
import { clearedMarkText } from "@/detail/MilestoneGoal";
import { SessionContext, type StapleSession } from "@/lib/session";
import type { EffectiveQueueRow, MilestoneListRow, MilestoneView } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { effective } from "@/views/queue/fixtures";
import { criterion, goal, listRow, member, progress, view, work } from "./fixtures";
import { AddWork, goalStartsOpen, MilestoneGlyph, StatusSubmenu } from "./milestone-parts";
import { milestonesMemoryKey } from "./milestones-memory";
import { landingOf, MilestonesOutline, outlineGroups } from "./MilestonesOutline";
import { openInPlan, SectionBody, SectionView, type SectionQueue } from "./MilestoneSection";
import type { MilestoneWork } from "./useMilestoneWork";
import { memberRowKey, WorkTree } from "./WorkTree";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};
const idle: SectionQueue = { busy: false, refusal: null, onQueue: noop, onDequeue: noop, onDismiss: noop };

const inSession = (node: ReactNode, over: Partial<StapleSession> = {}) =>
  renderToStaticMarkup(<SessionContext.Provider value={fakeSession({ ws: "staple", ...over })}>{node}</SessionContext.Provider>);

/** The list row a view's milestone has. */
const rowOf = (data: MilestoneView): MilestoneListRow => listRow({ milestone: data.milestone, progress: data.progress, next: data.next, memberCount: data.members.length });

function section(rowData: MilestoneListRow, w: MilestoneWork, over: Partial<Parameters<typeof SectionView>[0]> = {}): string {
  return inSession(<SectionView row={rowData} work={w} workspace="staple" effective={[]} folded={false} onFold={noop} narrow={false} queue={idle} {...over} />);
}

/** Visible words, tags stripped. */
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** Render as if the viewport were `width` px wide, with this browser's storage. */
function atWidth(width: number, storage: Record<string, string>, draw: () => string): string {
  const globals = globalThis as { window?: unknown };
  globals.window = {
    matchMedia: (query: string) => {
      const min = /min-width:\s*(\d+)px/.exec(query);
      const max = /max-width:\s*(\d+)px/.exec(query);
      return { matches: min ? width >= Number(min[1]) : max ? width <= Number(max[1]) : false, addEventListener: noop, removeEventListener: noop };
    },
    localStorage: { getItem: (key: string) => storage[key] ?? null, setItem: noop },
  };
  return draw();
}
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

const epic = issue({ id: "e1", identifier: "STA-66", kind: "epic", title: "S epic", status: "in_progress" });
const child = issue({ id: "c1", identifier: "STA-67", parentId: "e1", title: "S1", status: "blocked" });
const issues = [epic, child].map((i) => ({ ...row(), issue: i }));
const data = view({
  milestone: { identifier: "STA-190", title: "October cut", startDate: "2026-09-01", targetDate: "2026-10-31", assignee: "VP" },
  progress: progress({ counts: { done: 1, active: 1, ready: 1 } }),
  members: [member({ identifier: "STA-146", position: 1, note: "the flake, no epic" }), member({ identifier: "STA-66", kind: "epic", position: 2 })],
});
const loaded = (over: Partial<MilestoneWork> = {}) => work(data, { issues, now: NOW, ...over });

describe("a section's header", () => {
  const october = listRow({
    // Its target passed on every calendar: overdue by the store and by the reader's day.
    milestone: { identifier: "STA-190", title: "October cut", targetDate: "2026-08-31", state: "overdue" },
    progress: progress({ counts: { done: 5, ready: 6 } }),
    memberCount: 3,
    next: { identifier: "STA-67", position: 4 },
  });
  const queue: EffectiveQueueRow[] = [
    effective({ identifier: "STA-68", milestonePath: ["STA-190"], eligibility: "blocked", status: "todo" }),
    effective({ identifier: "STA-69", milestonePath: ["STA-190"], eligibility: "gated", status: "todo" }),
    // November's own blocked row must not leak into October's header.
    effective({ identifier: "STA-70", milestonePath: ["STA-191"], eligibility: "blocked", status: "todo" }),
  ];

  it("says the due date, the bar and percent, what needs attention and the facts, from the list row alone", () => {
    const html = section(october, work(null, { now: NOW }), { effective: queue, folded: true });
    expect(html).toContain('data-milestone-section="STA-190"');
    expect(html).toContain("data-milestone-folded");
    // The due date in red words, and the glyph red: no separate overdue flag.
    expect(html).toMatch(/data-milestone-target=""[^>]*class="text-\[var\(--plain-risk-fg\)\]">Was due 31 Aug, 4 days ago</);
    expect(html).toContain('data-milestone-glyph="overdue"');
    expect(html).not.toContain('data-plan-flag="late"');
    expect(html).toContain("45%");
    expect(html).toMatch(/data-milestone-flag="blocked"[^>]*>2 blocked</);
    expect(text(html)).toContain("5 of 11 tasks finished. 2 are blocked: 1 waits on other tasks, 1 on a person. Next up: STA-67, number 4 in the pickup order.");
    // No status pill: the status is in the `⋯` menu.
    expect(html).not.toContain("data-milestone-status");
    expect(html).not.toContain("status-chip");
    // Folded: nothing under the header, and nothing asked of the server for it.
    expect(html).not.toContain("data-milestone-goal-line");
    expect(html).not.toContain("data-milestone-loading");
  });

  it("offers Queue on an open milestone with no queue row, and names its place when it has one", () => {
    const html = section(october, work(null, { now: NOW }));
    expect(html).toMatch(/data-milestone-queue="STA-190"[^>]*>.*?Queue<\/button>/);
    expect(html).not.toContain("data-milestone-queued");
    // No queue read yet: nothing to write against.
    expect(section(october, work(null, { now: NOW }), { queue: { ...idle, onQueue: undefined } })).toMatch(/disabled=""[^>]*data-milestone-queue="STA-190"/);
    const queued = section(listRow({ milestone: { ...october.milestone, planPosition: 1 } }), work(null, { now: NOW }));
    expect(queued).toContain('data-milestone-queued="1"');
    expect(text(queued)).toContain("Queued #1");
    expect(queued).not.toContain("data-milestone-queue=");
  });

  it("under 760px moves the due date and the queue chip into the facts as text, with no calendar button", () => {
    const queued = listRow({ milestone: { identifier: "STA-190", targetDate: "2026-10-31", planPosition: 2 } });
    const desk = section(queued, work(null, { now: NOW }));
    expect(desk).toContain("data-milestone-due-button");
    expect(desk).not.toContain("data-milestone-facts-due");
    const phone = section(queued, work(null, { now: NOW }), { narrow: true });
    expect(phone).not.toContain("data-milestone-due-button");
    expect(phone).toMatch(/data-milestone-facts-due=""[\s\S]*Due 31 Oct, in 57 days[\s\S]*· Queued #2/);
  });

  it("flags a milestone waiting for approval and one behind its pace", () => {
    const gated = listRow({ milestone: { status: "awaiting_approval" } });
    expect(section(gated, work(null, { now: NOW }))).toMatch(/data-milestone-flag="approval"[^>]*>Waiting for your approval</);
    const behind = view({ goal: goal({ pace: { verdict: "behind" } }) });
    expect(section(rowOf(behind), work(behind, { now: NOW }))).toContain('data-milestone-flag="behind"');
  });

  it("draws each state as its own glyph: a filled ring, red when overdue, the check when done, struck when cancelled", () => {
    const glyphs = (["planned", "active", "overdue", "done", "cancelled"] as const).map((state) => renderToStaticMarkup(<MilestoneGlyph state={state} percent={40} />));
    expect(glyphs[2]).toContain("text-flag-late");
    expect(glyphs[3]).toContain("data-shipped-check");
    expect(glyphs[4]).toContain('stroke-dasharray="1.2 2.6"');
    expect(new Set(glyphs).size).toBe(5);
    // A picture only: the words beside it say the state.
    for (const glyph of glyphs) expect(glyph).toContain('aria-hidden="true"');
  });

  it("puts the status in the menu as the detail's own items, with the current status and its category", () => {
    const gated = detail({ issue: detailIssue({ id: "id-STA-190", identifier: "STA-190", kind: "milestone", status: "awaiting_approval" }) });
    function Menu_() {
      const controller = useIssueActions(noop);
      return (
        <Menu.Root open>
          <Menu.Content forceMount>
            <StatusSubmenu decision={{ detail: gated, controller }} status="awaiting_approval" onRequestApproval={noop} />
            <StatusSubmenu decision={null} status="in_progress" onRequestApproval={noop} />
          </Menu.Content>
        </Menu.Root>
      );
    }
    const html = inSession(<Menu_ />);
    expect(html).toMatch(/data-status-menu=""[^>]*data-status-category="gated"/);
    expect(html).toContain('aria-label="Status: Awaiting Approval. Change status"');
    // Before the detail has loaded the item is there, saying the status, but cannot open.
    expect(html).toMatch(/data-status-category="active"[^>]*data-menu-item="status"[^>]*data-disabled=""|data-disabled=""[^>]*data-status-category="active"/);
  });
});

describe("a section's goal and plan", () => {
  it("opens the goal in place when judging is the job, else starts it folded", () => {
    expect(goalStartsOpen({ milestone: { status: "awaiting_approval", state: "active" }, progress: { complete: false } })).toBe(true);
    expect(goalStartsOpen({ milestone: { status: "in_progress", state: "active" }, progress: { complete: true } })).toBe(true);
    expect(goalStartsOpen({ milestone: { status: "in_progress", state: "active" }, progress: { complete: false } })).toBe(false);
    // Closed: a record, not a question.
    expect(goalStartsOpen({ milestone: { status: "done", state: "done" }, progress: { complete: true } })).toBe(false);
  });

  const judged = view({
    milestone: { identifier: "STA-190" },
    goal: {
      ...goal({ criteria: [criterion({ position: 1, text: "Ships", verdict: "met", marked: "met", why: null }), criterion({ position: 2, text: "Docs read well" })] }),
      cleared: [
        { criterion: "Old wording", verdict: "met", markedBy: "bob", markedAt: "2026-09-01T00:00:00.000Z", reason: "removed" },
        { criterion: "Ships", verdict: "unmet", markedBy: "alice", markedAt: "2026-09-02T00:00:00.000Z", reason: "superseded" },
      ],
    },
  });

  it("says the goal on one line while folded: the count, the pace, the next criterion", () => {
    const html = inSession(<SectionBody work={work(judged, { now: NOW })} workspace="staple" row={rowOf(judged)} />);
    expect(html).toMatch(/data-milestone-goal-line="STA-190"[^>]*>/);
    expect(html).toMatch(/aria-expanded="false"[^>]*data-milestone-goal-line/);
    expect(text(html)).toContain("Goal 1 of 2 met");
    expect(text(html)).toContain("Next: Docs read well");
    expect(html).not.toContain("data-goal-criterion");
  });

  it("lists the criteria, the marks it cleared and the pace once open", () => {
    const html = inSession(<SectionBody work={work(judged, { now: NOW })} workspace="staple" row={rowOf(judged)} defaultGoalOpen />);
    expect(html).toContain('data-goal-criterion="1"');
    expect(html).toContain('data-goal-criterion="2"');
    expect(html).toContain('data-goal-cleared-reason="removed"');
    expect(text(html)).toContain("bob's met mark on “Old wording” was cleared: its criterion was removed.");
    expect(text(html)).toContain("alice's earlier unmet mark on “Ships” was replaced by a later one.");
    expect(text(html)).toContain("Pace.");
    // None cleared: no list at all.
    expect(inSession(<SectionBody work={work(data, { now: NOW })} workspace="staple" row={rowOf(data)} defaultGoalOpen />)).not.toContain("data-goal-cleared");
    expect(clearedMarkText({ criterion: "C", verdict: "unknown", markedBy: "x", reason: "superseded" })).toBe("x's earlier unknown mark on “C” was replaced by a later one.");
  });

  it("draws the Plan line only for a horizon", () => {
    expect(inSession(<SectionBody work={loaded()} workspace="staple" row={rowOf(data)} />)).not.toContain("data-milestone-plan-line");
  });

  it("opens a horizon in Plan inside the app, by the workspace and the horizon's identifier", () => {
    const calls: Array<[string, string]> = [];
    openInPlan({ openHorizon: (workspace, ref) => calls.push([workspace, ref]) }, "exercises-api", { identifier: "EXE-12" });
    expect(calls).toEqual([["exercises-api", "EXE-12"]]);
  });
});

describe("a section's work", () => {
  const body = (w: MilestoneWork, rowData = rowOf(w.view!)) => inSession(<SectionBody work={w} workspace="staple" row={rowData} />);

  it("heads the work with its count and draws each member with the shared row, an epic's children under it", () => {
    const html = body(loaded());
    expect(text(html)).toContain("Work, in order 2 items");
    expect(html.match(/data-testid="task-row"/g)).toHaveLength(3);
    expect(html).toMatch(/<ul role="treegrid" aria-label="Work in October cut"/);
    expect(html).toMatch(/role="row" aria-level="1" aria-expanded="true"[^>]*data-member-row="STA-66"/);
    expect(html).toMatch(/role="row" aria-level="2"[^>]*data-member-row="STA-67"/);
    expect(html).toContain("staple-row-bare");
    expect(html).toContain('aria-label="Collapse STA-66"');
    expect(html.match(/data-member-role="member"/g)).toHaveLength(2);
    expect(html.match(/data-member-role="child"/g)).toHaveLength(1);
    // The note, on its own line; the true position of each member, and none on a child.
    expect(html).toContain("the flake, no epic");
    expect(html).toMatch(/data-member-position="1"[^>]*>1</);
    expect(html).toMatch(/data-member-position="2"[^>]*>2</);
    expect(html.match(/data-member-position=/g)).toHaveLength(2);
    const childAt = html.indexOf('data-identifier="STA-67"');
    expect(html.slice(childAt, childAt + 400)).toContain("padding-left:28px");
  });

  it("names every control after the member it acts on, gives a child only Open, and keeps them outside the clickable row", () => {
    const html = body(loaded());
    expect(html).toContain('aria-label="Move STA-146 up"');
    expect(html).toContain('aria-label="Move STA-66 down"');
    expect(html).toContain('data-member-actions="STA-146"');
    expect(html).toContain('data-member-actions="STA-66"');
    // The child's `⋯` opens it and nothing that would rewrite an order.
    expect(html).toContain('aria-label="Actions for STA-67"');
    expect(html).not.toContain('aria-label="Move STA-67 up"');
    const li = /<li role="none" data-milestone-member="STA-66"[\s\S]*?<\/li>/.exec(html)![0];
    const controls = li.indexOf("data-member-controls");
    expect(controls).toBeGreaterThan(li.indexOf('role="row"'));
    for (const label of ["Move STA-66 up", "Move STA-66 down", "Actions for STA-66"]) expect(li.indexOf(`aria-label="${label}"`), label).toBeGreaterThan(controls);
    // The rows rove: one of them takes Tab, the arrows move between them.
    expect(html.match(/role="row"[^>]*tabindex="0"/g)).toHaveLength(1);
  });

  it("keeps a member's true place when Done hides an earlier one", () => {
    const three = view({ members: [member({ identifier: "STA-1", status: "done", position: 1 }), member({ identifier: "STA-2", position: 2 }), member({ identifier: "STA-3", position: 3 })] });
    const html = body(work(three, { now: NOW, members: work(three).members.slice(1), hiddenDone: 1 }));
    expect(html).toMatch(/data-member-position="2"[^>]*>2</);
    expect(html).not.toMatch(/data-member-position="1"/);
    expect(html).toContain('data-hidden-done="1"');
  });

  it("disables the edge moves, and every move while a write is in flight", () => {
    expect(body(loaded())).toMatch(/aria-label="Move STA-146 up"[^>]*disabled=""/);
    expect(body(loaded())).not.toMatch(/aria-label="Move STA-146 down"[^>]*disabled=""/);
    expect(body(loaded({ busy: true }))).toMatch(/aria-label="Move STA-146 down"[^>]*disabled=""/);
  });

  it("says the members are finished, and offers them, when Done hides every one", () => {
    const html = body(loaded({ members: [], hiddenDone: 3 }));
    expect(html).toContain('data-hidden-all=""');
    expect(html).toContain("3 finished items hidden");
    expect(html).toContain("Show done");
    expect(html).not.toContain("Nothing is in this milestone yet");
  });

  it("offers Add work as one quiet line that opens the reference and note fields", () => {
    const html = body(loaded());
    expect(html).toContain("data-milestone-add-open");
    expect(html).not.toContain("data-milestone-add=");
    const open = inSession(<AddWork busy={false} exampleRef="STA-12" onAdd={noop} defaultOpen />);
    expect(open).toContain('aria-label="Identifier to add"');
    expect(open).toContain('placeholder="Task or epic, like STA-12"');
    expect(open).toContain('aria-label="Note for the new member"');
    expect(text(open)).toContain("Add");
    expect(text(open)).toContain("Done");
  });

  it("shows a finished milestone's work read-only: Open only, no moves and no Add work", () => {
    const finished = view({ milestone: { state: "done", status: "done" }, members: [member({ identifier: "STA-10", status: "done" })] });
    const html = body(work(finished, { now: NOW }));
    expect(html).toContain('data-milestone-member="STA-10"');
    expect(html).toContain('aria-label="Actions for STA-10"');
    expect(html).not.toContain("Move STA-10 up");
    expect(html).not.toContain("data-milestone-add");
  });

  it("shows a stale base as a conflict with a Reload, and any other refusal as the store's sentence", () => {
    const refusal = (message: string, code: string) => ({ message, code, blockers: [], retryable: false, fromServer: true });
    const conflict = renderToStaticMarkup(<WorkTree work={loaded({ failure: { kind: "conflict", refusal: refusal("STA-190 members are at revision 4, not 3. Re-read the milestone and retry.", "revision_conflict") } })} />);
    expect(conflict).toContain("data-milestone-conflict");
    expect(conflict).toContain('role="alert"');
    expect(conflict).toContain("Member order changed elsewhere.");
    expect(conflict).toContain("at revision 4, not 3");
    expect(conflict).toContain("Reload");
    // The touch floor is lifted: Reload is the small text button, never a 44px box.
    expect(conflict).toMatch(/<button[^>]*\bmin-h-0\b[^>]*data-milestone-reload/);
    expect(conflict).not.toContain("data-guard-refusal");
    const refused = renderToStaticMarkup(<WorkTree work={loaded({ failure: { kind: "refusal", refusal: refusal("STA-66 is an epic, not a milestone", "validation") } })} />);
    expect(refused).toContain("data-guard-refusal");
    expect(refused).toContain("STA-66 is an epic, not a milestone");
    expect(refused).not.toContain("data-milestone-conflict");
  });

  it("shows a failed read with Retry in that section, and Loading while it reads", () => {
    const failed = body(work(null, { error: new Error("The server is not answering") }), rowOf(data));
    expect(failed).toContain("data-milestone-read-error");
    expect(failed).toContain("The server is not answering");
    expect(failed).toContain("data-milestone-retry");
    expect(body(work(null), rowOf(data))).toContain("data-milestone-loading");
  });

  it("gives the work list the Tasks list's keyboard: arrows move, Enter and Space open, left and right fold", () => {
    const rows = loaded().members;
    const key = (k: string, i: number, over: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) => memberRowKey({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...over }, rows, i);
    expect(key("ArrowDown", 0)).toEqual({ type: "focus", index: 1 });
    expect(key("ArrowDown", 2)).toEqual({ type: "focus", index: 2 });
    expect(key("ArrowUp", 0)).toEqual({ type: "focus", index: 0 });
    expect(key("End", 0)).toEqual({ type: "focus", index: 2 });
    expect(key("Enter", 2)).toEqual({ type: "open" });
    expect(key(" ", 1)).toEqual({ type: "open" });
    expect(key("ArrowLeft", 1)).toEqual({ type: "toggle" });
    expect(key("ArrowRight", 1)).toBeNull();
    expect(key("ArrowLeft", 0)).toBeNull();
    expect(key("ArrowUp", 1, { altKey: true })).toBeNull();
    expect(key("Enter", 1, { metaKey: true })).toBeNull();
  });
});

describe("control sizes", () => {
  it("draws no 44px box anywhere: small controls keep their look and grow an invisible tap", () => {
    const pages = [
      section(rowOf(data), loaded()),
      section(rowOf(data), loaded(), { narrow: true }),
      section(rowOf(data), loaded({ members: [], hiddenDone: 2 })),
      inSession(<AddWork busy={false} exampleRef={null} onAdd={noop} defaultOpen />),
    ];
    // (The sticky first line under 760px is 44px high: a line, not a control.)
    for (const html of pages) expect(html.replaceAll("@max-[760px]/ms:h-11", "")).not.toMatch(/size-11|min-h-11|\bh-11\b|size-9\b/);
    const html = pages[0]!;
    // The fold chevron: 20px, a 32px tap under 760px.
    expect(html).toMatch(/class="[^"]*size-5[^"]*@max-\[760px\]\/ms:before:-inset-1\.5[^"]*"[^>]*aria-label="Hide October cut"|aria-label="Hide October cut"[^>]*class="[^"]*size-5[^"]*@max-\[760px\]\/ms:before:-inset-1\.5/);
    // The header's `⋯` and every work row's: 28px, a 36px tap, and the touch floor lifted.
    expect(html).toMatch(/class="[^"]*min-h-0[^"]*"[^>]*aria-label="October cut options"/);
    expect(html).toMatch(/class="[^"]*min-h-0[^"]*"[^>]*aria-label="Actions for STA-146"/);
    expect(html).toMatch(/class="[^"]*size-7[^"]*before:-inset-1[^"]*"[^>]*aria-label="October cut options"/);
    expect(html).toMatch(/class="[^"]*size-7[^"]*before:-inset-1[^"]*"[^>]*aria-label="Actions for STA-146"/);
    // Text buttons: 28px.
    expect(html).toMatch(/class="[^"]*\bh-7\b[^"]*"[^>]*data-milestone-add-open/);
    expect(pages[2]).toMatch(/class="[^"]*\bh-7\b[^"]*"[^>]*data-show-done/);
  });
});

describe("the outline", () => {
  const open1 = listRow({ milestone: { id: "m1", identifier: "STA-1", title: "First", planPosition: 1, state: "active" } });
  const open2 = listRow({ milestone: { id: "m2", identifier: "STA-2", title: "Second", state: "planned" } });
  const done = listRow({ milestone: { id: "m3", identifier: "STA-3", title: "Shipped", state: "done", status: "done", targetDate: null, closedAt: "2026-08-01T12:00:00.000Z" }, progress: progress({ counts: { done: 9 } }) });
  const cancelled = listRow({ milestone: { id: "m4", identifier: "STA-4", title: "Dropped", state: "cancelled", status: "cancelled", targetDate: null, closedAt: "2026-08-20T12:00:00.000Z" } });
  const outline = (rows: MilestoneListRow[], over: Partial<StapleSession> = {}) =>
    inSession(<MilestonesOutline workspace="staple" rows={rows} effective={[]} queueRevision={3} onAuthError={noop} />, over);

  it("draws one section per open milestone in order, then the Finished shelf folded, its newest closed first", () => {
    const html = outline([open1, open2, done, cancelled]);
    const order = [...html.matchAll(/data-milestone-section="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(["STA-1", "STA-2"]);
    expect(html).toMatch(/aria-expanded="false"[^>]*data-milestones-shelf/);
    expect(text(html)).toContain("Finished 2 · show");
    expect(outlineGroups([open1, done, cancelled]).finished.map((r) => r.milestone.identifier)).toEqual(["STA-4", "STA-3"]);
    expect(text(html)).toContain("2 open · 2 finished");
  });

  it("opens the shelf as remembered, each finished milestone one line with its words", () => {
    const html = atWidth(1440, { [milestonesMemoryKey("staple")]: JSON.stringify({ folded: {}, finished: true }) }, () => outline([open1, done, cancelled]));
    expect(html).toMatch(/aria-expanded="true"[^>]*data-milestones-shelf/);
    expect(html).toContain('data-milestone-finished-line="STA-3"');
    expect(text(html)).toContain("All 9 tasks are finished.");
    // The day it closed (with its year once that is not this one).
    expect(text(html)).toMatch(/Finished 1 Aug( 2026)? /);
    expect(text(html)).toMatch(/Closed 20 Aug( 2026)? /);
    expect(html).toContain('data-milestone-glyph="cancelled"');
  });

  it("unfolds sections from 760px and folds them under it when nothing is remembered, and a remembered fold wins", () => {
    const desk = atWidth(1440, {}, () => outline([open1, open2]));
    expect(desk).not.toContain("data-milestone-folded");
    expect(desk).toContain('data-milestones-fold-all="collapse"');
    expect(text(desk)).toContain("Collapse all");
    const phone = atWidth(390, {}, () => outline([open1, open2]));
    expect(phone.match(/data-milestone-folded/g)).toHaveLength(2);
    const remembered = atWidth(1440, { [milestonesMemoryKey("staple")]: JSON.stringify({ folded: { m1: true }, finished: false }) }, () => outline([open1, open2]));
    expect(remembered).toMatch(/data-milestone-section="STA-1" data-milestone-folded=""/);
    expect(remembered).not.toMatch(/data-milestone-section="STA-2" data-milestone-folded=""/);
    const allFolded = atWidth(1440, { [milestonesMemoryKey("staple")]: JSON.stringify({ folded: { m1: true, m2: true }, finished: false }) }, () => outline([open1, open2]));
    expect(text(allFolded)).toContain("Expand all");
  });

  it("says when nothing is open, keeps the shelf, and disables Collapse all", () => {
    const html = outline([done]);
    expect(html).toContain("data-milestones-none-open");
    expect(text(html)).toContain("No open milestones");
    expect(html).toContain("data-milestones-shelf");
    expect(html).toMatch(/disabled=""[^>]*data-milestones-fold-all/);
  });

  it("offers a new milestone when there are none at all", () => {
    const html = outline([]);
    expect(html).toContain('data-milestones-empty="none"');
    expect(html).toContain("data-create-milestone");
    expect(html).not.toContain("staple milestone");
  });

  it("says a focus the list does not carry is not in it, with a way to open it", () => {
    const html = outline([open1], { milestoneFocus: "STA-999" });
    expect(html).toContain('data-milestone-missing="STA-999"');
    expect(text(html)).toContain("STA-999 is not in this list. Open it");
  });

  it("lands a focus on an open section, a finished line, or says it is missing", () => {
    const groups = outlineGroups([open1, done]);
    expect(landingOf("STA-1", groups)).toEqual({ kind: "open", identifier: "STA-1" });
    expect(landingOf("STA-3", groups)).toEqual({ kind: "finished", identifier: "STA-3" });
    expect(landingOf("STA-9", groups)).toEqual({ kind: "missing", identifier: "STA-9" });
    expect(landingOf(null, groups)).toBeNull();
  });
});
