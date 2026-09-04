import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import type { QueueEligibility, QueueStore } from "../src/core/queue-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

/**
 * STA-168 — the RESOLVER, `strict` and the human override: the policy half of
 * docs/queue.md, over the storage half `store-queue.test.ts` already pins.
 *
 * Every test name below is the one docs/queue.md names for the paragraph it
 * proves. The doc originally filed them under `store-queue.test.ts` because R2b
 * and R2c had not been split yet; they live here, and the doc's pins now say so.
 *
 * The line between the two files is the line between the two halves of the
 * service: `store-queue.test.ts` proves what the TABLE does — order, ranks,
 * revisions, lifecycle — and this file proves what the ORDER MEANS. Nothing here
 * writes a plan except to set one up.
 */

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let queue: QueueStore;
beforeEach(() => {
  store = memStore();
  queue = store.queue();
});

function refused(fn: () => unknown, code: string): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function issue(title: string, input: Record<string, unknown> = {}): string {
  return store.createIssue({ title, ...input }).identifier;
}

/** The effective order as `IDENT:eligibility`, which is what every rule here is about. */
function effective(actor?: string): string[] {
  return queue.effectiveQueue({ actor }).rows.map((row) => `${row.identifier}:${row.eligibility}`);
}

function identifiers(actor?: string): string[] {
  return queue.effectiveQueue({ actor }).rows.map((row) => row.identifier);
}

function eligibilityOf(identifier: string, actor?: string): QueueEligibility | undefined {
  return queue.effectiveQueue({ actor }).rows.find((row) => row.identifier === identifier)?.eligibility;
}

function strict(): void {
  store.setSetting("queue.policy", "strict", "vp");
}

// ------------------------------------------------------------ step 1: expand

