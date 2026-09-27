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
  queueAheadOf,
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
  return { ...actionContextOf({ ...d, workspace: "exercises" }, { worker: "tester", person: null }), order: ORDER, categoryOf, labelOf: (s) => s, ...over };
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
    expect(stop.call).toMatchObject({ payload: { type: "release" }, actor: { from: "worker" } });
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
    expect(primaryItem(c).call).toMatchObject({ payload: { type: "checkout", stealIfIdleSeconds: 1800 }, actor: { from: "worker-prompt" } });
    expect(overflowItems(c).find((i) => i.id === "free")?.call).toMatchObject({ payload: { type: "release", ifIdleSeconds: 1800 } });
    expect(overflowItems(c).find((i) => i.id === "release")).toBeUndefined();
  });
});

describe("the one primary action, chosen by state", () => {
  const primary = (d: IssueDetail, over: Partial<ActionContext> = {}) => primaryItem(ctx(d, over));

  it("is Start work on a claimable task, asking who is working", () => {
    expect(primary(detail({ issue: issue({ status: "todo" }) })).call).toMatchObject({ payload: { type: "checkout" }, actor: { from: "worker-prompt", prompt: ACTION_WORDS.checkoutPrompt } });
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

describe("whose name a write carries (the controller resolves it; see action-controller.test.ts)", () => {
  it("claims carry the working name; status changes and decisions carry the person", () => {
    const c = ctx(detail({ issue: issue({ status: "todo", assignee: "vp" }) }));
    expect(primaryItem(c).call?.actor.from).toBe("worker-prompt");
    expect(statusItems(c).find((i) => i.call)?.call?.actor).toEqual({ from: "person" });
    expect(gateCalls.approveAll(c).actor.from).toBe("person-confirm");
    expect(gateCalls.requestChanges(c, "x").actor.from).toBe("person-confirm");
    expect(gateCalls.request(c, "VP").actor.from).toBe("person-confirm");
  });
});

describe("what a task waits on, beyond this workspace", () => {
  const cross = (over: Record<string, unknown> = {}) => ({ identifier: "EXE-9", workspace: "exercises-api", status: "todo", resolved: false, unresolvable: false, ...over });

  it("holds Start work back for an open blocker in another workspace, as the queue does", () => {
    expect(primaryItem(ctx(detail({ issue: issue({ status: "todo" }), crossBlockers: [cross()] })))).toMatchObject({ id: "start", disabledReason: "Waiting on 1 other task to finish first." });
  });

  it("says a blocker this computer can't see plainly, never 'to finish'", () => {
    const gone = detail({ issue: issue({ status: "todo" }), crossBlockers: [cross({ identifier: "STA-9999", workspace: "staple", status: null, unresolvable: true })] });
    const withWs = { ...actionContextOf({ ...gone, workspace: "exercises" }, { worker: null, person: null }, { workspaces: ["staple"] }), order: ORDER, categoryOf, labelOf: (s: string) => s };
    expect(withWs.unreachable).toEqual([{ identifier: "STA-9999", workspace: "staple", missing: "task" }]);
    expect(primaryItem(withWs).disabledReason).toBe("Waiting on STA-9999, which can't be found in staple.");
    expect(statusSentence({ ...withWs, issue: gone.issue, openBlockers: 1 } as SentenceInput, categoryOf).lead).toBe("Waiting on STA-9999, which can't be found in staple");
    const noWs = actionContextOf({ ...gone, workspace: "exercises" }, { worker: null, person: null }, { workspaces: [] });
    expect(noWs.unreachable[0]!.missing).toBe("workspace");
    expect(statusSentence({ ...noWs, categoryOf, issue: gone.issue, openBlockers: 1 } as SentenceInput, categoryOf).lead).toBe("Waiting on STA-9999 in staple, which isn't on this computer");
    const told = actionContextOf({ ...gone, crossBlockers: [{ ...gone.crossBlockers[0]!, missing: "workspace" } as never], workspace: "exercises" }, { worker: null, person: null }, { workspaces: ["staple"] });
    expect(told.unreachable[0]!.missing).toBe("workspace");
  });
});

describe("the strict queue", () => {
  const rows = [
    { issueId: "a", identifier: "STA-28", title: "Queue head", position: 1, unqueued: false, eligibility: "eligible" },
    { issueId: "uuid-1", identifier: "STA-88", title: "This", position: 5, unqueued: true, eligibility: "eligible" },
  ];

  it("finds the row that must be taken first, as the store's order check does", () => {
    expect(queueAheadOf(rows, "uuid-1")).toEqual({ identifier: "STA-28", title: "Queue head" });
    expect(queueAheadOf([{ ...rows[0]!, eligibility: "claimed" }, rows[1]!], "uuid-1")).toBeNull();
    expect(queueAheadOf(rows, "a")).toBeNull();
  });

  it("says the task is next up after the queue's head, not 'Ready to pick up'", () => {
    const d = detail({ issue: issue({ status: "todo" }) });
    const c = ctx(d, { queueAhead: { identifier: "STA-28", title: "Queue head" } });
    expect(statusSentence({ ...c, issue: d.issue, openBlockers: 0 } as SentenceInput, categoryOf).lead).toBe("Next up after “Queue head”");
  });

  it("holds Start work and In Progress back, naming the head by its title", () => {
    const c = ctx(detail({ issue: issue({ status: "todo", assignee: "vp" }) }), { queueAhead: { identifier: "STA-28", title: "Queue head" } });
    expect(primaryItem(c).disabledReason).toBe("“Queue head” is next in the queue.");
    expect(statusItems(c).find((i) => i.status === "in_progress")?.disabledReason).toBe("“Queue head” is next in the queue.");
  });
});

describe("a queued child never gets a way round its parent's gate", () => {
  it("holds In Progress back with the gate's reason, with or without an assignee", () => {
    for (const assignee of [null, "vp"]) {
      const c = ctx(detail({ issue: issue({ status: "todo", assignee }), queuedBy: QUEUED }));
      expect(statusItems(c).find((i) => i.status === "in_progress")).toMatchObject({ disabledReason: "Waiting for VP to approve the parent task first." });
      expect(statusItems(c).find((i) => i.status === "in_progress")?.call).toBeUndefined();
    }
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
  it("words every refusal code, including the strict queue's", () => {
    expect(plainRefusal("STA-294 is later in the queue than STA-28, which is ready. Take STA-28, or ask a human to reorder or override.", "out_of_order")).toBe("STA-28 is next in the queue. Take that first, or change the queue's order.");
    for (const code of ["out_of_order", "gated", "revision_conflict", "cycle", "duplicate", "auth", "forbidden", "revoked", "rate_limited", "unavailable", "offline", "payload_too_large", "epoch_changed", "cursor_invalid", "schema_ahead", "protocol_unsupported"]) {
      expect(plainRefusal("x", code), code).not.toBe("That didn't go through.");
    }
  });

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

/**
 * THE HOLD-BACK MATRIX. Every write the page can offer that STARTS work (a checkout, a takeover,
 * or a status into the active category) meets the store's start checks: a gate above it, open
 * blockers, the strict queue. This walks every hold-back reason against every claim state and
 * every status, and asserts nothing that starts work is ever offered while a reason applies,
 * and that the item says that reason.
 */
describe("no offered write can meet a hold-back the page ignores", () => {
  const REASONS: Array<[string, Partial<ActionContext>, string]> = [
    ["queued behind a gate", { queuedBy: QUEUED }, "Waiting for VP to approve the parent task first."],
    ["an open blocker", { openBlockers: 1 }, "Waiting on 1 other task to finish first."],
    ["a blocker this computer can't see", { openBlockers: 1, unreachable: [{ identifier: "GAM-1", workspace: "gamma", missing: "workspace" }] }, "Waiting on GAM-1 in gamma, which isn't on this computer."],
    ["the strict queue", { queueAhead: { identifier: "STA-28", title: "Queue head" } }, "“Queue head” is next in the queue."],
  ];
  const CLAIMS: Array<[string, Partial<IssueDetail>, Partial<ActionContext>]> = [
    ["nobody", {}, {}],
    ["held by someone", { claim: claim({ heldBy: "dux" }) }, {}],
    ["held by a quiet holder", { claim: claim({ heldBy: "dux", idleSeconds: 7200 }) }, {}],
    ["held by me", { claim: claim({ heldBy: "tester" }) }, { worker: "tester" }],
  ];
  const starts = (call: WriteCall | undefined) =>
    call?.route === "action" && (call.payload.type === "checkout" || (call.payload.type === "status" && CATEGORY[call.payload.status] === "active"));

  for (const [reasonName, reason, words] of REASONS) {
    for (const [claimName, claimDetail, claimCtx] of CLAIMS) {
      for (const status of ORDER) {
        it(`${reasonName} · ${claimName} · ${status}`, () => {
          const holder = claimDetail.claim?.heldBy ?? null;
          const d = detail({ issue: issue({ status: status as never, assignee: "vp", checkoutAgent: status === "in_progress" ? holder : null }), ...(status === "in_progress" ? claimDetail : {}) });
          const c = ctx(d, { ...claimCtx, ...reason, stale: status === "in_progress" && (claimDetail.claim?.idleSeconds ?? 0) >= 1800 });
          const items = [primaryItem(c), ...overflowItems(c), ...statusItems(c)];
          for (const item of items) {
            expect(starts(item.call), `${"id" in item ? item.id : item.status} is offered`).toBe(false);
          }
          for (const item of items.filter((i) => ("id" in i ? i.id === "start" || i.id === "take-over" : CATEGORY[i.status] === "active" && !i.current))) {
            if (!item.call && item.disabledReason && !/^Approve it/.test(item.disabledReason)) expect(item.disabledReason).toBe(words);
          }
        });
      }
    }
  }
});
