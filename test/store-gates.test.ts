import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError, errorEnvelope } from "../src/core/types.js";

/**
 * STA-143 — approval gates in the store.
 *
 * A parent with children can be PARKED behind a human review gate. While it is
 * parked it carries `awaiting_approval`, everything open underneath derives
 * `queuedBy`, checkout of a queued issue is refused, and the inbox lists the
 * whole lot in a third bucket that is never `ready`.
 *
 * What is pinned here is the SEMANTICS, not the plumbing: which calls are
 * refused and why, what a gate does to the derivation ladder, exactly when a
 * child stops being queued, and the fact that every gate transition still leaves
 * a log the timing replay can read back.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
beforeEach(() => {
  store = memStore();
});

function statusOf(ref: string): string {
  return store.getIssue(ref).status;
}

function eventKinds(ref: string): string[] {
  const id = store.getIssue(ref).id;
  return store
    .listEvents(0, 1000)
    .filter((e) => e.issueId === id)
    .map((e) => e.kind);
}

/** An epic with `count` backlog children, the shape every gate needs. */
function epicWithChildren(count = 2): { epic: string; children: string[] } {
  const epic = store.createIssue({ title: "Epic" }).identifier;
  const children = Array.from({ length: count }, (_, i) =>
    store.createChild(epic, { title: `Child ${i + 1}` }).identifier,
  );
  return { epic, children };
}

/** Walk a ticket all the way to `done`, the way the guards insist on. */
function resolve(ref: string, to: "done" | "cancelled" = "done"): void {
  if (to === "done") {
    store.updateIssue(ref, { assignee: "someone" }, "someone");
    store.updateIssue(ref, { status: "in_progress" }, "someone");
  }
  store.updateIssue(ref, { status: to }, "someone");
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return errorEnvelope(error).code;
  }
  throw new Error("expected a throw");
}

// --------------------------------------------------------------- gate

describe("gate parks a parent and records who must answer", () => {
  it("moves the parent to awaiting_approval with the owner recorded", () => {
    const { epic } = epicWithChildren();
    const parked = store.gateIssue(epic, { owner: "VP" }, "agent-a");

    expect(parked.status).toBe("awaiting_approval");
    const gate = store.gate(epic)!;
    expect(gate.state).toBe("pending");
    expect(gate.owner).toBe("VP");
    expect(gate.requestedBy).toBe("agent-a");
    expect(gate.requestedAt).not.toBe("");
    // Not resolved yet, and "not yet" is a null rather than an empty string —
    // the same distinction estimatedSeconds draws between absent and zero.
    expect(gate.resolvedBy).toBeNull();
    expect(gate.resolvedAt).toBeNull();
  });

  it("clears the claim, because nobody is working a parked parent", () => {
    const { epic } = epicWithChildren();
    store.checkoutIssue(epic, "agent-a");
    expect(store.getIssue(epic).checkoutAgent).toBe("agent-a");

    store.gateIssue(epic, { owner: "VP" }, "agent-a");

    const parked = store.getIssue(epic);
    expect(parked.checkoutAgent).toBeNull();
    expect(parked.checkoutAt).toBeNull();
    // The claim is gone, so no liveness, so nothing to look stale and nothing
    // for another agent to "rescue". That is the STA-108 failure mode closed.
    expect(store.claimActivity(epic)).toBeNull();
    // The assignee survives: who owns the work is still true while it waits.
    expect(parked.assignee).toBe("agent-a");
  });

  it("refuses a leaf — there would be nothing to queue", () => {
    const leaf = store.createIssue({ title: "Leaf" }).identifier;
    expect(() => store.gateIssue(leaf, { owner: "VP" }, "a")).toThrow(StapleError);
    expect(codeOf(() => store.gateIssue(leaf, { owner: "VP" }, "a"))).toBe("validation");
    expect(() => store.gateIssue(leaf, { owner: "VP" }, "a")).toThrow(/no children/);
    // …and it points at the status that DOES mean "leaf awaiting a human".
    expect(() => store.gateIssue(leaf, { owner: "VP" }, "a")).toThrow(/in_review/);
  });

  it("refuses an owner-less gate: a gate with nobody to chase is a dead end", () => {
    const { epic } = epicWithChildren();
    expect(codeOf(() => store.gateIssue(epic, { owner: "  " }, "a"))).toBe("validation");
  });

  it("refuses a second gate while one is still PENDING", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    // Nobody gets to move the owner out from under a reviewer mid-read.
    expect(codeOf(() => store.gateIssue(epic, { owner: "someone-else" }, "b"))).toBe("conflict");
    expect(store.gate(epic)!.owner).toBe("VP");
  });

  it("ALLOWS re-gating after request-changes — that is the resubmit loop", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "split the migration out" }, "VP");

    // The reviewer said fix it; somebody fixed it; this is how it goes back.
    // Refusing here would leave the subtree queued behind an objection with no
    // way to answer it.
    expect(() => store.gateIssue(epic, { owner: "VP" }, "agent-a")).not.toThrow();
    expect(statusOf(epic)).toBe("awaiting_approval");
    const gate = store.gate(epic)!;
    expect(gate.state).toBe("pending");
    expect(gate.resolvedBy).toBeNull(); // the previous decision does not linger
    expect(store.queuedBy(children[0]!)).toEqual({ identifier: epic, owner: "VP" });
  });

  it("allows a NEW cycle once the previous gate was approved", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, {}, "VP");
    expect(() => store.gateIssue(epic, { owner: "VP" }, "a")).not.toThrow();
    expect(store.gate(epic)!.state).toBe("pending");
    expect(store.gate(epic)!.resolvedAt).toBeNull(); // the new cycle is clean
  });

  it("refuses to gate work that is already finished", () => {
    const { epic, children } = epicWithChildren(1);
    store.updateIssue(children[0]!, { status: "done" }, "a");
    store.updateIssue(epic, { status: "done" }, "a");
    expect(codeOf(() => store.gateIssue(epic, { owner: "VP" }, "a"))).toBe("conflict");
  });

  it("stores an optional comment with the request", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP", comment: "ready for your read" }, "agent-a");
    expect(store.listComments(store.getIssue(epic).id).map((c) => c.body)).toContain(
      "ready for your read",
    );
  });

  it("emits status_changed AND gate_requested, in that order", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "agent-a");
    // status_changed keeps the timing replay able to explain the row; the
    // gate_requested beside it carries the semantics status_changed has no
    // field for. Neither one alone is enough.
    expect(eventKinds(epic)).toEqual(["issue_created", "status_changed", "gate_requested"]);
  });
});

