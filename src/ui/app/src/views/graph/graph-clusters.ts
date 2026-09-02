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
import type { GraphEdge, GraphNode, IssueKind, IssueStatus } from "@/lib/types";

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
  /**
   * The epic's OWN parent — O4b (STA-134).
   *
   * `null` when the epic is top-level, when its ticket is not in the payload at all (the
   * hub-shaped case `summarizeEpics` already tolerates), or when the parent it names is
   * not itself an epic on this canvas. That last clause is what makes the field safe to
   * indent by: a `parent` that points at nothing visible would produce a row indented
   * under a row that is not there.
   */
  parent: string | null;
  /**
   * The epic's declared kind — O1a (STA-124), read straight off `GraphNode.kind`.
   *
   * `undefined` means the page is talking to an older server that omits the field, NOT
   * "this has no kind"; treat it as the default kind rather than as an error. Carried
   * here so the picker can draw a kind mark without a second lookup into the node list.
   */
  kind?: IssueKind;
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
      // Provisional: the raw parent ref. Narrowed to "a parent that is itself an epic
      // here" in the pass below, once every epic id is known.
      parent: own?.parent && own.parent !== epic ? own.parent : null,
      kind: own?.kind,
    });
  }
  summaries.sort((a, b) => a.id.localeCompare(b.id));

  // O4b: an epic whose parent is not ITSELF an epic on this canvas is top-level as far
  // as the picker is concerned. Nesting a row under an id that has no row would indent
  // it under nothing, which reads as a bug rather than as a hierarchy. This is a second
  // pass rather than a lookup inside the loop because the set of epics is only complete
  // once the loop has finished — an epic's parent may be summarized after it.
  const epicIds = new Set(summaries.map((summary) => summary.id));
  for (const summary of summaries) {
    if (summary.parent !== null && !epicIds.has(summary.parent)) summary.parent = null;
  }
  return summaries;
}

/**
 * The epics reachable DOWN the parent chain from a selection — O4b (STA-134).
 *
 * Selecting an epic means "show me this epic's work", and on a nested tree that includes
 * the work inside its child epics: `summarizeEpics` buckets by DIRECT parent, so a
 * grandchild lives in the child's bucket and nowhere else. Without this expansion,
 * picking the parent would show the child epic's node and none of the tickets under it —
 * a box with its contents surgically removed.
 *
 * Separate from `restrictToEpics` on purpose. "What does selecting a parent mean" is a
 * policy that could reasonably change; "keep only these members" is not, and folding the
 * two together would make the second untestable without the first.
 *
 * Order: the input epics in list order, each followed by its descendants. Cycles cannot
 * occur (the store forbids them) but the `seen` set makes that a fact rather than a hang.
 */
export function withDescendantEpics(
  epics: readonly EpicSummary[],
  selected: ReadonlySet<string>,
): EpicSummary[] {
  const children = new Map<string, EpicSummary[]>();
  for (const epic of epics) {
    if (epic.parent === null) continue;
    const bucket = children.get(epic.parent);
    if (bucket) bucket.push(epic);
    else children.set(epic.parent, [epic]);
  }

  const seen = new Set<string>();
  const out: EpicSummary[] = [];
  const walk = (epic: EpicSummary) => {
    if (seen.has(epic.id)) return;
    seen.add(epic.id);
    out.push(epic);
    for (const child of children.get(epic.id) ?? []) walk(child);
  };
  for (const epic of epics) if (selected.has(epic.id)) walk(epic);
  return out;
}

/** One line of the picker: an epic and how far it is indented. */
export interface EpicRow {
  epic: EpicSummary;
  /** 0 for a top-level epic, 1 for a child of one, and so on. */
  depth: number;
}

/**
 * The epic list as the picker draws it — parents immediately followed by their children.
 *
 * The flat, identifier-sorted list `summarizeEpics` returns is right for a super-node
 * order and wrong for a menu: `STA-53` and its child `STA-91` end up thirty rows apart
 * with unrelated epics between them, and the containment that is the whole reason epics
 * exist is invisible. Roots keep their sorted order and so do siblings, so the list is
 * still stable across polls.
 *
 * An epic whose parent chain is broken (`parent` already narrowed to a real epic by
 * `summarizeEpics`) is a root. Every epic appears exactly once — `seen` guards against a
 * cycle turning a render into a hang, which is the one failure mode of this shape that
 * would take the page down rather than merely look wrong.
 */
