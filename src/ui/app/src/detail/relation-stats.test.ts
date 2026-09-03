/**
 * The strip's wording, pinned character for character — O2b (STA-132).
 *
 * The ticket writes the strip out as a literal sentence, and the failure it is guarding
 * against is not a crash: it is a segment silently renamed so that "N upstream total"
 * starts reading "blocked by N". Both are integers, both typecheck, and the wrong one
 * changes whether somebody thinks they can start work. So the strings are the assertion.
 *
 * Relative imports, like every other test under `src/ui/app/`.
 */
import { describe, expect, it } from "vitest";
import type { RelationCounts } from "../lib/relation-context";
import { relationStats } from "./relation-stats";

const counts = (overrides: Partial<RelationCounts> = {}): RelationCounts => ({
  ancestors: 0,
  children: 0,
  childrenResolved: 0,
  descendants: 0,
  descendantsResolved: 0,
  blockedByDirect: 0,
  blockedByUnresolved: 0,
  blockedByTotal: 0,
  blocksDirect: 0,
  blocksTotal: 0,
  crossEdges: 0,
  crossNodes: 0,
  ...overrides,
});

describe("relationStats", () => {
  it("reads exactly as the ticket specifies", () => {
    const stats = relationStats(
      counts({
        ancestors: 2,
        children: 5,
        childrenResolved: 3,
        blockedByDirect: 4,
        blockedByUnresolved: 2,
        blockedByTotal: 9,
        blocksDirect: 1,
        crossEdges: 3,
      }),
    );
    expect(stats.map((stat) => stat.text)).toEqual([
      "ancestors 2",
      "children 3/5",
      "blocked by 4 direct (2 unresolved)",
      "9 upstream total",
      "blocks 1",
      "cross-workspace 3",
    ]);
  });

  it("prints zeros rather than dropping segments", () => {
    const stats = relationStats(counts());
    expect(stats).toHaveLength(6);
    expect(stats.map((stat) => stat.text)).toEqual([
      "ancestors 0",
      "children 0/0",
      "blocked by 0 direct (0 unresolved)",
      "0 upstream total",
      "blocks 0",
      "cross-workspace 0",
    ]);
  });

  it("tints only the blocked-by segment, and only when something is unresolved", () => {
    const clear = relationStats(counts({ blockedByDirect: 3, blockedByUnresolved: 0 }));
    expect(clear.every((stat) => !stat.blocked)).toBe(true);

    const stuck = relationStats(counts({ blockedByDirect: 3, blockedByUnresolved: 1 }));
    expect(stuck.filter((stat) => stat.blocked).map((stat) => stat.key)).toEqual(["blocked-by"]);
  });

  it("counts cross-workspace EDGES, which is what the canvas dashes", () => {
    const stats = relationStats(counts({ crossEdges: 2, crossNodes: 7 }));
    expect(stats.at(-1)?.text).toBe("cross-workspace 2");
  });

  it("keys are unique and stable", () => {
    const keys = relationStats(counts()).map((stat) => stat.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["ancestors", "children", "blocked-by", "upstream", "blocks", "cross"]);
  });
});
