/**
 * WHICH WORKSPACE A PER-WORKSPACE PAGE READS — and when it must ask instead.
 *
 * Queue, Milestones and Estimate accuracy each read one workspace: `/api/queue`,
 * `/api/milestones` and `/api/calibration` answer for a single store (a plan's positions and
 * revision, a milestone's membership, a workspace's own estimate history), and in hub mode
 * with no `ws` the server answers for ITS first registered workspace. These pages used to do
 * the same on the client (`session.ws || session.workspaces[0]`), so "All workspaces" showed
 * one workspace's queue under a header that said all of them, and a write from it landed in
 * a workspace the reader never picked.
 *
 * Aggregating is not an option the data offers: there is no cross-workspace pickup order to
 * draw (each plan has its own positions and revision), and milestones are scoped to one
 * store. So in All mode these pages ASK, with the workspaces one tap away.
 */
import type { UiMode, WorkspaceRef } from "@/lib/types";

export type WorkspaceScope = { kind: "one"; slug: string } | { kind: "choose"; workspaces: WorkspaceRef[] };

export function workspaceScope(mode: UiMode, ws: string, workspaces: readonly WorkspaceRef[]): WorkspaceScope {
  if (ws) return { kind: "one", slug: ws };
  // One workspace open on its own (not the hub), or a hub that only has one: there is no
  // choice to make, and "all of them" IS that one.
  if (mode !== "hub" || workspaces.length === 1) return { kind: "one", slug: workspaces[0]?.slug ?? "" };
  return { kind: "choose", workspaces: [...workspaces] };
}
