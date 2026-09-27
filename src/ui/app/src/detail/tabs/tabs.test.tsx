/**
 * What the Activity, Connections and Documents tabs put in the DOM on first render.
 *
 * Rendered with `react-dom/server`, like analytics-tab.test.tsx: no jsdom, so no effects
 * run and no request is made. That bounds the claims on purpose — these pin the SHAPE a
 * reader meets (a comment is a card and an event is not, a connection is a tappable row
 * with a title and a status word rather than a mono id, the map waits behind a toggle,
 * an empty tab says so in a sentence) and leave the fetched halves to the pure modules'
 * own tests (timeline.test.ts, relation-stats.test.ts).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { issue } from "@/components/task-list/fixtures";
import { SessionContext, type StapleSession } from "@/lib/session";
import type { IssueComment, IssueDetail, IssueTiming } from "@/lib/types";
import { ActivityTab } from "./ActivityTab";
import { DocumentsTab } from "./DocumentsTab";
import { RelationsTab } from "./RelationsTab";
import type { TabProps } from "./registry";

const timing = { subtreePlan: { estimatedSeconds: null, source: "none" } } as unknown as IssueTiming;

function detail(over: Partial<IssueDetail> = {}): IssueDetail {
  return {
    workspace: "staple",
    issue: issue({ identifier: "STA-50", title: "the focus" }),
    ancestors: [],
    children: [],
    blockedBy: [],
    blocks: [],
    comments: [],
    documents: [],
    crossBlockers: [],
    claim: null,
    timing,
    childrenTiming: {},
    gate: null,
    queuedBy: null,
    childrenQueued: [],
    ...over,
  };
}

const session = { open: () => {}, mode: "workspace", version: 0 } as unknown as StapleSession;

function render(Tab: (props: TabProps) => React.ReactNode, d: IssueDetail): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={session}>
      <Tab detail={d} workspace="staple" onAuthError={() => {}} refresh={() => {}} />
    </SessionContext.Provider>,
  );
}

const comment = (id: string, author: string, authorType: "agent" | "user", body: string): IssueComment => ({
  id,
  issueId: "id-50",
  author,
  authorType,
  body,
  idempotencyKey: null,
  deletedAt: null,
  createdAt: new Date().toISOString(),
});

describe("Activity", () => {
  it("draws a comment as a card with the person, under a day heading", () => {
    const html = render(
      ActivityTab,
      detail({ comments: [comment("c1", "opus-lane", "agent", "picked this up"), comment("c2", "VP", "user", "thanks")] }),
    );
    expect(html).toContain(">Today<");
    expect((html.match(/<li data-timeline-kind="comment"/g) ?? []).length).toBe(2);
    expect((html.match(/<article /g) ?? []).length).toBe(2);
    // People as a disc plus a name, agents marked, never as a mono handle.
    expect(html).toContain('data-person-disc="agent"');
    expect(html).toContain('data-person-disc="human"');
    expect(html).toContain(">agent<");
    expect(html).not.toContain("font-mono");
    expect(html).toContain("picked this up");
  });

  it("keeps the composer at the bottom, labelled for a screen reader", () => {
    const html = render(ActivityTab, detail({ comments: [comment("c1", "VP", "user", "hi")] }));
    expect(html.indexOf("data-timeline-kind")).toBeLessThan(html.indexOf('aria-label="Add a comment"'));
    expect(html).toContain(">Comment<");
  });
});

describe("Connections", () => {
  const busy = detail({
    ancestors: [issue({ identifier: "STA-40", title: "the parent epic", status: "in_progress" })],
    children: [
      issue({ identifier: "STA-51", title: "first sub-task", status: "done" }),
      issue({ identifier: "STA-52", title: "second sub-task", status: "todo" }),
    ],
    blockedBy: [
      { identifier: "STA-30", title: "an open blocker", status: "in_progress" },
      { identifier: "STA-31", title: "a finished blocker", status: "done" },
    ],
    blocks: [{ identifier: "STA-60", title: "waiting downstream", status: "todo" }],
  });

  it("opens on plain sentences, then readable lists, with the map behind a toggle", () => {
    const html = render(RelationsTab, busy);
    expect(html).toContain("Waiting on 1 task");
    expect(html).toContain("1 task is waiting on this");
    expect(html).toContain("1 of 2 sub-tasks finished");
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThanOrEqual(0);
      return index;
    };
    expect(at('data-testid="relations-summary"')).toBeLessThan(at('aria-label="Part of"'));
    expect(at('aria-label="Part of"')).toBeLessThan(at('aria-label="Sub-tasks"'));
    expect(at('aria-label="Sub-tasks"')).toBeLessThan(at('aria-label="Waiting on"'));
    expect(at('aria-label="Waiting on"')).toBeLessThan(at('aria-label="Holding up"'));
    // The map is secondary: a closed toggle, and no canvas drawn until it is opened.
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(">Show map<");
    expect(html).not.toContain("staple-relations-canvas");
    expect(html).not.toContain("upstream total");
  });

  it("draws each connection as a tappable row with its title and status in words", () => {
    const html = render(RelationsTab, busy);
    for (const title of ["the parent epic", "first sub-task", "second sub-task", "an open blocker", "waiting downstream"]) {
      expect(html).toMatch(new RegExp(`<button type="button" title="STA-\\d+ · ${title}"`));
    }
    expect(html).toContain(">In Progress<");
    expect(html).not.toContain("font-mono");
    // The open blocker is listed before the finished one.
    expect(html.indexOf("an open blocker")).toBeLessThan(html.indexOf("a finished blocker"));
    expect(html).toContain('aria-valuenow="1"');
  });

  it("says a task with no connections stands on its own, instead of drawing an empty canvas", () => {
    const html = render(RelationsTab, detail());
    expect(html).toContain("data-empty-state");
    expect(html).toContain("This task stands on its own");
    expect(html).not.toContain("Show map");
  });
});

describe("Documents", () => {
  it("says there are no documents yet in a sentence", () => {
    const html = render(DocumentsTab, detail());
    expect(html).toContain("data-empty-state");
    expect(html).toContain("No documents yet.");
  });

  it("names documents by title or key, never as key@revision", () => {
    const html = render(
      DocumentsTab,
      detail({
        documents: [
          { issueId: "id-50", key: "plan", currentRevision: 3, title: null, updatedAt: new Date().toISOString() },
          { issueId: "id-50", key: "worklog", currentRevision: 2, title: null, updatedAt: new Date().toISOString() },
        ],
      }),
    );
    expect(html).toContain(">Plan</button>");
    expect(html).toContain(">Worklog</button>");
    expect(html).not.toContain("@r3");
    expect(html).toContain("revision 3");
    expect(html).toContain('aria-label="Document view"');
  });
});
