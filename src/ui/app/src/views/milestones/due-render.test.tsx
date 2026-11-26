/**
 * The milestone's due control and the Milestones outline's finished milestones, as markup: what
 * the due date says and what its calendar offers, a finished milestone as a read-only record on
 * the Finished shelf whatever the Done toggle says, and the two empty pages (nothing open, and
 * nothing at all).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import { fakeSession } from "@/views/fake-session";
import { emptyFilters } from "@/lib/filters";
import { listRow, member, progress, view, work } from "./fixtures";
import { MilestoneDueControl } from "./MilestoneDue";
import { MilestonesOutline } from "./MilestonesOutline";
import { SectionBody } from "./MilestoneSection";
import { projectedDue } from "./milestone-plain";

const NOW = new Date(2026, 8, 27, 15, 30);
const noop = () => {};
const LEFT = { estimated: 2, unestimated: 0, unknown: 0, estimateSeconds: 6 * 3600, forecastSeconds: 8 * 3600 };

function due(props: Partial<Parameters<typeof MilestoneDueControl>[0]>): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <MilestoneDueControl milestone={{ targetDate: null, state: "active" }} projection={null} now={NOW} {...props} />
    </SessionContext.Provider>,
  );
}

describe("the due control", () => {
  it("shows the projection as an estimate, with a calendar that sets the milestone's own date", () => {
    const html = due({ projection: projectedDue(LEFT, NOW), onSetTarget: async () => true });
    expect(html).toMatch(/data-due-source="estimate"[^>]*>Due ~27 Sept? \(estimated\)</);
    expect(html).toContain(
      'title="All open work: 6h estimated, ~8h by the forecast (estimates scaled by how long they have really taken; work in review counts as done), counted from now. Set a date to override it."',
    );
    expect(html).toContain('aria-label="Set a due date"');
  });

  it("names a set target and offers to change it", () => {
    const html = due({ milestone: { targetDate: "2026-10-09", state: "active" }, projection: projectedDue(LEFT, NOW), onSetTarget: async () => true });
    expect(html).toMatch(/data-due-source="target"[^>]*>Due 9 Oct, in 12 days</);
    expect(html).toContain('aria-label="Change the due date"');
  });

  it("has no calendar on a finished milestone, and says when it finished", () => {
    const html = due({ milestone: { targetDate: null, state: "done", closedAt: "2026-09-26T12:00:00.000Z" }, editable: false, onSetTarget: async () => true });
    expect(html).toMatch(/>Finished 26 Sept?</);
    expect(html).not.toContain("data-milestone-due-button");
  });
});

describe("finished milestones on the Milestones page", () => {
  const open = listRow({ milestone: { id: "m1", identifier: "STA-1", state: "active" } });
  const done = listRow({ milestone: { id: "m2", identifier: "STA-2", state: "done", status: "done", targetDate: null }, progress: progress({ counts: { done: 3 } }) });
  const cancelled = listRow({ milestone: { id: "m3", identifier: "STA-3", state: "cancelled", status: "cancelled" } });
  const hidden = { ...emptyFilters(), showDone: false };
  const outline = (rows: ReturnType<typeof listRow>[]) =>
    renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession({ filters: hidden })}>
        <MilestonesOutline workspace="staple" rows={rows} effective={[]} queueRevision={1} onAuthError={noop} />
      </SessionContext.Provider>,
    );

  it("keeps finished milestones on the Finished shelf whatever the Done toggle says", () => {
    const html = outline([open, done, cancelled]);
    expect(html).toContain('data-milestone-section="STA-1"');
    expect(html).toContain("data-milestones-shelf");
    expect(html.replace(/<[^>]*>/g, " ")).toMatch(/Finished\s+2\s+· show/);
    // On the shelf, not as open sections.
    expect(html).not.toContain('data-milestone-section="STA-2"');
  });

  it("says nothing is open, and keeps the shelf, when every milestone is finished", () => {
    const html = outline([done, cancelled]);
    expect(html).toContain("data-milestones-none-open");
    expect(html).toContain("No open milestones");
    expect(html).toContain("data-milestones-shelf");
  });

  it("points to how to make one when there are none at all", () => {
    const html = outline([]);
    expect(html).toContain('data-milestones-empty="none"');
    expect(html).toContain("A milestone gathers tasks that should be finished by a date.");
    expect(html).toContain("data-create-milestone");
  });

  it("shows a finished milestone's work read-only: its members, and no add, move or remove", () => {
    const finished = view({
      milestone: { identifier: "STA-2", state: "done", status: "done", targetDate: null },
      progress: progress({ counts: { done: 3 } }),
      members: [member({ identifier: "STA-10", status: "done" })],
    });
    const html = renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession()}>
        <SectionBody work={work(finished, { now: NOW })} workspace="staple" row={done} />
      </SessionContext.Provider>,
    );
    expect(html).toContain('data-milestone-member="STA-10"');
    expect(html).toContain('aria-label="Actions for STA-10"');
    expect(html).not.toContain("Move STA-10 up");
    expect(html).not.toContain("Remove STA-10 from this milestone");
    expect(html).not.toContain("data-milestone-add");
    expect(html).not.toContain("data-milestone-due-button");
  });
});