export function flattenEpics(epics: readonly EpicSummary[]): EpicRow[] {
  const children = new Map<string, EpicSummary[]>();
  for (const epic of epics) {
    if (epic.parent === null) continue;
    const bucket = children.get(epic.parent);
    if (bucket) bucket.push(epic);
    else children.set(epic.parent, [epic]);
  }

  const seen = new Set<string>();
  const rows: EpicRow[] = [];
  const walk = (epic: EpicSummary, depth: number) => {
    if (seen.has(epic.id)) return;
    seen.add(epic.id);
    rows.push({ epic, depth });
    for (const child of children.get(epic.id) ?? []) walk(child, depth + 1);
  };
  for (const epic of epics) if (epic.parent === null) walk(epic, 0);
  // A cycle would leave epics unvisited by the root walk. Emit them flat rather than
  // dropping them: a row missing from the picker is a row of work nobody can reach.
  for (const epic of epics) walk(epic, 0);
  return rows;
}

/**
 * Narrow the picker's rows to a query — O4b (STA-134).
 *
 * ORDER IS THE INPUT'S, ALWAYS. Same rule, for the same reason, as R7's `filterOptions`:
 * a fuzzy scorer would put `STA-118` above `STA-1` for the query "STA-1", and a list of
 * identifiers that reorders itself as you type is a list you cannot aim at.
 *
 * Every whitespace-separated token must hit SOMETHING — the identifier or the title —
 * so "auth STA-1" narrows rather than widens.
 *
 * A MATCHED ROW BRINGS ITS ANCESTORS WITH IT, unmatched. Indentation is a claim about
 * the row above; a child surfacing alone at depth 1 under an unrelated epic would state
 * a containment that is false. Ancestors come back flagged `matched: false` so the
 * caller can draw them as the context they are rather than as results.
 */
export interface FilteredEpicRow extends EpicRow {
  /** False for a row present only to hold up the indentation of a match beneath it. */
  matched: boolean;
}

