import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { type IssueStatus, MAX_TREE_DEPTH, StapleError } from "../src/core/types.js";

/**
 * STA-79 — an epic must READ as in_progress while its children are being worked.
 *
 * The old behaviour left an epic sitting in `backlog` while agents worked its
 * subtasks, so the board reported a lie. These tests pin the derivation that
 * fixes it, and — just as importantly — pin everything it must NOT do.
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

/** Force a status past the guard, to build a starting state the guard would refuse. */
function forceStatus(ref: string, status: IssueStatus): void {
  const row = store.getIssue(ref)!;
  store.db.prepare("UPDATE issues SET status = ? WHERE id = ?").run(status, row.id);
}

function statusOf(ref: string): string {
  return store.getIssue(ref)!.status;
}

/** Every event on `ref`, newest last, as the store recorded it. */
function eventsFor(ref: string) {
  const id = store.getIssue(ref)!.id;
  return store.listEvents(0, 500).filter((e) => e.issueId === id);
}

/** Just the status_changed events on `ref`, oldest first. */
function statusEventsFor(ref: string) {
  return eventsFor(ref).filter((e) => e.kind === "status_changed");
}

/** epic -> feature -> leaf, all in `backlog` (nothing assigned). */
function threeDeep() {
  const epic = store.createIssue({ title: "Epic" });
  const feature = store.createIssue({ title: "Feature", parent: epic.identifier });
  const leaf = store.createIssue({ title: "Leaf", parent: feature.identifier });
  return { epic, feature, leaf };
}

