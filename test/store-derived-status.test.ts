import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { type IssueStatus, MAX_TREE_DEPTH } from "../src/core/types.js";

/**
 * STA-98 — a parent's status is DERIVED from its open children, holistically.
 *
 * STA-79 shipped one half of this: a one-way flip into `in_progress` when a
 * child started. This is the generalization — a full recompute on every child
 * transition, over open children only, reversible, and confined to statuses
 * derivation itself set. These tests pin the ladder, the immunities, and every
 * way the rule must decline to act.
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

function eventsFor(ref: string) {
  const id = store.getIssue(ref).id;
  return store.listEvents(0, 1000).filter((e) => e.issueId === id);
}

function statusEventsFor(ref: string) {
  return eventsFor(ref).filter((e) => e.kind === "status_changed");
}

/**
 * Move a child into `status` the way the world actually would — through the
 * store's own transitions, so the recompute fires exactly as it does in
 * production. Nothing here reaches past the store into raw SQL.
 */
function move(
  ref: string,
  status: IssueStatus,
  opts: { unblockOwner?: string; unblockAction?: string; actor?: string } = {},
): void {
  const actor = opts.actor ?? "agent-a";
  if (status === "in_progress") {
    store.checkoutIssue(ref, actor);
    return;
  }
  if (status === "blocked") {
    store.updateIssue(
      ref,
      { status, unblockOwner: opts.unblockOwner, unblockAction: opts.unblockAction },
      actor,
    );
    return;
  }
  store.updateIssue(ref, { status }, actor);
}

/** An epic with `n` children, everything in backlog and nothing derived yet. */
function epicWith(n: number, name = "Epic") {
  const epic = store.createIssue({ title: name });
  const children = Array.from({ length: n }, (_, i) =>
    store.createIssue({ title: `${name} child ${i + 1}`, parent: epic.identifier }),
  );
  return { epic, children };
}

/** Build an epic, drive its children into `statuses`, return the epic's status. */
let deriveSeq = 0;
function deriveFrom(statuses: readonly IssueStatus[]): string {
  deriveSeq += 1;
  const { epic, children } = epicWith(statuses.length, `Epic ${deriveSeq}`);
  statuses.forEach((status, i) => {
    if (status === "backlog") return; // already there
    move(children[i]!.identifier, status, status === "blocked" ? { unblockOwner: "VP" } : {});
  });
  return statusOf(epic.identifier);
}

// ---------------------------------------------------------------------------

describe("the ladder: precedence over OPEN children", () => {
  it("rung 1 — any in_progress child wins outright", () => {
    expect(deriveFrom(["in_progress"])).toBe("in_progress");
    expect(deriveFrom(["in_progress", "in_review"])).toBe("in_progress");
    expect(deriveFrom(["in_progress", "blocked"])).toBe("in_progress");
    expect(deriveFrom(["blocked", "backlog", "in_progress"])).toBe("in_progress");
  });

  it("rung 2 — in_review wins when nothing is in_progress", () => {
    expect(deriveFrom(["in_review"])).toBe("in_review");
    expect(deriveFrom(["in_review", "backlog"])).toBe("in_review");
    expect(deriveFrom(["blocked", "in_review"])).toBe("in_review");
    expect(deriveFrom(["done", "in_review"])).toBe("in_review");
  });

  it("rung 3 — a workable child leaves the epic in the unstarted band", () => {
    expect(deriveFrom(["backlog"])).toBe("backlog");
    expect(deriveFrom(["todo"])).toBe("backlog");
    expect(deriveFrom(["done", "todo"])).toBe("backlog");
  });

  it("rung 4 — blocked only when every open child is blocked", () => {
    expect(deriveFrom(["blocked"])).toBe("blocked");
    expect(deriveFrom(["blocked", "blocked"])).toBe("blocked");
    expect(deriveFrom(["done", "blocked"])).toBe("blocked");
    expect(deriveFrom(["done", "done", "done", "blocked"])).toBe("blocked");
  });

  it("resolved children are invisible to the ladder", () => {
    // done/cancelled contribute nothing at any rung — the epic reads only what
    // is still open underneath it.
    expect(deriveFrom(["cancelled", "in_progress"])).toBe("in_progress");
    expect(deriveFrom(["done", "cancelled", "blocked"])).toBe("blocked");
  });

  it("is level-triggered, so the ORDER the children moved in cannot change the answer", () => {
    // Same final child landscape, opposite build order, same epic status.
    expect(deriveFrom(["blocked", "in_review"])).toBe("in_review");
    expect(deriveFrom(["in_review", "blocked"])).toBe("in_review");
  });
});

