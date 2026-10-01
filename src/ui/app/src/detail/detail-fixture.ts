/**
 * Test-only builders for a loaded detail: an issue, its detail payload and a claim, with
 * every field present and the ungated, unclaimed case as the default.
 */
import type { ClaimActivity, Issue, IssueDetail, IssueTiming } from "@/lib/types";

/** Estimate-vs-actual is not what this file is about; every fixture gets the empty one. */
export function timing(): IssueTiming {
  return {
    estimatedSeconds: null,
    ownActiveSeconds: null,
    activeSeconds: null,
    reviewSeconds: null,
    approximate: false,
    countedThrough: null,
    childCount: 0,
    childrenEstimatedSeconds: null,
    childrenActiveSeconds: null,
    childStatusCounts: {
      backlog: 0, todo: 0, in_progress: 0, in_review: 0, awaiting_approval: 0, done: 0, blocked: 0, cancelled: 0,
    },
    subtreePlan: {
      estimatedSeconds: null,
      source: "none",
      descendantsEstimatedSeconds: null,
      contributingCount: 0,
      unplannedCount: 0,
      totalCount: 0,
    },
    workSeconds: null,
    estimateRatio: null,
    quality: {
      work: { state: "missing", inputs: [], reasons: ["never_started"], coverage: null, missingInputs: [] },
      wall: { state: "missing", inputs: [], reasons: ["never_started"] },
    },
  };
}

export function issue(patch: Partial<Issue> = {}): Issue {
  return {
    id: "uuid-1",
    identifier: "STA-88",
    title: "V3: task detail",
    description: null,
    status: "in_progress",
    statusVersion: 1,
    kind: "task",
    priority: "high",
    parentId: null,
    depth: 0,
    assignee: null,
    createdBy: null,
    labels: [],
    acceptanceCriteria: null,
    blockParentUntilDone: false,
    unblockOwner: null,
    unblockAction: null,
    originKind: "human",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    estimatedSeconds: null,
    createdAt: "2026-09-01T22:13:04Z",
    updatedAt: "2026-09-01T22:44:31Z",
    ...patch,
  };
}

export function detail(patch: Partial<IssueDetail> = {}): IssueDetail {
  return {
    workspace: "staple",
    issue: issue(),
    ancestors: [],
    children: [],
    blockedBy: [],
    blocks: [],
    comments: [],
    documents: [],
    attachments: [],
    crossBlockers: [],
    claim: null,
    timing: timing(),
    childrenTiming: {},
    // Q2 (STA-144). Required on `IssueDetail` rather than optional, following that
    // interface's own convention — even `claim` is required there — so the ungated
    // case has to be stated rather than assumed. These three ARE the ungated case.
    gate: null,
    queuedBy: null,
    // STA-154: a LIST of the open descendants a gate is holding, not a map of direct
    // children. Empty here for the same reason the two above are null.
    childrenQueued: [],
    ...patch,
  };
}

export const claim = (patch: Partial<ClaimActivity> = {}): ClaimActivity => ({
  heldBy: "v3-drawer",
  checkoutAt: "2026-09-01T22:40:00Z",
  lastActivityAt: "2026-09-01T22:44:31Z",
  heldSeconds: 300,
  idleSeconds: 45,
  scope: "local",
  lease: null,
  ...patch,
});