export function filterEpicRows(
  rows: readonly EpicRow[],
  query: string,
): FilteredEpicRow[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return rows.map((row) => ({ ...row, matched: true }));

  const matched = new Set<string>();
  for (const row of rows) {
    const haystack = `${row.epic.id} ${row.epic.title}`.toLowerCase();
    if (tokens.every((token) => haystack.includes(token))) matched.add(row.epic.id);
  }

  const parentOf = new Map(rows.map((row) => [row.epic.id, row.epic.parent]));
  const keep = new Set(matched);
  for (const id of matched) {
    let cursor = parentOf.get(id) ?? null;
    // `keep.has` also terminates a cycle, which `flattenEpics` already tolerates.
    while (cursor !== null && !keep.has(cursor)) {
      keep.add(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
  }

  return rows
    .filter((row) => keep.has(row.epic.id))
    .map((row) => ({ ...row, matched: matched.has(row.epic.id) }));
}

/**
 * A box on the canvas. Three kinds, and the third is the other half of the second.
 *
 * `cluster` and `container` are the SAME epic in its two states — collapsed, standing in
 * for its members; and expanded, drawn around them. They share an id (`clusterId`) on
 * purpose: see `containerize`.
 */
export type CanvasNode =
  | { kind: "task"; id: string; task: GraphNode }
  | { kind: "cluster"; id: string; epic: EpicSummary }
  | { kind: "container"; id: string; epic: EpicSummary };

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
 * Pin the canvas to a set of epics — the filter that falls out of the grouping.
 *
 * O4b (STA-134) made this plural. The single-epic version could answer "show me this
 * epic" and nothing else; the question people actually arrive with in a review is "show
 * me these two and how they relate", and with one slot the only way to ask it was to
 * clear the filter and read the whole board again.
 *
 * IT IS THE UNION, NOT THE INTERSECTION. Two epics share no members by construction —
 * a ticket has one parent — so an intersecting filter would go blank the moment it was
 * used for the thing it exists for.
 *
 * Edges need BOTH ends inside the union. Keeping the half-edges would draw arrows to
 * boxes that are not on screen, which is the one thing worse than not drawing them: an
 * arrow into nothing reads as a rendering bug, while a missing arrow reads as "you asked
 * to see these epics only", which is what happened. Note that the union makes edges
 * BETWEEN two selected epics survive, which is the point of selecting two.
 *
 * An empty list means no filter and returns the inputs, so the caller has no branch.
 */
export function restrictToEpics<T extends { id: string }>(
  nodes: readonly T[],
  edges: readonly GraphEdge[],
  epics: readonly EpicSummary[],
): { nodes: T[]; edges: GraphEdge[] } {
  if (epics.length === 0) return { nodes: [...nodes], edges: [...edges] };
  const members = new Set(epics.flatMap((epic) => epic.members));
  return {
    nodes: nodes.filter((node) => members.has(node.id)),
    edges: edges.filter((edge) => members.has(edge.from) && members.has(edge.to)),
  };
}

/**
 * The single-epic form, kept as a one-line wrapper.
 *
 * Not dead weight: "restrict to this one epic" is a real question — it is what a
 * double-click on a cluster would ask — and expressing it as `restrictToEpics(n, e,
 * epic ? [epic] : [])` at every call site is the kind of ceremony that eventually gets
 * inlined wrong. `null` still means the whole graph.
 */
export function restrictToEpic<T extends { id: string }>(
  nodes: readonly T[],
  edges: readonly GraphEdge[],
  epic: EpicSummary | null,
): { nodes: T[]; edges: GraphEdge[] } {
  return restrictToEpics(nodes, edges, epic ? [epic] : []);
}

/* ── Epic containers — O4c (STA-135) ─────────────────────────────────────────────────
 *
 * The expanded half of what `collapseGraph` does to a collapsed epic. Where collapsing
 * REPLACES an epic's members with one box, expanding DRAWS a box around them: the same
 * grouping, at the other end of the same gesture.
 *
 * THE CONTAINER REUSES THE CLUSTER ID. `epic:STA-53` names the collapsed super-node and
 * the expanded box, and only `collapsed` says which one you are looking at. That is the
 * acceptance criterion expressed as a data structure — "collapsing swaps the box for the
 * existing ClusterNode IN THE SAME PLACE" is free when the two share the coordinate slot
 * that GraphView's `positions` keys by. It also means every existing consumer of an
 * absorbed id — the detail-panel selection mapping, the share link — keeps working
 * without learning a second namespace.
 *
 * THE EPIC'S OWN TICKET BECOMES THE HEADER. When `STA-53` is drawn as a box, its own node
 * is dropped from the canvas and its edges are re-pointed at the box. Exactly the rule
 * `summarizeEpics` already states for collapsing, and for the identical reason: the header
 * says `STA-53`, so a `STA-53` card inside it would be the epic twice, wired to the same
 * things.
 */

/** Which nodes live inside which box, and which epics became a header. */
export interface Containment {
  /**
   * The canvas, in RENDER ORDER: every container appears before anything drawn inside
   * it. React Flow requires this of sub-flows — it warns and mis-positions otherwise —
   * so the order is part of the contract rather than a convenience.
   */
  nodes: CanvasNode[];
  /** node id -> the container id it is drawn inside. Absent means top level. */
  parentOf: Map<string, string>;
  /**
   * epic id -> the container id that now draws it, for epics whose own ticket became a
   * header. This is `absorption`'s counterpart for the expanded case, and it maps to the
   * same value `absorption` would produce if the epic were collapsed.
   */
  headers: Map<string, string>;
}

/**
 * Draw a box around every expanded epic that has work on this canvas.
 *
 * Runs on the output of `collapseGraph` AFTER the view has dropped hidden nodes, which is
 * what keeps `bridgeResolved` and the done modes untouched by this feature: they still
 * see the flat ticket graph they were written against, and an epic whose members were all
 * filtered away simply never becomes a box.
 *
 * A box needs at least ONE member on the canvas other than the epic's own ticket. Not
 * two: "an expanded epic with work on the canvas is a box" is one rule, and the `>= 2`
 * version is two rules whose second makes boxes appear and vanish as work lands.
 */
export function containerize(
  nodes: readonly CanvasNode[],
  epics: readonly EpicSummary[],
  collapsed: ReadonlySet<string>,
): Containment {
  /** member id -> the epic that owns it. Self-membership is not ownership. */
  const ownerOf = new Map<string, string>();
  for (const epic of epics) {
    for (const member of epic.members) {
      if (member !== epic.id) ownerOf.set(member, epic.id);
    }
  }

  /**
   * The ticket each box on the canvas stands for. A task stands for itself; a collapsed
   * cluster stands for its epic. This is what lets one rule — "your place is the box of
   * whoever you belong to" — cover tasks, nested clusters, and nested boxes alike.
   */
  const standsFor = (node: CanvasNode): string =>
    node.kind === "task" ? node.id : node.epic.id;

  const present = new Set(nodes.map(standsFor));
  const summaryOf = new Map(epics.map((epic) => [epic.id, epic]));

  /**
   * The epic a ticket belongs INSIDE — and the two answers are not the same question.
   *
   * A plain ticket belongs to the epic whose `members` it is in. AN EPIC BELONGS TO ITS
   * OWN `parent`, and this distinction is the whole reason O4b put `parent` on the
   * summary. `summarizeEpics` buckets by direct parent over DRAWN nodes only, so an epic
   * that blocks nothing — which is most of them, since the graph draws only tickets that
   * participate in a dependency — is in nobody's `members` even though its place in the
   * tree is perfectly well known. Nesting through `members` would leave every such epic's
   * box floating at the top level beside its own parent.
   */
  const placeOf = (ticket: string): string | null => {
    const summary = summaryOf.get(ticket);
    if (summary) return summary.parent;
    return ownerOf.get(ticket) ?? null;
  };

  /** How deep in the epic tree, so that "what is inside me" can be answered bottom-up. */
  const depthOfEpic = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>([id]);
    let cursor = summaryOf.get(id)?.parent ?? null;
    while (cursor !== null && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = summaryOf.get(cursor)?.parent ?? null;
    }
    return depth;
  };

  /**
   * An epic earns a box when something will be drawn INSIDE it — a member ticket, a
   * collapsed child epic's super-node, or a child epic that earned a box of its own.
   *
   * Deepest first, because the third clause is a question about the answer one level
   * down: a grandparent's box exists because its child's box does, which exists because
   * that child holds real work. One pass in `epics` order would get this right only by
   * accident of sorting.
   */
  const boxed = new Map<string, EpicSummary>();
  const byDepth = [...epics].sort((a, b) => depthOfEpic(b.id) - depthOfEpic(a.id));
  for (const epic of byDepth) {
    // A collapsed epic is a super-node, not a place. That is what collapsing means.
    if (collapsed.has(epic.id)) continue;
    const holdsWork = epic.members.some((member) => member !== epic.id && present.has(member));
    const holdsEpic = epics.some(
      (child) =>
        child.parent === epic.id && (boxed.has(child.id) || (collapsed.has(child.id) && present.has(child.id))),
    );
    if (holdsWork || holdsEpic) boxed.set(epic.id, epic);
  }

  const headers = new Map<string, string>();
  for (const epic of boxed.keys()) headers.set(epic, clusterId(epic));

  /** Anything belonging to a boxed epic is drawn inside that box. */
  const parentOf = new Map<string, string>();
  const boxFor = (ticket: string): string | undefined => {
    const place = placeOf(ticket);
    return place !== null && boxed.has(place) ? clusterId(place) : undefined;
  };

  const kept: CanvasNode[] = [];
  for (const node of nodes) {
    // The epic's own ticket IS the header now; drawing it too would be the epic twice.
    if (node.kind === "task" && boxed.has(node.id)) continue;
    kept.push(node);
    const box = boxFor(standsFor(node));
    if (box !== undefined) parentOf.set(node.id, box);
  }

  const containers: CanvasNode[] = [];
  for (const [id, epic] of boxed) {
    const container: CanvasNode = { kind: "container", id: clusterId(id), epic };
    containers.push(container);
    const box = boxFor(id);
    if (box !== undefined) parentOf.set(container.id, box);
  }

  /*
   * Render order: containers outermost-first, then everything else in the order
   * `collapseGraph` produced. Sorting the containers by nesting depth is what satisfies
   * React Flow's parent-before-child rule for boxes inside boxes; leaves keep their
   * original order so that collapsing and expanding does not reshuffle the canvas.
   */
  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id);
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor);
    }
    return depth;
  };
  containers.sort((a, b) => depthOf(a.id) - depthOf(b.id));

  return { nodes: [...containers, ...kept], parentOf, headers };
}