describe("blocked is exclusive — Refinement 1", () => {
  it("1 blocked + 1 backlog child does NOT derive blocked", () => {
    const { epic, children } = epicWith(2);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide" });

    // The second child is untouched backlog: there is still workable work.
    expect(statusOf(epic.identifier)).toBe("backlog");
    expect(statusOf(children[1]!.identifier)).toBe("backlog");
  });

  it("1 blocked + 1 todo child does NOT derive blocked", () => {
    const { epic, children } = epicWith(2);
    move(children[1]!.identifier, "todo");
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP" });

    expect(statusOf(epic.identifier)).not.toBe("blocked");
  });

  it("blocked wins the moment it is all that remains", () => {
    // VP's STA-80 case: the sole open child is blocked.
    const { epic, children } = epicWith(2);
    move(children[0]!.identifier, "done");
    move(children[1]!.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide" });

    expect(statusOf(epic.identifier)).toBe("blocked");
  });
});

describe("derivation un-derives when the child landscape changes", () => {
  it("blocked child unblocks -> epic leaves derived blocked", () => {
    const { epic, children } = epicWith(1);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide" });
    expect(statusOf(epic.identifier)).toBe("blocked");

    move(children[0]!.identifier, "todo");

    expect(statusOf(epic.identifier)).toBe("backlog");
  });

  it("blocked child COMPLETES -> epic leaves derived blocked too", () => {
    const { epic, children } = epicWith(2);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP" });
    move(children[1]!.identifier, "blocked", { unblockOwner: "VP" });
    expect(statusOf(epic.identifier)).toBe("blocked");

    // One blocked child is finished outright rather than unblocked.
    move(children[0]!.identifier, "done");

    // Still all-open-blocked, so still blocked.
    expect(statusOf(epic.identifier)).toBe("blocked");

    move(children[1]!.identifier, "done");

    // Now everything is resolved: rung 6 closes the epic (STA-153). Before that
    // ticket this was rung 0 and the epic sat in `blocked` forever.
    expect(statusOf(epic.identifier)).toBe("done");
  });

  it("clears the derived blocked descriptor fields when it leaves blocked", () => {
    const { epic, children } = epicWith(1);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide" });
    const blocked = store.getIssue(epic.identifier);
    expect(blocked.status).toBe("blocked");
    expect(blocked.blockedTransitionAt).not.toBeNull();

    move(children[0]!.identifier, "todo");

    const after = store.getIssue(epic.identifier);
    expect(after.unblockOwner).toBeNull();
    expect(after.unblockAction).toBeNull();
    expect(after.blockedTransitionAt).toBeNull();
  });

  it("the last in_progress child stopping drops the epic out of in_progress", () => {
    const { epic, children } = epicWith(2);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    // A sibling is still open and workable -> back into the unstarted band.
    expect(statusOf(epic.identifier)).toBe("backlog");
  });

  it("a RELEASE is a child transition too — the site STA-79 never had", () => {
    const { epic, children } = epicWith(2);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");

    store.releaseIssue(children[0]!.identifier, "agent-a");

    // Nothing is in flight any more; the epic must stop claiming it is.
    expect(statusOf(children[0]!.identifier)).toBe("todo");
    expect(statusOf(epic.identifier)).toBe("backlog");
  });
});

describe("derivation may only change what derivation set", () => {
  it("never overrides a MANUAL blocked, and never rewrites its descriptor", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(
      epic.identifier,
      { status: "blocked", unblockOwner: "vlad", unblockAction: "decide the schema" },
      "human",
    );

    // A child starting would otherwise derive in_progress.
    store.checkoutIssue(children[0]!.identifier, "agent-a");

    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("blocked");
    expect(after.unblockOwner).toBe("vlad");
    expect(after.unblockAction).toBe("decide the schema");
  });

  it("never downgrades a MANUAL in_review", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(epic.identifier, { status: "in_review" }, "human");

    // The child is merely workable — rung 3 would pull the epic into the band.
    move(children[0]!.identifier, "todo");

    expect(statusOf(epic.identifier)).toBe("in_review");
  });

  it("never touches a MANUAL in_progress — a real claim beats a derivation", () => {
    const { epic, children } = epicWith(1);
    store.checkoutIssue(epic.identifier, "human"); // a genuine claim ON the epic
    expect(store.getIssue(epic.identifier).checkoutAgent).toBe("human");

    move(children[0]!.identifier, "blocked", { unblockOwner: "VP" });

    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("in_progress");
    expect(after.checkoutAgent).toBe("human"); // the claim survives untouched
  });

  it("DOES move a status it set itself — that is the whole point", () => {
    const { epic, children } = epicWith(1);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress"); // derived

    store.updateIssue(children[0]!.identifier, { status: "in_review" }, "agent-a");

    expect(statusOf(epic.identifier)).toBe("in_review");
  });

  it("a manual status set ON TOP of a derived one becomes immune from then on", () => {
    const { epic, children } = epicWith(1);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress"); // derived

    // A human parks the epic explicitly. That is now a statement, not a report.
    store.updateIssue(
      epic.identifier,
      { status: "blocked", unblockOwner: "vlad", unblockAction: "approve the design" },
      "human",
    );

    store.updateIssue(children[0]!.identifier, { status: "in_review" }, "agent-a");

    expect(statusOf(epic.identifier)).toBe("blocked");
    expect(store.getIssue(epic.identifier).unblockOwner).toBe("vlad");
  });

  it("leaves backlog and todo alone as ONE band — no churn either way", () => {
    // A todo epic is not demoted to backlog by unstarted children...
    const epic = store.createIssue({ title: "Epic", assignee: "planner" });
    expect(statusOf(epic.identifier)).toBe("todo");
    const child = store.createIssue({ title: "Child", parent: epic.identifier });
    expect(statusOf(epic.identifier)).toBe("todo");

    move(child.identifier, "todo");
    expect(statusOf(epic.identifier)).toBe("todo");

    // ...and no event was written at all, because nothing changed.
    expect(statusEventsFor(epic.identifier)).toHaveLength(0);
  });
});

