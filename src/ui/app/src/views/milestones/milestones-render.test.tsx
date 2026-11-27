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
import { AddWorkForm, goalStartsOpen, MilestoneGlyph, StatusSubmenu } from "./milestone-parts";
import { milestonesMemoryKey } from "./milestones-memory";
import { landingOf, MilestonesOutline, outlineGroups } from "./MilestonesOutline";
import { openInPlan, SectionBody, SectionMenuItems, sectionAddable, SectionView, type SectionQueue } from "./MilestoneSection";
import type { MilestoneWork } from "./useMilestoneWork";
import { memberListRows } from "./milestones-model";
import { MemberMenuItems, memberMenuMove, memberRowKey, movedAnnouncement, WorkTree } from "./WorkTree";

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
  /** One row's own markup, from its opening tag to the next row's. */
  const rowOf_ = (html: string, identifier: string) => {
    const at = html.indexOf(`data-member-row="${identifier}"`);
    const start = html.lastIndexOf("<div", at);
    const next = html.indexOf('role="row"', at + 1);
    return html.slice(start, next === -1 ? undefined : next);
  };

  it("heads the work with Plan's strip and draws each member in Plan's outline grammar, an epic's children under it", () => {
    const html = body(loaded());
    // The strip: the work's own name with its count beside it, then the columns from 760px.
    expect(text(html)).toContain("Work, in order · 2 items Progress Now Updated");
    expect(html).toMatch(/<div role="treegrid" aria-label="Work in October cut"/);
    expect(html).toContain("@container/tree");
    expect(html).toMatch(/role="row" aria-level="1" aria-expanded="true"[^>]*data-member-row="STA-66"/);
    expect(html).toMatch(/role="row" aria-level="2"[^>]*data-member-row="STA-67"/);
    // No task list row inside: the row is the outline's own.
    expect(html).not.toContain('data-testid="task-row"');
    expect(html.match(/data-member-role="member"/g)).toHaveLength(2);
    expect(html.match(/data-member-role="child"/g)).toHaveLength(1);
    // A child's depth is one Plan guide in front of its chevron.
    expect(rowOf_(html, "STA-67").match(/data-work-guide=""/g)).toHaveLength(1);
    expect(rowOf_(html, "STA-66")).not.toContain("data-work-guide");
    expect(html).toContain('aria-label="Collapse STA-66"');
  });

  it("starts every row with its chevron, its status glyph and its title, with no position number, priority or kind glyph before them", () => {
    const html = body(loaded());
    for (const identifier of ["STA-146", "STA-66", "STA-67"]) {
      const line = rowOf_(html, identifier);
      const cell = line.slice(line.indexOf("data-work-cell"));
      const chevron = cell.search(/data-work-chevron|data-work-chevron-spacer/);
      const glyph = cell.indexOf('role="img" aria-label="Status:');
      const title = cell.indexOf("data-work-title");
      expect(chevron, identifier).toBeGreaterThan(-1);
      expect(glyph, identifier).toBeGreaterThan(chevron);
      expect(title, identifier).toBeGreaterThan(glyph);
      expect(cell.slice(0, title), identifier).not.toMatch(/staple-row-priority|data-kind-glyph|data-member-position/);
    }
    expect(html).not.toContain("data-member-position");
    // A direct member's title is the strong one, as Plan's depth-0 rows.
    expect(rowOf_(html, "STA-66")).toMatch(/data-work-title=""[^>]*font-medium|font-medium[^"]*"[^>]*data-work-title/);
    expect(rowOf_(html, "STA-67")).not.toMatch(/font-medium[^"]*"[^>]*data-work-title/);
  });

  it("says the identifier, a kind that is not a task or an epic in a word, and the note on the member's own line", () => {
    const bug = view({ ...data, members: [member({ identifier: "STA-9", kind: "bug", note: "found in the October run, see the log" }), ...data.members] });
    const html = body(work(bug, { issues, now: NOW }));
    const line = rowOf_(html, "STA-9");
    expect(line).toMatch(/data-work-id=""[^>]*>STA-9</);
    expect(line).toMatch(/data-work-kind=""[^>]*>bug</);
    // The note: one quiet truncated line, the whole of it in its title, inside the row.
    expect(line).toMatch(/data-member-note=""[^>]*title="found in the October run, see the log"|title="found in the October run, see the log"[^>]*data-member-note=""/);
    expect(line).toMatch(/class="[^"]*truncate[^"]*"[^>]*data-member-note|data-member-note=""[^>]*class="[^"]*truncate/);
    // An epic and a task say no kind word.
    expect(rowOf_(html, "STA-66")).not.toContain("data-work-kind");
    expect(rowOf_(html, "STA-146")).not.toContain("data-work-kind");
    // Nothing under a member: every row is one row.
    expect(html.match(/role="row"/g)).toHaveLength(4);
  });

  it("says where a row stands: a parent's rollup, a leaf's status in words, then what stands in the way", () => {
    const blocked = { ...row(), issue: issue({ id: "s1", identifier: "STA-146", title: "Flake", status: "awaiting_approval" }), deps: { blockedBy: ["STA-1", "STA-2"], blocks: ["STA-3"] } };
    const html = body(work(data, { issues: [...issues, blocked], now: NOW }));
    expect(rowOf_(html, "STA-66")).toContain('data-testid="parent-rollup"');
    expect(rowOf_(html, "STA-146")).toMatch(/data-work-state="awaiting_approval"[^>]*>Awaiting Approval</);
    const now = rowOf_(html, "STA-146").slice(rowOf_(html, "STA-146").indexOf("data-work-now"));
    const order = ["Blocked by 2", "waiting for approval", "Blocks 1"].map((words) => now.indexOf(words));
    expect(order.every((at) => at > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(now).toContain("data-desk-cues");
  });

  it("draws no hover arrows: the moves are in the row's menu", () => {
    const html = body(loaded());
    expect(html).not.toMatch(/aria-label="Move STA-\d+ (up|down)"/);
    expect(html).toContain('data-member-actions="STA-146"');
    expect(html).toContain('data-member-actions="STA-66"');
    expect(html).toContain('aria-label="Actions for STA-67"');
    // The rows rove: one of them takes Tab, the arrows move between them.
    expect(html.match(/role="row"[^>]*tabindex="0"/g)).toHaveLength(1);
  });

  it("puts each member's place in the order on its row for assistive technology, also when Done hides an earlier one", () => {
    const html = body(loaded());
    expect(rowOf_(html, "STA-146")).toMatch(/aria-posinset="1" aria-setsize="2"/);
    expect(rowOf_(html, "STA-66")).toMatch(/aria-posinset="2" aria-setsize="2"/);
    expect(rowOf_(html, "STA-67")).not.toContain("aria-posinset");
    const three = view({ members: [member({ identifier: "STA-1", status: "done", position: 1 }), member({ identifier: "STA-2", position: 2 }), member({ identifier: "STA-3", position: 3 })] });
    const hidden = body(work(three, { now: NOW, members: work(three).members.slice(1), hiddenDone: 1 }));
    expect(rowOf_(hidden, "STA-2")).toMatch(/aria-posinset="2" aria-setsize="3"/);
    expect(hidden).toContain('data-hidden-done="1"');
  });

  it("opens the row's menu on its place in the order, then the moves to the top and the bottom", () => {
    const menu = (index: number, over: Partial<Parameters<typeof MemberMenuItems>[0]> = {}) =>
      inSession(
        <Menu.Root open>
          <Menu.Content forceMount>
            <MemberMenuItems target={{ identifier: "STA-66", memberIndex: index }} identifier="STA-66" count={3} busy={false} onOpen={noop} onMove={noop} onRemove={noop} {...over} />
          </Menu.Content>
        </Menu.Root>,
      );
    const middle = menu(1);
    expect(middle).toMatch(/data-member-place=""[^>]*>2 of 3 in the order</);
    expect(middle).not.toMatch(/role="menuitem"[^>]*data-member-place/);
    const items = [...middle.matchAll(/data-menu-item="([a-z]+)"/g)].map((match) => match[1]);
    expect(items).toEqual(["open", "up", "down", "top", "bottom", "remove"]);
    expect(middle.indexOf("data-member-place")).toBeLessThan(middle.indexOf('data-menu-item="open"'));
    const first = menu(0);
    for (const edge of ["up", "top"]) expect(first).toMatch(new RegExp(`data-disabled=""[^>]*data-menu-item="${edge}"|data-menu-item="${edge}"[^>]*data-disabled=""`));
    expect(first).not.toMatch(/data-menu-item="bottom"[^>]*data-disabled=""|data-disabled=""[^>]*data-menu-item="bottom"/);
    const last = menu(2);
    for (const edge of ["down", "bottom"]) expect(last).toMatch(new RegExp(`data-disabled=""[^>]*data-menu-item="${edge}"|data-menu-item="${edge}"[^>]*data-disabled=""`));
    // A row lifted into a hidden member's place names the member it moves.
    expect(menu(1, { identifier: "STA-67" })).toMatch(/data-member-place=""[^>]*>STA-66 is 2 of 3 in the order</);
    // A child is context: it opens, and nothing would rewrite an order.
    const child = menu(1, { target: null, identifier: "STA-67" });
    expect([...child.matchAll(/data-menu-item="([a-z]+)"/g)].map((match) => match[1])).toEqual(["open"]);
    expect(child).not.toContain("data-member-place");
  });

  it("moves to the top and the bottom with the same reorder write", () => {
    const moves: [number, number][] = [];
    const onMove = (from: number, to: number) => moves.push([from, to]);
    for (const item of ["top", "bottom", "up", "down"] as const) memberMenuMove(item, 1, 3, onMove);
    expect(moves).toEqual([
      [1, 0],
      [1, 2],
      [1, 0],
      [1, 2],
    ]);
    expect(movedAnnouncement(1, 3)).toBe("Moved to 2 of 3");
  });

  it("flags the member that holds the milestone's next ticket, and the ticket itself once its parent is unfolded", () => {
    const next = view({ ...data, next: { identifier: "STA-67", position: 4 } });
    const folded = work(next, { issues, now: NOW, members: memberListRows(next, issues, "staple", { collapsed: new Set(["STA-66"]) }) });
    const foldedHtml = inSession(<SectionBody work={folded} workspace="staple" row={rowOf(next)} />, { issues: { data: issues, error: undefined, loading: false, reload: noop } });
    expect(rowOf_(foldedHtml, "STA-66")).toMatch(/data-work-next=""[^>]*>next up</);
    expect(rowOf_(foldedHtml, "STA-146")).not.toContain("data-work-next");
    const open = body(work(next, { issues, now: NOW }));
    expect(rowOf_(open, "STA-66")).toContain("data-work-next");
    expect(rowOf_(open, "STA-67")).toMatch(/data-work-next=""[^>]*>next up</);
    expect(open).toMatch(/data-plan-flag="you"[^>]*data-work-next|data-work-next=""[^>]*data-plan-flag="you"/);
    expect(body(loaded())).not.toContain("data-work-next");
  });

  it("gathers the finished rows Done hides into one line at the end, as Plan gathers shipped work", () => {
    const html = body(loaded({ hiddenDone: 9 }));
    const line = html.slice(html.indexOf("data-hidden-done"));
    expect(html).toMatch(/role="row"[^>]*data-hidden-done="9"/);
    expect(line).toContain("data-shipped-check");
    expect(text(line)).toContain("9 finished hidden · show");
    expect(html.indexOf("data-hidden-done")).toBeGreaterThan(html.lastIndexOf("data-member-row"));
  });

  it("says the members are finished, and offers them, when Done hides every one", () => {
    const html = body(loaded({ members: [], hiddenDone: 3 }));
    expect(html).toContain('data-hidden-all=""');
    expect(html).toContain("3 finished items hidden");
    expect(html).toContain("Show done");
    expect(html).not.toContain("Nothing is in this milestone yet");
  });

  it("offers Add work in the header, not as a line under the work", () => {
    const html = section(rowOf(data), loaded());
    expect(html).not.toContain("data-milestone-add-line");
    const header = html.slice(0, html.indexOf("</header>"));
    expect(header).toMatch(/data-milestone-add-open="STA-190"/);
    // Left of Queue, the lens's 28px outline button.
    expect(header.indexOf("data-milestone-add-open")).toBeLessThan(header.indexOf("data-milestone-queue"));
    expect(header).toMatch(/class="[^"]*\bh-7\b[^"]*min-h-0[^"]*"[^>]*data-milestone-add-open/);
    // Folded, it is still there: adding does not need the section unfolded.
    expect(section(rowOf(data), work(null, { now: NOW }), { folded: true })).toContain("data-milestone-add-open");
    const open = inSession(<AddWorkForm busy={false} ready exampleRef="STA-12" failure={null} onAdd={noop} />);
    expect(open).toContain('aria-label="Identifier to add"');
    expect(open).toContain('placeholder="Task or epic, like STA-12"');
    expect(open).toContain('aria-label="Note for the new member"');
    expect(open).toMatch(/type="submit"[^>]*>Add</);
  });

  it("keeps the add field's text while the write is in flight, and says a refusal in the field's own popover", () => {
    const busy = inSession(<AddWorkForm busy ready exampleRef={null} failure={null} onAdd={noop} />);
    expect(busy).toMatch(/aria-label="Identifier to add"[^>]*readOnly=""/i);
    expect(busy).not.toMatch(/aria-label="Identifier to add"[^>]*disabled=""/);
    const refused = inSession(<AddWorkForm busy={false} ready exampleRef={null} failure={{ kind: "refusal", refusal: { message: "STA-9 is not in this workspace", code: "not_found", blockers: [], retryable: false, fromServer: true } }} onAdd={noop} />);
    expect(refused).toMatch(/role="alert"[^>]*>STA-9 is not in this workspace</);
    // Before the milestone is read, Add waits for it.
    expect(inSession(<AddWorkForm busy={false} ready={false} exampleRef={null} failure={null} onAdd={noop} />)).toMatch(/type="submit"[^>]*disabled=""/);
  });

  it("puts Add work in the section's menu under 760px", () => {
    const items = (over: Partial<Parameters<typeof SectionMenuItems>[0]>) =>
      inSession(
        <Menu.Root open>
          <Menu.Content forceMount>
            <SectionMenuItems status="in_progress" decision={null} folded={false} queued={false} queue={idle} addable={false} onOpenDetails={noop} onChangeDue={noop} onRequestApproval={noop} onAddWork={noop} onFold={noop} {...over} />
          </Menu.Content>
        </Menu.Root>,
      );
    expect(items({ addable: true })).toContain('data-menu-item="add"');
    expect(items({ addable: false })).not.toContain('data-menu-item="add"');
    // Only a phone's open milestone: the desk has the header's button, a finished one offers none.
    expect(sectionAddable({ narrow: true, finished: false })).toBe(true);
    expect(sectionAddable({ narrow: false, finished: false })).toBe(false);
    expect(sectionAddable({ narrow: true, finished: true })).toBe(false);
  });

  it("shows a finished milestone's work read-only: Open only, no moves and no Add work", () => {
    const finished = view({ milestone: { state: "done", status: "done" }, members: [member({ identifier: "STA-10", status: "done" })] });
    const html = body(work(finished, { now: NOW }));
    expect(html).toContain('data-milestone-member="STA-10"');
    expect(html).toContain('aria-label="Actions for STA-10"');
    expect(html).not.toContain("data-milestone-add");
    expect(rowOf_(html, "STA-10")).not.toContain("aria-posinset");
  });

  it("shows a stale base as a conflict with a Reload, and any other refusal as the store's sentence", () => {
    const refusal = (message: string, code: string) => ({ message, code, blockers: [], retryable: false, fromServer: true });
    const conflict = inSession(<WorkTree work={loaded({ failure: { kind: "conflict", refusal: refusal("STA-190 members are at revision 4, not 3. Re-read the milestone and retry.", "revision_conflict") } })} />);
    expect(conflict).toContain("data-milestone-conflict");
    expect(conflict).toContain('role="alert"');
    expect(conflict).toContain("Member order changed elsewhere.");
    expect(conflict).toContain("at revision 4, not 3");
    expect(conflict).toContain("Reload");
    // The touch floor is lifted: Reload is the small text button, never a 44px box.
    expect(conflict).toMatch(/<button[^>]*\bmin-h-0\b[^>]*data-milestone-reload/);
    expect(conflict).not.toContain("data-guard-refusal");
    const refused = inSession(<WorkTree work={loaded({ failure: { kind: "refusal", refusal: refusal("STA-66 is an epic, not a milestone", "validation") } })} />);
    expect(refused).toContain("data-guard-refusal");
    expect(refused).toContain("STA-66 is an epic, not a milestone");
    expect(refused).not.toContain("data-milestone-conflict");
    // Folded, a write's failure still shows in its section.
    const folded = section(rowOf(data), loaded({ failure: { kind: "refusal", refusal: refusal("STA-9 is not in this workspace", "not_found") } }), { folded: true });
    expect(folded).toContain("STA-9 is not in this workspace");
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
      inSession(<AddWorkForm busy={false} ready exampleRef={null} failure={null} onAdd={noop} />),
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
