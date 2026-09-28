/**
 * The milestone's due control and the Milestones page's list states, as markup: what the due
 * date says and what its calendar offers, a finished milestone as a read-only record, and the
 * two empty lists (all finished, and none at all).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import { fakeSession } from "@/views/fake-session";
import { listRow, member, progress, view } from "./fixtures";
import { memberListRows } from "./milestones-model";
import { MilestoneDueControl } from "./MilestoneDue";
import { MilestoneDetailPane, MilestoneListPane, visibleMilestones } from "./MilestonesView";
import { projectedDue } from "./milestone-plain";

const NOW = new Date(2026, 8, 27, 15, 30);
const noop = () => {};
const PACE = { remainingSeconds: 8 * 3600, partial: false, unplannedRefs: [] };

function due(props: Partial<Parameters<typeof MilestoneDueControl>[0]>): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <MilestoneDueControl milestone={{ targetDate: null, state: "active" }} projection={null} now={NOW} {...props} />
    </SessionContext.Provider>,
  );
}

describe("the due control", () => {
  it("shows the projection as an estimate, with a calendar that sets the milestone's own date", () => {
    const html = due({ projection: projectedDue(PACE, NOW), onSetTarget: async () => true });
    expect(html).toMatch(/data-due-source="estimate"[^>]*>Due ~27 Sept? \(estimated\)</);
    expect(html).toContain('title="Estimated from 8h of work left, counted from now. Set a date to override it."');
    expect(html).toContain('aria-label="Set a due date"');
  });

  it("names a set target and offers to change it", () => {
    const html = due({ milestone: { targetDate: "2026-10-09", state: "active" }, projection: projectedDue(PACE, NOW), onSetTarget: async () => true });
    expect(html).toMatch(/data-due-source="target"[^>]*>Due 9 Oct, in 12 days</);
    expect(html).toContain('aria-label="Change the due date"');
  });

  it("has no calendar on a finished milestone, and says when it finished", () => {
    const html = due({ milestone: { targetDate: null, state: "done" }, completedAt: "2026-09-26T12:00:00.000Z", editable: false, onSetTarget: async () => true });
    expect(html).toMatch(/>Finished 26 Sept?</);
    expect(html).not.toContain("data-milestone-due-button");
  });
});

describe("finished milestones on the Milestones page", () => {
  const open = listRow({ milestone: { identifier: "STA-1", state: "active" } });
  const done = listRow({ milestone: { identifier: "STA-2", state: "done", status: "done" }, progress: progress({ counts: { done: 3 } }) });
  const cancelled = listRow({ milestone: { identifier: "STA-3", state: "cancelled", status: "cancelled" } });

  it("follows the Done toggle: finished ones listed when Done is shown, counted when hidden", () => {
    expect(visibleMilestones([open, done, cancelled], false)).toMatchObject({ rows: [open], hiddenFinished: 2 });
    expect(visibleMilestones([open, done, cancelled], true)).toMatchObject({ rows: [open, done, cancelled], hiddenFinished: 0 });
  });

  it("marks a finished milestone in the list with its Done status", () => {
    const html = renderToStaticMarkup(<MilestoneListPane rows={[done]} selectedRef={null} onSelect={noop} desk />);
    expect(html).toMatch(/data-milestone-row="STA-2" data-milestone-finished=""/);
    expect(html).toMatch(/data-milestone-status="done"[^>]*>.*?Done<\/span>/);
    expect(html).toContain("All 3 tasks are finished.");
  });

  it("says so, and offers them, when every milestone is finished and Done is hidden", () => {
    for (const desk of [true, false]) {
      const html = renderToStaticMarkup(<MilestoneListPane rows={[]} hiddenFinished={2} onShowFinished={noop} selectedRef={null} onSelect={noop} desk={desk} />);
      expect(html).toContain('data-milestone-empty="finished-hidden"');
      expect(html).toContain("All 2 milestones are finished and hidden while Done is hidden.");
      expect(html).toContain("Show finished milestones");
    }
  });

  it("points to how to make one when there are none at all", () => {
    const html = renderToStaticMarkup(<MilestoneListPane rows={[]} selectedRef={null} onSelect={noop} desk />);
    expect(html).toContain('data-milestone-empty="none"');
    expect(html).toContain("Create one with New task and the Milestone kind");
    expect(html).toContain("data-create-milestone");
  });

  it("shows a finished milestone's page read-only: its members, and no add, move or remove", () => {
    const finished = view({
      milestone: { identifier: "STA-2", state: "done", status: "done", targetDate: null },
      progress: progress({ counts: { done: 3 } }),
      members: [member({ identifier: "STA-10", status: "done" })],
    });
    const html = renderToStaticMarkup(
      <MilestoneDetailPane
        view={finished}
        members={memberListRows(finished, [], "staple")}
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
        due={{ busy: false, error: null, onSetTarget: async () => true }}
        desk
      />,
    );
    expect(html).toContain("All 3 tasks are finished.");
    expect(html).toContain('data-milestone-member="STA-10"');
    expect(html).toContain('aria-label="Open STA-10"');
    expect(html).not.toContain("Move STA-10 up");
    expect(html).not.toContain("Remove STA-10 from this milestone");
    expect(html).not.toContain("data-milestone-add");
    expect(html).not.toContain("data-milestone-due-button");
    expect(html).toMatch(/data-milestone-target=""[^>]*>Finished</);
  });
});
