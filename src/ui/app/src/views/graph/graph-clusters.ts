/**
 * Epics as collapsible clusters — G3 (STA-56), as pure functions.
 *
 * G1 answered "what is this ONE ticket connected to" by dimming everything else. That
 * works when you already know which ticket you care about. The complaint this file
 * answers is the other one — fifty boxes and no way to see the shape of the work at all
 * — and the fix is not a better highlight, it is fewer boxes: an epic becomes ONE node,
 * its internal arrows disappear because they are internal, and what is left is the
 * top-level answer, about eight nodes wide.
 *
 * ── Why this substitutes without touching the layout ─────────────────────────────────
 *
 * `connectedNodes` and `dagreLayout` (graph-layout.ts) take `readonly LayoutNode[]`,
 * which is "anything with an id". A cluster has an id. So the collapsed node list drops
 * into the existing layout pipeline unchanged, dagre ranks super-nodes exactly as it
 * ranks tickets, and G2's arrangement/persistence machinery never learns that clusters
 * exist. Everything below is set algebra over ids; nothing here renders anything.
 *
 * `graphSignature` gets the collapse set folded in for free, because GraphView computes
 * it over the COLLAPSED lists: toggling a cluster changes which ids and which edge pairs
 * exist, so the signature changes and the layout re-seeds. That is a consequence of
 * substituting the list rather than a rule anyone has to remember.
 *
 * Type imports only — `import type` is erased before this file ever runs, which is what
 * lets the test import it with a plain relative path (there is no vitest config at the
 * repo root, so the app's `@` alias does not exist at test time). graph-positions.ts
 * established that trick; this file follows it.
 */
import type { GraphEdge, GraphNode, IssueStatus } from "@/lib/types";

/**
 * Resolved = finished, one way or the other.
 *
 * Cancelled counts with done rather than against it. It is not remaining work, and an
 * epic whose last two tickets were cancelled must be able to read as complete —
 * otherwise finished epics sit at 7/9 forever and the badge stops meaning anything.
 */
const RESOLVED: ReadonlySet<IssueStatus> = new Set<IssueStatus>(["done", "cancelled"]);

export function isResolved(status: IssueStatus): boolean {
  return RESOLVED.has(status);
}

/**
 * The id space for super-nodes.
 *
 * A cluster shares one namespace with real tickets: React Flow node ids, dagre's graph,
 * and the saved-positions record are all keyed by it. `epic:` is safe as a separator
 * because a task identifier is `PREFIX-123` — letters, a hyphen, digits — and contains
 * no colon, so no ticket can ever be mistaken for a cluster or vice versa.
 */
const CLUSTER_PREFIX = "epic:";

export function clusterId(epic: string): string {
  return `${CLUSTER_PREFIX}${epic}`;
}

export function isClusterId(id: string): boolean {
  return id.startsWith(CLUSTER_PREFIX);
}

/** The epic identifier inside a cluster id, or null if that is not a cluster id. */
export function epicOfClusterId(id: string): string | null {
  return isClusterId(id) ? id.slice(CLUSTER_PREFIX.length) : null;
}

/**
 * Above this many drawn tickets, the graph opens collapsed.
 *
 * 24 is roughly what fits on a laptop canvas at a zoom where titles are still readable.
 * Below it the flat graph is not the thing that was called chaotic, and collapsing it
 * would hide structure to solve a problem that does not exist yet. Above it, the first
 * thing on screen should be the top-level shape, and expanding is one click.
 */
export const COLLAPSE_THRESHOLD = 24;

export function shouldDefaultCollapse(drawnCount: number): boolean {
  return drawnCount > COLLAPSE_THRESHOLD;
}

/** One epic, summarized over the members the canvas actually draws. */
export interface EpicSummary {
  /** The epic ticket's own identifier — `STA-53`. NOT the cluster id. */
  id: string;
  title: string;
  workspace: string;
  /** Drawn members, in the order they appeared. Includes the epic's own node if drawn. */
  members: string[];
  /** `members.length`. Named because the badge reads `resolved/total`. */
  total: number;
  resolved: number;
  /** The tint the super-node wears. See `aggregateStatus`. */
  status: IssueStatus;
}

