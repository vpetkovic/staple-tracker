/**
 * The certified plan of a subtree: its LABOR, its estimate COVERAGE and its CRITICAL PATH
 * (`docs/cli.md`, "Comparing plans"). Pure: the store reads the rows and hands them in.
 *
 * ## Plan units
 *
 * Every figure here is counted over one set of PLAN UNITS beneath the issue, the same set the
 * recursive `subtreePlan` sums, so the path and the labor can never disagree about what a unit
 * is:
 *
 *  - an issue with its OWN estimate is one unit, and every issue beneath it is inside that unit
 *    (its estimate shadows theirs; own over descendants);
 *  - an issue with no estimate and no live children is one UNPLANNED unit;
 *  - an issue with no estimate and live children is a CONTAINER: its units are its children's;
 *  - a cancelled issue, and everything beneath it, is no unit at all: it owes no work.
 *
 * The named issue itself is a container whenever it has live children, even when it carries its
 * own estimate: the path is a statement about the structure beneath it, and `labor.source` says
 * which of the two plans the labor figure is. A named issue with no live children is its own
 * single unit.
 *
 * ## The path
 *
 * A `blocks` edge between two issues of the subtree becomes edges between their units: a unit or
 * an issue inside one maps to that unit, a container to every unit beneath it. Edges that stay
 * inside one unit, touch the named issue, join an issue to its own ancestor, or touch a cancelled
 * issue are dropped. The critical path is the longest chain of the resulting graph, weighted by
 * each unit's estimate, so parallel branches take the max rather than adding. Only in-subtree
 * edges shape it; blockers from outside are listed beside it, never folded in.
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
  /** Any unit unplanned: the labor and the path are lower bounds. */
  partial: boolean;
  /** Identifiers of the unplanned units, at most `PLAN_LIST_LIMIT`. */
  unplannedRefs: string[];
  /** Cancelled issues beneath, excluded from every figure. */
  cancelled: number;
}

export interface PathStep {
  ref: string;
  /** The unit's estimate; null for an unplanned unit, which the path counts as unknown, never 0. */
  seconds: number | null;
  status: string;
}

export interface CriticalPath {
  /**
   * The wall-clock lower bound: the longest in-subtree dependency chain of units, weighted by
   * estimate. Null when no unit has an estimate.
   */
  seconds: number | null;
  /** True when a unit anywhere beneath is unplanned, or a cycle was broken. */
  partial: boolean;
  /** Why the figure is partial or null: `no_plan`, `unplanned_units`, `dependency_cycle`. */
  missing: string[];
  /** The chain, first to last, at most `PATH_CHAIN_LIMIT` steps. */
  chain: PathStep[];
  /** The number of units on the chain, even when `chain` was cut. */
  chainLength: number;
  /** In-subtree unit edges the path was computed over. */
  edgeCount: number;
  /** Units on a dependency cycle that was broken to compute the path. Normally empty. */
  cycle: string[];
  /** Blockers outside the subtree, unresolved first, at most `PLAN_LIST_LIMIT`. */
  crossSubtreeBlockers: CrossSubtreeBlocker[];
  crossSubtreeBlockerCount: number;
  /** How many of those are unresolved: work the path cannot start until something outside ends. */
  unresolvedCrossSubtreeBlockerCount: number;
}

