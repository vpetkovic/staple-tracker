import { describe, expect, it } from "vitest";
import {
  ACTIVE_GATE_STATES,
  buildGateCaptions,
  gateCaption,
  gateRefusalReason,
  isGateParked,
  impliedSelection,
  isQueuedBehindGate,
  queuedCaption,
  selectionRoots,
  subtreeOf,
} from "./derived-queued";
import type { IssueGate, IssueRow, QueuedBy } from "./types";

const gate = (over: Partial<IssueGate> = {}): IssueGate => ({
  state: "pending",
  owner: "VP",
  requestedBy: "opus-q1",
  requestedAt: "2026-09-02T10:00:00.000Z",
  resolvedBy: null,
  resolvedAt: null,
  ...over,
});

const queuedBy = (over: Partial<QueuedBy> = {}): QueuedBy => ({
  identifier: "STA-108",
  owner: "VP",
  ...over,
});

let seq = 0;
const row = (over: Partial<IssueRow["issue"]> = {}, siblings: Partial<IssueRow> = {}): IssueRow => {
  seq += 1;
  return {
    workspace: "staple",
    issue: {
      id: `id-${seq}`,
      identifier: `STA-${seq}`,
      title: "A task",
      description: null,
      status: "todo",
      statusVersion: 1,
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
      originKind: "manual",
      originId: null,
      idempotencyKey: null,
      checkoutAgent: null,
      checkoutAt: null,
      blockedTransitionAt: null,
      estimatedSeconds: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      resolvedAt: null,
      ...over,
    },
    claim: null,
    gate: null,
    queuedBy: null,
    ...siblings,
  } as IssueRow;
};

describe("ACTIVE_GATE_STATES", () => {
  /**
   * The queueing predicate, mirroring `GATE_QUEUEING_STATES` in src/core/store.ts.
   * `changes_requested` is in it because requesting changes does NOT drain the
   * queue — VP's decision, and the reason this is a set rather than
   * `state === "pending"`.
   */
  it("is pending and changes_requested — never approved", () => {
    expect([...ACTIVE_GATE_STATES]).toEqual(["pending", "changes_requested"]);
  });
});

describe("isGateParked", () => {
  it("is true for an awaiting_approval row holding an active gate", () => {
    expect(isGateParked(row({ status: "awaiting_approval" }, { gate: gate() }))).toBe(true);
    expect(
      isGateParked(row({ status: "awaiting_approval" }, { gate: gate({ state: "changes_requested" }) })),
    ).toBe(true);
  });

  it("is false once the gate is approved, whatever the status still says", () => {
    expect(
      isGateParked(row({ status: "awaiting_approval" }, { gate: gate({ state: "approved" }) })),
    ).toBe(false);
  });

  it("is false for a row carrying a historical gate but no longer parked", () => {
    expect(isGateParked(row({ status: "todo" }, { gate: gate({ state: "changes_requested" }) }))).toBe(false);
  });

  it("is false for an ordinary row and for a row with no gate sibling at all", () => {
    expect(isGateParked(row())).toBe(false);
    expect(isGateParked(row({ status: "awaiting_approval" }))).toBe(false);
  });
});

describe("isQueuedBehindGate", () => {
  it("is true exactly when the server sent a queuedBy", () => {
    expect(isQueuedBehindGate(row({}, { queuedBy: queuedBy() }))).toBe(true);
    expect(isQueuedBehindGate(row())).toBe(false);
  });

  /**
   * The UI never recomputes `queuedBy` — a released child stops carrying it and
   * therefore stops being queued, which is the whole mechanism behind
   * "Approve selected".
   */
  it("is false for a child of a gated parent that the server released", () => {
    expect(isQueuedBehindGate(row({ parentId: "id-parent" }, { queuedBy: null }))).toBe(false);
  });
});

describe("captions", () => {
  it("names the owner on the parked parent", () => {
    expect(gateCaption(gate())).toBe("awaiting VP");
    expect(gateCaption(gate({ owner: "kim" }))).toBe("awaiting kim");
  });

  it("names the owner AND the gate on a queued child", () => {
    expect(queuedCaption(queuedBy())).toBe("Queued · awaiting VP on STA-108");
  });

  it("says why checkout is refused, in a sentence a tooltip can carry", () => {
    expect(gateRefusalReason(queuedBy())).toBe(
      "Queued · awaiting VP on STA-108 — checkout is refused until the gate is approved",
    );
  });
});

