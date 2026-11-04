/**
 * The queue view: the pickup queue as the `ui://staple/queue` view draws it in an agent's
 * thread, in lanes.
 *
 * `queueLanes` reads everything the view shows, and both halves of a `show_queue` answer
 * come from it: `structuredContent.queue` for a host that renders the view, and `queueText`
 * for a host that does not. The view is a read: Take posts a message into the thread
 * (`ui/message`, which the host confirms), and Approve calls `approve_task` through the
 * host, which asks a person first because that tool writes.
 *
 * The lanes are the effective queue (`store.queue().effectiveQueue`, the one resolver
 * `staple queue next` and `next_task` read) split by eligibility, in effective order:
 *
 *   - READY: the `eligible` rows, in pickup order. The first is exactly what
 *     `staple queue next` answers as `next`.
 *   - GATED: the `gated` rows, grouped by the gate that holds them (the gate's ticket, its
 *     owner and who asked). A ticket that is itself awaiting approval is its own group.
 *   - IN PROGRESS: the `claimed` rows, with who holds each and how its current attempt is
 *     going (milestones recorded, the newest one, time against the estimate).
 *
 * `blocked` and `unavailable` rows are counted and named, not drawn as lanes. Resolved
 * rows never appear (the resolver only reaches open work).
 *
 * QUEUE POLICY. Under `queue.policy = strict` checkout refuses a row while an eligible
 * PLAN row comes before it, checked against the whole plan even when the view is scoped.
 * `expected` is that row (the one `checkout_task` would accept now), and each ready row
 * says whether it can be taken now (`takeable`). Under `advisory` every ready row can.
 */
import { formatDuration } from "./mcp-ticket-card.js";
import type { WorkspaceStore } from "./core/store.js";
import type { EffectiveQueueRow } from "./core/queue-store.js";
import type { QueuePolicy } from "./core/settings-registry.js";
import { nowIso } from "./core/types.js";

export interface QueueLaneRow {
  identifier: string;
  title: string;
  /** 1-based position in EFFECTIVE order, the number `queue next` and `out_of_order` speak. */
  position: number;
  /** The plan row this came from; null in the unqueued band. */
  planPosition: number | null;
  /** The milestone, then the ancestor epics, outermost first. */
  path: string[];
}

export interface QueueReadyRow extends QueueLaneRow {
  /** Whether `checkout_task` accepts it now: always under advisory, only `expected` under strict. */
  takeable: boolean;
}

export interface QueueGateGroup {
  /** The ticket that carries the gate. */
  identifier: string;
  title: string;
  /** Who must approve; null when the ticket is awaiting approval with no gate recorded. */
  owner: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  /** The queue rows this gate holds, in effective order. A ticket that is its own gate holds itself. */
  holds: QueueLaneRow[];
  /** Approve is offered while the gate is pending. */
  approve: boolean;
}

export interface QueueWorkingRow extends QueueLaneRow {
  /** The agent holding the claim. */
  heldBy: string;
  /** Seconds since the holder last did anything on it. */
  idleSeconds: number | null;
  /** The open attempt; null when the claim has none (claimed before attempts were recorded). */
  attempt: { ordinal: number; state: string; startedAt: string } | null;
  milestoneCount: number;
  /** The newest milestone's label. */
  lastMilestone: string | null;
  timing: { estimatedSeconds: number | null; elapsedSeconds: number | null };
}

export interface QueueLanes {
  /** The workspace slug, as the web UI's `ws` parameter names it. */
  workspace: string;
  /** The queue revision this was read at. */
  revision: number;
  /** The container the lanes are limited to, when the call named one. */
  scope: { identifier: string; title: string; kind: string } | null;
  policy: QueuePolicy;
  /** Under strict: the row checkout accepts now (whole plan). Null under advisory or when none is. */
  expected: { identifier: string; title: string; position: number } | null;
  /** What `staple queue next` answers for the same scope: the first ready row. */
  next: string | null;
  ready: QueueReadyRow[];
  gated: QueueGateGroup[];
  inProgress: QueueWorkingRow[];
  /** Rows waiting on other work, with what blocks them. */
  blocked: Array<{ identifier: string; title: string; blockers: string[] }>;
  /** Rows in a status checkout does not take (say, in review). */
  unavailable: Array<{ identifier: string; title: string; status: string }>;
  /** Each lane's full length; a lane carries at most {@link LANE_LIMIT} rows. */
  totals: { ready: number; gated: number; inProgress: number; blocked: number; unavailable: number };
  asOf: string;
}

