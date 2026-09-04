/**
 * The Milestones view's pure model — R3c (STA-173), docs/milestones.md.
 *
 * Everything here is a function of the server's milestone view plus the page's issue list;
 * no React, no fetch. The component renders what these return and the tests pin them
 * without a DOM.
 *
 * ── WHAT IS DERIVED HERE AND WHAT IS NOT ────────────────────────────────────────────────
 *
 * The milestone STATE (planned/active/overdue/done/cancelled) is derived by the store on
 * every read and arrives on the view; this module never re-derives it. Blocked and gated
 * are not milestone states — docs/milestones.md says so — they are facts about members,
 * and the store already counts them per status category in `progress.counts`. So "risk"
 * is a reading of the view, not a second derivation that could disagree with it.
 *
 * `next` is the queue resolver's answer and is null until R3d fills it; the view renders
 * the null as "no eligible work" rather than guessing.
 */
import { flatRow, type TaskRow } from "@/components/task-list";
import type {
  Issue,
  IssueRow,
  MilestoneListRow,
  MilestoneMemberRow,
  MilestoneNext,
  MilestoneState,
  MilestoneView,
} from "@/lib/types";

// ---------- ordering ----------

/** Numeric compare on the identifier's counter, so STA-9 sorts before STA-10. */
function byIdentifier(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Ascending, with null LAST — an unplanned milestone sits below every planned one. */
function nullsLast<T extends number | string>(a: T | null, b: T | null, compare: (x: T, y: T) => number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return compare(a, b);
}

/**
 * Plan order first, then target date, then identifier. Plan order is the human's explicit
 * sequence and beats a date the same way it does in the queue (docs/queue.md); a date
 * explains urgency but never reorders a plan.
 */
export function sortMilestones<T extends Pick<MilestoneListRow, "milestone">>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      nullsLast(a.milestone.planPosition, b.milestone.planPosition, (x, y) => x - y) ||
      nullsLast(a.milestone.targetDate, b.milestone.targetDate, (x, y) => x.localeCompare(y)) ||
      byIdentifier(a.milestone.identifier, b.milestone.identifier),
  );
}

// ---------- state and risk, without colour ----------

/**
 * One glyph and one word per state, so a state is legible with no colour at all (WCAG
 * 1.4.1). The glyphs are text on purpose: they render in a static-markup test and in a
 * terminal-pasted screenshot alike, and each is distinct from every other by shape.
 */
export const STATE_PRESENTATION: Readonly<Record<MilestoneState, { glyph: string; label: string }>> = {
  planned: { glyph: "○", label: "Planned" },
  active: { glyph: "◐", label: "Active" },
  overdue: { glyph: "!", label: "Overdue" },
  done: { glyph: "✓", label: "Done" },
  cancelled: { glyph: "×", label: "Cancelled" },
};

export interface MilestoneRisk {
  overdue: boolean;
  /** Counted leaves in the `blocked` category. */
  blocked: number;
  /** Counted leaves in the `gated` category. */
  gated: number;
}

export function milestoneRisk(row: Pick<MilestoneView, "milestone" | "progress">): MilestoneRisk {
  return {
    overdue: row.milestone.state === "overdue",
    blocked: row.progress.counts.blocked,
    gated: row.progress.counts.gated,
  };
}

/** The risk as words, each with its own glyph. Empty when there is nothing to warn about. */
export function riskLabels(risk: MilestoneRisk): string[] {
  const out: string[] = [];
  if (risk.overdue) out.push("! overdue");
  if (risk.blocked > 0) out.push(`⊘ ${risk.blocked} blocked`);
  if (risk.gated > 0) out.push(`◇ ${risk.gated} gated`);
  return out;
}

/** "5/11 done · 45%", or the honest sentence when nothing is countable. */
export function progressLabel(progress: MilestoneView["progress"]): string {
  if (progress.countable === 0) return "nothing to count yet";
  return `${progress.counts.done}/${progress.countable} done · ${progress.percent ?? 0}%`;
}

/** What the list and the detail say about the queue's answer. */
export const NOT_QUEUED_LABEL = "no eligible work";

export function nextWorkLabel(next: MilestoneNext | null): string {
  return next ? `next: ${next.identifier} (#${next.position})` : NOT_QUEUED_LABEL;
}

export function dateLabel(date: string | null): string {
  return date ?? "no date";
}

// ---------- members, with their hierarchy ----------

/**
 * A row in the member list: either a direct member (movable, removable) or one of a
 * member epic's own descendants, shown indented under it so the hierarchy is visible
 * without being editable here — membership never rewrites parentage, and neither does
 * this list.
 */