/**
 * STA-153. The ladder gained two rungs and LOST its exception: resolved is no
 * longer terminal, it is just another status the reversibility law governs.
 */
describe("rung 6 — the last open child closes the parent", () => {
  it("completing the last open child flips the epic to done", () => {
    const { epic, children } = epicWith(2);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("backlog"); // a sibling is still open

    store.updateIssue(children[1]!.identifier, { status: "done" }, "agent-a");

    expect(statusOf(epic.identifier)).toBe("done");
  });

  it("stamps completedAt, exactly as a manual close does", () => {
    const { epic, children } = epicWith(1);
    expect(store.getIssue(epic.identifier).completedAt).toBeNull();

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    expect(store.getIssue(epic.identifier).completedAt).not.toBeNull();
  });

  it("marks the close derived, and names the child that caused it", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    const last = statusEventsFor(epic.identifier).at(-1)!;
    expect(last.payload).toMatchObject({
      to: "done",
      derived: "children_resolved",
      derivedFrom: children[0]!.identifier,
    });
    expect(last.actor).toBe("agent-a");
  });

  it("mixed done and cancelled reads done — one shipped child means shipped", () => {
    expect(deriveFrom(["done", "cancelled"])).toBe("done");
    expect(deriveFrom(["cancelled", "done", "cancelled"])).toBe("done");
  });

  it("still fires children_complete — the close cannot write the summary", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    const kinds = eventsFor(epic.identifier).map((e) => e.kind);
    expect(kinds).toContain("children_complete");
    // The wake is evaluated BEFORE the epic closes, and the log reads
    // cause-then-effect: children complete, therefore the epic is done.
    expect(kinds.indexOf("children_complete")).toBeLessThan(kinds.lastIndexOf("status_changed"));
  });

  it("wakes whatever was blocked on the epic itself", () => {
    const { epic, children } = epicWith(1);
    const dependent = store.createIssue({ title: "Needs the epic" });
    store.setBlockedBy(dependent.identifier, [epic.identifier]);

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    expect(statusOf(epic.identifier)).toBe("done");
    const wakes = store.listEvents(0, 1000).filter((e) => e.kind === "blockers_resolved");
    expect(wakes.map((e) => e.issueId)).toContain(store.getIssue(dependent.identifier).id);
  });

  it("is idempotent — a recompute that changes nothing writes nothing", () => {
    const { epic, children } = epicWith(2);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    store.updateIssue(children[1]!.identifier, { status: "done" }, "agent-a");
    const closed = store.getIssue(epic.identifier);
    const events = eventsFor(epic.identifier).length;

    // Another resolved-to-resolved child transition: same verdict, no write.
    store.updateIssue(children[1]!.identifier, { status: "cancelled" }, "agent-a");

    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("done");
    expect(after.statusVersion).toBe(closed.statusVersion);
    expect(after.completedAt).toBe(closed.completedAt);
    expect(eventsFor(epic.identifier)).toHaveLength(events);
  });
});

