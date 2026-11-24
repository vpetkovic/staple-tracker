import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalLinkCard } from "@/detail/tabs/ExternalLinksTab";
import { groupLinks, type ExternalLink } from "./model";
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
  it("groups by immutable provider scope and repository rather than a shared display name", () => {
    const a = sourceLink(1),
      b = sourceLink(2),
      c = sourceLink(3);
    b.resource.ref.host = "git.example";
    c.resource.ref.containerId = "900";
    expect(groupLinks([a, b, c])).toHaveLength(3);
    expect(groupLinks([a, sourceLink(4)])[0]?.links).toHaveLength(2);
  });
  it("retains cached body with honest offline freshness and explicit sharing controls", () => {
    const html = renderToStaticMarkup(
      <ExternalLinkCard
        link={sourceLink(1)}
        busy={false}
        canRefresh={false}
        onRefresh={() => {}}
        onUnlink={() => {}}
        onShare={() => {}}
      />,
    );
    expect(html).toContain("Cached source body");
    expect(html).toContain("cached-only");
    expect(html).toContain("only on this machine");
    expect(html).toContain("cannot erase retained history");
    expect(html).not.toContain('checked=""');
  });
});
