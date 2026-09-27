/**
 * The detail's verbs, its status menu and its status line, in plain words, as DATA.
 *
 * The tracker and its agents speak in checkouts, releases and status ids (`blocked`,
 * `in_progress`). A person opening a task on their phone needs to know what a button does to
 * the task, not what the command is called. The status's own name and the raw ids are not
 * hidden (they sit under "More details"); they are just not the labels.
 *
 * EVERY WRITE IS DESCRIBED HERE, NOT IN A CLICK HANDLER. Each action the detail offers is an
 * `ActionItem`: a label, an optional reason it cannot run, and a `WriteCall` that names the
 * route, the workspace, the issue, the payload and where the actor's name comes from. The
 * components only render items and hand the chosen call to `toRequest`, so the whole write
 * path (which status the menu sends, which workspace, which verb) is unit tested without a
 * DOM.
 *
 * THE STORE'S RULES, MIRRORED SO NOTHING OFFERED IS A GUARANTEED REFUSAL (src/core/store.ts):
 *
 *   checkout     — only from a claimable category (ready, unstarted, blocked), only with no
 *                  unresolved same-workspace blocker, never while queued behind a gate.
 *   takeover     — a checkout that steals a claim silent for STALE_CLAIM_SECONDS; blockers
 *                  still win.
 *   release      — only from the active category, and only by the holder (the web app's
 *                  default actor "ui" is refused), unless it is the stale-claim release.
 *   status       — never INTO the gated category (that is "Ask for approval") and never OUT
 *                  of it (approve or send back first); into the active category only with
 *                  an assignee and no unresolved blocker. Everything else is allowed.
 *
 * The store stays the authority: a race can still refuse, and the refusal is shown in plain
 * words (`plainRefusal`). What this file guarantees is that the page never OFFERS a write the
 * store's rules already refuse.
 */
import type { ActionPayload, ClaimActivity, Issue, IssueGate, IssueStatus, QueuedBy, StatusCategory } from "@/lib/types";

/** Silence, in seconds, after which a claim may be taken over or freed. Mirrors lib/claim. */
export const STALE_SECONDS = 30 * 60;

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
  copyId: "Copy task ID",
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
 * What the status menu can list: the workspace's own vocabulary in its configured order, or the
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

// ─────────────────────────────────────────────────────────────── context

/** Everything the action decisions read, gathered once from the detail payload. */
export interface ActionContext {
  /** The workspace the detail was loaded from: every write carries it (hub mode needs it). */
  ws: string;
  issue: Pick<Issue, "id" | "identifier" | "status" | "checkoutAgent" | "assignee">;
  claim: ClaimActivity | null;
  gate: IssueGate | null;
  queuedBy: QueuedBy | null;
  /** The task holds an active review gate (pending or changes requested). */
  parked: boolean;
  /** The holder has been silent past the stale threshold. */
  stale: boolean;
  /** Direct children: a task with children can be parked behind an approval. */
  childCount: number;
  /**
   * Blockers that are not finished, here and in other workspaces. The store checks only the
   * same-workspace ones at checkout; the page holds back for both, because work that waits
   * on another workspace is still waiting.
   */
  openBlockers: number;
  /**
   * Blockers this computer cannot see at all: the task is missing from its workspace, or the
   * workspace is not on this computer. They can never finish from here, so they get their own
   * wording rather than "waiting for it to finish".
   */
  unreachable: readonly UnreachableBlocker[];
  /**
   * Under the Strict queue setting, the plan row that has to be taken before this one, or null
   * when the queue has nothing to say (policy off, or this is next).
   */
  queueAhead: { identifier: string; title: string } | null;
  /**
   * WHO IS WORKING ON IT: the name Start work last used (`staple:actor`). It may be an
   * agent's name, so it only ever attributes claims: starting, taking over, stopping.
   */
  worker: string | null;
  /**
   * WHO I AM: the person using this browser (`staple:me`). Status changes carry it, and a
   * decision (approve, send back, ask for approval) is confirmed with it pre-filled. Never
   * filled from the working name.
   */
  person: string | null;
  /** The status vocabulary in configured order, and each status's category and label. */
  order: readonly string[];
  categoryOf: (status: string) => StatusCategory;
  labelOf: (status: string) => string;
}