describe("a child entering in_progress lights up its ancestors", () => {
  it("flips parent AND grandparent from backlog, in one checkout", () => {
    const { epic, feature, leaf } = threeDeep();
    expect(statusOf(epic.identifier)).toBe("backlog");

    store.checkoutIssue(leaf.identifier, "agent-a");

    expect(statusOf(leaf.identifier)).toBe("in_progress");
    expect(statusOf(feature.identifier)).toBe("in_progress");
    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("flips ancestors that are in todo, not only backlog", () => {
    const epic = store.createIssue({ title: "Epic", assignee: "planner" }); // -> todo
    const leaf = store.createIssue({ title: "Leaf", parent: epic.identifier });
    expect(statusOf(epic.identifier)).toBe("todo");

    store.checkoutIssue(leaf.identifier, "agent-a");

    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("records started_at and bumps status_version on the ancestor", () => {
    const { epic, leaf } = threeDeep();
    const before = store.getIssue(epic.identifier)!;
    expect(before.startedAt).toBeNull();

    store.checkoutIssue(leaf.identifier, "agent-a");

    const after = store.getIssue(epic.identifier)!;
    expect(after.startedAt).not.toBeNull();
    // Anyone holding the old version must be forced to re-read.
    expect(after.statusVersion).toBe(before.statusVersion + 1);
  });
});

describe("the flip is a derivation, not a claim", () => {
  it("never invents an assignee or a claim on the epic", () => {
    const { epic, leaf } = threeDeep();

    store.checkoutIssue(leaf.identifier, "agent-a");

    const flipped = store.getIssue(epic.identifier)!;
    expect(flipped.status).toBe("in_progress");
    // The three fields that would make it look held by somebody.
    expect(flipped.assignee).toBeNull();
    expect(flipped.checkoutAgent).toBeNull();
    expect(flipped.checkoutAt).toBeNull();
  });

  it("leaves the derived epic unclaimed, so it can never be stolen as a dead claim", () => {
    const { epic, leaf } = threeDeep();
    store.checkoutIssue(leaf.identifier, "agent-a");

    // No claim => no liveness => nothing for a takeover to act on.
    expect(store.claimActivity(epic.identifier)).toBeNull();
  });

  it("flips even though the epic has no assignee — the guard would refuse this", () => {
    const { epic, leaf } = threeDeep();

    // Prove the guard really would have refused a manual start of the epic.
    expect(() => store.updateIssue(epic.identifier, { status: "in_progress" }, "human")).toThrow(
      /in_progress requires an assignee/,
    );

    store.checkoutIssue(leaf.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("flips even though the epic has an unresolved blocker — the guard would refuse this too", () => {
    const { epic, leaf } = threeDeep();
    const blocker = store.createIssue({ title: "Upstream" });
    store.setBlockedBy(epic.identifier, [blocker.identifier], "human");

    // The guard's other half: a blocked-by edge refuses a manual start outright.
    expect(() =>
      store.updateIssue(epic.identifier, { status: "in_progress", assignee: "human" }, "human"),
    ).toThrow(/unresolved blockers/);

    store.checkoutIssue(leaf.identifier, "agent-a");

    // A blocker answers "may this be started". It does not make the observed
    // fact — work IS happening underneath — untrue.
    expect(statusOf(epic.identifier)).toBe("in_progress");
  });
});

describe("the guard on manual transitions is completely unchanged", () => {
  it("still refuses a direct start with no assignee", () => {
    const solo = store.createIssue({ title: "Solo" });
    expect(() => store.updateIssue(solo.identifier, { status: "in_progress" }, "human")).toThrow(
      StapleError,
    );
    expect(statusOf(solo.identifier)).toBe("backlog");
  });

  it("still refuses a direct start behind an unresolved blocker", () => {
    const solo = store.createIssue({ title: "Solo", assignee: "human" });
    const blocker = store.createIssue({ title: "Upstream" });
    store.setBlockedBy(solo.identifier, [blocker.identifier], "human");
    expect(() =>
      store.updateIssue(solo.identifier, { status: "in_progress" }, "human"),
    ).toThrow(/unresolved blockers/);
    expect(statusOf(solo.identifier)).toBe("todo");
  });

  it("still refuses a checkout behind an unresolved blocker, parent or not", () => {
    const { leaf } = threeDeep();
    const blocker = store.createIssue({ title: "Upstream" });
    store.setBlockedBy(leaf.identifier, [blocker.identifier], "human");
    expect(() => store.checkoutIssue(leaf.identifier, "agent-a")).toThrow(/unresolved blockers/);
  });

  it("does not flip ancestors when the child's own start was refused", () => {
    const { epic, feature, leaf } = threeDeep();
    const blocker = store.createIssue({ title: "Upstream" });
    store.setBlockedBy(leaf.identifier, [blocker.identifier], "human");

    expect(() => store.checkoutIssue(leaf.identifier, "agent-a")).toThrow(StapleError);

    // The whole transaction rolled back, ancestors included.
    expect(statusOf(feature.identifier)).toBe("backlog");
    expect(statusOf(epic.identifier)).toBe("backlog");
  });
});

describe("ancestors that must be left alone", () => {
  it.each([
    ["in_progress"],
    ["in_review"],
    ["done"],
    ["cancelled"],
    ["blocked"],
  ] as const)("does not touch an ancestor already in %s", (status) => {
    const epic = store.createIssue({ title: "Epic" });
    const leaf = store.createIssue({ title: "Leaf", parent: epic.identifier });
    forceStatus(epic.identifier, status as IssueStatus);
    const before = store.getIssue(epic.identifier)!;

    store.checkoutIssue(leaf.identifier, "agent-a");

    const after = store.getIssue(epic.identifier)!;
    expect(after.status).toBe(status);
    // Untouched means untouched: no version bump, no event.
    expect(after.statusVersion).toBe(before.statusVersion);
    expect(eventsFor(epic.identifier).filter((e) => e.kind === "status_changed")).toHaveLength(0);
  });

  it("leaves a blocked epic blocked — that status is something the user said", () => {
    const { epic, feature, leaf } = threeDeep();
    store.updateIssue(
      epic.identifier,
      { status: "blocked", unblockOwner: "vlad", unblockAction: "decide the schema" },
      "human",
    );

    store.checkoutIssue(leaf.identifier, "agent-a");

    const after = store.getIssue(epic.identifier)!;
    expect(after.status).toBe("blocked");
    // The unblock instructions survive too — nothing about them was rewritten.
    expect(after.unblockOwner).toBe("vlad");
    expect(after.unblockAction).toBe("decide the schema");
    expect(statusOf(feature.identifier)).toBe("in_progress");
  });

  it("walks PAST an untouched ancestor instead of stopping at it", () => {
    // A mid-chain epic parked in in_review must not permanently shield the root:
    // the rule is a function of current state, not of what happened first.
    //
    // MOVED BY STA-98. The walk still continues past the untouched ancestor —
    // that is what this test is for, and it still passes. What changed is the
    // VALUE at the top. STA-79's one-way flip pushed `in_progress` all the way
    // up from the GRANDCHILD; the holistic rule has each ancestor read its OWN
    // children, and the root's own child is the feature, which reads in_review.
    // So the root now reports in_review, which is the honest answer: the thing
    // directly underneath the root is in review.
    const { epic, feature, leaf } = threeDeep();
    forceStatus(feature.identifier, "in_review");

    store.checkoutIssue(leaf.identifier, "agent-a");

    expect(statusOf(feature.identifier)).toBe("in_review");
    expect(statusOf(epic.identifier)).toBe("in_review");
    // The root DID move, which is the proof the walk did not stop at `feature`.
    expect(statusEventsFor(epic.identifier)).toHaveLength(1);
  });

  it("is idempotent: a second child starting changes nothing on an already-flipped epic", () => {
    const epic = store.createIssue({ title: "Epic" });
    const one = store.createIssue({ title: "One", parent: epic.identifier });
    const two = store.createIssue({ title: "Two", parent: epic.identifier });

    store.checkoutIssue(one.identifier, "agent-a");
    const afterFirst = store.getIssue(epic.identifier)!;
    store.checkoutIssue(two.identifier, "agent-b");
    const afterSecond = store.getIssue(epic.identifier)!;

    expect(afterSecond.statusVersion).toBe(afterFirst.statusVersion);
    expect(afterSecond.startedAt).toBe(afterFirst.startedAt);
    // Exactly one derived event, not one per child.
    expect(eventsFor(epic.identifier).filter((e) => e.kind === "status_changed")).toHaveLength(1);
  });

  it("still does not auto-close an epic when its children finish", () => {
    const epic = store.createIssue({ title: "Epic" });
    const leaf = store.createIssue({ title: "Leaf", parent: epic.identifier });
    store.checkoutIssue(leaf.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");

    store.updateIssue(leaf.identifier, { status: "done" }, "agent-a");

    // Opening up is derived; closing out stays deliberate. `children_complete`
    // is the nudge, and it is still only a nudge.
    expect(statusOf(epic.identifier)).toBe("in_progress");
    expect(eventsFor(epic.identifier).map((e) => e.kind)).toContain("children_complete");
  });
});

describe("attribution: the event names the child and the actor that caused it", () => {
  it("logs status_changed on the ancestor, carrying the trigger", () => {
    const { epic, feature, leaf } = threeDeep();

    store.checkoutIssue(leaf.identifier, "agent-a");

    const event = statusEventsFor(epic.identifier)[0]!;
    expect(event).toBeDefined();
    // The actor is the child's actor: they caused this, even though they never
    // touched the epic.
    expect(event.actor).toBe("agent-a");
    expect(event.payload).toMatchObject({
      identifier: epic.identifier,
      from: "backlog",
      to: "in_progress",
      derived: "child_started",
      derivedFrom: leaf.identifier,
    });

    // Each ancestor names the SAME triggering child, not its own descendant.
    const mid = statusEventsFor(feature.identifier)[0]!;
    expect(mid.payload.derivedFrom).toBe(leaf.identifier);
  });

  it("marks a normal transition as NOT derived, so consumers can tell them apart", () => {
    const solo = store.createIssue({ title: "Solo", assignee: "human" });
    store.updateIssue(solo.identifier, { status: "in_progress" }, "human");
    const event = statusEventsFor(solo.identifier)[0]!;
    expect(event.payload.derived).toBeUndefined();
  });

  it("reuses status_changed rather than a new kind, so the timeline renders it", () => {
    // The UI timeline switches on `kind` and only knows the existing set; an
    // unknown kind falls to its fail-soft branch and prints raw prose.
    const { epic, leaf } = threeDeep();
    store.checkoutIssue(leaf.identifier, "agent-a");
    expect(eventsFor(epic.identifier).map((e) => e.kind)).toEqual(["issue_created", "status_changed"]);
  });
});

describe("every path into in_progress triggers it, not just one", () => {
  it("via checkout — the common case, which does set status directly", () => {
    const { epic, leaf } = threeDeep();
    store.checkoutIssue(leaf.identifier, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("via updateIssue status change", () => {
    const epic = store.createIssue({ title: "Epic" });
    const leaf = store.createIssue({ title: "Leaf", parent: epic.identifier, assignee: "agent-a" });
    store.updateIssue(leaf.identifier, { status: "in_progress" }, "agent-a");
    expect(statusOf(epic.identifier)).toBe("in_progress");
  });

  it("via createIssue born in_progress under a backlog parent", () => {
    const epic = store.createIssue({ title: "Epic" });
    store.createIssue({
      title: "Leaf",
      parent: epic.identifier,
      status: "in_progress",
      assignee: "agent-a",
      createdBy: "agent-a",
    });
    expect(statusOf(epic.identifier)).toBe("in_progress");
    const event = statusEventsFor(epic.identifier)[0]!;
    expect(event.actor).toBe("agent-a");
  });

  it("via a stale-claim takeover, attributed to the agent that took over", () => {
    const { epic, leaf } = threeDeep();
    store.checkoutIssue(leaf.identifier, "agent-a");

    // The epic goes quiet again (someone parked it), then B rescues the leaf.
    store.db
      .prepare("UPDATE issues SET status = 'backlog' WHERE id = ?")
      .run(store.getIssue(epic.identifier)!.id);
    const at = new Date(Date.now() - 7200 * 1000).toISOString();
    const leafId = store.getIssue(leaf.identifier)!.id;
    store.db.prepare("UPDATE issues SET checkout_at = ? WHERE id = ?").run(at, leafId);
    store.db.prepare("UPDATE events SET created_at = ? WHERE issue_id = ?").run(at, leafId);

    store.checkoutIssue(leaf.identifier, "agent-b", undefined, { stealIfIdleSeconds: 3600 });

    expect(statusOf(epic.identifier)).toBe("in_progress");
    const derived = eventsFor(epic.identifier)
      .filter((e) => e.kind === "status_changed")
      .at(-1)!;
    expect(derived.actor).toBe("agent-b");
  });
});

describe("the walk is bounded", () => {
  it("climbs a deep chain without blowing the stack, and stops at the depth cap", () => {
    // Deep but legal: the store caps creation at MAX_TREE_DEPTH already.
    const depth = 40;
    let parent = store.createIssue({ title: "root" });
    const root = parent;
    for (let i = 0; i < depth; i += 1) {
      parent = store.createIssue({ title: `n${i}`, parent: parent.identifier });
    }

    store.checkoutIssue(parent.identifier, "agent-a");

    expect(depth).toBeLessThan(MAX_TREE_DEPTH);
    expect(statusOf(root.identifier)).toBe("in_progress");
  });

  it("terminates on a corrupted parent cycle instead of looping forever", () => {
    // Only reachable by writing bad data underneath the store, which is exactly
    // the case the bound exists for.
    const a = store.createIssue({ title: "A" });
    const b = store.createIssue({ title: "B", parent: a.identifier });
    const leaf = store.createIssue({ title: "Leaf", parent: b.identifier });
    store.db
      .prepare("UPDATE issues SET parent_id = ? WHERE id = ?")
      .run(store.getIssue(b.identifier)!.id, store.getIssue(a.identifier)!.id);

    expect(() => store.checkoutIssue(leaf.identifier, "agent-a")).not.toThrow();
    expect(statusOf(a.identifier)).toBe("in_progress");
    expect(statusOf(b.identifier)).toBe("in_progress");
  });
});

describe("the flip shows up in the read surfaces with no change to them", () => {
  it("reaches board, tree and list through the ordinary status projection", () => {
    const { epic, leaf } = threeDeep();
    store.checkoutIssue(leaf.identifier, "agent-a");

    const listed = store.listIssues({ status: ["in_progress"] }).map((i) => i.identifier);
    expect(listed).toContain(epic.identifier);

    const node = store.tree(epic.identifier)[0]!;
    expect(node.issue.status).toBe("in_progress");
  });
});
