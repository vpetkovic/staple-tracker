import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalPropertySummary } from "./ExternalPropertySummary";
import { LinkRow } from "./LinkList";
import { groupLinks, type ExternalLink } from "./model";
import type { IssueDetail } from "@/lib/types";
import { issue } from "@/components/task-list/fixtures";
export function sourceLink(n: number): ExternalLink {
  return {
    id: `link-${n}`,
    issueId: "local",
    parentResourceId: null,
    parentMissing: false,
    position: 0,
    createdBy: "tester",
    createdAt: "2026-11-23T00:00:00Z",
    updatedAt: "2026-11-23T00:00:00Z",
    resource: {
      id: `resource-${n}`,
      ref: {
        providerId: "github",
        host: "github.com",
        scopeId: "host",
        containerId: "42",
        id: String(n),
        kind: "issue",
      },
      key: `team/repo#${n}`,
      url: `https://github.com/team/repo/issues/${n}`,
      title: `Source ${n}`,
      body: "Cached source body",
      status: { id: "open", name: "Open" },
      fetchedAt: "2026-11-23T00:00:00Z",
      createdAt: "2026-11-23T00:00:00Z",
      updatedAt: "2026-11-23T00:00:00Z",
      contextShared: false,
    },
  };
}
describe("external ticket context", () => {
  it("shows full association counts but bounds property previews and offers linking", () => {
    const links = Array.from({ length: 12 }, (_, i) => sourceLink(i + 1));
    const detail = { workspace: "demo", issue: issue(), externalLinks: links } as IssueDetail;
    const html = renderToStaticMarkup(<ExternalPropertySummary detail={detail} kind="issue" />);
    expect(html).toContain('aria-label="12 linked issues; show External links"');
    expect(html).toContain("+10");
    expect(html).not.toContain("team/repo#3");
    expect(html).toContain('aria-label="Link issue"');
  });
  it("groups by immutable provider scope and repository rather than a shared display name", () => {
    const a = sourceLink(1),
      b = sourceLink(2),
      c = sourceLink(3);
    b.resource.ref.host = "git.example";
    c.resource.ref.containerId = "900";
    expect(groupLinks([a, b, c])).toHaveLength(3);
    expect(groupLinks([a, sourceLink(4)])[0]?.links).toHaveLength(2);
  });
  it("keeps the saved body readable offline, without a refresh, and sharing off by default", () => {
    const link = sourceLink(1);
    const html = renderToStaticMarkup(
      <ul>
        <LinkRow
          link={link}
          peers={[link]}
          links={[link]}
          depth={0}
          guides={[]}
          hasChildren={false}
          refreshable={false}
          open
          onOpenChange={() => {}}
          onWrite={async () => {}}
          now={Date.parse("2026-11-23T00:05:00Z")}
        />
      </ul>,
    );
    expect(html).toContain("Cached source body");
    expect(html).not.toContain("Refresh team/repo#1");
    expect(html).toMatch(/role="switch"[^>]*aria-checked="false"/);
    expect(html).toContain("Sharing also sends this title, description and state");
    expect(html).not.toContain('type="checkbox"');
  });
});