const CLAIMABLE: readonly StatusCategory[] = ["ready", "unstarted", "blocked"];

// ────────────────────────────────────────────────────────────── the calls

/** Where the name a write is attributed to comes from. */
export type ActorSource =
  /** Ask who works on it, pre-filled with the working name; the answer becomes the working name. */
  | { from: "worker-prompt"; prompt: string; need: string }
  /** The working name as it is (a release by the holder). */
  | { from: "worker" }
  /** The person's own name when set; the server's default ("ui") otherwise. */
  | { from: "person" }
  /**
   * A decision a person signs: always confirmed, pre-filled only with the person's own name,
   * never with the working name.
   */
  | { from: "person-confirm"; prompt: string; need: string };

/** A blocker this computer can't see, and why. */
export interface UnreachableBlocker {
  identifier: string;
  workspace: string;
  missing: "workspace" | "task";
}

export type WriteCall =
  | { route: "action"; ws: string; ref: string; payload: ActionPayload; actor: ActorSource }
  | { route: "gate-request"; ws: string; ref: string; owner: string; actor: ActorSource }
  | { route: "gate-approve"; ws: string; ref: string; children?: string[]; comment?: string; actor: ActorSource }
  | { route: "gate-changes"; ws: string; ref: string; comment: string; actor: ActorSource };

/** What the page does for a call, once the actor is known: which API function, with what. */
export type ApiRequest =
  | { fn: "action"; target: { ws: string; ref: string; actor?: string }; payload: ActionPayload }
  | { fn: "requestGate"; body: { ws: string; ref: string; owner: string; actor?: string } }
  | { fn: "approveGate"; body: { ws: string; ref: string; children?: string[]; comment?: string; actor?: string } }
  | { fn: "requestGateChanges"; body: { ws: string; ref: string; comment: string; actor?: string } };

export function toRequest(call: WriteCall, actor: string | null): ApiRequest {
  const who = actor ? { actor } : {};
  switch (call.route) {
    case "action":
      return { fn: "action", target: { ws: call.ws, ref: call.ref, ...who }, payload: call.payload };
    case "gate-request":
      return { fn: "requestGate", body: { ws: call.ws, ref: call.ref, owner: call.owner, ...who } };
    case "gate-approve":
      return {
        fn: "approveGate",
        body: { ws: call.ws, ref: call.ref, ...(call.children ? { children: call.children } : {}), ...(call.comment ? { comment: call.comment } : {}), ...who },
      };
    case "gate-changes":
      return { fn: "requestGateChanges", body: { ws: call.ws, ref: call.ref, comment: call.comment, ...who } };
  }
}

const PERSON: ActorSource = { from: "person" };
const WORKER: ActorSource = { from: "worker" };

function statusCall(ctx: ActionContext, status: string): WriteCall {
  return { route: "action", ws: ctx.ws, ref: ctx.issue.id, payload: { type: "status", status: status as IssueStatus }, actor: PERSON };
}

/** The confirmation each decision asks for, in words that fit what is being signed. */
export const SIGN = {
  approve: { from: "person-confirm", prompt: "Who is approving? Type your own name.", need: "Approving needs your name." },
  sendBack: { from: "person-confirm", prompt: "Who is sending it back? Type your own name.", need: "Sending it back needs your name." },
  ask: { from: "person-confirm", prompt: "Who is asking? Type your own name.", need: "Asking for approval needs your name." },
} as const satisfies Record<string, ActorSource>;

