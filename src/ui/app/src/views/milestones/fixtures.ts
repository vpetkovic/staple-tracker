/**
 * Test-support builders for the milestone view shape. NOT imported by any app code — Vite
 * drops it from the bundle because nothing in the module graph reaches it. Beside the code
 * for the reason `components/task-list/fixtures.ts` gives: typed against the browser app's
 * `lib/types.ts`, which the Node-side suite cannot see.
 */
import type { MilestoneListRow, MilestoneMemberRow, MilestoneProgress, MilestoneView } from "@/lib/types";

type ProgressOver = Omit<Partial<MilestoneProgress>, "counts"> & { counts?: Partial<MilestoneProgress["counts"]> };
type ViewOver = Omit<Partial<MilestoneView>, "milestone"> & { milestone?: Partial<MilestoneView["milestone"]> };
type ListRowOver = Omit<Partial<MilestoneListRow>, "milestone"> & { milestone?: Partial<MilestoneView["milestone"]> };

export function progress(over: ProgressOver = {}): MilestoneProgress {
  const counts = {
    unstarted: 0,
    ready: 0,
    active: 0,
    review: 0,
    gated: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    ...(over.counts ?? {}),
  };
  const countable = over.countable ?? Object.values(counts).reduce((a, b) => a + b, 0) - counts.cancelled;
  return {
    total: over.total ?? countable + counts.cancelled,
    countable,
    counts,
    percent: over.percent ?? (countable === 0 ? null : Math.floor((counts.done * 100) / countable)),
    complete: over.complete ?? (countable > 0 && counts.done === countable),
  };
}

export function member(over: Partial<MilestoneMemberRow> & { identifier: string }): MilestoneMemberRow {
  return {
    title: `${over.identifier} title`,
    kind: "task",
    status: "todo",
    position: 1,
    rank: 1024,
    parent: null,
    nestedUnder: null,
    addedBy: "vp",
    addedAt: "2026-09-01T00:00:00.000Z",
    note: null,
    ...over,
  };
}

export function view(over: ViewOver = {}): MilestoneView {
  return {
    milestone: {
      identifier: "STA-190",
      title: "October cut",
      status: "in_progress",
      kind: "milestone",
      assignee: null,
      targetDate: "2026-10-31",
      startDate: null,
      state: "active",
      planPosition: null,
      ...(over.milestone ?? {}),
    },
    progress: over.progress ?? progress(),
    revision: over.revision ?? 3,
    members: over.members ?? [],
    next: over.next ?? null,
  };
}

export function listRow(over: ListRowOver = {}): MilestoneListRow {
  const { members: _members, ...rest } = view(over);
  return { ...rest, memberCount: over.memberCount ?? 0 };
}
