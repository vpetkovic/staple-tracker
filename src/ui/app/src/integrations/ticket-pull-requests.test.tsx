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
import { SingleLinkCard } from "./LinkHoverCard";
import { mergedOffer } from "./MergedPullRequestNotice";
import { prLink, prTicket, subtreePr } from "./pull-request-fixture";

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

describe("a parent's pull requests in the detail", () => {
  // PARENT owns acme/shop#10 (which child A carries too); A, B and B's child B1 carry the rest.
  const P = prTicket("ACME-P", null);
  const A = prTicket("ACME-A", "id-ACME-A");
  const B1 = prTicket("ACME-B1", "id-ACME-B");
  const parent = issue({ id: "id-ACME-P", identifier: "ACME-P" });
  const own = [prLink(10, { checks: "pending" }), prLink(11, { state: "merged" })];
  const set = [
    subtreePr(10, { own: true, checks: "pending", tickets: [P, A] }),
    subtreePr(11, { own: true, state: "merged", tickets: [P] }),
    subtreePr(20, { tickets: [A] }),
    subtreePr(21, { state: "draft", tickets: [B1] }),
    subtreePr(88, { repo: "acme/admin", checks: "failing", failing: ["unit"], tickets: [B1] }),
  ];
  const summary = (d: IssueDetail, compact = false) => renderToStaticMarkup(<ExternalPropertySummary detail={d} kind="pull_request" compact={compact} />);
  const chips = (html: string) => [...html.matchAll(/data-link-chip="([^"]*)"/g)].map((m) => m[1]);

  it("keeps its own chips and adds one roll-up for its descendants', never a chip per descendant", () => {
    const html = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set }));
    expect(chips(html)).toEqual(["res-acme/shop-10", "res-acme/shop-11"]);
    expect(html.match(/data-subtree-rollup=""/g)).toHaveLength(1);
    expect(html).not.toContain("res-acme/shop-20");
    expect(html).not.toContain("res-acme/admin-88");
    expect(html).toContain('aria-label="In tasks inside: 3 pull requests: 1 with failing checks, 2 open, 1 draft"');
    expect(html).toMatch(/data-subtree-rollup=""[^>]*>.*?<span class="truncate">3 in tasks inside<\/span>.*?data-pr-tally=""/);
    expect(html).not.toContain(">None<");
  });

  it("shortens its own keys among its own links only, so a descendant in another repository adds no prefix", () => {
    const html = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set }));
    const keys = [...html.matchAll(/data-link-key="">([^<]*)</g)].map((m) => m[1]);
    expect(keys).toEqual(["#10", "#11"]);
  });

  it("marks an own chip's checks and says them in its name", () => {
    const html = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set }));
    expect(html).toContain('aria-label="acme/shop#10, Change 10, Open, checks pending"');
    const chip10 = /data-link-chip="res-acme\/shop-10".*?<\/button>/.exec(html)![0];
    expect(chip10).toContain('data-checks="pending"');
    const chip11 = /data-link-chip="res-acme\/shop-11".*?<\/button>/.exec(html)![0];
    expect(chip11).not.toContain("data-checks");
  });

  it("puts the roll-up on the chips' line, without None, when the parent has none of its own", () => {
    const html = summary(detail({ issue: parent, subtreePullRequests: set.filter((pr) => !pr.own) }));
    expect(chips(html)).toEqual([]);
    expect(html).not.toContain(">None<");
    // One line: the roll-up sits before the add button inside the chips' row.
    expect(html).toMatch(/data-subtree-rollup=""[\s\S]*aria-label="Link pull request"[\s\S]*<\/span><\/span>$/);
    expect(html).toContain('aria-label="In tasks inside: 3 pull requests: 1 with failing checks, 2 open, 1 draft"');
  });

  // DEFECT (WCAG 2.5.3, label in name): the roll-up shows "3 in tasks inside" but is named
  // "In tasks inside: 3 pull requests: ...", so saying what is on screen does not reach it.
  it.fails("names the roll-up with the words it shows", () => {
    const html = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set }));
    const label = /data-subtree-rollup=""[^>]*aria-label="([^"]*)"/.exec(html)![1]!;
    expect(label.toLowerCase()).toContain("3 in tasks inside");
  });

  it("says None with no pull requests anywhere", () => {
    const html = summary(detail({ issue: parent, subtreePullRequests: [] }));
    expect(html).toContain(">None<");
    expect(html).not.toContain("data-subtree-rollup");
  });

  it("draws no roll-up for a parent whose pull requests are all its own", () => {
    const html = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set.filter((pr) => pr.own) }));
    expect(chips(html)).toHaveLength(2);
    expect(html).not.toContain("data-subtree-rollup");
  });

  it("leaves a leaf as it was, apart from the checks mark", () => {
    const html = summary(detail({ externalLinks: [prLink(5, { checks: "failing", failing: ["unit"] }), prLink(6)] }));
    expect(chips(html)).toEqual(["res-acme/shop-5", "res-acme/shop-6"]);
    expect(html).not.toContain("data-subtree-rollup");
    expect(html.match(/data-checks="failing"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="acme/shop#5, Change 5, Open, checks failing: unit"');
  });

  describe("on the phone", () => {
    it("counts the parent's whole set on the pill and marks it when something fails", () => {
      const html = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set }), true);
      expect(html).toContain('data-link-pill="pull_request"');
      expect(html).toContain(">5 pull requests<");
      expect(html).toContain('aria-label="5 pull requests: 1 with failing checks, 3 open, 1 draft, 1 merged; show External links"');
      expect(html).toContain('data-checks="failing"');
    });

    it("draws no failing mark when nothing fails, and no pill with none", () => {
      const quiet = summary(detail({ issue: parent, externalLinks: own, subtreePullRequests: set.filter((pr) => !pr.checks || pr.checks.state !== "failing") }), true);
      expect(quiet).toContain(">4 pull requests<");
      expect(quiet).not.toContain("data-checks");
      expect(summary(detail({ issue: parent, subtreePullRequests: [] }), true)).toBe("");
    });

    it("counts a leaf's own links", () => {
      const html = summary(detail({ externalLinks: [prLink(5)] }), true);
      expect(html).toContain(">1 pull request<");
      expect(html).toContain('aria-label="1 pull request: 1 open; show External links"');
    });
  });

  it("names the checks and, for a pull request a descendant carries too, the other tickets in the chip's card", () => {
    const html = renderToStaticMarkup(
      <SingleLinkCard link={own[0]!} workspace="w" issueId="id-ACME-P" also={[A]} refresh={() => {}} onShowAll={() => {}} />,
    );
    expect(html).toMatch(/data-link-checks="pending"[^>]*>.*?Checks pending</);
    expect(html).toMatch(/data-link-also=""[^>]*>Also on.*?data-pr-ticket="ACME-A"/);
    const alone = renderToStaticMarkup(<SingleLinkCard link={own[1]!} workspace="w" issueId="id-ACME-P" refresh={() => {}} onShowAll={() => {}} />);
    expect(alone).not.toContain("data-link-also");
    expect(alone).not.toContain("data-link-checks");
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