/** The gate writes, for GateReview and the "Ask for approval" form. Each is signed by a person. */
export const gateCalls = {
  request: (ctx: Pick<ActionContext, "ws" | "issue">, owner: string): WriteCall => ({ route: "gate-request", ws: ctx.ws, ref: ctx.issue.id, owner, actor: SIGN.ask }),
  approveAll: (ctx: Pick<ActionContext, "ws" | "issue">, comment?: string): WriteCall => ({ route: "gate-approve", ws: ctx.ws, ref: ctx.issue.id, ...(comment ? { comment } : {}), actor: SIGN.approve }),
  approveSelected: (ctx: Pick<ActionContext, "ws" | "issue">, children: string[]): WriteCall => ({ route: "gate-approve", ws: ctx.ws, ref: ctx.issue.id, children, actor: SIGN.approve }),
  requestChanges: (ctx: Pick<ActionContext, "ws" | "issue">, comment: string): WriteCall => ({ route: "gate-changes", ws: ctx.ws, ref: ctx.issue.id, comment, actor: SIGN.sendBack }),
};

// ────────────────────────────────────────────────────────────── the items

export type ActionId = "start" | "done" | "reopen" | "review" | "take-over" | "release" | "free" | "request-approval" | "copy-id";

export interface ActionItem {
  id: ActionId;
  label: string;
  /** Shown but cannot run; the sentence says why. */
  disabledReason?: string;
  /** The write. Absent for the items that open something instead (review, request, copy). */
  call?: WriteCall;
}

const tasks = (n: number) => (n === 1 ? "1 other task" : `${n} other tasks`);
const blockedReason = (n: number) => `Waiting on ${tasks(n)} to finish first.`;
const queuedReason = (q: QueuedBy) => `Waiting for ${q.owner} to approve the parent task first.`;

/** "a task this computer can't see (STA-9999)", or the count when there are several. */
export function unreachablePhrase(list: readonly UnreachableBlocker[]): string {
  return list.length === 1 ? `a task this computer can't see (${list[0]!.identifier})` : `${list.length} tasks this computer can't see (${list.map((b) => b.identifier).join(", ")})`;
}

/** The queue's head, by title when there is one. */
const queueReason = (ahead: { identifier: string; title: string }) => `${ahead.title ? `“${ahead.title}”` : ahead.identifier} is next in the queue.`;

/**
 * Why work cannot start here, in the order the store would say it: a gate, then what it
 * waits on (unreachable first, since that never finishes on its own), then the strict queue.
 */
function startBlocker(ctx: ActionContext): string | null {
  if (ctx.queuedBy) return queuedReason(ctx.queuedBy);
  if (ctx.unreachable.length > 0) return `Waiting on ${unreachablePhrase(ctx.unreachable)}.`;
  if (ctx.openBlockers > 0) return blockedReason(ctx.openBlockers);
  if (ctx.queueAhead) return queueReason(ctx.queueAhead);
  return null;
}

function startItem(ctx: ActionContext): ActionItem {
  const item: ActionItem = { id: "start", label: ACTION_WORDS.checkout };
  const reason = startBlocker(ctx);
  if (reason) return { ...item, disabledReason: reason };
  return {
    ...item,
    call: { route: "action", ws: ctx.ws, ref: ctx.issue.id, payload: { type: "checkout" }, actor: { from: "worker-prompt", prompt: ACTION_WORDS.checkoutPrompt, need: "Starting work needs a name." } },
  };
}

function takeOverItem(ctx: ActionContext, holder: string): ActionItem {
  const item: ActionItem = { id: "take-over", label: ACTION_WORDS.takeOver };
  if (ctx.openBlockers > 0) return { ...item, disabledReason: blockedReason(ctx.openBlockers) };
  return {
    ...item,
    call: {
      route: "action",
      ws: ctx.ws,
      ref: ctx.issue.id,
      payload: { type: "checkout", stealIfIdleSeconds: STALE_SECONDS },
      actor: { from: "worker-prompt", prompt: ACTION_WORDS.takeOverPrompt(holder), need: "Taking it over needs a name." },
    },
  };
}

