/**
 * The Instructions section of the Details tab (`InstructionsSection.tsx`): what an agent is
 * handed with the ticket, and from where. Rendered with `react-dom/server`, like tabs.test.tsx:
 * the shape a reader meets on first render, no effects.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext, type StapleSession } from "@/lib/session";
import type { IssueDetail, ResolvedInstruction } from "@/lib/types";
import { detail, issue } from "./detail-fixture";
import { OverviewTab } from "./tabs/OverviewTab";

const session = {
  open: () => {},
  mode: "hub",
  version: 0,
  workspaces: [{ slug: "staple", prefix: "STA" }],
} as unknown as StapleSession;

function render(d: IssueDetail): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={session}>
      <OverviewTab detail={d} workspace="staple" onAuthError={() => {}} refresh={() => {}} />
    </SessionContext.Provider>,
  );
}

const parent = { kind: "parent", ref: "STA-10", issueId: "e", title: "The epic", runId: null } as const;
const milestone = { kind: "milestone", ref: "STA-9", issueId: "m", title: "October", runId: null } as const;

function entry(over: Partial<ResolvedInstruction>): ResolvedInstruction {
  return { key: "rules", revision: 1, title: null, body: "Stack every PR.", author: "vp", updatedAt: "2026-11-01T10:00:00Z", source: parent, effective: true, shadowedBy: null, ...over };
}

describe("the Instructions section", () => {
  it("is not drawn when nothing reaches the ticket", () => {
    const html = render(detail({ instructions: [] }));
    expect(html).not.toContain('data-instructions=""');
  });

  it("lists each inherited instruction with its source, its body, and which one a shared key resolves to", () => {
    const html = render(
      detail({
        instructions: [
          entry({}),
          entry({ source: milestone, body: "Milestone rules.", effective: false, shadowedBy: parent }),
          entry({ key: "review", body: "A skeptic reviews it.", source: milestone, revision: 3 }),
        ],
      }),
    );
    expect(html).toContain('data-instructions=""');
    expect(html).toContain("Instructions");
    expect(html).toContain('data-instruction-source="STA-10"');
    expect(html).toContain('data-instruction-source="STA-9"');
    expect(html).toContain("Stack every PR.");
    expect(html).toContain("A skeptic reviews it.");
    expect(html).toContain("Version 3");
    expect(html).toContain('data-effective="false"');
    expect(html).toContain("Not in effect: parent STA-10 sets");
    expect(html).toContain("nearest first");
  });

  it("on an epic, says its own are handed to everything inside it", () => {
    const html = render(
      detail({
        issue: issue({ kind: "epic", identifier: "STA-10" }),
        instructions: [entry({ source: { kind: "self", ref: "STA-10", issueId: "e", title: "The epic", runId: null } })],
      }),
    );
    expect(html).toContain("This epic");
    expect(html).toContain("Handed to every agent that works this epic or anything inside it.");
    expect(html).toContain("Open in Documents");
  });
});
