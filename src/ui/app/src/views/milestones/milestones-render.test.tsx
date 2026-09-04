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
import { MilestoneDetailPane, MilestoneListPane, MilestonesLayout, StateBadge } from "./MilestonesView";

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
            milestone: { identifier: "STA-190", title: "October cut", targetDate: "2026-10-31", state: "overdue" },
            progress: progress({ counts: { done: 5, ready: 6 } }),
            memberCount: 3,
            next: { identifier: "STA-67", position: 4 },
          }),
          listRow({ milestone: { identifier: "STA-191", title: "November", targetDate: null, state: "planned" }, next: null }),
        ]}
        effective={[
          effective({ identifier: "STA-68", milestonePath: ["STA-190"], eligibility: "blocked" }),
          effective({ identifier: "STA-69", milestonePath: ["STA-190"], eligibility: "gated" }),
          // November's own blocked row must not leak into October's line.
          effective({ identifier: "STA-70", milestonePath: ["STA-191"], eligibility: "blocked" }),
        ]}
        selectedRef="STA-190"
        onSelect={noop}
      />,
    );
    expect(html).toContain('data-milestone-row="STA-190"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("target 2026-10-31");
    expect(html).toContain("5/11 done · 45%");
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="45"');
    expect(html).toContain("3 members");
    expect(html).toContain('data-milestone-state="overdue"');
    expect(html).toContain("! overdue");
    expect(html).toContain("⊘ 1 blocked");
    expect(html).toContain("◇ 1 gated");
    expect(html).toContain('data-milestone-next="queued"');
    expect(html).toContain("next: STA-67 (#4)");
    // The second row: nothing planned yet, and the queue has no answer. Its one blocked
    // row is counted against it and not against October's.
    expect(html.match(/⊘ 1 blocked/g)).toHaveLength(2);
    expect(html).toContain("target no date");
    expect(html).toContain('data-milestone-next="none"');
    expect(html).toContain("no eligible work");
  });

  it("is honest when there are no milestones", () => {
    const html = renderToStaticMarkup(<MilestoneListPane rows={[]} selectedRef={null} onSelect={noop} />);
    expect(html).toContain("no milestones yet");
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
      { effective: [effective({ identifier: "STA-67", milestonePath: ["STA-190"], eligibility: "blocked" })] },
      issues,
    );
    expect(html).toContain('data-milestone-detail="STA-190"');
    expect(html).toContain("October cut");
    expect(html).toContain("start 2026-09-01");
    expect(html).toContain("target 2026-10-31");
    expect(html).toContain("owner VP");
    expect(html).toContain("data-milestone-rollups");
    expect(html).toContain("1/3 done · 33%");
    // The rollup and the risk line both count the queue's one blocked row, not the
    // status-category count — which is zero here, as it is for real blocked work.
    expect(html).toContain("⊘ 1");
    expect(html).toContain("⊘ 1 blocked");
    expect(html).toContain("no eligible work");
  });

  it("draws members with the shared row and an epic's children indented, read-only", () => {
    const html = renderDetail(data, {}, issues);
    // The shared row component, once per member and once per child.
    expect(html.match(/class="staple-row staple-row-bare"/g)).toHaveLength(3);
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
