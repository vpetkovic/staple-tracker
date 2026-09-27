/**
 * The detail's write path as data: which call each item makes (verb, status, workspace,
 * actor), which items are held back and why, the status sentence, and the plain wording of a
 * refusal. The store-level proof that none of these is a guaranteed refusal is
 * actions-audit.test.tsx; this file pins the shapes precisely, without a server.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionContext } from "@/lib/session";
import type { IssueDetail, StatusCategory } from "@/lib/types";
import { fakeSession } from "@/views/fake-session";
import { claim, detail, issue } from "./detail-fixture";
import { IssueDetailPanel } from "./IssueDetailPanel";
import { PrimaryAction, StatusMenu, actionContextOf, useIssueActions } from "./IssueActions";
import {
  ACTION_WORDS,
  STATUS_DESCRIPTIONS,
  firstStatusIn,
  gateCalls,
  overflowItems,
  plainRefusal,
  primaryItem,
  resolveActor,
  statusChoices,
  statusItems,
  statusSentence,
  toRequest,
  type ActionContext,
  type SentenceInput,
  type WriteCall,
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

/** The context the components build, on a hub workspace that is not the default one. */
function ctx(d: IssueDetail, over: Partial<ActionContext> = {}): ActionContext {
  return { ...actionContextOf({ ...d, workspace: "exercises" }, "tester"), order: ORDER, categoryOf, labelOf: (s) => s, ...over };
}

const GATE = { state: "pending" as const, owner: "VP", requestedBy: "lead", requestedAt: "2026-09-01T22:00:00Z", resolvedBy: null, resolvedAt: null };
const HELD = (holder = "dux") => detail({ issue: issue({ status: "in_progress", checkoutAgent: holder, assignee: holder }), claim: claim({ heldBy: holder }) });
const QUEUED = { identifier: "STA-60", owner: "VP" } as IssueDetail["queuedBy"];
const BLOCKER = { identifier: "STA-2", title: "Before", status: "todo" as const };

/** Every call an item list makes. */
const calls = (items: Array<{ call?: WriteCall }>) => items.flatMap((item) => (item.call ? [item.call] : []));

describe("the status menu's writes", () => {
  it("sends the status that was chosen, never the current one", () => {
    const items = statusItems(ctx(detail({ issue: issue({ status: "todo", assignee: "vp" }) })));
    for (const item of items.filter((i) => i.call)) {
      expect(item.call).toMatchObject({ route: "action", payload: { type: "status", status: item.status } });
    }
    expect(items.find((i) => i.status === "done")?.call).toMatchObject({ payload: { type: "status", status: "done" } });
    expect(items.find((i) => i.current)?.call).toBeUndefined();
  });

  it("never offers the gated status: approval is asked for, not set", () => {
    const statuses = statusItems(ctx(detail({ issue: issue({ status: "todo" }) }))).map((i) => i.status);
    expect(statuses).not.toContain("awaiting_approval");
  });

  it("offers nothing else while the task waits for approval", () => {
    const items = statusItems(ctx(detail({ issue: issue({ status: "awaiting_approval" }), gate: GATE })));
    expect(items.filter((i) => !i.current).every((i) => !i.call && i.disabledReason === "Approve it or send it back first.")).toBe(true);
  });

  it("holds back In Progress without an assignee or with an open blocker, and says why", () => {
    const bare = statusItems(ctx(detail({ issue: issue({ status: "todo" }) }))).find((i) => i.status === "in_progress")!;
    expect(bare).toMatchObject({ disabledReason: "Use Start work, so the tracker knows who is on it." });
    const blocked = statusItems(ctx(detail({ issue: issue({ status: "todo", assignee: "vp" }), blockedBy: [BLOCKER] }))).find((i) => i.status === "in_progress")!;
    expect(blocked).toMatchObject({ disabledReason: "Waiting on 1 other task to finish first." });
  });
});