/**
 * The tint for a whole epic.
 *
 * Precedence is "what is happening here right now", because that is the only question a
 * colour can answer at super-node size. Active work outranks blocked outranks queued: an
 * epic with one ticket in progress and six in backlog is an epic somebody is working on,
 * and reading it as backlog would be the more common half of the truth but the less
 * useful one.
 *
 * Everything resolved is checked FIRST and separately. It is the one state that is a
 * property of the whole set rather than of any member, and it is the state people scan
 * for.
 */
export function aggregateStatus(statuses: readonly IssueStatus[]): IssueStatus {
  if (statuses.length === 0) return "backlog";
  if (statuses.every(isResolved)) return "done";
  const present = new Set(statuses);
  for (const candidate of ["in_progress", "blocked", "in_review", "todo"] as const) {
    if (present.has(candidate)) return candidate;
  }
  return "backlog";
}

/**
 * Which epics exist, given everything and given what is drawn.
 *
 * TWO LISTS, ON PURPOSE. Titles come from `all` because an epic frequently is NOT drawn
 * — the graph only draws tickets that participate in a dependency, and an epic that
 * merely contains work often blocks nothing itself. Membership comes from `drawn`
 * because a super-node stands in for boxes on the canvas, and standing in for a ticket
 * that was never there would make the count disagree with what expanding shows.
 *
 * An epic whose ticket is missing from `all` entirely still yields a cluster, titled
 * with its identifier. That is a hub-shaped edge case (a parent in a workspace this
 * page cannot see) and losing the grouping would be worse than a plain title.
 *
 * Sorted by identifier so the toolbar's list does not reshuffle on every poll.
 */
export function summarizeEpics(
  all: readonly GraphNode[],
  drawn: readonly GraphNode[],
): EpicSummary[] {
  const byId = new Map(all.map((node) => [node.id, node]));
  const drawnIds = new Set(drawn.map((node) => node.id));

  /** epic identifier -> its drawn members, in drawn order. */
  const members = new Map<string, GraphNode[]>();
  for (const node of drawn) {
    // A node with no parent is not in any epic; it stays a ticket. Self-parenting is
    // impossible in the store but would otherwise make a cluster contain itself.
    if (!node.parent || node.parent === node.id) continue;
    const bucket = members.get(node.parent);
    if (bucket) bucket.push(node);
    else members.set(node.parent, [node]);
  }

  // The epic's OWN node joins its cluster when it is drawn. Otherwise collapsing would
  // leave the epic sitting beside the super-node that represents it, wired to the same
  // things, which reads as a duplicate.
  for (const epic of [...members.keys()]) {
    if (drawnIds.has(epic)) members.get(epic)!.unshift(byId.get(epic)!);
  }

  const summaries: EpicSummary[] = [];
  for (const [epic, group] of members) {
    const own = byId.get(epic);
    summaries.push({
      id: epic,
      title: own?.title ?? epic,
      // A bucket only exists because something was pushed into it, so [0] is present.
      workspace: own?.workspace ?? group[0]!.workspace,
      members: group.map((node) => node.id),
      total: group.length,
      resolved: group.filter((node) => isResolved(node.status)).length,
      status: aggregateStatus(group.map((node) => node.status)),
    });
  }
  return summaries.sort((a, b) => a.id.localeCompare(b.id));
}

/** A box on the canvas: either a real ticket or an epic standing in for several. */
export type CanvasNode =
  | { kind: "task"; id: string; task: GraphNode }
  | { kind: "cluster"; id: string; epic: EpicSummary };

/** An arrow on the canvas, possibly standing for several. */
export interface CanvasEdge {
  from: string;
  to: string;
  /** Dashed. True only when EVERY bundled edge crosses workspaces — see `collapseGraph`. */
  cross: boolean;
  /** How many real dependencies this arrow represents. 1 for an ordinary edge. */
  count: number;
}

/**
 * Substitute super-nodes for the members of every collapsed epic.
 *
 * The node half is a filter plus an insertion, and the ORDER matters only in that the
 * cluster takes the position of its first member, which keeps the list stable as things
 * collapse and expand rather than shuffling clusters to the end.
 *
 * The edge half is the part with teeth. Both endpoints are mapped through the same
 * lookup, and then:
 *
 *   - an edge whose ends land on the SAME node is dropped. That is an intra-cluster
 *     dependency, and hiding exactly those is what collapsing an epic means. It also
 *     silently handles the epic-blocks-its-own-child case, which would otherwise draw a
 *     self-loop on the super-node.
 *   - the survivors are deduped by (from,to). Nine tickets in epic A each blocked by
 *     something in epic B is ONE arrow, not nine drawn on top of each other — the
 *     redrawn-arrow pile is most of why the collapsed view would otherwise look no
 *     calmer than the expanded one.
 *
 * `cross` on a bundled edge requires ALL contributors to be cross-workspace, not any.
 * Dashed means "this connection crosses workspaces"; letting one cross edge in a bundle
 * of ten flip the whole arrow would make the legend's promise false. For an unbundled
 * edge (count 1) every rule agrees, which is the case that must not change from today.
 */
