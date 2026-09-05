/**
 * THE EFFECTIVE ORDER, DRAWN AS THE TREE IT ALREADY IS.
 *
 * `queue-model.ts` joins the plan to its expansion and turns numbers into labels. This file
 * does the one thing that file deliberately did not: it gives the expansion a SHAPE, so a
 * reader can see that STA-198 is a CHILD of STA-197 rather than having to be told in
 * monospace that it came "from plan #1".
 *
 * Nothing here renders, fetches, or reads a clock.
 *
 * ── WHY THIS REVERSES `EffectiveLine`'S ARGUMENT, AND ON WHAT GROUNDS ─────────────────
 *
 * `QueueView.tsx` shipped a bespoke `EffectiveLine` with a docstring that is worth quoting,
 * because it is the case against this file:
 *
 *     "Deliberately not the shared `TaskRowLine`. What matters about a row here is its
 *      pickup number, where in the plan it came from, whether it can be taken and the
 *      sentence saying why not — four facts the shared row does not carry — and many of
 *      these rows are leaves the page's issue list has never fetched, so drawing them as
 *      task rows would mean synthesising an `Issue` per row."
 *
 * Both halves were true and neither survives review:
 *
 *   THE FOUR FACTS. Three of them stop being per-row facts under the new layout. "Where in
 *   the plan it came from" is answered by POSITION — the row is drawn underneath its plan
 *   row — so printing it was answering a question the shape now answers better. "Whether it
 *   can be taken" and "the sentence saying why not" move to the rail, which has room for the
 *   whole sentence and the blockers as rows you can open, instead of a truncated aside. Only
 *   the pickup number stays on the row, and it is one number in a gutter.
 *
 *   SYNTHESISING AN `Issue`. `queue-model.ts` ALREADY does this, in `issueFromEntry`, for
 *   exactly the same reason — a plan entry for another workspace, or one the 1.5s poll has
 *   not reached. The objection was never to the synthesis; it was to paying for it twice.
 *   `issueFromEffective` below is the same twelve lines against a payload that carries
 *   strictly more (`kind`, `status`, `parent`), and the page's real `IssueRow` is preferred
 *   whenever it has one, so the synthesised row is the fallback rather than the rule.
 *
 * What the reversal buys is the ticket: one visual language across the tree, the milestone
 * members and the queue, so a task looks like a task wherever a reader meets it.
 *
 * ── THE NESTING IS THE WIRE'S, NOT THE TREE'S ────────────────────────────────────────
 *
 * docs/queue.md is absolute that one function computes expansion and every surface reads
 * it. So depth here is read off the fields the resolver already sends — `milestonePath`,
 * `epicPath`, `via` and `parent` — and NEVER by re-walking `parentId` through the page's
 * issue list. The difference matters the moment the two disagree: the resolver's answer is
 * what the agent gets, and a preview that drew a different tree would be previewing
 * something nobody will execute.
 *
 * ── THE CHAINS ARE OURS; THE WALK IS NOT ─────────────────────────────────────────────
 *
 * `views/tree/nesting.ts` says of `walkPlaced`: "This is the only place depth, guides and
 * the elbow are computed, for either axis" — it was extracted (O8a) precisely because two
 * placement rules had already diverged once. So this file builds the FOREST, which is
 * genuinely queue-specific (parented on the wire's ancestor chains rather than on
 * `parentId`, which `placeRows` cannot do), and hands it to `walkPlaced` for the walk.
 *
 * A first cut wrote its own recursion, and inside one afternoon it had drifted twice —
 * `guides.length === depth + 1` where the shared rule is `=== depth`, so a top-level row in
 * the unqueued band drew an elbow hanging off nothing; and `childCount = children.length`,
 * which counts BRACKETS, so a container whose one child is a bracket over three tasks
 * badged `+1`. Both are gone by construction now rather than by being fixed.
 *
 * The elbow under a plan row is recovered honestly: the container is put in the forest as
 * the root it actually is, walked, and then dropped from the output because the plan row
 * above already draws it. Its children land at depth 1 with one guide, which is what an
 * elbow IS — rather than at depth 0 with a guide the shared contract says cannot exist.
 *
 * ── INTERMEDIATE CONTAINERS ARE SYNTHESISED, AND THAT IS THE WHOLE POINT ─────────────
 *
 * The resolver "never emits a container as a row". Queue a milestone that holds an epic and
 * the effective rows are the epic's LEAVES; the epic itself is in nobody's list. Drawn flat
 * that is a run of tasks with no visible parent — the exact confusion this file exists to
 * remove. So every identifier named in an ancestor chain becomes a BRACKET ROW: it carries
 * no ordinal (it is not a checkout target and inventing a position for it would be the lie
 * `row-cues.ts` spends a paragraph refusing to tell), it is dimmed, and it exists to hold
 * an elbow. It is the same idea as the tree's ghost row, for the same reason.
 */