// --------------------------------------------------------------- queuedBy

describe("queuedBy: who is standing in whose queue", () => {
  it("queues every open descendant, not just direct children", () => {
    const { epic, children } = epicWithChildren(1);
    const grandchild = store.createChild(children[0]!, { title: "Grandchild" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    expect(store.queuedBy(children[0]!)).toEqual({ identifier: epic, owner: "VP" });
    expect(store.queuedBy(grandchild)).toEqual({ identifier: epic, owner: "VP" });
  });

  it("does not queue the gate holder itself", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    // It holds the queue; it does not stand in it.
    expect(store.queuedBy(epic)).toBeNull();
    expect(store.gate(epic)!.state).toBe("pending");
  });

  it("queues nothing when there is no gate anywhere above", () => {
    const { children } = epicWithChildren();
    expect(store.queuedBy(children[0]!)).toBeNull();
  });

  it("names the NEAREST gate when two are open above", () => {
    const outer = store.createIssue({ title: "Program" }).identifier;
    const inner = store.createChild(outer, { title: "Epic" }).identifier;
    const leaf = store.createChild(inner, { title: "Task" }).identifier;
    store.gateIssue(inner, { owner: "Lead" }, "a");
    store.gateIssue(outer, { owner: "VP" }, "a");

    expect(store.queuedBy(leaf)).toEqual({ identifier: inner, owner: "Lead" });
  });

  it("falls through to the OUTER gate once the inner one releases it", () => {
    const outer = store.createIssue({ title: "Program" }).identifier;
    const inner = store.createChild(outer, { title: "Epic" }).identifier;
    const leaf = store.createChild(inner, { title: "Task" }).identifier;
    store.gateIssue(inner, { owner: "Lead" }, "a");
    store.gateIssue(outer, { owner: "VP" }, "a");

    store.approveGate(inner, { children: [leaf] }, "Lead");

    // A release is granted by ONE reviewer and says nothing about the other's.
    expect(store.queuedBy(leaf)).toEqual({ identifier: outer, owner: "VP" });
  });

  it("carries a release down the whole released subtree", () => {
    const { epic, children } = epicWithChildren(1);
    const grandchild = store.createChild(children[0]!, { title: "Grandchild" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    store.approveGate(epic, { children: [children[0]!] }, "VP");

    // Releasing a branch and leaving its subtasks queued would release nothing
    // anyone could actually work.
    expect(store.queuedBy(children[0]!)).toBeNull();
    expect(store.queuedBy(grandchild)).toBeNull();
  });

  it("batches identically to the single-issue read", () => {
    const { epic, children } = epicWithChildren(3);
    store.gateIssue(epic, { owner: "VP" }, "a");
    const ids = children.map((c) => store.getIssue(c).id);
    const batched = store.queuedByFor(ids);
    for (const child of children) {
      expect(batched.get(store.getIssue(child).id)).toEqual(store.queuedBy(child));
    }
  });

  /**
   * VP's review of Q4, 2026-09-02 (STA-154). Two eligibility rules, both of
   * which were missing and both of which VP hit on the same screen.
   */
  it("never queues a RESOLVED issue — a queue is a queue of work still to do", () => {
    const { epic, children } = epicWithChildren(2);
    // Gate first, land the work after: since STA-153 resolving every child first
    // would auto-close the epic, and `gate` refuses finished work. This is the
    // realistic order anyway — the queue drains while the reviewer is reading.
    store.gateIssue(epic, { owner: "VP" }, "a");
    resolve(children[0]!);
    resolve(children[1]!, "cancelled");

    // Nothing is being held back from anyone: the work is finished. A done row
    // reading "Queued · awaiting VP" is a lie the reviewer cannot act on, and it
    // was the noise that made the real queue unreadable.
    expect(store.queuedBy(children[0]!)).toBeNull();
    expect(store.queuedBy(children[1]!)).toBeNull();
  });

  it("does not queue a parent whose open subtree is EMPTY — it has nothing to release", () => {
    const { epic, children } = epicWithChildren(1);
    const parent = children[0]!;
    const a = store.createChild(parent, { title: "A" }).identifier;
    const b = store.createChild(parent, { title: "B" }).identifier;
    // `parent` is CHECKED OUT, which is what keeps it open after its children land:
    // since STA-153 a derivation-owned parent closes itself, and this rule is about
    // an OPEN parent with nothing left underneath. A claim is the ordinary way a row
    // stays open past its children — somebody is holding it.
    store.checkoutIssue(parent, "agent-p");
    resolve(a);
    resolve(b);
    store.gateIssue(epic, { owner: "VP" }, "a");

    // This is the STA-122 shape. Approving it releases nothing, so offering it
    // as a decision is offering a no-op — and the reviewer who takes it finds
    // the row unchanged and concludes the gate is broken.
    expect(store.queuedBy(parent)).toBeNull();
  });

  it("still queues an open LEAF, which has no subtree to be empty", () => {
    const { epic, children } = epicWithChildren(1);
    // The rule above is about a parent with nothing left underneath it. A leaf
    // IS the work, so the emptiness of its (non-existent) subtree says nothing.
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(store.queuedBy(children[0]!)).toEqual({ identifier: epic, owner: "VP" });
  });

  it("queues a parent whose only open descendant is under a DONE child", () => {
    const { epic, children } = epicWithChildren(1);
    const parent = children[0]!;
    const middle = store.createChild(parent, { title: "Middle" }).identifier;
    const deep = store.createChild(middle, { title: "Deep" }).identifier;
    // Held, so it stays open once `middle` lands — see the note two tests above.
    store.checkoutIssue(parent, "agent-p");
    resolve(middle);
    store.gateIssue(epic, { owner: "VP" }, "a");

    // "Open subtree" means any open DESCENDANT, not any open child. `deep` is
    // still pickable work this gate is holding, so `parent` still has something
    // to release.
    expect(store.queuedBy(deep)).toEqual({ identifier: epic, owner: "VP" });
    expect(store.queuedBy(parent)).toEqual({ identifier: epic, owner: "VP" });
    expect(store.queuedBy(middle)).toBeNull();
  });
});

// --------------------------------------------------------------- the queue as a tree

/**
 * STA-154 rule (a): the checklist is the gated parent's OPEN descendants that
 * this gate still holds, rendered as a tree so that approving a parent visibly
 * releases its subtree.
 */
describe("gateQueueOf: the rows this gate is holding, as a tree", () => {
  it("lists open descendants in pre-order with a depth below the gate", () => {
    const { epic, children } = epicWithChildren(1);
    const parent = children[0]!;
    const child = store.createChild(parent, { title: "Child" }).identifier;
    const grandchild = store.createChild(child, { title: "Grandchild" }).identifier;
    const leaf = store.createChild(epic, { title: "Leaf" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    expect(store.gateQueueOf(epic).map((e) => [e.identifier, e.depth])).toEqual([
      [parent, 1],
      [child, 2],
      [grandchild, 3],
      [leaf, 1],
    ]);
  });

  it("carries enough of the row to render one — identifier, title, status, parent", () => {
    const { epic, children } = epicWithChildren(1);
    store.gateIssue(epic, { owner: "VP" }, "a");

    const [entry] = store.gateQueueOf(epic);
    expect(entry).toMatchObject({
      identifier: children[0]!,
      title: "Child 1",
      status: "backlog",
      parentId: store.getIssue(epic).id,
      depth: 1,
    });
    expect(entry!.id).toBe(store.getIssue(children[0]!).id);
  });

  it("omits resolved rows and parents with nothing open underneath", () => {
    const { epic, children } = epicWithChildren(2);
    const spent = children[0]!;
    const spentChild = store.createChild(spent, { title: "Spent child" }).identifier;
    resolve(spentChild);
    resolve(children[1]!);
    const live = store.createChild(epic, { title: "Live" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    expect(store.gateQueueOf(epic).map((e) => e.identifier)).toEqual([live]);
  });

  it("re-parents an orphan onto the nearest LISTED ancestor, so the list is a tree", () => {
    const { epic, children } = epicWithChildren(1);
    const parent = children[0]!;
    const middle = store.createChild(parent, { title: "Middle" }).identifier;
    const deep = store.createChild(middle, { title: "Deep" }).identifier;
    // Held, so it stays open once `middle` lands (STA-153's auto-close).
    store.checkoutIssue(parent, "agent-p");
    resolve(middle);
    store.gateIssue(epic, { owner: "VP" }, "a");

    // `middle` is done and therefore not listed. `deep` must not be rendered at
    // depth 3 under a row that is not there — an indent with no parent above it
    // is a hole, and a hole in a checklist is a row nobody can reason about.
    expect(store.gateQueueOf(epic).map((e) => [e.identifier, e.depth])).toEqual([
      [parent, 1],
      [deep, 2],
    ]);
  });

  it("drops a released row AND its subtree on the very next read", () => {
    const { epic, children } = epicWithChildren(2);
    const grandchild = store.createChild(children[0]!, { title: "Grandchild" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(store.gateQueueOf(epic).map((e) => e.identifier)).toEqual([
      children[0]!,
      grandchild,
      children[1]!,
    ]);

    store.approveGate(epic, { children: [children[0]!] }, "VP");

    // Rule (c): the reviewer's decision is visible immediately, and it takes the
    // whole subtree with it rather than leaving orphaned subtasks behind.
    expect(store.gateQueueOf(epic).map((e) => e.identifier)).toEqual([children[1]!]);
  });

  it("is empty once everything open has been released — the close-the-gate state", () => {
    const { epic, children } = epicWithChildren(1);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, { children: [children[0]!] }, "VP");

    // Rule (d): nothing left to tick, so the page must offer closing the gate
    // rather than a dead "Approve all".
    expect(store.gateQueueOf(epic)).toEqual([]);
    expect(store.gate(epic)!.state).toBe("pending");
  });

  it("is empty for an issue with no active gate, rather than a refusal", () => {
    const { epic } = epicWithChildren(1);
    // A read that answers "nothing" is what every caller wants here: the panel
    // asks for the queue on every issue it renders, gated or not.
    expect(store.gateQueueOf(epic)).toEqual([]);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, {}, "VP");
    expect(store.gateQueueOf(epic)).toEqual([]);
  });

  it("stops at an inner gate — that subtree is somebody else's decision", () => {
    const outer = store.createIssue({ title: "Program" }).identifier;
    const inner = store.createChild(outer, { title: "Epic" }).identifier;
    const leaf = store.createChild(inner, { title: "Task" }).identifier;
    const sibling = store.createChild(outer, { title: "Sibling" }).identifier;
    store.gateIssue(inner, { owner: "Lead" }, "a");
    store.gateIssue(outer, { owner: "VP" }, "a");

    // `leaf` is queued behind Lead, not behind VP. `approveGate` would refuse
    // nothing here — it is a descendant — but releasing it is not VP's call.
    expect(store.gateQueueOf(outer).map((e) => e.identifier)).toEqual([inner, sibling]);
    expect(store.gateQueueOf(inner).map((e) => e.identifier)).toEqual([leaf]);
  });
});

// --------------------------------------------------------------- checkout guard

describe("checkout of a queued issue is refused, and cannot be routed around", () => {
  it("refuses with code `gated`, naming the gate and its owner", () => {
    const { epic, children } = epicWithChildren(1);
    store.gateIssue(epic, { owner: "VP" }, "a");

    let thrown: unknown;
    try {
      store.checkoutIssue(children[0]!, "agent-b");
    } catch (error) {
      thrown = error;
    }
    const envelope = errorEnvelope(thrown);
    expect(envelope.code).toBe("gated");
    expect(envelope.retryable).toBe(false); // approval is a person, not a retry
    expect(envelope.message).toContain(children[0]!);
    expect(envelope.message).toContain(epic);
    expect(envelope.message).toContain("VP");
    expect(envelope.detail).toMatchObject({ queuedBy: { identifier: epic, owner: "VP" } });
  });

  it("is not bypassed by --steal-if-stale", () => {
    const { epic, children } = epicWithChildren(1);
    store.gateIssue(epic, { owner: "VP" }, "a");
    // A stale holder and a closed gate are unrelated facts; a takeover answers
    // only the first.
    expect(codeOf(() => store.checkoutIssue(children[0]!, "agent-b", undefined, { stealIfIdleSeconds: 0 }))).toBe(
      "gated",
    );
  });

  it("still lets the EXISTING holder re-claim after a crash", () => {
    const { epic, children } = epicWithChildren(1);
    store.checkoutIssue(children[0]!, "agent-a");
    store.gateIssue(epic, { owner: "VP" }, "a");

    // Mid-flight work, not a fresh pickup. Refusing it would orphan the claim.
    expect(() => store.checkoutIssue(children[0]!, "agent-a")).not.toThrow();
    expect(store.getIssue(children[0]!).checkoutAgent).toBe("agent-a");
  });

  it("lets a released child be claimed while its siblings stay queued", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, { children: [children[0]!] }, "VP");

    expect(() => store.checkoutIssue(children[0]!, "agent-b")).not.toThrow();
    expect(codeOf(() => store.checkoutIssue(children[1]!, "agent-c"))).toBe("gated");
  });

  it("refuses the parked parent itself — awaiting_approval is not a checkout status", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(codeOf(() => store.checkoutIssue(epic, "agent-b"))).toBe("conflict");
  });
});

// --------------------------------------------------------------- derivation

describe("a gate is immune to derivation, and outranks the automatic close", () => {
  it("a child moving does not un-park the parent", () => {
    const { epic, children } = epicWithChildren(2);
    store.checkoutIssue(children[0]!, "agent-a"); // in flight when the gate goes up
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(statusOf(epic)).toBe("awaiting_approval");

    store.updateIssue(children[0]!, { status: "in_review" }, "agent-a");
    store.updateIssue(children[0]!, { status: "done" }, "agent-a");

    // Without the immunity, the in_review rung would have spoken over the
    // reviewer and silently discarded the gate.
    expect(statusOf(epic)).toBe("awaiting_approval");
    expect(store.gate(epic)!.state).toBe("pending");
  });

  /**
   * A GATED CHILD IS AN ORDINARY RUNG-4 INPUT.
   *
   * This reverses what STA-143 shipped alone, and the reason is the ladder it
   * shipped against. Then, rung 0 meant "nothing open" and dropping the gated
   * child from the inputs left the grandparent untouched. Since STA-153 rung 0
   * means "no children at all" and an EMPTY open list means FINISHED — so
   * dropping the child would hand a grandparent whose only remaining child is
   * parked behind a human review straight to rung 6 and close it. A gate is the
   * one thing that must never be mistaken for a completion.
   *
   * Rung 4 says the true thing anyway: an approval nobody has given is not work
   * an agent can pick up, which is exactly what `blocked` means to a reader of
   * this list. The descriptor argument still holds and is still honoured — a
   * DERIVED `blocked` carries no unblockOwner/unblockAction, and never has.
   */
  it("a gated child derives rung 4 on its grandparent, and never rung 6", () => {
    const program = store.createIssue({ title: "Program" }).identifier;
    const epic = store.createChild(program, { title: "Epic" }).identifier;
    store.createChild(epic, { title: "Task" });

    store.gateIssue(epic, { owner: "VP" }, "a");

    expect(statusOf(program)).toBe("blocked");
    // The whole point: parked is not finished.
    expect(statusOf(program)).not.toBe("done");
    // A derived block borrows its descriptor from the blocking child and mints none.
    const row = store.getIssue(program);
    expect(row.unblockOwner).toBeNull();
    expect(row.unblockAction).toBeNull();
  });

  /**
   * ── THE AUTO-CLOSE RULE MEETS THE GATE (STA-143 x STA-153) ──────────────────
   *
   * STA-153 made a parent close itself when its last child lands. A gate says a
   * human still has to answer. Where they meet the human wins, in both of the
   * two states a gate can be open in — and the two get there by different
   * routes, which is why both are pinned.
   */
  it("does not auto-close a parent whose gate is still PENDING", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");

    for (const child of children) resolve(child);

    // The parent is IN the gated category, so the category immunity caught it
    // before the ladder was ever consulted.
    expect(statusOf(epic)).toBe("awaiting_approval");
    expect(store.gate(epic)!.state).toBe("pending");
    expect(store.getIssue(epic).completedAt).toBeNull();
  });

  /**
   * The case the explicit guard exists for. `request-changes` deliberately puts
   * the parent BACK in the workable band so the work can resume, so it is not in
   * the gated category and the category immunity does not apply — while the gate
   * itself is still unanswered. Without the guard, the last child landing again
   * would close the ticket out from under the reviewer who asked for changes,
   * skipping the resubmit loop entirely.
   */
  it("does not auto-close a parent whose gate is CHANGES_REQUESTED", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "the API shape is wrong" }, "VP");
    expect(statusOf(epic)).toBe("todo"); // back in the writable pre-work band
    expect(store.gate(epic)!.state).toBe("changes_requested");

    for (const child of children) resolve(child);

    /**
     * NOT `done`, and not `todo` either.
     *
     * The guard DECLINES the closing rungs rather than substituting a status of
     * its own, so the parent keeps the last thing the open rungs said — here
     * `in_progress`, written while the children were being worked. That is the
     * conservative behaviour and the honest one: the tracker refuses to answer
     * the question the reviewer was asked, and the unanswered gate is the fact
     * every surface renders. The one thing that must not happen is a resolved
     * timestamp, and there is none.
     */
    expect(statusOf(epic)).toBe("in_progress");
    expect(store.isResolvedStatus(statusOf(epic))).toBe(false);
    expect(store.getIssue(epic).completedAt).toBeNull();
    // Re-gating is the resubmit loop, and it is still available.
    expect(() => store.gateIssue(epic, { owner: "VP" }, "a")).not.toThrow();
  });

  /** Only the CLOSING rungs are refused. A report is still a report. */
  it("still reports rungs 1-4 while changes are requested", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "again please" }, "VP");

    store.updateIssue(children[0]!, { assignee: "agent-a" }, "agent-a");
    store.updateIssue(children[0]!, { status: "in_progress" }, "agent-a");

    expect(statusOf(epic)).toBe("in_progress");
  });

  it("auto-closes normally once the gate is approved", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, {}, "VP");
    expect(store.gate(epic)!.state).toBe("approved");

    for (const child of children) resolve(child);

    expect(statusOf(epic)).toBe("done");
    expect(store.getIssue(epic).completedAt).not.toBeNull();
  });


  it("a sibling that is still workable still derives normally past the gate", () => {
    const program = store.createIssue({ title: "Program" }).identifier;
    const epic = store.createChild(program, { title: "Epic" }).identifier;
    store.createChild(epic, { title: "Task" });
    const sibling = store.createChild(program, { title: "Sibling", assignee: "agent-a" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    store.checkoutIssue(sibling, "agent-a");
    expect(statusOf(program)).toBe("in_progress");
  });
});