describe("rung 5 — cancelled needs unanimity", () => {
  it("cancelling every child cancels the epic", () => {
    const { epic, children } = epicWith(2);
    store.updateIssue(children[0]!.identifier, { status: "cancelled" }, "agent-a");
    store.updateIssue(children[1]!.identifier, { status: "cancelled" }, "agent-a");

    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("cancelled");
    expect(after.cancelledAt).not.toBeNull();
    expect(statusEventsFor(epic.identifier).at(-1)!.payload).toMatchObject({
      to: "cancelled",
      derived: "children_cancelled",
    });
  });

  it("a revived child moves the epic from cancelled to done, stamp and all", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "cancelled" }, "agent-a");
    expect(store.getIssue(epic.identifier).cancelledAt).not.toBeNull();

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("done");
    expect(after.completedAt).not.toBeNull();
    // The stamp that no longer applies goes with it — no row claiming both.
    expect(after.cancelledAt).toBeNull();
  });

  it("one done child among the cancelled ones is enough to read done", () => {
    expect(deriveFrom(["cancelled", "cancelled"])).toBe("cancelled");
    expect(deriveFrom(["cancelled", "cancelled", "done"])).toBe("done");
  });
});

describe("re-opening a child re-opens the parent", () => {
  it("a reopened child pulls the epic back to the rung its children imply", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("done");

    store.updateIssue(children[0]!.identifier, { status: "todo" }, "agent-a");

    // One open, workable child -> the unstarted band, not a guess at in_progress.
    expect(statusOf(epic.identifier)).toBe("backlog");
  });

  it("clears completedAt on the way back out", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    expect(store.getIssue(epic.identifier).completedAt).not.toBeNull();

    store.updateIssue(children[0]!.identifier, { status: "todo" }, "agent-a");

    const after = store.getIssue(epic.identifier);
    expect(after.completedAt).toBeNull();
    expect(after.cancelledAt).toBeNull();
  });

  it("a child STARTING again lands the epic straight in in_progress", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("done");

    store.updateIssue(children[0]!.identifier, { status: "todo" }, "agent-a");
    store.checkoutIssue(children[0]!.identifier, "agent-a");

    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("a NEW open child under a closed epic re-opens it", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("done");

    store.createIssue({ title: "One more thing", parent: epic.identifier });

    expect(statusOf(epic.identifier)).toBe("backlog");
  });

  it("closes again when the reopened child lands, and stamps a fresh completedAt", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");
    const first = store.getIssue(epic.identifier).completedAt;
    store.updateIssue(children[0]!.identifier, { status: "todo" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("backlog");

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("done");
    expect(after.completedAt).not.toBeNull();
    expect(first).not.toBeNull();
  });
});

