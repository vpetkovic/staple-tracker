/**
 * Linked issues and pull requests in task detail: full-width rows in the property grid, one
 * chip per link with the shortest unambiguous key, a quiet "+N more", a `+` at the end, and a
 * hover card that says what the link is. Plus the External links tab's count.
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Tabs } from "@/components/ui/tabs";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { detail as detailFixture, issue as issueFixture } from "@/detail/detail-fixture";
import { DetailContent } from "@/detail/IssueDetailPanel";
import { useIssueActions } from "@/detail/IssueActions";
import { DetailTabStrip } from "@/detail/tabs/DetailTabStrip";
import { TABS } from "@/detail/tabs/registry";
import { ExternalPropertySummary } from "./ExternalPropertySummary";
import { LinkListCard, SingleLinkCard } from "./LinkHoverCard";
import type { ExternalLink } from "./model";

const noop = () => {};

function link(
  n: number,
  over: { kind?: "issue" | "pull_request"; key?: string; providerId?: string; fetchedAt?: string | null; status?: { id: string; name: string } | null } = {},
): ExternalLink {
  const kind = over.kind ?? "pull_request";
  const key = over.key ?? `team/repo#${n}`;
  return {
    id: `link-${n}`,
    issueId: "local",
    parentResourceId: null,
    parentMissing: false,
    position: n,
    createdBy: "tester",
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    resource: {
      id: `resource-${n}`,
      ref: { providerId: over.providerId ?? "github", host: "github.com", scopeId: "host", containerId: "42", id: String(n), kind },
      key,
      url: `https://github.com/${key.replace("#", kind === "issue" ? "/issues/" : "/pull/")}`,
      title: `Source ${n}`,
      body: null,
      status: over.status === undefined ? { id: "open", name: "open" } : over.status,
      fetchedAt: over.fetchedAt === undefined ? "2026-11-23T00:00:00Z" : over.fetchedAt,
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      contextShared: false,
    },
  };
}

const withLinks = (links: ExternalLink[], patch: Partial<IssueDetail> = {}): IssueDetail =>
  detailFixture({ externalLinks: links, ...patch } as Partial<IssueDetail>);

const summary = (d: IssueDetail, kind: "issue" | "pull_request", compact = false) =>
  renderToStaticMarkup(<ExternalPropertySummary detail={d} kind={kind} compact={compact} />);

const chips = (html: string) => [...html.matchAll(/data-link-chip="[^"]*"[^>]*>[\s\S]*?<span[^>]*data-link-key="">([^<]*)</g)].map((m) => m[1]);

// ─────────────────────────────────────────────────────────────────── the grid

function Content({ d }: { d: IssueDetail }) {
  const controller = useIssueActions(noop);
  return (
    <DetailContent
      detail={d}
      presentation="drawer"
      expanded={false}
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

const drawer = (d: IssueDetail) =>
  renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <Content d={d} />
    </SessionContext.Provider>,
  );

/** Every property row's opening tag, in order. */
const rows = (html: string) => [...html.matchAll(/<div data-property="([^"]+)" class="([^"]*)"/g)].map((m) => ({ id: m[1]!, cls: m[2]! }));

describe("the property grid", () => {
  // Kind, Priority, Assignee, Project, Updated, Created: six paired facts; Started makes seven.
  const even = withLinks([link(1)]);
  const odd = withLinks([link(1)], { issue: issueFixture({ startedAt: "2026-11-20T00:00:00Z" }) });

  for (const [name, d] of [["an even", even], ["an odd", odd]] as const) {
    it(`puts Linked issues, Pull requests and Labels full width after ${name} number of paired facts`, () => {
      const list = rows(drawer(d));
      const ids = list.map((r) => r.id);
      const tail = ids.slice(-3);
      expect(tail).toEqual(["linked issues", "pull requests", "labels"]);
      for (const r of list.slice(-3)) expect(r.cls, r.id).toContain("@lg:col-span-2");
      for (const r of list.slice(0, -3)) expect(r.cls, r.id).not.toContain("col-span");
      for (const r of list) expect(r.cls, r.id).not.toMatch(/col-start/);
    });
  }
});

// ─────────────────────────────────────────────────────────────────── the chips