// --------------------------------------------------------------- status guard

describe("only the gate commands may cross the awaiting_approval boundary", () => {
  it("refuses a direct status write INTO awaiting_approval", () => {
    const { epic } = epicWithChildren();
    expect(codeOf(() => store.updateIssue(epic, { status: "awaiting_approval" }, "a"))).toBe(
      "validation",
    );
    expect(() => store.updateIssue(epic, { status: "awaiting_approval" }, "a")).toThrow(
      /staple gate/,
    );
  });

  it("refuses a direct status write OUT of it, and names the way out", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    let thrown: unknown;
    try {
      store.updateIssue(epic, { status: "todo" }, "a");
    } catch (error) {
      thrown = error;
    }
    const envelope = errorEnvelope(thrown);
    expect(envelope.code).toBe("validation");
    expect(envelope.message).toContain("staple approve");
    expect(envelope.message).toContain("staple request-changes");
  });

  it("refuses `done` too — resolve the gate before closing the ticket", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    // Otherwise a resolved issue could carry an unanswered gate forever.
    expect(codeOf(() => store.updateIssue(epic, { status: "done" }, "a"))).toBe("validation");
  });

  it("still allows a non-status edit while parked", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(() => store.updateIssue(epic, { priority: "critical" }, "a")).not.toThrow();
    expect(store.getIssue(epic).priority).toBe("critical");
    expect(statusOf(epic)).toBe("awaiting_approval");
  });
});

