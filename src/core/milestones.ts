/**
 * Milestones — the pure half of the contract in `docs/milestones.md` (STA-171, R3a).
 *
 * A milestone is an issue of the reserved `milestone` kind that owns two calendar
 * dates and an ORDERED MEMBERSHIP of other issues, without re-parenting any of
 * them. Everything here is a type or a function of its arguments: no store, no
 * database, no clock. R3b's store methods import from here so that the rules —
 * the UTC inclusive-day contract, the sparse-rank encoding, and the
 * count-each-leaf-once progress rollup — have exactly one implementation and one
 * set of tests (`test/milestones.test.ts`).
 */
import { STATUS_CATEGORIES, StapleError, type StatusCategory } from "./types.js";

/**
 * The reserved kind id. A milestone is identified by its kind and by nothing
 * else — there is no flag column — which is why this is an id and not a
 * category: kinds have no categories, and the one behaviour a milestone carries
 * is confined to the milestone tables (see "Identity" in docs/milestones.md).
 */
export const MILESTONE_KIND = "milestone";

/** One `milestone_meta` row. Owner, details and notes live on the issue itself. */
export interface MilestoneMeta {
  issueId: string;
  /** `YYYY-MM-DD` or null — due by the END of that UTC day. */
  targetDate: string | null;
  /** `YYYY-MM-DD` or null — never after `targetDate` when both are set. */
  startDate: string | null;
  /** Bumped by every membership mutation on this milestone; the reorder CAS base. */
  membersRevision: number;
  updatedAt: string;
}

/** One `milestone_members` row: an issue's single direct membership. */
export interface MilestoneMembership {
  milestoneId: string;
  issueId: string;
  /** Sparse integer, unique within the milestone; see `rankBetween`. */
  rank: number;
  addedBy: string;
  addedAt: string;
  note: string | null;
}

export const MILESTONE_STATES = ["planned", "active", "overdue", "done", "cancelled"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

// ---------- dates: calendar days, UTC, inclusive ----------

export const MILESTONE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const MS_PER_DAY = 86_400_000;

function invalidDate(value: string): StapleError {
  return new StapleError("validation", `Milestone dates are calendar days, YYYY-MM-DD; got "${value}".`);
}

/**
 * Validate a `YYYY-MM-DD` string and return it trimmed. Refuses the wrong shape
 * and a day that does not exist (`2026-02-30`), which the round trip through
 * `Date.UTC` catches because JavaScript silently rolls such a date forward.
 */
export function parseMilestoneDate(value: string): string {
  const date = value.trim();
  if (!MILESTONE_DATE_PATTERN.test(date)) throw invalidDate(value);
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw invalidDate(value);
  }
  return date;
}

/** The inclusive extent of a calendar day in UTC, as ISO timestamps. */
export function milestoneDateBounds(date: string): { startsAt: string; endsAt: string } {
  const day = parseMilestoneDate(date);
  return { startsAt: `${day}T00:00:00.000Z`, endsAt: `${day}T23:59:59.999Z` };
}

