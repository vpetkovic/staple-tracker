/**
 * The Milestones view's pure model — R3c (STA-173), design/milestones.md.
 *
 * Everything here is a function of the server's milestone view plus the page's issue list;
 * no React, no fetch. The component renders what these return and the tests pin them
 * without a DOM.
 *
 * ── WHAT IS DERIVED HERE AND WHAT IS NOT ────────────────────────────────────────────────
 *
 * The milestone STATE (planned/active/overdue/done/cancelled) is derived by the store on
 * every read and arrives on the view; this module never re-derives it. Blocked and gated
 * are not milestone states — design/milestones.md says so — they are facts about members,
 * and the one place staple states them is the queue resolver's `eligibility`. So "risk"
 * is a reading of the view plus a reading of the queue, not a third derivation that could
 * disagree with either.
 *
 * `next` is the queue resolver's answer and is null until R3d fills it; the view renders
 * the null as "no eligible work" rather than guessing.
 */
import { flatRow, parentRollups, type TaskRow } from "@/components/task-list";
import { walkPlaced, type PlacedNode } from "@/views/tree/nesting";
import type {
  EffectiveQueueRow,
  Issue,
  IssueRow,
  MilestoneListRow,
  MilestoneMemberRow,
  MilestoneNext,
  MilestoneState,
  MilestoneView,
  StatusCategory,
} from "@/lib/types";
import { statusCategory } from "@/lib/settings";
import { shownState } from "./milestone-plain";

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
 * sequence and beats a date the same way it does in the queue (design/queue.md); a date
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
  /** Queue rows under this milestone the resolver classified `blocked`. */
  blocked: number;
  /** Queue rows under this milestone the resolver classified `gated`. */
  gated: number;
  /**
   * The same blocked and gated rows, counted by the status CATEGORY each one is in. A task
   * already in review can still wait on another, and the bar must not file it twice: it is
   * drawn as in review, and only the waiting work that has not started is drawn as blocked.
   * Optional so a hand-built reading (a test, an older caller) means "none started".
   */
  waitingIn?: Partial<Record<StatusCategory, number>>;
  /**
   * The waiting rows, filed by the bar's bucket FIRST and by their reason second, so what the
   * details say always adds up to what the bar shows (`waitBreakdown`):
   *
   *   - NOT STARTED and held for an unfinished blocker (`blocked`): `onTasksNotStarted`. The
   *     rest of the blocked bucket — parked by hand for a person, waiting for approval by
   *     status, or queued behind an approval gate — waits on a person.
   *   - STARTED (in progress or in review), which the bar draws in its own bucket: still held
   *     for a blocker (`startedOnTasks`), or queued behind an approval gate (`startedOnGate`).
   */
  waiting?: {
    onTasksNotStarted: number;
    startedOnTasks: Partial<Record<"active" | "review", number>>;
    startedOnGate: Partial<Record<"active" | "review", number>>;
  };
}
/**
 * Overdue comes off the milestone's own state. Blocked and gated come off the QUEUE, not
 * off `progress.counts`: those count leaves whose STATUS is in the blocked or gated
 * category, and staple moves no status for either — a blocker lives in the blocker table
 * and an approval gate queues its descendants through `queuedBy`, both leaving the status
 * alone. `effective` rows carry the resolver's verdict per row, and `milestonePath` names
 * the milestone each one is planned under, which is exactly the set to count over
 * (design/milestones.md, "State is derived, never stored").
 *
 * `effective` empty — the queue has not loaded, or failed — reads as no risk rather than
 * as an invented one.
 */
