import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import type { QueueStore } from "../src/core/queue-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { StapleError } from "../src/core/types.js";

/**
 * `queue.requireEstimate`: an opt-in rule that queue add refuses work with no estimate.
 * Off by default, so a queue behaves as it always has. When on, a leaf is judged by its
 * own estimate and a container by the open leaves queueing it would hand to agents. A
 * person steps over it with an override, which is recorded with who and why.
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

const HOUR = 3600;

function issue(title: string, input: Record<string, unknown> = {}): string {
  return store.createIssue({ title, ...input }).identifier;
}

function requireEstimate(): void {
  store.setSetting("queue.requireEstimate", true, "vp");
}

function refused(fn: () => unknown, code = "validation"): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function planned(): string[] {
  return queue.entries({ all: true }).map((entry) => entry.identifier);
}

function overrides(): Array<{ actor: string | null; payload: Record<string, unknown> }> {
  return store
    .listEvents(0, 1000)
    .filter((event) => event.kind === "queue_estimate_overridden")
    .map((event) => ({ actor: event.actor, payload: event.payload }));
}

function land(ref: string): void {
  store.updateIssue(ref, { assignee: "someone" }, "someone");
  store.updateIssue(ref, { status: "in_progress" }, "someone");
  store.updateIssue(ref, { status: "done" }, "someone");
}

describe("queue.requireEstimate off (the default)", () => {
  it("is off in a fresh workspace", () => {
    expect(store.getSetting("queue.requireEstimate")).toBe(false);
  });

  it("queues an unestimated leaf and an unestimated container as before", () => {
    const leaf = issue("No estimate");
    const epic = issue("Epic", { kind: "epic" });
    issue("Child", { parent: epic });
    queue.enqueue(leaf, {}, "vp");
    queue.mutate("add", { ref: epic }, "vp");
    expect(planned()).toEqual([leaf, epic]);
    expect(overrides()).toEqual([]);
  });
});

describe("queue.requireEstimate on", () => {
  beforeEach(requireEstimate);

  it("refuses an unestimated leaf, naming it, and writes nothing", () => {
    const leaf = issue("No estimate");
    const before = queue.revision();
    const error = refused(() => queue.mutate("add", { ref: leaf }, "agent-1"));
    expect(error.message).toContain(leaf);
    expect(error.message).toContain("queue.requireEstimate");
    expect(error.detail).toMatchObject({ identifier: leaf, unestimated: [leaf] });
    expect(planned()).toEqual([]);
    expect(queue.revision()).toBe(before);
  });

  it("queues an estimated leaf", () => {
    const leaf = issue("Estimated", { estimatedSeconds: HOUR });
    queue.enqueue(leaf, {}, "agent-1");
    expect(planned()).toEqual([leaf]);
  });

  it("queues a container whose open leaves are all estimated, the container itself unestimated", () => {
    const epic = issue("Epic", { kind: "epic" });
    const one = issue("One", { parent: epic, estimatedSeconds: HOUR });
    issue("One a", { parent: one, estimatedSeconds: HOUR });
    issue("Two", { parent: epic, estimatedSeconds: HOUR });
    // A finished leaf has nothing left to estimate, even one the plan still holds as its own row.
    const finished = issue("Finished", { parent: epic });
    store.setSetting("queue.requireEstimate", false, "vp");
    queue.enqueue(finished, {}, "vp");
    requireEstimate();
    land(finished);
    queue.enqueue(epic, {}, "agent-1");
    expect(planned()).toEqual([finished, epic]);
  });

  it("refuses a container with an unestimated open leaf and names every such leaf", () => {
    const epic = issue("Epic", { kind: "epic" });
    issue("Estimated", { parent: epic, estimatedSeconds: HOUR });
    const missing = issue("Missing", { parent: epic });
    const parent = issue("Parent", { parent: epic, estimatedSeconds: HOUR });
    const deep = issue("Deep", { parent });
    const error = refused(() => queue.enqueue(epic, {}, "agent-1"));
    expect(error.message).toContain(epic);
    expect(error.message).toContain(missing);
    expect(error.message).toContain(deep);
    // A parent with open children is not a leaf: its own estimate is not what counts.
    expect(error.detail).toMatchObject({ identifier: epic, unestimated: [missing, deep] });
    expect(planned()).toEqual([]);
  });

  it("judges a milestone by the open leaves of its members", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    const estimated = issue("Estimated", { estimatedSeconds: HOUR });
    const epic = issue("Member epic", { kind: "epic" });
    const missing = issue("Missing", { parent: epic });
    store.milestones().addMember(milestone, estimated, {}, "vp");
    store.milestones().addMember(milestone, epic, {}, "vp");
    const error = refused(() => queue.enqueue(milestone, {}, "agent-1"));
    expect(error.detail).toMatchObject({ unestimated: [missing] });
    store.updateIssue(missing, { estimatedSeconds: HOUR }, "vp");
    queue.enqueue(milestone, {}, "agent-1");
    expect(planned()).toEqual([milestone]);
  });

  it("judges an epic with no open children by its own estimate, as the resolver hands it out", () => {
    const empty = issue("Empty epic", { kind: "epic" });
    const error = refused(() => queue.enqueue(empty, {}, "agent-1"));
    expect(error.detail).toMatchObject({ unestimated: [empty] });
  });

  it("leaves a replay and a move of a queued entry alone", () => {
    const first = issue("First", { estimatedSeconds: HOUR });
    store.setSetting("queue.requireEstimate", false, "vp");
    const late = issue("Queued before the rule");
    queue.enqueue(first, {}, "vp");
    queue.enqueue(late, {}, "vp");
    requireEstimate();
    expect(queue.enqueue(late, {}, "vp").replayed).toBe(true);
    queue.enqueue(late, { before: first }, "vp");
    expect(planned()).toEqual([late, first]);
  });

  it("an override queues the ticket and records who did it and why", () => {
    const leaf = issue("No estimate");
    queue.mutate("add", { ref: leaf, overrideReason: "  sizing it after the spike  " }, "vp");
    expect(planned()).toEqual([leaf]);
    const [entry] = queue.entries();
    expect(entry).toMatchObject({ addedBy: "vp", note: "sizing it after the spike" });
    expect(overrides()).toEqual([
      {
        actor: "vp",
        payload: { identifier: leaf, reason: "sizing it after the spike", unestimated: [leaf] },
      },
    ]);
  });

  it("an override keeps a note given beside it", () => {
    const leaf = issue("No estimate");
    queue.enqueue(leaf, { note: "after the release", overrideReason: "sizing later" }, "vp");
    expect(queue.entries()[0]).toMatchObject({ note: "after the release" });
    expect(overrides()[0]!.payload).toMatchObject({ reason: "sizing later" });
  });

  it("refuses an override with an empty reason and writes nothing", () => {
    const leaf = issue("No estimate");
    const error = refused(() => queue.enqueue(leaf, { overrideReason: "   " }, "vp"));
    expect(error.message).toContain("reason");
    expect(planned()).toEqual([]);
    expect(overrides()).toEqual([]);
  });

  it("records no override when nothing was stepped over", () => {
    const leaf = issue("Estimated", { estimatedSeconds: HOUR });
    queue.enqueue(leaf, { overrideReason: "just in case" }, "vp");
    expect(planned()).toEqual([leaf]);
    expect(overrides()).toEqual([]);
  });
});
