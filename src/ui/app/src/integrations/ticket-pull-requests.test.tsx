/**
 * A ticket's pull requests in the detail and on the row: every one listed, a merged one
 * offers Mark done and never moves the status itself, and the row never draws one twice.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueDetail, StatusCategory } from "@/lib/types";
import { detail, issue } from "@/detail/detail-fixture";
import { actionContextOf } from "@/detail/IssueActions";
import type { ActionContext } from "@/detail/plain-actions";
import { sourceLink } from "./external-detail.test";
import { ExternalLinkBadges } from "./ExternalLinkBadges";
import { ExternalPropertySummary } from "./ExternalPropertySummary";
import { mergedOffer } from "./MergedPullRequestNotice";

const CATEGORY: Record<string, StatusCategory> = { todo: "ready", in_progress: "active", in_review: "review", awaiting_approval: "gated", done: "done", cancelled: "cancelled" };
const ctx = (d: IssueDetail, over: Partial<ActionContext> = {}): ActionContext => ({
  ...actionContextOf(d, { worker: "tester", person: null }),
  order: Object.keys(CATEGORY),
  categoryOf: (s) => CATEGORY[s] ?? "unstarted",
  labelOf: (s) => s,
  ...over,
});

function pr(n: number, state: string) {
  const link = sourceLink(n);
  link.resource.ref.kind = "pull_request";
  link.resource.url = `https://github.com/team/repo/pull/${n}`;
  link.resource.status = { id: state, name: state };
  return link;
}

describe("the merged pull request offer", () => {
  it("offers Mark done, as the ordinary status write, while the ticket is open", () => {
    const d = detail({ issue: issue({ status: "in_review" }), externalLinks: [pr(3, "merged"), pr(4, "open")] });
    const offer = mergedOffer(d, ctx(d));
    expect(offer?.merged.map((l) => l.resource.key)).toEqual(["team/repo#3"]);
    expect(offer?.done).toMatchObject({ id: "done", label: "Mark done", call: { route: "action", payload: { type: "status", status: "done" } } });
  });

  it("offers nothing without a merged pull request, once finished, or behind a review gate", () => {
    const open = detail({ issue: issue({ status: "in_progress" }), externalLinks: [pr(4, "open"), pr(5, "closed")] });
    expect(mergedOffer(open, ctx(open))).toBeNull();
    for (const status of ["done", "cancelled", "awaiting_approval"] as const) {
      const d = detail({ issue: issue({ status }), externalLinks: [pr(3, "merged")] });
      expect(mergedOffer(d, ctx(d))).toBeNull();
    }
    const parked = detail({ issue: issue({ status: "in_review" }), externalLinks: [pr(3, "merged")] });
    expect(mergedOffer(parked, ctx(parked, { parked: true }))).toBeNull();
  });
});

describe("the detail's pull requests", () => {
  it("lists every pull request, each with its state's glyph, where linked issues stop at four", () => {
    const states = ["open", "draft", "merged", "closed", "closed", "merged"];
    const d = detail({ externalLinks: states.map((state, i) => pr(i + 1, state)) });
    const html = renderToStaticMarkup(<ExternalPropertySummary detail={d} kind="pull_request" />);
    expect(html.match(/data-link-chip=/g)).toHaveLength(6);
    expect(html).not.toContain("more");
    for (const tone of ["open", "draft", "merged", "closed"]) expect(html).toContain(`data-link-tone="${tone}"`);
  });
});

describe("the row", () => {
  it("leaves the pull requests to the pull request badge when it draws them", () => {
    const summary = { issues: { count: 1, items: [] }, pullRequests: { count: 2, items: [] } };
    const both = renderToStaticMarkup(<ExternalLinkBadges summary={summary} workspace="w" issueId="i" />);
    expect(both).toContain('data-link-badge="pull_request"');
    const issuesOnly = renderToStaticMarkup(<ExternalLinkBadges summary={summary} workspace="w" issueId="i" withoutPullRequests />);
    expect(issuesOnly).toContain('data-link-badge="issue"');
    expect(issuesOnly).not.toContain('data-link-badge="pull_request"');
    const nothing = renderToStaticMarkup(<ExternalLinkBadges summary={{ ...summary, issues: { count: 0, items: [] } }} workspace="w" issueId="i" withoutPullRequests />);
    expect(nothing).toBe("");
  });
});
