/**
 * The certified plan of a subtree: its LABOR, its estimate COVERAGE, its PLANNED path and its
 * REMAINING path (`docs/cli.md`, "Comparing plans"). Pure: the store reads the rows and hands
 * them in.
 *
 * ## Plan units
 *
 * Every figure here is counted over one set of PLAN UNITS beneath the issue, the same set the
 * recursive `subtreePlan` sums, so the paths and the labor can never disagree about what a unit
 * is. An issue is LIVE when its own status is not cancelled; it CARRIES LIVE WORK when it, or any
 * issue beneath it, is live.
 *
 *  - a live issue with its OWN estimate is one unit, and every issue beneath it is inside that
 *    unit (its estimate shadows theirs; own over descendants);
 *  - a live issue with no estimate and no child carrying live work is one UNPLANNED unit;
 *  - a live issue with no estimate over children carrying live work is a CONTAINER: its units are
 *    its children's;
 *  - a CANCELLED issue with live work beneath it is a container too: its own estimate drops out
 *    (it owes nothing itself), but cancelling a parent does not cancel its children, so the live
 *    ones beneath it still count;
 *  - a cancelled issue with no live work beneath it is no unit at all.
 *
 * The named issue itself is a container whenever a child carries live work, even when it has its
 * own estimate: the paths are statements about the structure beneath it, and `labor.source` says
 * which of the two plans the labor figure is (`exceedsLabor` flags a path longer than an own
 * estimate). A named issue with no child carrying live work is its own single unit.
 *
 * ## The paths
 *
 * A `blocks` edge between two issues of the subtree connects their units: an issue inside a unit
 * stands for that unit; a container stands for all of its units, through two weightless virtual
 * nodes (its START, before every unit beneath it, and its FINISH, after them), so an edge between
 * two containers of a thousand units each is one edge, not a million. Edges that stay inside one
 * unit, touch the named issue, join an issue to its own ancestor, or touch a cancelled issue are
 * dropped.
 *
 * The PLANNED path is the longest chain weighted by each unit's estimate, parallel branches taking
 * the max: how long the whole plan takes at the very least, done work included. The REMAINING path
 * is the same chain with every `done` unit weighing 0: what is left of it. Neither is a forecast;
 * a unit in progress weighs its full estimate. Only in-subtree edges shape them; blockers from
 * outside are listed beside them, never folded in.
 *
 * The tracker refuses a direct cycle, but the unit graph can still hold one (a container that
 * blocks an issue which blocks one of the container's own children), and concurrent writes on two
 * devices can merge into one. A cycle is broken, deterministically, at the edge that closes it,
 * and its units are reported; the walk never loops.
 */

import type { PlanSource } from "./types.js";

/** One issue of the subtree, as the store read it. */
export interface PlanNode {
  id: string;
  identifier: string;
  parentId: string | null;
  estimatedSeconds: number | null;
  status: string;
  cancelled: boolean;
  /** Its status is in the `done` category. */
  done: boolean;
}

/** A `blocks` edge with both ends inside the subtree. */
export interface PlanEdge {
  blockerId: string;
  blockedId: string;
}

/** A blocker OUTSIDE the subtree on an issue inside it. */
export interface CrossSubtreeBlocker {
  /** The issue inside the subtree that waits. */
  blocked: string;
  /** The issue outside it that it waits on. */
  blocker: string;
  blockerStatus: string;
  /** The blocker is `done` or `cancelled`, so it holds nothing up any more. */
  resolved: boolean;
}

export interface PlanLabor {
  /**
   * TOTAL LABOR: the effective plan, `timing.subtreePlan.estimatedSeconds`. Every unit once;
   * never a parent's estimate on top of its descendants'. Null when nothing is planned.
   */
  seconds: number | null;
  /** `own` (the issue's own estimate), `descendants` (the sum of its units) or `none`. */
  source: PlanSource;
  /** The issue's own estimate. */
  ownSeconds: number | null;
  /** The bottom-up sum of the planned units beneath it (`subtreePlan.descendantsEstimatedSeconds`). */
  descendantsSeconds: number | null;
}

export interface PlanCoverage {
  /** Units with an estimate. */
  planned: number;
  /** Units without one. */
  unplanned: number;
  /** `planned + unplanned`. */
  units: number;
  /** Any unit unplanned: the labor and the paths are lower bounds. */
  partial: boolean;
  /** Identifiers of the unplanned units, at most `PLAN_LIST_LIMIT`. */
  unplannedRefs: string[];
  /** Issues beneath whose own status is cancelled. Their estimates are no labor. */
  cancelled: number;
}