describe("container expansion", () => {
  it("expands a container to open leaves, depth-first", () => {
    const epic = issue("S", { kind: "epic" });
    const one = issue("S1", { parent: epic });
    const nested = issue("S1a", { parent: one });
    const two = issue("S2", { parent: epic });
    queue.enqueue(epic, {}, "vp");

    // S1 has an open child, so S1 is itself a container: the leaf underneath it
    // comes out before S2, which is what depth-first means here.
    expect(identifiers()).toEqual([nested, two]);
    expect(one).not.toBe(nested);
    expect(identifiers()).not.toContain(one);
  });

  it("never emits a container as a row", () => {
    const epic = issue("S", { kind: "epic" });
    const child = issue("S1", { parent: epic });
    queue.enqueue(epic, {}, "vp");
    const rows = queue.effectiveQueue().rows;
    expect(rows.map((row) => row.identifier)).toEqual([child]);
    // Including the unqueued band: an epic with open children is not a row an
    // agent can be told to take, wherever it would otherwise have landed.
    queue.dequeue(epic, {}, "vp");
    expect(identifiers()).toEqual([child]);
  });

  it("treats a parent resolved after its children as a leaf, not a container", () => {
    const parent = issue("P", { kind: "epic" });
    const child = issue("P1", { parent });
    store.updateIssue(child, { status: "done" }, "vp");
    store.updateIssue(parent, { status: "todo" }, "vp");
    queue.enqueue(parent, {}, "vp");
    // Nothing open underneath, so it IS the work — the same test gates use.
    expect(identifiers()).toEqual([parent]);
  });

  it("emits a doubly-reached issue once, at its first occurrence", () => {
    const epic = issue("S", { kind: "epic" });
    const one = issue("S1", { parent: epic });
    const two = issue("S2", { parent: epic });
    queue.enqueue(two, {}, "vp");
    queue.enqueue(epic, {}, "vp");
    // S2 was queued directly at plan position 1 and is also reachable through
    // the epic at plan position 2. First occurrence wins.
    const rows = queue.effectiveQueue().rows;
    expect(rows.map((row) => row.identifier)).toEqual([two, one]);
    expect(rows[0]!.planPosition).toBe(1);
    expect(rows[0]!.via).toBeNull();
    expect(rows[1]!.via).toBe(epic);
  });

  it("expands a milestone in membership order, then each member by the tree rule", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    const epic = issue("S", { kind: "epic" });
    const child = issue("S1", { parent: epic });
    const solo = issue("Solo");
    const milestones = store.milestones();
    // Deliberately added epic-last, then moved: membership order is the human's,
    // not the order the issues were created in.
    milestones.addMember(milestone, solo, {}, "vp");
    milestones.addMember(milestone, epic, { before: solo }, "vp");
    queue.enqueue(milestone, {}, "vp");

    expect(identifiers()).toEqual([child, solo]);
    const rows = queue.effectiveQueue().rows;
    expect(rows.map((row) => row.via)).toEqual([milestone, milestone]);
  });

  it("a milestone's own children follow its members", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    // Nothing is ever re-parented INTO a milestone, but a human may parent an
    // issue under one; membership order comes first, then the tree rule.
    const own = issue("own child", { parent: milestone });
    const member = issue("member");
    store.milestones().addMember(milestone, member, {}, "vp");
    queue.enqueue(milestone, {}, "vp");

    expect(identifiers()).toEqual([member, own]);
    expect(queue.effectiveQueue().rows.map((row) => row.via)).toEqual([milestone, milestone]);
  });

  it("reordering membership updates effective order on the next read", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    const first = issue("first");
    const second = issue("second");
    const milestones = store.milestones();
    milestones.addMember(milestone, first, {}, "vp");
    milestones.addMember(milestone, second, {}, "vp");
    queue.enqueue(milestone, {}, "vp");
    expect(identifiers()).toEqual([first, second]);

    const queueRevision = queue.revision();
    const membersRevision = milestones.get(milestone).revision;
    const reordered = milestones.reorderMembers(milestone, [second, first], {}, "vp");
    // The effective order is DERIVED, so a membership reorder is visible on the
    // very next read with no queue write: the milestone's own members_revision
    // moves and the queue's does not.
    expect(identifiers()).toEqual([second, first]);
    expect(queue.revision()).toBe(queueRevision);
    expect(reordered.revision).toBe(membersRevision + 1);
  });

  it("a blocked or gated member stays visible under its milestone", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    const blocked = issue("blocked member");
    const epic = issue("gated member", { kind: "epic" });
    const gatedChild = issue("under the gate", { parent: epic });
    const free = issue("free member");
    const upstream = issue("upstream");
    store.setBlockedBy(blocked, [upstream], "vp");
    const milestones = store.milestones();
    milestones.addMember(milestone, blocked, {}, "vp");
    milestones.addMember(milestone, epic, {}, "vp");
    milestones.addMember(milestone, free, {}, "vp");
    store.gateIssue(epic, { owner: "vp" }, "vp");
    queue.enqueue(milestone, {}, "vp");

    // Both keep the place their milestone gave them and say why; the resolver
    // advances past them by the ladder rather than dropping or reordering them.
    expect(effective()).toEqual([
      `${blocked}:blocked`,
      `${gatedChild}:gated`,
      `${free}:eligible`,
      `${upstream}:eligible`,
    ]);
    const rows = queue.effectiveQueue().rows;
    expect(rows[0]!.reason).toContain(upstream);
    expect(rows[1]!.reason).toContain(epic);
    expect(rows.slice(0, 3).map((row) => row.milestonePath)).toEqual([
      [milestone],
      [milestone],
      [milestone],
    ]);
    expect(queue.effectiveQueue().next!.identifier).toBe(free);
  });

  it("reports the milestone and epic path for every effective row", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    const programme = issue("R programme", { kind: "epic" });
    const epic = issue("S epic", { kind: "epic", parent: programme });
    const leaf = issue("S1", { parent: epic });
    const loose = issue("loose");
    store.milestones().addMember(milestone, epic, {}, "vp");
    queue.enqueue(milestone, {}, "vp");

    const rows = queue.effectiveQueue().rows;
    const pathOf = (identifier: string) => {
      const row = rows.find((candidate) => candidate.identifier === identifier)!;
      return { milestonePath: row.milestonePath, epicPath: row.epicPath };
    };
    // The milestone is the epic's, inherited by the leaf underneath it; the epic
    // path is the ANCESTORS, outermost first, and never the row itself.
    expect(pathOf(leaf)).toEqual({ milestonePath: [milestone], epicPath: [programme, epic] });
    // Unqueued work reports its path too — it is a fact about the tree, not
    // about the plan.
    expect(pathOf(loose)).toEqual({ milestonePath: [], epicPath: [] });
    expect(rows.every((row) => Array.isArray(row.milestonePath) && Array.isArray(row.epicPath))).toBe(true);
  });

  it("a milestone date changes dueAt and nothing else", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    const late = issue("late");
    const early = issue("early");
    store.milestones().addMember(milestone, late, {}, "vp");
    queue.enqueue(milestone, {}, "vp");
    queue.enqueue(early, {}, "vp");
    const before = identifiers();

    store.milestones().update(milestone, { targetDate: "2026-01-01" }, "vp");
    expect(identifiers()).toEqual(before);
    const row = queue.effectiveQueue().rows.find((r) => r.identifier === late)!;
    // The INCLUSIVE end of the target day, so `new Date(dueAt) < now` is overdue only
    // once the day is over — docs/milestones.md, "Dates".
    expect(row.dueAt).toBe("2026-01-01T23:59:59.999Z");
    // A date explains urgency; it never reorders a plan somebody wrote by hand.
    expect(identifiers()[0]).toBe(late);
    expect(queue.effectiveQueue().rows.find((r) => r.identifier === early)!.dueAt).toBeNull();
  });

  it("changing milestone dates never reorders an explicit plan", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestones = store.milestones();
    const later = store.createIssue({ title: "November", kind: MILESTONE_KIND }).identifier;
    const sooner = store.createIssue({ title: "October", kind: MILESTONE_KIND }).identifier;
    const laterWork = issue("ship the November thing");
    const soonerWork = issue("ship the October thing");
    milestones.addMember(later, laterWork, {}, "vp");
    milestones.addMember(sooner, soonerWork, {}, "vp");
    // A human put November first. The dates say the opposite.
    queue.enqueue(later, {}, "vp");
    queue.enqueue(sooner, {}, "vp");
    milestones.update(later, { targetDate: "2026-11-30" }, "vp");
    milestones.update(sooner, { targetDate: "2026-10-31" }, "vp");
    const before = JSON.stringify(queue.effectiveQueue().rows);

    // Swap the dates, twice over, and clear one entirely.
    milestones.update(later, { targetDate: "2026-01-01" }, "vp");
    milestones.update(sooner, { targetDate: "2026-12-31", startDate: "2026-01-01" }, "vp");
    expect(identifiers()).toEqual([laterWork, soonerWork]);
    milestones.update(later, { targetDate: null }, "vp");
    expect(identifiers()).toEqual([laterWork, soonerWork]);

    // Restore the dates and the whole effective answer is byte-identical: the
    // only thing a date was ever allowed to touch is `dueAt`.
    milestones.update(later, { targetDate: "2026-11-30" }, "vp");
    milestones.update(sooner, { targetDate: "2026-10-31", startDate: null }, "vp");
    expect(JSON.stringify(queue.effectiveQueue().rows)).toBe(before);
  });
});

