import { describe, it, expect } from "vitest";
import { prStacks, prTreeRows, parentChoices } from "./pr-stacks";
import type { ExternalLink } from "./model";
function pr(id: string, parent: string | null = null, position = 0): ExternalLink {
  return {
    id,
    issueId: "ticket",
    parentResourceId: parent,
    parentMissing: false,
    position,
    createdBy: "tester",
    createdAt: "2026-11-23",
    updatedAt: "2026-11-23",
    resource: {
      id,
      ref: {
        providerId: "github",
        host: "github.com",
        scopeId: "host",
        containerId: "42",
        id,
        kind: "pull_request",
      },
      key: `repo#${id}`,
      url: `https://github.com/team/repo/pull/${id}`,
      title: null,
      body: null,
      status: null,
      fetchedAt: null,
      contextShared: false,
      createdAt: "2026-11-23",
      updatedAt: "2026-11-23",
    },
  };
}
describe("explicit PR stacks", () => {
  it("keeps two stacks, unrelated PRs and missing parents separate, using only stored parents and order", () => {
    const groups = prStacks([
      pr("2", "1", 2),
      pr("1"),
      pr("3", "1", 1),
      pr("4"),
      pr("5", "4"),
      pr("6"),
      pr("7", "missing"),
    ]);
    expect(groups).toHaveLength(4);
    expect(groups.find((g) => g.id === "1")?.rows.map((r) => [r.link.id, r.depth])).toEqual([
      ["1", 0],
      ["3", 1],
      ["2", 1],
    ]);
    expect(groups.find((g) => g.id === "standalone")?.rows.map((r) => r.link.id)).toEqual(["6"]);
    expect(groups.find((g) => g.id === "7")?.label).toContain("not linked");
  });
  it("renders deep chains iteratively and keeps cyclic data inspectable without looping", () => {
    const links = Array.from({ length: 1200 }, (_, i) => pr(String(i + 1), i ? String(i) : null));
    expect(prStacks(links)[0]?.rows.at(-1)?.depth).toBe(1199);
    expect(prStacks([pr("1", "2"), pr("2", "1")])[0]?.rows).toHaveLength(2);
  });
  it("keeps sibling guide lines through descendants without unbounded indentation", () => {
    const rows = prStacks([pr("1"), pr("2", "1"), pr("3", "2"), pr("4", "1")])[0]!.rows;
    expect(prTreeRows(rows).map(r => [r.link.id, r.guides])).toEqual([
      ["1", []], ["2", [true]], ["3", [true, false]], ["4", [false]],
    ]);
    const deep = Array.from({ length: 1200 }, (_, i) => pr(String(i + 1), i ? String(i) : null));
    expect(prTreeRows(prStacks(deep)[0]!.rows).every(r => r.guides.length <= 3)).toBe(true);
  });
  it("does not offer self or any descendant as a parent", () => {
    const root = pr("1"),
      child = pr("2", "1"),
      grandchild = pr("3", "2"),
      other = pr("4");
    expect(parentChoices(root, [root, child, grandchild, other]).map((l) => l.id)).toEqual(["4"]);
    expect(parentChoices(child, [root, child, grandchild, other]).map((l) => l.id)).toEqual([
      "1",
      "4",
    ]);
  });
});