function doneItem(ctx: ActionContext): ActionItem | null {
  const status = firstStatusIn(ctx.order, ctx.categoryOf, ["done"]);
  return status ? { id: "done", label: ACTION_WORDS.done, call: statusCall(ctx, status) } : null;
}

/**
 * THE ONE PRIMARY ACTION, chosen by state:
 *
 *   parked behind a review             → Review
 *   finished or cancelled              → Reopen (to the first ready status)
 *   queued behind a parent's gate      → Start work, disabled, saying who must approve
 *   held by a silent holder            → Take it over (disabled while blockers are open)
 *   held, or active / in review        → Mark done
 *   claimable                          → Start work (disabled while blockers are open)
 */
export function primaryItem(ctx: ActionContext): ActionItem {
  const category = ctx.categoryOf(ctx.issue.status);
  if (ctx.parked) return { id: "review", label: ACTION_WORDS.review };
  if (category === "gated") return { id: "review", label: ACTION_WORDS.review, disabledReason: "Waiting for approval." };
  if (category === "done" || category === "cancelled") {
    const status = firstStatusIn(ctx.order, ctx.categoryOf, ["ready", "unstarted"]);
    return status
      ? { id: "reopen", label: ACTION_WORDS.reopen, call: statusCall(ctx, status) }
      : { id: "reopen", label: ACTION_WORDS.reopen, disabledReason: "This workspace has no status to reopen into." };
  }
  if (ctx.queuedBy) return startItem(ctx);
  if (ctx.stale && ctx.claim) return takeOverItem(ctx, ctx.claim.heldBy);
  if (ctx.issue.checkoutAgent || category === "active" || category === "review") {
    return doneItem(ctx) ?? { id: "done", label: ACTION_WORDS.done, disabledReason: "This workspace has no finished status." };
  }
  if (CLAIMABLE.includes(category)) return startItem(ctx);
  return doneItem(ctx) ?? startItem(ctx);
}

/** Every other verb that applies right now, for the ⋯ menu. Never repeats the primary. */
export function overflowItems(ctx: ActionContext): ActionItem[] {
  const category = ctx.categoryOf(ctx.issue.status);
  const primary = primaryItem(ctx);
  const resolved = category === "done" || category === "cancelled";
  const items: ActionItem[] = [];

  if (primary.id !== "done" && !resolved && category !== "gated") {
    const done = doneItem(ctx);
    if (done) items.push(done);
  }

  const holder = ctx.issue.checkoutAgent;
  if (holder && category === "active") {
    if (ctx.stale && ctx.claim) {
      if (primary.id !== "take-over") items.push(takeOverItem(ctx, ctx.claim.heldBy));
      // No prompt: freeing hands the task back to the pool rather than to a person. The store
      // still refuses if the holder has come back to life since this rendered.
      items.push({
        id: "free",
        label: ACTION_WORDS.releaseStale,
        call: { route: "action", ws: ctx.ws, ref: ctx.issue.id, payload: { type: "release", ifIdleSeconds: STALE_SECONDS }, actor: PERSON },
      });
    } else if (ctx.worker && ctx.worker === holder) {
      items.push({
        id: "release",
        label: ACTION_WORDS.release,
        call: { route: "action", ws: ctx.ws, ref: ctx.issue.id, payload: { type: "release" }, actor: WORKER },
      });
    } else {
      items.push({
        id: "release",
        label: ACTION_WORDS.release,
        disabledReason: `Only ${holder} can stop. If ${holder} goes quiet for 30 minutes, you can take it over.`,
      });
    }
  }

  if (!ctx.parked && category !== "gated" && ctx.childCount > 0 && !resolved) {
    items.push({ id: "request-approval", label: `${ACTION_WORDS.requestApproval}…` });
  }
  return items;
}

