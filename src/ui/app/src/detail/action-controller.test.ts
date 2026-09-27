/**
 * The write controller and the wiring the components use, driven with fakes: every tap sends
 * exactly its own item's request, each gate verb reaches its own route, the name the prompt
 * returned is the name on the request, and "who I am" never borrows the working name.
 */
import { describe, expect, it } from "vitest";
import type { StatusCategory } from "@/lib/types";
import { createActionController, gateHandlers, overflowEntries, primaryEntry, resolveActor, statusEntries, type ControllerDeps, type Names } from "./action-controller";
import { claim, detail, issue } from "./detail-fixture";
import { actionContextOf } from "./IssueActions";
import { SIGN, overflowItems, primaryItem, statusItems, toRequest, type ActionContext, type WriteCall } from "./plain-actions";

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

function ctx(d = detail({ issue: issue({ status: "todo", assignee: "vp" }) }), names: Names = { worker: null, person: null }): ActionContext {
  return { ...actionContextOf({ ...d, workspace: "exercises" }, names), order: Object.keys(CATEGORY), categoryOf: (s) => CATEGORY[s] ?? "unstarted", labelOf: (s) => s };
}

/** A controller over recording fakes. `answers` are what the prompt returns, in order. */
function harness(names: Names = { worker: null, person: null }, answers: Array<string | null> = []) {
  const sent: Array<{ fn: string; args: unknown[] }> = [];
  const asked: Array<{ prompt: string; prefill: string }> = [];
  const remembered: Array<[keyof Names, string]> = [];
  const record = (fn: string) => async (...args: unknown[]) => {
    sent.push({ fn, args });
    return {};
  };
  const deps: ControllerDeps = {
    post: { action: record("action"), requestGate: record("requestGate"), approveGate: record("approveGate"), requestGateChanges: record("requestGateChanges") },
    ask: (prompt, prefill) => {
      asked.push({ prompt, prefill });
      return answers.shift() ?? null;
    },
    names: () => names,
    remember: (which, name) => remembered.push([which, name]),
  };
  const controller = createActionController(deps);
  const run = async (call: WriteCall) => (await controller.run(call)).kind === "sent";
  return { controller, run, sent, asked, remembered };
}

/** What a request built from `call` looks like on the wire. */
function wire(call: WriteCall, actor: string | null) {
  const request = toRequest(call, actor);
  return request.fn === "action" ? { fn: "action", args: [request.target, request.payload] } : { fn: request.fn, args: [request.body] };
}

describe("tapping an item sends exactly that item's request", () => {
  it("every status in the menu, one at a time", async () => {
    const items = statusItems(ctx());
    const writable = items.filter((item) => item.call);
    expect(writable.length).toBeGreaterThan(2);
    for (const item of writable) {
      const h = harness({ worker: null, person: "VP" });
      const entry = statusEntries(items, h.run).find((e) => e.status === item.status)!;
      entry.select();
      await Promise.resolve();
      expect(h.sent, item.status).toEqual([wire(item.call!, "VP")]);
    }
  });

  it("every item in the ⋯ menu, and the one that opens the approval form opens it", async () => {
    const quiet = detail({ issue: issue({ status: "in_progress", checkoutAgent: "dux" }), claim: claim({ heldBy: "dux", idleSeconds: 7200 }), children: [issue({ id: "c1", identifier: "STA-2" })] });
    const items = overflowItems(ctx(quiet, { worker: null, person: "VP" }));
    for (const item of items) {
      const h = harness({ worker: null, person: "VP" }, ["ada"]);
      let opened = 0;
      overflowEntries(items, h.run, { requestApproval: () => opened++ }).find((e) => e.id === item.id)!.select();
      await Promise.resolve();
      if (item.id === "request-approval") expect([opened, h.sent.length]).toEqual([1, 0]);
      else expect(h.sent, item.id).toEqual([wire(item.call!, item.call!.actor.from === "worker-prompt" ? "ada" : "VP")]);
    }
  });

  it("the primary: Review opens the card; every other kind sends its own call", async () => {
    let reviewed = 0;
    const parked = detail({ issue: issue({ status: "awaiting_approval" }), gate: { state: "pending", owner: "VP", requestedBy: "l", requestedAt: "2026-09-01T00:00:00Z", resolvedBy: null, resolvedAt: null } });
    const h = harness();
    primaryEntry(primaryItem(ctx(parked)), h.run, () => reviewed++).click();
    expect([reviewed, h.sent.length]).toEqual([1, 0]);

    const held = detail({ issue: issue({ status: "in_progress", checkoutAgent: "dux", assignee: "dux" }), claim: claim({ heldBy: "dux" }) });
    const done = primaryItem(ctx(held));
    const h2 = harness({ worker: null, person: null });
    primaryEntry(done, h2.run, () => reviewed++).click();
    await Promise.resolve();
    expect(h2.sent).toEqual([wire(done.call!, null)]);
  });
});