// ------------------------------------------------------ step 2: unqueued band

describe("the unqueued band", () => {
  it("appends unqueued work after the plan in presentation sort", () => {
    const low = issue("low", { priority: "low" });
    const critical = issue("critical", { priority: "critical" });
    const queued = issue("queued", { priority: "low" });
    queue.enqueue(queued, {}, "vp");

    // The queue is a prefix, not a filter: the low-priority queued row comes
    // first BECAUSE a human put it there, and the rest keeps presentation sort.
    expect(identifiers()).toEqual([queued, critical, low]);
    const rows = queue.effectiveQueue().rows;
    expect(rows.map((row) => row.unqueued)).toEqual([false, true, true]);
    expect(rows.map((row) => row.planPosition)).toEqual([1, null, null]);
  });

  it("a reopened issue whose entry was pruned lands in the unqueued band", () => {
    const one = issue("one");
    const two = issue("two");
    queue.enqueue(one, {}, "vp");
    queue.enqueue(two, {}, "vp");
    store.updateIssue(one, { status: "done" }, "vp");
    queue.prune({}, "vp");
    store.updateIssue(one, { status: "todo" }, "vp");

    expect(queue.entries({ all: true }).map((entry) => entry.identifier)).toEqual([two]);
    const rows = queue.effectiveQueue().rows;
    expect(rows.map((row) => row.identifier)).toEqual([two, one]);
    expect(rows[1]).toMatchObject({ unqueued: true, planPosition: null });
  });
});

