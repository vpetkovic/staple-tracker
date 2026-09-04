/**
 * Test-support builders for the queue view shape. NOT imported by any app code — Vite
 * drops it from the bundle because nothing in the module graph reaches it. Beside the code
 * for the reason `views/milestones/fixtures.ts` gives: typed against the browser app's
 * `lib/types.ts`, which the Node-side suite cannot see.
 */
import type { EffectiveQueueRow, QueueEntry, QueueView } from "@/lib/types";

export function entry(over: Partial<QueueEntry> & { identifier: string }): QueueEntry {
  return {
    issueId: `id-${over.identifier}`,
    title: `${over.identifier} title`,
    kind: "task",
    status: "backlog",
    planPosition: 1,
    rank: 1024,
    parent: null,
    resolved: false,
    addedBy: "vp",
    addedAt: "2026-09-01T00:00:00.000Z",
    note: null,
    ...over,
  };
}

export function effective(over: Partial<EffectiveQueueRow> & { identifier: string }): EffectiveQueueRow {
  return {
    issueId: `id-${over.identifier}`,
    title: `${over.identifier} title`,
    kind: "task",
    status: "backlog",
    position: 1,
    planPosition: null,
    via: null,
    unqueued: false,
    eligibility: "eligible",
    reason: null,
    detail: null,
    dueAt: null,
    parent: null,
    milestonePath: [],
    epicPath: [],
    ...over,
  };
}

export function queue(over: Partial<QueueView> = {}): QueueView {
  return { revision: 3, entries: [], effective: [], ...over };
}

/**
 * docs/queue.md's worked example, cut to the rows the editor has to draw: STA-31 resolved
 * at plan 1, STA-66 a container at plan 2 expanding to three of its children, STA-146 at
 * plan 3 and effective 5 — the row where the two numbers differ.
 */
export function workedExample(): QueueView {
  return queue({
    revision: 7,
    entries: [
      entry({ identifier: "STA-31", title: "A1: characterize current product contracts", status: "done", planPosition: 1, resolved: true, rank: 1024 }),
      entry({ identifier: "STA-66", title: "S: opt-in cloud continuity", kind: "epic", planPosition: 2, rank: 2048 }),
      entry({ identifier: "STA-146", title: "Flaky under full-suite load", planPosition: 3, rank: 3072 }),
    ],
    effective: [
      effective({ identifier: "STA-31", title: "A1: characterize current product contracts", status: "done", position: 1, planPosition: 1, eligibility: "resolved", reason: "STA-31 is done" }),
      effective({ identifier: "STA-67", title: "S1: specify the local-first sync", position: 2, planPosition: 2, via: "STA-66" }),
      effective({ identifier: "STA-68", title: "S2: add clone-safe repository identity", position: 3, planPosition: 2, via: "STA-66", eligibility: "blocked", reason: "blocked by STA-35, STA-67", detail: { blockers: ["STA-35", "STA-67"] } }),
      effective({ identifier: "STA-70", title: "S4: build the repository-scoped Worker", position: 4, planPosition: 2, via: "STA-66", eligibility: "blocked", reason: "blocked by STA-67" }),
      effective({ identifier: "STA-146", title: "Flaky under full-suite load", position: 5, planPosition: 3 }),
    ],
  });
}