// ──────────────────────────────────────────────────────────── status menu

export interface StatusItem {
  status: string;
  label: string;
  description: string;
  current: boolean;
  disabledReason?: string;
  call?: WriteCall;
}

/**
 * The status menu. The gated category is never offered as a status (a gate records who must
 * approve, and only "Ask for approval" can create one); while the task is gated, nothing else
 * is offered either, because the store keeps it there until the gate is answered.
 */
export function statusItems(ctx: ActionContext): StatusItem[] {
  const currentCategory = ctx.categoryOf(ctx.issue.status);
  const items: StatusItem[] = [];
  for (const status of statusChoices(ctx.order, [], ctx.issue.status)) {
    const category = ctx.categoryOf(status);
    const current = status === ctx.issue.status;
    if (category === "gated" && !current) continue;
    const item: StatusItem = { status, label: ctx.labelOf(status), description: STATUS_DESCRIPTIONS[category], current };
    if (current) {
      items.push(item);
      continue;
    }
    // Into the active category is starting work by another door: it is held back for every
    // reason Start work is, so the menu never offers a way round a gate, a blocker or the queue.
    const cannotStart = category === "active" ? startBlocker(ctx) : null;
    if (currentCategory === "gated") item.disabledReason = "Approve it or send it back first.";
    else if (cannotStart) item.disabledReason = cannotStart;
    else if (category === "active" && !ctx.issue.assignee) item.disabledReason = "Use Start work, so the tracker knows who is on it.";
    else item.call = statusCall(ctx, status);
    items.push(item);
  }
  return items;
}

// ──────────────────────────────────────────────────────────── status line

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

export interface SentenceInput {
  issue: Pick<
    Issue,
    "status" | "checkoutAgent" | "checkoutAt" | "startedAt" | "completedAt" | "cancelledAt" | "createdAt" | "updatedAt" | "unblockOwner" | "unblockAction"
  >;
  claim: ClaimActivity | null;
  gate: IssueGate | null;
  queuedBy: QueuedBy | null;
  parked: boolean;
  stale: boolean;
  /** Blockers that are not finished, in this workspace and in others. */
  openBlockers: number;
  /** Blockers this computer can't see. */
  unreachable?: readonly UnreachableBlocker[];
  /** The task's direct children, and how many of them are finished. */
  childrenTotal?: number;
  childrenDone?: number;
  /** The title of the task a queued task waits on, when it is one of its ancestors. */
  queuedByTitle?: string | null;
  /** True when the queue's gate is on the direct parent. */
  queuedByParent?: boolean;
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
    const what = input.queuedByParent ? "the parent task" : input.queuedByTitle ? `“${input.queuedByTitle}”` : "the task above this one";
    return { lead: "Waiting for", person: { name: input.queuedBy.owner, kind: "human" }, tail: `to approve ${what}`, tone: "attention" };
  }
  if (input.unreachable && input.unreachable.length > 0) return { lead: `Waiting on ${unreachablePhrase(input.unreachable)}`, tone: "attention" };
  if (input.openBlockers > 0) return { lead: `Waiting on ${tasks(input.openBlockers)}`, tone: "attention" };
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
    return { lead: "Blocked", atPrefix: "since", at: issue.updatedAt, tone: "attention" };
  }
  if (category === "review") return { lead: "Waiting for a check", atPrefix: "updated", at: issue.updatedAt, tone: "normal" };
  if (input.childrenTotal) {
    const done = input.childrenDone ?? 0;
    return { lead: `${done} of ${input.childrenTotal} ${input.childrenTotal === 1 ? "task" : "tasks"} done`, atPrefix: "updated", at: issue.updatedAt, tone: "normal" };
  }
  if (category === "ready") return { lead: "Ready to pick up", atPrefix: "added", at: issue.createdAt, tone: "normal" };
  if (category === "active") return { lead: "Nobody is working on it right now", atPrefix: "updated", at: issue.updatedAt, tone: "normal" };
  return { lead: "Not started", atPrefix: "added", at: issue.createdAt, tone: "normal" };
}