import { flatRow, type TaskRow } from "@/components/task-list";
import { walkPlaced, type PlacedNode } from "@/views/tree/nesting";
import type { EffectiveQueueRow, Issue, IssueRow } from "@/lib/types";

/** A synthesised row has no clock of its own. One constant, not two `Date`s per row. */
const EPOCH = new Date(0).toISOString();

/**
 * An `Issue` for an effective row the page's issue list does not carry.
 *
 * Same shape and same reason as `queue-model.ts`'s `issueFromEntry` — see the header. The
 * fields the wire does not send are given their no-information values rather than a guess:
 * a synthesised row draws a kind glyph, a status icon and a title, and claims nothing else.
 */
export function issueFromEffective(row: EffectiveQueueRow): Issue {
  return {
    id: row.issueId,
    identifier: row.identifier,
    title: row.title,
    description: null,
    status: row.status,
    statusVersion: 0,
    kind: row.kind,
    priority: "medium",
    parentId: row.parent,
    depth: 0,
    assignee: null,
    createdBy: "",
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
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
}

/**
 * A minimal `Issue` for a container nobody sent us — see "intermediate containers" above.
 * `kind: "epic"` because every identifier that can appear in `epicPath` is one, and a
 * milestone reaches this path through `milestonePath`, which the page can name for itself.
 */
function issueFromContainer(identifier: string): Issue {
  return issueFromEffective({
    issueId: `synthetic:${identifier}`,
    identifier,
    title: "",
    kind: "epic",
    status: "backlog",
    position: 0,
    planPosition: null,
    via: null,
    unqueued: false,
    eligibility: "eligible",
    reason: null,
    detail: null,
    dueAt: null,
    milestonePath: [],
    epicPath: [],
    parent: null,
  });
}

/**
 * The ancestors of an effective row, outermost first, as the WIRE names them.
 *
 * `milestonePath` leads because a milestone is a container OVER its membership and sits
 * above the epics it holds (docs/queue.md, step 1). `via` is appended only when it is not
 * already in the chain: a queued container that is neither an epic nor a milestone — a task
 * with open children — appears in neither path but is still the thing this row hangs under.
 */
function ancestorsOf(row: EffectiveQueueRow): string[] {
  const chain = [...row.milestonePath, ...row.epicPath];
  if (row.via && !chain.includes(row.via)) chain.push(row.via);
  return chain;
}

/**
 * The chain BELOW a given root — what this row hangs off, once the root itself is discounted.
 *
 * A root that is absent from the chain means the caller is nesting under something the
 * resolver did not name as an ancestor (a queued leaf, or a container reached by `parent`
 * alone), so the whole chain applies. Slicing after the LAST occurrence rather than the
 * first is deliberate: an identifier cannot legitimately appear twice, and if one ever does,
 * the shallower reading is the one that cannot produce a cycle.
 */
function chainBelow(row: EffectiveQueueRow, root: string | null): string[] {
  const chain = ancestorsOf(row);
  if (root === null) return chain;
  const at = chain.lastIndexOf(root);
  return at === -1 ? chain.filter((id) => id !== root) : chain.slice(at + 1);
}

/**
 * The forest, keyed on the wire's ancestor chains.
 *
 * `PlacedNode` is `nesting.ts`'s own node type, so what comes out of here goes straight into
 * `walkPlaced` — the forest is queue-specific, the walk is shared. Insertion order is
 * EFFECTIVE ORDER throughout: a node is created the first time it is named and never moved,
 * so the tree reads top to bottom in the order an agent will meet it. That is the one
 * ordering guarantee this file makes, and it is the resolver's rather than its own.
 *
 * A node created as a BRACKET and later named by a real row stops being a bracket — the same
 * node, upgraded, so an epic that is both somebody's ancestor and its own queued row appears
 * once.
 */
function forestOf(
  rows: readonly EffectiveQueueRow[],
  root: string | null,
  known: ReadonlyMap<string, IssueRow>,
  workspace: string,
): { forest: PlacedNode[]; effectiveOf: Map<string, EffectiveQueueRow> } {
  const top: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  const effectiveOf = new Map<string, EffectiveQueueRow>();

  const rowFor = (identifier: string, wire: EffectiveQueueRow | null): IssueRow => {
    const source = known.get(identifier);
    if (source) return source;
    return {
      workspace,
      issue: wire ? issueFromEffective(wire) : issueFromContainer(identifier),
      claim: null,
    };
  };

  const nodeFor = (identifier: string, parent: PlacedNode | null): PlacedNode => {
    const seen = byId.get(identifier);
    if (seen) return seen;
    const node: PlacedNode = { row: rowFor(identifier, null), ghost: true, children: [] };
    byId.set(identifier, node);
    (parent ? parent.children : top).push(node);
    return node;
  };

  for (const row of rows) {
    let parent: PlacedNode | null = null;
    for (const ancestor of chainBelow(row, root)) parent = nodeFor(ancestor, parent);
    const node = nodeFor(row.identifier, parent);
    // It is a real row, not a bracket — whether or not it was created as one.
    node.ghost = false;
    node.row = rowFor(row.identifier, row);
    effectiveOf.set(row.identifier, row);
  }

  return { forest: top, effectiveOf };
}

/** What a caller needs to draw one node: the effective row, or nothing when it is a bracket. */
export interface QueueTreeRow {
  /** The task row, ready for `TaskRowLine`. */
  row: TaskRow;
  /** The wire row, or null for a synthesised container bracket. */
  effective: EffectiveQueueRow | null;
}

/**
 * THE ONE ENTRY POINT: a flat list of effective rows, as nested task rows.
 *
 * `root` is the queued container the rows were expanded out of. It is put in the forest as
 * the root it actually is and then DROPPED from the output, because the caller has already
 * drawn it as a plan row — see the header. That is what puts its children at depth 1 with
 * the single guide that draws an elbow, without this file inventing a guide rule of its own.
 *
 * Pass null for a list that hangs off nothing, which is what the unqueued band is; those
 * rows are genuinely top-level and correctly draw no connector at all.
 */
export function queueTreeRows(
  rows: readonly EffectiveQueueRow[],
  options: {
    known: ReadonlyMap<string, IssueRow>;
    workspace: string;
    root?: string | null;
    collapsed?: ReadonlySet<string>;
  },
): QueueTreeRow[] {
  const root = options.root ?? null;
  const { forest, effectiveOf } = forestOf(rows, root, options.known, options.workspace);
  if (forest.length === 0) return [];

  const collapsed = options.collapsed ?? new Set<string>();
  const roots: PlacedNode[] =
    root === null
      ? forest
      : [
          {
            row: options.known.get(root) ?? {
              workspace: options.workspace,
              issue: issueFromContainer(root),
              claim: null,
            },
            ghost: true,
            children: forest,
          },
        ];

  const walked = walkPlaced(roots, (node) => !collapsed.has(node.row.issue.identifier));
  // Drop the container: the plan row above it is already the container's own line.
  const visible = root === null ? walked : walked.slice(1);

  return visible.map((nested) => ({
    effective: effectiveOf.get(nested.row.issue.identifier) ?? null,
    row: flatRow(nested.row, {
      depth: nested.depth,
      guides: nested.guides,
      isLast: nested.isLast,
      hasChildren: nested.hasChildren,
      isExpanded: nested.isExpanded,
      childCount: nested.childCount,
      // A bracket is CONTEXT, not content — the same reading the tree's ghost row gets, and
      // for the same reason: it is a shape holding an elbow, not a thing to take.
      ghost: nested.ghost,
    }),
  }));
}

/** The page's issue list as the lookup `queueTreeRows` wants. One pass, one place. */
export function knownRows(issues: readonly IssueRow[]): Map<string, IssueRow> {
  return new Map(issues.map((row) => [row.issue.identifier, row]));
}