// ----------------------------------------------------------- step 3: classify

describe("the eligibility ladder", () => {
  it("classifies by the ladder, first match wins", () => {
    const done = issue("done one");
    const blocker = issue("blocker");
    const blocked = issue("blocked one");
    const held = issue("held one");
    const free = issue("free one");
    store.updateIssue(done, { status: "done" }, "vp");
    store.setBlockedBy(blocked, [blocker], "vp");
    store.checkoutIssue(held, "other-agent");
    for (const ref of [done, blocked, held, free]) queue.enqueue(ref, {}, "vp");

    expect(effective("me")).toEqual([
      `${done}:resolved`,
      `${blocked}:blocked`,
      `${held}:claimed`,
      `${free}:eligible`,
      // The blocker itself is real, unqueued work.
      `${blocker}:eligible`,
    ]);
    // The actor's OWN claim is not somebody else's claim.
    expect(eligibilityOf(held, "other-agent")).toBe("eligible");
  });

  it("names the gate before the blocker", () => {
    const epic = issue("S", { kind: "epic" });
    const child = issue("S1", { parent: epic });
    const blocker = issue("blocker");
    store.setBlockedBy(child, [blocker], "vp");
    store.gateIssue(epic, { owner: "vp" }, "vp");
    queue.enqueue(child, {}, "vp");

    // Both facts are true; the gate is the more actionable of the two, because
    // the blocker cannot even be worked until a human opens the gate.
    const row = queue.effectiveQueue().rows.find((r) => r.identifier === child)!;
    expect(row.eligibility).toBe("gated");
    expect(row.detail).toEqual({ queuedBy: { identifier: epic, owner: "vp" } });
  });

  it("treats an unresolvable cross-workspace blocker as blocked", () => {
    const local = issue("local");
    queue.enqueue(local, {}, "vp");
    const rows = queue.effectiveQueue({
      crossBlockers: new Map([[local, [{ identifier: "WOR-12", resolved: false, unresolvable: true }]]]),
    }).rows;
    expect(rows[0]!.eligibility).toBe("blocked");
    expect(rows[0]!.detail).toMatchObject({
      blockers: [],
      crossBlockers: [{ identifier: "WOR-12", unresolvable: true }],
    });
    // A resolved cross blocker is not a constraint at all.
    expect(
      queue.effectiveQueue({
        crossBlockers: new Map([[local, [{ identifier: "WOR-12", resolved: true, unresolvable: false }]]]),
      }).rows[0]!.eligibility,
    ).toBe("eligible");
  });

  it("never drops an ineligible row", () => {
    const blocker = issue("blocker");
    const blocked = issue("blocked one");
    store.setBlockedBy(blocked, [blocker], "vp");
    queue.enqueue(blocked, {}, "vp");
    // The plan is shown WHOLE, so a human can see what their order waits on.
    expect(identifiers()).toContain(blocked);
    expect(queue.effectiveQueue().rows[0]!.reason).toContain(blocker);
  });

  it("next is the first eligible row and lists what it skipped", () => {
    const done = issue("done one");
    const blocker = issue("blocker");
    const blocked = issue("blocked one");
    const free = issue("free one");
    store.updateIssue(done, { status: "done" }, "vp");
    store.setBlockedBy(blocked, [blocker], "vp");
    for (const ref of [done, blocked, free]) queue.enqueue(ref, {}, "vp");

    const result = queue.effectiveQueue({ actor: "me" });
    expect(result.next?.identifier).toBe(free);
    expect(result.skipped.map((row) => `${row.identifier}:${row.eligibility}`)).toEqual([
      `${done}:resolved`,
      `${blocked}:blocked`,
    ]);
  });

  it("has no eligible row, and no next, when everything is held", () => {
    const only = issue("only");
    store.checkoutIssue(only, "other-agent");
    queue.enqueue(only, {}, "vp");
    const result = queue.effectiveQueue({ actor: "me" });
    expect(result.next).toBeNull();
    expect(result.skipped.map((row) => row.identifier)).toEqual([only]);
  });
});

