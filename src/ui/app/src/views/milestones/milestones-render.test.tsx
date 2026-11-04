/**
 * R3c (STA-173) — the Milestones view as markup: what the list says about each
 * milestone, what the detail draws for its members, how a failed write is shown, and
 * which panes exist at which layout. Rendered with `react-dom/server`, no DOM, the way
 * `components/task-list/row-render.test.tsx` does.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { issue, row } from "@/components/task-list/fixtures";
import { effective } from "@/views/queue/fixtures";
import { listRow, member, progress, view } from "./fixtures";
import { memberListRows } from "./milestones-model";
import { MilestoneDetailPane, MilestoneListPane, MilestonesLayout, memberRowKey, StateBadge } from "./MilestonesView";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};

function renderDetail(
  data = view(),
  over: Partial<Parameters<typeof MilestoneDetailPane>[0]> = {},
  issues = [] as ReturnType<typeof row>[],
): string {
  return renderToStaticMarkup(
    <MilestoneDetailPane
      view={data}
      members={memberListRows(data, issues, "staple")}
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
      {...over}
    />,
  );
}

describe("the milestone list", () => {
  it("shows target date, progress, state, risk and next work per row", () => {
    const html = renderToStaticMarkup(
      <MilestoneListPane
        rows={[
          listRow({
            // Its target passed on every calendar: overdue by the store and by the reader's day.
            milestone: { identifier: "STA-190", title: "October cut", targetDate: "2026-08-31", state: "overdue" },
            progress: progress({ counts: { done: 5, ready: 6 } }),
            memberCount: 3,
            next: { identifier: "STA-67", position: 4 },
          }),
          listRow({
            milestone: { identifier: "STA-191", title: "November", targetDate: null, state: "planned" },
            progress: progress({ counts: { ready: 1 } }),
            next: null,
          }),
        ]}
        effective={[
          effective({ identifier: "STA-68", milestonePath: ["STA-190"], eligibility: "blocked", status: "todo" }),
          effective({ identifier: "STA-69", milestonePath: ["STA-190"], eligibility: "gated", status: "todo" }),
          // November's own blocked row must not leak into October's line.
          effective({ identifier: "STA-70", milestonePath: ["STA-191"], eligibility: "blocked", status: "todo" }),
        ]}
        selectedRef="STA-190"
        onSelect={noop}
      />,
    );
    expect(html).toContain('data-milestone-row="STA-190"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("target 2026-08-31");
    expect(html).toContain("5/11 done · 45%");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="45"');
    expect(html).toContain("3 members");
    expect(html).toContain('data-milestone-state="overdue"');
    expect(html).toContain("! overdue");
    // The page's own sentence: what the bar calls blocked, and what each waits on.
    expect(html).toContain("⊘ 2 are blocked: 1 waits on other tasks, 1 on a person.");
    expect(html).toContain('data-milestone-next="queued"');
    expect(html).toContain("next: STA-67 (#4)");
    // The second row: nothing planned yet, and the queue has no answer. Its one blocked
    // row is counted against it and not against October's.
    expect(html).toContain("⊘ 1 is blocked, waiting on other tasks.");
    expect(html).toContain("target no date");
    expect(html).toContain('data-milestone-next="none"');
    expect(html).toContain("no eligible work");
  });

  it("is honest when there are no milestones", () => {
    const html = renderToStaticMarkup(<MilestoneListPane rows={[]} selectedRef={null} onSelect={noop} />);
    expect(html).toContain("No milestones here yet.");
    // Plain words: no command line for a reader who is not at one.
    expect(html).not.toContain("staple milestone");
    expect(html).not.toContain("data-milestone-list");
  });
});

describe("state badges", () => {
  it("differ by glyph AND word, so colour is never the only signal", () => {
    const rendered = (["planned", "active", "overdue", "done", "cancelled"] as const).map((state) =>
      renderToStaticMarkup(<StateBadge state={state} />),
    );
    expect(rendered[0]).toContain("○");
    expect(rendered[0]).toContain("Planned");
    expect(rendered[1]).toContain("◐");
    expect(rendered[1]).toContain("Active");
    expect(rendered[2]).toContain("!");
    expect(rendered[2]).toContain("Overdue");
    expect(rendered[3]).toContain("✓");
    expect(rendered[3]).toContain("Done");
    expect(rendered[4]).toContain("×");
    expect(rendered[4]).toContain("Cancelled");
    expect(new Set(rendered).size).toBe(5);
  });

  it("says when every member has landed but nobody closed the milestone", () => {
    expect(renderToStaticMarkup(<StateBadge state="active" complete />)).toContain("all members done");
    expect(renderToStaticMarkup(<StateBadge state="done" complete />)).not.toContain("all members done");
  });
});

describe("the milestone detail", () => {
  const epic = issue({ id: "e1", identifier: "STA-66", kind: "epic", title: "S epic", status: "in_progress" });
  const child = issue({ id: "c1", identifier: "STA-67", parentId: "e1", title: "S1", status: "blocked" });
  const issues = [epic, child].map((i) => ({ ...row(), issue: i }));
  const data = view({
    milestone: { identifier: "STA-190", title: "October cut", startDate: "2026-09-01", targetDate: "2026-10-31", assignee: "VP" },
    progress: progress({ counts: { done: 1, active: 1, ready: 1 } }),
    members: [
      member({ identifier: "STA-146", position: 1, note: "the flake, no epic" }),
      member({ identifier: "STA-66", kind: "epic", position: 2 }),
    ],
  });

  it("shows title, dates, owner, rollups and next work", () => {
    const html = renderDetail(
      data,
      { effective: [effective({ identifier: "STA-67", milestonePath: ["STA-190"], eligibility: "blocked", status: "todo" })] },
      issues,
    );
    expect(html).toContain('data-milestone-detail="STA-190"');
    expect(html).toContain("October cut");
    expect(html).toContain("start 2026-09-01");
    // The due date in words, from the target the person set: the page's one due control.
    expect(html).toMatch(/data-milestone-target=""[^>]*>Due 31 Oct, in 57 days</);
    expect(html).toContain("owner VP");
    expect(html).toContain("data-milestone-rollups");
    expect(html).toContain("1 of 3 tasks finished (33%).");
    // The grid counts the queue's one blocked row, not the status-category count — which is
    // zero here, as it is for real blocked work — and says it once.
    expect(html).toMatch(/Blocked, waiting on other tasks<\/dt><dd[^>]*>1<\/dd>/);
    expect(html).not.toContain("⊘");
    expect(html).toMatch(/Next up<\/dt><dd[^>]*>no eligible work<\/dd>/);
  });

  it("draws members with the shared row and an epic's children under it, read-only", () => {
    const html = renderDetail(data, {}, issues);
    // The shared row component, once per member and once per child — each an option in the
    // members treegrid, with the Tasks list's roles: a click, or Enter on the row, opens it.
    expect(html.match(/data-testid="task-row"/g)).toHaveLength(3);
    expect(html.match(/data-member-row=/g)).toHaveLength(3);
    expect(html).toMatch(/<ul role="treegrid" aria-label="Members of STA-190"/);
    // Level and state: the epic is level 1 and open, its child level 2; no option roles.
    expect(html).toMatch(/role="row" aria-level="1" aria-expanded="true"[^>]*data-member-row="STA-66"/);
    expect(html).toMatch(/role="row" aria-level="2"[^>]*data-member-row="STA-67"/);
    expect(html).not.toContain('role="option"');
    expect(html).not.toContain('role="listbox"');
    // The shared row is drawn bare inside the treegrid row, which owns the role, focus and click.
    expect(html).toContain("staple-row-bare");
    // The Tasks list's tree: a chevron on the epic, a connector on its child.
    expect(html).toContain('aria-label="Collapse STA-66"');
    expect(html).toContain("staple-guide-elbow");
    expect(html).toContain('data-milestone-member="STA-146"');
    expect(html).toContain('data-milestone-member="STA-66"');
    expect(html).toContain('data-milestone-member="STA-67"');
    expect(html.match(/data-member-role="member"/g)).toHaveLength(2);
    expect(html.match(/data-member-role="child"/g)).toHaveLength(1);
    // The note the member was added with.
    expect(html).toContain("the flake, no epic");
    // Members get the plan controls; the child gets only Open.
    expect(html).toContain('aria-label="Move STA-146 up"');
    expect(html).toContain('aria-label="Move STA-66 down"');
    expect(html).toContain('aria-label="Remove STA-66 from this milestone"');
    expect(html).toContain('aria-label="Open STA-67"');
    expect(html).not.toContain('aria-label="Move STA-67 up"');
    expect(html).not.toContain('aria-label="Remove STA-67 from this milestone"');
    // The child is indented one step deeper than its epic (ROW_PAD_LEFT 8 + INDENT_STEP 20).
    const epicAt = html.indexOf('data-identifier="STA-66"');
    const childAt = html.indexOf('data-identifier="STA-67"');
    expect(childAt).toBeGreaterThan(epicAt);
    expect(html.slice(childAt, childAt + 400)).toContain("padding-left:28px");
    // The kind and status glyphs come with the row.
    expect(html).toContain("Kind: Epic");
    expect(html).toContain("Status: Blocked");
  });

  it("on the desk, gives in-review work its own bucket and an aligned details grid with nothing said twice", () => {
    const reviewed = view({
      milestone: { identifier: "STA-190", status: "in_review" },
      progress: progress({ counts: { review: 9, blocked: 1, cancelled: 1 } }),
      members: [member({ identifier: "STA-66", kind: "epic" })],
    });
    const html = renderDetail(
      reviewed,
      {
        desk: true,
        effective: [
          effective({ identifier: "STA-67", milestonePath: ["STA-190"], eligibility: "blocked", status: "in_review" }),
          // Parked by hand for a person's decision: it waits on a person, not on another task.
          effective({ identifier: "STA-71", milestonePath: ["STA-190"], eligibility: "blocked", status: "blocked" }),
        ],
      },
      issues,
    );
    // The headline counts nine; the legend has an in-review bucket and puts all nine in it.
    expect(html).toContain("0 of 10 tasks finished (0%).");
    expect(html).toMatch(/data-legend="review"[^>]*>.*?<span class="staple-progress-count">9<\/span> in review/);
    expect(html).toMatch(/data-legend="active"[^>]*data-empty=""/);
    expect(html).toContain("1 is blocked, waiting on a person. 1 in review still waits on another task. 1 cancelled task is not counted.");
    // The status pill is the stored status, with the Tasks list's glyph and word.
    expect(html).toMatch(/data-milestone-status="in_review"[^>]*>.*?In Review<\/span>/);
    // One grid of label/value pairs, two pairs to a line; the old trailing risk line is gone.
    const grid = /<dl data-milestone-rollups[^>]*class="([^"]*)"/.exec(html)![1]!;
    expect(grid).toContain("min-[1280px]:grid-cols-[max-content_minmax(0,1fr)_max-content_minmax(0,1fr)]");
    // reference, counted, starts, waiting on tasks, target, waiting on a person, started-and-waiting, next
    expect(html.match(/<dt /g)).toHaveLength(8);
    expect(html).toMatch(/Started, still waiting on other tasks<\/dt><dd[^>]*>1<\/dd>/);
    expect(html).toMatch(/Blocked, waiting on a person<\/dt><dd[^>]*>1<\/dd>/);
    expect(html).toMatch(/Blocked, waiting on other tasks<\/dt><dd[^>]*>0<\/dd>/);
    expect(html).not.toContain("data-milestone-risk");
    expect(html).not.toContain("⊘");
  });

  it("keeps the open, move and remove buttons outside the clickable row, so they never also open it", () => {
    const html = renderDetail(data, {}, issues);
    const li = /<li role="none" data-milestone-member="STA-66"[\s\S]*?<\/li>/.exec(html)![0];
    const rowStart = li.indexOf('role="row"');
    const controlsStart = li.indexOf('<div role="gridcell" class="flex shrink-0 items-center">');
    expect(rowStart).toBeGreaterThan(-1);
    expect(controlsStart).toBeGreaterThan(rowStart);
    // Every control is after the row's own markup, i.e. a sibling of it, never inside it.
    for (const label of ["Open STA-66", "Move STA-66 up", "Move STA-66 down", "Remove STA-66 from this milestone"]) {
      expect(li.indexOf(`aria-label="${label}"`), label).toBeGreaterThan(controlsStart);
    }
    // The row is focusable as one tab stop: the first row, and only it, takes Tab.
    // The rows rove: one of them takes Tab, the arrows move between them.
    expect(html.match(/role="row"[^>]*tabindex="0"/g)).toHaveLength(1);
  });

  it("says the members are finished, and offers them, when Done hides every one", () => {
    const html = renderDetail(data, { members: [], hiddenDone: 3, onShowDone: noop, desk: true }, issues);
    expect(html).toContain('data-hidden-all=""');
    expect(html).toContain("3 finished items hidden");
    expect(html).toContain("Show done");
    expect(html).not.toContain("Nothing is in this milestone yet");
  });

  it("gives every control on the phone page a 44px target", () => {
    const html = renderDetail(data, {}, issues);
    expect(html).toMatch(/class="[^"]*max-md:size-11[^"]*"[^>]*aria-label="Open STA-146"/);
    // The header's own Open and the full-screen toggle, and the add form.
    expect(html).toMatch(/class="[^"]*max-md:size-11[^"]*"[^>]*aria-label="Open STA-190"/);
    expect(html).toMatch(/class="[^"]*max-md:size-11[^"]*"[^>]*aria-label="Expand to full screen"/);
    expect(html).toMatch(/class="[^"]*max-md:min-h-11[^"]*"[^>]*>Add member</);
    expect(html).toMatch(/<input[^>]*max-md:h-11[^>]*aria-label="Identifier to add"|aria-label="Identifier to add"[^>]*max-md:h-11/);
  });

  it("gives the member list the Tasks list's keyboard: arrows move, Enter and Space open, left and right fold", () => {
    const rows = memberListRows(data, issues, "staple");
    const key = (k: string, i: number, over: Partial<{ altKey: boolean; ctrlKey: boolean; metaKey: boolean }> = {}) =>
      memberRowKey({ key: k, altKey: false, ctrlKey: false, metaKey: false, ...over }, rows, i);
    expect(key("ArrowDown", 0)).toEqual({ type: "focus", index: 1 });
    expect(key("ArrowDown", 2)).toEqual({ type: "focus", index: 2 });
    expect(key("ArrowUp", 0)).toEqual({ type: "focus", index: 0 });
    expect(key("End", 0)).toEqual({ type: "focus", index: 2 });
    expect(key("Enter", 2)).toEqual({ type: "open" });
    expect(key(" ", 1)).toEqual({ type: "open" });
    // STA-66 (index 1) is an open epic: left folds it, right does nothing; a leaf ignores both.
    expect(key("ArrowLeft", 1)).toEqual({ type: "toggle" });
    expect(key("ArrowRight", 1)).toBeNull();
    expect(key("ArrowLeft", 0)).toBeNull();
    // alt+arrow is the reorder, the member row's own; the list stays out of its way.
    expect(key("ArrowUp", 1, { altKey: true })).toBeNull();
    expect(key("Enter", 1, { metaKey: true })).toBeNull();
  });

  it("disables the edge moves and everything while a write is in flight", () => {
    const idle = renderDetail(data, {}, issues);
    expect(idle).toMatch(/aria-label="Move STA-146 up"[^>]*disabled=""/);
    expect(idle).not.toMatch(/aria-label="Move STA-146 down"[^>]*disabled=""/);
    const busy = renderDetail(data, { busy: true }, issues);
    expect(busy).toMatch(/aria-label="Move STA-146 down"[^>]*disabled=""/);
    expect(busy).toMatch(/aria-label="Remove STA-66 from this milestone"[^>]*disabled=""/);
  });

  it("offers an add form with an identifier and an optional note", () => {
    const html = renderDetail();
    expect(html).toContain("data-milestone-add");
    expect(html).toContain('aria-label="Identifier to add"');
    expect(html).toContain('aria-label="Note for the new member"');
    expect(html).toContain("Add member");
    expect(html).toContain("no members yet");
  });

  it("shows a stale base as a conflict with a Reload, and any other refusal as the store's sentence", () => {
    const conflict = renderDetail(data, {
      failure: {
        kind: "conflict",
        refusal: {
          message: "STA-190 members are at revision 4, not 3. Re-read the milestone and retry.",
          code: "revision_conflict",
          blockers: [],
          retryable: false,
          fromServer: true,
        },
      },
    });
    expect(conflict).toContain("data-milestone-conflict");
    expect(conflict).toContain('role="alert"');
    expect(conflict).toContain("Member order changed elsewhere.");
    expect(conflict).toContain("at revision 4, not 3");
    expect(conflict).toContain("Reload");
    expect(conflict).not.toContain("data-guard-refusal");

    const refused = renderDetail(data, {
      failure: {
        kind: "refusal",
        refusal: { message: "STA-66 is an epic, not a milestone", code: "validation", blockers: [], retryable: false, fromServer: true },
      },
    });
    expect(refused).toContain("data-guard-refusal");
    expect(refused).toContain("STA-66 is an epic, not a milestone");
    expect(refused).not.toContain("data-milestone-conflict");
  });

  it("has a full-screen toggle that reports its state", () => {
    expect(renderDetail(data)).toContain('aria-label="Expand to full screen"');
    expect(renderDetail(data)).toContain('aria-pressed="false"');
    expect(renderDetail(data, { fullScreen: true })).toContain('aria-label="Collapse from full screen"');
    expect(renderDetail(data, { fullScreen: true })).toContain('aria-pressed="true"');
  });
});

describe("the layout", () => {
  const render = (layout: "stacked" | "split", fullScreen: boolean, hasSelection: boolean) =>
    renderToStaticMarkup(
      <MilestonesLayout
        layout={layout}
        fullScreen={fullScreen}
        hasSelection={hasSelection}
        list={<div data-test-list />}
        detail={<div data-test-detail />}
        onBack={noop}
      />,
    );

  it("stacks on a narrow viewport: the list alone, then the detail with a Back button", () => {
    const listOnly = render("stacked", false, false);
    expect(listOnly).toContain('data-milestones-layout="stacked"');
    expect(listOnly).toContain('data-milestones-pane="list"');
    expect(listOnly).not.toContain('data-milestones-pane="detail"');

    const detailOnly = render("stacked", false, true);
    expect(detailOnly).toContain('data-milestones-pane="detail"');
    expect(detailOnly).not.toContain('data-milestones-pane="list"');
    expect(detailOnly).toContain("Back to milestones");
  });

  it("splits on tablet and desktop: both panes, no Back button", () => {
    const split = render("split", false, true);
    expect(split).toContain('data-milestones-layout="split"');
    expect(split).toContain('data-milestones-pane="list"');
    expect(split).toContain('data-milestones-pane="detail"');
    expect(split).not.toContain("Back to milestones");
    expect(split).not.toContain("data-full-screen");
  });

  it("gives the detail the whole box in full screen, at any width", () => {
    for (const layout of ["stacked", "split"] as const) {
      const full = render(layout, true, true);
      expect(full).toContain('data-full-screen="true"');
      expect(full).toContain('data-milestones-pane="detail"');
      expect(full).not.toContain('data-milestones-pane="list"');
      expect(full).not.toContain("Back to milestones");
    }
  });
});
