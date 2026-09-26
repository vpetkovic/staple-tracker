import { describe, expect, it } from "vitest";
import type { Graph, GraphNode } from "@/lib/types";
import { scopeGraph } from "./graph-scope";

const node = (id: string, workspace: string, parent: string | null = null): GraphNode => ({
  id,
  workspace,
  title: id,
  status: "todo",
  parent,
});

// Two workspaces: ALP-2 waits on ALP-1 inside alpha; BET-2 waits on ALP-2 across the line;
// BET-1 → BET-3 is beta's own business; GAM-1 → GAM-2 has nothing to do with alpha.
const HUB: Graph = {
  nodes: [
    node("ALP-9", "alpha"),
    node("ALP-1", "alpha", "ALP-9"),
    node("ALP-2", "alpha", "ALP-9"),
    node("BET-8", "beta"),
    node("BET-2", "beta", "BET-8"),
    node("BET-1", "beta"),
    node("BET-3", "beta"),
    node("GAM-1", "gamma"),
    node("GAM-2", "gamma"),
  ],
  edges: [
    { from: "ALP-1", to: "ALP-2", cross: false },
    { from: "ALP-2", to: "BET-2", cross: true },
    { from: "BET-1", to: "BET-3", cross: false },
    { from: "GAM-1", to: "GAM-2", cross: false },
  ],
};

describe("scopeGraph — the hub's graph, narrowed to the chosen workspace", () => {
  it("keeps the workspace's own work and the other end of each of its cross-workspace edges, nothing further", () => {
    const scoped = scopeGraph(HUB, "alpha");
    expect(scoped.edges).toEqual([HUB.edges[0], HUB.edges[1]]);
    const ids = scoped.nodes.map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["ALP-9", "ALP-1", "ALP-2", "BET-2"]));
    expect(ids).not.toContain("BET-1");
    expect(ids).not.toContain("BET-3");
    expect(ids).not.toContain("GAM-1");
  });

  it("keeps the parents of what it keeps, so an epic's box has its title", () => {
    expect(scopeGraph(HUB, "alpha").nodes.map((n) => n.id)).toContain("BET-8");
  });

  it("a workspace with no dependencies scopes to no edges", () => {
    expect(scopeGraph({ nodes: [node("DEL-1", "delta"), ...HUB.nodes], edges: HUB.edges }, "delta").edges).toEqual([]);
  });

  it("All workspaces is the whole graph", () => {
    expect(scopeGraph(HUB, "")).toBe(HUB);
  });
});
