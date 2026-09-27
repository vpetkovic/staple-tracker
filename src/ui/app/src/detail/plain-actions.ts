/**
 * The detail's verbs and its status line, in plain words.
 *
 * The tracker and its agents speak in checkouts, releases and status ids (`blocked`,
 * `in_progress`). A person opening a task on their phone needs to know what a button does to
 * the task, not what the command is called. The command names are not hidden (they sit under
 * "More details"); they are just not the labels.
 *
 * Everything here is pure: which action leads, what the status line says, and what each
 * status means, all decided from the detail payload and the workspace's vocabulary, so the
 * decisions are unit tested rather than eyeballed.
 */
import type { ClaimActivity, Issue, IssueGate, IssueStatus, QueuedBy, StatusCategory } from "@/lib/types";

export const ACTION_WORDS = {
  /** `checkout`: somebody is now working on this task. */
  checkout: "Start work",
  checkoutPrompt: "Who is working on it? Type your name or the agent's name.",
  /** `release`: nobody is working on it any more; it goes back to be picked up. */
  release: "Stop working on it",
  /** Moves the task to the workspace's first finished status. */
  done: "Mark done",
  /** Moves a finished or cancelled task back to the first ready status. */
  reopen: "Reopen",
  /** Scrolls to the approval block of a task parked behind a review. */
  review: "Review",
  /** `checkout` with steal: the holder went quiet and someone else takes it. */
  takeOver: "Take it over",
  takeOverPrompt: (holder: string) => `${holder} has gone quiet. Who is taking this over? Type your name or the agent's name.`,
  /** `release` of a silent holder's claim. */
  releaseStale: "Free it up",
  /** Park a parent behind a person's approval. */
  requestApproval: "Ask for approval",
} as const;

/**
 * What each kind of status means, in one line, for the status menu. Keyed by CATEGORY, not by
 * id: a workspace can rename or add statuses, and the category is what decides behaviour.
 */
export const STATUS_DESCRIPTIONS: Record<StatusCategory, string> = {
  unstarted: "Not planned yet. It waits in the backlog.",
  ready: "Ready for someone to pick up.",
  active: "Someone is working on it now.",
  review: "The work is done and waits for a check.",
  gated: "Waits for a person to approve it.",
  blocked: "Stuck until something else happens first.",
  done: "Finished.",
  cancelled: "Not going to be done.",
};

/**
 * What the status menu offers: the workspace's own vocabulary in its configured order, or the
 * built-in statuses before settings have loaded — and always the task's current status, so the
 * menu can show what the task is even when the vocabulary does not list it.
 */
export function statusChoices(configured: readonly string[], builtIn: readonly string[], current: string): string[] {
  const base = configured.length > 0 ? [...configured] : [...builtIn];
  return base.includes(current) ? base : [current, ...base];
}

/** The first status in `order` whose category is one of `categories`, in their priority. */
export function firstStatusIn(
  order: readonly string[],
  categoryOf: (status: string) => StatusCategory,
  categories: readonly StatusCategory[],
): string | null {
  for (const category of categories) {
    const found = order.find((status) => categoryOf(status) === category);
    if (found) return found;
  }
  return null;
}

export type PrimaryKind = "review" | "reopen" | "take-over" | "done" | "start";

export interface PrimaryAction {
  kind: PrimaryKind;
  label: string;
  /** The status a status-changing action moves to. */
  status?: IssueStatus;
  /** Set when the action is shown but cannot run; the sentence says why. */
  disabledReason?: string;
}

export interface ActionState {
  issue: Pick<Issue, "status" | "checkoutAgent">;
  claim: ClaimActivity | null;
  gate: IssueGate | null;
  queuedBy: QueuedBy | null;
  /** The task holds an active review gate (pending or changes requested). */
  parked: boolean;
  /** The holder has been silent past the stale threshold. */
  stale: boolean;
}

/**
 * THE ONE PRIMARY ACTION, chosen by state, in this order:
 *
 *   1. parked behind a review   → Review (the approval block is the decision to make)
 *   2. finished or cancelled    → Reopen
 *   3. held by a silent holder  → Take it over
 *   4. somebody is working on it → Mark done
 *   5. otherwise                → Start work (shown disabled, with the reason, while queued)
 *
 * Everything else is in the overflow menu.
 */