/** True for the id of an epic that is currently COLLAPSED — a super-node, not a box. */
function isCollapsedCluster(id: string, collapsed: ReadonlySet<string>): boolean {
  const epic = epicOfClusterId(id);
  return epic !== null && collapsed.has(epic);
}

/** One arrow after containment, and the input edges it stands for. */
export interface BoundaryEdge {
  from: string;
  to: string;
  /**
   * Indices into the edge list this was computed from, in order. One entry is the
   * ordinary case; several means the arrow was lifted to a box's edge and bundled.
   * Indices rather than the edges themselves so the caller keeps whatever it knows about
   * them — `cross`, `count`, whether the edge was derived by bridging — without this
   * module having to learn any of it.
   */
  sources: number[];
}

/**
 * Re-point the edges at the boxes — O4c (STA-135).
 *
 * TWO THINGS HAPPEN HERE, AND ONLY TWO.
 *
 * 1. An epic that became a header has no node left, so its edges move to its container.
 *    Not a policy, just bookkeeping: the node they named is gone.
 *
 * 2. AN ENDPOINT INSIDE A BOX LIFTS TO THAT BOX WHEN THE FAR SIDE IS COLLAPSED, and the
 *    lifted arrows bundle. This is the acceptance criterion "inter-epic edges render once
 *    at the container boundary when the far side is collapsed", and the reason is what
 *    collapsing is FOR: nine arrows from nine members of an open epic to one collapsed
 *    epic is nine drawn on top of each other saying one thing — "these two epics are
 *    connected" — which the reader already asked to be told once by collapsing the far
 *    side. When the far side is EXPANDED both ends are real work and the arrow stays
 *    member-to-member, crossing the box borders, because at that point the reader is
 *    asking exactly which ticket waits on which.
 *
 * The NEAREST box, not the outermost: a member of a box inside a box lifts one level, so
 * the arrow still says which of the nested epics it came from.
 *
 * The lift is refused when the box would be an ancestor of the far end — otherwise a box
 * would draw an arrow to something drawn inside itself, which is a picture of nothing.
 */
