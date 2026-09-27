/**
 * The Queue page's plain summary: how much of the plan is ready, being worked on, waiting,
 * and finished, and how much open work is not in the plan at all.
 *
 * Read off the resolver's own `effective` rows (`/api/queue`), never re-derived: whether a
 * row is ready is the store's answer, and a second definition here would be the one thing the
 * queue cannot afford (docs/queue.md). This only counts what the server already decided.
 */
import type { EffectiveQueueRow, QueueEligibility } from "@/lib/types";

export type QueueBucket = "done" | "active" | "ready" | "waiting";

/** Which of the four plain buckets an eligibility falls in. */
export const BUCKET_OF: Readonly<Record<QueueEligibility, QueueBucket>> = {
  resolved: "done",
  claimed: "active",
  eligible: "ready",
  blocked: "waiting",
  gated: "waiting",
  unavailable: "waiting",
};

/** Bar order, left to right: what is finished, then what is moving, then what is not. */
export const BUCKET_ORDER: readonly QueueBucket[] = ["done", "active", "ready", "waiting"];

export const BUCKET_WORDS: Readonly<Record<QueueBucket, string>> = {
  done: "finished",
  active: "being worked on",
  ready: "ready to pick up",
  waiting: "waiting on something",
};

export interface QueueSummary {
  /** Tasks the plan puts in front of an agent, including what its entries expand to. */
  planned: number;
  counts: Record<QueueBucket, number>;
  /** Open work after the plan: picked up only once the plan is exhausted. */
  notPlanned: number;
}

export function queueSummary(effective: readonly EffectiveQueueRow[]): QueueSummary {
  const counts: Record<QueueBucket, number> = { done: 0, active: 0, ready: 0, waiting: 0 };
  let planned = 0;
  let notPlanned = 0;
  for (const row of effective) {
    if (row.unqueued) {
      notPlanned += 1;
      continue;
    }
    planned += 1;
    counts[BUCKET_OF[row.eligibility]] += 1;
  }
  return { planned, counts, notPlanned };
}

/** "3 ready to pick up, 1 being worked on and 2 waiting on something." Zero buckets are left out. */
export function summarySentence(summary: QueueSummary): string {
  if (summary.planned === 0) {
    return summary.notPlanned > 0
      ? `Nothing is planned yet, so agents take the ${summary.notPlanned} open ${summary.notPlanned === 1 ? "task" : "tasks"} in list order.`
      : "Nothing is planned and there is no open work.";
  }
  const parts = (["ready", "active", "waiting", "done"] as const)
    .filter((bucket) => summary.counts[bucket] > 0)
    .map((bucket) => `${summary.counts[bucket]} ${BUCKET_WORDS[bucket]}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `${summary.planned} ${summary.planned === 1 ? "task is" : "tasks are"} in the plan: ${list}.`;
}
