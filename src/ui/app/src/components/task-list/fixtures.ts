/**
 * Test-support builders for the tree row model. NOT imported by any app code — Vite drops
 * it from the bundle because nothing in the module graph reaches it.
 *
 * It lives beside the code rather than under `test/` because the Node-side suite compiles
 * against a different tsconfig (no DOM lib, no `@` alias) and these fixtures are typed
 * against the browser app's `lib/types.ts`.
 */
import {
  WORKLOG_KEY,
  type ClaimActivity,
  type Issue,
  type IssuePriority,
  type IssueRow,
  type IssueStatus,
  type WorklogSummary,
} from "@/lib/types";

let seq = 0;

export function issue(over: Partial<Issue> & { title?: string } = {}): Issue {
  seq += 1;
  const n = over.identifier ? Number(over.identifier.split("-")[1] ?? seq) : seq;
  return {
    id: over.id ?? `id-${n}`,
    identifier: over.identifier ?? `STA-${n}`,
    title: over.title ?? `task ${n}`,
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
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  };
}

/**
 * An `IssueRow` as `/api/issues` sends it: issue plus the two sibling readings.
 *
 * `worklog` is left UNDEFINED rather than defaulted to null when the caller says nothing.
 * The server always sends the field explicitly, but the type is optional so that every
 * view is obliged to check it — and a fixture that quietly supplied `null` would hide the
 * one case where a view forgot to (STA-113, and §5c of the STA-108 spec).
 */
export function row(
  over: Partial<Issue> = {},
  claim: ClaimActivity | null = null,
  worklog?: WorklogSummary | null,
): IssueRow {
  return { workspace: "staple", issue: issue(over), claim, worklog };
}

export function claim(over: Partial<ClaimActivity> = {}): ClaimActivity {
  return {
    heldBy: "opus-x",
    checkoutAt: "2026-09-01T00:00:00.000Z",
    lastActivityAt: "2026-09-01T00:00:00.000Z",
    heldSeconds: 600,
    idleSeconds: 30,
    ...over,
  };
}

/**
 * The `WorklogSummary` the server batches onto a row (STA-113).
 *
 * `updatedAt` defaults to the same instant as `claim()`'s `lastActivityAt`, so the pair
 * built with no arguments is FRESH — the unremarkable case. A test that wants the stale
 * one has to say by how much, which is the number the assertion is really about.
 */
export function worklog(over: Partial<WorklogSummary> = {}): WorklogSummary {
  return {
    key: WORKLOG_KEY,
    revisions: 3,
    updatedAt: "2026-09-01T00:00:00.000Z",
    author: "opus-x",
    ...over,
  };
}

export function at(status: IssueStatus, priority: IssuePriority = "medium"): Partial<Issue> {
  return { status, priority };
}

/** Reset the identifier counter so a test that cares about ordering can be deterministic. */
export function resetIds(): void {
  seq = 0;
}