export function primaryActionFor(
  state: ActionState,
  order: readonly string[],
  categoryOf: (status: string) => StatusCategory,
): PrimaryAction {
  const category = categoryOf(state.issue.status);
  if (state.parked) return { kind: "review", label: ACTION_WORDS.review };
  if (category === "done" || category === "cancelled") {
    const status = firstStatusIn(order, categoryOf, ["ready", "unstarted", "active"]);
    if (status) return { kind: "reopen", label: ACTION_WORDS.reopen, status: status as IssueStatus };
  }
  if (state.stale && state.claim) return { kind: "take-over", label: ACTION_WORDS.takeOver };
  if (state.issue.checkoutAgent) {
    const status = firstStatusIn(order, categoryOf, ["done"]);
    if (status && category !== "done") return { kind: "done", label: ACTION_WORDS.done, status: status as IssueStatus };
  }
  return {
    kind: "start",
    label: ACTION_WORDS.checkout,
    ...(state.queuedBy ? { disabledReason: `Waiting for ${state.queuedBy.owner} to approve ${state.queuedBy.identifier} first.` } : {}),
  };
}

/**
 * The status line under the title, as parts the component lays out:
 * `[lead] [person] [tail] · [atPrefix] [relative time]`.
 */
export interface StatusSentence {
  lead: string;
  person?: { name: string; kind: "agent" | "human" };
  tail?: string;
  atPrefix?: string;
  at?: string | null;
  tone: "normal" | "attention";
}

export interface SentenceInput extends ActionState {
  issue: Pick<
    Issue,
    "status" | "checkoutAgent" | "checkoutAt" | "startedAt" | "completedAt" | "cancelledAt" | "createdAt" | "updatedAt" | "unblockOwner" | "unblockAction"
  >;
  /** Direct blockers that are not finished. */
  openBlockers: number;
}

export function statusSentence(input: SentenceInput, categoryOf: (status: string) => StatusCategory): StatusSentence {
  const { issue, claim, gate } = input;
  const category = categoryOf(issue.status);

  if (input.parked && gate) {
    if (gate.state === "changes_requested") {
      return { lead: "Changes asked for by", person: { name: gate.resolvedBy ?? gate.owner, kind: "human" }, atPrefix: "", at: gate.resolvedAt ?? gate.requestedAt, tone: "attention" };
    }
    return { lead: "Waiting for", person: { name: gate.owner, kind: "human" }, tail: "to approve", atPrefix: "asked", at: gate.requestedAt, tone: "attention" };
  }
  if (category === "done") return { lead: "Finished", atPrefix: "", at: issue.completedAt ?? issue.updatedAt, tone: "normal" };
  if (category === "cancelled") return { lead: "Cancelled", atPrefix: "", at: issue.cancelledAt ?? issue.updatedAt, tone: "normal" };
  if (input.queuedBy) {
    return { lead: "Waiting for", person: { name: input.queuedBy.owner, kind: "human" }, tail: `to approve ${input.queuedBy.identifier}`, tone: "attention" };
  }
  if (input.stale && claim) {
    return { lead: "", person: { name: claim.heldBy, kind: "agent" }, tail: "has gone quiet", atPrefix: "last active", at: claim.lastActivityAt, tone: "attention" };
  }
  if (issue.checkoutAgent) {
    return { lead: "Being worked on by", person: { name: claim?.heldBy ?? issue.checkoutAgent, kind: "agent" }, atPrefix: "started", at: claim?.checkoutAt ?? issue.checkoutAt ?? issue.startedAt, tone: "normal" };
  }
  if (category === "blocked") {
    if (issue.unblockOwner) {
      return { lead: "Waiting for", person: { name: issue.unblockOwner, kind: "human" }, tail: issue.unblockAction ? `to ${issue.unblockAction}` : undefined, tone: "attention" };
    }
    if (input.openBlockers > 0) {
      return { lead: input.openBlockers === 1 ? "Waiting on 1 other task" : `Waiting on ${input.openBlockers} other tasks`, tone: "attention" };
    }
    return { lead: "Blocked", atPrefix: "since", at: issue.updatedAt, tone: "attention" };
  }
  if (category === "review") return { lead: "Waiting for a check", atPrefix: "updated", at: issue.updatedAt, tone: "normal" };
  if (category === "ready") return { lead: "Ready to pick up", atPrefix: "added", at: issue.createdAt, tone: "normal" };
  if (category === "active") return { lead: "In progress", atPrefix: "updated", at: issue.updatedAt, tone: "normal" };
  return { lead: "Not started", atPrefix: "added", at: issue.createdAt, tone: "normal" };
}
