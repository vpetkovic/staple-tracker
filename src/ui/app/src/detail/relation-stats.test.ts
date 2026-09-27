/**
 * The Connections summary, pinned sentence for sentence.
 *
 * The failure guarded against is not a crash: it is a sentence silently built from the
 * other number, so that "Waiting on N tasks" starts counting the transitive pile, or a
 * resolved blocker. Both are integers, both typecheck, and the wrong one changes whether
 * somebody thinks they can start work. So the strings are the assertion.
 *
 * Relative imports, like every other test under `src/ui/app/`.
 */
import { describe, expect, it } from "vitest";
import type { RelationCounts } from "../lib/relation-context";
import { directCounts, relationStats, unreachableWords } from "./relation-stats";

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

const texts = (c: RelationCounts) => relationStats(c).map((stat) => stat.text);

describe("relationStats", () => {
  it("reads as plain sentences, in order", () => {
    expect(
      texts(
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
      ),
    ).toEqual([
      "Waiting on 2 tasks",
      "5 tasks further up the chain",
      "1 task is waiting on this",
      "3 of 5 sub-tasks finished",
      "3 links to other workspaces",
    ]);
  });

  it("says the two answers a reader always wants even when both are nothing, and nothing else", () => {
    expect(texts(counts())).toEqual(["Nothing is blocking this", "Nothing is waiting on this"]);
  });

  it("leads with the UNRESOLVED direct blockers, never the direct total or the transitive pile", () => {
    // 4 direct, 1 unresolved, 9 upstream: the lead is 1, and the pile is said separately.
    const lead = relationStats(counts({ blockedByDirect: 4, blockedByUnresolved: 1, blockedByTotal: 9 }))[0]!;
    expect(lead.text).toBe("Waiting on 1 task");
    expect(texts(counts({ blockedByDirect: 4, blockedByUnresolved: 1, blockedByTotal: 9 }))).toContain(
      "5 tasks further up the chain",
    );
  });

  it("says a task whose blockers are all finished is not waiting", () => {
    expect(texts(counts({ blockedByDirect: 3, blockedByUnresolved: 0, blockedByTotal: 3 }))[0]).toBe(
      "Everything it waited on is finished",
    );
  });

  it("tints only the lead sentence, and only when something is unresolved", () => {
    const clear = relationStats(counts({ blockedByDirect: 3, blockedByUnresolved: 0 }));
    expect(clear.every((stat) => !stat.blocked)).toBe(true);

    const stuck = relationStats(counts({ blockedByDirect: 3, blockedByUnresolved: 1 }));
    expect(stuck.filter((stat) => stat.blocked).map((stat) => stat.key)).toEqual(["blocked-by"]);
  });

  it("counts cross-workspace EDGES, which is what the map dashes", () => {
    expect(texts(counts({ crossEdges: 2, crossNodes: 7 }))).toContain("2 links to other workspaces");
  });

  it("keys are unique and stable", () => {
    const keys = relationStats(
      counts({ children: 1, blockedByDirect: 1, blockedByTotal: 2, crossEdges: 1 }),
    ).map((stat) => stat.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual(["blocked-by", "upstream", "blocks", "children", "cross"]);
  });
});

describe("directCounts", () => {
  const resolved = (status: string) => status === "done" || status === "cancelled";

  it("counts from the detail payload, unresolved local and cross blockers both", () => {
    const c = directCounts({
      ancestors: 1,
      children: [{ status: "done" }, { status: "todo" }],
      blockedBy: [{ status: "done" }, { status: "in_progress" }],
      blocks: 2,
      crossBlockers: [{ resolved: false }],
      isResolved: resolved,
    });
    expect(c).toMatchObject({
      children: 2,
      childrenResolved: 1,
      blockedByDirect: 3,
      blockedByUnresolved: 2,
      blockedByTotal: 3,
      blocksDirect: 2,
      crossEdges: 1,
    });
    // Without the graph the transitive figure equals the direct one, so nothing is claimed about it.
    expect(texts(c)).not.toContain(expect.stringContaining("further up"));
  });
});

describe("unreachableWords", () => {
  const blocker = (over: Partial<Parameters<typeof unreachableWords>[0]> = {}) => ({
    identifier: "STA-9999",
    workspace: "staple",
    unresolvable: true,
    ...over,
  });

  it("says nothing about a blocker that was read", () => {
    expect(unreachableWords(blocker({ unresolvable: false }))).toBeNull();
  });

  it("tells a missing task apart from a missing workspace, from the hub's own reason", () => {
    expect(unreachableWords(blocker({ missing: "task" }))).toEqual({
      kind: "task",
      headline: "STA-9999 can't be found in staple.",
      advice: "It may have been deleted or renamed. Remove the link if it no longer applies.",
    });
    expect(unreachableWords(blocker({ identifier: "GAM-9", workspace: "gamma", missing: "workspace" }))).toEqual({
      kind: "workspace",
      headline: "GAM-9 is in gamma, which isn't on this computer.",
      advice: "Open that workspace on this computer, or remove the link if it no longer applies.",
    });
  });

  it("trusts the hub over the page's list: a registered but absent workspace is still absent", () => {
    expect(unreachableWords(blocker({ missing: "workspace" }), ["staple"])!.kind).toBe("workspace");
  });

  it("falls back to the workspaces this page knows when an older server sends no reason", () => {
    expect(unreachableWords(blocker(), ["staple"])!.kind).toBe("task");
    expect(unreachableWords(blocker(), ["alpha"])!.kind).toBe("workspace");
  });
});
