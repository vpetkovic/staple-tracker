/**
 * The Milestones view of a plain milestone, and of any milestone with planning off, is what it
 * was before the plan's tree: the server sends no `horizonPlan` then, and the detail draws byte
 * for byte the markup the snapshot recorded from the code before the tree existed.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { detail, issue } from "@/detail/detail-fixture";
import { useIssueActions } from "@/detail/IssueActions";
import { SessionContext } from "@/lib/session";
import type { IssueDetail, MilestoneView } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { member, progress, view } from "./fixtures";
import { memberListRows } from "./milestones-model";
import { MilestoneDetailPane } from "./MilestonesView";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const noop = () => {};

function Page({ data, withDetail, desk }: { data: MilestoneView; withDetail: IssueDetail | null; desk: boolean }) {
  const controller = useIssueActions(noop);
  return (
    <MilestoneDetailPane
      view={data}
      members={memberListRows(data, [], "staple")}
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
      decision={withDetail ? { detail: withDetail, controller } : null}
      desk={desk}
    />
  );
}

const render = (withDetail: IssueDetail | null, desk: boolean) =>
  renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession({ ws: "staple" })}>
      <Page data={view({ milestone: { id: "id-LAR-190", identifier: "LAR-190", title: "October cut" }, progress: progress({ counts: { done: 2, ready: 1 } }), members: [member({ identifier: "LAR-67" }), member({ identifier: "LAR-68", status: "done" })] })} withDetail={withDetail} desk={desk} />
    </SessionContext.Provider>,
  );

// Planning off, or a plain milestone: the detail the server sends has no `horizonPlan`.
const plain = detail({ issue: issue({ id: "id-LAR-190", identifier: "LAR-190", kind: "milestone", title: "October cut" }) });

describe("the Milestones view without a horizon's plan", () => {
  for (const desk of [true, false]) {
    it(`draws a plain milestone as before, on the ${desk ? "desk" : "phone"}`, () => {
      expect(render(null, desk)).toMatchSnapshot();
      expect(render(plain, desk)).toMatchSnapshot();
    });
  }
});
