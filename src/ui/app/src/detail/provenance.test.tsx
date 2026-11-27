/**
 * Where a record came from, as the detail draws it: a scaffolded ticket's "from I-STA-n · row K"
 * chip opening its idea in Plan, on the drawer and on the phone sheet; the ticket that sparked an
 * idea; and a ticket's sparked ideas. Nothing is drawn when the server sends none (planning off).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { detail, issue } from "./detail-fixture";
import type { DetailPresentation } from "./drawer";
import { DetailContent } from "./IssueDetailPanel";
import { useIssueActions } from "./IssueActions";
import { OverviewTab } from "./tabs/OverviewTab";

const noop = () => {};

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

const render = (d: IssueDetail, presentation: DetailPresentation = "drawer") =>
  renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <Content d={d} presentation={presentation} />
    </SessionContext.Provider>,
  );

const SCAFFOLDED = detail({
  workspace: "staple",
  issue: issue({ identifier: "STA-90", title: "Second task" }),
  scaffoldedFrom: { ideaId: "idea-1", ideaNumber: "I-STA-4", identifier: "STA-88", title: "Checkout", rowId: "row-2", rowKey: "R2" },
});

describe("a scaffolded ticket's chip", () => {
  for (const presentation of ["drawer", "sheet", "full"] as const) {
    it(`reads "from I-STA-n · row K" and opens the idea in Plan (${presentation})`, () => {
      const html = render(SCAFFOLDED, presentation);
      expect(html).toContain('data-scaffolded-from="I-STA-4"');
      expect(html).toContain("from I-STA-4 · row R2");
      expect(html).toContain('href="?ws=staple&amp;view=plan&amp;issue=idea-1"');
    });
  }

  it("says the row was removed when the breakdown no longer holds it", () => {
    const html = render(detail({ ...SCAFFOLDED, scaffoldedFrom: { ...SCAFFOLDED.scaffoldedFrom!, rowKey: null } }));
    expect(html).toContain("from I-STA-4 · a removed row");
  });

  it("draws nothing for a ticket with no provenance, as the server sends it with planning off", () => {
    const html = render(detail({ scaffoldedFrom: null, sparkedBy: null, sparked: [] }));
    expect(html).not.toContain("data-provenance");
    expect(html).not.toContain("data-sparked-ideas");
  });
});

describe("sparked ideas", () => {
  it("names the ticket that sparked a record", () => {
    const html = render(detail({ sparkedBy: { identifier: "STA-12", title: "Report screen", status: "in_progress" } }));
    expect(html).toContain('data-sparked-by="STA-12"');
    expect(html).toContain("sparked by");
  });

  it("lists a ticket's sparked ideas, each opening in Plan, an epic with both its numbers", () => {
    const html = renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession()}>
        <OverviewTab
          detail={detail({
            sparked: [
              { id: "idea-7", ideaNumber: "I-STA-7", identifier: null, title: "Bulk export", maturity: "raw" },
              { id: "idea-8", ideaNumber: "I-STA-8", identifier: "STA-95", title: "Grown up", maturity: "shaped" },
            ],
          })}
          workspace="staple"
          onAuthError={noop}
          refresh={noop}
        />
      </SessionContext.Provider>,
    );
    expect(html).toContain('aria-label="Sparked ideas"');
    expect(html).toContain('data-sparked-idea="I-STA-7"');
    expect(html).toContain('href="?ws=staple&amp;view=plan&amp;issue=idea-7"');
    expect(html).toContain("STA-95 · I-STA-8");
  });
});