export function milestoneRisk(
  row: Pick<MilestoneView, "milestone">,
  effective: readonly EffectiveQueueRow[] = [],
  now: Date = new Date(),
): MilestoneRisk {
  let blocked = 0;
  let gated = 0;
  const waitingIn: Partial<Record<StatusCategory, number>> = {};
  const waiting = {
    onTasksNotStarted: 0,
    startedOnTasks: {} as Partial<Record<"active" | "review", number>>,
    startedOnGate: {} as Partial<Record<"active" | "review", number>>,
  };
  for (const queueRow of effective) {
    if (!queueRow.milestonePath.includes(row.milestone.identifier)) continue;
    if (queueRow.eligibility === "blocked") blocked += 1;
    else if (queueRow.eligibility === "gated") gated += 1;
    else continue;
    const category = statusCategory(queueRow.status);
    waitingIn[category] = (waitingIn[category] ?? 0) + 1;
    if (category === "active" || category === "review") {
      const into = queueRow.eligibility === "gated" ? waiting.startedOnGate : waiting.startedOnTasks;
      into[category] = (into[category] ?? 0) + 1;
    } else if ((category === "ready" || category === "unstarted") && queueRow.eligibility === "blocked") {
      waiting.onTasksNotStarted += 1;
    }
  }
  // Overdue on the reader's local day, as every other word on the page (`shownState`).
  return { overdue: shownState(row.milestone, now) === "overdue", blocked, gated, waitingIn, waiting };
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
 * member epic's own descendants, shown under it so the hierarchy is visible without being
 * editable here — membership never rewrites parentage, and neither does
 * this list.
 */
export interface MemberListRow {
  row: TaskRow;
  role: "member" | "child";
  /** For a member: its index among direct members, which the move buttons act on. */
  memberIndex: number;
  member: MilestoneMemberRow | null;
  /**
   * The member this row carries the controls of, when the member itself is hidden by the done
   * gate and this row is the first of its open work lifted into its place. Without it the
   * member's move and remove would be unreachable while Done is hidden.
   */
  standsFor: { member: MilestoneMemberRow; memberIndex: number } | null;
}

export interface MemberListOptions {
  /**
   * Is this row on the page? The caller passes the Tasks list's own done gate
   * (`passesDone`), so "Done hidden" hides the same rows here as there. A hidden row's
   * children take its place, the way the Tasks list re-roots a subtree whose parent is
   * filtered out, each wearing the Tasks list's parent chip ("STA-354 ›"). Absent: every row
   * is shown.
   */
  visible?: (row: IssueRow) => boolean;
  /** Identifiers whose children the reader folded away. */
  collapsed?: ReadonlySet<string>;
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

interface MemberForest {
  roots: PlacedNode[];
  memberAt: Map<string, { member: MilestoneMemberRow; index: number }>;
}

/**
 * The members as a forest: each member a node, an epic member's own non-member children under
 * it, a nested member under the member it descends from when that member comes first in the
 * plan (moved above it, it is a node of its own at its own position, so a move always shows
 * and a child is never drawn above its parent).
 */
function memberForest(view: MilestoneView, issues: readonly IssueRow[], workspace: string): MemberForest {
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
  const memberAt = new Map(view.members.map((member, index) => [member.identifier, { member, index }]));

  // Every member is a node first, so a member nested under one listed after it still lands.
  const nodes = new Map<string, PlacedNode>();
  for (const member of view.members) {
    const known = byIdentifier.get(member.identifier);
    const source = known ?? { workspace, issue: issueFromMember(member, member.parent), claim: null };
    nodes.set(member.identifier, { row: source, ghost: false, children: [] });
  }
  const seen = new Set<string>();
  const descend = (row: IssueRow): PlacedNode[] =>
    (childrenOf.get(row.issue.id) ?? [])
      .filter((child) => !memberIds.has(child.issue.identifier) && !seen.has(child.issue.id))
      .map((child) => {
        seen.add(child.issue.id);
        return { row: child, ghost: false, children: descend(child) };
      });
  for (const member of view.members) {
    const node = nodes.get(member.identifier)!;
    if (byIdentifier.has(member.identifier)) node.children.push(...descend(node.row));
  }
  const roots: PlacedNode[] = [];
  view.members.forEach((member, index) => {
    const node = nodes.get(member.identifier)!;
    const hostAt = member.nestedUnder ? memberAt.get(member.nestedUnder) : undefined;
    const host = hostAt && hostAt.index < index ? nodes.get(member.nestedUnder!) : undefined;
    (host ?? { children: roots }).children.push(node);
  });
  return { roots, memberAt };
}

/**
 * How many of the milestone's rows the done gate hides: what the page says when a milestone
 * whose members are all finished would otherwise read as empty.
 */
export function hiddenMemberCount(
  view: MilestoneView,
  issues: readonly IssueRow[],
  workspace: string,
  visible: (row: IssueRow) => boolean,
): number {
  const count = (list: readonly PlacedNode[]): number =>
    list.reduce((n, node) => n + (visible(node.row) ? 0 : 1) + count(node.children), 0);
  return count(memberForest(view, issues, workspace).roots);
}

/**
 * The ordered member list as `TaskRow`s for the shared row component, shaped exactly as the
 * Tasks list shapes a tree (`memberForest`).
 *
 * A child that is itself a member is not drawn under its parent: it has its own row at its own
 * position, and one issue drawn twice would be two rows disagreeing about where it is.
 *
 * Depth, guides and the elbow come from `walkPlaced`, the tree's one walk, so the connector
 * lines, the chevron and the indent step are the Tasks list's own. A parent's rollup ("0/9")
 * is `parentRollups` over the whole, unfiltered issue list, the number the Tasks list prints on
 * the same row.
 */
export function memberListRows(
  view: MilestoneView,
  issues: readonly IssueRow[],
  workspace: string,
  options: MemberListOptions = {},
): MemberListRow[] {
  const visible = options.visible ?? (() => true);
  const collapsed = options.collapsed ?? new Set<string>();
  const { roots, memberAt } = memberForest(view, issues, workspace);

  // The done gate: a hidden row gives its place to its children, each wearing the hidden
  // parent's chip; the first of a hidden member's lifted rows carries that member's controls.
  const breadcrumbOf = new Map<string, { identifier: string; title: string }>();
  const standsForOf = new Map<string, { member: MilestoneMemberRow; memberIndex: number }>();
  const prune = (list: readonly PlacedNode[]): PlacedNode[] =>
    list.flatMap((node) => {
      const children = prune(node.children);
      if (visible(node.row)) return [{ ...node, children }];
      for (const child of children) {
        if (!breadcrumbOf.has(child.row.issue.id)) {
          breadcrumbOf.set(child.row.issue.id, { identifier: node.row.issue.identifier, title: node.row.issue.title });
        }
      }
      const at = memberAt.get(node.row.issue.identifier);
      const first = children[0];
      if (at && first && !memberAt.has(first.row.issue.identifier) && !standsForOf.has(first.row.issue.id)) {
        standsForOf.set(first.row.issue.id, { member: at.member, memberIndex: at.index });
      }
      return children;
    });

  const rollups = parentRollups(issues);
  return walkPlaced(prune(roots), (node) => !collapsed.has(node.row.issue.identifier)).map((nested) => {
    const at = memberAt.get(nested.row.issue.identifier);
    return {
      row: flatRow(nested.row, {
        depth: nested.depth,
        guides: nested.guides,
        isLast: nested.isLast,
        hasChildren: nested.hasChildren,
        isExpanded: nested.isExpanded,
        childCount: nested.childCount,
        rollup: nested.hasChildren ? (rollups.get(nested.row.issue.id) ?? null) : null,
        breadcrumb: breadcrumbOf.get(nested.row.issue.id) ?? null,
      }),
      role: at ? "member" : "child",
      memberIndex: at ? at.index : -1,
      member: at ? at.member : null,
      standsFor: at ? null : (standsForOf.get(nested.row.issue.id) ?? null),
    };
  });
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

/**
 * Tailwind's `lg` (64rem at 16px): below it the list and the detail stack, above it they
 * split. It was `md` (768px), which measured the VIEWPORT while the page only gets what the
 * navigation rail leaves: at 768px that is ~536px, split into a 256px list and a ~280px
 * detail whose member rows had no title left at all. Stacked, the detail gets the page.
 */
export const SPLIT_MIN_WIDTH_PX = 1024;

export function layoutFor(widthPx: number): MilestonesLayout {
  return widthPx >= SPLIT_MIN_WIDTH_PX ? "split" : "stacked";
}

// ---------- finished milestones ----------

/** A milestone that is over: finished or cancelled. Read-only on this page. */
export function isFinishedMilestone(state: MilestoneState): boolean {
  return state === "done" || state === "cancelled";
}

/**
 * The milestones the list shows under the Done toggle, and how many finished ones it hides.
 * `keep` names ones that stay listed whatever the toggle says: the one the page was pointed
 * at (a `focus=` link) or has open, so a link to a finished milestone shows that milestone
 * rather than quietly opening another.
 */
export function visibleMilestones<T extends Pick<MilestoneListRow, "milestone">>(
  all: readonly T[],
  showDone: boolean,
  keep: readonly (string | null)[] = [],
): { rows: T[]; hiddenFinished: number } {
  const rows = showDone ? [...all] : all.filter((row) => !isFinishedMilestone(row.milestone.state) || keep.includes(row.milestone.identifier));
  return { rows, hiddenFinished: all.length - rows.length };
}

// ---------- All workspaces ----------

/**
 * "This workspace has no milestone kind", told apart from every other failure.
 *
 * The store refuses a milestone read in a workspace whose vocabulary has no `milestone`
 * kind, with a `validation` error whose detail names the kind and a message written for the
 * command line (`Run staple kinds add milestone …`). That sentence must never reach the
 * page: a person using the web UI turns the kind on in Settings, not in a terminal. Matched
 * on the code and the detail, never on the wording.
 */
export function isMissingMilestoneKind(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const { code, detail } = error as { code?: unknown; detail?: unknown };
  return code === "validation" && (detail as { kind?: unknown } | undefined)?.kind === "milestone";
}

/**
 * One workspace's milestone read, as the All-workspaces page receives it: every milestone,
 * finished ones included, and the workspace's queue reading, which is where blocked and gated
 * are counted from (`milestoneRisk`) — the same two inputs the workspace page reads.
 */
export type WorkspaceMilestonesResult =
  | { workspace: string; ok: true; rows: readonly MilestoneListRow[]; effective?: readonly EffectiveQueueRow[] }
  | { workspace: string; ok: false; error: unknown };

export interface MilestoneGroup {
  workspace: string;
  rows: MilestoneListRow[];
  effective: readonly EffectiveQueueRow[];
}

export interface AllMilestones {
  /** Workspaces with milestones to list, in the order given, each list sorted like one workspace's page. */
  groups: MilestoneGroup[];
  /** Workspaces whose read failed for a reason other than "milestones are not turned on". */
  failed: { workspace: string; error: unknown }[];
  /** Finished milestones the Done toggle hides, over every workspace: what an empty page says. */
  hiddenFinished: number;
}

/**
 * Every workspace's milestones, grouped, under the Done toggle exactly as one workspace's page
 * lists them. A workspace with none to list — including one that has not turned milestones on
 * — is left out rather than shown as an empty heading or an error; the finished ones the toggle
 * hides are counted, so an empty page can say they exist.
 */
export function groupAllMilestones(results: readonly WorkspaceMilestonesResult[], showDone = true): AllMilestones {
  const groups: MilestoneGroup[] = [];
  const failed: { workspace: string; error: unknown }[] = [];
  let hiddenFinished = 0;
  for (const result of results) {
    if (result.ok) {
      const { rows: shown, hiddenFinished: hidden } = visibleMilestones(sortMilestones(result.rows), showDone);
      hiddenFinished += hidden;
      if (shown.length > 0) groups.push({ workspace: result.workspace, rows: shown, effective: result.effective ?? [] });
    } else if (!isMissingMilestoneKind(result.error)) {
      failed.push({ workspace: result.workspace, error: result.error });
    }
  }
  return { groups, failed, hiddenFinished };
}