describe("every write carries its workspace and its issue", () => {
  const states = [
    detail({ issue: issue({ status: "todo" }) }),
    HELD("tester"),
    detail({ issue: issue({ status: "in_progress", checkoutAgent: "dux" }), claim: claim({ heldBy: "dux", idleSeconds: 7200 }) }),
    detail({ issue: issue({ status: "done" }) }),
    detail({ issue: issue({ status: "in_review" }) }),
  ];

  it("on every item, for every state", () => {
    for (const state of states) {
      const c = ctx(state);
      for (const call of calls([primaryItem(c), ...overflowItems(c), ...statusItems(c)])) {
        expect(call.ws).toBe("exercises");
        expect(call.ref).toBe(state.issue.id);
      }
    }
  });

  it("through toRequest, for the action route and all three gate routes", () => {
    const c = ctx(detail());
    expect(toRequest(statusItems(c).find((i) => i.call)!.call!, "tester")).toMatchObject({ fn: "action", target: { ws: "exercises", ref: "uuid-1", actor: "tester" } });
    expect(toRequest(gateCalls.request(c, "VP"), "tester")).toEqual({ fn: "requestGate", body: { ws: "exercises", ref: "uuid-1", owner: "VP", actor: "tester" } });
    expect(toRequest(gateCalls.approveAll(c), "tester")).toEqual({ fn: "approveGate", body: { ws: "exercises", ref: "uuid-1", actor: "tester" } });
    expect(toRequest(gateCalls.approveSelected(c, ["id-1"]), "tester")).toEqual({ fn: "approveGate", body: { ws: "exercises", ref: "uuid-1", children: ["id-1"], actor: "tester" } });
    expect(toRequest(gateCalls.requestChanges(c, "fix it"), "tester")).toEqual({ fn: "requestGateChanges", body: { ws: "exercises", ref: "uuid-1", comment: "fix it", actor: "tester" } });
  });

  it("leaves the actor to the server's default only when there is no name", () => {
    expect(toRequest(statusItems(ctx(detail())).find((i) => i.call)!.call!, null)).toMatchObject({ target: { ws: "exercises" } });
    expect("actor" in (toRequest(statusItems(ctx(detail())).find((i) => i.call)!.call!, null) as { target: object }).target).toBe(false);
  });
});

describe("stopping work", () => {
  it("sends a release, as the remembered holder, when this browser is the holder", () => {
    const stop = overflowItems(ctx(HELD("tester"))).find((i) => i.id === "release")!;
    expect(stop.call).toMatchObject({ payload: { type: "release" }, actor: { from: "remembered" } });
    expect(toRequest(stop.call!, "tester")).toMatchObject({ fn: "action", target: { actor: "tester" }, payload: { type: "release" } });
  });

  it("is held back, honestly, when someone else holds the task", () => {
    const stop = overflowItems(ctx(HELD("dux"))).find((i) => i.id === "release")!;
    expect(stop.call).toBeUndefined();
    expect(stop.disabledReason).toBe("Only dux can stop. If dux goes quiet for 30 minutes, you can take it over.");
  });

  it("becomes Take it over and Free it up once the holder has gone quiet", () => {
    const quiet = detail({ issue: issue({ status: "in_progress", checkoutAgent: "dux" }), claim: claim({ heldBy: "dux", idleSeconds: 7200 }) });
    const c = ctx(quiet);
    expect(primaryItem(c).call).toMatchObject({ payload: { type: "checkout", stealIfIdleSeconds: 1800 }, actor: { from: "prompt" } });
    expect(overflowItems(c).find((i) => i.id === "free")?.call).toMatchObject({ payload: { type: "release", ifIdleSeconds: 1800 } });
    expect(overflowItems(c).find((i) => i.id === "release")).toBeUndefined();
  });
});

