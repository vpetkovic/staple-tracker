import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalLinkBadges } from "./ExternalLinkBadges";
import { TaskRowLine } from "@/components/task-list/TaskRowLine";
import { resolveTaskListConfig } from "@/components/task-list/config";
import { row } from "@/components/task-list/fixtures";
import { flatRow } from "@/components/task-list/model";
import { rowPlan } from "@/components/task-list/row-layout";
import type { ExternalLinkPreview, ExternalRowSummary } from "../../../../core/integrations/link-store";

const preview = (n: number, status?: { id: string; name: string }): ExternalLinkPreview =>
  ({
    id: `r${n}`, providerId: "github", host: "github.com", containerId: "42",
    key: `team/repo#${n}`, url: `https://github.com/team/repo/pull/${n}`, title: `Change ${n}`,
    ...(status ? { status } : {}),
  }) as ExternalLinkPreview;

/** Where the span opened just before `from` closes. */
function closeOf(html: string, from: number): number {
  const tags = /<span\b|<\/span>/g;
  tags.lastIndex = from;
  let depth = 1;
  for (let m = tags.exec(html); m; m = tags.exec(html)) {
    depth += m[0] === "</span>" ? -1 : 1;
    if (depth === 0) return m.index;
  }
  return html.length;
}

const badges = (summary: ExternalRowSummary) =>
  renderToStaticMarkup(<ExternalLinkBadges summary={summary} workspace="demo" issueId="id" />);

describe("row link badges", () => {
  it("reserves no row space for absent links and exposes distinct accessible issue/PR counts", () => {
    expect(renderToStaticMarkup(<ExternalLinkBadges workspace="demo" issueId="id" />)).toBe("");
    const html = badges({ issues: { count: 8, items: [] }, pullRequests: { count: 3, items: [] } });
    expect(html).toContain('aria-label="8 linked issues"');
    expect(html).toContain('aria-label="3 linked pull requests"');
    expect(html).not.toContain("repository");
  });

  it("wears the tone of the link most in motion when the server sends states", () => {
    const html = badges({
      issues: { count: 0, items: [] },
      pullRequests: { count: 2, items: [preview(1, { id: "merged", name: "merged" }), preview(2, { id: "open", name: "open" })] },
    });
    expect(html).toContain('data-link-tone="open"');
  });

  it("stays neutral, with no placeholder, when the previews carry no state", () => {
    const html = badges({ issues: { count: 0, items: [] }, pullRequests: { count: 2, items: [preview(1), preview(2)] } });
    expect(html).toContain('data-link-tone="neutral"');
    expect(html).toContain(">2<");
  });
});

describe("the desk row", () => {
  it("draws the badges at the end of the signals, before the who slot and the trailing slot", () => {
    const line = flatRow({
      ...row({ identifier: "STA-10", assignee: "vp" }),
      externalLinks: { issues: { count: 2, items: [] }, pullRequests: { count: 1, items: [] } },
      pullRequests: [{ provider: "github", number: 12, state: "open", url: "https://github.com/team/repo/pull/12" }],
    } as Parameters<typeof flatRow>[0]);
    const html = renderToStaticMarkup(
      <TaskRowLine
        row={line}
        config={resolveTaskListConfig("tree", { plan: rowPlan(1440), desk: true })}
        semantics="grid"
        now={new Date("2026-09-01T01:00:00.000Z")}
        onOpen={() => {}}
      />,
    );
    const signals = html.indexOf('class="staple-row-signals"');
    const links = html.indexOf("data-external-link-badges");
    const pr = html.indexOf("staple-pr-badge");
    const who = html.indexOf('data-testid="who-slot"');
    const trail = html.indexOf('class="staple-row-trail"');
    expect(signals).toBeGreaterThan(0);
    expect(links).toBeGreaterThan(signals);
    expect(pr).toBeGreaterThan(links);
    expect(who).toBeGreaterThan(pr);
    expect(trail).toBeGreaterThan(who);
    // Inside the signals span, not after it.
    expect(pr).toBeLessThan(closeOf(html, signals));
    expect(who).toBeGreaterThan(closeOf(html, signals));
  });
});