// --------------------------------------------------------------- approve

describe("approve releases the queue", () => {
  it("re-derives the parent from its children and drains every queue", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");

    const released = store.approveGate(epic, {}, "VP");

    // Backlog children => the workable band => `backlog`, not whatever it was
    // before it was parked.
    expect(released.status).toBe("backlog");
    expect(store.gate(epic)!.state).toBe("approved");
    expect(store.gate(epic)!.resolvedBy).toBe("VP");
    for (const child of children) expect(store.queuedBy(child)).toBeNull();
  });

  /**
   * THE SUBTREE FINISHED WHILE THE REVIEWER WAS READING IT.
   *
   * STA-143 landed this on `todo`, because the ladder it had said "leave it
   * alone" when nothing was open and leaving a parked parent alone was not an
   * available answer. STA-153 gave the ladder rungs 5 and 6, so it now has a
   * real answer — and it is the right one: the auto-close was DEFERRED by the
   * open gate, not cancelled by it, so answering the gate is exactly when it
   * should fire. Landing an epic whose every child has shipped in `todo` would
   * put it back at the top of somebody's pickup queue with nothing to pick up.
   *
   * The `todo` fallback still exists, for rung 0 — no children at all — which
   * `gate` itself refuses to create and only a reparent or a delete can reach.
   */
  it("closes the parent when everything underneath has already landed", () => {
    const { epic, children } = epicWithChildren(1);
    store.gateIssue(epic, { owner: "VP" }, "a");
    // Resolve the only child while the epic is parked.
    store.updateIssue(children[0]!, { status: "done" }, "a");
    expect(statusOf(epic)).toBe("awaiting_approval"); // deferred, not cancelled

    const approved = store.approveGate(epic, {}, "VP");
    expect(approved.status).toBe("done");
    expect(approved.completedAt).not.toBeNull();
    expect(store.gate(epic)!.state).toBe("approved");
  });

  it("derives in_progress when a child kept working through the gate", () => {
    const { epic, children } = epicWithChildren(2);
    store.checkoutIssue(children[0]!, "agent-a");
    store.gateIssue(epic, { owner: "VP" }, "a");

    expect(store.approveGate(epic, {}, "VP").status).toBe("in_progress");
  });

  it("clears per-child release flags so they cannot leak into the next cycle", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, { children: [children[0]!] }, "VP");
    store.approveGate(epic, {}, "VP");

    // A second gate must queue EVERY child again, including the one released
    // under the first one.
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(store.queuedBy(children[0]!)).toEqual({ identifier: epic, owner: "VP" });
    expect(store.queuedBy(children[1]!)).toEqual({ identifier: epic, owner: "VP" });
  });

  it("per-child approve keeps the parent parked and the gate pending", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");

    store.approveGate(epic, { children: [children[0]!] }, "VP");

    expect(statusOf(epic)).toBe("awaiting_approval");
    expect(store.gate(epic)!.state).toBe("pending");
    expect(store.queuedBy(children[0]!)).toBeNull();
    expect(store.queuedBy(children[1]!)).toEqual({ identifier: epic, owner: "VP" });
  });

  it("emits gate_child_approved on the CHILD, not on the parent", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, { children: [children[0]!] }, "VP");

    expect(eventKinds(children[0]!)).toContain("gate_child_approved");
    expect(eventKinds(epic)).not.toContain("gate_child_approved");
  });

  it("refuses to release a ref that is not underneath the gate", () => {
    const { epic } = epicWithChildren(1);
    const stranger = store.createIssue({ title: "Someone else's ticket" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    expect(codeOf(() => store.approveGate(epic, { children: [stranger] }, "VP"))).toBe("validation");
    expect(store.getIssue(stranger).status).toBe("backlog");
  });

  it("refuses when there is no gate at all", () => {
    const { epic } = epicWithChildren();
    expect(codeOf(() => store.approveGate(epic, {}, "VP"))).toBe("conflict");
    expect(() => store.approveGate(epic, {}, "VP")).toThrow(/staple gate/);
  });

  it("refuses a second whole-gate approve", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, {}, "VP");
    expect(codeOf(() => store.approveGate(epic, {}, "VP"))).toBe("conflict");
    expect(() => store.approveGate(epic, {}, "VP")).toThrow(/already approved/);
  });

  it("emits status_changed and gate_approved", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, { comment: "looks good" }, "VP");

    expect(eventKinds(epic)).toEqual([
      "issue_created",
      "status_changed",
      "gate_requested",
      "status_changed",
      "gate_approved",
      "comment_added",
    ]);
    expect(store.listComments(store.getIssue(epic).id).map((c) => c.body)).toContain("looks good");
  });
});