export interface MemberListRow {
  row: TaskRow;
  role: "member" | "child";
  /** For a member: its index among direct members, which the move buttons act on. */
  memberIndex: number;
  member: MilestoneMemberRow | null;
}

/**
 * An `Issue` for a member the page's issue list does not carry — another workspace in
 * hub mode, or a row the 1.5s poll has not reached yet. Everything the shared row needs
 * to draw a kind glyph, a status glyph and a title is on the member row already.
 */
function issueFromMember(member: MilestoneMemberRow, parentId: string | null): Issue {
  return {
    id: member.identifier,
    identifier: member.identifier,
    title: member.title,
    description: null,
    status: member.status as Issue["status"],
    statusVersion: 0,
    kind: member.kind,
    priority: "medium",
    parentId,
    depth: parentId ? 1 : 0,
    assignee: null,
    createdBy: null,
    labels: [],
    acceptanceCriteria: null,
    blockParentUntilDone: false,
    unblockOwner: null,
    unblockAction: null,
    originKind: "manual",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    estimatedSeconds: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: member.addedAt,
    updatedAt: member.addedAt,
  };
}

/**
 * The ordered member list as `TaskRow`s for the shared row component.
 *
 * Members keep the store's order. A member nested under another member (`nestedUnder`)
 * indents one step below it, and an epic member's OWN children — the ones in `issues`
 * whose parent it is and which are not members themselves — follow it indented, so a
 * reader sees the epic's hierarchy exactly as the tree shows it. Descendants recurse;
 * a child that is itself a member is skipped here because it has its own row at its own
 * position, and one issue drawn twice would be two rows disagreeing about where it is.
 *
 * `hasChildren` is left false on purpose: the hierarchy is shown by INDENT, never folded,
 * so the shared row draws no chevron — a chevron that folded nothing would be a control
 * that lies. A milestone's member epics are few; their children are always in view.
 */
export function memberListRows(view: MilestoneView, issues: readonly IssueRow[], workspace: string): MemberListRow[] {
  const byIdentifier = new Map(issues.map((row) => [row.issue.identifier, row]));
  const childrenOf = new Map<string, IssueRow[]>();
  for (const row of issues) {
    if (!row.issue.parentId) continue;
    const list = childrenOf.get(row.issue.parentId) ?? [];
    list.push(row);
    childrenOf.set(row.issue.parentId, list);
  }
  for (const list of childrenOf.values()) list.sort((a, b) => byIdentifier_(a, b));

  const memberIds = new Set(view.members.map((m) => m.identifier));
  const depthOf = new Map<string, number>();
  const out: MemberListRow[] = [];

  const pushChildren = (parent: IssueRow, depth: number) => {
    const children = (childrenOf.get(parent.issue.id) ?? []).filter((c) => !memberIds.has(c.issue.identifier));
    children.forEach((child, index) => {
      out.push({
        row: flatRow(child, { depth, isLast: index === children.length - 1 }),
        role: "child",
        memberIndex: -1,
        member: null,
      });
      pushChildren(child, depth + 1);
    });
  };

  view.members.forEach((member, memberIndex) => {
    const depth = member.nestedUnder ? (depthOf.get(member.nestedUnder) ?? 0) + 1 : 0;
    depthOf.set(member.identifier, depth);
    const known = byIdentifier.get(member.identifier);
    const source = known ?? {
      workspace,
      issue: issueFromMember(member, member.parent),
      claim: null,
    };
    out.push({
      row: flatRow(source, { depth, isLast: memberIndex === view.members.length - 1 }),
      role: "member",
      memberIndex,
      member,
    });
    if (known) pushChildren(known, depth + 1);
  });

  return out;
}

function byIdentifier_(a: IssueRow, b: IssueRow): number {
  return byIdentifier(a.issue.identifier, b.issue.identifier);
}

// ---------- reorder, as the keyboard does it ----------

/**
 * The member order with one entry moved from `from` to `to`. Out-of-range is the caller's
 * "already at the edge" and returns null rather than a no-op array, so a move that would
 * change nothing never becomes a write.
 */
export function movedOrder(members: readonly MilestoneMemberRow[], from: number, to: number): string[] | null {
  if (from < 0 || from >= members.length || to < 0 || to >= members.length || from === to) return null;
  const order = members.map((m) => m.identifier);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  return order;
}

// ---------- layout ----------

export type MilestonesLayout = "stacked" | "split";

/** Tailwind's `md` (48rem at 16px): below it the list and the detail stack, above it they split. */
export const SPLIT_MIN_WIDTH_PX = 768;

export function layoutFor(widthPx: number): MilestonesLayout {
  return widthPx >= SPLIT_MIN_WIDTH_PX ? "split" : "stacked";
}