describe("buildGateCaptions", () => {
  it("captions parked parents and queued children, and nothing else", () => {
    const parent = row({ status: "awaiting_approval" }, { gate: gate() });
    const child = row({}, { queuedBy: queuedBy({ identifier: parent.issue.identifier }) });
    const ordinary = row();

    const captions = buildGateCaptions([parent, child, ordinary]);

    expect(captions.get(parent.issue.id)).toBe("awaiting VP");
    expect(captions.get(child.issue.id)).toBe(`Queued · awaiting VP on ${parent.issue.identifier}`);
    expect(captions.has(ordinary.issue.id)).toBe(false);
    expect(captions.size).toBe(2);
  });

  /**
   * `gate` and `queuedBy` are complementary and at most one is ever non-null.
   * If a payload ever carried both, the row IS the gate and says so — the
   * caption a reader needs is the one naming who must act on this row.
   */
  it("prefers the row's own gate when a payload carries both", () => {
    const both = row({ status: "awaiting_approval" }, { gate: gate({ owner: "kim" }), queuedBy: queuedBy() });
    expect(buildGateCaptions([both]).get(both.issue.id)).toBe("awaiting kim");
  });

  it("is empty for a payload with no gates in it", () => {
    expect(buildGateCaptions([row(), row()]).size).toBe(0);
  });
});

/**
 * STA-154. The checklist arrives flat and pre-ordered with a depth per row, and
 * these three read the tree structure back out of that ordering. The fixture is
 * the shape a real gate produces:
 *
 *     STA-109                  depth 1
 *       STA-110                depth 2
 *         STA-111              depth 3
 *       STA-112                depth 2
 *     STA-113                  depth 1
 */
const QUEUE = [
  { identifier: "STA-109", depth: 1 },
  { identifier: "STA-110", depth: 2 },
  { identifier: "STA-111", depth: 3 },
  { identifier: "STA-112", depth: 2 },
  { identifier: "STA-113", depth: 1 },
];

describe("subtreeOf", () => {
  it("is the run of following rows deeper than the one at `index`", () => {
    expect(subtreeOf(QUEUE, 0).map((r) => r.identifier)).toEqual(["STA-110", "STA-111", "STA-112"]);
    expect(subtreeOf(QUEUE, 1).map((r) => r.identifier)).toEqual(["STA-111"]);
  });

  it("stops at the first row that is not deeper — a sibling ends a subtree", () => {
    // STA-112 is depth 2 and so is STA-110; the run must not swallow it.
    expect(subtreeOf(QUEUE, 3)).toEqual([]);
    expect(subtreeOf(QUEUE, 4)).toEqual([]);
  });

  it("is empty for an index that is not there", () => {
    expect(subtreeOf(QUEUE, 99)).toEqual([]);
  });
});

describe("impliedSelection", () => {
  it("adds the whole subtree of everything ticked", () => {
    expect([...impliedSelection(QUEUE, new Set(["STA-109"]))].sort()).toEqual([
      "STA-109",
      "STA-110",
      "STA-111",
      "STA-112",
    ]);
  });

  it("counts a leaf as itself", () => {
    expect([...impliedSelection(QUEUE, new Set(["STA-113"]))]).toEqual(["STA-113"]);
  });

  it("does not double-count overlapping ticks", () => {
    expect(impliedSelection(QUEUE, new Set(["STA-109", "STA-110"])).size).toBe(4);
  });

  it("is empty for an empty selection", () => {
    expect(impliedSelection(QUEUE, new Set()).size).toBe(0);
  });
});

describe("selectionRoots", () => {
  it("drops a tick already covered by an ancestor's tick", () => {
    // The store's release flag propagates down on its own, so sending both would
    // write the same decision twice and log it twice.
    expect(selectionRoots(QUEUE, new Set(["STA-109", "STA-111"]))).toEqual(["STA-109"]);
  });

  it("keeps ticks on separate branches, in checklist order", () => {
    expect(selectionRoots(QUEUE, new Set(["STA-113", "STA-110"]))).toEqual(["STA-110", "STA-113"]);
  });

  it("is empty for an empty selection", () => {
    expect(selectionRoots(QUEUE, new Set())).toEqual([]);
  });
});
