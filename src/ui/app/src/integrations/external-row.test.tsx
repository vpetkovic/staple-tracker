import { it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ExternalLinkBadges } from "./ExternalLinkBadges";
import type { ExternalRowSummary } from "../../../../core/integrations/link-store";
it("reserves no row space for absent links and exposes distinct accessible issue/PR counts", () => {
  expect(renderToStaticMarkup(<ExternalLinkBadges workspace="demo" issueId="id" />)).toBe("");
  const summary: ExternalRowSummary = {
    issues: { count: 8, items: [] },
    pullRequests: { count: 3, items: [] },
  };
  const html = renderToStaticMarkup(
    <ExternalLinkBadges summary={summary} workspace="demo" issueId="id" />,
  );
  expect(html).toContain('aria-label="8 linked issues"');
  expect(html).toContain('aria-label="3 linked pull requests"');
});