describe("the one primary action, chosen by state", () => {
  const primary = (d: IssueDetail, over: Partial<ActionContext> = {}) => primaryItem(ctx(d, over));

  it("is Start work on a claimable task, asking who is working", () => {
    expect(primary(detail({ issue: issue({ status: "todo" }) })).call).toMatchObject({ payload: { type: "checkout" }, actor: { from: "prompt", prompt: ACTION_WORDS.checkoutPrompt } });
  });

  it("is Mark done while held, in review, or active with nobody holding it", () => {
    expect(primary(HELD()).call).toMatchObject({ payload: { type: "status", status: "done" } });
    expect(primary(detail({ issue: issue({ status: "in_review" }) })).id).toBe("done");
    expect(primary(detail({ issue: issue({ status: "in_progress" }) })).id).toBe("done");
  });

  it("is Reopen on a finished task, into the first ready status (never into active)", () => {
    expect(primary(detail({ issue: issue({ status: "done" }) })).call).toMatchObject({ payload: { type: "status", status: "todo" } });
  });

  it("is Review while a gate is open", () => {
    expect(primary(detail({ issue: issue({ status: "awaiting_approval" }), gate: GATE })).id).toBe("review");
  });

  it("is Start work, held back with the reason, while queued or blocked", () => {
    expect(primary(detail({ issue: issue({ status: "todo" }), queuedBy: QUEUED }))).toMatchObject({ id: "start", disabledReason: "Waiting for VP to approve the parent task first." });
    expect(primary(detail({ issue: issue({ status: "todo" }), blockedBy: [BLOCKER, { ...BLOCKER, identifier: "STA-3" }] }))).toMatchObject({ id: "start", disabledReason: "Waiting on 2 other tasks to finish first." });
    expect(primary(detail({ issue: issue({ status: "todo" }), blockedBy: [{ ...BLOCKER, status: "done" }] })).call).toBeDefined();
  });

  it("finds the first status of a category in the configured order", () => {
    expect(firstStatusIn(["pairing", "shipped", "done"], (s) => (s === "pairing" ? "active" : "done"), ["done"])).toBe("shipped");
    expect(firstStatusIn(["todo"], () => "ready", ["done"])).toBeNull();
  });
});

describe("whose name a write carries", () => {
  const ask = (answer: string | null) => () => answer;
  it("asks for Start work and Take it over, and a cancelled prompt means do nothing", () => {
    expect(resolveActor({ from: "prompt", prompt: "?" }, "tester", ask("ada"))).toBe("ada");
    expect(resolveActor({ from: "prompt", prompt: "?" }, "tester", ask(null))).toBeUndefined();
    expect(resolveActor({ from: "prompt", prompt: "?" }, "tester", ask("  "))).toBeUndefined();
  });

  it("signs a gate decision with the remembered name, and asks only when there is none", () => {
    const call = gateCalls.approveAll(ctx(detail()));
    expect(resolveActor(call.actor, "tester", ask("never asked"))).toBe("tester");
    expect(resolveActor(call.actor, null, ask("VP"))).toBe("VP");
  });
});

describe("the status sentence", () => {
  const sentence = (d: IssueDetail, over: Partial<SentenceInput> = {}) =>
    statusSentence({ ...ctx(d), issue: d.issue, openBlockers: 0, ...over } as SentenceInput, categoryOf);

  it("names who is working on it and since when", () => {
    const held = detail({ issue: issue({ checkoutAgent: "dux-shell" }), claim: claim({ heldBy: "dux-shell", checkoutAt: "2026-09-01T22:40:00Z" }) });
    expect(sentence(held)).toMatchObject({ lead: "Being worked on by", person: { name: "dux-shell", kind: "agent" }, atPrefix: "started", at: "2026-09-01T22:40:00Z" });
  });

  it("says a silent holder has gone quiet", () => {
    const quiet = detail({ issue: issue({ checkoutAgent: "dux" }), claim: claim({ heldBy: "dux", idleSeconds: 7200 }) });
    expect(sentence(quiet)).toMatchObject({ tail: "has gone quiet", atPrefix: "last active", tone: "attention" });
  });

  it("says what a task waits on, whatever its status", () => {
    expect(sentence(detail({ issue: issue({ status: "todo" }) }), { openBlockers: 2 }).lead).toBe("Waiting on 2 other tasks");
    expect(sentence(detail({ issue: issue({ status: "in_review" }) }), { openBlockers: 1 }).lead).toBe("Waiting on 1 other task");
    const blocked = detail({ issue: issue({ status: "blocked", unblockOwner: "VP", unblockAction: "confirm the domain" }) });
    expect(sentence(blocked)).toMatchObject({ lead: "Waiting for", person: { name: "VP" }, tail: "to confirm the domain" });
  });

  it("names a queue's gate by the parent, never by its id", () => {
    const queued = detail({ issue: issue({ status: "todo" }), queuedBy: QUEUED });
    expect(sentence(queued, { queuedByParent: true }).tail).toBe("to approve the parent task");
    expect(sentence(queued, { queuedByTitle: "L: docs site" }).tail).toBe("to approve “L: docs site”");
    expect(JSON.stringify(sentence(queued, { queuedByParent: true }))).not.toContain("STA-60");
  });

  it("counts an open parent's finished children, and says when nobody holds an active task", () => {
    const parent = detail({ issue: issue({ status: "in_progress" }) });
    expect(sentence(parent, { childrenTotal: 4, childrenDone: 1 }).lead).toBe("1 of 4 tasks done");
    expect(sentence(parent).lead).toBe("Nobody is working on it right now");
  });

  it("never prints a raw status id", () => {
    for (const status of ORDER) {
      const words = sentence(detail({ issue: issue({ status: status as never }) }));
      expect(`${words.lead} ${words.tail ?? ""}`).not.toMatch(/_/);
    }
  });
});