/** The UTC calendar day an ISO timestamp falls on. */
export function utcDateOf(iso: string): string {
  const millis = Date.parse(iso);
  if (Number.isNaN(millis)) {
    throw new StapleError("validation", `Not an ISO timestamp: "${iso}".`);
  }
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * Overdue from the UTC midnight AFTER the target: on the target day itself, at
 * any hour, a milestone is still on time. Zero-padded `YYYY-MM-DD` strings
 * compare chronologically, so this is a string comparison on purpose.
 */
export function isOverdue(targetDate: string | null, nowIso: string): boolean {
  if (targetDate === null) return false;
  return utcDateOf(nowIso) > parseMilestoneDate(targetDate);
}

/** Whole calendar days from UTC today to the target: 0 on the day, negative after. */
export function daysUntil(targetDate: string, nowIso: string): number {
  const target = Date.parse(`${parseMilestoneDate(targetDate)}T00:00:00.000Z`);
  const today = Date.parse(`${utcDateOf(nowIso)}T00:00:00.000Z`);
  return Math.round((target - today) / MS_PER_DAY);
}

/** A start date may not be after the target date; either may be absent. */
export function assertMilestoneDates(dates: { startDate: string | null; targetDate: string | null }): void {
  const start = dates.startDate === null ? null : parseMilestoneDate(dates.startDate);
  const target = dates.targetDate === null ? null : parseMilestoneDate(dates.targetDate);
  if (start !== null && target !== null && start > target) {
    throw new StapleError("validation", `Start date ${start} is after target date ${target}.`, {
      startDate: start,
      targetDate: target,
    });
  }
}

// ---------- membership order: sparse integer ranks ----------

/** The gap between two ranks; the queue's step (docs/queue.md, "Storage"). */
export const MEMBER_RANK_STEP = 1024;

/**
 * The rank for a row slotted between two neighbours, either of which may be
 * absent. First row: the step. Append: `after + step`. Prepend: the midpoint of
 * zero and the head. Between: the midpoint, rounded down. Returns `null` when
 * the gap is exhausted (`after - before < 2`), which tells the caller to
 * renumber the milestone (`renumberedRanks`) in the same transaction and try
 * again.
 */
export function rankBetween(before: number | null, after: number | null): number | null {
  if (before === null && after === null) return MEMBER_RANK_STEP;
  if (after === null) return before! + MEMBER_RANK_STEP;
  const lower = before ?? 0;
  if (after - lower < 2) return null;
  return Math.floor((lower + after) / 2);
}

/** Clean ranks for `count` rows in their current order: step, 2·step, 3·step … */
export function renumberedRanks(count: number): number[] {
  return Array.from({ length: count }, (_, index) => (index + 1) * MEMBER_RANK_STEP);
}

// ---------- membership rules ----------

/** The kinds a membership check needs to know about an issue. */
export interface MembershipCandidate {
  id: string;
  identifier: string;
  kind: string;
}

/**
 * Refuse a membership before any row is written: the container must be a
 * milestone, the member may not be one (plans do not nest) nor the container
 * itself, and an issue is a DIRECT member of at most one milestone — a second is
 * a move, not an add. The kind-configured check is separate (`assertMilestoneKindConfigured`).
 */
export function assertMembershipAllowed(
  milestone: MembershipCandidate,
  member: MembershipCandidate,
  currentMilestone: { id: string; identifier: string } | null,
): void {
  if (milestone.kind !== MILESTONE_KIND) {
    throw new StapleError(
      "validation",
      `${milestone.identifier} is ${article(milestone.kind)} ${milestone.kind}, not a milestone.`,
      { identifier: milestone.identifier, kind: milestone.kind },
    );
  }
  if (member.id === milestone.id) {
    throw new StapleError("validation", `${milestone.identifier} cannot be a member of itself.`);
  }
  if (member.kind === MILESTONE_KIND) {
    throw new StapleError(
      "validation",
      `${member.identifier} is a milestone; milestones cannot be members of milestones.`,
      { identifier: member.identifier },
    );
  }
  if (currentMilestone !== null && currentMilestone.id !== milestone.id) {
    throw new StapleError(
      "validation",
      `${member.identifier} is already in ${currentMilestone.identifier}. Use \`staple milestone mv ${member.identifier} --to ${milestone.identifier}\` to move it.`,
      { identifier: member.identifier, milestone: currentMilestone.identifier },
    );
  }
}

/** The command that turns the feature on; every surface names it the same way. */
export const MILESTONE_KIND_MISSING_MESSAGE =
  "No `milestone` kind is configured in this workspace. Run `staple kinds add milestone --label Milestone` to enable milestones.";

/** Refuse every milestone operation in a workspace whose vocabulary lacks the kind. */
export function assertMilestoneKindConfigured(kindIds: readonly string[]): void {
  if (!kindIds.includes(MILESTONE_KIND)) {
    throw new StapleError("validation", MILESTONE_KIND_MISSING_MESSAGE, { kind: MILESTONE_KIND });
  }
}

/**
 * The effective milestone of an issue: its own direct membership if it has one,
 * else the nearest ancestor's. `chain` is the issue id first, then its parent,
 * then the grandparent, and so on; `memberOf` maps issue id to milestone id.
 */
export function nearestMilestone(
  chain: readonly string[],
  memberOf: ReadonlyMap<string, string>,
): string | null {
  for (const id of chain) {
    const milestone = memberOf.get(id);
    if (milestone !== undefined) return milestone;
  }
  return null;
}

// ---------- progress: count each leaf once ----------

/** What the rollup needs to know about a member or a descendant. */
export interface ProgressNode {
  id: string;
  parentId: string | null;
  category: StatusCategory;
}

export interface MilestoneProgress {
  /** Leaves counted, cancelled included. */
  total: number;
  /** `total` minus cancelled leaves — the denominator. */
  countable: number;
  /** Leaves per status category; every category is present, zero when empty. */
  counts: Record<StatusCategory, number>;
  /** `floor(done · 100 / countable)`; null when nothing is countable. */
  percent: number | null;
  /** Something is countable and all of it is done. */
  complete: boolean;
}

function emptyCounts(): Record<StatusCategory, number> {
  return Object.fromEntries(STATUS_CATEGORIES.map((category) => [category, 0])) as Record<
    StatusCategory,
    number
  >;
}

/**
 * Roll up the LEAVES reachable from the members, each counted once.
 *
 * `members` are the direct members in any order; `descendantsByMember` holds
 * every descendant of a member, at any depth. An issue is a leaf when nothing in
 * the reachable set names it as parent — so a parent is never counted (its
 * status is a report of its children's), and a descendant reached through two
 * members, or as a member and through its epic, is counted once by id.
 * Cancelled leaves are in `total` and `counts.cancelled` but not in `countable`.
 */
export function milestoneProgress(
  members: readonly ProgressNode[],
  descendantsByMember: ReadonlyMap<string, readonly ProgressNode[]>,
): MilestoneProgress {
  const reachable = new Map<string, ProgressNode>();
  for (const member of members) {
    reachable.set(member.id, member);
    for (const descendant of descendantsByMember.get(member.id) ?? []) {
      reachable.set(descendant.id, descendant);
    }
  }
  const parents = new Set<string>();
  for (const node of reachable.values()) {
    if (node.parentId !== null) parents.add(node.parentId);
  }

  const counts = emptyCounts();
  let total = 0;
  for (const node of reachable.values()) {
    if (parents.has(node.id)) continue;
    counts[node.category] += 1;
    total += 1;
  }
  const countable = total - counts.cancelled;
  const percent = countable === 0 ? null : Math.floor((counts.done * 100) / countable);
  return { total, countable, counts, percent, complete: countable > 0 && counts.done === countable };
}

// ---------- state: derived, never stored ----------

/**
 * First match wins: the milestone's own resolution, then the calendar, then
 * whether work has begun (the start date arrived, or any counted leaf left the
 * pre-work band), else `planned`. Blocked and gated are member facts, not
 * milestone states.
 */
export function milestoneState(
  milestone: { category: StatusCategory; targetDate: string | null; startDate: string | null },
  progress: MilestoneProgress,
  nowIso: string,
): MilestoneState {
  if (milestone.category === "done") return "done";
  if (milestone.category === "cancelled") return "cancelled";
  if (isOverdue(milestone.targetDate, nowIso)) return "overdue";
  if (milestone.startDate !== null && utcDateOf(nowIso) >= parseMilestoneDate(milestone.startDate)) {
    return "active";
  }
  const begun = progress.counts.active + progress.counts.review + progress.counts.done;
  return begun > 0 ? "active" : "planned";
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}
