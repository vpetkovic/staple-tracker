/**
 * A plain milestone, and any milestone with planning off, has no Plan line: the server sends no
 * `horizonPlan` then, and the section draws its goal and its work only, with or without the
 * milestone's detail read.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { detail, issue } from "@/detail/detail-fixture";
import { useIssueActions } from "@/detail/IssueActions";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { listRow, member, progress, view, work } from "./fixtures";
import { SectionView } from "./MilestoneSection";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};
const data = view({ milestone: { id: "id-LAR-190", identifier: "LAR-190", title: "October cut" }, progress: progress({ counts: { done: 2, ready: 1 } }), members: [member({ identifier: "LAR-67" }), member({ identifier: "LAR-68", status: "done" })] });

function Page({ withDetail, narrow }: { withDetail: IssueDetail | null; narrow: boolean }) {
  const controller = useIssueActions(noop);
  return (
    <SectionView
      row={listRow({ milestone: data.milestone, progress: data.progress })}
      work={work(data, { now: NOW, decision: withDetail ? { detail: withDetail, controller } : null })}
      workspace="staple"
      effective={[]}
      folded={false}
      onFold={noop}
      narrow={narrow}
      queue={{ busy: false, refusal: null, onDismiss: noop }}
    />
  );
}

const render = (withDetail: IssueDetail | null, narrow: boolean) =>
  renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession({ ws: "staple" })}>
      <Page withDetail={withDetail} narrow={narrow} />
    </SessionContext.Provider>,
  );

// Planning off, or a plain milestone: the detail the server sends has no `horizonPlan`.
const plain = detail({ issue: issue({ id: "id-LAR-190", identifier: "LAR-190", kind: "milestone", title: "October cut" }) });

describe("the Milestones outline without a horizon's plan", () => {
  for (const narrow of [false, true]) {
    it(`draws a plain milestone's goal and work and no Plan line, ${narrow ? "under" : "from"} 760px`, () => {
      for (const html of [render(null, narrow), render(plain, narrow)]) {
        expect(html).toContain("data-milestone-goal-line");
        expect(html).toContain('data-milestone-member="LAR-67"');
        expect(html).not.toContain("data-milestone-plan-line");
        expect(html).not.toContain("data-horizon-plan-tree");
        expect(html).not.toContain("Open in Plan");
      }
    });
  }
});