/** How many rows (or gate groups) one lane carries at most. */
export const LANE_LIMIT = 20;

function laneRow(row: EffectiveQueueRow): QueueLaneRow {
  return {
    identifier: row.identifier,
    title: row.title,
    position: row.position,
    planPosition: row.planPosition,
    path: [...row.milestonePath, ...row.epicPath],
  };
}

/** Everything the queue view shows, for one workspace or one container in it. */
export function queueLanes(store: WorkspaceStore, options: { scope?: string; actor?: string } = {}, now: string = nowIso()): QueueLanes {
  const queue = store.queue();
  const answer = queue.effectiveQueue({ actor: options.actor, scope: options.scope });
  const policy = store.getSetting("queue.policy") as QueuePolicy;

  // Strict refuses a row while an eligible PLAN row of the WHOLE queue comes first
  // (store.queueOrderCheck); the scope narrows what is shown, not what checkout checks.
  let expected: QueueLanes["expected"] = null;
  if (policy === "strict") {
    const whole = answer.scope ? queue.effectiveQueue({ actor: options.actor }).rows : answer.rows;
    const head = whole.find((row) => !row.unqueued && row.eligibility === "eligible");
    expected = head ? { identifier: head.identifier, title: head.title, position: head.position } : null;
  }

  const eligible = answer.rows.filter((row) => row.eligibility === "eligible");
  const ready: QueueReadyRow[] = eligible.slice(0, LANE_LIMIT).map((row) => ({
    ...laneRow(row),
    takeable: policy !== "strict" || expected === null || expected.identifier === row.identifier,
  }));

  const groups = new Map<string, QueueGateGroup>();
  for (const row of answer.rows) {
    if (row.eligibility !== "gated") continue;
    const by = (row.detail?.queuedBy ?? null) as { identifier: string; owner: string } | null;
    const holder = by?.identifier ?? row.identifier;
    let group = groups.get(holder);
    if (!group) {
      const gate = store.gate(holder);
      group = {
        identifier: holder,
        title: by === null ? row.title : store.getIssue(holder).title,
        owner: gate?.owner ?? by?.owner ?? null,
        requestedBy: gate?.requestedBy ?? null,
        requestedAt: gate?.requestedAt ?? null,
        holds: [],
        approve: gate?.state === "pending",
      };
      groups.set(holder, group);
    }
    group.holds.push(laneRow(row));
  }
  const gated = [...groups.values()];

  const claimed = answer.rows.filter((row) => row.eligibility === "claimed");
  const inProgress: QueueWorkingRow[] = claimed.slice(0, LANE_LIMIT).map((row) => {
    const current = store.attemptSummary(row.issueId).current;
    const milestones = current
      ? store.attemptTransitions(current.id).filter((transition) => transition.kind === "attempt_milestone")
      : [];
    const label = milestones.at(-1)?.detail as { label?: unknown } | undefined;
    const { timing } = store.detailTiming(row.issueId);
    return {
      ...laneRow(row),
      heldBy: String(row.detail?.heldBy ?? row.claim?.heldBy ?? ""),
      idleSeconds: row.claim?.idleSeconds ?? null,
      attempt: current ? { ordinal: current.ordinal, state: current.state, startedAt: current.startedAt } : null,
      milestoneCount: milestones.length,
      lastMilestone: typeof label?.label === "string" ? label.label : null,
      timing: {
        estimatedSeconds: timing.subtreePlan?.estimatedSeconds ?? timing.estimatedSeconds,
        elapsedSeconds: timing.activeSeconds,
      },
    };
  });

  const blockedRows = answer.rows.filter((row) => row.eligibility === "blocked");
  const unavailableRows = answer.rows.filter((row) => row.eligibility === "unavailable");
  return {
    workspace: store.slug,
    revision: answer.revision,
    scope: answer.scope ? { identifier: answer.scope.identifier, title: answer.scope.title, kind: answer.scope.kind } : null,
    policy,
    expected,
    next: answer.next?.identifier ?? null,
    ready,
    gated: gated.slice(0, LANE_LIMIT),
    inProgress,
    blocked: blockedRows.slice(0, LANE_LIMIT).map((row) => {
      const detail = row.detail as { blockers?: string[]; crossBlockers?: Array<{ identifier: string }> } | null;
      return {
        identifier: row.identifier,
        title: row.title,
        blockers: [...(detail?.blockers ?? []), ...(detail?.crossBlockers ?? []).map((blocker) => blocker.identifier)],
      };
    }),
    unavailable: unavailableRows.slice(0, LANE_LIMIT).map((row) => ({ identifier: row.identifier, title: row.title, status: row.status })),
    totals: {
      ready: eligible.length,
      gated: gated.length,
      inProgress: claimed.length,
      blocked: blockedRows.length,
      unavailable: unavailableRows.length,
    },
    asOf: now,
  };
}