describe("each gate verb reaches its own route", () => {
  const c = { ws: "exercises", issue: issue() };

  it("approve all and approve selected go to approve, send back to request-changes, ask to request", async () => {
    const h = harness({ worker: "codex-1", person: null }, ["VP", "VP", "VP", "VP"]);
    const handlers = gateHandlers(c, h.run);
    await handlers.approveAll();
    await handlers.approveSelected(["id-1"]);
    await handlers.requestChanges("fix it");
    await handlers.requestApproval("VP");
    expect(h.sent.map((s) => s.fn)).toEqual(["approveGate", "approveGate", "requestGateChanges", "requestGate"]);
    expect(h.sent[1]!.args[0]).toMatchObject({ ws: "exercises", children: ["id-1"], actor: "VP" });
    expect(h.sent[2]!.args[0]).toMatchObject({ comment: "fix it", actor: "VP" });
  });
});

describe("the name on a write", () => {
  it("is the name the prompt returned, carried all the way to the request", async () => {
    const h = harness({ worker: null, person: null }, ["ada"]);
    const start = primaryItem(ctx(detail({ issue: issue({ status: "todo" }) })));
    await h.run(start.call!);
    expect(h.sent).toEqual([{ fn: "action", args: [{ ws: "exercises", ref: "uuid-1", actor: "ada" }, { type: "checkout" }] }]);
    expect(h.remembered).toEqual([["worker", "ada"]]);
  });

  it("a decision is always confirmed, pre-filled with the person's own name, never the working name", async () => {
    const agentLast = harness({ worker: "codex-1", person: null }, ["VP"]);
    await gateHandlers({ ws: "exercises", issue: issue() }, agentLast.run).approveAll();
    expect(agentLast.asked).toEqual([{ prompt: SIGN.approve.prompt, prefill: "" }]);
    expect(agentLast.sent[0]!.args[0]).toMatchObject({ actor: "VP" });
    expect(agentLast.remembered).toEqual([["person", "VP"]]);

    const known = harness({ worker: "codex-1", person: "VP" }, ["VP"]);
    await gateHandlers({ ws: "exercises", issue: issue() }, known.run).requestChanges("again");
    expect(known.asked).toEqual([{ prompt: SIGN.sendBack.prompt, prefill: "VP" }]);
  });

  it("asks in words that fit: approving, sending back, asking", () => {
    expect(SIGN.approve.prompt).toBe("Who is approving? Type your own name.");
    expect(SIGN.sendBack.prompt).toBe("Who is sending it back? Type your own name.");
    expect(SIGN.ask.prompt).toBe("Who is asking? Type your own name.");
  });

  it("a status change carries the person's name, or none (the server's 'ui'), never the working name", async () => {
    const item = statusItems(ctx()).find((i) => i.call)!;
    const agentOnly = harness({ worker: "codex-1", person: null });
    await agentOnly.run(item.call!);
    expect(agentOnly.sent[0]!.args[0]).toEqual({ ws: "exercises", ref: "uuid-1" });
    const person = harness({ worker: "codex-1", person: "VP" });
    await person.run(item.call!);
    expect(person.sent[0]!.args[0]).toMatchObject({ actor: "VP" });
    expect(agentOnly.asked).toEqual([]);
  });

  it("a cancelled or empty name sends nothing and says why", async () => {
    for (const answer of [null, "   "]) {
      const h = harness({ worker: null, person: null }, [answer]);
      const outcome = await h.controller.run(primaryItem(ctx(detail({ issue: issue({ status: "todo" }) }))).call!);
      expect(outcome).toEqual({ kind: "cancelled", message: "Nothing was sent. Starting work needs a name." });
      expect(h.sent).toEqual([]);
    }
    const h = harness({ worker: null, person: "VP" }, [null]);
    expect(await h.controller.run({ route: "gate-approve", ws: "w", ref: "r", actor: SIGN.approve })).toEqual({ kind: "cancelled", message: "Nothing was sent. Approving needs your name." });
  });

  it("resolveActor keeps the two names apart", () => {
    const ask = () => "typed";
    expect(resolveActor({ from: "worker" }, { worker: "codex-1", person: "VP" }, ask)).toEqual({ actor: "codex-1" });
    expect(resolveActor({ from: "person" }, { worker: "codex-1", person: null }, ask)).toEqual({ actor: null });
  });

  it("a refusal comes back as refused, with the error", async () => {
    const deps: ControllerDeps = {
      post: { action: () => Promise.reject(new Error("409")), requestGate: async () => ({}), approveGate: async () => ({}), requestGateChanges: async () => ({}) },
      ask: () => null,
      names: () => ({ worker: null, person: null }),
      remember: () => {},
    };
    const outcome = await createActionController(deps).run(statusItems(ctx()).find((i) => i.call)!.call!);
    expect(outcome.kind).toBe("refused");
  });
});