describe("the closing rungs obey the SAME reversibility law as every other rung", () => {
  it("never re-opens a MANUALLY done epic when a child moves", () => {
    const { epic, children } = epicWith(2);
    store.updateIssue(epic.identifier, { status: "done" }, "human");

    store.checkoutIssue(children[0]!.identifier, "agent-a");

    expect(statusOf(epic.identifier)).toBe("done");
  });

  it("never re-opens a MANUALLY cancelled epic either", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(epic.identifier, { status: "cancelled" }, "human");

    move(children[0]!.identifier, "blocked", { unblockOwner: "VP" });

    expect(statusOf(epic.identifier)).toBe("cancelled");
  });

  it("does not close an epic a human parked in blocked", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(
      epic.identifier,
      { status: "blocked", unblockOwner: "vlad", unblockAction: "decide whether to ship" },
      "human",
    );

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    // The human's pending decision outranks the tracker's opinion; the nudge is
    // still delivered.
    const after = store.getIssue(epic.identifier);
    expect(after.status).toBe("blocked");
    expect(after.unblockOwner).toBe("vlad");
    expect(eventsFor(epic.identifier).map((e) => e.kind)).toContain("children_complete");
  });

  it("does not close an epic an agent genuinely claimed", () => {
    const { epic, children } = epicWith(1);
    store.checkoutIssue(epic.identifier, "human");

    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    expect(statusOf(epic.identifier)).toBe("in_progress");
    expect(store.getIssue(epic.identifier).checkoutAgent).toBe("human");
  });

  it("an explicit close on top of a derived one still works, and is idempotent", () => {
    const { epic, children } = epicWith(2);
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    // Closed by hand while a child is still open — allowed, and it sticks.
    store.updateIssue(epic.identifier, { status: "done", comment: "shipping it" }, "human");
    expect(statusOf(epic.identifier)).toBe("done");
    const closed = store.getIssue(epic.identifier);

    // Re-running it is a no-op, not an error and not a second event.
    const events = eventsFor(epic.identifier).length;
    store.updateIssue(epic.identifier, { status: "done" }, "human");
    expect(statusOf(epic.identifier)).toBe("done");
    expect(store.getIssue(epic.identifier).statusVersion).toBe(closed.statusVersion);
    expect(eventsFor(epic.identifier)).toHaveLength(events);

    // And the still-open child cannot pull it back out — that was a statement.
    store.checkoutIssue(children[1]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("done");
  });

  it("leaves a childless issue alone, forever — rung 0", () => {
    const leaf = store.createIssue({ title: "Leaf", assignee: "agent-a" });
    const before = store.getIssue(leaf.identifier);

    store.checkoutIssue(leaf.identifier, "agent-a");
    store.updateIssue(leaf.identifier, { status: "in_review" }, "agent-a");

    // Its own transitions moved it; nothing DERIVED anything onto it.
    expect(statusEventsFor(leaf.identifier).every((e) => e.payload.derived === undefined)).toBe(
      true,
    );
    expect(before.status).toBe("todo");
  });
});