// --------------------------------------------------------------- request-changes

describe("request-changes sends the parent back and KEEPS the children queued", () => {
  it("returns the parent to todo with the comment stored as a comment", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");

    const sent = store.requestChanges(epic, { comment: "split the migration out" }, "VP");

    expect(sent.status).toBe("todo");
    expect(store.gate(epic)!.state).toBe("changes_requested");
    expect(store.gate(epic)!.resolvedBy).toBe("VP");
    // Event payloads are not where anyone reads. The objection is the single
    // most important thing the next agent needs, so it is a real comment.
    expect(store.listComments(store.getIssue(epic).id).map((c) => c.body)).toContain(
      "split the migration out",
    );
    expect(eventKinds(epic)).toContain("gate_changes_requested");
  });

  it("keeps the children queued — VP's explicit decision", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "not yet" }, "VP");

    // "Changes requested" is not "released": draining the queue on an objection
    // is the opposite of what the reviewer asked for.
    expect(store.queuedBy(children[0]!)).toEqual({ identifier: epic, owner: "VP" });
    expect(codeOf(() => store.checkoutIssue(children[0]!, "agent-b"))).toBe("gated");
  });

  it("leaves the parent itself pickable, by anyone, with no auto re-checkout", () => {
    const { epic } = epicWithChildren();
    store.checkoutIssue(epic, "agent-a");
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "not yet" }, "VP");

    expect(store.getIssue(epic).checkoutAgent).toBeNull();
    expect(() => store.checkoutIssue(epic, "agent-b")).not.toThrow();
  });

  it("can still be approved afterwards — that is how the queue ends", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "fix it" }, "VP");

    // Otherwise a reviewer who asks for changes has trapped the subtree.
    expect(() => store.approveGate(epic, {}, "VP")).not.toThrow();
    expect(store.gate(epic)!.state).toBe("approved");
    expect(store.queuedBy(children[0]!)).toBeNull();
  });

  it("requires a comment", () => {
    const { epic } = epicWithChildren();
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(codeOf(() => store.requestChanges(epic, { comment: "   " }, "VP"))).toBe("validation");
    expect(store.gate(epic)!.state).toBe("pending");
  });

  it("refuses when there is no gate", () => {
    const { epic } = epicWithChildren();
    expect(codeOf(() => store.requestChanges(epic, { comment: "x" }, "VP"))).toBe("conflict");
  });

  it("lets derivation speak again once the parent is back in the pre-work band", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.requestChanges(epic, { comment: "fix it" }, "VP");
    // The parent is `todo` now, so it is no longer immune; the epic lights up
    // when work starts on it directly.
    store.checkoutIssue(epic, "agent-a");
    expect(statusOf(epic)).toBe("in_progress");
    expect(store.queuedBy(children[0]!)).not.toBeNull(); // …and the queue holds
  });
});