export interface PathStep {
  ref: string;
  /**
   * What the unit weighs on this path: its estimate on the planned path, and on the remaining
   * path too (a done unit is not on it). Null for an unplanned unit: unknown, never 0.
   */
  seconds: number | null;
  status: string;
}

export interface PlanPath {
  /**
   * The longest in-subtree dependency chain of units, weighted by estimate (on the remaining path,
   * a done unit weighs 0). Null when no unit that counts is planned; 0 on the remaining path when
   * every unit is done.
   */
  seconds: number | null;
  /** True when a counted unit is unplanned, or a cycle was broken. */
  partial: boolean;
  /** Why the figure is partial or null: `no_plan`, `unplanned_units`, `dependency_cycle`. */
  missing: string[];
  /** The chain, first to last, at most `PATH_CHAIN_LIMIT` steps. Empty when `seconds` is null. */
  chain: PathStep[];
  /** The number of units on the chain, even when `chain` was cut. */
  chainLength: number;
  /**
   * `labor.source` is `own` and this path is longer than that own estimate: the structure beneath
   * says more than the estimate set on the issue.
   */
  exceedsLabor: boolean;
}

export interface CriticalPath extends PlanPath {
  /** In-subtree dependency edges the paths were computed over. */
  edgeCount: number;
  /** Units on a dependency cycle that was broken to compute the paths. Normally empty. */
  cycle: string[];
  /** Blockers outside the subtree, unresolved first, at most `PLAN_LIST_LIMIT`. */
  crossSubtreeBlockers: CrossSubtreeBlocker[];
  crossSubtreeBlockerCount: number;
  /** How many of those are unresolved: work that cannot start until something outside ends. */
  unresolvedCrossSubtreeBlockerCount: number;
}

/** The certified plan of one issue: `planSummary` on the detail surfaces, one entry of `compare`. */
export interface PlanSummary {
  labor: PlanLabor;
  coverage: PlanCoverage;
  /** The PLANNED path: every unit at its estimate, done ones included. */
  criticalPath: CriticalPath;
  /** The REMAINING path: the same chain with done units weighing 0 and left off `chain`. */
  remainingPath: PlanPath;
}

export interface PlanComparisonEntry extends PlanSummary {
  ref: string;
  title: string;
  kind: string;
  status: string;
}

export interface PlanOverlap {
  /** A compared issue… */
  ref: string;
  /** …that lies inside this other compared issue, so the two labor figures must not be added. */
  within: string;
}

export interface PlanComparison {
  plans: PlanComparisonEntry[];
  overlaps: PlanOverlap[];
}

export const PLAN_LIST_LIMIT = 20;
export const PATH_CHAIN_LIMIT = 100;
/** Refs one comparison takes. */
export const COMPARE_MAX_REFS = 20;

/**
 * Units, coverage and both paths of the subtree under `rootId`. `nodes` holds the whole subtree
 * (the root included), `edges` the `blocks` edges with both ends in it.
 */