describe("the cascade is multi-level", () => {
  it("recomputes every ancestor, not only the immediate parent", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: mid.identifier });

    move(leaf.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide" });

    // leaf blocked -> mid derives blocked -> root's only child (mid) is blocked
    // -> root derives blocked. Three levels, one transaction.
    expect(statusOf(mid.identifier)).toBe("blocked");
    expect(statusOf(root.identifier)).toBe("blocked");
  });

  it("un-derives all the way back up", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: mid.identifier });
    move(leaf.identifier, "blocked", { unblockOwner: "VP" });
    expect(statusOf(root.identifier)).toBe("blocked");

    store.checkoutIssue(leaf.identifier, "agent-a");

    expect(statusOf(mid.identifier)).toBe("in_progress");
    expect(statusOf(root.identifier)).toBe("in_progress");
  });

  it("closes the whole chain — a grandparent follows through its child parent", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: mid.identifier });
    store.checkoutIssue(leaf.identifier, "agent-a");
    expect(statusOf(root.identifier)).toBe("in_progress");

    store.updateIssue(leaf.identifier, { status: "done" }, "agent-a");

    // leaf done -> mid's last child landed -> mid done -> root's last child
    // landed -> root done. One transaction, and each level got its own wake.
    expect(statusOf(mid.identifier)).toBe("done");
    expect(statusOf(root.identifier)).toBe("done");
    expect(store.getIssue(root.identifier).completedAt).not.toBeNull();
    expect(eventsFor(mid.identifier).map((e) => e.kind)).toContain("children_complete");
    expect(eventsFor(root.identifier).map((e) => e.kind)).toContain("children_complete");
  });

  it("re-opens the whole chain when the deep child comes back", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: mid.identifier });
    store.updateIssue(leaf.identifier, { status: "done" }, "agent-a");
    expect(statusOf(root.identifier)).toBe("done");

    store.updateIssue(leaf.identifier, { status: "todo" }, "agent-a");
    store.checkoutIssue(leaf.identifier, "agent-a");

    expect(statusOf(leaf.identifier)).toBe("in_progress");
    expect(statusOf(mid.identifier)).toBe("in_progress");
    expect(statusOf(root.identifier)).toBe("in_progress");
    expect(store.getIssue(root.identifier).completedAt).toBeNull();
  });

  it("cancelling the only leaf cancels every level above it", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: mid.identifier });

    store.updateIssue(leaf.identifier, { status: "cancelled" }, "agent-a");

    expect(statusOf(mid.identifier)).toBe("cancelled");
    expect(statusOf(root.identifier)).toBe("cancelled");
  });

  it("a mid-chain MANUAL status stops propagating its own value, not the walk", () => {
    const root = store.createIssue({ title: "Root" });
    const mid = store.createIssue({ title: "Mid", parent: root.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: mid.identifier });
    store.updateIssue(mid.identifier, { status: "in_review" }, "human");

    store.checkoutIssue(leaf.identifier, "agent-a");

    // mid is immune and stays in_review. The walk CONTINUES to root, which now
    // reads its own child honestly: root's only child is in_review.
    expect(statusOf(mid.identifier)).toBe("in_review");
    expect(statusOf(root.identifier)).toBe("in_review");
  });

  it("stays bounded on a corrupted parent cycle", () => {
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B", parent: a.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: b.identifier });
    store.db
      .prepare("UPDATE issues SET parent_id = ? WHERE id = ?")
      .run(store.getIssue(b.identifier).id, store.getIssue(a.identifier).id);

    expect(() => store.checkoutIssue(leaf.identifier, "agent-a")).not.toThrow();
    expect(statusOf(a.identifier)).toBe("in_progress");
    expect(statusOf(b.identifier)).toBe("in_progress");
  });

  it("climbs a deep chain without blowing the stack", () => {
    const depth = 40;
    expect(depth).toBeLessThan(MAX_TREE_DEPTH);
    let parent = store.createIssue({ title: "root" });
    const root = parent;
    for (let i = 0; i < depth; i += 1) {
      parent = store.createIssue({ title: `n${i}`, parent: parent.identifier });
    }

    move(parent.identifier, "blocked", { unblockOwner: "VP" });

    expect(statusOf(root.identifier)).toBe("blocked");
  });
});