/**
 * member id -> the cluster id it disappears into. Empty when nothing is collapsed.
 *
 * Exported because the VIEW needs the same answer: a ticket selected in the detail
 * panel may not be on the canvas under its own name, and "which box is this ticket
 * inside right now" has to be answered identically there and here or the highlight
 * lands on nothing.
 *
 * An epic that is itself collapsed maps to its OWN cluster — written after its parent's
 * membership, so it wins. One level of collapse at a time: a nested epic stays its own
 * super-node rather than vanishing into its grandparent, which keeps "expand this"
 * reversible in one click. Today's tree is only two deep, so this rule is defined
 * rather than exercised.
 */
export function absorption(
  epics: readonly EpicSummary[],
  collapsed: ReadonlySet<string>,
): Map<string, string> {
  const active = epics.filter((epic) => collapsed.has(epic.id));
  const absorbedBy = new Map<string, string>();
  for (const epic of active) {
    for (const member of epic.members) absorbedBy.set(member, clusterId(epic.id));
  }
  for (const epic of active) absorbedBy.set(epic.id, clusterId(epic.id));
  return absorbedBy;
}

export function collapseGraph(
  drawn: readonly GraphNode[],
  edges: readonly GraphEdge[],
  epics: readonly EpicSummary[],
  collapsed: ReadonlySet<string>,
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const byEpic = new Map(
    epics.filter((epic) => collapsed.has(epic.id)).map((epic) => [epic.id, epic]),
  );
  const absorbedBy = absorption(epics, collapsed);

  const nodes: CanvasNode[] = [];
  const emitted = new Set<string>();
  for (const task of drawn) {
    const cluster = absorbedBy.get(task.id);
    if (cluster === undefined) {
      nodes.push({ kind: "task", id: task.id, task });
      continue;
    }
    if (emitted.has(cluster)) continue;
    emitted.add(cluster);
    const epic = byEpic.get(epicOfClusterId(cluster)!);
    if (epic) nodes.push({ kind: "cluster", id: cluster, epic });
  }

  const resolve = (id: string): string => absorbedBy.get(id) ?? id;

  const bundled = new Map<string, CanvasEdge>();
  for (const edge of edges) {
    const from = resolve(edge.from);
    const to = resolve(edge.to);
    if (from === to) continue;
    // NUL-joined for the same reason lib/graph-lineage.ts does it: "A->B" plus "C" must
    // not key the same as "A" plus "B->C".
    const key = `${from}\u0000${to}`;
    const existing = bundled.get(key);
    if (existing) {
      existing.count += 1;
      existing.cross = existing.cross && edge.cross;
    } else {
      bundled.set(key, { from, to, cross: edge.cross, count: 1 });
    }
  }

  return { nodes, edges: [...bundled.values()] };
}

/**
 * Pin the canvas to one epic — the filter that falls out of the grouping.
 *
 * Edges need BOTH ends inside the epic. Keeping the half-edges would draw arrows to
 * boxes that are not on screen, which is the one thing worse than not drawing them: an
 * arrow into nothing reads as a rendering bug, while a missing arrow reads as "you asked
 * to see this epic only", which is what happened.
 *
 * `null` means no filter and returns the inputs, so the caller has no branch.
 */
export function restrictToEpic<T extends { id: string }>(
  nodes: readonly T[],
  edges: readonly GraphEdge[],
  epic: EpicSummary | null,
): { nodes: T[]; edges: GraphEdge[] } {
  if (!epic) return { nodes: [...nodes], edges: [...edges] };
  const members = new Set(epic.members);
  return {
    nodes: nodes.filter((node) => members.has(node.id)),
    edges: edges.filter((edge) => members.has(edge.from) && members.has(edge.to)),
  };
}
