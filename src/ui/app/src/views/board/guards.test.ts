/**
 * U6 — the advisory half of the board's guard story.
 *
 * The thing worth pinning is not that `columnAffordance` dims the right column. It is
 * that dimming and refusing are different: a column the client thinks a guard will
 * reject STILL accepts the drop, because the store's sentence is the deliverable and
 * you only get it by asking. A regression that turns "unlikely" into "not droppable"
 * would look like a polish improvement and would quietly delete the ticket.
 *
 * Imports are relative, not "@/…": there is no vitest config at the repo root, so the
 * app's `@` alias (defined in src/ui/app/vite.config.ts) does not exist at test time.
 * guards.ts itself only imports types from "@/lib/types", and a type-only import is
 * erased before it can be resolved.
 */
import { describe, expect, it } from "vitest";
import type { Issue, IssueStatus } from "../../lib/types";
import { canTransition, columnAffordance, transitionWarnings } from "./guards";

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: "i1",
    identifier: "STA-1",
    title: "A task",
    description: null,
    status: "todo",
    statusVersion: 0,
    priority: "medium",
    parentId: null,
    depth: 0,
    assignee: null,
    createdBy: null,
    labels: [],
    acceptanceCriteria: null,
    blockParentUntilDone: false,
    unblockOwner: null,
    unblockAction: null,
    originKind: "user",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("canTransition — the only hard client-side refusal", () => {
  it("refuses the column the card is already in, because that is a no-op not a transition", () => {
    expect(canTransition(issue({ status: "todo" }), "todo")).toEqual({
      allowed: false,
      reason: "already todo",
    });
  });

  it("allows everything else, including transitions the store will reject", () => {
    // No assignee, so the store WILL throw "in_progress requires an assignee". The
    // client still allows it: that error is the feature.
    expect(canTransition(issue({ assignee: null }), "in_progress").allowed).toBe(true);
    expect(canTransition(issue({ status: "done" }), "backlog").allowed).toBe(true);
    expect(canTransition(issue({ status: "blocked" }), "done").allowed).toBe(true);
  });
});

describe("transitionWarnings", () => {
  it("warns when another agent holds the checkout", () => {
    expect(transitionWarnings(issue({ checkoutAgent: "kim" }), "done")).toEqual(["held by kim"]);
  });

  it("warns about resolving something still marked blocked", () => {
    expect(transitionWarnings(issue({ status: "blocked" }), "done")).toEqual(["still marked blocked"]);
  });

  it("says nothing about an ordinary move", () => {
    expect(transitionWarnings(issue({ status: "todo" }), "in_review")).toEqual([]);
  });
});

describe("columnAffordance", () => {
  it("marks the card's own column as self and not droppable", () => {
    const affordance = columnAffordance(issue({ status: "in_review" }), "in_review");
    expect(affordance.tone).toBe("self");
    expect(affordance.droppable).toBe(false);
  });

  it("dims in_progress for an unassigned card but STILL accepts the drop", () => {
    const affordance = columnAffordance(issue({ assignee: null }), "in_progress");
    expect(affordance.tone).toBe("unlikely");
    expect(affordance.reason).toBe("no assignee");
    // The whole ticket: let it through so the store can say why.
    expect(affordance.droppable).toBe(true);
  });

  it("does not dim in_progress once the card has an assignee", () => {
    expect(columnAffordance(issue({ assignee: "kim" }), "in_progress").tone).toBe("ok");
  });

  it("cautions rather than dims when the card is held by someone else", () => {
    const affordance = columnAffordance(issue({ checkoutAgent: "kim" }), "in_review");
    expect(affordance.tone).toBe("caution");
    expect(affordance.reason).toBe("held by kim");
    expect(affordance.droppable).toBe(true);
  });

  it("joins several cautions into one phrase", () => {
    const affordance = columnAffordance(issue({ status: "blocked", checkoutAgent: "kim" }), "done");
    expect(affordance.reason).toBe("held by kim · still marked blocked");
  });

  it("never guesses at blockers — the board payload does not carry them", () => {
    // A blocked-by relation is invisible to GET /api/issues, so a card with unresolved
    // blockers looks ordinary here. That is deliberate: the refusal comes from the store
    // with detail.blockers attached, and the board renders that.
    const affordance = columnAffordance(issue({ assignee: "kim", status: "todo" }), "in_progress");
    expect(affordance.tone).toBe("ok");
  });

  it("offers every status as a target except the current one", () => {
    const statuses: IssueStatus[] = [
      "backlog",
      "todo",
      "in_progress",
      "in_review",
      "done",
      "blocked",
      "cancelled",
    ];
    const card = issue({ status: "todo", assignee: "kim" });
    const droppable = statuses.filter((s) => columnAffordance(card, s).droppable);
    expect(droppable).toEqual(["backlog", "in_progress", "in_review", "done", "blocked", "cancelled"]);
  });
});
