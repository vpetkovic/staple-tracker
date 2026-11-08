/**
 * Ideas and horizons in the shared drawer: the tab strip by kind and state, a header with no
 * ticket number, and actions that are exactly what the record's state offers (the payload's
 * `actions`, from the core lifecycle table).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { HorizonData, IdeaData, IdeaDetailData, OfferedAction } from "@/lib/plan-types";
import { SessionContext } from "@/lib/session";
import type { IssueDetail } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { detail, issue } from "./detail-fixture";
import type { DetailPresentation } from "./drawer";
import { DetailContent } from "./IssueDetailPanel";
import { useIssueActions } from "./IssueActions";
import { horizonActionItems, moveOffered, planActionItems, planPrimary } from "./plain-actions";
import { visibleTabs } from "./tabs/registry";
import { DocumentsTab } from "./tabs/DocumentsTab";
import { FilesTab } from "./tabs/FilesTab";
import { describeEvent } from "./timeline";
import { addressDrafts } from "@/lib/api";

const noop = () => {};
const ID = "1d4e7a52-0c6e-4b8e-9a51-3f1f3c0b9d21";

/** The rows of the core table the fixtures need, as the server sends them. */
const OFFERED: Record<string, OfferedAction[]> = {
  raw: [
    { id: "edit", label: "Edit title and brief", who: "anyone" },
    { id: "explore", label: "Start exploring", who: "person" },
    { id: "shape", label: "Mark shaped", who: "person" },
    { id: "drop", label: "Drop", who: "person" },
  ],
  shaped: [
    { id: "edit", label: "Edit title and brief", who: "anyone" },
    { id: "unshape", label: "Back to exploring", who: "person" },
    { id: "drop", label: "Drop", who: "person" },
    { id: "schedule", label: "Schedule on a horizon", who: "person" },
    { id: "promote", label: "Promote to epic", who: "anyone" },
    { id: "adopt", label: "Adopt existing work", who: "anyone" },
  ],
  started: [
    { id: "edit", label: "Edit title and brief", who: "anyone" },
    { id: "adopt", label: "Adopt existing work", who: "anyone" },
    { id: "unlink", label: "Unlink work", who: "anyone" },
    { id: "reset_baseline", label: "Reset baseline to the plan", who: "person" },
  ],
  shipped: [],
  dropped: [{ id: "restore", label: "Restore", who: "person" }],
};

function idea(state: keyof typeof OFFERED, patch: Partial<IdeaData> = {}): IdeaData {
  return {
    id: ID,
    identifier: null,
    promoted: false,
    kind: "idea",
    title: "Coach shares a program",
    description: null,
    maturity: state === "raw" || state === "dropped" ? state : "shaped",
    stage: state as IdeaData["stage"],
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 1024,
    links: [],
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    progress: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    childIds: [],
    openQuestions: 0,
    state: state as IdeaData["state"],
    actions: OFFERED[state]!,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  };
}

function record(view: IdeaData): IdeaDetailData {
  return { idea: view, parent: null, children: [], horizon: null, brief: "Read-only link.", questions: [], decisions: [], linked: [], today: "2026-11-08" };
}

/** An idea's detail as the page holds it: `draft: true`, addressed by its id (`getIssue`). */
function ideaDetail(view: IdeaData): IssueDetail {
  return detail({ issue: issue({ id: ID, identifier: view.identifier ?? ID, draft: view.identifier === null, kind: view.kind, title: view.title }), planRecord: record(view) });
}

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

function render(d: IssueDetail, presentation: DetailPresentation = "drawer"): string {
  return renderToStaticMarkup(
    <SessionContext.Provider value={fakeSession()}>
      <Content d={d} presentation={presentation} />
    </SessionContext.Provider>,
  );
}

describe("an idea in the shared drawer", () => {
  it("has the idea's tab strip: Plan, Connections, Documents, Files, Activity, For agents, Time", () => {
    const tabs = visibleTabs(ideaDetail(idea("raw")));
    expect(tabs.map((tab) => tab.id)).toEqual(["plan", "idea-connections", "documents", "files", "activity", "idea-agent", "plan-time"]);
    expect(tabs.map((tab) => tab.label)).toEqual(["Plan", "Connections", "Documents", "Files", "Activity", "For agents", "Time"]);
  });

  it("is the epic's strip once promoted, with the Plan tab kept for its plan actions", () => {
    const promoted = idea("started", { promoted: true, identifier: "LAR-90", kind: "epic" });
    expect(visibleTabs(ideaDetail(promoted)).map((tab) => tab.id)).toEqual(["overview", "plan", "relations", "documents", "files", "activity", "agent", "analytics"]);
  });

  it("never shows a ticket number or the record's id, in any presentation", () => {
    for (const presentation of ["drawer", "full", "sheet"] as const) {
      // What a person reads: the markup's text, and the titles a pointer shows. Data attributes
      // are keys for code and tests, not text.
      const html = render(ideaDetail(idea("shaped")), presentation);
      const read = html.replace(/<[^>]*?(title="([^"]*)")?[^>]*>/g, " $2 ");
      expect(read).toContain("Idea · Shaped");
      expect(read).not.toContain(ID);
      expect(read).not.toMatch(/\b[A-Z]{2,}-\d+\b/);
      expect(read).not.toContain("~");
    }
  });

  it("offers the step its state offers as the one primary action, and nothing its state does not", () => {
    // Raw's step forward is exploring; shaping it at once is in ⋯.
    expect(render(ideaDetail(idea("raw")))).toMatch(/data-plan-action="explore" data-plan-primary=""|data-plan-primary="" [^>]*data-plan-action="explore"/);
    const shaped = render(ideaDetail(idea("shaped")));
    expect(shaped).toContain('data-plan-action="promote"');
    expect(shaped).toContain("Promote to epic");
    const started = render(ideaDetail(idea("started", { linkCount: 1 })));
    expect(started).not.toContain('data-plan-action="promote"');
    expect(started).not.toContain("Promote to epic");
    const shipped = render(ideaDetail(idea("shipped")));
    expect(shipped).not.toContain("data-plan-action");
  });

  it("builds items from the offered actions alone: a disabled one says why, and a move needs its action", () => {
    const held = idea("shaped", { actions: [{ id: "promote", label: "Promote to epic", who: "anyone", disabledReason: "Held back for now." }] });
    const [promote] = planActionItems("ws", held);
    expect(promote).toMatchObject({ id: "promote", disabledReason: "Held back for now." });
    expect(promote!.call).toBeUndefined();
    expect(planPrimary(planActionItems("ws", idea("shipped")))).toBeNull();
    expect(moveOffered(idea("raw"), { maturity: "exploring" })).toBe(true);
    expect(moveOffered(idea("raw"), { maturity: "shaped" })).toBe(true);
    expect(moveOffered(idea("raw"), { horizon: "h1" })).toBe(false);
    expect(moveOffered(idea("shaped"), { horizon: "h1" })).toBe(true);
    expect(moveOffered(idea("started"), { maturity: "dropped" })).toBe(false);
  });
});

