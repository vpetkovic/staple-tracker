/**
 * The loaded detail's frame in each presentation: a quiet header with one status control and
 * one primary action, plain properties (people as chips, relative dates, raw values behind
 * "More details"), a readable column plus a rail on the full page, summary chips on the phone,
 * and tabs named in plain words.
 *
 * The panel's fetch does not run in a static render, so the loaded layout is rendered through
 * `DetailContent` with a fixture payload, exactly as the panel renders it once loaded.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { claim, detail, issue } from "./detail-fixture";
import type { DetailPresentation } from "./drawer";
import { DetailContent } from "./IssueDetailPanel";
import { useIssueActions } from "./IssueActions";
import { TABS } from "./tabs/registry";

const noop = () => {};

const LOADED = detail({
  issue: issue({
    identifier: "STA-313",
    title: "D1: desktop shell",
    description: "Lane D1. Owns the shell.",
    acceptanceCriteria: ["Sidebar reads as plain groups", "Focus rings on every control"],
    assignee: "dux-shell",
    checkoutAgent: "dux-shell",
    createdBy: "orchestrator",
    startedAt: "2026-09-01T22:40:00Z",
  }),
  ancestors: [issue({ id: "parent", identifier: "STA-312", title: "D: desktop UX overhaul" })],
  claim: claim({ heldBy: "dux-shell" }),
});

function Content({ d, presentation }: { d: IssueDetail; presentation: DetailPresentation }) {
  const controller = useIssueActions(d.issue, d.workspace, noop);
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

function render(presentation: DetailPresentation, d: IssueDetail = LOADED): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <Content d={d} presentation={presentation} />
    </SessionContext.Provider>,
  );
}

/** The markup minus the closed "More details" disclosure, i.e. what is read first. */
function firstRead(html: string): string {
  return html.replace(/<details[\s\S]*?<\/details>/g, "");
}

describe("the header", () => {
  it("leads with the title, then one status line with the pill, a sentence, one primary action and ⋯", () => {
    const html = render("drawer");
    expect(html).toContain(">D1: desktop shell</h2>");
    expect(html).toContain("data-status-menu");
    expect(html).toContain("Being worked on by");
    expect((html.match(/data-action="primary"/g) ?? []).length).toBe(1);
    expect(html).toContain('data-primary="done"');
    expect(html).toContain("data-overflow-menu");
  });

  it("has no four-button status panel: no apply button, no start and stop side by side", () => {
    const html = render("drawer");
    expect(html).not.toContain(">Change status<");
    const statusLine = /<div[^>]*data-status-line[\s\S]*?<\/p>/.exec(html)?.[0] ?? "";
    expect(statusLine).toContain("data-status-menu");
    expect(statusLine).not.toMatch(/<select|role="combobox"/);
    expect(html).not.toContain("Start working on it");
    expect(html).not.toContain("Stop working on it");
    expect(html).not.toContain("Show details");
  });
});

describe("the properties", () => {
  it("show people as chips and dates as relative times, never in mono, with no @handles", () => {
    const html = firstRead(render("drawer"));
    expect(html).toContain('data-person="dux-shell"');
    expect(html).toMatch(/<time dateTime="2026-09-01T22:40:00Z"/);
    expect(html).not.toContain("font-mono");
    expect(html).not.toContain("@dux-shell");
    expect(html).not.toContain("2026-09-01 22:40");
  });

  it("keep every raw value behind More details", () => {
    const html = render("drawer");
    const more = /<details[\s\S]*?<\/details>/.exec(html)?.[0] ?? "";
    expect(more).toContain("More details");
    expect(more).toContain(">STA-313<");
    expect(more).toContain(">in_progress<");
    expect(more).toContain(">orchestrator<");
    expect(more).toContain("2026-09-01 22:13");
  });

  it("sit in a compact two-column list in the drawer", () => {
    expect(render("drawer")).toContain('data-property-list="grid"');
  });
});

describe("the three presentations", () => {
  it("full page: a readable column and a properties rail", () => {
    const html = render("full");
    expect(html).toContain('data-detail-layout="page"');
    expect(html).toContain("lg:max-w-readable");
    expect(html).toContain("data-detail-rail");
    expect(html).toContain('data-property-list="rail"');
    expect(html).not.toContain('data-property-list="grid"');
  });

  it("drawer: one column, no rail", () => {
    const html = render("drawer");
    expect(html).toContain('data-detail-layout="drawer"');
    expect(html).not.toContain("data-detail-rail");
  });

  it("phone sheet: summary chips first, the rest inside More details, the title at heading size", () => {
    const html = render("sheet");
    expect(html).toContain('data-detail-layout="sheet"');
    expect(html).toContain("data-summary-chips");
    expect(html).toContain("text-heading");
    expect(firstRead(html)).not.toContain("data-property-list");
    // The status line sits under the title; on the phone its pill moves into the chips.
    expect(html.indexOf("data-status-sentence")).toBeLessThan(html.indexOf("data-summary-chips"));
  });

  it("phone sheet: the task's reference is printed on one line in the breadcrumb", () => {
    const tag = /<span[^>]*data-detail-identifier=""[^>]*>/.exec(render("sheet"))?.[0] ?? "";
    expect(tag).toContain("whitespace-nowrap");
    expect(tag).toContain("shrink-0");
  });

  it("names the parent by its title, not its id, in the breadcrumb", () => {
    const crumb = /<nav[^>]*data-detail-breadcrumb[\s\S]*?<\/nav>/.exec(render("sheet"))?.[0] ?? "";
    expect(crumb).toContain(">D: desktop UX overhaul</button>");
  });
});

describe("the tab strip", () => {
  it("uses plain names, and keeps the ids code keys off", () => {
    expect(TABS.map((tab) => [tab.id, tab.label])).toEqual([
      ["overview", "Details"],
      ["relations", "Connections"],
      ["documents", "Documents"],
      ["activity", "Activity"],
      ["agent", "For agents"],
      ["analytics", "Time"],
    ]);
  });

  it("is a scrollable segmented control on the phone and an underlined strip on a desk", () => {
    expect(render("sheet")).toContain('data-variant="default"');
    expect(render("sheet")).toContain("staple-detail-segments");
    expect(render("drawer")).toContain('data-variant="line"');
  });
});

describe("the Details tab", () => {
  it("renders the criteria as a checklist under a sentence-case heading", () => {
    const html = render("drawer");
    expect(html).toContain("data-criteria");
    expect(html).toContain(">Done when</h3>");
    expect(html).toContain("Sidebar reads as plain groups");
    expect(html).not.toMatch(/uppercase/);
  });

  it("does not print empty relation sections", () => {
    const html = render("drawer");
    expect(html).not.toContain(">none<");
    expect(html).not.toContain("Waiting on");
  });
});