export function boundaryEdges(
  edges: readonly { from: string; to: string }[],
  containment: Containment,
  collapsed: ReadonlySet<string>,
): BoundaryEdge[] {
  const { parentOf, headers } = containment;
  const resolve = (id: string): string => headers.get(id) ?? id;

  const isAncestorOf = (box: string, id: string): boolean => {
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id);
    while (cursor !== undefined && !seen.has(cursor)) {
      if (cursor === box) return true;
      seen.add(cursor);
      cursor = parentOf.get(cursor);
    }
    return false;
  };

  const liftTowards = (id: string, far: string): string => {
    const box = parentOf.get(id);
    if (box === undefined || box === far || isAncestorOf(box, far)) return id;
    return box;
  };

  const bundled = new Map<string, BoundaryEdge>();
  edges.forEach((edge, index) => {
    const source = resolve(edge.from);
    const sink = resolve(edge.to);
    // Both decisions read the ORIGINAL pair: lifting one end must not change whether the
    // other end sees a collapsed epic across from it.
    const from = isCollapsedCluster(sink, collapsed) ? liftTowards(source, sink) : source;
    const to = isCollapsedCluster(source, collapsed) ? liftTowards(sink, source) : sink;
    // An edge whose ends land on the same box is an internal dependency of that box, and
    // hiding exactly those is what drawing the box means.
    if (from === to) return;
    // NUL-joined for the same reason collapseGraph does it.
    const key = `${from}\u0000${to}`;
    const existing = bundled.get(key);
    if (existing) existing.sources.push(index);
    else bundled.set(key, { from, to, sources: [index] });
  });
  return [...bundled.values()];
}

/**
 * Which boxes should be dimmed, given which nodes are.
 *
 * A CONTAINER IS NOT DIMMED WHILE ANYTHING INSIDE IT IS LIT. React Flow draws children as
 * siblings of the box rather than inside it, so a dimmed box does not fade its contents —
 * it just draws a ghost outline around perfectly bright cards, which reads as a rendering
 * fault rather than as "you did not ask about this". The honest rule is that a box is
 * background only when everything it holds is background.
 *
 * Takes the dimmed set for the LEAVES and returns the full set including boxes, so the
 * caller has one answer to consult rather than two. Deepest first, because an outer box
 * cannot be judged until the boxes inside it have been.
 */
export function dimContainers(
  nodes: readonly CanvasNode[],
  parentOf: ReadonlyMap<string, string>,
  dimmed: ReadonlySet<string>,
): Set<string> {
  const out = new Set(dimmed);
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    const parent = parentOf.get(node.id);
    if (parent === undefined) continue;
    const bucket = children.get(parent);
    if (bucket) bucket.push(node.id);
    else children.set(parent, [node.id]);
  }

  const depthOf = (id: string): number => {
    let depth = 0;
    const seen = new Set<string>([id]);
    let cursor = parentOf.get(id);
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      depth += 1;
      cursor = parentOf.get(cursor);
    }
    return depth;
  };

  const containers = nodes
    .filter((node) => node.kind === "container")
    .map((node) => node.id)
    .sort((a, b) => depthOf(b) - depthOf(a));

  for (const container of containers) {
    const kids = children.get(container) ?? [];
    // A box with nothing in it has nothing to protect, so it keeps whatever the emphasis
    // said about it — the same answer any other node gets.
    if (kids.length === 0) continue;
    if (kids.every((kid) => out.has(kid))) out.add(container);
    else out.delete(container);
  }
  return out;
}
