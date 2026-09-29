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
import { emptyFilters } from "@/lib/filters";
import { member, progress, view } from "@/views/milestones/fixtures";
import { effective } from "@/views/queue/fixtures";
import { MilestoneMembers, MilestoneProgressSummary } from "./MilestoneParts";
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

  it("shows when it is due as a property, with the Milestones page's own due control", () => {
    const html = render(PLAN);
    expect(html).toContain("data-milestone-due");
    // The same control as on the Milestones page: the date in words and the calendar that sets it.
    expect(html).toMatch(/data-milestone-due=""><span[^>]*data-milestone-due-control=""/);
    expect(html).toContain('aria-label="Change the due date"');
  });

  it("projects the due date from the calibrated work left when no target is set", () => {
    const plan = view({ milestone: { targetDate: null }, remaining: { estimated: 1, unestimated: 0, unknown: 0, estimateSeconds: 3600, forecastSeconds: 3600 } });
    const html = render({ ...PLAN, milestonePlan: plan });
    expect(html).toMatch(/data-milestone-sentence="">[^<]*Due ~\d+ \w+ \(estimated\)\.</);
    expect(html).toContain('data-due-source="estimate"');
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

describe("the milestone inside a task detail reads as the Milestones page reads", () => {
  const epic = issue({ id: "e", identifier: "STA-321", title: "Autopilot runs", kind: "epic", status: "in_review" });
  const open = issue({ id: "c1", identifier: "STA-326", title: "Run record", parentId: "e", status: "in_review" });
  const duplicate = issue({ id: "c2", identifier: "STA-325", title: "Run record (duplicate)", parentId: "e", status: "cancelled" });
  const rows = [epic, open, duplicate].map((i) => ({ workspace: "staple", issue: i, claim: null }));
  const plan = view({
    milestone: { identifier: "STA-332" },
    progress: progress({ counts: { review: 1, cancelled: 1 } }),
    members: [member({ identifier: "STA-321", kind: "epic" })],
  });
  const members = (showDone: boolean) =>
    renderToStaticMarkup(
      <SessionContext.Provider
        value={fakeSession({ issues: { data: rows, error: undefined, loading: false, reload: noop }, filters: { ...emptyFilters(), showDone } })}
      >
        <MilestoneMembers plan={plan} workspace="staple" />
      </SessionContext.Provider>,
    );

  it("hides a cancelled member while Done is hidden, and shows it when Done is shown", () => {
    expect(members(false)).toContain('data-identifier="STA-326"');
    expect(members(false)).not.toContain('data-identifier="STA-325"');
    expect(members(true)).toContain('data-identifier="STA-325"');
  });

  it("gives in-review work its own bucket and names the cancelled task the count leaves out", () => {
    const html = members(false);
    expect(html).toMatch(/data-legend="review"[^>]*>.*?<span class="staple-progress-count">1<\/span> in review/);
    expect(html).toContain("1 cancelled task is not counted.");
  });

  it("reads the queue as the page does: work in review that still waits is named, not drawn as blocked", () => {
    const html = renderToStaticMarkup(
      <MilestoneProgressSummary
        plan={view({ milestone: { identifier: "STA-332" }, progress: progress({ counts: { review: 9, cancelled: 1 } }) })}
        effective={Array.from({ length: 7 }, (_, i) =>
          effective({ identifier: `STA-${323 + i}`, milestonePath: ["STA-332"], eligibility: "blocked", status: "in_review" }),
        )}
      />,
    );
    expect(html).toMatch(/data-legend="blocked"[^>]*data-empty=""/);
    expect(html).toContain("7 in review still wait on other tasks. 1 cancelled task is not counted.");
  });

  it("says every member is finished, with Show done, when Done hides them all", () => {
    const finished = [epic, { ...open, status: "done" as const }, duplicate].map((i) => ({ workspace: "staple", issue: { ...i, status: i === epic ? ("done" as const) : i.status }, claim: null }));
    const html = renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession({ issues: { data: finished, error: undefined, loading: false, reload: noop }, filters: emptyFilters() })}>
        <MilestoneMembers plan={plan} workspace="staple" />
      </SessionContext.Provider>,
    );
    expect(html).toContain("3 finished items hidden");
    expect(html).toContain("data-show-done");
    expect(html).not.toContain("Nothing is planned here yet");
  });
});