// --------------------------------------------------------------- inbox

describe("the inbox third bucket", () => {
  it("puts queued children and the parked parent in `queued`, never in `ready`", () => {
    const { epic, children } = epicWithChildren(2);
    const free = store.createIssue({ title: "Unrelated", status: "todo" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    const inbox = store.inbox();
    const ids = (rows: Array<{ identifier: string }>) => rows.map((r) => r.identifier);

    expect(ids(inbox.ready)).toEqual([free]);
    expect(ids(inbox.queued).sort()).toEqual([epic, ...children].sort());
    expect(ids(inbox.blocked)).toEqual([]);
  });

  it("carries queuedBy on the children and gate on the parent", () => {
    const { epic, children } = epicWithChildren(1);
    store.gateIssue(epic, { owner: "VP" }, "a");
    const inbox = store.inbox();

    const child = inbox.queued.find((i) => i.identifier === children[0]!)!;
    expect(child.queuedBy).toEqual({ identifier: epic, owner: "VP" });
    expect(child.gate).toBeNull();

    const parent = inbox.queued.find((i) => i.identifier === epic)!;
    // It is not standing in a queue; it IS one. Surfaces read `gate` to say
    // "awaiting VP" instead of the "? must act" a blocked bucket would produce.
    expect(parent.queuedBy).toBeNull();
    expect(parent.gate).toMatchObject({ state: "pending", owner: "VP" });
  });

  it("prefers the gate over a blocker: the blocker cannot be worked either way", () => {
    const { epic, children } = epicWithChildren(2);
    store.setBlockedBy(children[0]!, [children[1]!], "a");
    store.gateIssue(epic, { owner: "VP" }, "a");

    const inbox = store.inbox();
    expect(inbox.queued.map((i) => i.identifier)).toContain(children[0]!);
    expect(inbox.blocked.map((i) => i.identifier)).not.toContain(children[0]!);
  });

  it("returns them to `ready` on approval", () => {
    const { epic, children } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, {}, "VP");

    const inbox = store.inbox();
    expect(inbox.queued).toEqual([]);
    expect(inbox.ready.map((i) => i.identifier).sort()).toEqual([epic, ...children].sort());
  });

  it("obeys the same eligibility rule: no resolved rows, no empty-subtree parents", () => {
    const { epic, children } = epicWithChildren(2);
    const spent = children[0]!;
    const spentChild = store.createChild(spent, { title: "Spent child" }).identifier;
    resolve(spentChild);
    resolve(children[1]!);
    const live = store.createChild(epic, { title: "Live" }).identifier;
    store.gateIssue(epic, { owner: "VP" }, "a");

    // One definition of "queued", read by the inbox, the tree, the detail panel
    // and the checklist alike — they all go through `queuedByFor`.
    expect(store.inbox().queued.map((i) => i.identifier).sort()).toEqual([epic, live].sort());
  });

  it("keeps every field an inbox entry already had", () => {
    const { children } = epicWithChildren(1);
    const entry = store.inbox().ready.find((i) => i.identifier === children[0]!)!;
    // Additive means additive: the pre-existing shape is untouched.
    expect(entry.unresolvedBlockers).toEqual([]);
    expect(entry.identifier).toBe(children[0]!);
    expect(entry.statusVersion).toBe(0);
  });
});

// --------------------------------------------------------------- replay

describe("every gate transition still leaves a replayable log", () => {
  /**
   * The failure mode this guards is silent — see store-timing.test.ts. A
   * status-writing site whose event kind is not in `STATUS_MOVING_EVENT_KINDS`
   * stops explaining its row, and the issue quietly degrades to `approximate`
   * with nothing going red. The gate sites emit `status_changed` beside their
   * semantic event precisely so this stays true with no change to the replay.
   */
  it("gate, approve and request-changes all keep timing exact", () => {
    const { epic } = epicWithChildren(2);
    store.gateIssue(epic, { owner: "VP" }, "a");
    expect(store.timing(epic).approximate).toBe(false);

    store.requestChanges(epic, { comment: "again" }, "VP");
    expect(store.timing(epic).approximate).toBe(false);

    store.gateIssue(epic, { owner: "VP" }, "a");
    store.approveGate(epic, {}, "VP");
    expect(store.timing(epic).approximate).toBe(false);
  });

  it("parked time is not billed as active time", () => {
    const { epic, children } = epicWithChildren(1);
    store.checkoutIssue(children[0]!, "agent-a");
    store.gateIssue(epic, { owner: "VP" }, "a");
    // A parked parent has no stopwatch and no open interval to count through.
    expect(store.timing(epic).ownActiveSeconds ?? 0).toBe(0);
  });
});