// ─────────────────────────────────────────────────────────────── refusals

/**
 * A refusal from the store, said plainly. The store's own sentence is written for agents and
 * names CLI commands; a person reads this one first, and the store's words stay one tap away.
 */
export function plainRefusal(message: string, code: string): string {
  let m: RegExpExecArray | null;
  if ((m = /Cannot release: held by (\S+), not/.exec(message))) return `Only ${m[1]} can stop working on this.`;
  if ((m = /unresolved blockers ([^.]+)/.exec(message))) return `This can't start until ${m[1]!.trim()} ${m[1]!.includes(",") ? "are" : "is"} finished.`;
  if (/Cannot set "[^"]+" directly/.test(message)) return "To wait for someone's approval, use Ask for approval in the ⋯ menu.";
  if (/parked behind a review gate/.test(message)) return "This waits for approval. Approve it or send it back before changing its status.";
  if ((m = /queued behind (\S+), awaiting approval by ([^.]+)\./.exec(message))) return `This waits for ${m[2]} to approve ${m[1]} first.`;
  if (/requires an assignee/.test(message)) return "Use Start work, so the tracker knows who is on it.";
  if ((m = /Checkout refused: status is "([^"]+)"/.exec(message))) return "This task can't be started from its current status.";
  if ((m = /held by (\S+?),? /.exec(message))) return `${m[1]} is still working on this.`;
  if ((m = /later in the queue than (\S+?), which is ready/.exec(message))) return `${m[1]} is next in the queue. Take that first, or change the queue's order.`;
  if (code === "out_of_order") return "Something else is next in the queue. Take that first, or change the queue's order.";
  if (code === "gated") return "This waits for someone's approval first.";
  if (code === "revision_conflict") return "Someone changed this at the same time. Look again and retry.";
  if (code === "cycle") return "That would make tasks wait on each other in a loop.";
  if (code === "duplicate") return "Something with that name already exists.";
  if (code === "auth" || code === "forbidden" || code === "revoked") return "This page is no longer allowed to make changes. Reload it from the link staple printed.";
  if (code === "rate_limited") return "Too many changes at once. Wait a moment and try again.";
  if (code === "unavailable" || code === "offline") return "The tracker can't be reached right now. Try again in a moment.";
  if (code === "payload_too_large") return "That is too large to save.";
  if (code === "epoch_changed" || code === "cursor_invalid" || code === "schema_ahead" || code === "protocol_unsupported") return "The tracker's sync needs attention before this can be saved.";
  if (code === "conflict") return "The task changed while you were looking. Check it and try again.";
  if (code === "validation") return "The tracker didn't accept that change.";
  if (code === "not_found") return "This task could not be found. It may have moved.";
  return "That didn't go through.";
}

// ─────────────────────────────────────────────────────────────── the queue

/** The fields of a queue row the strict check reads (`EffectiveQueueRow`). */
export interface QueueRowLike {
  issueId: string;
  identifier: string;
  title: string;
  position: number;
  unqueued: boolean;
  eligibility: string;
}

/**
 * Under the Strict queue setting, the plan row that must be taken before `issueId`, exactly as
 * the store's order check decides it: an eligible row in the plan band that comes before this
 * one (or any eligible plan row, when this one is not in the plan). Null when nothing is ahead.
 */
export function queueAheadOf(rows: readonly QueueRowLike[], issueId: string): { identifier: string; title: string } | null {
  const target = rows.find((row) => row.issueId === issueId) ?? null;
  const ahead = rows.find(
    (row) =>
      !row.unqueued &&
      row.eligibility === "eligible" &&
      row.issueId !== issueId &&
      (target === null || target.unqueued || row.position < target.position),
  );
  return ahead ? { identifier: ahead.identifier, title: ahead.title } : null;
}