/** The certified plan of one issue: `planSummary` on the detail surfaces, one entry of `compare`. */
export interface PlanSummary {
  labor: PlanLabor;
  coverage: PlanCoverage;
  criticalPath: CriticalPath;
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
 * Units, coverage and critical path of the subtree under `rootId`. `nodes` holds the whole
 * subtree (the root included), `edges` the `blocks` edges with both ends in it.
 */
export function planStructureOf(
  rootId: string,
  nodes: ReadonlyMap<string, PlanNode>,
  edges: readonly PlanEdge[],
  outside: readonly CrossSubtreeBlocker[],
): { coverage: PlanCoverage; criticalPath: CriticalPath } {
  const childrenOf = new Map<string, PlanNode[]>();
  for (const node of nodes.values()) {
    if (node.id === rootId || node.parentId === null) continue;
    let list = childrenOf.get(node.parentId);
    if (!list) childrenOf.set(node.parentId, (list = []));
    list.push(node);
  }
  for (const list of childrenOf.values()) list.sort(byIdentifier);
  const liveChildren = (id: string) => (childrenOf.get(id) ?? []).filter((child) => !child.cancelled);

  const units: PlanNode[] = [];
  /** An issue that is a unit or lies inside one -> that unit's id. */
  const unitOf = new Map<string, string>();
  /** A container -> the units beneath it. */
  const unitsUnder = new Map<string, string[]>();
  let cancelled = 0;

  const countCancelled = (id: string): void => {
    cancelled += 1;
    for (const child of childrenOf.get(id) ?? []) countCancelled(child.id);
  };
  const shadow = (id: string, unit: string): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (child.cancelled) countCancelled(child.id);
      else {
        unitOf.set(child.id, unit);
        shadow(child.id, unit);
      }
    }
  };
  const visit = (node: PlanNode): string[] => {
    if (node.cancelled) {
      countCancelled(node.id);
      return [];
    }
    if (node.estimatedSeconds != null || liveChildren(node.id).length === 0) {
      units.push(node);
      unitOf.set(node.id, node.id);
      shadow(node.id, node.id);
      return [node.id];
    }
    const under = (childrenOf.get(node.id) ?? []).flatMap(visit);
    unitsUnder.set(node.id, under);
    return under;
  };

  const root = nodes.get(rootId)!;
  if (liveChildren(rootId).length === 0) {
    units.push(root);
    unitOf.set(rootId, rootId);
    for (const child of childrenOf.get(rootId) ?? []) countCancelled(child.id);
  } else {
    unitsUnder.set(rootId, (childrenOf.get(rootId) ?? []).flatMap(visit));
  }

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

  // ---- the unit graph
  const isAncestor = (ancestor: string, id: string): boolean => {
    let at = nodes.get(id)?.parentId ?? null;
    for (let guard = 0; at !== null && guard <= nodes.size; guard++) {
      if (at === ancestor) return true;
      if (at === rootId) return false;
      at = nodes.get(at)?.parentId ?? null;
    }
    return false;
  };
  const endpoint = (id: string): string[] => {
    const unit = unitOf.get(id);
    if (unit !== undefined) return [unit];
    return unitsUnder.get(id) ?? [];
  };
  const successors = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.blockerId === rootId || edge.blockedId === rootId) continue;
    if (isAncestor(edge.blockerId, edge.blockedId) || isAncestor(edge.blockedId, edge.blockerId)) continue;
    for (const from of endpoint(edge.blockerId)) {
      for (const to of endpoint(edge.blockedId)) {
        if (from === to) continue;
        let set = successors.get(from);
        if (!set) successors.set(from, (set = new Set()));
        set.add(to);
      }
    }
  }

  // ---- break cycles at the edge that closes them (DFS in identifier order), then walk the DAG
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  const ordered = [...units].sort(byIdentifier);
  const adjacency = new Map<string, string[]>();
  for (const [from, set] of successors) {
    adjacency.set(from, [...set].sort((a, b) => byIdentifier(unitById.get(a)!, unitById.get(b)!)));
  }
  const state = new Map<string, "open" | "done">();
  const cycleUnits = new Set<string>();
  const dag = new Map<string, string[]>();
  let edgeCount = 0;
  for (const start of ordered) {
    if (state.has(start.id)) continue;
    // Iterative DFS: a stack of [unit, next successor index].
    const stack: Array<[string, number]> = [[start.id, 0]];
    const onStack: string[] = [start.id];
    state.set(start.id, "open");
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
        // Back edge: dropped, and every unit on the loop it closes is reported.
        for (const id of onStack.slice(onStack.indexOf(to))) cycleUnits.add(id);
        continue;
      }
      let list = dag.get(top[0]);
      if (!list) dag.set(top[0], (list = []));
      list.push(to);
      edgeCount += 1;
      if (seen === undefined) {
        state.set(to, "open");
        stack.push([to, 0]);
        onStack.push(to);
      }
    }
  }

  // Longest path, weighted by estimate: `best` is the heaviest chain ENDING at a unit.
  const predecessors = new Map<string, string[]>();
  for (const [from, list] of dag) {
    for (const to of list) {
      let preds = predecessors.get(to);
      if (!preds) predecessors.set(to, (preds = []));
      preds.push(from);
    }
  }
  const best = new Map<string, { seconds: number; length: number; prev: string | null }>();
  const resolve = (id: string): { seconds: number; length: number; prev: string | null } => {
    const known = best.get(id);
    if (known) return known;
    // Iterative post-order so a long chain cannot overflow the stack.
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
      let chosen: { seconds: number; length: number; prev: string | null } = { seconds: 0, length: 0, prev: null };
      for (const pred of [...preds].sort((a, b) => byIdentifier(unitById.get(a)!, unitById.get(b)!))) {
        const reading = best.get(pred)!;
        if (reading.seconds > chosen.seconds || (reading.seconds === chosen.seconds && reading.length > chosen.length)) {
          chosen = { seconds: reading.seconds, length: reading.length, prev: pred };
        }
      }
      const own = unitById.get(at)!.estimatedSeconds ?? 0;
      best.set(at, { seconds: chosen.seconds + own, length: chosen.length + 1, prev: chosen.prev });
    }
    return best.get(id)!;
  };
  let end: string | null = null;
  for (const unit of ordered) {
    const reading = resolve(unit.id);
    const current = end === null ? null : best.get(end)!;
    if (current === null || reading.seconds > current.seconds || (reading.seconds === current.seconds && reading.length > current.length)) {
      end = unit.id;
    }
  }
  const chainIds: string[] = [];
  for (let at: string | null = end; at !== null; at = best.get(at)!.prev) chainIds.push(at);
  chainIds.reverse();

  const missing: string[] = [];
  if (planned.length === 0) missing.push("no_plan");
  else if (unplanned.length > 0) missing.push("unplanned_units");
  if (cycleUnits.size > 0) missing.push("dependency_cycle");

  const sortedOutside = [...outside].sort(
    (a, b) => Number(a.resolved) - Number(b.resolved) || compareRefs(a.blocked, b.blocked) || compareRefs(a.blocker, b.blocker),
  );
  return {
    coverage,
    criticalPath: {
      seconds: planned.length === 0 ? null : end === null ? 0 : best.get(end)!.seconds,
      partial: unplanned.length > 0 || cycleUnits.size > 0,
      missing,
      chain: chainIds.slice(0, PATH_CHAIN_LIMIT).map((id) => {
        const unit = unitById.get(id)!;
        return { ref: unit.identifier, seconds: unit.estimatedSeconds, status: unit.status };
      }),
      chainLength: chainIds.length,
      edgeCount,
      cycle: [...cycleUnits].map((id) => unitById.get(id)!.identifier).sort(compareRefs),
      crossSubtreeBlockers: sortedOutside.slice(0, PLAN_LIST_LIMIT),
      crossSubtreeBlockerCount: outside.length,
      unresolvedCrossSubtreeBlockerCount: outside.filter((blocker) => !blocker.resolved).length,
    },
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
