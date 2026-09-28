/**
 * The milestone wherever a detail meets one — see MilestoneParts.tsx.
 *
 * A member (direct or inherited) names its milestone in the breadcrumb, as a property and
 * under "Part of"; a milestone's own detail reads as a plan, not as a task nobody can start.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import type { EffectiveMilestone, IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { member, view } from "@/views/milestones/fixtures";
import { detail, issue } from "./detail-fixture";
import type { DetailPresentation } from "./drawer";
import { DetailContent } from "./IssueDetailPanel";
import { useIssueActions } from "./IssueActions";
import { RelationsTab } from "./tabs/RelationsTab";

const noop = () => {};

const OCTOBER: EffectiveMilestone = {
  id: "id-STA-190",
  identifier: "STA-190",
  title: "October cut",
  status: "backlog",
  targetDate: "2026-10-31",
  via: null,
};

function Content({ d, presentation }: { d: IssueDetail; presentation: DetailPresentation }) {
  const controller = useIssueActions(noop);
  return (
    <DetailContent
      detail={d}
      presentation={presentation}
      expanded={presentation === "full"}
      mode="workspace"
      controller={controller}
      refresh={noop}
      onAuthError={noop}
      requestOpen={false}
      onRequestApproval={noop}
      onCloseRequest={noop}
      onReview={noop}
    />
  );
}

function render(d: IssueDetail, presentation: DetailPresentation = "drawer"): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <Content d={d} presentation={presentation} />
    </SessionContext.Provider>,
  );
}

const crumbOf = (html: string) => /<nav[^>]*data-detail-breadcrumb[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";

const TASK = detail({
  issue: issue({ identifier: "STA-322", title: "Scoped pickup", parentId: "epic" }),
  ancestors: [issue({ id: "epic", identifier: "STA-321", title: "Autopilot runs" })],
  milestone: { ...OCTOBER, via: { identifier: "STA-321", title: "Autopilot runs" } },
});

describe("a member's detail", () => {
  it("puts the milestone first in the breadcrumb, before the real parent", () => {
    const crumb = crumbOf(render(TASK, "sheet"));
    expect(crumb).toContain('data-breadcrumb-milestone="STA-190"');
    expect(crumb.indexOf("October cut")).toBeLessThan(crumb.indexOf("Autopilot runs"));
  });

  it("shows a Milestone property that says which ancestor it comes through", () => {
    const html = render(TASK);
    expect(html).toContain(">Milestone<");
    expect(html).toContain('data-detail-milestone="STA-190"');
    expect(html).toContain('data-milestone-via="STA-321"');
    expect(html).toContain("via Autopilot runs");
  });

  it("says nothing about a milestone for work in none", () => {
    const html = render(detail({ milestone: null }));
    expect(html).not.toContain("data-detail-milestone");
    expect(crumbOf(html)).not.toContain("data-breadcrumb-milestone");
  });

  it("lists the milestone under Part of in Connections", () => {
    const html = renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession()}>
        <RelationsTab detail={TASK} workspace="staple" onAuthError={noop} refresh={noop} />
      </SessionContext.Provider>,
    );
    expect(html).toContain("Milestone, via Autopilot runs");
    expect(html.indexOf("October cut")).toBeLessThan(html.indexOf("Autopilot runs</span>"));
  });
});

const PLAN = detail({
  issue: issue({ id: "id-STA-190", identifier: "STA-190", title: "October cut", kind: "milestone", status: "backlog" }),
  milestonePlan: view({
    members: [member({ identifier: "STA-321", title: "Autopilot runs", kind: "epic" })],
  }),
});

describe("a milestone's own detail", () => {
  it("reads as a plan: progress and due date, and no Start work", () => {
    const html = render(PLAN);
    expect(html).toContain("data-milestone-sentence");
    expect(html).toContain('data-primary="open-plan"');
    expect(html).not.toContain("Start work");
  });

  it("shows when it is due as a property", () => {
    expect(render(PLAN)).toContain("data-milestone-due");
  });

  it("lists what is in it", () => {
    const html = render(PLAN);
    expect(html).toContain("What is in this milestone");
    expect(html).toContain("Autopilot runs");
  });

  it("keeps the ordinary primary on a finished milestone, which the plan list hides", () => {
    const done = { ...PLAN, milestonePlan: view({ milestone: { state: "done" } }) };
    expect(render(done)).not.toContain('data-primary="open-plan"');
  });
});
