/**
 * The numbers above the Relations canvas — O2b (STA-132).
 *
 * Six segments, `·`-separated, and the WORDING is the point. Every number here already
 * exists on `RelationCounts`; nothing is recomputed, so the strip cannot disagree with
 * the boxes underneath it. What CAN go wrong is a segment being labelled with the other
 * number's meaning — "blocked by 7" when 7 is the transitive pile and 2 is what actually
 * stops you starting today. O2a went to the trouble of exposing and naming both numbers
 * precisely because that mistake survives for months and no typecheck can see it. So the
 * sentences live here, out of the `.tsx` (there is no DOM in this suite), and a test pins
 * them character for character.
 */
import type { RelationCounts } from "../lib/relation-context";

export interface RelationStat {
  /** Stable React key. Never rendered. */
  key: string;
  /** Exactly what the reader sees. */
  text: string;
  /**
   * Tint this segment with the blocked status token. True only for the unresolved
   * blockers, which is the one number on the strip that means "you cannot start".
   */
  blocked: boolean;
}

/**
 * The strip, in reading order.
 *
 * Zeros are printed rather than dropped. "blocks 0" is information — nothing is waiting
 * on this ticket — and a strip whose segments come and go would move the other five every
 * time an agent linked a dependency.
 */
export function relationStats(counts: RelationCounts): RelationStat[] {
  return [
    { key: "ancestors", text: `ancestors ${counts.ancestors}`, blocked: false },
    {
      // DIRECT children, resolved over total: the same denominator the tree's progress
      // reads, and the reason O2a keeps `descendants` as a separate pair of numbers.
      key: "children",
      text: `children ${counts.childrenResolved}/${counts.children}`,
      blocked: false,
    },
    {
      key: "blocked-by",
      text: `blocked by ${counts.blockedByDirect} direct (${counts.blockedByUnresolved} unresolved)`,
      blocked: counts.blockedByUnresolved > 0,
    },
    { key: "upstream", text: `${counts.blockedByTotal} upstream total`, blocked: false },
    { key: "blocks", text: `blocks ${counts.blocksDirect}`, blocked: false },
    {
      // EDGES, not nodes. O2a exposes both; the criterion sitting next to this one is
      // about dashed arrows, so this counts the dashed arrows on the canvas.
      key: "cross",
      text: `cross-workspace ${counts.crossEdges}`,
      blocked: false,
    },
  ];
}