describe("a refusal, said plainly", () => {
  it("translates the store's sentences a person would hit", () => {
    expect(plainRefusal("Cannot release: held by review-bot, not ui", "conflict")).toBe("Only review-bot can stop working on this.");
    expect(plainRefusal('Cannot set "awaiting_approval" directly — park the issue with `staple gate <ref> --owner <who>`', "validation")).toBe("To wait for someone's approval, use Ask for approval in the ⋯ menu.");
    expect(plainRefusal("Checkout refused: unresolved blockers WOR-1. Pick a different task.", "conflict")).toBe("This can't start until WOR-1 is finished.");
    expect(plainRefusal('Checkout refused: status is "in_review", expected one of todo, backlog, blocked.', "conflict")).toBe("This task can't be started from its current status.");
  });

  it("never passes a CLI command through as the plain sentence", () => {
    for (const code of ["conflict", "validation", "gated", "not_found", "other"]) expect(plainRefusal("run `staple approve X`", code)).not.toContain("staple");
  });
});

describe("the status control", () => {
  function Menu({ d }: { d: IssueDetail }) {
    const controller = useIssueActions(noop);
    return <StatusMenu detail={d} controller={controller} onRequestApproval={noop} />;
  }

  it("is one pill naming the status in words", () => {
    const html = renderToStaticMarkup(<Menu d={detail({ issue: issue({ status: "in_progress" }) })} />);
    expect(html).toContain("data-status-menu");
    expect(html).toContain("In Progress");
    expect(html).not.toContain(">in_progress<");
    expect((html.match(/<button/g) ?? []).length).toBe(1);
  });

  it("gives every kind of status a one-line meaning", () => {
    for (const text of Object.values(STATUS_DESCRIPTIONS)) expect(text).not.toMatch(/_/);
  });

  it("lists the workspace's own statuses, and always the task's current one", () => {
    expect(statusChoices(["todo", "doing", "done"], ["backlog"], "doing")).toEqual(["todo", "doing", "done"]);
    expect(statusChoices(["todo", "done"], ["backlog"], "pairing")).toEqual(["pairing", "todo", "done"]);
    expect(statusChoices([], ["backlog", "todo"], "todo")).toEqual(["backlog", "todo"]);
  });
});

describe("the primary action button", () => {
  function Primary({ d }: { d: IssueDetail }) {
    const controller = useIssueActions(noop);
    return <PrimaryAction detail={d} controller={controller} onReview={noop} />;
  }

  it("says what it does to the task, not the command's name", () => {
    const text = renderToStaticMarkup(<Primary d={detail({ issue: issue({ status: "todo" }) })} />).replace(/<[^>]+>/g, " ");
    expect(text).toContain("Start work");
    for (const jargon of [/\bcheckout\b/i, /\bclaim\b/i, /\brelease\b/i, /\bset status\b/i]) expect(text).not.toMatch(jargon);
  });

  it("is disabled and says why while queued", () => {
    const html = renderToStaticMarkup(<Primary d={detail({ issue: issue({ status: "todo" }), queuedBy: QUEUED })} />);
    expect(html).toContain("disabled");
    expect(html).toContain('title="Waiting for VP to approve the parent task first."');
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
