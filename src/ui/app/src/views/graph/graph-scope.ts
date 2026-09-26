/**
 * THE GRAPH, SCOPED TO THE WORKSPACE THE SWITCHER NAMES.
 *
 * In hub mode `/api/graph` is the whole hub's graph (`Hub.graph()`), whichever workspace is
 * chosen. Every other Workspace page shows the chosen workspace only, so the Graph does too:
 * the workspace's own tickets, plus each ticket in ANOTHER workspace that blocks one of them
 * or is blocked by one — the cross-workspace edge is the one fact about the others that this
 * workspace's plan depends on, so it stays, drawn dashed as ever. Nothing further out.
 *
 * The parents of what is kept stay in the node list too: the canvas names an epic's box from
 * the full list, and a box named by its identifier alone reads as a hole.
 *
 * "All workspaces" (no `ws`) is the whole graph, unchanged.
 */
import type { Graph } from "@/lib/types";

export function scopeGraph(graph: Graph, ws: string): Graph {
  if (!ws) return graph;
  const own = new Set(graph.nodes.filter((node) => node.workspace === ws).map((node) => node.id));
  const edges = graph.edges.filter((edge) => own.has(edge.from) || own.has(edge.to));
  const keep = new Set(own);
  for (const edge of edges) {
    keep.add(edge.from);
    keep.add(edge.to);
  }
  const parentOf = new Map(graph.nodes.map((node) => [node.id, node.parent ?? null]));
  for (const id of [...keep]) {
    let parent = parentOf.get(id) ?? null;
    while (parent !== null && !keep.has(parent)) {
      keep.add(parent);
      parent = parentOf.get(parent) ?? null;
    }
  }
  return { nodes: graph.nodes.filter((node) => keep.has(node.id)), edges };
}
