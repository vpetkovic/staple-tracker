/**
 * The detail's verbs and status line in plain words: one state-driven primary action, the
 * rest in ⋯, one status control whose menu explains each status, and a status sentence a
 * person can read. And the sheet's Previous/Next are 44×44 targets.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import type { IssueDetail, StatusCategory } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { claim, detail, issue } from "./detail-fixture";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { PrimaryAction, StatusMenu, actionStateOf, useIssueActions } from "./IssueActions";
import {
  ACTION_WORDS,
  STATUS_DESCRIPTIONS,
  firstStatusIn,
  primaryActionFor,
  statusChoices,
  statusSentence,
  type SentenceInput,
} from "./plain-actions";

const noop = () => {};

const CATEGORY: Record<string, StatusCategory> = {
  backlog: "unstarted",
  todo: "ready",
  in_progress: "active",
  in_review: "review",
  awaiting_approval: "gated",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};
const ORDER = Object.keys(CATEGORY);
const categoryOf = (status: string): StatusCategory => CATEGORY[status] ?? "unstarted";

const primary = (d: IssueDetail) => primaryActionFor(actionStateOf(d), ORDER, categoryOf);
const sentence = (d: IssueDetail, openBlockers = 0) =>
  statusSentence({ ...actionStateOf(d), issue: d.issue, openBlockers } as SentenceInput, categoryOf);

const GATE = { state: "pending" as const, owner: "VP", requestedBy: "lead", requestedAt: "2026-09-01T22:00:00Z", resolvedBy: null, resolvedAt: null };

describe("the one primary action, chosen by state", () => {
  it("is Start work on an open task nobody holds", () => {
    expect(primary(detail({ issue: issue({ status: "todo" }) }))).toEqual({ kind: "start", label: ACTION_WORDS.checkout });
  });

  it("is Mark done while somebody works on it, moving to the first finished status", () => {
    const held = detail({ issue: issue({ status: "in_progress", checkoutAgent: "dux" }), claim: claim({ heldBy: "dux" }) });
    expect(primary(held)).toMatchObject({ kind: "done", label: "Mark done", status: "done" });
  });

  it("is Reopen on a finished or cancelled task, back to the first ready status", () => {
    expect(primary(detail({ issue: issue({ status: "done" }) }))).toMatchObject({ kind: "reopen", status: "todo" });
    expect(primary(detail({ issue: issue({ status: "cancelled" }) }))).toMatchObject({ kind: "reopen", status: "todo" });
  });

  it("is Review while a review gate is open, whatever else is true", () => {
    const parked = detail({ issue: issue({ status: "awaiting_approval" }), gate: GATE });
    expect(primary(parked).kind).toBe("review");
  });

  it("is Take it over when the holder has gone quiet", () => {
    const quiet = detail({ issue: issue({ checkoutAgent: "dux" }), claim: claim({ heldBy: "dux", idleSeconds: 3 * 3600 }) });
    expect(primary(quiet).kind).toBe("take-over");
  });

  it("is Start work, disabled with the reason, while the task is queued behind a gate", () => {
    const queued = detail({ issue: issue({ status: "todo" }), queuedBy: { identifier: "STA-60", owner: "VP" } as IssueDetail["queuedBy"] });
    expect(primary(queued)).toMatchObject({ kind: "start", disabledReason: "Waiting for VP to approve STA-60 first." });
  });

  it("finds the first status of a category in the configured order", () => {
    expect(firstStatusIn(["pairing", "shipped", "done"], (s) => (s === "pairing" ? "active" : "done"), ["done"])).toBe("shipped");
    expect(firstStatusIn(["todo"], () => "ready", ["done"])).toBeNull();
  });
});

describe("the status sentence", () => {
  it("names who is working on it and since when", () => {
    const held = detail({ issue: issue({ checkoutAgent: "dux-shell" }), claim: claim({ heldBy: "dux-shell", checkoutAt: "2026-09-01T22:40:00Z" }) });
    expect(sentence(held)).toMatchObject({ lead: "Being worked on by", person: { name: "dux-shell", kind: "agent" }, atPrefix: "started", at: "2026-09-01T22:40:00Z" });
  });

  it("says a silent holder has gone quiet, and asks for attention", () => {
    const quiet = detail({ issue: issue({ checkoutAgent: "dux" }), claim: claim({ heldBy: "dux", idleSeconds: 7200 }) });
    expect(sentence(quiet)).toMatchObject({ tail: "has gone quiet", atPrefix: "last active", tone: "attention" });
  });

  it("says who a blocked task waits for, and what they must do", () => {
    const blocked = detail({ issue: issue({ status: "blocked", unblockOwner: "VP", unblockAction: "confirm the domain" }) });
    expect(sentence(blocked)).toMatchObject({ lead: "Waiting for", person: { name: "VP" }, tail: "to confirm the domain" });
    expect(sentence(detail({ issue: issue({ status: "blocked" }) }), 2).lead).toBe("Waiting on 2 other tasks");
  });

  it("says when a task finished, and who a gate waits for", () => {
    expect(sentence(detail({ issue: issue({ status: "done", completedAt: "2026-09-02T10:00:00Z" }) }))).toMatchObject({ lead: "Finished", at: "2026-09-02T10:00:00Z" });
    expect(sentence(detail({ issue: issue({ status: "awaiting_approval" }), gate: GATE }))).toMatchObject({ lead: "Waiting for", person: { name: "VP", kind: "human" }, tail: "to approve" });
  });

  it("never prints a raw status id", () => {
    for (const status of ORDER) {
      const words = sentence(detail({ issue: issue({ status: status as never }) }));
      expect(`${words.lead} ${words.tail ?? ""}`).not.toMatch(/_/);
    }
  });
});

describe("the status control", () => {
  function Menu({ d }: { d: IssueDetail }) {
    const controller = useIssueActions(d.issue, "staple", noop);
    return <StatusMenu issue={d.issue} controller={controller} />;
  }

  it("is one pill naming the status in words, not a select plus an apply button", () => {
    const html = renderToStaticMarkup(<Menu d={detail({ issue: issue({ status: "in_progress" }) })} />);
    expect(html).toContain("data-status-menu");
    expect(html).toContain("In Progress");
    expect(html).not.toContain(">in_progress<");
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });

  it("gives every kind of status a one-line meaning", () => {
    for (const text of Object.values(STATUS_DESCRIPTIONS)) {
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toMatch(/_/);
    }
  });

  it("offers the workspace's own statuses, and always the task's current one", () => {
    expect(statusChoices(["todo", "doing", "done"], ["backlog"], "doing")).toEqual(["todo", "doing", "done"]);
    expect(statusChoices(["todo", "done"], ["backlog"], "pairing")).toEqual(["pairing", "todo", "done"]);
    expect(statusChoices([], ["backlog", "todo"], "todo")).toEqual(["backlog", "todo"]);
  });
});

describe("the primary action button", () => {
  function Primary({ d }: { d: IssueDetail }) {
    const controller = useIssueActions(d.issue, "staple", noop);
    return <PrimaryAction detail={d} controller={controller} onReview={noop} />;
  }

  it("says what it does to the task, not the command's name", () => {
    const text = renderToStaticMarkup(<Primary d={detail({ issue: issue({ status: "todo" }) })} />).replace(/<[^>]+>/g, " ");
    expect(text).toContain("Start work");
    for (const jargon of [/\bcheckout\b/i, /\bclaim\b/i, /\brelease\b/i, /\bset status\b/i]) expect(text).not.toMatch(jargon);
  });

  it("is disabled and says why while queued", () => {
    const html = renderToStaticMarkup(<Primary d={detail({ issue: issue({ status: "todo" }), queuedBy: { identifier: "STA-60", owner: "VP" } as IssueDetail["queuedBy"] })} />);
    expect(html).toContain("disabled");
    expect(html).toContain('title="Waiting for VP to approve STA-60 first."');
  });
});

describe("the sheet's Previous and Next", () => {
  const panel = (presentation: "sheet" | "drawer") =>
    renderToStaticMarkup(
      <SessionContext.Provider value={fakeSession()}>
        <IssueDetailPanel
          selection={{ workspace: "staple", ref: "STA-60" }}
          mode="drawer"
          presentation={presentation}
          onToggleMode={noop}
          nav={{ prev: null, next: null, index: -1, total: 0 }}
          onNavigate={noop}
          onClose={noop}
          onAuthError={noop}
        />
      </SessionContext.Provider>,
    );
  const navClass = (html: string, direction: string) =>
    new RegExp(`<button[^>]*data-detail-nav="${direction}"[^>]*>`).exec(html)?.[0].match(/class="([^"]*)"/)?.[1] ?? "";

  it("are full 44×44 targets on the phone sheet", () => {
    const html = panel("sheet");
    for (const direction of ["prev", "next"]) expect(navClass(html, direction).split(" ")).toContain("size-11");
  });

  it("keep the desktop drawer's compact buttons, widened only under a finger", () => {
    const html = panel("drawer");
    for (const direction of ["prev", "next"]) {
      const classes = navClass(html, direction).split(" ");
      expect(classes).not.toContain("size-11");
      expect(classes).toContain("pointer-coarse:min-w-11");
    }
  });
});