export function planStructureOf(
  rootId: string,
  nodes: ReadonlyMap<string, PlanNode>,
  edges: readonly PlanEdge[],
  outside: readonly CrossSubtreeBlocker[],
  labor: PlanLabor,
): Omit<PlanSummary, "labor"> {
  const childrenOf = new Map<string, PlanNode[]>();
  for (const node of nodes.values()) {
    if (node.id === rootId || node.parentId === null) continue;
    let list = childrenOf.get(node.parentId);
    if (!list) childrenOf.set(node.parentId, (list = []));
    list.push(node);
  }
  for (const list of childrenOf.values()) list.sort(byIdentifier);

  // Carries live work: live itself, or anything beneath it is. Deepest first via post-order.
  const carries = new Map<string, boolean>();
  const carriesLive = (node: PlanNode): boolean => {
    const known = carries.get(node.id);
    if (known !== undefined) return known;
    const stack: Array<[PlanNode, boolean]> = [[node, false]];
    while (stack.length > 0) {
      const [at, expanded] = stack.pop()!;
      if (carries.has(at.id)) continue;
      const kids = childrenOf.get(at.id) ?? [];
      if (!expanded) {
        stack.push([at, true]);
        for (const kid of kids) if (!carries.has(kid.id)) stack.push([kid, false]);
        continue;
      }
      carries.set(at.id, !at.cancelled || kids.some((kid) => carries.get(kid.id)));
    }
    return carries.get(node.id)!;
  };
  const liveChildren = (id: string) => (childrenOf.get(id) ?? []).filter(carriesLive);

  const units: PlanNode[] = [];
  /** An issue that is a unit or lies inside one -> that unit's id. Cancelled issues map nowhere. */
  const unitOf = new Map<string, string>();
  /** Containers, the root's own role aside. */
  const containers: PlanNode[] = [];

  const shadow = (id: string, unit: string): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (!child.cancelled) unitOf.set(child.id, unit);
      shadow(child.id, unit);
    }
  };
  const visit = (node: PlanNode): void => {
    if (!carriesLive(node)) return;
    if (!node.cancelled && (node.estimatedSeconds != null || liveChildren(node.id).length === 0)) {
      units.push(node);
      unitOf.set(node.id, node.id);
      shadow(node.id, node.id);
      return;
    }
    containers.push(node);
    for (const child of childrenOf.get(node.id) ?? []) visit(child);
  };

  const root = nodes.get(rootId)!;
  const rootIsUnit = liveChildren(rootId).length === 0;
  if (rootIsUnit) {
    units.push(root);
    unitOf.set(rootId, rootId);
  } else {
    for (const child of childrenOf.get(rootId) ?? []) visit(child);
  }

  let cancelled = 0;
  for (const node of nodes.values()) if (node.id !== rootId && node.cancelled) cancelled += 1;
  const planned = units.filter((unit) => unit.estimatedSeconds != null);
  const unplanned = units.filter((unit) => unit.estimatedSeconds == null);
  const coverage: PlanCoverage = {
    planned: planned.length,
    unplanned: unplanned.length,
    units: units.length,
    partial: unplanned.length > 0,
    unplannedRefs: unplanned.map((unit) => unit.identifier).sort(compareRefs).slice(0, PLAN_LIST_LIMIT),
    cancelled,
  };

  // ---- the graph: units, plus a START and a FINISH per container
  const isContainer = new Set(containers.map((c) => c.id));
  const startOf = (id: string): string => (isContainer.has(id) ? `${id}#start` : unitOf.get(id)!);
  const finishOf = (id: string): string => (isContainer.has(id) ? `${id}#finish` : unitOf.get(id)!);
  const successors = new Map<string, Set<string>>();
  const link = (from: string, to: string): boolean => {
    if (from === to) return false;
    let set = successors.get(from);
    if (!set) successors.set(from, (set = new Set()));
    if (set.has(to)) return false;
    set.add(to);
    return true;
  };
  // Structure: a container starts before, and finishes after, every child carrying live work.
  for (const container of containers) {
    for (const child of liveChildren(container.id)) {
      link(startOf(container.id), startOf(child.id));
      link(finishOf(child.id), finishOf(container.id));
    }
  }
  const isAncestor = (ancestor: string, id: string): boolean => {
    let at = nodes.get(id)?.parentId ?? null;
    for (let guard = 0; at !== null && guard <= nodes.size; guard++) {
      if (at === ancestor) return true;
      if (at === rootId) return false;
      at = nodes.get(at)?.parentId ?? null;
    }
    return false;
  };
  const connectable = (id: string): boolean =>
    id !== rootId && !nodes.get(id)!.cancelled && (isContainer.has(id) || unitOf.has(id));
  let edgeCount = 0;
  for (const edge of edges) {
    if (!connectable(edge.blockerId) || !connectable(edge.blockedId)) continue;
    if (isAncestor(edge.blockerId, edge.blockedId) || isAncestor(edge.blockedId, edge.blockerId)) continue;
    if (link(finishOf(edge.blockerId), startOf(edge.blockedId))) edgeCount += 1;
  }

  // ---- deterministic order: units by identifier, then each container's start and finish
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const order: string[] = [
    ...[...units].sort(byIdentifier).map((unit) => unit.id),
    ...[...containers].sort(byIdentifier).flatMap((c) => [`${c.id}#start`, `${c.id}#finish`]),
  ];
  const rank = new Map(order.map((id, index) => [id, index]));
  const byRank = (a: string, b: string) => rank.get(a)! - rank.get(b)!;

  // ---- break cycles at the edge that closes them (iterative DFS in rank order)
  const adjacency = new Map<string, string[]>();
  for (const [from, set] of successors) adjacency.set(from, [...set].sort(byRank));
  const state = new Map<string, "open" | "done">();
  const cycleUnits = new Set<string>();
  const predecessors = new Map<string, string[]>();
  for (const start of order) {
    if (state.has(start)) continue;
    const stack: Array<[string, number]> = [[start, 0]];
    const onStack: string[] = [start];
    state.set(start, "open");
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const next = adjacency.get(top[0]) ?? [];
      if (top[1] >= next.length) {
        state.set(top[0], "done");
        stack.pop();
        onStack.pop();
        continue;
      }
      const to = next[top[1]++]!;
      const seen = state.get(to);
      if (seen === "open") {
        for (const id of onStack.slice(onStack.indexOf(to))) if (unitById.has(id)) cycleUnits.add(id);
        continue;
      }
      let preds = predecessors.get(to);
      if (!preds) predecessors.set(to, (preds = []));
      preds.push(top[0]);
      if (seen === undefined) {
        state.set(to, "open");
        stack.push([to, 0]);
        onStack.push(to);
      }
    }
  }
  for (const preds of predecessors.values()) preds.sort(byRank);

  const counted = (weightOf: (unit: PlanNode) => number | null, include: (unit: PlanNode) => boolean): PlanPath => {
    // `best` is the heaviest chain ENDING at a node; length counts units only.
    const best = new Map<string, { seconds: number; length: number; prev: string | null }>();
    const resolve = (id: string): void => {
      const work: Array<[string, boolean]> = [[id, false]];
      while (work.length > 0) {
        const [at, expanded] = work.pop()!;
        if (best.has(at)) continue;
        const preds = predecessors.get(at) ?? [];
        if (!expanded) {
          work.push([at, true]);
          for (const pred of preds) if (!best.has(pred)) work.push([pred, false]);
          continue;
        }
        let chosen = { seconds: 0, length: 0, prev: null as string | null };
        for (const pred of preds) {
          const reading = best.get(pred)!;
          if (reading.seconds > chosen.seconds || (reading.seconds === chosen.seconds && reading.length > chosen.length)) {
            chosen = { seconds: reading.seconds, length: reading.length, prev: pred };
          }
        }
        const unit = unitById.get(at);
        const counts = unit !== undefined && include(unit);
        best.set(at, {
          seconds: chosen.seconds + (counts ? (weightOf(unit) ?? 0) : 0),
          length: chosen.length + (counts ? 1 : 0),
          prev: chosen.prev,
        });
      }
    };
    let end: string | null = null;
    for (const id of order) {
      resolve(id);
      const reading = best.get(id)!;
      const current = end === null ? null : best.get(end)!;
      if (current === null || reading.seconds > current.seconds || (reading.seconds === current.seconds && reading.length > current.length)) {
        end = id;
      }
    }
    const considered = units.filter(include);
    const plannedHere = considered.filter((unit) => weightOf(unit) !== null);
    const unplannedHere = considered.length - plannedHere.length;
    // Nothing counted at all is a real 0 (all done); counted units with no plan is unknown.
    const seconds = considered.length === 0 ? 0 : plannedHere.length === 0 ? null : best.get(end!)!.seconds;
    const chainIds: string[] = [];
    if (seconds !== null) {
      for (let at: string | null = end; at !== null; at = best.get(at)!.prev) {
        const unit = unitById.get(at);
        if (unit !== undefined && include(unit)) chainIds.push(at);
      }
      chainIds.reverse();
    }
    const missing: string[] = [];
    if (seconds === null) missing.push("no_plan");
    else if (unplannedHere > 0) missing.push("unplanned_units");
    if (cycleUnits.size > 0) missing.push("dependency_cycle");
    return {
      seconds,
      partial: unplannedHere > 0 || cycleUnits.size > 0,
      missing,
      chain: chainIds.slice(0, PATH_CHAIN_LIMIT).map((id) => {
        const unit = unitById.get(id)!;
        return { ref: unit.identifier, seconds: weightOf(unit), status: unit.status };
      }),
      chainLength: chainIds.length,
      exceedsLabor: labor.source === "own" && labor.seconds !== null && seconds !== null && seconds > labor.seconds,
    };
  };

  const plannedPath = counted((unit) => unit.estimatedSeconds, () => true);
  const remainingPath = counted((unit) => unit.estimatedSeconds, (unit) => !unit.done);

  const sortedOutside = [...outside].sort(
    (a, b) => Number(a.resolved) - Number(b.resolved) || compareRefs(a.blocked, b.blocked) || compareRefs(a.blocker, b.blocker),
  );
  return {
    coverage,
    criticalPath: {
      ...plannedPath,
      edgeCount,
      cycle: [...cycleUnits].map((id) => unitById.get(id)!.identifier).sort(compareRefs),
      crossSubtreeBlockers: sortedOutside.slice(0, PLAN_LIST_LIMIT),
      crossSubtreeBlockerCount: outside.length,
      unresolvedCrossSubtreeBlockerCount: outside.filter((blocker) => !blocker.resolved).length,
    },
    remainingPath,
  };
}

/** `STA-9` before `STA-10`: prefix, then number. */
export function compareRefs(a: string, b: string): number {
  const ma = /^(.*?)(\d+)$/.exec(a);
  const mb = /^(.*?)(\d+)$/.exec(b);
  if (ma && mb && ma[1] === mb[1]) return Number(ma[2]) - Number(mb[2]);
  return a < b ? -1 : a > b ? 1 : 0;
}

function byIdentifier(a: { identifier: string }, b: { identifier: string }): number {
  return compareRefs(a.identifier, b.identifier);
}