describe("link chips", () => {
  it("shows at most four chips with the repository-local key, then +N more and the +", () => {
    const html = summary(withLinks(Array.from({ length: 6 }, (_, i) => link(i + 1))), "pull_request");
    expect(chips(html)).toEqual(["#1", "#2", "#3", "#4"]);
    expect(html).toContain(">+2 more<");
    expect(html).toContain('aria-label="Link pull request"');
    expect(html).toContain('class="sr-only">6 pull requests<');
    expect(html).not.toContain("#5");
    // The + comes last, after the "+N more".
    expect(html.indexOf("+2 more")).toBeLessThan(html.indexOf('aria-label="Link pull request"'));
  });

  it("names the repository when links span two", () => {
    const html = summary(withLinks([link(1, { key: "team/repo#1" }), link(2, { key: "team/other#2" })]), "pull_request");
    expect(chips(html)).toEqual(["repo#1", "other#2"]);
    expect(html).not.toContain("more<");
  });

  it("keeps the chips of one kind only", () => {
    const html = summary(withLinks([link(1, { kind: "issue" }), link(2)]), "issue");
    expect(chips(html)).toEqual(["#1"]);
    expect(html).toContain('class="sr-only">1 linked issue<');
  });

  it("says None beside the + when nothing is linked", () => {
    const html = summary(withLinks([]), "issue");
    expect(html).toContain(">None<");
    expect(html).toContain('aria-label="Link issue"');
    expect(chips(html)).toEqual([]);
  });

  it("is one counted pill per kind on the phone, with its own + ", () => {
    const html = summary(withLinks(Array.from({ length: 3 }, (_, i) => link(i + 1, { kind: "issue" }))), "issue", true);
    expect(html).toContain(">3 issues<");
    expect(chips(html)).toEqual([]);
    expect(html).toContain('aria-label="Link issue"');
    expect(summary(withLinks(Array.from({ length: 6 }, (_, i) => link(i + 1))), "pull_request", true)).toContain(">6 pull requests<");
  });

  it("is only the labelled + on the phone when nothing is linked", () => {
    const html = summary(withLinks([]), "issue", true);
    expect(html).toContain(">Link issue<");
    expect(html).not.toContain("0 issues");
  });
});

// ─────────────────────────────────────────────────────────────────── the hover card

describe("the hover card", () => {
  it("says where a single link lives, what it is, its state, how old the copy is, and what can be done", () => {
    const one = link(7, { status: { id: "merged", name: "merged" } });
    const html = renderToStaticMarkup(<SingleLinkCard link={one} workspace="demo" issueId="local" refresh={noop} onShowAll={noop} />);
    expect(html).toContain('data-provider="github"');
    expect(html).toContain(">team/repo<");
    expect(html).toContain(">Source 7<");
    expect(html).toContain(">Merged<");
    expect(html).toMatch(/Saved copy from [^<]+ ago/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/github.com\/team\/repo\/pull\/7"[^>]*target="_blank"[^>]*rel="noreferrer noopener"[^>]*>[\s\S]*?Open on GitHub/);
    expect(html).toContain(">Show in External links<");
    expect(html).toContain(">Unlink<");
  });

  it("says when a link was never read", () => {
    const html = renderToStaticMarkup(
      <SingleLinkCard link={link(8, { fetchedAt: null, status: null, providerId: "linear", key: "ENG-8" })} workspace="demo" issueId="local" refresh={noop} onShowAll={noop} />,
    );
    expect(html).toContain("Linked by URL, not read yet");
    expect(html).toContain(">Open in Linear<");
  });

  it("lists a row's links, one row each, and offers them all in External links", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      id: `r${i}`, providerId: "github", host: "github.com", containerId: "42",
      key: `team/repo#${i + 1}`, url: `https://github.com/team/repo/pull/${i + 1}`, title: i === 2 ? null : `Change ${i + 1}`,
    }));
    const html = renderToStaticMarkup(<LinkListCard kind="pull_request" count={6} items={items} onShowAll={noop} />);
    expect(html).toContain(">6 pull requests<");
    expect(html.match(/data-link-row=""/g)).toHaveLength(5);
    expect(html).toContain(">Change 1<");
    // No title: the key stands in.
    expect(html).toMatch(/data-link-row=""[^>]*href="https:\/\/github.com\/team\/repo\/pull\/3"[\s\S]*?>team\/repo#3</);
    expect(html).toContain(">#5<");
    expect(html).toContain(">Show all 6 in External links<");
    expect(html).not.toContain("repository 42");
  });
});

// ─────────────────────────────────────────────────────────────────── the tab count

describe("the External links tab", () => {
  const tab = TABS.find((t) => t.id === "external-links")!;

  it("counts the links, and says nothing when there are none", () => {
    expect(tab.count?.(withLinks([link(1), link(2, { kind: "issue" })]))).toBe(2);
    expect(tab.count?.(withLinks([]))).toBeNull();
    expect(TABS.filter((t) => t.count).map((t) => t.id)).toEqual(["external-links"]);
  });

  it("draws the count after the label and reads it in the tab's name", () => {
    const strip = (count: number | null) =>
      renderToStaticMarkup(
        <Tabs value="overview">
          <DetailTabStrip sheet={false} label="Tabs" items={[{ id: "overview", label: "Details" }, { id: "external-links", label: "External links", count }]} />
        </Tabs>,
      );
    const html = strip(8);
    expect(html).toMatch(/aria-label="External links, 8"[^>]*>External links<span[^>]*text-text-tertiary[^>]*>8<\/span>/);
    expect(strip(null)).not.toContain("External links,");
    expect(strip(null)).not.toContain("text-text-tertiary");
  });
});