describe("a derivation is a report, not a claim (STA-79's exemption, generalized)", () => {
  it("never invents an assignee or a claim, at ANY rung", () => {
    for (const status of ["in_progress", "in_review", "blocked"] as const) {
      const store2 = memStore();
      const epic = store2.createIssue({ title: "Epic" });
      const child = store2.createIssue({ title: "Child", parent: epic.identifier });
      if (status === "in_progress") store2.checkoutIssue(child.identifier, "agent-a");
      else if (status === "blocked") {
        store2.updateIssue(child.identifier, { status, unblockOwner: "VP" }, "agent-a");
      } else store2.updateIssue(child.identifier, { status }, "agent-a");

      const derived = store2.getIssue(epic.identifier);
      expect(derived.status, `rung ${status}`).toBe(status);
      expect(derived.assignee).toBeNull();
      expect(derived.checkoutAgent).toBeNull();
      expect(derived.checkoutAt).toBeNull();
      // No claim => no liveness => nothing a takeover can act on.
      expect(store2.claimActivity(epic.identifier)).toBeNull();
    }
  });

  it("derives past guards that would refuse the same transition manually", () => {
    const { epic, children } = epicWith(1);
    const blocker = store.createIssue({ title: "Upstream" });
    store.setBlockedBy(epic.identifier, [blocker.identifier], "human");

    expect(() =>
      store.updateIssue(epic.identifier, { status: "in_progress", assignee: "human" }, "human"),
    ).toThrow(/unresolved blockers/);

    store.checkoutIssue(children[0]!.identifier, "agent-a");

    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("a derived-blocked parent gets NO unblock descriptor of its own", () => {
    const { epic, children } = epicWith(1);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide the API" });

    const derived = store.getIssue(epic.identifier);
    expect(derived.status).toBe("blocked");
    // The descriptor lives on the CHILD. The parent borrows it at render time.
    expect(derived.unblockOwner).toBeNull();
    expect(derived.unblockAction).toBeNull();
  });
});

describe("the derived event payload", () => {
  it("reuses status_changed and names the rule and the trigger", () => {
    const { epic, children } = epicWith(1);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP", actor: "agent-a" });

    expect(eventsFor(epic.identifier).map((e) => e.kind)).toEqual(["issue_created", "status_changed"]);
    const event = statusEventsFor(epic.identifier).at(-1)!;
    expect(event.actor).toBe("agent-a"); // the child's actor caused it
    expect(event.payload).toMatchObject({
      identifier: epic.identifier,
      from: "backlog",
      to: "blocked",
      derived: "children_blocked",
      derivedFrom: children[0]!.identifier,
    });
  });

  it("carries a distinct marker per rung", () => {
    const cases: Array<[IssueStatus, string]> = [
      ["in_progress", "child_started"],
      ["in_review", "child_in_review"],
      ["blocked", "children_blocked"],
    ];
    for (const [childStatus, marker] of cases) {
      const store2 = memStore();
      store = store2;
      const { epic, children } = epicWith(1);
      move(children[0]!.identifier, childStatus, { unblockOwner: "VP" });
      const event = statusEventsFor(epic.identifier).at(-1)!;
      expect(event.payload.derived, `${childStatus} -> ${marker}`).toBe(marker);
    }
  });

  it("marks the un-derive back into the workable band too", () => {
    const { epic, children } = epicWith(2);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    store.updateIssue(children[0]!.identifier, { status: "done" }, "agent-a");

    const event = statusEventsFor(epic.identifier).at(-1)!;
    expect(event.payload).toMatchObject({
      from: "in_progress",
      to: "backlog",
      derived: "children_workable",
    });
  });

  it("a manual transition is still NOT marked derived", () => {
    const solo = store.createIssue({ title: "Solo", assignee: "human" });
    store.updateIssue(solo.identifier, { status: "in_review" }, "human");
    expect(statusEventsFor(solo.identifier).at(-1)!.payload.derived).toBeUndefined();
  });

  it("writes no event when the recompute is a no-op", () => {
    const { epic, children } = epicWith(2);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    const first = statusEventsFor(epic.identifier).length;

    store.checkoutIssue(children[1]!.identifier, "agent-b");

    expect(statusEventsFor(epic.identifier)).toHaveLength(first);
  });
});

describe("every hook site fires the recompute", () => {
  it("createIssue — a child born blocked under a fresh epic", () => {
    const epic = store.createIssue({ title: "Epic" });
    store.createIssue({
      title: "Child",
      parent: epic.identifier,
      status: "blocked",
      unblockOwner: "VP",
      createdBy: "agent-a",
    });
    expect(statusOf(epic.identifier)).toBe("blocked");
  });

  it("updateIssue — any status change, not only into in_progress", () => {
    const { epic, children } = epicWith(1);
    store.updateIssue(children[0]!.identifier, { status: "in_review" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_review");
  });

  it("checkoutIssue — the plain claim", () => {
    const { epic, children } = epicWith(1);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("checkoutIssue — the stale-claim takeover", () => {
    const { epic, children } = epicWith(1);
    const leaf = children[0]!;
    store.checkoutIssue(leaf.identifier, "agent-a");

    // Park the epic underneath the store, the way STA-79's suite does: the
    // takeover must be able to light it up again from the pre-work band.
    store.db
      .prepare("UPDATE issues SET status = 'backlog' WHERE id = ?")
      .run(store.getIssue(epic.identifier).id);
    const at = new Date(Date.now() - 7200 * 1000).toISOString();
    const leafId = store.getIssue(leaf.identifier).id;
    store.db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(at, leafId);
    store.db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(at, leafId);

    store.checkoutIssue(leaf.identifier, "agent-b", undefined, { stealIfIdleSeconds: 3600 });

    expect(statusOf(epic.identifier)).toBe("in_progress");
    expect(statusEventsFor(epic.identifier).at(-1)!.actor).toBe("agent-b");
  });

  it("releaseIssue — giving a claim back", () => {
    const { epic, children } = epicWith(1);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    store.releaseIssue(children[0]!.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("backlog");
  });

  it("rolls the ancestor write back with the child's own failed transaction", () => {
    const { epic, children } = epicWith(1);
    const blocker = store.createIssue({ title: "Upstream" });
    store.setBlockedBy(children[0]!.identifier, [blocker.identifier], "human");

    expect(() => store.checkoutIssue(children[0]!.identifier, "agent-a")).toThrow();

    expect(statusOf(epic.identifier)).toBe("backlog");
  });
});

describe("pickup semantics: a derived-blocked epic behaves like blocked", () => {
  it("leaves the ready list and lands in the blocked bucket", () => {
    const { epic, children } = epicWith(1);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP", unblockAction: "decide" });

    const inbox = store.inbox();
    expect(inbox.ready.map((i) => i.identifier)).not.toContain(epic.identifier);
    expect(inbox.blocked.map((i) => i.identifier)).toContain(epic.identifier);
  });

  it("returns to the ready list once the child unblocks", () => {
    const { epic, children } = epicWith(1);
    move(children[0]!.identifier, "blocked", { unblockOwner: "VP" });
    move(children[0]!.identifier, "todo");

    const inbox = store.inbox();
    expect(inbox.ready.map((i) => i.identifier)).toContain(epic.identifier);
    expect(inbox.blocked.map((i) => i.identifier)).not.toContain(epic.identifier);
  });

  it("a derived-in_progress epic is NOT checkoutable behind its own guard", () => {
    // It has no assignee and no claim, so it is a report on the board — not
    // something an agent picks up by accident.
    const { epic, children } = epicWith(1);
    store.checkoutIssue(children[0]!.identifier, "agent-a");
    expect(() => store.checkoutIssue(epic.identifier, "agent-b")).toThrow(/status is "in_progress"/);
  });
});

describe("blockingChildrenOf — what the UI renders on a derived-blocked parent", () => {
  it("returns each blocked open child with its descriptor", () => {
    const { epic, children } = epicWith(2);
    move(children[0]!.identifier, "blocked", {
      unblockOwner: "VP",
      unblockAction: "decide the schema",
    });
    move(children[1]!.identifier, "blocked", { unblockOwner: "ops", unblockAction: "grant access" });

    const found = store.blockingChildrenOf([store.getIssue(epic.identifier).id]);
    const rows = found.get(store.getIssue(epic.identifier).id) ?? [];
    expect(rows).toEqual([
      {
        identifier: children[0]!.identifier,
        title: "Epic child 1",
        unblockOwner: "VP",
        unblockAction: "decide the schema",
      },
      {
        identifier: children[1]!.identifier,
        title: "Epic child 2",
        unblockOwner: "ops",
        unblockAction: "grant access",
      },
    ]);
  });

  it("omits resolved children and children that are not blocked", () => {
    const { epic, children } = epicWith(3);
    move(children[0]!.identifier, "done");
    move(children[1]!.identifier, "blocked", { unblockOwner: "VP" });
    move(children[2]!.identifier, "todo");

    const epicId = store.getIssue(epic.identifier).id;
    const rows = store.blockingChildrenOf([epicId]).get(epicId) ?? [];
    expect(rows.map((r) => r.identifier)).toEqual([children[1]!.identifier]);
  });

  it("is empty for a parent with no blocked children", () => {
    const { epic } = epicWith(1);
    const epicId = store.getIssue(epic.identifier).id;
    expect(store.blockingChildrenOf([epicId]).get(epicId) ?? []).toEqual([]);
  });

  it("batches: one call answers for many parents", () => {
    const a = epicWith(1, "Alpha");
    const b = epicWith(1, "Beta");
    move(a.children[0]!.identifier, "blocked", { unblockOwner: "VP" });
    move(b.children[0]!.identifier, "blocked", { unblockOwner: "ops" });

    const ids = [store.getIssue(a.epic.identifier).id, store.getIssue(b.epic.identifier).id];
    const found = store.blockingChildrenOf(ids);
    expect(found.get(ids[0]!)![0]!.unblockOwner).toBe("VP");
    expect(found.get(ids[1]!)![0]!.unblockOwner).toBe("ops");
  });
});
