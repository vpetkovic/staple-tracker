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

const session = {
  open: () => {},
  mode: "hub",
  version: 0,
  workspaces: [{ slug: "staple", prefix: "STA" }, { slug: "alpha", prefix: "ALP" }],
} as unknown as StapleSession;

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

  it("reads as one sentence with real spaces round the dot and a lowercase 'just now'", () => {
    const html = render(ActivityTab, detail({ comments: [comment("c1", "VP", "user", "hi")] }));
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    const text = header.replace(/<[^>]+>/g, "");
    expect(text).toMatch(/^VP commented · just now$/);
    expect(text).not.toContain("Just now");
  });

  it("names the web app's own actor as a person would", () => {
    const html = render(ActivityTab, detail({ comments: [comment("c1", "ui", "user", "from the page")] }));
    expect(html).toContain(">Someone in the web app<");
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
    // Sub-task progress is said beside the list, once.
    expect(html).not.toContain("sub-tasks finished");
    expect(html).toContain("1 of 2 finished");
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

  it("names a blocker in another workspace by title and status, like any other row", () => {
    const html = render(
      RelationsTab,
      detail({
        crossBlockers: [
          { identifier: "ALP-1", workspace: "alpha", status: "in_progress", resolved: false, unresolvable: false, title: "Publish the API contract" },
          { identifier: "GAM-9", workspace: "gamma", status: null, resolved: false, unresolvable: true, title: null, missing: "workspace" },
          { identifier: "STA-9999", workspace: "staple", status: null, resolved: false, unresolvable: true, title: null, missing: "task" },
        ] as unknown as IssueDetail["crossBlockers"],
      }),
    );
    expect(html).toContain(">Publish the API contract<");
    expect(html).toContain("In Progress · in alpha");
    expect(html).not.toContain(">ALP-1<");
    // A workspace that is not here, and a task that is not in a workspace that IS here, are
    // two different facts with two different sentences (the wording the frame uses too).
    expect(html).toContain("GAM-9 is in gamma, which isn&#x27;t on this computer.");
    expect(html).toContain("Open that workspace on this computer, or remove the link if it no longer applies.");
    expect(html).toContain("STA-9999 can&#x27;t be found in staple.");
    expect(html).toContain("It may have been deleted or renamed. Remove the link if it no longer applies.");
    expect(html).not.toContain("staple, which isn");
    // Nothing to open, so not a button, and no guessed status.
    expect(html).not.toMatch(/<button[^>]*title="STA-9999/);
    expect(html).not.toContain("Status unknown");
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
    // "Updated just now · revision 3": lowercase mid-sentence, real spaces round the dot.
    const line = html.slice(html.indexOf("Updated"), html.indexOf("revision 3") + "revision 3".length).replace(/<[^>]+>/g, "");
    expect(line).toBe("Updated just now · revision 3");
    expect(html).toContain('aria-label="Document view"');
  });
});