describe("an idea as the server sends it", () => {
  it("is addressed by its id, with its ancestors and children, so no request ever names null", () => {
    const sent = detail({
      issue: { ...issue({ id: ID, kind: "idea" }), identifier: null as unknown as string, draft: true },
      ancestors: [{ ...issue({ id: "parent-idea" }), identifier: null as unknown as string, draft: true }],
      children: [issue({ id: "child", identifier: "LAR-7" })],
    });
    const held = addressDrafts(sent);
    expect(held.issue).toMatchObject({ id: ID, identifier: ID, draft: true });
    expect(held.ancestors[0]).toMatchObject({ id: "parent-idea", identifier: "parent-idea" });
    expect(held.children[0]!.identifier).toBe("LAR-7");
  });
});

describe("a horizon in the shared drawer", () => {
  const horizon = (state: HorizonData["state"], actions: OfferedAction[]): HorizonData => ({
    id: "h1",
    identifier: "LAR-3",
    name: "Now · Beta",
    date: "2026-12-31",
    rank: 1024,
    status: "backlog",
    shipped: state === "shipped",
    memberCount: state === "planned" ? 0 : 2,
    ideaCount: 1,
    lateCount: 0,
    notStartedCount: 0,
    late: false,
    state,
    actions,
  });

  it("shows its state, the actions it offers and its ideas, on the milestone it is", () => {
    const active = horizon("active", [{ id: "queue", label: "Queue the horizon", who: "anyone" }]);
    const d = detail({ issue: issue({ id: "h1", identifier: "LAR-3", kind: "milestone", title: "Now · Beta" }), horizonPlan: { horizon: active, ideas: [idea("shaped", { horizonId: "h1" })] } });
    const html = render(d);
    expect(html).toContain('data-horizon-state="active"');
    expect(html).toContain('data-horizon-action="queue"');
    expect(html).not.toContain('data-horizon-action="remove"');
    expect(html).toContain("Coach shares a program");
    expect(horizonActionItems("ws", horizon("shipped", []))).toEqual([]);
  });

  it("says why an offered action is held back, in words on the page", () => {
    const queued = horizon("planned", [{ id: "remove", label: "Remove", who: "person", disabledReason: "It is in the queue; take it off first." }]);
    const d = detail({ issue: issue({ id: "h1", identifier: "LAR-3", kind: "milestone", title: "Now · Beta" }), horizonPlan: { horizon: queued, ideas: [] } });
    const read = render(d).replace(/<[^>]*>/g, " ");
    expect(read).toContain("It is in the queue; take it off first.");
  });
});

describe("the idea's tabs speak of an idea", () => {
  const tabProps = (d: IssueDetail) => ({ detail: d, workspace: "ws", onAuthError: noop, refresh: noop });
  it("says an idea was captured, and has no plan, notes or files 'on this ticket'", () => {
    const d = ideaDetail(idea("raw"));
    expect(describeEvent({ seq: 1, kind: "issue_created", actor: "vp", createdAt: "2026-11-01T00:00:00.000Z", payload: {} } as never, "idea")?.summary).toBe("captured this idea");
    expect(describeEvent({ seq: 1, kind: "issue_created", actor: "vp", createdAt: "2026-11-01T00:00:00.000Z", payload: {} } as never)?.summary).toBe("created this task");
    const docs = renderToStaticMarkup(<SessionContext.Provider value={fakeSession()}><DocumentsTab {...tabProps(d)} /></SessionContext.Provider>);
    expect(docs).toContain("No plan or notes on this idea yet.");
    const files = renderToStaticMarkup(<SessionContext.Provider value={fakeSession()}><FilesTab {...tabProps(d)} /></SessionContext.Provider>);
    expect(files).toContain("No files on this idea.");
  });
});

describe("the idea's header follows its state", () => {
  it("makes the title editable only where the state offers editing", () => {
    expect(render(ideaDetail(idea("raw")))).toContain("data-edit-title");
    expect(render(ideaDetail(idea("shaped")))).toContain("data-edit-title");
    for (const state of ["shipped", "dropped"] as const) {
      const html = render(ideaDetail(idea(state)));
      expect(html, state).not.toContain("data-edit-title");
      expect(html, state).toContain("Coach shares a program");
    }
  });
});
