/**
 * The sentences above the Connections list — what this task is waiting on, what is waiting
 * on it, how far its sub-tasks have got — in plain words.
 *
 * It used to be a strip of counters (`ancestors 1 · children 0/0 · blocked by 0 direct (0
 * unresolved) · 0 upstream total …`). Every number was right and nobody could read it. The
 * numbers are the same ones; the WORDING is the point, and the failure it guards against is
 * still the old one: a sentence silently built from the other number. "Waiting on 7 tasks"
 * when 7 is the transitive pile and 2 is what actually stops you starting today changes
 * whether somebody thinks they can start. So the lead sentence is built ONLY from the
 * unresolved DIRECT blockers, the transitive pile gets its own sentence that says "further
 * up the chain", and a test pins every sentence character for character.
 */
import type { RelationCounts } from "../lib/relation-context";

export interface RelationStat {
  /** Stable React key. Never rendered. */
  key: string;
  /** Exactly what the reader sees. */
  text: string;
  /**
   * Tint this sentence with the blocked status token. True only when an unresolved
   * direct blocker exists, which is the one fact here that means "you cannot start".
   */
  blocked: boolean;
}

const tasks = (n: number) => `${n} ${n === 1 ? "task" : "tasks"}`;

/**
 * The sentences, in reading order.
 *
 * Two are always said, because their "nothing" is itself the answer a reader came for:
 * whether anything blocks this task, and whether anything waits on it. The rest are said
 * only when there is something to say — "0 of 0 sub-tasks finished" is not information.
 */
export function relationStats(counts: RelationCounts): RelationStat[] {
  const stats: RelationStat[] = [];

  stats.push({
    key: "blocked-by",
    text:
      counts.blockedByUnresolved > 0
        ? `Waiting on ${tasks(counts.blockedByUnresolved)}`
        : counts.blockedByDirect > 0
          ? `Everything it waited on is finished`
          : "Nothing is blocking this",
    blocked: counts.blockedByUnresolved > 0,
  });

  // The transitive pile, named as such, and only when it is bigger than what is directly
  // attached — otherwise it repeats the lead sentence with a different number in it.
  const further = counts.blockedByTotal - counts.blockedByDirect;
  if (further > 0) {
    stats.push({ key: "upstream", text: `${tasks(further)} further up the chain`, blocked: false });
  }

  stats.push({
    key: "blocks",
    text:
      counts.blocksDirect > 0
        ? `${tasks(counts.blocksDirect)} ${counts.blocksDirect === 1 ? "is" : "are"} waiting on this`
        : "Nothing is waiting on this",
    blocked: false,
  });

  // DIRECT children, resolved over total: the same denominator the tree's progress reads.
  if (counts.children > 0) {
    stats.push({
      key: "children",
      text: `${counts.childrenResolved} of ${counts.children} sub-${counts.children === 1 ? "task" : "tasks"} finished`,
      blocked: false,
    });
  }

  // EDGES, not nodes: the dashed arrows the map draws.
  if (counts.crossEdges > 0) {
    stats.push({
      key: "cross",
      text: `${counts.crossEdges} ${counts.crossEdges === 1 ? "link" : "links"} to other workspaces`,
      blocked: false,
    });
  }

  return stats;
}

/**
 * Counts from the detail payload alone, for the moment before the graph has loaded (and
 * for a task the graph does not cover). Only the transitive figures need the graph; here
 * they fall back to the direct ones, which makes the "further up the chain" sentence
 * silent rather than wrong.
 */
export function directCounts(input: {
  ancestors: number;
  children: readonly { status: string }[];
  blockedBy: readonly { status: string }[];
  blocks: number;
  crossBlockers: readonly { resolved: boolean }[];
  isResolved: (status: string) => boolean;
}): RelationCounts {
  const childrenResolved = input.children.filter((child) => input.isResolved(child.status)).length;
  const unresolvedLocal = input.blockedBy.filter((ref) => !input.isResolved(ref.status)).length;
  const unresolvedCross = input.crossBlockers.filter((blocker) => !blocker.resolved).length;
  const blockedByDirect = input.blockedBy.length + input.crossBlockers.length;
  return {
    ancestors: input.ancestors,
    children: input.children.length,
    childrenResolved,
    descendants: input.children.length,
    descendantsResolved: childrenResolved,
    blockedByDirect,
    blockedByUnresolved: unresolvedLocal + unresolvedCross,
    blockedByTotal: blockedByDirect,
    blocksDirect: input.blocks,
    blocksTotal: input.blocks,
    crossEdges: input.crossBlockers.length,
    crossNodes: input.crossBlockers.length,
  };
}