// ----------------------------------------------------------------- the policy

describe("queue.policy = advisory", () => {
  it("advisory never refuses a checkout for order", () => {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    // The default. Upgrading a workspace changes nothing an agent can observe
    // until a human sets strict.
    expect(store.getSetting("queue.policy")).toBe("advisory");
    expect(store.checkoutIssue(later, "agent-1").identifier).toBe(later);
  });
});

describe("queue.policy = strict", () => {
  it("strict refuses a later checkout with out_of_order, naming the earlier eligible rows", () => {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    strict();

    const error = refused(() => store.checkoutIssue(later, "agent-1"), "out_of_order");
    expect(error.message).toBe(
      `${later} is later in the queue than ${first}, which is ready. Take ${first}, or ask a human to reorder or override.`,
    );
    expect(error.detail).toEqual({
      policy: "strict",
      expected: [first],
      position: 2,
      expectedPosition: 1,
    });
    // Refusing wrote nothing: the row is still claimable by whoever takes it in
    // turn, and the plan is untouched.
    expect(store.getIssue(later).checkoutAgent).toBeNull();
    expect(queue.revision()).toBe(2);
  });

  it("strict allows the head row", () => {
    const first = issue("first");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(issue("later"), {}, "vp");
    strict();
    expect(store.checkoutIssue(first, "agent-1").identifier).toBe(first);
  });

  it("strict allows a later row once every earlier row is ineligible", () => {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    strict();
    // Agent one takes the head; agent two is then handed the second row, and its
    // checkout passes — which is the whole serializability argument.
    store.checkoutIssue(first, "agent-1");
    expect(queue.effectiveQueue({ actor: "agent-2" }).next?.identifier).toBe(later);
    expect(store.checkoutIssue(later, "agent-2").identifier).toBe(later);
  });

  it("strict refuses unqueued work while any plan row is eligible", () => {
    const planned = issue("planned");
    const unqueued = issue("unqueued");
    queue.enqueue(planned, {}, "vp");
    strict();
    const error = refused(() => store.checkoutIssue(unqueued, "agent-1"), "out_of_order");
    expect(error.detail).toMatchObject({ expected: [planned], expectedPosition: 1 });
  });

  it("strict is a no-op on an empty queue", () => {
    const low = issue("low", { priority: "low" });
    issue("critical", { priority: "critical" });
    strict();
    // Every row is in the unqueued band, and the unqueued band is presentation
    // sort — a default, not a human's statement that this comes before that. So
    // it refuses nothing, including the row presentation sort ranks last.
    expect(store.checkoutIssue(low, "agent-1").identifier).toBe(low);
  });

  it("still lets the existing holder re-claim", () => {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    store.checkoutIssue(later, "agent-1");
    strict();
    // Mid-flight work, not a pickup: the crash-recovery re-claim runs before the
    // guard, so a strict policy switched on underneath an agent cannot orphan
    // the claim it is trying to recover.
    expect(store.checkoutIssue(later, "agent-1").checkoutAgent).toBe("agent-1");
  });

  it("is not bypassed by --steal-if-stale", () => {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    store.checkoutIssue(later, "dead-agent");
    strict();
    // A stale holder and a plan are unrelated facts, and a takeover answers the
    // first one only.
    refused(() => store.checkoutIssue(later, "agent-1", undefined, { stealIfIdleSeconds: 0 }), "out_of_order");
    expect(store.getIssue(later).checkoutAgent).toBe("dead-agent");
  });
});