/** The message Take posts into the thread: what a person types to hand a ticket to the agent. */
export function takeMessage(identifier: string): string {
  return `Work ${identifier}`;
}

function more(shown: number, total: number): string | null {
  return total > shown ? `  …and ${total - shown} more` : null;
}

/** The lanes as prose: the whole answer for a host without MCP Apps. */
export function queueText(lanes: QueueLanes): string {
  const { totals } = lanes;
  const lines = [
    [
      `Queue${lanes.scope ? ` in ${lanes.scope.identifier} ${lanes.scope.title}` : ""} (${lanes.policy})`,
      `${totals.ready} ready`,
      `${totals.gated} gated`,
      `${totals.inProgress} in progress`,
      ...(totals.blocked > 0 ? [`${totals.blocked} blocked`] : []),
    ].join(" · "),
  ];
  const head = lanes.ready[0];
  lines.push(head ? `Next: ${head.identifier} ${head.title}` : "Next: nothing is ready.");
  if (lanes.policy === "strict" && lanes.expected) {
    lines.push(`Strict queue: checkout takes ${lanes.expected.identifier} now; every other ready row waits for it.`);
  }
  if (lanes.ready.length > 0) {
    lines.push("Ready, in pickup order:");
    lanes.ready.forEach((row, index) => {
      lines.push(`  ${index + 1}. ${row.identifier} ${row.title}${row.takeable ? "" : ` (after ${lanes.expected?.identifier ?? "the expected row"})`}`);
    });
    const tail = more(lanes.ready.length, totals.ready);
    if (tail) lines.push(tail);
  }
  if (lanes.gated.length > 0) {
    lines.push("Gated, waiting on a person:");
    for (const group of lanes.gated) {
      const held = group.holds.map((row) => row.identifier).filter((id) => id !== group.identifier);
      lines.push(
        `  ${group.identifier} ${group.title}: ${group.owner ? `waiting on ${group.owner}` : "awaiting approval"}${held.length > 0 ? `; holds ${held.join(", ")}` : ""}.${group.approve ? " Approve with approve_task." : ""}`,
      );
    }
    const tail = more(lanes.gated.length, totals.gated);
    if (tail) lines.push(tail);
  }
  if (lanes.inProgress.length > 0) {
    lines.push("In progress:");
    for (const row of lanes.inProgress) {
      const parts = [row.heldBy];
      if (row.attempt) parts.push(`attempt #${row.attempt.ordinal} ${row.attempt.state}`);
      parts.push(`${row.milestoneCount} milestone${row.milestoneCount === 1 ? "" : "s"}${row.lastMilestone ? `, last "${row.lastMilestone}"` : ""}`);
      const { estimatedSeconds, elapsedSeconds } = row.timing;
      if (estimatedSeconds !== null) parts.push(`${formatDuration(elapsedSeconds ?? 0)} of ${formatDuration(estimatedSeconds)}`);
      else if (elapsedSeconds) parts.push(`${formatDuration(elapsedSeconds)}, no estimate`);
      lines.push(`  ${row.identifier} ${row.title}: ${parts.join(" · ")}`);
    }
    const tail = more(lanes.inProgress.length, totals.inProgress);
    if (tail) lines.push(tail);
  }
  if (lanes.blocked.length > 0) {
    lines.push(
      `Blocked: ${lanes.blocked.map((row) => `${row.identifier}${row.blockers.length > 0 ? ` (by ${row.blockers.join(", ")})` : ""}`).join(", ")}${totals.blocked > lanes.blocked.length ? `, and ${totals.blocked - lanes.blocked.length} more` : ""}.`,
    );
  }
  if (lanes.unavailable.length > 0) {
    lines.push(`Not takeable now: ${lanes.unavailable.map((row) => `${row.identifier} (${row.status.replace(/_/g, " ")})`).join(", ")}.`);
  }
  if (head) lines.push(`To take one, say "${takeMessage(head.identifier)}".`);
  return lines.join("\n");
}
