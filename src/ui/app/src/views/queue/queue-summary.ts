/**
 * The Queue page's counts: how much of the plan is ready, being worked on, waiting, and
 * finished, and how much open work is not in the plan at all.
 *
 * Read off the resolver's own `effective` rows (`/api/queue`), never re-derived: whether a
 * row is ready is the store's answer, and a second definition here would be the one thing the
 * queue cannot afford (design/queue.md). This only counts what the server already decided.
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
  // Another member's ticket: not this machine's to take, so waiting from here.
  assigned_to_other_member: "waiting",
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