describe("hard constraints are never bypassed by rank", () => {
  it("rank cannot lift a blocked row", () => {
    const blocker = issue("blocker");
    const blocked = issue("blocked one");
    store.setBlockedBy(blocked, [blocker], "vp");
    queue.enqueue(blocked, {}, "vp");
    strict();
    // Position 1 in the plan, and still refused — by the ordinary conflict the
    // blocker has always produced, not by anything the queue added.
    expect(queue.effectiveQueue().rows[0]).toMatchObject({ identifier: blocked, position: 1 });
    refused(() => store.checkoutIssue(blocked, "agent-1"), "conflict");
  });

  it("rank cannot lift a gated row", () => {
    const epic = issue("S", { kind: "epic" });
    const child = issue("S1", { parent: epic });
    queue.enqueue(child, {}, "vp");
    store.gateIssue(epic, { owner: "vp" }, "vp");
    strict();
    refused(() => store.checkoutIssue(child, "agent-1"), "gated");
  });

  it("approve re-derives effective order on the next read", () => {
    const epic = issue("S", { kind: "epic" });
    const child = issue("S1", { parent: epic });
    const other = issue("other");
    queue.enqueue(child, {}, "vp");
    queue.enqueue(other, {}, "vp");
    store.gateIssue(epic, { owner: "vp" }, "vp");
    expect(queue.effectiveQueue().next?.identifier).toBe(other);
    const revisionWhileGated = queue.revision();

    store.approveGate(epic, {}, "vp");
    // No queue write happened or was needed: eligibility is derived, so the very
    // next read has the new answer at the same revision.
    expect(queue.effectiveQueue().next?.identifier).toBe(child);
    expect(queue.revision()).toBe(revisionWhileGated);
  });
});

// --------------------------------------------------------------- the override

describe("human override", () => {
  function twoRowPlan(): { first: string; later: string } {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    strict();
    return { first, later };
  }

  it("override takes a later row and records why", () => {
    const { later } = twoRowPlan();
    const claimed = store.checkoutIssue(later, "vp", undefined, { overrideReason: "CI is red for everyone" });
    expect(claimed.checkoutAgent).toBe("vp");
  });

  it("override requires a reason", () => {
    const { later } = twoRowPlan();
    const error = refused(() => store.checkoutIssue(later, "vp", undefined, { overrideReason: "   " }), "validation");
    expect(error.message).toContain("An override needs a reason");
    expect(store.getIssue(later).checkoutAgent).toBeNull();
  });

  it("override does not bypass a gate, a blocker or a live claim", () => {
    const epic = issue("S", { kind: "epic" });
    const gated = issue("S1", { parent: epic });
    const blocker = issue("blocker");
    const blocked = issue("blocked one");
    const held = issue("held one");
    store.setBlockedBy(blocked, [blocker], "vp");
    store.checkoutIssue(held, "other-agent");
    store.gateIssue(epic, { owner: "vp" }, "vp");
    strict();
    // "Take this out of turn", never "take this regardless".
    refused(() => store.checkoutIssue(gated, "vp", undefined, { overrideReason: "because" }), "gated");
    refused(() => store.checkoutIssue(blocked, "vp", undefined, { overrideReason: "because" }), "conflict");
    refused(() => store.checkoutIssue(held, "vp", undefined, { overrideReason: "because" }), "conflict");
  });

  it("emits queue_overridden with actor, reason and the displaced rows", () => {
    const { first, later } = twoRowPlan();
    store.checkoutIssue(later, "vp", undefined, { overrideReason: "CI is red for everyone" });
    const event = store.listEvents(0, 100).find((e) => e.kind === "queue_overridden")!;
    expect(event.actor).toBe("vp");
    expect(event.payload).toEqual({
      identifier: later,
      reason: "CI is red for everyone",
      policy: "strict",
      expected: [first],
      position: 2,
      expectedPosition: 1,
    });
  });

  it("writes the event under advisory too, where nothing was refused", () => {
    const first = issue("first");
    const later = issue("later");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(later, {}, "vp");
    store.checkoutIssue(later, "vp", undefined, { overrideReason: "wanted it" });
    // The audit trail is the point of the flag, not the refusal.
    const event = store.listEvents(0, 100).find((e) => e.kind === "queue_overridden")!;
    expect(event.payload).toMatchObject({ policy: "advisory", expected: [first] });
  });

  it("an override does not reorder the plan", () => {
    const { first, later } = twoRowPlan();
    const revisionBefore = queue.revision();
    store.checkoutIssue(later, "vp", undefined, { overrideReason: "CI is red for everyone" });
    expect(queue.entries({ all: true }).map((entry) => entry.identifier)).toEqual([first, later]);
    expect(queue.revision()).toBe(revisionBefore);
    // The displaced row is still the head for the next agent.
    expect(queue.effectiveQueue({ actor: "agent-1" }).next?.identifier).toBe(first);
  });
});
